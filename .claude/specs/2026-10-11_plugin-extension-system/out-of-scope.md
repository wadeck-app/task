# Out of Scope -- Plugin / Extension-Point System

Items listed here are **explicitly excluded**.
Raising an excluded item as a requirement is a change-of-scope conversation, not a design question.

## Excluded items

### NPM-based plugin distribution and discovery
**Reason:** V1 only needs plugins that live locally inside the owning application's own repo
(Decision #1). Fetching, versioning, and trusting plugin code sourced from npm (or any external
registry) introduces discovery and trust-boundary concerns that are not needed to validate the
core extension-point model.
**Covered by:** Future iteration 2 of this spec (not yet scheduled).

### Dynamic / third-party plugin loading at runtime
**Reason:** A direct consequence of the npm-distribution exclusion above -- if plugins are not
sourced externally in V1, there is no need for a sandboxing or code-signing story yet either.
**Covered by:** Should be revisited together with npm distribution in iteration 2; see
`threat-model.md` open security questions for the specific concern to carry forward.

## How to challenge scope
If you believe an item should be in scope, open a new discussion with the rationale.
Do not modify this file silently -- scope changes must be acknowledged as a versioned decision.
