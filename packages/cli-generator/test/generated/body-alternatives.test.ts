/**
 * A generated CLI sends one of an operation's request body alternatives, the one `--content-type` names (JSON when
 * none does, even when another is listed first), encoded as that media type says, and refuses before any connection a
 * flag that belongs to another alternative or a media type the operation does not declare.
 *
 * - Bodies: a message posted as JSON, by default or named, as a form or as multipart; an upload whose multipart
 *   alternative is listed before JSON, posted by default; and events sent as NDJSON from stdin. Fields of URL-safe text:
 *   the message's text, its tags (a form field the Encoding Object joins with commas) and its ids (repeated pairs), the
 *   multipart file's bytes. Oracles: the media type's own reading of the body: JSON parsed to the fields given, form
 *   pairs in schema order under the Encoding rules, multipart parts by name with each part's content type and the
 *   file's name and bytes, NDJSON byte for byte and chunked.
 * - Faults, planted one per run: a part flag under the JSON default, `--body` with multipart named, and a media type
 *   the operation does not declare. Oracle: exit 2 and no connection.
 *
 * A case draws a focus, a feature or none, and the run aimed at it; while a required feature is still pending, a case
 * aimed at it draws the run made to reach it (body-alternatives.fixtures.ts cases), so each is reached on every run seed.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, FileSystem, Path } from "effect"
import {
	type AlternativeFeature,
	bodyFixture,
	cases,
	done,
	expectedOf,
	FEATURES,
	FILE_NAME,
	invocationOf,
	type Outcome,
	receivedOf,
	sendFeatures
} from "#test/generated/body-alternatives.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"

/**
 * Each request is the alternative --content-type names, JSON when none does, encoded as its media type says, and a
 * misplaced flag or an undeclared media type sends nothing. Its budget is the count its suite stated before the conversion: 12 independent cases, and up to 30
 * steered while a situation is unreached.
 */
export const bodyAlternatives = property.explore(cases, {
	needs: { fixture: bodyFixture, scratch: Scratch.dir, checkout: Checkout.dir },
	situations: FEATURES,
	check:
		({ fixture, scratch: scratchDir }, k: Case<AlternativeFeature>) =>
		(s) =>
			Effect.gen(function* () {
				const { server, built, commands } = yield* fixture
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const scratch = yield* scratchDir
				const file = path.join(scratch, FILE_NAME)
				k.noteAll(sendFeatures(s))
				if (s.kind === "message as multipart") {
					yield* fs.writeFile(file, s.file)
				}
				const invoked = invocationOf(s, file)
				const observed = yield* server.observe(
					() => done,
					runBin(built, {
						args: Arr.flatten([
							commands[invoked.operation],
							["--base-url", server.origins["127.0.0.1"]],
							invoked.args
						]),
						env: {},
						stdin: invoked.stdin
					})
				)
				const requests = yield* Effect.forEach(observed.requests, receivedOf)
				assert.deepEqual<Outcome>(
					{
						exitCode: observed.result.exitCode,
						connections: observed.connections.length,
						requests
					},
					expectedOf(s),
					"the request is the named alternative, encoded by its media type, or none for a misplaced flag"
				)
			}),
	oracle: {
		kind: "specification",
		name: "each media type's own reading of the body, and exit 2 with no connection for a planted fault"
	},
	kept: [],
	budget: { runs: 12, steered: 30 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/negotiate.ts",
			original:
				"\t\t\t\t\t\t\t: Option.getOrElse(Arr.findFirst(media.request, isJsonFamily), () => first)",
			replacement: "\t\t\t\t\t\t\t: first",
			why: "With no --content-type the first declared alternative is sent, so the upload listed multipart first is posted as multipart where JSON is the default; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
			original: "\t\tif (Option.isSome(misplaced)) {",
			replacement: "\t\tif (false) {",
			why: "A body flag of another alternative is dropped silently, so a part flag under the JSON default is sent where it is refused before any connection; the property fails."
		}
	]
})
