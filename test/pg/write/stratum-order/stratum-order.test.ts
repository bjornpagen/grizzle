import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn as drawnField, natural, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	counted,
	fin,
	mutable,
	on,
	ordered,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
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
 * B also owns a sequence of Q, so each B's insert nests its Q members, a nested write in the stratum as importWrite
 * holds one. The schema's owners are each mutable or immutable, drawn.
 *
 * The oracle is the writer's model: the stratum compiles, every write is accepted, and the rows read back are the rows
 * written, each owner's count its members'.
 */
const B = relation("B", { id: uuid, n: drawnField(natural), m: drawnField(natural) }, ["id"])
const T = relation("T", { b: uuid, k: uuid }, ["k"])
const O = relation("O", { id: uuid, k: uuid, n: drawnField(natural), tb: uuid }, ["id"])
const P = relation("P", { id: uuid, o: uuid }, ["id"])
const Q = relation("Q", { b: uuid, at: drawnField(natural), v: uuid }, ["b", "at"])

/** The schema over B, T, O and P, its owners mutable as drawn. */
const shapeOf = (mutableB: boolean, mutableO: boolean) =>
	schema("StratumOrder", { B, O, P, Q, T }, [
		counted(on(T, "b"), fin(B, "n")),
		ordered(on(Q, "b", "at"), fin(B, "m")),
		counted(on(P, "o"), fin(O, "n")),
		contained(on(O, "tb", "k"), on(T, "b", "k")),
		...(mutableB ? [mutable(B)] : []),
		...(mutableO ? [mutable(O)] : [])
	])

/**
 * The full world's workload over a drawn shape: the stratum's insert of B with Q nested, T, O and P, each call's facts;
 * and O's, B's, Q's and P's rows read back.
 */
const programsOf = (shape: ReturnType<typeof shapeOf>) => ({
	write: ChangeSet.empty(shape).insert(B, []).insert(T, []).insert(O, []).insert(P, []),
	owners: query(shape).rule((r) => {
		const { id, k: at, n, tb } = v(O, "o")
		return r.match(O, { id, k: at, n, tb }).find({ id, n })
	}),
	bRows: query(shape).rule((r) => {
		const { id, n, m } = v(B, "b")
		return r.match(B, { id, n, m }).find({ id, n, m })
	}),
	qRows: query(shape).rule((r) => {
		const { b, at, v: value } = v(Q, "q")
		return r.match(Q, { b, at, v: value }).find({ b, at, v: value })
	}),
	pRows: query(shape).rule((r) => {
		const { id, o: owner } = v(P, "p")
		return r.match(P, { id, o: owner }).find({ id })
	})
})

/** A case: each B's count of T members and of the Q members nested in it, each T's count of O rows naming it, and each
 * O's count of P members. */
interface OrderCase {
	readonly mutableB: boolean
	readonly mutableO: boolean
	readonly ts: ReadonlyArray<number>
	readonly qs: ReadonlyArray<number>
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
		qs: Arr.map(ts, () => source.draw(int(0, 2))),
		os,
		ps: Arr.map(os, () => source.draw(int(0, 2)))
	}
}

type OrderFeature =
	| "an owner with members on both sides"
	| "an owner with no members"
	| "immutable owners"
	| "members nested in the stratum"

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
										"immutable owners",
										"members nested in the stratum"
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
									const shape = shapeOf(k.mutableB, k.mutableO)
									const o = yield* installed(
										shape,
										{},
										{
											label: `order${k.mutableB ? "m" : "i"}${k.mutableO ? "m" : "i"}`,
											extensions: [],
											programs: programsOf(shape)
										}
									)
									yield* replaceRows(s.admin, installationGroup(namesOf(o.installed)), [])
									yield* Effect.gen(function* () {
										const db = yield* Db.open(o.served.login.roles.app, {})
										const bs = Arr.map(k.ts, (_, i) => ({
											id: uuidOf(100 + i),
											m: upTo(defined(k.qs[i], "a B's nested count"), (j) => ({
												v: uuidOf(600 + 10 * i + j)
											}))
										}))
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
										const outcome = yield* db.workload.write.apply(
											{ insert: { B: bs, T: ts, O: os, P: ps } },
											{}
										)
										assert.equal(
											outcome.kind,
											"accepted",
											`the stratum is accepted: ${Formatter.format(outcome)}`
										)
										const owners = yield* Effect.flatMap(
											db.workload.owners.execute({}),
											(r) => r.collect
										)
										for (const row of owners) {
											const members = Arr.filter(ps, (p) => p.o === row.id).length
											assert.equal(row.n, BigInt(members), "an owner's count is its members'")
										}
										const bRows = yield* Effect.flatMap(
											db.workload.bRows.execute({}),
											(r) => r.collect
										)
										for (const row of bRows) {
											const members = Arr.filter(ts, (t) => t.b === row.id).length
											assert.equal(row.n, BigInt(members), "a B's count is its members'")
											const nested = defined(
												Arr.findFirst(bs, (b) => b.id === row.id).pipe(Option.getOrUndefined),
												"a B written"
											).m.length
											assert.equal(row.m, BigInt(nested), "a B's sequence is its nested members")
										}
										const qRows = yield* Effect.flatMap(
											db.workload.qRows.execute({}),
											(r) => r.collect
										)
										assert.deepEqual(
											sortedIds(Arr.map(qRows, (q) => q.v)),
											sortedIds(Arr.flatMap(bs, (b) => Arr.map(b.m, (q) => q.v))),
											"every nested member is stored"
										)
										const pRows = yield* Effect.flatMap(
											db.workload.pRows.execute({}),
											(r) => r.collect
										)
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
										if (Arr.some(k.qs, (n) => n > 0)) {
											c.note("members nested in the stratum")
										}
									}).pipe(
										(body) =>
											Effect.flatMap(Layer.build(o.served.layer), (context) =>
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
