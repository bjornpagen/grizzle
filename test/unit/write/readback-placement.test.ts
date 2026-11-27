/**
 * Where a ChangeSet's read-back runs (write/schedule/plan.ts placeReadBacks): a read-back over a delta a statement makes
 * rides the one statement that makes every side it reads whole, after every write of the state it reads; any other runs
 * after the writes, each side it names that a statement makes carried there out of the one statement making it whole:
 * a carrier filled inside that statement from its RETURNING, which the read-back reads;
 * only a side no one statement makes whole is refused, as ReadBackCrossesStatements naming it. No artifact holds a
 * carrier but those and a member slot's two statements read (write/program/slot-carriers.ts).
 *
 * The box, constructed: over relations M, A and Z of an id and a payload, M mutable inside the unit of its id and A and
 * Z immutable, a first stratum that inserts, deletes or puts M's facts, with or without the opposite action of M beside it (a delete beside an insert or a put, an insert
 * beside a delete), and with or without a second stratum inserting M's facts again from a query over a relation
 * parameter; another relation W, A or Z, written by an insert in the first stratum, in the second, or not at all; and
 * one read-back of one rule joining by id M's added facts, its removed facts, or both, with W's added facts, W's
 * state, or neither. Every member but the second stratum's is an array a call gives, so no member is carried.
 * Exhausted.
 *
 * Oracle: the rule as a model over the statements the construction implies. M's first-stratum action is one statement,
 * an insert's or a delete's, or a put's: its upsert alone where the read-back names M's added side alone, and else two,
 * its displacing deletion making removed facts and its upsert, its insert half, added ones; an action beside it is one
 * more; a second stratum's insert is one more. A stratum of one-statement writes of
 * two relations is one statement. A side is made whole by a statement exactly where that statement is its only maker
 * and no maker of the opposite side is of another stratum: no fact is both added and removed by the writes of one
 * stratum (README, "A row one stratum both adds and deletes stays"). A read-back naming a side no statement makes whole
 * is refused, naming one such side. One whose sides one statement makes whole rides it where W, which it reads as
 * state, is written before it: W written at that statement (one statement of both writes) or in a later stratum is
 * state after it, and W written beside M in a stratum of several statements is ordered first. Any other runs after the
 * writes, and each side it names that a statement makes is carried out of the statement making it whole: one carrier per
 * side, which that statement alone fills, and the read-back reads exactly those carriers.
 *
 * Features: riding an insert, a delete, a put's insert half, a put's displacing deletion and one statement of two
 * writes; riding beside the opposite action of M in its stratum; riding after W's state written beside M, by name
 * before M and after it; running after the writes over no side; carrying past state written in the delta's own
 * statement and in a later stratum, two sides two statements make, and a put's displaced side; and the refused side.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import type { CarrierName } from "#compiler/sql/naming.ts"
import type { WriteArtifact } from "#compiler/write/program/artifact.ts"
import { succeeded } from "#test/support/assert.ts"
import { carrierFills, carrierReads } from "#test/support/carrier-reads.ts"
import { slotCarriers } from "#test/support/slot-carriers.ts"
import {
	compiledSketch,
	type Feature,
	type Making,
	isMaking,
	ridden,
	ridingNotes,
	sameSide,
	sketchGen,
	subject,
	verdictOf
} from "#test/unit/write/readback-placement.fixtures.ts"

/** The position of the one statement filling `carrier`. */
const filledAt = (artifact: WriteArtifact, carrier: CarrierName): number => {
	const fillers = Arr.filter(
		Array.from({ length: artifact.statements.length }, (_, at) => at),
		(at) =>
			carrierFills(defined(artifact.statements[at], "a statement of the artifact").ast).has(carrier)
	)
	assert.equal(fillers.length, 1, "one statement fills the carrier")
	return defined(fillers[0], "the statement filling the carrier")
}

/** A ChangeSet's read-back rides the one statement that makes its delta after the state it reads, runs after the writes over its delta carried out of the statements making it whole otherwise, and is refused only over a side no one statement makes whole. */
export const aChangeSetsReadBackRidesTheStatementMakingItsDeltaOrRunsAfterTheWritesOverItsCarriedDeltaRefusedOnlyOverASideNoOneStatementMakesWhole =
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
			"carried past state its own statement writes",
			"carried past state a later stratum writes",
			"carried, two sides two statements make",
			"carried out of a put's displacing deletion",
			"refused: a side two statements make"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (sketch) =>
			Effect.sync(() => {
				const program = compiledSketch(sketch, subject)
				const verdict = verdictOf(sketch)
				if (verdict.kind === "refused") {
					if (program.ok) {
						return assert.fail("refused, as the model holds a side no one statement makes whole")
					}
					const reason = program.error.reason
					if (reason._tag !== "ReadBackCrossesStatements") {
						return assert.fail(`refused as ${reason._tag}, not crossing statements`)
					}
					assert.equal(reason.read, "r")
					assert.ok(
						Arr.some(verdict.sides, (side) => sameSide(side, reason.delta)),
						"the refused side is one no one statement makes whole"
					)
					c.note("refused: a side two statements make")
					return
				}
				const artifact = succeeded(program, "the ChangeSet compiles").artifact
				const staged = slotCarriers(artifact)
				const carriers = Arr.dedupe(
					Arr.flatMap(artifact.statements, (st) =>
						Arr.filter([...carrierFills(st.ast)], (carrier) => !staged.has(carrier))
					)
				)
				const carried = defined(
					Option.getOrUndefined(Arr.findFirst(artifact.readBacks, (r) => r.name === "r")),
					"the read-back"
				).carried
				const making = (position: number, expected: Making): void =>
					assert.deepEqual(
						ridden(artifact, position, expected.relation),
						{ writes: expected.writes, maker: expected.maker },
						"the statement making the side"
					)
				if (verdict.kind === "after") {
					if (carried.kind !== "sent") {
						return assert.fail("runs after the writes")
					}
					const read = carrierReads(carried.statement.ast)
					assert.deepEqual<ReadonlyArray<string>>(
						Arr.sort(carriers, Order.String),
						Arr.sort([...read], Order.String),
						"its carriers are the ones the read-back reads, and no other but a staged slot's"
					)
					assert.equal(read.size, verdict.carried.length, "one carrier for each side it names")
					for (const carrier of read) {
						const filled = filledAt(artifact, carrier)
						assert.ok(
							Arr.some(verdict.carried, ({ making: m }) => isMaking(artifact, filled, m)),
							"the carrier is filled by the statement making a side the read-back names"
						)
					}
					if (Arr.isReadonlyArrayEmpty(verdict.carried)) {
						c.note("runs after the writes")
						return
					}
					if (sketch.reads === "state" && sketch.written === "first") {
						c.note("carried past state its own statement writes")
					}
					if (sketch.reads === "state" && sketch.written === "second") {
						c.note("carried past state a later stratum writes")
					}
					if (read.size > 1) {
						c.note("carried, two sides two statements make")
					}
					if (Arr.some(verdict.carried, ({ making: m }) => m.maker === "displaced")) {
						c.note("carried out of a put's displacing deletion")
					}
					return
				}
				assert.deepEqual(carriers, [], "no carrier but a staged member slot's")
				if (carried.kind !== "riding") {
					return assert.fail("rides the statement that makes its delta")
				}
				making(carried.statement, verdict)
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
				why: "A delta's writers counted by relation, as before, so a put's sides are never made whole."
			},
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original: "\t\treturn netting.length === 0 ? maker.position : undefined",
				replacement: "\t\treturn maker.position",
				why: "A side's one maker taken whole whatever nets against it."
			},
			{
				file: "packages/engine/src/write/frontend/schedule.ts",
				original:
					"\t\tOrder.mapInput(Order.compareBooleans, (s: Scheduled) => last.has(s.action.relation)),\n",
				replacement: "",
				why: "The canonical order with no key for the delta relations (write/frontend/schedule.ts scheduledOrder): a read-back that could ride is carried."
			},
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original: "\t\tconst later = withCascades(writes.slice(position).flat(), frontend)",
				replacement: "\t\tconst later = withCascades(writes.slice(position + 1).flat(), frontend)",
				why: "The statement a read-back rides left out of the writes after it: a read-back rides the delta's own statement over state that statement writes."
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
				original: "\t\t\trest.every((w) => w.position === first.position) &&\n",
				replacement: "",
				why: "A read-back of two sides two statements make placed at the first's statement."
			},
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original: '\tother.kind === "family" ||',
				replacement: '\tother.kind === "family" ||\n\tmaker.stratum === other.stratum ||',
				why: "An addition and a removal of one stratum taken to cancel, so a read-back beside the opposite action of its relation is refused."
			},
			{
				file: "packages/engine/src/write/program/compile.ts",
				original: "\t\t\tparts: [...placed.map((p) => p.part), ...stashes]\n",
				replacement: "\t\t\tparts: placed.map((p) => p.part)\n",
				why: "A carried side's carrier never filled by the statement making it: the read-back after the writes would read it empty."
			}
		]
	})
