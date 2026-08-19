# Security rules

Repo-level security rules the procoder harness reads and follows. Edit
freely — what is written here wins over the built-in defaults.

## Blocking lines

- A detected secret always blocks. Remove it AND rotate the credential:
  assume it leaked the moment it was written.
- SAST findings at ERROR severity block; WARNING and INFO are judged.
- Dependency vulnerabilities at CVSS 7.0 or above block; below that they
  are reported and judged.

## False positives

A finding that is genuinely not a secret (a test fixture, a docs
placeholder, a gitignored local credential) is silenced the tool's own
way, never by weakening the scan: `gitleaks:allow` on the exact line, or
a fingerprint in .gitleaksignore. Every allow is a reviewed decision —
say why in the commit.

## Never

- Never echo a secret value into a report, a commit message, or a chat.
- Never silence a scanner instead of fixing or judging its finding.
