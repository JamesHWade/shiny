# MCP Apps: known limitations

Constraints discovered while building Shiny's MCP App support, verified against
a real host (Claude Desktop, stdio transport). These shape the design in
`design-mcpConfigure.md`; record them here so we don't re-litigate settled
dead ends.

## 1. Init arguments cannot auto-restore input widgets (no flash-free restore)

**What we wanted:** the model opens the app with `open_app(n = 200)` and the
`sliderInput("n")` is *born* at 200 — no author code, no visible jump — by
reusing Shiny's bookmark `RestoreContext` / `restoreInput()`.

**Why it can't work:** normal bookmarking restores a widget because the page is
rendered **server-side with the restore context active** (from the URL query
string), so `restoreInput()` bakes the value into the widget HTML, and the
browser reports it back. For an MCP App:

- The UI is rendered at `resources/read` (via `renderMcpAppHtml()` →
  `uiHandler(mcpFakePageRequest())`), with **no query string and no arguments**
  — the tool-call arguments are not part of `resources/read`.
- The arguments reach the *client* only afterward, via the async
  `ui/notifications/tool-input` (`ontoolinput`) notification, *after* the
  widget HTML has already rendered at its defaults.
- There is no subsequent page-GET of the app to carry the args (the resource is
  shown in a sandboxed `srcdoc` iframe; direct-connect only upgrades the
  websocket, it does not navigate the frame).

So `restoreInput()` always runs against an empty context and returns the
default. Only server-side `onRestore()` could see the args, and even that
races (see below) — so we do **not** use `RestoreContext` for MCP at all.

### The `resourceUri`-with-args idea — tested, does NOT work

We tried having the `open_*` tool result return a per-call resource URI that
encodes the arguments (`ui://shiny/app?_inputs_&n=200`), hoping the host would
pass it to `resources/read` so we could render with the args. **Claude ignores
it:** it issued `resources/read` with the static `ui://shiny/app` (no query),
~4ms *before* the tool call even returned. Hosts choose the resource from the
static tool/resource `_meta`, not from the tool-call result. Dead end.

**Consequence:** init arguments are delivered through the reactive
`mcpUpdates()` channel and applied by the author with `updateXxxInput()`. A
brief flash (default → model's value) on open is unavoidable.

### Update, 2026-09-28: solved on the client instead

The restore doesn't have to happen on the server. The arguments reach the page
before Shiny *needs* them: hosts send `ui/notifications/tool-input` right
after the handshake, and the session can't start before the handshake anyway
(the tunnel calls tools through the host). So the bridge now holds Shiny's
initialization (new `Shiny.deferInitialization(promise)`) until the arguments
arrive, at most one second after the handshake, and writes each declared
argument into the markup of the input with the same id (a `<select>`'s
selected options, a slider's `data-from`, a date input's
`data-initial-date`, and so on). Shiny's own bindings then initialize from
those values and send them with "init": the server function's first render
uses the model's values, nothing is sent twice, and no author code is needed.
See `srcts/src/mcp/applyArguments.ts` and `proposed-changes.md`.

Two things we tried first, and why they fell short:

- *Rewriting the "init" message in a `shiny:connected` handler* (after
  setting each widget through its binding) gets the first render right, but
  the widget's change event queues a resend that goes out after "init".
  `session$input` is created with `dedupe = FALSE` (the client's
  `InputNoResendDecorator` is meant to drop duplicates, and its cache was
  filled from the defaults), so the server renders a second time. This is
  still the fallback for inputs from packages, whose markup the bridge
  doesn't know.
- *Holding the socket open* until the arguments arrive has the same problem;
  the inputs have already been bound and cached by then.

## 2. There is no in-place "update the running app" — hosts re-render per call

The model's only lever on the app is calling a tool. When asked to change a
parameter, Claude **re-invokes `open_*`**, and the host renders a **fresh app
instance** (a new Shiny session with a new `session$token`) for each call —
verified: two opens produced sessions `1ec8…` then `8820…`. It does not send an
in-place tool-input update to the already-rendered instance, and the model has
no "update" verb to do so.

**Consequence:**

- "Initial open" and "re-open with new args" are the *same event* to the app —
  which is why a single `mcpUpdates()` observer handles both.
- True live re-steering of a running instance requires an explicit
  server-side update tool the model can call. Tracked in
  rstudio/shiny#4415.

## 3. The init-vs-update channel was a race (now removed)

An earlier design split init args into `RestoreContext`/`onRestore` and later
args into `mcpUpdates()`, gated by a timeout on when `ontoolinput` arrived
relative to socket start. In practice the *same* opening arguments landed on
different channels purely by timing (session A → `mcpUpdates`, session B →
`onRestore`), so an author couldn't predict which fired. Resolved by routing
**every** `ontoolinput` (opening and later) to the single `mcpUpdates()`
channel.

## 4. Host-passthrough spike: session token visibility

**What needs verification:** the `mcpAnnounceSession()` call emits a
`structuredContent { session, state }` envelope plus a text instruction ("This
app instance's id is ...") via the `updateModelContext` bridge channel. For
`update_<appId>_app` to work, the host must forward the `structuredContent` and
the text into the model's readable context so the model can echo the session id
into `update_*(session = ...)`.

**Status:** ✅ **Confirmed in Claude Desktop (2026-07-17).** The host forwards
the announced session token into the model's context, and the model calls
`update_<appId>_app` in place (rather than re-opening) to change the running
instance. Also verified earlier with the MCP Inspector (stdio transport). Not
yet spot-checked on claude.ai (web) — its iframe CSP handling differs, so the
tunnel transport is expected to carry it, but confirm when convenient.

## 5. Multi-instance caveat

When several instances of the same app are open simultaneously, the model
receives one session-token announcement per instance. To update a specific
instance, the model must select the correct token. The model
targets/loops per handle — it has no built-in mechanism to disambiguate beyond
matching the text context (e.g. heading labels) the app provides via
`mcpUpdateModelContext()`.

**Status:** ✅ Exercised in Claude Desktop (2026-07-17): with two instances of
the same app open, updating the *first* instance's label targeted the correct
session token. This is not a server-side guarantee — the model chose correctly
from context — so the caveat remains a theoretical risk, but it works in
practice for the common case.

**Mitigation:** apps that expect multiple simultaneous instances should include
distinguishing information (e.g. a label or purpose) in their
`mcpUpdateModelContext()` text so the model can pair tokens to instances.

## Summary

| Wanted | Reality |
|---|---|
| Flash-free widget auto-restore of init args | Not possible — args aren't available at render time |
| Args via a per-call `resourceUri` | Host ignores it; reads the static URI |
| Live in-place update of a running app | Implemented via `update_<appId>_app`; host-passthrough (section 4) and multi-instance targeting (section 5) confirmed working in Claude Desktop 2026-07-17 |
| Deterministic init channel | Achieved by using one channel (`mcpUpdates()`) for all args |
