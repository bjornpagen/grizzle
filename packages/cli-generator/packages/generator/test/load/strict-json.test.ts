/**
 * The strict JSON loader against an oracle that reads the same document from the tree it was rendered from: a generated
 * document, written with generated whitespace and escapes, loads as its own value, and when it breaks a rule the loader
 * refuses it with the code, pointer and position the oracle derives from the tree and the rendering. The rules, in the
 * loader's order: UTF-8; then JSON syntax; then, in document order, a repeated key (compared after unescaping) and an
 * unsafe number literal at a `default`, `enum` or `const` site (never inside `example`/`examples`, never as a name under
 * a name map such as `properties`). No size, depth or count refuses a document: it is its own user's.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actual,
	documentGen,
	expected,
	type Feature,
	featuresOf,
	render
} from "#test/load/strict-json.fixtures.ts"

/**
 * A generated document loads as its own value or is refused exactly as its tree says. Its budget is the count its suite stated
 * before the conversion: 600 independent cases, and up to 2000 steered while a situation is unreached.
 */
export const strictJson = property.explore(documentGen, {
	needs: {},
	situations: [
		"loaded",
		"invalid syntax",
		"not UTF-8",
		"a repeated key",
		"an unsafe number at a data site",
		"an unsafe number under an example",
		"a byte order mark",
		"a multi-byte character before a finding"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, k: Case<Feature>) => (doc) =>
		Effect.gen(function* () {
			const rendered = render(doc)
			const want = expected(doc, rendered)
			const got = yield* actual(doc, rendered)
			k.noteAll(featuresOf(doc, rendered, want))
			assert.deepEqual(got, want)
		}),
	oracle: {
		kind: "second-implementation",
		name: "the document's value, or the refusal's code, pointer and position, derived from the tree it was rendered from"
	},
	kept: [],
	budget: { runs: 600, steered: 2000 },
	kills: [
		{
			file: "packages/generator/src/load/json.ts",
			original: 'top.key = Str.includes("\\\\")(raw) ? unescapeKey(raw) : raw',
			replacement: "top.key = raw",
			why: "Keys are compared before unescaping, so a key repeated under another escape spelling is not refused as a duplicate (and one escaped alike is); the property fails."
		},
		{
			file: "packages/generator/src/load/json.ts",
			original: `formatPointer(Arr.map(frames, (frame) => (frame.array ? \`\${frame.index}\` : frame.key)))`,
			replacement: `formatPointer(Arr.map(Arr.dropRight(frames, 1), (frame) => (frame.array ? \`\${frame.index}\` : frame.key)))`,
			why: "A finding's pointer names the parent object instead of the member, so a repeated key or an unsafe number is reported one level up; the property fails."
		},
		{
			file: "packages/generator/src/load/json.ts",
			original: "if (frame.array || frame.nameMap) {",
			replacement: "if (frame.array) {",
			why: "valueContext reads every key under a name map such as `properties` as a keyword, so a property named `default`, `enum` or `const` makes its schema a data site and its number literals unsafe; the property fails."
		},
		{
			file: "packages/generator/src/load/json.ts",
			original: "const value = Math.abs(Number(token))",
			replacement: "const value = Math.abs(Math.trunc(Number(token)))",
			why: "isUnsafeNumber reads only a literal's integer part, so a decimal at a data site is judged against the wrong double; the property fails."
		},
		{
			file: "packages/generator/src/load/json.ts",
			original: "column: codePointCount(Arr.lastNonEmpty(lines)) + 1,",
			replacement: "column: Arr.lastNonEmpty(lines).length + 1,",
			why: "A finding's column counts UTF-16 units, not code points, so a finding after an astral character on its line is placed one column too far; the property fails."
		},
		{
			file: "packages/generator/src/load/json.ts",
			original:
				'state.frames.push({\n\t\t...valueContext(state.frames.at(-1)),\n\t\tarray: char === "[",\n\t\texpectKey: char === "{",\n\t\tindex: 0,\n\t\tkey: "",\n\t\tkeys: new Set()\n\t})',
			replacement: "{}",
			why: "An opened object or array pushes no frame, so its members are read in the enclosing container's context; the property fails (CATCH's evidence, mutant 531cb6ed1f)."
		}
	]
})
