import { layer } from "@effect/vitest"
import { type Case, drawn } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Data,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	Result
} from "effect"
import { DatabaseError } from "pg"
import type { TestContext } from "vitest"
import { fromEngine } from "#adapter/engine.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { ConnectionLost, type UnreadableAnswer } from "#adapter/errors/failures.ts"
import { type PageCall, type PageRows, pageFlight } from "#adapter/page/execute.ts"
import { pageOf } from "#adapter/page/page.ts"
import { type PageArtifactName, type PageRuntime, pageRuntimeOf } from "#adapter/page/template.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import type { BatchOutcome, Flight } from "#adapter/wire/batch.ts"
import { serverFailure } from "#adapter/wire/failure.ts"
import { arrayTexts } from "#compiler/codec/recordset.ts"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { indices } from "#compiler/core/array.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { type CursorError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { NodeId, ParamId } from "#compiler/core/ids.ts"
import { formatLoc, SourceLoc } from "#compiler/core/loc.ts"
import { textMaxLength } from "#compiler/core/policy.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { nodesByLabel, relNode, rooted, topoOrder } from "#compiler/ir/dag.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { LogicalQuery, ParamDecl, StatementSpec } from "#compiler/ir/products.ts"
import {
	type CompletedOrder,
	conservativeMeta,
	type Heading,
	type OrderKey
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	conservativeInput,
	type ConservativeStatement,
	flight,
	keyColumns
} from "#compiler/lower/conservative/types.ts"
import { lowerOptimized } from "#compiler/lower/optimize/pipeline.ts"
import { deliveredAsOptimized, type OptimizedStatement } from "#compiler/lower/shapes/index.ts"
import { compilePage, type PageTemplate } from "#compiler/lower/shapes/page/compile.ts"
import { mergeHeadingGroups } from "#compiler/lower/shapes/union/index.ts"
import { declaredSlotOf, statementSpec } from "#compiler/lower/template.ts"
import { hasCapability } from "#compiler/scalar/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { admitValue } from "#compiler/scalar/values/identity.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import type { Page } from "#compiler/types/page/page.ts"
import { assert, refusalLoc } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import { strictRead } from "#test/support/kernel/strict.ts"
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
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { printQueryCase } from "#test/support/oracle/gen/print.ts"
import { normalQuery } from "#test/support/oracle/gen/query.ts"
import { type GenRelation, schemaDesc, schemaName } from "#test/support/oracle/gen/schema.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { oraclePlan } from "#test/support/oracle/install/real.ts"
import {
	CurrentPerturbation,
	multiplyFacts,
	plannerStatements
} from "#test/support/oracle/perturb.ts"
import { factSet, inputText, oracleCheck, PropertyFailed } from "#test/support/oracle/runner.ts"
import { loweringViolations } from "#test/support/oracle/verify/index.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { statementSql } from "#test/support/sql.ts"
import { headingRecord } from "#test/support/statement-rows.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { Q } from "#test/unit/lower/conservative/fixtures.ts"

/**
 * Why a case pages nothing: a column without an admitted order, a baseline lowering that refuses the query, a
 * heterogeneous union whose common columns hold no proved key, heading groups that tie on every common column, or a
 * traversal over the request bound.
 */
type PageSkip =
	| "unordered column"
	| "baseline refuses"
	| "union without a common key"
	| "heading groups tie"
	| "traversal over the request bound"

/**
 * The page sizes a case draws from, one per direction: up to seven, so a D of more than seven rows spans several pages
 * at every size.
 */
const pageSizes = [1, 2, 3, 4, 5, 6, 7] as const
type PageSize = (typeof pageSizes)[number]

/**
 * What a case reached: the node kinds of its query, the shapes of its template, the size of its D, the lookahead row
 * a page drops, a per-execution form, a caller's float -0 among a relation parameter's rows, the page size of each traversal, and
 * its skip.
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
	| "unit"
	| "mixed directions"
	| "row comparison"
	| "ascending"
	| "descending"
	| "distinct before the bound"
	| "key prefix"
	| "empty D"
	| "more than seven rows"
	| "lookahead parent with children"
	| "per-execution form"
	| "float -0 in a relation parameter"
	| "a traversal of at least 200 pages in one direction"
	| `page size ${PageSize}`
	| `skipped: ${PageSkip}`

/** What the population must reach. */
const situations: Arr.NonEmptyReadonlyArray<PageFeature> = [
	"Group",
	"Recursive",
	"Take",
	"Union",
	"SemiJoin",
	"AntiJoin",
	"Difference",
	"heading groups",
	"attachments",
	"lookahead parent with children",
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
	"a traversal of at least 200 pages in one direction",
	...Arr.map(pageSizes, (n) => `page size ${n}` as const)
]

/**
 * The requests a case's traversals may take: what fits in half its hang bound (caseHang, two minutes)
 * at the slowest per-request time measured on this machine. Over 6,956 traversed cases of generated-optimized at
 * three seeds, a request (one page's flight with its attachments and checks) took 0.54 ms
 * at the median, 4.4 ms at the 90th percentile, and 6.04 ms at the slowest; at the median, the 110,000 requests half
 * the bound would admit take eight minutes for the slowest shapes, so the bound uses the slowest: 60,000 / 6 = 10,000.
 * The largest traversal those runs drew took 3,460 requests; one case, 186,624 (a 93,312-row cross product at page
 * size 1), is the kind the bound skips.
 */
const slowestRequestMillis = 6

/** How long one case may run before it is stopped and reported. */
const caseHang = Duration.minutes(2)

const requestBound = Math.floor(Duration.toMillis(caseHang) / 2 / slowestRequestMillis)

/**
 * The share of a run's cases the request bound may skip: past it the generator has drifted toward results no traversal
 * can afford, and the run fails rather than keep skipping.
 */
const boundSkipShare = 0.05

/**
 * A traversal this long in one direction: a length every measured run reached 6 to 8 times (the three seeds above),
 * far under the request bound.
 */
const longTraversal = 200

const config: GenConfig = {
	...defaultGenConfig,
	query: {
		...defaultGenConfig.query,
		roots: {
			...defaultGenConfig.query.roots,
			plain: 4,
			attach: 2,
			hetero: 2
		}
	}
}

interface OrderedCase {
	readonly c: QueryCase
	readonly rotate: number
	readonly dirs: ReadonlyArray<boolean>
	readonly stated: number
	/** Each direction's page size. */
	readonly size: { readonly forward: PageSize; readonly backward: PageSize }
	/**
	 * Whether the caller passes every float zero among its relation parameters' rows as -0, a number its host carrier
	 * admits as the one zero.
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
	 * A quarter of the cases page forward at size 1, so every such case whose D holds 200 rows or more reaches a
	 * 200-page traversal, a required feature; the rest draw both sizes.
	 */
	size: source.draw(
		weighted<OrderedCase["size"]>([
			[3, (inner) => ({ forward: inner.draw(pageSizeGen), backward: inner.draw(pageSizeGen) })],
			[1, (inner) => ({ forward: 1, backward: inner.draw(pageSizeGen) })]
		])
	),
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

/** A long traversal: a long case of 200 to 240 facts in key order, paged forward one fact at a time. */
const longOrderedCaseGen: Gen<OrderedCase> = map(
	int(longTraversal, longTraversal + 40),
	(facts): OrderedCase => ({
		c: longCase(facts),
		rotate: 0,
		dirs: Arr.makeBy(8, () => false),
		stated: 0,
		size: { forward: 1, backward: 1 },
		negativeZero: false
	})
)

/**
 * The case a case pages: the drawn one, or, while the case's steering leaves a traversal of 200 pages pending, a long
 * traversal drawn from the case's own tape, which no drawn population of this size reaches by itself.
 */
const aimedCase = (o: OrderedCase, c: Case<PageFeature>): OrderedCase =>
	Option.exists(c.steering, (pending) =>
		pending.has("a traversal of at least 200 pages in one direction")
	)
		? c.draw(longOrderedCaseGen)
		: o

const printCase = (o: OrderedCase): string =>
	`order: rotate ${o.rotate}, stated ${o.stated}, ${Arr.join(
		Arr.map(o.dirs, (d) => (d ? "desc" : "asc")),
		" "
	)}${o.negativeZero ? ", relation parameters' float zeros passed as -0" : ""}\n${printQueryCase(o.c)}`

type Row = ReadonlyArray<string>

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
		order,
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
	literal: TypedLiteral
): { readonly value: unknown; readonly text: string } => {
	const codec = scalarCodec(type)
	const of = (value: unknown) => ({ value, text: codec.text(value) })
	const text = inputText(literal)
	const value = strictRead(type, text)
	if (Result.isSuccess(value)) {
		return of(value.success)
	}
	const decimal = codec.spec.carrier === "numeric" ? Decimal.fromString(text) : undefined
	const admitted = decimal?.ok === true ? admitValue(codec.spec, decimal.value) : undefined
	if (admitted?.ok === true) {
		return of(admitted.value)
	}
	throw new Error(`a generated literal its codec refuses: ${text}`)
}

/** Whether a literal is a float zero, which a caller may pass as -0. */
const isFloatZero = (literal: TypedLiteral): boolean =>
	literal.kind === "float" && literal.value === 0

/**
 * The case's parameters as a caller passes them: scalars as host values, relation parameters as arrays of facts, each
 * float zero among their rows as -0 where the case passes it so.
 */
const hostParams = (o: OrderedCase): Readonly<Record<string, unknown>> =>
	Rec.fromEntries(
		Arr.map(Rec.toEntries(o.c.query.params), ([name, p]) => {
			if (p.kind === "scalar") {
				return [name, callerInput(p.type, p.value).value]
			}
			return [
				name,
				Arr.map(p.rows, (row) =>
					Rec.fromEntries(
						Arr.map(p.heading, (h, i) => {
							const literal = defined(row[i], "parameter column")
							return [
								h.name,
								o.negativeZero && isFloatZero(literal) ? -0 : callerInput(h.type, literal).value
							]
						})
					)
				)
			]
		})
	)

/** A placeholder's text from the caller's parameter values, for D's conservative statements. */
const slotText = (c: QueryCase, slot: ConservativeStatement["params"][number]): string => {
	const p = c.query.params[slot.param]
	if (slot.kind === "scalar" && p?.kind === "scalar") {
		return callerInput(p.type, p.value).text
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
				return callerInput(type, defined(row[at], "column")).text
			})
		)
		const arrays = arrayTexts(
			String(slot.param),
			Arr.map(slot.columns, (col) => col.name),
			Arr.dedupeWith(texts, (x, y) => x.length === y.length && Arr.every(x, (t, i) => t === y[i])),
			textMaxLength
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

const run =
	(session: PgConnection) =>
	(sql: string, values: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<Row>, SqlError> =>
		Effect.map(session.queryValues(sql, values), textRows)

/**
 * Rows on `heading` as values: each cell its column type's canonical text (oracle/compare.ts canonicalCell), so two
 * spellings of one value, which two statements' deduplications may keep differently, read alike.
 */
const valueRows = (heading: Heading, rows: ReadonlyArray<Row>): ReadonlyArray<Row> => {
	const cells = Arr.map(heading, (c) => canonicalCell(c.type))
	return Arr.map(rows, (row) =>
		Arr.map(cells, (cell, i) => cell(defined(row[i], `column ${i} of a delivered row`)))
	)
}

/** The rows PostgreSQL returns, every column as text. */
const textRows = (rows: unknown): ReadonlyArray<Row> => trusted<ReadonlyArray<Row>>(rows)

class Skip extends Data.TaggedError("Skip")<{ readonly reason: string }> {}

interface Full {
	readonly rows: ReadonlyArray<Row>
	readonly attachments: ReadonlyArray<ReadonlyArray<Row>>
}

/**
 * D: the conservative lowering's delivery, each heading group sorted on the page order and the groups merged on it,
 * on the template's heading, as values (valueRows); and every attachment statement's rows over every delivered parent.
 */
const fullResult = (
	session: PgConnection,
	o: OrderedCase,
	query: LogicalQuery,
	template: PageTemplate,
	statements: ReadonlyArray<OptimizedStatement>
): Effect.Effect<Full, SqlError> =>
	Effect.gen(function* () {
		const specs = Arr.map(statements, (s, i) => {
			const spec = statementSpec(s, { kind: "unmetered" }, i, declaredSlotOf)
			if (!spec.ok) {
				throw new Error(spec.error.message)
			}
			return spec.value
		})
		const raws: Array<ReadonlyArray<Row>> = []
		for (const [i, statement] of statements.entries()) {
			const values = Arr.map(statement.params, (slot) => slotText(o.c, slot))
			const raw = yield* run(session)(defined(specs[i], "statement").sql, values)
			raws.push(raw)
		}
		const heading = template.heading
		const project = (spec: StatementSpec, row: Row): Row =>
			Arr.map(heading, (c) =>
				defined(
					row[
						Option.getOrThrowWith(
							Arr.findFirstIndex(spec.heading, (h) => h.name === c.name),
							() => new Error("a column the case's own heading holds")
						)
					],
					c.name
				)
			)
		const groups = Arr.flatMap(specs, (spec, i) =>
			spec.role === "attachment" ? [] : [{ spec, rows: raws[i] ?? [] }]
		)
		const attachments = Arr.flatMap(specs, (spec, i) =>
			spec.role === "attachment" ? [raws[i] ?? []] : []
		)
		const types: Record<string, Heading[number]["type"]> = {}
		for (const c of heading) {
			types[c.name] = c.type
		}
		const compare = mergeComparator({ order: template.order, types })
		if (!compare.ok) {
			throw new Error(compare.error.message)
		}
		const rootNode = query.dag.roots[0]
		if (rootNode.kind !== "OrderedResult") {
			throw new Error("an ordered result")
		}
		const rootOrder = rootNode.order
		const compareRoot = mergeComparator({ order: rootOrder, types })
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
					row: project(g.spec, row),
					value: headingRecord(g.spec.heading)(row)
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
			if (compareRoot.value(a.value, b.value) !== 0) {
				throw new PropertyFailed({
					report: `two delivered rows tie on the page order ${Formatter.format(template.order.keys)} but not on every common column\n${printCase(o)}`
				})
			}
			if (groups.length > 1) {
				throw new Skip({ reason: "heading groups tie on every common column" })
			}
			throw new PropertyFailed({
				report: `two delivered rows tie on every column\n${printCase(o)}`
			})
		}
		return {
			rows: valueRows(
				heading,
				Arr.map(merged, (m) => m.row.row)
			),
			attachments
		}
	})

/**
 * One request through the runtime minus its transaction: the token validated and decoded, the page run on the borrowed
 * session, and its cursors made from the decoded edges (packages/grizzle/src/adapter/page/page.ts).
 */
interface Paged {
	readonly page: Page<unknown, unknown>
	readonly rows: PageRows
	/** The delivered rows on the template's heading, in presentation order, as values (valueRows). */
	readonly delivered: ReadonlyArray<Row>
	/** Every attachment statement of the request's program, in statement order. */
	readonly attached: ReadonlyArray<Attached>
}

/**
 * One attachment statement of one page: the parent key texts its parent delivered on this page (the page's delivered
 * rows of a rows statement, or every row of a parent attachment), and the rows it read, each leading with its parent
 * key.
 */
interface Attached {
	readonly width: number
	readonly parents: ReadonlyArray<string>
	readonly rows: ReadonlyArray<Row>
	/**
	 * The parent keys of the page's first and last edges, when the attachment's parent is the rows statement that
	 * delivered them.
	 */
	readonly head: string | undefined
	readonly tail: string | undefined
}

/** The parent key text of an attachment row, or of a parent row, at the key's positions. */
const keyText = (row: Row, positions: ReadonlyArray<number>): string =>
	Formatter.format(Arr.map(positions, (p) => row[p]))
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
 * Runs a page's flight on the test's session, inside the transaction the test holds open there: its statements one at a
 * time, every column delivered as text.
 */
const flightOn =
	(session: PgConnection) =>
	<A>(flight: Flight<A, UnreadableAnswer>): Effect.Effect<A, ReadError> =>
		Effect.flatMap(
			Effect.forEach(flight.statements, (statement) =>
				Effect.mapBoth(session.queryValues(statementSql(statement), statement.params), {
					onFailure: readFailureOf,
					onSuccess: (rows): BatchOutcome => ({
						command: "SELECT",
						rows: Arr.map(rows, (row) => Arr.map(row, textCell))
					})
				})
			),
			(outcomes) => Effect.mapError(flight.read(outcomes), (reason) => new ReadFailure({ reason }))
		)

/** One page request as a caller makes it: from an end, or from a cursor token of an earlier page. */
type PageRequest =
	| { readonly variant: "first" | "last"; readonly size: number }
	| { readonly variant: "after" | "before"; readonly size: number; readonly token: string }

/**
 * Every attachment runs, in the rows statement's flight: one with no parent row on this page reads none.
 *
 * The rows statements, every attachment, and the probe of an anchored request only.
 */
const pager =
	(
		runtime: PageRuntime,
		artifact: PageArtifactName,
		send: <A>(flight: Flight<A, UnreadableAnswer>) => Effect.Effect<A, ReadError>,
		params: Readonly<Record<string, unknown>>
	) =>
	(request: PageRequest): Effect.Effect<Paged, ReadError | CursorError> =>
		Effect.gen(function* () {
			const variant = request.variant
			const inputs = yield* Effect.fromResult(
				Result.mapError(
					executionInputs(paramCodecs(runtime.params), params),
					(reason) => new ReadFailure({ reason })
				)
			)
			const call: PageCall =
				"token" in request
					? {
							variant: request.variant,
							size: request.size,
							boundary: (yield* fromEngine(runtime.codec.decode(request.token))).texts
						}
					: { variant: request.variant, size: request.size }
			const rows = yield* Effect.flatMap(
				Effect.mapError(
					pageFlight(runtime, artifact, inputs, call),
					(reason) => new ReadFailure({ reason })
				),
				send
			)
			/** The page's nodes, which this suite compares by their texts, read as their Rows. */
			const page = yield* Effect.fromResult(pageOf(runtime, rows, (row) => row))
			const records = runtime.artifacts[artifact].requests[variant].records
			const delivered = valueRows(
				runtime.page.heading,
				Arr.map(rows.edges, (e) => {
					const heading = e.statement.run.statement.heading
					return Arr.map(runtime.page.heading, (c) =>
						defined(
							e.raw[
								Option.getOrThrowWith(
									Arr.findFirstIndex(heading, (h) => h.name === c.name),
									() => new Error("a column the case's own heading holds")
								)
							],
							c.name
						)
					)
				})
			)
			const attached: Array<Attached> = []
			let expected = Option.isSome(rows.probe) ? 1 : 0
			const parents = new Map(
				Arr.flatMap(records, (r) => Arr.map(r.plan.children, (c) => [c.record, r] as const))
			)
			for (const record of records) {
				const statement = record.run.statement
				const parentRecord = parents.get(record)
				if (parentRecord === undefined) {
					expected++
					continue
				}
				const parentKey = keyColumns(statement.role)
				const parent = parentRecord.run.statement
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
						? (rows.attachments.get(parentRecord) ?? [])
						: Arr.map(
								Arr.filter(rows.edges, (e) => e.statement === parentRecord),
								(e) => e.raw
							)
				expected++
				const edgeKey = (edge: PageRows["edges"][number] | undefined): string | undefined =>
					edge?.statement === parentRecord ? keyText(edge.raw, positions) : undefined
				attached.push({
					width: parentKey.length,
					parents: Arr.map(parentRows, (row) => keyText(row, positions)),
					rows: rows.attachments.get(record) ?? [],
					head: edgeKey(rows.edges[0]),
					tail: edgeKey(rows.edges[rows.edges.length - 1])
				})
			}
			assert.equal(
				Option.isSome(rows.probe),
				variant === "after" || variant === "before",
				`${variant} probe`
			)
			assert.equal(rows.statements, expected, `${variant} statements`)
			return { page, rows, delivered, attached }
		})

/**
 * Each attachment of each page reads exactly its delivered parents' children: every row it read belongs
 * to a parent delivered on that page, never to the dropped lookahead row or a row of another page, and each delivered
 * parent's children are exactly D's children of that parent key, with no duplicate and no omission. The attachment
 * statement keeps each (parent key, child) once (shapes/attach pipelinedAttachment), so a parent key's children are
 * the same multiset on a page as in D's attachment statement.
 */
const checkAttachments = (label: string, p: Paged, full: Full): void => {
	for (const [a, attached] of p.attached.entries()) {
		const all = full.attachments[a]
		if (all === undefined) {
			throw new PropertyFailed({ report: `${label}: no attachment ${a} in D` })
		}
		const keyed = (rows: ReadonlyArray<Row>): Map<string, Array<string>> => {
			const out = new Map<string, Array<string>>()
			for (const row of rows) {
				const key = keyText(row, leading(attached.width))
				const group = out.get(key)
				if (group === undefined) {
					out.set(key, [Formatter.format(row)])
				} else {
					group.push(Formatter.format(row))
				}
			}
			return out
		}
		const parents = new Set(attached.parents)
		const page = keyed(attached.rows)
		const d = keyed(all)
		for (const key of page.keys()) {
			assert.ok(
				parents.has(key),
				`${label} attachment ${a}: a child of ${key}, a parent this page did not deliver`
			)
		}
		for (const key of parents) {
			assert.deepEqual(
				Arr.sort([...(page.get(key) ?? [])], Order.String),
				Arr.sort([...(d.get(key) ?? [])], Order.String),
				`${label} attachment ${a}: the children of ${key}`
			)
		}
	}
}

/**
 * A forward and a backward traversal, each once at its drawn size, and the empty-page rules.
 *
 * Whether checkAttachments could see the dropped lookahead row's children leak onto a page: the row after a
 * forward page, the next page's first edge, or before a backward page, the previous page's last edge, is a
 * parent with children in D that the page did not deliver.
 */
const checkRuntime = (
	label: string,
	page: ReturnType<typeof pager>,
	full: Full,
	note: Case<PageFeature>["note"],
	sizes: { readonly forward: PageSize; readonly backward: PageSize }
): Effect.Effect<void, ReadError | CursorError> =>
	Effect.gen(function* () {
		const total = full.rows.length
		for (const direction of ["forward", "backward"] as const) {
			const size = sizes[direction]
			const pages: Array<Paged> = []
			let next: Paged = yield* page({ variant: direction === "forward" ? "first" : "last", size })
			for (;;) {
				pages.push(next)
				const info = next.page.pageInfo
				const more = direction === "forward" ? info.hasNextPage : info.hasPreviousPage
				const cursor = direction === "forward" ? info.endCursor : info.startCursor
				if (!more || Option.isNone(cursor)) {
					break
				}
				if (pages.length > total + 2) {
					throw new PropertyFailed({ report: `${label}: a traversal that does not end` })
				}
				next = yield* page({
					variant: direction === "forward" ? "after" : "before",
					size,
					token: cursor.value
				})
			}
			if (pages.length >= longTraversal) {
				note("a traversal of at least 200 pages in one direction")
			}
			const ordered = direction === "forward" ? pages : Arr.reverse(pages)
			const delivered: ReadonlyArray<Row> = Arr.flatMap(ordered, (p) => p.delivered)
			assert.deepEqual(delivered, full.rows, `${label} ${direction} ${size}`)
			let offset = 0
			for (const [k, p] of ordered.entries()) {
				const start = offset
				offset += p.delivered.length
				assert.equal(
					p.page.pageInfo.hasPreviousPage,
					start > 0,
					`${label} ${direction} ${size} page ${k} previous`
				)
				assert.equal(
					p.page.pageInfo.hasNextPage,
					offset < total,
					`${label} ${direction} ${size} page ${k} next`
				)
				assert.equal(p.page.edges.length, p.delivered.length)
				checkAttachments(`${label} ${direction} ${size} page ${k}`, p, full)
			}
			for (let k = 1; k < ordered.length; k++) {
				const prev = defined(ordered[k - 1], "page")
				const cur = defined(ordered[k], "page")
				const [fetched, lookahead] =
					direction === "forward"
						? [prev, Arr.map(cur.attached, (x) => x.head)]
						: [cur, Arr.map(prev.attached, (x) => x.tail)]
				for (const [a, x] of fetched.attached.entries()) {
					const key = lookahead[a]
					if (
						key !== undefined &&
						!x.parents.includes(key) &&
						Arr.some(full.attachments[a] ?? [], (row) => keyText(row, leading(x.width)) === key)
					) {
						note("lookahead parent with children")
					}
				}
			}
			note(`page size ${size}`)
		}
		const first = yield* page({ variant: "first", size: 1 })
		const last = yield* page({ variant: "last", size: 1 })
		const start = first.page.pageInfo.startCursor
		const end = last.page.pageInfo.endCursor
		if (Option.isSome(start) && Option.isSome(end)) {
			const pastEnd = yield* page({ variant: "after", size: 2, token: end.value })
			assert.deepEqual(
				[
					pastEnd.delivered,
					pastEnd.page.pageInfo.hasPreviousPage,
					pastEnd.page.pageInfo.hasNextPage
				],
				[[], true, false],
				`${label} past the end`
			)
			const beforeStart = yield* page({ variant: "before", size: 2, token: start.value })
			assert.deepEqual(
				[
					beforeStart.delivered,
					beforeStart.page.pageInfo.hasPreviousPage,
					beforeStart.page.pageInfo.hasNextPage
				],
				[[], false, true],
				`${label} before the start`
			)
		} else {
			assert.equal(total, 0, `${label}: no edge only for an empty D`)
			for (const p of [first, last]) {
				assert.deepEqual(
					[p.delivered, p.page.pageInfo.hasPreviousPage, p.page.pageInfo.hasNextPage],
					[[], false, false],
					`${label} empty D`
				)
			}
		}
	})

/**
 * What a case reached besides its skip and its relation parameters: its query's node kinds, its template's
 * shapes and its D. A distinct is read from the statements' ASTs, never their text.
 */
const coverage = (
	query: LogicalQuery,
	template: PageTemplate,
	full: Full,
	note: Case<PageFeature>["note"]
): void => {
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
	if (template.conservative.requests.first.delivery.kind === "headingGroups") {
		note("heading groups")
	}
	if (
		Arr.some(flight(template.optimized.requests.first.roots), (s) => s.role.kind === "attachment")
	) {
		note("attachments")
	}
	if (Arr.some(flight(template.optimized.requests.first.roots), (s) => s.forms.kind === "chosen")) {
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
			flight(template.optimized.requests.after.roots),
			(s) => has(shapeOf(s.ast), "distinct") || has(shapeOf(s.ast), "distinct on")
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
 * The suite over one artifact: test/pg/page/generated-optimized.test.ts and generated-conservative.test.ts each run it
 * as a CPU-bound job of its own, on the same cases.
 *
 * The page runtime on generated ordered queries.
 *
 * Each oracle case (test/support/oracle/gen: plain, attached and heterogeneous-union roots over matches,
 * filters, projections, semi- and anti-joins, unions, intersections, differences, groups, takes and recursive
 * closures) is ordered by a drawn prefix of its result heading, rotated, each direction drawn. Its page template is the
 * page compiler's, and its runtime template (packages/grizzle/src/adapter/page/template.ts pageRuntimeOf) adds the specs and the cursor
 * codec. The case installs with the real installer in a transaction that is rolled back, and every page reads that one
 * snapshot. Every request goes through the runtime as a reader's does, minus the transaction: the request's token is
 * validated and decoded by the cursor codec (codec/cursor), the request runs (k + 1 rows, the
 * heading-group merge, the lookahead, the backward reversal, the attachments over the delivered page, the probe), and
 * the page's cursors are made from the decoded edges by pageOf, so the next request continues from a real token. Then:
 *
 * - forward pages from { first } and backward pages from { last }, at one page size per direction, drawn per case,
 *   every size 1 through 7 over the run, concatenate to the complete sorted distinct conservative result D
 *   (fullResult, as the lowering suite computes it), on the template's heading as raw result texts;
 * - every page's flags are exact, and so are the inclusive rules of an empty page after the last edge, before the
 *   first, and of an empty D;
 * - each page's attachments read its delivered parents only: every attachment row a page read belongs
 *   to a parent it delivered, never to the lookahead row, and each delivered parent's children are exactly D's
 *   children of that key; every attachment statement goes in the page's one flight, which the page's statement count
 *   confirms.
 *
 * Both artifacts run, each in a file of its own on the same cases: the optimized one, which the runtime selects in a
 * matching context (generated-optimized.test.ts), and the conservative one, which it selects in a weaker context
 * (generated-conservative.test.ts; program/context.ts). A heterogeneous union whose common
 * columns hold no proved key is refused by the page compiler and skipped, as are the other rare skips
 * the lowering suite names. Every case notes what it reached (PageFeature), a skip its reason (PageSkip), and the
 * population must reach every required feature, among them a per-execution form, a relation parameter holding a
 * float -0, which the runtime passes as the caller's one zero, and a traversal of at least 200 pages.
 *
 * A case whose traversal at its drawn sizes would take more requests than fit in half its hang bound is skipped, its
 * D, sizes and request count logged; such skips may be at most 5% of the run's cases, or the generator has drifted and
 * the run fails.
 */
export const generatedSuite = (artifact: PageArtifactName): void => {
	/**
	 * The run's cases and those the request bound skipped, for the skip share; a passing run executes each drawn case
	 * once and shrinks nothing, so the counts are its cases.
	 *
	 * The order refusal is located at the caller's orderBy, never at the node the order completes over.
	 *
	 * A ROLLBACK that fails leaves the pinned session in a transaction: a defect of the case, never ignored.
	 *
	 * This file's artifact only: its sibling file runs the other on the same cases.
	 *
	 * Noted only once the case pages: a skipped case never read its -0.
	 */
	const runCase = (
		o: OrderedCase,
		schema: string,
		c: Case<PageFeature>,
		ctx: TestContext,
		share: { cases: number; overBound: number }
	) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			share.cases++
			const ordered = orderedQuery(o)
			if (ordered === undefined) {
				c.note("skipped: unordered column")
				return
			}
			const query = ordered.query
			const desc = schemaDesc(o.c.schema)
			const planned = oraclePlan(desc, identity.schema(parsedSchemaName(schema)), s.owner.role)
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
			const facts = factStatements(plan, factSet(stored))
			if (!facts.ok) {
				return yield* Effect.die(new Error(facts.error.message))
			}
			const names = plan.installation.names
			const conservative = lowerConservative(conservativeInput(query), {
				names,
				params: query.params,
				subject: { kind: "query" },
				meter: new BudgetMeter(compileBudgets)
			})
			if (!conservative.ok) {
				c.note("skipped: baseline refuses")
				return
			}
			const catalog = genCatalog(o.c.schema)
			const optimized = lowerOptimized(query, {
				names,
				context: "snapshot",
				catalog,
				subject: { kind: "query" },
				meter: new BudgetMeter(compileBudgets)
			})
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
			const page = compilePage({
				checked: query,
				optimized: optimized.value,
				names,
				stated: { keys: ordered.stated, at: statedAt }
			})
			if (
				!page.ok &&
				page.error.reason._tag === "UnsupportedOperation" &&
				formatLoc(refusalLoc(page.error)) === formatLoc(statedAt)
			) {
				c.note("skipped: union without a common key")
				return
			}
			if (!page.ok) {
				return yield* new PropertyFailed({
					report: `page compiler: ${page.error.message}\n${printCase(o)}`
				})
			}
			const template = page.value
			const labelled = nodesByLabel(query.dag)
			const runtime = pageRuntimeOf({
				page: template,
				params: query.params,
				query: `generated ${Formatter.format(ordered.stated)} ${o.c.query.dag.roots[0].id}`,
				generation: { schema: schema, extensions: {} },
				/**
				 * The conservative claims of the checked DAG, which are sound (reader/analysis.ts): each attachment
				 * delivered as its Attach node states, and every child column carried.
				 */
				facts: {
					delivered: (attach) => {
						const node = labelled.get(attach)
						if (node?.kind !== "Attach") {
							throw new Error(`the delivery of ${attach}, no Attach node of the checked DAG`)
						}
						return node.delivered
					},
					root: { under: new Map() },
					carried: () => true
				}
			})
			if (Result.isFailure(runtime)) {
				return yield* new PropertyFailed({
					report: `page runtime template: ${runtime.failure.message}\n${printCase(o)}`
				})
			}
			const params = hostParams(o)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const session = yield* s.admin.pin
					yield* session.query("BEGIN", [])
					yield* Effect.addFinalizer(() => Effect.orDie(session.query("ROLLBACK", [])))
					yield* session.query("SET LOCAL statement_timeout = '30s'", [])
					for (const sql of plan.sql) {
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
					const full = yield* fullResult(
						session,
						o,
						query,
						template,
						flight(deliveredAsOptimized(conservative.value).roots)
					).pipe(
						Effect.catchDefect((defect) =>
							defect instanceof Skip ? Effect.void : Effect.die(defect)
						)
					)
					if (full === undefined) {
						c.note("skipped: heading groups tie")
						return
					}
					const sizes = o.size
					/** One request per page of each traversal, an empty D's traversal being one page. */
					const cost =
						Math.max(1, Math.ceil(full.rows.length / sizes.forward)) +
						Math.max(1, Math.ceil(full.rows.length / sizes.backward))
					if (cost > requestBound) {
						share.overBound++
						yield* Effect.promise(() =>
							ctx.annotate(
								`skipped over the request bound ${requestBound}: |D| ${full.rows.length}, sizes ${sizes.forward} forward and ${sizes.backward} backward, ${cost} requests`
							)
						)
						c.note("skipped: traversal over the request bound")
						return
					}
					yield* checkRuntime(
						artifact,
						pager(runtime.success, artifact, flightOn(session), params),
						full,
						c.note,
						sizes
					)
					coverage(query, template, full, c.note)
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
			Effect.catchTag(["ReadFailure", "CursorError"], (e) =>
				Effect.fail(
					new PropertyFailed({ report: `${e._tag}: ${Formatter.format(e)}\n${printCase(o)}` })
				)
			)
		)

	layer(Substrate.layer)(
		`the page runtime on generated ordered queries, ${artifact} artifact`,
		(it) => {
			it.effect(
				"pages generated ordered queries through the runtime at a drawn size per direction, flags exact",
				(ctx) =>
					searched(
						ctx,
						Effect.gen(function* () {
							const s = yield* Substrate
							const schema = yield* s.schema({ create: false, label: "page_rt" })
							const share = { cases: 0, overBound: 0 }
							const explored = yield* oracleCheck(
								drawn(orderedCaseGen),
								{
									suite: `page/generated-${artifact}`,
									literal: Formatter.format,
									coverage: required<PageFeature>(situations, { cases: 2_000, sense: notesOnly }),
									kept: [],
									/** The suite's stated population. */
									runs: 2_000,
									shrink: completeShrink,
									caseHang,
									perturb: "all"
								},
								(o, c) => runCase(aimedCase(o, c), schema, c, ctx, share)
							)
							assert.ok(
								share.overBound <= boundSkipShare * share.cases,
								`${share.overBound} of ${share.cases} cases over the request bound ${requestBound}`
							)
							return explored
						})
					),
				3_600_000
			)
		}
	)
}
