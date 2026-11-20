/**
 * A whole rule's statement is the size of the definitions it reads, not of their unfolding (analysis/theory/navigate.ts,
 * lower/optimize/cte-policy): a join of definitions its rule reads more than once in its unfolding is computed once per
 * unit and every read of it joins its rows, so a chain of queries each reading the one below it `uses` times reads
 * Node's table `uses` times, at the leaf's one reader, where unfolded at every reference each level multiplied the
 * statement, a chain `depth` deep of `uses` reads per
 * level reading Node `uses` to the `depth` times (edullm IMPL-TESTS on 5447: the assembled-catalog part's largest
 * statement 1.2 MB, 3798 SELECTs and 1186 reads of qti.node, whose planning at a session's first COMMIT took 12.4 GB).
 * A definition read once, and a scan of one relation, is read where it stands, by the keys the reads before it bound.
 *
 * Oracle: a specification, read off the chain: its leaf reads Node once, and no other definition reads it.
 *
 * Features: a definition read once, twice and three times; a chain three deep.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { chainGen, judged, type Reached } from "#test/unit/physical/judge-size.fixtures.ts"

/** A whole rule's statement over a chain of definitions reads Node's table at its leaf's reader's uses alone, however deep the chain. */
export const aWholeRulesStatementOverAChainOfDefinitionsReadsTheLeafsRelationOnceHoweverTheChainMultipliesIt =
	property.exhaust(finite(chainGen), {
		needs: {},
		situations: [
			"a definition read once",
			"a definition read twice",
			"a definition read three times",
			"a chain three deep"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (chain) => Effect.sync(() => judged(chain, c.note)),
		oracle: {
			kind: "specification",
			name: "the chain: its leaf reads Node once, at each of its one reader's uses, and no other definition reads it"
		},
		box: "every chain of one to three queries over Node, each reading the one below one to three times, under a whole rule's check",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tif (!isNonEmpty(joined)) {\n\t\t\treturn shared",
				replacement: "\t\tif (isNonEmpty(joined) || !isNonEmpty(joined)) {\n\t\t\treturn shared",
				why: "Navigation keeps no import whole, as before: each read of a definition inlines it, so a chain two deep of two reads per level reads Node four times and three deep eight; the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst known = this.#by.get(identity.value)",
				replacement: "\t\tconst known = undefined",
				why: "Every read of an import a navigation keeps whole is an object of its own, so the checker, which keys an import by its query's place (check/session.ts), builds a node at every read, and a chain two deep of two reads per level reads Node four times; the property fails."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\t\t\tconst region = cost === "scan" ? undefined : regionOf(node, references)',
				replacement: "\t\t\tconst region = undefined",
				why: "A shared node correlated to its region is inlined at each read (rule 3, as before), so the import navigation keeps whole is spelled at every read of it, each level's definition again inside the one above, and a chain three deep reads Node four times or more; the property fails."
			}
		]
	})
