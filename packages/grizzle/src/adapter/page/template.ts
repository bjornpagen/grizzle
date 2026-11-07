import { Array as Arr, Record as Rec, Result } from "effect"
import { toResult } from "#adapter/engine.ts"
import { type AttachmentScope, attachmentHeads } from "#adapter/reader/analysis.ts"
import {
	programRecords,
	type RunStatement,
	type StatementForm,
	type StatementRecord
} from "#adapter/reader/execution.ts"
import { type GroupOrder, groupOrder } from "#adapter/reader/run.ts"
import { vectorExpectations } from "#compiler/plan/catalog.ts"
import {
	type Carrier,
	type Codebook,
	type CompileError,
	Engine,
	type Layout,
	type ParamDecl,
	type QueryDesc,
	rowText,
	type SchemaArtifacts,
	SourceLoc,
	type StatementSpec
} from "#compiler/plan/common.ts"
import {
	type CarrierHost,
	columnPosition,
	compareValues,
	compilePageOf,
	cursorCodec,
	type CursorCodec,
	type CursorGeneration,
	cursorTokenMaxLength,
	type FusedStatement,
	type Heading,
	type PageArtifact,
	type PageComparator,
	type PageDirection,
	type PageProbeProgram,
	type PageProgram,
	pageQueryFingerprint,
	type PageRequestProgram,
	type PageStatement,
	type PageStatementSlot,
	pageStatementSlotOf,
	type PageTemplate,
	type PageVariant,
	type ProbeKind,
	type QueryTemplate,
	scalarCodec,
	type ScalarCodec,
	type ShapeChoice,
	statedOrderOf,
	type StatementRoots,
	statementSpec,
	traverseTree
} from "#compiler/plan/read.ts"

/**
 * The page runtime template of an ordered query.
 *
 * Compilation produces the source query, completed order, seek comparator, forward and reverse SQL templates,
 * page-info probes, cursor codecs, and execution requirements. The page compiler (lower/shapes/page/compile.ts)
 * produces the order, the comparators and the statements of every request variant and
 * probe for both artifacts; this module adds what running them needs, once per template:
 *
 * - each statement's StatementSpec (lower/template.ts statementSpec): its executable text with every delivered column
 *   cast to text and one encoder per declared parameter's placeholder; and each per-execution variant's beside the
 *   statement it replaces;
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
export type PageRunStatement = RunStatement<
	FusedStatement<PageStatementSlot>,
	PageStatementSlot,
	ShapeChoice
>

/** A page statement's record (reader/execution.ts programRecords). */
export type PageRecord = StatementRecord<PageRunStatement>

/** A delivered row's comparison tuple, the comparators' values converted from its texts, in order. */
export type ComparisonTuple = ReadonlyArray<CarrierHost[Carrier]>

/** A rows statement of a request: its record, and the reading of a row's comparison tuple from its texts. */
export interface RowsStatement {
	readonly record: PageRecord
	readonly tuple: (texts: ReadonlyArray<string>) => ComparisonTuple
}

/**
 * What a request delivers: the Rows of its delivered statements, a rows delivery's one statement concatenated, or its
 * heading groups merged on the fetch order, each group with its reading of a row's key under it.
 */
export type PageDelivery =
	| { readonly kind: "concat"; readonly groups: Arr.NonEmptyReadonlyArray<RowsStatement> }
	| { readonly kind: "groups"; readonly order: GroupOrder<RowsStatement> }

export interface RunProgram<P extends PageProgram = PageRequestProgram> {
	readonly program: P
	/**
	 * Its statements' records in flight order, what the request delivers, and the layouts of its delivered Rows, one
	 * per heading group (one for a rows delivery), which the query's decoder binds to.
	 */
	readonly records: ReadonlyArray<PageRecord>
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
	comparators: ReadonlyArray<readonly [PageComparator, ScalarCodec]>,
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
	readonly program: PageProbeProgram<K>
	readonly statement: PageRunStatement
	readonly answer: ScalarCodec
}

interface RunArtifact {
	readonly requests: { readonly [V in PageVariant]: RunProgram<PageRequestProgram<V>> }
	readonly probes: { readonly [K in ProbeKind]: RunProbe<K> }
}

export type PageArtifactName = "optimized" | "conservative"

export interface PageRuntime {
	readonly page: PageTemplate
	readonly params: ReadonlyArray<ParamDecl>
	readonly artifacts: { readonly [A in PageArtifactName]: RunArtifact }
	readonly codec: CursorCodec<ReadonlyArray<PageComparator>>
	/** What the codec binds every token to: the ordered query's semantic fingerprint and the semantic generation. */
	readonly identity: { readonly query: string; readonly generation: CursorGeneration }
	/** One value codec per comparator, in order. */
	readonly values: ReadonlyArray<ScalarCodec>
}

interface PageRuntimeParts {
	readonly page: PageTemplate
	readonly params: ReadonlyArray<ParamDecl>
	/**
	 * The installation's codes, which every value codec, cursor boundary and placeholder encoder of a closed id or a set
	 * reads.
	 */
	readonly codes: Codebook
	/**
	 * The DAG each artifact's statements lower, whose Attach nodes lay out fused attachments: a page has none
	 * (pageForm), so its Rows plans read none.
	 * The ordered query's semantic fingerprint and the semantic generation.
	 */
	readonly query: string
	readonly generation: CursorGeneration
	/** The delivered spine, whose attachments' children carry the columns their head keys name (reader/analysis.ts). */
	readonly spine: AttachmentScope
}

/** The form of a page statement: each page placeholder is the page's, every other one a declared parameter's. */
const pageForm = (
	statement: FusedStatement<PageStatementSlot>,
	spec: StatementSpec
): StatementForm<FusedStatement<PageStatementSlot>, PageStatementSlot> => ({
	statement,
	spec,
	slots: statement.params
})

/**
 * A statement of a page program as it runs, each form with the spec rebuilt from it, its placeholders encoded under the
 * installation's codes `codes`.
 */
const pageRun = (
	statement: PageStatement,
	codes: Codebook
): Engine.Result<PageRunStatement, CompileError> =>
	Engine.flatMap(
		statementSpec(statement, pageStatementSlotOf(codes)),
		(spec): Engine.Result<PageRunStatement, CompileError> => {
			const form = pageForm(statement, spec)
			const forms = statement.forms
			if (forms.kind === "one") {
				return Engine.ok({ ...form, forms, arrival: statement.arrival })
			}
			return Engine.map(
				statementSpec(forms.large, pageStatementSlotOf(codes)),
				(large): PageRunStatement => ({
					...form,
					forms: { kind: "chosen", choices: forms.choices, large: pageForm(forms.large, large) },
					arrival: statement.arrival
				})
			)
		}
	)

/** The statements of a page program as they run (pageRun), in their tree. */
const specsOf = (
	program: PageProgram,
	codes: Codebook
): Result.Result<StatementRoots<PageRunStatement>, CompileError> =>
	toResult(traverseTree(program.roots, (statement) => pageRun(statement, codes)))

/**
 * The reading of a rows statement's comparison tuple: each comparator's column, a column of the statement's heading
 * the page names by field (lower/conservative/context.ts columnPosition), converted from the statement's texts by the
 * comparator's value codec.
 */
const rowsStatement = (
	record: PageRecord,
	comparators: ReadonlyArray<readonly [PageComparator, ScalarCodec]>
): RowsStatement => {
	const read = Arr.map(comparators, ([c, value]) => ({
		at: columnPosition(record.run.statement.heading, c.field),
		convert: value.convert
	}))
	return {
		record,
		tuple: (texts) => {
			const tuple: Array<ComparisonTuple[number]> = []
			for (const c of read) {
				tuple.push(c.convert(rowText(texts, c.at)))
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
	delivery: PageRequestProgram["delivery"],
	heading: Heading,
	delivered: Arr.NonEmptyReadonlyArray<PageRecord>,
	comparators: ReadonlyArray<readonly [PageComparator, ScalarCodec]>,
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
	readonly values: ReadonlyArray<ScalarCodec>
	readonly spine: AttachmentScope
	readonly codes: Codebook
}

const runArtifact = (
	artifact: PageArtifact,
	parts: ArtifactParts
): Result.Result<RunArtifact, CompileError> =>
	Result.gen(function* () {
		const request = <V extends PageVariant>(v: V) =>
			Result.gen(function* () {
				const program = artifact.requests[v]
				const { records, delivered } = programRecords(
					yield* specsOf(program, parts.codes),
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
				const run: RunProgram<PageRequestProgram<V>> = {
					program,
					records,
					delivery,
					layouts: deliveredLayouts(delivery),
					fetch: fetchComparison(Arr.zip(parts.comparators, parts.values), program.direction)
				}
				return run
			})
		const probe = <K extends ProbeKind>(k: K) =>
			Result.gen(function* () {
				const program = artifact.probes[k]
				const run: RunProbe<K> = {
					program,
					statement: yield* toResult(pageRun(program.statement, parts.codes)),
					answer: scalarCodec(program.column.type, parts.codes)
				}
				return run
			})
		return {
			requests: {
				first: yield* request("first"),
				after: yield* request("after"),
				last: yield* request("last"),
				before: yield* request("before")
			},
			probes: {
				atOrBefore: yield* probe("atOrBefore"),
				atOrAfter: yield* probe("atOrAfter")
			}
		}
	})

/** The runtime template of a page template and what its statements and cursors need. */
export const pageRuntimeOf = (parts: PageRuntimeParts): Result.Result<PageRuntime, CompileError> =>
	Result.gen(function* () {
		const page = parts.page
		const values: ReadonlyArray<ScalarCodec> = Arr.map(page.comparators, (c) =>
			scalarCodec(c.type, parts.codes)
		)
		const shared: ArtifactParts = {
			heading: page.heading,
			comparators: page.comparators,
			values,
			spine: parts.spine,
			codes: parts.codes
		}
		const optimized = yield* runArtifact(page.optimized, shared)
		const conservative = yield* runArtifact(page.conservative, shared)
		const codec = yield* toResult(
			cursorCodec(
				{ query: parts.query, comparators: page.comparators, generation: parts.generation },
				cursorTokenMaxLength,
				parts.codes
			)
		)
		return {
			page,
			params: parts.params,
			artifacts: { optimized, conservative },
			codec,
			identity: { query: parts.query, generation: parts.generation },
			values
		}
	})

/**
 * The semantic generation of a schema's cursors: its fingerprint, and each extension it requires at the version
 * admission verified.
 */
const cursorGeneration = (artifacts: SchemaArtifacts): CursorGeneration => ({
	schema: artifacts.fingerprint,
	extensions: Rec.fromEntries(
		Arr.map(
			vectorExpectations(artifacts.owned, artifacts.names.vectorSchema),
			(e) => [e.extension, e.version] as const
		)
	)
})

/** The ordered query's semantic fingerprint (program/workload/fingerprint.ts). */
const orderedQueryFingerprint = (
	desc: QueryDesc,
	artifacts: SchemaArtifacts
): Result.Result<string, CompileError> =>
	toResult(pageQueryFingerprint(desc, artifacts.fingerprint))

interface PageTemplateInput {
	/** The query template compiled with read "page" (program/compile.ts), and the Description it was compiled from. */
	readonly template: QueryTemplate
	readonly desc: QueryDesc
	readonly artifacts: SchemaArtifacts
}

/** The page runtime template of a query template compiled for a page. */
export const pageTemplateFor = (
	input: PageTemplateInput
): Result.Result<PageRuntime, CompileError> => {
	const { template, desc, artifacts } = input
	return Result.gen(function* () {
		/** The location compileQuery checks the template's Description at (program/compile.ts, label "query"). */
		const stated = yield* toResult(statedOrderOf(desc, SourceLoc("query", [])))
		const page = yield* toResult(
			compilePageOf(template.programs, { stated, names: artifacts.reads })
		)
		const query = yield* orderedQueryFingerprint(desc, artifacts)
		return yield* pageRuntimeOf({
			page,
			params: template.params,
			codes: artifacts.names.codes,
			query,
			generation: cursorGeneration(artifacts),
			spine: attachmentHeads(desc)
		})
	})
}
