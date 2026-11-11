import * as Arr from "effect/Array"
import type * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { type InputTooLarge, UnreadableAnswer } from "#adapter/errors/failures.ts"
import type {
	ComparisonTuple,
	PageDelivery,
	PageRunStatement,
	PageRuntime,
	RowsStatement,
	RunProgram
} from "#adapter/page/template.ts"
import type { ReadIntake } from "#adapter/reader/run.ts"
import { countParam, defect, mergeHeadingGroups, runsLargeForm } from "#compiler/plan/runtime.ts"

import {
	type ExecutionInputs,
	encodeForm,
	formFor,
	inputCount,
	partRuns,
	readBinding,
	rowsOf,
	runOf,
	type SentRuns
} from "#adapter/reader/execution.ts"
import type { GroupOrder } from "#adapter/reader/run.ts"
import type { PreparedStatement, RowIntake } from "#adapter/wire/batch.ts"
import type { Cell, OutputRows, ParamText, Row } from "#compiler/plan/common.ts"
import type { ChoiceInput, PageFill, PageStatementSlot } from "#compiler/plan/read.ts"
import type { ServedChoice } from "#compiler/plan/serve.ts"

/**
 * One window of a paged member as one statement of one read's flight.
 *
 * The window's statement runs in a read's one flight (reader/stream.ts), its rows taken as they arrive and read once it
 * has answered whole (windowIntake). Its statement binds its parameters, chooses its per-execution form and delivers its
 * parts' records as a read's does (reader/execution.ts), from what the page runtime template settled once
 * (template.ts).
 *
 * 1. The rows part of the window's template, or one per heading group of a heterogeneous union. Each is take(size) in
 *    the template's fetch order after its seek: its size placeholder takes the window's size, its LIMIT and its
 *    attachments' bound alike, and each boundary placeholder the anchor's text at that comparator's position, its
 *    comparator column's codec's (window.ts); every other placeholder is a declared parameter, encoded by the
 *    statement's own encoder, or a relation parameter in the transport its distinct fact count selected
 *    (reader/relations.ts). A statement with a
 *    per-execution form runs that form when one of its choices' inputs exceeds the choice's threshold: a relation
 *    parameter's distinct fact count, or, for an attachment's take over the window, its size.
 * 2. Attachments, evaluated over the window's rows only: each part reads the window's delivered rows, which the
 *    statement holds once, a heading group's rows cut by the merge (lower/shapes/page/rows.ts), from the same
 *    placeholders. Children are stitched onto their parents by key, in the attachment's delivered type, exactly as a read
 *    stitches them.
 * 3. Once the statement has answered, heading groups are merged on the fetch order and cut to the size: the first k of
 *    the union lie among the first k of each group (union/index.ts mergeHeadingGroups), each row keyed by the fetch
 *    order's columns converted from its group's texts. A backward template's rows are reversed back to the
 *    presentation order.
 *
 * Whether more rows lie beyond a window is no flag of it: the adjacent window, anchored at its first or last row's key,
 * answers them, and answers none where none lie. A statement failure fails the window: there is no short window.
 *
 * One window as it runs: its template's variant and its size, and an anchored window's boundary texts, one per
 * comparator, its RowKey's values written by their comparators' codecs (window.ts windowCall).
 */
export type PageCall =
	| { readonly variant: "first"; readonly size: number }
	| { readonly variant: "last"; readonly size: number }
	| {
			readonly variant: "after"
			readonly size: number
			readonly boundary: ReadonlyArray<ParamText>
	  }
	| {
			readonly variant: "before"
			readonly size: number
			readonly boundary: ReadonlyArray<ParamText>
	  }

/** A delivered row of a window: the Row the query's decoder reads, its row's cells with its attachments' child Rows. */
interface DeliveredEdge {
	readonly row: Row
}

/**
 * The binding of a window's page placeholder: the size fill's text, the window's size, or a boundary value as the
 * window's anchor wrote it. The engine allocates one boundary
 * placeholder per comparator, at its position, and the window's RowKey holds one value per comparator (window.ts), so a
 * position the boundary holds no text at is a defect of the compiler.
 */
const windowBinding =
	(call: PageCall) =>
	(fill: PageFill): ParamText => {
		if (fill.kind !== "boundary") {
			return countParam(call.size)
		}
		const boundary = "boundary" in call ? call.boundary : []
		const text = boundary[fill.position]
		if (text === undefined) {
			throw defect(`a ${call.variant} window binds its page boundary placeholder ${fill.position}`)
		}
		return text
	}

/** The size of a choice's input in one execution: the window's size, or a relation parameter's distinct fact count. */
const choiceCount = (
	choice: ServedChoice<ChoiceInput>,
	inputs: ExecutionInputs,
	size: number
): number => {
	const source = choice.source
	switch (source.kind) {
		case "pageSize":
			return size
		case "relation":
			return inputCount(inputs, source.param)
	}
}

/**
 * The statement of `run`, in the form the window's size and `inputs` choose, each page placeholder bound by `bind`,
 * which takes every fill the statement holds, its rows going to `intake`.
 */
const sending = <F extends PageFill>(
	run: PageRunStatement<F>,
	inputs: ExecutionInputs,
	size: number,
	bind: (fill: F) => ParamText,
	intake: RowIntake
): Effect.Effect<PreparedStatement, InputTooLarge> => {
	const form = formFor(run, (choice: ServedChoice<ChoiceInput>) =>
		runsLargeForm(choice, choiceCount(choice, inputs, size))
	)
	return encodeForm(
		form,
		(slot: PageStatementSlot<F>) =>
			slot.kind === "page" ? Result.succeed(bind(slot.fill)) : readBinding(slot, inputs),
		intake
	)
}

/** The statement of window `call` of `runtime`, its rows going to `intake` (see the header, 1 and 2). */
export const windowStatement = (
	runtime: PageRuntime,
	inputs: ExecutionInputs,
	call: PageCall,
	intake: RowIntake
): Effect.Effect<PreparedStatement, InputTooLarge> =>
	sending(
		runtime.artifact.requests[call.variant].run,
		inputs,
		call.size,
		windowBinding(call),
		intake
	)

/**
 * A row a rows statement delivered, a candidate row of the window: its statement, its heading group, its cells and its
 * comparison tuple.
 */
interface Candidate {
	readonly statement: RowsStatement
	readonly group: number
	readonly cells: ReadonlyArray<Cell>
	readonly tuple: ComparisonTuple
}

/** The server's answer contradicting what statement `index` is proved to deliver, after the read committed. */
const contradicted = (index: number): UnreadableAnswer =>
	new UnreadableAnswer({ index, fate: "committed" })

/**
 * The candidates in fetch order: each rows statement's of a rows delivery, which its LIMIT bounds by `limit`, the size;
 * or the heading groups merged on the fetch order and cut to `limit`. The rows are the server's answer, so a statement
 * answering more than its LIMIT is UnreadableAnswer at its position.
 */
const fetchOrder = (
	delivery: PageDelivery,
	sent: SentRuns,
	limit: number
): Result.Result<ReadonlyArray<Candidate>, UnreadableAnswer> => {
	if (delivery.kind === "groups") {
		return Result.succeed(mergedCandidates(delivery.order, sent, limit))
	}
	const out: Array<Candidate> = []
	for (const [group, rows] of delivery.groups.entries()) {
		const candidates = candidatesOf(rows, group, sent)
		if (candidates.length > limit) {
			return Result.fail(contradicted(0))
		}
		for (const candidate of candidates) {
			out.push(candidate)
		}
	}
	return Result.succeed(out)
}

/**
 * The first candidate whose comparison tuple does not strictly follow the one before it in the fetch order: a repeat
 * or a step back, which a window's rows, distinct by the completed order's key and fetched in that order, never hold.
 */
const outOfOrder = (
	candidates: ReadonlyArray<Candidate>,
	fetch: RunProgram["fetch"]
): Candidate | undefined => {
	for (const [at, candidate] of candidates.entries()) {
		const before = candidates[at - 1]
		if (before !== undefined && fetch(before.tuple, candidate.tuple) >= 0) {
			return candidate
		}
	}
	return undefined
}

/**
 * The delivered rows of a window of `size` whose statement answered `sent`, in presentation order (see the header, 3).
 * The candidates are a strictly increasing sequence under the fetch order: a candidate that repeats or precedes the one
 * before it is UnreadableAnswer at its statement, as is a statement's answer that repeats a row (reader/execution.ts
 * rowsOf).
 */
const windowEdges = (
	program: RunProgram,
	sent: SentRuns,
	size: number
): Result.Result<ReadonlyArray<DeliveredEdge>, UnreadableAnswer> =>
	Result.flatMap(fetchOrder(program.delivery, sent, size), (candidates) => {
		const stray = outOfOrder(candidates, program.fetch)
		if (stray !== undefined) {
			return Result.fail(contradicted(0))
		}
		const delivery = program.delivery
		const statements: ReadonlyArray<RowsStatement> =
			delivery.kind === "concat" ? delivery.groups : Arr.map(delivery.order.groups, (g) => g.group)
		/** Each candidate as a row at its fetch position, its rows statement's rows read as Rows together. */
		const placed: Array<{ readonly at: number; readonly edge: DeliveredEdge }> = []
		for (const [group, rows] of statements.entries()) {
			const mine = candidates.flatMap((c, at) => (c.statement === rows ? [{ c, at }] : []))
			const read = rowsOf(
				rows.record,
				sent,
				Arr.map(mine, ({ c }) => c.cells),
				group
			)
			if (Result.isFailure(read)) {
				return Result.fail(read.failure)
			}
			for (const [{ at }, row] of Arr.zip(mine, read.success)) {
				placed.push({ at, edge: { row } })
			}
		}
		const fetched = placed.toSorted((a, b) => a.at - b.at).map((p): DeliveredEdge => p.edge)
		return Result.succeed(program.program.direction === "backward" ? fetched.toReversed() : fetched)
	})

/**
 * A window's intake for one call (reader/run.ts ReadIntake): every row of its statement taken as it arrives, and its
 * delivered Rows emitted to `emit` in presentation order once the statement has answered whole (windowEdges), since a
 * window's order, its merge and its backward reversal read its whole answer.
 */
export const windowIntake = (
	program: RunProgram,
	size: number,
	emit: (row: Row) => void
): ReadIntake => {
	const rows: Array<OutputRows[number]> = []
	return {
		take: (row) => {
			rows.push(row)
		},
		end: () =>
			Result.map(windowEdges(program, partRuns(program.run.parts, rows), size), (edges) => {
				for (const edge of edges) {
					emit(edge.row)
				}
			})
	}
}

/** The candidates of `rows`, heading group `group`, in a flight whose statement answered `sent`. */
const candidatesOf = (
	rows: RowsStatement,
	group: number,
	sent: SentRuns
): ReadonlyArray<Candidate> =>
	runOf(rows.record, sent).map((row): Candidate => ({
		statement: rows,
		group,
		cells: row,
		tuple: rows.tuple(row)
	}))

/** A candidate and its key under the fetch order. */
interface KeyedCandidate {
	readonly c: Candidate
	readonly key: Parameters<GroupOrder<RowsStatement>["compare"]>[0]
}

/** The candidates of every heading group of `order`, merged on it and cut to `limit`. */
const mergedCandidates = (
	order: GroupOrder<RowsStatement>,
	sent: SentRuns,
	limit: number
): ReadonlyArray<Candidate> => {
	const groups = order.groups.map((one, group) =>
		candidatesOf(one.group, group, sent).map((c): KeyedCandidate => ({ c, key: one.key(c.cells) }))
	)
	return mergeHeadingGroups(groups, (a, b) => order.compare(a.key, b.key), limit).map(
		(one) => one.row.c
	)
}
