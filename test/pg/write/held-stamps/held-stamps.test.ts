/**
 * metis's hold gate on PostgreSQL 19: a write stamps each due assignment of the call's user with its read-aloud, a union
 * of three rules each a navigation's chain of steps, read beside the due assignments, and reads the same rows of every
 * relation however many other users' assignments are stored. The due assignments seed a key set even read through the
 * open assignments, a query whose step reads each assignment again at the key the first read bound, its row equated to
 * the values passed in by a filter (lower/optimize/cte-policy regionRestrictedByValues: a source restricted once the
 * outer row it reads is, a filter's equalities over its region); and each rule of the union, read LATERAL per key, reads
 * its first step at the key inside that step's own fence (lower/shapes/share/keyed.ts pushedInto), where a restriction
 * over the rule stopped at the fence and each key read every assignment again. metis's assign spent 377 ms of its 390
 * ms hold on that insert, the union read whole over 97,379 assignments in each of its three rules.
 *
 * metis's own form held nothing until a region's occurrence held at the outer row's key counted whatever its source:
 * its dueOfCall reads its declared Open and Valid views as steps, each a region whose one occurrence is the view's rows
 * held at the due assignment's key by constants, and only a stored relation's constants reached an occurrence, so the
 * due assignments seeded no key set and the union was read whole (metis assign statement 5, 125k pages a call).
 *
 * The box, exhausted: the due assignments read through the open assignments, by negations of their own, or through
 * metis's declared views; each at scale 1 and 16, 32 and 512 other users' assignments stored beside the call user's
 * four. Each case installs the schema twice, once a scale.
 *
 * Property, per case: at each scale the call commits and AssignmentReadAloud holds the model's stamps
 * (held-stamps.fixtures.ts modelOf); and the rows the write reads in its transaction of the relations the union's rules
 * read beside the assignments (pg_stat_xact_user_tables) at scale 16 are at most those at scale 1, where PostgreSQL may
 * scan a table of a few dozen rows whole that it reads by its index at sixteen times as many. Oracle: specification, the model, and PostgreSQL's
 * own counts.
 *
 * Features: each way of reading the due assignments.
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
	AssignmentReadAloud,
	build,
	changeOf,
	type Due,
	dueGen,
	dues,
	ExpiryHeld,
	modelOf,
	now,
	ReadAloudNeed,
	stateAt,
	Test,
	user
} from "#test/pg/write/held-stamps/held-stamps.fixtures.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The scales: the other users' assignments stored, 32 a scale. */
const scales = [1, 16] as const

/**
 * The relations the read-aloud union's rules read beside the assignments, whose rows read the property counts: read at
 * the due assignments' keys, a few for each; read whole, one for each assignment stored. Assignment itself is not
 * counted: the call's user's are read by the user, no key of it.
 */
const counted = [Test, ReadAloudNeed] as const

/** The relations the property stores rows of. */
const stored = [Assignment, ExpiryHeld, Test, ReadAloudNeed] as const

/** One scale's run: the stamps after the call, and the rows the write read of the counted relations. */
const runAt = (due: Due, scale: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const s = yield* Substrate
			const fx = yield* installWrites(build("HeldStamps").schema, "heldstamps", {
				programs: {},
				logins: () => []
			})
			const S = build(fx.installed.declared)
			const names = namesOf(fx.installed)
			/** The INSERT of `rows` into `r`, each row its `fields`' values in order; none for no row. */
			const insert = (
				r: (typeof stored)[number],
				fields: ReadonlyArray<string>,
				rows: ReadonlyArray<ReadonlyArray<number | boolean>>
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
			const { assignments, held, tests, needs } = stateAt(scale)
			yield* ownerTransaction(
				fx,
				Arr.flatten([
					insert(
						Assignment,
						["child", "number", "user", "test", "expiresAt"],
						Arr.map(assignments, (a) => [a.child, a.number, a.user, a.test, a.expiresAt])
					),
					insert(
						ExpiryHeld,
						["child", "number", "at"],
						Arr.map(held, (h) => [h.child, h.number, 0])
					),
					insert(
						Test,
						["test", "subject", "gradeRank"],
						Arr.map(tests, (t) => [t.test, t.subject, t.gradeRank])
					),
					insert(
						ReadAloudNeed,
						["person", "on"],
						Arr.map(needs, (n) => [n.person, n.on])
					)
				])
			)
			const db = yield* openFull(fx, S.schema)
			let read = -1
			const observed = yield* observedChange(db, changeOf(S, due), attemptLabel, {
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
			const applied = yield* observed.apply({ user, now, test: 1 })
			assert.ok(
				applied.value.kind === "accepted" || applied.value.kind === "no-change",
				`${due} at scale ${scale}: the call commits, not ${applied.value.kind}`
			)
			const stamps = yield* Effect.map(
				s.admin.queryValues(
					`SELECT ${Arr.join(
						Arr.map(
							["child", "number", "on"],
							(f) => `${quoteIdent(names.columnIdent(AssignmentReadAloud, f))}::text`
						),
						", "
					)} FROM ${names.table(AssignmentReadAloud)}`,
					[]
				),
				(rows) =>
					Arr.sort(
						Arr.map(rows, (row) => Arr.join(Arr.map(row, String), " | ")),
						Order.String
					)
			)
			return { stamps, read }
		})
	)

/** A due assignment's stamp reads the same rows of every relation at any number of other users' assignments. */
export const aDueAssignmentsStampReadsTheSameRowsOfEveryRelationHoweverManyOtherAssignmentsAreStored =
	property.exhaust(finite(dueGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: dues satisfies ReadonlyArray<Reached<Due>>,
		check:
			({ substrate }, k: Case<Due>) =>
			(due) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						k.note(due)
						const runs = yield* Effect.forEach(scales, (scale) => runAt(due, scale))
						for (const [scale, run] of Arr.zip(scales, runs)) {
							assert.deepEqual<ReadonlyArray<string>>(
								run.stamps,
								modelOf(scale),
								`${due} at scale ${scale}: the stamps are the model's`
							)
						}
						const [small, large] = runs
						const grown = defined(large, "the run at the second scale").read
						assert.ok(
							grown <= small.read,
							`${due}: the rows the write reads at scale 16, ${grown}, are at most those at scale 1, ${small.read}: the union read at the due assignments' keys inside each rule's first step`
						)
					}),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the model's stamps, and PostgreSQL's counts of the rows the write reads, at scale 16 at most those at scale 1"
		},
		box: "the due assignments read through the open assignments, by negations of their own or through metis's declared views, at 32 and 512 other users' assignments",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original:
					'\t\t\t\t(o.source.kind !== "Base" &&\n\t\t\t\t\trestrictedByValues(o.source) &&\n\t\t\t\t\touterOf(o.source).every((c) => fixedFor(o, c)))\n',
				replacement: "\t\t\t\tfalse\n",
				why: "A step read at the key its region's earlier read bound is no restriction of the region: the due assignments read through the open ones seed nothing, the union is read whole over every assignment, and the rows read grow with them."
			},
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: '\t\t\tcase "Step":\n\t\t\t\tdeliver(at, at.input, equalities, true)\n',
				replacement: '\t\t\tcase "Step":\n\t\t\t\tdeliver(at, at.input, [], true)\n',
				why: "A rule of the union read at a key is restricted over its first step, whose fence stops it: each key reads every assignment again, and the rows read grow with them."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\t...o.constants.flatMap((c) => {\n",
				replacement: '\t\t...(o.source.kind === "Base" ? o.constants : []).flatMap((c) => {\n',
				why: "Only a stored relation's constants reach an occurrence, as before: metis's views, each a region whose one occurrence is the view's rows held at the due assignment's key, are reached by none, the due assignments seed no key set, and the union is read whole, its rows growing with the other users' assignments."
			}
		]
	})
