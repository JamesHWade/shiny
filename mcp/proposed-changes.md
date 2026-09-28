# Proposed changes from shinymcp's experience

2026-09-28. Example implementations on a fork of the `mcp` branch
(`JamesHWade/shiny`, branch `claude/shinymcp-comprehensive-revamp-du3uns`,
based on `mcp-shared-secret`). They come from building the same features in
[shinymcp](https://github.com/JamesHWade/shinymcp). Each change stands on its
own and can be taken or left.

## 1. A result from the call that opens the app

**Problem.** `open_<appId>_app` always answers "The Shiny app is now
displayed in the conversation." The model learns nothing about what the app
shows, and in hosts that can't display apps the sentence isn't true.

**Change.** `mcpConfigure(result = function(arguments) ...)`. The function
gets the model's arguments (filtered by `arguments`), runs outside any
session like a registered tool, and returns a string, a named list
(structured content plus JSON text), `NULL` (the default text), or a promise
of one. An error falls back to the default text with a warning, so the app
still opens.

**Why not render the app for the result.** shinymcp runs the server function
headlessly during the call and reports the outputs. That doubles start-up
work, and any side effects in the server function run twice. The author
knows which few facts the model needs (a row count, record ids), and a
function of the arguments can compute them directly.

Files: `R/mcp-config.R`, `R/mcp-server.R` (`mcpOpenAppCall()`), tests in
`test-mcp-server.R`.

## 2. Arguments set inputs before the first render

**Problem.** See `limitations.md` §1. Authors write an observer that calls
`update*Input()` for each argument, the outputs render twice, and the
person sees the defaults first.

**Change.**

- shiny.js gains `Shiny.deferInitialization(promise)`: initialization waits
  for promises registered before the document is ready.
- When the app declared arguments, the MCP bridge holds initialization until
  `ui/notifications/tool-input` arrives: at most one second after the
  handshake, four in all. It writes each declared argument into the markup
  of the input with the same id: selected options, checked boxes, a
  slider's `data-from`/`data-to` (milliseconds for date sliders), a date
  input's `data-initial-date`, a text or numeric input's value. Shiny's
  bindings then initialize from those values and send them with "init".
- Inputs whose markup the bridge doesn't know (from packages) are set
  through their bindings in a `shiny:connected` handler, and their values
  written into `$initialInput`. The first render is still right, but the
  binding's change event is resent after "init", and the server, whose
  `input` doesn't deduplicate, renders again.
- Arguments that arrive after the session starts, and those the model sends
  with `update_<appId>_app` (as the `shiny.mcp.applyArguments` message), go
  through the bindings like `update*Input()`.
- `mcpUpdates()` still returns every argument, for those that aren't inputs.

**Cost.** Initialization waits for the handshake and the tool input:
typically tens of milliseconds, during which the page shows its widgets
unbound. Apps that declare no arguments don't wait.

Files: `srcts/src/shiny/index.ts`, `srcts/src/mcp/applyArguments.ts`,
`srcts/src/mcp/index.ts`, `R/mcp-server.R` (the page config lists the
declared arguments; the update tool sends the message), tests in
`srcts/src/mcp/__tests__/applyArguments.test.ts` and `test-mcp-session.R`.

## 3. `conditionalPanel()` without `eval()`

**Problem.** The MCP Apps specification's default Content Security Policy
has no `'unsafe-eval'`. `scopeExprToFunc()` builds each condition with
`new Function()`, which that policy refuses: the error escapes
`$updateConditionals()`, and no conditional panel shows.

**Change.** When `new Function()` is refused, `scopeExprToFunc()` falls back
to a small interpreter (`srcts/src/utils/safeExpression.ts`). It reads
literals (numbers, strings, `true`/`false`/`null`/`undefined`, arrays,
regular expressions), `input.x`, `input['x']`, `output.x`, `.length`,
`! - + typeof`, arithmetic, comparisons, `&& ||`, `?:`, and a short list of
string, array, and regular expression methods. Names resolve against the
scope object only, with no access to globals or prototypes. A condition it
can't read shows its panel, with a warning; one that throws while
evaluating hides it. Pages that allow `new Function()` are unchanged.

The same interpreter runs in shinymcp's page script, where its results were
compared against real Shiny for the same conditions.

Files: `srcts/src/utils/index.ts`, `srcts/src/utils/safeExpression.ts`, tests
in `srcts/src/utils/__tests__/safeExpression.test.ts`.

## 4. MCP protocol 2025-11-25 and 2026-07-28

**Change.**

- 2025-11-25 joins the negotiated versions.
- The server declares the MCP Apps extension
  (`capabilities.extensions["io.modelcontextprotocol/ui"]`).
- Stateless 2026-07-28 requests work:
  - `server/discover` lists the supported versions.
  - Each request names its version and the client's capabilities in
    `params._meta`.
  - Over HTTP, the `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name`
    headers must match the body. A mismatch is -32020 with status 400; an
    unsupported version is -32022 with 400; an unknown method is 404.
  - Results carry `resultType` and the server's identity in `_meta`, and
    list results carry caching hints.
- Clients whose capabilities don't include the extension get neither the
  app's `_meta.ui` nor the internal `_shiny_*` tools. Handshake-era clients
  are unchanged.
- CORS allows the new headers. Without that, browsers refuse to send
  stateless requests.

This follows shinymcp's server, which has been tested against the official
TypeScript client and the MCP Apps host SDK in both protocol generations.

Files: `R/mcp-server.R`, `R/mcp-stdio.R`, tests in `test-mcp-server.R`.

## How it was checked

- The branch's R tests pass, with new ones for each change.
- The JavaScript checks in `npm run build` pass: lint, types, tests, and
  type coverage.
- A browser run through shinymcp's host, whose Content Security Policy is
  the specification's default, with `direct = TRUE` and `direct = FALSE`:
  - the app opened from `open_demo_app(n = 200, region = "West")` rendered
    once, with those values;
  - conditional panels followed the inputs;
  - the model received the `result` text;
  - `update_demo_app` changed both inputs in one render.

`npm run bundle_shiny` also needed a fix: it had been refusing the build
since `tunnelXhr.ts` gained a comment containing `jQuery.`. The check in
`srcts/build/_jquery.ts` reads comments too. The build script only logs the
error, so the committed `shiny.js` had quietly stopped updating.

## Not done

- **Argument types from the UI.** Declaring `region =
  ellmer::type_enum(...)` repeats the choices of `selectInput("region")`.
  Reading them from the UI needs the app's tag tree when `tools/list` is
  answered, but the MCP handler only has the rendered page.
- Other gaps met while hosting Shiny apps elsewhere:
  - registered tools are process-global, so they can't reach the session
    of the instance the model is looking at;
  - tools don't publish annotations;
  - each model-context update replaces the one before, including the
    announcement of the session id.
