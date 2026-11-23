/** What restricted-share.test.ts reads: its schema, its box and the statements of a case's write. */

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

/**
 * A session's items and the ones done, every item's tags and each tag's label, the content no value of a write
 * restricts, as edullm's ledger's attributes hold every item's response declarations, and two relations the members
 * write.
 */
const Item = relation("Item", { session: pg.integer, k: pg.bigint, v: pg.bigint }, ["session", "k"])
const Done = relation("Done", { session: pg.integer, k: pg.bigint }, ["session", "k"])
const Tag = relation("Tag", { k: pg.bigint, t: pg.integer }, ["k", "t"])
const Label = relation("Label", { t: pg.integer, name: pg.integer }, ["t"])
const fields = { session: pg.integer, k: pg.bigint, v: pg.bigint } as const
const Out0 = relation("Out0", fields, ["session", "k", "v"])
const Out1 = relation("Out1", fields, ["session", "k", "v"])

const Restricted = schema("RestrictedShare", [Item, Done, Tag, Label, Out0, Out1, machine], [])

/** The sessions a write reads, a relation parameter each query binds to its own. */
const sessions = { session: pg.integer } as const

/** A query's binding of `sittings` to the sessions of the rule `r` reads it in: each import of it a copy of its own. */
const bySession = (r: Rule<typeof Restricted>) => ({
	sittings: r.relation("sittings", sessions)
})

/**
 * The open items of the call's sessions, a join the write's sessions restrict: each argument's import a copy, and the
 * second member's, one carried part of the statement, as the ledger's gradable runs are.
 */
const open = query(Restricted).rule((r) => {
	const { session } = v(r.relation("sittings", sessions), "s")
	const { k, v: x } = v(Item, "item")
	return r
		.match(r.relation("sittings", sessions), { session })
		.match(Item, { session, k, v: x })
		.where(r.not(Done, { session, k }))
		.find({ session, k, v: x })
})

/** Every item's labels: a join of Tag and Label, which no value of the write restricts. */
const labelled = query(Restricted).rule((r) => {
	const { k, t } = v(Tag, "tag")
	const { name } = v(Label, "label")
	return r.match(Tag, { k, t }).match(Label, { t, name }).find({ k, name })
})

/**
 * How each argument reads the labels: joined to the open items by the item, or alone, beside no carried part, each item
 * at least the argument's index.
 */
export type Content = "by the open items" | "alone"

/** How many of the call's four arguments read the labels; the others are empty. */
export type Reading = 1 | 2 | 4

export interface Box {
	readonly content: Content
	readonly reading: Reading
}

export const boxGen: Gen<Box> = element<Box>(
	Arr.flatMap(["by the open items", "alone"] as const, (content) =>
		Arr.map([1, 2, 4] as const, (reading) => ({ content, reading }))
	)
)

/** The `j`-th argument over the open items: those at least j, each joined to its labels by the item. */
const argumentByOpen = (j: number) =>
	query(Restricted).rule((r) => {
		const p = open.bind(bySession(r))
		const { session, k, v: x } = v(p, "p")
		const { name } = v(labelled, "l")
		return r
			.match(p, { session, k, v: x })
			.match(labelled, { k, name })
			.where(r.ge(x, BigInt(j)))
			.find({ k, v: x })
	})

/** The `j`-th argument over the labels alone: every labelled item at least j. */
const argumentAlone = (j: number) =>
	query(Restricted).rule((r) => {
		const { k, name } = v(labelled, "l")
		return r
			.match(labelled, { k, name })
			.where(r.ge(k, BigInt(j)))
			.find({ k, v: k })
	})

/** No rows of (k, v): an argument that reads nothing. */
const none = query(Restricted).rule((r) => r.where(r.or()).find({ k: 0n, v: 0n }))

/** A member writing the call's first field, its first `reading` arguments reading the labels, for its sessions. */
const callMember = (box: Box) =>
	query(Restricted).rule((r) => {
		const argument = (j: number) => {
			if (j >= box.reading) {
				return none
			}
			switch (box.content) {
				case "by the open items":
					return argumentByOpen(j).bind(bySession(r))
				case "alone":
					return argumentAlone(j)
			}
		}
		const read = Fn.row(machine, {
			in0: argument(0),
			in1: argument(1),
			in2: argument(2),
			in3: argument(3)
		}).a0
		const { session } = v(r.relation("sittings", sessions), "s")
		const { k, v: x } = v(read, "out")
		return r
			.match(r.relation("sittings", sessions), { session })
			.match(read, { k, v: x })
			.find({ session, k, v: x })
	})

/** A member writing the open items of its sessions: with the call's arguments, the second statement reading them. */
const openMember = query(Restricted).rule((r) => {
	const p = open.bind(bySession(r))
	const { session, k, v: x } = v(p, "open")
	return r.match(p, { session, k, v: x }).find({ session, k, v: x })
})

/** The session the call names: the write's `sittings`. */
const named = query(Restricted).rule((r) => r.find({ session: r.param("session", pg.integer) }))

const reality = realityWrite(succeeded(testArtifacts(Restricted, testCompile)))

/** The text of each statement the case's write sends whole, its parts assembled. */
export const statementsOf = (box: Box): ReadonlyArray<string> =>
	Arr.map(
		succeeded(
			compileWrite(
				checking(Restricted),
				descOf(
					ChangeSet.empty(Restricted)
						.insert(Out0, callMember(box))
						.insert(Out1, openMember)
						.bind({ sittings: named })
				),
				reality
			),
			"the case's write compiles"
		).artifact.statements,
		(s) => s.spec.sql
	)

/** How many times `sql` scans `table` of the schema. */
export const scans = (sql: string, table: "tag" | "item"): number =>
	Str.split(`"restricted_share"."${table}" AS`)(sql).length - 1

/** The CTE a line opens, `"r<n>"(` at its start past one tab, a part of the statement's WITH; none for another line. */
const partName = (line: string): string | undefined => {
	const [before, name, after] = Str.split('"')(
		Str.startsWith("\t")(line) ? Str.slice(1)(line) : line
	)
	return before === "" &&
		name !== undefined &&
		Str.startsWith("r")(name) &&
		after !== undefined &&
		Str.startsWith("(")(after)
		? name
		: undefined
}

/** The parts of `sql`: each line that opens a CTE with the lines after it up to the next, by the CTE's name. */
const partsOf = (sql: string): ReadonlyArray<{ readonly name: string; readonly text: string }> =>
	Arr.reduce(
		Str.split("\n")(sql),
		Arr.empty<{ readonly name: string; readonly text: string }>(),
		(parts, line) => {
			const name = partName(line)
			if (name !== undefined) {
				return [...parts, { name, text: line }]
			}
			const last = parts.at(-1)
			return last === undefined
				? parts
				: [...parts.slice(0, -1), { name: last.name, text: `${last.text}\n${line}` }]
		}
	)

/**
 * The part of `sql` that holds the labels once restricted: the text of each MATERIALIZED CTE of the statement's WITH, its
 * name, that scans Tag and Item none, and whether it keeps its rows by an EXISTS over the union of its partners' keys,
 * each read from its part.
 */
export const labelParts = (
	sql: string
): ReadonlyArray<{ readonly name: string; readonly keptByAPart: boolean }> =>
	Arr.flatMap(partsOf(sql), (part) =>
		scans(part.text, "tag") > 0 && scans(part.text, "item") === 0
			? [
					{
						name: part.name,
						keptByAPart: Str.includes("EXISTS (SELECT 1 FROM (SELECT ")(part.text)
					}
				]
			: []
	)
