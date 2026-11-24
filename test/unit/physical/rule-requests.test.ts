/**
 * A rule over a query asks the index of each read it makes (physical/ddl/rules.ts requestsOf): a probe's index requests
 * are the access paths of the chain that runs, each step a lookup of one relation by the columns the steps before it
 * bound (analysis/theory/navigate.ts), which a step binds as `column = channel`, the channel correlated with the row
 * before it, and the access-path extraction reads as a fixed equality (physical/access/extract.ts regionFacts); and a
 * whole rule's requests lead with its unit's key (ir/law.ts LawIndexRequest), so no index another column leads serves
 * a read that never leaves the unit, but a read whose path binds no field of its unit, a lookup by a declared key the
 * unit does not lead, which asks for no index: the key's own serves it, as the scan a whole rule's check over every row
 * starts from needs none.
 *
 * Each case is a containment of D in S, D the x of each T row and U row that agree on g, on h or on both, U's w held
 * to a literal or not, over T and U keyed by `package` and a column of their own and S by its pack: immutable in no
 * declared unit, D's rows of one package, so the rule is unit-local and judged whole and D live for its borrow; or
 * mutable, each in a unit of its own, D's rows of any two packages, so D is live, its definition unit-local in no unit
 * (analysis/derived/storage.ts), and the rule, reading several units, is probed; and, beside it or not, a containment of E, U's g of every row, in Q, keyed by g alone, whose probe of Q's
 * deletes reads U by g across every unit; with U declaring a key over g alone or not, which a read of U that binds g
 * looks it up by. The schema compiles to its installation.
 *
 * Oracle: specification, read from the installation's planned indexes: each read of a probe's chain, U and T by the
 * join's columns, and of a whole rule's, by those and `package` (U also by w where D holds it, and by its key over g
 * alone where it declares one and the join binds g), and a whole rule's first read of U at its unit and w, has an index of exactly
 * those columns; and every index a whole rule creates for its requests leads with `package`.
 *
 * Features: a whole rule's read by a join, a probe's, a whole rule's read beside a read of its relation across units,
 * whose index without the unit's block first would merge into one led by g, and a whole rule's read by a key its unit
 * does not lead.
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
			"a whole rule's read beside a read across units",
			"a whole rule's read by a key its unit does not lead"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (shape) => Effect.sync(() => judged(shape, c.note)),
		oracle: {
			kind: "specification",
			name: "the planned indexes: an index of exactly the columns each join reads U and T by, and every index a whole rule asks for led by package"
		},
		box: "every containment of D in S over T and U keyed by package, immutable or mutable, D joining them by g, h or both and holding U's w to a literal or not, beside a containment of U's g in Q or not, U keyed by g alone or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\t\t? { blocks: isNonEmpty(rest) ? [bound, rest] : [bound], reads }\n\t\t: undefined",
				replacement:
					'\t\t? { blocks: isNonEmpty(rest) ? [bound, rest] : [bound], reads }\n\t\t: (() => { throw new Error("a read binds no field of its unit") })()',
				why: "A whole rule's read whose path binds no field of its unit, U's lookup by its key over g, is refused as a defect rather than left to the key's own index: the installation of a whole rule beside U's key over g dies."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"\t\t? { blocks: isNonEmpty(rest) ? [bound, rest] : [bound], reads }\n\t\t: undefined",
				replacement:
					"\t\t? { blocks: isNonEmpty(rest) ? [bound, rest] : [bound], reads }\n\t\t: { blocks: [keys], reads }",
				why: "A whole rule's check over every row asks an index of the scan it starts from, led by the literal it reads U at, w, not by the unit: an index every write of U pays for a read one migration makes."
			},
			{
				file: "packages/engine/src/physical/access/extract.ts",
				original: "\t\treturn k1 === undefined || k2 === undefined ? [] : [[k1, k2]]",
				replacement: "\t\treturn []",
				why: "A navigation step's `column = channel` is no fixed equality to the extraction, so a probe's lookup of U by the join asks no index, and PostgreSQL reads every row of U's package at each row of T's delta; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t? { blocks: isNonEmpty(rest) ? [bound, rest] : [bound], reads }",
				replacement: "\t\t? { blocks: [keys], reads }",
				why: "A whole rule's request is one block, so the engine merges it into the index Q's probes ask of U by g, led by g: the whole rule's read is served by an index whose scan by g reads every unit's rows of that value, which PostgreSQL may AND into another read, as qti.node's path-led indexes were for the manifest rules; the property fails."
			}
		]
	})
