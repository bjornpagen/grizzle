import type { BudgetMeter } from "#compiler/core/budget.ts"
import { canonicalEquals, catchRefusal, everyProperty } from "#compiler/core/canonical.ts"
import type { Diagnostic } from "#compiler/core/diag.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { Certificate } from "#compiler/ir/certificate.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import { makePassContext, type Pass, type PassContext } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { RelDag } from "#compiler/ir/rel.ts"
import { annotateQuery, type LogicalEnv } from "#compiler/logical/annotate.ts"
import { LowerContext } from "#compiler/lower/conservative/context.ts"
import {
	type ConservativeOptions,
	flight,
	type MembershipLowering,
	type ReadBackLowering,
	type StatementRoots
} from "#compiler/lower/conservative/types.ts"
import { type CtePlan, ctePolicyPass } from "#compiler/lower/optimize/cte-policy/index.ts"
import { dedupPlacement } from "#compiler/lower/optimize/dedup/pass.ts"
import type { DedupPlan } from "#compiler/lower/optimize/dedup/plan.ts"
import {
	relationalRewrites,
	semanticSimplification,
	sequence
} from "#compiler/lower/optimize/demand/phases.ts"
import { graphPass } from "#compiler/lower/optimize/graph/index.ts"
import { catalogPass } from "#compiler/lower/shapes/catalog/rewrite.ts"
import {
	type DeliveredProgram,
	type FusedStatement,
	OptimizedDelivery,
	type OptimizedDeliveryProgram,
	type OptimizedStatement,
	optimizedDispatch,
	type RelationChoice,
	ShapeState
} from "#compiler/lower/shapes/index.ts"
import { arrivalsOf } from "#compiler/lower/shapes/share/index.ts"
import { type ShapeFacts, shapeFactsFromPlan } from "#compiler/lower/shapes/share/physical.ts"
import { everyParentTakes } from "#compiler/lower/shapes/take/decorrelate.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"

interface OptimizedOptions extends Omit<ConservativeOptions, "meter" | "params" | "subject"> {
	readonly subject: OptimizedSubject
}

/**
 * What is compiled: a query; a derived relation's definition, which always wants every group; a write program's
 * read-back; or a write filter's membership at the row its caller names.
 */
type OptimizedSubject =
	| { readonly kind: "query" }
	| { readonly kind: "derivedDefinition" }
	| ReadBackLowering
	| MembershipLowering

/**
 * The optimized artifact of a query, a derived relation's definition or a read-back: its statements, each with its
 * forms, whose large form is L (the large mode's statement as lowered, or as a template holds it with its spec).
 */
export interface OptimizedProgram<L = FusedStatement> extends OptimizedDeliveryProgram<
	RelationChoice,
	L
> {
	/** The query the rewrites left, whose DAG the statements lower. */
	readonly query: LogicalQuery
	readonly plan: DedupPlan
	readonly cte: CtePlan
	/**
	 * Every certificate the compilation recorded, in order: the rewrites', the catalog's, the placement's, the CTE
	 * policy's and the shapes'.
	 */
	readonly certificates: ReadonlyArray<Certificate>
	readonly diagnostics: ReadonlyArray<Diagnostic>
}

/**
 * The query the optimized lowering takes, from a checked one: every take correlated through bind restated with its
 * correlation explicit, so the take policy sees its parent set and lowers it LATERAL, over every group, or per execution
 * by a relation parameter's count (lower/shapes/take/decorrelate.ts), and the restated DAG annotated under `evidence`
 * (logical/annotate.ts): its logical keys, cardinalities and contexts derived, never stated. The conservative artifact
 * keeps the checked DAG.
 *
 * The optimized pipeline: the optimized lowering of a checked query, its passes in a fixed order.
 *
 * The first four passes (ownership, scope and type checking, theory normalization, law specialization)
 * run before a query reaches the optimizer: the schema package, the checker, the theory and the law model. Physical
 * requests run at migration generation, never at compilation. The query passes run here, in this order:
 *
 * 1. query demand analysis (demand/): demanded fields, contribution identity, sharing boundaries;
 * 2. semantic simplification (demand/phases.ts): folding, equality propagation, branch removal, R01 fusion;
 * 3. relational rewrites: prune, R03, R07, R02, pushdown, semi-join movement, simplify, prune, R06;
 * 4. specialized lowering: the compile-target catalog (shapes/catalog) and bounded traversal specialization (graph/);
 * 5. deduplication placement (dedup/): every node's realization and every fold's input, with certificates;
 * 6. program scheduling and SQL emission: the CTE policy (cte-policy/), the shape kind table and the optimized
 *    delivery (shapes/index.ts), each statement printed through sql/emit.
 *
 * The lowering trusts its own construction: the plan's obligations recomputed from the DAG, every statement's channels
 * and the alignment with the conservative artifact are properties of the test kernel that every lowering of the suites
 * is checked against (test/support/oracle/verify), never steps of a compilation.
 * Every pass charges the compilation's budget meter and records its certificates in the context's log; the context
 * fixes the evidence context the artifact is compiled for, and the pipeline refuses a conservative
 * context: the conservative artifact is the separate oracle lowering. Each pass states its measure; no
 * rewrite loops without one.
 */
export const optimizedInput = (
	query: LogicalQuery,
	evidence: LogicalEnv
): Result.Result<LogicalQuery, CompileError> =>
	Result.flatMap(everyParentTakes(query), (restated) => annotateQuery(restated.query, evidence))

/**
 * The rewrite passes up to and including specialized lowering, in normative order, under the compilation's catalog
 * (PassContext). A derived-relation definition always wants every group, so its catalog pass takes the whole input.
 */
export const rewritePipeline = (
	subject: OptimizedSubject["kind"]
): Pass<LogicalQuery, LogicalQuery> =>
	sequence("rewrite pipeline", [
		semanticSimplification,
		relationalRewrites,
		catalogPass(subject === "derivedDefinition" ? "whole" : "auto"),
		graphPass
	])

/** The shape facts of a placement, their certificates recorded once each in the context's log. */
const factsOf = (plan: DedupPlan, ctx: PassContext, options: OptimizedOptions): ShapeFacts =>
	shapeFactsFromPlan(plan, {
		derivedDefinition: options.subject.kind === "derivedDefinition",
		certify: (certificate) => {
			if (!ctx.certificates.all().some((c) => canonicalEquals(c, certificate, everyProperty))) {
				ctx.certificates.record(certificate)
			}
		}
	})

/** The delivery of the rewritten query: each statement with its forms. */
const deliver = (
	query: LogicalQuery,
	facts: ShapeFacts,
	cte: CtePlan,
	options: OptimizedOptions,
	ctx: PassContext
): Result.Result<DeliveredProgram<RelationChoice>, CompileError> =>
	catchRefusal(() => {
		const state = new ShapeState<RelationInput>("small", cte)
		const lowering: ConservativeOptions = {
			names: options.names,
			params: query.params,
			meter: ctx.budgets,
			/** A derived relation's definition lowers as a query. */
			subject: options.subject.kind === "derivedDefinition" ? { kind: "query" } : options.subject
		}
		const cx = new LowerContext(query.dag, lowering, optimizedDispatch(facts, state))
		return new OptimizedDelivery<never>(cx, facts, state).program(query.dag.roots[0])
	})

/**
 * Each statement with how the runtime has it (shapes/share arrivalsOf), a statement of two forms charged to the variants
 * budget (closed-domain variants stay bounded) at its position in flight order.
 */
const arrivedStatements = (
	dag: RelDag,
	delivered: DeliveredProgram<RelationChoice>,
	ctx: PassContext
): Result.Result<
	StatementRoots<OptimizedStatement<RelationChoice, FusedStatement>>,
	CompileError
> =>
	Result.flatMap(arrivalsOf(dag, delivered.roots), (roots) => {
		for (const [i, s] of flight(roots).entries()) {
			if (s.forms.kind === "chosen") {
				const charged = ctx.budgets.charge(
					"variants",
					1,
					SourceLoc("optimized pipeline", ["variants", i])
				)
				if (!charged.ok) {
					return Result.err(charged.error)
				}
			}
		}
		return Result.ok(roots)
	})

/** The optimized lowering of a checked query, as a pass. */
const optimizedLowering = (options: OptimizedOptions): Pass<LogicalQuery, OptimizedProgram> => ({
	name: "optimizedLowering",
	measure: "bounded-worklist",
	run: (input, ctx) => {
		const rewritten = rewritePipeline(options.subject.kind).run(input, ctx)
		if (!rewritten.ok) {
			return rewritten
		}
		const query = rewritten.value
		const placed = dedupPlacement.run({ dag: query.dag }, ctx)
		if (!placed.ok) {
			return placed
		}
		const plan = placed.value
		const planned = ctePolicyPass.run(query, ctx)
		if (!planned.ok) {
			return planned
		}
		const cte = planned.value.cte
		const facts = factsOf(plan, ctx, options)
		const delivered = deliver(query, facts, cte, options, ctx)
		if (!delivered.ok) {
			return delivered
		}
		const program = delivered.value
		const arrived = arrivedStatements(query.dag, program, ctx)
		if (!arrived.ok) {
			return arrived
		}
		return Result.ok({
			...program,
			roots: arrived.value,
			query,
			plan,
			cte,
			certificates: ctx.certificates.all(),
			diagnostics: ctx.diagnostics.all()
		})
	}
})

export interface LowerOptimizedOptions extends OptimizedOptions {
	/** The execution context the artifact is compiled for. */
	readonly context: TemplateContext
	/**
	 * The installed constraints behind declared keys and containments, named as ownership installs them: every pass of
	 * the compilation proves over this one catalog.
	 */
	readonly catalog: EvidenceCatalog
	/** The compilation's meter, which every pass charges. */
	readonly meter: BudgetMeter
}

/** The optimized lowering in a fresh optimized context: the entry the differential suites and the program package use. */
export const lowerOptimized = (
	query: LogicalQuery,
	options: LowerOptimizedOptions
): Result.Result<OptimizedProgram, CompileError> => {
	const ctx = makePassContext({
		budgets: options.meter,
		evidenceContext: options.context,
		catalog: options.catalog
	})
	return optimizedLowering(options).run(query, ctx)
}
