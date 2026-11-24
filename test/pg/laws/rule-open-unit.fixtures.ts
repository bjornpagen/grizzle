/** What the property of rule-open-unit.test.ts reads: its schemas and their templates, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { baselineRuleChecks, lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	mutable,
	on,
	relation,
	schema,
	select,
	unit
} from "#compiler/public/schema.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { foundQueryOf, judgedStatementsOf, raisedRule, standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"

/**
 * The shapes installed: Presence and Seat both mutable in the one unit of a learner, each keyed by its child first, or
 * Presence in the learner's unit and Seat's twin, Bench, keyed by its pupil, in a unit of its own, so the rule joins
 * the rows of two units, two borrows.
 */
const shapes = ["one unit", "two units"] as const

export type Shape = (typeof shapes)[number]

const Presence = relation("Presence", { child: pg.integer, slot: pg.integer, score: pg.integer }, [
	"child",
	"slot"
])

const Seat = relation(
	"Seat",
	{ child: pg.integer, slot: pg.integer, cap: pg.integer, open: pg.integer },
	["child", "slot"]
)

const Bench = relation(
	"Bench",
	{ pupil: pg.integer, slot: pg.integer, cap: pg.integer, open: pg.integer },
	["pupil", "slot"]
)

const learner = unit("Learner", { child: pg.integer })

/**
 * The laws of each shape, over Presence and its seat, the seat a Seat of the presence's child or a Bench of the pupil
 * its child is: Seated, every presence at a seat, its foreign key; Present, a presence that scored stands at an open
 * seat, a containment between two selected sides; Capped, a presence scores at most its seat's cap, a check over their
 * join. Seated holds every Presence in its seat at the seat's key, so where the seat is immutable the check's region
 * reads a seat written only where it replaces one removed (analysis/theory/unit.ts witnessesOf); Seat and Bench are
 * mutable, their caps updated in place, so it reads every seat written.
 */
const schemaOf = (shape: Shape) => {
	switch (shape) {
		case "one unit": {
			const Base = schema(
				"OpenUnitOne",
				[Presence, Seat],
				[
					learner,
					mutable(Presence),
					mutable(Seat),
					contained(on(Presence, "child", "slot"), on(Seat, "child", "slot")),
					contained(
						on(
							select(Presence, (p) => p.gt(p.score, 0)),
							"child",
							"slot"
						),
						on(
							select(Seat, (s) => s.eq(s.open, 1)),
							"child",
							"slot"
						)
					)
				]
			)
			/** Each presence's score beside its seat's cap, by its child alone: a unit no wider than the learner's, so its
			 * upkeep would re-derive a learner's whole unit at each write and it is live (analysis/derived/storage.ts), and
			 * Capped, a check of each row, is judged whole over its definition, which reads every presence beside its seat
			 * as the slot-keyed join did. */
			const Over = derived(
				"Over",
				query(Base).rule((r) => {
					const { child, slot, score } = v(Presence, "p")
					const { cap } = v(Seat, "s")
					return r
						.match(Presence, { child, slot, score })
						.match(Seat, { child, slot, cap })
						.find({ child, score, cap })
				})
			)
			return schema.extend(
				[Base],
				"OpenUnitOne_1",
				[Over],
				[check("Capped", Over, (o) => o.le(o.score, o.cap))]
			)
		}
		case "two units": {
			const Base = schema(
				"OpenUnitTwo",
				[Presence, Bench],
				[
					learner,
					unit("Pupil", { pupil: pg.integer }),
					mutable(Presence),
					mutable(Bench),
					contained(on(Presence, "child", "slot"), on(Bench, "pupil", "slot")),
					contained(
						on(
							select(Presence, (p) => p.gt(p.score, 0)),
							"child",
							"slot"
						),
						on(
							select(Bench, (s) => s.eq(s.open, 1)),
							"pupil",
							"slot"
						)
					)
				]
			)
			const Over = derived(
				"Over",
				query(Base).rule((r) => {
					const { child, slot, score } = v(Presence, "p")
					const { cap } = v(Bench, "s")
					return r
						.match(Presence, { child, slot, score })
						.match(Bench, { pupil: child, slot, cap })
						.find({ child, slot, score, cap })
				})
			)
			return schema.extend(
				[Base],
				"OpenUnitTwo_1",
				[Over],
				[check("Capped", Over, (o) => o.le(o.score, o.cap))]
			)
		}
	}
}

const templateOf = (shape: Shape) =>
	migratedTemplate({
		declaredIn: import.meta,
		name: `open unit, ${shape}`,
		content: { schema: schemaOf(shape).name, logins: [] },
		versions: [{ schema: schemaOf(shape), logins: [], declarations: noDeclarations }],
		options: {
			label: shape === "one unit" ? "open_unit_one" : "open_unit_two",
			extensions: [],
			compile: compileInstallation,
			ambient: ordinarySession,
			review: noPlaceholders
		}
	})

/** Each shape installed by its migration, its judge among it. */
export const openTemplates = {
	"one unit": templateOf("one unit"),
	"two units": templateOf("two units")
} as const

/** A seat's row: its child, slot, cap and whether it is open. */
interface SeatRow {
	readonly child: number
	readonly slot: number
	readonly cap: number
	readonly open: number
}

/** A presence's row: its child, slot and score. */
interface PresenceRow {
	readonly child: number
	readonly slot: number
	readonly score: number
}

/**
 * A write of one row, by direct SQL: a put, an INSERT that updates the row standing at its key (ON CONFLICT DO UPDATE);
 * an UPDATE of the row at its key, of its seat's cap and openness or of its presence's score; a DELETE of it.
 */
type Op =
	| { readonly kind: "put seat"; readonly row: SeatRow }
	| { readonly kind: "put presence"; readonly row: PresenceRow }
	| { readonly kind: "update seat"; readonly row: SeatRow }
	| { readonly kind: "update presence"; readonly row: PresenceRow }
	| { readonly kind: "delete seat"; readonly child: number; readonly slot: number }
	| { readonly kind: "delete presence"; readonly child: number; readonly slot: number }

/** A case: its shape, a lawful state it writes first, and the writes after, the judge run after each. */
export interface OpenCase {
	readonly shape: Shape
	readonly seats: ReadonlyArray<SeatRow>
	readonly presences: ReadonlyArray<PresenceRow>
	readonly ops: ReadonlyArray<Op>
}

/** Two children of two slots each: four keys. */
const keys = [
	[1, 1],
	[1, 2],
	[2, 1],
	[2, 2]
] as const

const seatGen =
	(child: number, slot: number): Gen<SeatRow> =>
	(s) => ({
		child,
		slot,
		cap: s.draw(int(0, 2)),
		open: s.draw(int(0, 1))
	})

const presenceGen =
	(child: number, slot: number): Gen<PresenceRow> =>
	(s) => ({
		child,
		slot,
		score: s.draw(int(0, 2))
	})

const opGen: Gen<Op> = (s) => {
	const [child, slot] = s.draw(element(keys))
	return s.draw(
		weighted<Op>([
			[2, (t) => ({ kind: "put seat", row: t.draw(seatGen(child, slot)) })],
			[2, (t) => ({ kind: "put presence", row: t.draw(presenceGen(child, slot)) })],
			[3, (t) => ({ kind: "update seat", row: t.draw(seatGen(child, slot)) })],
			[3, (t) => ({ kind: "update presence", row: t.draw(presenceGen(child, slot)) })],
			[2, () => ({ kind: "delete seat", child, slot })],
			[1, () => ({ kind: "delete presence", child, slot })]
		])
	)
}

/** A drawn case: at each key a seat or none, and at a seat a lawful presence or none; then one to four writes. */
export const openCaseGen: Gen<OpenCase> = (s) => {
	const shape = s.draw(element(shapes))
	const seats = Arr.flatMap(keys, ([child, slot]) =>
		s.draw(int(0, 3)) === 0 ? [] : [s.draw(seatGen(child, slot))]
	)
	const presences = Arr.flatMap(seats, (seat) =>
		s.draw(int(0, 3)) === 0
			? []
			: [
					{
						child: seat.child,
						slot: seat.slot,
						score: seat.open === 1 ? s.draw(int(0, seat.cap)) : 0
					}
				]
	)
	return { shape, seats, presences, ops: s.draw(array(opGen, { min: 1, max: 4 })) }
}

/**
 * The kept case, replayed by value (gen.ts recorded): a seat of cap 2 under a presence of score 2, its cap then lowered
 * to 1 in place, open as before, which breaks Capped through an update no side of olds captures, the side reading only
 * the key and openness the update leaves as they were.
 */
export const keptOpen: Arr.NonEmptyReadonlyArray<OpenCase> = [
	{
		shape: "one unit",
		seats: [{ child: 1, slot: 1, cap: 2, open: 1 }],
		presences: [{ child: 1, slot: 1, score: 2 }],
		ops: [{ kind: "update seat", row: { child: 1, slot: 1, cap: 1, open: 1 } }]
	}
]

export type OpenFeature =
	| "judged whole in one unit"
	| "probed across two units"
	| `${Op["kind"]} accepted`
	| `${Exclude<Op["kind"], "delete presence">} refused`

export const openFeatures: readonly [OpenFeature, ...Array<OpenFeature>] = [
	"judged whole in one unit",
	"probed across two units",
	"put seat accepted",
	"put presence accepted",
	"update seat accepted",
	"update presence accepted",
	"delete seat accepted",
	"delete presence accepted",
	"put seat refused",
	"put presence refused",
	"update seat refused",
	"update presence refused",
	"delete seat refused"
]

/** The state a case's transaction holds, as the oracle keeps it: its seats and presences, each by its key. */
interface State {
	readonly seats: ReadonlyMap<string, SeatRow>
	readonly presences: ReadonlyMap<string, PresenceRow>
}

const keyOf = (child: number, slot: number): string => `${child}:${slot}`

/** The state after `op`, as PostgreSQL applies it: a put replaces or adds its row, an update replaces a standing one. */
const applied = (state: State, op: Op): State => {
	const put = <R extends { readonly child: number; readonly slot: number }>(
		rows: ReadonlyMap<string, R>,
		row: R,
		only: boolean
	): ReadonlyMap<string, R> => {
		const key = keyOf(row.child, row.slot)
		return only && !rows.has(key) ? rows : new Map([...rows, [key, row]])
	}
	const dropped = <R>(rows: ReadonlyMap<string, R>, key: string): ReadonlyMap<string, R> =>
		new Map(Arr.filter([...rows], ([k]) => k !== key))
	switch (op.kind) {
		case "put seat":
			return { ...state, seats: put(state.seats, op.row, false) }
		case "update seat":
			return { ...state, seats: put(state.seats, op.row, true) }
		case "put presence":
			return { ...state, presences: put(state.presences, op.row, false) }
		case "update presence":
			return { ...state, presences: put(state.presences, op.row, true) }
		case "delete seat":
			return { ...state, seats: dropped(state.seats, keyOf(op.child, op.slot)) }
		case "delete presence":
			return { ...state, presences: dropped(state.presences, keyOf(op.child, op.slot)) }
	}
}

/** Whether `state` breaks a law: a presence at no seat (Seated), a scored one at a closed seat (Present), or one that
 * scores past its seat's cap (Capped). */
const broken = (state: State): boolean =>
	Arr.some([...state.presences.values()], (p) => {
		const seat = state.seats.get(keyOf(p.child, p.slot))
		return seat === undefined || (p.score > 0 && seat.open !== 1) || p.score > seat.cap
	})

/** Whether `state` breaks Seated, the foreign key, which no rule judges, so its refusal may name no rule. */
const unseated = (state: State): boolean =>
	Arr.some([...state.presences.values()], (p) => !state.seats.has(keyOf(p.child, p.slot)))

/** The names a shape's writes spell: its seat's table and columns, its presence's. */
const spelling = (installed: Installed, shape: Shape) => {
	const names = namesOf(installed)
	const presence = {
		table: names.table(Presence),
		child: names.column(Presence, "child"),
		slot: names.column(Presence, "slot"),
		score: names.column(Presence, "score")
	}
	switch (shape) {
		case "one unit":
			return {
				presence,
				seat: {
					table: names.table(Seat),
					child: names.column(Seat, "child"),
					slot: names.column(Seat, "slot"),
					cap: names.column(Seat, "cap"),
					open: names.column(Seat, "open")
				}
			}
		case "two units":
			return {
				presence,
				seat: {
					table: names.table(Bench),
					child: names.column(Bench, "pupil"),
					slot: names.column(Bench, "slot"),
					cap: names.column(Bench, "cap"),
					open: names.column(Bench, "open")
				}
			}
	}
}

type Spelling = ReturnType<typeof spelling>

/** The INSERT of `seats` and of `presences`, one statement each where any stands. */
const seeded = (
	n: Spelling,
	seats: ReadonlyArray<SeatRow>,
	presences: ReadonlyArray<PresenceRow>
): ReadonlyArray<string> => [
	...(Arr.isReadonlyArrayNonEmpty(seats)
		? [
				`INSERT INTO ${n.seat.table} (${n.seat.child}, ${n.seat.slot}, ${n.seat.cap}, ${n.seat.open}) VALUES ${Arr.join(
					Arr.map(seats, (r) => `(${r.child}, ${r.slot}, ${r.cap}, ${r.open})`),
					", "
				)}`
			]
		: []),
	...(Arr.isReadonlyArrayNonEmpty(presences)
		? [
				`INSERT INTO ${n.presence.table} (${n.presence.child}, ${n.presence.slot}, ${n.presence.score}) VALUES ${Arr.join(
					Arr.map(presences, (r) => `(${r.child}, ${r.slot}, ${r.score})`),
					", "
				)}`
			]
		: [])
]

/** The statement of `op`. */
const statementOf = (n: Spelling, op: Op): string => {
	switch (op.kind) {
		case "put seat":
			return `INSERT INTO ${n.seat.table} (${n.seat.child}, ${n.seat.slot}, ${n.seat.cap}, ${n.seat.open}) VALUES (${op.row.child}, ${op.row.slot}, ${op.row.cap}, ${op.row.open}) ON CONFLICT (${n.seat.child}, ${n.seat.slot}) DO UPDATE SET ${n.seat.cap} = EXCLUDED.${n.seat.cap}, ${n.seat.open} = EXCLUDED.${n.seat.open}`
		case "put presence":
			return `INSERT INTO ${n.presence.table} (${n.presence.child}, ${n.presence.slot}, ${n.presence.score}) VALUES (${op.row.child}, ${op.row.slot}, ${op.row.score}) ON CONFLICT (${n.presence.child}, ${n.presence.slot}) DO UPDATE SET ${n.presence.score} = EXCLUDED.${n.presence.score}`
		case "update seat":
			return `UPDATE ${n.seat.table} SET ${n.seat.cap} = ${op.row.cap}, ${n.seat.open} = ${op.row.open} WHERE ${n.seat.child} = ${op.row.child} AND ${n.seat.slot} = ${op.row.slot}`
		case "update presence":
			return `UPDATE ${n.presence.table} SET ${n.presence.score} = ${op.row.score} WHERE ${n.presence.child} = ${op.row.child} AND ${n.presence.slot} = ${op.row.slot}`
		case "delete seat":
			return `DELETE FROM ${n.seat.table} WHERE ${n.seat.child} = ${op.child} AND ${n.seat.slot} = ${op.slot}`
		case "delete presence":
			return `DELETE FROM ${n.presence.table} WHERE ${n.presence.child} = ${op.child} AND ${n.presence.slot} = ${op.slot}`
	}
}

/**
 * The judge's verdict on the state the transaction holds, its rules' checks first held to their violation queries: each
 * rule's check over every row, the one a migration runs, finds a row exactly where its violation query lowered by the
 * oracle baseline does; then SET CONSTRAINTS ALL IMMEDIATE runs the judge over the units the transaction wrote since it
 * last ran, and every deferred law.
 */
const judged = (installed: Installed, connection: PgConnection, where: string) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const baselines = baselineRuleChecks(installation)
		for (const [i, check] of lawChecks(installation).rules.entries()) {
			const baseline = baselines[i]
			assert.ok(baseline?.law === check.law, "one baseline per rule, in law order")
			const violated =
				(yield* connection.queryValues(
					`SELECT EXISTS (${printStatement(baseline.query)})`,
					[]
				))[0]?.[0] === true
			const found = (yield* connection.queryValues(foundQueryOf(check.query), []))[0]?.[0] === true
			assert.equal(
				found,
				violated,
				`the check over every row agrees with its violation query, ${where}`
			)
		}
		return yield* refusalOf(connection.query("SET CONSTRAINTS ALL IMMEDIATE", []))
	})

/**
 * Whether the transaction refuses the state it holds, its write `sql` run: refused at the write, where a law of its own
 * statement refuses it (a foreign key held at every statement), or by the judge (`judged`). A refusal is an integrity
 * SQLSTATE; the names the judge raises under come with it.
 */
const refused = (
	installed: Installed,
	connection: PgConnection,
	sql: ReadonlyArray<string>,
	where: string
) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const atWrite = yield* refusalOf(
			Effect.forEach(sql, (statement) => connection.query(statement, []), { discard: true })
		)
		const refusal = Option.isSome(atWrite) ? atWrite : yield* judged(installed, connection, where)
		if (Option.isSome(refusal)) {
			assert.ok(
				Arr.contains(["23503", "23505", "23514"], refusal.value.code),
				`refused under ${refusal.value.code}, an integrity SQLSTATE, ${where}`
			)
		}
		return { refusal, raised: Arr.getSomes(Arr.map(judgedStatementsOf(installation), raisedRule)) }
	})

/**
 * One case in its one transaction, which the case's end rolls back: the shape's rules judged as it says, whole where
 * Presence and Seat sit in one unit, probed where their rows sit in two; the lawful state written and judged; then each
 * write, the constraints deferred again before it, judged as the state it leaves breaks a law or none, until one is
 * refused.
 */
export const runOpen = (
	installed: Installed,
	connection: PgConnection,
	drawn: OpenCase,
	c: Case<OpenFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(connection, installed.installation)
		const rules = installed.installation.laws.rules
		const whole = drawn.shape === "one unit"
		assert.ok(
			Arr.isReadonlyArrayNonEmpty(rules) &&
				Arr.every(rules, (r) => (r.rule.kind === "whole") === whole),
			whole
				? "every rule over Presence and Seat, one unit's mutable relations, is judged whole"
				: "every rule over Presence and Bench, two units' mutable relations, is probed"
		)
		c.note(whole ? "judged whole in one unit" : "probed across two units")
		const n = spelling(installed, drawn.shape)
		const seed: State = {
			seats: new Map(Arr.map(drawn.seats, (r) => [keyOf(r.child, r.slot), r] as const)),
			presences: new Map(Arr.map(drawn.presences, (r) => [keyOf(r.child, r.slot), r] as const))
		}
		const first = yield* refused(
			installed,
			connection,
			seeded(n, drawn.seats, drawn.presences),
			`${Formatter.format(drawn)}, its lawful state`
		)
		assert.ok(Option.isNone(first.refusal), "the judge accepts the lawful state written first")
		let state = seed
		for (const [i, op] of drawn.ops.entries()) {
			yield* connection.query("SET CONSTRAINTS ALL DEFERRED", [])
			state = applied(state, op)
			const lawless = broken(state)
			const where = `${Formatter.format(drawn)}, at write ${i}`
			const verdict = yield* refused(installed, connection, [statementOf(n, op)], where)
			assert.equal(
				Option.isSome(verdict.refusal),
				lawless,
				`the transaction ${Option.isSome(verdict.refusal) ? "refused" : "accepted"} a state that breaks ${lawless ? "a law" : "none"}, ${where}`
			)
			if (Option.isSome(verdict.refusal)) {
				if (whole && !unseated(state)) {
					assert.ok(
						verdict.refusal.value.constraint !== undefined &&
							Arr.contains(verdict.raised, verdict.refusal.value.constraint),
						`refused under ${verdict.refusal.value.constraint ?? "no constraint"}, a rule's, ${where}`
					)
				}
				if (op.kind !== "delete presence") {
					c.note(`${op.kind} refused`)
				}
				return
			}
			c.note(`${op.kind} accepted`)
		}
	})
