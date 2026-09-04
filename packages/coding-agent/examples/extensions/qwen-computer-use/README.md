# Qwen Computer Use extension

This extension keeps Pi and browser execution on the local machine while the
selected model can run on a remote OpenAI-compatible server.

It launches an isolated local Chrome profile, injects the current page
observation before each user turn, exposes a sequential `computer_use` tool,
and returns a fresh observation after every action. Observations always include
visible page text, page metrics, and indexed visible controls, and can
optionally include a screenshot. The extension never sends model requests
directly; Pi's selected provider owns the remote HTTP conversation.

## Project-local configuration

This checkout contains the verified reusable configuration in
`.pi/qwen-computer-use/`:

- `models.json` selects the remote Qwen endpoint and model;
- `qwen-computer-use.json` opens `example.com`, allows Google and Baidu, and
  keeps site data in a dedicated browser profile;
- `settings.json` configures Pi auto-compaction and enables the local file
  tools used by this model;
- `.gitignore` excludes sessions, credentials, browser state, and other runtime
  files that Pi may create in that directory.

For another deployment, copy `models.example.json` and replace:

- `baseUrl` with a literal URL reachable from the local machine;
- `REPLACE_WITH_SERVER_MODEL_ID` with the exact ID from `/v1/models`;
- context and output limits with the server's actual values.

`baseUrl` does not support environment interpolation in `models.json`.
`apiKey` does, so the example reads `QWEN38_API_KEY` at request time.

The deployment verified on 2026-08-31 uses:

- SSH host: `cytoai-rf-h20-10`
- model endpoint on that host: `http://127.0.0.1:18001/v1`
- model: `Qwen3.8-27B-phase1-lora`
- context window: `16384` tokens, inherited from its advertised parent model
- maximum configured output: `12288` tokens; Pi reduces this per request to
  preserve `4096` tokens of context safety space

For a server that listens only on its own loopback interface, create a local
SSH forward first:

```bash
ssh -N \
  -L 18001:127.0.0.1:18001 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  cytoai-rf-h20-10
```

Do not expose an unauthenticated model port to the public internet.

## Context window and auto-compaction

The model server and `models.json` both limit the complete request context to
`16384` tokens. The configured `maxTokens: 12288` is an output ceiling inside
that same context window, not an additional allowance. Pi also preserves 4096
tokens of safety space and reduces `max_tokens` as the input grows.

Pi supports automatic context compaction, but its general defaults retain more
tokens than this model can hold. The checked-in
`.pi/qwen-computer-use/settings.json` overrides them:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 4096,
    "keepRecentTokens": 4096
  },
  "defaultTools": ["read", "bash", "edit", "write", "grep", "find", "ls"]
}
```

Compaction starts as the estimated context approaches 12K tokens, summarizes
older content, and retains approximately 4K recent tokens. The provider is
configured with `supportsUsageInStreaming: false`, so Pi receives zero usage
values and falls back to local token estimation. A server response with
`finish_reason: "length"` can surface as `Response was truncated before
completion`; start a new session if an existing session still contains a large
pre-change history.

## Local filesystem tools

The Qwen profile explicitly enables Pi's local `read`, `write`, `edit`,
`grep`, `find`, and `ls` tools. It also preserves the existing `bash` tool.
These tools run in the local Pi process; the remote Qwen server only produces
their tool calls and receives their results.

| Operation | Tool |
| --- | --- |
| Read a file | `read` |
| Create or replace a file | `write` |
| Replace selected content in a file | `edit` |
| Search file contents | `grep` |
| Search paths by glob | `find` |
| List a directory | `ls` |

The browser-scoped `computer_use` tool does not duplicate filesystem actions.
Starting Pi with `--tools`, `--exclude-tools`, `--no-tools`, or
`--no-builtin-tools` can override or disable the configured tools.

## Configure the local browser

Edit `.pi/qwen-computer-use/qwen-computer-use.json` to change the initial page,
exact navigation origins, and dedicated Chrome profile. The checked-in
configuration is:

```json
{
  "userDataDir": "browser-profile",
  "sendScreenshots": false,
  "startUrl": "https://example.com",
  "allowedOrigins": [
    "https://example.com",
    "https://google.com",
    "https://www.google.com",
    "https://www.baidu.com",
    "https://wappass.baidu.com"
  ],
  "headless": false
}
```

The extension loads `$PI_CODING_AGENT_DIR/qwen-computer-use.json`. Without that
variable, it falls back to `~/.pi/agent/qwen-computer-use.json`. Set
`PI_CUA_CONFIG_PATH` to load another path explicitly. Environment variables
override values from the JSON file.

`sendScreenshots` controls image transmission:

- `false`: send URL, title, viewport, page list, and visible page text only;
- `true`: include a JPEG screenshot with the newest browser observation;
- `PI_CUA_SEND_SCREENSHOTS=true|false`: override the JSON value for the current
  process.

## Browser actions and observations

The tool supports coordinate input plus indexed controls derived from Chrome's
Accessibility tree. Prefer the indexed actions when the target appears in
`interactiveElements`; their numeric indexes remain stable while the underlying
DOM nodes remain present.

- Page control: `navigate`, `go_back`, `wait`, `list_pages`, `switch_page`, and
  `close_page`.
- Page inspection: `screenshot`, `search_page`, `find_text`, and
  `find_elements`.
- Indexed controls: `click_element`, `input_element`, and `select_dropdown`.
- Coordinate controls: `left_click`, `double_click`, `type`, `key`, and
  `scroll`.

Each result can include `pageInfo` scroll/content metrics,
`interactiveElements`, `recentEvents`, and an action-specific `actionResult`.
New tabs are selected automatically, JavaScript dialogs are dismissed and
reported, and repeated actions against an unchanged page return a progress
warning.

These capabilities adapt browser-control patterns reviewed in
[`browser-use/browser-use`](https://github.com/browser-use/browser-use) to the
existing local TypeScript/CDP runtime. The extension does not add a runtime
dependency on browser-use or replace Pi's agent, model, session, or filesystem
layers.

## Screenshot transport and retention

When screenshots are enabled, Chrome CDP captures a JPEG and returns its Base64
data. The extension represents it as an image content block:

```json
{
  "type": "image",
  "data": "<base64 JPEG>",
  "mimeType": "image/jpeg"
}
```

The `openai-completions` adapter converts that block to an OpenAI-compatible
`image_url` containing `data:image/jpeg;base64,...`. It is embedded in the JSON
body sent to `/v1/chat/completions`; it is not a multipart file upload. Base64
adds roughly one third to the JPEG byte size. With the documented SSH forward,
the local HTTP request is carried inside the encrypted SSH tunnel.

Before every model request, the extension removes images from older Computer
Use observations. Only the newest browser-state image is eligible for
transmission; unrelated images explicitly attached by the user remain. This
filter is non-destructive: old screenshots can remain in the session JSONL even
though they are omitted from later model requests. With the checked-in
`sendScreenshots: false`, no browser image is captured or transmitted.

## Site verification handoff

Baidu may redirect a search to `wappass.baidu.com/static/captcha/`, while
Google may redirect to `*.google.com/sorry/`. Both are server-side risk
controls. A persistent profile can reuse site data after a person completes a
challenge, but it cannot guarantee that either site will never request
verification again.

The extension treats both verification URL patterns, plus Baidu pages titled
`百度安全验证`, as a manual-action boundary. It sets
`manualVerificationRequired: true`, returns the observation as a tool error,
and blocks automated click, double-click, typing, key, and scroll actions while
the challenge remains visible. Complete the verification manually in the
visible Chrome window, then send a new Pi prompt. The next browser action first
checks the current page and resumes only after the verification page is gone.

The extension intentionally does not use macOS-wide mouse or keyboard events to
simulate a person and does not attempt to solve or evade CAPTCHA challenges.
OS-wide input could affect other applications and disguising automation would
not make site risk decisions predictable.

Live session traces contain both a Baidu CAPTCHA redirect and a Google
`/sorry/index` redirect. A fresh-profile Baidu smoke test confirmed the
boundary: the redirect returned `manualVerificationRequired: true`, and the
next coordinate click returned `blocked: true` without being dispatched to
Chrome. Regression tests cover the same detection and input blocking for
Google.

## Run

```bash
export QWEN38_API_KEY=EMPTY
export PI_CODING_AGENT_DIR="$PWD/.pi/qwen-computer-use"
export PI_CODING_AGENT_SESSION_DIR=/private/tmp/pi-qwen-cua-sessions

./pi-test.sh \
  -e packages/coding-agent/examples/extensions/qwen-computer-use/index.ts \
  --provider qwen-cua-server \
  --model Qwen3.8-27B-phase1-lora
```

Then enter a request in the Pi TUI:

```text
Observe the current page. Describe its title and main text without changing anything.
```

For a different page, change `startUrl` and add its exact origin to
`allowedOrigins`. Keep the SSH tunnel running while Pi is active.

`EMPTY` is only appropriate for a server without authentication that is reached
through a private tunnel. Use a real credential for a gateway.

## Local browser configuration

| JSON key | Environment override | Description | Default |
| --- | --- | --- | --- |
| — | `PI_CUA_CONFIG_PATH` | Explicit JSON config path | agent directory file |
| `browserExecutable` | `PI_CUA_BROWSER_EXECUTABLE` | Chrome/Chromium executable | platform discovery |
| `userDataDir` | `PI_CUA_USER_DATA_DIR` | Dedicated persistent Chrome profile; relative JSON paths resolve from the config file | temporary profile |
| `sendScreenshots` | `PI_CUA_SEND_SCREENSHOTS` | Attach JPEG screenshots to model observations | `true` |
| `startUrl` | `PI_CUA_START_URL` | Initial local page | `about:blank` |
| `allowedOrigins` | `PI_CUA_ALLOWED_ORIGINS` | Exact origins allowed for top-level navigation; the environment form is comma-separated | loopback HTTP origins |
| `headless` | `PI_CUA_HEADLESS` | `true`/`1` for headless Chrome | `false` |

Unknown JSON keys and invalid value types stop startup with a configuration
error so a misspelled allowlist cannot silently weaken or block navigation.
Visible page text is capped at 12,000 characters per observation. With
`sendScreenshots: false`, the `screenshot` action returns text metadata without
an image; coordinate clicks are less reliable without visual grounding, so
prefer indexed controls and page inspection actions.
The allowlist applies to the selected page's top-level navigation, not embedded
frames or other page resources. A live Baidu search showed
`https://wappass.baidu.com` as a main-frame intermediate navigation, so the
checked-in configuration permits that exact origin. Navigation waits for DOM
content, but a slow page no longer terminates Pi when that CDP event exceeds the
request timeout; its rejection is handled immediately even while
`Page.navigate` is still pending. A transient empty URL reported for a Chrome
page target is treated as `about:blank`; user-supplied navigation URLs remain
strictly validated.

The checked-in configuration uses a dedicated persistent profile and binds
DevTools to loopback. Persistent site data allows a manually completed
verification to survive Pi restarts, which can reduce repeated challenges.
Baidu and Google can still require verification based on their own risk
controls. Use this directory for only one Pi browser at a time, do not commit
it, and do not point `userDataDir` at the user's normal Chrome profile.

## Local commands without a model

Configure `localCommands.sites` to handle common navigation and search input
inside the local extension before Pi starts an agent turn. The checked-in
configuration maps Google and Baidu aliases. Supported forms include:

```text
/open google
open baidu
打开谷歌
请帮我访问百度官网。
/search google pi agent
search baidu TypeScript
在 Google 搜索 pi agent
用百度搜索 TypeScript
百度一下今天天气。
麻烦用谷歌查一下 TypeScript
```

Each site entry has an exact alias list and navigation URL. An optional
`search` object specifies the search endpoint and query parameter:

```json
{
  "localCommands": {
    "sites": [
      {
        "aliases": ["google", "谷歌"],
        "url": "https://www.google.com/",
        "search": {
          "url": "https://www.google.com/search?hl=zh-CN",
          "queryParameter": "q"
        }
      }
    ]
  }
}
```

Local commands run only while the agent is idle and the input has no image
attachments. Unknown or ambiguous input continues through the normal model
flow. Once a local command matches, execution failures are reported locally
instead of falling back to the model, avoiding duplicate navigation. All local
URLs remain subject to `allowedOrigins`. A small built-in phrase dictionary
covers common request prefixes, open/search synonyms, `一下`, site suffixes,
and Chinese sentence punctuation. These rules are precompiled when the
extension loads; site aliases still require an exact configured match.

The `computer_use` tool intentionally excludes OS-wide input, arbitrary
JavaScript, filesystem operations, shell commands, downloads, and automatic
CAPTCHA handling. Local filesystem and shell access comes from Pi's separate
built-in tools configured in `settings.json`. Browser page content and
model-produced tool arguments are untrusted data.
