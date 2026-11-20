/**
 * A generated CLI retries a failed attempt only when the caller asked for retries and the attempt may be sent again
 * (design D-AD7):
 *
 * - `--retries <n>` is the run's whole budget; without it the run never retries, and no environment variable stands
 *   in for it.
 * - A retried outcome is a final status of 408, 429, 500, 502, 503 or 504, or a header timeout; any other status ends
 *   the run at once.
 * - An idempotent method is retried; `POST` only with a declared `Idempotency-Key` sent, which every attempt carries
 *   unchanged, or with `--retry-unsafe`.
 * - A body read once from stdin is never sent again: the run stops and names `unreplayableBody`. A file body is sent
 *   again byte for byte, under a `Content-Length`.
 * - A retry waits the response's `Retry-After`, else the backoff; a `Retry-After` longer than the effective timeout
 *   (`--timeout`, else `<PREFIX>_TIMEOUT`) is not waited, and the run stops naming the server's delay as `retryAfter`.
 *   With neither, or with `0`, an attempt is untimed and nothing caps a wait, so absent and zero timeouts are drawn
 *   beside small ones, and every `Retry-After` drawn is at most 3 seconds.
 * - Each retry prints one `Notice: retrying` line. The run exits 0 on a 2xx, 1 on another final status, 4 on a header
 *   timeout, and `--error-format json` names the final error's kind, status and capped delay.
 *
 * One package with a GET, a POST with a JSON body and an optional `Idempotency-Key`, a POST and a PUT of octet bodies.
 * A steered property draws the operation, the body's source, the flags and the server's sequence of answers. Oracle:
 * a model of the rules above run over that sequence, compared with every attempt the capture server recorded, the exit
 * code, the notices and the JSON error.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import {
	answerAt,
	attemptOf,
	caseFeatures,
	cases,
	errorOf,
	expectedOf,
	type Feature,
	FEATURES,
	isOneShot,
	octetBody,
	operationOf,
	type Outcome,
	responseOf,
	retryFixture,
	sendArgs
} from "#test/generated/retry-policy.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"
import { printedText } from "#test/support/printed.ts"

/**
 * Every attempt, notice, exit code and JSON error is the one the retry rules give over the server's answers. Its
 * budget is the count its suite stated before the conversion: 6 independent cases, and up to 24
 * steered while a situation is unreached.
 */
export const retryPolicy = property.explore(cases, {
	needs: { fixture: retryFixture, checkout: Checkout.dir },
	situations: FEATURES,
	check:
		({ fixture }, k: Case<Feature>) =>
		(c) =>
			Effect.gen(function* () {
				const { server, built, commands, file } = yield* fixture
				k.noteAll(caseFeatures(c))
				const observed = yield* server.observe(
					(_request, attempt) => responseOf(answerAt(c.answers, attempt)),
					runBin(built, {
						args: Arr.flatten([
							commands[operationOf(c.send)],
							["--base-url", server.origins["127.0.0.1"], "--error-format", "json"],
							c.unsafe ? ["--retry-unsafe"] : [],
							Option.match(c.retries, {
								onNone: () => [],
								onSome: (retries) => ["--retries", String(retries)]
							}),
							Option.match(
								Option.filter(c.timeout, (timeout) => timeout.from === "the flag"),
								{
									onNone: () => [],
									onSome: (timeout) => ["--timeout", String(timeout.seconds)]
								}
							),
							sendArgs(c.send, file)
						]),
						env: {
							...(c.retriesVariable ? { RETRY_RETRIES: "5" } : {}),
							...Option.match(
								Option.filter(c.timeout, (timeout) => timeout.from === "the variable"),
								{
									onNone: () => ({}),
									onSome: (timeout) => ({ RETRY_TIMEOUT: String(timeout.seconds) })
								}
							)
						},
						stdin: isOneShot(c.send) ? octetBody() : new Uint8Array(0)
					})
				)
				const lines = Str.split("\n")(printedText(observed.result.stderr))
				assert.deepEqual<Outcome>(
					{
						exitCode: observed.result.exitCode,
						attempts: Arr.map(observed.requests, attemptOf(c)),
						retryNotices: Arr.length(Arr.filter(lines, Str.startsWith("Notice: retrying "))),
						unreplayable: Arr.some(lines, Str.includes("unreplayableBody")),
						error: errorOf(lines)
					},
					expectedOf(c),
					"the attempts, the notices, the exit code and the error follow the retry rules"
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "a model of the retry rules run over the server's sequence of answers"
	},
	kept: [],
	budget: { runs: 6, steered: 24 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/client.ts",
			original: "\tidempotencyKeyPresent || idempotentMethods.has(method)",
			replacement: "\tidempotentMethods.has(method)",
			why: "A POST that sends its declared Idempotency-Key is not retried without --retry-unsafe; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/client.ts",
			original: "\tif (isOneShot(request.body)) {",
			replacement: "\tif (false) {",
			why: "A body read once from stdin is sent again, empty, where the run stops naming unreplayableBody; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/client.ts",
			original: "\tif (Option.isSome(server) && exceedsCap(server.value, timeout)) {",
			replacement: "\tif (false) {",
			why: "A Retry-After longer than the effective timeout is waited, where the run stops naming the server's delay; the property fails."
		}
	]
})
