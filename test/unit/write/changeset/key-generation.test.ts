/**
 * Bucket(a, b, v), its primary key (m, b), m = a mod 3 a key generation.
 *
 * Host normalization over a relation whose primary key holds a key generation, checked against the brute-force add-wins
 * calculator over the facts the model fills first (each fact's m, a second implementation of `a mod 3`): a refusal
 * before SQL is a ChangeSet whose filled additions the add-wins meaning rejects by the primary key's law, its witness
 * the filled key two of one stratum's additions share, refused even where their reads (a, b) differ; and a normalized
 * ChangeSet holds every fact of every slot, insert, put and delete, with its key generation filled as the model fills
 * it, and means exactly what the one it came from means, so its collapse and its netting are the model's.
 *
 * Oracle: the brute-force add-wins calculator (oracle/addwins.ts, a second implementation) over the model's filled facts.
 *
 * Features: two strata, a refusal at a key the reads tell apart, two deletions at one key normalized, a fact a stratum
 * both deletes and adds netted, an insert and a put of one fact.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	caseGen,
	collidingGen,
	fillsFirst,
	type KeyGenerationFeature,
	nestedCaseGen,
	nestedCollidingGen,
	type NestedKeyFeature,
	nestingFillsFirst,
	nettingGen
} from "#test/unit/write/changeset/key-generation.fixtures.ts"

/**
 * Normalization over a key generation compares the filled key: it refuses exactly what the add-wins meaning of the
 * model's filled facts rejects, by the primary key, and keeps every slot's facts filled and the meaning of what it
 * passes.
 */
export const normalizationOverAKeyGenerationComparesTheFilledKeyAndKeepsTheMeaningOfWhatItPasses =
	property.explore(
		aimed(caseGen, [
			["refused at a key its reads tell apart", collidingGen],
			["a fact a stratum both deletes and adds, netted", nettingGen]
		]),
		{
			needs: {},
			situations: [
				"two strata",
				"refused at a key its reads tell apart",
				"two deletions at one key, normalized",
				"a fact a stratum both deletes and adds, netted",
				"an insert and a put of one fact"
			] satisfies ReadonlyArray<Reached<KeyGenerationFeature>>,
			check:
				(_, c: Case<KeyGenerationFeature>) =>
				([start, strata]) =>
					fillsFirst(start, strata, c),
			oracle: {
				kind: "second-implementation",
				name: "the brute-force add-wins calculator over the model's filled facts"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/write/insert/unique.ts",
					original:
						'\t\tcase "retirement":\n\t\tcase "keyGenerated":\n\t\t\treturn true\n\t\tcase "generated":',
					replacement:
						'\t\tcase "retirement":\n\t\t\treturn true\n\t\tcase "keyGenerated":\n\t\tcase "generated":',
					why: "The host holds no key generation, so it skips a key over one as it skips a key over a generated field PostgreSQL computes: two additions of one stratum at one filled key pass normalization (write/insert/unique.ts hostHeld)."
				},
				{
					file: "packages/engine/src/runtime/write/normalize.ts",
					original: "\tif (fill.generations.length === 0) {\n\t\treturn Result.ok(stated)\n\t}",
					replacement: "\tif (fill.generations.length >= 0) {\n\t\treturn Result.ok(stated)\n\t}",
					why: "The host compares keys before it fills them: a stated fact reaches the same-key checks and its slot with no key generation (runtime/write/normalize.ts filledFacts skipped)."
				}
			]
		}
	)

/**
 * A nested insert over an owner whose primary key holds a key generation fills the owner's key before it keys the
 * owner and copies it: it refuses exactly where two owner facts of a stratum that are not one fact share the filled key,
 * by the owner's primary key, and else every member row holds its owner's filled key at its slot.
 */
export const aNestedInsertOverAKeyGenerationKeysEachOwnerAndItsMembersByTheFilledKey =
	property.explore(
		aimed(nestedCaseGen, [["two owners at one key their reads tell apart", nestedCollidingGen]]),
		{
			needs: {},
			situations: [
				"two strata",
				"an owner stated twice",
				"two owners at one key their reads tell apart",
				"an owner with members"
			] satisfies ReadonlyArray<Reached<NestedKeyFeature>>,
			check: (_, c: Case<NestedKeyFeature>) => (strata) => nestingFillsFirst(strata, c),
			oracle: { kind: "specification", name: "the owner's key filled first: a mod 3 and b" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/fill.ts",
					original:
						'\t\tif (field.writing.kind !== "generated" && field.writing.kind !== "keyGenerated") {',
					replacement: '\t\tif (field.writing.kind !== "generated") {',
					why: "The walk lays out no key generation, as if PostgreSQL computed it: no owner's key is filled before the nesting keys the owner and its members copy it (analysis/theory/fill.ts generatedAt)."
				}
			]
		}
	)
