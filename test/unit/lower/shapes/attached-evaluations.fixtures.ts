/** What attached-evaluations.test.ts reads: its schema, its box and the optimized statements of a case's read. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { type Facts, Fn, type Term } from "#compiler/public/compute.ts"
import { int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"

const A = rows({ k: int8, v: int8 })

/** machine: two rows arguments of (k, v), and one row of two fields of rows of (k, v). */
const machine = fn("machine", {
	calls: [],
	args: { in0: A, in1: A },
	returns: row(rows({ a0: A, a1: A })),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT NULL`
})

/** A session, and its items. */
const Session = relation("Session", { s: int4, n: int4 }, ["s"])
const Item = relation("Item", { session: int4, k: int8, v: int8 }, ["session", "k"])
const Attached = schema("AttachedEvaluations", [Session, Item, machine], [])

/** The session's items whose v is at least `j`. */
const itemsOf = (j: bigint) =>
	query(Attached).rule((r) => {
		const { k, v: x } = v(Item, "item")
		return r
			.match(Item, { session: r.param("s", int4), k, v: x })
			.where(r.ge(x, j))
			.find({ k, v: x })
	})

/** Whether every attachment reads one call, at the same arguments, or each a call of its own, at its own arguments. */
export type Calls = "one call" | "a call each"

/** How many attachments read machine's run at their parent's key, how they read it, and how many of its fields. */
export interface Box {
	readonly attachments: 1 | 2 | 3
	readonly calls: Calls
	readonly fields: "one field" | "two fields"
}

export const boxGen: Gen<Box> = element<Box>(
	Arr.flatMap([1, 2, 3] as const, (attachments) =>
		Arr.flatMap(["one call", "a call each"] as const, (calls) =>
			Arr.map(["one field", "two fields"] as const, (fields) => ({ attachments, calls, fields }))
		)
	)
)

/** The session the read names, the parent row every attachment reads machine's run at. */
const sessions = query(Attached).rule((r) => {
	const { s, n } = v(Session, "session")
	return r
		.match(Session, { s, n })
		.where(r.eq(s, r.param("session", int4)))
		.find({ s, n })
})

/** A session's key as its parent row carries it. */
type SessionKey = Readonly<{
	s: Term<number, unknown, unknown, "int4", unknown, Facts, unknown>
}>

/**
 * The `i`-th attachment's child: machine's run at its parent's session, its arguments the items at least `j` and at
 * least `j + 1`, `j` 0 for every attachment where they read one call, `2i` where each reads its own; its first field
 * read, or both in one rule.
 */
const childOf = (box: Box, i: number) => (parent: SessionKey) =>
	query(Attached).rule((r) => {
		const j = box.calls === "one call" ? 0n : BigInt(2 * i)
		const run = Fn.row(machine, {
			in0: itemsOf(j).bind({ s: parent.s }),
			in1: itemsOf(j + 1n).bind({ s: parent.s })
		})
		const { k, v: x } = v(run.a0, "first")
		if (box.fields === "one field") {
			return r.match(run.a0, { k, v: x }).find({ k, v: x })
		}
		const { v: y } = v(run.a1, "second")
		return r.match(run.a0, { k, v: x }).match(run.a1, { k, v: y }).find({ k, v: x })
	})

/** The read of the case: the session and its attachments, each reading machine's run at the session's key. */
const readOf = (box: Box) => {
	const one = sessions.attach("a0", childOf(box, 0), "array")
	switch (box.attachments) {
		case 1:
			return one
		case 2:
			return one.attach("a1", childOf(box, 1), "array")
		case 3:
			return one.attach("a1", childOf(box, 1), "array").attach("a2", childOf(box, 2), "array")
	}
}

/** The optimized statements of the case's read, their texts joined. */
export const optimizedOf = (box: Box): string =>
	Arr.join(
		Arr.map(
			succeeded(compileTemplate(readOf(box), undefined, testCompile), "the case's read compiles")
				.optimized,
			(s) => s.sql
		),
		"\n"
	)

/** How many times `sql` calls machine. */
export const machineCalls = (sql: string): number =>
	Str.split('"attached_evaluations"."machine"(')(sql).length - 1
