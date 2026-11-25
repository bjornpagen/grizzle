import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	map,
	recorded,
	type Steered,
	steered,
	weighted
} from "@bjornpagen/testing/gen"
import { type Budget, type Case, type Kept, type Kill } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec, Result } from "effect"
import { DatabaseError } from "pg"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { ConnectionLost } from "#adapter/errors/failures.ts"
import { windowIntake, windowStatement } from "#adapter/page/execute.ts"
import type { PageRuntime } from "#adapter/page/template.ts"
import { windowCall } from "#adapter/page/window.ts"
import { partRuns, runOf } from "#adapter/reader/execution.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { compiledPageRuntime } from "#adapter/served/forms.ts"
import { keptRows } from "#adapter/wire/batch.ts"
import { serverFailure } from "#adapter/wire/failure.ts"
import { arrayTexts } from "#compiler/codec/recordset.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { maxStringLength } from "#compiler/core/canonical.ts"
import { identity } from "#compiler/core/identity.ts"
import { NodeId, ParamId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Cell, ParamText } from "#compiler/core/wire.ts"
import { floatLiteral } from "#compiler/ir/carriers.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { relNode, rooted, topoOrder, groupHeadings } from "#compiler/ir/dag.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import { callerParams, type LogicalQuery, type ParamDecl } from "#compiler/ir/products.ts"
import {
	type CompletedOrder,
	conservativeMeta,
	type Heading,
	type InputSetInput,
	type NodeOf,
	type OrderKey,
	type RelNode,
	type RootedDag,
	unionArms
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { type Anchor, RowKey } from "#compiler/live/index.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	conservativeInput,
	type ConservativeProgram,
	type ConservativeStatement,
	flight
} from "#compiler/lower/conservative/types.ts"
import { lowerOptimized } from "#compiler/lower/optimize/pipeline.ts"
import { conservativeStatement } from "#compiler/lower/shapes/index.ts"
import { compilePage, type PageTemplate } from "#compiler/lower/shapes/page/compile.ts"
import type { Row as DeliveredRow } from "#compiler/plan/common.ts"
import { columnPosition, rowCell, scalarReader } from "#compiler/plan/runtime.ts"
import { keyColumns, statementOutput } from "#compiler/runtime/lower/tree.ts"
import { mergeHeadingGroups } from "#compiler/runtime/lower/union.ts"
import { hasCapability } from "#compiler/scalar/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { storedValue } from "#compiler/scalar/values/identity.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { admitGenerated, filledSql, programAsts } from "#test/support/compile.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { sentSql } from "#test/support/flight/scripted.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import { strictReader } from "#test/support/kernel/strict.ts"
import { correlatedChildUnderNestedAttachment } from "#test/support/key-sets.ts"
import { mergeComparator } from "#test/support/merge.ts"
import { messageOf } from "#test/support/message.ts"
import { canonicalCell } from "#test/support/oracle/compare.ts"
import {
	defaultGenConfig,
	type GenConfig,
	type QueryCase,
	queryCaseGen
} from "#test/support/oracle/gen/case.ts"
import { int4 } from "#test/support/oracle/gen/domain.ts"
import { canonicalFacts, type GenFacts } from "#test/support/oracle/gen/facts.ts"
import { printQueryCase } from "#test/support/oracle/gen/print.ts"
import { type GenParam, normalQuery } from "#test/support/oracle/gen/query.ts"
import { type GenRelation, schemaDesc, schemaName } from "#test/support/oracle/gen/schema.ts"
import { everyRow, type RawCaptureError } from "#test/support/oracle/install/capture.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { oraclePlan } from "#test/support/oracle/install/real.ts"
import {
	CurrentPerturbation,
	multiplyFacts,
	plannerStatements
} from "#test/support/oracle/perturb.ts"
import {
	factSet,
	inputText,
	oracleProperty,
	PropertyFailed,
	sentRows
} from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import { loweringViolations } from "#test/support/oracle/verify/index.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { everyColumnCarried } from "#test/support/spine.ts"
import { headingRecord } from "#test/support/statement-rows.ts"
import { outputRows } from "#test/support/wire.ts"
import { Q } from "#test/unit/lower/conservative/fixtures.ts"
import { withinOneParentCase } from "#test/unit/lower/dedup/cases.ts"

/**
 * Why a case pages nothing: a column without an admitted order, a baseline lowering that refuses the query, or an
 * answer or a walk over the request bound.
 */
type PageSkip =
	| "unordered column"
	| "baseline refuses"
	| "answer over the request bound"
	| "walk over the request bound"

/**
 * The window sizes a case draws from, one per direction: up to seven, so a D of more than seven rows spans several
 * windows at every size.
 */
const pageSizes = [1, 2, 3, 4, 5, 6, 7] as const
type PageSize = (typeof pageSizes)[number]

/**
 * What a case reached: the node kinds of its query, the shapes of its template, a correlated child under a nested
 * attachment (test/support/key-sets.ts), the size of its D, a row past a window whose children it must not read, a
 * per-execution form, a caller's float -0 among a relation parameter's rows, the window size of each walk, and its
 * skip.
 */
type PageFeature =
	| "Group"
	| "Recursive"
	| "Take"
	| "Union"
	| "SemiJoin"
	| "AntiJoin"
	| "Difference"
	| "heading groups"
	| "attachments"
	| "a correlated child under a nested attachment"
	| "unit"
	| "mixed directions"
	| "row comparison"
	| "ascending"
	| "descending"
	| "distinct before the bound"
	| "key prefix"
	| "empty D"
	| "more than seven rows"
	| "a parent past the window with children"
	| "per-execution form"
	| "float -0 in a relation parameter"
	| "a walk of at least 200 windows in one direction"
	| "several pages by position"
	| "a window at a position within D"
	| "a window at a position past D"
	| `window size ${PageSize}`
	| `skipped: ${PageSkip}`

/**
 * What the population must reach, among them a heterogeneous union paged by position past its first page, where each
 * group's part delivers its rows of the window alone (rows.ts positionedGroupRows).
 */
const situations: ReadonlyArray<Reached<PageFeature>> = [
	"Group",
	"Recursive",
	"Take",
	"Union",
	"SemiJoin",
	"AntiJoin",
	"Difference",
	"heading groups",
	"attachments",
	"a correlated child under a nested attachment",
	"a parent past the window with children",
	"key prefix",
	"mixed directions",
	"row comparison",
	"ascending",
	"descending",
	"distinct before the bound",
	"empty D",
	"more than seven rows",
	"per-execution form",
	"float -0 in a relation parameter",
	"a walk of at least 200 windows in one direction",
	"several pages by position",
	"a window at a position within D",
	"a window at a position past D",
	["heading groups", "several pages by position"],
	...Arr.map(pageSizes, (n) => `window size ${n}` as const)
]

/**
 * What a case may cost, a search budget: the rows its answer may hold by structure (`answerBound`), which D and every
 * window read, judged before anything runs, and the windows its walks read, judged once D is read. A drawn case over it
 * in either is skipped.
 */
const requestBound = 10_000

/** A walk this long in one direction: the required feature "a walk of at least 200 windows in one direction". */
const longWalk = 200

/**
 * The product of two row bounds: no rows where either holds none, an unbounded side otherwise unbounding it, never the
 * NaN that zero times Infinity is.
 */
const times = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : a * b)

/** A column of a region's occurrence bound to one of the region's variables. */
interface BoundColumn {
	readonly source: RelNode
	readonly column: string
}

/** Every occurrence column the variable of `region`'s heading column `column` is bound to. */
const boundColumns = (region: NodeOf<"MatchRegion">, column: string): ReadonlyArray<BoundColumn> =>
	Arr.flatMap(region.occurrences, (o) =>
		Arr.flatMap(o.bindings, (b) =>
			b.var.name === column ? [{ source: o.source, column: b.column }] : []
		)
	)

/**
 * The rows each node of `nodes`, in topological order, may hold, by structure over the case's stored facts `facts`
 * and its relation parameters' rows `params`: a stored relation its facts, a closed relation its rows, a relation
 * parameter its rows, a region the product of its occurrences', a union the sum of its arms', an intersection its lesser
 * side's, an uncorrelated literal take its bound, a fold at least its one row, an approximate nearest its take, a
 * recursive relation the product over its state columns of the values each may take, and every other node its input's
 * or its left side's. Where structure bounds nothing, a correlated region, a view, a producer, a context, the bound is
 * Infinity. No node's bound is below the rows PostgreSQL delivers for it, and none is NaN (`times`).
 *
 * A recursive relation's column takes its base's values and the values its step adds: none where the step carries the
 * column's own value through (a projection, a filter, a region variable bound to it), what its step's other source holds
 * where a region variable is bound there too, and no bound where the step reads another column of its state.
 */
const rowsBounds = (
	nodes: ReadonlyArray<RelNode>,
	facts: GenFacts,
	params: Readonly<Record<string, GenParam>>
): ReadonlyMap<NodeId, number> => {
	const byId = new Map(Arr.map(nodes, (n) => [n.id, n] as const))
	const bounds = new Map<NodeId, number>()
	const rows = (n: RelNode): number =>
		defined(bounds.get(n.id), "a node's inputs bounded before it")
	const referenced = (expr: ScalarExpr): BoundColumn | undefined =>
		expr.kind === "column"
			? {
					source: defined(byId.get(expr.column.node), "a referenced node"),
					column: expr.column.name
				}
			: undefined
	const projected = (n: NodeOf<"ProjectSet">, column: string): BoundColumn | undefined =>
		Option.match(
			Arr.findFirst(n.out, (o) => o.name === column),
			{ onNone: () => undefined, onSome: (o) => referenced(o.expr) }
		)
	const values = (n: RelNode, column: string): number => {
		if (n.kind === "Filter") {
			return values(n.input, column)
		}
		if (n.kind === "ProjectSet") {
			const from = projected(n, column)
			return from === undefined ? rows(n) : Math.min(rows(n), values(from.source, from.column))
		}
		if (n.kind === "MatchRegion") {
			return Arr.reduce(boundColumns(n, column), rows(n), (least, b) =>
				Math.min(least, values(b.source, b.column))
			)
		}
		return rows(n)
	}
	const added = (recursive: NodeId, own: string, n: RelNode, column: string): number => {
		if (n.kind === "SelfRef") {
			return n.recursive === recursive && column === own ? 0 : Number.POSITIVE_INFINITY
		}
		if (n.kind === "Filter") {
			return added(recursive, own, n.input, column)
		}
		if (n.kind === "ProjectSet") {
			const from = projected(n, column)
			return from === undefined ? rows(n) : added(recursive, own, from.source, from.column)
		}
		if (n.kind === "MatchRegion") {
			return Arr.reduce(boundColumns(n, column), rows(n), (least, b) =>
				Math.min(least, added(recursive, own, b.source, b.column))
			)
		}
		return values(n, column)
	}
	const relationRows = (input: InputSetInput): number => {
		if (input.kind === "row") {
			return 1
		}
		if (input.kind === "member") {
			return Number.POSITIVE_INFINITY
		}
		const param = defined(params[input.param], "a relation parameter's rows")
		if (param.kind !== "relation") {
			throw new Error(`an InputSet over the scalar parameter ${input.param}`)
		}
		return param.rows.length
	}
	const bound = (n: RelNode): number => {
		switch (n.kind) {
			case "Base":
				return n.relationKind === "relation"
					? (facts[n.relation] ?? []).length
					: Number.POSITIVE_INFINITY
			case "Closed":
				return n.rows.length
			case "InputSet":
				return relationRows(n.input)
			case "MatchRegion":
				return n.correlated.length > 0
					? Number.POSITIVE_INFINITY
					: Arr.reduce(n.occurrences, 1, (product, o) => times(product, rows(o.source)))
			case "Filter":
			case "ProjectSet":
			case "Window":
			case "Step":
			case "OrderedResult":
				return rows(n.input)
			case "SemiJoin":
			case "AntiJoin":
			case "Difference":
				return rows(n.left)
			case "Intersect":
				return Math.min(rows(n.left), rows(n.right))
			case "Union":
				return Arr.reduce(unionArms(n.groups), 0, (sum, arm) => sum + rows(arm))
			case "Take":
				return n.bound.kind === "literal" && n.correlation.length === 0
					? Math.min(Number(n.bound.k), rows(n.input))
					: rows(n.input)
			case "Group":
			case "OrderedSetAggregate":
				return Math.max(1, rows(n.input))
			case "ApproximateNearest":
				return Math.min(Number(n.take), rows(n.source))
			case "Attach":
				return rows(n.parent)
			case "Recursive":
				return Arr.reduce(n.heading, 1, (product, c) =>
					times(product, values(n.base, c.name) + added(n.id, c.name, n.step, c.name))
				)
			case "Call":
			case "Context":
			case "Delta":
			case "Produce":
			case "SelfRef":
			case "Forbid":
				return Number.POSITIVE_INFINITY
		}
	}
	for (const n of nodes) {
		bounds.set(n.id, bound(n))
	}
	return bounds
}

/**
 * The rows a case's answer may hold, by structure (`rowsBounds`): its root's, and every attachment's child's, the parts
 * D reads and every page reads its share of. It is never below what PostgreSQL delivers.
 */
const answerBound = (
	dag: RootedDag,
	facts: GenFacts,
	params: Readonly<Record<string, GenParam>>
): number => {
	const nodes = topoOrder(dag)
	const bounds = rowsBounds(nodes, facts, params)
	const rows = (n: RelNode): number => defined(bounds.get(n.id), "a node of the case's DAG")
	return Arr.reduce(nodes, rows(dag.roots[0]), (sum, n) =>
		n.kind === "Attach" ? sum + rows(n.child) : sum
	)
}

/**
 * The oracle's population, its plain, attached and heterogeneous-union roots drawn 4 : 2 : 2, each heterogeneous union
 * keyed by the fields every heading group holds (QueryConfig `hetero` "keyed"): a page reads one row's key of those
 * fields, which seeks every group's part and orders the merge across them, and a union with no key within them has no
 * such order, which the page compiler refuses (lower/conservative/take/order.ts sharedOrder).
 */
const config: GenConfig = {
	...defaultGenConfig,
	query: {
		...defaultGenConfig.query,
		roots: {
			...defaultGenConfig.query.roots,
			plain: 4,
			attach: 2,
			hetero: 2
		},
		hetero: "keyed"
	}
}

interface OrderedCase {
	readonly c: QueryCase
	readonly rotate: number
	readonly dirs: ReadonlyArray<boolean>
	readonly stated: number
	/** Each direction's window size; pages by position are of the forward one. */
	readonly size: { readonly forward: PageSize; readonly backward: PageSize }
	/** The position of the case's window at a position, off any page's start as often as on one, and past D's end. */
	readonly position: number
	/**
	 * Whether the caller passes every float zero among its relation parameters' rows as -0, a value of its own (README:
	 * a float keeps its zero's sign), which D then reads too (passedCell).
	 */
	readonly negativeZero: boolean
}

const pageSizeGen: Gen<PageSize> = element(pageSizes)

const orderedCaseGen: Gen<OrderedCase> = (source) => ({
	c: source.draw(queryCaseGen(config)),
	rotate: source.draw(int(0, 7)),
	/** A direction per stated key, the keys being at most eight. */
	dirs: source.draw(array(boolean, { min: 8, max: 8 })),
	stated: source.draw(int(0, 8)),
	/**
	 * A quarter of the cases walk forward at size 1, so every such case whose D holds 200 rows or more reaches a walk of
	 * 200 windows, a required feature; the rest draw both sizes.
	 */
	size: source.draw(
		weighted<OrderedCase["size"]>([
			[3, (inner) => ({ forward: inner.draw(pageSizeGen), backward: inner.draw(pageSizeGen) })],
			[1, (inner) => ({ forward: 1, backward: inner.draw(pageSizeGen) })]
		])
	),
	position: source.draw(int(0, 15)),
	negativeZero: source.draw(boolean)
})

/** A long case: R0(k, a) keyed by k, `facts` facts, k numbering them and a their residue mod 3, every fact read. */
const longCase = (facts: number): QueryCase => {
	const r: GenRelation = {
		name: "R0",
		columns: [
			{ name: "k", type: int4 },
			{ name: "a", type: int4 }
		],
		primaryKey: ["k"],
		keys: [],
		mutable: false
	}
	const q = new Q()
	const root = q.region([
		{
			source: q.base(
				{ name: r.name, heading: r.columns, primaryKey: r.primaryKey },
				conservativeMeta
			),
			bind: { k: "k", a: "a" },
			constants: {}
		}
	])
	const int = (value: number): TypedLiteral => ({ kind: "int", value: BigInt(value) })
	return {
		schema: { name: schemaName, relations: [r], closed: [], containments: [] },
		facts: canonicalFacts({ R0: Arr.map(indices(facts), (i) => [int(i + 1), int(i % 3)]) }),
		query: { dag: normalQuery(q.b.build(Arr.of(root))), params: {} },
		spelling: { mode: "drawn", edge: false }
	}
}

/** A long walk: a long case of 200 to 240 facts in key order, walked forward one fact at a time. */
const longOrderedCaseGen: Gen<OrderedCase> = map(
	int(longWalk, longWalk + 40),
	(facts): OrderedCase => ({
		c: longCase(facts),
		rotate: 0,
		dirs: Arr.makeBy(8, () => false),
		stated: 0,
		size: { forward: 1, backward: 1 },
		position: facts - 1,
		negativeZero: false
	})
)

/**
 * The cases a witness pages: drawn ones (orderedCaseGen), or, while its steering leaves a walk of 200 windows pending
 * (Pending `has`), a long walk (longOrderedCaseGen), which no drawn population of this size reaches by itself; and
 * beside either, the recorded counterexample (recordedPageCases).
 */
const steeredOrderedCases: Steered<OrderedCase, PageFeature> = steered((steering) =>
	recorded(
		Option.exists(steering, (pending) =>
			pending.has("a walk of at least 200 windows in one direction")
		)
			? longOrderedCaseGen
			: orderedCaseGen,
		recordedPageCases
	)
)

const printCase = (o: OrderedCase): string =>
	`order: rotate ${o.rotate}, stated ${o.stated}, ${Arr.join(
		Arr.map(o.dirs, (d) => (d ? "desc" : "asc")),
		" "
	)}, sizes ${o.size.forward} forward and ${o.size.backward} backward, position ${o.position}${o.negativeZero ? ", relation parameters' float zeros passed as -0" : ""}\n${printQueryCase(o.c)}`

type Row = ReadonlyArray<string>

/**
 * A delivered cell as PostgreSQL's output text of its value, which D reads every cell as: a text column's cell itself,
 * a bytes column's assembled value as byteaout's hex text.
 */
const outputOf = (cell: Cell): string => (typeof cell === "string" ? cell : `\\x${cell.toHex()}`)

/** A delivered row's cells as PostgreSQL's output texts (`outputOf`). */
const outputRow = (cells: ReadonlyArray<Cell>): Row => Arr.map(cells, outputOf)

/** A value the case's structure guarantees: its absence is a defect of the suite. */
const defined = <A>(value: A | undefined, what: string): A => {
	if (value === undefined) {
		throw new Error(`expected ${what}`)
	}
	return value
}

interface OrderedQuery {
	readonly query: LogicalQuery
	readonly stated: ReadonlyArray<OrderKey>
}

/**
 * The case's query under an ordered result: the stated keys, then the rest of the heading ascending in heading order,
 * as the checker completes an orderBy; undefined when a column has no admitted order.
 */
const orderedQuery = (o: OrderedCase): OrderedQuery | undefined => {
	const top = o.c.query.dag.roots[0]
	if (
		Arr.some(
			top.heading,
			(col) => !hasCapability(col.type, "ordering") || !hasCapability(col.type, "equality")
		)
	) {
		return undefined
	}
	const names = Arr.map(top.heading, (col) => col.name)
	const rotated = Arr.map(indices(names.length), (i) =>
		defined(names[(i + o.rotate) % names.length], "column")
	)
	const stated: ReadonlyArray<OrderKey> = Arr.map(rotated.slice(0, o.stated), (column, i) => ({
		column,
		dir: o.dirs[i % o.dirs.length] === true ? "desc" : "asc"
	}))
	const named = new Set(Arr.map(stated, (k) => k.column))
	const order: CompletedOrder = {
		keys: [
			...stated,
			...Arr.map(
				Arr.filter(names, (column) => !named.has(column)),
				(column) => ({ column, dir: "asc" as const })
			)
		]
	}
	const node = relNode(NodeId("ordered"), {
		kind: "OrderedResult",
		input: top,
		orders: Arr.map(groupHeadings(top), () => order),
		heading: top.heading,
		meta: top.meta,
		loc: undefined
	})
	const params: Array<ParamDecl> = Arr.map(Rec.toEntries(o.c.query.params), ([name, p]) =>
		p.kind === "scalar"
			? { id: ParamId(name), name, kind: "scalar", type: p.type }
			: { id: ParamId(name), name, kind: "relation", heading: p.heading }
	)
	return {
		query: {
			dag: rooted([node]),
			params
		},
		stated
	}
}

/**
 * A literal as a caller passes it: its host value, which its type's codec reads from the literal's text, or, for an
 * exact numeric whose literal is not written at its typmod's display scale (the codec reads PostgreSQL's own text,
 * "0.00" for numeric(5,2)), the Decimal of that text admitted at the typmod; and the text the codec writes for that
 * value. D reads that text, not the literal's: a caller passes only what its host carrier holds, which is one zero for
 * a float, so a literal spelled -0 reaches PostgreSQL as 0 through the runtime and must reach D as 0 too.
 */
const callerInput = (
	type: ScalarType,
	literal: TypedLiteral,
	codes: Codebook
): { readonly value: unknown; readonly text: ParamText } => {
	const codec = scalarCodec(type, codes)
	const of = (value: unknown) => ({ value, text: codec.text(value) })
	const text = inputText(literal, type, codes)
	const value = strictReader(type, codes)(text)
	if (Result.isSuccess(value)) {
		return of(value.success)
	}
	const decimal = codec.spec.carrier === "numeric" ? Decimal.fromString(text) : undefined
	const admitted = decimal?.ok === true ? storedValue(codec.spec, decimal.value) : undefined
	if (admitted?.ok === true) {
		return of(admitted.value)
	}
	throw new Error(`a generated literal its codec refuses: ${text}`)
}

/** Whether a literal is a float zero, which a caller may pass as -0. */
const isFloatZero = (literal: TypedLiteral): boolean =>
	literal.kind === "float" && literal.value === 0

/**
 * A relation parameter's cell as the caller passes it: a float zero as -0 where the case passes it so (negativeZero),
 * the value itself otherwise; the runtime reads it as the caller's value and D as the codec's text of it.
 */
const passedCell = (o: OrderedCase, literal: TypedLiteral): TypedLiteral =>
	o.negativeZero && isFloatZero(literal) ? floatLiteral(-0) : literal

/**
 * The case's parameters as a caller passes them: scalars as host values, relation parameters as arrays of facts, each
 * float zero among their rows as -0 where the case passes it so.
 */
const hostParams = (o: OrderedCase, codes: Codebook): Readonly<Record<string, unknown>> =>
	Rec.fromEntries(
		Arr.map(Rec.toEntries(o.c.query.params), ([name, p]) => {
			if (p.kind === "scalar") {
				return [name, callerInput(p.type, p.value, codes).value]
			}
			return [
				name,
				Arr.map(p.rows, (row) =>
					Rec.fromEntries(
						Arr.map(p.heading, (h, i) => {
							const literal = defined(row[i], "parameter column")
							return [h.name, callerInput(h.type, passedCell(o, literal), codes).value]
						})
					)
				)
			]
		})
	)

/** A placeholder's text from the caller's parameter values, for D's conservative statements. */
const slotText = (
	o: OrderedCase,
	slot: ConservativeStatement["params"][number],
	codes: Codebook
): string => {
	const p = o.c.query.params[slot.param]
	if (slot.kind === "scalar" && p?.kind === "scalar") {
		return callerInput(p.type, p.value, codes).text
	}
	if (slot.kind === "relation" && p?.kind === "relation") {
		const index = Arr.map(slot.columns, (col) =>
			Option.getOrThrowWith(
				Arr.findFirstIndex(p.heading, (h) => h.name === col.name),
				() => new Error("a column the case's own heading holds")
			)
		)
		const texts = Arr.map(p.rows, (row) =>
			Arr.map(index, (at) => {
				const type = defined(p.heading[at], "parameter column").type
				return callerInput(type, passedCell(o, defined(row[at], "column")), codes).text
			})
		)
		const arrays = arrayTexts(
			String(slot.param),
			Arr.map(slot.columns, (col) => col.name),
			Arr.dedupeWith(texts, (x, y) => x.length === y.length && Arr.every(x, (t, i) => t === y[i])),
			maxStringLength
		)
		if (!arrays.ok) {
			throw new Error(`the arrays of ${slot.param} pass the string bound`)
		}
		return defined(
			arrays.value[slot.part.kind === "column" ? slot.part.index : 0],
			`the array of placeholder ${slot.number}`
		)
	}
	throw new Error(`no value for a ${slot.kind} placeholder`)
}

/**
 * Rows on `heading` as values: each cell its column type's canonical text (oracle/compare.ts canonicalCell), so two
 * spellings of one value, which two statements' deduplications may keep differently, read alike.
 */
const valueRows = (
	heading: Heading,
	rows: ReadonlyArray<Row>,
	codes: Codebook
): ReadonlyArray<Row> => Arr.map(rows, valueRow(heading, codes))

/** A row on `heading` as values (`valueRows`), one row at a time. */
const valueRow = (heading: Heading, codes: Codebook): ((row: Row) => Row) => {
	const cells = Arr.map(heading, (c) => canonicalCell(c.type, codes))
	return (row) =>
		Arr.map(cells, (cell, i) => cell(defined(row[i], `column ${i} of a delivered row`)))
}

/**
 * Rows of an attachment statement on `heading`, each leading with a parent key `width` columns wide, as values
 * (`valueRow`): each parent key's rows, each row's text, in string order. Each row is read as a value and set by its key
 * as it is read, so the rows are held once, as their texts.
 */
const childrenByKey = (
	heading: Heading,
	rows: ReadonlyArray<Row>,
	width: number,
	codes: Codebook
): ReadonlyMap<string, ReadonlyArray<string>> => {
	const value = valueRow(heading, codes)
	const positions = leading(width)
	const out = new Map<string, Array<string>>()
	for (const raw of rows) {
		const row = value(raw)
		const key = keyText(row, positions)
		const group = out.get(key)
		if (group === undefined) {
			out.set(key, [Formatter.format(row)])
		} else {
			group.push(Formatter.format(row))
		}
	}
	for (const group of out.values()) {
		group.sort()
	}
	return out
}

interface Full {
	readonly rows: ReadonlyArray<Row>
	/** Each attachment statement's rows over every delivered parent, by parent key (`childrenByKey`). */
	readonly attachments: ReadonlyArray<ReadonlyMap<string, ReadonlyArray<string>>>
}

/**
 * D: the conservative lowering's delivery, sent as the conservative program's one statement (shapes/index.ts
 * conservativeStatement) and its rows divided into its parts as the runtime divides them (oracle/runner.ts sentRows),
 * each heading group sorted on the page order and the groups merged on it, on the template's heading, as values
 * (valueRows); and every attachment part's rows over every delivered parent, as values too, by parent key, each read
 * as it arrives (`childrenByKey`), so D holds one copy of every row.
 */
const fullResult = (
	session: PgConnection,
	o: OrderedCase,
	query: LogicalQuery,
	template: PageTemplate,
	conservative: ConservativeProgram,
	codes: Codebook
): Effect.Effect<Full, SqlError | RawCaptureError> =>
	Effect.gen(function* () {
		const program = conservativeStatement(conservative)
		const values = Arr.map(program.statement.params, (slot) => slotText(o, slot, codes))
		const parts = yield* sentRows(session, program, program.statement.sql.text, values, everyRow)
		const groups: Array<{ readonly heading: Heading; readonly rows: ReadonlyArray<Row> }> = []
		const attachments: Array<ReadonlyMap<string, ReadonlyArray<string>>> = []
		for (const { labeled, rows } of parts) {
			const part = labeled.statement
			const output = statementOutput(part.role, part.heading, part.fused).heading
			if (part.role.kind === "attachment") {
				attachments.push(childrenByKey(output, rows, keyColumns(part.role).length, codes))
			} else {
				groups.push({ heading: output, rows })
			}
		}
		const heading = template.heading
		const project = (from: Heading, row: Row): Row =>
			Arr.map(heading, (c) =>
				defined(
					row[
						Option.getOrThrowWith(
							Arr.findFirstIndex(from, (h) => h.name === c.name),
							() => new Error("a column the case's own heading holds")
						)
					],
					c.name
				)
			)
		const types: Record<string, Heading[number]["type"]> = {}
		for (const c of heading) {
			types[c.name] = c.type
		}
		const compare = mergeComparator({ order: template.order, types, codes })
		if (!compare.ok) {
			throw new Error(compare.error.message)
		}
		const rootNode = query.dag.roots[0]
		if (rootNode.kind !== "OrderedResult") {
			throw new Error("an ordered result")
		}
		const [rootOrder] = rootNode.orders
		const compareRoot = mergeComparator({ order: rootOrder, types, codes })
		if (!compareRoot.ok) {
			throw new Error(compareRoot.error.message)
		}
		type Decoded = { readonly row: Row; readonly value: { readonly [c: string]: unknown } }
		const byPage = (a: Decoded, b: Decoded): number => compare.value(a.value, b.value)
		/** The page's order as an Order: the comparator's sign. */
		const pageOrder: Order.Order<Decoded> = (a, b) => {
			const sign = byPage(a, b)
			return sign < 0 ? -1 : sign > 0 ? 1 : 0
		}
		const decoded = Arr.map(groups, (g) =>
			Arr.sort(
				Arr.map(g.rows, (row): Decoded => ({
					row: project(g.heading, row),
					value: headingRecord(g.heading, codes)(row)
				})),
				pageOrder
			)
		)
		const merged = mergeHeadingGroups(decoded, byPage, undefined)
		for (let i = 1; i < merged.length; i++) {
			const a = defined(merged[i - 1], "row").row
			const b = defined(merged[i], "row").row
			if (byPage(a, b) !== 0) {
				continue
			}
			throw new PropertyFailed({
				report:
					compareRoot.value(a.value, b.value) !== 0
						? `two delivered rows tie on the page order ${Formatter.format(template.order.keys)} but not on every common column\n${printCase(o)}`
						: `two delivered rows tie on every common column\n${printCase(o)}`
			})
		}
		return {
			rows: valueRows(
				heading,
				Arr.map(merged, (m) => m.row.row),
				codes
			),
			attachments
		}
	})

/**
 * One window through the runtime minus its transaction: its anchor read by the window's parse (page/window.ts
 * windowCall), its one statement built by the runtime's windowStatement and run on the test's session, and its rows read
 * by the runtime's windowIntake, which merges heading groups, cuts them to the size, reverses a backward template and
 * stitches attachments: the delivered Rows, in presentation order, and the Keys of the first and the last, which the
 * windows before and after it anchor at.
 */
interface Windowed {
	/** The delivered rows on the template's heading, in presentation order, as values (valueRows). */
	readonly delivered: ReadonlyArray<Row>
	/** Every attachment statement of the window's program, in statement order. */
	readonly attached: ReadonlyArray<Attached>
	readonly first: Option.Option<RowKey>
	readonly last: Option.Option<RowKey>
}

/**
 * One attachment statement of one window: the parent keys its parent delivered in this window (the window's delivered
 * rows of a rows statement, or every row of a parent attachment), and the rows it read, each leading with its parent
 * key, all as values (valueRows): an attachment statement keeps each (parent key, child) once, so where two parents'
 * keys are one value spelled two ways (-0 and 0), D's statement and the window's may keep different spellings of that
 * row.
 */
interface Attached {
	readonly width: number
	readonly parents: ReadonlyArray<string>
	readonly rows: ReadonlyArray<Row>
	/**
	 * The parent keys of the window's first and last rows, when the attachment's parent is the rows statement that
	 * delivered them.
	 */
	readonly head: string | undefined
	readonly tail: string | undefined
}

/** The parent key text of an attachment row, or of a parent row, at the key's positions, of rows read as values. */
const keyText = (row: Row, positions: ReadonlyArray<number>): string =>
	Formatter.format(Arr.map(positions, (p) => row[p]))

/** The parent key of a parent row as a value: each cell at the key's positions its column type's canonical text. */
const keyValue = (
	row: Row,
	positions: ReadonlyArray<number>,
	key: Heading,
	codes: Codebook
): string =>
	Formatter.format(
		Arr.map(positions, (p, i) =>
			canonicalCell(
				defined(key[i], "a parent key column").type,
				codes
			)(defined(row[p], "a parent key cell"))
		)
	)
const leading = (width: number): ReadonlyArray<number> => [...indices(width)]

/** A cell as the wire admits it: the text the server sent, or NULL. */
const textCell = (cell: unknown): string => {
	if (typeof cell === "string") {
		return cell
	}
	throw new Error(`a cell delivered as ${typeof cell}, not as text`)
}

/**
 * A test connection's failure as a read's: the server's refusal, which pg reported as a DatabaseError, parsed as the wire
 * parses it (wire/failure.ts serverFailure), and anything else the transport's loss.
 */
const readFailureOf = (error: SqlError): ReadFailure => {
	const answer = error.cause instanceof DatabaseError ? serverFailure(error.cause) : undefined
	return new ReadFailure({
		reason:
			answer === undefined
				? new ConnectionLost({ operation: "query", ended: { by: "transport" } })
				: answer.error
	})
}

/**
 * Reads windows of `runtime` with `params` on the test's session, inside the transaction the test holds open there: each
 * window's one statement sent, every column delivered as text, and its rows read by the runtime's intake (see Windowed).
 * Every attachment runs, a part of the window's one statement: one with no parent row in this window reads none.
 */
const windowReader = (
	runtime: PageRuntime,
	session: PgConnection,
	params: Readonly<Record<string, unknown>>,
	codes: Codebook
) => {
	const comparators = Arr.map(runtime.page.comparators, (c) => ({
		field: c.field,
		value: scalarReader(c.type, codes)
	}))
	return (anchor: Anchor, size: number): Effect.Effect<Windowed, ReadError> =>
		Effect.gen(function* () {
			const inputs = yield* Effect.fromResult(
				Result.mapError(
					executionInputs(paramCodecs(runtime.params, codes), params),
					(reason) => new ReadFailure({ reason })
				)
			)
			const call = yield* Effect.fromResult(
				Result.mapError(
					windowCall({ anchor, size }, runtime.anchors),
					(reason) => new ReadFailure({ reason })
				)
			)
			const program = runtime.artifact.requests[call.variant]
			const statement = yield* Effect.mapError(
				windowStatement(runtime, inputs, call, keptRows),
				(reason) => new ReadFailure({ reason })
			)
			const raw = yield* Effect.mapBoth(session.queryValues(sentSql(statement), statement.params), {
				onFailure: readFailureOf,
				onSuccess: (rows) => outputRows(Arr.map(rows, (row) => Arr.map(row, textCell)))
			})
			const rows: Array<DeliveredRow> = []
			const intake = windowIntake(program, call.size, (row) => {
				rows.push(row)
			})
			for (const row of raw) {
				intake.take(row)
			}
			yield* Effect.mapError(
				Effect.fromResult(intake.end()),
				(reason) => new ReadFailure({ reason })
			)
			const sent = partRuns(program.run.parts, raw)
			const delivery = program.delivery
			const groups =
				delivery.kind === "concat"
					? delivery.groups
					: Arr.map(delivery.order.groups, (g) => g.group)
			/** The record of the rows statement that delivered a row, by its heading group. */
			const recordOf = (row: DeliveredRow) =>
				defined(groups[row.group], "a delivered row's heading group").record
			/** A delivered row's RowKey: its comparators' values, each converted from its cell. */
			const keyOfRow = (row: DeliveredRow): RowKey => {
				const heading = recordOf(row).part.heading
				return RowKey(
					Arr.map(comparators, (c) =>
						c.value.convert(rowCell(row.cells, columnPosition(heading, c.field)))
					)
				)
			}
			const delivered = valueRows(
				runtime.page.heading,
				Arr.map(rows, (row) => {
					const heading = recordOf(row).part.heading
					return Arr.map(runtime.page.heading, (c) =>
						defined(
							outputRow(row.cells)[
								Option.getOrThrowWith(
									Arr.findFirstIndex(heading, (h) => h.name === c.name),
									() => new Error("a column the case's own heading holds")
								)
							],
							c.name
						)
					)
				}),
				codes
			)
			const records = program.records
			const parents = new Map(
				Arr.flatMap(records, (r) => Arr.map(r.plan.children, (c) => [c.record, r] as const))
			)
			const attached: Array<Attached> = []
			for (const record of records) {
				const parentRecord = parents.get(record)
				if (parentRecord === undefined) {
					continue
				}
				const parentKey = keyColumns(record.part.role)
				const parent = parentRecord.part
				const offset = keyColumns(parent.role).length
				const positions = Arr.map(parentKey, ({ name }) => {
					const at = Arr.findFirstIndex(parent.heading, (h) => h.name === name)
					if (Option.isNone(at)) {
						throw new PropertyFailed({ report: `no parent column ${name}` })
					}
					return offset + at.value
				})
				const parentRows: ReadonlyArray<Row> =
					parent.role.kind === "attachment"
						? Arr.map(runOf(parentRecord, sent), outputRow)
						: Arr.map(
								Arr.filter(rows, (row) => recordOf(row) === parentRecord),
								(row) => outputRow(row.cells)
							)
				const edgeKey = (row: DeliveredRow | undefined): string | undefined =>
					row !== undefined && recordOf(row) === parentRecord
						? keyValue(outputRow(row.cells), positions, parentKey, codes)
						: undefined
				attached.push({
					width: parentKey.length,
					parents: Arr.map(parentRows, (row) => keyValue(row, positions, parentKey, codes)),
					rows: valueRows(
						statementOutput(record.part.role, record.part.heading, record.part.fused).heading,
						Arr.map(runOf(record, sent), outputRow),
						codes
					),
					head: edgeKey(rows[0]),
					tail: edgeKey(rows.at(-1))
				})
			}
			return {
				delivered,
				attached,
				first: Option.map(Arr.head(rows), keyOfRow),
				last: Option.map(Arr.last(rows), keyOfRow)
			}
		})
}

/**
 * Each attachment of each window reads exactly its delivered parents' children: every row it read belongs to a parent
 * delivered in that window, never to a row past it or of another window, and each delivered parent's children are
 * exactly D's children of that parent key, with no duplicate and no omission. The attachment statement keeps each
 * (parent key, child) once (shapes/attach pipelinedAttachment), so a parent key's children are the same set of values
 * in a window as in D's attachment statement, keys and rows compared as values, as the reader matches a parent to its
 * children (codec/scalar.ts cellText).
 */
const checkAttachments = (label: string, w: Windowed, full: Full): void => {
	for (const [a, attached] of w.attached.entries()) {
		const d = full.attachments[a]
		if (d === undefined) {
			throw new PropertyFailed({ report: `${label}: no attachment ${a} in D` })
		}
		const parents = new Set(attached.parents)
		const read = new Map<string, Array<string>>()
		for (const row of attached.rows) {
			const key = keyText(row, leading(attached.width))
			const group = read.get(key)
			if (group === undefined) {
				read.set(key, [Formatter.format(row)])
			} else {
				group.push(Formatter.format(row))
			}
		}
		for (const key of read.keys()) {
			assert.ok(
				parents.has(key),
				`${label} attachment ${a}: a child of ${key}, a parent this window did not deliver`
			)
		}
		for (const key of parents) {
			const children: ReadonlyArray<string> = Arr.sort(read.get(key) ?? [], Order.String)
			assert.deepEqual(
				children,
				d.get(key) ?? [],
				`${label} attachment ${a}: the children of ${key}`
			)
		}
	}
}

/**
 * A walk from the start and a walk from the end, each at its drawn size: from the start, each window after the last
 * row of the one before; from the end, each before the first row of the one before; each until a window holds no row.
 * Each window is judged as it arrives, against D's rows at its place: it holds exactly its size of them, or what
 * remains of D, so a walk ends with the one empty window past D's last row (or before its first), and an empty D's walk
 * is that window alone. A walk holds one window besides the one before it.
 *
 * Whether checkAttachments could see the children of a row past a window leak into it: the row after a forward
 * window, the next window's first row, or before a backward window, the previous window's last row, is a parent with
 * children in D that the window did not deliver.
 */
const checkRuntime = (
	read: ReturnType<typeof windowReader>,
	full: Full,
	note: Case<PageFeature>["note"],
	sizes: { readonly forward: PageSize; readonly backward: PageSize },
	position: number
): Effect.Effect<void, ReadError> =>
	Effect.gen(function* () {
		const total = full.rows.length
		for (const direction of ["forward", "backward"] as const) {
			const size = sizes[direction]
			const forward = direction === "forward"
			const walk = `${direction} ${size}`
			let previous: Windowed | undefined
			let current = yield* read(forward ? { kind: "start" } : { kind: "end" }, size)
			let windows = 0
			let walked = 0
			for (;;) {
				const count = current.delivered.length
				const start = forward ? walked : total - walked - count
				const at = `${walk} window ${windows}`
				assert.equal(count, Math.min(size, total - walked), `${at}: its size, or what remains of D`)
				assert.deepEqual(current.delivered, full.rows.slice(start, start + count), at)
				checkAttachments(at, current, full)
				if (previous !== undefined) {
					const beyond = Arr.map(current.attached, (x) => (forward ? x.head : x.tail))
					for (const [a, x] of previous.attached.entries()) {
						const key = beyond[a]
						if (
							key !== undefined &&
							!x.parents.includes(key) &&
							(full.attachments[a]?.has(key) ?? false)
						) {
							note("a parent past the window with children")
						}
					}
				}
				walked += count
				windows += 1
				const edge = forward ? current.last : current.first
				if (Option.isNone(edge)) {
					break
				}
				if (windows > total + 1) {
					throw new PropertyFailed({ report: `${walk}: a walk that does not end` })
				}
				previous = current
				current = yield* read(
					forward ? { kind: "after", key: edge.value } : { kind: "before", key: edge.value },
					size
				)
			}
			assert.equal(walked, total, `${walk}: every row of D delivered`)
			if (windows >= longWalk) {
				note("a walk of at least 200 windows in one direction")
			}
			note(`window size ${size}`)
		}
		yield* checkPositions(read, full, note, sizes.forward, position)
	})

/**
 * Windows at positions: pages by position at the forward size, page n at position n times the size, from page 0 until
 * one holds no row, and the window at the case's own position, with the window after its last row's key. Each is judged
 * as it arrives, against D's rows at its place: the window at position p of size k holds exactly D's rows [p, p + k), so
 * the one past D's last row holds none; its attachments read exactly its rows' children; the pages together hold every
 * row of D exactly once, in D's order; and the window anchored after a positioned window's last row holds D's next k
 * rows, as a keyset walk continues from a page.
 */
const checkPositions = (
	read: ReturnType<typeof windowReader>,
	full: Full,
	note: Case<PageFeature>["note"],
	size: PageSize,
	position: number
): Effect.Effect<void, ReadError> =>
	Effect.gen(function* () {
		const total = full.rows.length
		const judged = (at: number): Effect.Effect<Windowed, ReadError> =>
			Effect.map(read({ kind: "at", position: at }, size), (w) => {
				const where = `at ${at} of ${size}`
				assert.deepEqual(w.delivered, full.rows.slice(at, at + size), where)
				checkAttachments(where, w, full)
				return w
			})
		const pages: Array<Row> = []
		for (let page = 0; ; page++) {
			if (page > total + 1) {
				throw new PropertyFailed({ report: `pages by position of ${size} that do not end` })
			}
			const paged = yield* judged(page * size)
			if (paged.delivered.length === 0) {
				break
			}
			for (const row of paged.delivered) {
				pages.push(row)
			}
			if (page === 1) {
				note("several pages by position")
			}
		}
		const concatenated: ReadonlyArray<Row> = pages
		assert.deepEqual(
			concatenated,
			full.rows,
			`pages by position of ${size}: every row of D once, in order`
		)
		const positioned = yield* judged(position)
		if (Option.isNone(positioned.last)) {
			note("a window at a position past D")
			return
		}
		note("a window at a position within D")
		const after = yield* read({ kind: "after", key: positioned.last.value }, size)
		const next = position + positioned.delivered.length
		assert.deepEqual(
			after.delivered,
			full.rows.slice(next, next + size),
			`after the window at ${position} of ${size}`
		)
	})

/**
 * What a case reached besides its skip and its relation parameters: its query's node kinds, the shapes of the template
 * it pages through, among them a per-execution form, and its D, paired with its heading groups where it spans several
 * pages by position at the forward size `forward`. A distinct is read from the statements' ASTs, never their text.
 */
const coverage = (
	query: LogicalQuery,
	template: PageTemplate,
	full: Full,
	forward: PageSize,
	c: Case<PageFeature>
): void => {
	const note = c.note
	const kinds = new Set(Arr.map(topoOrder(query.dag), (n) => n.kind))
	for (const kind of [
		"Group",
		"Recursive",
		"Take",
		"Union",
		"SemiJoin",
		"AntiJoin",
		"Difference"
	] as const) {
		if (kinds.has(kind)) {
			note(kind)
		}
	}
	if (template.artifact.requests.first.delivery.kind === "headingGroups") {
		note("heading groups")
		if (full.rows.length > forward) {
			c.pair("heading groups", "several pages by position")
		}
	}
	if (
		Arr.some(
			flight(template.artifact.requests.first.program.roots),
			(s) => s.role.kind === "attachment"
		)
	) {
		note("attachments")
	}
	if (correlatedChildUnderNestedAttachment(query.dag)) {
		note("a correlated child under a nested attachment")
	}
	if (template.artifact.requests.first.program.statement.forms.kind === "chosen") {
		note("per-execution form")
	}
	if (template.heading.length === 0) {
		note("unit")
	}
	const dirs = new Set(Arr.map(template.comparators, (c) => c.direction))
	if (dirs.size > 1) {
		note("mixed directions")
	}
	if (dirs.size === 1 && template.comparators.length > 1) {
		note("row comparison")
	}
	if (dirs.has("desc")) {
		note("descending")
	}
	if (dirs.has("asc")) {
		note("ascending")
	}
	if (
		Arr.some(
			programAsts(template.artifact.requests.after.program),
			(ast) => has(shapeOf(ast), "distinct") || has(shapeOf(ast), "distinct on")
		)
	) {
		note("distinct before the bound")
	}
	if (template.comparators.length < template.heading.length) {
		note("key prefix")
	}
	if (full.rows.length === 0) {
		note("empty D")
	}
	if (full.rows.length > 7) {
		note("more than seven rows")
	}
}

/**
 * Whether the caller passes a float -0 in a relation parameter: its host carrier admits it as the one zero, so the
 * runtime's answer must be D's, which reads the codec's text of that zero.
 */
const negativeZeroRelation = (o: OrderedCase): boolean =>
	o.negativeZero &&
	Arr.some(
		Rec.values(o.c.query.params),
		(p) => p.kind === "relation" && Arr.some(p.rows, (row) => Arr.some(row, isFloatZero))
	)

/**
 * The page runtime on generated ordered queries, through the optimized artifact, which the page compiler builds and the
 * runtime runs (test/pg/page/generated-optimized.test.ts).
 *
 * Each oracle case (test/support/oracle/gen: plain, attached and heterogeneous-union roots over matches,
 * filters, projections, semi- and anti-joins, unions, intersections, differences, groups, takes and recursive
 * closures) is ordered by a drawn prefix of its result heading, rotated, each direction drawn. Its page template is the
 * page compiler's, and its runtime template (packages/grizzle/src/adapter/page/template.ts pageRuntimeOf) adds the
 * specs and one anchor codec per comparator. The case installs with the real installer in a transaction that is rolled
 * back, and every window reads that one snapshot. Every window goes through the runtime as a reader's does, minus the
 * transaction: its anchor is read by the window's parse (page/window.ts windowCall), its RowKey the delivered row's
 * comparator values, its one statement runs (a LIMIT of its size, the heading-group merge and cut, the backward
 * reversal, the attachments over the delivered rows), and its rows are read by the runtime's window intake, so the
 * next window anchors at a real row's RowKey. Then:
 *
 * - windows walked from the start, each after the last one's last row, and from the end, each before the first one's
 *   first row, at one size per direction, drawn per case, every size 1 through 7 over the run, cut the complete sorted
 *   distinct conservative result D (fullResult, as the lowering suite computes it), on the template's heading as raw
 *   result texts: each window holds exactly its size of D's rows at its place, or what remains of D, and a walk ends
 *   with the one empty window past D's last row (or before its first), an empty D's walk being that window alone;
 * - each window's attachments read its delivered parents only: every attachment row a window read belongs to a parent
 *   it delivered, never to a row past it, and each delivered parent's children are exactly D's children of that key;
 *   every attachment statement is a part of the window's one statement;
 * - windows at positions (checkPositions): the window at position p of size k holds exactly D's rows [p, p + k), pages
 *   by position at the forward size, from position 0 until one holds no row, hold every row of D exactly once in D's
 *   order, and the window after the last row of the window at the case's drawn position holds D's next k rows. A
 *   heterogeneous union's positioned window delivers each group's rows of the window alone, so its merge keeps them
 *   all.
 *
 * Every heterogeneous union is keyed by the fields its heading groups share (`config`), so every case the rare skips
 * leave compiles: a page compiler's refusal fails the case, as two rows of D tying on the page order do. Every case
 * notes what it reached (PageFeature), a skip its reason (PageSkip), and the population must reach every required
 * feature, among them a per-execution form, a relation parameter holding a float -0, which the runtime passes as the
 * caller's one zero, a walk of at least 200 windows, a heterogeneous union's pages by position, and a correlated
 * child under a nested attachment, the shape where a key within one parent must not stand for a key across parents
 * (lower/conservative/keys.ts). Its escaped counterexample is recorded (recordedPageCases) and replays by its token
 * before its streams.
 *
 * A case whose walks at its drawn sizes would read more windows than the request bound is skipped, noted as its skip.
 */

/**
 * The suite's escaped counterexample, recorded beside its space (gen.ts recorded), which no search of toolchain-test
 * keep reached: page/generated-optimized at TEST_SEED=28094260 (its rotating stream's case 872,
 * test/unit/lower/dedup/cases.ts withinOneParentCase), ordered by its one column and paged two rows at a time, so a
 * page delivers both parents whose children, a take of one row each, share the key a = 0 of the attachment nested below
 * them. The optimized artifact read that attachment's key set without DISTINCT, as if a key within one parent held
 * across parents, and its statement delivered each child of 0 twice, rows the reader refused. The property keeps it by
 * its token, `:-:1` and the unperturbed, once-rotated conditions its case draws after it.
 */
const recordedPageCases: Arr.NonEmptyReadonlyArray<OrderedCase> = [
	{
		c: withinOneParentCase(),
		rotate: 0,
		dirs: Arr.makeBy(8, () => false),
		stated: 0,
		size: { forward: 2, backward: 2 },
		position: 1,
		negativeZero: false
	}
]

export const generatedProperty = (
	kept: ReadonlyArray<Kept>,
	kills: ReadonlyArray<Kill>,
	budget: Budget
) => {
	/**
	 * The case installs, loads and reads under one savepoint of its transaction (OracleSeat's reading), rolled back to
	 * after it: a rollback that fails leaves the transaction unlike the case found it, a defect of the case, never
	 * ignored.
	 *
	 * Noted only once the case pages: a skipped case never read its -0.
	 */
	const runCase = (o: OrderedCase, c: Case<PageFeature>) =>
		Effect.gen(function* () {
			const seat = yield* OracleSeat
			const schema = yield* seat.schema("page_rt")
			const ordered = orderedQuery(o)
			if (ordered === undefined) {
				c.note("skipped: unordered column")
				return
			}
			const query = ordered.query
			const desc = schemaDesc(o.c.schema)
			const planned = oraclePlan(desc, identity.schema(parsedSchemaName(schema)), query.params)
			if (!planned.ok) {
				return yield* Effect.die(new Error(planned.error.message))
			}
			const plan = planned.value
			/**
			 * The case's plan perturbation (test/support/oracle/perturb.ts): its facts repeated under fresh keys, and its
			 * planner settings for the full result and every page.
			 */
			const perturbation = yield* CurrentPerturbation
			const stored = {
				...o.c,
				facts: multiplyFacts(o.c.schema, o.c.facts, perturbation.multiplier)
			}
			const answer = answerBound(query.dag, stored.facts, o.c.query.params)
			if (!(answer <= requestBound)) {
				c.note("skipped: answer over the request bound")
				return
			}
			const facts = factStatements(plan, factSet(stored))
			if (!facts.ok) {
				return yield* Effect.die(new Error(facts.error.message))
			}
			const names = plan.installation.names
			const codes = names.codes
			const conservative = lowerConservative(conservativeInput(query), {
				names,
				params: query.params,
				subject: { kind: "query" }
			})
			if (!conservative.ok) {
				c.note("skipped: baseline refuses")
				return
			}
			const catalog = genCatalog(o.c.schema)
			const admission = admitGenerated(query)
			const optimized = admission.ok
				? lowerOptimized(admission.value, {
						names,
						context: "snapshot",
						catalog,
						subject: { kind: "query" }
					})
				: admission
			if (!optimized.ok) {
				return yield* new PropertyFailed({
					report: `optimized lowering: ${optimized.error.message}\n${printCase(o)}`
				})
			}
			const violations = loweringViolations({
				optimized: optimized.value,
				alignment: { kind: "aligned", conservative: conservative.value },
				context: "snapshot",
				catalog
			})
			if (violations.length > 0) {
				return yield* new PropertyFailed({
					report: `${Arr.join(violations, "\n")}\n${printCase(o)}`
				})
			}
			/** The generated order is stated at a location of its own, which a refusal to complete it names. */
			const statedAt = SourceLoc("generated orderBy", [])
			const pageInput = {
				checked: query,
				optimized: optimized.value,
				names,
				stated: { keys: ordered.stated, at: statedAt }
			}
			const page = compilePage(pageInput)
			if (!page.ok) {
				return yield* new PropertyFailed({
					report: `page compiler: ${page.error.message}\n${printCase(o)}`
				})
			}
			const template = page.value
			const runtime = compiledPageRuntime({
				page: template,
				params: callerParams(query.params),
				codes,
				spine: everyColumnCarried(query.dag)
			})
			const params = hostParams(o, codes)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const reading = yield* seat.reading
					const session = reading.connection
					for (const sql of reading.open) {
						yield* session.query(sql, [])
					}
					yield* Effect.addFinalizer(() => Effect.orDie(session.pipeline(reading.close)))
					for (const sql of filledSql(plan.drafted, seat.database)) {
						yield* session.query(sql, [])
					}
					for (const sql of facts.value) {
						yield* session.query(sql, [])
					}
					const tables = Arr.map(Rec.values(plan.tables), (t) => printObjectName(t.name))
					if (tables.length > 0) {
						yield* session.query(`ANALYZE ${Arr.join(tables, ", ")}`, [])
					}
					for (const sql of plannerStatements(perturbation)) {
						yield* session.query(sql, [])
					}
					const full = yield* fullResult(session, o, query, template, conservative.value, codes)
					const read = Arr.reduce(full.attachments, full.rows.length, (sum, children) =>
						Arr.reduce([...children.values()], sum, (n, rows) => n + rows.length)
					)
					assert.ok(
						read <= answer,
						`D holds ${read} rows, over the answer's structural bound ${answer}\n${printCase(o)}`
					)
					const sizes = o.size
					/**
					 * One window per size of D's rows in each walk and in the pages by position, the empty window that ends
					 * each, and the window at the case's position with the one after it.
					 */
					const cost =
						2 * (Math.ceil(full.rows.length / sizes.forward) + 1) +
						Math.ceil(full.rows.length / sizes.backward) +
						1 +
						2
					if (cost > requestBound) {
						c.note("skipped: walk over the request bound")
						return
					}
					yield* checkRuntime(
						windowReader(runtime, session, params, codes),
						full,
						c.note,
						sizes,
						o.position
					)
					coverage(query, template, full, sizes.forward, c)
					if (negativeZeroRelation(o)) {
						c.note("float -0 in a relation parameter")
					}
				})
			)
		}).pipe(
			Effect.catchDefect((defect) =>
				Effect.fail(
					defect instanceof PropertyFailed
						? defect
						: new PropertyFailed({ report: `${messageOf(defect)}\n${printCase(o)}` })
				)
			),
			Effect.catchTag("ReadFailure", (e) =>
				Effect.fail(
					new PropertyFailed({ report: `${e._tag}: ${Formatter.format(e)}\n${printCase(o)}` })
				)
			)
		)

	return oracleProperty(steeredOrderedCases, {
		situations,
		perturb: "all",
		oracle: {
			kind: "second-implementation",
			name: "the baseline lowering's ordered answer, cut into windows by the window contract"
		},
		budget,
		kept,
		kills,
		show: Formatter.format,
		check: (c: Case<PageFeature>) => (o) => runCase(o, c)
	})
}
