import { Array as Arr, Effect, Option, Result } from "effect"
import { UnreadableAnswer } from "#adapter/errors/failures.ts"
import type {
	ComparisonTuple,
	PageArtifactName,
	PageDelivery,
	PageRecord,
	PageRunStatement,
	PageRuntime,
	RowsStatement,
	RunProgram
} from "#adapter/page/template.ts"

import {
	answerOf,
	type ExecutionInputs,
	encodeForm,
	formFor,
	inputCount,
	readBinding,
	rowsOf,
	runOf,
	type SentRuns,
	type StatementRun
} from "#adapter/reader/execution.ts"
import type { InputRefusal } from "#adapter/reader/relations.ts"
import type { GroupOrder } from "#adapter/reader/run.ts"
import type { BatchStatement, Flight } from "#adapter/wire/batch.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { type Row, rowText } from "#compiler/core/decoder.ts"
import { defect } from "#compiler/core/invariant.ts"
import type { PageParamSlot, PageStatementSlot } from "#compiler/lower/conservative/types.ts"
import type { ShapeChoice } from "#compiler/lower/shapes/index.ts"
import type { ProbeKind } from "#compiler/lower/shapes/page/seek.ts"
import { runsLargeForm } from "#compiler/lower/shapes/take/index.ts"
import { mergeHeadingGroups } from "#compiler/lower/shapes/union/index.ts"

type Raw = ReadonlyArray<ReadonlyArray<string>>

/**
 * One page request as one flight of one transaction.
 *
 * The caller runs the flight (page.ts): a lone statement as itself, anything more in one read-only transaction, so the
 * rows, the attachments and the probe describe one snapshot. The flight is one round trip, and every statement in it
 * binds only the request: none reads another's rows. Each statement binds its parameters, chooses its per-execution
 * form and delivers its records as a read's does (reader/execution.ts), from what the page runtime template settled
 * once (template.ts).
 *
 * 1. The rows statement of the request variant, or one per heading group of a heterogeneous union. Each is
 *    take(k + 1) in the variant's fetch order after its seek: its limit placeholder takes the validated size plus one,
 *    and each boundary placeholder the anchor's canonical text at that comparator's position, byte for byte as the
 *    cursor carried it; every other placeholder is a declared parameter, encoded by the statement's own encoder, or a
 *    relation parameter in the transport its distinct fact count selected (reader/relations.ts). A statement with a
 *    per-execution form runs that form when one of its choices' inputs exceeds the choice's threshold: a relation
 *    parameter's distinct fact count, or, for an attachment's take over the delivered page, the requested size.
 * 2. Attachments, evaluated over the delivered page only: each statement computes the page's delivered rows again,
 *    the lookahead row dropped and a heading group's rows cut by the merge (lower/shapes/page/rows.ts), from the same
 *    placeholders, whose size placeholder takes the validated size. Children are stitched onto their parents by key,
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
	| { readonly variant: "after"; readonly size: number; readonly boundary: ReadonlyArray<string> }
	| { readonly variant: "before"; readonly size: number; readonly boundary: ReadonlyArray<string> }

interface DeliveredEdge {
	/** The rows statement that delivered it, and its row's result texts. */
	readonly statement: PageRecord
	readonly raw: ReadonlyArray<string>
	/** The delivered Row: the row's texts with its attachments' child Rows, which the query's decoder reads. */
	readonly row: Row
	/** The comparison tuple, the comparators' values in order. */
	readonly tuple: ComparisonTuple
}

export interface PageRows {
	/** The delivered edges in presentation order. */
	readonly edges: ReadonlyArray<DeliveredEdge>
	readonly hasPreviousPage: boolean
	readonly hasNextPage: boolean
	/** The rows of each attachment statement, by its record. */
	readonly attachments: ReadonlyMap<PageRecord, Raw>
	/** The probe that decided the opposite flag, none when none ran. */
	readonly probe: Option.Option<ProbeKind>
	/** How many statements were sent. */
	readonly statements: number
}

/**
 * The binding of a page placeholder: the limit, the validated size plus one, and the size, each a `$n::bigint` bound as
 * the decimal digits of a bigint, which every validated size, a safe integer, and that size plus one are; and a
 * boundary value as the cursor carried it. The one site of the fact that a page statement's boundary placeholders are
 * those its request binds: one only in an anchored request, at a position of the boundary its decoded cursor carries
 * one value per comparator for. The engine allocates the placeholders and the cursor's decode admits the boundary
 * apart, runtime facts no TypeScript type ties together, so another binding is a defect of the compiler.
 */
const pageBinding = (slot: PageParamSlot, call: PageCall): string => {
	const fill = slot.fill
	switch (fill.kind) {
		case "limit":
			return (BigInt(call.size) + 1n).toString()
		case "size":
			return BigInt(call.size).toString()
		case "boundary": {
			const text =
				call.variant === "first" || call.variant === "last"
					? undefined
					: call.boundary[fill.position]
			if (text === undefined) {
				throw defect(
					`a ${call.variant} request binds its page boundary placeholder ${fill.position}`
				)
			}
			return text
		}
	}
}

/** The size of a choice's input in one execution: the requested size, or a relation parameter's distinct fact count. */
const choiceCount = (choice: ShapeChoice, inputs: ExecutionInputs, call: PageCall): number => {
	const source = choice.source
	switch (source.kind) {
		case "pageSize":
			return call.size
		case "relation":
			return inputCount(inputs, source.param)
	}
}

/** The `encode` phase of `run`, in the form `call` and `inputs` choose. */
const sending = (
	run: PageRunStatement,
	inputs: ExecutionInputs,
	call: PageCall
): Effect.Effect<BatchStatement, InputRefusal> => {
	const form = formFor(run, (choice: ShapeChoice) =>
		runsLargeForm(choice, choiceCount(choice, inputs, call))
	)
	const bind = (slot: PageStatementSlot) =>
		slot.kind === "page" ? Result.succeed(pageBinding(slot, call)) : readBinding(slot, inputs)
	return encodeForm(form, bind)
}

/**
 * A row a rows statement delivered, a candidate edge: its statement, its heading group, its texts and its comparison
 * tuple.
 */
interface Candidate {
	readonly statement: RowsStatement
	readonly group: number
	readonly texts: ReadonlyArray<string>
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
	rows: StatementRun,
	index: number
): Result.Result<boolean, UnreadableAnswer> => {
	const [only, ...rest] = rows
	const value =
		only === undefined || rest.length > 0
			? undefined
			: scalarCodec(probe.column.type).convert(rowText(only, 0))
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
			return Result.fail(contradicted(answerOf(rows.record.arrival)))
		}
		for (const candidate of candidates) {
			out.push(candidate)
		}
	}
	return Result.succeed(out)
}

/** The delivered edges of a request whose sent statements answered `sent` (see the header, 4). */
export const pageEdges = (
	program: RunProgram,
	sent: SentRuns,
	size: number
): Result.Result<PageEdges, UnreadableAnswer> =>
	Result.map(fetchOrder(program.delivery, sent, size + 1), (candidates) => {
		const delivery = program.delivery
		/** The lookahead, dropped. */
		const lookahead = candidates.length > size
		const kept = candidates.slice(0, lookahead ? size : candidates.length)
		const statements: ReadonlyArray<RowsStatement> =
			delivery.kind === "concat" ? delivery.groups : Arr.map(delivery.order.groups, (g) => g.group)
		/** Each kept candidate as an edge at its fetch position, its rows statement's kept rows read as Rows together. */
		const placed = statements.flatMap((rows, group) => {
			const mine = kept.flatMap((c, at) => (c.statement === rows ? [{ c, at }] : []))
			const read = rowsOf(
				rows.record,
				sent,
				Arr.map(mine, ({ c }) => c.texts),
				group
			)
			return Arr.map(Arr.zip(mine, read), ([{ c, at }, row]) => ({
				at,
				edge: { statement: c.statement.record, raw: c.texts, row, tuple: c.tuple }
			}))
		})
		const fetched = placed.toSorted((a, b) => a.at - b.at).map((p): DeliveredEdge => p.edge)
		/** A backward page, reversed to the presentation order. */
		const edges = program.program.direction === "backward" ? fetched.toReversed() : fetched
		return { edges, lookahead }
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
		texts: row,
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
		candidatesOf(one.group, group, sent).map((c): KeyedCandidate => ({ c, key: one.key(c.texts) }))
	)
	return mergeHeadingGroups(groups, (a, b) => order.compare(a.key, b.key), limit).map(
		(one) => one.row.c
	)
}

/** A probe as an anchored request sends it: its kind, its one Boolean column, and its statement in this form. */
interface SentProbe {
	readonly kind: ProbeKind
	readonly column: PageRunStatement["statement"]["heading"][number]
	readonly statement: BatchStatement
}

/** The probe of an anchored request, the kind its variant names, in the form this execution runs. */
const probeSending = (
	run: PageRuntime["artifacts"][PageArtifactName],
	inputs: ExecutionInputs,
	call: Extract<PageCall, { readonly boundary: ReadonlyArray<string> }>
): Effect.Effect<SentProbe, InputRefusal> => {
	const probe = run.probes[run.requests[call.variant].program.probe]
	return Effect.map(sending(probe.statement, inputs, call), (statement) => ({
		kind: probe.program.kind,
		column: probe.program.column,
		statement
	}))
}

/** The flight of one page request, reading its rows (see the header). */
export const pageFlight = (
	runtime: PageRuntime,
	artifact: PageArtifactName,
	inputs: ExecutionInputs,
	call: PageCall
): Effect.Effect<Flight<PageRows, UnreadableAnswer>, InputRefusal> =>
	Effect.gen(function* () {
		const run = runtime.artifacts[artifact]
		const program: RunProgram = run.requests[call.variant]
		/** 1, 2. Every statement of the request, the rows statements and their attachments. */
		const batch: Array<BatchStatement> = []
		for (const record of program.records) {
			if (record.arrival.kind === "sent") {
				const statement = yield* sending(record.run, inputs, call)
				batch.push(statement)
			}
		}
		const sent = batch.length
		/** 3. An anchored request's opposite flag: its probe on the anchor. */
		const probing =
			call.variant === "first" || call.variant === "last"
				? Option.none()
				: yield* Effect.asSome(probeSending(run, inputs, call))
		if (Option.isSome(probing)) {
			batch.push(probing.value.statement)
		}
		return {
			statements: batch,
			read: (outcomes) =>
				Effect.fromResult(
					Result.gen(function* () {
						const runs: ReadonlyArray<StatementRun> = Arr.map(
							outcomes.slice(0, sent),
							(outcome) => outcome.rows
						)
						const attachments = new Map<PageRecord, Raw>()
						for (const record of program.records) {
							for (const { record: child } of record.plan.children) {
								attachments.set(child, runOf(child, runs))
							}
						}
						let opposite = false
						if (Option.isSome(probing)) {
							for (const outcome of outcomes.slice(sent)) {
								opposite = yield* probeAnswer(probing.value, outcome.rows, sent)
							}
						}
						const page = yield* pageEdges(program, runs, call.size)
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
