/** What the properties of met-skew.test.ts read: its spaces, models and helpers. */

import { boolean, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import type { DeltaSource } from "#compiler/types/changeset/changeset.ts"
import { rigTemplate } from "#test/support/schedules/rig.ts"
import type { ScheduleOutcome } from "#test/support/schedules/types.ts"

export const Held = relation("Held", { id: pg.uuidv7, k: pg.integer, a: pg.integer }, ["id"])

export const Mark = relation("Mark", { k: pg.integer }, ["k"])

const heldKey = key(on(Held, "k"))

/** The schema, the role `writer`, which inserts Held and Mark, and `direct`, which writes both, and their logins. */
export const skew = (name: string) => {
	const base = schema(name, [Held, Mark], [heldKey])
	const writer = role(base, "writer", { Held, Mark }, { insert: ["Held", "Mark"] })
	const direct = role(base, "direct", { Held, Mark }, { write: ["Held", "Mark"] })
	const heldOf = (side: DeltaSource<typeof Held>) =>
		query(base).rule((r) => {
			const { id, k, a } = v(side, "held")
			return r.match(side, { id, k, a }).find({ id, k, a })
		})
	return {
		schema: base,
		writer,
		direct,
		server: login(base, "server", [writer], {
			workload: [
				workload(writer, {
					meet: ChangeSet.empty(base)
						.insert(
							Held,
							query(base).rule((r) => {
								const held = r.relation("held", { k: Held.fields.k, a: Held.fields.a })
								const { k, a } = v(held, "given")
								return r.match(held, { k, a }).find({ k, a })
							})
						)
						.insert(Mark, [])
						.read("added", (d) => heldOf(d.added(Held)))
						.read("met", (d) => heldOf(d.met(Held)))
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** One case of the box. */
interface Skew {
	/** Whether L's Held request repeats m exactly, or states the free key 3. */
	readonly repeats: boolean
	/** Whether D deletes m, or o. */
	readonly deletesMet: boolean
	/** Whether D reads Mark at L's key, or at another. */
	readonly readsMark: boolean
}

export const skewGen: Gen<Skew> = (source) => ({
	repeats: source.draw(boolean),
	deletesMet: source.draw(boolean),
	readsMark: source.draw(boolean)
})

export type SkewFeature =
	| "the skew through a met row refused with 40001"
	| "a met row D does not delete, D committed"
	| "a met row D deletes, beside no read of L's mark, D committed"
	| "a new row beside D's deletion, D committed"
	| "a 40001 no skew forces"

/** L's Mark key, and the one D reads otherwise. */
export const markKey = 5

export const otherMark = 6

/** A Held row as L reads it back. */
interface HeldRow {
	readonly id: string
	readonly k: number
	readonly a: number
}

/** A Held row as the table's state reads it: k, a and id, each as text. */
export interface HeldText {
	readonly k: string
	readonly a: string
	readonly id: string
}

export const heldText = (r: HeldRow): HeldText => ({ k: String(r.k), a: String(r.a), id: r.id })

export const byKey = (rows: ReadonlyArray<HeldText>): ReadonlyArray<HeldText> =>
	Arr.sort(
		rows,
		Order.mapInput(Order.String, (r: HeldText) => r.k)
	)

/** Whether a schedule outcome is SSI's serialization failure: 40001 at a statement, or a COMMIT rolled back. */
export const isSerialization = (o: ScheduleOutcome): boolean =>
	(o._tag === "PgError" && o.fields.code === "40001") || o._tag === "RolledBack"

/** The schedule's installation made once per member (support/schedules/rig.ts rigTemplate), which each case's seat holds. */
export const skewRig = rigTemplate(import.meta, "met skew", skew)
