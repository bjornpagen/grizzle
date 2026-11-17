/**
 * The generator and the runtime agree on every sequential media type: the codec the generator assigns a declared
 * response key is the codec the runtime frames that response's body by, and a type the runtime frames as sequential
 * is one the generator assigns that codec, in every spelling a document may use.
 */

import { deepStrictEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import {
	generatorCodec,
	mediaSpace,
	type ParityFeature,
	parityFeatures,
	runtimeCodec,
	spelled
} from "#test/runtime/sequential-media-parity.fixtures.ts"

/**
 * Each media type of the runtime's sequential table, its suffix forms and its near misses, in four spellings, is
 * framed by the runtime with exactly the codec the generator assigns it. It replaces two example cases, each over a
 * hand list of candidates; the exhaustion proves it over the table's every type.
 */
export const sequentialParity = property.exhaust(mediaSpace, {
	needs: {},
	box: "every type of the runtime's sequential media table, with its +json-seq and +xml forms, upper-cased or not, with a parameter or not",
	situations: [
		"jsonseq",
		"ndjson",
		"sse",
		"not sequential",
		"suffix form",
		"upper case",
		"parameter"
	] satisfies ReadonlyArray<Reached<ParityFeature>>,
	check: (_, c: Case<ParityFeature>) => (media) =>
		Effect.gen(function* () {
			const mediaType = spelled(media)
			const assigned = yield* Effect.orDie(generatorCodec(mediaType))
			const framed = yield* runtimeCodec(mediaType)
			c.noteAll(parityFeatures(media, framed))
			deepStrictEqual(
				Option.filter(
					assigned,
					(codec) => codec === "jsonseq" || codec === "ndjson" || codec === "sse"
				),
				framed
			)
		}),
	oracle: {
		kind: "universal",
		name: "the generator's codec of a response media type is the codec its runtime frames by"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/sequential.ts",
			original: '[",", ":"]',
			replacement: '[","]',
			why: "A colon no longer lets a value follow, so a JSON-seq record holding a member is not framed and its type no longer reads as JSON-seq at runtime; the property fails (CATCH's evidence, mutant f315b3e7bc)."
		}
	]
})
