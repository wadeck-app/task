# Guiding Principles -- Plugin / Extension-Point System

These principles take priority in every design decision.
Any option that conflicts with a principle must be raised as an open question -- never silently accepted.

## Principles

### P-1: Applications own their extension points
Each application (task-cli, flow-cli, orchestrator, queue, ...) defines its own set of named
extension points, each with a required contract/format (e.g. a "page" shape). Plugins do not
invent extension points; they implement ones an application has already declared.
**Why:** Matches the Jenkins-style model the user explicitly asked for, and matches the shape
already visible in flow-cli's existing plugin entries (`extensionPoint: 'workspace' | 'approval'`,
`typeString: 'plugins.<id>.default'`).

### P-2: Consistency across CLIs, without forcing premature coupling
The *shape* of "extension point" and "plugin" should look and feel the same across every CLI in
the family, even though V1 keeps each application's registry local to its own repo.
**Why:** This spec exists because task-cli already hand-duplicated flow-cli's plugin list once
(`PluginsCommand.ts`, confirmed holding a hardcoded mirror of flow-cli's registry with a comment
flagging the duplication risk). Repeating that pattern per app, just one layer up, would recreate
the same problem at a slightly higher level.

### P-3: No premature distribution infrastructure
V1 does not build any mechanism for discovering, fetching, or trusting plugin code from outside
an application's own repository (e.g. npm). That is explicitly deferred (see `out-of-scope.md`).
**Why:** Avoids designing a registry/discovery/trust model before there is a single concrete,
working extension point in production. Matches "no hypothetical future requirements" -- build for
what is needed now, revisit when iteration 2 is actually scheduled.
