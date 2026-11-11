import * as Arr from "effect/Array"
import {
	programRecords,
	type RunStatement,
	runStatement,
	type StatementRecord
} from "#adapter/reader/execution.ts"
import { type GroupOrder, groupOrder } from "#adapter/reader/run.ts"
import type { Carrier, Cell, Codebook, Layout, ParamDecl } from "#compiler/plan/common.ts"
import type { ScalarReader } from "#compiler/plan/decode.ts"
import type {
	CarrierHost,
	ChoiceInput,
	Heading,
	PageComparator,
	PageDirection,
	PageFill,
	PageStatementSlot,
	PageVariant,
	ScalarCodec,
	VariantFill
} from "#compiler/plan/read.ts"
import {
	columnPosition,
	compareValues,
	rowCell,
	scalarCodec,
	scalarReader
} from "#compiler/plan/runtime.ts"
import type {
	ServedChoice,
	ServedPage,
	ServedPageProgram,
	ServedPageRequest,
	ServedSpine
} from "#compiler/plan/serve.ts"

/**
 * The page runtime template of a paged member's ordered query.
 *
 * The page compiler (lower/shapes/page/compile.ts) produces the order, the comparators and the statements of every
 * template, and its served form (engine program/served.ts servedPage) each statement's spec, its executable text with
 * every delivered column cast to text, and each per-execution variant's beside the statement it replaces, emitted when
 * the page compiles; this module adds what running them needs, once per template, from that served form alone:
 *
 * - each template's statement records (reader/execution.ts programRecords), so the query's decoder binds to the same
 *   layouts on every window of the template, and how its rows statements deliver: each one's comparison tuple read
 *   from its texts by the comparators' value codecs, and a heterogeneous union's groups merged on the fetch order;
 * - one codec per comparator, which writes a window's anchor RowKey, one decoded value per comparator, as the boundary
 *   texts its seek binds (window.ts).
 *
 * The statement of a page program as the runtime runs it: its page placeholders, each the page fill the runtime binds
 * (execute.ts), among its read ones, its per-execution form, when it has one, and how its rows divide into its parts.
 */
export type PageRunStatement<F extends PageFill = PageFill> = RunStatement<
	PageStatementSlot<F>,
	ServedChoice<ChoiceInput>
>

/** A delivered row's comparison tuple, the comparators' values converted from its cells, in order. */
export type ComparisonTuple = ReadonlyArray<CarrierHost[Carrier]>

/** A rows statement of a request: its record, and the reading of a row's comparison tuple from its cells. */
export interface RowsStatement {
	readonly record: StatementRecord
	readonly tuple: (cells: ReadonlyArray<Cell>) => ComparisonTuple
}

/**
 * What a request delivers: the Rows of its delivered statements, a rows delivery's one statement concatenated, or its
 * heading groups merged on the fetch order, each group with its reading of a row's key under it.
 */
export type PageDelivery =
	| { readonly kind: "concat"; readonly groups: Arr.NonEmptyReadonlyArray<RowsStatement> }
	| { readonly kind: "groups"; readonly order: GroupOrder<RowsStatement> }

/**
 * A request variant's program as it runs: its statements' page placeholders are each filled by one of its variant's
 * fills (VariantFill), so a plain request's binding reads its size alone.
 */
export interface RunProgram<V extends PageVariant = PageVariant> {
	readonly program: ServedPageRequest<V>
	/** Its statement as it runs. */
	readonly run: PageRunStatement<VariantFill[V]>
	/**
	 * Its parts' records in flight order, what the request delivers, and the layouts of its delivered Rows, one per
	 * heading group (one for a rows delivery), which the query's decoder binds to.
	 */
	readonly records: ReadonlyArray<StatementRecord>
	readonly delivery: PageDelivery
	readonly layouts: Arr.NonEmptyReadonlyArray<Layout>
	/** The fetch order of two delivered rows' comparison tuples (fetchComparison). */
	readonly fetch: (a: ComparisonTuple, b: ComparisonTuple) => number
}

/**
 * The fetch order of a request's comparison tuples: the comparators in order, each by its carrier's B-tree order
 * (scalar/values/identity.ts compareValues) in its direction, all reversed for a backward request. The comparators
 * are the completed order's keys, a key of the result, so the rows a request fetches strictly increase under it.
 */
const fetchComparison = (
	comparators: ReadonlyArray<readonly [PageComparator, ScalarReader]>,
	direction: PageDirection
): ((a: ComparisonTuple, b: ComparisonTuple) => number) => {
	const fetched = direction === "backward" ? -1 : 1
	const keys = Arr.map(comparators, ([c, value]) => ({
		spec: value.spec,
		sign: (c.direction === "desc" ? -1 : 1) * fetched
	}))
	return (a, b) => {
		for (const [k, [x, y]] of Arr.zip(keys, Arr.zip(a, b))) {
			const c = compareValues(k.spec, x, y)
			if (c !== 0) {
				return c * k.sign
			}
		}
		return 0
	}
}

interface RunArtifact {
	readonly requests: { readonly [V in PageVariant]: RunProgram<V> }
}

/**
 * A served page as it runs: its served form, its read's parameters, each template's program (RunArtifact), and each
 * comparator's codec, in comparator order, which writes an anchor's RowKey (window.ts windowCall).
 */
export interface PageRuntime {
	readonly page: ServedPage
	readonly params: ReadonlyArray<ParamDecl>
	readonly artifact: RunArtifact
	readonly anchors: ReadonlyArray<ScalarCodec>
}

/** What a page's runtime is built from: its served form, its read's parameters and spine, and the installation's codes. */
interface PageRuntimeParts {
	readonly page: ServedPage
	readonly params: ReadonlyArray<ParamDecl>
	/** The installation's codes, which every value codec, cursor boundary and placeholder encoder of a closed id or a set
	 * reads. */
	readonly codes: Codebook
	/** The delivered spine, whose attachments' children carry the columns their head keys name (engine served/read.ts carried). */
	readonly spine: ServedSpine
}

/** The statement of a page program as it runs: its served spec and placeholders, its large form's, and its parts. */
const pageRun = <F extends PageFill>(program: ServedPageProgram<F>): PageRunStatement<F> =>
	runStatement(program.statement, program.parts, (choice) => choice)

/**
 * The reading of a rows statement's comparison tuple: each comparator's column, a column of the statement's heading
 * the page names by field (lower/conservative/context.ts columnPosition), converted from the statement's texts by the
 * comparator's value codec.
 */
const rowsStatement = (
	record: StatementRecord,
	comparators: ReadonlyArray<readonly [PageComparator, ScalarReader]>
): RowsStatement => {
	const read = Arr.map(comparators, ([c, value]) => ({
		at: columnPosition(record.part.heading, c.field),
		convert: value.convert
	}))
	return {
		record,
		tuple: (cells) => {
			const tuple: Array<ComparisonTuple[number]> = []
			for (const c of read) {
				tuple.push(c.convert(rowCell(cells, c.at)))
			}
			return tuple
		}
	}
}

/**
 * What a request delivers (PageDelivery), from its delivered records in flight order: a rows delivery's concatenated, or
 * its heading groups merged on its fetch order, under `heading`, the union's heading every group carries.
 */
const pageDelivery = (
	delivery: ServedPageRequest["delivery"],
	heading: Heading,
	delivered: Arr.NonEmptyReadonlyArray<StatementRecord>,
	comparators: ReadonlyArray<readonly [PageComparator, ScalarReader]>,
	codes: Codebook
): PageDelivery => {
	const rows = Arr.map(delivered, (record) => rowsStatement(record, comparators))
	return delivery.kind === "rows"
		? { kind: "concat", groups: rows }
		: {
				kind: "groups",
				order: groupOrder(delivery.order, heading, rows, (r) => r.record.part.heading, codes)
			}
}

/** The layouts of the Rows a request delivers: its rows statement's, or each heading group's, in group order. */
const deliveredLayouts = (delivery: PageDelivery): Arr.NonEmptyReadonlyArray<Layout> =>
	delivery.kind === "concat"
		? Arr.map(delivery.groups, (rows) => rows.record.layout)
		: Arr.map(delivery.order.groups, (g) => g.group.record.layout)

interface ArtifactParts {
	readonly heading: Heading
	readonly comparators: ReadonlyArray<PageComparator>
	readonly values: ReadonlyArray<ScalarReader>
	readonly spine: ServedSpine
	readonly codes: Codebook
}

const runArtifact = (page: ServedPage, parts: ArtifactParts): RunArtifact => {
	const request = <V extends PageVariant>(program: ServedPageRequest<V>): RunProgram<V> => {
		const { records, delivered } = programRecords(program.program.roots, parts.spine, parts.codes)
		const delivery = pageDelivery(
			program.delivery,
			parts.heading,
			delivered,
			Arr.zip(parts.comparators, parts.values),
			parts.codes
		)
		return {
			program,
			run: pageRun<VariantFill[V]>(program.program),
			records,
			delivery,
			layouts: deliveredLayouts(delivery),
			fetch: fetchComparison(Arr.zip(parts.comparators, parts.values), program.direction)
		}
	}
	return {
		requests: {
			first: request(page.requests.first),
			after: request(page.requests.after),
			last: request(page.requests.last),
			before: request(page.requests.before)
		}
	}
}

/**
 * The runtime template of a served page: its templates' records and deliveries, its comparators' value codecs, which
 * read a delivered row's comparison tuple, and their parameter codecs, which write an anchor's RowKey.
 */
export const pageRuntimeOf = (parts: PageRuntimeParts): PageRuntime => {
	const page = parts.page
	const values: ReadonlyArray<ScalarReader> = Arr.map(page.comparators, (c) =>
		scalarReader(c.type, parts.codes)
	)
	return {
		page,
		params: parts.params,
		artifact: runArtifact(page, {
			heading: page.heading,
			comparators: page.comparators,
			values,
			spine: parts.spine,
			codes: parts.codes
		}),
		anchors: Arr.map(page.comparators, (c) => scalarCodec(c.type, parts.codes))
	}
}
