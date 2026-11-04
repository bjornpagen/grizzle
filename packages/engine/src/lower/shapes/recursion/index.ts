import {
	type CounterAnalysis,
	type CounterProof,
	counterBound
} from "#compiler/check/recursion/bound.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { recursionUnrollMax } from "#compiler/core/policy.ts"
import { makeCertificate } from "#compiler/ir/certificate.ts"
import type { NodeOf, RelDag } from "#compiler/ir/rel.ts"
import {
	type Env,
	headingTargets,
	type LowerContext,
	type NamedColumn,
	type NodeLowerer,
	namedMap,
	nodeLabel,
	refuse
} from "#compiler/lower/conservative/context.ts"
import { requireAdmittedFeedback } from "#compiler/lower/conservative/recursive/index.ts"
import { stateColumns, stateTerm } from "#compiler/lower/shapes/recursion/terms.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import type { Cte, Select, SelectCore } from "#compiler/sql/ast.ts"
import { cteRefAs, distinctCoreWhen, select, setOp } from "#compiler/sql/build.ts"

export const unrollRule = "recursion.unroll"

/**
 * Which form a recursion lowers to: the unrolled union when a counter proves a depth within `unrollMax`
 * (core/policy.ts recursionUnrollMax in production), otherwise the recursive CTE.
 */
type RecursionForm =
	| { readonly kind: "unrolled"; readonly proof: CounterProof }
	| { readonly kind: "recursive"; readonly analysis: CounterAnalysis }

/**
 * Recursive relations in the optimized lowering.
 *
 * A recursion lowers to one of two forms, both a set of its complete declared state:
 *
 * 1. WITH RECURSIVE ... UNION, the native fixed point:
 *
 *      WITH RECURSIVE r1(c1, c2) AS (
 *        SELECT r2.id::uuid, 0::integer FROM network.person AS r2 WHERE r2.id = $1::uuid
 *        UNION
 *        SELECT r4.c5::uuid, r4.c6 + 1::integer FROM ... r1 AS r3 ... WHERE r3.c2 < 4::integer
 *      )
 *      SELECT r5.c1, r5.c2 FROM r1 AS r5
 *
 *    UNION deduplicates the complete feedback state within and across iterations, so the seed and step SELECTs carry
 *    no DISTINCT of their own when the placement realized them plain, and the complete final-state
 *    projection needs none either; a later projection dropping state fields deduplicates where the placement puts it.
 *    UNION is never relaxed to UNION ALL, whatever the edge keys, acyclicity or depth bound:
 *    dedup/policy.ts pins the Recursive realization `distinct`, and a `plain` one is refused here.
 *    Each term is cast to the declared state representation (terms.ts).
 *
 * 2. An unrolled set union of joins, when a bounded counter proves that the step's image
 *    of the seeds is empty after N iterations (bound.ts) and N is at most the fixed policy's recursionUnrollMax:
 *
 *      WITH r1(c1, c2) AS NOT MATERIALIZED (<seed>),
 *           r2(c3, c4) AS NOT MATERIALIZED (<step reading r1>),
 *           ...
 *           r<N+1>(...) AS NOT MATERIALIZED (<step reading r<N>>)
 *      SELECT r.c1, r.c2 FROM r1 AS r UNION SELECT ... FROM r2 AS ... UNION ... FROM r<N+1> AS ...
 *
 *    Level n is the step's n-th image of the seeds, the step lowered with its feedback scan reading level n - 1; the
 *    least fixed point of positive linear feedback is the set union of the levels, which UNION
 *    computes, deduplicating the complete state like recursive UNION. With N = 0 the step never applies and the form
 *    is the seed under SELECT DISTINCT. Every level is a feedback node, which the CTE policy inlines: NOT
 *    MATERIALIZED lets PostgreSQL expand each union arm into one join chain of n steps over the seed, with a bound root
 *    pushed into each, instead of a working table per iteration. The rows of one arm repeat as its joins fan out;
 *    the set UNION absorbs them, as it absorbs the fixed-length join form's. The choice is the fixed
 *    policy's, never the caller's, and records a `recursion.unroll` certificate.
 *
 * Before either form, the refusals of the conservative lowering apply (conservative/recursive requireAdmittedFeedback):
 * positive linear feedback and a hash operator class for every state column.
 */
export const recursionForm = (
	dag: RelDag,
	rec: NodeOf<"Recursive">,
	unrollMax: number
): RecursionForm => {
	const analysis = counterBound(dag, rec)
	return analysis.kind === "bounded" && analysis.proof.depth <= unrollMax
		? { kind: "unrolled", proof: analysis.proof }
		: { kind: "recursive", analysis }
}

/** One CTE of a recursion's state: the recursive CTE or one unrolled level, its columns paired with the state columns. */
interface StateCte {
	readonly name: string
	readonly columns: ReadonlyArray<NamedColumn>
}

/** A read of one CTE's state columns under a fresh alias, in heading order, deduplicated when `distinct`. */
const readState = (
	cx: LowerContext,
	rec: NodeOf<"Recursive">,
	cte: StateCte,
	distinct: boolean
): SelectCore => {
	const alias = cx.relationAlias({ kind: "node", node: rec.id })
	return distinctCoreWhen(
		distinct,
		headingTargets(rec.heading, namedMap(alias, cte.columns)),
		[cteRefAs(cte.name, alias)],
		undefined
	)
}

/** The scope of the step, whose SelfRef reads `cte`: the recursive CTE, or the previous level. */
const stepScope = (cx: LowerContext, rec: NodeOf<"Recursive">, cte: StateCte): LowerContext =>
	cx.withFeedback(rec, cte.name, cte.columns)

const recursiveForm = (rec: NodeOf<"Recursive">, cx: LowerContext, env: Env): Select => {
	const origin = { kind: "node", node: rec.id } as const
	const cte: StateCte = { name: cx.relationAlias(origin), columns: stateColumns(cx, rec) }
	const base = stateTerm(cx, rec, rec.base, env)
	const step = stateTerm(stepScope(cx, rec, cte), rec, rec.step, env)
	return {
		...select(readState(cx, rec, cte, false)),
		with: {
			recursive: true,
			ctes: [
				{
					name: cte.name,
					columns: cte.columns.map((c) => c.column),
					query: select({ kind: "setOp", op: "UNION", arms: [base, step] }),
					materialized: undefined
				}
			]
		}
	}
}

const unrolledForm = (
	rec: NodeOf<"Recursive">,
	cx: LowerContext,
	env: Env,
	proof: CounterProof
): Select => {
	const origin = { kind: "node", node: rec.id } as const
	const level = (query: () => Select): StateCte & { readonly query: Select } => {
		const name = cx.relationAlias(origin)
		const columns = stateColumns(cx, rec)
		return { name, columns, query: query() }
	}
	const base = level(() => select(stateTerm(cx, rec, rec.base, env)))
	const steps: Array<StateCte & { readonly query: Select }> = []
	for (let n = 1, below = base; n <= proof.depth; n++) {
		const feedback = below
		below = level(() => select(stateTerm(stepScope(cx, rec, feedback), rec, rec.step, env)))
		steps.push(below)
	}
	const body = setOp("UNION", [
		readState(cx, rec, base, steps.length === 0),
		...steps.map((l) => readState(cx, rec, l, false))
	])
	const ctes = mapNonEmpty([base, ...steps], (l): Cte => ({
		name: l.name,
		columns: l.columns.map((c) => c.column),
		materialized: "NOT MATERIALIZED",
		query: l.query
	}))
	return { ...select(body), with: { ctes, recursive: false } }
}

const certifyUnroll = (facts: ShapeFacts, rec: NodeOf<"Recursive">): void => {
	const inputs: Array<NodeId> = [rec.base.id, rec.step.id, rec.self.id]
	const cert = makeCertificate({
		rule: unrollRule,
		inputs,
		outputs: [rec.id],
		premises: [{ kind: "node", node: rec.id }],
		context: "queryLocal",
		preservedHeading: rec.heading.map((c) => c.name),
		equality: [],
		coercion: [],
		params: undefined
	})
	if (!cert.ok) {
		throw new Refusal(cert.error)
	}
	facts.certify(cert.value)
}

export const recursionLowerer =
	(facts: ShapeFacts): NodeLowerer<"Recursive"> =>
	(node, cx, env) => {
		requireAdmittedFeedback(node)
		if (facts.realization(node) !== "distinct") {
			return refuse(
				"MalformedDescription",
				nodeLabel(node),
				"recursive feedback realized with its UNION: no UNION ALL elision applies to it"
			)
		}
		const form = recursionForm(cx.dag, node, recursionUnrollMax)
		if (form.kind === "recursive") {
			return recursiveForm(node, cx, env)
		}
		certifyUnroll(facts, node)
		return unrolledForm(node, cx, env, form.proof)
	}
