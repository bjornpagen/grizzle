import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn as drawnField, natural, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, counted, fin, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * One stratum whose writes must land on both sides of one owner's insert, on PostgreSQL 19rc1: pantry's importWrite
 * shape (qti-pie e67d7cd5), where AssembledReference is contained in TestReference rows its stratum appends and owns
 * PlacedReference rows its stratum appends too.
 *
 * O owns a counted family of P and is contained in T at every field T has, so its foreign key is immediate; T is a
 * counted member of B. A case inserts
 * B's rows, T's members of them, O's rows each naming a T's `k`, and P's members of O's rows, all in one stratum:
 * T's rows must land before O's insert, which the containment reads, and P's after it, which their owner axis reads.
 * The schema's owners are each mutable or immutable, drawn.
 *
 * The oracle is the writer's model: the stratum compiles, every write is accepted, and the rows read back are the rows
 * written, each owner's count its members'.
 */
const B = relation("B", { id: uuid, n: drawnField(natural) }, ["id"])
const T = relation("T", { b: uuid, k: uuid }, ["k"])
const O = relation("O", { id: uuid, k: uuid, n: drawnField(natural), tb: uuid }, ["id"])
const P = relation("P", { id: uuid, o: uuid }, ["id"])

/** The schema over B, T, O and P, its owners mutable as drawn. */
const shapeOf = (mutableB: boolean, mutableO: boolean) =>
	schema("StratumOrder", { B, O, P, T }, [
		counted(on(T, "b"), fin(B, "n")),
		counted(on(P, "o"), fin(O, "n")),
		contained(on(O, "tb", "k"), on(T, "b", "k")),
		...(mutableB ? [mutable(B)] : []),
		...(mutableO ? [mutable(O)] : [])
	])

/** A case: each B's count of T members, each T's count of O rows naming it, and each O's count of P members. */
interface OrderCase {
	readonly mutableB: boolean
	readonly mutableO: boolean
	readonly ts: ReadonlyArray<number>
	readonly os: ReadonlyArray<number>
	readonly ps: ReadonlyArray<number>
}

const caseGen: Gen<OrderCase> = (source) => {
	const ts = source.draw(array(int(0, 2), { min: 1, max: 3 }))
	const tCount = Arr.reduce(ts, 0, (a, b) => a + b)
	const os = tCount === 0 ? [] : source.draw(array(int(0, tCount - 1), { min: 1, max: 3 }))
	return {
		mutableB: source.draw(boolean),
		mutableO: source.draw(boolean),
		ts,
		os,
		ps: Arr.map(os, () => source.draw(int(0, 2)))
	}
}

type OrderFeature =
	| "an owner with members on both sides"
	| "an owner with no members"
	| "immutable owners"

/** `f` of 0 to n - 1: none for n = 0, where Arr.makeBy makes one. */
const upTo = <A>(n: number, f: (i: number) => A): ReadonlyArray<A> =>
	n === 0 ? [] : Arr.makeBy(n, f)

const sortedIds = (ids: ReadonlyArray<string>): ReadonlyArray<string> => Arr.sort(ids, Order.String)

layer(Substrate.layer, { excludeTestServices: true })(
	"one stratum around an owner's insert",
	(it) => {
		it.effect(
			"orders the writes that must land before and after an owner's insert, and stores the writer's rows",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						return yield* explore(
							{
								suite: "pg/write/stratum-order",
								draw: drawn(caseGen),
								literal: Formatter.format,
								oracle: {
									kind: "second-implementation",
									name: "the writer's model: every row written, each owner's count its members'"
								},
								coverage: required<OrderFeature>(
									[
										"an owner with members on both sides",
										"an owner with no members",
										"immutable owners"
									],
									{ cases: 8, sense: notesOnly }
								),
								kept: [],
								runs: 8,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 4,
								caseHang
							},
							(k, c) =>
								Effect.gen(function* () {
									const o = yield* installed(
										shapeOf(k.mutableB, k.mutableO),
										{},
										{
											label: `order${k.mutableB ? "m" : "i"}${k.mutableO ? "m" : "i"}`,
											extensions: []
										}
									)
									yield* replaceRows(s.admin, installationGroup(namesOf(o.installed)), [])
									yield* Effect.gen(function* () {
										const db = yield* Db.open(o.server.roles.app, {})
										const bs = Arr.map(k.ts, (_, i) => ({ id: uuidOf(100 + i) }))
										const ts = Arr.map(
											Arr.flatMap(k.ts, (n, i) => upTo(n, () => ({ b: uuidOf(100 + i) }))),
											(t, j) => ({ ...t, k: uuidOf(300 + j) })
										)
										const os = Arr.map(k.os, (t, i) => ({
											id: uuidOf(400 + i),
											k: uuidOf(300 + t),
											tb: defined(ts[t], "a T an O names").b
										}))
										const ps = Arr.flatMap(k.ps, (n, i) =>
											upTo(n, (j) => ({ id: uuidOf(500 + 10 * i + j), o: uuidOf(400 + i) }))
										)
										const outcome = yield* db.apply(
											ChangeSet.empty(o.schema)
												.insert(B, bs)
												.insert(T, ts)
												.insert(O, os)
												.insert(P, ps),
											{}
										)
										assert.equal(
											outcome.kind,
											"accepted",
											`the stratum is accepted: ${Formatter.format(outcome)}`
										)
										const ownersQuery = query(o.schema).rule((r) => {
											const { id, k: at, n, tb } = v(O, "o")
											return r.match(O, { id, k: at, n, tb }).find({ id, n })
										})
										const owners = yield* Effect.flatMap(
											db.execute(ownersQuery, {}),
											(r) => r.collect
										)
										for (const row of owners) {
											const members = Arr.filter(ps, (p) => p.o === row.id).length
											assert.equal(row.n, BigInt(members), "an owner's count is its members'")
										}
										const bQuery = query(o.schema).rule((r) => {
											const { id, n } = v(B, "b")
											return r.match(B, { id, n }).find({ id, n })
										})
										const bRows = yield* Effect.flatMap(db.execute(bQuery, {}), (r) => r.collect)
										for (const row of bRows) {
											const members = Arr.filter(ts, (t) => t.b === row.id).length
											assert.equal(row.n, BigInt(members), "a B's count is its members'")
										}
										const pQuery = query(o.schema).rule((r) => {
											const { id, o: owner } = v(P, "p")
											return r.match(P, { id, o: owner }).find({ id })
										})
										const pRows = yield* Effect.flatMap(db.execute(pQuery, {}), (r) => r.collect)
										assert.deepEqual(
											sortedIds(Arr.map(pRows, (p) => p.id)),
											sortedIds(Arr.map(ps, (p) => p.id)),
											"every member is stored"
										)
										if (Arr.some(k.ps, (n) => n > 0) && os.length > 0) {
											c.note("an owner with members on both sides")
										}
										if (Arr.some(k.ps, (n) => n === 0)) {
											c.note("an owner with no members")
										}
										if (!k.mutableB || !k.mutableO) {
											c.note("immutable owners")
										}
									}).pipe(
										(body) =>
											Effect.flatMap(Layer.build(o.layer), (context) =>
												Effect.provideContext(body, context)
											),
										Effect.scoped
									)
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
