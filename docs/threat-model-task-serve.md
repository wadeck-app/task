# Threat model: `task serve` and the `remote` strategy

Scope: protocol v1 (plain HTTP, one shared bearer token, one project per server). Source of the behaviours: CLAUDE.md "Storage strategy: remote" and `packages/task-service/src/server/`. Verified on loopback only; no second machine, no TLS.

## Assets

| Asset                             | Why it matters                                                                |
| --------------------------------- | ----------------------------------------------------------------------------- |
| Tasks of the served project       | Read and write access to every task, comment, link and label of that project. |
| The bearer token                  | Single credential: whoever holds it can read and change everything served.    |
| The server's data folder          | Task files; never exposed by a path, never named in an error body.            |
| Queue events raised by the server | A write raises events on the server machine (flows may react).                |

## Trust boundaries

- Client machine to server: plain HTTP. The network between them is trusted or wrapped (TLS/tunnel/forward port) by something outside task.
- Server process to its data folder: single writer; nothing else may write that folder (task data has no other lock).
- Loopback hop of a forwarder (for example a `machine` forward port): any local process of that machine can reach it; the token is the only protection there.

## Threats and answers

| Id  | Threat                                     | Answer in v1                                                                                                                                                   | Residual                                                                       |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| T1  | Sniffing the network (token, tasks)        | Loopback by default; any other host needs `--allow-lan` and a loud stderr warning BEFORE binding; `strategy check` warns on non-loopback `http://`.            | Accepted: readable on a hostile network. Fix = TLS wrapper (deferred).         |
| T2  | Token replay after a sniff                 | None beyond T1.                                                                                                                                                | No per-request signature (deferred).                                           |
| T3  | Token guessing                             | Constant-time compare, 500 ms delay and a per-address counter on every failure (logged without the token), token of at least 16 characters, required to start. | No lockout (a typo must not lock the owner out).                               |
| T4  | Unauthenticated probing                    | Authentication is checked FIRST: an unauthenticated peer learns nothing about routes or versions.                                                              |                                                                                |
| T5  | Path traversal, injection                  | Strict id pattern, exact-key JSON bodies, JSON only, no shell, no file name taken from a payload.                                                              |                                                                                |
| T6  | Resource exhaustion                        | 1 MiB body limit (declared and streamed), 30 s to receive a request, 16 KiB of headers.                                                                        | No rate limiting beyond the failure delay (deferred).                          |
| T7  | Browser abuse (CSRF, cross-origin read)    | No CORS (a preflight is refused), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, bearer header required.                                        |                                                                                |
| T8  | Token or data folder leaking in output     | Token never logged and removed from every error body; the server's data folder removed too; no stack in errors.                                                |                                                                                |
| T9  | Redirect used to steal the token           | The client never follows a redirect (the token would follow it).                                                                                               |                                                                                |
| T10 | Lost update (two writers)                  | One writer: writes queued one at a time in arrival order; `If-Match` revision gives 412 on a stale write.                                                      | Nothing else may write the data folder.                                        |
| T11 | Lost or duplicated write on timeout        | A client never retries automatically; a write timeout says to check with `task show`.                                                                          | A timed-out write may have been applied.                                       |
| T12 | Token passed on a command line             | `--token <value>` is an unknown option with an explanation; token comes from an environment variable or a file.                                                |                                                                                |
| T13 | Token file readable by others              | A `tokenFile` must be absolute and, on POSIX, mode 600 (checked); on Windows a warning (permissions cannot be read).                                           | Windows ACLs not checked.                                                      |
| T14 | Local process abusing a loopback forwarder | The bearer token is still required on every request.                                                                                                           | Any local process holding the token (or reading its file/env) has full access. |

## Cleartext policy compared with sibling tools

`task serve` accepts plain HTTP on a trusted LAN (warning, explicit `--allow-lan`); flow's worker availability model and `machine` fail closed on cleartext. Task does not refuse cleartext: it warns at start and in `strategy check`. A fail-closed mode (refuse non-loopback without a TLS wrapper) is a possible change, not decided.

## Deferred (not in v1)

TLS and tunnels (as `transport` plugins), per-token project scope and several users, rate limiting beyond the delay, request signing, multi-project serve, discovery of served projects.

## Review triggers

Update this file when the protocol version changes, a transport plugin is added, auth changes, or serve gains a second project.
