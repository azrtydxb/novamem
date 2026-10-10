// PII redaction for the LLM fact-extraction payload (#371).
//
// The extraction LLM is an external service: whatever is handed to
// storeFactsForChunk leaves the process in the prompt. Users store
// emails, phone numbers, API keys and addresses in their memories, and
// forwarding those verbatim to a third-party model is a disclosure the
// storage layer never agreed to. So the payload is redacted here, on
// its way out — and ONLY here. The stored entry keeps the original text
// verbatim: this is about what leaves the process, not about what the
// user wrote.
//
// Deliberate properties:
//
//   - Placeholders, not deletion. "[EMAIL]" survives extraction as a
//     fact the model can still reason about ("the user's email is
//     [EMAIL]"), so redaction does not destroy the memory's usefulness.
//   - Deterministic. Pure regex over the payload, no model judgement,
//     no randomness: the same input always yields the same payload.
//   - Case-sensitive where sensitivity buys precision. "sk-" and "nm_"
//     prefixes are matched in lower case only; "SK-" in prose is far
//     more likely to be an abbreviation than a credential.
//
// False positives are accepted over false negatives, but kept rare: the
// generic token rule needs 32+ consecutive credential-shaped characters
// containing both letters and digits, which ordinary prose does not
// produce.
package engine

import (
	"regexp"
	"strings"
)

// The stable placeholders. Facts referencing "[EMAIL]" stay useful to
// the model and to recall; the actual value never leaves the process.
const (
	phEmail  = "[EMAIL]"
	phPhone  = "[PHONE]"
	phSecret = "[SECRET]"
	phIP     = "[IP]"
)

// redactionRule is one pattern with its placeholder.
type redactionRule struct {
	// name is for test failure messages and logs only.
	name string
	re   *regexp.Regexp
	// ph is the replacement. A rule may instead compute its replacement
	// per match (see the generic token rule, which needs a heuristic over
	// the matched run) by leaving ph empty and setting fn.
	ph string
	fn func(match string) string
}

// email — anything local-part@domain.tld shaped. Deliberately greedy on
// the local part: a redaction that swallows a little surrounding text is
// preferable to a leaked address.
var emailRule = redactionRule{
	name: "email",
	re:   regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}`),
	ph:   phEmail,
}

// ipv4 — strict dotted quad, each octet range-checked in the pattern.
// The optional trailing-octet group is how a five-number dotted run
// ("1.2.3.4.5", a version or an OID fragment) is refused: if it matched,
// the fn below leaves the whole run alone. RE2 has no lookahead, so the
// refusal is expressed as a longer match that fn then rejects.
var ipv4Rule = redactionRule{
	name: "ipv4",
	re: regexp.MustCompile(`\b(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}` +
		`(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.[0-9]{1,3})?\b`),
	fn: func(match string) string {
		if strings.Count(match, ".") > 3 {
			return match // the optional fifth-octet group matched: a dotted run, not an address
		}
		return phIP
	},
}

// phoneInternational — a leading +, a 1-3 digit country code, then 8-14
// more digits broken by spaces, dots or dashes. No parentheses here: a
// parenthesised number goes through phoneLocalRule below, which carries
// an optional country-code prefix, so "+1 (555) 123-4567" is matched by
// exactly one rule.
var phoneInternationalRule = redactionRule{
	name: "phone-intl",
	re:   regexp.MustCompile(`\+[0-9]{1,3}(?:[ .\-]?[0-9]){8,14}`),
	ph:   phPhone,
}

// phoneLocal — the (555) 123-4567 / 555-123-4567 / 555 123 4567 shapes:
// three digits, separator, three digits, optional separator, four, with
// an optional international country code in front. A separator is
// REQUIRED between the groups, so order ids and plain integers never
// match.
var phoneLocalRule = redactionRule{
	name: "phone-local",
	re:   regexp.MustCompile(`(?:\+[0-9]{1,3}[ .\-]?)?(?:\([0-9]{3}\)[ .\-]?|[0-9]{3}[ .\-])[0-9]{3}[ .\-]?[0-9]{4}`),
	ph:   phPhone,
}

// secretPrefix — credentials with a recognisable vendor prefix:
// OpenAI-style "sk-…" and novamem's own "nm_…" tokens. Lower case only,
// per the comment at the top of the file.
var secretPrefixRule = redactionRule{
	name: "secret-prefix",
	re:   regexp.MustCompile(`(?:sk-|nm_)[A-Za-z0-9_\-]{8,}`),
	ph:   phSecret,
}

// secretBearer — a bearer credential spelled out in stored text, as an
// agent that recorded a curl command would produce. Capitalised "Bearer"
// only: the credential rules are case-sensitive by design (see the top
// of this file), and lower-case "bearer" in prose is too common.
var secretBearerRule = redactionRule{
	name: "secret-bearer",
	re:   regexp.MustCompile(`Bearer[ =][A-Za-z0-9._\-]{16,}`),
	ph:   phSecret,
}

// secretGeneric — bearer-like long credential runs with no prefix: hex
// digests, base64url tokens, UUIDs. 32+ characters of [A-Za-z0-9_-]
// containing BOTH letters and digits; fn drops the runs that are
// alphabet-only (words do not run 32 characters unbroken) or digit-only
// (long numbers are usually data, not credentials, and [PHONE] would be
// the wrong label anyway).
var secretGenericRule = redactionRule{
	name: "secret-generic",
	re:   regexp.MustCompile(`[A-Za-z0-9_\-]{32,}`),
	fn: func(match string) string {
		hasLetter, hasDigit := false, false
		for _, r := range match {
			switch {
			case r >= '0' && r <= '9':
				hasDigit = true
			default:
				hasLetter = true
			}
		}
		if hasLetter && hasDigit {
			return phSecret
		}
		return match
	},
}

// extraRedactors is the documented extension point. Append a
// redactionRule here (at init time or in a test) to redact a pattern
// the built-ins do not cover — a national ID format, an internal
// hostname scheme. Rules run AFTER every built-in, in slice order, so an
// extension can never un-redact what a built-in already replaced; a
// replacement string containing "[EMAIL]" or another placeholder is
// carried through verbatim like any other text.
var extraRedactors []redactionRule

// redactForExtraction applies every rule, in order: email first (so an
// address's long local part is never mistaken for a token), then IPv4
// (so a dotted quad is not half-eaten by the phone rules), then phones,
// then the credential rules.
func redactForExtraction(content string) string {
	all := append([]redactionRule{
		emailRule, ipv4Rule, phoneInternationalRule, phoneLocalRule,
		secretPrefixRule, secretBearerRule, secretGenericRule,
	}, extraRedactors...)
	for _, rule := range all {
		if rule.fn != nil {
			content = rule.re.ReplaceAllStringFunc(content, rule.fn)
			continue
		}
		content = rule.re.ReplaceAllString(content, rule.ph)
	}
	return content
}
