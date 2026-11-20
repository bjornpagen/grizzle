/**
 * A generated CLI sends each operation's method as the document spells it, to the operation's target, with the body
 * its source holds, framed by what that source knows of its length.
 *
 * - Operations: every method member an OpenAPI 3.2 path item names (uppercased on the wire) and additional operations
 *   whose keys hold every token symbol once, in either case, each with an optional binary body. Bodies:
 *   none, a file's bytes (`--body-file <path>`) or stdin's (`--body-file -`), of any byte values. Oracle: the
 *   document and the invocation: the method as spelled, the path, the body's bytes, and for a body with bytes,
 *   `Content-Length` for a file and `Transfer-Encoding: chunked` for stdin. An empty body's framing is no part of the
 *   contract: no framing, `Content-Length: 0` and a chunked body with no chunk all frame a zero-length body (RFC 9112
 *   6.3), so asserting one would pin an implementation detail.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, FileSystem, Option, Path, String as Str } from "effect"
import {
	canonical,
	done,
	expectedOf,
	type MethodFeature,
	methodsFixture,
	send,
	sentOf,
	spellingOf
} from "#test/generated/methods-bodies.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"

/**
 * A request carries its operation's method as the document spells it and the body its source holds, framed by what
 * that source knows of its length. Its budget is the count its suite stated before the conversion: 30 independent
 * cases, and up to 60 steered while a situation is unreached.
 */
export const methodsBodies = property.explore(send, {
	needs: { fixture: methodsFixture, scratch: Scratch.dir, checkout: Checkout.dir },
	situations: [
		"a method member",
		"an additional operation",
		"a lower-case additional method",
		"a mixed-case additional method",
		"a method holding a token symbol",
		"no body",
		"a file body",
		"a stdin body",
		"an empty body"
	] satisfies ReadonlyArray<Reached<MethodFeature>>,
	check:
		({ fixture, scratch: scratchDir }, k: Case<MethodFeature>) =>
		(s) =>
			Effect.gen(function* () {
				const { server, built, commands } = yield* fixture
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const scratch = yield* scratchDir
				if (Str.includes("additionalOperations")(s.operation.pointer)) {
					k.note("an additional operation")
					k.noteAll(spellingOf(s.operation.method))
				} else {
					k.note("a method member")
				}
				k.note(
					s.body.kind === "none"
						? "no body"
						: s.body.kind === "file"
							? "a file body"
							: "a stdin body"
				)
				if (s.body.kind !== "none" && s.body.bytes.length === 0) {
					k.note("an empty body")
				}
				const command = yield* Effect.fromOption(
					Option.fromNullishOr(commands.get(s.operation.pointer))
				)
				const file = path.join(scratch, "body.bin")
				const bodyArgs =
					s.body.kind === "none"
						? []
						: s.body.kind === "file"
							? ["--body-file", file]
							: ["--body-file", "-"]
				if (s.body.kind === "file") {
					yield* fs.writeFile(file, s.body.bytes)
				}
				const observed = yield* server.observe(
					() => done,
					runBin(built, {
						args: [...command, "--base-url", server.origins["127.0.0.1"], ...bodyArgs],
						env: {},
						stdin: s.body.kind === "stdin" ? s.body.bytes : new Uint8Array(0)
					})
				)
				assert.deepEqual(
					{
						exitCode: observed.result.exitCode,
						sent: Arr.map(observed.requests, (request) => canonical(sentOf(request)))
					},
					{ exitCode: 0, sent: [canonical(expectedOf(s))] },
					"the request carries the method as spelled and the body framed by its source"
				)
			}),
	oracle: {
		kind: "specification",
		name: "the document and the invocation: the method as spelled, the path, the body's bytes and its framing"
	},
	kept: [],
	budget: { runs: 30, steered: 60 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "HttpClientRequest.makeWith(\n\t\t\t\tmethod,",
			replacement: "HttpClientRequest.makeWith(\n\t\t\t\tStr.toUpperCase(method),",
			why: "Every method is sent upper-cased, so an additional operation spelled in lower or mixed case goes out under another method; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
			original:
				"Effect.map((stdio) => HttpBody.stream(stdio.stdin.pipe(Stream.mapError(cannotRead))))",
			replacement: "Effect.map(() => HttpBody.stream(Stream.empty))",
			why: "`--body-file -` streams nothing from stdin, so a stdin body arrives empty; the property fails."
		}
	]
})
