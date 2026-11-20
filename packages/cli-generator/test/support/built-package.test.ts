/**
 * A built generated CLI never fails as a defect: whatever argv it is given, under the hardened Node flags, it exits with
 * a code its contract documents for the exchange the server saw (0 success, 1 a non-2xx answer, 2 a usage error, 3 a
 * credential refusal, 4 a transport or redirect failure, 5 a body failure), never with 70, an internal error, nor by a
 * signal; and it exits the same way twice.
 *
 * - Invocations: mostly the update operation's command with an id and well-formed fields, body, timeout, error format
 *   and switches, so most runs send a request; otherwise any of the package's command paths, from the generation
 *   report, with flags and values of any shape and words it does not know, the deliberate faults; and, aimed, the
 *   update command given a body that is no JSON text, a usage error the runtime raises itself (errors.ts UsageError)
 *   rather than its parser; each with or without a bearer token, against the capture server as its base, which answers
 *   every request with a status and body bytes drawn per case. The package is generated and built once through
 *   cli-package.ts, as every generated-CLI suite builds its own. Oracles: never-crashes, and determinism: a second run
 *   of the same invocation exits with the same code and prints the same bytes.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Duration, Effect, Option } from "effect"
import {
	admittedOf,
	argvOf,
	bodyNotJson,
	type ExitFeature,
	goldenFixture,
	invocations,
	meaningOf
} from "#test/support/built-package.fixtures.ts"
import type { ScriptedResponse } from "#test/support/capture-server.ts"
import { runBin } from "#test/support/cli-package.ts"

/**
 * Whatever argv it is given, the built CLI exits with a code its contract documents for the exchange the server saw,
 * and exits and prints the same way twice. Its budget is the count its suite stated before the conversion: 12
 * independent cases, and up to 24 steered while a situation is unreached.
 */
export const builtExits = property.explore(invocations, {
	needs: { fixture: goldenFixture, checkout: Checkout.dir },
	situations: ["success", "non-2xx", "usage", "a request sent", "a body that is no JSON text"],
	check:
		({ fixture }, k: Case<ExitFeature>) =>
		(c) =>
			Effect.gen(function* () {
				const { server, built, commands } = yield* fixture
				const base = { EXAMPLE_BASE_URL: server.origins["127.0.0.1"] }
				const answer: ScriptedResponse = {
					status: c.status,
					headers: [["Content-Type", "application/json"]],
					delay: Duration.zero,
					body: { kind: "complete", bytes: c.body }
				}
				const env = Option.match(c.token, {
					onNone: () => base,
					onSome: (token) => ({ ...base, EXAMPLE_BEARER_AUTH: token })
				})
				const run = runBin(built, { args: argvOf(commands, c.argv), env, stdin: new Uint8Array(0) })
				const first = yield* server.observe(() => answer, run)
				const second = yield* server.observe(() => answer, run)
				const meaning = meaningOf(first.result.exitCode)
				if (meaning !== "defect") {
					k.note(meaning)
				}
				if (first.requests.length > 0) {
					k.note("a request sent")
				}
				if (bodyNotJson(c)) {
					k.note("a body that is no JSON text")
				}
				assert.deepEqual(
					Arr.intersection([meaning], admittedOf(first.requests.length, c.status)),
					[meaning],
					"the exit code is one the contract documents for the exchange the server saw"
				)
				assert.deepEqual(
					second.result,
					first.result,
					"a second run exits the same way and prints the same bytes"
				)
			}),
	oracle: {
		kind: "universal",
		name: "a documented exit code, and a second run of the same invocation exits and prints the same"
	},
	kept: [],
	budget: { runs: 12, steered: 24 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/domain/errors.ts",
			original: "\toverride readonly [Runtime.errorExitCode] = 2",
			replacement: "\toverride readonly [Runtime.errorExitCode] = 70",
			why: "A usage error exits 70, the code of an internal error, where the contract documents 2; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original:
				"Effect.fail(Object.assign(help, { [Runtime.errorExitCode]: invalidInvocationExitCode }))",
			replacement: "Effect.fail(Object.assign(help, { [Runtime.errorExitCode]: 70 }))",
			why: "An invocation the parser refuses exits 70, the code of an internal error, where the contract documents 2; the property fails."
		}
	]
})
