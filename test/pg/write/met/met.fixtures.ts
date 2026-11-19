/** What the properties of met.test.ts read: its spaces, models and helpers. */

import { deepEquals } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import type { WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import type { Witness } from "#compiler/types/changeset/changeset.ts"
import type { WriteAnswer } from "#test/support/calls.ts"
import { rigTemplate } from "#test/support/schedules/rig.ts"

const Krc = relation("Krc", { k: pg.integer, a: pg.integer, b: pg.integer }, ["k"])

const Kser = relation("Kser", { k: pg.integer, a: pg.integer, b: pg.integer }, ["k"])

const Prc = relation("Prc", { k: pg.integer, a: pg.integer }, ["k", "a"])

const Pser = relation("Pser", { k: pg.integer, a: pg.integer }, ["k", "a"])
const Qrc = relation("Qrc", { k: pg.integer, a: pg.integer }, ["k"])
const Qser = relation("Qser", { k: pg.integer, a: pg.integer }, ["k"])
const Orc = relation("Orc", { k: pg.integer }, ["k"])
const Oser = relation("Oser", { k: pg.integer }, ["k"])

/** The relations by name, each with its shape and the level its inserting role runs at. */
export const shapes = {
	Krc: { shape: "keyed", level: "readCommitted" },
	Kser: { shape: "keyed", level: "serializable" },
	Prc: { shape: "set", level: "readCommitted" },
	Pser: { shape: "set", level: "serializable" },
	Qrc: { shape: "queried", level: "readCommitted" },
	Qser: { shape: "queried", level: "serializable" },
	Orc: { shape: "queriedOne", level: "readCommitted" },
	Oser: { shape: "queriedOne", level: "serializable" }
} as const

export type Name = keyof typeof shapes

type Shape = (typeof shapes)[Name]["shape"]

const names: Arr.NonEmptyReadonlyArray<Name> = [
	"Krc",
	"Kser",
	"Prc",
	"Pser",
	"Qrc",
	"Qser",
	"Orc",
	"Oser"
]

/** The schema, its roles and logins, and one member per relation inserting its rows and reading back both sides. */
export const metSchema = (name: string) => {
	const base = schema(name, [Krc, Kser, Prc, Pser, Qrc, Qser, Orc, Oser], [])
	const rc = role(base, "rc", { Krc, Prc, Qrc, Orc }, { insert: ["Krc", "Prc", "Qrc", "Orc"] })
	const ser = role(
		base,
		"ser",
		{ Kser, Pser, Qser, Oser },
		{ insert: ["Kser", "Pser", "Qser", "Oser"] }
	)
	const direct = role(
		base,
		"direct",
		{ Kser, Pser, Qser, Oser },
		{ write: ["Kser", "Pser", "Qser", "Oser"] }
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
					Qrc: ChangeSet.empty(rc)
						.insert(
							rc.relations.Qrc,
							query(rc).rule((r) => {
								const rows = r.relation("rows", { k: Qrc.fields.k, a: Qrc.fields.a })
								const { k, a } = v(rows, "row")
								return r.match(rows, { k, a }).find({ k, a })
							})
						)
						.read("added", (d) =>
							query(rc).rule((r) => {
								const { k, a } = v(d.added(rc.relations.Qrc), "row")
								return r.match(d.added(rc.relations.Qrc), { k, a }).find({ k, a })
							})
						)
						.read("met", (d) =>
							query(rc).rule((r) => {
								const { k, a } = v(d.met(rc.relations.Qrc), "row")
								return r.match(d.met(rc.relations.Qrc), { k, a }).find({ k, a })
							})
						),
					Orc: ChangeSet.empty(rc)
						.insert(
							rc.relations.Orc,
							query(rc).rule((r) => {
								const rows = r.relation("rows", { k: Orc.fields.k })
								const { k } = v(rows, "row")
								return r.match(rows, { k }).find({ k })
							})
						)
						.read("added", (d) =>
							query(rc).rule((r) => {
								const { k } = v(d.added(rc.relations.Orc), "row")
								return r.match(d.added(rc.relations.Orc), { k }).find({ k })
							})
						)
						.read("met", (d) =>
							query(rc).rule((r) => {
								const { k } = v(d.met(rc.relations.Orc), "row")
								return r.match(d.met(rc.relations.Orc), { k }).find({ k })
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
					Qser: ChangeSet.empty(ser)
						.insert(
							ser.relations.Qser,
							query(ser).rule((r) => {
								const rows = r.relation("rows", { k: Qser.fields.k, a: Qser.fields.a })
								const { k, a } = v(rows, "row")
								return r.match(rows, { k, a }).find({ k, a })
							})
						)
						.read("added", (d) =>
							query(ser).rule((r) => {
								const { k, a } = v(d.added(ser.relations.Qser), "row")
								return r.match(d.added(ser.relations.Qser), { k, a }).find({ k, a })
							})
						)
						.read("met", (d) =>
							query(ser).rule((r) => {
								const { k, a } = v(d.met(ser.relations.Qser), "row")
								return r.match(d.met(ser.relations.Qser), { k, a }).find({ k, a })
							})
						),
					Oser: ChangeSet.empty(ser)
						.insert(
							ser.relations.Oser,
							query(ser).rule((r) => {
								const rows = r.relation("rows", { k: Oser.fields.k })
								const { k } = v(rows, "row")
								return r.match(rows, { k }).find({ k })
							})
						)
						.read("added", (d) =>
							query(ser).rule((r) => {
								const { k } = v(d.added(ser.relations.Oser), "row")
								return r.match(d.added(ser.relations.Oser), { k }).find({ k })
							})
						)
						.read("met", (d) =>
							query(ser).rule((r) => {
								const { k } = v(d.met(ser.relations.Oser), "row")
								return r.match(d.met(ser.relations.Oser), { k }).find({ k })
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

/** Whether a shape states a, and whether it states b. */
const statesA = (shape: Shape): boolean => shape !== "queriedOne"
const statesB = (shape: Shape): boolean => shape === "keyed"

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
	shape === "set" || shape === "queriedOne" ? ["repeat", "free"] : ["repeat", "differing", "free"]

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
	...(shape === "keyed" || shape === "queried" ? (["refused at a differing key"] as const) : [])
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
export const byKey: Order.Order<Fact> = Order.combine(
	Order.mapInput(Order.Number, (r: Fact) => r.k),
	Order.mapInput(Order.Number, (r: Fact) => r.a)
)

/** What a call answered, the same for every relation's member: committed, with its added count and both sides it read
 * back; refused, with its witness; or any other answer, which the property refuses. */
export type Answer =
	| {
			readonly kind: "committed"
			readonly outcome: "accepted" | "unchanged"
			readonly added: bigint
			readonly addedRows: ReadonlyArray<Fact>
			readonly metRows: ReadonlyArray<Fact>
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
	toRow: (r: R) => Fact
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

/** Fact readers of each shape's read-back row. */
export const keyedRow = (r: {
	readonly k: number
	readonly a: number
	readonly b: number
}): Fact => ({
	k: r.k,
	a: r.a,
	b: r.b
})
export const pairRow = (r: { readonly k: number; readonly a: number }): Fact => ({
	k: r.k,
	a: r.a,
	b: 0
})
export const oneRow = (r: { readonly k: number }): Fact => ({ k: r.k, a: 0, b: 0 })

export const relations = { Krc, Kser, Prc, Pser, Qrc, Qser, Orc, Oser } as const

export const columnsOf = (n: Name): ReadonlyArray<string> => {
	const { shape } = shapes[n]
	return ["k", ...(statesA(shape) ? ["a"] : []), ...(statesB(shape) ? ["b"] : [])]
}

/** The schedule's installation made once per member (support/schedules/rig.ts rigTemplate), which each case's seat holds. */
export const metRig = rigTemplate(import.meta, "met", metSchema)
