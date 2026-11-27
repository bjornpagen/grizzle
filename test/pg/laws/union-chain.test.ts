/**
 * A check over a chain of unions is judged on PostgreSQL 19 as its violation query reads it. Top is a chain one to four
 * deep of unions of two rules over Node, each rule reading the level below once or twice, the first at kind 0 and the
 * second at every kind but 0, under a check that every row's kind is at most 100 (test/unit/physical/judge-size.fixtures.ts
 * unionSchemaOf). Node is keyed by its document first, so the check is judged whole over the documents a transaction
 * wrote. Each level is one node per unit at each set of values it is read at, bound to the values its importer bound
 * (check/checker.ts #bindValue), which every rule of the level above reads: a node correlated to values the unit's own
 * rows bind, which no region's correlated values carry, held as a MATERIALIZED CTE in the SELECT of the outermost
 * region every read lies in that sees those values (lower/optimize/cte-policy holdingRegion), where it was inlined at
 * every read.
 *
 * Each case writes a drawn state of two documents in two parts, in one transaction rolled back after: the first part,
 * then the judge (SET CONSTRAINTS ALL IMMEDIATE); where it accepts, the second part, then the judge again, over the
 * documents the second part wrote.
 *
 * Oracle: the check's violation query lowered by the oracle baseline (deploy/snapshot/violation.ts baselineRuleChecks)
 * over the state: the judge refuses exactly when it finds a row, under the check's name and an integrity SQLSTATE, and
 * the check over every row a migration runs finds a row exactly then.
 *
 * Features: chains one to four deep, each rule reading the level below once or twice; refused, by a second part's
 * units among them, and accepted.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type ChainFeature,
	chainCaseGen,
	chainFeatures,
	chainTemplates,
	runChain
} from "#test/pg/laws/union-chain.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A check over a chain of unions is judged over the units a transaction wrote exactly as its violation query finds the
 * state, each level held once per unit in the region every read of it lies in.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aCheckOverAChainOfUnionsIsJudgedOverTheUnitsATransactionWroteExactlyAsItsViolationQueryFindsTheState =
	property.explore(chainCaseGen, {
		needs: Substrate.oneOf(chainTemplates, Substrate.rolledBack),
		situations: chainFeatures satisfies ReadonlyArray<Reached<ChainFeature>>,
		check: (installed, c) => (drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* installed[drawn.chain]
				yield* runChain(value, connection, drawn, c)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the check's violation query lowered by the oracle baseline: the judge refuses exactly when it finds a row"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					'\t\tconst columns = [...bound].filter((c) => table.holds.get(c) !== "none").toSorted(compareStrings)\n',
				replacement:
					'\t\tconst columns = [...bound].filter((c) => table.holds.get(c) !== "none").toSorted(compareStrings).slice(1)\n',
				why: "A judge's request leaves out a column its seek binds: the check over a document's top nodes, read at the document and kind 0, asks no index holding the document, and the installation refuses the judge as a missed index, as the extraction that never asked the kind its lowering lands on the step did."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\t\tif (!sees(at, region, read)) {\n\t\t\t\tbreak\n\t\t\t}\n",
				replacement: "",
				why: "A shared node is held in the outermost region on its chain of dominators whatever values it reads, past the region whose rows bind them, where its CTE reads a column no FROM item of that SELECT's scope holds: the judge of a chain two deep or more fails to run."
			}
		]
	})
