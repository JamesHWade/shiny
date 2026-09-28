test_that("mcpHttpHandler ignores other paths and handles OPTIONS/GET", {
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  expect_null(h(mcp_req(NULL, method = "GET", path = "/other")))

  opts <- h(mcp_req(NULL, method = "OPTIONS"))
  expect_equal(opts$status, 204L)
  expect_equal(opts$headers[["Access-Control-Allow-Origin"]], "*")
  # Browsers may send the headers that stateless (2026-07-28) requests carry.
  allowed <- opts$headers[["Access-Control-Allow-Headers"]]
  for (header in c("Mcp-Protocol-Version", "Mcp-Method", "Mcp-Name")) {
    expect_match(allowed, header, fixed = TRUE)
  }

  get <- h(mcp_req(NULL, method = "GET"))
  expect_equal(get$status, 405L)
})

test_that("initialize negotiates protocol version", {
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)

  out <- mcp_post(
    h, "initialize",
    params = list(protocolVersion = "2025-06-18", capabilities = empty_named_list())
  )
  expect_equal(out$result$protocolVersion, "2025-06-18")
  expect_equal(out$result$serverInfo$name, "shiny")
  expect_true(is.list(out$result$capabilities$tools))

  out2 <- mcp_post(
    h, "initialize",
    params = list(protocolVersion = "9999-01-01", capabilities = empty_named_list())
  )
  expect_equal(out2$result$protocolVersion, "2025-11-25")
})

test_that("notifications get 202, unknown methods get -32601, ping works", {
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)

  notif <- h(mcp_req(list(jsonrpc = "2.0", method = "notifications/initialized")))
  expect_equal(notif$status, 202L)

  out <- mcp_post(h, "bogus/method")
  expect_equal(out$error$code, -32601L)

  out <- mcp_post(h, "ping")
  expect_true(is.list(out$result))
  expect_length(out$result, 0)
})

test_that("invalid JSON gets a parse error", {
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  req <- mcp_req(NULL)
  req$rook.input <- fakeRookInput(charToRaw("not json"))
  resp <- h(req)
  expect_equal(resp$status, 400L)
  out <- jsonlite::parse_json(rawToChar(as_bytes(resp$content)))
  expect_equal(out$error$code, -32700L)
})

test_that("tools/list includes the visible app tool with ui metadata", {
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  out <- mcp_post(h, "tools/list")
  tools <- out$result$tools
  tool_names <- vapply(tools, function(t) t$name, character(1))
  expect_true("open_shiny_app" %in% tool_names)
  app_tool <- tools[[which(tool_names == "open_shiny_app")]]
  expect_equal(app_tool$`_meta`$ui$resourceUri, "ui://shiny/app")
})

test_that("tool name and description are configurable", {
  local_mcp_config(appId = "dashboard", description = "Show it")
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  out <- mcp_post(h, "tools/list")
  tool_names <- vapply(out$result$tools, function(t) t$name, character(1))
  expect_true("open_dashboard_app" %in% tool_names)

  called <- mcp_post(h, "tools/call",
    params = list(name = "open_dashboard_app", arguments = empty_named_list())
  )
  expect_match(called$result$content[[1]]$text, "displayed")
})

test_that("createAppHandlers mounts /mcp only when enabled", {
  ui <- fluidPage("hello mcp")
  app <- shinyApp(ui, function(input, output) {})
  make_handler <- function() {
    h <- createAppHandlers(app$httpHandler, function() function(input, output) {})
    h$http
  }
  local_mcp_config()
  resp <- wait_for_result(make_handler()(mcp_req(
    list(jsonrpc = "2.0", id = 1, method = "ping")
  )))
  expect_equal(resp$status, 200L)

  local_mcp_config(enabled = FALSE)
  expect_null(make_handler()(mcp_req(
    list(jsonrpc = "2.0", id = 1, method = "ping")
  )))
})

test_that("registered author tools appear in tools/list with JSON schema", {
  skip_if_not_installed("ellmer")
  local_mcp_tools()
  registerMcpTool(
    ellmer::tool(
      function(x, y) list(sum = x + y),
      name = "add_numbers",
      description = "Add two numbers.",
      arguments = list(
        x = ellmer::type_number("x", required = TRUE),
        y = ellmer::type_number("y", required = TRUE)
      )
    ),
    ellmer::tool(function() "Hello from R", name = "get_motd",
      description = "Get the message of the day.")
  )
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  out <- mcp_post(h, "tools/list")

  # tools must serialize as a JSON array, not an object
  expect_null(names(out$result$tools))
  tool_names <- vapply(out$result$tools, function(t) t$name, character(1))
  expect_true(all(c("add_numbers", "get_motd") %in% tool_names))

  add_tool <- out$result$tools[[which(tool_names == "add_numbers")]]
  expect_equal(add_tool$inputSchema$type, "object")
  expect_equal(add_tool$inputSchema$properties$x$type, "number")
  # required must be a JSON array even when derived from ellmer
  expect_equal(add_tool$inputSchema$required, list("x", "y"))
  expect_null(add_tool$inputSchema$description)

  # a tool with no arguments still advertises an object schema with properties
  motd <- out$result$tools[[which(tool_names == "get_motd")]]
  expect_equal(motd$inputSchema$type %||% "object", "object")
})

test_that("registered author tools execute via tools/call", {
  skip_if_not_installed("ellmer")
  local_mcp_tools()
  registerMcpTool(
    ellmer::tool(function(x, y) list(sum = x + y), name = "add_numbers",
      description = "Add two numbers.",
      arguments = list(
        x = ellmer::type_number("x", required = TRUE),
        y = ellmer::type_number("y", required = TRUE)
      )),
    ellmer::tool(function() "Hello from R", name = "get_motd",
      description = "Get the message of the day.")
  )
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)

  res <- mcp_post(h, "tools/call",
    params = list(name = "add_numbers", arguments = list(x = 2, y = 40)))
  expect_equal(res$result$structuredContent$sum, 42)
  expect_match(res$result$content[[1]]$text, "42")

  res <- mcp_post(h, "tools/call",
    params = list(name = "get_motd", arguments = empty_named_list()))
  expect_equal(res$result$content[[1]]$text, "Hello from R")
  expect_null(res$result$structuredContent)
})

test_that("author tool errors become isError results, not crashes", {
  skip_if_not_installed("ellmer")
  local_mcp_tools()
  registerMcpTool(
    ellmer::tool(function(why) stop("kaboom: ", why), name = "boom",
      description = "Always fails.",
      arguments = list(why = ellmer::type_string("why", required = TRUE)))
  )
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  res <- mcp_post(h, "tools/call",
    params = list(name = "boom", arguments = list(why = "testing")))
  expect_true(isTRUE(res$result$isError))
  expect_match(res$result$content[[1]]$text, "kaboom: testing")
})

test_that("async author tools (promises) are supported", {
  skip_if_not_installed("ellmer")
  local_mcp_tools()
  registerMcpTool(
    ellmer::tool(
      function() promises::promise(function(resolve, reject) {
        later::later(function() resolve(list(answer = 42)), 0.1)
      }),
      name = "slow_answer", description = "Answers later.")
  )
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  res <- mcp_post(h, "tools/call",
    params = list(name = "slow_answer", arguments = empty_named_list()))
  expect_equal(res$result$structuredContent$answer, 42)
})

test_that("mcpDirectBase honors option > Connect headers > request origin", {
  req <- new.env(parent = emptyenv())
  req$HTTP_HOST <- "connect.example.com"
  req$HTTP_X_FORWARDED_PROTO <- "https"

  # Request-derived origin (no path information)
  expect_equal(mcpDirectBase(req), "https://connect.example.com")

  # shinyapps.io sends external host + path (schemeless) in
  # X-Redx-Frontend-Name
  req$HTTP_X_REDX_FRONTEND_NAME <- "barret.shinyapps.io/my-app/"
  expect_equal(mcpDirectBase(req), "https://barret.shinyapps.io/my-app")

  # Connect forwards the full external URL of the request (API content)
  req$HTTP_X_RSC_REQUEST <- "https://connect.example.com/content/abc123/mcp"
  expect_equal(mcpDirectBase(req), "https://connect.example.com/content/abc123")

  # Connect sends the app's base URL with every request to Shiny content;
  # it wins over everything but the option (needs no path surgery)
  req$HTTP_RSTUDIO_CONNECT_APP_BASE_URL <-
    "https://connect.example.com/content/def456/"
  expect_equal(mcpDirectBase(req), "https://connect.example.com/content/def456")

  # Explicit origin wins over everything, trailing slash normalized
  local_mcp_config(origin = "https://other.example.com/apps/dash/")
  expect_equal(mcpDirectBase(req), "https://other.example.com/apps/dash")
})

test_that("appId namespaces internal tools and the resource", {
  local_mcp_config(appId = "sales")

  expect_equal(mcpResourceUri(), "ui://shiny/sales")
  expect_equal(mcpTunnelToolName("_shiny_connect"), "sales_shiny_connect")
  expect_equal(mcpTunnelLocalName("sales_shiny_http"), "_shiny_http")
  # names that don't carry the prefix pass through unchanged
  expect_equal(mcpTunnelLocalName("_shiny_http"), "_shiny_http")
  expect_equal(mcpTunnelLocalName("sales_tool"), "sales_tool")

  tool_names <- vapply(mcpToolsList(), function(t) t$name, character(1))
  expect_true("sales_shiny_connect" %in% tool_names)
  expect_false("_shiny_connect" %in% tool_names)
  # the app tool advertises the namespaced resource
  app_tool <- mcpToolsList()[[1]]
  expect_equal(app_tool$`_meta`$ui$resourceUri, "ui://shiny/sales")
  expect_equal(mcpResourcesList()[[1]]$uri, "ui://shiny/sales")
})

test_that("mcpDirectBase ignores empty headers and prefers X-Forwarded-Host", {
  req <- new.env(parent = emptyenv())
  req$HTTP_HOST <- "127.0.0.1:34599"
  req$HTTP_X_FORWARDED_PROTO <- "https"
  # shinyapps.io sends this header with an empty value to Shiny content
  req$HTTP_RSTUDIO_CONNECT_APP_BASE_URL <- ""

  # the internal Host is replaced by the forwarded external host
  req$HTTP_X_FORWARDED_HOST <- "barret.shinyapps.io"
  expect_equal(mcpDirectBase(req), "https://barret.shinyapps.io")
})

test_that("mcpDeployedUrl finds a host-matched rsconnect deployment record", {
  dir <- withr::local_tempdir()
  rec <- file.path(dir, "rsconnect", "connect.example.com", "barret")
  dir.create(rec, recursive = TRUE)
  write.dcf(
    data.frame(
      name = "myapp",
      server = "connect.example.com",
      url = "https://connect.example.com/content/abc123/"
    ),
    file.path(rec, "myapp.dcf")
  )
  rec2 <- file.path(dir, "rsconnect", "shinyapps.io", "barret")
  dir.create(rec2, recursive = TRUE)
  write.dcf(
    data.frame(
      name = "myapp",
      server = "shinyapps.io",
      url = "https://barret.shinyapps.io/myapp/"
    ),
    file.path(rec2, "myapp.dcf")
  )

  # Host match picks the right record and strips the trailing slash
  expect_equal(
    mcpDeployedUrl(dir, "connect.example.com"),
    "https://connect.example.com/content/abc123"
  )
  expect_equal(
    mcpDeployedUrl(dir, "barret.shinyapps.io"),
    "https://barret.shinyapps.io/myapp"
  )
  # No match (e.g. running locally): never use a deployment record
  expect_null(mcpDeployedUrl(dir, "127.0.0.1:7788"))
  expect_null(mcpDeployedUrl(dir, NULL))
  # No records at all
  expect_null(mcpDeployedUrl(withr::local_tempdir(), "connect.example.com"))
})

test_that("resources/read uses the path-aware base: origin-only CSP, full directBase", {
  ui <- fluidPage("hi")
  app <- shinyApp(ui, function(input, output) {})
  local_mcp_config(origin = "https://connect.example.com/content/abc123/")
  handlers <- createAppHandlers(
    app$httpHandler,
    function() function(input, output) {}
  )
  req <- mcp_req(list(
    jsonrpc = "2.0", id = 1, method = "resources/read",
    params = list(uri = "ui://shiny/app")
  ))
  out <- jsonlite::parse_json(rawToChar(as_bytes(
    wait_for_result(handlers$http(req))$content
  )))
  csp <- unlist(out$result$contents[[1]]$`_meta`$ui$csp$connectDomains)
  # CSP entries are origins only (host CSP sanitizers reject paths)
  expect_setequal(
    csp,
    c("https://connect.example.com", "wss://connect.example.com")
  )
  # ...but the bridge gets the full base including the path
  expect_match(
    out$result$contents[[1]]$text,
    '"directBase":"https://connect.example.com/content/abc123"',
    fixed = TRUE
  )
})

test_that("update_<appId>_app is listed only when arguments are declared", {
  skip_if_not_installed("ellmer")

  # No arguments: no update tool.
  local_mcp_config(appId = "demo")
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  names_no_args <- vapply(
    mcp_post(h, "tools/list")$result$tools, function(t) t$name, character(1)
  )
  expect_false("update_demo_app" %in% names_no_args)

  # With arguments: update tool present, schema carries required `session`.
  local_mcp_config(
    appId = "demo",
    arguments = list(note = ellmer::type_string("A note"))
  )
  tools <- mcp_post(h, "tools/list")$result$tools
  nms <- vapply(tools, function(t) t$name, character(1))
  expect_true("update_demo_app" %in% nms)

  upd <- tools[[which(nms == "update_demo_app")]]
  expect_equal(upd$inputSchema$properties$session$type, "string")
  expect_equal(upd$inputSchema$properties$note$type, "string")
  expect_true("session" %in% unlist(upd$inputSchema$required))
  expect_match(upd$description, "in place", ignore.case = TRUE)
})

test_that("update tool name follows appId and reserves the name", {
  skip_if_not_installed("ellmer")
  local_mcp_config(arguments = list(x = ellmer::type_integer("x")))
  expect_equal(mcpUpdateToolName(), "update_shiny_app")
  expect_true("update_shiny_app" %in% mcpReservedToolNames())

  local_mcp_config(appId = "clock", arguments = list(x = ellmer::type_integer("x")))
  expect_equal(mcpUpdateToolName(), "update_clock_app")
  expect_true("update_clock_app" %in% mcpReservedToolNames())
})

test_that("mcpDeployedUrl reads Posit Publisher deployment records", {
  dir <- withr::local_tempdir()
  rec_dir <- file.path(dir, ".posit", "publish", "deployments")
  dir.create(rec_dir, recursive = TRUE)
  writeLines(
    c(
      "$schema = 'https://cdn.posit.co/publisher/schemas/posit-publishing-record-schema-v3.json'",
      "server_type = 'connect'",
      "server_url = 'https://connect.example.com'",
      "id = 'abc-123'",
      "dashboard_url = 'https://connect.example.com/connect/#/apps/abc-123'",
      "direct_url = 'https://connect.example.com/content/abc-123/'"
    ),
    file.path(rec_dir, "deployment-A1B2.toml")
  )
  expect_equal(
    mcpDeployedUrl(dir, "connect.example.com"),
    "https://connect.example.com/content/abc-123"
  )
  expect_null(mcpDeployedUrl(dir, "other.example.com"))
})

test_that("initialize accepts 2025-11-25 and declares the MCP Apps extension", {
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  out <- mcp_post(
    h, "initialize",
    params = list(protocolVersion = "2025-11-25", capabilities = empty_named_list())
  )
  expect_equal(out$result$protocolVersion, "2025-11-25")
  expect_true(
    "io.modelcontextprotocol/ui" %in% names(out$result$capabilities$extensions)
  )
})

test_that("server/discover lists both protocol generations", {
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  out <- mcp_post(h, "server/discover")
  versions <- unlist(out$result$supportedVersions)
  expect_true(all(c("2026-07-28", "2025-11-25", "2024-11-05") %in% versions))
  expect_equal(out$result$serverInfo$name, "shiny")
})

test_that("stateless requests are served without a handshake", {
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  res <- mcp_response(h, mcp_stateless_req("tools/list"))
  expect_equal(res$status, 200L)
  result <- res$body$result
  expect_equal(result$resultType, "complete")
  expect_equal(result$`_meta`[["io.modelcontextprotocol/serverInfo"]]$name, "shiny")
  expect_equal(result$ttlMs, 60000)
  tool_names <- vapply(result$tools, function(t) t$name, character(1))
  expect_true("open_shiny_app" %in% tool_names)
  expect_true("_shiny_connect" %in% tool_names)

  called <- mcp_response(h, mcp_stateless_req(
    "tools/call",
    params = list(name = "open_shiny_app", arguments = empty_named_list())
  ))
  expect_equal(called$status, 200L)
  expect_match(called$body$result$content[[1]]$text, "displayed")
  expect_equal(called$body$result$resultType, "complete")
})

test_that("stateless clients that can't show apps get no app metadata", {
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  res <- mcp_response(h, mcp_stateless_req("tools/list", ui = FALSE))
  tools <- res$body$result$tools
  tool_names <- vapply(tools, function(t) t$name, character(1))
  expect_false(any(startsWith(tool_names, "_shiny_")))
  app_tool <- tools[[which(tool_names == "open_shiny_app")]]
  expect_null(app_tool$`_meta`)
})

test_that("stateless requests must mirror their version, method, and target in headers", {
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)

  missing <- mcp_response(h, mcp_stateless_req("tools/list", headers = list()))
  expect_equal(missing$status, 400L)
  expect_equal(missing$body$error$code, -32020L)

  wrong_method <- mcp_response(h, mcp_stateless_req(
    "tools/list",
    headers = list("MCP-Protocol-Version" = "2026-07-28", "Mcp-Method" = "tools/call")
  ))
  expect_equal(wrong_method$status, 400L)
  expect_match(wrong_method$body$error$message, "Mcp-Method")

  wrong_name <- mcp_response(h, mcp_stateless_req(
    "tools/call",
    params = list(name = "open_shiny_app", arguments = empty_named_list()),
    headers = list(
      "MCP-Protocol-Version" = "2026-07-28",
      "Mcp-Method" = "tools/call",
      "Mcp-Name" = "something_else"
    )
  ))
  expect_equal(wrong_name$status, 400L)
  expect_match(wrong_name$body$error$message, "Mcp-Name")

  encoded <- mcp_response(h, mcp_stateless_req(
    "tools/call",
    params = list(name = "open_shiny_app", arguments = empty_named_list()),
    headers = list(
      "MCP-Protocol-Version" = "2026-07-28",
      "Mcp-Method" = "tools/call",
      "Mcp-Name" = paste0("=?base64?", jsonlite::base64_enc(charToRaw("open_shiny_app")), "?=")
    )
  ))
  expect_equal(encoded$status, 200L)
})

test_that("stateless errors: unsupported versions and unknown methods", {
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  old <- mcp_response(h, mcp_stateless_req("tools/list", version = "2099-01-01"))
  expect_equal(old$status, 400L)
  expect_equal(old$body$error$code, -32022L)
  expect_true("2026-07-28" %in% unlist(old$body$error$data$supported))

  unknown <- mcp_response(h, mcp_stateless_req("bogus/method"))
  expect_equal(unknown$status, 404L)
  expect_equal(unknown$body$error$code, -32601L)
})

test_that("handshake-era requests with an unknown version header are refused", {
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  req <- mcp_req(
    list(jsonrpc = "2.0", id = 1, method = "tools/list"),
    headers = list("MCP-Protocol-Version" = "1999-01-01")
  )
  res <- mcp_response(h, req)
  expect_equal(res$status, 400L)

  ok <- mcp_req(
    list(jsonrpc = "2.0", id = 1, method = "tools/list"),
    headers = list("MCP-Protocol-Version" = "2025-11-25")
  )
  expect_equal(mcp_response(h, ok)$status, 200L)
})

test_that("stateless requests work over stdio, without headers", {
  dispatch <- function(body) mcpDispatch(body, function(req) NULL, function(ws) TRUE)
  written <- character()
  line <- as.character(jsonlite::toJSON(list(
    jsonrpc = "2.0", id = 7, method = "tools/list",
    params = list(`_meta` = list(
      "io.modelcontextprotocol/protocolVersion" = "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities" = empty_named_list()
    ))
  ), auto_unbox = TRUE))
  mcpStdioHandleLine(line, dispatch, function(x) written <<- c(written, x))
  out <- jsonlite::parse_json(written[[1]])
  expect_equal(out$id, 7L)
  expect_equal(out$result$resultType, "complete")
})

test_that("mcpConfigure(result = ) answers the call that opens the app", {
  skip_if_not_installed("ellmer")
  h <- mcpHttpHandler(function(req) NULL, function(ws) TRUE)
  open_app <- function(arguments = empty_named_list()) {
    mcp_post(h, "tools/call", params = list(
      name = "open_shiny_app", arguments = arguments
    ))$result
  }

  seen <- NULL
  local_mcp_config(
    arguments = list(region = ellmer::type_string("Region")),
    result = function(args) {
      seen <<- args
      paste("Showing sales for", args$region)
    }
  )
  res <- open_app(list(region = "West", undeclared = "x"))
  expect_equal(res$content[[1]]$text, "Showing sales for West")
  # Only declared arguments reach the function.
  expect_equal(names(seen), "region")

  local_mcp_config(result = function(args) list(rows = 12L, ids = list("a", "b")))
  res <- open_app()
  expect_equal(res$structuredContent$rows, 12L)
  expect_match(res$content[[1]]$text, '"rows":12', fixed = TRUE)

  local_mcp_config(result = function(args) NULL)
  expect_match(open_app()$content[[1]]$text, "displayed")

  local_mcp_config(result = function(args) promises::promise_resolve("later"))
  expect_equal(open_app()$content[[1]]$text, "later")

  local_mcp_config(result = function(args) stop("boom"))
  expect_warning(res <- open_app(), "boom")
  expect_match(res$content[[1]]$text, "displayed")
  expect_false(isTRUE(res$isError))
})

test_that("mcpConfigure(result = ) must be a function", {
  expect_error(mcpConfigure(result = "text"), "must be NULL or a function")
})

test_that("the page learns which arguments the app declared", {
  skip_if_not_installed("ellmer")
  local_mcp_config(arguments = list(
    region = ellmer::type_string("Region"),
    n = ellmer::type_integer("Rows")
  ))
  ui <- function(req) httpResponse(200L, "text/html", "<html><body></body></html>")
  h <- mcpHttpHandler(ui, function(ws) TRUE)
  out <- mcp_post(h, "resources/read", params = list(uri = "ui://shiny/app"))
  html <- out$result$contents[[1]]$text
  expect_match(html, '"arguments":["region","n"]', fixed = TRUE)
})
