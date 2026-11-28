/** What the properties of entry-occupants.test.ts read: its spaces, models and helpers. */

import { boolean, type Gen } from "@bjornpagen/testing/gen"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { context, login, relation, role, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { rigTemplate } from "#test/support/schedules/rig.ts"

const Subject = str.regex("^u_[a-z]{1,8}$")

export const Seat = relation("Seat", { id: int4, team: int4, holder: Subject }, ["id"])

/** The relation a held call inserts last, which the owner's SHARE lock holds it at. */
export const Gate = relation("Gate", { n: int4 }, ["n"])

/** The schema, the role `holder`, which inserts its subject's seats and Gate, and its two logins. */
export const seats = (name: string) => {
	const base = schema(name, [Seat, Gate], [])
	const Session = context("Session", { sub: Subject })
	const mine = query(base).rule((r) => {
		const { id, team, holder } = v(Seat, "seat")
		return r.match(Seat, { id, team, holder }).match(Session, { sub: holder }).find({ id, team })
	})
	const holder = role(
		base,
		"holder",
		{ MySeat: mine, Gate },
		{ insert: ["MySeat", "Gate"], contexts: [Session] }
	)
	const direct = role(base, "direct", { Seat, Gate })
	const MySeat = holder.relations.MySeat
	return {
		schema: base,
		holder,
		direct,
		server: login(base, "server", [holder], {
			workload: [
				workload(holder, {
					take: ChangeSet.empty(holder)
						.insert(MySeat, [])
						.read("added", (d) =>
							query(holder).rule((r) => {
								const { id, team } = v(d.added(MySeat), "seat")
								return r.match(d.added(MySeat), { id, team }).find({ id, team })
							})
						)
						.read("met", (d) =>
							query(holder).rule((r) => {
								const { id, team } = v(d.met(MySeat), "seat")
								return r.match(d.met(MySeat), { id, team }).find({ id, team })
							})
						),
					held: ChangeSet.sequence(
						ChangeSet.empty(holder).insert(MySeat, []),
						ChangeSet.empty(holder).insert(Gate, [])
					)
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** One case of the box. */
interface Race {
	/** Whether W runs as carl, outside ann's entry, or as ann. */
	readonly outside: boolean
	/** Whether A requests W's id, and whether at W's team. */
	readonly sameId: boolean
	readonly sameTeam: boolean
}

export const raceGen: Gen<Race> = (source) => ({
	outside: source.draw(boolean),
	sameId: source.draw(boolean),
	sameTeam: source.draw(boolean)
})

export type RaceFeature =
	| "an outside seat committed past the snapshot: 40001, then refused on the key's law"
	| "an own seat committed past the snapshot: 40001, then met as an exact repeat"
	| "an own seat at another team committed past the snapshot: 40001, then refused on the key's law"
	| "a free id, inserted without waiting"

/** A seat a call reads back, as a plain record. */
export const seatOf = (r: { readonly id: number; readonly team: number }) => ({
	id: r.id,
	team: r.team
})

/** W's seat, and A's at another id or team. */
export const wId = 1

export const wTeam = 1

export const otherId = 2

export const otherTeam = 2

/** The schedule's installation made once per member (support/schedules/rig.ts rigTemplate), which each case's seat holds. */
export const seatsRig = rigTemplate(import.meta, "entry occupants", seats)
