import { Array as Arr, Data, Effect, Option, Record as Rec } from "effect"
import {
	explainStatementWith,
	type PlanNode,
	parsePlan,
	planNodes
} from "#bench/harness/explain.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { identity } from "#compiler/core/identity.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import {
	type ConservativeProgram,
	type ConservativeStatement,
	flight
} from "#compiler/lower/conservative/types.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { unrollRule } from "#compiler/lower/shapes/recursion/index.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { defined } from "#test/support/assert.ts"
import { lowerAligned } from "#test/support/compile.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { canonicalFacts, type ValueFacts } from "#test/support/oracle/gen/facts.ts"
import { genParamDecls, normalQuery } from "#test/support/oracle/gen/query.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import { schemaDesc } from "#test/support/oracle/gen/schema.ts"
import type { GenContainment, GenSchema } from "#test/support/oracle/gen/schema.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { oraclePlan, type RealInstallPlan } from "#test/support/oracle/install/real.ts"
import {
	factSet,
	inputText,
	type LabelledCase,
	type Lowering
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
 * (R37) or kept one pipelined, and whether a recursion was unrolled into joins or stayed a recursive CTE.
 */
export type GraphOptimizedFeature =
	| GraphRule
	| "seeded attachment"
	| "pipelined attachment"
	| "unrolled recursion"
	| "recursive CTE"

/**
 * Whether a program statement is an attachment seeded once from the parent keys (R37): an R37 seeded attachment is a
 * WITH RECURSIVE at its statement's top level by construction.
 */
export const seededStatements = (program: ConservativeProgram): number =>
	Arr.filter(
		flight(program.roots),
		(s) => s.role.kind === "attachment" && s.ast.with?.recursive === true
	).length

/**
 * Whether a statement holds a WITH RECURSIVE at any depth of its AST: the lowering nests a recursion's WITH RECURSIVE
 * inside a derived table under any consumer node, so its top level alone does not show it.
 */
const holdsRecursive = (statement: ConservativeStatement): boolean =>
	has(shapeOf(statement.ast), "with recursive")

/**
 * What one optimized program did, as features. A recursion is unrolled when the unroll certificate
 * records it, and stays a recursive CTE when a statement of the query itself, not an attachment's, holds a WITH
 * RECURSIVE.
 */
export const optimizedFeatures = (
	program: OptimizedProgram
): ReadonlyArray<GraphOptimizedFeature> => {
	const seeded = seededStatements(program)
	const pipelined =
		Arr.filter(flight(program.roots), (s) => s.role.kind === "attachment").length - seeded
	return [
		...Arr.flatMap(program.certificates, (c) => (isGraphRule(c.rule) ? [c.rule] : [])),
		...(seeded > 0 ? ["seeded attachment" as const] : []),
		...(pipelined > 0 ? ["pipelined attachment" as const] : []),
		...(Arr.some(program.certificates, (c) => c.rule === unrollRule)
			? ["unrolled recursion" as const]
			: []),
		...(Arr.some(flight(program.roots), (s) => s.role.kind !== "attachment" && holdsRecursive(s))
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
 * The totality of the forms: a query that reaches no recursion shows neither form, one recursion exactly one, several
 * at least one.
 */
export const formsHold = (
	recursions: number,
	forms: { readonly unrolled: boolean; readonly recursive: boolean }
): boolean => {
	const shown = (forms.unrolled ? 1 : 0) + (forms.recursive ? 1 : 0)
	return recursions === 0 ? shown === 0 : recursions === 1 ? shown === 1 : shown >= 1
}

/**
 * The totality of the forms the lowering of `root` shows (formsHold), given its program and the features its lowering
 * noted. The forms are unrolled (the "unrolled recursion" feature, the unroll certificate) and kept, a WITH RECURSIVE
 * in any statement: the query's own or an attachment's, whose statement carries the recursion it attaches. A message
 * naming the counts when the lowering breaks it: a recursion that shows no form is one the observer cannot see, or one
 * the graph pass rewrote away.
 */
export const formsBroken = (
	root: RelNode,
	program: ConservativeProgram,
	features: ReadonlyArray<GraphOptimizedFeature>
): string | undefined => {
	const recursions = reachableRecursions(root)
	const unrolled = features.includes("unrolled recursion")
	const kept = Arr.some(flight(program.roots), holdsRecursive)
	const shown = (unrolled ? 1 : 0) + (kept ? 1 : 0)
	return formsHold(recursions, { unrolled, recursive: kept })
		? undefined
		: `${recursions} reachable recursions shown in ${shown} forms (unrolled: ${unrolled}, a WITH RECURSIVE: ${kept})`
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
		const rows = Arr.dedupeWith(p.rows, (a, b) => {
			const x = Arr.map(a, inputText)
			const y = Arr.map(b, inputText)
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
	readonly schema: unknown
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
			const planned = oraclePlan(
				desc,
				identity.schema(parsedSchemaName(schema)),
				substrate.owner.role
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
				yield* exec("SET LOCAL statement_timeout = '60s'")
				for (const sql of plan.sql) {
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

/** The value of a relation parameter's row at a column of its heading. */
const cellOf = (row: ReadonlyArray<TypedLiteral>, index: number, column: string): TypedLiteral => {
	const value = row[index]
	if (value === undefined) {
		throw new Error(`no value for the column ${column}`)
	}
	return value
}

/**
 * The text of each placeholder of a statement: a scalar parameter's value, or a relation parameter's rows
 * (runner.ts slotValue). A query statement's placeholder is a declared parameter, never a write's member or a page's.
 */
export const statementParams = (
	c: QueryCase,
	statement: ConservativeStatement
): ReadonlyArray<string> =>
	Arr.map(statement.params, (slot): string => {
		switch (slot.kind) {
			case "scalar": {
				const p = c.query.params[slot.param]
				if (p?.kind !== "scalar") {
					throw new Error(`no value for ${slot.param}`)
				}
				return inputText(p.value)
			}
			case "relation": {
				const p = c.query.params[slot.param]
				if (p?.kind !== "relation") {
					throw new Error(`no rows for ${slot.param}`)
				}
				return jsonText(
					Arr.map(p.rows, (row) =>
						Rec.fromEntries(
							Arr.map(slot.columns, (col) => [
								col.definition.name,
								inputText(
									cellOf(
										row,
										Option.getOrThrowWith(
											Arr.findFirstIndex(p.heading, (h) => h.name === col.name),
											() => new Error("a column the case's own heading holds")
										),
										col.name
									)
								)
							])
						)
					)
				)
			}
		}
	})

/**
 * The rows a statement read from one table: every scan of it, the rows it returned and those its filter or recheck
 * removed, times its loops.
 */
export const tableRowsRead = (root: PlanNode, table: string): number =>
	Arr.reduce(
		Arr.filter(planNodes(root), (n) => Option.contains(n.relation, table)),
		0,
		(sum, n) =>
			sum + (n.actualRows + n.rowsRemovedByFilter + n.rowsRemovedByIndexRecheck) * n.actualLoops
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
				catalog: genCatalog(c.schema),
				meter: new BudgetMeter(compileBudgets)
			}),
			(p) => {
				note(optimizedFeatures(p))
				return p
			}
		)
})
