import type { ResolvedRule, ResolvedStage } from "#compiler/check/params.ts"
import type { SchemaReading } from "#compiler/check/schema.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { DagBuilder, ReservedNode } from "#compiler/ir/builder.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { NodeSpec, RelNode } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/**
 * Where a stage is checked: the parameters it reads, the attachment parent it is correlated to, and the feedback
 * node a recursive step's `self` source reads. Plug-ins pass it through; its fields are the checker's.
 */
export interface StageScope {
	readonly kind: "scope"
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/**
 * A node as a check states it: its body without the location, which the services record from the `loc` the node is
 * charged at, so every checked node stands for the Description node there. A check claims no metadata: the services
 * record conservativeMeta, and annotation computes the rest (logical/annotate.ts).
 */
export type CheckedNodeSpec = DistributiveOmit<NodeSpec, "loc" | "meta">

export type RecursiveStage = Extract<ResolvedStage, { readonly kind: "recursive" }>
export type ApproximateStage = Extract<ResolvedStage, { readonly kind: "approx" }>

/**
 * The contract between the checker and its plug-in directories.
 *
 * check/index.ts dispatches three families to fixed plug-in directories: recursion/, approximate/ and refinement/. The
 * dispatch is written once; each directory implements its family behind it and never edits the dispatch. This module
 * states what a plug-in receives, so every plug-in codes against one interface: the checker's services (the DAG under
 * construction, the schema, the budgets, rule checking in a scope) and the stage it is asked to check.
 *
 * The checker's services.
 */
export interface CheckServices {
	readonly schema: SchemaReading
	readonly builder: DagBuilder
	/** Records a node located at `loc`, charging the node budget there. */
	readonly node: (spec: CheckedNodeSpec, loc: SourceLoc) => RelNode
	/**
	 * A fresh label to define later (DagBuilder.reserve): a Recursive, which its SelfRef names. The services track it as
	 * reserved until it is defined (`reserved`).
	 */
	readonly reserve: () => ReservedNode
	/** Defines a reserved label (a Recursive its SelfRef names), charging the same budgets. */
	readonly define: (id: ReservedNode, spec: CheckedNodeSpec, loc: SourceLoc) => RelNode
	/**
	 * Whether a label is reserved and not yet defined: a rule's region, which the lateral sources and constants checked
	 * inside it name before its matches are checked, or a Recursive whose step is being checked.
	 */
	readonly reserved: (id: NodeId) => boolean
	/**
	 * The approximate searches this check has built, by the identity of their sealed source, score and bound
	 * (approximate/index.ts): one search per sealed source.
	 */
	readonly searches: Map<string, RelNode>
	/** The ScalarType of a descriptor the query carries (a recursive row's fields, say). */
	readonly fieldType: (desc: FieldDesc, loc: SourceLoc) => ScalarType
}

/** The checker's services in the checker's own scope type `S`, which a plug-in receives and passes back unchanged. */
export interface ScopedServices<S extends StageScope> extends CheckServices {
	/**
	 * Checks rule arms as one stage in `scope`, a `self` source reading `self` when given: their union, or the one
	 * arm's node.
	 * `self` is the recursive relation a step's arms read, undefined outside a step.
	 */
	readonly arms: (
		arms: NonEmptyReadonlyArray<ResolvedRule>,
		scope: S,
		loc: SourceLoc,
		self: RelNode | undefined
	) => RelNode
}

/** recursion/: query(S).recursive(name, { row, base, rec }). */
export interface RecursionPlugin {
	readonly check: <S extends StageScope>(
		stage: RecursiveStage,
		scope: S,
		loc: SourceLoc,
		cx: ScopedServices<S>
	) => RelNode
}

/** approximate/: Query.approximateNearest({ by, take }) over the stage's input. */
export interface ApproximatePlugin {
	readonly check: <S extends StageScope>(
		stage: ApproximateStage,
		input: RelNode,
		loc: SourceLoc,
		cx: ScopedServices<S>
	) => RelNode
}

/** refinement/: the text refinement and contract guarantees a checked value carries. */
export interface RefinementPlugin {
	/** The type of a column that several arms of one union deliver: the guarantees common to every arm. */
	readonly common: (types: NonEmptyReadonlyArray<ScalarType>) => ScalarType
}
