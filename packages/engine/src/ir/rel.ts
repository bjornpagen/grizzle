import { nominal } from "#compiler/core/brand.ts"
import type {
	ExprId,
	LawId,
	NodeId,
	OccurrenceId,
	ParamId,
	ScopeId,
	VarId
} from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { EvidenceContext, Premise } from "#compiler/ir/evidence.ts"
import {
	type CatalogOpId,
	type ScalarExpr,
	type TableExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import type { ClaimedKey, ViewKey } from "#compiler/ir/keys.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

export const relKinds = [
	"Base",
	"Closed",
	"Context",
	"InputSet",
	"Delta",
	"MatchRegion",
	"Filter",
	"ProjectSet",
	"SemiJoin",
	"AntiJoin",
	"Union",
	"Intersect",
	"Difference",
	"Take",
	"Group",
	"Produce",
	"Recursive",
	"SelfRef",
	"ApproximateNearest",
	"OrderedResult",
	"Attach",
	"Forbid",
	"Window",
	"OrderedSetAggregate"
] as const
export type RelKind = (typeof relKinds)[number]

export type Card = "many" | "atMostOne" | "one"

/** What a Base reads (Base relationKind). */
type BaseRelationKind = "relation" | "derived" | "world"

export interface HeadingColumn {
	readonly name: string
	readonly type: ScalarType
}
/** The complete logical heading, in column order. The zero-column heading is meaningful. */
export type Heading = ReadonlyArray<HeadingColumn>

/** A set of heading column names that together determine a row. The empty set is the key of at most one row. */
export type KeySet = ReadonlyArray<string>

/** A key a relation declares: its primary key or a further key() over at least one of its fields. */
export type DeclaredKey = NonEmptyReadonlyArray<string>

/** The metadata a builder states of a node: everything but the structural fields, which construction computes. */
export interface MetaSpec {
	/**
	 * The keys relative to the node's inputs, parameters and, inside an attachment, the parent's variables, each a
	 * distinct set of heading columns (ir/keys.ts ClaimedKey): the logical analysis's minimal keys, each with its proof,
	 * or a lowering rewrite's claim of a node it builds; the empty key, at most one row, only on a node of card atMostOne
	 * or one. A proof is a value about the DAG its analysis ran over: a rename or a rewrite of the DAG carries the claim
	 * and leaves the proof describing the nodes it was proved for, which the key kernel checks it against.
	 */
	readonly logicalKeys: ReadonlyArray<ClaimedKey>
	readonly card: Card
	/** The minimum evidence context the node's evidence requires. */
	readonly context: EvidenceContext
}

/**
 * A node's metadata: what its builder states, and its structural fields, which the one constructor (dag.ts relNode)
 * computes from the node and its inputs and no builder states. Both structural fields are lexical: a node's own and its
 * inputs', the feedback edge of a SelfRef not followed, so a Recursive, whose base and step are its inputs, covers its
 * whole region.
 */
export interface NodeMeta extends MetaSpec {
	/**
	 * The parameters the node depends on: those its expressions read, its InputSet, its bound, its approximate search's
	 * bindings and its certificate's premises, and its inputs'.
	 */
	readonly paramDeps: ReadonlyArray<ParamId>
	/** The stored relations the node reads: a Base's, and its inputs'. */
	readonly reads: ReadonlyArray<string>
}

export const conservativeMeta: MetaSpec = Object.freeze({
	logicalKeys: [],
	card: "many",
	context: "queryLocal"
})

export interface OrderKey {
	readonly column: string
	readonly dir: "asc" | "desc"
}

/**
 * A total output order completed by the compiler: the user's keys, then a retained key or the
 * remaining heading. The zero-column heading's order is the empty comparison tuple.
 */
export interface CompletedOrder {
	readonly keys: ReadonlyArray<OrderKey>
}

/** A positive literal or the name of an integer parameter. */
export type TakeBound =
	| { readonly kind: "literal"; readonly k: bigint }
	| { readonly kind: "param"; readonly param: ParamId }

interface ColumnPair {
	readonly left: string
	readonly right: string
}

export interface VarDecl {
	readonly id: VarId
	/** The column name the variable has in the region's heading. */
	readonly name: string
	readonly type: ScalarType
}

/**
 * What the references a node holds are in one form of a DAG: its data edges (`node`), its expressions (`expr`), its
 * region's references to the region's own variables (`var`), and its metadata (`meta`).
 *
 * - A RelNode (LiveRefs) holds its inputs, its expressions and its variables themselves, and its whole metadata.
 * - A NodeSpec (SpecRefs) is a RelNode as a builder states it: no identifier, and only the metadata it claims.
 * - A TableNode (TableRefs) is the outside form a table keyed by identifier holds (dag.ts toTable): every reference an
 *   identifier.
 * - An EditNode (EditRefs) is the node a rewrite edits in place: its inputs are the editor's cells.
 * - A fold step reads a node with each input replaced by that input's value (ValueRefs).
 *
 * A node's sub-structures (an occurrence, a heading group, a correlation, an aggregate, a producer call) are generic over
 * exactly the references they hold, never over the whole bundle: two forms that agree on those references hold one and
 * the same sub-structure type (a correlation, which holds an expression, is the same in a live, a stated and an edited
 * node), so restating a node in another form never meets a sub-structure typed apart by a reference it does not hold.
 */
export interface RefKinds {
	readonly node: unknown
	readonly expr: unknown
	readonly var: unknown
	readonly meta: unknown
}

export interface LiveRefs {
	readonly node: RelNode
	readonly expr: ScalarExpr
	readonly var: VarDecl
	readonly meta: NodeMeta
}

export interface SpecRefs {
	readonly node: RelNode
	readonly expr: ScalarExpr
	readonly var: VarDecl
	readonly meta: MetaSpec
}

export interface TableRefs {
	readonly node: NodeId
	readonly expr: ExprId
	readonly var: VarId
	readonly meta: NodeMeta
}

export interface EditRefs {
	readonly node: Cell
	readonly expr: ScalarExpr
	readonly var: VarDecl
	readonly meta: MetaSpec
}

export interface ValueRefs<A> {
	readonly node: A
	readonly expr: ScalarExpr
	readonly var: VarDecl
	readonly meta: NodeMeta
}

/**
 * A node of any form, read for its data edges alone (EdgeRefs) or its expressions alone (ExprRefs): a reader generic over
 * the form (edgesOf, exprsOf) takes that one reference as its type parameter, every other reference whatever the form
 * holds. A kind that holds that reference holds it in its own fields (an input, an occurrence's source; a predicate, a
 * correlation's expression), so the reader infers it from the node it is handed, of whichever form: a live or tabled node
 * as well as a stated, edited or folded one.
 */
interface EdgeRefs<N> extends RefKinds {
	readonly node: N
}

interface ExprRefs<E> extends RefKinds {
	readonly expr: E
}

/**
 * A heading column held equal to an outer expression, a parameter or a correlated outer variable: a restriction of
 * the rows a Take ranks in each evaluation, which fixes the column there.
 */
export interface CorrelationOver<E> {
	readonly column: string
	readonly expr: E
}
export type Correlation = CorrelationOver<ScalarExpr>

/**
 * A source a region reads. Every source column neither bound nor fixed is an existential witness, whose value the region
 * never observes.
 */
export interface OccurrenceOver<N, E, V> {
	readonly id: OccurrenceId
	readonly source: N
	/** Source columns bound to the region's variables. One variable in two bindings expresses equality. */
	readonly bindings: ReadonlyArray<{ readonly column: string; readonly var: V }>
	/** Source columns fixed to an expression (a literal or parameter binding). */
	readonly constants: ReadonlyArray<{ readonly column: string; readonly expr: E }>
}
export type Occurrence = OccurrenceOver<RelNode, ScalarExpr, VarDecl>

export interface HeadingGroupOver<N> {
	readonly heading: Heading
	readonly arms: NonEmptyReadonlyArray<N>
}
export type HeadingGroup = HeadingGroupOver<RelNode>

/** The aggregates a Group computes: the public ones (count, sum, mean as avg, min, max) and the boolean folds. */
export const aggregateFns = ["count", "sum", "avg", "min", "max", "boolAnd", "boolOr"] as const
export type AggregateFn = (typeof aggregateFns)[number]

/** The exact number of arguments of each aggregate: count(*) has none, every other one. */
export const aggregateArity = (fn: AggregateFn): number => (fn === "count" ? 0 : 1)

/** An aggregate's function and its aggregated expressions, in argument order, as many as its arity. */
export type AggregateCallOver<E> =
	| { readonly fn: "count"; readonly args: readonly [] }
	| { readonly fn: Exclude<AggregateFn, "count">; readonly args: readonly [E] }

export type AggregateSpecOver<E> = {
	readonly name: string
	/** The native aggregate overload. */
	readonly op: CatalogOpId
	/**
	 * count(*) FILTER (WHERE p), R24's conditional count, or undefined for an unfiltered aggregate. Only count is
	 * filtered: sum over no row is NULL, so a conditional sum is sum(CASE WHEN p THEN x ELSE 0 END) instead.
	 */
	readonly filter: E | undefined
} & AggregateCallOver<E>
export type AggregateSpec = AggregateSpecOver<ScalarExpr>

/** `a` with each of its expressions mapped by `f`, its arguments in order and then its filter, keeping its arity. */
export const mapAggregate = <E, F>(
	a: AggregateSpecOver<E>,
	f: (e: E) => F
): AggregateSpecOver<F> => {
	const filter = (): F | undefined => (a.filter === undefined ? undefined : f(a.filter))
	switch (a.fn) {
		case "count":
			return { ...a, args: [], filter: filter() }
		case "sum":
		case "avg":
		case "min":
		case "max":
		case "boolAnd":
		case "boolOr":
			return { ...a, args: [f(a.args[0])], filter: filter() }
	}
}

/**
 * Why a recursive node terminates: projection over finite carrier relations, bounded computed state, or
 * a recognized well-founded transition. The state estimate is checked against recursionMaxStates at admission.
 */
export interface TerminationCert {
	readonly kind: "finiteCarrier" | "boundedState" | "wellFounded"
	readonly stateEstimate: bigint
	readonly premises: ReadonlyArray<Premise>
}

/**
 * What a producer computes from its span arguments: the packed components of one span per group, or the
 * intersection or difference of two spans.
 */
export type ProducerCallOver<E> =
	| { readonly producer: "spanPack"; readonly args: readonly [E] }
	| { readonly producer: "spanIntersection" | "spanDifference"; readonly args: readonly [E, E] }
export type ProducerKind = ProducerCallOver<ScalarExpr>["producer"]
export type ProducerNode<P extends ProducerKind> = NodeOf<"Produce"> & { readonly producer: P }

/**
 * The window functions R26-R28 and R41 lower to: ordinals, the running and partition aggregates (avg is mean), and
 * LEAD/LAG with their offset and default (R27 writes LEAD(f, 1, f)).
 */
export const windowFns = [
	"rowNumber",
	"rank",
	"denseRank",
	"count",
	"sum",
	"avg",
	"min",
	"max",
	"lag",
	"lead"
] as const
export type WindowFn = (typeof windowFns)[number]

/**
 * The functions whose result depends on the order of rows within a partition rather than only on their set, so their
 * order must be total: ROW_NUMBER, and LEAD and LAG, which read a neighbouring row.
 */
export const orderSensitiveWindowFns: ReadonlyArray<WindowFn> = ["rowNumber", "lag", "lead"]

/** One end of a ROWS frame (R41). */
export type FrameBound =
	| "unboundedPreceding"
	| { readonly preceding: bigint }
	| "currentRow"
	| { readonly following: bigint }

/** ROWS BETWEEN start AND end, always stated explicitly; ROWS is the only frame unit grizzle emits. */
export interface WindowFrame {
	readonly unit: "rows"
	readonly start: FrameBound
	readonly end: FrameBound
}

export const orderedSetFns = ["percentileDisc", "percentileCont", "mode"] as const
type OrderedSetFn = (typeof orderedSetFns)[number]

/** What an attachment delivers per parent: the bare child, an option, or an array, which alone has an order. */
export type AttachDelivery =
	| { readonly delivered: "option" | "one"; readonly order: undefined }
	| { readonly delivered: "array"; readonly order: CompletedOrder | undefined }

/**
 * What fills an InputSet: a relation parameter the query declares and its caller binds, or an enumerated member slot of
 * a write, filled from the normalized facts the write puts into `relation`, each a placeholder of the statement; or the
 * row a write filter's membership is asked at, exactly one fact, whose values the membership's caller names
 * (ir/desc.ts RowSourceDesc), which no placeholder carries.
 */
export type InputSetInput = PlaceholderInput | { readonly kind: "row" }

/** An InputSet input a placeholder of the statement carries: a declared relation parameter or a write's member slot. */
export type PlaceholderInput =
	| { readonly kind: "declared"; readonly param: ParamId }
	| { readonly kind: "member"; readonly slot: ParamId; readonly relation: string }

/**
 * The placeholder id a placeholder input reads: its declared parameter or its member slot. For readers that name the
 * placeholder (a premise, a key identity); the lowering switches on the input itself.
 */
export const inputSetPlaceholder = (input: PlaceholderInput): ParamId =>
	input.kind === "declared" ? input.param : input.slot

interface NodeCommon<R extends RefKinds> {
	readonly heading: Heading
	readonly meta: R["meta"]
	/** Where the node was authored, or undefined for a node no Description node stands behind. */
	readonly loc: SourceLoc | undefined
}

interface BaseOf<R extends RefKinds, Kind extends BaseRelationKind> extends NodeCommon<R> {
	readonly kind: "Base"
	readonly relation: string
	readonly occurrence: OccurrenceId
	/** The key the node is read by: an ordinary relation's primary key; a view's whole heading, until evidence that
	 * admits its own keys restates it (logical/annotate.ts). */
	readonly primaryKey: DeclaredKey
	/** Every additional declared key, or a view's other keys once restated. */
	readonly keys: ReadonlyArray<DeclaredKey>
	/** In a role's program every Base reads the role's view of that name. */
	readonly relationKind: Kind
}

/** A Base over an ordinary relation's table, keyed by its declared keys. */
export type StoredBase<R extends RefKinds> = BaseOf<R, "relation">

/**
 * A Base over a view: a derived relation's materialized view, or a role's world relation, a plain view. `view` holds
 * the keys its definition proves, narrowest first, with what each rests on, which the checker stamps from the checked
 * schema's analysis of the view (analysis/schema.ts): a derived relation's inherited keys, resting on its view's unique
 * indexes, or a world relation's, resting on its definition's proof.
 */
export interface ViewBase<R extends RefKinds> extends BaseOf<R, "derived" | "world"> {
	readonly view: ReadonlyArray<ViewKey>
}

export type Base<R extends RefKinds> = StoredBase<R> | ViewBase<R>

export interface Closed<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "Closed"
	readonly closed: string
	readonly rows: ReadonlyArray<ReadonlyArray<TypedLiteral>>
}

/**
 * The literal of a closed fact's row at `position` of its heading: the one site of the fact that a closed relation's
 * facts are rows rectangular over its heading, the rows a Closed node holds and the theory's closed relations
 * (ClosedTheoryRelation) alike. Every row is built by mapping the heading, and a row's width
 * is a runtime length that no TypeScript type of an array relates to another array's, so a short row is a defect.
 */
export const closedCell = (row: ReadonlyArray<TypedLiteral>, position: number): TypedLiteral => {
	const literal = row[position]
	if (literal === undefined) {
		throw defect(`a Closed row holds a literal at heading position ${position}`)
	}
	return literal
}

/** The literals of a Closed node's column at `position` of its heading, one per row in row order. */
export const closedColumn = <R extends RefKinds>(
	node: Closed<R>,
	position: number
): ReadonlyArray<TypedLiteral> => node.rows.map((row) => closedCell(row, position))

/** A Closed node's rows in row order, each its cells paired with their heading columns in heading order. */
export const closedRows = <R extends RefKinds>(
	node: Closed<R>
): ReadonlyArray<
	ReadonlyArray<{ readonly column: HeadingColumn; readonly literal: TypedLiteral }>
> =>
	node.rows.map((row) =>
		node.heading.map((column, position) => ({ column, literal: closedCell(row, position) }))
	)

/** A context by its declared name: at most one row, the session's claims read through the heading's types. */
export interface Context<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "Context"
	readonly context: string
}

export interface InputSet<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "InputSet"
	readonly input: InputSetInput
}

export interface Delta<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "Delta"
	readonly relation: string
	readonly side: "added" | "removed"
	/**
	 * Its relation's declared keys, the primary key first: an ordinary relation's; none for a world relation, whose keys
	 * are its definition's.
	 */
	readonly keys: ReadonlyArray<DeclaredKey>
}

export interface MatchRegion<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "MatchRegion"
	readonly scope: ScopeId
	readonly vars: ReadonlyArray<VarDecl>
	readonly occurrences: ReadonlyArray<OccurrenceOver<R["node"], R["expr"], R["var"]>>
	readonly equalities: ReadonlyArray<{ readonly a: R["var"]; readonly b: R["var"] }>
	readonly correlated: ReadonlyArray<{ readonly var: R["var"]; readonly expr: R["expr"] }>
}

export interface Filter<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "Filter"
	readonly input: R["node"]
	readonly pred: R["expr"]
}

export interface ProjectSet<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "ProjectSet"
	readonly input: R["node"]
	readonly out: ReadonlyArray<{ readonly name: string; readonly expr: R["expr"] }>
}

export interface SemiJoin<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "SemiJoin"
	readonly left: R["node"]
	readonly right: R["node"]
	readonly on: ReadonlyArray<ColumnPair>
}

export interface AntiJoin<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "AntiJoin"
	readonly left: R["node"]
	readonly right: R["node"]
	readonly on: ReadonlyArray<ColumnPair>
}

export interface Union<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "Union"
	readonly groups: NonEmptyReadonlyArray<HeadingGroupOver<R["node"]>>
	/** Columns present in every arm and bound to a literal there; required when there are several groups. */
	readonly discriminant: ReadonlyArray<string>
}

/** Every arm of every group of a union, in order: a union has a group and a group an arm. */
export const unionArms = <N>(
	groups: NonEmptyReadonlyArray<HeadingGroupOver<N>>
): NonEmptyReadonlyArray<N> => {
	const [first, ...rest] = groups
	const [head, ...tail] = first.arms
	return [head, ...tail, ...rest.flatMap((g) => g.arms)]
}

export interface Intersect<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "Intersect"
	readonly left: R["node"]
	readonly right: R["node"]
}

export interface Difference<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "Difference"
	readonly left: R["node"]
	readonly right: R["node"]
}

export interface Take<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "Take"
	readonly input: R["node"]
	readonly order: CompletedOrder
	readonly bound: TakeBound
	/** Each evaluation ranks only the input rows that satisfy every correlation; none restricts nothing. */
	readonly correlation: ReadonlyArray<CorrelationOver<R["expr"]>>
}

export interface Group<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "Group"
	readonly input: R["node"]
	/** The complete bound tuple B whose distinct values are the aggregate's contributions. */
	readonly bound: KeySet
	readonly keys: KeySet
	readonly aggs: ReadonlyArray<AggregateSpecOver<R["expr"]>>
}

export type Produce<R extends RefKinds> = NodeCommon<R> & {
	readonly kind: "Produce"
	readonly input: R["node"]
	/** Input columns carried to each produced fact. */
	readonly carried: ReadonlyArray<string>
	readonly out: string
} & ProducerCallOver<R["expr"]>

export interface Recursive<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "Recursive"
	readonly name: string
	readonly base: R["node"]
	readonly step: R["node"]
	/** The SelfRef node the step reads. */
	readonly self: R["node"]
	readonly termination: TerminationCert
	/**
	 * The origin fields: the state-heading columns that carry the originating seed or parent identity through
	 * the recursion when traversals are batched, such as an attached recursive child seeded from the parent-key
	 * recordset; empty when nothing is batched. Separate seeds'
	 * traversals never merge, because these columns are part of the deduplicated state.
	 */
	readonly origin: KeySet
}

/**
 * The feedback reference of a Recursive, read only inside its step: it names the Recursive, which is built after it
 * (DagBuilder.reserve), so the name is the only back edge, and no traversal follows it.
 */
export interface SelfRef<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "SelfRef"
	readonly recursive: NodeId
}

export interface ApproximateNearest<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "ApproximateNearest"
	readonly source: R["node"]
	/** The cosine-distance column the candidates are selected by. */
	readonly score: string
	readonly take: bigint
	readonly params: ReadonlyArray<ParamId>
	readonly sealed: true
}

export interface OrderedResult<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "OrderedResult"
	readonly input: R["node"]
	readonly order: CompletedOrder
}

export type Attach<R extends RefKinds> = NodeCommon<R> & {
	readonly kind: "Attach"
	readonly parent: R["node"]
	readonly child: R["node"]
	readonly name: string
	/** Parent heading columns equated with child heading columns. */
	readonly correlation: ReadonlyArray<{ readonly parent: string; readonly child: string }>
} & AttachDelivery

export interface Forbid<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "Forbid"
	readonly lawId: LawId
	readonly violation: R["node"]
}

export interface Window<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "Window"
	readonly input: R["node"]
	readonly partition: KeySet
	/** Empty for a partition aggregate over the whole partition (R28: COUNT(*) OVER (PARTITION BY key)). */
	readonly order: CompletedOrder
	readonly fn: WindowFn
	/** The native function or aggregate overload. */
	readonly op: CatalogOpId
	/**
	 * In argument order: none for the ordinals and count(*), the aggregated value, or LEAD/LAG's value, offset
	 * and default.
	 */
	readonly args: ReadonlyArray<R["expr"]>
	/** count(*) FILTER (WHERE p) OVER (...), R41's conditional count, or undefined for an unfiltered one. */
	readonly filter: R["expr"] | undefined
	/** The ROWS frame, or undefined for the function's default frame. */
	readonly frame: WindowFrame | undefined
	readonly out: string
	/** The rewrite that produced the node (R26-R31, R41). */
	readonly rule: string
}

export interface OrderedSetAggregate<R extends RefKinds> extends NodeCommon<R> {
	readonly kind: "OrderedSetAggregate"
	readonly input: R["node"]
	readonly keys: KeySet
	readonly fn: OrderedSetFn
	/** The native aggregate overload; several fractions use the array overload. */
	readonly op: CatalogOpId
	/** WITHIN GROUP (ORDER BY value): exactly one key, the ordered value. */
	readonly order: CompletedOrder
	/**
	 * One double precision fraction per output for the percentiles, subscripted from the array overload into
	 * the outputs in order; none for mode.
	 */
	readonly fractions: ReadonlyArray<R["expr"]>
	readonly outs: ReadonlyArray<string>
	readonly rule: string
}

/**
 * The closed relational node family over one form of reference (RefKinds): one plain parametric union, so every form
 * of a DAG (live, stated, tabled, edited, folded) has the same 24 kinds with the same fields.
 */
export type NodeOver<R extends RefKinds> =
	| Base<R>
	| Closed<R>
	| Context<R>
	| InputSet<R>
	| Delta<R>
	| MatchRegion<R>
	| Filter<R>
	| ProjectSet<R>
	| SemiJoin<R>
	| AntiJoin<R>
	| Union<R>
	| Intersect<R>
	| Difference<R>
	| Take<R>
	| Group<R>
	| Produce<R>
	| Recursive<R>
	| SelfRef<R>
	| ApproximateNearest<R>
	| OrderedResult<R>
	| Attach<R>
	| Forbid<R>
	| Window<R>
	| OrderedSetAggregate<R>

/** One kind of the family over one form of reference. */
export type KindOver<K extends RelKind, R extends RefKinds> = Extract<
	NodeOver<R>,
	{ readonly kind: K }
>

/** A node's label: its identifier, a name for outputs, the snapshot and explain, never a key a reader looks it up by. */
export interface Identified {
	readonly id: NodeId
}

/**
 * The closed relational node family.
 *
 * One scoped DAG, not a SQL tree. Every node denotes a set of its complete heading under native
 * equality; no node is a bag. The family is closed: the 22 public kinds (Window and
 * OrderedSetAggregate are internal lowering nodes produced by R26-R31 and R41, never constructible from the public
 * surface), plus Delta, a ChangeSet's netted delta source for read-backs, and SelfRef, the single
 * feedback reference of a Recursive node, read only inside its step.
 *
 * A node holds its inputs and its expressions themselves: one frozen object, shared by every reader. A frozen node can
 * only hold nodes built before it, so no data edge closes a cycle: SelfRef's back edge is a name (its Recursive is
 * built after it), as are a column reference's node, a premise's node and a key proof's node, which are compared and
 * never followed.
 *
 * NodeMeta is the normative logical metadata, computed by analysis/logical. Its structural fields, the parameters and
 * stored relations a node depends on, are not claims: the one constructor (dag.ts relNode) computes them and no
 * builder states one, as none states an expression's dependencies. A builder that has not run the analysis
 * records `conservativeMeta` for the rest, which claims nothing: no key, cardinality many, every column demanded, and
 * no determinism. Wider is always sound. Physical multiplicity is optimization-only and lives in a
 * separate map (multiplicity.ts).
 */
export type RelNode = NodeOver<LiveRefs> & Identified
export type NodeOf<K extends RelKind> = Extract<RelNode, { readonly kind: K }>

/**
 * A node as a builder states it (DagBuilder.node, relNode): its body over built inputs and the metadata it
 * claims (conservativeMeta claims nothing); its identifier is minted and its structural fields computed.
 */
export type NodeSpec = NodeOver<SpecRefs>

/** The outside form of a node, every reference an identifier (dag.ts toTable). */
export type TableNode = NodeOver<TableRefs> & Identified

/**
 * The node a rewrite edits in place: its body over the editor's cells and the metadata it states. An in-place redefine
 * is `cell.current = …`, which every reader of the cell sees.
 */
export type EditNode = NodeOver<EditRefs>

/**
 * One node of an editor (dag.ts cellFold, finishCells): its label, fixed, and its current body, which a rewrite
 * replaces in place. A rewrite holding a cell keeps its identity across edits, as an identifier did.
 */
export interface Cell {
	readonly id: NodeId
	current: EditNode
}

/** A DAG's roots: any number of them, or, for a query's DAG, at least one (Rooted). */
export type Roots = ReadonlyArray<RelNode>
export type Rooted = NonEmptyReadonlyArray<RelNode>
/**
 * The roots `R` mapped root for root (a renaming, a rewrite moving a root): a one-for-one map keeps the list's shape,
 * so a non-empty list stays non-empty.
 */
export const mapRoots = <R extends Roots>(roots: R, f: (root: RelNode) => RelNode): R =>
	nominal<Roots, R>()(roots.map((root) => f(root)))

/** One scoped DAG: its roots, which hold every node it has. */
export interface RelDag<R extends Roots = Roots> {
	readonly roots: R
}

/**
 * A DAG grizzle's builders and editors assembled: every node built by the one constructor (dag.ts relNode), so its
 * structural fields are the computed ones, every label one construction minted once, and every name a node holds (a
 * column reference's node, a SelfRef's Recursive) a node in its scope. dag.ts mints it where a construction assembles
 * one, and nothing else does. The tests' strict re-reader checks every rule again over its table
 * (test/support/oracle/dag-validate.ts).
 */
export type ValidDag<R extends Roots = Roots> = RelDag<R> & { readonly [validDagBrand]: true }
declare const validDagBrand: unique symbol

/**
 * A query's DAG: valid, with the query's root first among its roots (the others are the read-backs a write's DAG
 * roots beside it).
 */
export type RootedDag = ValidDag<Rooted>

/**
 * The outside form of a DAG (dag.ts toTable, normalizeDag): its roots' labels, and every node and expression it holds
 * keyed by label, each reference an identifier. Insertion order carries no meaning.
 */
export interface DagTable {
	readonly roots: ReadonlyArray<NodeId>
	readonly nodes: Readonly<Record<NodeId, TableNode>>
	readonly exprs: Readonly<Record<ExprId, TableExpr>>
}

/**
 * How a structural map (mapNode) restates every reference a node holds but its data edges, which it yields: its
 * expressions, its region's references to its variables and the variables it declares, the labels it holds (its
 * occurrences', its scope's, and the node names of a SelfRef's feedback and a certificate's premises), and its metadata.
 * A map that renames variables maps a declaration and every reference to it to one value.
 */
export interface RefMap<R extends RefKinds, S extends RefKinds> {
	readonly expr: (expr: R["expr"]) => S["expr"]
	readonly var: (ref: R["var"]) => S["var"]
	readonly decl: (decl: VarDecl) => VarDecl
	readonly occurrence: (id: OccurrenceId) => OccurrenceId
	readonly scope: (id: ScopeId) => ScopeId
	readonly name: (id: NodeId) => NodeId
	readonly meta: (meta: R["meta"]) => S["meta"]
}

const same = <A>(a: A): A => a

/** The map that restates every reference as it is: a RefMap between any two forms that agree on the references. */
export const keptRefs = {
	expr: same,
	var: same,
	decl: same,
	occurrence: same,
	scope: same,
	name: same,
	meta: same
} as const

/** A node's stated metadata: its claims, its structural fields left behind. */
export const metaSpecOf = (meta: MetaSpec): MetaSpec => ({
	logicalKeys: meta.logicalKeys,
	card: meta.card,
	context: meta.context
})

const mapPremise = (p: Premise, name: (id: NodeId) => NodeId): Premise =>
	p.kind === "node" ? { kind: "node", node: name(p.node) } : p

/** A union's heading group with each arm yielded, in arm order, and the value sent back in its place. */
function* mapGroup<N, M>(g: HeadingGroupOver<N>): Generator<N, HeadingGroupOver<M>, M> {
	const [first, ...rest] = g.arms
	const head: M = yield first
	const tail: Array<M> = []
	for (const arm of rest) {
		const value: M = yield arm
		tail.push(value)
	}
	return { heading: g.heading, arms: [head, ...tail] }
}

/**
 * Every reference a node holds, restated in one fixed structural order: the kind's fields in declaration order, then the
 * metadata. Each data edge is yielded, and the value sent back stands in its place; every other reference is restated
 * by `m`, called in the same order. Traversal, folding, tabling, renaming and normalizing are all built on this one
 * generator, so they agree on what a node references and in what order (dag.ts normalizeDag numbers by first
 * occurrence in it).
 */
export function* mapNode<R extends RefKinds, S extends RefKinds>(
	n: NodeOver<R>,
	m: RefMap<R, S>
): Generator<R["node"], NodeOver<S>, S["node"]> {
	switch (n.kind) {
		case "Base":
			return { ...n, occurrence: m.occurrence(n.occurrence), meta: m.meta(n.meta) }
		case "Closed":
		case "Context":
		case "Delta":
		case "InputSet":
			return { ...n, meta: m.meta(n.meta) }
		case "MatchRegion": {
			const scope = m.scope(n.scope)
			const vars = n.vars.map((v) => m.decl(v))
			const occurrences: Array<OccurrenceOver<S["node"], S["expr"], S["var"]>> = []
			for (const o of n.occurrences) {
				const id = m.occurrence(o.id)
				const source: S["node"] = yield o.source
				const bindings = o.bindings.map((b) => ({ column: b.column, var: m.var(b.var) }))
				const constants = o.constants.map((c) => ({ column: c.column, expr: m.expr(c.expr) }))
				occurrences.push({ id, source, bindings, constants })
			}
			const equalities = n.equalities.map((e) => {
				const a = m.var(e.a)
				return { a, b: m.var(e.b) }
			})
			const correlated = n.correlated.map((c) => {
				const v = m.var(c.var)
				return { var: v, expr: m.expr(c.expr) }
			})
			return { ...n, scope, vars, occurrences, equalities, correlated, meta: m.meta(n.meta) }
		}
		case "Filter": {
			const input: S["node"] = yield n.input
			return { ...n, input, pred: m.expr(n.pred), meta: m.meta(n.meta) }
		}
		case "ProjectSet": {
			const input: S["node"] = yield n.input
			const out = n.out.map((o) => ({ name: o.name, expr: m.expr(o.expr) }))
			return { ...n, input, out, meta: m.meta(n.meta) }
		}
		case "SemiJoin":
		case "AntiJoin":
		case "Intersect":
		case "Difference": {
			const left: S["node"] = yield n.left
			const right: S["node"] = yield n.right
			return { ...n, left, right, meta: m.meta(n.meta) }
		}
		case "Union": {
			const [first, ...rest] = n.groups
			const head = yield* mapGroup<R["node"], S["node"]>(first)
			const tail: Array<HeadingGroupOver<S["node"]>> = []
			for (const g of rest) {
				tail.push(yield* mapGroup<R["node"], S["node"]>(g))
			}
			return { ...n, groups: [head, ...tail], meta: m.meta(n.meta) }
		}
		case "Take": {
			const input: S["node"] = yield n.input
			const correlation = n.correlation.map((c) => ({ column: c.column, expr: m.expr(c.expr) }))
			return { ...n, input, correlation, meta: m.meta(n.meta) }
		}
		case "Group": {
			const input: S["node"] = yield n.input
			const aggs = n.aggs.map((a) => mapAggregate(a, (e) => m.expr(e)))
			return { ...n, input, aggs, meta: m.meta(n.meta) }
		}
		case "Produce": {
			const input: S["node"] = yield n.input
			return n.producer === "spanPack"
				? { ...n, input, args: [m.expr(n.args[0])], meta: m.meta(n.meta) }
				: { ...n, input, args: [m.expr(n.args[0]), m.expr(n.args[1])], meta: m.meta(n.meta) }
		}
		case "Recursive": {
			const base: S["node"] = yield n.base
			const step: S["node"] = yield n.step
			const self: S["node"] = yield n.self
			const premises = n.termination.premises.map((p) => mapPremise(p, m.name))
			return {
				...n,
				base,
				step,
				self,
				termination: { ...n.termination, premises },
				meta: m.meta(n.meta)
			}
		}
		case "SelfRef":
			return { ...n, recursive: m.name(n.recursive), meta: m.meta(n.meta) }
		case "ApproximateNearest": {
			const source: S["node"] = yield n.source
			return { ...n, source, meta: m.meta(n.meta) }
		}
		case "OrderedResult": {
			const input: S["node"] = yield n.input
			return { ...n, input, meta: m.meta(n.meta) }
		}
		case "Attach": {
			const parent: S["node"] = yield n.parent
			const child: S["node"] = yield n.child
			return { ...n, parent, child, meta: m.meta(n.meta) }
		}
		case "Forbid": {
			const violation: S["node"] = yield n.violation
			return { ...n, violation, meta: m.meta(n.meta) }
		}
		case "Window": {
			const input: S["node"] = yield n.input
			const args = n.args.map((e) => m.expr(e))
			return {
				...n,
				input,
				args,
				filter: n.filter === undefined ? undefined : m.expr(n.filter),
				meta: m.meta(n.meta)
			}
		}
		case "OrderedSetAggregate": {
			const input: S["node"] = yield n.input
			const fractions = n.fractions.map((e) => m.expr(e))
			return { ...n, input, fractions, meta: m.meta(n.meta) }
		}
	}
}

/**
 * Every data edge of a node, in structural order (mapNode's), repeats kept: one per input position, as the lowering
 * reads it. A SelfRef's feedback is a name, no edge; a Recursive's base, step and SelfRef are its edges.
 */
export const edgesOf = <N>(n: NodeOver<EdgeRefs<N>>): ReadonlyArray<N> => {
	switch (n.kind) {
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "SelfRef":
			return []
		case "MatchRegion":
			return n.occurrences.map((o) => o.source)
		case "Filter":
		case "ProjectSet":
		case "Take":
		case "Group":
		case "Produce":
		case "OrderedResult":
		case "Window":
		case "OrderedSetAggregate":
			return [n.input]
		case "SemiJoin":
		case "AntiJoin":
		case "Intersect":
		case "Difference":
			return [n.left, n.right]
		case "Union":
			return n.groups.flatMap((g) => g.arms)
		case "Recursive":
			return [n.base, n.step, n.self]
		case "ApproximateNearest":
			return [n.source]
		case "Attach":
			return [n.parent, n.child]
		case "Forbid":
			return [n.violation]
	}
}

/** The data inputs of a node, in structural order without repeats. */
export const inputsOf = <N>(n: NodeOver<EdgeRefs<N>>): ReadonlyArray<N> => [...new Set(edgesOf(n))]

/** The expressions a node holds itself, in structural order (mapNode's), repeats kept. */
export const exprsOf = <E>(n: NodeOver<ExprRefs<E>>): ReadonlyArray<E> => {
	switch (n.kind) {
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "SemiJoin":
		case "AntiJoin":
		case "Union":
		case "Intersect":
		case "Difference":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "OrderedResult":
		case "Attach":
		case "Forbid":
			return []
		case "MatchRegion":
			return [
				...n.occurrences.flatMap((o) => o.constants.map((c) => c.expr)),
				...n.correlated.map((c) => c.expr)
			]
		case "Filter":
			return [n.pred]
		case "ProjectSet":
			return n.out.map((o) => o.expr)
		case "Take":
			return n.correlation.map((c) => c.expr)
		case "Group":
			return n.aggs.flatMap((a) => (a.filter === undefined ? a.args : [...a.args, a.filter]))
		case "Produce":
			return n.args
		case "Window":
			return n.filter === undefined ? n.args : [...n.args, n.filter]
		case "OrderedSetAggregate":
			return n.fractions
	}
}

/**
 * The parameters a node's own fields name, beside its expressions': an InputSet's placeholder (a membership's row has
 * none), a take's parameter bound, an approximate search's bindings and a certificate's parameter premises.
 */
export const fieldParams = (n: NodeOver<RefKinds>): ReadonlyArray<ParamId> => {
	switch (n.kind) {
		case "InputSet":
			return n.input.kind === "row" ? [] : [inputSetPlaceholder(n.input)]
		case "Take":
			return n.bound.kind === "param" ? [n.bound.param] : []
		case "ApproximateNearest":
			return n.params
		case "Recursive":
			return n.termination.premises.flatMap((p) => (p.kind === "param" ? [p.param] : []))
		case "Base":
		case "Closed":
		case "Context":
		case "Delta":
		case "MatchRegion":
		case "Filter":
		case "ProjectSet":
		case "SemiJoin":
		case "AntiJoin":
		case "Union":
		case "Intersect":
		case "Difference":
		case "Group":
		case "Produce":
		case "SelfRef":
		case "OrderedResult":
		case "Attach":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
			return []
	}
}

const noScopeExprs: ReadonlyArray<never> = Object.freeze([])

/**
 * The expressions a node evaluates in its own scope, the only ones outer values enter it through: a region's constants
 * and correlated variables, evaluated with the whole region in scope, and a take's correlation. A column reference one
 * of them makes may name any node in scope there: the region itself, another occurrence's source, or a node of an
 * enclosing scope. Every other expression a node evaluates reads its input's rows alone. The
 * scope rule (dag.ts nodeScopes) and demand analysis's lateral reads are both read from these.
 */
export const scopeExprs = <E>(n: NodeOver<ExprRefs<E>>): ReadonlyArray<E> => {
	switch (n.kind) {
		case "MatchRegion":
			return [
				...n.occurrences.flatMap((o) => o.constants.map((c) => c.expr)),
				...n.correlated.map((c) => c.expr)
			]
		case "Take":
			return n.correlation.map((c) => c.expr)
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "Filter":
		case "ProjectSet":
		case "SemiJoin":
		case "AntiJoin":
		case "Union":
		case "Intersect":
		case "Difference":
		case "Group":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "OrderedResult":
		case "Attach":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
			return noScopeExprs
	}
}

/**
 * How a node's rows are some of one input's rows under that input's heading: every row unchanged, which a delivering
 * node passes on with something more (an ordered result its order, an attachment its child's statement, a law its
 * violation check), or some rows, which a test of each row (a filter, the left side of a semi-join, anti-join,
 * intersection or difference) or an order's bound (a take, a page) keeps.
 */
export interface KeptRows<N> {
	readonly input: N
	readonly keeps: "every" | "some"
}

/**
 * The kept-rows rule, the one every walk down a node's delivered rows follows: a column of a kept row is its input's,
 * so a literal, a refinement, an attachment, a key or a column's origin read through the node is the input's. Every
 * other node computes its rows: its heading is not one input's (a projection, a group, a producer, a window, an
 * ordered set), its rows are several inputs' (a union, whose arms each walk reads as it needs), it reads none (a
 * source), or its rows are a sealed source of their own (an approximate search, whose consumers read its candidates,
 * never its source's rows).
 */
export const keptRowsOf = <N>(n: NodeOver<EdgeRefs<N>>): KeptRows<N> | undefined => {
	switch (n.kind) {
		case "OrderedResult":
			return { input: n.input, keeps: "every" }
		case "Attach":
			return { input: n.parent, keeps: "every" }
		case "Forbid":
			return { input: n.violation, keeps: "every" }
		case "Filter":
		case "Take":
			return { input: n.input, keeps: "some" }
		case "SemiJoin":
		case "AntiJoin":
		case "Intersect":
		case "Difference":
			return { input: n.left, keeps: "some" }
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "MatchRegion":
		case "ProjectSet":
		case "Union":
		case "Group":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "Window":
		case "OrderedSetAggregate":
			return undefined
	}
}

/** The input a delivering node passes on unchanged: the kept rows that are every input row. */
export const deliveredInput = <N>(n: NodeOver<EdgeRefs<N>>): N | undefined => {
	const kept = keptRowsOf(n)
	return kept?.keeps === "every" ? kept.input : undefined
}
