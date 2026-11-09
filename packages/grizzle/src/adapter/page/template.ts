import * as Arr from "effect/Array"
import * as Result from "effect/Result"
import { toResult } from "#adapter/engine.ts"
import {
	programRecords,
	readForm,
	type RunStatement,
	type StatementRecord
} from "#adapter/reader/execution.ts"
import { type GroupOrder, groupOrder } from "#adapter/reader/run.ts"
import type {
	Carrier,
	Cell,
	Codebook,
	CompileError,
	Layout,
	ParamDecl
} from "#compiler/plan/common.ts"
import type { ScalarReader } from "#compiler/plan/decode.ts"
import type {
	CarrierHost,
	ChoiceInput,
	CursorCodec,
	CursorGeneration,
	Heading,
	PageComparator,
	PageDirection,
	PageFill,
	PageStatementSlot,
	PageVariant,
	ProbeKind,
	VariantFill
} from "#compiler/plan/read.ts"
import {
	columnPosition,
	compareValues,
	cursorCodec,
	cursorTokenMaxLength,
	rowCell,
	scalarReader,
	servedTree
} from "#compiler/plan/runtime.ts"
import type {
	ServedChoice,
	ServedPage,
	ServedPageProbe,
	ServedPageRequest,
	ServedPageStatement,
	ServedRoots,
	ServedSpine
} from "#compiler/plan/serve.ts"

/**
 * The page runtime template of an ordered query.
 *
 * Compilation produces the source query, completed order, seek comparator, forward and reverse SQL templates,
 * page-info probes, cursor codecs, and execution requirements. The page compiler (lower/shapes/page/compile.ts)
 * produces the order, the comparators and the statements of every request variant and probe, and its served form
 * (engine program/served.ts servedPage) each statement's spec, its executable text with every delivered column cast to
 * text, and each per-execution variant's beside the statement it replaces, emitted when the page compiles; this module
 * adds what running them needs, once per template, from that served form alone:
 *
 * - each request's statement records (reader/execution.ts programRecords), so the query's decoder binds to the same
 *   layouts on every page of the request variant, and how its rows statements deliver: each one's comparison tuple read
 *   from its texts by the comparators' value codecs, and a heterogeneous union's groups merged on the fetch order;
 * - the cursor codec (codec/cursor) of the completed comparator sequence, bound to the ordered query's semantic
 *   fingerprint and the semantic generation. The fingerprint is the page query fingerprint
 *   (program/workload/fingerprint.ts): the query's canonical Description and the schema fingerprint, independent of the
 *   evidence context, the request variant and the page size, so one token serves every Db of the schema and the
 *   compiled handles of the query. The generation is the schema fingerprint and the extensions the
 *   schema requires by name, at the version admission verified (physical/vector/admission.ts): a token of another
 *   schema or extension generation fails validation explicitly. Its tokens are bounded by the layout alone
 *   (cursorTokenMaxLength), and a completed order whose shortest token exceeds it is refused here with
 *   UnsupportedOperation;
 * - one value codec per comparator, which writes a delivered edge's boundary values as the texts its probe binds, the
 *   same canonical texts the edge's cursor carries.
 *
 * One statement of a page program as the runtime runs it: its page placeholders, each the page fill the runtime binds
 * (execute.ts), among its read ones, and its per-execution form, when it has one.
 */
export type PageRunStatement<F extends PageFill = PageFill> = RunStatement<
	ServedPageStatement<F>["statement"],
	PageStatementSlot<F>,
	ServedChoice<ChoiceInput>
>

/** A page statement's record (reader/execution.ts programRecords), its page placeholders each filled by one of `F`. */
export type PageRecord<F extends PageFill = PageFill> = StatementRecord<PageRunStatement<F>>

/** A delivered row's comparison tuple, the comparators' values converted from its cells, in order. */
export type ComparisonTuple = ReadonlyArray<CarrierHost[Carrier]>

/** A rows statement of a request: its record, and the reading of a row's comparison tuple from its cells. */
export interface RowsStatement {
	readonly record: PageRecord
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
	/**
	 * Its statements' records in flight order, what the request delivers, and the layouts of its delivered Rows, one
	 * per heading group (one for a rows delivery), which the query's decoder binds to.
	 */
	readonly records: ReadonlyArray<PageRecord<VariantFill[V]>>
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

/**
 * A probe: its program, whose one statement delivers one Boolean column, that statement as it runs, and the column's
 * codec, which reads its answer.
 */
interface RunProbe<K extends ProbeKind = ProbeKind> {
	readonly program: ServedPageProbe<K>
	readonly statement: PageRunStatement
	readonly answer: ScalarReader
}

interface RunArtifact {
	readonly requests: { readonly [V in PageVariant]: RunProgram<V> }
	readonly probes: { readonly [K in ProbeKind]: RunProbe<K> }
}

export interface PageRuntime {
	readonly page: ServedPage
	readonly params: ReadonlyArray<ParamDecl>
	readonly artifact: RunArtifact
	readonly codec: CursorCodec<ReadonlyArray<PageComparator>>
	/** What the codec binds every token to: the ordered query's semantic fingerprint and the semantic generation. */
	readonly identity: { readonly query: string; readonly generation: CursorGeneration }
	/** One value reader per comparator, in order. */
	readonly values: ReadonlyArray<ScalarReader>
}

/** What a page's runtime is built from: its served form, its read's parameters and spine, and the installation's codes. */
interface PageRuntimeParts {
	readonly page: ServedPage
	readonly params: ReadonlyArray<ParamDecl>
	/** The installation's codes, which every value codec, cursor boundary and placeholder encoder of a closed id or a set
	 * reads. */
	readonly codes: Codebook
	/** The delivered spine, whose attachments' children carry the columns their head keys name (reader/analysis.ts). */
	readonly spine: ServedSpine
}

/** A statement of a page program as it runs: its served spec and placeholders, and its large form's. */
const pageRun = <F extends PageFill>(served: ServedPageStatement<F>): PageRunStatement<F> => {
	const { statement, spec } = served
	const forms = statement.forms
	return {
		statement,
		...readForm(statement, spec),
		forms:
			forms.kind === "one"
				? forms
				: {
						kind: "chosen",
						choices: forms.choices,
						large: readForm(forms.large.statement, forms.large.spec)
					},
		arrival: statement.arrival
	}
}

/** The statements of a page program as they run (pageRun), in their tree. */
const runsOf = <F extends PageFill>(
	roots: ServedRoots<ServedPageStatement<F>>
): ServedRoots<PageRunStatement<F>> => Arr.map(roots, (tree) => servedTree(tree, pageRun))

/**
 * The reading of a rows statement's comparison tuple: each comparator's column, a column of the statement's heading
 * the page names by field (lower/conservative/context.ts columnPosition), converted from the statement's texts by the
 * comparator's value codec.
 */
const rowsStatement = (
	record: PageRecord,
	comparators: ReadonlyArray<readonly [PageComparator, ScalarReader]>
): RowsStatement => {
	const read = Arr.map(comparators, ([c, value]) => ({
		at: columnPosition(record.run.statement.heading, c.field),
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
	delivered: Arr.NonEmptyReadonlyArray<PageRecord>,
	comparators: ReadonlyArray<readonly [PageComparator, ScalarReader]>,
	codes: Codebook
): PageDelivery => {
	const rows = Arr.map(delivered, (record) => rowsStatement(record, comparators))
	return delivery.kind === "rows"
		? { kind: "concat", groups: rows }
		: {
				kind: "groups",
				order: groupOrder(
					delivery.order,
					heading,
					rows,
					(r) => r.record.run.statement.heading,
					codes
				)
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
		const { records, delivered } = programRecords(
			runsOf<VariantFill[V]>(program.roots),
			parts.spine,
			parts.codes
		)
		const delivery = pageDelivery(
			program.delivery,
			parts.heading,
			delivered,
			Arr.zip(parts.comparators, parts.values),
			parts.codes
		)
		return {
			program,
			records,
			delivery,
			layouts: deliveredLayouts(delivery),
			fetch: fetchComparison(Arr.zip(parts.comparators, parts.values), program.direction)
		}
	}
	const probe = <K extends ProbeKind>(program: ServedPageProbe<K>): RunProbe<K> => ({
		program,
		statement: pageRun(program.statement),
		answer: scalarReader(program.column.type, parts.codes)
	})
	return {
		requests: {
			first: request(page.requests.first),
			after: request(page.requests.after),
			last: request(page.requests.last),
			before: request(page.requests.before)
		},
		probes: {
			atOrBefore: probe(page.probes.atOrBefore),
			atOrAfter: probe(page.probes.atOrAfter)
		}
	}
}

/**
 * The runtime template of a served page and what its statements and cursors need: its statements' records and
 * deliveries, its comparators' value codecs, and its cursor codec, bound to the page's query fingerprint and cursor
 * generation. A completed order whose shortest token exceeds cursorTokenMaxLength is refused with UnsupportedOperation.
 */
export const pageRuntimeOf = (parts: PageRuntimeParts): Result.Result<PageRuntime, CompileError> =>
	Result.map(
		toResult(
			cursorCodec(
				{
					query: parts.page.query,
					comparators: parts.page.comparators,
					generation: parts.page.generation
				},
				cursorTokenMaxLength,
				parts.codes
			)
		),
		(codec): PageRuntime => {
			const page = parts.page
			const values: ReadonlyArray<ScalarReader> = Arr.map(page.comparators, (c) =>
				scalarReader(c.type, parts.codes)
			)
			const artifact = runArtifact(page, {
				heading: page.heading,
				comparators: page.comparators,
				values,
				spine: parts.spine,
				codes: parts.codes
			})
			return {
				page,
				params: parts.params,
				artifact,
				codec,
				identity: { query: page.query, generation: page.generation },
				values
			}
		}
	)
