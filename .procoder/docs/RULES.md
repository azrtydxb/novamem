# Documentation rules

Repo-level documentation rules the procoder harness reads and follows. Edit
freely — what is written here wins over the built-in defaults. The list
sections below are machine-read (one `- item` per line); everything else is
guidance for the agent.

## Required docs

- README.md
- CHANGELOG.md

## Required badges

- ci
- license

## README first screen

- usp
- badges

## Version-tracked docs

- CHANGELOG.md

## Guidance

The README is deliberately a short front door: value proposition, badges,
and a pointer to the docs site (azrtydxb.github.io/novamem), which carries
the quick start, install paths, and architecture. The root package.json
version belongs to the npm packages (released via Changesets); the server
releases on its own vX.Y.Z tags — so the CHANGELOG, not the README, is the
version-tracked doc.

Docs-site links are written as relative `.md` links (the VitePress
recommendation) so offline link checkers can resolve them. The one
exception VitePress forces is `public/` assets, which must be referenced
root-absolute — avoid public/ for images that a single page embeds; keep
the image next to the page instead.

Known false positives the gate still shows: the `procoder <command>`
documentation-coverage findings fire in any repo with a `docs/` directory,
but they describe procoder's own CLI, which novamem does not ship. Ignore
them until the plugin scopes that check to its own repository.

Keep CHANGELOG.md current: every release gets an entry a user can read.
Version headings are written `## X.Y.Z - date` (no brackets) so the
version-coverage check can find them.
