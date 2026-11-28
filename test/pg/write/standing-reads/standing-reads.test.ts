/**
 * metis's assign on PostgreSQL 19 (its statement 6): a write admits a sitting and its origin where the call's user holds
 * no active sitting of the test and none of its subject and grade, each read through a view that tests each of the
 * user's sittings against the standing invalidations, and reads the same rows of the invalidations and reinstatements
 * however many other sittings are invalidated. Each test reads its right side once per left row, at the sitting's key,
 * inside its fence (lower/optimize/cte-policy rightPerLeftRow, lower/shapes/semi-join atRowWalk), where the statement
 * carried the standing invalidations as joins two views read, four MATERIALIZED copies of every invalidation the store
 * holds that the tests read whole: metis's assign read 1,118 pages a call in that statement for the user's one sitting.
 *
 * The box, exhausted: the call's user's earlier sitting of the test active, invalidated, or invalidated and reinstated;
 * each at scale 1 and 16, 32 and 512 other users' invalidated sittings stored beside the user's one. Each case installs
 * the schema twice, once a scale.
 *
 * Property, per case: at each scale the call commits, and Assignment and Origin hold the model's rows
 * (standing-reads.fixtures.ts modelOf); and the rows the write reads in its transaction of the invalidations and the
 * reinstatements (pg_stat_xact_user_tables) at scale 16 are at most those at scale 1, where PostgreSQL may scan a table
 * of a few dozen rows whole that it reads by its index at sixteen times as many. Oracle: specification, the model, and
 * PostgreSQL's own counts.
 *
 * Features: each standing of the user's earlier sitting.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import {
	attemptLabel,
	installWrites,
	observedChange,
	openFull,
	ownerTransaction
} from "#bench/write/support/writes.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	Assignment,
	AssignmentGrade,
	build,
	call,
	changeOf,
	type Earlier,
	earlierGen,
	Invalidation,
	modelOf,
	Origin,
	Reinstatement,
	stateAt
} from "#test/pg/write/standing-reads/standing-reads.fixtures.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The scales: the other users' sittings stored, 32 a scale. */
const scales = [1, 16] as const

/**
 * The relations the tests of the user's sittings read, whose rows read the property counts: read at the sittings' keys,
 * a few; read whole, one for each invalidation stored.
 */
const counted = [Invalidation, Reinstatement] as const

/** The relations the property stores rows of. */
const stored = [Assignment, AssignmentGrade, Invalidation, Reinstatement] as const

/** The rows of `r` as text, its `fields` joined by " | " each, sorted. */
const rowsOf = (
	names: ReturnType<typeof namesOf>,
	r: typeof Assignment | typeof Origin,
	fields: ReadonlyArray<string>
) =>
	Effect.flatMap(Substrate, (s) =>
		Effect.map(
			s.admin.queryValues(
				`SELECT ${Arr.join(
					Arr.map(fields, (f) => `${quoteIdent(names.columnIdent(r, f))}::text`),
					", "
				)} FROM ${names.table(r)}`,
				[]
			),
			(rows) =>
				Arr.sort(
					Arr.map(rows, (row) => Arr.join(Arr.map(row, String), " | ")),
					Order.String
				)
		)
	)

/** One scale's run: the sittings and origins after the call, and the rows the write read of the counted relations. */
const runAt = (earlier: Earlier, scale: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fixture = build("StandingReads")
			/** The installation's login's workload holds the call's write, so it holds every index the write reads
			 * through, SittingEvent's by its child, kind and number among them, as generate plans an application's (a
			 * served compile under its snapshot refuses a read through one it does not hold, UninstalledIndex). */
			const fx = yield* installWrites(fixture.schema, "standingreads", {
				programs: { sit: changeOf(fixture) },
				logins: () => []
			})
			const B = build(fx.installed.declared)
			const names = namesOf(fx.installed)
			/** The INSERT of `rows` into `r`, each row its `fields`' values in order; none for no row. */
			const insert = (
				r: (typeof stored)[number],
				fields: ReadonlyArray<string>,
				rows: ReadonlyArray<ReadonlyArray<number>>
			): ReadonlyArray<string> =>
				rows.length === 0
					? []
					: [
							`INSERT INTO ${names.table(r)} (${Arr.join(
								Arr.map(fields, (f) => quoteIdent(names.columnIdent(r, f))),
								", "
							)}) VALUES ${Arr.join(
								Arr.map(rows, (row) => `(${Arr.join(Arr.map(row, String), ", ")})`),
								", "
							)}`
						]
			const { assignments, grades, invalidations, reinstatements } = stateAt(earlier, scale)
			yield* ownerTransaction(
				Arr.flatten([
					insert(
						Assignment,
						["child", "number", "user", "test", "subject"],
						Arr.map(assignments, (a) => [a.child, a.number, a.user, a.test, a.subject])
					),
					insert(
						AssignmentGrade,
						["number", "gradeRank"],
						Arr.map(grades, (g) => [g.number, g.gradeRank])
					),
					insert(
						Invalidation,
						["child", "number", "change"],
						Arr.map(invalidations, (i) => [i.child, i.number, i.change])
					),
					insert(
						Reinstatement,
						["child", "number", "change"],
						Arr.map(reinstatements, (i) => [i.child, i.number, i.change])
					)
				])
			)
			const db = yield* openFull(fx, B.schema)
			let read = -1
			const observed = yield* observedChange(db, changeOf(B), attemptLabel, {
				kind: "probe",
				run: (probe) =>
					Effect.map(
						probe.rows(
							`SELECT (COALESCE(sum(seq_tup_read), 0) + COALESCE(sum(idx_tup_fetch), 0))::text FROM pg_catalog.pg_stat_xact_user_tables WHERE relid = ANY (ARRAY[${Arr.join(
								Arr.map(counted, (_, i) => `$${i + 1}::regclass`),
								", "
							)}])`,
							Arr.map(counted, (r) => names.table(r))
						),
						(rows) => {
							read = Number(defined(rows[0]?.[0], "the rows read"))
						}
					)
			})
			const applied = yield* observed.apply(call)
			assert.ok(
				applied.value.kind === "accepted" || applied.value.kind === "no-change",
				`${earlier} at scale ${scale}: the call commits, not ${applied.value.kind}`
			)
			return {
				assignments: yield* rowsOf(names, Assignment, [
					"child",
					"number",
					"user",
					"test",
					"subject"
				]),
				origins: yield* rowsOf(names, Origin, ["child", "number", "origin"]),
				read
			}
		})
	)

/** The user's sittings are tested against the standing invalidations at their keys, whatever else is invalidated. */
export const aSittingsTestOfTheStandingInvalidationsReadsTheSameRowsHoweverManyAreStored =
	property.exhaust(finite(earlierGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["active", "invalidated", "reinstated"] satisfies ReadonlyArray<Reached<Earlier>>,
		check:
			({ substrate }, k: Case<Earlier>) =>
			(earlier) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						k.note(earlier)
						const runs = yield* Effect.forEach(scales, (scale) => runAt(earlier, scale))
						for (const [scale, run] of Arr.zip(scales, runs)) {
							const model = modelOf(earlier, scale)
							assert.deepEqual<ReadonlyArray<string>>(
								run.assignments,
								model.assignments,
								`${earlier} at scale ${scale}: the sittings are the model's`
							)
							assert.deepEqual<ReadonlyArray<string>>(
								run.origins,
								model.origins,
								`${earlier} at scale ${scale}: the origins are the model's`
							)
						}
						const [small, large] = runs
						const grown = defined(large, "the run at the second scale").read
						assert.ok(
							grown <= small.read,
							`${earlier}: the rows the write reads of the invalidations and reinstatements at scale 16, ${grown}, are at most those at scale 1, ${small.read}: each test of the user's sittings reads them at the sitting's key`
						)
					}),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the model's sittings and origins, and PostgreSQL's counts of the rows the write reads, at scale 16 at most those at scale 1"
		},
		box: "the call's user's earlier sitting of the test active, invalidated, or invalidated and reinstated, at 32 and 512 other users' invalidated sittings",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/semi-join/exists.ts",
				original: "\t\tconst placed = atLeftRow(\n",
				replacement: "\t\tconst placed = asItStands(\n",
				why: "A right side read per left row is lowered where it stands, so the test reads the set the statement carries, the standing invalidations derived whole for both views, and the rows read grow with every invalidation stored."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\t(!restrictedWithin(node.right, node) || leftLeads(node)) &&\n",
				replacement: "\t\tleftLeads(node) &&\n",
				why: "A right side no value of the statement restricts is tested as a set where the left side leads it at no rank: a bare EXISTS over the standing invalidations the statement carries, derived whole, and the rows read grow with every invalidation stored."
			}
		]
	})
