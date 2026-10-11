# Threat Model -- Plugin / Extension-Point System

**Version:** 1.0
**Date:** 2026-10-11
**Methodology:** STRIDE

## Scope

V1 only: a local, in-repo registry per application where each application declares its own
extension points and plugins (also local, in-repo) implement them. No network fetch, no
third-party code loading, no cross-machine distribution in this version.

## Assets

What we are protecting:

| Asset | Sensitivity | Owner |
|---|---|---|
| Plugin implementation code (runs inside the CLI process) | Medium -- V1 code is first-party/local only, so blast radius is limited to what the app's own repo already allows | Each application (task-cli, flow-cli, orchestrator, queue) |
| Extension point contracts (the "format" plugins must satisfy) | Low -- public, documented by design | Each application |

## Threat actors

| Actor | Motivation | Capability |
|---|---|---|
| N/A for V1 | Local, first-party-only plugins have no new external threat actor beyond "a developer with repo write access", already covered by existing repo access controls. | - |

## STRIDE analysis

### Spoofing
Not applicable in V1 -- no identity/authentication boundary is introduced; plugins are selected
by local config, not by a remote identity.

### Tampering
Not applicable in V1 -- plugin code lives in the same repo as the application, under the same
source control and review process as any other code change. No new tampering surface.

### Repudiation
Not applicable in V1 -- no new audit/logging requirement beyond what the application already has.

### Information Disclosure
Not applicable in V1 -- no new data flows to external systems.

### Denial of Service
Low, deferred -- a buggy plugin implementation could misbehave at runtime (e.g. hang an
extension point call), but that is a correctness concern for `extension-point-model.md` (e.g.
timeouts), not a new security boundary.

### Elevation of Privilege
Not applicable in V1 -- plugins run with the same privileges as the hosting CLI process; no
sandboxing boundary exists or is being claimed to exist.

## Mitigations

| ID | Threat category | Threat description | Mitigation | Status | Decision # |
|---|---|---|---|---|---|
| T-01 | Denial of Service | A misbehaving plugin implementation (e.g. an extension point handler that hangs or throws) degrades the host CLI. | To be addressed in `extension-point-model.md` design (e.g. call contract, error handling expectations). | Open | - |

## Open security questions

Q: When iteration 2 introduces npm-sourced (third-party) plugins, what validates or sandboxes
plugin code before it runs inside a CLI process, and how is plugin provenance/trust established?
-> Deferred; not an active open question in `_index.md` because npm distribution is out of scope
for V1 (see `out-of-scope.md`). Must be the first question raised when iteration 2 is scheduled.
