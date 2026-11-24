/**
 * A whole rule's statement is the size of the definitions it reads, not of their unfolding (analysis/theory/navigate.ts,
 * lower/optimize/cte-policy): a join of definitions its rule reads more than once in its unfolding is computed once per
 * unit and every read of it joins its rows, so a chain of queries each reading the one below it `uses` times reads
 * Node's table `uses` times, at the leaf's one reader, where unfolded at every reference each level multiplied the
 * statement, a chain `depth` deep of `uses` reads per
 * level reading Node `uses` to the `depth` times (edullm IMPL-TESTS on 5447: the assembled-catalog part's largest
 * statement 1.2 MB, 3798 SELECTs and 1186 reads of qti.node, whose planning at a session's first COMMIT took 12.4 GB).
 * A definition read once, and a scan of one relation, is read where it stands, by the keys the reads before it bound.
 * The rule's check over every row, the migration's full violation query, is held to the same size over both boxes.
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
	checkedOverEveryRow,
	type ContainmentReached,
	containmentGen,
	type EveryRowReached,
	type FoldedReached,
	foldedGen,
	type NestedReached,
	nestedGen,
	everyRowGen,
	judged,
	judgedContainment,
	judgedFolded,
	judgedNested,
	judgedUnions,
	type Reached,
	readsDeltasThroughReaders,
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
				original: "\t\tif (!isNonEmpty(joined)) {\n\t\t\treturn new Set(",
				replacement: "\t\tif (isNonEmpty(joined) || !isNonEmpty(joined)) {\n\t\t\treturn new Set(",
				why: "Navigation keeps no import whole, as before: each read of a definition inlines it, so a chain two deep of two reads per level reads Node four times and three deep eight; the property fails."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\t\t\tconst held = cost === "scan" ? undefined : holder(node, references)',
				replacement: "\t\t\tconst held = undefined",
				why: "A shared node correlated to its region is inlined at each read (rule 3, as before), so the import navigation keeps whole is spelled at every read of it, each level's definition again inside the one above, and a chain three deep reads Node four times or more; the property fails."
			}
		]
	})

/**
 * A whole rule's statement over reads of a union reads each of the union's rules once, however many reads of it the
 * rule joins: navigation reads the union whole (analysis/theory/navigate.ts sharedImports `unions`), one node per unit
 * every read of which joins its rows, its rules navigated inside it, where distributed into the rule's conjunctions
 * it was one conjunction for each choice of a rule at every read, the union's rules to the power of
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
		box: "one to three reads of a union of two or three rules over Node, each the nodes of one kind, or a chain one to four deep of unions of two rules each reading the level below once or twice, under a whole rule's check",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\t\t\tunions.add(key)",
				replacement: "\t\t\t\t\tunions.size",
				why: "Navigation keeps no union whole and distributes none into the rule's conjunctions, so it reads each union's rules inline, which it refuses (\"a navigation: an imported query of one rule\"): every rule over reads of a union fails to compile; the property fails."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\t\treturn resolved\n",
				replacement:
					'\t\t\treturn resolved.kind === "column" ? this.#slotValue(this.#paramSlot(term.cell, loc), node) : resolved\n',
				why: "Each rule of a union reads the level below at the column its own region re-exposes the unit's channels at, as before, so each rule's read is a node of its own, and a chain of unions three deep reads Node eight times, four deep sixteen; the property fails."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\t\theld = region\n",
				replacement: "\t\t\tbreak\n",
				why: "A node the rules of a union read is placed in no region, inlined at each read (rule 3, as before), so a chain of unions spells the level below in each rule above it, and four deep reads Node sixteen times; the property fails."
			},
			{
				file: "packages/text/src/base/graph.ts",
				original: "\t\tconst at = first === undefined ? undefined : rest.reduce(meet, first)\n",
				replacement: "\t\tconst at = rest.length === 0 ? first : undefined\n",
				why: "A node several readers read is dominated by none of them, as though its readers met only above every root, so the node the rules of a union read is held in no region and inlined at each read, and a chain of unions three deep reads Node eight times; the property fails."
			}
		]
	})

/**
 * A whole rule's containment reads each definition its sides share once per set of values it reads it at, however many
 * rules of the met side, levels above the leaf or negations inside it read it: the definitions both sides read at the
 * unit's channels one node, computed once in the unit's region, whose negation of the met side reads it there, and those
 * the met side's rules read at the fact's terms one node every rule reads. Before, every read inside the negation was a
 * node of its own region, correlated to a column that region's occurrence binds, which no region holds, so spelled at
 * every read, a level's restrictions renamed at every depth (the reset line's targeted_branch_rule_in_forward_branch_rule
 * on edullm's pantry: 465 KB, 2,097 SELECTs and 128 reads of qti.node, a definition at the package spelled 3, 4, 7 and
 * 18 times, planned in 12.1 s at a fresh backend's first COMMIT, 58% of the judge's first-call planning).
 *
 * Oracle: a specification, read off the case: Node read three times for each set of values the leaf is read at, and once
 * for each further rule of the met side.
 *
 * Features: a met side of three rules; a negation inside the met side; a union two levels above the leaf.
 */
export const aWholeRulesContainmentReadsEachDefinitionItsSidesShareOncePerSetOfValues =
	property.exhaust(finite(containmentGen), {
		needs: {},
		situations: [
			"a met side of three rules",
			"a negation inside the met side",
			"a union two levels above the leaf"
		] satisfies ReadonlyArray<ReachedOf<ContainmentReached>>,
		check: (_, c: Case<ContainmentReached>) => (containment) =>
			Effect.sync(() => judgedContainment(containment, c.note)),
		oracle: {
			kind: "specification",
			name: "the leaf's restrictions: Node read three times at each set of values the statement reads the leaf at, once more for each further rule of the met side"
		},
		box: "every containment From ⊆ To over a union zero to two levels above a union over Node, To one to three rules each reading it at the fact's terms, with or without a rule that negates a definition over it",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/index.ts",
				original: "\t\t\tconst region = filteredRegion(node)\n",
				replacement: '\t\t\tconst region = node.kind === "MatchRegion" ? node : undefined\n',
				why: "A region's CTEs stand in its own SELECT alone, as before, so the negation of To, a SELECT over the region, reads none of them and spells each definition again at every read, each level's inside the one above, and the reads of Node grow with the depth; the property fails."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\t\treturn resolved\n",
				replacement:
					'\t\t\treturn resolved.kind === "column" ? this.#slotValue(this.#paramSlot(term.cell, loc), node) : resolved\n',
				why: "An import at the unit's channels is bound at its reader's region's column, as before, so each rule inside the negation reads a node of its own region, spelled at its read, and a containment with the negation reads Node 15 times, past its 9; the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: `const received = (name: string): string => (minted(name) ? \`in.\${name}\` : name)`,
				replacement: `const received = (name: string): string => \`in.\${name}\``,
				why: "An import receives the unit's channel under a name of each depth, as before, so the leaf restricted to the unit inside a level is another query than the leaf restricted to it at the top, spelled again, and a containment with the negation reads Node 12 times, past its 9; the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\t\tpinnedBy(flatFixed(read.flat, rule.loc)),\n",
				replacement: "\t\t\t\t(e: InferredExpr): InferredExpr => e,\n",
				why: "A filter passes a term its rule fixes to the unit's channel through a channel of its own, as before, so a negation inside To reads the leaf at that channel, another set of values than the unit's, spelled again, and a containment with the negation a level above the leaf reads Node 12 times, past its 9; the property fails."
			}
		]
	})

/**
 * A rule's check over every row, the full violation query the migration that adds the rule runs once (deploy/snapshot
 * violation.ts lawChecks, physical/ddl/rules.ts everyRowCheck), is the size of the definitions it reads, as the judge's
 * statements are: every rule statement reads each import its unfolding multiplies whole (analysis/theory/navigate.ts
 * ImportSharing `perStatement`), and the check, whose region holds every row, computes one no parameter restricts once,
 * one node every read of which joins its rows (lower/optimize/cte-policy rules 5 and 6). Navigated as a unit's statement
 * once was, before 142269847, it was inlined at every read and every union it reads distributed into the rule's
 * conjunctions, the product of the unions' widths at every depth (metis's rehearsal, its reset: the full
 * violation query of targeted_branch_rule_in_forward_branch_rule 1.15 MB, 3,571 SELECTs, 157 UNIONs and 1,281 table
 * reads, planned 20 s over an empty installation, the reset's validate file 26 s of which 23 s its full checks).
 *
 * Oracle: a specification, read off the case: Node read at most as often as the definitions read it, each spelled once.
 *
 * Features: a definition read three times; a chain three deep; a union read three times; a union of three rules; a chain
 * of unions four deep; a chain of unions each rule reading the level below twice.
 */
export const aRulesCheckOverEveryRowReadsEachDefinitionOnceHoweverItsRuleMultipliesIt =
	property.exhaust(finite(everyRowGen), {
		needs: {},
		situations: [
			"a definition read three times",
			"a chain three deep",
			"a union read three times",
			"a union of three rules",
			"a chain of unions four deep",
			"a chain of unions each rule reading the level below twice"
		] satisfies ReadonlyArray<ReachedOf<EveryRowReached>>,
		check: (_, c: Case<EveryRowReached>) => (drawn) =>
			Effect.sync(() => checkedOverEveryRow(drawn, c.note)),
		oracle: {
			kind: "specification",
			name: "the definitions: the check over every row reads Node as often as they read it, each spelled once"
		},
		box: "the chain box's and the union box's cases, every one, under the whole rule's check over every row",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\t\t\tdecision = decide("materialized", "sharedExpensive", statementScope)',
				replacement: '\t\t\tdecision = decide("inline", "sharedExpensive", statementScope)',
				why: "A union the check reads more than once, no parameter restricting it, is inlined at each read rather than computed once (rule 5), every level's union again inside the one above, so three reads of a union of three rules read Node 9 times and a chain of unions four deep, each rule reading the level below twice, 256; the property fails."
			}
		]
	})

/**
 * A whole rule's statements read every delta through its reader, never the session's table: the judge truncates a delta
 * once it has read it, and a plan that read the table was made again at every COMMIT after one, where one that reads
 * the reader stands.
 */
export const aWholeRulesStatementsReadEveryDeltaThroughItsReader = property.exhaust(
	finite(chainGen),
	{
		needs: {},
		situations: [
			"a definition read once",
			"a definition read twice",
			"a definition read three times",
			"a chain three deep"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (chain) =>
			Effect.sync(() => readsDeltasThroughReaders(chain, c.note)),
		oracle: {
			kind: "specification",
			name: "the judge's statements: no FROM source a table of pg_temp, and some a delta's reader"
		},
		box: "every chain of one to three queries over Node, each reading the one below one to three times, under a whole rule's check",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original:
					'\t\t\tkind: "function",\n\t\t\tcall: qualifiedCall(\n\t\t\t\t{ kind: "qualified", schema: reader.schema, name: reader.name, volatility: "VOLATILE" },\n\t\t\t\t[]\n\t\t\t),\n\t\t\talias,',
				replacement:
					'\t\t\tkind: "table",\n\t\t\ttable: sessionTable(read.delta.name),\n\t\t\talias,',
				why: "The judge's statements read the session's delta table, as before, so the TRUNCATE that empties it invalidates every plan that reads it, made again at the next COMMIT."
			}
		]
	}
)

/**
 * A probed rule over levels of definitions, each negating the one below or each a union whose rules match the one
 * below, a containment into them or a check of them, is judged by one statement for each relation and side, each
 * spelling the target once, each level's definition once, and reading what the write moves of each level once, however
 * deep and wide (analysis/theory/query.ts probe, absentsOf, movedOf, DefinedMatch): every statement reads Node at most
 * twice for each rule of the description, levels that negate and levels that match alike. edullm's ledger judged
 * its servable rule, a containment in Servable whose leaves negate definitions that match unions and negate in turn, by
 * 1083 probes of about 800 KB each, the judge's two hours; one statement per block, its rows a path each down the negated
 * arms, still spelled a migration past V8's longest string; and qti's Human within maximum, a check of a definition
 * matching a union beside definitions over Node and Attribute, spelled a statement of 12.75 MB, a row for each choice of
 * one rule at every union it matched.
 */
export const aProbedRuleOverNestedDefinitionsReadsEachDefinitionOnceInOneStatementPerBlock =
	property.exhaust(finite(nestedGen), {
		needs: {},
		situations: [
			"a containment in Servable",
			"a check of Servable",
			"negates the level below",
			"matches the level below",
			"two rules a level",
			"three rules a level",
			"four levels deep"
		] satisfies ReadonlyArray<ReachedOf<NestedReached>>,
		check: (_, c: Case<NestedReached>) => (nested) =>
			Effect.sync(() => judgedNested(nested, c.note)),
		oracle: {
			kind: "specification",
			name: "the description: one statement per relation and side, Node read at most twice for each rule of the description in each, and, under negating levels, the target's Node once for the root and once for each rule of each level"
		},
		box: "every containment of Session's doc in Servable, and every check of Servable's doc, Servable the docs whose root no level holds, one to four levels, each one rule matching a union of two or three rules over Node and negating the level below, or each a union of two or three rules each matching Node and the level below",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: '\t\tconst k = r.fields.join(",")\n',
				replacement: '\t\tconst k = r.fields.join(",") + String(groups.size)\n',
				why: "Each rule of what a write moves of a definition is a query of its own, as each path down the negated arms was a row of its own before: a level reads each rule of the level below apart, so the rows of Node's blocks grow as w to the depth, past twice each rule of the description; the property fails."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\t\t: inlined.arms.length > 1\n",
				replacement: "\t\t\t\t\t: inlined.arms.length > 1 && inlined.arms.length < 1\n",
				why: "A definition of several rules a rule matches is distributed into its arms, as before, an arm for each choice of a rule at every union matched: a level whose rules each match the level below is the width to the depth arms, each a row of Node's blocks, past twice each rule of the description; the property fails."
			}
		]
	})

/**
 * A probed rule over a fold of a union reads the union once in each statement over a delta it reads, the fold at the
 * groups the write touched, which are the keys of the union's facts the write moves (analysis/theory/query.ts movedOf
 * over the fold's body, `bothWays`), never the union read again to confirm those facts, which the fold reads at the
 * same keys. metis's beacon judged Suspended in time, a check over its last presences, a fold of a union of seven
 * rules over TestVisit, Presence, TestSuspension and TestEnd, by a statement over Presence's news of 71.8 KB, 31 MB of
 * planner memory, 23 KB of it the union read again at the presences the beacon moved, before the fold read it there.
 */
export const aProbedRuleOverAFoldOfAUnionReadsTheUnionOnceForTheFoldAtTheGroupsAWriteTouched =
	property.exhaust(finite(foldedGen), {
		needs: {},
		situations: [
			"a check of the fold",
			"a check beside a relation keyed apart",
			"a union of two rules",
			"a union of three rules"
		] satisfies ReadonlyArray<ReachedOf<FoldedReached>>,
		check: (_, c: Case<FoldedReached>) => (folded) =>
			Effect.sync(() => judgedFolded(folded, c.note)),
		oracle: {
			kind: "specification",
			name: "the description: each statement over Mark's delta reads Mark once for each rule of the union over it"
		},
		box: "a check of the last sign of each visit, the greatest of a union of a visit's own sign and one or two rules over Mark, read directly or through a derived relation beside a relation keyed apart",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\t\tkeyed(definitionsKeyed(arm, t.region, depth, loc)),\n",
				replacement: "\t\t\t\t\tdefinitionsKeyed(arm, t.region, depth, loc),\n",
				why: "A relaxed candidate of a definition's facts reads the definition again as it stands at the keys it moved, so the fold's touched groups read the union over Mark once more before the fold reads it, twice each rule over Mark in the statement over Mark's news, as metis's beacon did; the property fails."
			}
		]
	})
