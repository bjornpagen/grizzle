import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import type { ServedCalls } from "#adapter/db/handles.ts"
import type { PageRuntime } from "#adapter/page/template.ts"
import type { DecodedRow } from "#adapter/reader/stream.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { isRecord } from "#compiler/core/record.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	type Anchor,
	type CallError,
	type KeyFields,
	keyOf,
	type RowKey
} from "#compiler/live/index.ts"
import { assert } from "#test/support/assert.ts"
import { readOnce } from "#test/support/calls.ts"
import { isList } from "#test/support/list.ts"
import { mergeComparator } from "#test/support/merge.ts"

/**
 * Shared helpers for the page runtime suites (test/pg/page).
 *
 * Every suite reads windows of the members of a login's served workload, exactly as an application does, over the
 * Paging fixture and the boundary-value Measures fixture of the unit page suites (test/unit/page/fixtures.ts). A
 * window's rows are compared as canonical values (`canon`), which keep every carrier's identity: a bigint, a Decimal's
 * text, a float's sign of zero and NaN, an Option.
 *
 * A paged member's input: its parameters, no facts, and the window of `size` rows from `anchor`.
 */
export const windowInput = (params: unknown, anchor: Anchor, size: number) => ({
	params,
	facts: {},
	window: { anchor, size }
})

/** The rows of the window of `size` rows from `anchor` of the paged member `calls`, in presentation order. */
export const windowOf = (
	calls: ServedCalls,
	params: unknown,
	anchor: Anchor,
	size: number
): Effect.Effect<ReadonlyArray<DecodedRow>, CallError> =>
	readOnce(calls)(windowInput(params, anchor, size))

/** A delivered row as the record it is. */
export const rowOf = (row: unknown): Readonly<Record<string, unknown>> => {
	if (!isRecord(row)) {
		throw new Error(`a row is a record, not ${String(row)}`)
	}
	return row
}

/** The name of a prototype's constructor, "object" when it has none. */
const constructorName = (proto: unknown): string =>
	isRecord(proto) && typeof proto.constructor === "function" ? proto.constructor.name : "object"

/** A value with every carrier's identity kept, arrays of records sorted where they are sets (unordered attachments). */
export const canon = (value: unknown): unknown => {
	if (Option.isOption(value)) {
		return Option.isSome(value) ? { some: canon(value.value) } : "none"
	}
	if (typeof value === "bigint") {
		return `bigint ${value}`
	}
	if (typeof value === "number") {
		return Object.is(value, -0) ? "number -0" : `number ${String(value)}`
	}
	if (isList(value)) {
		return Arr.map(value, canon)
	}
	if (typeof value === "object" && value !== null) {
		const proto: unknown = Object.getPrototypeOf(value)
		if (proto !== null && proto !== Object.prototype) {
			return `${constructorName(proto)} ${Formatter.format(value)}`
		}
		const out: Record<string, unknown> = {}
		const fields = rowOf(value)
		for (const k of Arr.sort(Rec.keys(fields), Order.String)) {
			const v = canon(fields[k])
			out[k] = isList(v) ? Arr.sort([...v], Order.mapInput(Order.String, canonicalTextOf)) : v
		}
		return out
	}
	return value
}

/**
 * A paged member's page runtime with the installation's codes, which its rows' closed ids and sets order and decode by,
 * and its key fields, the completed order's columns, whose values in order are a row's RowKey and a window's anchor.
 */
export interface TestPage {
	readonly runtime: PageRuntime
	readonly codes: Codebook
	readonly fields: KeyFields
}

/**
 * The page runtime of the paged member `member`, as its served file holds it and its layer loads it
 * (adapter/served/load.ts LoadedPage), with `codes`, the installation's: a member that pages nothing is a defect of the
 * test.
 */
export const pageTemplate = (member: LoadedMember, codes: Codebook): TestPage => {
	if (member.kind !== "paged") {
		throw new Error(`the member ${member.name} pages nothing`)
	}
	return { runtime: member.page.runtime, codes, fields: member.read.key.fields }
}

/** The page's completed order over records holding its order's columns: negative when the first comes first. */
export const pageOrder = (compiled: TestPage): ((a: unknown, b: unknown) => number) => {
	const types: Record<string, ScalarType> = {}
	for (const c of compiled.runtime.page.heading) {
		types[c.name] = c.type
	}
	const compare = mergeComparator({
		order: compiled.runtime.page.order,
		types,
		codes: compiled.codes
	})
	if (!compare.ok) {
		throw new Error(compare.error.message)
	}
	return (a, b) => compare.value(rowOf(a), rowOf(b))
}

/**
 * The complete sorted distinct result D: `rows`, a read's whole answer, sorted on the page's completed order, in
 * canonical form; no two rows tie on it.
 */
export const sortedResult = (
	compiled: TestPage,
	rows: ReadonlyArray<unknown>
): ReadonlyArray<unknown> => {
	const order = pageOrder(compiled)
	const sorted = Arr.sort(rows, (a: unknown, b: unknown) => {
		const sign = order(a, b)
		return sign < 0 ? -1 : sign > 0 ? 1 : 0
	})
	for (let i = 1; i < sorted.length; i++) {
		assert.notEqual(order(sorted[i - 1], sorted[i]), 0, "the page order is total over D")
	}
	return Arr.map(sorted, canon)
}

/** A RowKey as the record of its fields' values, which the page order compares rows with. */
const keyRecord = (fields: KeyFields, key: RowKey): Readonly<Record<string, unknown>> =>
	Rec.fromEntries(Arr.zip(fields, key))

/**
 * The rows of `rows` strictly after the anchor's values `key` in the page order, sorted and canonical: what a window
 * after the key reads, whether or not a row of the key is still among them.
 */
export const strictlyAfter = (
	compiled: TestPage,
	rows: ReadonlyArray<unknown>,
	key: RowKey
): ReadonlyArray<unknown> => {
	const order = pageOrder(compiled)
	const anchor = keyRecord(compiled.fields, key)
	return sortedResult(
		compiled,
		Arr.filter(rows, (r) => order(r, anchor) > 0)
	)
}

/**
 * The rows of `rows` strictly before the anchor's values `key` in the page order, sorted and canonical: what a window
 * before the key reads, whether or not a row of the key is still among them.
 */
export const strictlyBefore = (
	compiled: TestPage,
	rows: ReadonlyArray<unknown>,
	key: RowKey
): ReadonlyArray<unknown> => {
	const order = pageOrder(compiled)
	const anchor = keyRecord(compiled.fields, key)
	return sortedResult(
		compiled,
		Arr.filter(rows, (r) => order(r, anchor) < 0)
	)
}

/** Whether a row of `rows` holds the anchor's values `key`. */
export const holdsKey = (
	compiled: TestPage,
	rows: ReadonlyArray<unknown>,
	key: RowKey
): boolean => {
	const order = pageOrder(compiled)
	const anchor = keyRecord(compiled.fields, key)
	return Arr.some(rows, (r) => order(r, anchor) === 0)
}

/** Where a walk starts: D's first rows, each window after the last one's last row; or its last, each before the first. */
export type From = "start" | "end"

export interface Walk {
	/** Every window in the order the walk read them, its last the empty window that ends it, each row canonical. */
	readonly windows: ReadonlyArray<ReadonlyArray<unknown>>
	/** The rows of every window, in D's order, canonical. */
	readonly nodes: ReadonlyArray<unknown>
}

/**
 * Every window of D through the paged member `calls`, whose rows' Keys are their `fields`' values: from the start, each
 * window after the last row of the one before, or from the end, each before its first row, until a window holds no
 * row. A walk over D of `rows` rows ends within rows + 1 windows at any size; one that does not is a defect.
 */
export const walk = (
	calls: ServedCalls,
	fields: KeyFields,
	params: unknown,
	size: number,
	from: From,
	rows: number
): Effect.Effect<Walk, CallError> =>
	Effect.gen(function* () {
		const windows: Array<ReadonlyArray<DecodedRow>> = []
		let anchor: Anchor = from === "start" ? { kind: "start" } : { kind: "end" }
		while (windows.length <= rows) {
			const window = yield* windowOf(calls, params, anchor, size)
			windows.push(window)
			const edge = from === "start" ? Arr.last(window) : Arr.head(window)
			if (Option.isNone(edge)) {
				const presented = from === "start" ? windows : Arr.reverse(windows)
				return {
					windows: Arr.map(windows, (w) => Arr.map(w, canon)),
					nodes: Arr.flatMap(presented, (w) => Arr.map(w, canon))
				}
			}
			const key = keyOf(fields, edge.value)
			anchor = from === "start" ? { kind: "after", key } : { kind: "before", key }
		}
		return assert.fail(`a walk of D's ${rows} rows read more than ${rows + 1} windows`)
	})

/**
 * The windows a walk of `size` reads over D, `full`, in the order it reads them: D cut into windows of `size` rows from
 * its start, or from its end, each window in D's order, then the empty window that ends the walk.
 */
export const expectedWalk = (
	full: ReadonlyArray<unknown>,
	size: number,
	from: From
): ReadonlyArray<ReadonlyArray<unknown>> => {
	const out: Array<ReadonlyArray<unknown>> = []
	for (let read = 0; read < full.length; read += size) {
		out.push(
			from === "start"
				? full.slice(read, read + size)
				: full.slice(Math.max(0, full.length - read - size), full.length - read)
		)
	}
	out.push([])
	return out
}
