import { exact, ordered } from "@grizzle/testing/oracle"
import { Array as Arr, Data, Effect, Formatter, Option, Order, Record as Rec, Result } from "effect"
import { decodePlan } from "#adapter/explain/plan.ts"
import { type PlanLabel, planEdges, planNodeTypes } from "#bench/harness/explain.ts"
import { resultTextCasts } from "#compiler/codec/scalar.ts"
import { appendAll } from "#compiler/core/array.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { ParamId } from "#compiler/core/ids.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import * as Engine from "#compiler/core/result.ts"
import type { Certificate } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { nativeEqualityKey, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { LogicalQuery, ParamDecl } from "#compiler/ir/products.ts"
import type { Heading, NodeOf, RelDag, RelNode } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { checkerEvidence } from "#compiler/logical/annotate.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import {
	conservativeInput,
	type ConservativeParamSlot,
	type ConservativeProgram,
	flight,
	keyColumns,
	type StatementRoots,
	statementOutput
} from "#compiler/lower/conservative/types.ts"

import {
	lowerOptimized,
	type OptimizedProgram,
	optimizedInput
} from "#compiler/lower/optimize/pipeline.ts"
import { type FusedAttachment, fusedElement } from "#compiler/lower/shapes/attach/decode.ts"
import {
	deliveredAsOptimized,
	type FusedStatement,
	type OptimizedStatement
} from "#compiler/lower/shapes/index.ts"

import { canonicalTextOf, type Json } from "#compiler/core/canonical.ts"
import { jsonText, trusted, trustedJson } from "#compiler/core/trusted.ts"
import { explainOf } from "#compiler/sql/emit.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { installedCatalog } from "#test/support/evidence.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { strictArrayText } from "#test/support/kernel/strict.ts"
import { messageOf } from "#test/support/message.ts"
import {
	canonicalRows,
	type Comparison,
	compareRuns,
	printComparison,
	printRun,
	rawRowKey,
	type Run,
	type Labeled,
	labeledStatements,
	type StatementRows
} from "#test/support/oracle/compare.ts"
import { largeFormPrograms } from "#test/support/oracle/forms.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { printQueryCase } from "#test/support/oracle/gen/print.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import { schemaDesc } from "#test/support/oracle/gen/schema.ts"
import { arrayCasts, captureRows, type RawRow } from "#test/support/oracle/install/capture.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { oraclePlan, type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import {
	CurrentPerturbation,
	multiplyFacts,
	plannerStatements
} from "#test/support/oracle/perturb.ts"
import {
	factSet,
	type Lowering,
	printOracleCase,
	PropertyFailed,
	slotValue,
	sqlMessage
} from "#test/support/oracle/runner.ts"
import { fusedHeading } from "#test/support/oracle/verify/channels.ts"
import { loweringViolations } from "#test/support/oracle/verify/index.ts"
import { typeProblems } from "#test/support/oracle/verify/types.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

class DifferentialFailure extends Data.TaggedError("DifferentialFailure")<{
	readonly stage: "plan" | "lower" | "verify" | "types" | "execute" | "unfuse" | "explain"
	readonly side: string
	readonly message: string
}> {}

const failure = (stage: DifferentialFailure["stage"], side: string, message: string) =>
	new DifferentialFailure({ stage, side, message })

const compileMessage = (e: CompileError): string => e.message

/** Whether two arrays' elements are the same, position by position. */
const sameSequence = (a: ReadonlyArray<string | null>, b: ReadonlyArray<string | null>): boolean =>
	a.length === b.length && Arr.every(a, (v, i) => v === b[i])

/** The cell of a raw row at a position the caller has in range. */
const cellAt = (row: RawRow, i: number, what: string): string => {
	const cell = row[i]
	if (cell === undefined) {
		throw new Error(`${what}: a row has no column ${i}`)
	}
	return cell
}

/**
 * The parameters of a generated query as the checker would declare them (check/params.ts): a scalar by its name with
 * its one column, a relation parameter by its heading.
 */
const paramDecls = (c: QueryCase): ReadonlyArray<ParamDecl> =>
	Arr.map(Rec.toEntries(c.query.params), ([id, p]: [string, GenParam]): ParamDecl =>
		p.kind === "scalar"
			? { id: ParamId(id), name: id, kind: "scalar", type: p.type }
			: { id: ParamId(id), name: id, kind: "relation", heading: p.heading }
	)

/** The case's query as a checked LogicalQuery. */
const logicalQuery = (c: QueryCase): LogicalQuery => ({
	dag: c.query.dag,
	params: paramDecls(c)
})

/** Entries by their key. */
const byKey: Order.Order<readonly [string, unknown]> = Order.mapInput(
	Order.String,
	(entry: readonly [string, unknown]) => entry[0]
)

/**
 * The case with every relation parameter normalized as the runtime sends it: each fact once under
 * native equality, the first spelling kept (the generator stores one spelling per value class, gen/domain.ts), in a
 * canonical order.
 */
const normalizedCase = <C extends QueryCase>(c: C): C => {
	const params: Record<string, GenParam> = {}
	let changed = false
	for (const [id, p] of Rec.toEntries(c.query.params)) {
		if (p.kind !== "relation") {
			params[id] = p
			continue
		}
		const seen = new Map<string, ReadonlyArray<TypedLiteral>>(
			Arr.dedupeWith(
				Arr.map(
					p.rows,
					(row) =>
						[
							Arr.join(
								Arr.map(row, (v) => nativeEqualityKey(v)),
								"\u0000"
							),
							row
						] as const
				),
				([a], [b]) => a === b
			)
		)
		const rows = Arr.map(Arr.sort(seen.entries(), byKey), ([, row]) => row)
		if (rows.length !== p.rows.length) {
			changed = true
		}
		params[id] = { ...p, rows }
	}
	return changed ? { ...c, query: { ...c.query, params } } : c
}

/** One executed program: each statement's raw rows, fused columns included, in delivery order. */
export interface Executed {
	readonly statements: ReadonlyArray<Labeled<OptimizedStatement>>
	readonly rows: ReadonlyArray<ReadonlyArray<RawRow>>
}

/** The values of a statement's placeholders, each filled by `fill`. */
const placeholders = (
	statement: OptimizedStatement,
	i: number,
	name: string,
	fill: (slot: ConservativeParamSlot) => string | undefined
): Effect.Effect<ReadonlyArray<string>, DifferentialFailure> => {
	const params: Array<string> = []
	for (const slot of statement.params) {
		const value = fill(slot)
		if (value === undefined) {
			return Effect.fail(
				failure("execute", name, `statement ${i}: no value for a ${slot.kind} placeholder`)
			)
		}
		params.push(value)
	}
	return Effect.succeed(params)
}

/** Runs a program's statements in order, each placeholder filled by `fill`. */
export const executeStatements = (
	session: PgConnection,
	roots: StatementRoots<OptimizedStatement>,
	name: string,
	fill: (slot: ConservativeParamSlot) => string | undefined
): Effect.Effect<Executed, DifferentialFailure> =>
	Effect.gen(function* () {
		const statements = labeledStatements(roots)
		const ran: Array<ReadonlyArray<RawRow>> = []
		for (const [i, { statement }] of statements.entries()) {
			const params = yield* placeholders(statement, i, name, fill)
			const output = statementOutput(statement.role, statement.heading, statement.fused)
			const columns = [
				...Arr.map(output.heading, (h) => resultTextCasts(h.type)),
				...Arr.map(output.fused, () => arrayCasts)
			]
			const rows = yield* captureRows(session, statement.sql.text, params, columns).pipe(
				Effect.mapError((e) =>
					failure("execute", name, `statement ${i}: ${sqlMessage(e)}\n${statement.sql.text}`)
				)
			)
			ran.push(rows)
		}
		return { statements, rows: ran }
	})

/** A plan node's label: its type, with the join type or aggregate strategy that refines it. */
const labelText = (label: PlanLabel): string =>
	Arr.join(
		[label.nodeType, ...Option.toArray(label.joinType), ...Option.toArray(label.strategy)],
		" "
	)

/** A statement's plan as a case notes it: its node types, and each node's label under its parent's. */
export interface PlanShape {
	readonly nodes: ReadonlyArray<string>
	readonly edges: ReadonlyArray<{ readonly parent: string; readonly child: string }>
}

/**
 * The EXPLAIN cell as grizzle's own driver hands it to db.explain: json text. The test client parses json columns, so
 * the plan is spelled back as text before the runtime's reader sees it.
 */
const asDriverText = (cell: unknown): string => jsonText(trusted<Json>(cell))

/**
 * The plan PostgreSQL chooses for each of `statements`, under the settings and with the parameter values the statements
 * run with, planned as db.explain plans a statement: its own EXPLAIN statement (sql/emit.ts explainOf),
 * estimate-only, sent as a statement of its own, whose one cell db.explain's decoder reads as a Plan
 * and the plan readers read as node types and edges (bench/harness/explain.ts planNodeTypes and planEdges). A
 * statement PostgreSQL refuses to plan, or a plan db.explain does not decode, fails the case.
 */
const explainStatements = (
	session: PgConnection,
	statements: ReadonlyArray<OptimizedStatement>,
	name: string,
	fill: (slot: ConservativeParamSlot) => string | undefined
): Effect.Effect<ReadonlyArray<PlanShape>, DifferentialFailure> =>
	Effect.gen(function* () {
		const plans: Array<PlanShape> = []
		for (const [i, statement] of statements.entries()) {
			const params = yield* placeholders(statement, i, name, fill)
			const rows = yield* session
				.queryValues(explainOf(statement.sql.text), params)
				.pipe(
					Effect.mapError((e) =>
						failure("explain", name, `statement ${i}: ${sqlMessage(e)}\n${statement.sql.text}`)
					)
				)
			const [row, ...more] = rows
			if (row === undefined || more.length > 0 || row.length !== 1) {
				return yield* failure(
					"explain",
					name,
					`statement ${i}: EXPLAIN returned ${rows.length} rows, not one row of one column`
				)
			}
			const [cell] = row
			const plan = decodePlan(asDriverText(cell))
			if (Result.isFailure(plan)) {
				return yield* failure("explain", name, `statement ${i}: ${plan.failure}`)
			}
			plans.push({
				nodes: planNodeTypes(cell),
				edges: Arr.map(planEdges(cell), (e) => ({
					parent: labelText(e.parent),
					child: labelText(e.child)
				}))
			})
		}
		return plans
	})

const execute = (
	session: PgConnection,
	c: QueryCase,
	roots: StatementRoots<OptimizedStatement>,
	name: string
): Effect.Effect<Executed, DifferentialFailure> =>
	executeStatements(session, roots, name, (slot) => slotValue(c, slot))

/**
 * A fused attachment's Attach node, read from the program's own DAG, and the child columns its array carries and those
 * the parent row supplies (attach/index.ts fusedLayout).
 */
const layoutOf = (dag: RelDag, f: FusedAttachment) =>
	Option.map(
		Arr.findFirst(
			topoOrder(dag),
			(n): n is NodeOf<"Attach"> => n.kind === "Attach" && n.id === f.attach
		),
		(attach) => {
			const correlated = Arr.flatMap(f.layout.columns, (c) =>
				c.source.from === "parent" ? [{ parent: c.source.parent, child: c.column.name }] : []
			)
			return { attach, layout: { element: fusedElement(f.layout), correlated } }
		}
	)

const unitColumn = "__unit"

/**
 * The child rows one fused array text delivers for one parent row: each child heading column from the element (the
 * array's own text form) or from the parent row (a correlated column the array leaves out).
 */
const childRowsOf = (
	text: string,
	parentRow: RawRow,
	parentHeading: Heading,
	child: Heading,
	element: Heading,
	correlated: ReadonlyArray<{ readonly parent: string; readonly child: string }>
): Result.Result<ReadonlyArray<ReadonlyArray<string>>, string> => {
	const elements = strictArrayText(text)
	if (Result.isFailure(elements)) {
		return Result.fail(`a malformed array ${Formatter.format(text)}`)
	}
	const out: Array<ReadonlyArray<string>> = []
	const [only] = element
	for (const e of elements.success) {
		if (e === null) {
			return Result.fail("a NULL array element")
		}
		/**
		 * The element's values by column: an existence element is `true` for the unit column, a one-column element is
		 * its column's text, and a wider element is a JSON object whose f1..fn are the columns' texts.
		 */
		let values: ReadonlyMap<string, string>
		if (element.length === 0) {
			if (e !== "true") {
				return Result.fail(`an existence element ${Formatter.format(e)}`)
			}
			values = new Map([[unitColumn, e]])
		} else if (element.length === 1 && only !== undefined) {
			values = new Map([[only.name, e]])
		} else {
			const object = trustedJson<Readonly<Record<string, string>>>(e)
			if (Rec.keys(object).length !== element.length) {
				return Result.fail(`a JSON element of another width ${Formatter.format(e)}`)
			}
			const m = new Map<string, string>()
			for (const [i, col] of element.entries()) {
				const cell = object[`f${i + 1}`]
				if (cell === undefined) {
					return Result.fail(`a JSON element without f${i + 1} ${Formatter.format(e)}`)
				}
				m.set(col.name, cell)
			}
			values = m
		}
		const row = Result.all(
			Arr.map(child, (col) =>
				Option.match(
					Arr.findFirst(correlated, (k) => k.child === col.name),
					{
						onSome: (carried) =>
							Result.fromOption(
								Option.flatMap(
									Arr.findFirstIndex(parentHeading, (h) => h.name === carried.parent),
									(at) => Arr.get(parentRow, at)
								),
								() => `a correlated parent column ${carried.parent}`
							),
						onNone: () =>
							Result.fromNullishOr(
								values.get(col.name),
								() => `no element field for child column ${col.name}`
							)
					}
				)
			)
		)
		if (Result.isFailure(row)) {
			return Result.fail(row.failure)
		}
		out.push(row.success)
	}
	return Result.succeed(out)
}

/** One statement's rows as the comparison sees them, and the order checks of an ordered delivery. */
export interface Delivered {
	readonly run: Run
	/**
	 * For each statement label, the rows in delivery order, and for an ordered attachment the parent key prefix
	 * length under which the child sequence is judged.
	 */
	readonly sequences: ReadonlyMap<
		string,
		{ readonly rows: ReadonlyArray<RawRow>; readonly prefix: number }
	>
	readonly fusedAttachments: number
}

const columnTypes = (h: Heading): ReadonlyArray<ScalarType> => Arr.map(h, (c) => c.type)

/** A statement's rows in delivery order, and the parent key prefix under which an attachment's sequence is judged. */
/**
 * An ordered delivery's rows as values (compare.ts canonicalRows), in delivery order, and how many of its leading
 * columns are its parent's key: two spellings of one value are one value in an order too.
 */
type Sequence = { readonly rows: ReadonlyArray<RawRow>; readonly prefix: number }

/** A fused attachment's array for one distinct parent key tuple, and the first parent row carrying it. */
interface ParentArray {
	readonly key: ReadonlyArray<string>
	readonly text: string
	readonly row: RawRow
}

/** Array elements in text order, NULL first: sorting two arrays by it compares their elements in some order. */
const elementOrder: Order.Order<string | null> = Order.mapInput(
	Option.makeOrder(Order.String),
	(element: string | null) => Option.fromNullOr(element)
)

/** Whether two array texts hold the same elements in some order. */
const sameElements = (a: string, b: string): boolean => {
	const left = strictArrayText(a)
	const right = strictArrayText(b)
	return (
		Result.isSuccess(left) &&
		Result.isSuccess(right) &&
		sameSequence(Arr.sort(left.success, elementOrder), Arr.sort(right.success, elementOrder))
	)
}

/** One array per distinct parent key tuple; every parent row with that tuple carries the same array. */
const parentArrays = (
	raw: ReadonlyArray<RawRow>,
	parentAt: ReadonlyArray<number>,
	fusedAt: number,
	fusedLabel: string
): Result.Result<ReadonlyMap<string, ParentArray>, string> => {
	const arrays = new Map<string, ParentArray>()
	for (const row of raw) {
		const key = Arr.map(parentAt, (p) => cellAt(row, p, fusedLabel))
		const text = cellAt(row, fusedAt, fusedLabel)
		const id = rawRowKey(key)
		const seen = arrays.get(id)
		if (seen === undefined) {
			arrays.set(id, { key, text, row })
		} else if (seen.text !== text && !sameElements(seen.text, text)) {
			return Result.fail(
				`${fusedLabel}: parents with key ${Arr.join(key, ", ")} carry different arrays ${seen.text} and ${text}`
			)
		}
	}
	return Result.succeed(arrays)
}

/**
 * A fused attachment unfused into the rows of the attachment statement it replaces, each element column the text its
 * array carries, which is the column's result text (codec resultTextCasts), with its sequence when the attachment is
 * ordered.
 */
const unfused = (
	dag: RelDag,
	name: string,
	fusedLabel: string,
	heading: Heading,
	raw: ReadonlyArray<RawRow>,
	fusedAt: number,
	f: FusedAttachment
): Effect.Effect<
	{
		readonly statement: StatementRows
		readonly sequence: ReadonlyArray<readonly [string, Sequence]>
	},
	DifferentialFailure
> =>
	Effect.gen(function* () {
		const found = layoutOf(dag, f)
		if (Option.isNone(found)) {
			return yield* failure("unfuse", name, `${fusedLabel}: its Attach node`)
		}
		const { attach, layout } = found.value
		const child = fusedHeading(f)
		const parentFound = Option.all(
			Arr.map(f.parentColumns, (c) => Arr.findFirstIndex(heading, (h) => h.name === c))
		)
		if (Option.isNone(parentFound)) {
			return yield* failure(
				"unfuse",
				name,
				`${fusedLabel}: parent columns ${Arr.join(f.parentColumns, ", ")}`
			)
		}
		const parentAt = parentFound.value
		const arrays = parentArrays(raw, parentAt, fusedAt, fusedLabel)
		if (Result.isFailure(arrays)) {
			return yield* failure("unfuse", name, arrays.failure)
		}
		const rows: Array<Array<string>> = []
		for (const { key, text, row } of arrays.success.values()) {
			const children = childRowsOf(text, row, heading, child, layout.element, layout.correlated)
			if (Result.isFailure(children)) {
				return yield* failure("unfuse", name, `${fusedLabel}: ${children.failure}`)
			}
			appendAll(
				rows,
				Arr.map(children.success, (c) => [...key, ...c])
			)
		}
		const parentColumns: Array<Heading[number]> = []
		for (const p of parentAt) {
			const column = heading[p]
			if (column === undefined) {
				return yield* failure("unfuse", name, `${fusedLabel}: parent column ${p}`)
			}
			parentColumns.push(column)
		}
		const statement: StatementRows = {
			label: fusedLabel,
			columns: [...f.parentColumns, ...Arr.map(child, (h) => h.name)],
			types: [...columnTypes(parentColumns), ...columnTypes(child)],
			unstated: { kind: "none" },
			rows
		}
		return {
			statement,
			sequence:
				attach.order === undefined
					? []
					: [
							[
								fusedLabel,
								{ rows: canonicalRows(statement), prefix: f.parentColumns.length }
							] as const
						]
		}
	})

/**
 * An executed program as the conservative program's statements: every fused attachment unfused into the rows of the
 * attachment statement it replaces.
 */
export const delivered = (
	dag: RelDag,
	executed: Executed,
	name: string,
	isOrdered: boolean
): Effect.Effect<Delivered, DifferentialFailure> =>
	Effect.gen(function* () {
		const statements: Array<StatementRows> = []
		const sequences: Array<readonly [string, Sequence]> = []
		let fusedAttachments = 0
		for (const [i, { statement: s, label, attach }] of executed.statements.entries()) {
			const raw = executed.rows[i] ?? []
			const output = statementOutput(s.role, s.heading, s.fused)
			const heading = output.heading
			const width = heading.length
			const statement: StatementRows = {
				label,
				columns: Arr.map(heading, (h) => h.name),
				types: columnTypes(heading),
				unstated: { kind: "none" },
				rows: Arr.map(raw, (r) => r.slice(0, width))
			}
			statements.push(statement)
			if (attach?.order !== undefined) {
				sequences.push([
					label,
					{ rows: canonicalRows(statement), prefix: keyColumns(s.role).length }
				])
			} else if (isOrdered && s.role.kind === "main") {
				sequences.push([label, { rows: canonicalRows(statement), prefix: 0 }])
			}
			for (const [k, f] of s.fused.entries()) {
				fusedAttachments++
				const fusedLabel = `${label}/${f.name}`
				const u = yield* unfused(dag, name, fusedLabel, heading, raw, output.fusedAt(k), f)
				statements.push(u.statement)
				appendAll(sequences, u.sequence)
			}
		}
		return { run: { name, statements }, sequences: new Map(sequences), fusedAttachments }
	})

/**
 * The order problems of an optimized delivery against the conservative one: an ordered statement delivers the same
 * sequence, and an ordered attachment the same child sequence under each parent key. Both orders are the query's completed total order over a set, so the sequences are determined.
 */
export const orderProblems = (
	conservative: Delivered,
	optimized: Delivered
): ReadonlyArray<string> => {
	const out: Array<string> = []
	for (const [label, l] of conservative.sequences) {
		const r = optimized.sequences.get(label)
		if (r === undefined) {
			out.push(`${label}: ${optimized.run.name} delivers it unordered`)
			continue
		}
		const groups = (rows: ReadonlyArray<RawRow>): ReadonlyMap<string, ReadonlyArray<string>> => {
			const m = new Map<string, Array<string>>()
			for (const row of rows) {
				const key = canonicalTextOf(row.slice(0, l.prefix))
				const list = m.get(key) ?? []
				list.push(canonicalTextOf(row))
				m.set(key, list)
			}
			return m
		}
		const a = groups(l.rows)
		const b = groups(r.rows)
		appendAll(
			out,
			Arr.flatMap([...a], ([key, seq]) => {
				const other = b.get(key) ?? []
				return Option.isNone(ordered(exact)(seq, other))
					? []
					: [
							`${label}${l.prefix > 0 ? ` under parent ${key}` : ""}: order ${Arr.join(seq, " ")} against ${Arr.join(other, " ")}`
						]
			})
		)
	}
	return out
}

/** The optimized artifact is compiled for `snapshot` against the installation's own catalog. */
export interface DifferentialOptions {
	/** The PostgreSQL schema the case installs under; every case is rolled back, so one name serves a whole test. */
	readonly schema: string
	/**
	 * Further lowerings (mutants of the conservative lowering) run on the same installation and facts and compared
	 * with the conservative run.
	 */
	readonly others: ReadonlyArray<Lowering>
}

/** The plain differential: no other lowering. */
export const plainDifferential: Omit<DifferentialOptions, "schema"> = { others: [] }

/** An optimized form that runs: the default program, or the per-execution variant of one statement. */
export type OptimizedForm =
	| { readonly kind: "optimized" }
	| { readonly kind: "optimized variant"; readonly statement: number }

/** A form as the name its run and reports carry. */
const formLabel = (form: OptimizedForm): string =>
	form.kind === "optimized variant" ? `optimized variant ${form.statement}` : form.kind

/** One compared run of the optimized artifact: the default program, or a per-execution variant. */
export interface OptimizedRun {
	readonly form: OptimizedForm
	readonly run: Run
	readonly comparison: Comparison
	readonly order: ReadonlyArray<string>
}

export interface DifferentialOutcome {
	readonly case: QueryCase
	readonly plan: RealInstallPlan
	readonly conservativeProgram: ConservativeProgram
	readonly optimizedProgram: OptimizedProgram
	readonly certificates: ReadonlyArray<Certificate>
	readonly conservative: Run
	readonly optimized: ReadonlyArray<OptimizedRun>
	/** The plan of each statement an optimized form sent, each text once. */
	readonly plans: ReadonlyArray<PlanShape>
	readonly others: ReadonlyArray<{
		readonly name: string
		readonly run: Run
		readonly comparison: Comparison
	}>
	readonly fusedAttachments: number
}

/** Whether every optimized run equals the conservative run, repeats no row, and keeps every delivery order. */
export const agrees = (o: DifferentialOutcome): boolean =>
	Arr.every(
		o.optimized,
		(r) => r.comparison.equal && r.comparison.rightDuplicates === 0 && r.order.length === 0
	)

/** Whether the conservative run repeats no row: the baseline is a set at every statement. */
export const baselineIsSet = (o: DifferentialOutcome): boolean =>
	Arr.every(
		o.conservative.statements,
		(s) => new Set(Arr.map(s.rows, (r) => canonicalTextOf(r))).size === s.rows.length
	)

const lowerSide = <A>(side: string, f: () => Engine.Result<A, CompileError>) =>
	Effect.try({ try: f, catch: (e) => failure("lower", side, messageOf(e)) }).pipe(
		Effect.flatMap((r) =>
			r.ok ? Effect.succeed(r.value) : Effect.fail(failure("lower", side, compileMessage(r.error)))
		)
	)

/** Runs one case under both artifacts and every per-execution form of the optimized one. */
const runDifferential = (
	input: QueryCase,
	options: DifferentialOptions
): Effect.Effect<DifferentialOutcome, DifferentialFailure, Substrate> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		/**
		 * The case's plan perturbation (test/support/oracle/perturb.ts): its facts repeated under fresh keys, and its
		 * planner settings for every form's statements.
		 */
		const perturbation = yield* CurrentPerturbation
		const normalized = normalizedCase(input)
		const c: QueryCase = {
			...normalized,
			facts: multiplyFacts(normalized.schema, normalized.facts, perturbation.multiplier)
		}
		const desc = schemaDesc(c.schema)
		const planned = oraclePlan(
			desc,
			identity.schema(parsedSchemaName(options.schema)),
			substrate.owner.role
		)
		if (!planned.ok) {
			return yield* failure("plan", "install", compileMessage(planned.error))
		}
		const plan = planned.value
		const facts = factStatements(plan, factSet(c))
		if (!facts.ok) {
			return yield* failure("plan", "facts", facts.error.message)
		}
		const names: PhysicalNames = plan.installation.names
		const query = logicalQuery(c)
		const conservativeProgram = yield* lowerSide("conservative", () =>
			lowerConservative(conservativeInput(query), {
				names,
				params: query.params,
				subject: { kind: "query" },
				meter: new BudgetMeter(compileBudgets)
			})
		)
		const catalog = installedCatalog(plan.installation)
		/**
		 * The optimized lowering takes the query as a compilation hands it over (optimizedInput): its logical metadata
		 * derived by the annotation, so every rewrite transfers real keys, cardinalities and contexts.
		 */
		const optimizedProgram = yield* lowerSide("optimized", () =>
			Engine.flatMap(optimizedInput(query, checkerEvidence), (caseInput) =>
				lowerOptimized(caseInput, {
					names,
					catalog,
					subject: { kind: "query" },
					meter: new BudgetMeter(compileBudgets),
					context: "snapshot"
				})
			)
		)
		const violations = loweringViolations({
			optimized: optimizedProgram,
			alignment: { kind: "aligned", conservative: conservativeProgram },
			context: "snapshot",
			catalog
		})
		if (violations.length > 0) {
			return yield* failure("verify", "optimized", Arr.join(violations, "\n"))
		}
		const others: Array<{ readonly lowering: Lowering; readonly program: ConservativeProgram }> = []
		for (const lowering of options.others) {
			others.push({
				lowering,
				program: yield* lowerSide(lowering.name, () => lowering.lower({ case: c, names }))
			})
		}
		const isOrdered = (root: RelNode) => root.kind === "OrderedResult"
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const session = yield* substrate.admin.pin
				const exec = (sql: string, stage: string) =>
					session
						.query(sql, [])
						.pipe(Effect.mapError((e) => failure("execute", stage, `${sqlMessage(e)}\n${sql}`)))
				yield* exec("BEGIN", "setup")
				return yield* Effect.gen(function* () {
					yield* exec("SET LOCAL statement_timeout = '30s'", "setup")
					for (const sql of plan.sql) {
						yield* exec(sql, "install")
					}
					for (const sql of facts.value) {
						yield* exec(sql, "facts")
					}
					/**
					 * Statistics for this transaction's own rows (the oracle runner's reason: estimates over empty
					 * statistics run tiny recursive cases into executor startup costs); rolled back with the rest.
					 */
					const tables = Arr.map(Rec.values(plan.tables), (t) => printObjectName(t.name))
					if (tables.length > 0) {
						yield* exec(`ANALYZE ${Arr.join(tables, ", ")}`, "facts")
					}
					for (const sql of plannerStatements(perturbation)) {
						yield* exec(sql, "perturbation")
					}
					/**
					 * The type oracle (oracle/verify/types.ts): every column each artifact delivers is of the type its
					 * heading states, as PostgreSQL resolves the statement.
					 */
					const typed: Array<string> = []
					const judged: ReadonlyArray<readonly [string, FusedStatement]> = [
						...Arr.map(
							flight(deliveredAsOptimized(conservativeProgram).roots),
							(s, i) => [`conservative statement ${i}`, s] as const
						),
						...Arr.map(
							flight(optimizedProgram.roots),
							(s, i) => [`optimized statement ${i}`, s] as const
						)
					]
					for (const [k, [where, s]] of judged.entries()) {
						const problems = yield* typeProblems(session, s, names, `type_probe_${k}`, where).pipe(
							Effect.mapError((e) => failure("types", where, `${sqlMessage(e)}\n${s.sql.text}`))
						)
						appendAll(typed, problems)
					}
					if (typed.length > 0) {
						return yield* failure("types", "both", Arr.join(typed, "\n"))
					}
					const conservativeRun = yield* execute(
						session,
						c,
						deliveredAsOptimized(conservativeProgram).roots,
						"conservative"
					)
					const baseline = yield* delivered(
						query.dag,
						conservativeRun,
						"conservative",
						isOrdered(query.dag.roots[0])
					)
					const optimizedDag = optimizedProgram.query.dag
					const optimizedOrdered = isOrdered(optimizedDag.roots[0])
					const forms: Array<{
						readonly form: OptimizedForm
						readonly roots: StatementRoots<OptimizedStatement>
					}> = [{ form: { kind: "optimized" }, roots: optimizedProgram.roots }]
					for (const v of largeFormPrograms(optimizedProgram.roots, (l) => l)) {
						forms.push({
							form: { kind: "optimized variant", statement: v.statement },
							roots: v.roots
						})
					}
					const optimized: Array<OptimizedRun> = []
					let fusedAttachments = 0
					for (const f of forms) {
						const label = formLabel(f.form)
						const run = yield* execute(session, c, f.roots, label)
						const d = yield* delivered(optimizedDag, run, label, optimizedOrdered)
						fusedAttachments = Math.max(fusedAttachments, d.fusedAttachments)
						optimized.push({
							form: f.form,
							run: d.run,
							comparison: compareRuns(baseline.run, d.run),
							order: orderProblems(baseline, d)
						})
					}
					/**
					 * Every statement a form sent, each text planned once: db.explain plans whichever form an
					 * execution's inputs select.
					 */
					const sent = new Map<string, OptimizedStatement>()
					for (const s of Arr.flatMap(forms, (f) => flight(f.roots))) {
						if (!sent.has(s.sql.text)) {
							sent.set(s.sql.text, s)
						}
					}
					const plans = yield* explainStatements(session, [...sent.values()], "optimized", (slot) =>
						slotValue(c, slot)
					)
					const otherRuns: Array<DifferentialOutcome["others"][number]> = []
					for (const o of others) {
						const run = yield* execute(
							session,
							c,
							deliveredAsOptimized(o.program).roots,
							o.lowering.name
						)
						const d = yield* delivered(query.dag, run, o.lowering.name, false)
						otherRuns.push({
							name: o.lowering.name,
							run: d.run,
							comparison: compareRuns(baseline.run, d.run)
						})
					}
					return {
						/** The case as generated; the perturbation's report says how its facts ran. */
						case: normalized,
						plan,
						conservativeProgram,
						optimizedProgram,
						certificates: optimizedProgram.certificates,
						conservative: baseline.run,
						optimized,
						plans,
						others: otherRuns,
						fusedAttachments
					} satisfies DifferentialOutcome
				}).pipe(Effect.ensuring(Effect.ignore(session.query("ROLLBACK", []))))
			})
		)
	})

/**
 * The optimized-versus-conservative differential runner.
 *
 * One generated or hand-built case runs on PostgreSQL 19 under both of a template's artifacts, in one rolled-back
 * transaction on one pinned owner session:
 *
 * 1. the case's schema is installed by the real installer (packages/engine/src/physical/install, as the oracle runner does),
 *    any case setup runs, the facts load as typed literal INSERTs, and the tables are ANALYZEd inside the transaction;
 * 2. the conservative lowering, the oracle baseline that deduplicates at every set boundary and uses no rewrite
 *    certificate, runs every statement of its program;
 * 3. the optimized lowering (lower/optimize/pipeline.ts lowerOptimized), compiled against the installation's own
 *    evidence catalog (laws/model/catalog.ts, the catalog compileQuery uses) for one execution context, checked by
 *    the kernel's verification against the conservative artifact (oracle/verify), runs every statement of its
 *    program, every column of which the type oracle judged (oracle/verify/types.ts), and then
 *    each per-execution form the runtime may choose instead: every per-execution variant statement,
 *    and the VALUES transport of every relation parameter the transport rule sends as VALUES;
 * 4. every optimized run is compared with the conservative run statement by statement as raw output-function text
 *    multisets (test/support/oracle/compare.ts), its repeated rows are counted, and the order of every ordered
 *    delivery is compared too;
 * 5. every statement an optimized form sent is planned as db.explain plans it, each text once, and its plan is read as
 *    the plan features the suites note.
 *
 * Relation parameters are deduplicated on entry: the runtime normalizes a relation input
 * before it sends it, so both artifacts receive each fact once, as the runtime would send them, and the optimized
 * lowering may rely on the input's complete heading being a key. The case's own rows may repeat; the runner sends
 * their normalized set to both sides.
 *
 * A fused attachment is one array column of its parent's statement rather than a statement of its own.
 * The runner unfuses it into the rows the pipelined attachment statement would deliver, the parent key columns and
 * then the child's heading, so the comparison stays structural: each element of the array is the child value's result
 * text cast inside the array (codec resultTextCasts: `::text`, money through numeric), the text capture reads for an
 * ordinary column; a child column correlated to a parent column the array leaves out is the parent row's text
 * (shapes/attach/decode.ts). Two parent rows with equal parent key columns must carry equal arrays, and an array
 * that repeats an element is a repeated row of the unfused statement.
 *
 * runDifferential, with a failure to lower or run either artifact reported as a failed property carrying the case in
 * printable form, so a shrunk failure prints the case that produced it.
 */
export const differentialCase = (
	c: QueryCase,
	options: DifferentialOptions
): Effect.Effect<DifferentialOutcome, PropertyFailed, Substrate> =>
	Effect.mapError(
		runDifferential(c, options),
		(e) =>
			new PropertyFailed({
				report: `${e.stage} failed on ${e.side}: ${e.message}\n${printOracleCase(c)}`
			})
	)

/**
 * The printable report of an outcome: the case, every failing optimized form's comparison and order problems, both
 * runs, and the optimized program's SQL.
 */
export const printDifferential = (o: DifferentialOutcome): string => {
	const lines: Array<string> = []
	lines.push(printQueryCase(o.case))
	for (const r of o.optimized) {
		if (r.comparison.equal && r.comparison.rightDuplicates === 0 && r.order.length === 0) {
			continue
		}
		lines.push(printComparison(r.comparison, "conservative", formLabel(r.form)))
		for (const p of r.order) {
			lines.push(`  order: ${p}`)
		}
		lines.push(printRun(r.run))
	}
	lines.push(printRun(o.conservative))
	for (const [i, s] of flight(o.optimizedProgram.roots).entries()) {
		lines.push(`optimized statement ${i}:\n${s.sql.text}`)
	}
	for (const [i, s] of flight(o.optimizedProgram.roots).entries()) {
		if (s.forms.kind === "chosen") {
			lines.push(`optimized variant ${i}:\n${s.forms.large.sql.text}`)
		}
	}
	for (const [i, s] of flight(o.conservativeProgram.roots).entries()) {
		lines.push(`conservative statement ${i}:\n${s.sql.text}`)
	}
	lines.push(
		`certificates: ${Arr.join(
			Arr.map(o.certificates, (c) => c.rule),
			", "
		)}`
	)
	return Arr.join(lines, "\n")
}
