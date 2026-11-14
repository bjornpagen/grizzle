/**
 * The rows an insertion met (README, "Rows an insertion met"), against PostgreSQL 19, at both levels and in every form
 * an insert arbitrates by (write/insert/protocol.ts Arbitration).
 *
 * Four shapes of relation, each twice: K (k, a, b), keyed by k, complete facts with a payload; P (k, a), a pure set; D
 * (id, k, a), its id drawn by uuidv7() and declared keyed by k, a generated addition arbitrated at k with a payload;
 * and E (id, k), the same with none. The role `rc` inserts the four `…rc` relations and nothing else, so generate
 * certifies it READ COMMITTED (the case requires it): each insert is the `returned` form, ON CONFLICT DO SELECT, met
 * rows returned by the arbiter. The role `ser` inserts the four `…ser` relations, which the role `direct` deletes, so
 * it runs SERIALIZABLE: K and P are the `every` form, complete facts met under the transaction snapshot, and D and E the
 * `returned` form with each met row read again under it. Each relation's member inserts its rows and reads back
 * delta.added and delta.met of it, every field: K's and P's an array of them, and D's and E's a query over the call's
 * relation parameter `rows`, whose head leaves the id out, so every row is a generated addition. An array of D's or E's
 * rows would be two insertions, one of the rows that state the id and one of those that leave it out, so its added and
 * met sides would be two statements' and the read-back refused (README "Where a read-back runs").
 *
 * Each case stores up to three facts of one relation and inserts one to three requests into it, each a copy of a
 * stored fact (an exact repeat), a fact at a stored key with another payload, or a fact at a free key, at distinct keys.
 *
 * Properties, per case:
 * - A request at a stored key whose payload differs refuses the call on that key's law, its witness one of those keys,
 *   and the table is unchanged.
 * - Otherwise the call is accepted where it adds a request and unchanged where it adds none, with that count; it reads
 *   back as added exactly the rows it made, their drawn ids as stored, and as met exactly the stored rows at the keys
 *   it repeats, each whole, its id included; and the table holds the stored facts and the ones it made.
 *
 * Oracle: specification, the insertion over the stated rows: an exact repeat meets its stored fact, a differing one
 * refuses its key, any other is added.
 *
 * Features: each relation met, added beside met, unchanged with met rows only, and, where its facts have a payload,
 * refused at a differing key. A witness whose turn aims at a pending one runs a case constructed to reach it.
 *
 * Plants: ~/.cache/grizzle-release/DELTAMET/plants/met-marker-inverted.patch, the `returned` form's met marker read as
 * inserted, must turn the property red; ~/.cache/grizzle-release/DELTAMET/plants/met-result-every-row.patch, the
 * insert's own rows every verdict row but a refusal's, met rows counted as added, must turn it red; and
 * ~/.cache/grizzle-release/DELTAMET/plants/met-occupant-met.patch, occupantVerdict answering met for an insertion, a
 * differing occupant met where its key's law refuses it, must turn it red.
 */
import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import type { WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { Witness } from "#compiler/types/changeset/changeset.ts"
import { assert, deepEquals } from "#test/support/assert.ts"
import { answered, type WriteAnswer } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { openRig } from "#test/support/schedules/rig.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Krc = relation("Krc", { k: pg.integer, a: pg.integer, b: pg.integer }, ["k"])
const Kser = relation("Kser", { k: pg.integer, a: pg.integer, b: pg.integer }, ["k"])
const Prc = relation("Prc", { k: pg.integer, a: pg.integer }, ["k", "a"])
const Pser = relation("Pser", { k: pg.integer, a: pg.integer }, ["k", "a"])
const Drc = relation("Drc", { id: pg.uuidv7, k: pg.integer, a: pg.integer }, ["id"])
const Dser = relation("Dser", { id: pg.uuidv7, k: pg.integer, a: pg.integer }, ["id"])
const Erc = relation("Erc", { id: pg.uuidv7, k: pg.integer }, ["id"])
const Eser = relation("Eser", { id: pg.uuidv7, k: pg.integer }, ["id"])

/** The relations by name, each with its shape and the level its inserting role runs at. */
const shapes = {
	Krc: { shape: "keyed", level: "readCommitted" },
	Kser: { shape: "keyed", level: "serializable" },
	Prc: { shape: "set", level: "readCommitted" },
	Pser: { shape: "set", level: "serializable" },
	Drc: { shape: "drawn", level: "readCommitted" },
	Dser: { shape: "drawn", level: "serializable" },
	Erc: { shape: "drawnSet", level: "readCommitted" },
	Eser: { shape: "drawnSet", level: "serializable" }
} as const

type Name = keyof typeof shapes
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
const metSchema = (name: string) => {
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
interface Fact {
	readonly k: number
	readonly a: number
	readonly b: number
}

/** A stored or read-back row of any shape: its fact, and its id where the shape draws one. */
interface Row extends Fact {
	readonly id: Option.Option<string>
}

/** What a request is to the stored state: a copy of a stored fact, one at a stored key with another payload, or one at
 * a free key. */
type RequestKind = "repeat" | "differing" | "free"

interface Request {
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
const drawsId = (shape: Shape): boolean => shape === "drawn" || shape === "drawnSet"

/** A fact as `shape` states it: the fields it lacks at 0. */
const asStated = (shape: Shape, f: Fact): Fact => ({
	k: f.k,
	a: statesA(shape) ? f.a : 0,
	b: statesB(shape) ? f.b : 0
})

/** Whether two facts share the key a fact is met at: the pure set's whole fact, every other shape's k. */
const sameKey = (shape: Shape, x: Fact, y: Fact): boolean =>
	x.k === y.k && (shape !== "set" || x.a === y.a)

/** The kinds of request a shape draws: a set's facts never differ at their key. */
const kindsOf = (shape: Shape): Arr.NonEmptyReadonlyArray<RequestKind> =>
	shape === "set" || shape === "drawnSet" ? ["repeat", "free"] : ["repeat", "differing", "free"]

const metGen: Gen<Met> = (source) => {
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

type MetFeature = `${Name}: ${MetSituation}`

/** The situations a relation's cases must reach: a set's facts never differ at their key. */
const situationsOf = (shape: Shape): Arr.NonEmptyReadonlyArray<MetSituation> => [
	"met",
	"added beside met",
	"unchanged, met only",
	...(shape === "keyed" || shape === "drawn" ? (["refused at a differing key"] as const) : [])
]

const metFeatures: Arr.NonEmptyReadonlyArray<MetFeature> = Arr.flatMap(
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

/** Each required situation with the cases constructed to reach it. */
const aims: ReadonlyArray<readonly [MetFeature, Gen<Met>]> = Arr.flatMap(names, (n) =>
	Arr.map(
		situationsOf(shapes[n].shape),
		(situation) => [`${n}: ${situation}`, reaching(n, situation)] as const
	)
)

/**
 * The case a witness runs: its drawn one, or, where its turn aims at a pending situation (Case.steering), one
 * constructed to reach it, drawn on the case's own tape, so the cases of one window aim at distinct pending situations.
 */
const aimedCase = (drawnCase: Met, k: Case<MetFeature>): Met => {
	const pending = Option.getOrUndefined(k.steering)
	const aim = Arr.findFirst(aims, ([situation]) => pending?.aimed(situation) === true)
	return Option.isNone(aim) ? drawnCase : k.draw(aim.value[1])
}

/** Rows in one order: by k, then a. */
const byKey: Order.Order<Row> = Order.combine(
	Order.mapInput(Order.Number, (r: Row) => r.k),
	Order.mapInput(Order.Number, (r: Row) => r.a)
)

/** What a call answered, the same for every relation's member: committed, with its added count and both sides it read
 * back; refused, with its witness; or any other answer, which the property refuses. */
type Answer =
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
const answerOf = <R, E, Q>(
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
const keyedRow = (r: { readonly k: number; readonly a: number; readonly b: number }): Row => ({
	k: r.k,
	a: r.a,
	b: r.b,
	id: Option.none()
})
const setRow = (r: { readonly k: number; readonly a: number }): Row => ({
	k: r.k,
	a: r.a,
	b: 0,
	id: Option.none()
})
const drawnRow = (r: { readonly id: string; readonly k: number; readonly a: number }): Row => ({
	k: r.k,
	a: r.a,
	b: 0,
	id: Option.some(r.id)
})
const drawnSetRow = (r: { readonly id: string; readonly k: number }): Row => ({
	k: r.k,
	a: 0,
	b: 0,
	id: Option.some(r.id)
})

layer(Substrate.layer)("the rows an insertion met", (it) => {
	it.effect(
		"are read back whole, beside the rows it made, at both levels and in every form",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const rig = yield* openRig(metSchema)
					const tables = namesOf(rig.installed)
					const rc = yield* rig.servedWriter(
						"rc",
						(context) => openServed(rig.served.roles.rc, {}).pipe(Effect.provideContext(context)),
						(db) =>
							db.workload.Krc.once({ params: {}, facts: { insert: { Krc: [] } } }).pipe(answered)
					)
					const ser = yield* rig.servedWriter(
						"ser",
						(context) => openServed(rig.served.roles.ser, {}).pipe(Effect.provideContext(context)),
						(db) =>
							db.workload.Kser.once({ params: {}, facts: { insert: { Kser: [] } } }).pipe(answered)
					)
					assert.equal(rc.ctx.isolation, "readCommitted", "generate certifies rc READ COMMITTED")
					assert.equal(
						ser.ctx.isolation,
						"serializable",
						"ser, beside a deleter of its relations, runs SERIALIZABLE"
					)
					const relations = { Krc, Kser, Prc, Pser, Drc, Dser, Erc, Eser } as const
					const columnsOf = (n: Name): ReadonlyArray<string> => {
						const { shape } = shapes[n]
						return [
							"k",
							...(statesA(shape) ? ["a"] : []),
							...(statesB(shape) ? ["b"] : []),
							...(drawsId(shape) ? ["id"] : [])
						]
					}
					const columnOf = (n: Name, field: string): string =>
						quoteIdent(tables.columnIdent(relations[n], field))
					/** A relation's stored rows, each read as text and then as a Row, in key order. */
					const stateOf = (n: Name) => {
						const { shape } = shapes[n]
						const fields = columnsOf(n)
						return Effect.map(
							s.admin.queryValues(
								`SELECT ${Arr.join(
									Arr.map(fields, (c) => `${columnOf(n, c)}::text`),
									", "
								)} FROM ${tables.table(relations[n])}`,
								[]
							),
							(rows) =>
								Arr.sort(
									Arr.map(rows, (row): Row => {
										const value = (field: string): Option.Option<string> =>
											Option.flatMap(
												Arr.findFirstIndex(fields, (f) => f === field),
												(i) => Option.map(Arr.get(row, i), String)
											)
										const number = (field: string): number =>
											Option.getOrElse(Option.map(value(field), Number), () => 0)
										return {
											k: number("k"),
											a: number("a"),
											b: number("b"),
											id: drawsId(shape) ? value("id") : Option.none()
										}
									}),
									byKey
								)
						)
					}
					/** The call of relation `n`'s member with its requests, every row the shape states. */
					const call = (n: Name, facts: ReadonlyArray<Fact>): Effect.Effect<Answer> => {
						const keyed = Arr.map(facts, (f) => ({ k: f.k, a: f.a, b: f.b }))
						const set = Arr.map(facts, (f) => ({ k: f.k, a: f.a }))
						const drawnSet = Arr.map(facts, (f) => ({ k: f.k }))
						switch (n) {
							case "Krc":
								return answerOf(
									n,
									rc.db.workload.Krc.once({ params: {}, facts: { insert: { Krc: keyed } } }).pipe(
										answered
									),
									keyedRow
								)
							case "Prc":
								return answerOf(
									n,
									rc.db.workload.Prc.once({ params: {}, facts: { insert: { Prc: set } } }).pipe(
										answered
									),
									setRow
								)
							case "Drc":
								return answerOf(
									n,
									rc.db.workload.Drc.once({ params: { rows: set }, facts: {} }).pipe(answered),
									drawnRow
								)
							case "Erc":
								return answerOf(
									n,
									rc.db.workload.Erc.once({ params: { rows: drawnSet }, facts: {} }).pipe(answered),
									drawnSetRow
								)
							case "Kser":
								return answerOf(
									n,
									ser.db.workload.Kser.once({
										params: {},
										facts: { insert: { Kser: keyed } }
									}).pipe(answered),
									keyedRow
								)
							case "Pser":
								return answerOf(
									n,
									ser.db.workload.Pser.once({ params: {}, facts: { insert: { Pser: set } } }).pipe(
										answered
									),
									setRow
								)
							case "Dser":
								return answerOf(
									n,
									ser.db.workload.Dser.once({ params: { rows: set }, facts: {} }).pipe(answered),
									drawnRow
								)
							case "Eser":
								return answerOf(
									n,
									ser.db.workload.Eser.once({ params: { rows: drawnSet }, facts: {} }).pipe(
										answered
									),
									drawnSetRow
								)
						}
					}
					return yield* explore(
						{
							suite: "pg/write/met",
							draw: drawn(metGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the insertion over the stated rows: an exact repeat meets its stored fact, a differing one refuses its key, any other is added"
							},
							coverage: required<MetFeature>(metFeatures, { cases: 400, sense: notesOnly }),
							kept: [],
							runs: 400,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(drawnCase, k) =>
							Effect.gen(function* () {
								const c = aimedCase(drawnCase, k)
								const { shape } = shapes[c.relation]
								const stated = Arr.filter(columnsOf(c.relation), (col) => col !== "id")
								const valueOf = (f: Fact, col: string): number =>
									col === "k" ? f.k : col === "a" ? f.a : f.b
								yield* rig.replace(
									Arr.isReadonlyArrayNonEmpty(c.stored)
										? [
												`INSERT INTO ${tables.table(relations[c.relation])} (${Arr.join(
													Arr.map(stated, (col) => columnOf(c.relation, col)),
													", "
												)}) VALUES ${Arr.join(
													Arr.map(
														c.stored,
														(f) =>
															`(${Arr.join(
																Arr.map(stated, (col) => String(valueOf(f, col))),
																", "
															)})`
													),
													", "
												)}`
											]
										: []
								)
								const before = yield* stateOf(c.relation)
								const answer = yield* call(
									c.relation,
									Arr.map(c.requests, (r) => r.fact)
								)
								const after = yield* stateOf(c.relation)
								const at = (rows: ReadonlyArray<Row>, requests: ReadonlyArray<Request>) =>
									Arr.filter(rows, (row) => Arr.some(requests, (r) => sameKey(shape, row, r.fact)))
								const differing = Arr.filter(c.requests, (r) => r.kind === "differing")
								if (Arr.isReadonlyArrayNonEmpty(differing)) {
									assert.ok(
										answer.kind === "refused",
										`a differing request refuses the call: ${Formatter.format(answer)}`
									)
									const witness = answer.witness
									assert.ok(
										witness.kind === "key" &&
											Arr.some(differing, (r) => deepEquals(witness.values, { k: r.fact.k })),
										`the witness is one of the differing keys: ${Formatter.format(witness)}`
									)
									assert.deepEqual(after, before, "a refused call changes nothing")
									k.note(`${c.relation}: refused at a differing key`)
									return
								}
								assert.ok(
									answer.kind === "committed",
									`the call commits: ${Formatter.format(answer)}`
								)
								const repeats = Arr.filter(c.requests, (r) => r.kind === "repeat")
								const free = Arr.filter(c.requests, (r) => r.kind === "free")
								assert.equal(
									answer.outcome,
									Arr.isReadonlyArrayNonEmpty(free) ? "accepted" : "unchanged",
									"accepted where it adds a request, unchanged otherwise"
								)
								assert.equal(answer.added, BigInt(free.length), "its count is the requests it adds")
								assert.deepEqual(
									Arr.sort(answer.addedRows, byKey),
									at(after, free),
									"added: exactly the rows it made, their drawn ids as stored"
								)
								assert.deepEqual(
									Arr.sort(answer.metRows, byKey),
									at(before, repeats),
									"met: exactly the stored rows it repeats, each whole"
								)
								assert.deepEqual(
									Arr.filter(after, (row) => !Arr.some(free, (r) => sameKey(shape, row, r.fact))),
									before,
									"the stored rows stay as they are"
								)
								if (Arr.isReadonlyArrayNonEmpty(repeats)) {
									k.note(`${c.relation}: met`)
									k.note(
										Arr.isReadonlyArrayNonEmpty(free)
											? `${c.relation}: added beside met`
											: `${c.relation}: unchanged, met only`
									)
								}
							})
					)
				})
			)
	)
})
