# Helpers for MCP Apps tests (test-mcp-*.R)

# Set MCP config for the duration of the calling test, restoring the prior
# .globals$mcp afterwards. Replaces the old withr::with_options(shiny.mcp*).
local_mcp_config <- function(..., .env = parent.frame()) {
  old <- .globals$mcp
  withr::defer(.globals$mcp <- old, envir = .env)
  mcpConfigure(...)
}

# Reset registered MCP author tools around a test (registerMcpTool() writes
# to process-global .globals$mcpAuthorTools).
local_mcp_tools <- function(env = parent.frame()) {
  old <- .globals$mcpAuthorTools
  withr::defer(.globals$mcpAuthorTools <- old, envir = env)
  .globals$mcpAuthorTools <- list()
}

fakeRookInput <- function(bytes) {
  list(read = function(...) bytes, rewind = function() NULL)
}

mcp_req <- function(body, method = "POST", path = "/mcp", headers = list()) {
  req <- new.env(parent = emptyenv())
  req$REQUEST_METHOD <- method
  req$PATH_INFO <- path
  req$QUERY_STRING <- ""
  req$HTTP_HOST <- "127.0.0.1"
  for (name in names(headers)) {
    key <- paste0("HTTP_", gsub("-", "_", toupper(name), fixed = TRUE))
    assign(key, headers[[name]], envir = req)
  }
  if (!is.null(body)) {
    json <- jsonlite::toJSON(body, auto_unbox = TRUE, null = "null")
    req$rook.input <- fakeRookInput(charToRaw(json))
  }
  req
}

as_bytes <- function(x) if (is.raw(x)) x else charToRaw(enc2utf8(x))

wait_for_result <- function(x, timeout = 5) {
  if (!promises::is.promising(x)) return(x)
  result <- NULL
  done <- FALSE
  err <- NULL
  promises::then(
    x,
    onFulfilled = function(value) {
      result <<- value
      done <<- TRUE
    },
    onRejected = function(e) {
      err <<- e
      done <<- TRUE
    }
  )
  end <- Sys.time() + timeout
  while (!done && Sys.time() < end) later::run_now(0.05)
  if (!done) stop("timed out waiting for promise")
  if (!is.null(err)) stop(err)
  result
}

mcp_post <- function(handler, method, params = NULL, id = 1) {
  body <- list(jsonrpc = "2.0", id = id, method = method)
  if (!is.null(params)) body$params <- params
  resp <- wait_for_result(handler(mcp_req(body)))
  expect_s3_class(resp, "httpResponse")
  jsonlite::parse_json(rawToChar(as_bytes(resp$content)))
}

# Replicates one iteration of serviceApp() without blocking on httpuv
pump_shiny <- function(seconds = 0.1) {
  end <- Sys.time() + seconds
  while (Sys.time() < end) {
    timerCallbacks$executeElapsed()
    flushReact()
    flushPendingSessions()
    later::run_now(0.02)
  }
}

# A 2026-07-28 (stateless) request: version and client capabilities in
# `_meta`, mirrored in headers the way HTTP clients send them.
mcp_stateless_req <- function(method, params = list(), id = 1,
                              version = "2026-07-28", ui = TRUE,
                              headers = NULL) {
  capabilities <- list()
  if (ui) {
    capabilities$extensions <- list(
      "io.modelcontextprotocol/ui" = list(mimeTypes = list("text/html;profile=mcp-app"))
    )
  }
  meta <- list(
    "io.modelcontextprotocol/protocolVersion" = version,
    "io.modelcontextprotocol/clientCapabilities" = capabilities
  )
  params$`_meta` <- meta
  body <- list(jsonrpc = "2.0", id = id, method = method, params = params)
  if (is.null(headers)) {
    headers <- list("MCP-Protocol-Version" = version, "Mcp-Method" = method)
    target <- params$name %||% params$uri
    if (!is.null(target)) headers[["Mcp-Name"]] <- target
  }
  mcp_req(body, headers = headers)
}

mcp_response <- function(handler, req) {
  resp <- wait_for_result(handler(req))
  list(
    status = resp$status,
    body = jsonlite::parse_json(rawToChar(as_bytes(resp$content)))
  )
}
