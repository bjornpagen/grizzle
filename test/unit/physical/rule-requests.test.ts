/**
 * A rule over a query asks the index of each read it makes (physical/ddl/rules.ts requestsOf): a probe's index requests
 * are the access paths of the chain that runs, each step a lookup of one relation by the columns the steps before it
 * bound (analysis/theory/navigate.ts), which a step binds as `column = channel`, the channel correlated with the row
 * before it, and the access-path extraction reads as a fixed equality (physical/access/extract.ts regionFacts); and a
 * whole rule's requests lead with its unit's key (ir/law.ts LawIndexRequest), so no index another column leads serves
 * a read that never leaves the unit.
 *
 * Each case is a containment of D in S, D the x of each T row and U row of one package that agree on g, on h or on both,
 * U's w held to a literal or not, over relations each keyed by `package` and a column of its own, immutable, so the rule
 * is unit-local and judged whole, or mutable, so it is probed; and, beside it or not, a containment of E, U's g of
 * every row, in Q, keyed by g alone, whose probe of Q's deletes reads U by g across every unit. The schema compiles to
 * its installation.
 *
 * Oracle: specification, read from the installation's planned indexes: U and T, each read by the join's columns and
 * `package` (U also by w where D holds it), each have an index of exactly those columns; and every index a whole rule
 * asks for leads with `package`.
 *
 * Features: a whole rule's read by a join, a probe's, and a whole rule's read beside a read of its relation across units,
 * whose index without the unit's block first would merge into one led by g.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { judged, type Reached, shapeGen } from "#test/unit/physical/rule-requests.fixtures.ts"

/** A rule over a query asks an index of each read its judge makes, a whole rule's led by its unit's key. */
export const aRuleOverAQueryAsksAnIndexOfEachReadItsJudgeMakesAWholeRulesLedByItsUnitsKey =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: [
			"a whole rule's read by a join",
			"a probe's read by a join",
			"a whole rule's read beside a read across units"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (shape) => Effect.sync(() => judged(shape, c.note)),
		oracle: {
			kind: "specification",
			name: "the planned indexes: an index of exactly the columns each join reads U and T by, and every index a whole rule asks for led by package"
		},
		box: "every containment of D in S over T and U keyed by package, immutable or mutable, D joining them by g, h or both and holding U's w to a literal or not, beside a containment of U's g in Q or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/access/extract.ts",
				original: "\t\treturn k1 === undefined || k2 === undefined ? [] : [[k1, k2]]",
				replacement: "\t\treturn []",
				why: "A navigation step's `column = channel` is no fixed equality to the extraction, so a probe's lookup of U by the join asks no index, and PostgreSQL reads every row of U's package at each row of T's delta; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t\t? { blocks: isNonEmpty(rest) ? [bound, rest] : [bound], reads }",
				replacement: "\t\t\t\t? { blocks: [keys], reads }",
				why: "A whole rule's request is one block, so the engine merges it into the index Q's probes ask of U by g, led by g: the whole rule's read is served by an index whose scan by g reads every unit's rows of that value, which PostgreSQL may AND into another read, as qti.node's path-led indexes were for the manifest rules; the property fails."
			}
		]
	})
