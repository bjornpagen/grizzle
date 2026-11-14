import { Array as Arr, Data, Effect, Option, Record as Rec } from "effect"
import {
	explainStatementWith,
	type PlanNode,
	parsePlan,
	planNodes
} from "#bench/harness/explain.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { identity } from "#compiler/core/identity.ts"
import * as Result from "#compiler/core/result.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { type ConservativeParamSlot, flight } from "#compiler/lower/conservative/types.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import type { DeliveredPart } from "#compiler/lower/shapes/index.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import type { OperandSelect } from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { defined } from "#test/support/assert.ts"
import {
	type FixtureSchema,
	lowerAligned,
	partQueries,
	partRecursive,
	programAsts,
	filledSql
} from "#test/support/compile.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { canonicalFacts, type ValueFacts } from "#test/support/oracle/gen/facts.ts"
import { genParamDecls, normalQuery } from "#test/support/oracle/gen/query.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import { schemaCodes, schemaDesc } from "#test/support/oracle/gen/schema.ts"
import type { GenContainment, GenSchema } from "#test/support/oracle/gen/schema.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { oraclePlanUnder, type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import {
	factSet,
	inputText,
	type LabelledCase,
	type Lowering,
	type SentProgram,
	slotValue
} from "#test/support/oracle/runner.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The graph pass's rules (lower/optimize/graph/seed.ts). The record is total over them, so a new graph rule in src is
 * a compile error here.
 */
type GraphRule = Extract<CertificateRule, `graph.${string}`>
const graphRules: { readonly [R in GraphRule]: true } = {
	"graph.seedPushdown.filter": true,
	"graph.seedPushdown.constant": true,
	"graph.seedPushdown.region": true
}

/**
 * Whether a certificate's rule or an optimized program's feature is a graph rule.
 *
 * Shared pieces of the graph recognition and recursive attachment suites.
 *
 * - optimizedLowering is the full optimized pipeline (lower/optimize/pipeline.ts) over a generated case, with the
 *   case schema's containments as the R03 evidence catalog, in the snapshot or the transaction evidence context. It
 *   records what the graph work did in each run: the graph certificates (lower/optimize/graph/seed.ts), the
 *   attachment statements seeded from the parent keys (lower/shapes/attach-recursive, R37), which a seeded statement
 *   shows as a WITH RECURSIVE at its top level, where the pipelined statement reads its child LATERAL to the recordset,
 *   and the form each recursion took, observed over the whole statement AST.
 */
export const isGraphRule = (rule: string): rule is GraphRule =>
	Rec.has<string, true>(graphRules, rule)

/**
 * What one optimized program did: each graph rule it fired, whether it seeded an attachment once from the parent keys
 * (R37) or kept one pipelined, and whether a recursion stayed the recursive CTE, its one form.
 */
export type GraphOptimizedFeature =
	| GraphRule
	| "seeded attachment"
	| "pipelined attachment"
	| "recursive CTE"

/**
 * Each delivered relation of an optimized program with the query its part computes (test/support/compile.ts
 * partQueries).
 */
const partsOf = (
	program: SentProgram
): ReadonlyArray<{ readonly part: DeliveredPart; readonly query: OperandSelect }> => {
	const queries = partQueries(program)
	return Arr.map(flight(program.roots), (part) => {
		const query = queries[part.answer]
		if (query === undefined) {
			throw new Error(`the query of part ${part.answer}`)
		}
		return { part, query }
	})
}

/**
 * Whether a program part is an attachment seeded once from the parent keys (R37): an R37 seeded attachment is a
 * WITH RECURSIVE at its part's top level by construction.
 */
export const seededStatements = (program: SentProgram): number =>
	Arr.filter(
		partsOf(program),
		({ part, query }) => part.role.kind === "attachment" && query.with?.recursive === true
	).length

/**
 * What one optimized program did, as features. A recursion stays a recursive CTE when a part of the query itself,
 * not an attachment's, holds a WITH RECURSIVE (test/support/compile.ts partRecursive).
 */
export const optimizedFeatures = (
	program: OptimizedProgram
): ReadonlyArray<GraphOptimizedFeature> => {
	const parts = partsOf(program)
	const seeded = seededStatements(program)
	const pipelined = Arr.filter(parts, ({ part }) => part.role.kind === "attachment").length - seeded
	return [
		...Arr.flatMap(program.certificates, (c) => (isGraphRule(c.rule) ? [c.rule] : [])),
		...(seeded > 0 ? ["seeded attachment" as const] : []),
		...(pipelined > 0 ? ["pipelined attachment" as const] : []),
		...(Arr.some(
			parts,
			({ part }) => part.role.kind !== "attachment" && partRecursive(program, part.answer)
		)
			? ["recursive CTE" as const]
			: [])
	]
}

/**
 * The Recursive nodes a query reaches from `root`: every node under it, each once, through every node's data inputs
 * (dag.ts topoOrder), which pass through an attachment's child.
 */
export const reachableRecursions = (root: RelNode): number =>
	Arr.filter(topoOrder({ roots: [root] }), (node) => node.kind === "Recursive").length

/**
 * The totality of the one form: a query that reaches no recursion shows no WITH RECURSIVE, one that reaches some shows
 * one.
 */
export const formsHold = (recursions: number, recursive: boolean): boolean =>
	recursions === 0 ? !recursive : recursive

/**
 * The totality of the form the lowering of `root` shows (formsHold), given its program: a WITH RECURSIVE in any
 * statement, the query's own or an attachment's, whose statement carries the recursion it attaches. A message naming
 * the count when the lowering breaks it: a recursion that shows no WITH RECURSIVE is one the observer cannot see, or one
 * the graph pass rewrote away.
 */
export const formsBroken = (root: RelNode, program: SentProgram): string | undefined => {
	const recursions = reachableRecursions(root)
	const kept = Arr.some(programAsts(program), (ast) => has(shapeOf(ast), "with recursive"))
	return formsHold(recursions, kept)
		? undefined
		: `${recursions} reachable recursions, a WITH RECURSIVE shown: ${kept}`
}

/** Where a lowering's features go: the case's notes, and whatever else a test keeps of them. */
export type Note = (features: ReadonlyArray<GraphOptimizedFeature>) => void

/**
 * The case with every relation parameter normalized as the host codec normalizes it before any SQL is sent
 * (codec/recordset.ts): a relation parameter is a set, and the codec deduplicates complete facts, so the
 * optimized lowering reads it without a DISTINCT (shapes/relparam). The generator draws root inputs that may repeat,
 * which only the conservative lowering, deduplicating at every boundary, is indifferent to.
 */
export const hostNormalized = <C extends QueryCase>(c: C): C => {
	const params: Record<string, GenParam> = {}
	for (const [id, p] of Rec.toEntries(c.query.params)) {
		if (p.kind !== "relation") {
			params[id] = p
			continue
		}
		const codes = schemaCodes(c.schema)
		const texts = (row: ReadonlyArray<TypedLiteral>) =>
			Arr.map(row, (v, i) =>
				inputText(v, defined(p.heading[i], "a column of the parameter").type, codes)
			)
		const rows = Arr.dedupeWith(p.rows, (a, b) => {
			const x = texts(a)
			const y = texts(b)
			return x.length === y.length && Arr.every(x, (t, i) => t === y[i])
		})
		params[id] = { ...p, rows }
	}
	return { ...c, query: { ...c.query, params } }
}

/**
 * A hand-built case over a schema built with the public API: the generator's schema description of its relations, in
 * their checked headings' column order, with the containments given, and the query checked and normalized.
 */
export const publicCase = (input: {
	readonly schema: FixtureSchema
	/** The schema's declared name. */
	readonly name: string
	readonly relations: ReadonlyArray<string>
	readonly containments: ReadonlyArray<GenContainment>
	readonly facts: ValueFacts
	readonly label: string
	readonly query: unknown
	readonly params: Readonly<Record<string, TypedLiteral>>
}): LabelledCase => {
	const s = input.schema
	const checked = checking(s)
	const schema: GenSchema = {
		name: input.name,
		relations: Arr.map(input.relations, (name) => {
			const info = checked.relations.get(name)
			if (info === undefined) {
				throw new Error(`no relation ${name}`)
			}
			return {
				name,
				columns: Arr.map(info.heading, (c) => ({ name: c.name, type: c.type })),
				primaryKey: info.primaryKey,
				keys: [],
				mutable: false
			}
		}),
		closed: [],
		containments: input.containments
	}
	const desc = queryValueDesc(input.query)
	if (desc === undefined) {
		throw new Error(`${input.label}: not a query value`)
	}
	const q = checkQuery(checking(s), desc, checkOptions("query"))
	if (!q.ok) {
		throw new Error(`${input.label}: ${q.error.message}`)
	}
	const dag = normalQuery(q.value.dag)
	const params: Record<string, GenParam> = {}
	for (const p of q.value.params) {
		const value = input.params[p.name]
		if (value === undefined || p.kind === "relation") {
			throw new Error(`${input.label}: no value for ${p.name}`)
		}
		params[p.id] = { kind: "scalar", type: p.type, value }
	}
	return {
		schema,
		facts: canonicalFacts(input.facts),
		query: { dag, params },
		spelling: { mode: "drawn", edge: false },
		label: input.label
	}
}

/** A failure of the harness itself, with the SQL that failed. */
class HarnessFailure extends Data.TaggedError("HarnessFailure")<{ readonly message: string }> {}

/**
 * The case installed and loaded the way the oracle runner installs it (runner.ts runOracle): the real installer's plan
 * under `schema`, with the oracle's login whose full role writes every relation, the facts, ANALYZE, all in one
 * transaction on a pinned owner session that is rolled back. `body` runs inside it, with the installation's physical
 * names.
 */
export const inInstalledCase = <A, E>(
	c: QueryCase,
	schema: string,
	body: (session: PgConnection, plan: RealInstallPlan) => Effect.Effect<A, E>
): Effect.Effect<A, E | HarnessFailure, Substrate> =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const desc = schemaDesc(c.schema)
			const planned = oraclePlanUnder(
				desc,
				identity.schema(parsedSchemaName(schema)),
				substrate.owner.role,
				schemaCodes(c.schema),
				genParamDecls(c.query)
			)
			if (!planned.ok) {
				return yield* new HarnessFailure({ message: planned.error.message })
			}
			const plan = planned.value
			const facts = factStatements(plan, factSet(c))
			if (!facts.ok) {
				return yield* new HarnessFailure({ message: facts.error.message })
			}
			const session = yield* substrate.admin.pin
			const exec = (sql: string) =>
				session
					.query(sql, [])
					.pipe(Effect.mapError((e) => new HarnessFailure({ message: `${String(e)}\n${sql}` })))
			yield* exec("BEGIN")
			return yield* Effect.gen(function* () {
				for (const sql of filledSql(plan.drafted, substrate.database)) {
					yield* exec(sql)
				}
				for (const sql of facts.value) {
					yield* exec(sql)
				}
				const tables = Arr.map(Rec.values(plan.tables), (t) => printObjectName(t.name))
				if (tables.length > 0) {
					yield* exec(`ANALYZE ${Arr.join(tables, ", ")}`)
				}
				return yield* body(session, plan)
			}).pipe(Effect.ensuring(Effect.ignore(session.query("ROLLBACK", []))))
		})
	)

/**
 * The text of each placeholder of a statement, as the oracle runner binds it (runner.ts slotValue): a scalar
 * parameter's value, or a relation parameter column's array, closed ids by the case's codes. A query statement's
 * placeholder is a declared parameter, never a write's member or a page's.
 */
export const statementParams = (
	c: QueryCase,
	statement: { readonly params: ReadonlyArray<ConservativeParamSlot> }
): ReadonlyArray<string> =>
	Arr.map(statement.params, (slot): string => {
		const value = slotValue(c, slot)
		if (value === undefined) {
			throw new Error(`no value of the case for a ${slot.kind} placeholder`)
		}
		return value
	})

/**
 * The rows a plan node produced over all its loops. PostgreSQL reports a node's rows per loop to two decimal places, so
 * their product with its loops, rounded, is its total, a whole number, wherever it loops fewer than 100 times, and lies
 * within a two-hundredth of a row a loop of it otherwise.
 */
export const rowsOverLoops = (n: PlanNode): number => Math.round(n.actualRows * n.actualLoops)

/**
 * The rows a statement read from one table: every scan of it, the rows it returned over its loops (rowsOverLoops) and
 * those its filter or recheck removed, which PostgreSQL reports per loop too.
 */
export const tableRowsRead = (root: PlanNode, table: string): number =>
	Arr.reduce(
		Arr.filter(planNodes(root), (n) => Option.contains(n.relation, table)),
		0,
		(sum, n) =>
			sum + rowsOverLoops(n) + (n.rowsRemovedByFilter + n.rowsRemovedByIndexRecheck) * n.actualLoops
	)

/**
 * The executed plan of a statement with its placeholders bound: EXPLAIN (ANALYZE) without timing, so the row counts
 * are deterministic for fixed data and a fixed plan, read by the bench's EXPLAIN decoder.
 */
export const executedPlan = (session: PgConnection, sql: string, params: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const result = yield* session
			.query(explainStatementWith(sql, { serialize: { kind: "off" }, wal: false }), params)
			.pipe(Effect.mapError((e) => new HarnessFailure({ message: `${String(e)}\n${sql}` })))
		const explained = parsePlan(Rec.values(defined(result.rows[0], "the EXPLAIN row"))[0])
		if (explained._tag === "Failure") {
			return yield* new HarnessFailure({ message: `${explained.failure.message}\n${sql}` })
		}
		return explained.success.plan
	})

/** The checked query of a generated case, as the optimized pipeline takes it. */
export const logicalOf = (c: QueryCase): LogicalQuery => ({
	dag: c.query.dag,
	params: genParamDecls(c.query)
})

/** The optimized lowering of a case in an evidence context, each program's features handed to `note`. */
export const optimizedLoweringWith = (note: Note, context: TemplateContext): Lowering => ({
	name: `optimized (${context})`,
	lower: ({ case: c, names }) =>
		Result.map(
			lowerAligned(logicalOf(c), "query", {
				names,
				context,
				catalog: genCatalog(c.schema)
			}),
			(p) => {
				note(optimizedFeatures(p))
				return p
			}
		)
})
