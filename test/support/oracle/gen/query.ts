import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	proportional,
	span,
	weighted
} from "@grizzle/testing/gen"
import type { Source } from "@grizzle/testing/source"
import { fullSwarm, keep, type Swarm, weightOf } from "@grizzle/testing/swarm"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { AllenMask, fullAllenMask } from "#compiler/allen/mask.ts"
import { allenExpr } from "#compiler/check/allen.ts"
import { completeStatedOrders, type StatedOrder } from "#compiler/check/order.ts"
import { makeIdSupply, ParamId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { normalizeDag, relNode, rooted, topoOrder } from "#compiler/ir/dag.ts"
import {
	exprClosure,
	OpId,
	rangeOp,
	type ScalarExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import {
	type AggregateSpec,
	type CompletedOrder,
	conservativeMeta,
	exprsOf,
	type Heading,
	type HeadingColumn,
	inputsOf,
	type KindOver,
	type Occurrence,
	type RelDag,
	type RelNode,
	type RootedDag,
	type SpecRefs,
	type TakeBound,
	type VarDecl
} from "#compiler/ir/rel.ts"

import {
	baseOf,
	isRefined,
	type ScalarType,
	sameScalarType,
	spanCarrierOf,
	spanOf
} from "#compiler/ir/scalar.ts"
import { defined } from "#test/support/assert.ts"
import { parameterNames } from "#test/support/kernel/dict.ts"
import { liveOf, validateDag } from "#test/support/oracle/dag-validate.ts"
import {
	buildCompare,
	buildTerm,
	type CompareSketch,
	castChainSketchGen,
	compareSketchGen,
	isCastChain,
	type LowerHooks,
	type TermScope,
	type TermSketch,
	termSketchGen
} from "#test/support/oracle/gen/compute.ts"

import {
	bool,
	compareParamType,
	float8,
	floatSpecialSketches,
	hasCap,
	int4,
	int8,
	typedLiteralDesc,
	resolveValue,
	type Spelling,
	textFlavor,
	type ValueSketch
} from "#test/support/oracle/gen/domain.ts"
import { type LiteralRow, type RowSketch, rowSketchGen } from "#test/support/oracle/gen/facts.ts"
import {
	aggregateApplies,
	aggregateOpId,
	aggregateResult,
	andOp,
	compareOpId,
	compareOps,
	type GenAggregate,
	genAggregates,
	notOp,
	orOp
} from "#test/support/oracle/gen/ops.ts"

import {
	closedHeading,
	type GenContainment,
	type GenRelation,
	type GenSchema,
	relationHeading,
	relationNamed,
	valueSketchGen
} from "#test/support/oracle/gen/schema.ts"
import { at, cyclicAt, elementAt, nonEmptyList, indices } from "#test/support/oracle/pick.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"

type SourceSketch =
	| { readonly tag: "relation"; readonly pick: number }
	| { readonly tag: "closed"; readonly pick: number }
	| {
			readonly tag: "input"
			readonly columns: ReadonlyArray<number>
			readonly rows: ReadonlyArray<RowSketch>
	  }
	| { readonly tag: "query"; readonly query: QuerySketch }
	| { readonly tag: "follow"; readonly pick: number }

/**
 * How one source column enters a region: mode 0-4 a fresh variable, 5-6 a variable of the region already bound to a
 * column of the same type (a join), 7 left unbound (an existential witness), 8 fixed to a literal, 9 to a parameter.
 */
export interface BindSketch {
	readonly mode: number
	readonly pick: number
	readonly value: ValueSketch
}

export interface OccurrenceSketch {
	readonly source: SourceSketch
	readonly columns: ReadonlyArray<BindSketch>
}

type RhsSketch =
	| { readonly tag: "column"; readonly pick: number }
	| { readonly tag: "literal"; readonly value: ValueSketch }
	| { readonly tag: "param"; readonly value: ValueSketch }

type PredSketch =
	| {
			readonly tag: "compare"
			readonly column: number
			readonly op: number
			readonly rhs: RhsSketch
	  }
	| { readonly tag: "and" | "or"; readonly args: ReadonlyArray<PredSketch> }
	| { readonly tag: "not"; readonly arg: PredSketch }
	| { readonly tag: "const"; readonly value: boolean }
	| { readonly tag: "term"; readonly compare: CompareSketch }
	| { readonly tag: "equate"; readonly left: number; readonly right: number }
	| {
			readonly tag: "allen"
			readonly column: number
			readonly mask: number
			readonly rhs: RhsSketch
	  }
	| {
			readonly tag: "endpoint"
			readonly column: number
			readonly upper: boolean
			readonly op: number
			readonly rhs: RhsSketch
			readonly rhsUpper: boolean
	  }

/** A sketch part a population draws, or none where it leaves the part out. */
export type Drawn<A> = { readonly kind: "none" } | { readonly kind: "drawn"; readonly value: A }

/** The part a population leaves out. */
export const undrawn: Drawn<never> = { kind: "none" }

/** A part drawn always. */
export const drawnGen = <A>(generator: Gen<A>): Gen<Drawn<A>> =>
	map(generator, (value): Drawn<A> => ({ kind: "drawn", value }))

/** A part drawn four times in five, shrinking toward none. */
const sometimesGen = <A>(generator: Gen<A>): Gen<Drawn<A>> =>
	weighted<Drawn<A>>([
		[1, constant(undrawn)],
		[4, drawnGen(generator)]
	])

/** A part drawn wherever `drawn`, and never otherwise. */
const drawnWhere = <A>(drawn: boolean, generator: Gen<A>): Gen<Drawn<A>> =>
	drawn ? drawnGen(generator) : constant(undrawn)

/**
 * A projected column: an input column, a literal of one of the schema's types, or a computed term where the
 * configuration computes.
 */
interface OutSketch {
	readonly literal: boolean
	readonly pick: number
	readonly value: ValueSketch
	readonly term: Drawn<TermSketch>
}

interface AggSketch {
	readonly fn: number
	readonly column: number
}

/**
 * Generated checked queries: well-scoped relational DAGs over a generated schema.
 *
 * A query is generated as a sketch, a tree of plain numbers and tags, and resolved against the schema, under the case's
 * swarms, whose thinning decisions it draws from the case's tape, by a resolver that records nodes and expressions
 * through DagBuilder, so the result is the LogicalQuery IR the checker
 * produces: every reference resolves, every variable is declared once, every expression reads only its
 * node's input, every heading is the one its kind defines, every order is total, and the DAG validates. Each choice in
 * the sketch is reduced modulo what the resolver has in scope (the columns of an input, the variables of a region of
 * one type), and a choice with nothing to choose from degrades to a simpler valid form, so every sketch resolves and
 * shrinking any number toward zero keeps the case valid and makes it smaller.
 *
 * The fragment is the one the conservative lowering covers and the mutant suite's counterexamples need:
 *
 * - match: a region of one to three occurrences over stored relations, closed rosters, relation parameters and
 *   imported queries, whose columns are bound to fresh variables, joined through a shared variable, left existential,
 *   or fixed to a literal or a parameter (only bound variables contribute);
 * - filter over comparisons, AND, OR and NOT; project, including the projections that drop keys and collapse;
 *   semi- and anti-join; union of same-heading arms, optionally tagged by a literal column, which keeps them disjoint;
 *   intersection and difference;
 * - group, whose bound tuple may be a strict subset of its input's heading, so the distinct bound tuple, not the input
 *   rows, is what is folded; aggregate-only groups;
 * - take over a completed total order;
 * - closure, a linear recursive relation over the edges of any generated query, optionally acyclic; the richer
 *   recursive generator is recursive.ts;
 * - at the root: attachments, each with a chain of up to two attachments nested below its child, every level under
 *   its own per-parent take where drawn (the per-evaluation facts a nested attachment under a top-k child must
 *   qualify), or a heterogeneous union of heading groups with a literal discriminant;
 * - where the configuration asks for them (the optimizer's population, case.ts optimizerGenConfig): orders stated
 *   in part and completed as the checker completes them, occurrences that read through a declared containment,
 *   equations between two columns, closures read from one root, and filters read through a region.
 *
 * Metadata is conservativeMeta throughout: no logical key, cardinality many, so every claim the lowering could rely on
 * is one it must prove itself, and every attachment is delivered as an array, the widest sound type. A query that states
 * an order carries the logical metadata the checker records once it completes one, every node's claims the analysis's.
 */
export type QuerySketch =
	| {
			readonly tag: "match"
			readonly occurrences: ReadonlyArray<OccurrenceSketch>
			readonly equalities: ReadonlyArray<readonly [number, number]>
			/**
			 * Which earlier source a lateral constant or a correlated variable reads, where the soundness population
			 * draws them.
			 */
			readonly lateral: Drawn<number>
	  }
	| { readonly tag: "filter"; readonly input: QuerySketch; readonly pred: PredSketch }
	| { readonly tag: "project"; readonly input: QuerySketch; readonly out: ReadonlyArray<OutSketch> }
	| {
			readonly tag: "semi" | "anti"
			readonly left: QuerySketch
			readonly right: QuerySketch
			readonly on: ReadonlyArray<number>
			/** Which node already built the right side reads instead, where the soundness population shares nodes. */
			readonly shared: Drawn<number>
	  }
	| {
			readonly tag: "union"
			readonly arms: ReadonlyArray<QuerySketch>
			readonly width: number
			readonly picks: ReadonlyArray<number>
			readonly tagged: boolean
	  }
	| {
			readonly tag: "intersect" | "difference"
			readonly left: QuerySketch
			readonly right: QuerySketch
			readonly picks: ReadonlyArray<number>
	  }
	| {
			readonly tag: "group"
			readonly input: QuerySketch
			readonly full: boolean
			readonly boundMask: number
			readonly keyMask: number
			readonly aggs: ReadonlyArray<AggSketch>
	  }
	| ({
			readonly tag: "take"
			readonly input: QuerySketch
			readonly k: number
			readonly param: boolean
			/** Which earlier source a correlated take's key reads, where the soundness population draws one. */
			readonly lateral: Drawn<number>
	  } & OrderSketch)
	| {
			readonly tag: "window"
			readonly input: QuerySketch
			readonly fn: number
			readonly partition: number
			readonly column: number
			readonly rotate: number
	  }
	| {
			readonly tag: "approximate"
			readonly input: QuerySketch
			readonly k: number
			readonly score: ValueSketch
	  }
	| {
			readonly tag: "closure"
			readonly edge: QuerySketch
			readonly pair: number
			readonly acyclic: boolean
			/** How the closure is read from one root, where the configuration roots closures. */
			readonly root: Drawn<RootedSketch>
	  }

/**
 * How a closure is read from one root, where the configuration roots closures: its paths from the source `value`, by a
 * filter over the closure (form 0), by a region over it fixing the source to the value (form 1), or by a region over it
 * and a filter on the variable the source is bound to (form 2); the value a literal or a parameter.
 */
interface RootedSketch {
	readonly form: number
	readonly value: ValueSketch
	readonly param: boolean
}

/**
 * An order over a heading: every column, rotated by `rotate`, each descending where `dirs` says so. Where the
 * configuration states orders, the query states only the first 1 + `stated` of those keys and the checker's completion
 * over the logical keys supplies the rest (check/order.ts), so an order that reaches a key stops there.
 */
interface OrderSketch {
	readonly rotate: number
	readonly dirs: ReadonlyArray<boolean>
	readonly stated: Drawn<number>
}

/**
 * The first k child tuples of each parent tuple: a take inside the attachment, correlated with the
 * parent through the attachment's correlated columns, over the rest of the child's heading.
 */
interface ChildTakeSketch extends OrderSketch {
	readonly k: number
}

/**
 * An attachment below an attachment's child: its own child, its correlation with the level above, and its per-parent
 * take.
 */
interface NestedSketch {
	readonly child: QuerySketch
	readonly correlation: ReadonlyArray<number>
	readonly take: Drawn<ChildTakeSketch>
}

interface AttachSketch {
	readonly child: QuerySketch
	readonly correlation: ReadonlyArray<number>
	readonly take: Drawn<ChildTakeSketch>
	/** The attachments nested below the child, outermost first: the child's own, then that one's child's. */
	readonly nested: ReadonlyArray<NestedSketch>
}

interface HeteroGroupSketch {
	readonly arms: ReadonlyArray<QuerySketch>
	readonly width: number
	readonly picks: ReadonlyArray<number>
}

export type RootSketch =
	| {
			readonly tag: "plain"
			readonly body: QuerySketch
			readonly order: Drawn<OrderSketch>
	  }
	| {
			readonly tag: "attach"
			readonly body: QuerySketch
			readonly children: ReadonlyArray<AttachSketch>
	  }
	| { readonly tag: "hetero"; readonly groups: ReadonlyArray<HeteroGroupSketch> }

/**
 * The forms a query draws. `filterOver` is a filter directly over a stage the pushdown rules move a filter below or
 * into: a group, a union, a semi- or anti-join, an intersection or a difference. `semiOver` is a semi-join whose left
 * side is a group with keys, read through a region where regions are drawn: the stage pushdown.semiSource moves a
 * semi-join's comparison onto, and pushdown.semiGroup then below the group.
 */
const queryForms = [
	"match",
	"filter",
	"project",
	"semi",
	"anti",
	"union",
	"intersect",
	"difference",
	"group",
	"take",
	"closure",
	"window",
	"approximate",
	"filterOver",
	"semiOver"
] as const
type QueryForm = (typeof queryForms)[number]

const rootForms = ["plain", "attach", "hetero"] as const
type RootForm = (typeof rootForms)[number]

export interface QueryConfig {
	/** The deepest nesting of operators above the leaf regions. */
	readonly maxDepth: number
	/** Relative frequency of each form; 0 leaves it out. A match leaf is always available. */
	readonly weights: Readonly<Record<QueryForm, number>>
	readonly roots: Readonly<Record<RootForm, number>>
	/** Scalar parameters in comparisons, match constants and take bounds; relation parameters as match sources. */
	readonly params: boolean
	readonly inputSets: boolean
	readonly aggregates: ReadonlyArray<GenAggregate>
	/**
	 * "acyclic" filters every closure's edges to src < dst, so the graph has no cycle and a recursive UNION ALL (the
	 * diamond mutant) terminates; "any" lets the sketch decide.
	 */
	readonly closure: "any" | "acyclic"
	/**
	 * Relative frequency of computed terms (compute.ts) in projections and filters; 0 leaves computation out, so
	 * every expression is a column, a literal, a parameter or a comparison of them.
	 */
	readonly compute: number
	/** The most operations in one computed term. */
	readonly termDepth: number
	/**
	 * Whether every computed term is a chain of one or two casts over one input column (compute.ts castChainSketchGen),
	 * which a projection may deliver while dropping other columns: the population for the dedup proof's injective
	 * casts, where a cast that keeps every value lets a DISTINCT go and one that rounds or merges must keep it.
	 */
	readonly castChains: boolean
	/**
	 * Relative frequency of r.allen predicates in filters (a filter with no span column in scope degrades to a
	 * constant); 0 leaves them out.
	 */
	readonly allen: number
	/**
	 * Relative frequency of endpoint predicates between span columns in filters (a filter with no span column in scope
	 * degrades to a constant); 0 leaves them out.
	 */
	readonly endpoints: number
	/**
	 * Whether a computed term may be one that can fail on some value (an overflow, a division by zero, a NaN cast to an
	 * integer). Off, a place whose term can fail takes what it would take without computation, so every expression of
	 * the query is total and an execution error is a defect: the population of a runner that compares exact rows.
	 */
	readonly failing: boolean
	/**
	 * Whether takes and ordered roots state only a prefix of their order, which the checker completes over the logical
	 * keys of the relation they order (check/order.ts completeStatedOrders), so an order that reaches a key stops there
	 * and leaves the other columns unordered, and every node carries the logical metadata the checker records.
	 */
	readonly statedOrders: boolean
	/**
	 * Relative frequency of occurrences that read through a declared containment (the `follow` source); 0 leaves them
	 * out.
	 */
	readonly follow: number
	/** Relative frequency of imported queries among the sources of a region above the leaves. */
	readonly imported: number
	/** Relative frequency of equations between two columns among a filter's comparisons; 0 leaves them out. */
	readonly equate: number
	/** Whether closures may be read from one root (RootedSketch). */
	readonly rooted: boolean
	/**
	 * Whether a filter over a stage that is not a region may read it through a region binding its every column, as the
	 * checker builds a where over an imported query.
	 */
	readonly regions: boolean
	/**
	 * Whether a filter over a group with keys may compare its key columns only, the shape pushdown.group moves below
	 * the group.
	 */
	readonly groupFilter: boolean
	/**
	 * Whether the analysis soundness population's shapes are drawn (soundnessFeatures): constants that read an earlier
	 * occurrence's source, correlated variables and takes in a source an occurrence reads laterally, and a semi- or
	 * anti-join's right side shared with another reader. Window functions and approximate searches are forms of their
	 * own (`weights`, 0 by default), which the soundness swarm gates where it is drawn; no lowering need accept a
	 * window, which is for the analyses and the reference evaluator.
	 */
	readonly soundness: boolean
	/**
	 * How the parameters the query mints are named: p<n> for a scalar and r<n> for a relation ("numbered"), or each the
	 * parameter-name dictionary's name (kernel/dict.ts parameterNames) its sketch pick selects among those the case has
	 * not taken, the numbered name once every dictionary name is taken ("dictionary").
	 */
	readonly paramNames: "numbered" | "dictionary"
}

export const defaultQueryConfig: QueryConfig = {
	maxDepth: 3,
	weights: {
		match: 3,
		filter: 3,
		project: 3,
		semi: 2,
		anti: 2,
		union: 2,
		intersect: 1,
		difference: 1,
		group: 3,
		take: 2,
		closure: 1,
		window: 0,
		approximate: 0,
		filterOver: 0,
		semiOver: 0
	},
	roots: { plain: 6, attach: 2, hetero: 1 },
	params: true,
	inputSets: true,
	aggregates: genAggregates,
	closure: "any",
	compute: 0,
	termDepth: 2,
	castChains: false,
	allen: 0,
	endpoints: 0,
	failing: true,
	statedOrders: false,
	follow: 0,
	imported: 2,
	equate: 0,
	rooted: false,
	regions: false,
	groupFilter: false,
	soundness: false,
	paramNames: "numbered"
}

/**
 * The features a case's swarm turns on or off and thins: every operator form but the match leaf, the root
 * forms beyond a plain set, the match sources beyond a stored relation, the ways a region binds a column beyond a fresh
 * variable, scalar parameters, and computed terms.
 */
export const queryFeatures = [
	"filter",
	"project",
	"semi",
	"anti",
	"union",
	"intersect",
	"difference",
	"group",
	"take",
	"closure",
	"attach",
	"hetero",
	"closed",
	"input",
	"imported",
	"joins",
	"existentials",
	"constants",
	"params",
	"compute",
	"ordered"
] as const
export type QueryFeature = (typeof queryFeatures)[number]

/**
 * The features of a second swarm, drawn only where the configuration enables one of them, so a configuration without
 * them draws exactly the cases it drew before they existed: stated orders, occurrences that follow a containment,
 * equations between columns, rooted closures, filters read through a region, and filters over a group's keys.
 */
export const rewriteFeatures = [
	"stated",
	"follow",
	"equate",
	"rooted",
	"regions",
	"groupFilter"
] as const
export type RewriteFeature = (typeof rewriteFeatures)[number]

/**
 * The features of a third swarm, drawn only where the configuration draws the soundness population, so every other
 * configuration draws exactly the cases it drew before they existed.
 */
export const soundnessFeatures = [
	"lateral",
	"correlated",
	"correlated take",
	"shared",
	"window",
	"approximate"
] as const
export type SoundnessFeature = (typeof soundnessFeatures)[number]

/** The swarms that turn every feature on at full weight: a resolution without swarm testing. */
export const fullQuerySwarm: Swarm<QueryFeature> = fullSwarm(queryFeatures)
export const fullRewriteSwarm: Swarm<RewriteFeature> = fullSwarm(rewriteFeatures)
export const fullSoundnessSwarm: Swarm<SoundnessFeature> = fullSwarm(soundnessFeatures)

/** Whether a configuration enables a feature of the second swarm. */
export const rewriteSwarmed = (config: QueryConfig): boolean =>
	config.statedOrders ||
	config.follow > 0 ||
	config.equate > 0 ||
	config.rooted ||
	config.regions ||
	config.groupFilter

/**
 * A built DAG in normal form (ir/dag.ts normalizeDag), live again and validated: what a generated or planted case holds
 * (GenQuery.dag), its labels allocation-independent. A DAG that does not normalize, or holds no root, is a defect of the
 * code that built it, never of a case.
 */
export const normalQuery = (dag: RelDag): RootedDag => {
	const normal = normalizeDag(dag)
	if (!normal.ok) {
		throw new Error(`could not normalize a built DAG: ${normal.error.message}`)
	}
	const [first, ...rest] = liveOf(normal.value).dag.roots
	if (first === undefined) {
		throw new Error("a built DAG of no root")
	}
	return validateDag(rooted([first, ...rest]))
}

/** Every expression a query's DAG holds, each once: its nodes' expressions and their arguments at any depth. */
export const queryExprs = (dag: RelDag): ReadonlyArray<ScalarExpr> =>
	exprClosure(Arr.flatMap(topoOrder(dag), (node) => exprsOf(node)))

export type GenParam =
	| { readonly kind: "scalar"; readonly type: ScalarType; readonly value: TypedLiteral }
	| {
			readonly kind: "relation"
			readonly heading: Heading
			readonly rows: ReadonlyArray<LiteralRow>
	  }

export interface GenQuery {
	/**
	 * Normalized (dag.ts normalizeDag) and validated: one root, no unreachable entry, allocation-independent
	 * identifiers.
	 */
	readonly dag: RootedDag
	/** Every parameter the DAG reads, by ParamId, with the value the case binds. */
	readonly params: Readonly<Record<string, GenParam>>
}

/**
 * The parameters a generated query reads, declared as the checker declares them: a scalar at its type, a relation at
 * its heading, in name order.
 */
export const genParamDecls = (q: GenQuery): ReadonlyArray<ParamDecl> =>
	Arr.map(
		Arr.sort(
			Rec.toEntries(q.params),
			Order.mapInput(Order.String, ([name]: readonly [string, unknown]) => name)
		),
		([name, p]): ParamDecl =>
			p.kind === "scalar"
				? { id: ParamId(name), name, kind: "scalar", type: p.type }
				: { id: ParamId(name), name, kind: "relation", heading: p.heading }
	)

const bindGen: Gen<BindSketch> = (source) => ({
	mode: source.draw(int(0, 9)),
	pick: source.draw(int(0, 7)),
	value: source.draw(valueSketchGen)
})

const columnBindsWidth = 6

/**
 * Lists of one to `max` items, and now and then the empty list. A zero-column projection and an aggregate-free group
 * are meaningful, but a length drawn uniformly from zero would make them a large share of so short a list's population.
 */
const mostlyNonEmpty = <A>(item: Gen<A>, max: number): Gen<ReadonlyArray<A>> =>
	weighted([
		[8, array(item, { min: 1, max })],
		[1, constant([])]
	])

/**
 * One of several forms in proportion to their configured weights, a form of weight 0 left out, shrinking toward the
 * first form drawn at all.
 */
const weightedForms = <A>(
	entries: Arr.NonEmptyReadonlyArray<readonly [weight: number, generator: Gen<A>]>
): Gen<A> => {
	if (!Arr.some(entries, ([weight]) => weight > 0)) {
		throw new Error("no generator form is enabled")
	}
	return proportional(entries)
}

/**
 * A compared literal's value sketch: any value, and now and then a float special (negative zero, NaN, Infinity and
 * -Infinity, each as often), which resolves to that special over a float column and to some value of any other, so the
 * specials reach the lowerings' emitted text.
 */
const comparedValueGen: Gen<ValueSketch> = weighted([
	[4, valueSketchGen],
	[1, element(nonEmptyList(floatSpecialSketches, "the float special sketches"))]
])

/**
 * A query sketch's generators: `query(depth)`, for a depth up to the config's maxDepth, draws an operator tree at most
 * `depth` operators above its leaf regions, every tree drawn at one depth labelled as one span of that depth, so a
 * steered search splices a subtree only where a subtree of its depth was drawn, and `root` draws a whole root.
 */
export interface QueryGenerators {
	readonly query: (depth: number) => Gen<QuerySketch>
	readonly root: Gen<RootSketch>
}

export const queryGenerators = (config: QueryConfig): QueryGenerators => {
	const w = config.weights
	const picks = array(int(0, 7), { min: 1, max: 4 })
	/** A union's width: usually one to three columns, sometimes none, the zero-column relation. */
	const width = weighted([
		[8, int(1, 3)],
		[1, constant(0)]
	])

	const rhsGen: Gen<RhsSketch> = weightedForms<RhsSketch>([
		[3, (source) => ({ tag: "literal", value: source.draw(comparedValueGen) })],
		[2, (source) => ({ tag: "column", pick: source.draw(int(0, 7)) })],
		[config.params ? 1 : 0, (source) => ({ tag: "param", value: source.draw(valueSketchGen) })]
	])
	const compareGen: Gen<PredSketch> = (source) => ({
		tag: "compare",
		column: source.draw(int(0, 7)),
		op: source.draw(int(0, compareOps.length - 1)),
		rhs: source.draw(rhsGen)
	})
	const allenGen: Gen<PredSketch> = (source) => ({
		tag: "allen",
		column: source.draw(int(0, 7)),
		mask: source.draw(int(0, 8191)),
		rhs: source.draw(rhsGen)
	})
	const endpointGen: Gen<PredSketch> = (source) => ({
		tag: "endpoint",
		column: source.draw(int(0, 7)),
		upper: source.draw(boolean),
		op: source.draw(int(0, compareOps.length)),
		rhs: source.draw(rhsGen),
		rhsUpper: source.draw(boolean)
	})
	const equateGen: Gen<PredSketch> = (source) => ({
		tag: "equate",
		left: source.draw(int(0, 7)),
		right: source.draw(int(0, 7))
	})
	const constGen: Gen<PredSketch> = (source) => ({ tag: "const", value: source.draw(boolean) })
	const connective = element(["and", "or"] as const)
	const predGen = (depth: number): Gen<PredSketch> =>
		depth === 0
			? weightedForms<PredSketch>([
					[5, compareGen],
					[config.equate, equateGen],
					[config.allen, allenGen],
					[config.endpoints, endpointGen],
					[1, constGen]
				])
			: weightedForms<PredSketch>([
					[4, compareGen],
					[config.equate, equateGen],
					[config.allen, allenGen],
					[config.endpoints, endpointGen],
					[
						1,
						(source) => ({
							tag: source.draw(connective),
							args: source.draw(array(predGen(depth - 1), { min: 2, max: 3 }))
						})
					],
					[1, (source) => ({ tag: "not", arg: source.draw(predGen(depth - 1)) })]
				])
	const termPred: Gen<PredSketch> = (source) => ({
		tag: "term",
		compare: source.draw(compareSketchGen(config.termDepth))
	})
	const pred =
		config.compute > 0
			? weightedForms<PredSketch>([
					[4, predGen(2)],
					[config.compute, termPred],
					[
						1,
						(source) => ({
							tag: source.draw(connective),
							args: source.draw(array(oneOf([termPred, predGen(0)]), { min: 2, max: 3 }))
						})
					]
				])
			: predGen(2)
	const term = config.castChains ? castChainSketchGen : termSketchGen(config.termDepth)
	/** An order's rotation and directions, and how many of its keys the query states where orders are stated. */
	const stated = drawnWhere(config.statedOrders, int(0, 3))
	const orderGen: Gen<OrderSketch> = (source) => ({
		rotate: source.draw(int(0, 7)),
		dirs: source.draw(array(boolean, { min: 0, max: 4 })),
		stated: source.draw(stated)
	})
	const childTakeGen: Gen<ChildTakeSketch> = (source) => ({
		...source.draw(orderGen),
		k: source.draw(int(0, 2))
	})

	const sourceGen = (depth: number): Gen<SourceSketch> =>
		weightedForms<SourceSketch>([
			[6, (source) => ({ tag: "relation", pick: source.draw(int(0, 7)) })],
			[config.follow, (source) => ({ tag: "follow", pick: source.draw(int(0, 7)) })],
			[2, (source) => ({ tag: "closed", pick: source.draw(int(0, 3)) })],
			[
				config.inputSets ? 1 : 0,
				(source) => ({
					tag: "input",
					columns: source.draw(array(int(0, 7), { min: 1, max: 3 })),
					rows: source.draw(array(rowSketchGen, { min: 0, max: 4 }))
				})
			],
			...(depth > 0
				? [
						[
							config.imported,
							map(query(depth - 1), (q): SourceSketch => ({ tag: "query", query: q }))
						] as const
					]
				: [])
		])

	const lateral = drawnWhere(config.soundness, pickGen)

	const matchGen = (depth: number): Gen<QuerySketch> => {
		const occurrence: Gen<OccurrenceSketch> = (source) => ({
			source: source.draw(sourceGen(depth)),
			columns: source.draw(array(bindGen, { min: columnBindsWidth, max: columnBindsWidth }))
		})
		const equality = (source: Source) => [source.draw(int(0, 7)), source.draw(int(0, 7))] as const
		return (source) => ({
			tag: "match",
			occurrences: source.draw(array(occurrence, { min: 1, max: 3 })),
			equalities: source.draw(array(equality, { min: 0, max: 1 })),
			lateral: source.draw(lateral)
		})
	}

	/** The operator trees at most `depth` operators above their leaf regions, each operator over a tree drawn by `sub`. */
	const over = (depth: number, sub: Gen<QuerySketch>): Gen<QuerySketch> => {
		const on = array(int(0, 15), { min: 0, max: 2 })
		const shared = drawnWhere(config.soundness, pickGen)
		const semiGen: Gen<QuerySketch> = (source) => ({
			tag: "semi",
			left: source.draw(sub),
			right: source.draw(sub),
			on: source.draw(on),
			shared: source.draw(shared)
		})
		const antiGen: Gen<QuerySketch> = (source) => ({
			tag: "anti",
			left: source.draw(sub),
			right: source.draw(sub),
			on: source.draw(on),
			shared: source.draw(shared)
		})
		const unionGen: Gen<QuerySketch> = (source) => ({
			tag: "union",
			arms: source.draw(array(sub, { min: 2, max: 3 })),
			width: source.draw(width),
			picks: source.draw(picks),
			tagged: source.draw(boolean)
		})
		const intersectGen: Gen<QuerySketch> = (source) => ({
			tag: "intersect",
			left: source.draw(sub),
			right: source.draw(sub),
			picks: source.draw(picks)
		})
		const differenceGen: Gen<QuerySketch> = (source) => ({
			tag: "difference",
			left: source.draw(sub),
			right: source.draw(sub),
			picks: source.draw(picks)
		})
		const aggregate: Gen<AggSketch> = (source) => ({
			fn: source.draw(int(0, 15)),
			column: source.draw(int(0, 7))
		})
		const groupGen: Gen<QuerySketch> = (source) => ({
			tag: "group",
			input: source.draw(sub),
			full: source.draw(boolean),
			boundMask: source.draw(int(0, 63)),
			keyMask: source.draw(int(0, 63)),
			aggs: source.draw(mostlyNonEmpty(aggregate, 2))
		})
		/**
		 * The stages a filterOver filters: a group four times and a union thrice as often as each set comparison.
		 */
		const staged = weighted<QuerySketch>([
			[4, groupGen],
			[3, unionGen],
			[1, semiGen],
			[1, antiGen],
			[1, intersectGen],
			[1, differenceGen]
		])
		const literalOut = weighted([
			[4, constant(false)],
			[1, constant(true)]
		])
		const outTerm = config.compute > 0 ? sometimesGen(term) : constant(undrawn)
		const out: Gen<OutSketch> = (source) => ({
			literal: source.draw(literalOut),
			pick: source.draw(int(0, 7)),
			value: source.draw(valueSketchGen),
			term: source.draw(outTerm)
		})
		const rooted = drawnWhere(config.rooted, (source) => ({
			form: source.draw(int(0, 2)),
			value: source.draw(valueSketchGen),
			param: source.draw(boolean)
		}))
		return weightedForms<QuerySketch>([
			[w.match, matchGen(depth)],
			[w.filter, (source) => ({ tag: "filter", input: source.draw(sub), pred: source.draw(pred) })],
			[
				w.filterOver,
				(source) => ({ tag: "filter", input: source.draw(staged), pred: source.draw(pred) })
			],
			[
				w.project,
				(source) => ({
					tag: "project",
					input: source.draw(sub),
					out: source.draw(mostlyNonEmpty(out, 3))
				})
			],
			[w.semi, semiGen],
			[
				w.semiOver,
				(source) => ({
					tag: "semi",
					left: source.draw(groupGen),
					right: source.draw(sub),
					on: source.draw(on),
					shared: source.draw(shared)
				})
			],
			[w.anti, antiGen],
			[w.union, unionGen],
			[w.intersect, intersectGen],
			[w.difference, differenceGen],
			[w.group, groupGen],
			[
				w.take,
				(source) => ({
					tag: "take",
					input: source.draw(sub),
					...source.draw(orderGen),
					k: source.draw(int(0, 2)),
					param: source.draw(boolean),
					lateral: source.draw(lateral)
				})
			],
			[
				w.window,
				(source) => ({
					tag: "window",
					input: source.draw(sub),
					fn: source.draw(pickGen),
					partition: source.draw(int(0, 63)),
					column: source.draw(pickGen),
					rotate: source.draw(int(0, 7))
				})
			],
			[
				w.approximate,
				(source) => ({
					tag: "approximate",
					input: source.draw(sub),
					k: source.draw(int(0, 2)),
					score: source.draw(valueSketchGen)
				})
			],
			[
				w.closure,
				(source) => ({
					tag: "closure",
					edge: source.draw(sub),
					pair: source.draw(int(0, 15)),
					acyclic: source.draw(boolean),
					root: source.draw(rooted)
				})
			]
		])
	}

	/** The levels of the tower by depth, 0 to maxDepth: the leaf regions, then each level's operators over the one below. */
	const levels: Array<Gen<QuerySketch>> = [span("query 0", matchGen(0))]
	for (let depth = 1; depth <= config.maxDepth; depth++) {
		levels.push(
			span(`query ${depth}`, over(depth, elementAt(levels, depth - 1, "the level below")))
		)
	}
	const query = (depth: number): Gen<QuerySketch> =>
		elementAt(levels, depth, "the query generators' levels")

	const top = query(config.maxDepth)
	const child = query(Math.max(0, config.maxDepth - 1))
	const correlation = array(int(0, 15), { min: 1, max: 2 })
	const take = sometimesGen(childTakeGen)
	const nested: Gen<NestedSketch> = (source) => ({
		child: source.draw(child),
		correlation: source.draw(correlation),
		take: source.draw(take)
	})
	const attached: Gen<AttachSketch> = (source) => ({
		child: source.draw(child),
		correlation: source.draw(correlation),
		take: source.draw(take),
		nested: source.draw(array(nested, { min: 0, max: 2 }))
	})
	const heteroGroup: Gen<HeteroGroupSketch> = (source) => ({
		arms: source.draw(array(child, { min: 1, max: 2 })),
		width: source.draw(width),
		picks: source.draw(picks)
	})
	const order = sometimesGen(orderGen)
	const root = weightedForms<RootSketch>([
		[
			config.roots.plain,
			(source) => ({ tag: "plain", body: source.draw(top), order: source.draw(order) })
		],
		[
			config.roots.attach,
			(source) => ({
				tag: "attach",
				body: source.draw(top),
				children: source.draw(array(attached, { min: 1, max: 2 }))
			})
		],
		[
			config.roots.hetero,
			(source) => ({ tag: "hetero", groups: source.draw(array(heteroGroup, { min: 2, max: 3 })) })
		]
	])
	return { query, root }
}

/**
 * The window functions the soundness population draws: those every input admits, and those that read a value column.
 */
const windowOrdinals = ["rowNumber", "rank", "denseRank", "count"] as const
const windowReaders = ["min", "max", "lag", "lead"] as const
const windowOps: Readonly<
	Record<(typeof windowOrdinals)[number] | (typeof windowReaders)[number], string>
> = {
	rowNumber: "row_number",
	rank: "rank",
	denseRank: "dense_rank",
	count: "count",
	min: "min",
	max: "max",
	lag: "lag",
	lead: "lead"
}

interface Built {
	readonly node: RelNode
	readonly heading: Heading
	/**
	 * The columns whose spelling PostgreSQL's arithmetic chooses rather than the case (computedSpelling), which the
	 * resolver keeps away from every merge.
	 */
	readonly computed: ReadonlySet<string>
}

const none: ReadonlySet<string> = new Set()

/** Whether projected arms carry an integer literal `tag` column, and its value for each arm. */
type ArmTag =
	| { readonly kind: "untagged" }
	| { readonly kind: "tagged"; readonly tag: (arm: number) => bigint }

const untagged: ArmTag = { kind: "untagged" }

/**
 * A text value outside the generated refinements ^.{0,2}$ and ^[a-c]{1,2}$ (domain.ts), which only a parameter can
 * carry.
 */
const outOfContract: TypedLiteral = { kind: "text", value: "abc" }

/**
 * Whether an aggregate's result is spelled by PostgreSQL's arithmetic rather than by the case (gen/domain.ts): a
 * numeric sum or avg takes the largest input display scale, or select_div_scale for avg, so sum('0.00', '1') is
 * '1.00', sum(int8 1) is '1' and avg(int4 1) is '1.00000000000000000000', whatever spelling the case gives its stored
 * numerics; a float sum or avg can turn -0 into 0. Such a value is natively equal to a case-spelled one of its type
 * and spelled differently, so wherever the two could merge (a set boundary, a group key, a join variable, a min or
 * max) PostgreSQL's plan would choose the surviving text. count, an integer sum (bigint), a money sum, min, max and the
 * boolean folds return values the case spelled or that have one spelling.
 */
const computedSpelling = (fn: GenAggregate, argType: ScalarType | undefined): boolean => {
	if (fn !== "sum" && fn !== "avg") {
		return false
	}
	const carrier = aggregateResult(fn, argType).carrier
	return carrier === "numeric" || carrier === "float4" || carrier === "float8"
}

const plain = (c: HeadingColumn, computed: ReadonlySet<string>): boolean => !computed.has(c.name)

/**
 * Whether a computed value of `type` is spelled by PostgreSQL's arithmetic: a numeric's display scale follows its
 * operands and operations, and float arithmetic can produce -0.
 */
const arithmeticSpelling = (type: ScalarType): boolean =>
	type.carrier === "numeric" || type.carrier === "float4" || type.carrier === "float8"

const freshName = (base: string, taken: ReadonlySet<string>): string => {
	if (!taken.has(base)) {
		return base
	}
	for (let k = 2; ; k++) {
		if (!taken.has(`${base}_${k}`)) {
			return `${base}_${k}`
		}
	}
}

export const column = (name: string, type: ScalarType): HeadingColumn => ({ name, type })

/** The names a query's minted parameters take (QueryConfig.paramNames), every name once in the case. */
export class ParamNames {
	readonly #mode: QueryConfig["paramNames"]
	readonly #picks: ReadonlyArray<number>
	readonly #taken = new Set<string>()
	#scalars = 0
	#relations = 0

	constructor(mode: QueryConfig["paramNames"], picks: ReadonlyArray<number>) {
		this.#mode = mode
		this.#picks = picks
	}

	/** A fresh name for a scalar ("p") or relation ("r") parameter. */
	mint(prefix: "p" | "r"): ParamId {
		const free =
			this.#mode === "dictionary"
				? Arr.filter(parameterNames, (name) => !this.#taken.has(name))
				: []
		const [first, ...rest] = free
		let name =
			first === undefined
				? this.#numbered(prefix)
				: pickFrom(
						[first, ...rest],
						cyclicAt(this.#picks, this.#taken.size, "the parameter name picks")
					)
		while (this.#taken.has(name)) {
			name = this.#numbered(prefix)
		}
		this.#taken.add(name)
		return ParamId(name)
	}

	#numbered(prefix: "p" | "r"): string {
		return prefix === "p" ? `p${++this.#scalars}` : `r${++this.#relations}`
	}
}

/**
 * The resolution of one root sketch: the DAG it builds, the parameters it mints, and the case's tape, which its swarms'
 * thinning decisions are drawn from.
 */
class QueryResolver {
	readonly b = new DagBuilder(makeIdSupply())
	readonly params: Record<string, GenParam> = {}
	readonly schema: GenSchema
	readonly spelling: Spelling
	readonly config: QueryConfig
	readonly swarm: Swarm<QueryFeature>
	readonly rewrite: Swarm<RewriteFeature>
	readonly soundness: Swarm<SoundnessFeature>
	/**
	 * The sources earlier occurrences read, while the source of a later occurrence of their region resolves: what a
	 * lateral source may read.
	 */
	#lateral: ReadonlyArray<Built> = []
	/** Every node built outside a lateral source, which a later reader may share. */
	readonly #built: Array<Built> = []
	/**
	 * The parents of the attachment child being built, at every level of its chain: the root's body and each nested
	 * level's child above it, whose columns the child's take reads.
	 */
	#parent: ReadonlyArray<RelNode> = []
	/** Every column type of the schema, for literal outputs and relation-parameter headings. */
	readonly types: ReadonlyArray<ScalarType>
	/** The orders the query states, by the node they order, which resolveQuery completes as the checker does. */
	readonly stated = new Map<RelNode, StatedOrder>()
	readonly #names: ParamNames
	#closures = 0
	/** The value sketches of the parameters a term names before the type they adopt is known. */
	readonly #termParams = new Map<string, ValueSketch>()
	/** The expressions that can fail or are stable, which every operator over them inherits. */
	readonly #canFail = new Set<ScalarExpr>()
	readonly #stable = new Set<ScalarExpr>()

	readonly #source: Source

	constructor(
		source: Source,
		schema: GenSchema,
		spelling: Spelling,
		config: QueryConfig,
		swarm: Swarm<QueryFeature>,
		rewrite: Swarm<RewriteFeature>,
		soundness: Swarm<SoundnessFeature>,
		names: ReadonlyArray<number>
	) {
		this.#source = source
		this.schema = schema
		this.spelling = spelling
		this.config = config
		this.swarm = swarm
		this.rewrite = rewrite
		this.soundness = soundness
		this.#names = new ParamNames(config.paramNames, names)
		const types: Array<ScalarType> = []
		const add = (t: ScalarType) => {
			if (!Arr.some(types, (u) => sameScalarType(u, t))) {
				types.push(t)
			}
		}
		for (const r of schema.relations) {
			for (const c of r.columns) {
				add(c.type)
			}
		}
		for (const c of schema.closed) {
			for (const h of closedHeading(c)) {
				add(h.type)
			}
		}
		this.types = types
	}

	/** Whether `feature` appears at this place: always, never, or as the decision drawn under its weight says. */
	kept<F extends string>(swarm: Swarm<F>, feature: NoInfer<F>): boolean {
		return this.#source.draw(keep(swarm, feature))
	}

	col(node: RelNode, c: HeadingColumn): ScalarExpr {
		return this.b.expr({
			kind: "column",
			column: { node: node.id, name: c.name },
			args: [],
			type: c.type,
			nonNull: "storage"
		})
	}

	lit(value: TypedLiteral, type: ScalarType): ScalarExpr {
		return this.b.expr({
			kind: "literal",
			value,
			args: [],
			type,
			nonNull: "literal"
		})
	}

	/** A comparison parameter, bound as its base type: the generated text's refinement dropped. */
	scalarParam(operandType: ScalarType, value: TypedLiteral): ScalarExpr {
		const type = compareParamType(operandType)
		const param = this.#names.mint("p")
		this.params[param] = { kind: "scalar", type, value }
		return this.b.expr({
			kind: "param",
			param,
			role: "compare",
			args: [],
			type,
			nonNull: "codec"
		})
	}

	/** A compare operand: a parameter when parameters are on and the sketch asks for one, a literal otherwise. */
	operand(type: ScalarType, value: ValueSketch, asParam: boolean): ScalarExpr {
		const literal = resolveValue(type, value, this.spelling, "compare")
		if (!(asParam && this.config.params && this.kept(this.swarm, "params"))) {
			return this.lit(literal, type)
		}
		/**
		 * A parameter is bound as its base type, so it may carry a value outside the column's refinement, which
		 * compares unequal to every stored value and raises nothing.
		 * A refined text's out-of-contract value is three code points long, outside the generated short text's and the
		 * Code contract's patterns (unbounded text admits it); a contract over a number has no predicate here, so every
		 * value of its base is inside it.
		 */
		const outside =
			isRefined(type) &&
			baseOf(type).carrier === "text" &&
			textFlavor(type) !== "long" &&
			value.sp % 4 === 3
		return this.scalarParam(type, outside ? outOfContract : literal)
	}

	/** Computed terms (compute.ts) over `heading`, a heading of `node`. */
	termScope(heading: Heading): TermScope {
		return {
			heading,
			params: this.config.params && weightOf(this.swarm, "params") > 0,
			literal: (type, value) => ({
				kind: "literal",
				value: typedLiteralDesc(resolveValue(type, value, this.spelling, "compare"), type),
				type: undefined
			}),
			param: (value) => {
				const name = `t${this.#termParams.size + 1}`
				this.#termParams.set(name, value)
				return name
			}
		}
	}

	termHooks(node: RelNode): LowerHooks {
		return {
			emit: (spec) => this.b.expr(spec),
			column: (c) => ({
				kind: "column",
				column: { node: node.id, name: c.name },
				args: [],
				type: c.type,
				nonNull: "storage"
			}),
			param: (name, operandType) => {
				const type = compareParamType(operandType)
				const sketch = this.#termParams.get(name) ?? { cls: 0, sp: 0 }
				const param = this.#names.mint("p")
				this.params[param] = {
					kind: "scalar",
					type,
					value: resolveValue(type, sketch, this.spelling, "compare")
				}
				return {
					kind: "param",
					param,
					role: "compare",
					args: [],
					type,
					nonNull: "codec"
				}
			}
		}
	}

	/** Whether this place takes a computed term. */
	computes(): boolean {
		return this.config.compute > 0 && this.kept(this.swarm, "compute")
	}

	/** An operator node; it can fail when an operand can. */
	op(op: OpId, args: ReadonlyArray<ScalarExpr>, type: ScalarType): ScalarExpr {
		const canFail = Arr.some(args, (a) => this.#canFail.has(a))
		const id = this.b.expr({
			kind: "op",
			op,
			args,
			type,
			nonNull: "strict",
			volatility: Arr.some(args, (a) => this.#stable.has(a)) ? "stable" : "immutable",
			failure: canFail ? "canFail" : "total"
		})
		if (canFail) {
			this.#canFail.add(id)
		}
		if (Arr.some(args, (a) => this.#stable.has(a))) {
			this.#stable.add(id)
		}
		return id
	}

	/** Records what a computed term's root can do. */
	noteTerm(t: {
		readonly expr: ScalarExpr
		readonly canFail: boolean
		readonly stable: boolean
	}): ScalarExpr {
		if (t.canFail) {
			this.#canFail.add(t.expr)
		}
		if (t.stable) {
			this.#stable.add(t.expr)
		}
		return t.expr
	}

	source(s: SourceSketch): Built {
		const schema = this.schema
		if (s.tag === "closed" && schema.closed.length > 0 && this.kept(this.swarm, "closed")) {
			const closed = at(schema.closed, s.pick)
			const heading = closedHeading(closed)
			return {
				node: this.b.node({
					loc: undefined,
					meta: conservativeMeta,
					kind: "Closed",
					closed: closed.name,
					rows: closed.rows,
					heading
				}),
				heading,
				computed: none
			}
		}
		if (s.tag === "input" && this.config.inputSets && this.kept(this.swarm, "input")) {
			const heading = Arr.map(s.columns, (pick, i) => column(`i${i}`, at(this.types, pick)))
			const rows = Arr.map(s.rows, (r) =>
				Arr.map(heading, (c, i) =>
					resolveValue(
						c.type,
						cyclicAt(r.values, i, "a row sketch's values"),
						this.spelling,
						"stored"
					)
				)
			)
			const param = this.#names.mint("r")
			this.params[param] = { kind: "relation", heading, rows }
			return {
				node: this.b.node({
					loc: undefined,
					meta: conservativeMeta,
					kind: "InputSet",
					input: { kind: "declared", param },
					heading
				}),
				heading,
				computed: none
			}
		}
		if (s.tag === "query" && this.kept(this.swarm, "imported")) {
			return this.query(s.query)
		}
		return this.scan(at(schema.relations, s.tag === "input" || s.tag === "query" ? 0 : s.pick))
	}

	scan(relation: GenRelation): Built {
		const heading = relationHeading(relation)
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "Base",
			relation: relation.name,
			occurrence: this.b.ids.occurrence(),
			primaryKey: nonEmptyList(relation.primaryKey, "a primary key"),
			keys: Arr.map(relation.keys, (k) => nonEmptyList(k, "a candidate key")),
			relationKind: "relation",
			heading
		})
		return { node: id, heading, computed: none }
	}

	/**
	 * The containment a follow source reads through, when the configuration and the swarm draw one and the schema
	 * declares one.
	 */
	followed(s: SourceSketch): GenContainment | undefined {
		if (s.tag !== "follow" || this.config.follow <= 0 || this.schema.containments.length === 0) {
			return undefined
		}
		return this.kept(this.rewrite, "follow") ? at(this.schema.containments, s.pick) : undefined
	}

	/**
	 * A stated prefix of `order`, the order of the ordered node `ordered`, recorded for completion where the
	 * configuration states orders, with the relation the node orders, its columns fixed per evaluation, and the node with
	 * a completed order in place of its own (check/order.ts StatedOrder).
	 */
	stateOrder(
		ordered: RelNode,
		of: Pick<StatedOrder, "input" | "fixed" | "withOrder">,
		order: CompletedOrder,
		s: OrderSketch
	): void {
		if (s.stated.kind === "none" || !this.config.statedOrders || order.keys.length === 0) {
			return
		}
		if (!this.kept(this.rewrite, "stated")) {
			return
		}
		const keys = order.keys.slice(0, 1 + (s.stated.value % order.keys.length))
		this.stated.set(ordered, { keys, at: SourceLoc("a generated order", []), ...of })
	}

	/** A form the swarm leaves out degrades to its input, its left input, its first arm or its edges. */
	degrade(s: QuerySketch): Built {
		switch (s.tag) {
			case "match":
				return this.match(s)
			case "filter":
			case "project":
			case "group":
			case "take":
			case "window":
			case "approximate":
				return this.query(s.input)
			case "semi":
			case "anti":
			case "intersect":
			case "difference":
				return this.query(s.left)
			case "union":
				return this.query(elementAt(s.arms, 0, "a union's arms"))
			case "closure":
				return this.query(s.edge)
		}
	}

	/**
	 * A node built outside every lateral source reads nothing but its own subtree, so any later reader may share it.
	 */
	query(s: QuerySketch): Built {
		const built = this.form(s)
		if (this.config.soundness && this.#lateral.length === 0) {
			this.#built.push(built)
		}
		return built
	}

	form(s: QuerySketch): Built {
		if (s.tag === "window") {
			return this.kept(this.soundness, "window") ? this.window(s) : this.degrade(s)
		}
		if (s.tag === "approximate") {
			return this.kept(this.soundness, "approximate") ? this.approximate(s) : this.degrade(s)
		}
		if (s.tag !== "match" && !this.kept(this.swarm, s.tag)) {
			return this.degrade(s)
		}
		switch (s.tag) {
			case "match":
				return this.match(s)
			case "filter": {
				const inner = this.query(s.input)
				const keys = this.groupKeyed(inner)
				const input = keys === undefined ? this.regioned(inner) : inner
				const pred = this.pred(s.pred, keys === undefined ? input : { ...input, heading: keys })
				const id = this.b.node({
					loc: undefined,
					meta: conservativeMeta,
					kind: "Filter",
					input: input.node,
					pred,
					heading: input.heading
				})
				return { node: id, heading: input.heading, computed: input.computed }
			}
			case "project":
				return this.project(this.query(s.input), s.out)
			case "semi":
			case "anti": {
				const left = this.semiSourced(this.query(s.left))
				const right = Option.getOrElse(this.shared(s.shared), () => this.query(s.right))
				return this.semi(s.tag === "semi" ? "SemiJoin" : "AntiJoin", left, right, s.on)
			}
			case "union":
				return this.union(s)
			case "intersect":
			case "difference": {
				/**
				 * An intersection's row is a left row and a right row merged, so neither side brings a computed
				 * spelling; a difference returns left rows as they are.
				 */
				const first = this.query(s.left)
				const left = s.tag === "intersect" ? this.dropComputed(first) : first
				const right = this.conform(this.query(s.right), left.heading, s.picks, [])
				const kind = s.tag === "intersect" ? "Intersect" : "Difference"
				return {
					node: this.b.node({
						loc: undefined,
						meta: conservativeMeta,
						kind,
						left: left.node,
						right: right.node,
						heading: left.heading
					}),
					heading: left.heading,
					computed: left.computed
				}
			}
			case "group":
				return this.group(s)
			case "take":
				return this.take(s)
			case "closure":
				return this.closure(s)
		}
	}

	/**
	 * The key columns of `input` where it is a group with keys and the configuration and the swarm draw a filter over
	 * them: the predicate then compares those columns only, the shape pushdown.group moves below the group.
	 */
	groupKeyed(input: Built): Heading | undefined {
		if (!this.config.groupFilter || !this.kept(this.rewrite, "groupFilter")) {
			return undefined
		}
		const node = input.node
		if (node.kind !== "Group" || node.keys.length === 0) {
			return undefined
		}
		const keys = new Set(node.keys)
		return Arr.filter(input.heading, (c) => keys.has(c.name))
	}

	/**
	 * A semi- or anti-join's left side read through a region where it is a group with keys and the configuration and
	 * the swarm draw regions: the left side whose comparison pushdown.semiSource moves onto the group's occurrence, and
	 * pushdown.semiGroup then below the group where the comparison reads its keys alone.
	 */
	semiSourced(left: Built): Built {
		return left.node.kind === "Group" && left.node.keys.length > 0 ? this.regioned(left) : left
	}

	/**
	 * `input` read through a region that binds its every column to a variable of the column's name, where the
	 * configuration and the swarm draw one and it is no region already: the stage a checked where filters.
	 */
	regioned(input: Built): Built {
		if (
			!this.config.regions ||
			input.node.kind === "MatchRegion" ||
			!this.kept(this.rewrite, "regions")
		) {
			return input
		}
		return this.boundRegion(input, [])
	}

	/**
	 * `input` read through a region that binds its every column to a variable of the column's name, declaring besides
	 * the variables `correlated` copies a column of an enclosing region's earlier source into.
	 *
	 * Binding every column merges nothing, so the computed spellings pass through under their names; a copied
	 * column is case-spelled (lateralPick).
	 */
	boundRegion(
		input: Built,
		correlated: ReadonlyArray<{ readonly var: VarDecl; readonly expr: ScalarExpr }>
	): Built {
		const vars: ReadonlyArray<VarDecl> = [
			...Arr.map(input.heading, (c) => this.varOf(c.name, c)),
			...Arr.map(correlated, (c) => c.var)
		]
		const heading: Heading = Arr.map(vars, (v) => column(v.name, v.type))
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "MatchRegion",
			scope: this.b.ids.scope(),
			vars,
			occurrences: [
				{
					id: this.b.ids.occurrence(),
					source: input.node,
					bindings: Arr.map(input.heading, (c, i) => ({ column: c.name, var: at(vars, i) })),
					constants: []
				}
			],
			equalities: [],
			correlated: Arr.map(correlated, (c) => ({ var: c.var, expr: c.expr })),
			heading
		})
		return { node: id, heading, computed: input.computed }
	}

	/** A fresh variable `name` of the type of `c`. */
	varOf(name: string, c: HeadingColumn): VarDecl {
		return { id: this.b.ids.var(), name, type: c.type }
	}

	match(s: Extract<QuerySketch, { tag: "match" }>): Built {
		const vars: Array<VarDecl> = []
		const names = new Set<string>()
		const occurrences: Array<Occurrence> = []
		/**
		 * The variables bound to a column with a computed spelling: never joined, so no variable merges two columns.
		 */
		const computed = new Set<VarDecl>()
		const fresh = (c: HeadingColumn): VarDecl => {
			const name = freshName(c.name, names)
			names.add(name)
			const v: VarDecl = { id: this.b.ids.var(), name, type: c.type }
			vars.push(v)
			return v
		}
		/**
		 * The sources an enclosing region's earlier occurrences read, and those this region's earlier occurrences read,
		 * which a lateral source may read.
		 */
		const outer = this.#lateral
		const resolved: Array<Built> = []
		/**
		 * Every source but a follow source's is resolved first; a follow source scans its relations when its occurrence is
		 * bound, after the occurrences before it.
		 */
		const plans = Arr.map(
			s.occurrences,
			(
				o,
				index
			):
				| {
						readonly tag: "source"
						readonly source: Built
						readonly columns: ReadonlyArray<BindSketch>
				  }
				| {
						readonly tag: "follow"
						readonly through: GenContainment
						readonly columns: ReadonlyArray<BindSketch>
				  } => {
				const through = this.followed(o.source)
				if (through !== undefined) {
					return { tag: "follow", through, columns: o.columns }
				}
				this.#lateral = [...outer, ...resolved]
				const read = this.source(o.source)
				this.#lateral = outer
				const earlier = [...outer, ...resolved]
				const source =
					index >= 1 && resolved.length > 0
						? this.laterRegion(this.laterTake(read, earlier, o, s.lateral), earlier, s.lateral)
						: read
				resolved.push(source)
				return { tag: "source", source, columns: o.columns }
			}
		)
		/** The sources this region's occurrences read, in order, as they are placed. */
		const placed: Array<Built> = []
		/**
		 * An existential witness projects its column away, which merges the region's bindings that differ only there;
		 * a region over a computed spelling binds every column instead. A constant column needs no such care: it is
		 * natively one value in every binding.
		 */
		const witnesses = Arr.every(plans, (p) => p.tag === "follow" || p.source.computed.size === 0)
		/**
		 * One occurrence of `source`: a column in `fixed` bound to its variable, one in `fresh` to a fresh variable, and
		 * every other as its bind sketch says. Behind a containment (`through`), the target's columns past its key are
		 * left existential where the sketch would bind them fresh, so the occurrence often only tests that a target fact
		 * exists, which is what eliminating it rests on.
		 *
		 * An existential witness: the column left unbound.
		 */
		const occur = (
			source: Built,
			columns: ReadonlyArray<BindSketch>,
			fixed: ReadonlyMap<string, VarDecl>,
			freshColumns: ReadonlySet<string>,
			through: boolean
		): Occurrence => {
			const id = this.b.ids.occurrence()
			const bindings: Array<{ column: string; var: VarDecl }> = []
			const constants: Array<{ column: string; expr: ScalarExpr }> = []
			for (const [ci, c] of source.heading.entries()) {
				const forced = fixed.get(c.name)
				if (forced !== undefined) {
					bindings.push({ column: c.name, var: forced })
					continue
				}
				const bind = at(columns, ci)
				const sketched = bind.mode % 10
				const drawn = freshColumns.has(c.name)
					? 0
					: through && sketched < 5
						? 7
						: through && sketched === 7
							? 0
							: sketched
				const allowed =
					drawn === 7
						? this.kept(this.swarm, "existentials")
						: drawn === 8 || drawn === 9
							? this.kept(this.swarm, "constants")
							: drawn === 5 || drawn === 6
								? this.kept(this.swarm, "joins")
								: true
				const mode = allowed ? drawn : 0
				const spelled = plain(c, source.computed)
				if (mode === 7 && witnesses) {
					continue
				}
				if (mode === 8 || mode === 9) {
					/**
					 * A constant that reads an earlier occurrence's source, or a source an enclosing region's earlier
					 * occurrence reads: a value fixed per tuple of that source, never overall.
					 */
					const lateral = this.lateralColumn([...outer, ...placed], c.type, s.lateral, "lateral")
					if (lateral !== undefined) {
						constants.push({ column: c.name, expr: lateral })
						continue
					}
					/**
					 * A constant is of its column's base type, and a parameter never of a refined one,
					 * so a refined column's constant is a literal.
					 */
					const asParam = mode === 9 && !isRefined(c.type)
					constants.push({ column: c.name, expr: this.operand(c.type, bind.value, asParam) })
					continue
				}
				if ((mode === 5 || mode === 6) && spelled) {
					const same = Arr.filter(vars, (v) => sameScalarType(v.type, c.type) && !computed.has(v))
					if (same.length > 0) {
						bindings.push({ column: c.name, var: at(same, bind.pick) })
						continue
					}
				}
				const v = fresh(c)
				if (!spelled) {
					computed.add(v)
				}
				bindings.push({ column: c.name, var: v })
			}
			const occurrence: Occurrence = { id, source: source.node, bindings, constants }
			occurrences.push(occurrence)
			placed.push(source)
			return occurrence
		}
		const unfixed = new Map<string, VarDecl>()
		const unforced = new Set<string>()
		for (const p of plans) {
			if (p.tag === "source") {
				occur(p.source, p.columns, unfixed, unforced, false)
				continue
			}
			/**
			 * The containment's source relation: an earlier occurrence binding every field of it, or a new one binding
			 * them to fresh variables; then its target, bound at its key to those variables.
			 */
			const c = p.through
			const from = relationNamed(this.schema, c.from.relation)
			const scans = (x: Occurrence): boolean =>
				x.source.kind === "Base" && x.source.relation === from.name
			const via = Option.getOrElse(
				Arr.findFirst(
					occurrences,
					(x) =>
						scans(x) && Arr.every(c.from.fields, (f) => Arr.some(x.bindings, (b) => b.column === f))
				),
				() => occur(this.scan(from), p.columns, unfixed, new Set(c.from.fields), false)
			)
			const fixed = new Map<string, VarDecl>()
			for (const [i, f] of c.to.fields.entries()) {
				const b = Arr.findFirst(via.bindings, (x) => x.column === c.from.fields[i])
				if (Option.isSome(b)) {
					fixed.set(f, b.value.var)
				}
			}
			occur(this.scan(relationNamed(this.schema, c.to.relation)), p.columns, fixed, unforced, true)
		}
		const equalities: Array<{ a: VarDecl; b: VarDecl }> = []
		for (const [i, j] of vars.length > 1 ? s.equalities : []) {
			const a = at(vars, i)
			const b = at(vars, j)
			const unbound =
				a !== b &&
				sameScalarType(baseOf(a.type), baseOf(b.type)) &&
				!Arr.some(equalities, (e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))
			if (unbound) {
				equalities.push({ a, b })
			}
		}
		/**
		 * A region an enclosing region's occurrence reads laterally may copy a column of that region's earlier source
		 * into a variable of its own, whose value is fixed per outer tuple only.
		 */
		const correlated: Array<{ var: VarDecl; expr: ScalarExpr }> = []
		const copied = this.lateralPick(outer, s.lateral, "correlated")
		if (copied !== undefined) {
			const v = fresh(copied.column)
			correlated.push({ var: v, expr: this.col(copied.source.node, copied.column) })
		}
		/** The region's heading is its complete binding: every variable it declares. */
		const heading: Heading = Arr.map(vars, (v) => column(v.name, v.type))
		const node = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "MatchRegion",
			scope: this.b.ids.scope(),
			vars,
			occurrences,
			equalities,
			correlated,
			heading
		})
		return {
			node,
			heading,
			computed: new Set(
				Arr.map(
					Arr.filter(vars, (v) => computed.has(v)),
					(v) => v.name
				)
			)
		}
	}

	pred(p: PredSketch, input: Built): ScalarExpr {
		switch (p.tag) {
			case "const":
				return this.lit({ kind: "bool", value: p.value }, bool)
			case "term": {
				const built = this.computes()
					? buildCompare(this.termScope(input.heading), this.termHooks(input.node), p.compare)
					: undefined
				return built === undefined || (built.canFail && !this.config.failing)
					? this.lit({ kind: "bool", value: p.compare.op % 2 === 0 }, bool)
					: this.noteTerm(built)
			}
			case "not":
				return this.op(notOp, [this.pred(p.arg, input)], bool)
			case "and":
			case "or": {
				const args = Arr.map(p.args, (a) => this.pred(a, input))
				const [only, ...others] = args
				if (only !== undefined && others.length === 0) {
					return only
				}
				return this.op(p.tag === "and" ? andOp : orOp, args, bool)
			}
			case "allen":
				return this.allen(p, input)
			case "endpoint":
				return this.endpoint(p, input)
			case "equate": {
				if (input.heading.length === 0 || !this.kept(this.rewrite, "equate")) {
					return this.lit({ kind: "bool", value: true }, bool)
				}
				const left = at(input.heading, p.left)
				const others = Arr.filter(
					input.heading,
					(c) => c.name !== left.name && sameScalarType(c.type, left.type)
				)
				const right = others.length > 0 ? at(others, p.right) : left
				return this.op(
					compareOpId(left.type, "eq"),
					[this.col(input.node, left), this.col(input.node, right)],
					bool
				)
			}
			case "compare": {
				if (input.heading.length === 0) {
					return this.lit({ kind: "bool", value: p.op % 2 === 0 }, bool)
				}
				const left = at(input.heading, p.column)
				const right =
					p.rhs.tag === "column"
						? this.col(
								input.node,
								at(
									Arr.filter(input.heading, (c) => sameScalarType(c.type, left.type)),
									p.rhs.pick
								)
							)
						: this.operand(left.type, p.rhs.value, p.rhs.tag === "param")
				const cmp = at(compareOps, p.op)
				return this.op(compareOpId(left.type, cmp), [this.col(input.node, left), right], bool)
			}
		}
	}

	/**
	 * r.allen(left, mask, right) as the checker lowers it, the IR's one spelling of a mask (check/allen.ts): its
	 * formula from the Allen table, each literal the range operator of its atom over the span columns (swapped when the
	 * atom reads B first), negated by NOT, each conjunction an AND and the formula an OR; the full mask is literally true.
	 */
	allen(p: Extract<PredSketch, { tag: "allen" }>, input: Built): ScalarExpr {
		const spans = Arr.filter(
			input.heading,
			(c) => c.type.carrier === "range4" || c.type.carrier === "range8"
		)
		if (spans.length === 0) {
			return this.lit({ kind: "bool", value: p.mask % 2 === 0 }, bool)
		}
		const leftColumn = at(spans, p.column)
		const left = this.col(input.node, leftColumn)
		const right =
			p.rhs.tag === "column"
				? this.col(
						input.node,
						at(
							Arr.filter(spans, (c) => sameScalarType(c.type, leftColumn.type)),
							p.rhs.pick
						)
					)
				: this.operand(leftColumn.type, p.rhs.value, p.rhs.tag === "param")
		const mask = AllenMask((p.mask % fullAllenMask) + 1)
		const carrier = defined(spanCarrierOf(leftColumn.type), "an Allen operand's span carrier")
		return allenExpr(mask, left, right, carrier, bool, (spec) => this.b.expr(spec))
	}

	/**
	 * An endpoint predicate over a span column, as the checker lowers r.lt(Compute.lower(a), Compute.upper(b)) and
	 * r.pointIn(Compute.lower(a), s): each endpoint the lower(anyrange) or upper(anyrange) node over its column, typed by
	 * the span's endpoint, the comparison the endpoint carrier's, and the membership range_contains_elem(span, point),
	 * whose span is a column of the carrier or, as a parameter or literal, takes the column's type.
	 */
	endpoint(p: Extract<PredSketch, { tag: "endpoint" }>, input: Built): ScalarExpr {
		const spans = Arr.filter(
			input.heading,
			(c) => c.type.carrier === "range4" || c.type.carrier === "range8"
		)
		if (spans.length === 0) {
			return this.lit({ kind: "bool", value: p.op % 2 === 0 }, bool)
		}
		const leftColumn = at(spans, p.column)
		const carrier = defined(spanCarrierOf(leftColumn.type), "an endpoint's span carrier")
		const endpointType = defined(spanOf(leftColumn.type), "a span column's endpoint").endpoint
		const rightColumn = at(
			Arr.filter(spans, (c) => spanCarrierOf(c.type) === carrier),
			p.rhs.tag === "column" ? p.rhs.pick : p.column
		)
		const endpoint = (headingColumn: HeadingColumn, upper: boolean): ScalarExpr =>
			this.op(
				rangeOp(upper ? "upper(anyrange)" : "lower(anyrange)", carrier),
				[this.col(input.node, headingColumn)],
				endpointType
			)
		const point = endpoint(leftColumn, p.upper)
		const cmp = compareOps[p.op]
		if (cmp !== undefined) {
			return this.op(
				compareOpId(endpointType, cmp),
				[point, endpoint(rightColumn, p.rhsUpper)],
				bool
			)
		}
		const within =
			p.rhs.tag === "column"
				? this.col(input.node, rightColumn)
				: this.operand(leftColumn.type, p.rhs.value, p.rhs.tag === "param")
		return this.op(rangeOp("range_contains_elem", carrier), [within, point], bool)
	}

	project(input: Built, out: ReadonlyArray<OutSketch>): Built {
		const taken = new Set<string>()
		const items: Array<{ name: string; expr: ScalarExpr }> = []
		const heading: Array<HeadingColumn> = []
		const computed = new Set<string>()
		/**
		 * A projection that keeps every input column is injective, so it merges nothing and a computed spelling may
		 * pass through it; any other projection merges the inputs that differ only in what it drops, and draws from
		 * the case-spelled columns alone.
		 */
		const picked = new Set(
			Arr.flatMap(out, (o) =>
				!o.literal && input.heading.length > 0 ? [at(input.heading, o.pick).name] : []
			)
		)
		const injective = Arr.every(input.heading, (c) => picked.has(c.name))
		const choices = injective
			? input.heading
			: Arr.filter(input.heading, (c) => plain(c, input.computed))
		for (const [i, o] of out.entries()) {
			if (o.term.kind === "drawn" && choices.length > 0 && this.computes()) {
				const t = buildTerm(this.termScope(choices), this.termHooks(input.node), o.term.value)
				/**
				 * A computed numeric or float is spelled by PostgreSQL's arithmetic (computedSpelling): two input rows
				 * that compute natively equal values of different spellings would merge here, so it is projected only
				 * where the projection keeps every input column and merges nothing.
				 * A cast chain over one case-spelled column spells each output by its input's class alone: two rows that
				 * meet in it hold natively equal values, which the case spells one way, or values a cast rounds or merges,
				 * whose output the target type spells one way. So it may be delivered where the projection merges.
				 */
				const chain = this.config.castChains && isCastChain(o.term.value)
				const spelledHere = t !== undefined && (injective || chain || !arithmeticSpelling(t.type))
				if (t !== undefined && spelledHere && (this.config.failing || !t.canFail)) {
					const name = freshName(`y${i}`, taken)
					taken.add(name)
					items.push({ name, expr: this.noteTerm(t) })
					heading.push(column(name, t.type))
					if (arithmeticSpelling(t.type)) {
						computed.add(name)
					}
					continue
				}
			}
			if (!o.literal && choices.length > 0) {
				const c = at(choices, o.pick)
				const name = freshName(c.name, taken)
				taken.add(name)
				items.push({ name, expr: this.col(input.node, c) })
				heading.push(column(name, c.type))
				if (input.computed.has(c.name)) {
					computed.add(name)
				}
				continue
			}
			const type = at(this.types, o.pick)
			const name = freshName(`x${i}`, taken)
			taken.add(name)
			items.push({
				name,
				expr: this.lit(resolveValue(type, o.value, this.spelling, "stored"), type)
			})
			heading.push(column(name, type))
		}
		return {
			node: this.b.node({
				loc: undefined,
				meta: conservativeMeta,
				kind: "ProjectSet",
				input: input.node,
				out: items,
				heading
			}),
			heading,
			computed
		}
	}

	/**
	 * `input` without its computed spellings: a projection onto its case-spelled columns, which merges nothing a
	 * computed spelling could tell apart.
	 */
	dropComputed(input: Built): Built {
		if (input.computed.size === 0) {
			return input
		}
		const heading = Arr.filter(input.heading, (c) => plain(c, input.computed))
		const items = Arr.map(heading, (c) => ({ name: c.name, expr: this.col(input.node, c) }))
		return {
			node: this.b.node({
				loc: undefined,
				meta: conservativeMeta,
				kind: "ProjectSet",
				input: input.node,
				out: items,
				heading
			}),
			heading,
			computed: none
		}
	}

	/** The column pairs of two inputs at one type, in a fixed order; `spelled` leaves out the computed spellings. */
	pairs(
		left: Built,
		right: Built,
		spelled: boolean
	): ReadonlyArray<{ readonly left: string; readonly right: string }> {
		const of = (b: Built) =>
			spelled ? Arr.filter(b.heading, (c) => plain(c, b.computed)) : b.heading
		return Arr.flatMap(of(left), (l) =>
			Arr.flatMap(of(right), (r) =>
				sameScalarType(l.type, r.type) ? [{ left: l.name, right: r.name }] : []
			)
		)
	}

	semi(kind: "SemiJoin" | "AntiJoin", left: Built, right: Built, on: ReadonlyArray<number>): Built {
		/** A semi- or antijoin compares, and returns left rows as they are: it merges nothing. */
		const candidates = this.pairs(left, right, false)
		const chosen: Array<{ left: string; right: string }> = []
		for (const pick of candidates.length > 0 ? on : []) {
			const p = at(candidates, pick)
			if (!Arr.some(chosen, (q) => q.left === p.left && q.right === p.right)) {
				chosen.push({ ...p })
			}
		}
		return {
			node: this.b.node({
				loc: undefined,
				meta: conservativeMeta,
				kind,
				left: left.node,
				right: right.node,
				on: chosen,
				heading: left.heading
			}),
			heading: left.heading,
			computed: left.computed
		}
	}

	/**
	 * A projection of `input` onto `target`'s names and types: each target column from a case-spelled input column of
	 * its type, or a literal of its type when the input has none; then the `extra` literal columns. Its rows meet
	 * other inputs' rows at a union or an intersection, so it never carries a computed spelling.
	 */
	conform(
		input: Built,
		target: Heading,
		picks: ReadonlyArray<number>,
		extra: ReadonlyArray<{ readonly column: HeadingColumn; readonly value: TypedLiteral }>
	): Built {
		const items: Array<{ name: string; expr: ScalarExpr }> = []
		for (const [k, t] of target.entries()) {
			const same = Arr.filter(
				input.heading,
				(c) => sameScalarType(c.type, t.type) && plain(c, input.computed)
			)
			const pick = at(picks, k)
			items.push({
				name: t.name,
				expr:
					same.length > 0
						? this.col(input.node, at(same, pick))
						: this.lit(resolveValue(t.type, { cls: pick, sp: 0 }, this.spelling, "stored"), t.type)
			})
		}
		for (const e of extra) {
			items.push({ name: e.column.name, expr: this.lit(e.value, e.column.type) })
		}
		const heading = [
			...Arr.map(target, (t) => column(t.name, t.type)),
			...Arr.map(extra, (e) => e.column)
		]
		return {
			node: this.b.node({
				loc: undefined,
				meta: conservativeMeta,
				kind: "ProjectSet",
				input: input.node,
				out: items,
				heading
			}),
			heading,
			computed: none
		}
	}

	/**
	 * The target heading of a union's arms: `width` columns of the first arm, at the picked positions, named x0, x1, ...
	 */
	armHeading(first: Heading, width: number, picks: ReadonlyArray<number>): Heading {
		if (first.length === 0) {
			return []
		}
		return Arr.map(indices(Math.min(width, first.length)), (k) =>
			column(`x${k}`, at(first, at(picks, k)).type)
		)
	}

	/** Projects each arm onto `target`, with an integer literal `tag` column where the arms are tagged. */
	arms(
		arms: ReadonlyArray<Built>,
		target: Heading,
		picks: ReadonlyArray<number>,
		tag: ArmTag
	): ReadonlyArray<Built> {
		return Arr.map(arms, (arm, i) =>
			tag.kind === "untagged"
				? this.conform(arm, target, picks, [])
				: this.conform(arm, target, picks, [
						{ column: column("tag", int4), value: { kind: "int", value: tag.tag(i) } }
					])
		)
	}

	union(s: Extract<QuerySketch, { tag: "union" }>): Built {
		const arms = Arr.map(s.arms, (a) => this.query(a))
		const target = this.armHeading(elementAt(arms, 0, "a union's arms").heading, s.width, s.picks)
		const projected = this.arms(
			arms,
			target,
			s.picks,
			s.tagged ? { kind: "tagged", tag: (i) => BigInt(i) } : untagged
		)
		const heading = elementAt(projected, 0, "a union's projected arms").heading
		const ids = Arr.map(projected, (p) => p.node)
		return {
			node: this.b.node({
				loc: undefined,
				meta: conservativeMeta,
				kind: "Union",
				groups: [{ heading, arms: nonEmptyList(ids, "a union's projected arms") }],
				discriminant: [],
				heading
			}),
			heading,
			computed: none
		}
	}

	/** min and max return one of their arguments, merging the equal ones. */
	group(s: Extract<QuerySketch, { tag: "group" }>): Built {
		const input = this.query(s.input)
		const h = input.heading
		/**
		 * The distinct bound tuples merge the input rows that agree on them, unless the bound tuple is the whole
		 * heading, and a group key merges the tuples it groups: a computed spelling is bound only in a whole heading
		 * and is never a key.
		 */
		const picked = Arr.flatMap(h, (headingColumn, i) =>
			s.full || ((s.boundMask >> i) & 1) === 1 ? [headingColumn] : []
		)
		const bound =
			picked.length === h.length ? picked : Arr.filter(picked, (c) => plain(c, input.computed))
		const keys = Arr.filter(
			bound,
			(c, i) => ((s.keyMask >> i) & 1) === 1 && plain(c, input.computed)
		)
		const taken = new Set(Arr.map(keys, (k) => k.name))
		const enabled = this.config.aggregates
		const aggs: Array<AggregateSpec> = []
		const aggHeading: Array<HeadingColumn> = []
		const computed = new Set<string>()
		for (const a of s.aggs) {
			let fn: GenAggregate = enabled.length === 0 ? "count" : at(enabled, a.fn)
			const arg = bound.length === 0 ? undefined : at(bound, a.column)
			if (fn !== "count" && (arg === undefined || !aggregateApplies(fn, arg.type))) {
				fn = "count"
			}
			if ((fn === "min" || fn === "max") && arg !== undefined && !plain(arg, input.computed)) {
				fn = "count"
			}
			const name = freshName(`g${aggs.length}`, taken)
			taken.add(name)
			/** Every aggregate but count has an argument: one without has become count above. */
			const used = fn === "count" ? undefined : arg
			const argType = used?.type
			const op = aggregateOpId(fn, argType)
			if (fn === "count") {
				aggs.push({ name, fn, op, args: [], filter: undefined })
			} else {
				if (used === undefined) {
					throw new Error(`${fn} without an argument`)
				}
				aggs.push({ name, fn, op, args: [this.col(input.node, used)], filter: undefined })
			}
			aggHeading.push(column(name, aggregateResult(fn, argType)))
			if (computedSpelling(fn, argType)) {
				computed.add(name)
			}
		}
		const heading = [...Arr.map(keys, (k) => column(k.name, k.type)), ...aggHeading]
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "Group",
			input: input.node,
			bound: Arr.map(bound, (c) => c.name),
			keys: Arr.map(keys, (c) => c.name),
			aggs,
			heading
		})
		return { node: id, heading, computed }
	}

	take(s: Extract<QuerySketch, { tag: "take" }>): Built {
		const input = this.query(s.input)
		const h = input.heading
		/** Every heading column, rotated: a completed total order over a set. */
		const order: CompletedOrder = {
			keys: Arr.map(indices(h.length), (i) => {
				const c = cyclicAt(h, i + s.rotate, "a taken heading")
				return { column: c.name, dir: s.dirs.length > 0 && at(s.dirs, i) ? "desc" : "asc" }
			})
		}
		const k = BigInt(1 + (s.k % 3))
		let bound: TakeBound = { kind: "literal", k }
		if (s.param && this.config.params && weightOf(this.swarm, "params") > 0) {
			const param = this.#names.mint("p")
			this.params[param] = { kind: "scalar", type: int8, value: { kind: "int", value: k } }
			bound = { kind: "param", param }
		}
		/**
		 * Inside a lateral source, a take may fix a column to a column an enclosing region's earlier source reads: the
		 * first k tuples per outer tuple.
		 */
		const keyed = this.lateralKeyPick(this.#lateral, h, s.lateral, "correlated take")
		const correlation =
			keyed === undefined
				? []
				: [{ column: keyed.own.name, expr: this.col(keyed.source.node, keyed.column) }]
		/** A take orders a set and keeps a prefix of it: it merges nothing. */
		const spec: KindOver<"Take", SpecRefs> = {
			loc: undefined,
			meta: conservativeMeta,
			kind: "Take",
			input: input.node,
			order,
			bound,
			correlation,
			heading: h
		}
		const id = this.b.node(spec)
		this.stateOrder(
			id,
			{
				input: input.node,
				fixed: Arr.map(correlation, (c) => c.column),
				withOrder: (completed) => relNode(id.id, { ...spec, order: completed })
			},
			order,
			s
		)
		return { node: id, heading: h, computed: input.computed }
	}

	/**
	 * A later occurrence's source read through a take correlated to an earlier source's column, where the soundness
	 * population and its swarm draw "correlated take": the first k tuples per outer tuple, every column ordered.
	 */
	laterTake(
		source: Built,
		earlier: ReadonlyArray<Built>,
		o: OccurrenceSketch,
		pick: Drawn<number>
	): Built {
		if (!this.config.soundness) {
			return source
		}
		const keyed = this.lateralKeyPick(earlier, source.heading, pick, "correlated take")
		if (keyed === undefined) {
			return source
		}
		const first = at(o.columns, 0)
		const h = source.heading
		/** Every heading column, rotated: a completed total order over a set. */
		const order: CompletedOrder = {
			keys: Arr.map(indices(h.length), (i) => ({
				column: cyclicAt(h, i + first.pick, "a taken heading").name,
				dir: "asc"
			}))
		}
		const bound: TakeBound = { kind: "literal", k: BigInt(1 + (first.mode % 3)) }
		const correlation = [
			{ column: keyed.own.name, expr: this.col(keyed.source.node, keyed.column) }
		]
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "Take",
			input: source.node,
			order,
			bound,
			correlation,
			heading: h
		})
		return { node: id, heading: h, computed: source.computed }
	}

	/**
	 * A later occurrence's source read through a region binding its every column that copies an earlier source's column
	 * into a variable of its own, where the soundness population and its swarm draw "correlated": a region evaluated per
	 * outer tuple.
	 */
	laterRegion(source: Built, earlier: ReadonlyArray<Built>, pick: Drawn<number>): Built {
		const copied = this.lateralPick(earlier, pick, "correlated")
		if (copied === undefined) {
			return source
		}
		const v = this.varOf(
			freshName(copied.column.name, new Set(Arr.map(source.heading, (c) => c.name))),
			copied.column
		)
		return this.boundRegion(source, [{ var: v, expr: this.col(copied.source.node, copied.column) }])
	}

	/**
	 * The choice the pick selects among those `choices` makes of each case-spelled column of `sources`, where the
	 * soundness population and its swarm draw `feature` and some source has one.
	 */
	lateralChoice<C>(
		sources: ReadonlyArray<Built>,
		pick: Drawn<number>,
		feature: SoundnessFeature,
		choices: (source: Built, column: HeadingColumn) => ReadonlyArray<C>
	): C | undefined {
		if (!this.config.soundness || pick.kind === "none" || sources.length === 0) {
			return undefined
		}
		const [first, ...rest] = Arr.flatMap(sources, (source) => {
			const plainColumns = Arr.filter(source.heading, (c) => plain(c, source.computed))
			return Arr.flatMap(plainColumns, (headingColumn) => choices(source, headingColumn))
		})
		if (first === undefined || !this.kept(this.soundness, feature)) {
			return undefined
		}
		return pickFrom([first, ...rest], pick.value)
	}

	/** A column of one of `sources` the pick selects (lateralChoice). */
	lateralPick(
		sources: ReadonlyArray<Built>,
		pick: Drawn<number>,
		feature: SoundnessFeature
	): { readonly source: Built; readonly column: HeadingColumn } | undefined {
		return this.lateralChoice(sources, pick, feature, (source, headingColumn) => [
			{ source, column: headingColumn }
		])
	}

	/**
	 * A column of one of `sources` the pick selects, of the base type of a column of `own`, with that column
	 * (lateralChoice).
	 */
	lateralKeyPick(
		sources: ReadonlyArray<Built>,
		own: Heading,
		pick: Drawn<number>,
		feature: SoundnessFeature
	):
		| { readonly source: Built; readonly column: HeadingColumn; readonly own: HeadingColumn }
		| undefined {
		return this.lateralChoice(sources, pick, feature, (source, headingColumn) =>
			Arr.map(
				Arr.filter(own, (o) => sameScalarType(baseOf(o.type), baseOf(headingColumn.type))),
				(o) => ({ source, column: headingColumn, own: o })
			)
		)
	}

	/** A column expression of one of `sources` of the base type of `type`, as lateralKeyPick draws it. */
	lateralColumn(
		sources: ReadonlyArray<Built>,
		type: ScalarType,
		pick: Drawn<number>,
		feature: SoundnessFeature
	): ScalarExpr | undefined {
		const drawn = this.lateralKeyPick(sources, [column("", type)], pick, feature)
		return drawn === undefined ? undefined : this.col(drawn.source.node, drawn.column)
	}

	/**
	 * A node built earlier that a semi- or anti-join's right side reads instead of its own, where the soundness
	 * population and its swarm share one. Never one holding a node the subtree being built may read by column (a lateral
	 * source's earlier sources, an attachment child's parent): that node would then be read both as the enclosing tuple
	 * and as a relation of its own.
	 */
	shared(pick: Drawn<number>): Option.Option<Built> {
		const read = [...Arr.map(this.#lateral, (l) => l.node), ...this.#parent]
		const [first, ...rest] = Arr.filter(
			this.#built,
			(b) => !Arr.some(read, (n) => this.reaches(b.node, n))
		)
		if (
			!this.config.soundness ||
			pick.kind === "none" ||
			first === undefined ||
			!this.kept(this.soundness, "shared")
		) {
			return Option.none()
		}
		return Option.some(pickFrom([first, ...rest], pick.value))
	}

	/**
	 * Whether the subtree of `from` holds `to`.
	 *
	 * A set's iterator visits what is added while it is walked.
	 */
	reaches(from: RelNode, to: RelNode): boolean {
		const seen = new Set<RelNode>([from])
		for (const position of seen) {
			if (position === to) {
				return true
			}
			for (const input of inputsOf(position)) {
				seen.add(input)
			}
		}
		return false
	}

	/**
	 * A window function over the input: an ordinal over a total order of every column, a count or extreme over the
	 * whole partition, or the neighbouring tuple's value with the tuple's own as the default. Over an empty heading
	 * there is no column to order by, so the function is a count over the whole partition, the one valid there.
	 */
	window(s: Extract<QuerySketch, { tag: "window" }>): Built {
		const input = this.query(s.input)
		const h = input.heading
		const fn =
			h.length === 0
				? "count"
				: pickFrom(
						Arr.some(h, (c) => hasCap(c.type, "ordering"))
							? ([...windowOrdinals, ...windowReaders] as const)
							: windowOrdinals,
						s.fn
					)
		const partition = Arr.map(
			Arr.filter(h, (c, i) => ((s.partition >> i) & 1) === 1 && hasCap(c.type, "equality")),
			(c) => c.name
		)
		const order: CompletedOrder =
			fn === "count" || fn === "min" || fn === "max"
				? { keys: [] }
				: {
						keys: Arr.map(indices(h.length), (i) => ({
							column: cyclicAt(h, i + s.rotate, "a window's heading").name,
							dir: "asc"
						}))
					}
		/**
		 * The value column an extreme or a neighbour reads, among those of an ordered type; none leaves the ordinals.
		 */
		const [orderable, ...orderables] = Arr.filter(h, (c) => hasCap(c.type, "ordering"))
		const value =
			orderable === undefined ? undefined : pickFrom([orderable, ...orderables], s.column)
		const read = value === undefined ? undefined : this.col(input.node, value)
		const args =
			read === undefined ||
			fn === "rowNumber" ||
			fn === "rank" ||
			fn === "denseRank" ||
			fn === "count"
				? []
				: fn === "lag" || fn === "lead"
					? [read, this.lit({ kind: "int", value: 1n }, int4), read]
					: [read]
		const ordinal = fn === "rowNumber" || fn === "rank" || fn === "denseRank" || fn === "count"
		const out = freshName("w", new Set(Arr.map(h, (c) => c.name)))
		const outType = ordinal || value === undefined ? int8 : value.type
		const heading = [...h, column(out, outType)]
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "Window",
			input: input.node,
			partition,
			order,
			fn,
			op: OpId(windowOps[fn]),
			args,
			out,
			rule: "generated",
			heading,
			filter: undefined,
			frame: undefined
		})
		const computed =
			value !== undefined && !ordinal && input.computed.has(value.name)
				? new Set([...input.computed, out])
				: input.computed
		return { node: id, heading, computed }
	}

	/** The approximate nearest candidates of the input by its first double precision column. */
	approximate(s: Extract<QuerySketch, { tag: "approximate" }>): Built {
		const { input, score } = this.scored(this.query(s.input), s.score)
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "ApproximateNearest",
			source: input.node,
			score: score.name,
			take: BigInt(1 + (s.k % 3)),
			params: [],
			sealed: true,
			heading: input.heading
		})
		return { node: id, heading: input.heading, computed: input.computed }
	}

	/**
	 * `input` with a double precision column to rank by: its first, or the constant `value` projected beside its every
	 * column, which merges nothing.
	 */
	scored(
		input: Built,
		value: ValueSketch
	): { readonly input: Built; readonly score: HeadingColumn } {
		const own = Arr.findFirst(input.heading, (c) => baseOf(c.type).carrier === "float8")
		if (Option.isSome(own)) {
			return { input, score: own.value }
		}
		const score = column(freshName("score", new Set(Arr.map(input.heading, (c) => c.name))), float8)
		const heading = [...input.heading, score]
		const out = [
			...Arr.map(input.heading, (c) => ({ name: c.name, expr: this.col(input.node, c) })),
			{
				name: score.name,
				expr: this.lit(resolveValue(float8, value, this.spelling, "stored"), float8)
			}
		]
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "ProjectSet",
			input: input.node,
			out,
			heading
		})
		return { input: { node: id, heading, computed: input.computed }, score }
	}

	/**
	 * The edges project onto two columns, and the recursion merges the paths that reach one pair: the endpoints are
	 * case-spelled columns.
	 *
	 * A recursive state column needs hashing: no closure over money.
	 */
	closure(s: Extract<QuerySketch, { tag: "closure" }>): Built {
		const edge = this.query(s.edge)
		const acyclic = this.config.closure === "acyclic" || s.acyclic
		const h = edge.heading
		const candidates: ReadonlyArray<readonly [HeadingColumn, HeadingColumn]> = Arr.flatMap(h, (a) =>
			Arr.flatMap(h, (b) =>
				a.name !== b.name &&
				plain(a, edge.computed) &&
				plain(b, edge.computed) &&
				sameScalarType(a.type, b.type) &&
				hasCap(a.type, "hashing") &&
				(!acyclic || hasCap(a.type, "ordering"))
					? [[a, b] as const]
					: []
			)
		)
		if (candidates.length === 0) {
			return edge
		}
		const [from, to] = at(candidates, s.pair)
		let source = edge
		if (acyclic) {
			const lt = this.op(
				compareOpId(from.type, "lt"),
				[this.col(edge.node, from), this.col(edge.node, to)],
				bool
			)
			source = {
				node: this.b.node({
					loc: undefined,
					meta: conservativeMeta,
					kind: "Filter",
					input: edge.node,
					pred: lt,
					heading: h
				}),
				heading: h,
				computed: edge.computed
			}
		}
		const state: Heading = [column("src", from.type), column("dst", to.type)]
		const edges = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "ProjectSet",
			input: source.node,
			out: [
				{ name: "src", expr: this.col(source.node, from) },
				{ name: "dst", expr: this.col(source.node, to) }
			],
			heading: state
		})
		const rec = this.b.reserve()
		const self = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "SelfRef",
			recursive: rec,
			heading: state
		})
		const type = from.type
		const vSrc: VarDecl = { id: this.b.ids.var(), name: "src", type }
		const vMid: VarDecl = { id: this.b.ids.var(), name: "mid", type }
		const vDst: VarDecl = { id: this.b.ids.var(), name: "dst", type }
		const region = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "MatchRegion",
			scope: this.b.ids.scope(),
			vars: [vSrc, vMid, vDst],
			occurrences: [
				{
					id: this.b.ids.occurrence(),
					source: self,
					bindings: [
						{ column: "src", var: vSrc },
						{ column: "dst", var: vMid }
					],
					constants: []
				},
				{
					id: this.b.ids.occurrence(),
					source: edges,
					bindings: [
						{ column: "src", var: vMid },
						{ column: "dst", var: vDst }
					],
					constants: []
				}
			],
			equalities: [],
			correlated: [],
			heading: [column("src", type), column("mid", type), column("dst", type)]
		})
		const step = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "ProjectSet",
			input: region,
			out: [
				{ name: "src", expr: this.col(region, column("src", type)) },
				{ name: "dst", expr: this.col(region, column("dst", type)) }
			],
			heading: state
		})
		const recursive = this.b.define(rec, {
			loc: undefined,
			meta: conservativeMeta,
			kind: "Recursive",
			name: `closure${++this.#closures}`,
			base: edges,
			step,
			self,
			/** Projection over a finite carrier: the state is a pair of edge endpoints. */
			termination: { kind: "finiteCarrier", stateEstimate: 4096n, premises: [] },
			origin: [],
			heading: state
		})
		const closed: Built = { node: recursive, heading: state, computed: none }
		return s.root.kind === "drawn" && this.config.rooted && this.kept(this.rewrite, "rooted")
			? this.rooted(closed, type, s.root.value)
			: closed
	}

	/** The paths of a closure from one source value (RootedSketch). */
	rooted(closure: Built, type: ScalarType, s: RootedSketch): Built {
		const src = column("src", type)
		const dst = column("dst", type)
		const value = this.operand(type, s.value, s.param && !isRefined(type))
		if (s.form % 3 === 0) {
			const pred = this.op(compareOpId(type, "eq"), [this.col(closure.node, src), value], bool)
			return {
				node: this.b.node({
					loc: undefined,
					meta: conservativeMeta,
					kind: "Filter",
					input: closure.node,
					pred,
					heading: closure.heading
				}),
				heading: closure.heading,
				computed: none
			}
		}
		const fixed = s.form % 3 === 1
		const vSrc: VarDecl = { id: this.b.ids.var(), name: "src", type }
		const vDst: VarDecl = { id: this.b.ids.var(), name: "dst", type }
		const heading = fixed ? [dst] : [src, dst]
		const region = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "MatchRegion",
			scope: this.b.ids.scope(),
			vars: fixed ? [vDst] : [vSrc, vDst],
			occurrences: [
				{
					id: this.b.ids.occurrence(),
					source: closure.node,
					bindings: fixed
						? [{ column: "dst", var: vDst }]
						: [
								{ column: "src", var: vSrc },
								{ column: "dst", var: vDst }
							],
					constants: fixed ? [{ column: "src", expr: value }] : []
				}
			],
			equalities: [],
			correlated: [],
			heading
		})
		if (fixed) {
			return { node: region, heading, computed: none }
		}
		const pred = this.op(compareOpId(type, "eq"), [this.col(region, src), value], bool)
		return {
			node: this.b.node({
				loc: undefined,
				meta: conservativeMeta,
				kind: "Filter",
				input: region,
				pred,
				heading
			}),
			heading,
			computed: none
		}
	}

	attach(
		parent: Built,
		child: Built,
		picks: ReadonlyArray<number>,
		name: string,
		drawnTake: Drawn<ChildTakeSketch>
	): Built | undefined {
		/**
		 * The delivery keys each child tuple by its parent's correlated columns, the distinct parent keys: the
		 * correlation pairs case-spelled columns.
		 */
		const candidates = this.pairs(parent, child, true)
		if (candidates.length === 0) {
			return undefined
		}
		const correlation: Array<{ parent: string; child: string }> = []
		for (const pick of picks) {
			const p = at(candidates, pick)
			if (!Arr.some(correlation, (c) => c.parent === p.left && c.child === p.right)) {
				correlation.push({ parent: p.left, child: p.right })
			}
		}
		let childNode = child.node
		if (drawnTake.kind === "drawn" && this.kept(this.swarm, "take")) {
			const take = drawnTake.value
			/**
			 * The correlated columns are fixed per parent tuple, so the completed order is total over the others
			 * (the checker's take, check/checker.ts).
			 */
			const fixed = new Set(Arr.map(correlation, (c) => c.child))
			const rest = Arr.filter(child.heading, (c) => !fixed.has(c.name))
			const order: CompletedOrder = {
				keys: Arr.map(indices(rest.length), (i) => {
					const c = cyclicAt(rest, i + take.rotate, "a child take's heading")
					return { column: c.name, dir: take.dirs.length > 0 && at(take.dirs, i) ? "desc" : "asc" }
				})
			}
			const parentColumn = (attachName: string): HeadingColumn => {
				const c = Arr.findFirst(parent.heading, (h) => h.name === attachName)
				if (Option.isNone(c)) {
					throw new Error(`the parent has no column ${attachName}`)
				}
				return c.value
			}
			const spec: KindOver<"Take", SpecRefs> = {
				loc: undefined,
				meta: conservativeMeta,
				kind: "Take",
				input: child.node,
				order,
				bound: { kind: "literal", k: BigInt(1 + (take.k % 3)) },
				correlation: Arr.map(correlation, (c) => ({
					column: c.child,
					expr: this.col(parent.node, parentColumn(c.parent))
				})),
				heading: child.heading
			}
			const taken = this.b.node(spec)
			this.stateOrder(
				taken,
				{
					input: child.node,
					fixed: Arr.map(spec.correlation, (c) => c.column),
					withOrder: (completed) => relNode(taken.id, { ...spec, order: completed })
				},
				order,
				take
			)
			childNode = taken
		}
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "Attach",
			parent: parent.node,
			child: childNode,
			name,
			correlation,
			delivered: "array",
			heading: parent.heading,
			order: undefined
		})
		return { node: id, heading: parent.heading, computed: parent.computed }
	}

	/**
	 * An attachment's child with the chain of attachments nested below it, outermost first: each level is built over
	 * its own child, the deepest attached first, under its per-parent take where drawn. A level that has no column to
	 * correlate on is left out. While a level's child and the levels below it are built, `child`, their parent, is among
	 * the parents no shared node may hold.
	 */
	nestedChain(child: Built, nested: ReadonlyArray<NestedSketch>): Built {
		const [level, ...deeper] = nested
		if (level === undefined) {
			return child
		}
		const outer = this.#parent
		this.#parent = [...outer, child.node]
		const below = this.nestedChain(this.query(level.child), deeper)
		this.#parent = outer
		return (
			this.attach(child, below, level.correlation, `nested${deeper.length}`, level.take) ?? child
		)
	}

	root(s: RootSketch): RelNode {
		switch (s.tag) {
			case "plain": {
				const body = this.query(s.body)
				if (s.order.kind === "none" || !this.kept(this.swarm, "ordered")) {
					return body.node
				}
				/** Every heading column, rotated: a completed total order over the delivered set. */
				const h = body.heading
				const stated = s.order.value
				const dirs = stated.dirs
				const order: CompletedOrder = {
					keys: Arr.map(indices(h.length), (i) => ({
						column: cyclicAt(h, i + stated.rotate, "an ordered heading").name,
						dir: dirs.length > 0 && at(dirs, i) ? "desc" : "asc"
					}))
				}
				const spec: KindOver<"OrderedResult", SpecRefs> = {
					loc: undefined,
					meta: conservativeMeta,
					kind: "OrderedResult",
					input: body.node,
					order,
					heading: h
				}
				const id = this.b.node(spec)
				this.stateOrder(
					id,
					{
						input: body.node,
						fixed: [],
						withOrder: (completed) => relNode(id.id, { ...spec, order: completed })
					},
					order,
					stated
				)
				return id
			}
			case "attach": {
				if (!this.kept(this.swarm, "attach")) {
					return this.query(s.body).node
				}
				const body = this.query(s.body)
				const names = new Set(Arr.map(body.heading, (c) => c.name))
				const attachedAll = Arr.reduce(s.children, body, (current, a) => {
					this.#parent = [current.node]
					const child = this.nestedChain(this.query(a.child), a.nested)
					this.#parent = []
					const name = freshName(`att${names.size}`, names)
					const attached = this.attach(current, child, a.correlation, name, a.take)
					if (attached === undefined) {
						return current
					}
					names.add(name)
					return attached
				})
				return attachedAll.node
			}
			case "hetero": {
				const first = elementAt(s.groups, 0, "the heading groups")
				if (!this.kept(this.swarm, "hetero")) {
					return this.query(elementAt(first.arms, 0, "a heading group's arms")).node
				}
				return this.hetero(s.groups)
			}
		}
	}

	hetero(groups: ReadonlyArray<HeteroGroupSketch>): RelNode {
		const resolved: Array<{ heading: Heading; arms: Arr.NonEmptyArray<RelNode> }> = []
		for (const [gi, g] of groups.entries()) {
			const arms = Arr.map(g.arms, (a) => this.query(a))
			const target = this.armHeading(
				elementAt(arms, 0, "a heading group's arms").heading,
				g.width,
				g.picks
			)
			const projected = this.arms(arms, target, g.picks, { kind: "tagged", tag: () => BigInt(gi) })
			const heading = elementAt(projected, 0, "a heading group's projected arms").heading
			const same = Arr.findFirst(
				resolved,
				(r) =>
					r.heading.length === heading.length &&
					Arr.every(r.heading, (c) =>
						Arr.some(heading, (d) => d.name === c.name && sameScalarType(c.type, d.type))
					)
			)
			const ids = nonEmptyList(
				Arr.map(projected, (p) => p.node),
				"a heading group's arms"
			)
			if (Option.isSome(same)) {
				same.value.arms.push(...ids)
			} else {
				resolved.push({ heading, arms: Arr.copy(ids) })
			}
		}
		const first = elementAt(resolved, 0, "the heading groups").heading
		const heading = Arr.filter(first, (c) =>
			Arr.every(resolved, (r) =>
				Arr.some(r.heading, (d) => d.name === c.name && sameScalarType(c.type, d.type))
			)
		)
		return this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "Union",
			groups: nonEmptyList(resolved, "the heading groups"),
			discriminant: ["tag"],
			heading
		})
	}
}

/**
 * Resolves a root sketch to a query over `schema` under the case's three swarms, drawing their thinning decisions from
 * the case's tape. A DAG that fails validation is a defect of the generator, never of the case, so it throws with the
 * validator's reason.
 */
export const resolveQuery =
	(
		schema: GenSchema,
		sketch: RootSketch,
		spelling: Spelling,
		config: QueryConfig,
		names: ReadonlyArray<number>,
		swarm: Swarm<QueryFeature>,
		rewrite: Swarm<RewriteFeature>,
		soundness: Swarm<SoundnessFeature>
	): Gen<GenQuery> =>
	(source) => {
		const r = new QueryResolver(source, schema, spelling, config, swarm, rewrite, soundness, names)
		const root = r.root(sketch)
		const built = r.b.build(Arr.of(root))
		/** The stated orders completed as the checker completes them, every node then carrying the logical metadata. */
		const completed = completeStatedOrders(built, r.stated)
		if (!completed.ok) {
			throw new Error(`could not complete a generated order: ${completed.error.message}`)
		}
		const dag = normalQuery(completed.value)
		const read = new Set<string>(Arr.flatMap(dag.roots, (root) => root.meta.paramDeps))
		const params: Record<string, GenParam> = {}
		for (const [id, p] of Rec.toEntries(r.params)) {
			if (read.has(id)) {
				params[id] = p
			}
		}
		return { dag, params }
	}
