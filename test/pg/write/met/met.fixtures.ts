/** What the properties of met.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import type { WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import type { Witness } from "#compiler/types/changeset/changeset.ts"
import { deepEquals } from "#test/support/assert.ts"
import type { WriteAnswer } from "#test/support/calls.ts"
import { rigTemplate } from "#test/support/schedules/rig.ts"

const Krc = relation("Krc", { k: pg.integer, a: pg.integer, b: pg.integer }, ["k"])

const Kser = relation("Kser", { k: pg.integer, a: pg.integer, b: pg.integer }, ["k"])

const Prc = relation("Prc", { k: pg.integer, a: pg.integer }, ["k", "a"])

const Pser = relation("Pser", { k: pg.integer, a: pg.integer }, ["k", "a"])

const Drc = relation("Drc", { id: pg.uuidv7, k: pg.integer, a: pg.integer }, ["id"])

const Dser = relation("Dser", { id: pg.uuidv7, k: pg.integer, a: pg.integer }, ["id"])

const Erc = relation("Erc", { id: pg.uuidv7, k: pg.integer }, ["id"])

const Eser = relation("Eser", { id: pg.uuidv7, k: pg.integer }, ["id"])

/** The relations by name, each with its shape and the level its inserting role runs at. */
export const shapes = {
	Krc: { shape: "keyed", level: "readCommitted" },
	Kser: { shape: "keyed", level: "serializable" },
	Prc: { shape: "set", level: "readCommitted" },
	Pser: { shape: "set", level: "serializable" },
	Drc: { shape: "drawn", level: "readCommitted" },
	Dser: { shape: "drawn", level: "serializable" },
	Erc: { shape: "drawnSet", level: "readCommitted" },
	Eser: { shape: "drawnSet", level: "serializable" }
} as const

export type Name = keyof typeof shapes

type Shape = (typeof shapes)[Name]["shape"]

const names: Arr.NonEmptyReadonlyArray<Name> = [
	"Krc",
	"Kser",
	"Prc",
	"Pser",
	"Drc",
	"Dser",
	"Erc",
	"Eser"
]

/** The schema, its roles and logins, and one member per relation inserting its rows and reading back both sides. */
export const metSchema = (name: string) => {
	const base = schema(
		name,
		[Krc, Kser, Prc, Pser, Drc, Dser, Erc, Eser],
		[key(on(Drc, "k")), key(on(Dser, "k")), key(on(Erc, "k")), key(on(Eser, "k"))]
	)
	const rc = role(base, "rc", { Krc, Prc, Drc, Erc }, { insert: ["Krc", "Prc", "Drc", "Erc"] })
	const ser = role(
		base,
		"ser",
		{ Kser, Pser, Dser, Eser },
		{ insert: ["Kser", "Pser", "Dser", "Eser"] }
	)
	const direct = role(
		base,
		"direct",
		{ Kser, Pser, Dser, Eser },
		{ write: ["Kser", "Pser", "Dser", "Eser"] }
	)
	return {
		schema: base,
		rc,
		ser,
		direct,
		server: login(base, "server", [rc, ser], {
			workload: [
				workload(rc, {
					Krc: ChangeSet.empty(rc)
						.insert(rc.relations.Krc, [])
						.read("added", (d) =>
							query(rc).rule((r) => {
								const { k, a, b } = v(d.added(rc.relations.Krc), "row")
								return r.match(d.added(rc.relations.Krc), { k, a, b }).find({ k, a, b })
							})
						)
						.read("met", (d) =>
							query(rc).rule((r) => {
								const { k, a, b } = v(d.met(rc.relations.Krc), "row")
								return r.match(d.met(rc.relations.Krc), { k, a, b }).find({ k, a, b })
							})
						),
					Prc: ChangeSet.empty(rc)
						.insert(rc.relations.Prc, [])
						.read("added", (d) =>
							query(rc).rule((r) => {
								const { k, a } = v(d.added(rc.relations.Prc), "row")
								return r.match(d.added(rc.relations.Prc), { k, a }).find({ k, a })
							})
						)
						.read("met", (d) =>
							query(rc).rule((r) => {
								const { k, a } = v(d.met(rc.relations.Prc), "row")
								return r.match(d.met(rc.relations.Prc), { k, a }).find({ k, a })
							})
						),
					Drc: ChangeSet.empty(rc)
						.insert(
							rc.relations.Drc,
							query(rc).rule((r) => {
								const rows = r.relation("rows", { k: Drc.fields.k, a: Drc.fields.a })
								const { k, a } = v(rows, "row")
								return r.match(rows, { k, a }).find({ k, a })
							})
						)
						.read("added", (d) =>
							query(rc).rule((r) => {
								const { id, k, a } = v(d.added(rc.relations.Drc), "row")
								return r.match(d.added(rc.relations.Drc), { id, k, a }).find({ id, k, a })
							})
						)
						.read("met", (d) =>
							query(rc).rule((r) => {
								const { id, k, a } = v(d.met(rc.relations.Drc), "row")
								return r.match(d.met(rc.relations.Drc), { id, k, a }).find({ id, k, a })
							})
						),
					Erc: ChangeSet.empty(rc)
						.insert(
							rc.relations.Erc,
							query(rc).rule((r) => {
								const rows = r.relation("rows", { k: Erc.fields.k })
								const { k } = v(rows, "row")
								return r.match(rows, { k }).find({ k })
							})
						)
						.read("added", (d) =>
							query(rc).rule((r) => {
								const { id, k } = v(d.added(rc.relations.Erc), "row")
								return r.match(d.added(rc.relations.Erc), { id, k }).find({ id, k })
							})
						)
						.read("met", (d) =>
							query(rc).rule((r) => {
								const { id, k } = v(d.met(rc.relations.Erc), "row")
								return r.match(d.met(rc.relations.Erc), { id, k }).find({ id, k })
							})
						)
				}),
				workload(ser, {
					Kser: ChangeSet.empty(ser)
						.insert(ser.relations.Kser, [])
						.read("added", (d) =>
							query(ser).rule((r) => {
								const { k, a, b } = v(d.added(ser.relations.Kser), "row")
								return r.match(d.added(ser.relations.Kser), { k, a, b }).find({ k, a, b })
							})
						)
						.read("met", (d) =>
							query(ser).rule((r) => {
								const { k, a, b } = v(d.met(ser.relations.Kser), "row")
								return r.match(d.met(ser.relations.Kser), { k, a, b }).find({ k, a, b })
							})
						),
					Pser: ChangeSet.empty(ser)
						.insert(ser.relations.Pser, [])
						.read("added", (d) =>
							query(ser).rule((r) => {
								const { k, a } = v(d.added(ser.relations.Pser), "row")
								return r.match(d.added(ser.relations.Pser), { k, a }).find({ k, a })
							})
						)
						.read("met", (d) =>
							query(ser).rule((r) => {
								const { k, a } = v(d.met(ser.relations.Pser), "row")
								return r.match(d.met(ser.relations.Pser), { k, a }).find({ k, a })
							})
						),
					Dser: ChangeSet.empty(ser)
						.insert(
							ser.relations.Dser,
							query(ser).rule((r) => {
								const rows = r.relation("rows", { k: Dser.fields.k, a: Dser.fields.a })
								const { k, a } = v(rows, "row")
								return r.match(rows, { k, a }).find({ k, a })
							})
						)
						.read("added", (d) =>
							query(ser).rule((r) => {
								const { id, k, a } = v(d.added(ser.relations.Dser), "row")
								return r.match(d.added(ser.relations.Dser), { id, k, a }).find({ id, k, a })
							})
						)
						.read("met", (d) =>
							query(ser).rule((r) => {
								const { id, k, a } = v(d.met(ser.relations.Dser), "row")
								return r.match(d.met(ser.relations.Dser), { id, k, a }).find({ id, k, a })
							})
						),
					Eser: ChangeSet.empty(ser)
						.insert(
							ser.relations.Eser,
							query(ser).rule((r) => {
								const rows = r.relation("rows", { k: Eser.fields.k })
								const { k } = v(rows, "row")
								return r.match(rows, { k }).find({ k })
							})
						)
						.read("added", (d) =>
							query(ser).rule((r) => {
								const { id, k } = v(d.added(ser.relations.Eser), "row")
								return r.match(d.added(ser.relations.Eser), { id, k }).find({ id, k })
							})
						)
						.read("met", (d) =>
							query(ser).rule((r) => {
								const { id, k } = v(d.met(ser.relations.Eser), "row")
								return r.match(d.met(ser.relations.Eser), { id, k }).find({ id, k })
							})
						)
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** A fact of any of the shapes as stated: its key k and, where the shape has them, a and b, 0 where it has none. */
export interface Fact {
	readonly k: number
	readonly a: number
	readonly b: number
}

/** A stored or read-back row of any shape: its fact, and its id where the shape draws one. */
export interface Row extends Fact {
	readonly id: Option.Option<string>
}

/** What a request is to the stored state: a copy of a stored fact, one at a stored key with another payload, or one at
 * a free key. */
type RequestKind = "repeat" | "differing" | "free"

export interface Request {
	readonly kind: RequestKind
	readonly fact: Fact
}

interface Met {
	readonly relation: Name
	readonly stored: ReadonlyArray<Fact>
	readonly requests: ReadonlyArray<Request>
}

/** Whether a shape states a, whether it states b, and whether it draws an id. */
const statesA = (shape: Shape): boolean => shape !== "drawnSet"

const statesB = (shape: Shape): boolean => shape === "keyed"

export const drawsId = (shape: Shape): boolean => shape === "drawn" || shape === "drawnSet"

/** A fact as `shape` states it: the fields it lacks at 0. */
const asStated = (shape: Shape, f: Fact): Fact => ({
	k: f.k,
	a: statesA(shape) ? f.a : 0,
	b: statesB(shape) ? f.b : 0
})

/** Whether two facts share the key a fact is met at: the pure set's whole fact, every other shape's k. */
export const sameKey = (shape: Shape, x: Fact, y: Fact): boolean =>
	x.k === y.k && (shape !== "set" || x.a === y.a)

/** The kinds of request a shape draws: a set's facts never differ at their key. */
const kindsOf = (shape: Shape): Arr.NonEmptyReadonlyArray<RequestKind> =>
	shape === "set" || shape === "drawnSet" ? ["repeat", "free"] : ["repeat", "differing", "free"]

export const metGen: Gen<Met> = (source) => {
	const relation = source.draw(element(names))
	const { shape } = shapes[relation]
	const factGen: Gen<Fact> = (s) =>
		asStated(shape, { k: s.draw(int(1, 4)), a: s.draw(int(0, 1)), b: s.draw(int(0, 1)) })
	const stored = Arr.dedupeWith(source.draw(array(factGen, { min: 0, max: 3 })), (x, y) =>
		sameKey(shape, x, y)
	)
	const requestGen: Gen<Request> = (s) => ({
		kind: s.draw(element(kindsOf(shape))),
		fact: s.draw(factGen)
	})
	const requests = Arr.flatMap(
		source.draw(array(requestGen, { min: 1, max: 3 })),
		(r): ReadonlyArray<Request> => {
			const at = Arr.findFirst(stored, (f) => sameKey(shape, f, r.fact))
			switch (r.kind) {
				case "free":
					return Option.isNone(at) ? [r] : []
				case "repeat":
					return Option.match(at, {
						onNone: (): ReadonlyArray<Request> => [],
						onSome: (f): ReadonlyArray<Request> => [{ kind: "repeat", fact: f }]
					})
				case "differing":
					return Option.match(at, {
						onNone: (): ReadonlyArray<Request> => [],
						onSome: (f): ReadonlyArray<Request> => (deepEquals(f, r.fact) ? [] : [r])
					})
			}
		}
	)
	return {
		relation,
		stored,
		requests: Arr.dedupeWith(requests, (x, y) => sameKey(shape, x.fact, y.fact))
	}
}

type MetSituation =
	| "met"
	| "added beside met"
	| "refused at a differing key"
	| "unchanged, met only"

export type MetFeature = `${Name}: ${MetSituation}`

/** The situations a relation's cases must reach: a set's facts never differ at their key. */
const situationsOf = (shape: Shape): Arr.NonEmptyReadonlyArray<MetSituation> => [
	"met",
	"added beside met",
	"unchanged, met only",
	...(shape === "keyed" || shape === "drawn" ? (["refused at a differing key"] as const) : [])
]

export const metFeatures: Arr.NonEmptyReadonlyArray<MetFeature> = Arr.flatMap(
	names,
	(n): Arr.NonEmptyReadonlyArray<MetFeature> =>
		Arr.map(situationsOf(shapes[n].shape), (situation): MetFeature => `${n}: ${situation}`)
)

/**
 * A case of `relation` constructed to reach `situation`, its values drawn: one stored fact and its repeat; beside the
 * repeat, for "added beside met", a request at the next key, which no stored fact holds; for "refused at a differing
 * key", in its place a request at the stored key whose a differs.
 */
const reaching =
	(relation: Name, situation: MetSituation): Gen<Met> =>
	(source) => {
		const { shape } = shapes[relation]
		const stored = asStated(shape, {
			k: source.draw(int(1, 4)),
			a: source.draw(int(0, 1)),
			b: source.draw(int(0, 1))
		})
		const repeat: Request = { kind: "repeat", fact: stored }
		switch (situation) {
			case "met":
			case "unchanged, met only":
				return { relation, stored: [stored], requests: [repeat] }
			case "added beside met":
				return {
					relation,
					stored: [stored],
					requests: [repeat, { kind: "free", fact: { ...stored, k: (stored.k % 4) + 1 } }]
				}
			case "refused at a differing key":
				return {
					relation,
					stored: [stored],
					requests: [{ kind: "differing", fact: { ...stored, a: 1 - stored.a } }]
				}
		}
	}

/**
 * Each required situation with the cases constructed to reach it: a witness whose turn aims at a pending one draws such
 * a case (aimed), the case it runs, prints and keeps, so the cases of one window aim at distinct pending situations.
 */
export const aims: ReadonlyArray<readonly [MetFeature, Gen<Met>]> = Arr.flatMap(names, (n) =>
	Arr.map(
		situationsOf(shapes[n].shape),
		(situation) => [`${n}: ${situation}`, reaching(n, situation)] as const
	)
)

/** Rows in one order: by k, then a. */
export const byKey: Order.Order<Row> = Order.combine(
	Order.mapInput(Order.Number, (r: Row) => r.k),
	Order.mapInput(Order.Number, (r: Row) => r.a)
)

/** What a call answered, the same for every relation's member: committed, with its added count and both sides it read
 * back; refused, with its witness; or any other answer, which the property refuses. */
export type Answer =
	| {
			readonly kind: "committed"
			readonly outcome: "accepted" | "unchanged"
			readonly added: bigint
			readonly addedRows: ReadonlyArray<Row>
			readonly metRows: ReadonlyArray<Row>
	  }
	| { readonly kind: "refused"; readonly witness: Witness }
	| { readonly kind: "other"; readonly shown: string }

/** A member's call as an Answer, each read-back row through `toRow`. */
export const answerOf = <R, E, Q>(
	relation: Name,
	call: Effect.Effect<
		WriteAnswer<WriteOutcome<{ readonly added: ReadonlyArray<R>; readonly met: ReadonlyArray<R> }>>,
		E,
		Q
	>,
	toRow: (r: R) => Row
): Effect.Effect<Answer, never, Q> =>
	Effect.map(Effect.result(call), (ran): Answer => {
		if (Result.isFailure(ran)) {
			return { kind: "other", shown: Formatter.format(ran.failure) }
		}
		const answer = ran.success
		switch (answer.kind) {
			case "refused":
				return { kind: "refused", witness: answer.witness }
			case "outsideWorld":
				return { kind: "other", shown: Formatter.format(answer) }
			case "accepted":
			case "unchanged":
				return {
					kind: "committed",
					outcome: answer.kind,
					added:
						answer.kind === "accepted"
							? Option.getOrElse(
									Option.map(
										Arr.findFirst(answer.counts, (x) => x.relation === relation),
										(x) => x.added
									),
									() => 0n
								)
							: 0n,
					addedRows: Arr.map(answer.reads.added, toRow),
					metRows: Arr.map(answer.reads.met, toRow)
				}
		}
	})

/** Row readers of each shape's read-back row. */
export const keyedRow = (r: {
	readonly k: number
	readonly a: number
	readonly b: number
}): Row => ({
	k: r.k,
	a: r.a,
	b: r.b,
	id: Option.none()
})

export const setRow = (r: { readonly k: number; readonly a: number }): Row => ({
	k: r.k,
	a: r.a,
	b: 0,
	id: Option.none()
})

export const drawnRow = (r: {
	readonly id: string
	readonly k: number
	readonly a: number
}): Row => ({
	k: r.k,
	a: r.a,
	b: 0,
	id: Option.some(r.id)
})

export const drawnSetRow = (r: { readonly id: string; readonly k: number }): Row => ({
	k: r.k,
	a: 0,
	b: 0,
	id: Option.some(r.id)
})

export const relations = { Krc, Kser, Prc, Pser, Drc, Dser, Erc, Eser } as const

export const columnsOf = (n: Name): ReadonlyArray<string> => {
	const { shape } = shapes[n]
	return [
		"k",
		...(statesA(shape) ? ["a"] : []),
		...(statesB(shape) ? ["b"] : []),
		...(drawsId(shape) ? ["id"] : [])
	]
}

/** The schedule's installation made once per member (support/schedules/rig.ts rigTemplate), which each case's seat holds. */
export const metRig = rigTemplate(import.meta, "met", metSchema)
