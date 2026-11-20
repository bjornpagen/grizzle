/**
 * A generated CLI shows the request it would send without sending it, shows what it sends and receives on stderr
 * without changing stdout, and renders a failed run as one JSON object:
 *
 * - `--dry-run` prints `METHOD <absolute URL> HTTP/1.1`, then the headers a real send carries, in the order it sends
 *   them, but the two undici writes itself (`host` and `connection`), each with the value it sends, then a blank line
 *   and the body; it exits 0 and opens no connection. A credential prints as `<redacted:<scheme>>` whether or not one is
 *   configured, so the print never depends on it and never shows it.
 * - `--verbose` writes `> ` lines for the request, the lines `--dry-run` prints, and `< ` lines for the response to
 *   stderr and nothing else there, while stdout is the response body alone.
 * - `--error-format json` writes exactly one line, a `{"error":{...}}` object, and nothing on stdout. Its keys follow
 *   the error: an API error carries `body`, `matched`, `operation` and `status`, its declared request id when the
 *   response sent one, and `retryAfter` when a `Retry-After` past the timeout stopped retrying; a missing credential
 *   carries `operation`; a refused connection and a usage error carry `kind` and `message` alone. The exit codes are 1,
 *   3, 4 and 2.
 *
 * One package with a secured GET taking a header parameter, a secured POST with a JSON body, and an open GET. A
 * property draws a request and runs it as a dry run with and without the credential and as a verbose real send,
 * comparing the three with each other and with what reached the capture server; an exhaustion runs every JSON error.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import {
	answered,
	expectedRendered,
	expectedShown,
	type Failure,
	failureRun,
	FAILURES,
	failures,
	keysOf,
	MARKER,
	operationOfRequest,
	printedFixture,
	printedOf,
	type Rendered,
	requestArgs,
	requests,
	sentNamesOf,
	type Shown,
	type ShownFeature,
	SHOWN_FEATURES,
	shownFeatures,
	TOKEN,
	verboseRequest
} from "#test/generated/printed-requests.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"
import { errorLineOf, printedJson, printedText } from "#test/support/printed.ts"

/**
 * The dry run prints what a send carries, the same with or without the credential, and verbose changes nothing else.
 * Its budget is the count its suite stated before the conversion: 4 independent cases, and up to 16 steered while a
 * situation is unreached.
 */
export const printedRequests = property.explore(requests, {
	needs: { fixture: printedFixture, checkout: Checkout.dir },
	situations: SHOWN_FEATURES,
	check:
		({ fixture }, k: Case<ShownFeature>) =>
		(request) =>
			Effect.gen(function* () {
				const { server, built, commands } = yield* fixture
				const base = server.origins["127.0.0.1"]
				k.noteAll(shownFeatures(request))
				const args = Arr.flatten([
					commands[operationOfRequest(request)],
					["--base-url", base],
					requestArgs(request)
				])
				const run = (flag: string, env: Readonly<Record<string, string>>) =>
					server.observe(
						() => answered(request.kind === "get" ? 200 : 201),
						runBin(built, {
							args: Arr.prepend(args, flag),
							env,
							stdin: new Uint8Array(0)
						})
					)
				const dryRun = yield* run("--dry-run", { OM_TOKEN: TOKEN })
				const bare = yield* run("--dry-run", {})
				const verbose = yield* run("--verbose", { OM_TOKEN: TOKEN })
				const sent = yield* Effect.fromOption(Arr.head(verbose.requests))
				const dryRunStdout = printedText(dryRun.result.stdout)
				const verboseStderr = printedText(verbose.result.stderr)
				const printed = printedOf(dryRunStdout)
				const verboseLines = Arr.filter(Str.split("\n")(verboseStderr), Str.isNonEmpty)
				assert.deepEqual<Shown>(
					{
						dryRunRequestLine: printed.requestLine,
						dryRunExit: dryRun.result.exitCode,
						dryRunConnections: dryRun.connections.length + bare.connections.length,
						dryRunStderr: printedText(dryRun.result.stderr),
						withoutCredential: printedText(bare.result.stdout),
						verboseExit: verbose.result.exitCode,
						verboseLinesOnly: Arr.every(
							verboseLines,
							(line) => Str.startsWith("> ")(line) || Str.startsWith("< ")(line)
						),
						verboseRequest: verboseRequest(verboseStderr),
						verboseBody: printedJson(printedText(verbose.result.stdout)),
						responseOnStderr: Str.includes(MARKER)(verboseStderr),
						tokenShown: Arr.some(
							[
								dryRunStdout,
								printedText(bare.result.stdout),
								printedText(bare.result.stderr),
								verboseStderr,
								printedText(verbose.result.stdout)
							],
							Str.includes(TOKEN)
						),
						printedHeaders: printed.headerLines,
						sentNames: sentNamesOf(sent),
						printedBody: printed.body
					},
					expectedShown(printed, dryRunStdout, sent, base, request),
					"the dry run prints what a send carries, the same with or without the credential, and verbose changes nothing else"
				)
			}),
	oracle: {
		kind: "specification",
		name: "the dry run, the verbose send and what reached the capture server, each against the others"
	},
	kept: [],
	budget: { runs: 4, steered: 16 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "\t\t\tif (dryRun) {",
			replacement: "\t\t\tif (false) {",
			why: "--dry-run sends the request it should only print, so a dry run opens a connection and prints the response; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: `\tlabel === "" ? redactedPlaceholder() : \`<redacted:\${label}>\``,
			replacement: "\tredactedPlaceholder()",
			why: "A credential prints as a bare <redacted>, naming no scheme, so the dry run's header is not the placeholder of its scheme; the property fails."
		}
	]
})

/** Every failure renders as one JSON object with its error's keys, nothing on stdout, and its exit code. */
export const jsonErrors = property.exhaust(failures, {
	box: "every failure the suite lists: API errors with and without a request id, a refused connection, a missing credential, a usage error and a Retry-After past the timeout",
	needs: { fixture: printedFixture, checkout: Checkout.dir },
	situations: FAILURES,
	check:
		({ fixture }, k: Case<Failure>) =>
		(failure) =>
			Effect.gen(function* () {
				const { server, deadOrigin, built, commands } = yield* fixture
				k.note(failure)
				const planned = failureRun(failure, {
					live: server.origins["127.0.0.1"],
					dead: deadOrigin
				})
				const observed = yield* server.observe(
					() => planned.answer,
					runBin(built, {
						args: Arr.appendAll(commands[planned.operation], planned.args),
						env: planned.env,
						stdin: new Uint8Array(0)
					})
				)
				const lines = Arr.filter(
					Str.split("\n")(printedText(observed.result.stderr)),
					Str.isNonEmpty
				)
				const error = Arr.findFirst(lines, errorLineOf)
				assert.deepEqual<Rendered>(
					{
						exitCode: observed.result.exitCode,
						connections: observed.connections.length,
						stdout: printedText(observed.result.stdout),
						lines: lines.length,
						kind: Option.map(error, (fields) => fields.kind),
						keys: Option.match(error, { onNone: () => [], onSome: keysOf }),
						status: Option.flatMap(error, (fields) => fields.status),
						requestId: Option.flatMap(error, (fields) => fields.requestId),
						retryAfter: Option.flatMap(error, (fields) => fields.retryAfter),
						bodyHasMarker: Option.exists(
							Option.flatMap(error, (fields) => fields.body),
							Str.includes(MARKER)
						)
					},
					expectedRendered(failure),
					"one JSON object with the error's keys, and the error's exit code"
				)
			}),
	oracle: {
		kind: "specification",
		name: "one JSON error line with the keys its error carries, nothing on stdout, and its exit code"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original:
				"\t\trequestId: api?.requestId === undefined ? undefined : singleLine(api.requestId, credentials),",
			replacement: "\t\trequestId: undefined,",
			why: "An API error's JSON leaves out the request id its response declared; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "\t\tretryAfter: api?.retryAfterSeconds,",
			replacement: "\t\tretryAfter: undefined,",
			why: "A run stopped by a Retry-After past the timeout names no retryAfter in its JSON error; the property fails."
		}
	]
})
