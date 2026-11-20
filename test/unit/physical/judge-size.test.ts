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
import {
	chainGen,
	judged,
	judgedUnions,
	type Reached,
	type UnionReached,
	unionsGen
} from "#test/unit/physical/judge-size.fixtures.ts"

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
				original: "\t\tif (!isNonEmpty(joined)) {\n\t\t\treturn { kept",
				replacement: "\t\tif (isNonEmpty(joined) || !isNonEmpty(joined)) {\n\t\t\treturn { kept",
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

/**
 * A whole rule's statement over reads of a union reads each of the union's rules once, however many reads of it the
 * rule joins: navigation reads the union whole (analysis/theory/navigate.ts sharedImports `unions`), one node per unit
 * every read of which joins its rows, its rules navigated inside it, where distributed into the rule's conjunctions
 * (`conjunctions`) it was one conjunction for each choice of a rule at every read, the union's rules to the power of
 * its reads, each reading Node at every read (edullm IMPL-TESTS on 5447: the prefixed map response rules, 533 KB and
 * 2158 SELECTs each).
 */
export const aWholeRulesStatementOverReadsOfAUnionReadsEachOfItsRulesOnceHoweverManyReadsItJoins =
	property.exhaust(finite(unionsGen), {
		needs: {},
		situations: [
			"a union read once",
			"a union read twice",
			"a union read three times",
			"a union of three rules",
			"a chain of unions four deep",
			"a chain of unions each rule reading the level below twice"
		] satisfies ReadonlyArray<ReachedOf<UnionReached>>,
		check: (_, c: Case<UnionReached>) => (unions) =>
			Effect.sync(() => judgedUnions(unions, c.note)),
		oracle: {
			kind: "specification",
			name: "the union: its rules read Node once each, and no read of the union reads it again"
		},
		box: "one to three reads of a union of two or three rules over Node, each the nodes of one kind, or a chain one to four deep of unions of two rules each reading the level below once, or one or two deep each reading it twice, under a whole rule's check",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\t\t\tunions.add(key)",
				replacement: "\t\t\t\t\tunions.size",
				why: "Navigation keeps no union whole, as before: the rule over two reads of a union of two rules is distributed into its four conjunctions, each reading Node twice; the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					'\t\t\tcase "perUnit":\n\t\t\t\treturn navigate(rule, loc, columns, sharing, interned)',
				replacement:
					'\t\t\tcase "perUnit":\n\t\t\t\treturn flatMapNonEmpty(split, (conjunction) => navigatedRule(conjunction, loc, columns, sharing, interned))',
				why: "A whole rule's statement is distributed into its conjunctions before navigation reads it, as a write member's is, so every union it reads is read once in each conjunction; the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\tconst known = this.#by.get(identity.value)",
				replacement: "\t\tconst known = undefined",
				why: "Every read of a union a navigation keeps whole is an object of its own, so the checker, which keys an import by its query's place (check/session.ts), builds a node at every read, and the rule over two reads of a union of two rules reads Node four times; the property fails."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					'\t\t\treturn outer.kind === "column" && this.#reexposed.has(reexposedKey(outer.node, outer.name))',
				replacement: '\t\t\treturn outer.kind === "column" && this.#reexposed.size < 0',
				why: "Each rule of a union reads the level below at the column its own region re-exposes the unit's channels at, as before, so each rule's read is a node of its own, and a chain of unions three deep reads Node eight times, four deep sixteen; the property fails."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\t\t: first !== undefined && others.length === 0",
				replacement: "\t\t\t: first === undefined && others.length === 0",
				why: "A node the rules of a union read is placed in no region, one read by occurrences of several regions inlined at each (rule 3, as before), so a chain of unions spells the level below in each rule above it, and four deep reads Node sixteen times; the property fails."
			}
		]
	})
