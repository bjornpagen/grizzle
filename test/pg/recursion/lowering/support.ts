import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import { planNodeTypes } from "#bench/harness/explain.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { ParamId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import { type ConservativeProgram, flight } from "#compiler/lower/conservative/types.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import type { Select, SelectBody } from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { defined } from "#test/support/assert.ts"
import { lowerAligned } from "#test/support/compile.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import { schemaDesc } from "#test/support/oracle/gen/schema.ts"
import { factStatements } from "#test/support/oracle/install/load.ts"
import { oraclePlan } from "#test/support/oracle/install/real.ts"
import {
	aliasOrigins,
	identityVisitor,
	rewriteProgram,
	rewriteSelect,
	topLevelContext
} from "#test/support/oracle/mutants/ast.ts"

import {
	factSet,
	inputText,
	type Lowering,
	type LoweringInput
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The parameter declarations of a case's query, for the lowering's typed placeholders. */
const caseParams = (c: QueryCase): ReadonlyArray<ParamDecl> =>
	Arr.map(Rec.toEntries(c.query.params), ([id, p]): ParamDecl =>
		p.kind === "scalar"
			? { id: ParamId(id), name: id, kind: "scalar", type: p.type }
			: { id: ParamId(id), name: id, kind: "relation", heading: p.heading }
	)

const literalKey = (row: ReadonlyArray<unknown>): string => Formatter.format(row)

/**
 * A case whose relation parameters hold each fact once. The host encoder deduplicates a relation parameter's complete
 * facts before any SQL runs (packages/engine/src/codec/recordset.ts), and the optimized lowering's
 * InputSet rests on that (lower/shapes/relparam); the oracle runner binds a case's rows as given, repeats
 * included, which only the conservative lowering, deduplicating on entry, tolerates. A relation parameter is a set,
 * so the deduplicated case means the same as the original.
 */
export const withEncodedParams = <C extends QueryCase>(c: C): C => {
	const params: Record<string, GenParam> = {}
	for (const [id, p] of Rec.toEntries(c.query.params)) {
		if (p.kind !== "relation") {
			params[id] = p
			continue
		}
		const seen = new Set<string>()
		params[id] = {
			...p,
			rows: Arr.filter(p.rows, (row) => {
				const key = literalKey(row)
				if (seen.has(key)) {
					return false
				}
				seen.add(key)
				return true
			})
		}
	}
	return { ...c, query: { ...c.query, params } }
}

export const lowerCase = (
	c: QueryCase,
	names: LoweringInput["names"]
): Result.Result<OptimizedProgram, CompileError> =>
	lowerAligned({ dag: c.query.dag, params: caseParams(c) }, "query", {
		names,
		context: "snapshot",
		catalog: genCatalog(c.schema)
	})

/**
 * Shared pieces of the optimized recursive lowering suites.
 *
 * - optimizedLowering is the oracle's left side: the full optimized pipeline (rewrites, placement, CTE policy, the
 *   shape kind table with the recursion plug-in) over a generated case, checked by the kernel's verification (it lowers
 *   through test/support/compile.ts lowerAligned), with the case's declared containments as installed evidence.
 * - optimizedFeedbackUnionAll is the feedback UNION ALL mutant applied to the optimized output itself: every recursion's
 *   recursive UNION turned into UNION ALL. The seed and step SELECTs are already plain there (V6), so a diamond kills
 *   it when two routes reach one state.
 */
export const optimizedLowering = (name: string): Lowering => ({
	name,
	lower: ({ case: c, names }) => lowerCase(c, names)
})

/**
 * EXPLAIN (FORMAT JSON), without ANALYZE (no trial run at preparation; plan shape only), of a lowering's
 * main statement over a case installed and loaded in a rolled-back transaction, after ANALYZE of its tables. Only
 * scalar parameters are bound; the plan's node types are returned in depth-first order.
 */
export const explainMain = (c: QueryCase, lowering: Lowering) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const schema = yield* substrate.schema({ create: false, label: "explain" })
			const desc = schemaDesc(c.schema)
			const planned = oraclePlan(
				desc,
				identity.schema(parsedSchemaName(schema)),
				substrate.owner.role
			)
			if (!planned.ok) {
				return yield* Effect.die(new Error(planned.error.message))
			}
			const plan = planned.value
			const facts = factStatements(plan, factSet(c))
			if (!facts.ok) {
				return yield* Effect.die(new Error(facts.error.message))
			}
			const lowered = lowering.lower({ case: c, names: plan.installation.names })
			if (!lowered.ok) {
				return yield* Effect.die(new Error(lowered.error.message))
			}
			const [main] = flight(lowered.value.roots)
			const params = Arr.map(main.params, (slot) => {
				const p = slot.kind === "scalar" ? c.query.params[slot.param] : undefined
				if (p?.kind !== "scalar") {
					throw new Error(`explainMain binds scalar parameters only, not ${slot.kind}`)
				}
				return inputText(p.value)
			})
			const session = yield* substrate.admin.pin
			yield* session.query("BEGIN", [])
			return yield* Effect.gen(function* () {
				for (const sql of [...plan.sql, ...facts.value]) {
					yield* session.query(sql, [])
				}
				const tables = Arr.map(Rec.values(plan.tables), (t) => printObjectName(t.name))
				if (tables.length > 0) {
					yield* session.query(`ANALYZE ${Arr.join(tables, ", ")}`, [])
				}
				const result = yield* session.query(`EXPLAIN (FORMAT JSON) ${main.sql.text}`, params)
				const [record] = result.rows
				/** The plan's node types, a node before its children (bench/harness/explain.ts planNodeTypes). */
				const explained = Rec.values(defined(record, "the EXPLAIN row"))[0]
				return { sql: main.sql.text, nodes: planNodeTypes(explained) }
			}).pipe(Effect.ensuring(Effect.ignore(session.query("ROLLBACK", []))))
		})
	)

/** The I8 rewrite on the optimized output: each recursion's feedback union made UNION ALL. */
const unionAll = (body: SelectBody, count: () => void): SelectBody => {
	if (body.kind !== "setOp" || body.op !== "UNION") {
		return body
	}
	count()
	return { ...body, op: "UNION ALL" }
}

/** A recursive CTE's body with its feedback union made UNION ALL; any other query as it is. */
const mutateFeedback = (query: Select, count: () => void): Select => {
	const w = query.with
	if (w === undefined || !w.recursive) {
		return query
	}
	const ctes = Arr.map(w.ctes, (cte) =>
		cte.query.kind === "select"
			? { ...cte, query: { ...cte.query, body: unionAll(cte.query.body, count) } }
			: cte
	)
	return { ...query, with: { ...w, ctes } }
}

interface MutatedFeedback {
	readonly program: ConservativeProgram
	readonly sites: number
}

export const feedbackUnionAll = (
	program: ConservativeProgram
): Result.Result<MutatedFeedback, CompileError> => {
	let sites = 0
	const count = () => {
		sites++
	}
	const rewritten = rewriteProgram(program, (statement) =>
		mutateFeedback(
			rewriteSelect(
				statement.ast,
				aliasOrigins(statement),
				{ ...identityVisitor, derived: (query) => mutateFeedback(query, count) },
				topLevelContext
			),
			count
		)
	)
	return Result.map(rewritten, (p) => ({ program: p, sites }))
}

export const optimizedFeedbackUnionAll: Lowering = {
	name: "mutant optimized feedback UNION ALL",
	lower: ({ case: c, names }) =>
		Result.flatMap(lowerCase(c, names), (p) => Result.map(feedbackUnionAll(p), (m) => m.program))
}
