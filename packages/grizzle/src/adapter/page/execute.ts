import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
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
import {
	countParam,
	defect,
	mergeHeadingGroups,
	rowText,
	runsLargeForm
} from "#compiler/plan/runtime.ts"

import {
	type ExecutionInputs,
	encodeForm,
	formFor,
	inputCount,
	partRuns,
	readBinding,
	rowsOf,
	runOf,
	type SentRuns,
	type StatementRecord
} from "#adapter/reader/execution.ts"
import type { GroupOrder } from "#adapter/reader/run.ts"
import { type BatchStatement, type Flight, keptRows, sentAnswer } from "#adapter/wire/batch.ts"
import type { AssembledRows, Cell, ParamText, Row } from "#compiler/plan/common.ts"
import type { ScalarReader } from "#compiler/plan/decode.ts"
import type {
	AnchoredVariant,
	ChoiceInput,
	PageFill,
	PageStatementSlot,
	PageVariant,
	ProbeKind,
	SizeFill,
	VariantFill
} from "#compiler/plan/read.ts"
import type { ServedChoice } from "#compiler/plan/serve.ts"

/**
 * One page request as one flight of one transaction.
 *
 * The caller runs the flight (page.ts): a lone statement as itself, anything more in one read-only transaction, so the
 * rows, the attachments and the probe describe one snapshot. The flight is one round trip, and every statement in it
 * binds only the request: none reads another's rows. The request's statement binds its parameters, chooses its
 * per-execution form and delivers its parts' records as a read's does (reader/execution.ts), from what the page
 * runtime template settled once (template.ts).
 *
 * 1. The rows part of the request variant, or one per heading group of a heterogeneous union. Each is
 *    take(k + 1) in the variant's fetch order after its seek: its limit placeholder takes the validated size plus one,
 *    and each boundary placeholder the anchor's canonical text at that comparator's position, byte for byte as the
 *    cursor carried it; every other placeholder is a declared parameter, encoded by the statement's own encoder, or a
 *    relation parameter in the transport its distinct fact count selected (reader/relations.ts). A statement with a
 *    per-execution form runs that form when one of its choices' inputs exceeds the choice's threshold: a relation
 *    parameter's distinct fact count, or, for an attachment's take over the delivered page, the requested size.
 * 2. Attachments, evaluated over the delivered page only: each part reads the page's delivered rows, which the
 *    statement holds once, the lookahead row dropped and a heading group's rows cut by the merge
 *    (lower/shapes/page/rows.ts), from the same placeholders, whose size placeholder takes the validated size.
 *    Children are stitched onto their parents by key,
 *    in the attachment's delivered type, exactly as a read stitches them. The cursor, the flags and the order are the
 *    parent's alone.
 * 3. The opposite flag: an after or before request's probe (compile.ts requestFlags), one statement of one Boolean
 *    column, bound to the request's anchor with the inclusive rule, which decides the flag for an empty page and a
 *    nonempty one alike (seek.ts probeKinds). first and last need no probe: nothing precedes D's first tuple or
 *    follows its last. A flag is never set because a cursor was supplied: the probe decides it.
 * 4. Once the flight answers, heading groups are merged on the fetch order and cut to k + 1: the first k + 1 of the
 *    union lie among the first k + 1 of each group (union/index.ts mergeHeadingGroups), each row keyed by the fetch
 *    order's columns converted from its group's texts. The lookahead: k + 1
 *    candidates prove the flag of the fetching direction, and the extra one is dropped; it never becomes a delivered
 *    edge or a cursor. A backward variant's retained rows are reversed back to the presentation order.
 *
 * Each delivered edge keeps its comparison tuple, its comparators' values converted from the database output texts by
 * the comparators' value codecs (template.ts): the cursor is made from those values, never recomputed from presentation
 * values. The kept rows are delivered as Rows, which the query's decoder reads (page.ts). A statement failure fails the
 * page: there is no short page.
 *
 * One request as it runs: its variant and the validated size, and for after and before the anchor's boundary texts,
 * one per comparator, from the validated cursor (codec/cursor DecodedCursor.texts).
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

interface DeliveredEdge {
	/** The rows part that delivered it, and its row's cells. */
	readonly statement: StatementRecord
	readonly raw: ReadonlyArray<Cell>
	/** The delivered Row: the row's cells with its attachments' child Rows, which the query's decoder reads. */
	readonly row: Row
	/** The comparison tuple, the comparators' values in order. */
	readonly tuple: ComparisonTuple
}

export interface PageRows {
	/** The delivered edges in presentation order. */
	readonly edges: ReadonlyArray<DeliveredEdge>
	readonly hasPreviousPage: boolean
	readonly hasNextPage: boolean
	/** The rows of each attachment part, by its record. */
	readonly attachments: ReadonlyMap<StatementRecord, AssembledRows>
	/** The probe that decided the opposite flag, none when none ran. */
	readonly probe: Option.Option<ProbeKind>
	/** How many statements were sent. */
	readonly statements: number
}

/**
 * The text of a size fill, a `$n::bigint` bound as the decimal digits of a bigint: the limit, the validated size plus
 * one, or the size. Every validated size, a safe integer, and that size plus one are bigint values.
 */
const sizeBinding = (fill: SizeFill, size: number): ParamText => {
	switch (fill.kind) {
		case "limit":
			return countParam(size + 1)
		case "size":
			return countParam(size)
	}
}

/** An anchored request: its variant, its validated size and its decoded cursor's boundary texts. */
type AnchoredCall = Extract<PageCall, { readonly variant: AnchoredVariant }>

/**
 * The binding of an anchored request's page placeholder: a size fill's text (sizeBinding), or a boundary value as the
 * cursor carried it. The cursor's decode checks its foreign text against the comparators, one text per comparator
 * (codec/cursor), and the engine allocates one boundary placeholder per comparator, at its position, so a position the
 * decoded boundary holds no text at is a defect of the compiler.
 */
const anchoredBinding =
	(call: AnchoredCall) =>
	(fill: PageFill): ParamText => {
		if (fill.kind !== "boundary") {
			return sizeBinding(fill, call.size)
		}
		const text = call.boundary[fill.position]
		if (text === undefined) {
			throw defect(`a ${call.variant} request binds its page boundary placeholder ${fill.position}`)
		}
		return text
	}

/** The size of a choice's input in one execution: the requested size, or a relation parameter's distinct fact count. */
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
 * The `encode` phase of `run`, in the form the requested size and `inputs` choose, each page placeholder bound by
 * `bind`, which takes every fill the statement holds.
 */
const sending = <F extends PageFill>(
	run: PageRunStatement<F>,
	inputs: ExecutionInputs,
	size: number,
	bind: (fill: F) => ParamText
): Effect.Effect<BatchStatement, InputTooLarge> => {
	const form = formFor(run, (choice: ServedChoice<ChoiceInput>) =>
		runsLargeForm(choice, choiceCount(choice, inputs, size))
	)
	return encodeForm(
		form,
		(slot: PageStatementSlot<F>) =>
			slot.kind === "page" ? Result.succeed(bind(slot.fill)) : readBinding(slot, inputs),
		keptRows
	)
}

/**
 * A row a rows statement delivered, a candidate edge: its statement, its heading group, its cells and its comparison
 * tuple.
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
 * Whether the probe's one row says D holds a tuple on its side of the anchor: its one Boolean column. Its SQL is
 * grizzle's one EXISTS over its column, but the rows are the server's answer, so any other answer is UnreadableAnswer
 * at the probe's position `index`.
 */
const probeAnswer = (
	probe: SentProbe,
	rows: AssembledRows,
	index: number
): Result.Result<boolean, UnreadableAnswer> => {
	const [only, ...rest] = rows
	const value =
		only === undefined || rest.length > 0 ? undefined : probe.answer.convert(rowText(only, 0))
	return typeof value === "boolean" ? Result.succeed(value) : Result.fail(contradicted(index))
}

/**
 * The delivered edges of a request of `size` whose sent statements answered `sent`, in presentation order, and whether
 * its lookahead row came back, which proves the flag of the fetching direction.
 */
interface PageEdges {
	readonly edges: ReadonlyArray<DeliveredEdge>
	readonly lookahead: boolean
}

/**
 * The candidates in fetch order: each rows statement's of a rows delivery, which its LIMIT bounds by `limit`, the size
 * plus one; or the heading groups merged on the fetch order and cut to `limit`. The rows are the server's answer, so a
 * statement answering more than its LIMIT is UnreadableAnswer at its position.
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
 * or a step back, which a request's rows, distinct by the completed order's key and fetched in that order, never hold.
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
 * The delivered edges of a request whose sent statements answered `sent` (see the header, 4). The candidates are a
 * strictly increasing sequence under the fetch order, so the lookahead counts distinct rows: a candidate that repeats
 * or precedes the one before it is UnreadableAnswer at its statement, as is a kept statement's answer that repeats a
 * row (reader/execution.ts rowsOf).
 */
export const pageEdges = (
	program: RunProgram,
	sent: SentRuns,
	size: number
): Result.Result<PageEdges, UnreadableAnswer> =>
	Result.flatMap(fetchOrder(program.delivery, sent, size + 1), (candidates) => {
		const stray = outOfOrder(candidates, program.fetch)
		if (stray !== undefined) {
			return Result.fail(contradicted(0))
		}
		const delivery = program.delivery
		/** The lookahead, dropped. */
		const lookahead = candidates.length > size
		const kept = candidates.slice(0, lookahead ? size : candidates.length)
		const statements: ReadonlyArray<RowsStatement> =
			delivery.kind === "concat" ? delivery.groups : Arr.map(delivery.order.groups, (g) => g.group)
		/** Each kept candidate as an edge at its fetch position, its rows statement's kept rows read as Rows together. */
		const placed: Array<{ readonly at: number; readonly edge: DeliveredEdge }> = []
		for (const [group, rows] of statements.entries()) {
			const mine = kept.flatMap((c, at) => (c.statement === rows ? [{ c, at }] : []))
			const read = rowsOf(
				rows.record,
				sent,
				Arr.map(mine, ({ c }) => c.cells),
				group
			)
			if (Result.isFailure(read)) {
				return Result.fail(read.failure)
			}
			for (const [{ c, at }, row] of Arr.zip(mine, read.success)) {
				placed.push({
					at,
					edge: { statement: c.statement.record, raw: c.cells, row, tuple: c.tuple }
				})
			}
		}
		const fetched = placed.toSorted((a, b) => a.at - b.at).map((p): DeliveredEdge => p.edge)
		/** A backward page, reversed to the presentation order. */
		const edges = program.program.direction === "backward" ? fetched.toReversed() : fetched
		return Result.succeed({ edges, lookahead })
	})

/** The candidates of `rows`, heading group `group`, in a flight whose sent statements answered `sent`. */
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

/**
 * A probe as an anchored request sends it: its kind, its one Boolean column's codec, which reads its answer, and its
 * statement in this form.
 */
interface SentProbe {
	readonly kind: ProbeKind
	readonly answer: ScalarReader
	readonly statement: BatchStatement
}

/** The probe of an anchored request, the kind its variant names, in the form this execution runs. */
const probeSending = (
	run: PageRuntime["artifact"],
	inputs: ExecutionInputs,
	call: AnchoredCall,
	bind: (fill: PageFill) => ParamText
): Effect.Effect<SentProbe, InputTooLarge> => {
	const probe = run.probes[run.requests[call.variant].program.probe]
	return Effect.map(sending(probe.statement, inputs, call.size, bind), (statement) => ({
		kind: probe.program.kind,
		answer: probe.answer,
		statement
	}))
}

/**
 * The flight of one request of `program`, whose page placeholders `bind` binds, of the requested size `size`, and the
 * probe of its opposite flag `probe` sends, none for a plain request (see the header).
 */
const requestFlight = <V extends PageVariant>(
	program: RunProgram<V>,
	inputs: ExecutionInputs,
	size: number,
	bind: (fill: VariantFill[V]) => ParamText,
	probe: Effect.Effect<Option.Option<SentProbe>, InputTooLarge>
): Effect.Effect<Flight<PageRows, UnreadableAnswer>, InputTooLarge> =>
	Effect.gen(function* () {
		/** 1, 2. The request's statement, its rows parts and their attachments'. */
		const batch: Array<BatchStatement> = [yield* sending(program.run, inputs, size, bind)]
		/** 3. An anchored request's opposite flag: its probe on the anchor. */
		const probing = yield* probe
		if (Option.isSome(probing)) {
			batch.push(probing.value.statement)
		}
		return {
			statements: batch,
			read: (outcomes) =>
				Effect.fromResult(
					Result.gen(function* () {
						const runs: SentRuns = partRuns(program.run.parts, sentAnswer(outcomes, 0).rows)
						const attachments = new Map<StatementRecord, AssembledRows>()
						for (const record of program.records) {
							for (const { record: child } of record.plan.children) {
								attachments.set(child, runOf(child, runs))
							}
						}
						let opposite = false
						if (Option.isSome(probing)) {
							for (const outcome of outcomes.slice(1)) {
								opposite = yield* probeAnswer(probing.value, outcome.rows, 1)
							}
						}
						const page = yield* pageEdges(program, runs, size)
						const flags = program.program
						return {
							edges: page.edges,
							hasPreviousPage: flags.lookahead === "hasPreviousPage" ? page.lookahead : opposite,
							hasNextPage: flags.lookahead === "hasNextPage" ? page.lookahead : opposite,
							attachments,
							probe: Option.map(probing, (p) => p.kind),
							statements: batch.length
						}
					})
				)
		}
	})

/** The flight of one page request, reading its rows (see the header): a plain request's binds its size alone. */
export const pageFlight = (
	runtime: PageRuntime,
	inputs: ExecutionInputs,
	call: PageCall
): Effect.Effect<Flight<PageRows, UnreadableAnswer>, InputTooLarge> => {
	const run = runtime.artifact
	switch (call.variant) {
		case "first":
		case "last":
			return requestFlight(
				run.requests[call.variant],
				inputs,
				call.size,
				(fill: SizeFill) => sizeBinding(fill, call.size),
				Effect.succeedNone
			)
		case "after":
		case "before": {
			const bind = anchoredBinding(call)
			return requestFlight(
				run.requests[call.variant],
				inputs,
				call.size,
				bind,
				Effect.asSome(probeSending(run, inputs, call, bind))
			)
		}
	}
}
