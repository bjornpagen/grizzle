/**
 * `--document` pairs make a document set in order. Every pair whose retrieval URI is absolute and names a resource no
 * earlier member names (under any spelling: scheme and host case, a dot segment, a fragment), and that is not the entry
 * spelled another way, loads as a member under its URI as written, keeping its path, its format, its value and the
 * sha256 of the bytes it parsed, a pair through a symlink keeping the pair's own path; thirty or forty pairs all load,
 * with or without the entry among them. The first refusal ends the load, in pair order: a relative URI under the file
 * URL of the pair's path (a space, `%`, `#` and a wide character escaped), a repeated resource or the entry respelled
 * as a duplicate, a missing file as unreadable; each document-scoped, naming the pair's path.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import { Digest } from "effect/crypto"
import {
	actualSet,
	expectedSet,
	laidOut,
	pairLoads,
	type PairsFeature,
	pairsFeatures
} from "#test/load/document-set.fixtures.ts"
import { digestService } from "#test/support/digest.ts"

/**
 * Pairs load in order into the set the specification gives, or end at the first refusal. It replaces fourteen example
 * cases, so its rotating stream is fourteen drawn loads; its floor and steered phase reach each situation by an aimed load.
 */
export const documentPairs = property.explore(pairLoads, {
	needs: { dir: Scratch.dir, digest: digestService },
	situations: [
		"a JSON member and a YAML member",
		"a symlinked pair",
		"a relative URI",
		"a relative URI under a path with a space, % and #",
		"an unreadable path",
		"a repeated retrieval URI",
		"a resource spelled with upper case",
		"a resource spelled with a dot segment",
		"a resource spelled with a fragment",
		"a pair spelling the entry differently",
		"the entry among the pairs",
		"a refusal before a later pair's refusal",
		"thirty pairs or more"
	] satisfies ReadonlyArray<Reached<PairsFeature>>,
	check:
		({ dir, digest }, c: Case<PairsFeature>) =>
		(load) =>
			Effect.gen(function* () {
				const service = yield* digest
				const scratch = yield* dir
				const given = yield* laidOut(scratch, load)
				const expected = yield* Effect.provideService(
					expectedSet(load, given),
					Digest.Digest,
					service
				)
				const actual = yield* Effect.provideService(actualSet(load, given), Digest.Digest, service)
				c.noteAll(pairsFeatures(load, actual))
				assert.deepEqual(actual, expected)
			}),
	oracle: {
		kind: "specification",
		name: "the set the pairs make in order: members under their URIs as written, or the first pair's refusal"
	},
	kept: [],
	budget: { runs: 14, steered: 26 },
	kills: [
		{
			file: "packages/generator/src/load/document-set.ts",
			original: "\tretrievalBase(uri) === retrievalBase(known)",
			replacement: "\tretrievalBase(uri) !== retrievalBase(known)",
			why: "Two spellings of one resource read as different documents and every other pair as the same one; the property fails (CATCH's evidence, mutant 5d39e53139)."
		},
		{
			file: "packages/generator/src/load/document-set.ts",
			original: "yield* loadPair(loading, pair, readOperatorPair)",
			replacement: "{}",
			why: "No pair is loaded, so every set is empty; the property fails (CATCH's evidence, mutant a8b0177a3b)."
		},
		{
			file: "packages/generator/src/load/document-set.ts",
			original:
				'Effect.fnUntraced(\n\tfunction* readMember(\n\t\tpair: DocumentPair,\n\t\tdocument: Document,\n\t\tread: ReadPair\n\t): Effect.fn.Return<SetMember, LoadRefusal, FileSystem.FileSystem | Digest.Digest> {\n\t\tconst bytes = yield* read(pair, document)\n\t\tconst loaded = yield* loadBytes(bytes, { document })\n\t\tconst sha256 = yield* sha256Hex(bytes)\n\n\t\treturn { ...loaded, path: pair.path, sha256 }\n\t},\n\t(effect, pair) => effect.pipe(Effect.catchTag("LoadRefusal", withPathOf(pair.path)))\n)',
			replacement:
				"Effect.fnUntraced(function* readMember(\n\t\tpair: DocumentPair,\n\t\tdocument: Document,\n\t\tread: ReadPair\n\t): Effect.fn.Return<SetMember, LoadRefusal, FileSystem.FileSystem | Digest.Digest> {\n\t\tconst bytes = yield* read(pair, document)\n\t\tconst loaded = yield* loadBytes(bytes, { document })\n\t\tconst sha256 = yield* sha256Hex(bytes)\n\n\t\treturn { ...loaded, path: pair.path, sha256 }\n\t})",
			why: "A pair's refusal while reading no longer names the pair's path; the property fails (CATCH's evidence, mutant 1e6204a91f)."
		},
		{
			file: "packages/generator/src/load/document-set.ts",
			original: "if (isDuplicate(loading, uri.value)) {\n\t\treturn yield* duplicateUri(pair)\n\t}",
			replacement: "{}",
			why: "A pair naming a resource a member already has is loaded over it instead of refused as a duplicate; the property fails (CATCH's evidence, mutant 094c62e6e0)."
		},
		{
			file: "packages/generator/src/load/document-set.ts",
			original: "entry !== undefined && uri !== entry && sameResource(uri, entry)",
			replacement: "entry !== undefined && uri !== entry",
			why: "Every pair under another URI than the entry's is refused as the entry respelled; the property fails (CATCH's evidence, mutant e4475b16f5)."
		}
	]
})
