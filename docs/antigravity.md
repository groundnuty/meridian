# Experimental Antigravity backend

Meridian can expose the official `agy` CLI through its Anthropic Messages
endpoint using the CLI's signed-in Google account. No Gemini API key, Python
SDK, copied OAuth credential, private model endpoint, or API-key fallback is
used. Claude remains the default backend.

This first version supports text and client-owned tools on macOS and Linux.
It is experimental: Antigravity's harness instructions remain in effect,
`max_tokens` is advisory, and a new ordinary turn replays client history.
Windows and arbitrary client compatibility are not established.

## Start

Install the official Antigravity CLI and sign in by running `agy` interactively.
Use the default account provider, with paid overage credits disabled in agy's
settings. Meridian checks effective CLI settings and account model discovery
before starting. API-provider environment variables are removed from the
child environment; configured API-key providers are refused.

```sh
# Text-only requests:
MERIDIAN_BACKEND=antigravity MERIDIAN_PORT=3457 meridian

# Client-owned tools (read the permission explanation below):
MERIDIAN_BACKEND=antigravity \
MERIDIAN_AGY_ALLOW_TOOL_BRIDGE=1 \
MERIDIAN_PORT=3457 meridian

curl http://127.0.0.1:3457/v1/models
```

Use a model slug returned by that endpoint, such as `gemini-3.8-flash-low` if
your account offers it. Claude aliases such as `sonnet` are not remapped.
The local client may require a placeholder API key; this is not a Google key.
The existing `MERIDIAN_API_KEY` protects message and model endpoints with
`x-api-key` or bearer authentication. Health probes remain public. Desktop pages
and Claude profiles are unavailable on this backend.

When running from a checkout, replace `meridian` with `node dist/cli.js` after
`npm install` and `npm run build`.

## Tool permissions

The tool bridge requires explicit `MERIDIAN_AGY_ALLOW_TOOL_BRIDGE=1`. It launches
the CLI with per-process `--dangerously-skip-permissions` and installs a workspace
hook that denies every tool except the named client tools on Meridian's MCP
server. This combination is deliberate: the CLI's headless permission layer
denied MCP dispatch in research even when the hook returned `allow`.

The hook has been tested to deny a built-in file read under auto-approval.
This is not OS sandboxing or a proof of complete isolation against CLI bugs or
conflicting user customizations. Global CLI customizations still load. Use this
opt-in only with a trusted local CLI installation and account configuration;
project-scoped grants without blanket CLI auto-approval remain future work.
The default text-only mode does not use the auto-approval flag.

Meridian creates a disposable workspace containing its hook and MCP config.
It advertises the client's tools through a loopback MCP listener. When the
model requests a tool, Meridian returns `tool_use` to the client and keeps
the MCP response pending. The next HTTP request supplies `tool_result`, which
becomes the MCP result. Meridian never runs the client's filesystem or shell
tools itself. Client tool execution and permission prompts remain the client's
responsibility.

## State and recovery

Pending tool calls retain a live `agy` process. Each continuation must preserve
the delivered conversation prefix, model, system instructions, tool catalog and
output budget. The result must correspond to the exact delivered tool ID.
Changed, duplicate, unknown and expired results receive HTTP 409. A batch of
upstream calls is exposed as one client call per HTTP response, retaining all
upstream correlations. A result cannot silently move to a different account.

Completed ordinary turns retain no Meridian-owned session mapping. Later
requests replay the full client history into a new CLI conversation. This makes
completed-history edits and undo independent of undocumented native rewind
controls, but forfeits native resume/cache affinity. History is rendered as
explicit JSON context; it is not native role-preserving transcript import.

Meridian does not automatically retry side-effecting work. If the proxy or CLI
dies during a pending tool call, the old result cannot resume that process.
Start a new user turn containing the completed tool history; do not blindly
execute a tool a second time. HTTP disconnects during active responses abort
that request's process. Disconnecting normally after a `tool_use` response
leaves its process waiting until the tool deadline.

Temporary workspaces are removed after subprocess exit. The official CLI still
persists its own conversations and project metadata under its normal account
directories. Meridian does not edit or garbage-collect those private records.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MERIDIAN_BACKEND` | `claude` | Set to `antigravity` to select the experimental backend |
| `MERIDIAN_AGY_PATH` | `agy` | Official CLI executable |
| `MERIDIAN_AGY_ALLOW_TOOL_BRIDGE` | off | Explicit tool bridge permission opt-in |
| `MERIDIAN_AGY_MAX_CONCURRENT` | `4` | Maximum live processes, including pending tools |
| `MERIDIAN_AGY_TURN_TIMEOUT_MS` | `300000` | Entire subprocess lifetime, including tool waits |
| `MERIDIAN_AGY_TOOL_TIMEOUT_MS` | `60000` | Deadline for each delivered client tool result |

Capacity exhaustion returns 429 with `Retry-After`. No unbounded request queue
is created. Bodies are capped at 8 MiB; upstream stdout is capped at 16 MiB.
Prompts use stdin to avoid OS argument-size limits. Shutdown terminates owned
process groups and closes the MCP listener.

Embedders can set `backend: "antigravity"` and `antigravity: { executable,
allowToolBridge, maxConcurrent, turnTimeoutMs, pendingToolTimeoutMs }` on
`startProxyServer`. Call `ProxyInstance.close()` to release resources. Direct
`createProxyServer().app.fetch` embedders must call the optional
`closeBackend()` when finished.

## Supported surface and limits

- `POST /v1/messages` and `/messages`: text, text tool results, JSON and SSE.
- `GET /v1/models`: current account's CLI model slugs.
- `GET /health`, `/readyz`, `/livez`: backend identity, capability limits and health.
- Images, thinking controls other than `disabled`, forced tool choice, sampling
  controls, structured-output contracts, stop sequences, OpenAI routes, Claude
  profiles, plugins, telemetry/dashboard and native persistent resume are not
  implemented. Unsupported modeled request features fail before execution.
- `max_tokens` is included as a prompt instruction; the CLI does not expose a
  native hard output-token cap. Health reports this as `advisory`.
- CLI permission denial is an error even when the CLI's terminal status says
  `SUCCESS`. Interrupted or malformed streams never receive a success stop.
- Usage is accumulated from per-step usage for each HTTP response, avoiding
  double-counting cumulative CLI conversation totals.
- Fresh replay, full native prompt inheritance and account quotas can make
  this less efficient than Claude's existing resume implementation.

## Verification

`bun test src/__tests__/antigravity-backend.test.ts` drives the real process/MCP
transport against a deterministic local CLI fixture. It covers continuation
matching, parallel-call correlation, duplicate/stale results, body capabilities,
SSE lifecycle, permission-denial errors, disconnect cancellation, deadlines,
capacity, account-provider refusal and long stdin payloads.

`node scripts/e2e-antigravity.mjs` uses the actual official CLI and account model,
then runs actual Pi through the built Node entrypoint. A recording relay verifies
that a random file value entered through Pi's own tool result. Run after
`npm run build`; it consumes account quota. See [E2E.md](../E2E.md#antigravity-subscription-cli-backend)
for the recorded versions and outcome.

Implementation tracks [#1073](https://github.com/rynfar/meridian/issues/1073),
following the [research PR](https://github.com/rynfar/meridian/pull/1050).
