/**
 * A key set whose keys are every key of a stored relation at a coarser prefix is read once a prefix, as a range: the
 * nodes a read holds of a document are every node of it, so the document's attributes, keyed by the node and a
 * predecessor, are one range of the attributes' key, read once and joined to the nodes in memory, where read at each
 * node's key the read descends the attributes' index once for each node. metis's sitting read its 34 served items'
 * 1,462 nodes and then their attributes, element types and namespaces at each node's key, 1,462 descents each, 7.9k
 * of its 12.7k pages (lower/optimize/cte-policy prefixOver, lower/shapes/region chainedSelect `keyset`, lower/shapes/attach pipelinedAttachment).
 *
 * On PostgreSQL 19, a sitting's served documents beside others no sitting serves, each of a few nodes and then of a
 * hundred more, each node with its attributes.
 *
 * Oracle: a bound, the read descends the attributes' indexes at most once for each served document, however many
 * nodes each holds, in any pg_class state.
 *
 * Features: the attributes in one region with the nodes, and attached to each node (metis's form); one document and
 * several; each pg_class state.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type PrefixFeature,
	prefixGen,
	prefixRangeTemplate,
	runPrefixRange
} from "#test/pg/lower-shapes/prefix-range.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A sitting's content reads each served document's attributes once, however many nodes the document holds. */
export const aKeySetOfEveryKeyAtAPrefixIsReadOnceAPrefixAsARange = property.explore(prefixGen, {
	needs: { stored: Substrate.rolledBack(prefixRangeTemplate) },
	situations: [
		"in one region",
		"attached to each node",
		"one document",
		"several documents",
		"its tables never vacuumed",
		"its tables counted empty",
		"its tables analyzed",
		"its tables skewed",
		"its tables large"
	] satisfies ReadonlyArray<Reached<PrefixFeature>>,
	check:
		({ stored }, c) =>
		(drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* stored
				yield* runPrefixRange(value.installed, connection, drawn, c)
			}),
	oracle: {
		kind: "universal",
		name: "bound: the read descends the attributes' indexes at most once for each served document, at a few nodes a document and at a hundred more, in any pg_class state"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
			original: "\treturn properKeyPrefix(whole.base, whole.at) &&\n",
			replacement: "\treturn false &&\n",
			why: "No read is taken at a prefix its rows before hold whole: in one region and attached to each node alike, each node's attributes are read at the node's key, one descent of the attributes' index for each node of each served document."
		}
	]
})
