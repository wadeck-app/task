# Spec: Plugin / Extension-Point System

**Created:** 2026-10-11
**Version:** v0.1
**Status:** In Progress -- v0.1 -- 1/2 questions resolved
**Iteration:** 1

## Summary

A shared conceptual model for plugins and extension points across the Wadeck CLI family
(task-cli, flow-cli, orchestrator, queue, and future CLIs). Each application defines its own
named extension points with a required contract per point. Plugins implement one or more
extension points. V1 ships a per-application, in-repo (local) registry. Distribution of plugins
via npm (dynamic/third-party sourcing) is deferred to a later iteration.

This spec was triggered by a concrete smell found in task-cli: `PluginsCommand.ts` hardcodes a
copy of flow-cli's plugin list purely for documentation purposes, with a comment acknowledging
the duplication risk. The goal is to replace that kind of ad hoc duplication with one consistent
model, without over-building for needs that are not concrete yet.

## Decision Log

| # | Decision | Status | Date | Rationale |
|---|---|---|---|---|
| 1 | V1 scope is a per-application, in-repo plugin registry. No npm-based plugin distribution/discovery in V1. | Decided | 2026-10-11 | Ship the extension-point model first; distribution adds registry/discovery/trust concerns that are not needed yet. |
| 2 | Extension model follows a Jenkins-style pattern: each application defines named extension points, each with a required contract (e.g. a "page" type). Plugins provide one or more implementations of one or more extension points. | Decided | 2026-10-11 | Proven, well-understood model; matches the shape already visible in flow-cli's existing `extensionPoint`/`type string` concept (workspace, approval). |
| 3 | Each application implements its own extension-point/registry mechanism independently in V1 (Option B). No shared engine package yet. Extraction into a shared package is deferred until at least two apps have a real, working implementation to generalize from. | Decided | 2026-10-11 | User's explicit choice, made reluctantly to keep momentum rather than block on a cross-app design-by-committee. Accepted risk: this is the same shape of problem that triggered this spec (task-cli's hardcoded copy of flow-cli's plugin list) -- recorded as a guiding principle amendment and an open risk, not swept aside. |

## Open Questions

| # | Question | Priority | Status |
|---|---|---|---|
| 1 | Should the per-application registries share a common underlying engine package, or should each application implement its own registry independently in V1? | High | Resolved (Decision #3) |
| 2 | What triggers the extraction into a shared package once two apps have independent implementations -- a fixed condition (e.g. "second app ships one") or a scheduled revisit? | Medium | Open |

## Modules / Sub-files

| File | Contents |
|---|---|
| `guiding-principles.md` | Core principles driving all decisions |
| `out-of-scope.md` | Explicitly excluded items |
| `threat-model.md` | Security threats and mitigations |
| `extension-point-model.md` | Core data model: how an app declares an extension point, how a plugin implements one, registry mechanics |

## Changelog

| Version | Date | Summary |
|---|---|---|
| v0.1 | 2026-10-11 | Initial spec created. Decisions 1-2 captured from brainstorming. Open Question 1 raised. |
