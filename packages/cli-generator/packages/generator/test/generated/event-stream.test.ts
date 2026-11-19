/**
 * A CLI generated from an OpenAPI 3.2 document shaped as grizzle writes one per login (a read and a write, each a
 * `POST` whose streamed response names its events, each with a `grizzle-wire` header whose schema admits one value),
 * run against a local server that sends `text/event-stream` bodies, writes exactly the events the server sent, one
 * JSON line each, and ends as the stream's contract says: after the first `ready` event by default, after `end` under
 * `--follow`, with exit 130 when a followed stream is interrupted, and with exit 1 after an `error` event, which is
 * retried, as a fresh call, only when the event says retrying is safe and the caller gave `--retries`. Every request
 * carries its operation's `grizzle-wire` value, which no flag reads.
 *
 * Generated event lists: items (`reset`, `upsert`, `remove`) whose JSON data, spelled as grizzle spells int8, money,
 * bytes and codes, is written with whitespace between its tokens and across `data` lines, a `ready` event, live items
 * after it and an `end`, comments between events, sent in one or several writes. Oracle: the events' own lines,
 * through the stop point the command's flags name. The failure and retry behaviour is exhausted over every pairing of
 * the error event's verdict, `--retries` and the read or the write; the oracle there is the contract's: the lines
 * printed, the exit code, the calls made and the header each carried, and the `--error-format json` object of a call
 * that ends at the error, whose `data` is the error event's JSON data as the JSON value it is.
 *
 * A stream cut by its transport, its body ending after the read's `ready` or the write's outcome with no terminal event,
 * is exhausted over the read and the write, each with and without `--retries`; the oracle is the decided contract: a
 * cut read is what a retry-safe `unavailable` event says, so under a budget it is called again and read anew (its
 * reset, its ready, its end), and without one it exits 5 after one call; a cut write, which may have committed, exits
 * 5 after one call whatever the budget.
 *
 * Every event's data is checked against its event's `contentSchema` before it prints, so the scripted data is what the
 * fixture's schemas admit; an exhaustion sends one event of each type a read sends whose data its schema refuses, and
 * the command must end with exit 5 (`invalidData`) printing nothing of it. The feed's draws aim at a pending feature
 *.
 *
 * Features: a stop at ready, a stream followed to its end, an interrupted stream, data across lines, a comment, a write
 * that splits an event; each failure verdict with and without a budget, on the read and on the write; a cut read and a
 * cut write, each with and without a budget; refused data of each event type.
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec, Schema, String as Str } from "effect"
import {
	bodyOf,
	cutCases,
	type CutFeature,
	cutFeature,
	errorData,
	ErrorLine,
	errorText,
	kindOf,
	expectedOf,
	failureCases,
	type FailureFeature,
	failureFeature,
	FEED_FEATURES,
	type FeedFeature,
	feedFeatures,
	feeds,
	firstItem,
	lineOf,
	outcomeText,
	readArgs,
	readBody,
	refusedCases,
	type RefusedData,
	refusedText,
	resetText,
	runCli,
	Server,
	Site,
	streamFixture,
	writeBody,
	writesOf
} from "#test/generated/event-stream.fixtures.ts"

/** Each stream's events are written exactly as sent, through the stop point its flags name. Its budget is the count
 * its suite stated before the conversion: 4 independent cases, and up to 16 steered while a situation is unreached.
 */
export const streamFeed = property.explore(feeds, {
	needs: { fixture: streamFixture, checkout: Checkout.dir },
	situations: FEED_FEATURES,
	check:
		({ fixture }, k: Case<FeedFeature>) =>
		(sent) =>
			Effect.flatMap(fixture, (services) =>
				Effect.gen(function* () {
					const server = yield* Server
					yield* server.script([{ writes: writesOf(bodyOf(sent), sent.writes), close: sent.ends }])
					const interrupted = sent.follow && !sent.ends
					const expected = yield* expectedOf(sent)
					const lastLine = Option.getOrElse(
						Arr.last(Str.split("\n")(Str.trimEnd(expected))),
						() => ""
					)
					const run = yield* runCli(
						readArgs(server.origin, sent.follow),
						interrupted ? Option.some(lastLine) : Option.none()
					)
					k.noteAll(feedFeatures(sent))
					deepStrictEqual(
						{ exitCode: run.exitCode, stdout: run.stdout },
						{ exitCode: interrupted ? 130 : 0, stdout: expected }
					)
				}).pipe(Effect.provideContext(services))
			),
	oracle: {
		kind: "specification",
		name: "the events' own lines, through the stop point the command's flags name"
	},
	kept: [],
	budget: { runs: 4, steered: 16 },
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/sse.ts",
			original: '\tFlag.map((follow): StopAt => (follow ? "terminal" : "ready"))',
			replacement: '\tFlag.map((follow): StopAt => (follow ? "ready" : "ready"))',
			why: "--follow stops at the first ready as the default does, so a followed stream's live items and end are never printed; the property fails."
		}
	]
})

/** An error event ends the run with exit 1, and is retried as a fresh call only when it says retrying is safe and
 * the caller gave --retries.
 */
export const streamFailure = property.exhaust(failureCases, {
	box: "every pairing of the error event's verdict, a --retries budget or none, and the read or the write",
	needs: { fixture: streamFixture, checkout: Checkout.dir },
	situations: [
		"safe with a budget on post-page",
		"safe without a budget on post-page",
		"never with a budget on post-page",
		"never without a budget on post-page",
		"safe with a budget on comment",
		"safe without a budget on comment",
		"never with a budget on comment",
		"never without a budget on comment"
	],
	check:
		({ fixture }, k: Case<FailureFeature>) =>
		(failure) =>
			Effect.flatMap(fixture, (services) =>
				Effect.gen(function* () {
					const server = yield* Server
					const [itemType, itemText] = firstItem(failure.command)
					const retried = failure.verdict === "safe" && Option.isSome(failure.retries)
					const success =
						failure.command === "post-page"
							? "event: ready\ndata: {}\n\n"
							: "event: end\ndata: {}\n\n"
					yield* server.script([
						{ writes: [itemText, errorText(failure.verdict)], close: true },
						{ writes: [itemText, success], close: true }
					])
					const run = yield* runCli(
						[
							"--base-url",
							server.origin,
							"--error-format",
							"json",
							...Option.match(failure.retries, {
								onNone: () => [],
								onSome: (n) => ["--retries", String(n)]
							}),
							"reader",
							failure.command,
							"--body",
							failure.command === "post-page" ? readBody : writeBody
						],
						Option.none()
					)
					const item = yield* lineOf(
						itemType,
						failure.command === "post-page"
							? ["{", '"key"', ":", "[", "]", "}"]
							: [
									"{",
									'"outcome"',
									":",
									"{",
									'"kind"',
									":",
									'"unchanged"',
									",",
									'"reads"',
									":",
									"{",
									"}",
									"}",
									"}"
								]
					)
					const error = yield* lineOf("error", [
						"{",
						'"error"',
						":",
						"{",
						'"kind"',
						":",
						`"${kindOf(failure.verdict)}"`,
						",",
						'"retry"',
						":",
						`"${failure.verdict}"`,
						",",
						'"message"',
						":",
						'"try again"',
						"}",
						"}"
					])
					const last = yield* lineOf(failure.command === "post-page" ? "ready" : "end", ["{", "}"])
					const lastError = Option.getOrElse(
						Arr.last(Str.split("\n")(Str.trim(run.stderr))),
						() => ""
					)
					const printedError = Option.map(Schema.decodeOption(ErrorLine)(lastError), (line) => ({
						kind: line.error.kind,
						data: line.error.data
					}))
					const site = yield* Site
					const digest = Rec.get(
						site.wire,
						failure.command === "post-page" ? "/site/reader/postPage" : "/site/reader/comment"
					)
					const requests = yield* server.requests
					const wire = yield* server.wire
					k.note(failureFeature(failure))
					deepStrictEqual(wire, Arr.getSomes(Array.from({ length: requests }, () => digest)))
					deepStrictEqual(
						{
							exitCode: run.exitCode,
							requests,
							stdout: run.stdout,
							printedError
						},
						retried
							? {
									exitCode: 0,
									requests: 2,
									stdout: `${item}${error}${item}${last}`,
									printedError: Option.none()
								}
							: {
									exitCode: 1,
									requests: 1,
									stdout: `${item}${error}`,
									printedError: Option.some({
										kind: "StreamEventError",
										data: errorData(failure.verdict)
									})
								}
					)
				}).pipe(Effect.provideContext(services))
			),
	oracle: {
		kind: "specification",
		name: "the stream's contract: the lines printed, the exit code, the calls made and the header each carried, and the error object's data"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/sse.ts",
			original: '\t"retryWhen" in row && saysSafe(event.data, row.retryWhen)',
			replacement: '\t"retryWhen" in row',
			why: "An error event is taken as safe to retry whatever its verdict, so a `never` error under --retries is called again; the property fails."
		}
	]
})

/** An event whose data its contentSchema refuses ends the run with exit 5 (invalidData), printing nothing of it. */
export const streamRefusedData = property.exhaust(refusedCases, {
	box: "the read sent one event of each type whose data its contentSchema refuses",
	needs: { fixture: streamFixture, checkout: Checkout.dir },
	situations: ["reset", "upsert", "remove", "ready", "error"],
	check:
		({ fixture }, k: Case<RefusedData>) =>
		(refused) =>
			Effect.flatMap(fixture, (services) =>
				Effect.gen(function* () {
					const server = yield* Server
					yield* server.script([{ writes: [refusedText[refused]], close: true }])
					const run = yield* runCli(readArgs(server.origin, false), Option.none())
					k.note(refused)
					deepStrictEqual(
						{
							exitCode: run.exitCode,
							stdout: run.stdout,
							invalidData: Str.includes("invalidData")(run.stderr)
						},
						{ exitCode: 5, stdout: "", invalidData: true }
					)
				}).pipe(Effect.provideContext(services))
			),
	oracle: {
		kind: "specification",
		name: "the event's contentSchema: data it refuses ends the stream with invalidData, exit 5, and is never printed"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/sse.ts",
			original: "\tif (!admitted(row.data, event.data)) {",
			replacement: "\tif (false) {",
			why: "An event's data is printed without its contentSchema's check, so refused data is written and the run goes on; the property fails."
		}
	]
})

/** A read cut by its transport is called again under --retries and read anew; a cut write ends the run with exit 5. */
export const streamCut = property.exhaust(cutCases, {
	box: "the read followed past its ready and the write, each cut before its terminal event, with a --retries budget or none",
	needs: { fixture: streamFixture, checkout: Checkout.dir },
	situations: [
		"a cut read with a budget",
		"a cut read without a budget",
		"a cut write with a budget",
		"a cut write without a budget"
	],
	check:
		({ fixture }, k: Case<CutFeature>) =>
		(cut) =>
			Effect.flatMap(fixture, (services) =>
				Effect.gen(function* () {
					const server = yield* Server
					const read = cut.command === "post-page"
					yield* server.script(
						read
							? [
									{ writes: [resetText, "event: ready\ndata: {}\n\n"], close: true },
									{
										writes: [resetText, "event: ready\ndata: {}\n\n", "event: end\ndata: {}\n\n"],
										close: true
									}
								]
							: [
									{ writes: [outcomeText], close: true },
									{ writes: [outcomeText, "event: end\ndata: {}\n\n"], close: true }
								]
					)
					const run = yield* runCli(
						[
							"--base-url",
							server.origin,
							...Option.match(cut.retries, {
								onNone: () => [],
								onSome: (n) => ["--retries", String(n)]
							}),
							"reader",
							cut.command,
							"--body",
							read ? readBody : writeBody,
							...(read ? ["--follow"] : [])
						],
						Option.none()
					)
					const reset = yield* lineOf("reset", ["{", '"key"', ":", "[", "]", "}"])
					const ready = yield* lineOf("ready", ["{", "}"])
					const end = yield* lineOf("end", ["{", "}"])
					const outcome = yield* lineOf("outcome", [
						"{",
						'"outcome"',
						":",
						"{",
						'"kind"',
						":",
						'"unchanged"',
						",",
						'"reads"',
						":",
						"{",
						"}",
						"}",
						"}"
					])
					const requests = yield* server.requests
					k.note(cutFeature(cut))
					const resumed = read && Option.isSome(cut.retries)
					deepStrictEqual(
						{ exitCode: run.exitCode, requests, stdout: run.stdout },
						resumed
							? { exitCode: 0, requests: 2, stdout: `${reset}${ready}${reset}${ready}${end}` }
							: {
									exitCode: 5,
									requests: 1,
									stdout: read ? `${reset}${ready}` : outcome
								}
					)
				}).pipe(Effect.provideContext(services))
			),
	oracle: {
		kind: "specification",
		name: "a cut read is a retry-safe unavailable event and a cut write ends the run: the lines printed, the exit code and the calls made"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/sse.ts",
			original: '\t\t\tArr.some(Rec.values(contract.events), (row) => row.role === "ready")',
			replacement: "\t\t\tfalse",
			why: "No operation reads state, so a read cut by its transport is never called again under --retries; the property fails."
		}
	]
})
