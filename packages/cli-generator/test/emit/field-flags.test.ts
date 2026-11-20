/**
 * The field flags the emitter writes behave as their help says, run in process the way a generated command runs them.
 * A numeric field's flag (Input.numericFlag for an integer or a number, Input.int64Flag for an int64) is labelled in
 * help by its numeric kind, never `string`; a text the JSON grammar of its kind admits reaches the JSON body with every
 * digit, past a double's precision too, and any other text exits 2 and sends nothing. A secret field's flag
 * (Input.secretFileFlag, Input.secretPartFlag) is labelled `path|-` and its help shows the property's description, when
 * it has one, before the note that the value is read from a file or stdin and never echoed. A multipart number part
 * sends its text unchanged. A deepObject parameter's JSON flag sends its object as `name[key]=value` pairs.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option, String as Str } from "effect"
import {
	admits,
	AIMS,
	caseGen,
	deepObjectQuery,
	deepObjectSent,
	type Feature,
	featuresOf,
	numberPartSent,
	numericRuns,
	objectText,
	SECRET_NOTE,
	secretHelp
} from "#test/emit/field-flags.fixtures.ts"

/**
 * A field flag parses, labels and sends as its kind's grammar and help say. It replaces 9 example cases (the runtime
 * halves of fmt-fixes and password-file), so its budget is 9 independent cases; its situations need few more, up to 40
 * steered.
 */
export const fieldFlags = property.explore(aimed(caseGen, AIMS), {
	needs: {},
	situations: [
		"an integer field",
		"a number field",
		"an int64 field",
		"a secret-file field",
		"a secret part",
		"a number part",
		"a deepObject JSON flag",
		"a text the grammar refuses",
		"an integer text the grammar refuses",
		"a number's digits past a double's precision",
		"a described secret"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, k: Case<Feature>) => (drawnCase) =>
		Effect.gen(function* () {
			k.noteAll(featuresOf(drawnCase))
			switch (drawnCase.kind) {
				case "integer":
				case "number":
				case "int64": {
					const { name, text } = drawnCase
					const runs = yield* numericRuns(drawnCase.kind, name, text)
					const label = drawnCase.kind === "number" ? "number" : "integer"
					const admitted = admits(drawnCase.kind, text)
					assert.deepEqual(
						{
							code: runs.given.code,
							sent: runs.given.sent,
							helped: runs.help.code,
							labelled: Str.includes(`--${name} ${label}`)(runs.help.printed),
							asString: Str.includes(`--${name} string`)(runs.help.printed)
						},
						{
							code: admitted ? 0 : 2,
							sent: admitted ? [`{"${name}":${text}}`] : [],
							helped: 0,
							labelled: true,
							asString: false
						}
					)
					return
				}
				case "secret-file":
				case "secret-part": {
					const { name, description } = drawnCase
					const help = yield* secretHelp(drawnCase.kind, name, description)
					const note = Str.indexOf(SECRET_NOTE)(help.printed)
					const described = Option.flatMap(description, (text) => Str.indexOf(text)(help.printed))
					assert.deepEqual(
						{
							code: help.code,
							labelled: Str.includes(`--${name} path|-`)(help.printed),
							noted: Option.isSome(note),
							describedFirst: Option.match(description, {
								onNone: () => true,
								onSome: () =>
									Option.isSome(described) && Option.isSome(note) && described.value < note.value
							})
						},
						{ code: 0, labelled: true, noted: true, describedFirst: true }
					)
					return
				}
				case "deep-json": {
					const { name, entries } = drawnCase
					const sent = yield* deepObjectSent(name, objectText(entries))
					assert.deepEqual(sent, [deepObjectQuery(name, entries)])
					return
				}
				case "number-part": {
					const sent = yield* numberPartSent(drawnCase.text)
					assert.deepEqual(Str.includes(`\r\n\r\n${drawnCase.text}\r\n--`)(sent), true)
					return
				}
			}
		}),
	oracle: {
		kind: "specification",
		name: "the JSON grammar of each numeric kind (RFC 8259) and each flag's help contract: its label, description and note"
	},
	kept: [],
	budget: { runs: 9, steered: 40 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
			original:
				"Flag.String(name).pipe(\n\t\tFlag.withMetavar(kind),\n\t\tFlag.mapEffect(numericText(kind, (cause) => usage(name, cause)))\n\t)",
			replacement:
				"Flag.String(name).pipe(Flag.mapEffect(numericText(kind, (cause) => usage(name, cause))))",
			why: "A numeric flag loses its label, so help shows an integer or a number field as a string; the property fails (CATCH's evidence, mutant 67fa9e64ed)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
			original:
				"Flag.String(name).pipe(\n\t\tFlag.withMetavar(kind),\n\t\tFlag.mapEffect(numericText(kind, (cause) => usage(name, cause)))\n\t)",
			replacement: "Flag.String(name).pipe(Flag.withMetavar(kind))",
			why: "A numeric flag no longer checks its text, so `--count 1e2` is sent where it must exit 2; the property fails (CATCH's evidence, mutant 17bf87d53d)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
			original:
				'Flag.String(name).pipe(\n\t\tFlag.withMetavar("path|-"),\n\t\tFlag.optional,\n\t\tFlag.withDescription(secretHelp(description))\n\t)',
			replacement:
				"Flag.String(name).pipe(Flag.optional, Flag.withDescription(secretHelp(description)))",
			why: "A secret-file flag loses its `path|-` label, so help no longer says the value is a path; the property fails (CATCH's evidence, mutant 29eb91b5ad)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
			original:
				'Flag.String(name).pipe(Flag.withMetavar("path|-"), Flag.withDescription(secretHelp(description)))',
			replacement: 'Flag.String(name).pipe(Flag.withMetavar("path|-"))',
			why: "A secret part's flag loses its description and note, so help never says the value is read from a file and never echoed; the property fails (CATCH's evidence, mutant 1cd3545b30)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				"entries.push([name, repeated.has(name) ? Arr.map(leaves, assertedValue) : assertedValue(first)])",
			replacement: "{}",
			why: "A multipart body drops every asserted field, so a number part is never sent; the property fails (CATCH's evidence, mutant c4fccda7a7)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
			original: "\treturn true\n}\n\nconst JsonNodeSchema = Schema.declare(isJsonNode)",
			replacement: "\treturn false\n}\n\nconst JsonNodeSchema = Schema.declare(isJsonNode)",
			why: "No parsed JSON value is a JSON node, so a deepObject parameter's JSON flag refuses every value, as m2-dpany's string flag did; the property fails (dpany's claim; its CATCH evidence 7011ca43c4 was this check before the walk became iterative)."
		}
	]
})
