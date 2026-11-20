/**
 * RFC 6901 JSON Pointers (model/pointer.ts), the `$defs` key reader (model/defs-ref.ts) and the extension-name test
 * (model/extension.ts). A pointer or URI fragment drawn into a JSON tree (empty, blank, escaped, percent-encoded,
 * prototype and index-like names) or off it (a missing member, an index out of range or non-canonical, a scalar
 * descended into), spelled soundly or with a fault (no leading slash, a `~2` or bare `~`, a broken percent escape, no
 * hash), parses and evaluates as a reference evaluator written from the RFC says, its Result and Effect forms agreeing,
 * each failure naming the pointer through the token that failed; the JsonPointer brand admits exactly the texts that
 * parse, and formatting the parsed tokens gives the pointer text back. A pointer is within an ancestor exactly when its
 * tokens extend the ancestor's; a `#/$defs/` reference's key is its text unescaped by `~1` and `~0` alone, never
 * percent-decoded; a member name is a specification extension exactly when it begins `x-`.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	expectedNamesOf,
	expectedOf,
	type NameFeature,
	nameFeaturesOf,
	namesOf,
	nameSpace,
	type PointerFeature,
	pointerFeaturesOf,
	pointerSpace
} from "#test/model/pointer.fixtures.ts"

/**
 * A drawn pointer parses and evaluates as the reference does, in both forms. Its budget replaces 52 example cases
 * (pointer's 12 section 5 and 12 section 6 evaluations, its 28 parse, failure and agreement cases): 52 independent
 * cases, and up to 28 steered while one of its 14 situations is unreached, each reached by its own aimed arm.
 */
export const pointerEvaluation = property.explore(pointerSpace, {
	needs: {},
	situations: [
		"a value reached",
		"the root by the empty pointer",
		"a member missing",
		"an index out of range",
		"a non-canonical index",
		"a scalar descended into",
		"a prototype name",
		"an escaped token",
		"a fragment percent-encoded",
		"no leading slash refused",
		"an escape of `~2` refused",
		"a bare `~` at the end refused",
		"a broken percent escape refused",
		"no hash refused"
	],
	check: (_, k: Case<PointerFeature>) => (c) =>
		Effect.gen(function* () {
			k.noteAll(pointerFeaturesOf(c))
			const actual = yield* actualOf(c)
			assert.deepEqual(actual, expectedOf(c))
		}),
	oracle: {
		kind: "second-implementation",
		name: "a reference RFC 6901 parser and evaluator, sections 3, 4 and 6, written from the RFC"
	},
	kept: [],
	budget: { runs: 52, steered: 28 },
	kills: [
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original: "\t\t\t\tstepResult(current, token, formatPointer(Arr.take(tokens, index + 1)))",
			replacement: "\t\t\t\tstepResult(current, token, formatPointer(Arr.take(tokens, index + 0)))",
			why: "An evaluation failure names the pointer to the token's parent instead of through the token; the property fails (CATCH's evidence, mutant fe745aa53c)."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original:
				'Result.try({\n\t\tcatch: () => new PointerSyntaxError({ pointer: fragment, reason: "invalid-percent-escape" }),\n\t\ttry: () => decodeURIComponent(Str.slice(1)(fragment))\n\t}).pipe(\n\t\tResult.flatMap((decoded) =>\n\t\t\tResult.mapError(\n\t\t\t\tparsePointerResult(decoded),\n\t\t\t\t(failure) => new PointerSyntaxError({ pointer: fragment, reason: failure.reason })\n\t\t\t)\n\t\t)\n\t)',
			replacement:
				'Result.try({\n\t\tcatch: () => new PointerSyntaxError({ pointer: fragment, reason: "invalid-percent-escape" }),\n\t\ttry: () => decodeURIComponent(Str.slice(1)(fragment))\n\t})',
			why: "A fragment is percent-decoded but never parsed as a pointer, so its tokens are wrong; the property fails (CATCH's evidence, mutant a7fdf4a4db)."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original: "if (Str.isEmpty(pointer)) {\n\t\treturn Result.succeed([])\n\t}",
			replacement: "{}",
			why: "The empty pointer is refused as missing its leading slash instead of naming the whole document; the property fails (CATCH's evidence, mutant b8c5d9a1bc)."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original:
				'invalidEscape.test(token)\n\t\t? Result.fail(new PointerSyntaxError({ pointer: token, reason: "invalid-escape" }))\n\t\t: Result.succeed(JsonPointer.unescapeToken(token))',
			replacement:
				'invalidEscape.test(token) ? Result.succeed(JsonPointer.unescapeToken(token)) : Result.fail(new PointerSyntaxError({ pointer: token, reason: "invalid-escape" }))',
			why: "Unescaping fails every sound token and passes every bad escape; the property fails (CATCH's evidence, mutant ec2c5d7c2a)."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original:
				"if (Arr.isArray<Json>(current)) {\n\t\treturn Result.fromOption(\n\t\t\tarrayIndex.test(token) ? Arr.get(current, Number(token)) : Option.none(),\n\t\t\t() => new PointerIndexOutOfRange({ pointer, token })\n\t\t)\n\t}",
			replacement: "{}",
			why: "An array is read as an object, so a non-canonical index or `-` is a missing member and the failure is misnamed; the property fails (CATCH's evidence, mutant 41318bc6f6)."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original: "arrayIndex.test(token) ? Arr.get(current, Number(token)) : Option.none()",
			replacement: "arrayIndex.test(token) ? Option.none() : Arr.get(current, Number(token))",
			why: "A canonical array index reaches nothing and every other token reads an item; the property fails (CATCH's evidence, mutant 0aa9da3fd6)."
		}
	]
})

/**
 * Drawn pointer pairs and member names read as the model says. Its budget replaces 8 example cases (pointer's 2
 * isPointerWithin, defs-ref's 5, extension's 1): 8 independent cases, and up to 18 steered while one of its 9
 * situations is unreached, each reached by its own aimed arm.
 */
export const pointerNames = property.explore(nameSpace, {
	needs: {},
	situations: [
		"a pointer within itself",
		"a pointer below its ancestor",
		"a sibling sharing a text prefix",
		"a pointer above",
		"the empty ancestor",
		"an extension name",
		"an extension in another case",
		"a $defs key with escapes",
		"a reference outside $defs"
	],
	check: (_, k: Case<NameFeature>) => (c) =>
		Effect.sync(() => {
			k.noteAll(nameFeaturesOf(c))
			assert.deepEqual(namesOf(c), expectedNamesOf(c))
		}),
	oracle: {
		kind: "specification",
		name: "token-wise ancestry, `~1` and `~0` unescaping alone, and the case-sensitive `x-` prefix"
	},
	kept: [],
	budget: { runs: 8, steered: 18 },
	kills: [
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original: "pointer === ancestor || Str.startsWith(",
			replacement: "false && Str.startsWith(",
			why: "isPointerWithin never answers true, so no pointer is within itself or its ancestor; the property fails (CATCH's evidence, mutant 28323e2ebb)."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original: "pointer === ancestor ||",
			replacement: "pointer !== ancestor ||",
			why: "isPointerWithin no longer counts a pointer as within itself; the property fails (CATCH's evidence, mutant c38cb8519b)."
		},
		{
			file: "packages/cli-generator/src/model/defs-ref.ts",
			original:
				"Str.startsWith(defsRefPrefix)(ref)\n\t\t? JsonPointer.unescapeToken(Str.slice(defsRefPrefix.length)(ref))\n\t\t: undefined",
			replacement:
				"Str.startsWith(defsRefPrefix)(ref) ? undefined : JsonPointer.unescapeToken(Str.slice(defsRefPrefix.length)(ref))",
			why: "defsKeyOf reads a `#/$defs/` reference as no key and every other reference as one; the property fails (CATCH's evidence, mutant c8ed75051b)."
		},
		{
			file: "packages/cli-generator/src/model/extension.ts",
			original: 'Str.startsWith("x-")(key)',
			replacement: "true",
			why: "Every member name reads as a specification extension; the property fails (CATCH's evidence, mutant 6f194aedd5)."
		}
	]
})
