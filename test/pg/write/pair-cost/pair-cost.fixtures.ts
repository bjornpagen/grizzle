/** What the properties of pair-cost.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect } from "effect"
import { rowsScannedAndPaired } from "#bench/harness/explain.ts"
import { explainedChange, installWrites, openFull } from "#bench/write/support/writes.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, pg, span } from "#compiler/public/fields.ts"
import { counted, fin, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { assert } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { writeAuditViolations } from "#test/support/write-audit.ts"

const Owner = relation(
	"Owner",
	{ pkg: pg.integer, path: pg.integer, start: pg.bigint, n: drawn(natural) },
	["pkg", "path", "start"]
)

const Item = relation(
	"Item",
	{
		pkg: pg.integer,
		path: pg.integer,
		start: pg.bigint,
		name: pg.integer,
		kind: pg.integer,
		value: pg.bigint,
		during: span(pg.bigint)
	},
	["pkg", "path", "start", "name"]
)

/** The unique object beside Item's primary key whose pairs the family additions statement checks. */
const objects = [
	"a key beside the primary key",
	"a key over a selection",
	"a no-overlap key"
] as const

type UniqueObjectKind = (typeof objects)[number]

const objectStatement = (object: UniqueObjectKind) => {
	switch (object) {
		case "a key beside the primary key":
			return key(on(Item, "pkg", "path", "value"))
		case "a key over a selection":
			return key(
				on(
					select(Item, (r) => r.eq(r.kind, 1)),
					"pkg",
					"path",
					"start"
				)
			)
		case "a no-overlap key":
			return key(on(Item, "pkg", "path", "during"))
	}
}

const build = (name: string, object: UniqueObjectKind) =>
	schema(
		name,
		[Owner, Item],
		[counted(on(Item, "pkg", "path", "start"), fin(Owner, "n")), objectStatement(object)]
	)

type Schema = ReturnType<typeof build>

/** The members each owner holds: one of each kind, each with a value and a span of its own. */
const membersPerOwner = 2

/** The write of `owners` owners and their members, inserted together into an empty installation. */
const writeOf = (s: Schema, owners: number) =>
	ChangeSet.empty(s)
		.insert(
			Owner,
			Arr.map(indices(owners), (o) => ({ pkg: 1, path: o % 7, start: BigInt(o) }))
		)
		.insert(
			Item,
			Arr.flatMap(indices(owners), (o) =>
				Arr.map(indices(membersPerOwner), (m) => ({
					pkg: 1,
					path: o % 7,
					start: BigInt(o),
					name: m,
					kind: m,
					value: BigInt(membersPerOwner * o + m),
					during: {
						start: BigInt(membersPerOwner * o + m),
						end: BigInt(membersPerOwner * o + m + 1)
					}
				}))
			)
		)

/** The smallest sizes a case writes, n owners: 2n and 4n follow. */
const sizes = ["n of 125", "n of 250"] as const

type Size = (typeof sizes)[number]

export const smallest: Readonly<Record<Size, number>> = { "n of 125": 125, "n of 250": 250 }

export type Situation = `${UniqueObjectKind}, ${Size}`

export const situations: Arr.NonEmptyReadonlyArray<Situation> = Arr.flatMap(objects, (object) =>
	Arr.map(sizes, (size): Situation => `${object}, ${size}`)
)

/** A case: the unique object whose pairs it checks, and the smallest size its law measures it at. */
interface Sketch {
	readonly object: UniqueObjectKind
	readonly size: Size
}

export const sketchGen: Gen<Sketch> = (source) => ({
	object: source.draw(element(objects)),
	size: source.draw(element(sizes))
})

/** What one size's write cost: the rows its statements read and paired, and the pages they read and the temp they wrote. */
interface Cost {
	readonly owners: number
	readonly rows: number
	readonly pages: number
	readonly temp: number
}

export const costText = (c: Cost): string =>
	`${c.rows} rows read and paired at ${c.owners} owners (${c.pages} pages read, ${c.temp} temp pages written)`

/**
 * The cost of writing `owners` owners and their members under `object` on a fresh installation, with the times
 * PostgreSQL analyzed its tables, which a never-analyzed installation holds at none.
 */
export const costOf = (object: UniqueObjectKind, owners: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("PairCost", object), "paircost", {
				programs: {},
				logins: []
			})
			const S = build(fx.installed.declared, object)
			const db = yield* openFull(fx, S)
			const write = writeOf(S, owners)
			const plans = yield* explainedChange(db, write)
			assert.ok(plans.length > 0, `the write of ${owners} owners runs a statement`)
			const violations = yield* writeAuditViolations(db, write)
			assert.deepEqual(violations, [], "every statement of the write passes the structural audit")
			const substrate = yield* Substrate
			const analyzed = yield* substrate.admin.queryValues(
				`SELECT coalesce(sum(analyze_count + autoanalyze_count), 0)::text FROM pg_catalog.pg_stat_user_tables WHERE relid IN (${Arr.join(
					Arr.map(fx.tables, (table) => `'${table}'::pg_catalog.regclass`),
					", "
				)})`,
				[]
			)
			return {
				analyzed: Number(analyzed[0]?.[0]),
				cost: {
					owners,
					rows: Arr.reduce(plans, 0, (sum, p) => sum + rowsScannedAndPaired(p.plan)),
					pages: Arr.reduce(
						plans,
						0,
						(sum, p) => sum + p.plan.buffers.sharedHit + p.plan.buffers.sharedRead
					),
					temp: Arr.reduce(plans, 0, (sum, p) => sum + p.plan.buffers.tempWritten)
				} satisfies Cost
			}
		})
	)
