/**
 * Secret and base64 body fields through the pipeline (resolve, normalize, the names plan, the CLI emitter): over JSON
 * bodies whose properties are drawn from every shape the rules turn on, on each line, a `format: password` string is a
 * secret-file flag `--<name>-file` and never `--<name>` (design 13.1 R4), reached directly, through a component, an
 * allOf member, a `$ref` sibling or any anyOf or oneOf branch (failing closed), at its dotted name one level down and
 * not at all inside a JSON-valued flag; an array of password strings has no flag and is refused at element scope
 * (FMT-05), the body still sent by `--body-file`; a base64 string (contentEncoding base64 or base64url, or 3.0's
 * `format: byte`) is a file flag the emitted CLI sends in that encoding, 3.1's `format: byte` and any base64 array plain
 * text; and a sibling named like a secret's file flag refuses the operation (RQB-03).
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	expectedOf,
	type Feature,
	featuresOf,
	plannedOf,
	secretSpace
} from "#test/names/password-file.fixtures.ts"

/**
 * A drawn body's secret, base64 and plain fields are planned and emitted as the specification says. Its budget replaces
 * 21 example cases (password-file 13, base64-field 8): 21 independent cases, and up to 42 steered while one of its 21
 * situations is unreached, each reached by its own aimed arm.
 */
export const secretFields = property.explore(secretSpace, {
	needs: {},
	situations: [
		"a property shaped plain string",
		"a property shaped password",
		"a property shaped password through a component",
		"a property shaped password through an allOf member",
		"a property shaped password beside a $ref",
		"a property shaped password in an anyOf branch",
		"a property shaped password in a oneOf branch",
		"a property shaped base64 contentEncoding",
		"a property shaped base64url contentEncoding",
		"a property shaped format byte",
		"a property shaped password array inline",
		"a property shaped password array through items $ref",
		"a property shaped password array component",
		"a property shaped password array through allOf",
		"a property shaped plain string array",
		"a property shaped format byte array",
		"a property shaped object holding a password",
		"a property shaped object two deep holding a password",
		"a secret's sibling colliding",
		"a 3.0 byte field as base64",
		"a 3.1 byte field as text"
	],
	check: (_, k: Case<Feature>) => (c) =>
		Effect.gen(function* () {
			k.noteAll(featuresOf(c))
			const planned = yield* plannedOf(c)
			assert.deepEqual(planned, expectedOf(c))
		}),
	oracle: {
		kind: "specification",
		name: "design 4.5 and 13.1 R4's secret-file flags, 6.3's base64 file flags and FMT-05, by each property's shape and line"
	},
	kept: [],
	budget: { runs: 21, steered: 42 },
	kills: [
		{
			file: "packages/generator/src/normalize/schemas.ts",
			original: '["requestBody", "requestBody", "one"]',
			replacement: '["requestBody", "one"]',
			why: "Normalize stores no schema for a request body's own sites, so a body's properties plan no field flags; the property fails (CATCH's evidence, mutant 7028d16aeb)."
		},
		{
			file: "packages/generator/src/resolve/index.ts",
			original:
				'\t\tif (kind === "schema") {\n\t\t\tconst own = Option.getOrUndefined(schemaBase(member.line, base, node))\n\t\t\tif (own === undefined) {\n\t\t\t\treturn failure(\n\t\t\t\t\tmember.line === "3.2" ? "REF-12/invalid-base" : "REF-11/invalid-base",',
			replacement:
				'\t\tif (kind === "schema") {\n\t\t\tconst own = Option.getOrUndefined(schemaBase(member.line, base, node))\n\t\t\tif (own !== undefined) {\n\t\t\t\treturn failure(\n\t\t\t\t\tmember.line === "3.2" ? "REF-12/invalid-base" : "REF-11/invalid-base",',
			why: "A schema reference resolves as a non-schema member, so a body reaching a component through `$ref` resolves wrongly; the property fails (CATCH's evidence, mutant 65babfccac)."
		}
	]
})
