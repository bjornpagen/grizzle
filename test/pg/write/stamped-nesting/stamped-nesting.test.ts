/**
 * Every member of a nested write under a stamped owner stores exactly its owner's stamp, on PostgreSQL 19: an owner
 * whose place its insert leaves out, its members nested in it one or two deep, each carrying the owner's key, the place
 * among it, in its group (write/family/nesting.ts Nesting `stamps`). The walk fills every member's column but the
 * carried place and the generated field over it (runtime/write/fill.ts StatementFills), and the one family statement
 * stamps the owner's head once at each group, every row that carries it joining that stamp (write/family/additions.ts
 * stampedSources), so the owner and every member it nests store one place, and PostgreSQL computes the generated field
 * over it as it stores the row.
 *
 * The box, exhausted: Owner(g, h, s, x, ms, tot), keyed (g, h, s) with `s` a place, owning M1(g, h, s, at, v, cx, ks,
 * gs) at `ms` and M1 owning M2(g, h, s, at, bt, w) at `ks`, each member copying its owner's `x` at `cx`, its `gs`
 * generated over its carried place (`v` where the place is at least 1, else 0), and the owner's `tot` the sum of its
 * members' `v` (test/unit/write/stamped-nesting.fixtures.ts, its fold over every member); members one or two deep;
 * one owner, two in two groups, or two in one group stated apart; none, one or two members an owner, as many again under
 * each member two deep. Each case installs the schema, serves an insert of Owner's host rows, each leaving its place
 * out, and calls it twice with the case's owners.
 *
 * Property, per case: each call is accepted, its owners stamped the next place of their group, 0 and then 1, and every
 * member stored with exactly its owner's place, its group's other fields, its slot, its owner's `x` and the generated
 * field over the place; or, two owners of one group, each call is refused before any statement at the owner's primary
 * key, and nothing is stored. Oracle: the rule, the case's owners and members as it nests them, stamped call by call.
 * Kill: the fill reads the stamped field, so the bind dies before any statement.
 *
 * Features: members two deep, no member, each set of owners.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { installFullWorld } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { oneFlight } from "#test/support/one-flight.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"
import {
	featuresOf,
	ownersOf,
	type StampedCase,
	type StampedFeature,
	stampedSchemaOf,
	writtenGen
} from "#test/unit/write/stamped-nesting.fixtures.ts"

/** The case's rows as PostgreSQL stores them after `calls` calls of its owners, each column's text: each owner at the
 * place its group's calls stamped it, every member at its owner's. */
const expectedAfter = (c: StampedCase, calls: number) => {
	const owners = ownersOf(c)
	const stamps = Array.from({ length: calls }, (_, s) => s)
	const text = (v: number | bigint) => String(v)
	return {
		Owner: Arr.flatMap(stamps, (s) =>
			Arr.map(owners, (o) => [
				text(o.g),
				text(o.h),
				text(s),
				text(o.x),
				text(Arr.reduce(o.members, 0n, (sum, m) => sum + m.v))
			])
		),
		M1: Arr.flatMap(stamps, (s) =>
			Arr.flatMap(owners, (o) =>
				Arr.map(o.members, (m, at) => [
					text(o.g),
					text(o.h),
					text(s),
					text(at),
					text(m.v),
					text(o.x),
					text(s >= 1 ? m.v : 0n)
				])
			)
		),
		M2: Arr.flatMap(stamps, (s) =>
			Arr.flatMap(owners, (o) =>
				Arr.flatMap(o.members, (m, at) =>
					Arr.map(m.ws, (w, bt) => [text(o.g), text(o.h), text(s), text(at), text(bt), text(w)])
				)
			)
		)
	}
}

/** Rows of column texts, in one order. */
const sorted = (rows: ReadonlyArray<ReadonlyArray<string>>) =>
	Arr.sort(
		rows,
		Order.mapInput(Order.String, (r: ReadonlyArray<string>) => Arr.join(r, " "))
	)

/** Every member of a nested write under a stamped owner stores exactly its owner's stamp, call after call. */
export const everyMemberOfANestedWriteUnderAStampedOwnerStoresExactlyItsOwnersStamp =
	property.exhaust(finite(writtenGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"owners one",
			"owners two groups",
			"owners one group",
			"members two deep",
			"no member",
			"bound",
			"conflict"
		] satisfies ReadonlyArray<Reached<StampedFeature>>,
		check:
			({ substrate }, k: Case<StampedFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						k.noteAll(featuresOf(c))
						const declared = stampedSchemaOf(c, "Stamped").schema
						const done = yield* installFullWorld(declared, {}, [], {
							ambient: ordinarySession,
							label: "stamped"
						})
						const built = stampedSchemaOf(c, done.schema)
						const world = fullWorld(built.schema, {}, [])
						const db = yield* openServedDb(done, world.server.roles.app, {})
						const flight = yield* oneFlight(db.ctx, done.as(world.server))
						const loaded = yield* db.load({
							stamp: ChangeSet.empty(built.schema).insert(built.Owner, [])
						})
						const facts = {
							insert: {
								Owner: Arr.map(ownersOf(c), (o) => ({
									g: o.g,
									h: o.h,
									x: o.x,
									ms: Arr.map(o.members, (m) => ({ v: m.v, ks: Arr.map(m.ws, (w) => ({ w })) }))
								}))
							}
						}
						const call = writeAnswerOf(
							writeOnce(memberCalls(flight.context, member(loaded, "stamp")))({ params: {}, facts })
						)
						const conflict = c.owners === "one group"
						for (const nth of [1, 2]) {
							const answer = yield* call
							assert.equal(
								answer.kind,
								conflict ? "refused" : "accepted",
								`call ${String(nth)}: ${Formatter.format(answer)}`
							)
						}
						const names = namesOf(done)
						const s = yield* Substrate
						/** A table's rows, each column `columns` names as its text, in one order. */
						const stored = (table: string, columns: ReadonlyArray<string>) =>
							Effect.map(
								s.admin.queryValues(
									`SELECT ${Arr.join(
										Arr.map(columns, (column) => `${column}::text`),
										", "
									)} FROM ${table}`,
									[]
								),
								(rows) => sorted(Arr.map(rows, (row) => Arr.map(row, (cell) => String(cell))))
							)
						const expected = expectedAfter(c, conflict ? 0 : 2)
						assert.deepEqual(
							{
								Owner: yield* stored(
									names.table(built.Owner),
									Arr.map(["g", "h", "s", "x", "tot"] as const, (f) => names.column(built.Owner, f))
								),
								M1: yield* stored(
									names.table(built.M1),
									Arr.map(["g", "h", "s", "at", "v", "cx", "gs"] as const, (f) =>
										names.column(built.M1, f)
									)
								),
								M2: yield* stored(
									names.table(built.M2),
									Arr.map(["g", "h", "s", "at", "bt", "w"] as const, (f) =>
										names.column(built.M2, f)
									)
								)
							},
							{
								Owner: sorted(expected.Owner),
								M1: sorted(expected.M1),
								M2: sorted(expected.M2)
							},
							"every owner at its group's next place, and every member at its owner's"
						)
					}),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the rule: each call stamps each group's next place, which every member its owner nests stores; two owners of one group are refused at the owner's key"
		},
		box: "members one or two deep under an owner keyed (g, h) and a place, its fold over every member, one owner, two in two groups or two in one group, none to two members each, each called twice",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/fill.ts",
				original:
					"\tfor (const c of layout.columns.filter((column) => !pending.has(column.key))) {\n",
				replacement: "\tfor (const c of layout.columns) {\n",
				why: "The walk fills a member's carried place from its owner's, which no row the host fills holds, so every call under a stamped owner dies of the invariant at filledBefore before any statement, den's claim's crash."
			}
		]
	})
