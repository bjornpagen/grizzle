import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import type { CompiledOps } from "#adapter/db/ops.ts"
import type { ReadError } from "#adapter/errors/execution.ts"
import type { PageRuntime } from "#adapter/page/template.ts"
import type { ReadExecutor } from "#adapter/reader/executor.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import type { CursorError } from "#compiler/core/errors.ts"
import { isRecord } from "#compiler/core/record.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { Param } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { ParamMap } from "#compiler/plan/common.ts"
import { assert } from "#test/support/assert.ts"
import { isList } from "#test/support/list.ts"
import { mergeComparator } from "#test/support/merge.ts"

/**
 * A page as the runtime delivers it, trusted at its documented shape: a served member's operations type it unknown,
 * since its program is.
 */
export interface PageValue {
	readonly edges: ReadonlyArray<{ readonly node: unknown; readonly cursor: string }>
	readonly pageInfo: {
		readonly startCursor: Option.Option<string>
		readonly endCursor: Option.Option<string>
		readonly hasPreviousPage: boolean
		readonly hasNextPage: boolean
	}
}

const admitPage = (page: unknown): PageValue => trusted<PageValue>(page)

/**
 * A page of the paged member `ops` with `params`, admitted at its documented shape.
 *
 * Shared helpers for the page runtime suites (test/pg/page).
 *
 * Every suite pages through the members of a login's served workload, exactly as an application does, over the Paging
 * fixture and the boundary-value Measures fixture of the unit page suites (test/unit/page/fixtures.ts). A page's nodes
 * are compared as canonical values (`canon`), which keep every carrier's identity: a bigint, a Decimal's text, a float's
 * sign of zero and NaN, an Option.
 */
export const pageOf = (
	ops: CompiledOps<unknown>,
	params: ParamMap,
	request: unknown
): Effect.Effect<PageValue, ReadError | CursorError> =>
	Effect.map(ops.page(params, request), admitPage)

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

/** A paged member's page runtime with the installation's codes, which its rows' closed ids and sets order and decode by. */
export interface TestPage {
	readonly runtime: PageRuntime
	readonly codes: Codebook
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
	return { runtime: member.page.runtime, codes }
}

/**
 * The complete sorted distinct result D: the rows the reader's execute delivers, sorted on the page's completed order,
 * in canonical form.
 */
export const sortedResult = (
	compiled: TestPage,
	rows: ReadonlyArray<unknown>
): ReadonlyArray<unknown> => {
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
	/** The page's completed order: the comparator's sign. */
	const pageOrder: Order.Order<unknown> = (a, b) => {
		const sign = compare.value(rowOf(a), rowOf(b))
		return sign < 0 ? -1 : sign > 0 ? 1 : 0
	}
	const sorted = Arr.sort(rows, pageOrder)
	for (let i = 1; i < sorted.length; i++) {
		assert.notEqual(
			compare.value(rowOf(sorted[i - 1]), rowOf(sorted[i])),
			0,
			"the page order is total over D"
		)
	}
	return Arr.map(sorted, canon)
}

/** The page's completed order over delivered rows: negative when the first row comes first. */
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
 * The rows strictly after an anchor's values in the page order, sorted and canonical: what a forward
 * page after the anchor's cursor reads from `rows`, whether or not the anchor is still among them.
 */
export const strictlyAfter = (
	compiled: TestPage,
	rows: ReadonlyArray<unknown>,
	anchor: unknown
): ReadonlyArray<unknown> => {
	const order = pageOrder(compiled)
	return sortedResult(
		compiled,
		Arr.filter(rows, (r) => order(r, anchor) > 0)
	)
}

/**
 * The rows strictly before an anchor's values in the page order, sorted and canonical: what a backward page before the
 * anchor's cursor reads from `rows`, whether or not the anchor is still among them.
 */
export const strictlyBefore = (
	compiled: TestPage,
	rows: ReadonlyArray<unknown>,
	anchor: unknown
): ReadonlyArray<unknown> => {
	const order = pageOrder(compiled)
	return sortedResult(
		compiled,
		Arr.filter(rows, (r) => order(r, anchor) < 0)
	)
}

export interface Traversal {
	readonly pages: ReadonlyArray<PageValue>
	/** The nodes of every page, in presentation order, canonical. */
	readonly nodes: ReadonlyArray<unknown>
}

/**
 * The most pages one traversal takes before it counts as one that does not end: the suites' D hold at most a few
 * dozen rows, so a page size of 1 ends far below it.
 */
const traversalPagesMax = 1_000

/**
 * Every page of D through the paged member `ops`, forward from { first }, following each endCursor while hasNextPage,
 * or backward from { last }, following each startCursor while hasPreviousPage.
 */
export const traverse = (
	ops: CompiledOps<unknown>,
	params: ParamMap,
	direction: "forward" | "backward",
	size: number,
	/** Where the traversal starts: the first or last tuple, or an anchor's cursor. */
	from: { readonly kind: "end" } | { readonly kind: "anchor"; readonly cursor: string }
): Effect.Effect<Traversal, ReadError | CursorError> =>
	Effect.gen(function* () {
		const pages: Array<PageValue> = []
		let request: object =
			direction === "forward"
				? from.kind === "end"
					? { first: size }
					: { first: size, after: from.cursor }
				: from.kind === "end"
					? { last: size }
					: { last: size, before: from.cursor }
		for (let n = 0; n < traversalPagesMax; n++) {
			const page = yield* pageOf(ops, params, request)
			pages.push(page)
			const more =
				direction === "forward" ? page.pageInfo.hasNextPage : page.pageInfo.hasPreviousPage
			const next = direction === "forward" ? page.pageInfo.endCursor : page.pageInfo.startCursor
			if (!more || Option.isNone(next)) {
				const ordered = direction === "forward" ? pages : Arr.reverse(pages)
				return {
					pages,
					nodes: Arr.flatMap(ordered, (p) => Arr.map(p.edges, (e) => canon(e.node)))
				}
			}
			request =
				direction === "forward"
					? { first: size, after: next.value }
					: { last: size, before: next.value }
		}
		throw new Error(`a traversal of more than ${traversalPagesMax} pages`)
	})

/**
 * Holds a page's edges and edge cursors to its own shape: startCursor and endCursor are the first and last
 * edges' cursors, Option.none on an empty page.
 */
export const assertEdges = (page: PageValue, label: string): void => {
	const first = page.edges[0]
	const last = page.edges[page.edges.length - 1]
	assert.deepEqual(
		page.pageInfo.startCursor,
		first === undefined ? Option.none() : Option.some(first.cursor),
		label
	)
	assert.deepEqual(
		page.pageInfo.endCursor,
		last === undefined ? Option.none() : Option.some(last.cursor),
		label
	)
	for (const e of page.edges) {
		assert.equal(typeof e.cursor, "string", label)
	}
}

export interface Counts {
	/** Reads the executor ran, each on one session and, past a lone statement, in one transaction. */
	within: number
	/** The flights sent: one round trip each. */
	flights: number
	/** Statements sent through the page's session. */
	statements: number
	/** Every statement text and its parameters as sent, a text or a binary value each (core/wire.ts Param), in order. */
	readonly sent: Array<{ readonly sql: string; readonly params: ReadonlyArray<Param> }>
}

/** An executor that counts the reads, flights and statements a page sends through `inner`. */
export const countingExecutor = (
	inner: ReadExecutor
): { readonly executor: ReadExecutor; readonly counts: Counts } => {
	const counts: Counts = { within: 0, flights: 0, statements: 0, sent: [] }
	const executor: ReadExecutor = {
		run: (flight) =>
			Effect.suspend(() => {
				counts.within++
				if (flight.statements.length > 0) {
					counts.flights++
				}
				for (const statement of flight.statements) {
					counts.statements++
					counts.sent.push({
						sql: statement.sql,
						params: statement.params
					})
				}
				return inner.run(flight)
			})
	}
	return { executor, counts }
}
