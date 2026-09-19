# Antigravity backend

Meridian can expose the official `agy` CLI through its Anthropic Messages
endpoint using the CLI's signed-in Google account. No Gemini API key, Python
SDK, copied OAuth credential, private model endpoint, or API-key fallback is
used. Claude remains the default backend.

The supported macOS path covers text and client-owned tools. Linux is preview.
The scope is explicit: Antigravity's harness instructions remain in effect,
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
`x-api-key` or bearer authentication. Health probes remain public. Provider usage is available in the web dashboard and desktop app. Claude
profiles remain specific to Claude.

When running from a checkout, replace `meridian` with `node dist/cli.js` after
`npm install` and `npm run build`.

## Tool permissions

The tool bridge requires explicit `MERIDIAN_AGY_ALLOW_TOOL_BRIDGE=1`. It launches
the CLI with per-process `--dangerously-skip-permissions` and installs a workspace
hook that denies every tool except the named client tools on Meridian's MCP
server. This combination is deliberate: the CLI's headless permission layer
denied MCP dispatch in research even when the hook returned `allow`.

The hook has been tested to deny a built-in file read under auto-approval.
The hook alone is not OS sandboxing or a proof of complete isolation against CLI bugs or
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
Changed, duplicate, unknown and expired results receive HTTP 409. New user text
may accompany the exact result or follow it in another user message. This steering
continues the same pending process and is delivered separately from tool output. A batch of
upstream calls is exposed as one client call per HTTP response, retaining all
upstream correlations. A result cannot silently move to a different account.

Completed ordinary turns retain no Meridian-owned session mapping. Later
requests replay the full client history into a new CLI conversation. This makes
completed-history edits and undo independent of undocumented native rewind
controls, but forfeits native resume/cache affinity. History is rendered as
explicit JSON context; it is not native role-preserving transcript import.

Repeated MCP request IDs reuse their original result, and conflicting reuse is
rejected. Each turn allows at most 256 distinct MCP tool calls.

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
| `MERIDIAN_BACKEND` | `claude` | Set to `antigravity` to select Antigravity, or `combined` for both providers |
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
- Images, numeric thinking budgets, forced tool choice, sampling
  controls, structured-output contracts, stop sequences, OpenAI routes, Claude
  profiles, plugins, the full Claude telemetry dashboard and native persistent resume are not
  implemented. Unsupported modeled request features fail before execution.
- `output_config.effort` accepts `low`, `medium`, or `high` only when it matches
  the selected model slug suffix; it is passed to the native CLI flag. Adaptive
  thinking is accepted, but no private reasoning transcript is synthesized.
  Google-hosted Claude does not support this effort override: select its account
  model as advertised, with client thinking controls off. Gemini effort variants
  can always be selected as separate model slugs.
- `max_tokens` is included as a prompt instruction; the CLI does not expose a
  native hard output-token cap. Health reports this as `advisory`.
- CLI permission denial is an error even when the CLI's terminal status says
  `SUCCESS`. Interrupted or malformed streams never receive a success stop.
- Usage is accumulated from per-step usage for each HTTP response, avoiding
  double-counting cumulative CLI conversation totals. Cached input is subtracted
  from CLI input before filling Anthropic `input_tokens`, and reported separately
  as `cache_read_input_tokens`.
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

For a full client coding loop, run `node scripts/e2e-antigravity-tools.mjs`
after building. It verifies actual Pi `read`, `edit`, `bash` and `write`, recovery
from a tool error, Unicode paths, and exact source/output bytes. This is separate
from the basic read/write gate; neither establishes arbitrary client compatibility
or recovery of a pending process after a crash.

Implementation tracks [#1073](https://github.com/rynfar/meridian/issues/1073),
following the [research PR](https://github.com/rynfar/meridian/pull/1050).

## Combined service and provider navigation

Set `MERIDIAN_BACKEND=combined` to run both providers in one Meridian service.
Claude retains `/v1/messages`; Antigravity uses `/antigravity/v1/messages` and
`/antigravity/v1/models`. Configure the Antigravity client's base URL with the
`/antigravity` suffix. Claude account routing never selects a Google account.
An unavailable Antigravity installation does not prevent Claude from starting.

Open `/providers` for **All providers / Claude / Antigravity** navigation.
`/providers/status` supplies the same data to Meridian Desktop. Quota windows
come from the official `agy -p /usage --output-format json` command: Gemini and
Claude/GPT allowances remain separate inside the Google subscription. Quota reads refresh in the background; the dashboard never waits for them. Failed
refreshes retain last known readings with stale/error labels. These percentages
are never added to Anthropic percentages or converted to invented costs.

The activity strip sums observed request and token counts over the past hour.
Antigravity uses bounded minute buckets; Claude uses its telemetry window. Antigravity activity is process-local, retains the
latest 500 request metadata records, and resets when Meridian restarts. No
prompts or tool contents are retained in this activity feed. Subscription quotas
come from the account and survive proxy restarts.

The macOS app has a Providers page, the same overview and filters, separate
Antigravity quota windows in the menu bar, and provider selection under Settings.
For an app-managed service, stop it, choose Claude, Antigravity, or both, then
start it. Client tools require the separate opt-in checkbox. An attached service
is configured by its owner. Sign into Google using the official CLI; the desktop
app does not collect Google credentials or repurpose Claude profile login.

## Compatibility and operational contract

The supported macOS text/client-tools path is gated to official `agy` **1.2.7**.
An unverified CLI update is refused before a new model process starts. Validate
new versions with the live gates below before changing the compatibility gate.
Linux remains preview until its actual CLI/client flow is verified; Windows is
refused. This is a supported, bounded protocol surface, not full Claude parity.

Each new process rechecks account-provider and paid-credit settings, even when
the model catalogue is cached. Preflight work counts toward capacity. Readiness
checks CLI configuration, not a billable model call; account quota failures are
shown separately in provider status. A quota failure maps to HTTP 429 (or an SSE
error) with retry guidance. Work is never automatically replayed after errors.
Successful terminal CLI output is committed only after a clean process exit.
Slow stream readers have a 1 MiB response-buffer budget; deadlines and process
shutdown still apply. Terminal sandboxing is requested in addition to the deny
hook, but does not claim full isolation of the CLI or all native tools.

MCP tool content is wrapped in `meridian_client_result` JSON. The model is
instructed to decode that exact client content, keeping CLI timing metadata out
of file contents. The live Pi copy gate compares exact bytes and catches leaks.

For the actual macOS app and its managed combined service:

```sh
npm run build
npm ci --prefix apps/desktop
npm run build --prefix apps/desktop
env -u ELECTRON_RUN_AS_NODE apps/desktop/node_modules/.bin/electron \
  scripts/e2e-antigravity-desktop.cjs
```

This creates disposable app data and an isolated managed service, exercises
provider filters and settings, runs actual Pi read/write through Antigravity,
checks the ordinary Claude SDK route, observes both providers' activity, and
stops the owned service. It consumes both accounts' model quota.


CLI behavior references: [headless mode](https://antigravity.google/docs/cli/headless/),
[hooks](https://antigravity.google/docs/hooks), and
[terminal sandbox](https://antigravity.google/docs/sandbox?tab=cli).

## Pi and OpenCode

Both clients use their own tools, permissions and saved sessions. Meridian does
not replace their tool implementations. Completed-turn resume, forks, undo and
compaction use the history supplied by the client; native agy persistent resume
is still unavailable. Client-owned delegation (for example OpenCode's `task`)
is allowed through MCP; Antigravity's built-in delegation remains denied.

These examples use standalone Antigravity on port 3457. For a combined service,
use its port and prepend `/antigravity` to each base URL. If Meridian API-key
protection is configured, replace `local-placeholder` with that local key.

Pi's `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "meridian-agy": {
      "api": "anthropic-messages",
      "baseUrl": "http://127.0.0.1:3457",
      "apiKey": "local-placeholder",
      "models": [{
        "id": "gemini-3.8-flash-low",
        "name": "Antigravity Gemini Flash Low",
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 128000,
        "maxTokens": 4096
      }]
    }
  }
}
```

Run `pi --provider meridian-agy --model gemini-3.8-flash-low --thinking off`.
Pi enables read/edit/bash/write by default. To enable its search tools too, add
`--tools read,edit,bash,write,grep,find,ls`. Add other account model slugs as
separate entries (including Gemini medium/high variants). `reasoning: false`
disables unsupported client thinking-budget controls; it does not disable a
model's intrinsic reasoning. The context/output settings above are conservative
client budgets, not claims about native hard limits.

OpenCode's `opencode.json` (merge the provider into existing configuration):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "meridian-agy": {
      "npm": "@ai-sdk/anthropic",
      "name": "Antigravity through Meridian",
      "options": {
        "baseURL": "http://127.0.0.1:3457/v1",
        "apiKey": "local-placeholder"
      },
      "models": {
        "gemini-3.8-flash-low": {
          "name": "Antigravity Gemini Flash Low",
          "limit": { "context": 128000, "output": 4096 },
          "temperature": false,
          "reasoning": false,
          "tool_call": true,
          "modalities": { "input": ["text"], "output": ["text"] }
        }
      }
    }
  }
}
```

Select `meridian-agy/gemini-3.8-flash-low`. Leave permission choices with the
client; there is no need to globally auto-approve OpenCode tools. Use a configured
Antigravity model for `small_model` as well if title/compaction helper work should
stay on that subscription. This custom provider does not need the Claude-specific
Meridian OpenCode plugin.

For a matching Gemini high model entry, OpenCode model `options` may specify
`{"thinking":{"type":"adaptive"},"effort":"high"}`. Do not apply these options
to low/medium variants or Google-hosted Claude models.

The actual-client gates are:

```sh
npm run build
E2E_CLIENT=pi node scripts/e2e-antigravity-clients.mjs
E2E_CLIENT=opencode E2E_AGY_EFFORT_MODEL=gemini-3.8-flash-high node scripts/e2e-antigravity-clients.mjs
node scripts/e2e-antigravity-opencode-session.mjs
```

They consume subscription quota and retain local fixture artifacts. See
[E2E.md](../E2E.md#antigravity-coding-tool-acceptance-gate) for verified versions,
individual outcomes and retained failures. They establish the listed coding
flows, not image support, every third-party extension, or hard token budgets.
