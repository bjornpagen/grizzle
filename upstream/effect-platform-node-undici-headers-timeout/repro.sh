#!/bin/sh
# Shows the one-hour headers timeout makeUndici gives every request, and what undici does with 0 instead:
# `sh repro.sh <a directory whose node_modules hold effect and @effect/platform-node>`.
# 1. A recording undici dispatcher reads the headersTimeout a request through makeUndici carries: 3600000 today.
# 2. undici alone, against a server that answers after 1.5 s: headersTimeout 1000 fails with UND_ERR_HEADERS_TIMEOUT,
#    and 0 waits for the late headers.
set -eu
dir="$(cd "$1" && pwd)"
node --input-type=module - "$dir" <<'JS'
import { createRequire } from "node:module"
import http from "node:http"
const require = createRequire(process.argv[2] + "/package.json")
const { NodeHttpClient } = await import(require.resolve("@effect/platform-node"))
const Undici = (await import(require.resolve("@effect/platform-node/Undici"))).default
const { Effect } = await import(require.resolve("effect"))
const seen = []
const agent = new Undici.Agent()
const recording = agent.compose((dispatch) => (options, handler) => {
  seen.push(options.headersTimeout)
  return dispatch(options, handler)
})
const prompt = http.createServer((_, res) => res.end("ok"))
await new Promise((resolve) => prompt.listen(0, "127.0.0.1", resolve))
await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* NodeHttpClient.makeUndici
    const response = yield* client.get(`http://127.0.0.1:${prompt.address().port}/`)
    yield* response.text
  }).pipe(Effect.provideService(NodeHttpClient.Dispatcher, recording))
)
console.log(JSON.stringify({ makeUndiciHeadersTimeout: seen }))
const late = http.createServer((_, res) => setTimeout(() => res.end("late"), 1500))
await new Promise((resolve) => late.listen(0, "127.0.0.1", resolve))
for (const headersTimeout of [1000, 0]) {
  const started = Date.now()
  try {
    const { body } = await agent.request({
      origin: `http://127.0.0.1:${late.address().port}`,
      path: "/",
      method: "GET",
      headersTimeout,
      bodyTimeout: 0
    })
    console.log(JSON.stringify({ headersTimeout, outcome: await body.text(), ms: Date.now() - started }))
  } catch (error) {
    console.log(JSON.stringify({ headersTimeout, outcome: error.code, ms: Date.now() - started }))
  }
}
await agent.destroy()
prompt.close()
late.close()
JS
