/**
 * Media negotiation follows its precedence model: the request media an operation sends with or without
 * `--content-type`, the Accept value with or without `--accept`, and the declared key a response's Content-Type
 * dispatches to, an exact type before its range before any; a refusal names its flag and never the operator's value.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import * as Negotiate from "#runtime-src/runtime/negotiate.ts"
import {
	acceptModel,
	declarationOf,
	dispatchModel,
	echoes,
	type Negotiated,
	type NegotiationFeature,
	negotiationFeatures,
	negotiationSpace,
	requestMediaModel
} from "#test/runtime/negotiate.fixtures.ts"

/** A negotiation's effect as its result: the value, or the flag its UsageError names, its message kept for the echo law. */
const negotiated = <A>(
	effect: Effect.Effect<A, { readonly flag?: string; readonly message: string }>
) =>
	Effect.match(effect, {
		onFailure: (error) =>
			[
				{ kind: "refused", flag: error.flag ?? "" } satisfies Negotiated<A>,
				Option.some(error.message)
			] as const,
		onSuccess: (value) =>
			[{ kind: "chosen", value } satisfies Negotiated<A>, Option.none<string>()] as const
	})

/**
 * Each negotiation chooses, lists and dispatches as its precedence model does, or is refused naming its flag. It
 * replaces seventeen example cases (negotiate's selectRequestMedia, accept and dispatchResponse); its budget is 68
 * drawn negotiations, its floor 17, steered up to 68.
 */
export const mediaNegotiation = property.explore(negotiationSpace, {
	needs: {},
	situations: [
		"one key used as declared",
		"JSON key chosen by default",
		"first key by default",
		"type chosen among keys",
		"range key with a type inside it",
		"exact key over its range",
		"range key as default refused",
		"undeclared type refused",
		"not one concrete type refused",
		"no request media refused",
		"Accept lists every key once",
		"Accept narrowed to JSON",
		"Accept names one type",
		"Accept outside the keys refused",
		"no Accept",
		"dispatched exactly",
		"dispatched by a type range",
		"dispatched by any",
		"dispatched past case and parameters",
		"dispatched nowhere"
	] satisfies ReadonlyArray<Reached<NegotiationFeature>>,
	check: (_, c: Case<NegotiationFeature>) => (media) =>
		Effect.gen(function* () {
			c.noteAll(negotiationFeatures(media))
			const declaration = declarationOf(media)
			const [chosen, chosenMessage] = yield* negotiated(
				Negotiate.selectRequestMedia(declaration, media.contentType)
			)
			assert.deepEqual(chosen, requestMediaModel(media))
			const [accepted, acceptMessage] = yield* negotiated(
				Negotiate.accept(declaration, media.accept)
			)
			assert.deepEqual(accepted, acceptModel(media))
			assert.equal(
				Option.exists(chosenMessage, echoes) || Option.exists(acceptMessage, echoes),
				false,
				"a refusal repeats the operator's value"
			)
			assert.deepEqual(
				Option.fromUndefinedOr(
					Negotiate.dispatchResponse(
						Arr.dedupe(Arr.flatten(Rec.values(media.responses))),
						Option.getOrUndefined(media.actual)
					)
				),
				dispatchModel(media)
			)
		}),
	oracle: {
		kind: "second-implementation",
		name: "a media precedence model: an exact type, then its type range, then any, the first among equals"
	},
	kept: [],
	budget: { runs: 68, steered: 68 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/negotiate.ts",
			original: 'Str.endsWith("/*")(essence(key))',
			replacement: "true",
			why: "Every key reads as a range, so a lone concrete key cannot be the default and a named type is sent under any key; the property fails (CATCH's evidence, mutant ad92409670)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/negotiate.ts",
			original: "\t\t\t\t\t\tmedia.request.length === 1\n\t\t\t\t\t\t\t? first",
			replacement: "\t\t\t\t\t\tmedia.request.length === 2\n\t\t\t\t\t\t\t? first",
			why: "A lone key is no longer used as declared but sought among JSON keys, and two keys default to the first; the property fails (CATCH's evidence, mutant c97a2f0475)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/negotiate.ts",
			original: "\tArr.findFirst(declared, (key) => essence(key) === concrete.type).pipe(",
			replacement: "\tArr.findFirst(declared, (key) => essence(key) !== concrete.type).pipe(",
			why: "The exact match takes the first key that is not the named type; the property fails (CATCH's evidence, mutant 2c778d0c25)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/negotiate.ts",
			original: "!==",
			replacement: "===",
			why: "A type's range is matched by any range but its own, and any-type ranges by */* alone; the property fails (CATCH's evidence, mutant 89bbe0c455)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/negotiate.ts",
			original:
				"\t\t\tconst listed = json.length > 0 && json.length < declared.length ? json : declared",
			replacement:
				"\t\t\tconst listed = json.length > 1 && json.length < declared.length ? json : declared",
			why: "Accept narrows to JSON only when two JSON keys coexist with others, so one JSON key beside others is not chosen; the property fails (CATCH's evidence, mutant d3bb2a7141)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/negotiate.ts",
			original:
				'Arr.isReadonlyArrayNonEmpty(listed) ? Option.some(Arr.join(listed, ", ")) : Option.none()',
			replacement:
				'Arr.isReadonlyArrayNonEmpty(listed) ? Option.none() : Option.some(Arr.join(listed, ", "))',
			why: "An operation with response media sends no Accept and one without sends an empty one; the property fails (CATCH's evidence, mutant 43c2a18460)."
		}
	]
})
