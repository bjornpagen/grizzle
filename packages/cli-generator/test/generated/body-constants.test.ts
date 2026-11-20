/**
 * A generated CLI sends a JSON body's members that admit one value itself, as it sends a constant parameter, and reads
 * every other member from its flags:
 *
 * - A required member whose schema admits exactly one value (a `const`, a one-member `enum`, or a closed object whose
 *   every member is required and admits one value, `{}` among them) has no flag; `--help` lists it under CONSTANTS as
 *   `body <pointer> = <JSON>`, and every request built from field flags holds it. A constant inside an object whose
 *   other members are flags is one too. An optional member that admits one value keeps its flag: sending it or not is
 *   the operator's choice.
 * - A string whose `allOf` members only refine it (a `pattern`) is a string flag, its value sent as a JSON string.
 * - `--body` is sent byte for byte as given: it is checked against the schema, constants included, so a whole body
 *   that leaves a constant out is refused (exit 2) before any connection, like a missing required field flag and an
 *   optional constant given another value.
 *
 * One package with one POST whose body holds each form. A property draws a run, by field flags or by a whole body,
 * each member given or not; the oracle is the schema's constants and the drawn values: the body that reached the
 * capture server, compared as JSON, or exit 2 and no request. While a required feature is still pending, a case aimed
 * at it draws the run made to reach it (body-constants.fixtures.ts runs), so each is reached on every run seed.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import {
	argsOf,
	type ConstantFeature,
	constantsFixture,
	constantsLine,
	decodeBody,
	done,
	expectedOf,
	FEATURES,
	featuresOf,
	helpPage,
	runs
} from "#test/generated/body-constants.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"

/** The constants have no flag and are listed under CONSTANTS, and the refined string keeps its string flag. */
export const constantsHelp = property.exhaust(helpPage, {
	box: "the one command's --help, its body holding every form a member may take",
	needs: { fixture: constantsFixture, checkout: Checkout.dir },
	situations: [],
	check:
		({ fixture }) =>
		(flag) =>
			Effect.gen(function* () {
				const { built, command } = yield* fixture
				const help = yield* runBin(built, {
					args: [...command, flag],
					env: {},
					stdin: new Uint8Array(0)
				})
				const lines = Arr.map(Str.split("\n")(new TextDecoder().decode(help.stdout)), Str.trim)
				const flagNames = Arr.flatMap(lines, (line) =>
					Str.startsWith("--")(line) ? [Arr.headNonEmpty(Str.split(" ")(line))] : []
				)
				assert.deepEqual(
					{
						exitCode: help.exitCode,
						flags: Arr.sort(flagNames, Str.Order),
						nameIsString: Arr.some(lines, Str.startsWith("--name string")),
						constants: Arr.some(lines, Str.includes(constantsLine))
					},
					{
						exitCode: 0,
						flags: ["--body", "--body-file", "--chosen", "--count", "--meta.note", "--name"],
						nameIsString: true,
						constants: true
					},
					"each constant is listed under CONSTANTS with no flag, and the refined string is a string flag"
				)
			}),
	oracle: {
		kind: "specification",
		name: "the schema's members: no flag and a CONSTANTS entry for each that admits one value, a flag for every other"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/emit/cli.ts",
			original: '\t\t? Option.some(["CONSTANTS", Arr.join(lines, "; ")] as const)',
			replacement: "\t\t? Option.none()",
			why: "--help lists no CONSTANTS, so the constants a request sends are shown nowhere; the property fails."
		}
	]
})

/**
 * Every body built from field flags holds the constants, and a whole body is sent as given. Its budget is the count
 * its suite stated before the conversion: 30 independent cases, and up to 60 steered while a situation is unreached.
 */
export const bodyConstants = property.explore(runs, {
	needs: { fixture: constantsFixture, checkout: Checkout.dir },
	situations: FEATURES,
	check:
		({ fixture }, k: Case<ConstantFeature>) =>
		(r) =>
			Effect.gen(function* () {
				const { server, built, command } = yield* fixture
				const expected = expectedOf(r)
				k.noteAll(featuresOf(r, expected))
				const observed = yield* server.observe(
					() => done,
					runBin(built, {
						args: [...command, "--base-url", server.origins["127.0.0.1"], ...argsOf(r)],
						env: {},
						stdin: new Uint8Array(0)
					})
				)
				const bodies = yield* Effect.forEach(observed.requests, (request) =>
					decodeBody(new TextDecoder().decode(request.body))
				)
				assert.deepEqual(
					{ exitCode: observed.result.exitCode, bodies },
					expected.kind === "sent"
						? { exitCode: 0, bodies: [expected.body] }
						: { exitCode: 2, bodies: [] },
					"the body holds every constant and the drawn values, or the run is refused before any connection"
				)
			}),
	oracle: {
		kind: "specification",
		name: "the schema's constants and the drawn values: the body that reached the server, as JSON, or exit 2 and no request"
	},
	kept: [],
	budget: { runs: 30, steered: 60 },
	kills: [
		{
			file: "packages/cli-generator/src/names/flatten.ts",
			original:
				"\t\treturn Result.succeed(members.length === 1 ? Arr.head(members) : Option.none())",
			replacement: "\t\treturn Result.succeed(Option.none())",
			why: "A one-member enum admits no one value, so `one` becomes a required flag that no field run gives, and every body built from field flags is refused; the property fails."
		},
		{
			file: "packages/cli-generator/src/names/flatten.ts",
			original: '\tif (Record.has<string, Schema.Json>(json, "const")) {',
			replacement: "\tif (false) {",
			why: "A `const` member admits no one value, so each becomes a flag of its own that no field run gives, and every body built from field flags is refused; the property fails."
		}
	]
})
