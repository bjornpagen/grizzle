/** What evaluation-core.test.ts reads: its schema, its box and the statements of a case's write. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { Fn } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import { fn, relation, row, rows, schema } from "#compiler/public/schema.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

const A = rows({ k: pg.bigint, v: pg.bigint })

/** machine: four rows arguments of (k, v), and one row of two fields of rows of (k, v). */
const machine = fn("machine", {
	calls: [],
	args: { in0: A, in1: A, in2: A, in3: A },
	returns: row(rows({ a0: A, a1: A })),
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT NULL`
})

/** A session's items, the ones done, and two relations the members write. */
const Item = relation("Item", { session: pg.integer, k: pg.bigint, v: pg.bigint }, ["session", "k"])
const Done = relation("Done", { session: pg.integer, k: pg.bigint }, ["session", "k"])
const fields = { session: pg.integer, k: pg.bigint, v: pg.bigint } as const
const Out0 = relation("Out0", fields, ["session", "k", "v"])
const Out1 = relation("Out1", fields, ["session", "k", "v"])

const Core = schema("EvaluationCore", [Item, Done, Out0, Out1, machine], [])

/** The sessions a write reads, a relation parameter each query binds to its own. */
const sessions = { session: pg.integer } as const

/** A query's binding of `sittings` to the sessions of the rule `r` reads it in: each import of it a copy of its own. */
const bySession = (r: Rule<typeof Core>) => ({ sittings: r.relation("sittings", sessions) })

/** What the arguments read: a fold or a join at the call's sessions, each argument's import a copy of its own, or a
 * join of every session, one node every argument reads. */
export type CoreKind =
	| "a fold at the call's sessions"
	| "a join at the call's sessions"
	| "a join of every session"

/**
 * The core at the call's sessions, folded: each session's items no Done fact matches, the greatest v of each, a fold
 * over an anti-join. Imported by each argument through its own binding (`bySession`), so each argument reads a copy of
 * it, as every argument of the ledger's grade reads its own copy of the graded attempts (qti-pie grade.ts gradableOf).
 */
const folded = query(Core).rule((r) => {
	const { session } = v(r.relation("sittings", sessions), "s")
	const { k, v: x } = v(Item, "item")
	return r
		.match(r.relation("sittings", sessions), { session })
		.match(Item, { session, k, v: x })
		.where(r.not(Done, { session, k }))
		.find({ session, k, v: r.max(x) })
})

/** The core at the call's sessions, a join: each session's items no Done fact matches, a copy in each argument. */
const joined = query(Core).rule((r) => {
	const { session } = v(r.relation("sittings", sessions), "s")
	const { k, v: x } = v(Item, "item")
	return r
		.match(r.relation("sittings", sessions), { session })
		.match(Item, { session, k, v: x })
		.where(r.not(Done, { session, k }))
		.find({ session, k, v: x })
})

/** The core of every session: every item no Done fact matches, which no value of the call restricts. */
const everySession = query(Core).rule((r) => {
	const { session, k, v: x } = v(Item, "item")
	return r
		.match(Item, { session, k, v: x })
		.where(r.not(Done, { session, k }))
		.find({ session, k, v: x })
})

/** The `j`-th argument over the folded core: its rows whose v is at least j. */
const argumentOfFolded = (j: number) =>
	query(Core).rule((r) => {
		const p = folded.bind(bySession(r))
		const { session, k, v: x } = v(p, "p")
		return r
			.match(p, { session, k, v: x })
			.where(r.ge(x, BigInt(j)))
			.find({ k, v: x })
	})

/** The `j`-th argument over the joined core: its rows whose v is at least j. */
const argumentOfJoined = (j: number) =>
	query(Core).rule((r) => {
		const p = joined.bind(bySession(r))
		const { session, k, v: x } = v(p, "p")
		return r
			.match(p, { session, k, v: x })
			.where(r.ge(x, BigInt(j)))
			.find({ k, v: x })
	})

/** The `j`-th argument over the core of every session: its rows whose v is at least j. */
const argumentOfEvery = (j: number) =>
	query(Core).rule((r) => {
		const { session, k, v: x } = v(everySession, "p")
		return r
			.match(everySession, { session, k, v: x })
			.where(r.ge(x, BigInt(j)))
			.find({ k, v: x })
	})

/** How many of the call's four arguments read the core; the others are empty. */
export type Reading = 1 | 2 | 4

/** Whether the write is one member reading the call, or two members of one statement, one or both reading it. */
export type Members = "one reads the call" | "two, one reads the call" | "two, both read the call"

export interface Box {
	readonly core: CoreKind
	readonly reading: Reading
	readonly members: Members
}

export const boxGen: Gen<Box> = element<Box>(
	Arr.flatMap(
		[
			"a fold at the call's sessions",
			"a join at the call's sessions",
			"a join of every session"
		] as const,
		(core) =>
			Arr.flatMap([1, 2, 4] as const, (reading) =>
				Arr.map(
					["one reads the call", "two, one reads the call", "two, both read the call"] as const,
					(members) => ({ core, reading, members })
				)
			)
	)
)

/** No rows of (k, v): an argument that reads nothing. */
const none = query(Core).rule((r) => r.where(r.or()).find({ k: 0n, v: 0n }))

/** The call of a rule `r`, its first `reading` arguments each reading the core, at `r`'s sessions. */
const callIn = (r: Rule<typeof Core>, core: CoreKind, reading: Reading) => {
	/** The `j`-th argument: the core's, at `r`'s sessions where the core reads them, where it reads one, else none. */
	const argument = (j: number) => {
		if (j >= reading) {
			return none
		}
		switch (core) {
			case "a fold at the call's sessions":
				return argumentOfFolded(j).bind(bySession(r))
			case "a join at the call's sessions":
				return argumentOfJoined(j).bind(bySession(r))
			case "a join of every session":
				return argumentOfEvery(j)
		}
	}
	return Fn.row(machine, { in0: argument(0), in1: argument(1), in2: argument(2), in3: argument(3) })
}

/** A member writing `field` of the call's row into `target`, for the sessions it reads. */
const callMember = (core: CoreKind, reading: Reading, field: "a0" | "a1") =>
	query(Core).rule((r) => {
		const { session } = v(r.relation("sittings", sessions), "s")
		const read = callIn(r, core, reading)[field]
		const { k, v: x } = v(read, "out")
		return r
			.match(r.relation("sittings", sessions), { session })
			.match(read, { k, v: x })
			.find({ session, k, v: x })
	})

/** A member that reads no call: each session's items. */
const itemMember = query(Core).rule((r) => {
	const { session } = v(r.relation("sittings", sessions), "s")
	const { k, v: x } = v(Item, "item")
	return r
		.match(r.relation("sittings", sessions), { session })
		.match(Item, { session, k, v: x })
		.find({ session, k, v: x })
})

/** The session the call names: the write's `sittings`. */
const named = query(Core).rule((r) => r.find({ session: r.param("session", pg.integer) }))

/** The case's write, its sessions bound to the call's `session`. */
const changesOf = (box: Box) => {
	const first = ChangeSet.empty(Core).insert(Out0, callMember(box.core, box.reading, "a0"))
	switch (box.members) {
		case "one reads the call":
			return first.bind({ sittings: named })
		case "two, one reads the call":
			return first.insert(Out1, itemMember).bind({ sittings: named })
		case "two, both read the call":
			return first.insert(Out1, callMember(box.core, box.reading, "a1")).bind({ sittings: named })
	}
}

const reality = realityWrite(succeeded(testArtifacts(Core, testCompile)))

/** The text of each statement the case's write sends whole, its parts assembled. */
export const statementsOf = (box: Box): ReadonlyArray<string> =>
	Arr.map(
		succeeded(
			compileWrite(checking(Core), descOf(changesOf(box)), reality),
			"the case's write compiles"
		).artifact.statements,
		(s) => s.spec.sql
	)

/** How many times `sql` scans Done, the core's anti-join's right side. */
export const doneScans = (sql: string): number =>
	Str.split('"evaluation_core"."done" AS')(sql).length - 1
