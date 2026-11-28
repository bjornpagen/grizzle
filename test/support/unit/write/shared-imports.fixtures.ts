/** What the properties of shared-imports.test.ts read: their schema, their boxes and the writes of a case. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { Fn } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { param, query, v } from "#compiler/public/query.ts"
import { fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"

const A = rows({ k: pg.bigint, v: pg.bigint })

/** machine: eight rows arguments of (k, v), and one row of eight fields of rows of (k, v). */
const machine = fn("machine", {
	calls: [],
	args: { in0: A, in1: A, in2: A, in3: A, in4: A, in5: A, in6: A, in7: A },
	returns: row(rows({ a0: A, a1: A, a2: A, a3: A, a4: A, a5: A, a6: A, a7: A })),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT NULL`
})

/** A session's items, and the ones done. */
const Item = relation("Item", { session: pg.integer, k: pg.bigint, v: pg.bigint }, ["session", "k"])
const Done = relation("Done", { session: pg.integer, k: pg.bigint }, ["session", "k"])

const fields = { session: pg.integer, k: pg.bigint, v: pg.bigint } as const
const key = ["session", "k", "v"] as const

/** The relations the members write, one each, with the field of the call each reads: two fields, read alternately. */
const outs = [
	[relation("Out0", fields, key), "a0"],
	[relation("Out1", fields, key), "a1"],
	[relation("Out2", fields, key), "a0"],
	[relation("Out3", fields, key), "a1"],
	[relation("Out4", fields, key), "a0"],
	[relation("Out5", fields, key), "a1"],
	[relation("Out6", fields, key), "a0"],
	[relation("Out7", fields, key), "a1"]
] as const

export const Shared = schema(
	"SharedImports",
	[Item, Done, ...Arr.map(outs, ([relation]) => relation), machine],
	[]
)

const session = param("session", pg.integer)

/** The session's pending items: the bound query every argument reads. */
const pending = query(Shared).rule((r) => {
	const { k, v: x } = v(Item, "item")
	return r
		.match(Item, { session: r.param("session", pg.integer), k, v: x })
		.where(r.not(Done, { session: r.param("session", pg.integer), k }))
		.find({ k, v: x })
})

/** The `j`-th argument: the pending items whose v is at least j. */
const argumentOf = (j: bigint) =>
	query(Shared)
		.rule((r) => {
			const p = pending.bind({ session })
			const { k, v: x } = v(p, "p")
			return r.match(p, { k, v: x }).where(r.ge(x, j)).find({ k, v: x })
		})
		.bind({ session })

/** How many members read the call, a case of the call's box. */
export type Readers = 1 | 2 | 4 | 8

export const readersGen: Gen<Readers> = element([1, 2, 4, 8] as const)

/**
 * The case's ChangeSet: one call of machine, each of its eight arguments an import of `pending` bound to the session,
 * which each of `members` inserts reads one field of, a0 or a1 alternately, into a relation of its own.
 */
export const readersOf = (members: Readers): unknown => {
	const run = Fn.row(machine, {
		in0: argumentOf(0n),
		in1: argumentOf(1n),
		in2: argumentOf(2n),
		in3: argumentOf(3n),
		in4: argumentOf(4n),
		in5: argumentOf(5n),
		in6: argumentOf(6n),
		in7: argumentOf(7n)
	})
	return Arr.reduce(Arr.take(outs, members), ChangeSet.empty(Shared), (cs, [relation, field]) =>
		cs.insert(
			relation,
			query(Shared).rule((r) => {
				const read = run[field]
				const { k, v: x } = v(read, "out")
				return r.match(read, { k, v: x }).find({ session, k, v: x })
			})
		)
	)
}

/** The depths of the chain's box. */
export type Depth = 1 | 4 | 8

export const depthGen: Gen<Depth> = element([1, 4, 8] as const)

/** The first level of the chain: two rules, each reading `pending` bound to the session. */
const first = () =>
	query(Shared)
		.rule((r) => {
			const b = pending.bind({ session })
			const { k, v: x } = v(b, "first")
			return r.match(b, { k, v: x }).find({ k, v: x })
		})
		.rule((r) => {
			const b = pending.bind({ session })
			const { k, v: x } = v(b, "second")
			return r.match(b, { k, v: x }).where(r.ge(x, 1n)).find({ k, v: x })
		})

/** A level of the chain above the first: two rules, each reading the level below it bound to the session. */
const up = (below: ReturnType<typeof first>): ReturnType<typeof first> =>
	query(Shared)
		.rule((r) => {
			const b = below.bind({ session })
			const { k, v: x } = v(b, "first")
			return r.match(b, { k, v: x }).find({ k, v: x })
		})
		.rule((r) => {
			const b = below.bind({ session })
			const { k, v: x } = v(b, "second")
			return r.match(b, { k, v: x }).where(r.ge(x, 1n)).find({ k, v: x })
		})

/** The top of a chain of `depth` levels over `pending`. */
const chainOf = (depth: number): ReturnType<typeof first> => {
	let level = first()
	for (let i = 1; i < depth; i++) {
		level = up(level)
	}
	return level
}

/** One insert of the top of a chain of `depth` levels. */
export const chainWriteOf = (depth: number): unknown =>
	ChangeSet.empty(Shared).insert(
		outs[0][0],
		query(Shared).rule((r) => {
			const top = chainOf(depth).bind({ session })
			const { k, v: x } = v(top, "top")
			return r.match(top, { k, v: x }).find({ session, k, v: x })
		})
	)

/** One insert of the top of a chain of `depth` levels, its rows those whose v is at least 2: a member no chain of
 * `chainWriteOf` equals. */
export const chainVariantWriteOf = (depth: number): unknown =>
	ChangeSet.empty(Shared).insert(
		outs[0][0],
		query(Shared).rule((r) => {
			const top = chainOf(depth).bind({ session })
			const { k, v: x } = v(top, "top")
			return r.match(top, { k, v: x }).where(r.ge(x, 2n)).find({ session, k, v: x })
		})
	)

/** The members of a ChangeSet of the chain's box (identity.test.ts): one insert, or eight. */
export type ChainReaders = 1 | 8

/** `members` inserts, each into a relation of its own, all reading the top of one chain of `depth` levels. */
export const chainReadersOf = (depth: number, members: ChainReaders): unknown => {
	const chain = chainOf(depth)
	return Arr.reduce(Arr.take(outs, members), ChangeSet.empty(Shared), (cs, [relation]) =>
		cs.insert(
			relation,
			query(Shared).rule((r) => {
				const top = chain.bind({ session })
				const { k, v: x } = v(top, "top")
				return r.match(top, { k, v: x }).find({ session, k, v: x })
			})
		)
	)
}

/** A session's latest item: its pending item of the greatest v, the least k among equals, an import with a take. */
const latest = query(Shared)
	.rule((r) => {
		const { k, v: x } = v(Item, "item")
		return r.match(Item, { session: r.param("session", pg.integer), k, v: x }).find({ k, v: x })
	})
	.orderBy(["v", "desc"], ["k", "asc"])
	.take(1)

/**
 * `members` inserts, each into a relation of its own, each reading the latest item of the session of every Done fact:
 * `latest` bound to a variable of the reading rule, a take correlated through `bind`, which the write's optimized form
 * restates over every parent (lower/shapes/take/decorrelate.ts everyParentTakes).
 */
export const boundTakeWriteOf = (members: 1 | 8): unknown =>
	Arr.reduce(Arr.take(outs, members), ChangeSet.empty(Shared), (cs, [relation]) =>
		cs.insert(
			relation,
			query(Shared).rule((r) => {
				const { session: s, k: done } = v(Done, "done")
				const read = latest.bind({ session: s })
				const { k, v: x } = v(read, "latest")
				return r
					.match(Done, { session: s, k: done })
					.match(read, { k, v: x })
					.find({ session: s, k, v: x })
			})
		)
	)

/** A session's readings, each a float: a rule over them delivers a float, so its head states a merge (check/merge.ts). */
const Reading = relation("Reading", { session: pg.integer, k: pg.bigint, x: pg.real }, [
	"session",
	"k"
])
const FloatOut = relation("FloatOut", { session: pg.integer, k: pg.bigint, x: pg.real }, [
	"session",
	"k"
])

export const Floats = schema("FloatImports", [Reading, FloatOut], [])

/** The depths of the float chain's box. */
export type FloatDepth = 2 | 3 | 4 | 6 | 8

export const floatDepthGen: Gen<FloatDepth> = element([2, 3, 4, 6, 8] as const)

/** The session's readings, each with its float: the query the float chain's first level reads, bound to the session. */
const floatRoot = query(Floats).rule((r) => {
	const { k, x } = v(Reading, "reading")
	return r.match(Reading, { session: r.param("session", pg.integer), k, x }).find({ k, x })
})

/**
 * The float chain's first level: one rule reading the session's readings, bound to the session, delivering each one's
 * float, so its head states a merge (check/merge.ts), as every level's does; each level is a closed import its check
 * completes under the logical analysis of its own DAG, the levels below it among its nodes.
 */
const floatFirst = () =>
	query(Floats).rule((r) => {
		const b = floatRoot.bind({ session })
		const { k, x } = v(b, "below")
		return r.match(b, { k, x }).find({ k, x })
	})

/** A level of the float chain above the first: one rule reading the level below bound to the session. */
const floatUp = (below: ReturnType<typeof floatFirst>): ReturnType<typeof floatFirst> =>
	query(Floats).rule((r) => {
		const b = below.bind({ session })
		const { k, x } = v(b, "below")
		return r.match(b, { k, x }).find({ k, x })
	})

/** The top of a float chain of `depth` levels over Reading. */
const floatChainOf = (depth: number): ReturnType<typeof floatFirst> => {
	let level = floatFirst()
	for (let i = 1; i < depth; i++) {
		level = floatUp(level)
	}
	return level
}

/** One insert of the top of a float chain of `depth` levels into FloatOut. */
export const floatChainWriteOf = (depth: FloatDepth): unknown =>
	ChangeSet.empty(Floats).insert(
		FloatOut,
		query(Floats).rule((r) => {
			const top = floatChainOf(depth).bind({ session })
			const { k, x } = v(top, "top")
			return r.match(top, { k, x }).find({ session, k, x })
		})
	)
