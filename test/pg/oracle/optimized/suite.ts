import { maxOf } from "@bjornpagen/grizzle-text/base/array"
import type { Reached } from "@bjornpagen/testing/features"
import {
	type Aimed,
	aimed as aimedSpace,
	array,
	element,
	type Gen,
	int,
	type Space
} from "@bjornpagen/testing/gen"
import type {
	Budget,
	Case as PropertyCase,
	Kept as KeptToken,
	Kill,
	Oracle
} from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record, type Scope } from "effect"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { nativeEqualityKey, type OpId, type TypedLiteral } from "#compiler/ir/expr.ts"
import { Fold } from "#compiler/ir/fold.ts"
import {
	conservativeMeta,
	inputsOf,
	type NodeOf,
	type RelDag,
	type RelNode
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
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
import { correlatedChildUnderNestedAttachment, keySetSites } from "#test/support/key-sets.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import {
	baseTypeSpecs,
	bool,
	canonicallySpelled,
	int4,
	type SpelledValue,
	scalarOfSpec,
	spelledAt,
	valueClasses
} from "#test/support/oracle/gen/domain.ts"
import { aggregateOpId, aggregateResult, compareOpId } from "#test/support/oracle/gen/ops.ts"
import { normalQuery, queryExprs } from "#test/support/oracle/gen/query.ts"
import { type GenRelation, schemaName } from "#test/support/oracle/gen/schema.ts"
import { elementAt, nonEmptyList } from "#test/support/oracle/pick.ts"
import { literalOfValue } from "#test/support/oracle/reference/values.ts"
import { oracleProperty, type Placement, PropertyFailed } from "#test/support/oracle/runner.ts"
import { OracleSeat } from "#test/support/oracle/seat.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type AggregateSpec, Q } from "#test/unit/lower/conservative/fixtures.ts"

/** The kinds of optimized form a case runs (support.ts OptimizedForm). */
type OptimizedFormKind = OptimizedForm["kind"]

/**
 * What an optimized differential's case reaches: the certificate rules its optimized artifact rests on, the optimized
 * forms that ran, fused and pipelined attachments, heading groups, computed terms, a conservative run that delivered a
 * row, a parent key set read without DISTINCT, the per-evaluation shapes, a fold attached by a key the attachment pairs
 * with two parent columns, a relation parameter named from the parameter-name dictionary, and the shapes of the plans
 * its statements were given.
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
	| "a correlated child under a nested attachment"
	| "a key set read without DISTINCT"
	| "correlated take"
	| "correlated region"
	| "take over a union"
	| "a fold key correlated with two parent columns"
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
 * An operation that computes a value: one of the scalar catalogue's that is no comparison or connective. An
 * operation outside the catalogue is a span's relation (an Allen predicate), which compares.
 */
const computing = (op: OpId): boolean => {
	const native = nativeOp(op)
	return native !== undefined && !comparing.has(native.fn)
}

/** Whether a query computes a value: a cast, a conditional, or an operation of the scalar catalogue. */
const computes = (dag: RelDag): boolean =>
	Arr.some(
		queryExprs(dag),
		(e) => e.kind === "cast" || e.kind === "cond" || (e.kind === "op" && computing(e.op))
	)

/**
 * What a query evaluates per outer row, the per-evaluation facts a lowering must qualify: the deepest chain of
 * attachments, each the child of the one above it; whether a take correlated per parent bounds a subtree that holds an
 * attachment; whether an attachment's child that reads its parent holds an attachment of its own, whose parent key set
 * reads children keyed within one parent only (test/support/key-sets.ts correlatedChildUnderNestedAttachment); whether
 * any take is correlated; whether a region copies an outer column into a variable of its own; and whether a take bounds
 * a union, whose arms each deliver their own first rows.
 */
const evaluationShapes = (
	dag: RelDag
): {
	readonly depth: number
	readonly perParentTake: boolean
	readonly correlatedChild: boolean
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
		correlatedChild: correlatedChildUnderNestedAttachment(dag),
		correlatedTake: Arr.some(nodes, (n) => n.kind === "Take" && n.correlation.length > 0),
		correlatedRegion: Arr.some(nodes, (n) => n.kind === "MatchRegion" && n.correlated.length > 0),
		boundedUnion: Arr.some(nodes, (n) => n.kind === "Take" && n.input.kind === "Union")
	}
}

/**
 * Whether an Attach's child is a fold by every column it correlates, two of whose pairs name one child column: a Group
 * whose keys hold each correlated child column (lower/shapes/attach foldedByCorrelation, the fold the optimized
 * lowering restricts by its parent's values inside the grouping), with a key equal to two parent columns, so a parent
 * whose two columns differ has no group.
 */
const foldsKeyTwice = (attach: NodeOf<"Attach">): boolean => {
	const child = attach.child
	if (child.kind !== "Group" || child.keys.length === 0) {
		return false
	}
	const correlated = Arr.map(attach.correlation, (c) => c.child)
	return (
		Arr.every(correlated, (c) => child.keys.includes(c)) &&
		new Set(correlated).size < correlated.length
	)
}

/**
 * The features of one outcome: the certificate rules it rests on, the optimized forms that ran,
 * fused and pipelined attachments, heading groups, computed terms, whether the baseline delivered any row, a fold the
 * DAG the optimized statements lower attaches by a key it pairs with two parent columns (foldsKeyTwice), a relation
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
	if (Arr.some(keySetSites(o.optimizedProgram), (site) => !site.deduplicates)) {
		features.add("a key set read without DISTINCT")
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
	if (shapes.correlatedChild) {
		features.add("a correlated child under a nested attachment")
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
			topoOrder(o.optimizedProgram.query.dag),
			(n) => n.kind === "Attach" && foldsKeyTwice(n)
		)
	) {
		features.add("a fold key correlated with two parent columns")
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

/** The two orders an Attach of foldKeyTwiceCase states its pairs in: each a parent column paired with the fold's a. */
type ParentOrder = readonly ["a", "b"] | readonly ["b", "a"]

/** Both orders, which an aimed case draws between. */
const parentOrders: readonly [ParentOrder, ParentOrder] = [
	["a", "b"],
	["b", "a"]
]

/** The fold an aimed case attaches: its count. */
const counted: AggregateSpec = {
	name: "n",
	fn: "count",
	op: aggregateOpId("count", undefined),
	args: [],
	type: aggregateResult("count", undefined)
}

/**
 * The case "a fold key correlated with two parent columns" names: one relation R0(k integer, a T, b T) keyed by k,
 * holding `facts`, each an (a, b) pair stored at k its position, and every fact of R0 with the fold of R0 by a,
 * counted, attached on its a and its b, each equal to the fold's a, the pairs in the order `parents` states them. A
 * parent whose a and b differ natively has no group, since one key cannot equal both; one whose a and b agree has the
 * group of that value where a fact holds it as its a.
 */
export const foldKeyTwiceCase = (
	key: ScalarType,
	parents: ParentOrder,
	facts: ReadonlyArray<readonly [SpelledValue, SpelledValue]>
): QueryCase => {
	const r0: GenRelation = {
		name: "R0",
		columns: [
			{ name: "k", type: int4 },
			{ name: "a", type: key },
			{ name: "b", type: key }
		],
		primaryKey: ["k"],
		keys: [],
		mutable: false
	}
	const q = new Q()
	const base = (): RelNode =>
		q.base({ name: r0.name, heading: r0.columns, primaryKey: r0.primaryKey }, conservativeMeta)
	const parent = q.region([{ source: base(), bind: { k: "k", a: "a", b: "b" }, constants: {} }])
	const fold = q.group(
		q.region([{ source: base(), bind: { k: "k", a: "a" }, constants: {} }]),
		["k", "a"],
		["a"],
		[counted],
		conservativeMeta
	)
	const pairs = Arr.map(parents, (p) => [p, "a"] as const)
	const root = q.attach(parent, fold, "folded", pairs, "array", undefined)
	return {
		schema: { name: schemaName, relations: [r0], closed: [], containments: [] },
		facts: {
			R0: Arr.map(facts, ([a, b], k) => [canonicallySpelled(literalOfValue(BigInt(k), int4)), a, b])
		},
		query: { dag: normalQuery(q.b.build(Arr.of(root))), params: {} },
		spelling: { mode: "drawn", edge: false }
	}
}

/**
 * The key types an aimed fold draws: every base type of the generators' palette (gen/domain.ts baseTypeSpecs), each
 * with its value classes, one per value under native equality, where it has two.
 */
const foldKeys = nonEmptyList(
	Arr.flatMap(baseTypeSpecs, (spec) => {
		const type = scalarOfSpec(spec)
		const values = Arr.dedupeWith(
			valueClasses(type, false),
			(x: TypedLiteral, y: TypedLiteral) => nativeEqualityKey(x) === nativeEqualityKey(y)
		)
		return values.length >= 2 ? [{ type, values }] : []
	}),
	"the aimed fold's key types"
)

/**
 * A case foldKeyTwiceCase builds, drawn: a key type of the palette, the pairs' order, and R0's facts, each value in a
 * spelling of its own drawn: (x, y) and (y, y) for two values x and y native equality tells apart, then up to three
 * drawn (a, b) pairs. The first parent's a and b differ while the fold has a group at each of them, so a lowering that
 * restricts the fold by one of the two pairs alone delivers that parent the group the other pair excludes.
 */
const foldKeyTwiceGen: Gen<QueryCase> = (source) => {
	const key = source.draw(element(foldKeys))
	const count = key.values.length
	const pick = (i: number): TypedLiteral => elementAt(key.values, i, "the aimed fold's key values")
	const spelled = (literal: TypedLiteral): SpelledValue =>
		spelledAt(key.type, literal, source.draw(int(0, 3)))
	const xi = source.draw(int(0, count - 1))
	const x = pick(xi)
	const y = pick((xi + 1 + source.draw(int(0, count - 2))) % count)
	const parents = source.draw(element(parentOrders))
	const drawn = source.draw(
		array(
			(s): readonly [TypedLiteral, TypedLiteral] => [
				pick(s.draw(int(0, count - 1))),
				pick(s.draw(int(0, count - 1)))
			],
			{ min: 0, max: 3 }
		)
	)
	const facts = Arr.map(
		[[x, y] as const, [y, y] as const, ...drawn],
		([a, b]) => [spelled(a), spelled(b)] as const
	)
	return foldKeyTwiceCase(key.type, parents, facts)
}

/**
 * The case cte.notMaterialized names: one relation R0(k integer, a integer, b integer) keyed by k, holding `facts`,
 * each an (a, b) pair stored at k its position, and its join with itself where one row's a is another's b, read by
 * two filters, the pairs of one row with itself and those of two rows, the union of the two the query. The join of two sources is read twice and
 * by no reader per row of another, neither a region's occurrence nor a semi- or anti-join's right side, so the CTE
 * policy shares it NOT MATERIALIZED (rule 6): PostgreSQL may fold it into each filter. Since a workload's read reads
 * every shared join a region or a semi- or anti-join reads per row, materialized (rule 5b), the population's reads
 * seldom share one otherwise.
 */
const sharedJoinCase = (facts: ReadonlyArray<readonly [SpelledValue, SpelledValue]>): QueryCase => {
	const r0: GenRelation = {
		name: "R0",
		columns: [
			{ name: "k", type: int4 },
			{ name: "a", type: int4 },
			{ name: "b", type: int4 }
		],
		primaryKey: ["k"],
		keys: [],
		mutable: false
	}
	const q = new Q()
	const base = (): RelNode =>
		q.base({ name: r0.name, heading: r0.columns, primaryKey: r0.primaryKey }, conservativeMeta)
	const joined = q.region([
		{ source: base(), bind: { k: "k", a: "v" }, constants: {} },
		{ source: base(), bind: { k: "j", b: "v" }, constants: {} }
	])
	const compared = (op: "eq" | "ne") =>
		q.filter(joined, q.op(compareOpId(int4, op), [q.col(joined, "k"), q.col(joined, "j")], bool))
	const root = q.union([compared("eq"), compared("ne")], [])
	return {
		schema: { name: schemaName, relations: [r0], closed: [], containments: [] },
		facts: {
			R0: Arr.map(facts, ([a, b], k) => [canonicallySpelled(literalOfValue(BigInt(k), int4)), a, b])
		},
		query: { dag: normalQuery(q.b.build(Arr.of(root))), params: {} },
		spelling: { mode: "drawn", edge: false }
	}
}

/** A case sharedJoinCase builds, drawn: up to six (a, b) pairs of R0, each value one of three, in a spelling of its own. */
const sharedJoinGen: Gen<QueryCase> = (source) => {
	const values = valueClasses(int4, false)
	const pick = (s: typeof source): SpelledValue =>
		spelledAt(
			int4,
			elementAt(values, s.draw(int(0, Math.min(2, values.length - 1))), "an int4 value"),
			s.draw(int(0, 3))
		)
	return sharedJoinCase(source.draw(array((s) => [pick(s), pick(s)] as const, { min: 0, max: 6 })))
}

/**
 * The required situations the drawn populations seldom reach, each with the case built to reach it: a case whose turn
 * aims at one draws that case in place of the population's (resolved), the case it runs, prints and keeps. A suite
 * that does not require a situation never aims at it.
 */
export const optimizedAims: ReadonlyArray<readonly [OptimizedFeature, Gen<QueryCase>]> = [
	["a fold key correlated with two parent columns", foldKeyTwiceGen],
	["cte.notMaterialized", sharedJoinGen]
]

/** The oracle every optimized differential is checked against. */
const conservativeSets: Oracle = {
	kind: "second-implementation",
	name: "the conservative lowering's raw text sets, no repeated row on the optimized side"
}

/**
 * One case of the optimized differential (see differential): `c` run through every optimized form beside the
 * conservative baseline under `placement`, its outcome's features noted, and the case failed where the baseline
 * repeats a row, the forms disagree with it, or a key set read without DISTINCT repeats a key.
 */
const differentialOf = (c: QueryCase, placement: Placement, k: PropertyCase<OptimizedFeature>) =>
	Effect.gen(function* () {
		const o = yield* differentialCase(c, { ...plainDifferential, placement })
		k.noteAll(outcomeFeatures(o))
		if (!baselineIsSet(o)) {
			return yield* new PropertyFailed({
				report: `the conservative baseline repeats a row\n${printDifferential(o)}`
			})
		}
		if (!agrees(o)) {
			return yield* new PropertyFailed({ report: printDifferential(o) })
		}
		if (o.keySetRepeats.length > 0) {
			return yield* new PropertyFailed({
				report: `${Arr.join(o.keySetRepeats, "\n")}\n${printDifferential(o)}`
			})
		}
	})

/**
 * A population's space aimed at the situations the drawn populations seldom reach (aims): a case whose turn aims at
 * one draws the case built to reach it.
 */
export const optimizedSpace = (gen: Gen<QueryCase>): Aimed<QueryCase, OptimizedFeature> =>
	aimedSpace(gen, optimizedAims)

/**
 * The optimized differential as a property of the runner (runner.ts oracleProperty): `space`'s values, each resolved
 * to its case by `resolve` in the check (so a sketch prints and shrinks as itself), placed by `placing` in the case's
 * own database and run through differentialOf, with `situations` required and `kills`.
 */
export const differentialProperty = <S>(
	space: Space<S> | Aimed<S, OptimizedFeature>,
	resolve: (sketch: S) => QueryCase,
	placing: Effect.Effect<Placement, SqlError, Scope.Scope | OracleSeat>,
	spec: {
		readonly situations: ReadonlyArray<Reached<OptimizedFeature>>
		readonly kills: ReadonlyArray<Kill>
		readonly budget: Budget
		readonly kept: ReadonlyArray<KeptToken>
	}
) =>
	oracleProperty(space, {
		situations: spec.situations,
		perturb: "all",
		oracle: conservativeSets,
		kept: spec.kept,
		kills: spec.kills,
		budget: spec.budget,
		show: Formatter.format,
		check: (k: PropertyCase<OptimizedFeature>) => (sketch) =>
			Effect.flatMap(placing, (placement) => differentialOf(resolve(sketch), placement, k))
	})

/**
 * The multiplicity certificates of the mutant suite's five valid transformations: V1 retainedPrimaryKey, V2
 * combinedJoinKeys, V3 R02.existence, V5 R17.unionAll, V6 R17.recursiveTerms.
 */
export const validRewriteRules = [
	"R17.elide.retainedPrimaryKey",
	"R17.elide.combinedJoinKeys",
	"R02.existence",
	"R17.unionAll",
	"R17.recursiveTerms"
] as const satisfies ReadonlyArray<CertificateRule>

/**
 * The rewrite and placement rules a generated population of a few thousand cases reliably fires, so a suite whose
 * differential held also held for each of them, or that its aims reach (cte.notMaterialized, sharedJoinGen).
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
	"prune.heading",
	"cte.notMaterialized",
	"cte.materialized"
] as const satisfies ReadonlyArray<CertificateRule>

/**
 * The rewrite families the optimized population (generated.ts) is drawn to reach: elimination through a containment the
 * query reads, late fetch of wide payload under a take, every simplification a
 * checked query can meet, seed pushdown into a rooted closure, the take shapes, and the elisions that rest on one row
 * or on an exact deduplication. A filter directly over declared facts (simplify.finiteFold) is no checked query's
 * shape.
 */
export const rewriteFamilies = [
	"R03.elimination",
	"R06.lateFetch",
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
