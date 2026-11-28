/**
 * A SERIALIZABLE insertion's met row is a read SSI sees: an insertion that meets a stored row as an exact repeat, beside
 * a write another transaction read the absence of, and that transaction's deletion of the met row are a write skew,
 * which SSI refuses with 40001.
 *
 * Held(k, a) is keyed by k, its natural identity, so an insertion arbitrates at k, and its met rows are classified in
 * the insert's own statement under its snapshot at SERIALIZABLE (write/insert/protocol.ts), so SSI sees each met row as
 * read. Mark(k) is a pure set. The role `writer` inserts both, and its workload is `meet`, an insertion of Held and of
 * Mark in one stratum that reads back the Held rows it added and the stored ones it met, Held's from a query over the
 * call's relation parameter `held`. The role `direct` deletes Held, so generate serves `writer` SERIALIZABLE (the case
 * requires it). The stored state is m = Held(k 1, a 0) and o = Held(k 2, a 0).
 *
 * One schedule per case: D, a direct SQL session of `direct`, begins SERIALIZABLE and reads whether Mark holds a key;
 * L, a served writer of `writer`, runs `meet` and commits; D deletes a stored Held row and commits.
 *
 * Box: L's Held request repeats m exactly (k 1, a 0) or states a free key (k 3, a 0); D deletes m or o; D reads Mark at
 * L's key, 5, or at another, 6. Exhausted.
 *
 * Properties, per case:
 * - L commits, reading back as met exactly the stored m where it repeats m, and as added exactly the row it made at
 *   k 3 where it states that key.
 * - Every run is serializable: where L met m, D read the absence of L's Mark row and D deletes m, no serial order
 *   explains both (L before D would show D L's mark; D before L would leave L no m to meet), so D fails with 40001.
 *   Anywhere else D commits, or fails with 40001 where SSI judges coarser than the rows (a relation-level SIRead lock
 *   of a sequential scan), and the table ends as L, then D, leaves it.
 *
 * Oracle: specification, the two serial orders of L and D over the stated rows.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import {
	byKey,
	Held,
	heldText,
	type HeldText,
	isSerialization,
	Mark,
	markKey,
	otherMark,
	skew,
	type SkewFeature,
	skewGen,
	skewRig
} from "#test/schedules/write/met-skew.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { rigIn } from "#test/support/schedules/rig.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A SERIALIZABLE insertion's met row is a read SSI sees: a write skew through it never commits.
 */
export const aSERIALIZABLEInsertionsMetRowIsAReadSSISeesAWriteSkewThroughItNeverCommits =
	property.exhaust(finite(skewGen), {
		needs: { rigged: Substrate.fresh(skewRig) },
		situations: [
			"the skew through a met row refused with 40001",
			"a new row beside D's deletion, D committed"
		] satisfies ReadonlyArray<Reached<SkewFeature>>,
		check:
			({ rigged }, k: Case<SkewFeature>) =>
			(c) =>
				Effect.flatMap(rigged, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = yield* Substrate
							const rig = yield* rigIn(taken, skew)
							const names = namesOf(rig.installed)
							const held = names.table(Held)
							const mark = names.table(Mark)
							const column = (field: "k" | "a") => names.column(Held, field)
							const markColumn = names.column(Mark, "k")
							const l = yield* rig.servedWriter(
								"l",
								(context) =>
									openServed(rig.served.roles.writer, {}).pipe(Effect.provideContext(context)),
								(db) =>
									writeAnswerOf(
										db.workload.meet.once({ params: { held: [] }, facts: { insert: { Mark: [] } } })
									)
							)
							assert.equal(
								l.ctx.isolation,
								"serializable",
								"a role beside a deleter of Held runs SERIALIZABLE"
							)
							const { d } = yield* openActors(s, { d: { kind: "raw", as: rig.direct } })
							const heldState = Effect.map(
								s.admin.queryValues(
									`SELECT ${column("k")}::text, ${column("a")}::text FROM ${held} ORDER BY 1`,
									[]
								),
								(rows): ReadonlyArray<HeldText> =>
									Arr.map(rows, ([k, a]) => ({ k: String(k), a: String(a) }))
							)
							const markState = Effect.map(
								s.admin.queryValues(`SELECT ${markColumn}::text FROM ${mark} ORDER BY 1`, []),
								(rows) => Arr.map(rows, ([k]) => String(k))
							)

							yield* rig.replace([
								`INSERT INTO ${held} (${column("k")}, ${column("a")}) VALUES (1, 0), (2, 0)`
							])
							const before = yield* heldState
							const at = (key: string): HeldText =>
								defined(
									Option.getOrUndefined(Arr.findFirst(before, (r) => r.k === key)),
									`the stored row at k ${key}`
								)
							const m = at("1")
							const o = at("2")
							const target = c.deletesMet ? m : o
							yield* d.perform({ _tag: "Begin" })
							const read = yield* d.perform({
								_tag: "Sql",
								sql: `SELECT 1 FROM ${mark} WHERE ${markColumn} = ${c.readsMark ? markKey : otherMark}`
							})
							assert.equal(read._tag, "Ok", "D reads Mark")
							const ran = yield* Effect.result(
								writeAnswerOf(
									l.db.workload.meet.once({
										params: { held: [{ k: c.repeats ? 1 : 3, a: 0 }] },
										facts: { insert: { Mark: [{ k: markKey }] } }
									})
								)
							)
							const deleted = yield* d.perform({
								_tag: "Sql",
								sql: `DELETE FROM ${held} WHERE ${column("k")} = ${target.k}`
							})
							const ended = deleted._tag === "Ok" ? yield* d.perform({ _tag: "Commit" }) : deleted
							if (ended._tag !== "Ok" && ended._tag !== "RolledBack") {
								yield* d.perform({ _tag: "Rollback" })
							}
							const after = yield* heldState
							const marks = yield* markState
							assert.ok(Result.isSuccess(ran), `L commits: ${Formatter.format(ran)}`)
							const outcome = ran.success
							assert.ok(
								outcome._tag === "accepted" || outcome._tag === "unchanged",
								`L inserts its mark: ${Formatter.format(outcome)}`
							)
							const made = Arr.filter(after, (r) => r.k === "3")
							assert.deepEqual(
								byKey(Arr.map(outcome.reads.met, heldText)),
								c.repeats ? [m] : [],
								"L reads back as met exactly the stored m it repeats"
							)
							assert.deepEqual(
								byKey(Arr.map(outcome.reads.added, heldText)),
								c.repeats ? [] : made,
								"L reads back as added exactly the row it made"
							)
							assert.deepEqual(marks, [String(markKey)], "L's mark is stored")
							if (c.repeats && c.deletesMet && c.readsMark) {
								assert.ok(
									isSerialization(ended),
									`D, whose deletion of the met m and read of the absence of L's mark no serial order explains beside L, fails with 40001: ${Formatter.format(ended)}`
								)
								k.note("the skew through a met row refused with 40001")
								return
							}
							if (ended._tag !== "Ok") {
								assert.ok(
									isSerialization(ended),
									`D fails only by a serialization failure: ${Formatter.format(ended)}`
								)
								k.note("a 40001 no skew forces")
								return
							}
							assert.deepEqual(
								after,
								byKey(Arr.filter([...before, ...made], (r) => r.k !== target.k)),
								"the table ends as L, then D, leave it"
							)
							k.note(
								!c.repeats
									? "a new row beside D's deletion, D committed"
									: c.deletesMet
										? "a met row D deletes, beside no read of L's mark, D committed"
										: "a met row D does not delete, D committed"
							)
						}),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "the two serial orders of L and D over the stated rows"
		},
		box: "L's Held request a repeat of m or a free key; D deleting m or o; D reading Mark at L's key or another",
		kept: [],
		kills: []
	})
