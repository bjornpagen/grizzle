import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	boolean,
	constant,
	element,
	filter,
	type Gen,
	int,
	oneOf,
	option
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { context, key, login, on, relation, role, schema, select } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { assert, defined } from "#test/support/assert.ts"
import { migrated, noObservation } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { clearRows, installationGroup } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { tokenOf } from "#test/support/worlds.ts"

/**
 * A query entry's write meets every stored fact at every unique object of its target as that object's law.
 *
 * README, "Writing through a role" and "Errors and outcomes": a put or insert that collides with a fact outside the
 * entry, at a key, is `invariant-rejected` on that key's law alone, and a key broken by a stored fact inside the entry
 * or outside it shows the key you submitted, in the fields you wrote it in.
 *
 * Seat(id, code, grp, lead, team, holder) has four unique objects, each a key (fin.md §6, "at most one"): its primary
 * key; the candidate key code; at most one lead per group, `key(on(select(Seat, lead), "grp"))`, a UNIQUE over the
 * selected side's generated law column; and at most one seat per team, `key(on(Seat, "team"))`. The role `holder` writes
 * MySeat, the seats of the session's subject, so a seat of another holder is a fact outside its world. A case stores
 * carl's seat (outside ann's world), ann's own seat (inside it), both or neither, lawfully, and ann inserts one seat
 * through MySeat. Every stored seat that conflicts with hers at an object is a refusal by that object's law, whichever
 * world holds it; with none she inserts it, and an exact repeat of her own changes nothing. No outcome is a
 * TransientFailure: nothing runs concurrently, so a write that meets a stored fact the role cannot see and fails
 * transiently fails again on every retry (the livelock FR2 fixed at the at-most-one objects, which the precheck did
 * not probe). The oracle is the specification turned into a checker: each object's conflict, stated over the drawn
 * values.
 */
const Subject = str.regex("^u_[a-z]{1,8}$")
const Seat = relation(
	"Seat",
	{
		id: pg.integer,
		code: pg.integer,
		grp: pg.integer,
		lead: pg.boolean,
		team: pg.integer,
		holder: Subject
	},
	["id"]
)
const codeKey = key(on(Seat, "code"))
const oneLead = key(
	on(
		select(Seat, (x) => x.eq(x.lead, true)),
		"grp"
	)
)
const oneSeat = key(on(Seat, "team"))

const seatsAt = (name: string) => {
	const base = schema(name, { Seat }, [codeKey, oneLead, oneSeat])
	const Session = context("Session", { sub: Subject })
	const mine = query(base).rule((r) => {
		const { id, code, grp, lead, team, holder } = v(Seat, "seat")
		return r
			.match(Seat, { id, code, grp, lead, team, holder })
			.match(Session, { sub: holder })
			.find({ id, code, grp, lead, team })
	})
	const holder = role(base, "holder", { MySeat: mine }, { write: ["MySeat"] })
	return {
		base,
		holder,
		desk: login(base, "desk", [holder], {
			workload: [
				workload(holder, {
					insertSeat: ChangeSet.empty(holder).insert(holder.relations.MySeat, [])
				})
			]
		})
	}
}

/** A seat as MySeat holds it. */
interface Values {
	readonly id: number
	readonly code: number
	readonly grp: number
	readonly lead: boolean
	readonly team: number
}

/** Small domains, so every object meets. */
const valuesGen: Gen<Values> = (source) => ({
	id: source.draw(int(1, 3)),
	code: source.draw(int(1, 3)),
	grp: source.draw(int(1, 2)),
	lead: source.draw(boolean),
	team: source.draw(int(1, 3))
})

type ObjectName = "primary key" | "candidate key" | "at most one lead" | "at most one seat"

/** A unique object of Seat: the head fields its refusal's witness names, and when two seats conflict there. */
interface UniqueObject {
	readonly name: ObjectName
	readonly witness: ReadonlyArray<keyof Values>
	readonly conflict: (a: Values, b: Values) => boolean
}

const objects: ReadonlyArray<UniqueObject> = [
	{ name: "primary key", witness: ["id"], conflict: (a, b) => a.id === b.id },
	{ name: "candidate key", witness: ["code"], conflict: (a, b) => a.code === b.code },
	{
		name: "at most one lead",
		witness: ["grp"],
		conflict: (a, b) => a.lead && b.lead && a.grp === b.grp
	},
	{ name: "at most one seat", witness: ["team"], conflict: (a, b) => a.team === b.team }
]

/** A seat held by `holder` as a VALUES row of Seat's columns. */
const row = (s: Values, holder: string): string =>
	`(${s.id}, ${s.code}, ${s.grp}, ${s.lead}, ${s.team}, '${holder}')`

const same = (a: Values, b: Values): boolean =>
	a.id === b.id && a.code === b.code && a.grp === b.grp && a.lead === b.lead && a.team === b.team

/** Carl's seat and ann's own, each stored or not, never conflicting; and the seat ann inserts. */
interface OccupantCase {
	readonly hidden: Option.Option<Values>
	readonly inside: Option.Option<Values>
	readonly submitted: Values
}

/** `s` with its `field` taken from `from`. */
const withField = (s: Values, field: keyof Values, from: Values): Values => {
	switch (field) {
		case "id":
			return { ...s, id: from.id }
		case "code":
			return { ...s, code: from.code }
		case "grp":
			return { ...s, grp: from.grp }
		case "lead":
			return { ...s, lead: from.lead }
		case "team":
			return { ...s, team: from.team }
	}
}

/**
 * The stored seats, lawful together; and ann's seat, drawn fresh, or a stored seat itself (her exact repeat, or carl's
 * seat at every object), or a stored seat with one field drawn again, so it meets the objects that field leaves alone.
 */
const storedGen = filter(
	(source) => ({ hidden: source.draw(option(valuesGen)), inside: source.draw(option(valuesGen)) }),
	({ hidden, inside }) =>
		Option.isNone(hidden) ||
		Option.isNone(inside) ||
		!Arr.some(objects, (o) => o.conflict(hidden.value, inside.value)),
	10
)

const caseGen: Gen<OccupantCase> = (source) => {
	const { hidden, inside } = source.draw(storedGen)
	const near = Arr.map(Arr.getSomes([hidden, inside]), (s) =>
		oneOf([
			constant(s),
			(drawing) =>
				withField(
					s,
					drawing.draw(element(["id", "code", "grp", "lead", "team"] as const)),
					drawing.draw(valuesGen)
				)
		])
	)
	return { hidden, inside, submitted: source.draw(oneOf([valuesGen, ...near])) }
}

type OccupantFeature =
	| `${"hidden" | "inside"} occupant at the ${ObjectName}`
	| "an exact repeat"
	| "accepted"

/** The objects where the stored seat of `world` conflicts with the submitted one: ann's own, unless it is the same
 * seat, an exact repeat; carl's, whatever its values, since a seat of his is never hers. */
const metIn = (c: OccupantCase, world: "hidden" | "inside"): ReadonlyArray<UniqueObject> =>
	Option.match(c[world], {
		onNone: () => [],
		onSome: (stored) =>
			world === "inside" && same(stored, c.submitted)
				? []
				: Arr.filter(objects, (o) => o.conflict(stored, c.submitted))
	})

layer(Substrate.layer)("a query entry's write meets every unique object of its target", (it) => {
	it.effect(
		"a stored fact at any unique object, inside the entry or outside it, is that object's law with the submitted key",
		(ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const built: Array<ReturnType<typeof seatsAt>> = []
						const m = yield* migrated({
							label: "seats",
							schemaName: { kind: "unique" },
							first: (name) => {
								const seats = seatsAt(name)
								built.push(seats)
								return { schema: seats.base, logins: [seats.desk] }
							},
							later: [],
							apply: { kind: "noPlaceholders" },
							declared: () => noDeclarations,
							observe: noObservation
						})
						const { desk } = defined(built[0], "the installed version")
						const names = namesOf(m)
						const lawOf: Readonly<Record<ObjectName, LawId>> = {
							"primary key": names.primaryKeyLaw(Seat),
							"candidate key": names.lawOf(codeKey),
							"at most one lead": names.lawOf(oneLead),
							"at most one seat": names.lawOf(oneSeat)
						}
						const table = names.table(Seat)
						const columns = Arr.join(
							Arr.map(["id", "code", "grp", "lead", "team", "holder"] as const, (f) =>
								names.column(Seat, f)
							),
							", "
						)
						const served = yield* servedFixture(m, desk)
						/** ann's Db, opened and used inside the layer of the served login that holds her role. */
						const explored = Effect.gen(function* () {
							const db = yield* Db.open(served.login.roles.holder, {
								token: tokenOf({ sub: "u_ann" })
							})
							return yield* explore(
								{
									oracle: { kind: "unstated" },
									suite: "pg/write/entry-occupants",
									draw: drawn(caseGen),
									literal: Formatter.format,
									coverage: required<OccupantFeature>(
										[
											"hidden occupant at the primary key",
											"hidden occupant at the candidate key",
											"hidden occupant at the at most one lead",
											"hidden occupant at the at most one seat",
											"inside occupant at the at most one lead",
											"inside occupant at the at most one seat",
											"an exact repeat",
											"accepted"
										],
										{ cases: 60, sense: notesOnly }
									),
									kept: [],
									runs: 60,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 16,
									caseHang
								},
								(c, cx) =>
									Effect.gen(function* () {
										const stored = [
											...Option.match(c.hidden, {
												onNone: () => [],
												onSome: (s) => [row(s, "u_carl")]
											}),
											...Option.match(c.inside, {
												onNone: () => [],
												onSome: (s) => [row(s, "u_ann")]
											})
										]
										yield* clearRows(m.owner, installationGroup(names))
										if (stored.length > 0) {
											yield* m.sql(
												`INSERT INTO ${table} (${columns}) VALUES ${Arr.join(stored, ", ")}`
											)
										}
										const before = yield* m.owner.values(
											`SELECT ${columns} FROM ${table} ORDER BY 1`,
											[]
										)
										const applied = yield* Effect.result(
											db.workload.insertSeat.apply({ insert: { MySeat: [c.submitted] } }, {})
										)
										if (Result.isFailure(applied)) {
											return assert.fail(
												`ann's insert of ${Formatter.format(c.submitted)} failed with ${applied.failure._tag}: ${applied.failure.message}`
											)
										}
										const outcome = applied.success
										const after = yield* m.owner.values(
											`SELECT ${columns} FROM ${table} ORDER BY 1`,
											[]
										)
										const hiddenMet = metIn(c, "hidden")
										const insideMet = metIn(c, "inside")
										for (const o of hiddenMet) {
											cx.note(`hidden occupant at the ${o.name}`)
										}
										for (const o of insideMet) {
											cx.note(`inside occupant at the ${o.name}`)
										}
										const met = [...hiddenMet, ...insideMet]
										const repeat = Option.exists(c.inside, (s) => same(s, c.submitted))
										if (met.length === 0) {
											cx.note(repeat ? "an exact repeat" : "accepted")
											assert.equal(outcome.kind, repeat ? "no-change" : "accepted", "the outcome")
											const { id, code, grp, lead, team } = c.submitted
											assert.deepEqual(
												after,
												repeat
													? before
													: Arr.sort(
															[...before, [id, code, grp, lead, team, "u_ann"]],
															Order.mapInput(Order.Number, (r: ReadonlyArray<unknown>) =>
																Number(r[0])
															)
														),
												"the seats stored after the insert: ann's beside the ones before it"
											)
											return
										}
										if (outcome.kind !== "invariant-rejected") {
											return assert.fail(
												`ann's insert of ${Formatter.format(c.submitted)} met ${Arr.join(
													Arr.map(met, (o) => o.name),
													", "
												)} and answered ${outcome.kind}`
											)
										}
										const [law, ...more] = Arr.map(outcome.refused.laws, (l) => names.reported(l))
										assert.deepEqual(more, [], "a key's refusal names its one law")
										const object = Option.getOrThrowWith(
											Arr.findFirst(met, (o) => lawOf[o.name] === law),
											() =>
												new Error(
													`the refusal's law ${law} is none of the objects ann's seat met: ${Arr.join(
														Arr.map(met, (o) => o.name),
														", "
													)}`
												)
										)
										assert.deepEqual(
											outcome.witness,
											{
												kind: "key",
												relation: "MySeat",
												values: Rec.fromEntries(
													Arr.map(object.witness, (f) => [f, c.submitted[f]] as const)
												)
											},
											`the witness of the ${object.name}: the key ann submitted, in MySeat's fields`
										)
										assert.deepEqual(after, before, "a refused insert stores nothing")
									})
							)
						})
						return yield* Effect.scoped(explored).pipe(withLayer(served.layer))
					})
				)
			)
	)
})
