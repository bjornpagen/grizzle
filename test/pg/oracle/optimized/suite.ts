import type { Draw, Explored, Run, SearchFailure } from "@grizzle/testing/explore"
import type { Gen } from "@grizzle/testing/gen"
import type { ShrinkBudget } from "@grizzle/testing/shrink"
import { Array as Arr, Effect, Record, type Scope } from "effect"
import { maxOf } from "#compiler/core/array.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { OpId } from "#compiler/ir/expr.ts"
import { Fold } from "#compiler/ir/fold.ts"
import { inputsOf, type RelDag, type RelNode } from "#compiler/ir/rel.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { nativeOp } from "#compiler/scalar/compute/registry.ts"
import {
	agrees,
	baselineIsSet,
	type DifferentialOutcome,
	differentialCase,
	type OptimizedForm,
	plainDifferential,
	printDifferential
} from "#test/pg/oracle/optimized/support.ts"
import { parameterNames } from "#test/support/kernel/dict.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { queryExprs } from "#test/support/oracle/gen/query.ts"
import { type CheckOptions, oracleCheck, PropertyFailed } from "#test/support/oracle/runner.ts"
import type { SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The kinds of optimized form a case runs (support.ts OptimizedForm). */
type OptimizedFormKind = OptimizedForm["kind"]

/**
 * What an optimized differential's case reaches: the certificate rules its optimized artifact rests on, the optimized
 * forms that ran, fused and pipelined attachments, heading groups, computed terms, a conservative run that delivered a
 * row, a relation parameter named from the parameter-name dictionary, and the shapes of the plans its statements were
 * given.
 */
export type OptimizedFeature =
	| CertificateRule
	| `form:${OptimizedFormKind}`
	| "fused attachment"
	| "nonempty"
	| "pipelined attachment"
	| "heading groups"
	| "computed term"
	| "nested attachment"
	| "nested attachment two deep"
	| "per-parent take over an attachment"
	| "correlated take"
	| "correlated region"
	| "take over a union"
	| "relation parameter named from the dictionary"
	| `plan node ${string}`
	| `plan ${string} under ${string}`

/**
 * The parameter-name dictionary (kernel/dict.ts): a page's own input names, reserved-looking spellings and the identifier
 * dictionary's names.
 */
const dictionaryNames: ReadonlySet<string> = new Set(parameterNames)

/** The comparisons and connectives a filter states, which compute nothing. */
const comparing: ReadonlySet<string> = new Set([
	"eq",
	"ne",
	"lt",
	"le",
	"gt",
	"ge",
	"and",
	"or",
	"not",
	"between",
	"in"
])

/**
 * An operation that computes a value: one of the Compute catalogue's that is no comparison or connective. An
 * operation outside the catalogue is a span's relation (an Allen predicate), which compares.
 */
const computing = (op: OpId): boolean => {
	const native = nativeOp(op)
	return native !== undefined && !comparing.has(native.fn)
}

/** Whether a query computes a value: a cast, a conditional, or an operation of the Compute catalogue. */
const computes = (dag: RelDag): boolean =>
	Arr.some(
		queryExprs(dag),
		(e) => e.kind === "cast" || e.kind === "cond" || (e.kind === "op" && computing(e.op))
	)

/**
 * What a query evaluates per outer row, the per-evaluation facts a lowering must qualify: the deepest chain of
 * attachments, each the child of the one above it; whether a take correlated per parent bounds a subtree that holds an
 * attachment; whether any take is correlated; whether a region copies an outer column into a variable of its own; and
 * whether a take bounds a union, whose arms each deliver their own first rows.
 */
const evaluationShapes = (
	dag: RelDag
): {
	readonly depth: number
	readonly perParentTake: boolean
	readonly correlatedTake: boolean
	readonly correlatedRegion: boolean
	readonly boundedUnion: boolean
} => {
	/** The deepest chain of attachments under each node: an attachment's child one deeper than the attachment. */
	const depth = new Fold<RelNode, number>(function* (node) {
		if (node.kind === "Attach") {
			const parent = yield node.parent
			const child = yield node.child
			return Math.max(parent, 1 + child)
		}
		const below: Array<number> = []
		for (const input of inputsOf(node)) {
			below.push(yield input)
		}
		return maxOf(below, 0)
	})
	const nodes = topoOrder(dag)
	return {
		depth: maxOf(
			Arr.map(dag.roots, (root) => depth.of(root)),
			0
		),
		perParentTake: Arr.some(
			nodes,
			(n) => n.kind === "Take" && n.correlation.length > 0 && depth.of(n.input) > 0
		),
		correlatedTake: Arr.some(nodes, (n) => n.kind === "Take" && n.correlation.length > 0),
		correlatedRegion: Arr.some(nodes, (n) => n.kind === "MatchRegion" && n.correlated.length > 0),
		boundedUnion: Arr.some(nodes, (n) => n.kind === "Take" && n.input.kind === "Union")
	}
}

/**
 * The features of one outcome: the certificate rules it rests on, the optimized forms that ran,
 * fused and pipelined attachments, heading groups, computed terms, whether the baseline delivered any row, a relation
 * parameter named from the dictionary, and the plans PostgreSQL chose for the statements the optimized forms sent:
 * each plan node by its type, and each node under its parent, labelled with its join type or aggregate strategy
 * (bench/harness/explain.ts planNodeTypes, planEdges). A plan feature names node types only, never a relation, an index, a cost
 * or a row estimate.
 */
const outcomeFeatures = (o: DifferentialOutcome): ReadonlyArray<OptimizedFeature> => {
	const features = new Set<OptimizedFeature>()
	for (const c of o.certificates) {
		features.add(c.rule)
	}
	for (const r of o.optimized) {
		features.add(`form:${r.form.kind}`)
	}
	if (o.fusedAttachments > 0) {
		features.add("fused attachment")
	}
	if (Arr.some(o.conservative.statements, (s) => s.rows.length > 0)) {
		features.add("nonempty")
	}
	if (Arr.some(flight(o.optimizedProgram.roots), (s) => s.role.kind === "attachment")) {
		features.add("pipelined attachment")
	}
	if (o.optimizedProgram.delivery.kind === "headingGroups") {
		features.add("heading groups")
	}
	if (computes(o.case.query.dag)) {
		features.add("computed term")
	}
	const shapes = evaluationShapes(o.case.query.dag)
	if (shapes.depth >= 2) {
		features.add("nested attachment")
	}
	if (shapes.depth >= 3) {
		features.add("nested attachment two deep")
	}
	if (shapes.perParentTake) {
		features.add("per-parent take over an attachment")
	}
	if (shapes.correlatedTake) {
		features.add("correlated take")
	}
	if (shapes.correlatedRegion) {
		features.add("correlated region")
	}
	if (shapes.boundedUnion) {
		features.add("take over a union")
	}
	if (
		Arr.some(
			Record.toEntries(o.case.query.params),
			([id, p]) => p.kind === "relation" && dictionaryNames.has(id)
		)
	) {
		features.add("relation parameter named from the dictionary")
	}
	for (const plan of o.plans) {
		for (const node of plan.nodes) {
			features.add(`plan node ${node}`)
		}
		for (const edge of plan.edges) {
			features.add(`plan ${edge.child} under ${edge.parent}`)
		}
	}
	return [...features]
}

/**
 * How far a failing case shrinks: every case runs on PostgreSQL, so shrinking a large case can take far longer than
 * finding it. Shrinking stops after this many candidates (deterministic, never wall time), at the smallest failing
 * case so far.
 */
export const optimizedShrink: ShrinkBudget = { kind: "bounded", candidates: 240 }

/**
 * The differential property every optimized suite runs, and the features it notes: at least 10,000 seeded cases per
 * CI run, optimized and conservative raw multisets equal, and no repeated row in the optimized output.
 *
 * A case passes when every optimized form (the program, each per-execution variant, the VALUES transport) delivers
 * exactly the conservative run's raw text multiset in every statement, repeats no row, and keeps the order of every
 * ordered delivery, and when db.explain's EXPLAIN plans every statement those forms sent; the conservative baseline
 * itself must repeat no row. A failing case shrinks and is reported in printable form with both programs' SQL and the
 * optimized certificates.
 *
 * Explores the draw's cases through the differential property, each sketch resolved to its case in the property, each
 * outcome's features noted through its case. Every case also plans each statement its optimized forms sent as
 * db.explain plans it, which fails the case where PostgreSQL refuses it, and the plan's shape joins the features, so
 * the residual risk counts the plans the population likely never met.
 */
export const differential = <S>(
	draw: Draw<S, Gen<QueryCase>>,
	label: string,
	check: CheckOptions<S, OptimizedFeature>
): Effect.Effect<Explored, SearchFailure | SqlError, Scope.Scope | Substrate | Run> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema({ create: false, label })
		return yield* oracleCheck(draw, check, (resolved, k) =>
			Effect.gen(function* () {
				const o = yield* differentialCase(k.draw(resolved), { ...plainDifferential, schema })
				/** A relation parameter named from the dictionary that the optimized VALUES form carries in the same case. */
				const reached = outcomeFeatures(o)
				k.noteAll(reached)
				if (
					reached.includes("form:optimized VALUES") &&
					reached.includes("relation parameter named from the dictionary")
				) {
					k.pair("form:optimized VALUES", "relation parameter named from the dictionary")
				}
				if (!baselineIsSet(o)) {
					return yield* new PropertyFailed({
						report: `the conservative baseline repeats a row\n${printDifferential(o)}`
					})
				}
				if (!agrees(o)) {
					return yield* new PropertyFailed({ report: printDifferential(o) })
				}
			})
		)
	})

/**
 * The multiplicity certificates of the mutant suite's six valid transformations: V1 retainedPrimaryKey, V2
 * combinedJoinKeys, V3 R02.existence, V4 R17.contribution, V5 R17.unionAll, V6 R17.recursiveTerms.
 */
export const validRewriteRules = [
	"R17.elide.retainedPrimaryKey",
	"R17.elide.combinedJoinKeys",
	"R02.existence",
	"R17.contribution",
	"R17.unionAll",
	"R17.recursiveTerms"
] as const satisfies ReadonlyArray<CertificateRule>

/**
 * The rewrite and placement rules a generated population of a few thousand cases reliably fires, so a suite whose
 * differential held also held for each of them.
 */
export const generatedRules = [
	...validRewriteRules,
	"R17.placement",
	"R17.elide.oneToOneJoin",
	"R17.elide.groupedOutputKey",
	"R17.elide.finiteFacts",
	"R17.elide.deduplicatedInput",
	"R17.elide.globalRecursiveClosure",
	"R01.fusion",
	"R02.semiJoin",
	"R02.antiJoin",
	"R07.finiteMembership",
	"prune.heading",
	"cte.notMaterialized",
	"cte.materialized"
] as const satisfies ReadonlyArray<CertificateRule>

/**
 * The rewrite families the optimized population (generated.ts) is drawn to reach: elimination through a containment the
 * query reads, late fetch of wide payload under a take, every predicate and semi-join movement, every simplification a
 * checked query can meet, seed pushdown into a rooted closure, the take shapes, and the elisions that rest on one row
 * or on an exact deduplication. A filter directly over declared facts (simplify.finiteFold) is no checked query's
 * shape.
 */
export const rewriteFamilies = [
	"R03.elimination",
	"R06.lateFetch",
	"pushdown.group",
	"pushdown.left",
	"pushdown.project",
	"pushdown.source",
	"pushdown.union",
	"pushdown.semiSource",
	"pushdown.semiGroup",
	"simplify.empty",
	"simplify.equality",
	"simplify.fold",
	"simplify.identityProjection",
	"simplify.mergeFilters",
	"simplify.mergeProjections",
	"graph.seedPushdown.constant",
	"graph.seedPushdown.filter",
	"graph.seedPushdown.region",
	"R20.distinctOn",
	"R20.lateral",
	"R20.rowNumber",
	"R17.elide.atMostOneRow",
	"R17.elide.exactDeduplication"
] as const satisfies ReadonlyArray<CertificateRule>
