/**
 * A form body or a form-urlencoded querystring is written exactly as its reference writes it from the WHATWG
 * serializer and the Encoding Object rules, in declared order with undeclared names after, or refused exactly where
 * the reference refuses (a pair two properties send, a refused field however it would travel, a value that is no
 * object), and no refusal repeats a value.
 */

import { assertFalse, assertTrue, deepStrictEqual, strictEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option, Record as Rec, Result, String as Str } from "effect"
import * as Serialize from "#runtime-src/runtime/serialize.ts"
import {
	type FormFeature,
	formFeatures,
	formModel,
	formSpace
} from "#test/runtime/serialize-form.fixtures.ts"
import { bodyBytes, expanded, outcomeOf, SECRET } from "#test/runtime/serialize.fixtures.ts"

/**
 * A form is sent as its reference writes it, nothing is sent where the reference sends nothing, and it is refused as
 * the reference refuses. It replaces eighty-two example cases (serialize-form, serialize-form-number, querystring's
 * form-urlencoded content, and the form arms of serialize-brackets, serialize-scalars and deep-object-keys); its
 * budget is 328 drawn forms, its floor 82, steered up to 328 while a situation is unreached.
 */
export const formBody = property.explore(formSpace, {
	needs: {},
	situations: [
		"space written as plus",
		"name encoded",
		"default content scalar",
		"default content object as JSON",
		"default content list repeats its name",
		"default content list item as JSON",
		"digit text kept",
		"null property omitted",
		"styled list joined",
		"styled object exploded",
		"delimited style",
		"deepObject members",
		"bracket convention",
		"scalar under deepObject",
		"reserved character passed",
		"declared order kept",
		"undeclared name follows",
		"nested styled value refused",
		"number with no JSON text refused",
		"lone surrogate refused",
		"member named like a declared property refused",
		"pair name from two properties refused",
		"refused field named refused",
		"refused field named though it sends nothing refused",
		"refused field carried by a pair refused",
		"refused field carried by a bracketed pair refused",
		"refused field of another media sent",
		"absent body",
		"empty body text",
		"value not an object refused",
		"form querystring sent"
	] satisfies ReadonlyArray<Reached<FormFeature>>,
	check: (_, c: Case<FormFeature>) => (form) =>
		Effect.gen(function* () {
			c.noteAll(formFeatures(form))
			const value = Option.getOrUndefined(form.value)
			const expected = formModel(form)
			if (form.through === "querystring") {
				const actual = yield* expanded(
					Serialize.querystring("q", form.mediaType, value, {
						required: form.required,
						properties: form.properties
					}).expand
				)
				deepStrictEqual(actual.outcome, outcomeOf(expected))
				assertFalse(
					Option.exists(actual.message, Str.includes(SECRET)),
					"a refusal repeats a value"
				)
				return
			}
			const options = Option.match(form.refused, {
				onNone: () => ({ properties: form.properties, required: form.required }),
				onSome: (refused) => ({ properties: form.properties, required: form.required, refused })
			})
			const built = yield* Effect.result(
				Serialize.request("POST", {
					body: Serialize.urlEncoded(form.mediaType, value, options),
					headers: [],
					path: Serialize.path("/", []),
					query: []
				})
			)
			assertTrue(
				Result.isSuccess(built) === Result.isSuccess(expected),
				"refused exactly when the reference refuses"
			)
			if (Result.isFailure(built)) {
				assertFalse(Str.includes(SECRET)(built.failure.message), "a refusal repeats a value")
			}
			if (Result.isSuccess(built) && Result.isSuccess(expected)) {
				const contentType = Rec.get(built.success.headers, "content-type")
				Option.match(expected.success, {
					onNone: () => {
						strictEqual(built.success.body._tag, "Empty")
						deepStrictEqual(contentType, Option.none())
					},
					onSome: () => deepStrictEqual(contentType, Option.some(form.mediaType))
				})
				deepStrictEqual(
					yield* bodyBytes(built.success.body),
					Option.map(expected.success, (written) => Buffer.from(written, "utf8").toString("latin1"))
				)
			}
		}),
	oracle: {
		kind: "second-implementation",
		name: "Node's URLSearchParams serializer per name and value, under the design's Encoding Object and guard rules"
	},
	kept: [],
	budget: { runs: 328, steered: 328 },
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/serialize.ts",
			original:
				"(sender !== undefined && sender !== name) ||\n\t\t\t\t\t(sent.members && declaredNames.has(pairName))",
			replacement: "(sender !== undefined && sender !== name)",
			why: "An exploded member's pair named like a declared property is sent beside it, so a server cannot tell them apart; the property fails (CATCH's evidence, mutant 6b0d3e6409)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/serialize.ts",
			original: '\t\t\treturn token === "~" ? "%7E" : encodeUnreserved(token)',
			replacement: '\t\t\treturn token !== "~" ? "%7E" : encodeUnreserved(token)',
			why: "Every character the WHATWG serializer encodes is written as a tilde's triplet and a tilde by RFC 3986; the property fails (CATCH's evidence, mutant 609d3514cf)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/serialize.ts",
			original: "[`)(pairName)",
			replacement: "\\u0000`)(pairName)",
			why: "A pair named under a refused field by brackets is no longer read as carrying it, so the field reaches the server; the property fails (CATCH's evidence, mutant 2afe26279a)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/serialize.ts",
			original:
				"if (Option.isSome(ownKey)) {\n\t\t\treturn yield* refuseField(ownKey.value, mediaType)\n\t\t}",
			replacement: "{}",
			why: "A refused field among the body's own names is sent when it sends no pair of its own name; the property fails (CATCH's evidence, mutant a9330420c3)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/serialize.ts",
			original: '\tmediaEssence(mediaType) === "application/x-www-form-urlencoded"',
			replacement: '\tmediaEssence(mediaType) !== "application/x-www-form-urlencoded"',
			why: "Form-urlencoded querystring content is written by the text codec and any other by the form encoder; the property fails (CATCH's evidence, mutant 0315b2f785)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/serialize.ts",
			original: '\t\t\texplode: encoding.explode ?? style === "form"',
			replacement: '\t\t\texplode: encoding.explode ?? style !== "form"',
			why: "A property with no explode takes explode true exactly when its style is not form, so a form list is joined; the property fails (CATCH's evidence, mutant f3d6d3d188)."
		}
	]
})
