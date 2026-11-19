/**
 * Where a ChangeSet's read-back runs (write/schedule/plan.ts placeReadBacks): a read-back over a delta a statement makes
 * rides the one statement that makes every side it reads whole, after every write of the state it reads; one that reads
 * no delta a statement makes runs after the writes; any other is refused as ReadBackCrossesStatements, naming one of its
 * crossings. No artifact carries a delta in a temporary table: its one carrier is a member slot's two statements read
 * (write/program/slot-carriers.ts).
 *
 * The box, constructed: over immutable relations M, A and Z of an id and a payload, a first stratum that inserts, deletes
 * or puts M's facts, with or without the opposite action of M beside it (a delete beside an insert or a put, an insert
 * beside a delete), and with or without a second stratum inserting M's facts again from a query over a relation
 * parameter; another relation W, A or Z, written by an insert in the first stratum, in the second, or not at all; and
 * one read-back of one rule joining by id M's added facts, its removed facts, or both, with W's added facts, W's
 * state, or neither. Every member but the second stratum's is an array a call gives, so no member is carried.
 * Exhausted.
 *
 * Oracle: the rule as a model over the statements the construction implies. M's first-stratum action is one statement,
 * an insert's or a delete's, or a put's two, its displacing deletion making removed facts and its insert half added
 * ones; an action beside it is one more; a second stratum's insert is one more. A stratum of one-statement writes of
 * two relations is one statement. A side is made whole by a statement exactly where that statement is its only maker
 * and no maker of the opposite side is of another stratum: no fact is both added and removed by the writes of one
 * stratum (README, "A row one stratum both adds and deletes stays"); a read-back rides where every side it names, of a
 * side some statement makes, is made whole by one statement and W, which the read-back reads as state, is written
 * before it: W written at that statement (one statement of both writes) or in a later stratum is state after it, and W
 * written beside M in a stratum of several statements is ordered first. The model's crossings are every side not made
 * whole, every two sides made whole by two statements, and state after; a refusal names one of them, and is made
 * exactly where there is one. A read-back naming no side any statement makes runs after the writes.
 *
 * Features: riding an insert, a delete, a put's insert half, a put's displacing deletion and one statement of two
 * writes; riding beside the opposite action of M in its stratum; riding after W's state written beside M, by name
 * before M and after it;
 * running after the writes; and each crossing refused.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { succeeded } from "#test/support/assert.ts"
import { slotCarriers } from "#test/support/slot-carriers.ts"
import {
	compiledSketch,
	crossingNotes,
	type Feature,
	holds,
	ridden,
	ridingNotes,
	sketchGen,
	subject,
	verdictOf
} from "#test/unit/write/readback-placement.fixtures.ts"

/** A ChangeSet's read-back rides the one statement that makes its delta after the state it reads, runs after the writes over no delta, and is refused otherwise. */
export const aChangeSetsReadBackRidesTheOneStatementThatMakesItsDeltaAfterTheStateItReadsRunsAfterTheWritesOverNoDeltaAndIsRefusedOtherwise =
	property.exhaust(finite(sketchGen), {
		needs: {},
		situations: [
			"rides an insert",
			"rides a delete",
			"rides a put's insert half",
			"rides a put's displacing deletion",
			"rides one statement of two writes",
			"rides beside the opposite action of M in its stratum",
			"rides after state written beside it, named before it",
			"rides after state written beside it, named after it",
			"runs after the writes",
			"refused: a side two statements make",
			"refused: two sides apart",
			"refused: state after"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (sketch) =>
			Effect.sync(() => {
				const program = compiledSketch(sketch, subject)
				const verdict = verdictOf(sketch)
				if (verdict.kind === "refused") {
					if (program.ok) {
						return assert.fail("refused, as the model holds a crossing")
					}
					const reason = program.error.reason
					if (reason._tag !== "ReadBackCrossesStatements") {
						return assert.fail(`refused as ${reason._tag}, not crossing statements`)
					}
					assert.equal(reason.read, "r")
					assert.ok(
						holds(verdict.crossings, reason.crossing),
						`the crossing ${Formatter.format(reason.crossing)} is one of ${Formatter.format(verdict.crossings)}`
					)
					c.note(crossingNotes[reason.crossing.kind])
					return
				}
				const artifact = succeeded(program, "the ChangeSet compiles").artifact
				const staged = slotCarriers(artifact)
				assert.deepEqual(
					Arr.filter(
						artifact.statements,
						(st) => st.step.kind === "carrier" && !staged.has(st.step.carrier)
					),
					[],
					"no carrier but a staged member slot's"
				)
				const carried = defined(
					Option.getOrUndefined(Arr.findFirst(artifact.readBacks, (r) => r.name === "r")),
					"the read-back"
				).carried
				if (verdict.kind === "after") {
					assert.equal(carried.kind, "sent", "runs after the writes")
					c.note("runs after the writes")
					return
				}
				if (carried.kind !== "riding") {
					return assert.fail("rides the statement that makes its delta")
				}
				assert.deepEqual(
					ridden(artifact, carried.statement, verdict.relation),
					{ writes: verdict.writes, maker: verdict.maker },
					"the statement it rides"
				)
				c.note(ridingNotes[verdict.maker])
				if (verdict.writes.length > 1) {
					c.note("rides one statement of two writes")
				}
				if (sketch.beside) {
					c.note("rides beside the opposite action of M in its stratum")
				}
				if (sketch.reads === "state" && sketch.written === "first") {
					c.note(
						sketch.other === "A"
							? "rides after state written beside it, named before it"
							: "rides after state written beside it, named after it"
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the placement rule as a model over the statements the construction implies"
		},
		box: "every first-stratum action of M, the opposite action beside it or not, M again in a second stratum or not, W written in either stratum or not, and a read-back of M's added, removed or both sides with W's added facts, its state or neither",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original:
					"\t\t\t\twrite.relation === relation && write.side === side ? [{ position, write }] : []",
				replacement: "\t\t\t\twrite.relation === relation ? [{ position, write }] : []",
				why: "A delta's writers counted by relation, as before, so a put's sides never ride."
			},
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original:
					'\t\treturn netting.length === 0 ? { kind: "at", position: maker.position } : twice',
				replacement: '\t\treturn { kind: "at", position: maker.position }',
				why: "A side's one maker taken whole whatever nets against it."
			},
			{
				file: "packages/engine/src/write/frontend/schedule.ts",
				original:
					"\t\tOrder.mapInput(Order.compareBooleans, (s: Scheduled) => last.has(s.action.relation)),\n",
				replacement: "",
				why: "The canonical order with no key for the delta relations (write/frontend/schedule.ts scheduledOrder)."
			},
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original: "\t\tconst later = withCascades(writes.slice(position).flat(), frontend)",
				replacement: "\t\tconst later = withCascades(writes.slice(position + 1).flat(), frontend)",
				why: "The statement a read-back rides left out of the writes after it."
			},
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original: "\t\tconst later = withCascades(writes.slice(position).flat(), frontend)",
				replacement:
					"\t\tconst riding = sides[position]?.[0]?.stratum\n\t\tconst later = withCascades(\n\t\t\twrites\n\t\t\t\t.slice(position)\n\t\t\t\t.filter((_, i) => (sides[position + i] ?? []).every((w) => w.stratum === riding))\n\t\t\t\t.flat(),\n\t\t\tfrontend\n\t\t)",
				why: "The writes of later strata left out of the writes after the statement a read-back rides."
			},
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original:
					'\t\t\tif (other.position !== at.position) {\n\t\t\t\treturn { kind: "crossing", crossing: { kind: "sidesApart", first, second: side } }\n\t\t\t}\n',
				replacement: "",
				why: "A read-back of two sides placed at the first's statement."
			},
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original: '\tother.kind === "family" ||',
				replacement: '\tother.kind === "family" ||\n\tmaker.stratum === other.stratum ||',
				why: "An addition and a removal of one stratum taken to cancel, so a read-back beside the opposite action of its relation is refused."
			}
		]
	})
