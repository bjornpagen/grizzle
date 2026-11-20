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
	language: "sql",
	body: fn.body`SELECT NULL`
})

/** A session's items, and the ones done. */
const Item = relation("Item", { session: pg.integer, k: pg.bigint, v: pg.bigint }, ["session", "k"])
const Done = relation("Done", { session: pg.integer, k: pg.bigint }, ["session", "k"])

const fields = { session: pg.integer, k: pg.bigint, v: pg.bigint } as const
const key = ["session", "k", "v"] as const

/** The relations the members write, one each, with the field of the call each reads. */
const outs = [
	[relation("Out0", fields, key), "a0"],
	[relation("Out1", fields, key), "a1"],
	[relation("Out2", fields, key), "a2"],
	[relation("Out3", fields, key), "a3"],
	[relation("Out4", fields, key), "a4"],
	[relation("Out5", fields, key), "a5"],
	[relation("Out6", fields, key), "a6"],
	[relation("Out7", fields, key), "a7"]
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
 * which each of `members` inserts reads one field of, into a relation of its own.
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
