/**
 * A generated CLI sends a parameter written by `content` as its one media type's encoding of the value it was given:
 * JSON content as the JSON text of the value the flag parsed, text content as the text, in the parameter's place.
 *
 * - Parameters: a required JSON object in the query, an optional JSON array of strings in the query (the optional
 *   content parameter with an array schema, which reaches its builder as one value), an optional text header and an
 *   optional text cookie, each given or not; and planted faults, one per run: the required parameter missing, and
 *   text that is not JSON in a JSON flag. Oracles: the query's pairs percent-decoded and their JSON parsed back to the
 *   values given; the header's and the cookie's text as given; and exit 2 with no connection for each fault.
 * - Help: each JSON content flag shows `json` as its value in `--help`.
 *
 * While a required feature is still pending, a case aimed at it draws the run made to reach it
 * (content-parameters.fixtures.ts runs), so each is reached on every run seed.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import {
	argsOf,
	carriedOf,
	type ContentFeature,
	contentFixture,
	done,
	expectedOf,
	FEATURES,
	jsonFlags,
	type Outcome,
	runFeatures,
	runs
} from "#test/generated/content-parameters.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"
import { metavarOf } from "#test/support/help.ts"

/** Each JSON content flag shows `json` as its value in the command's `--help`. */
export const contentHelp = property.exhaust(jsonFlags, {
	box: "every JSON content flag of the notes command: --coordinates, an object, and --tags, an array",
	needs: { fixture: contentFixture, checkout: Checkout.dir },
	situations: [],
	check:
		({ fixture }) =>
		(flag) =>
			Effect.gen(function* () {
				const { built, command } = yield* fixture
				const help = yield* runBin(built, {
					args: Arr.append(command, "--help"),
					env: {},
					stdin: new Uint8Array(0)
				})
				assert.deepEqual<Readonly<{ exitCode: number; shown: Option.Option<string> }>>(
					{
						exitCode: help.exitCode,
						shown: metavarOf(Buffer.from(help.stdout).toString("utf8"), flag)
					},
					{ exitCode: 0, shown: Option.some("json") },
					"a JSON content flag takes json"
				)
			}),
	oracle: { kind: "specification", name: "a JSON content flag's value is named json in --help" },
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/emit/cli.ts",
			original:
				'\t(parameter.serialization.kind === "content" &&\n\t\ttakesJsonContent(parameter.location, parameter.serialization.mediaType))',
			replacement: "\tfalse",
			why: "Only an object parameter's flag takes json, so --tags, JSON content with an array schema, shows no value name; the property fails."
		}
	]
})

/**
 * Each content parameter carries its media type's encoding of the value given, and a fault sends nothing. Its budget
 * is the count its suite stated before the conversion: 12 independent cases, and up to 30 steered while a situation is
 * unreached.
 */
export const contentParameters = property.explore(runs, {
	needs: { fixture: contentFixture, checkout: Checkout.dir },
	situations: FEATURES,
	check:
		({ fixture }, k: Case<ContentFeature>) =>
		(r) =>
			Effect.gen(function* () {
				const { server, built, command } = yield* fixture
				k.noteAll(runFeatures(r))
				const observed = yield* server.observe(
					() => done,
					runBin(built, {
						args: Arr.flatten([command, ["--base-url", server.origins["127.0.0.1"]], argsOf(r)]),
						env: {},
						stdin: new Uint8Array(0)
					})
				)
				const requests = yield* Effect.forEach(observed.requests, carriedOf)
				assert.deepEqual<Outcome>(
					{
						exitCode: observed.result.exitCode,
						connections: observed.connections.length,
						requests
					},
					expectedOf(r),
					"each content parameter carries its media type's encoding of the value given"
				)
			}),
	oracle: {
		kind: "specification",
		name: "the query's pairs parsed back to the values given, the header's and the cookie's text as given, and exit 2 with no connection for a fault"
	},
	kept: [],
	budget: { runs: 12, steered: 30 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: `\t\tif (isJsonMedia(mediaType)) {\n\t\t\treturn yield* jsonText(\`parameter \${name}\`, value)`,
			replacement: `\t\tif (false) {\n\t\t\treturn yield* jsonText(\`parameter \${name}\`, value)`,
			why: "A JSON content parameter's value is taken for text, so an object or an array is refused as no text under a non-JSON media type; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "\t\t\t: value\n\t})",
			replacement: "\t\t\t: JSON.stringify(value)\n\t})",
			why: "Text content is sent as its JSON text, quoted, so a header carries its value in quotes and a cookie's quotes are refused as no cookie-octet; the property fails."
		}
	]
})
