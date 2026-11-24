/** What the property of library-nulls.test.ts reads: each library function's calls, its rows of NULLs and its SQL. */

import { assert } from "@bjornpagen/testing/assert"
import { array, characterOf, constant, type Gen, oneOf, string } from "@bjornpagen/testing/gen"
import { type Equivalence, equivalence } from "@bjornpagen/testing/oracle"
import { Array as Arr, Formatter } from "effect"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { exprClosure, predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { LibraryFn } from "#compiler/ir/physical.ts"
import { libraryCreate } from "#compiler/physical/ddl/library.ts"
import { compiledExpr, sqlNull } from "#compiler/scalar/compute/evaluate.ts"
import { libraryOf, nativeOp, nativeOps } from "#compiler/scalar/compute/registry.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { sameBytes } from "#compiler/scalar/values/bytes.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { baseParams, lowerWith, plainRender, renderSql } from "#test/unit/compute/support.ts"
import { textColumn } from "#test/unit/compute/text.fixtures.ts"
import { referenceCaseGen } from "#test/unit/text/uri.fixtures.ts"
import { patternGen } from "#test/unit/text/xsd.fixtures.ts"

/**
 * The library functions the host evaluates, whose NULLs the host decides: every one but wall, a zone's wall clock by
 * PostgreSQL's tzdata, which the host does not hold (scalar/compute/registry.ts zoneWall), whose NULLs
 * test/pg/compute/wall.test.ts holds to the reference evaluator, and decodedPath and resolvedWithin, which no term
 * calls, only a decoded path's split and a target within a base's, whose arguments are stored texts, never NULL
 * (test/pg/compute/decoded-path.test.ts, test/pg/compute/resolved-within.test.ts), and closedRow, a closed relation's
 * row of a prefix, which no scalar operation calls (sql/constants.ts completions), whose NULLs
 * test/pg/closed/sparse.test.ts holds to its model.
 */
type HostLibraryFn = Exclude<LibraryFn, "wall" | "closedRow" | "decodedPath" | "resolvedWithin">

/** Which of a call's arguments a row holds NULL: none, one of them by its place, or every one. */
type Nulls = "no argument" | "argument 1" | "argument 2" | "every argument"

/** What a row of a batch reached: its library function, and which of its arguments are NULL. */
export type LibraryNullFeature = `${HostLibraryFn} with ${Nulls} NULL`

/** The two argument columns a call reads, `a` and then `b`, its first and second. */
const columns = ["a", "b"] as const

/** A scalar term over its first `arity` argument columns, whose SQL calls a library function. */
interface Call {
	readonly desc: ExprDesc
	readonly arity: 1 | 2
}

const over = (
	fn: "cutBefore" | "cutFrom" | "isXsdPattern" | "resolveReference" | "sha256",
	arity: 1 | 2
): Call => ({
	desc: {
		kind: "compute",
		fn,
		args: Arr.map(columns.slice(0, arity), (name) => ({ kind: "var", var: name }))
	},
	arity
})

/**
 * Each library function's calls, a scalar term each, total over the ones the host evaluates, so a new library function
 * states its own: the two cuts', isXsdPattern's, resolveReference's and a text's digest, Crypto.sha256 over a text,
 * textDigest's.
 */
const callsOf: { readonly [F in HostLibraryFn]: Arr.NonEmptyReadonlyArray<Call> } = {
	cutBefore: [over("cutBefore", 2)],
	cutFrom: [over("cutFrom", 2)],
	isXsdPattern: [over("isXsdPattern", 1)],
	resolveReference: [over("resolveReference", 2)],
	textDigest: [over("sha256", 1)]
}

/** A call lowered: its library function, its arguments' count, its term as a check lowers it, and its SQL. */
export interface LoweredCall {
	readonly fn: HostLibraryFn
	readonly arity: number
	readonly term: ScalarExpr
	readonly sql: string
	readonly create: string
}

/** The library functions an expression's SQL calls, by the native nodes it holds (registry.ts libraryOf). */
const libraryCallsOf = (e: ScalarExpr): ReadonlyArray<LibraryFn> =>
	Arr.dedupe(
		Arr.flatMap(exprClosure([e]), (x) => {
			const sql = x.kind === "op" ? nativeOp(x.op)?.sql : undefined
			const fn = sql === undefined ? undefined : libraryOf(sql)
			return fn === undefined ? [] : [fn]
		})
	)

/** `fn`'s call as a check lowers it over texts, and the SQL that reads it over a batch's rows. */
const lowered = (fn: HostLibraryFn, { desc, arity }: Call): LoweredCall => {
	const term = succeeded(
		lowerWith("check", desc, { a: textColumn, b: textColumn }, false, baseParams),
		`the call of ${fn} lowers in a check over any texts`
	).root
	assert.ok(
		Arr.contains(libraryCallsOf(term.expr), fn),
		`the call of ${fn} is SQL that calls ${fn}, not ${Formatter.format(libraryCallsOf(term.expr))}`
	)
	return {
		fn,
		arity,
		term: term.expr,
		sql: `SELECT ${renderSql(term.expr, plainRender)} FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, a text, b text) ORDER BY r0.ord`,
		create: printStatement(libraryCreate("pg_temp", fn))
	}
}

/** Every library function's calls, lowered once. */
export const calls: Arr.NonEmptyReadonlyArray<LoweredCall> = [
	...Arr.map(callsOf.cutBefore, (d) => lowered("cutBefore", d)),
	...Arr.map(callsOf.cutFrom, (d) => lowered("cutFrom", d)),
	...Arr.map(callsOf.isXsdPattern, (d) => lowered("isXsdPattern", d)),
	...Arr.map(callsOf.resolveReference, (d) => lowered("resolveReference", d)),
	...Arr.map(callsOf.textDigest, (d) => lowered("textDigest", d))
]

/**
 * The native nodes that call a library function the host evaluates and no call above holds, which must be none: every
 * overload such a library function serves is one the property calls.
 */
export const uncalledNodes: ReadonlyArray<string> = Arr.flatMap(nativeOps, (op) => {
	const fn = libraryOf(op.sql)
	const held = Arr.some(calls, (c) =>
		Arr.some(exprClosure([c.term]), (x) => x.kind === "op" && x.op === op.id)
	)
	return fn === undefined || fn === "wall" || fn === "closedRow" || held ? [] : [`${op.fn} (${fn})`]
})

/** A text an argument holds where it is no NULL: an XML Schema pattern, a reference or a base, or any short text. */
const argumentGen: Gen<string> = oneOf<string>([
	(s) => s.draw(patternGen).xsd,
	(s) => s.draw(referenceCaseGen).reference,
	(s) => s.draw(referenceCaseGen).base,
	string(characterOf(["a", "/", ":", "?", "#", ".", "(", "[", "\\", "{", "é", "😀"]), {
		min: 0,
		max: 8
	}),
	constant("")
])

/** One row of a call: its arguments, each a text or NULL, and what it reached. */
export interface NullRow {
	readonly args: ReadonlyArray<string | null>
	readonly feature: LibraryNullFeature
}

/** Which arguments of `arity` a mask of bits holds NULL, bit i the argument i + 1's. */
const nullsOf = (mask: number, arity: number): Nulls =>
	mask === 0
		? "no argument"
		: mask === 2 ** arity - 1
			? "every argument"
			: mask === 1
				? "argument 1"
				: "argument 2"

/** Every row of `args`: each set of its arguments NULL in turn, none and every one among them. */
const rowsOf = (fn: HostLibraryFn, args: ReadonlyArray<string>): ReadonlyArray<NullRow> =>
	Array.from({ length: 2 ** args.length }, (_, mask) => ({
		args: Arr.map(args, (a, i) => (((mask >> i) & 1) === 1 ? null : a)),
		feature: `${fn} with ${nullsOf(mask, args.length)} NULL`
	}))

/** A batch of one call: two to six drawn argument lists, each with every set of its arguments NULL. */
const rowsGen =
	(call: LoweredCall): Gen<ReadonlyArray<NullRow>> =>
	(source) =>
		Arr.flatMap(
			source.draw(
				array(array(argumentGen, { min: call.arity, max: call.arity }), { min: 2, max: 6 })
			),
			(args) => rowsOf(call.fn, args)
		)

/** A batch: every call's rows. */
export const batchGen: Gen<ReadonlyArray<ReadonlyArray<NullRow>>> = (source) =>
	Arr.map(calls, (call) => source.draw(rowsGen(call)))

/** A row's arguments as the SQL's JSON reads them, `a` and `b` by place, NULL as JSON's null. */
export const rowsJson = (
	rows: ReadonlyArray<NullRow>
): ReadonlyArray<{ readonly ord: number; readonly a: string | null; readonly b: string | null }> =>
	Arr.map(rows, (row, ord) => ({ ord, a: row.args[0] ?? null, b: row.args[1] ?? null }))

/**
 * A library function's value, as either side holds it: isXsdPattern's boolean, a cut's and resolveReference's text, textDigest's
 * digest, its bytes (a Sha256 on the host, bytea as PostgreSQL returns it), or NULL.
 */
export type LibraryValue = boolean | string | Uint8Array | null

/** `value` as a LibraryValue: a boolean, a text or bytes as themselves, NULL (the host's sqlNull among them) as null. */
export const libraryValue = (value: unknown, side: string): LibraryValue =>
	value === sqlNull || value === null
		? null
		: typeof value === "boolean" || typeof value === "string" || value instanceof Uint8Array
			? value
			: assert.fail(`${side}'s value is a boolean, a text or bytes, not ${Formatter.format(value)}`)

/** A value as a report spells it: bytes by their hex, every other value by Formatter. */
const spelled = (value: LibraryValue): string =>
	value instanceof Uint8Array ? `bytes ${value.toHex()}` : Formatter.format(value)

/** Whether two values are one: two bytes values by their bytes (bytea's equality), every other pair by identity. */
export const sameLibraryValue: Equivalence<LibraryValue> = equivalence(
	(left, right) =>
		left instanceof Uint8Array && right instanceof Uint8Array
			? sameBytes(left, right)
			: left === right,
	spelled
)

/** The host evaluator's value of a call over a row (scalar/compute/evaluate.ts). */
export const hostValue = (call: LoweredCall, row: NullRow): LibraryValue => {
	const table = predicateTable(call.term)
	const value = succeeded(
		compiledExpr(table)(
			{
				value: undefined,
				column: (ref) => row.args[ref.name === "a" ? 0 : 1] ?? sqlNull,
				closed: () => undefined
			},
			ProgramPatterns.of(tablePatterns(table))
		),
		`the host evaluates ${call.fn}`
	)
	return libraryValue(value, "the host")
}
