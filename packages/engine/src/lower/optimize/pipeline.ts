import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { keyAmong } from "#compiler/analysis/physical/props.ts"
import type { AdmittedQuery } from "#compiler/check/index.ts"
import { canonicalEquals, catchRefusal, unwrap } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { type Certificate, makeCertificate } from "#compiler/ir/certificate.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import { makePassContext, type Pass, type PassContext } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { CompletedOrder } from "#compiler/ir/rel.ts"
import { annotateQuery, type LogicalEnv, SharedAnalyses } from "#compiler/logical/annotate.ts"
import { LowerContext } from "#compiler/lower/conservative/context.ts"
import type {
	ConservativeOptions,
	DeclaredParamSlot,
	MembershipLowering,
	ReadBackLowering,
	RegionLowering
} from "#compiler/lower/conservative/types.ts"
import { type CtePlan, ctePolicyPass } from "#compiler/lower/optimize/cte-policy/index.ts"
import { dedupPlacement } from "#compiler/lower/optimize/dedup/pass.ts"
import type { DedupPlan } from "#compiler/lower/optimize/dedup/plan.ts"
import {
	relationalRewritePasses,
	semanticSimplificationPasses,
	sequence
} from "#compiler/lower/optimize/demand/phases.ts"
import { graphPass } from "#compiler/lower/optimize/graph/index.ts"
import { propagatePass } from "#compiler/lower/optimize/propagate/index.ts"
import { sourcePrunePass } from "#compiler/lower/optimize/prune/index.ts"
import { catalogPass } from "#compiler/lower/shapes/catalog/rewrite.ts"
import {
	OptimizedDelivery,
	type OptimizedDeliveryProgram,
	optimizedDispatch,
	type RelationChoice,
	ShapeState
} from "#compiler/lower/shapes/index.ts"
import {
	asItStands,
	driverCertificate,
	type PageWindow,
	pagedReads,
	windowDriver
} from "#compiler/lower/shapes/page/driver.ts"
import { noKeys, queryKeys, type StatementKeys } from "#compiler/lower/shapes/share/keyed.ts"
import { type ShapeFacts, shapeFactsFromPlan } from "#compiler/lower/shapes/share/physical.ts"
import { everyParentTakes } from "#compiler/lower/shapes/take/decorrelate.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import type { EmittedSql, StatementText, UnprintedSql } from "#compiler/sql/ast.ts"
import { emitText, type TextOf, unprintedText } from "#compiler/sql/emit.ts"

interface OptimizedOptions extends Omit<ConservativeOptions, "params" | "subject"> {
	readonly subject: OptimizedSubject
}

/**
 * What is compiled: a query, read as rows or by pages; a rule's probe over its region, which reads the session's delta of its relation
 * (RegionLowering); a derived relation's definition, which always wants every group; a write program's read-back; or a
 * write filter's membership at the row its caller names.
 */
type OptimizedSubject =
	| { readonly kind: "query" }
	| PageLowering
	| RegionLowering
	| { readonly kind: "derivedDefinition" }
	| ReadBackLowering
	| MembershipLowering

/**
 * A query read by pages (program/compile.ts, read "page"): a query whose windows may be driven
 * (lower/shapes/page/driver.ts), in the page's completed order (page/compile.ts completedPageOrder), each relation's
 * unit key fields `unitOf` telling a driver's seek that reads one unit's rows.
 */
export interface PageLowering {
	readonly kind: "page"
	readonly order: CompletedOrder
	readonly unitOf: (relation: string) => ReadonlyArray<string>
}

/**
 * The optimized artifact of a query, a derived relation's definition or a read-back: the one statement it sends, in
 * its forms, and its parts, each statement's text `T`, its print, or none where another statement composes it
 * (lowerComposed).
 */
export interface OptimizedProgram<
	T extends StatementText = EmittedSql
> extends OptimizedDeliveryProgram<RelationChoice, DeclaredParamSlot, T> {
	/** The query the rewrites left, whose DAG the statements lower. */
	readonly query: LogicalQuery
	readonly plan: DedupPlan
	readonly cte: CtePlan
	/** The key sets its statements compute their nodes at (lower/shapes/share/keyed.ts queryKeys). */
	readonly keys: StatementKeys
	/** How its pages' windows read its rows (lower/shapes/page/driver.ts): as they stand, but for a driven page's. */
	readonly window: PageWindow
	/**
	 * Every certificate the compilation recorded, in order: the rewrites', the catalog's, the placement's, the CTE
	 * policy's and the shapes'.
	 */
	readonly certificates: ReadonlyArray<Certificate>
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
 * 3. relational rewrites: prune, R03, R07, R02, simplify, prune, R06;
 * 4. specialized lowering: the compile-target catalog (shapes/catalog) and bounded traversal specialization (graph/),
 *    then the constant columns (propagate/), each key a parameter fixes bound where its stored relation is read and
 *    each reference to a column held at a parameter reading it, then the last prune, which narrows the sources too
 *    (prune/ sourcePrunePass);
 * 5. deduplication placement (dedup/): every node's realization and every fold's input, with certificates;
 * 6. program scheduling and SQL emission: the CTE policy (cte-policy/), the shape kind table and the optimized
 *    delivery (shapes/index.ts), each statement printed through sql/emit, but a rule's judged query, which the
 *    statement that reads it prints (lowerJudged).
 *
 * The lowering trusts its own construction: the plan's obligations recomputed from the DAG, every statement's channels
 * and the alignment with the conservative artifact are properties of the test kernel that every lowering of the suites
 * is checked against (test/support/oracle/verify), never steps of a compilation.
 * Every pass records its certificates in the context's log; the context fixes the evidence context the artifact is
 * compiled for, and the pipeline refuses a conservative context: the conservative artifact is the separate oracle
 * lowering. Each pass states its measure; no rewrite loops without one.
 */
export const optimizedInput = (
	query: AdmittedQuery,
	evidence: LogicalEnv
): Result.Result<OptimizedInput, CompileError> =>
	Result.flatMap(everyParentTakes(query), (restated) => annotatedInput(restated.query, evidence))

/**
 * What the optimized lowering takes: the query annotated, and the store of the compile's analyses it was annotated
 * through (logical/annotate.ts SharedAnalyses), under the one evidence every claim of the compile rests on, which the
 * rewrite pipeline reads its claims through after every pass (rewritePipeline): the annotated query and its evidence
 * travel together, so no claim of the compile is made under another.
 */
export interface OptimizedInput {
	readonly query: AdmittedQuery
	readonly analyses: SharedAnalyses
}

/**
 * `query` annotated under `evidence` through a store of its own, every node shared, as the optimized lowering takes it:
 * a query restated already (optimizedInput), or a write's read-back, whose takes its write's restatement restated.
 */
export const annotatedInput = (
	query: AdmittedQuery,
	evidence: LogicalEnv
): Result.Result<OptimizedInput, CompileError> => {
	const analyses = new SharedAnalyses(evidence, () => true)
	return Result.map(annotateQuery(query, analyses), (annotated) => ({ query: annotated, analyses }))
}

/**
 * The rewrite passes up to and including specialized lowering, in normative order, under the compilation's catalog
 * (PassContext), then the constant columns over the DAG they leave, and last the prune that narrows the sources, once no
 * rewrite reads two scans of one relation by their whole headings, nor any reference a column the constant columns
 * read as its value. A derived-relation definition always wants every group, so its catalog pass takes the whole input.
 */
export const rewritePipeline = (
	subject: OptimizedSubject["kind"],
	analyses: SharedAnalyses
): Pass<LogicalQuery, LogicalQuery> =>
	sequence("rewrite pipeline", rewritePasses(subject, analyses))

/**
 * The rewrite pipeline's passes, each phase's in order, the one list the pipeline runs (rewritePipeline), each leaving
 * the claims of the DAG it delivers what the compile's analysis states of it (claimed): a claim is a fact the logical
 * analysis derives of a node's content (logical/annotate.ts), so no pass carries one, where a node a rewrite rebuilt kept
 * the claims its cell held before it, a key the rewrite's new structure proves claimed by no node and a proof naming
 * what the rewrite took away (test/unit/lower/rewrite/claims.test.ts).
 */
export const rewritePasses = (
	subject: OptimizedSubject["kind"],
	analyses: SharedAnalyses
): ReadonlyArray<Pass<LogicalQuery, LogicalQuery>> =>
	[
		...semanticSimplificationPasses,
		...relationalRewritePasses,
		catalogPass(subject === "derivedDefinition" ? "whole" : "auto", analyses),
		graphPass,
		propagatePass,
		sourcePrunePass
	].map((pass) => claimed(pass, analyses))

/**
 * `pass`, the DAG it delivers annotated through the compile's analyses (`analyses`), which read every node an earlier
 * analysis of the compile annotated as it stands, so the work is the nodes the pass built: a pass that delivers the DAG
 * it was given delivers its claims as they were.
 */
const claimed = (
	pass: Pass<LogicalQuery, LogicalQuery>,
	analyses: SharedAnalyses
): Pass<LogicalQuery, LogicalQuery> => ({
	name: pass.name,
	run: (query, ctx) =>
		Result.flatMap(pass.run(query, ctx), (out) =>
			out.dag === query.dag ? Result.ok(out) : annotateQuery(out, analyses)
		)
})

/** The shape facts of a placement, their certificates recorded once each in the context's log. */
const factsOf = (plan: DedupPlan, ctx: PassContext, options: OptimizedOptions): ShapeFacts =>
	shapeFactsFromPlan(plan, {
		derivedDefinition: options.subject.kind === "derivedDefinition",
		certify: (certificate) => {
			if (!ctx.certificates.all().some((c) => canonicalEquals(c, certificate))) {
				ctx.certificates.record(certificate)
			}
		}
	})

/** Whether a subject is a query's read, as rows or by pages, which the CTE policy reads as a workload's. */
const queryRead = (subject: OptimizedSubject): boolean =>
	subject.kind === "query" || subject.kind === "page"

/**
 * How a subject's pages read its rows (lower/shapes/page/driver.ts): a page's driven by the driver its root meets, on
 * the physical analysis's keys and the catalog's containments in the compilation's context, its certificate recorded;
 * as they stand for every other subject and a page no driver drives.
 */
const pageWindow = (
	query: LogicalQuery,
	plan: DedupPlan,
	ctx: PassContext,
	subject: OptimizedSubject
): PageWindow => {
	const root = query.dag.roots[0]
	if (subject.kind !== "page" || root.kind !== "OrderedResult") {
		return asItStands
	}
	const driver = windowDriver(root, subject.order, {
		context: ctx.evidenceContext,
		containments: ctx.catalog.containments,
		unitOf: subject.unitOf,
		keyAmong: (base, fields) => {
			const key = keyAmong(plan.analysis.of(base).props, fields)
			return key === undefined
				? undefined
				: {
						columns: key.columns,
						grounds: { premises: key.just.premises, context: key.just.context }
					}
		}
	})
	if (driver === undefined) {
		return asItStands
	}
	ctx.certificates.record(unwrap(makeCertificate(driverCertificate(root, driver))))
	return { kind: "driven", driver }
}

/**
 * What the optimized delivery lowers: the query the rewrites left, its deduplication placement, its CTE plan, the
 * shape facts of its placement, the key sets its statements compute their nodes at, and how its pages' windows read
 * its rows.
 */
interface Planned {
	readonly query: LogicalQuery
	readonly plan: DedupPlan
	readonly cte: CtePlan
	readonly facts: ShapeFacts
	readonly keys: StatementKeys
	readonly window: PageWindow
}

/** The passes of the optimized lowering before its delivery, in their order (the header's 1 to 6). */
const planned = (
	input: OptimizedInput,
	ctx: PassContext,
	options: OptimizedOptions
): Result.Result<Planned, CompileError> => {
	const rewritten = rewritePipeline(options.subject.kind, input.analyses).run(input.query, ctx)
	if (!rewritten.ok) {
		return rewritten
	}
	const query = rewritten.value
	const placed = dedupPlacement.run({ dag: query.dag }, ctx)
	if (!placed.ok) {
		return placed
	}
	const plan = placed.value
	const policy = ctePolicyPass(queryRead(options.subject) ? "query" : "other", (node) =>
		defined(plan.realization[node.id], "every node's realization, the placement's")
	).run(query, ctx)
	if (!policy.ok) {
		return policy
	}
	const cte = policy.value.cte
	const facts = factsOf(plan, ctx, options)
	const window = pageWindow(query, plan, ctx, options.subject)
	/** A derived relation's definition wants every row: none of its nodes is computed at keys. */
	const keys =
		options.subject.kind === "derivedDefinition"
			? noKeys
			: queryKeys(query.dag, cte, facts.fixed, facts.realization, pagedReads(window))
	return Result.ok({ query, plan, cte, facts, keys, window })
}

/** The optimized delivery of the planned query, in a lowering context of its own, its statements' texts `text`'s. */
const delivery = <T extends StatementText>(
	p: Planned,
	options: OptimizedOptions,
	text: TextOf<T>
): OptimizedDelivery<never, never, T> => {
	const state = new ShapeState<RelationInput>("small", p.cte, p.keys)
	const lowering: ConservativeOptions = {
		names: options.names,
		params: p.query.params,
		/** A derived relation's definition lowers as a query. */
		subject:
			options.subject.kind === "derivedDefinition" || options.subject.kind === "page"
				? { kind: "query" }
				: options.subject
	}
	const dispatching = optimizedDispatch(p.facts, state)
	/**
	 * A node the statement computes once, its CTE (at its key set or whole) or a union or a fold in place at its key
	 * set, is read there by every read of it (computedAt).
	 */
	const cx = new LowerContext(
		p.query.dag,
		lowering,
		dispatching.dispatch,
		state.evaluationHolding,
		dispatching.carrying
	).withComputedAt(
		(node) =>
			p.keys.once.get(node.id)?.columns ??
			p.keys.inPlace.get(node)?.columns ??
			(state.strategy(node) === "materialized" ? [] : undefined)
	)
	return new OptimizedDelivery<never, never, T>(cx, p.facts, state, text)
}

/**
 * The optimized lowering of a checked query, as a pass: its one statement, in its forms, and its parts, each statement's
 * text `text`'s.
 */
const optimizedLowering = <T extends StatementText>(
	options: OptimizedOptions,
	text: TextOf<T>
): Pass<OptimizedInput, OptimizedProgram<T>> => ({
	name: "optimizedLowering",
	run: (input, ctx) =>
		Result.flatMap(planned(input, ctx, options), (p) =>
			Result.map(
				catchRefusal(() => delivery(p, options, text).optimizedProgram(p.query.dag.roots[0])),
				(delivered) => ({
					...delivered,
					query: p.query,
					plan: p.plan,
					cte: p.cte,
					keys: p.keys,
					window: p.window,
					certificates: ctx.certificates.all()
				})
			)
		)
})

/** What a compilation lowers under: its subject and names, the execution context and the catalog. */
interface CompilationOptions extends OptimizedOptions {
	/** The execution context the artifact is compiled for. */
	readonly context: TemplateContext
	/**
	 * The installed constraints behind declared keys and containments, named as ownership installs them: every pass of
	 * the compilation proves over this one catalog.
	 */
	readonly catalog: EvidenceCatalog
}

/**
 * What `lowerOptimized` lowers and prints: a query, a derived relation's definition, and a read-back placed as a
 * statement of its own; never a rule's judged query or a write filter's membership, which another statement always
 * composes (lowerComposed).
 */
export interface LowerOptimizedOptions extends CompilationOptions {
	readonly subject: Exclude<OptimizedSubject, RegionLowering | MembershipLowering>
}

/**
 * The query the optimized lowering lowers (`rewritePipeline`) in a fresh optimized context, without its lowering: what a
 * workload's access is read off (program/workload/compile.ts), so each path it requests is one the lowering's decisions
 * over this query seek by (physical/access/extract.ts), the same decisions over the same nodes.
 */
export const rewrittenQuery = (
	input: OptimizedInput,
	options: LowerOptimizedOptions
): Result.Result<LogicalQuery, CompileError> =>
	rewritePipeline(options.subject.kind, input.analyses).run(
		input.query,
		makePassContext({ evidenceContext: options.context, catalog: options.catalog })
	)

/** The optimized lowering in a fresh optimized context: the entry the differential suites and the program package use. */
export const lowerOptimized = (
	input: OptimizedInput,
	options: LowerOptimizedOptions
): Result.Result<OptimizedProgram, CompileError> => {
	const ctx = makePassContext({ evidenceContext: options.context, catalog: options.catalog })
	return optimizedLowering(options, emitText).run(input, ctx)
}

/**
 * A subject whose statement another statement composes, so it is never printed apart: a rule's judged query, read by
 * the judge's statement through the deltas' readers (physical/ddl/deltas.ts headed), each delta a CTE of its name no
 * statement holds; a write filter's membership, read in an EXISTS of the statement that asks it at its row, which it
 * names by that statement's alias; and a read-back riding its write's single statement, which reads the write's CTEs.
 */
export type ComposedSubject = RegionLowering | MembershipLowering | ReadBackLowering

/** What a composed statement is lowered under: the optimized lowering's options, its subject a composed one. */
export interface LowerComposedOptions extends CompilationOptions {
	readonly subject: ComposedSubject
}

/**
 * A query whose statement another statement composes, lowered as `lowerOptimized` lowers it, by the same passes and
 * the same delivery, each statement's text none (UnprintedSql): its names may be bound by the composing statement
 * alone, so a print of it apart would read names nothing binds (sql/scope.ts), and the composing statement is its one
 * print.
 */
export const lowerComposed = (
	input: OptimizedInput,
	options: LowerComposedOptions
): Result.Result<OptimizedProgram<UnprintedSql>, CompileError> => {
	const ctx = makePassContext({ evidenceContext: options.context, catalog: options.catalog })
	return optimizedLowering(options, unprintedText).run(input, ctx)
}
