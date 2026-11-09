import { emptyAllenMask, parseAllenMask } from "#compiler/allen/mask.ts"
import { allenExpr } from "#compiler/check/allen.ts"
import { approximate } from "#compiler/check/approximate/index.ts"
import type { CheckedNodeSpec, ScopedServices, StageScope } from "#compiler/check/context.ts"
import { only } from "#compiler/check/defined.ts"
import { fail, failWith, unwrap } from "#compiler/check/fail.ts"
import { completeStatedOrders, type StatedOrder } from "#compiler/check/order.ts"
import type {
	ParamCell,
	ParamTable,
	Resolved,
	ResolvedAttach,
	ResolvedBound,
	ResolvedExpr,
	ResolvedHead,
	ResolvedInterior,
	ResolvedMatch,
	ResolvedQuery,
	ResolvedRule,
	ResolvedSource,
	ResolvedStage,
	ResolvedTake
} from "#compiler/check/params.ts"
import { recursion } from "#compiler/check/recursion/index.ts"
import { refinement } from "#compiler/check/refinement/index.ts"
import {
	entries,
	freshColumnName,
	type Leaves,
	parentUse,
	ruleLeaves,
	splitWhere
} from "#compiler/check/scan.ts"

import type { MemberRelation, SchemaReading } from "#compiler/check/schema.ts"
import { allenMaskMax } from "#compiler/core/allen.ts"
import { canonicalEquals, catchRefusal, everyProperty } from "#compiler/core/canonical.ts"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import { makeIdSupply, type NodeId, type ParamId, type VarId } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import { int4Max } from "#compiler/core/limits.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import {
	appendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { type Comparator, compareStrings, mapInput } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { DagBuilder, type ReservedNode } from "#compiler/ir/builder.ts"
import { deliverySpine, relNode } from "#compiler/ir/dag.ts"
import {
	descText,
	type FieldDesc,
	type LiteralDesc,
	type OrderDesc,
	type VarDesc
} from "#compiler/ir/desc.ts"

import {
	type ExprSpec,
	type DefinedOp,
	type TypedLiteral,
	OpId,
	type ParamRole,
	type ScalarExpr
} from "#compiler/ir/expr.ts"
import { headingColumns } from "#compiler/ir/law.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	type AggregateCallOver,
	type AggregateSpec,
	type CompletedOrder,
	type Correlation,
	conservativeMeta,
	type FoldInput,
	type Heading,
	type HeadingColumn,
	type KeySet,
	type Occurrence,
	type ProducerCallOver,
	type ProducerKind,
	type RelNode,
	type TakeBound,
	type VarDecl
} from "#compiler/ir/rel.ts"

import {
	baseOf,
	contractOf,
	type ScalarType,
	type SpanCarrier,
	sameScalarType,
	typeLabel
} from "#compiler/ir/scalar.ts"
import {
	type AggregateOverload,
	countOverload,
	returnsInput,
	unaryOverload
} from "#compiler/scalar/aggregate.ts"
import { bareLiteralKind } from "#compiler/scalar/compute/literal.ts"
import {
	type ClosedRelations,
	type LeafDesc,
	type LowerEnv,
	type Lowered,
	type LowerParams,
	loweredOf,
	lowerPredicate,
	lowerReturned,
	lowerTerm,
	noClosedRelations,
	type ParamRef
} from "#compiler/scalar/compute/lower.ts"
import {
	binaryCoercion,
	definedIdOf,
	definedRangeOp,
	overloadOf
} from "#compiler/scalar/compute/registry.ts"
import { type Typing, typed, untyped } from "#compiler/scalar/compute/term.ts"
import {
	anyNumeric,
	compatible,
	isComputedNumeric,
	literalNumeric,
	meetingType,
	meets,
	type PlainCarrier,
	plainType,
	valueType,
	wildcardText,
	widening,
	withoutSpanWidth
} from "#compiler/scalar/compute/types.ts"
import { CompilePatterns, type PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { hasCapability, spanType } from "#compiler/scalar/registry.ts"
import { textLookup } from "#compiler/text/refinement.ts"

/**
 * How a query is read: as rows (execute, get, compile, attach, derived, a ChangeSet member), as a page, as a
 * ChangeSet's read-back, which may read delta.added and delta.removed sources, or as a write filter's membership, which
 * reads the row it is asked at (schema/entry.ts). A read-back may name the delta of any ordinary relation: one the
 * ChangeSet does not write is empty, which the write program supplies.
 */
export type QueryRead = "rows" | "page" | "readBack" | "membership"

export interface CheckOptions {
	readonly read: QueryRead
	/**
	 * The label of the query's location in diagnostics: "query", `read <name>`, `<op> <relation>`, `derived <name>`.
	 */
	readonly label: string
}

/** A ChangeSet member described by a query: its head takes the types of the relation it is written into. */
export interface MemberTarget {
	readonly relation: MemberRelation
	readonly op: "insert" | "delete" | "put"
}

interface ParentColumn {
	readonly parent: string
	readonly name: string
	readonly type: ScalarType
}

interface ParentScope {
	/** The parent's label, which the child's correlation references name. */
	readonly node: NodeId
	readonly heading: Heading
	readonly columns: ReadonlyArray<ParentColumn>
}

/**
 * What an imported query's parameter is bound to: one of the importer's own parameters, a typed
 * constant, or an outer value read through a column of the importer's region. A constant carries the bind entry where
 * it was written: it is admitted at the imported parameter's declared type, and a refusal of it names the bind entry.
 */
type BindValue =
	| { readonly kind: "param"; readonly cell: ParamCell }
	| {
			readonly kind: "literal"
			readonly value: LiteralDesc
			readonly stated: Typing
			readonly loc: SourceLoc
	  }
	| {
			readonly kind: "column"
			readonly node: NodeId
			readonly name: string
			readonly type: ScalarType
	  }

/**
 * A bound constant at a use of `type`: the use's literal, refused when the bind entry states a type the use's is not
 * compatible with.
 */
const boundConstant = (
	schema: SchemaReading,
	constant: Extract<BindValue, { readonly kind: "literal" }>,
	type: ScalarType,
	patterns: PatternAutomata
): ExprSpec => {
	if (constant.stated.kind === "typed" && !compatible(constant.stated.type, type)) {
		fail(
			"MalformedDescription",
			constant.loc,
			`a bound constant of ${typeLabel(type)}, not ${typeLabel(constant.stated.type)}`
		)
	}
	return literalSpec(schema.literal(constant.value, type, constant.loc, patterns), type)
}

type ParamResolver =
	| { readonly kind: "own" }
	| {
			readonly kind: "bound"
			readonly values: ReadonlyMap<string, BindValue>
			readonly used: Set<string>
			readonly loc: SourceLoc
	  }

/**
 * How the query a check's root reads is read: as rows, a page, a read-back or a membership, as a ChangeSet member's
 * query, written into its relation, or as a definition, a derived relation's or a role's query entry's, which is a
 * relation.
 */
export type RootRole =
	| { readonly kind: "rows" }
	| { readonly kind: "page" }
	| { readonly kind: "readBack" }
	| { readonly kind: "membership" }
	| { readonly kind: "member"; readonly target: MemberTarget }
	| { readonly kind: "definition" }

/**
 * Where a scope's rules stand: the query's own root, read in its role; an attachment's child, correlated to its parent;
 * an import's query, its parameters bound; or a rule's interior stage. Only an attachment's child correlates to a
 * parent, and only the root writes a member or reads a page.
 */
type ScopeOrigin =
	| { readonly kind: "root"; readonly role: RootRole }
	| { readonly kind: "attachChild"; readonly parent: ParentScope }
	| { readonly kind: "import" }
	| { readonly kind: "interior" }

interface Scope extends StageScope {
	readonly params: ParamResolver
	readonly origin: ScopeOrigin
	/** The feedback reference a recursive step's arms read, undefined outside a recursive step. */
	readonly self: RelNode | undefined
}

/** The relation a scope's head is written into: a ChangeSet member root's. */
const writtenTarget = (origin: ScopeOrigin): MemberTarget | undefined =>
	origin.kind === "root" && origin.role.kind === "member" ? origin.role.target : undefined

interface StageOut {
	readonly node: RelNode
	readonly order: StageOrder
}

/**
 * The order a stage's rows carry: none; an orderBy's, which a take or the query's result reads; or the one a take
 * ranked by, whose rows are a set to whatever composes with them and which an attachment, and a root whose rows a
 * caller reads, deliver them in (rootOrder). A name or an attachment keeps its input's rows, and so a take's delivery
 * order; no stage but take reads an orderBy's (ir/desc.ts QueryStageDesc).
 */
type StageOrder =
	| { readonly kind: "none" }
	| { readonly kind: "ordered"; readonly stated: StatedOrderDesc }
	| { readonly kind: "delivered"; readonly stated: StatedOrderDesc }

const unordered: StageOrder = { kind: "none" }

/** The order a stage that keeps its input's rows as they are carries: a take's delivery order, else none. */
const keptOrder = (input: StageOrder): StageOrder =>
	input.kind === "delivered" ? input : unordered

/**
 * The order a root's rows are delivered in: the one its last stage carries, an orderBy's or the take's it ends in,
 * where its role hands its rows to a caller (rows, a page, a read-back), so a take reaches a caller in its order as it
 * reaches an attachment's parent; and none where its rows are a set: a member's, written into its relation, a
 * membership's, tested, and a definition's, a relation.
 */
const rootOrder = (order: StageOrder, role: RootRole): StatedOrderDesc | undefined => {
	switch (role.kind) {
		case "rows":
		case "page":
		case "readBack":
			return order.kind === "none" ? undefined : order.stated
		case "membership":
		case "member":
		case "definition":
			return undefined
	}
}

interface StatedOrderDesc {
	readonly keys: ReadonlyArray<OrderDesc>
	readonly at: SourceLoc
}

/** The first match column a slot is bound to: the slot takes its type. */
interface Binding {
	readonly type: ScalarType
}

/** An outer value a slot is correlated to: a column of the attachment parent or of the importer. */
interface Outer {
	readonly node: NodeId
	readonly name: string
	readonly type: ScalarType
}

interface SlotOf<Kind extends string> {
	readonly kind: Kind
	readonly id: VarId
	readonly name: string
}

/**
 * A variable of a rule's region. A rule variable is reserved when the rule is declared (its identifier and column
 * name) and becomes a slot at the first match binding it, which gives it its type. A parent variable is correlated to
 * its parent column until a match binds it. An imported parameter bound to an outer value is correlated to it, and the
 * region carries it only when a filter, the head or a fallback equality reads it (needed). A hidden variable is bound
 * to a second column of another type and equated with its variable by the filter.
 */
type ReservedUser = SlotOf<"user">
type UserSlot = ReservedUser & { readonly binding: Binding }
type ParentSlot = SlotOf<"parent"> & { readonly outer: Outer }
type ParamSlot = SlotOf<"param"> & { readonly outer: Outer }
type HiddenSlot = SlotOf<"hidden"> & { readonly binding: Binding }
type Slot = UserSlot | ParentSlot | ParamSlot | HiddenSlot

type AggregateHead = Extract<ResolvedHead, { readonly kind: "aggregate" }>
type ProducerHead = Extract<ResolvedHead, { readonly kind: "producer" }>

/**
 * An equality the rule's filter owes: a variable and the hidden variable bound to a second column of another
 * refinement or typmod, or a hidden variable and the value a binding fixes its column to.
 */
type PendingEquality =
	| { readonly kind: "slots"; readonly left: UserSlot | ParentSlot; readonly right: HiddenSlot }
	| { readonly kind: "value"; readonly hidden: HiddenSlot; readonly value: ScalarExpr }

/** A slot a match binds a source column to: a rule or parent variable, or a hidden one. */
type BoundSlot = UserSlot | ParentSlot | HiddenSlot

/** A source column a match binds, and the slot it is bound to. */
interface SlotBinding {
	readonly column: string
	readonly var: BoundSlot
}

interface PendingOccurrence {
	readonly match: ResolvedMatch
	readonly index: number
	readonly loc: SourceLoc
	readonly source: RelNode
	readonly heading: Heading
	readonly bindings: ReadonlyArray<SlotBinding>
	readonly constants: ReadonlyArray<{ readonly column: string; readonly expr: ScalarExpr }>
}

/**
 * A literal head column of an arm: its IR literal at the column's type, and what typed it. A fixed literal's type is
 * the one it states (X.handle, Compute.literal), the declared type of the imported parameter it is bound to, or the
 * written column's; a bare literal (a JavaScript value in a head) meets no term in its rule, so its type there is its
 * value's JavaScript default (Checker bareLiteralType), which a union retypes by its position, the type the arms that deliver the column
 * by a term agree on (Checker #positionedTypes).
 */
type HeadLiteral =
	| { readonly kind: "fixed"; readonly literal: TypedLiteral }
	| {
			readonly kind: "bare"
			readonly literal: TypedLiteral
			readonly value: LiteralDesc
			readonly loc: SourceLoc
	  }

/** How a head literal is typed in its rule: fixed at the type it states or writes, or bare, at its value's default. */
type LiteralTyping =
	| { readonly kind: "fixed"; readonly type: ScalarType }
	| { readonly kind: "bare" }

/** A head term: its expression, its type, and the literal a literal term is, undefined for any other term. */
interface TermOut {
	readonly expr: ScalarExpr
	readonly type: ScalarType
	readonly literal: HeadLiteral | undefined
}

/**
 * A negated binding correlated with a slot of the rule's region: the slot's region column, and the column of the
 * negation's left input that delivers it, the slot's own column over the region or the head key delivering it after the
 * head.
 */
interface NegatedCorrelation {
	readonly region: HeadingColumn
	readonly on: string
}

/** The correlation of a negated binding, `column` bound to `e`, or undefined for a binding correlated with no slot. */
type Correlate = (column: string, e: ResolvedExpr, at: SourceLoc) => NegatedCorrelation | undefined

/** A negation the rule applies after its head: its place in the rule's where and each correlated binding's. */
interface LateNegation {
	readonly index: number
	readonly absent: Extract<ResolvedExpr, { readonly kind: "absent" }>
	readonly correlated: ReadonlyMap<string, NegatedCorrelation>
}

/** How a binding of a negated match lands in its region (RuleCheck #negatedBinding). */
type NegatedBinding =
	| {
			readonly kind: "correlated"
			readonly column: string
			readonly type: ScalarType
			readonly left: string
	  }
	| { readonly kind: "constant"; readonly column: string; readonly expr: ScalarExpr }
	| {
			readonly kind: "filtered"
			readonly column: string
			readonly type: ScalarType
			readonly value: ScalarExpr
	  }
	| { readonly kind: "none" }

/** How a constant binding lands: a constant of the region that fixes the column, or a value the filter equates with it. */
type ConstantPlacement = { readonly kind: "fix" | "filter"; readonly expr: ScalarExpr }

/** One output column of a projection: its name, its expression and the heading column it makes. */
interface OutColumn {
	readonly name: string
	readonly expr: ScalarExpr
	readonly type: ScalarType
}

const projectionOf = (out: ReadonlyArray<OutColumn>) => ({
	out: out.map((o) => ({ name: o.name, expr: o.expr })),
	heading: out.map((o): HeadingColumn => ({ name: o.name, type: o.type }))
})

const columnSpec = (node: NodeId, name: string, type: ScalarType): ExprSpec => ({
	kind: "column",
	column: { node, name },
	args: [],
	type,
	nonNull: "storage"
})

const literalSpec = (value: TypedLiteral, type: ScalarType): ExprSpec => ({
	kind: "literal",
	value,
	args: [],
	type,
	nonNull: "literal"
})

const paramSpec = (param: ParamId, role: ParamRole, type: ScalarType): ExprSpec => ({
	kind: "param",
	param,
	role,
	args: [],
	type,
	nonNull: "codec"
})

/** The type a comparison parameter is bound as: the base, plain text for regex text. */
const compareType = (t: ScalarType): ScalarType => {
	const base = baseOf(t)
	return base.carrier === "text" ? wildcardText : base
}

/**
 * The type a bare literal adopts opposite a term of type t in a comparison: the contract and its refinements
 * when it has one, otherwise the value type, a numeric widened to every numeric value and a span's fixed width dropped
 * (scalar/compute/lower.ts Lowering.adopt).
 */
const adoptCompare = (t: ScalarType): ScalarType => {
	if (contractOf(t) !== undefined) {
		return t
	}
	const v = valueType(t)
	return v.carrier === "numeric" ? anyNumeric : withoutSpanWidth(v)
}

/**
 * The refusal of a column with no equality capability where a binding would compare it, saying `why`: a join, a
 * correlation and a constant each compare the column, which a stored-only type, as bytes is, never is.
 */
const comparable = (column: HeadingColumn, why: string, loc: SourceLoc): void => {
	if (!hasCapability(column.type, "equality")) {
		fail(
			"UnsupportedOperation",
			loc,
			`equality: column ${column.name} is ${typeLabel(column.type)}, which has no equality: ${why}`
		)
	}
}

const columnOf = (heading: Heading, name: string): HeadingColumn | undefined =>
	heading.find((c) => c.name === name)

const hasColumn = (heading: Heading, name: string): boolean => heading.some((c) => c.name === name)

/** The lowering environment of a query expression, whose parameters are its rule's scope. */
type QueryEnv = Extract<LowerEnv<Resolved>, { readonly mode: "query" }> & {
	readonly params: Extract<LowerParams<Resolved>, { readonly kind: "scope" }>
}

/**
 * Where a query's expression stands: in a rule's filter, a predicate whose IS TRUE refuses a value that is absent, or
 * in a value the query delivers or binds, which is never absent.
 */
type ExprReading = "filter" | "value"

/**
 * What a value the query delivers or binds applies of the closed relations: none, since C.at at a key no tuple holds
 * reads no value (ir/expr.ts closedAt), and only a predicate and a generated column refuse it.
 */
const deliveredValue: ClosedRelations = noClosedRelations(
	"a closed read stands in a rule's filter or a generated field's expression, where a key no tuple holds is refused, never in a value the query delivers or binds"
)

/**
 * The span type a type is over through its contracts, or undefined for a type that is no span. A contract's carrier is
 * its base's, so a term's nominal and actual types, which differ at most by a contract, are over one span carrier.
 */
type SpanBase = Extract<ScalarType, { readonly carrier: SpanCarrier }>
const spanBase = (t: ScalarType): SpanBase | undefined => {
	const base = baseOf(t)
	return base.carrier === "range4" || base.carrier === "range8" || base.carrier === "rangeDate"
		? base
		: undefined
}

/**
 * The result column of each aggregate head key, in order: its own name, or `__agg_<name>_<n>` for the least n from 2
 * when a group key or an earlier aggregate takes it.
 */
const aggregateColumns = (
	keyColumns: ReadonlyArray<string>,
	aggregates: NonEmptyReadonlyArray<readonly [string, AggregateHead]>
): NonEmptyReadonlyArray<Placed<AggregateHead>> => {
	const taken = new Set(keyColumns)
	return mapNonEmpty(aggregates, ([name, head]) => {
		let column = name
		for (let n = 2; taken.has(column); n++) {
			column = `__agg_${name}_${n}`
		}
		taken.add(column)
		return { name, column, head }
	})
}

/** The result column of a head's span producer: its own name, or `__produced_<name>` when a group key takes it. */
const producedColumn = (
	keyColumns: ReadonlyArray<string>,
	[name, head]: readonly [string, ProducerHead]
): Placed<ProducerHead> => ({
	name,
	column: keyColumns.includes(name) ? `__produced_${name}` : name,
	head
})

/**
 * What a head folds, or undefined for a head of plain terms: aggregates and a span producer never share a head, and a
 * head has at most one producer.
 */
const foldedOf = (
	at: SourceLoc,
	aggregates: ReadonlyArray<readonly [string, AggregateHead]>,
	producers: ReadonlyArray<readonly [string, ProducerHead]>
): Folded | undefined => {
	const [producer, ...more] = producers
	if (isNonEmpty(aggregates)) {
		if (producer !== undefined) {
			fail(
				"UnsupportedOperation",
				at,
				"aggregate and span producer in one head: a producer yields facts per binding, an aggregate folds them"
			)
		}
		return { kind: "aggregates", aggregates }
	}
	if (producer === undefined) {
		return undefined
	}
	if (more.length > 0) {
		fail("UnsupportedOperation", at, "one span producer per head")
	}
	return { kind: "producer", producer }
}

/** A column of a union's arm, with the bare head literal the arm delivers it by, if any. */
interface Delivered {
	readonly column: HeadingColumn
	readonly bare: BareLiteral | undefined
}

/** A head's folding node, with each folded term's result column of its heading. */
interface Folding {
	readonly node: RelNode
	readonly results: ReadonlyArray<{ readonly name: string; readonly column: HeadingColumn }>
}

/** A head term placed under its result column. */
interface Placed<H> {
	readonly name: string
	readonly column: string
	readonly head: H
}

/** What a head folds: its aggregates, or its one span producer. */
type Folded =
	| {
			readonly kind: "aggregates"
			readonly aggregates: NonEmptyReadonlyArray<readonly [string, AggregateHead]>
	  }
	| { readonly kind: "producer"; readonly producer: readonly [string, ProducerHead] }

/** Whether a term is an untyped literal, which takes the type of the term it meets. */
const isBareLiteral = (d: ResolvedExpr): boolean => d.kind === "literal" && d.type === undefined

/** A scalar parameter reference: its cell and its declared type. */
type ParamExpr = ParamRef<Resolved>

/** The key of a heading: its column names, sorted. */
const headingKey = (h: Heading): string =>
	h
		.map((c) => c.name)
		.toSorted(compareStrings)
		.join("\u0000")

/** The attachment names of rows that carry none. */
const carriesNone: ReadonlySet<string> = new Set()

/** Named things in code unit order of their names. */
const byName: Comparator<{ readonly name: string }> = mapInput(
	compareStrings,
	(named: { readonly name: string }) => named.name
)

/** The one widening (types.ts widening) of a value of `from` into `to`, refused where `to` widens none of it. */
const widened = (from: ScalarType, to: ScalarType, loc: SourceLoc): DefinedOp =>
	widening(from, to) ??
	fail("UnsupportedOperation", loc, `a widening of ${typeLabel(from)} into ${typeLabel(to)}`)

const sameTypes = (types: NonEmptyReadonlyArray<ScalarType>): boolean =>
	types.every((t) => sameScalarType(t, types[0]))

const compatibleTypes = (types: NonEmptyReadonlyArray<ScalarType>): boolean =>
	types.every((t) => compatible(t, types[0]))

/**
 * The type a group of arms delivers `column` at, given each arm's type for it: the type every arm shares, or the
 * guarantees common to them; arms of incompatible types are refused.
 */
const groupColumnType = (
	types: NonEmptyReadonlyArray<ScalarType>,
	column: HeadingColumn,
	loc: SourceLoc
): ScalarType => {
	if (sameTypes(types)) {
		return types[0]
	}
	if (compatibleTypes(types)) {
		return refinement.common(types)
	}
	return fail(
		"MalformedDescription",
		loc,
		`arms of one heading with one type per column; ${column.name} is ${types.map(typeLabel).join(" and ")}`
	)
}

/** The type arms agree on: the one they share, or the guarantees common to them; none when they are incompatible. */
const agreedType = (types: ReadonlyArray<ScalarType>): ScalarType | undefined => {
	if (!isNonEmpty(types)) {
		return undefined
	}
	if (sameTypes(types)) {
		return types[0]
	}
	return compatibleTypes(types) ? refinement.common(types) : undefined
}

type BareLiteral = Extract<HeadLiteral, { readonly kind: "bare" }>

/** A literal head column typed by its position, or none for any other column. */
const bareOf = (head: HeadLiteral | undefined): BareLiteral | undefined =>
	head?.kind === "bare" ? head : undefined

/**
 * The columns every group delivers, in the first heading's order, each with the guarantees common to all that every
 * group's target widens it to, or undefined when every group delivers it at one type. Groups deliver every column they
 * share at compatible types (Checker.union refuses any other).
 */
const commonColumnsOf = (
	firstHeading: Heading,
	groups: NonEmptyReadonlyArray<{ readonly target: ReadonlyMap<string, ScalarType> }>
): ReadonlyArray<{ readonly name: string; readonly widen: ScalarType | undefined }> =>
	firstHeading.flatMap(
		(c): ReadonlyArray<{ readonly name: string; readonly widen: ScalarType | undefined }> => {
			const known = everyDefined(mapNonEmpty(groups, (g) => g.target.get(c.name)))
			if (known === undefined) {
				return []
			}
			return [{ name: c.name, widen: sameTypes(known) ? undefined : refinement.common(known) }]
		}
	)

/** Every element of a non-empty list, when none is undefined. */
const everyDefined = <A>(
	xs: NonEmptyReadonlyArray<A | undefined>
): NonEmptyReadonlyArray<A> | undefined => {
	const [head, ...tail] = xs
	if (head === undefined) {
		return undefined
	}
	const out: [A, ...Array<A>] = [head]
	for (const x of tail) {
		if (x === undefined) {
			return undefined
		}
		out.push(x)
	}
	return out
}

const producerKinds = {
	intersection: "spanIntersection",
	difference: "spanDifference",
	pack: "spanPack"
} as const satisfies Readonly<Record<"intersection" | "difference" | "pack", ProducerKind>>

const int4TakeCapability = `a positive integer bound for take, at most ${int4Max.value}`

/**
 * A take bound has one domain, int4's positive range, however it is spelled: a literal, or a parameter an import
 * binds to a literal (the parameter itself is typed int4).
 * A literal take is positive by its description (ir/desc.ts takeDescShape), and a nonpositive bound breaks a rule of the
 * relational DAG too, but an imported query's take bound by `bind` to a literal reaches here first: this refuses it at
 * the query that binds it, in int4's terms.
 */
const int4TakeBound = (k: bigint, loc: SourceLoc): TakeBound => {
	if (k < 1n || k > BigInt(int4Max.value)) {
		fail("MalformedDescription", loc, int4TakeCapability)
	}
	return { kind: "literal", k }
}

/**
 * The checker: a ResolvedQuery to a LogicalQuery DAG.
 *
 * It resolves every name a query description uses against the schema, types every expression through the Compute
 * catalogue, and builds the scoped relational DAG with exact headings and binding semantics. The shapes are:
 *
 * - A rule is one MatchRegion over its matches: one occurrence per match, each over a fresh source node
 *   (a Base or Closed scan, a relation parameter's InputSet, an imported query's DAG, an interior stage, a read-back's
 *   Delta). A variable shared by several matches is the join. Its heading is its complete binding: every variable a
 *   match binds, whether or not the head names it, so a fold sees the distinct full bindings. A literal,
 *   parameter or computed binding fixes its column. Every source column neither bound nor fixed is an existential
 *   witness. Variables are named by the field `v` took them from, which survives a round trip through a
 *   QueryDescription; allocated VarIds never name anything.
 * - Its scalar filters are one Filter over the region; each `r.not` is an AntiJoin against the negated source projected
 *   onto the columns the rule's values fix.
 * - Its head is a ProjectSet, a set projection, or with aggregates a Group over the complete bound tuple, keyed by the
 *   non-aggregate head terms. A constant head term beside aggregates is not a group key: it
 *   is added by a projection over the groups, so no literal is ever a grouping item.
 * - Arms are a Union, grouped by heading. Arms of different headings need a literal discriminant: the columns present in
 *   every arm and bound to a literal in every head, with differing literal tuples for arms of different headings
 *   (MissingDiscriminant); the roster-typed ones alone when they tell the groups apart. A bare head literal is typed
 *   by its position across the whole union (#positions). A column several arms deliver keeps the guarantees common to
 *   them all (refinement/). A match or negation of a query selects the arms its constants may meet, refusing
 *   constants no arm delivers, and narrows a union of several headings to them (RuleCheck #narrow). An arm whose rows
 *   carry an attachment, its own or under a take or a name, shares its heading with no other arm (Checker.union).
 * - orderBy is completed to a total order: an Ordered query, and a query ending in a take whose rows a caller reads,
 *   delivers an OrderedResult, take a Take, an ordered attachment the order on its Attach. Each is built with the
 *   conservative completion, the remaining heading, and once the DAG is whole order.ts completes the stated order
 *   under the logical keys instead, so the completion stops as soon as the order is total (logical/order.ts).
 * - An attachment is an Attach whose child delivers its correlation columns beside its heading: each parent variable the
 *   child reads becomes a variable of the child's rules, bound where a match binds it and correlated to the parent row
 *   otherwise, delivered under one name by every arm and correlated by the Attach. A child that reads no
 *   parent variable is AttachedParentUnbound; a page over a query correlated to a parent is AttachedPage.
 *   Delivered types start at ReadonlyArray; analysis/logical narrows them by evidence.
 * - An imported query is checked in its own scope: its parameters are not the importer's but
 *   are bound by its complete bind map to the importer's parameters, variables or typed constants, so two imports bind
 *   one name differently without capture. A bind to an outer variable correlates the import: its source reads the
 *   importer's region, placed LATERAL by the lowering.
 * - A parameter is typed from its uses and unified across the query (params.ts), bound as its base type wherever it is
 *   compared and cast to the refinement where it is written or emitted. A literal adopts the type of the
 *   term it meets and is checked against that type's contract and regex refinement (ContractLiteral).
 *
 * - A context is a Context leaf of at most one row, its heading the context's fields typed against the schema (a closed
 *   handle names a roster of the schema). One query names each context with one descriptor (DuplicateIdentity).
 *   Checked against a role, a query reads only the contexts the role's relations read, as they declare them: a Db of
 *   the role holds facts of those alone.
 *
 * Recursive and approximate stages are plug-ins (context.ts). A query reads only what its schema declares: checked
 * against a role, only the role's relations.
 */
export class Checker {
	readonly schema: SchemaReading
	readonly options: CheckOptions
	readonly b: DagBuilder
	readonly params: ParamTable
	/**
	 * The literal head columns of every arm node, for typing a bare one by its position in a union, for discriminants
	 * and for narrowing a matched union.
	 */
	readonly #literals = new Map<RelNode, Map<string, HeadLiteral>>()
	/** The arms of every union node, for flattening a further rule and for narrowing a matched union. */
	readonly #unions = new Map<
		RelNode,
		{ readonly arms: NonEmptyReadonlyArray<RelNode>; readonly discriminant: ReadonlyArray<string> }
	>()
	/**
	 * The heading each union arm a widening projection rewrote delivered before it was widened (#widenArm): its columns'
	 * own types, which bound the values the arm delivers, for selecting a matched union's arms (RuleCheck #delivers).
	 */
	readonly #delivered = new Map<RelNode, Heading>()
	/**
	 * The attachment names each node's rows carry, never empty: an Attach's and its parent's, those of the rows a node
	 * keeps (#inherit) and those of every arm of a union. A node it holds none for carries none (#carried).
	 */
	readonly #attached = new Map<RelNode, ReadonlySet<string>>()
	/** Contracts the query declares itself, for DuplicateIdentity. */
	readonly #contracts = new Map<string, { text: string; loc: SourceLoc }>()
	/** The admitted patterns the query's compile reads (scalar/regex/patterns.ts), each parsed once per query. */
	readonly patterns = new CompilePatterns()
	/** The contexts the query matches, each with its descriptor's canonical text, for DuplicateIdentity. */
	readonly #contexts = new Map<string, { text: string; loc: SourceLoc }>()
	/**
	 * The order the user stated for each Take, OrderedResult and ordered Attach, completed once the DAG is built
	 * (order.ts).
	 */
	readonly #stated = new Map<RelNode, StatedOrder>()
	/** The labels reserved and not yet defined: the regions of the rules being checked, the recursions being checked. */
	readonly #reserved = new Set<NodeId>()
	/** The approximate searches built, by the identity of their sealed source, score and bound (approximate/). */
	readonly #searches = new Map<string, RelNode>()

	/** `params` are the cells of the resolved description the checker checks (params.ts resolveQuery). */
	constructor(schema: SchemaReading, options: CheckOptions, params: ParamTable) {
		this.schema = schema
		this.options = options
		this.b = new DagBuilder(makeIdSupply())
		this.params = params
	}

	/** Records an expression, built over its arguments with its effects (ir/expr.ts builtExpr). */
	emit(spec: ExprSpec): ScalarExpr {
		return this.b.expr(spec)
	}

	node(spec: CheckedNodeSpec, loc: SourceLoc): RelNode {
		return this.b.node({ ...spec, loc, meta: conservativeMeta })
	}

	/** A fresh label to define later, reserved until it is defined. */
	reserve(): ReservedNode {
		const id = this.b.reserve()
		this.#reserved.add(id)
		return id
	}

	define(id: ReservedNode, spec: CheckedNodeSpec, loc: SourceLoc): RelNode {
		this.#reserved.delete(id)
		return this.b.define(id, { ...spec, loc, meta: conservativeMeta })
	}

	/**
	 * `node` restated as `spec`, at `loc`, under its own label: the node an order completion puts in its place, its
	 * inputs and fields the checker's but its order (order.ts StatedOrder withOrder).
	 */
	#restated(node: RelNode, spec: CheckedNodeSpec, loc: SourceLoc): RelNode {
		return relNode(node.id, { ...spec, loc, meta: conservativeMeta })
	}

	fieldType(desc: FieldDesc, loc: SourceLoc): ScalarType {
		return this.schema.queryFieldType(desc, loc, this.#contracts, this.patterns)
	}

	/**
	 * A scalar parameter's declared type (lower.ts Lowering.param). A channel the checker writes declares none: its import
	 * binds it to a column, which every use of it reads.
	 */
	paramType(param: ParamExpr, loc: SourceLoc): ScalarType {
		if (param.type.kind === "channel") {
			return fail(
				"MalformedDescription",
				loc,
				`parameter ${param.cell.name} bound to a column: a channel of a factored recursion is read as its column`
			)
		}
		return this.fieldType(param.type, loc)
	}

	services(): ScopedServices<Scope> {
		return {
			schema: this.schema,
			builder: this.b,
			node: (spec, loc) => this.node(spec, loc),
			reserve: () => this.reserve(),
			define: (id, spec, loc) => this.define(id, spec, loc),
			reserved: (id) => this.#reserved.has(id),
			searches: this.#searches,
			arms: (arms, scope, loc, self) =>
				this.arms(arms, self === undefined ? scope : { ...scope, self }, loc),
			fieldType: (desc, loc) => this.fieldType(desc, loc)
		}
	}

	ownScope(role: RootRole): Scope {
		return {
			kind: "scope",
			params: { kind: "own" },
			origin: { kind: "root", role },
			self: undefined
		}
	}

	/**
	 * The query's DAG as a whole: its stages, then an OrderedResult in the order its rows are delivered in, where its
	 * role delivers them in one (rootOrder). Its parameters are the table's once the pass is final (check/index.ts).
	 */
	root(desc: ResolvedQuery, loc: SourceLoc, role: RootRole): LogicalQuery["dag"] {
		if (this.options.read === "page" && desc.stage.kind !== "order") {
			fail(
				"MalformedDescription",
				loc,
				"an Ordered query for a page: page reads the completed order of an orderBy"
			)
		}
		const out = this.stage(desc.stage, this.ownScope(role))
		const order = rootOrder(out.order, role)
		const root = order === undefined ? out.node : this.#orderedResult(out.node, order)
		return unwrap(completeStatedOrders(this.b.build([root]), this.#stated))
	}

	/** A root's delivered rows: its rows under the order stated, which order.ts completes. */
	#orderedResult(input: RelNode, stated: StatedOrderDesc): RelNode {
		const heading = input.heading
		const at = stated.at
		const node = this.node(
			{ kind: "OrderedResult", input, order: this.complete(stated, heading, new Set()), heading },
			at
		)
		this.#state(node, stated, {
			input,
			fixed: [],
			withOrder: (order) =>
				this.#restated(node, { kind: "OrderedResult", input, order, heading }, at)
		})
		return node
	}

	stage(s: ResolvedStage, scope: Scope): StageOut {
		/** An attachment stage is located at its attach entry, whose child is below it. */
		const here = s.kind === "attach" ? s.attach.loc : s.loc
		switch (s.kind) {
			case "rules":
				return { node: this.arms(s.arms, scope, childLoc(here, "arms")), order: unordered }
			case "recursive":
				return { node: recursion.check(s, scope, here, this.services()), order: unordered }
			case "union": {
				const input = this.stage(s.input, scope)
				const prior = this.#unions.get(input.node)?.arms ?? [input.node]
				const added = s.arms.map((arm) => this.rule(arm, scope))
				return { node: this.union([...prior, ...added], here), order: unordered }
			}
			case "attach": {
				const input = this.stage(s.input, scope)
				return {
					node: this.attachIn(input.node, s.attach, scope, here),
					order: keptOrder(input.order)
				}
			}
			case "named": {
				const input = this.stage(s.input, scope)
				return { node: input.node, order: keptOrder(input.order) }
			}
			case "order": {
				const input = this.stage(s.input, scope)
				return {
					node: input.node,
					order: { kind: "ordered", stated: { keys: s.order, at: childLoc(here, "order") } }
				}
			}
			case "take": {
				const input = this.stage(s.input, scope)
				if (input.order.kind !== "ordered") {
					return fail("MalformedDescription", here, "take over an Ordered query")
				}
				const stated = input.order.stated
				return {
					node: this.take(input.node, stated, s.take, scope, here),
					order: { kind: "delivered", stated }
				}
			}
			case "approx": {
				const input = this.stage(s.input, scope)
				return { node: approximate.check(s, input.node, here, this.services()), order: unordered }
			}
		}
	}

	/**
	 * The placeholder completion a node is built with: the user's keys, then the rest of the heading in heading order,
	 * less the columns `fixed` holds constant, such as an attachment's correlation. It is total without evidence, so the
	 * DAG is valid as it is built; the stated order, recorded by #state, is completed under the logical keys once the
	 * DAG is whole (order.ts).
	 */
	complete(order: StatedOrderDesc, heading: Heading, fixed: ReadonlySet<string>): CompletedOrder {
		for (const [i, o] of order.keys.entries()) {
			if (!hasColumn(heading, o.column)) {
				fail(
					"MalformedDescription",
					childLoc(order.at, i),
					`an order column of the query's heading, over a union one common to every arm; ${o.column} is not one`
				)
			}
		}
		const named = new Set(order.keys.map((o) => o.column))
		return {
			keys: [
				...order.keys.map((o) => ({ column: o.column, dir: o.dir })),
				...heading
					.filter((c) => !named.has(c.name) && !fixed.has(c.name))
					.map((c) => ({ column: c.name, dir: "asc" as const }))
			]
		}
	}

	/**
	 * Records the order the user stated for `node`, which order.ts completes: the relation it orders, the columns fixed
	 * per evaluation of it, and the node with a completed order in its place.
	 */
	#state(
		node: RelNode,
		order: StatedOrderDesc,
		ordered: Pick<StatedOrder, "input" | "fixed" | "withOrder">
	): void {
		this.#stated.set(node, {
			keys: order.keys.map((o) => ({ column: o.column, dir: o.dir })),
			at: order.at,
			...ordered
		})
	}

	take(
		input: RelNode,
		stated: StatedOrderDesc,
		take: ResolvedTake,
		scope: Scope,
		loc: SourceLoc
	): RelNode {
		const heading = input.heading
		const origin = scope.origin
		const correlation: ReadonlyArray<Correlation> =
			origin.kind === "attachChild"
				? origin.parent.columns.map((c) => ({
						column: c.name,
						expr: this.emit(columnSpec(origin.parent.node, c.parent, c.type))
					}))
				: []
		const fixed = new Set(correlation.map((c) => c.column))
		const order = this.complete(stated, heading, fixed)
		const bound = this.takeBound(take, scope, loc)
		const node = this.node({ kind: "Take", input, order, bound, correlation, heading }, loc)
		this.#state(node, stated, {
			input,
			fixed: correlation.map((c) => c.column),
			withOrder: (completed) =>
				this.#restated(
					node,
					{ kind: "Take", input, order: completed, bound, correlation, heading },
					loc
				)
		})
		this.#inherit(node, input)
		return node
	}

	takeBound(take: ResolvedTake, scope: Scope, loc: SourceLoc): TakeBound {
		if (take.kind === "literal") {
			return int4TakeBound(BigInt(take.k), loc)
		}
		const int4 = plainType("int4")
		const resolved = this.#resolveParam(take.cell, scope, loc)
		switch (resolved.kind) {
			case "param":
				return { kind: "param", param: resolved.cell.use(int4, loc) }
			case "literal": {
				const v = resolved.value
				if (typeof v === "bigint") {
					return int4TakeBound(v, resolved.loc)
				}
				if (typeof v === "number" && Number.isSafeInteger(v)) {
					return int4TakeBound(BigInt(v), resolved.loc)
				}
				return fail("MalformedDescription", resolved.loc, int4TakeCapability)
			}
			case "column":
				return fail(
					"UnsupportedOperation",
					loc,
					`take bound: a bound per outer variable; take's bound is a positive literal or a parameter`
				)
		}
	}

	/** Rule arms as one stage: the one arm's node, or their union. */
	arms(arms: NonEmptyReadonlyArray<ResolvedRule>, scope: Scope, loc: SourceLoc): RelNode {
		const nodes = mapNonEmpty(arms, (arm) => this.rule(arm, scope))
		return only(nodes) ?? this.union(nodes, loc)
	}

	#inherit(node: RelNode, from: RelNode): void {
		const literals = this.#literals.get(from)
		if (literals !== undefined) {
			this.#literals.set(node, literals)
		}
		const attached = this.#attached.get(from)
		if (attached !== undefined) {
			this.#attached.set(node, attached)
		}
	}

	/** The attachment names a node's rows carry (#attached). */
	#carried(node: RelNode): ReadonlySet<string> {
		return this.#attached.get(node) ?? carriesNone
	}

	/**
	 * A union fact can come from several arms of one heading, so which arm's attachment it would carry is undetermined:
	 * an arm whose rows carry an attachment (#carried), through whatever stage keeps its rows, shares its heading with no
	 * other arm. The union's rows carry every arm's attachments.
	 *
	 * A union of several headings delivers each heading group only as a query's result (ir/dag.ts deliverySpine): a
	 * take, an attachment or any stage over it has the columns its groups share for its heading, so as an arm it would
	 * deliver those alone, and is refused.
	 */
	union(arms: NonEmptyReadonlyArray<RelNode>, loc: SourceLoc): RelNode {
		for (const arm of arms) {
			const ends = deliverySpine(arm).arms?.union
			if (ends !== undefined && ends.groups.length > 1) {
				fail(
					"UnsupportedOperation",
					loc,
					"an arm over a union of several headings: only a query's result delivers each heading group, and an arm would deliver the columns they share alone"
				)
			}
		}
		const [first, ...more] = arms
		type Group = { readonly key: string; readonly arms: [RelNode, ...Array<RelNode>] }
		const groups: [Group, ...Array<Group>] = [{ key: headingKey(first.heading), arms: [first] }]
		for (const arm of more) {
			const k = headingKey(arm.heading)
			const g = groups.find((x) => x.key === k)
			if (g === undefined) {
				groups.push({ key: k, arms: [arm] })
			} else {
				g.arms.push(arm)
			}
		}
		for (const g of groups) {
			if (g.arms.length > 1 && g.arms.some((a) => this.#carried(a).size > 0)) {
				fail(
					"UnsupportedOperation",
					loc,
					"attachment on an arm of a union whose heading several arms share: a fact can come from several arms, so which arm's attachment it carries is undetermined"
				)
			}
		}
		const positions = this.#positions(arms)
		const targets = mapNonEmpty(groups, (g) => ({
			arms: g.arms,
			target: this.#groupTarget(g.arms, positions, loc)
		}))
		for (const [gi, g] of targets.entries()) {
			for (const earlier of targets.slice(0, gi)) {
				for (const [name, type] of g.target) {
					const known = earlier.target.get(name)
					if (known !== undefined && !compatible(known, type)) {
						fail(
							"MalformedDescription",
							loc,
							`arms of one query with one type per column they share; ${name} is ${typeLabel(known)} and ${typeLabel(type)}`
						)
					}
				}
			}
		}
		const firstHeading = first.heading
		const commonColumns = groups.length > 1 ? commonColumnsOf(firstHeading, targets) : []
		const widenings = commonColumns.flatMap(({ name, widen }) =>
			widen === undefined ? [] : [{ name, widen }]
		)
		for (const { name, widen } of widenings) {
			for (const g of targets) {
				g.target.set(name, widen)
			}
		}
		const common = commonColumns.map(({ name }) => name)
		const widenedGroups = mapNonEmpty(targets, (g) => ({
			arms: mapNonEmpty(g.arms, (a) => {
				const w = this.#widenArm(a, g.target, loc)
				if (w !== a) {
					this.#delivered.set(w, this.deliveredOf(a))
				}
				return w
			})
		}))
		let discriminant: ReadonlyArray<string> = []
		if (widenedGroups.length > 1) {
			/** Each arm's head literals over the common columns, in their order. */
			const literalRows = widenedGroups.map((g) =>
				g.arms.map((a) => {
					const literals = this.#literals.get(a)
					return common.flatMap((c) => {
						const head = literals?.get(c)
						return head === undefined ? [] : [{ column: c, literal: head.literal }]
					})
				})
			)
			const literal = common.filter((c) =>
				literalRows.every((rows) => rows.every((row) => row.some((e) => e.column === c)))
			)
			/** Whether the literal tuples over these columns of arms with different headings differ. */
			const clashes = (columns: ReadonlyArray<string>) => {
				const tuples = literalRows.map((rows) =>
					rows.map((row) => row.filter((e) => columns.includes(e.column)).map((e) => e.literal))
				)
				return tuples.some((mine, gi) =>
					tuples.some(
						(theirs, oi) =>
							oi < gi && mine.some((t) => theirs.some((u) => canonicalEquals(t, u, everyProperty)))
					)
				)
			}
			/**
			 * The discriminant is the closed-id literal columns when they alone tell the heading groups apart, so
			 * its roster order, its codes' order, completes ties across arms and a further
			 * constant column, such as a bare integer wrap, is an ordinary column; otherwise it is every common column
			 * bound to a literal in every head, typed as bare literals. A set over a roster is no closed id: bit
			 * strings compare by their bits, not by any handle's order.
			 */
			const rostered = literal.filter((c) => {
				const t = targets[0].target.get(c)
				return t !== undefined && baseOf(t).carrier === "code"
			})
			discriminant = rostered.length > 0 && !clashes(rostered) ? rostered : literal
			const clash = clashes(discriminant)
			if (discriminant.length === 0 || clash) {
				fail(
					"MissingDiscriminant",
					loc,
					discriminant.length === 0
						? "a literal discriminant: arms of different headings share fields bound to a literal in every head"
						: `discriminant literals (${discriminant.join(", ")}) that differ between arms of different headings`
				)
			}
		}
		const groupHeadings = mapNonEmpty(widenedGroups, (g) => ({
			heading: g.arms[0].heading,
			arms: g.arms
		}))
		const firstGroup = groupHeadings[0]
		const heading: Heading =
			widenedGroups.length === 1
				? firstGroup.heading
				: firstGroup.heading.filter((c) => common.includes(c.name))
		const node = this.node({ kind: "Union", groups: groupHeadings, discriminant, heading }, loc)
		const [firstWidened, ...moreWidened] = widenedGroups
		const flat: NonEmptyReadonlyArray<RelNode> = [
			...firstWidened.arms,
			...moreWidened.flatMap((g) => g.arms)
		]
		this.#unions.set(node, { arms: flat, discriminant })
		const carried = new Set(arms.flatMap((a) => [...this.#carried(a)]))
		if (carried.size > 0) {
			this.#attached.set(node, carried)
		}
		return node
	}

	/**
	 * The type the arms of every heading group that deliver each column by a term or a fixed literal agree on: the
	 * position of a bare head literal of the column in a group that delivers it by none (#positionedTypes), so a value
	 * beside a typed constant of another heading is typed alike (Tone.handle("low") in one arm, "mid" in another).
	 */
	#positions(arms: NonEmptyReadonlyArray<RelNode>): ReadonlyMap<string, ScalarType> {
		const termTypes = new Map<string, Array<ScalarType>>()
		for (const a of arms) {
			const literals = this.#literals.get(a)
			for (const column of a.heading) {
				if (bareOf(literals?.get(column.name)) !== undefined) {
					continue
				}
				const known = termTypes.get(column.name)
				if (known === undefined) {
					termTypes.set(column.name, [column.type])
				} else {
					known.push(column.type)
				}
			}
		}
		const positions = new Map<string, ScalarType>()
		for (const [name, types] of termTypes) {
			const agreed = agreedType(types)
			if (agreed !== undefined) {
				positions.set(name, agreed)
			}
		}
		return positions
	}

	/**
	 * The type each column of a group of arms is delivered at, once each bare head literal is typed by its position
	 * (#positionedTypes): the type all its arms share, or the guarantees common to them. The arms of one group share the
	 * heading's column names.
	 */
	#groupTarget(
		arms: NonEmptyReadonlyArray<RelNode>,
		positions: ReadonlyMap<string, ScalarType>,
		loc: SourceLoc
	): Map<string, ScalarType> {
		/** Each column of the group, in the first arm's heading order, as every arm delivers it, in arm order. */
		const delivered = new Map<string, [Delivered, ...Array<Delivered>]>()
		for (const a of arms) {
			const literals = this.#literals.get(a)
			for (const column of a.heading) {
				const d: Delivered = { column, bare: bareOf(literals?.get(column.name)) }
				const known = delivered.get(column.name)
				if (known === undefined) {
					delivered.set(column.name, [d])
				} else {
					known.push(d)
				}
			}
		}
		const target = new Map<string, ScalarType>()
		for (const [name, columns] of delivered) {
			target.set(
				name,
				groupColumnType(this.#positionedTypes(columns, positions.get(name)), columns[0].column, loc)
			)
		}
		return target
	}

	/**
	 * The type each arm of a group delivers a column at, a bare head literal typed by its position, never by an equal
	 * literal of another arm: it takes the type the group's arms that deliver the column by a term or a fixed literal
	 * agree on, or, where none of them does, the union's `position` (#positions), when it is a value of that type, and
	 * otherwise keeps the type it has, its value's JavaScript default or the type an earlier union's position gave it,
	 * which is how a union narrowed to some of its arms keeps the types the whole union gave them.
	 */
	#positionedTypes(
		delivered: NonEmptyReadonlyArray<Delivered>,
		position: ScalarType | undefined
	): NonEmptyReadonlyArray<ScalarType> {
		const agreed =
			agreedType(delivered.flatMap((d) => (d.bare === undefined ? [d.column.type] : []))) ??
			position
		return mapNonEmpty(delivered, (d) =>
			d.bare !== undefined &&
			agreed !== undefined &&
			this.schema.admits(d.bare.value, agreed, this.patterns)
				? agreed
				: d.column.type
		)
	}

	/**
	 * An arm whose columns take a wider type than it delivers, rewritten by a projection that casts them; its literal
	 * columns stay literals, retyped, so it keeps its discriminant. A projection keeps no attachment of the rows it
	 * reads, so an arm whose rows carry one (#carried) is refused.
	 */
	#widenArm(arm: RelNode, target: ReadonlyMap<string, ScalarType>, loc: SourceLoc): RelNode {
		const heading = arm.heading
		const changes = heading.filter((c) => {
			const t = target.get(c.name)
			return t !== undefined && !sameScalarType(t, c.type)
		})
		const [changed] = changes
		if (changed === undefined) {
			return arm
		}
		if (this.#carried(arm).size > 0) {
			fail(
				"UnsupportedOperation",
				loc,
				`union arm with an attachment whose column ${changed.name} differs in refinement or typmod from the other arms'; cast it to one type with Compute.cast`
			)
		}
		const literals = this.#literals.get(arm) ?? new Map<string, HeadLiteral>()
		const kept = new Map<string, HeadLiteral>()
		const out = heading.map((c) => {
			const t = target.get(c.name) ?? c.type
			const head = literals.get(c.name)
			if (head !== undefined) {
				/** A bare literal is a value of its new type, which its position gives it; a fixed one keeps its value. */
				const retyped: HeadLiteral =
					head.kind === "fixed" || sameScalarType(t, c.type)
						? head
						: { ...head, literal: this.schema.literal(head.value, t, head.loc, this.patterns) }
				kept.set(c.name, retyped)
				return { name: c.name, expr: this.emit(literalSpec(retyped.literal, t)), type: t }
			}
			const col = this.emit(columnSpec(arm.id, c.name, c.type))
			if (sameScalarType(t, c.type)) {
				return { name: c.name, expr: col, type: t }
			}
			return {
				name: c.name,
				expr: this.emit({
					kind: "cast",
					cast: widened(c.type, t, loc),
					args: [col],
					type: t,
					nonNull: "strict",
					volatility: "immutable"
				}),
				type: t
			}
		})
		const node = this.node(
			{
				kind: "ProjectSet",
				input: arm,
				out: out.map((o) => ({ name: o.name, expr: o.expr })),
				heading: out.map((o) => ({ name: o.name, type: o.type }))
			},
			loc
		)
		if (kept.size > 0) {
			this.#literals.set(node, kept)
		}
		return node
	}

	#attach(
		parent: RelNode,
		desc: ResolvedAttach,
		scope: Scope,
		loc: SourceLoc
	): { readonly node: RelNode; readonly carries: ReadonlySet<string> } {
		/**
		 * An attachment is part of the result type, so on a member query's own result, a stage of its
		 * chain or an arm's Finished.attach, it adds a field the relation's heading lacks; the Attach node's heading is
		 * its parent's, which the member's head check compares. An import or an attachment
		 * child is its own scope and carries no member.
		 */
		const member = writtenTarget(scope.origin)
		if (member !== undefined) {
			fail(
				"DescribedHeadingMismatch",
				loc,
				`a member head of ${member.relation.name}'s heading; attachment ${desc.name} adds a field`
			)
		}
		const heading = parent.heading
		if (hasColumn(heading, desc.name)) {
			fail(
				"MalformedDescription",
				loc,
				`an attachment name distinct from the parent's columns; ${desc.name} is a column`
			)
		}
		const carried = this.#carried(parent)
		if (carried.has(desc.name)) {
			fail("MalformedDescription", loc, `one attachment per name; ${desc.name} is attached twice`)
		}
		const use = parentUse(desc.child)
		for (const p of use.columns) {
			if (!hasColumn(heading, p)) {
				fail(
					"MalformedDescription",
					loc,
					`a parent variable of the parent's heading; ${p} is not a column of it`
				)
			}
		}
		if (use.columns.size === 0) {
			fail(
				"AttachedParentUnbound",
				loc,
				`a child that binds a parent variable: attachment ${desc.name} reads none of ${heading.length === 0 ? "the parent's columns" : heading.map((c) => c.name).join(", ")}`
			)
		}
		/**
		 * One correlation column per parent variable, named alike in every arm: the head key that delivers it, or the
		 * first source column it is bound to, or the parent's own column name, kept clear of the child's head keys and of
		 * its own attachments' names.
		 */
		const taken = new Set<string>()
		const columns: Array<ParentColumn> = []
		for (const c of heading) {
			if (!use.columns.has(c.name)) {
				continue
			}
			const alias = use.headAlias.get(c.name)
			const name = alias ?? freshColumnName(use, use.firstBound.get(c.name) ?? c.name, taken)
			if (alias !== undefined && taken.has(name)) {
				fail("MalformedDescription", loc, `one parent variable per head key; ${name} delivers two`)
			}
			taken.add(name)
			columns.push({ parent: c.name, name, type: c.type })
		}
		const childScope: Scope = {
			kind: "scope",
			params: scope.params,
			origin: { kind: "attachChild", parent: { node: parent.id, heading, columns } },
			self: undefined
		}
		const child = this.stage(desc.child.stage, childScope)
		const childHeading = child.node.heading
		const fixed = new Set(columns.map((c) => c.name))
		const correlation = columns.map((c) => ({ parent: c.parent, child: c.name }))
		/**
		 * An array's order is the one its child states, an orderBy's or the take's it ends in, or, stating none, the empty
		 * order, which the completion (check/order.ts) extends by the child's key: its positions are a function of its
		 * child's facts, and ties under a stated order are broken by the child's key.
		 */
		const stated = child.order.kind === "none" ? { keys: [], at: loc } : child.order.stated
		const node = this.node(
			{
				kind: "Attach",
				parent,
				child: child.node,
				name: desc.name,
				correlation,
				judged: "array",
				delivered: "array",
				order: this.complete(stated, childHeading, fixed),
				heading
			},
			loc
		)
		this.#state(node, stated, {
			input: child.node,
			fixed: correlation.map((c) => c.child),
			withOrder: (order) =>
				this.#restated(
					node,
					{
						kind: "Attach",
						parent,
						child: child.node,
						name: desc.name,
						correlation,
						judged: "array",
						delivered: "array",
						order,
						heading
					},
					loc
				)
		})
		const literals = this.#literals.get(parent)
		if (literals !== undefined) {
			this.#literals.set(node, literals)
		}
		const carries = new Set([...carried, desc.name])
		this.#attached.set(node, carries)
		return { node, carries }
	}

	/**
	 * An attachment as a stage or a rule of `scope` declares it. Under an import (`scope.params.kind === "bound"`), an
	 * attachment is no row the importer reads: it is checked as any attachment (its refusals, its parameter uses, so
	 * the import's complete-bind check sees the child's parameters), and the parent is returned, carrying the
	 * attachment's name so a second attachment of that name is still refused. No root reaches the Attach node it built,
	 * so no statement delivers it and no Attach the importer reaches lies off its delivery spine (ir/dag.ts
	 * deliverySpine); order.ts completes its stated order like any other, and nothing reads it.
	 */
	attachIn(parent: RelNode, desc: ResolvedAttach, scope: Scope, loc: SourceLoc): RelNode {
		const { node, carries } = this.#attach(parent, desc, scope, loc)
		if (scope.params.kind === "own") {
			return node
		}
		this.#attached.set(parent, carries)
		return parent
	}

	/**
	 * What a parameter reference reads in `scope`: in the query's own scope its own cell, under an import what the
	 * import's bind map binds the parameter to, by the name the bind map spells it by.
	 */
	#resolveParam(cell: ParamCell, scope: Scope, loc: SourceLoc): BindValue {
		const params = scope.params
		if (params.kind === "own") {
			return { kind: "param", cell }
		}
		const bound = params.values.get(cell.name)
		if (bound === undefined) {
			return fail(
				"MalformedDescription",
				loc,
				`a bind map that binds parameter ${cell.name}: an imported query's parameters are bound completely with bind`
			)
		}
		params.used.add(cell.name)
		return bound
	}

	rule(rule: ResolvedRule, scope: Scope): RelNode {
		return new RuleCheck(this, rule, scope, rule.loc).run()
	}

	source(
		src: ResolvedSource,
		scope: Scope,
		interiors: ReadonlyArray<ResolvedInterior>,
		loc: SourceLoc,
		bind: (term: ResolvedBound, param: string, loc: SourceLoc) => BindValue
	): RelNode {
		switch (src.kind) {
			case "relation": {
				const info = this.schema.relation(src.name, loc)
				if (info.kind === "closed") {
					return this.node(
						{ kind: "Closed", closed: info.name, rows: info.rows, heading: info.heading },
						loc
					)
				}
				if (info.kind === "derived" || info.kind === "world") {
					/** A view is read by its whole heading under the checker's evidence, and carries its own keys for evidence that
					 * admits them. */
					const { heading, keys } = info.analysis.read
					return this.node(
						{
							kind: "Base",
							relation: info.name,
							occurrence: this.b.ids.occurrence(),
							primaryKey: mapNonEmpty(heading, (c) => c.name),
							keys: [],
							relationKind: info.kind,
							view: keys,
							heading
						},
						loc
					)
				}
				return this.node(
					{
						kind: "Base",
						relation: info.name,
						occurrence: this.b.ids.occurrence(),
						primaryKey: info.primaryKey,
						keys: info.keys,
						relationKind: "relation",
						heading: headingColumns(info.heading)
					},
					loc
				)
			}
			case "query":
				return this.#importSource(src, loc, bind)
			case "param":
			case "paramOf":
				return this.#paramSource(src, scope, loc)
			case "row":
				return this.node(
					{
						kind: "InputSet",
						input: { kind: "row" },
						heading: this.#declaredHeading(src.heading, loc)
					},
					loc
				)
			case "interior": {
				const interior = interiors.find((i) => i.id === src.id)
				if (interior === undefined) {
					return fail(
						"MalformedDescription",
						loc,
						`an interior stage the rule declares, not ${JSON.stringify(src.id)}`
					)
				}
				const inner: Scope = {
					kind: "scope",
					params: scope.params,
					origin: { kind: "interior" },
					self: undefined
				}
				return this.arms(interior.arms, inner, childLoc(loc, "interior"))
			}
			case "self": {
				if (scope.self === undefined) {
					return fail("MalformedDescription", loc, "a self source inside a recursive step only")
				}
				return scope.self
			}
			case "delta": {
				if (this.options.read !== "readBack") {
					return fail(
						"MalformedDescription",
						loc,
						`a delta source inside a ChangeSet read-back only; delta.${src.side}(${src.relation}) reads a change`
					)
				}
				/**
				 * delta.added(R) and delta.removed(R) are R's final state minus its initial state and the reverse, for
				 * every ordinary relation: over a relation the ChangeSet does not write
				 * both are empty, which the write program supplies, so a read-back shared by ChangeSets that write
				 * different relations checks against each. A closed or derived relation is never written. Over a role,
				 * any world relation's delta is typed by its checked heading in canonical order (compareText), the order
				 * the write front end delivers it in: empty, its target's projected onto its head, or refused there.
				 */
				const info = this.schema.relation(src.relation, loc)
				if (info.kind === "world") {
					const heading = info.analysis.read.heading.toSorted(byName)
					return this.node(
						{ kind: "Delta", relation: info.name, side: src.side, keys: [], heading },
						loc
					)
				}
				if (info.kind !== "relation") {
					return fail(
						"MalformedDescription",
						loc,
						`a delta of an ordinary relation or a world relation; ${info.name} is ${info.kind}, which no ChangeSet writes`
					)
				}
				return this.node(
					{
						kind: "Delta",
						relation: info.name,
						side: src.side,
						keys: [info.primaryKey, ...info.keys],
						heading: headingColumns(info.heading)
					},
					loc
				)
			}
			case "context":
				return this.#contextSource(src, loc)
		}
	}

	#contextSource(
		src: Extract<ResolvedSource, { readonly kind: "context" }>,
		loc: SourceLoc
	): RelNode {
		const context = src.context
		const text = unwrap(descText(context))
		/**
		 * A Db of a role holds facts of exactly the contexts its relations read, decoded from its token: a query
		 * over the role reads one of them, as they declare it, or would read a context no Db of the role holds.
		 */
		const world = this.schema.world
		if (world.kind === "role") {
			const held = world.role.contexts[context.name]
			if (held === undefined) {
				fail(
					"MalformedDescription",
					loc,
					`a context role ${world.role.name}'s relations read, whose facts its Db holds (${Object.keys(world.role.contexts).length === 0 ? "none" : Object.keys(world.role.contexts).join(", ")}); context ${context.name} is none of them`
				)
			}
			if (unwrap(descText(held)) !== text) {
				failWith({
					_tag: "DuplicateIdentity",
					at: loc,
					duplicate: { kind: "context", name: context.name, earlier: world.role.loc }
				})
			}
		}
		const prior = this.#contexts.get(context.name)
		if (prior === undefined) {
			this.#contexts.set(context.name, { text, loc })
		} else if (prior.text !== text) {
			failWith({
				_tag: "DuplicateIdentity",
				at: loc,
				duplicate: { kind: "context", name: context.name, earlier: prior.loc }
			})
		}
		const heading: Heading = entries(context.fields).map(([name, d]) => ({
			name,
			type: this.fieldType(d, childLoc(loc, name))
		}))
		return this.node({ kind: "Context", context: context.name, heading }, loc)
	}

	#importSource(
		src: Extract<ResolvedSource, { readonly kind: "query" }>,
		loc: SourceLoc,
		bind: (term: ResolvedBound, param: string, loc: SourceLoc) => BindValue
	): RelNode {
		const values = new Map<string, BindValue>()
		for (const [param, term] of entries(src.bind)) {
			values.set(param, bind(term, param, childLoc(childLoc(loc, "bind"), param)))
		}
		const resolver: ParamResolver = { kind: "bound", values, used: new Set(), loc }
		const inner: Scope = {
			kind: "scope",
			params: resolver,
			origin: { kind: "import" },
			self: undefined
		}
		const out = this.stage(src.query.stage, inner)
		for (const param of values.keys()) {
			if (!resolver.used.has(param)) {
				fail(
					"MalformedDescription",
					childLoc(childLoc(loc, "bind"), param),
					`a bind map naming the imported query's parameters; it uses no parameter ${param}`
				)
			}
		}
		return out.node
	}

	#paramSource(
		src: Extract<ResolvedSource, { readonly kind: "param" | "paramOf" }>,
		scope: Scope,
		loc: SourceLoc
	): RelNode {
		const heading =
			src.kind === "param"
				? this.#declaredHeading(src.heading, loc)
				: this.#relationHeading(src.relation, loc)
		const resolved = this.#resolveParam(src.cell, scope, loc)
		if (resolved.kind !== "param") {
			return fail(
				"MalformedDescription",
				loc,
				`relation parameter ${src.cell.name} bound to the importer's relation parameter`
			)
		}
		const param = resolved.cell.useRelation(heading, loc)
		return this.node({ kind: "InputSet", input: { kind: "declared", param }, heading }, loc)
	}

	/**
	 * A relation parameter's or a row's declared heading: each field typed, a serial one as its integer, since how a field
	 * is written is no part of its type. A heading of no field is the unit relation (ir/rel.ts Heading), as the fill of a
	 * generated addition into a query entry whose every carried field is serial declares; a user's relation parameter has
	 * a field, which its builder, the Description's decoder and its type refuse otherwise.
	 */
	#declaredHeading(declared: Readonly<Record<string, FieldDesc>>, loc: SourceLoc): Heading {
		return entries(declared).map(([name, d]) => ({
			name,
			type: this.fieldType(d, childLoc(loc, name))
		}))
	}

	/** The heading of the ordinary relation a relation parameter is typed by. */
	#relationHeading(relation: string, loc: SourceLoc): Heading {
		const info = this.schema.relation(relation, loc)
		if (info.kind !== "relation") {
			fail(
				"MalformedDescription",
				loc,
				`a relation parameter typed by an ordinary relation's heading; ${info.name} is ${info.kind}`
			)
		}
		return headingColumns(info.heading)
	}

	/**
	 * The environment a scalar description lowers in: leaves are columns of the node labelled `node` (a reserved region
	 * or a built node), the input of the consumer the expression belongs to, resolved by `leaf`. A rule's filter applies
	 * the schema's closed relations (`reads` "filter"); every other expression, a value the query delivers or binds,
	 * applies none.
	 */
	env(
		node: NodeId,
		loc: SourceLoc,
		leaf: (
			desc: LeafDesc<Resolved>,
			loc: SourceLoc
		) => { readonly name: string; readonly type: ScalarType },
		scope: Scope,
		paramColumn: (
			cell: ParamCell,
			loc: SourceLoc
		) => { readonly name: string; readonly type: ScalarType },
		reads: ExprReading
	): QueryEnv {
		return {
			mode: "query",
			loc,
			closed: reads === "filter" ? this.schema.closedReads : deliveredValue,
			emit: (spec) => this.emit(spec),
			leaf: (desc, at) =>
				catchRefusal(() => {
					const c = leaf(desc, at)
					return columnSpec(node, c.name, c.type)
				}),
			params: {
				kind: "scope",
				lower: (param, at) =>
					catchRefusal(() => this.#paramUse(param, at, scope, node, paramColumn))
			},
			fieldType: (desc, at) =>
				catchRefusal(() => this.schema.queryFieldType(desc, at, this.#contracts, this.patterns)),
			patterns: this.patterns,
			patternLanguage: textLookup,
			extension: (desc, at, lower) => catchRefusal(() => this.#extension(desc, lower, at))
		}
	}

	/**
	 * A parameter inside an expression, of its declared type: bound as the type's base, or replaced by what an import's
	 * bind map binds it to, a literal then admitted at the type and a column compatible with it; a channel the checker
	 * writes is the column it is bound to, at the column's type.
	 */
	#paramUse(
		param: ParamExpr,
		loc: SourceLoc,
		scope: Scope,
		node: NodeId,
		paramColumn: (
			cell: ParamCell,
			loc: SourceLoc
		) => { readonly name: string; readonly type: ScalarType }
	): { readonly spec: ExprSpec; readonly type: ScalarType } {
		const cell = param.cell
		const resolved = this.#resolveParam(cell, scope, loc)
		if (resolved.kind === "column") {
			const c = paramColumn(cell, loc)
			const spec = columnSpec(node, c.name, c.type)
			if (param.type.kind === "channel") {
				return { spec, type: c.type }
			}
			const type = this.paramType(param, loc)
			if (!compatible(c.type, type)) {
				fail(
					"MalformedDescription",
					loc,
					`operands of one type: the variable bound to parameter ${cell.name} is ${typeLabel(c.type)}, declared ${typeLabel(type)}`
				)
			}
			return { spec, type }
		}
		const type = this.paramType(param, loc)
		return resolved.kind === "param"
			? { spec: paramSpec(resolved.cell.use(type, loc), "compare", compareType(type)), type }
			: { spec: boundConstant(this.schema, resolved, type, this.patterns), type }
	}

	/** One immutable operator node over `args`, of an overload defined on every value its operands admit. */
	#opNode(op: DefinedOp, args: ReadonlyArray<ScalarExpr>, type: ScalarType): ScalarExpr {
		return this.emit({
			kind: "op",
			op,
			args,
			type,
			nonNull: "strict",
			volatility: "immutable"
		})
	}

	/**
	 * A connective, or an equality of two operands of one type or of a plain integer or money and an exact value of its
	 * family: the plain one widened into the exact carrier, as the comparison Compute writes is (lower.ts comparison).
	 */
	opNamed(
		fn: "eq" | "and" | "not" | "or",
		given: ReadonlyArray<ScalarExpr>,
		loc: SourceLoc
	): ScalarExpr {
		const bool = plainType("bool")
		const [left, right] = given
		const args =
			fn !== "eq" || left === undefined || right === undefined
				? given
				: (
						[
							[left, right],
							[right, left]
						] as const
					).map(([a, partner]) => {
						const at = meetingType(a.type, partner.type)
						return at === a.type
							? a
							: this.emit({
									kind: "cast",
									cast: widened(a.type, at, loc),
									args: [a],
									type: at,
									nonNull: "strict",
									volatility: "immutable"
								})
					})
		const carriers =
			fn === "eq" ? args.map((a) => baseOf(a.type).carrier) : ([bool.carrier] as const)
		const op = overloadOf(fn, carriers)
		const id = op === undefined ? undefined : definedIdOf(op)
		if (id === undefined) {
			return fail("UnsupportedOperation", loc, `${fn} over ${carriers.join(", ")}`)
		}
		return this.#opNode(id, args, bool)
	}

	conjunction(preds: ReadonlyArray<ScalarExpr>, loc: SourceLoc): ScalarExpr {
		return only(preds) ?? this.opNamed("and", preds, loc)
	}

	/**
	 * r.allen and r.pointIn, lowered to the range operators of the shipped Allen table (check/allen.ts allenExpr, the
	 * one IR spelling of a mask); r.not is a rule-level filter, never a scalar operand.
	 *
	 * A window literal takes its type from the point: a span over the point's type, as r.pointIn(t, window) writes a
	 * time window. A parameter is a term of its declared type.
	 */
	#extension(
		desc: Extract<ResolvedExpr, { readonly kind: "allen" | "pointIn" | "absent" }>,
		lower: (child: ResolvedExpr) => Result.Result<Lowered, CompileError>,
		loc: SourceLoc
	): Lowered {
		const bool = plainType("bool")
		const lowered = loweredOf
		/** A bare literal operand adopts `against`'s type; anything else, a parameter among them, meets it compatibly. */
		const operand = (d: ResolvedExpr, against: ScalarType, at: SourceLoc): ScalarExpr => {
			const adopted = adoptCompare(against)
			if (d.kind === "literal" && d.type === undefined) {
				return this.emit(
					literalSpec(this.schema.literal(d.value, adopted, at, this.patterns), adopted)
				)
			}
			const t = unwrap(lower(d))
			if (!compatible(t.nominal, against)) {
				fail(
					"MalformedDescription",
					at,
					`operands of one type: ${typeLabel(against)} never meets ${typeLabel(t.nominal)}`
				)
			}
			return t.expr
		}
		/**
		 * A span term's expression and type, with the span its type is over and its range carrier, which its operators are
		 * typed by.
		 */
		const spanTerm = (
			d: ResolvedExpr,
			at: SourceLoc
		): {
			readonly expr: ScalarExpr
			readonly nominal: ScalarType
			readonly span: SpanBase["span"]
			readonly carrier: SpanCarrier
		} => {
			if (isBareLiteral(d)) {
				return fail(
					"MalformedDescription",
					at,
					"a span term here; a literal takes the type of the term it meets"
				)
			}
			const t = unwrap(lower(d))
			const base = spanBase(t.nominal)
			if (base === undefined) {
				return fail("MalformedDescription", at, `a span term, not ${typeLabel(t.nominal)}`)
			}
			return { expr: t.expr, nominal: t.nominal, span: base.span, carrier: base.carrier }
		}
		switch (desc.kind) {
			case "absent":
				return fail(
					"UnsupportedOperation",
					loc,
					"r.not inside a scalar expression: relational negation is a rule-level filter, alone or in a top-level conjunction"
				)
			case "allen": {
				const left = spanTerm(desc.left, childLoc(loc, "allen", "left"))
				const right = operand(desc.right, left.nominal, childLoc(loc, "allen", "right"))
				const mask = parseAllenMask(desc.mask)
				if (mask === undefined) {
					return fail("MalformedDescription", loc, `an Allen mask in 1..${allenMaskMax}`)
				}
				if (mask === emptyAllenMask) {
					return fail("MalformedDescription", loc, "a nonempty Allen mask")
				}
				return lowered(
					allenExpr(mask, left.expr, right, left.carrier, bool, (spec) => this.emit(spec))
				)
			}
			case "pointIn": {
				const at = childLoc(loc, "pointIn", "span")
				if (!isBareLiteral(desc.span)) {
					const span = spanTerm(desc.span, at)
					const point = operand(desc.point, span.span.endpoint, childLoc(loc, "pointIn", "point"))
					return lowered(
						this.#opNode(
							definedRangeOp("range_contains_elem", span.carrier),
							[span.expr, point],
							bool
						)
					)
				}
				if (isBareLiteral(desc.point)) {
					return fail(
						"MalformedDescription",
						childLoc(loc, "pointIn"),
						"a term on one side of pointIn; a literal takes the type of the term it meets"
					)
				}
				const point = unwrap(lower(desc.point))
				const window = spanType(adoptCompare(point.nominal), undefined, at)
				if (!window.ok) {
					return fail(
						"MalformedDescription",
						childLoc(loc, "pointIn", "point"),
						`a span endpoint as the point, not ${typeLabel(point.nominal)}`
					)
				}
				const span = operand(desc.span, window.value, at)
				const carrier = window.value.carrier
				return lowered(
					this.#opNode(definedRangeOp("range_contains_elem", carrier), [span, point.expr], bool)
				)
			}
		}
	}

	/**
	 * The type of a literal that meets no term: a JavaScript number is integer, a bigint bigint, a
	 * Decimal numeric, a Money money, a boolean boolean and a string text with the canonical wildcard. A Decimal is
	 * admitted as any numeric value, and its node then typed by its own value (literalNumeric).
	 */
	bareLiteralType(value: LiteralDesc, loc: SourceLoc): ScalarType {
		const kind = bareLiteralKind(value)
		const plain: Partial<Record<string, PlainCarrier>> = {
			integer: "int4",
			bigint: "int8",
			money: "money",
			boolean: "bool"
		}
		if (kind === "text") {
			return wildcardText
		}
		if (kind === "numeric") {
			return anyNumeric
		}
		const carrier = kind === undefined ? undefined : plain[kind]
		if (carrier === undefined) {
			return fail(
				"MalformedDescription",
				loc,
				"a head literal whose type something fixes: an integer, a bigint, a Decimal, a Money, a boolean or a string, or a typed Compute.literal"
			)
		}
		return plainType(carrier)
	}

	/** The literal head columns of an arm node. */
	literalOf(node: RelNode): ReadonlyMap<string, HeadLiteral> | undefined {
		return this.#literals.get(node)
	}

	setLiterals(node: RelNode, literals: Map<string, HeadLiteral>): void {
		if (literals.size > 0) {
			this.#literals.set(node, literals)
		}
	}

	/** The arms and discriminant of a union node this checker built. */
	unionOf(node: RelNode):
		| {
				readonly arms: NonEmptyReadonlyArray<RelNode>
				readonly discriminant: ReadonlyArray<string>
		  }
		| undefined {
		return this.#unions.get(node)
	}

	/** The arms a match selects among (RuleCheck #selected): a union's, a bounded union's, or the node as its one arm. */
	armsOf(node: RelNode): NonEmptyReadonlyArray<RelNode> {
		const arm = node.kind === "Take" ? node.input : node
		return this.#unions.get(arm)?.arms ?? [arm]
	}

	/** The heading an arm delivered before a union widened it (#delivered), its own where none did. */
	deliveredOf(node: RelNode): Heading {
		return this.#delivered.get(node) ?? node.heading
	}

	/** A node over `from` that delivers `from`'s rows: it keeps `from`'s literal columns and attachments. */
	inherit(node: RelNode, from: RelNode): void {
		this.#inherit(node, from)
	}

	resolveParam(cell: ParamCell, scope: Scope, loc: SourceLoc): BindValue {
		return this.#resolveParam(cell, scope, loc)
	}
}

/** How a refusal names the source a match reads: its relation, parameter, context, delta, or the kind of source it is. */
const sourceLabel = (src: ResolvedSource): string => {
	switch (src.kind) {
		case "relation":
			return src.name
		case "query":
			return "the matched query"
		case "param":
		case "paramOf":
			return `relation parameter ${src.cell.name}`
		case "interior":
			return "the interior stage"
		case "self":
			return "the recursion's own rows"
		case "delta":
			return `delta.${src.side}(${src.relation})`
		case "context":
			return `context ${src.context.name}`
		case "row":
			return "the asked row"
	}
}

/** One rule: its region, filters, negations and head. */
class RuleCheck {
	readonly cx: Checker
	readonly rule: ResolvedRule
	readonly scope: Scope
	readonly loc: SourceLoc
	readonly region: ReservedNode
	/** The rule variables a match binds, by the description's variable id, each reserved when the rule is declared. */
	readonly #reserved = new Map<string, ReservedUser>()
	/** The rule variables bound so far, by the description's variable id: each became a slot at its first match. */
	readonly user = new Map<string, UserSlot>()
	readonly decls = new Map<string, VarDesc>()
	readonly parents = new Map<string, ParentSlot>()
	/**
	 * The parent columns the rule's scope correlates to, an attachment child's and none anywhere else, each with its
	 * slot (#declare).
	 */
	readonly correlation: Array<{ readonly column: ParentColumn; readonly slot: ParentSlot }> = []
	readonly paramSlots = new Map<string, ParamSlot>()
	readonly hidden: Array<HiddenSlot> = []
	/** The first match column each parent variable a match binds is bound to, which gives it its type. */
	readonly #parentBindings = new Map<VarId, Binding>()
	/** The imported parameters bound to an outer value that a filter, the head or a fallback equality reads. */
	readonly #needed = new Set<VarId>()
	readonly names = new Set<string>()
	#occurrences: ReadonlyArray<PendingOccurrence> = []
	/** The region's occurrences, each beside the match it was resolved from, in match order, once the region is defined. */
	#defined: ReadonlyArray<{
		readonly pending: PendingOccurrence
		readonly occurrence: Occurrence
	}> = []
	readonly eqs: Array<PendingEquality> = []

	constructor(cx: Checker, rule: ResolvedRule, scope: Scope, loc: SourceLoc) {
		this.cx = cx
		this.rule = rule
		this.scope = scope
		this.loc = loc
		this.region = cx.reserve()
	}

	at(...segments: ReadonlyArray<string | number>): SourceLoc {
		return segments.reduce<SourceLoc>((l, s) => childLoc(l, s), this.loc)
	}

	fresh(stem: string): string {
		let name = stem
		for (let n = 2; this.names.has(name); n++) {
			name = `${stem}_${n}`
		}
		this.names.add(name)
		return name
	}

	run(): RelNode {
		const leaves = ruleLeaves(this.rule, true)
		this.#declare(leaves)
		this.#matches()
		const region = this.#defineRegion(leaves)
		let node = this.#filter(region)
		/**
		 * A negation that reads only columns the head delivers unchanged applies after the projection, over fewer
		 * columns: projecting first and negating on the delivered columns keeps the same
		 * set.
		 */
		const late = this.#lateNegations()
		if (late === undefined) {
			node = this.#earlyNegations(node)
		}
		node = this.#head(node)
		for (const n of late ?? []) {
			node = this.#negation(node, n.absent, this.at("where", n.index), (column) =>
				n.correlated.get(column)
			)
		}
		for (const a of this.rule.attach) {
			node = this.cx.attachIn(node, a, this.scope, a.loc)
		}
		return node
	}

	/**
	 * The type of a slot: a rule variable's and a hidden slot's binding, a parent variable's binding or else its parent
	 * column's, a parameter's outer value's.
	 */
	slotType(slot: Slot): ScalarType {
		switch (slot.kind) {
			case "param":
				return slot.outer.type
			case "parent":
				return this.#parentBindings.get(slot.id)?.type ?? slot.outer.type
			case "hidden":
			case "user":
				return slot.binding.type
		}
	}

	/** A slot's column of the rule's region, which every node the rule builds over the region delivers unchanged. */
	#slotColumn(slot: Slot): HeadingColumn {
		return { name: slot.name, type: this.slotType(slot) }
	}

	/** Whether no match binds the rule variable `name`. */
	#unbound(name: string): boolean {
		return !this.user.has(name)
	}

	/** The slot of a parent variable the rule reads, refused for a column its scope does not correlate to. */
	#parentSlot(column: string, loc: SourceLoc): ParentSlot {
		const slot = this.parents.get(column)
		if (slot === undefined) {
			return fail(
				"MalformedDescription",
				loc,
				`a parent variable inside an attachment; ${column} is not one`
			)
		}
		return slot
	}

	/** The slot of a parameter the rule reads that its import binds to an outer value, refused for any other. */
	#paramSlot(cell: ParamCell, loc: SourceLoc): ParamSlot {
		const slot = this.paramSlots.get(cell.name)
		if (slot === undefined) {
			return fail("MalformedDescription", loc, `parameter ${cell.name} read in this rule`)
		}
		return slot
	}

	/**
	 * Slots: the parent variables an attachment's child delivers, the parameters an import binds to outer values, and
	 * the rule's own variables, named by the field `v` took them from.
	 */
	#declare(leaves: Leaves<Resolved["param"], Resolved["paramType"]>): void {
		for (const v of this.rule.vars) {
			this.decls.set(v.id, v)
		}
		const origin = this.scope.origin
		if (origin.kind === "attachChild") {
			for (const column of origin.parent.columns) {
				const slot: ParentSlot = {
					kind: "parent",
					id: this.cx.b.ids.var(),
					name: this.fresh(column.name),
					outer: { node: origin.parent.node, name: column.parent, type: column.type }
				}
				this.parents.set(column.parent, slot)
				this.correlation.push({ column, slot })
			}
		}
		const pageRoot = origin.kind === "root" && origin.role.kind === "page"
		for (const p of [...leaves.parents].toSorted(compareStrings)) {
			if (!this.parents.has(p)) {
				fail(
					pageRoot ? "AttachedPage" : "MalformedDescription",
					this.loc,
					pageRoot
						? `a page over a query read by an attachment: parent variable ${p} correlates it to a parent, and a long child list is its own top-level query keyed by the parent`
						: `a parent variable inside an attachment's own rules; ${p} is read outside one`
				)
			}
		}
		const params = this.scope.params
		const needed = new Set(ruleLeaves(this.rule, false).params.map((p) => p.cell))
		const read = new Set(leaves.params.map((p) => p.cell))
		for (const p of [...read].toSorted(mapInput(compareStrings, (c: ParamCell) => c.name))) {
			const value = params.kind === "bound" ? params.values.get(p.name) : undefined
			if (value?.kind !== "column") {
				continue
			}
			const slot: ParamSlot = {
				kind: "param",
				id: this.cx.b.ids.var(),
				name: this.fresh(`__${p.name}`),
				outer: { node: value.node, name: value.name, type: value.type }
			}
			this.paramSlots.set(p.name, slot)
			if (needed.has(p)) {
				this.#needed.add(slot.id)
			}
		}
		const firstColumn = new Map<string, string>()
		for (const [column, e] of this.rule.matches.flatMap((m) => entries(m.bindings))) {
			if (e.kind === "var" && !firstColumn.has(e.var)) {
				firstColumn.set(e.var, column)
			}
		}
		for (const v of this.rule.vars) {
			const first = firstColumn.get(v.id)
			if (first === undefined) {
				continue
			}
			this.#reserved.set(v.id, {
				kind: "user",
				id: this.cx.b.ids.var(),
				name: this.fresh(v.origin === undefined ? first : v.origin.field)
			})
		}
	}

	/** The slot of a rule variable a match has bound, refused for a variable the rule does not declare or binds by no
	 * match. */
	#userSlot(id: string, loc: SourceLoc): UserSlot {
		return this.user.get(id) ?? this.#unboundVariable(id, loc)
	}

	/** The reservation of a rule variable a match binds, refused as #userSlot refuses. */
	#reservedSlot(id: string, loc: SourceLoc): ReservedUser {
		return this.#reserved.get(id) ?? this.#unboundVariable(id, loc)
	}

	#unboundVariable(id: string, loc: SourceLoc): never {
		if (!this.decls.has(id)) {
			return fail(
				"MalformedDescription",
				loc,
				`a variable this rule declares; ${JSON.stringify(id)} is another rule's or no one's`
			)
		}
		return fail(
			"MalformedDescription",
			loc,
			`variable ${id} bound by a match: creating a variable with v does not bind it, using it in a match does`
		)
	}

	/**
	 * Binds the rule variable `id`, reserved as `reserved`, to a source column: its first binding makes its slot, of the
	 * column's type, and a later one is a rebinding (#rebind).
	 */
	#bindUser(
		id: string,
		reserved: ReservedUser,
		column: HeadingColumn,
		loc: SourceLoc
	): SlotBinding {
		const bound = this.user.get(id)
		if (bound === undefined) {
			const slot: UserSlot = { ...reserved, binding: { type: column.type } }
			this.user.set(id, slot)
			return { column: column.name, var: slot }
		}
		return this.#rebind(bound, bound.binding.type, column, loc)
	}

	/**
	 * Binds a parent variable to a source column: its first binding, compatible with its parent column, which the
	 * attachment's correlation equates it with, gives it the column's type, and a later one is a rebinding (#rebind).
	 */
	#bindParent(slot: ParentSlot, column: HeadingColumn, loc: SourceLoc): SlotBinding {
		comparable(column, "no parent's column correlates with it", loc)
		const binding = this.#parentBindings.get(slot.id)
		if (binding !== undefined) {
			return this.#rebind(slot, binding.type, column, loc)
		}
		this.#compatibleBinding(slot, slot.outer.type, column, loc)
		this.#parentBindings.set(slot.id, { type: column.type })
		return { column: column.name, var: slot }
	}

	/**
	 * A further column bound to a variable of type `type`: the variable itself for a column of its type, else a hidden
	 * variable equated with it by the rule's filter, since one variable has one type.
	 */
	#rebind(
		slot: UserSlot | ParentSlot,
		type: ScalarType,
		column: HeadingColumn,
		loc: SourceLoc
	): SlotBinding {
		comparable(column, `variable ${slot.name} binds it and no other column`, loc)
		this.#compatibleBinding(slot, type, column, loc)
		if (sameScalarType(type, column.type)) {
			return { column: column.name, var: slot }
		}
		const hidden = this.#hidden(column)
		this.eqs.push({ kind: "slots", left: slot, right: hidden })
		return { column: column.name, var: hidden }
	}

	#compatibleBinding(slot: Slot, type: ScalarType, column: HeadingColumn, loc: SourceLoc): void {
		if (!compatible(type, column.type)) {
			fail(
				"MalformedDescription",
				loc,
				`a variable bound to columns of one type: ${slot.name} is ${typeLabel(type)}, ${column.name} is ${typeLabel(column.type)}`
			)
		}
	}

	#hidden(column: HeadingColumn): HiddenSlot {
		const slot: HiddenSlot = {
			kind: "hidden",
			id: this.cx.b.ids.var(),
			name: this.fresh(`__${column.name}`),
			binding: { type: column.type }
		}
		this.hidden.push(slot)
		return slot
	}

	/**
	 * Matches: sources are resolved in order, a source whose bind map reads a variable an unresolved match binds
	 * waiting for it; variable and parent bindings first, then the constants, which may read any variable.
	 */
	#matches(): void {
		const pending = this.rule.matches.map((match, index) => ({ match, index }))
		const waiting = (m: ResolvedMatch): ReadonlyArray<string> => {
			if (m.source.kind !== "query") {
				return []
			}
			return entries(m.source.bind).flatMap(([, e]) =>
				e.kind === "var" && this.#unbound(e.var) ? [e.var] : []
			)
		}
		while (isNonEmpty(pending)) {
			const [p] = pending
			const found = pending.find((q) => waiting(q.match).length === 0)
			if (found === undefined) {
				fail(
					"MalformedDescription",
					p.match.loc,
					`a bind map reading variables some match binds; ${waiting(p.match).join(", ")} ${waiting(p.match).length === 1 ? "is" : "are"} bound by no match`
				)
			}
			const ready = found
			pending.splice(pending.indexOf(ready), 1)
			const { match, index } = ready
			const loc = match.loc
			const source = this.cx.source(
				match.source,
				this.scope,
				this.rule.interiors,
				loc,
				(term, param, at) => this.#bindValue(term, param, at)
			)
			const narrowed = this.#narrow(source, match.bindings, loc)
			const heading = narrowed.heading
			const bindings = entries(match.bindings).flatMap(([column, e]) => {
				const col = this.#column(
					narrowed,
					heading,
					column,
					childLoc(childLoc(loc, "bindings"), column)
				)
				if (e.kind === "var") {
					return [this.#bindUser(e.var, this.#reservedSlot(e.var, childLoc(loc, column)), col, loc)]
				}
				return e.kind === "parent"
					? [this.#bindParent(this.#parentSlot(e.column, loc), col, loc)]
					: []
			})
			this.#occurrences = [
				...this.#occurrences,
				{ match, index, loc, source: narrowed, heading, bindings, constants: [] }
			]
		}
		this.#occurrences = this.#occurrences
			.toSorted((a, b) => a.index - b.index)
			.map((occ) => this.#withConstants(occ))
	}

	#column(source: RelNode, heading: Heading, column: string, loc: SourceLoc): HeadingColumn {
		const c = columnOf(heading, column)
		if (c === undefined) {
			/** The matched union, or the union a matched take bounds. */
			const union = this.cx.unionOf(source.kind === "Take" ? source.input : source)
			return fail(
				"MalformedDescription",
				loc,
				union !== undefined && union.discriminant.length > 0
					? `a column every arm of the union delivers, or the discriminant (${union.discriminant.join(", ")}) bound to select arms that deliver ${column}`
					: `a column of the source's heading (${heading.map((h) => h.name).join(", ")}), not ${column}`
			)
		}
		return c
	}

	/**
	 * The source a match or a negation reads, narrowed to the arms its constants select (the types' LiteralArms,
	 * types/query/terms.ts). Each constant the bindings give a column of the source's heading, a value of the column's
	 * type, selects the arms that may deliver it: an arm holding a head literal at the column when the literal is the
	 * value, typed at the column, and any other arm when the value is one of the type the arm delivers the column at
	 * before a union widened it. Constants that select no arm are a filter no fact of the source meets, refused alike by
	 * the types (DeadConstants): "no arm of the source delivers the bound constants". A source that is no query, a
	 * relation, a context, a relation parameter, delivers every value of its columns' types, so its constants select
	 * it.
	 *
	 * A matched union of several headings whose bindings name a column only some arms deliver narrows to the arms its
	 * constants select, whose own columns the match may then bind, and the narrowed union selects again over its own
	 * heading, which holds those columns. Whether every selected arm delivers each column the match binds is decided by
	 * #column over their union.
	 *
	 * A bounded union, a take over such a union, narrows the same way: the selected arms' rows joined back to the bounded
	 * union on every common field, the discriminant included. The take's order completion refused the union
	 * unless its common fields hold a key (check/order.ts), so each bounded row is at most one arm row and the join back
	 * is the semi-join that keeps the arm rows among the first k. A take correlated to an attachment's parent is matched
	 * by nothing outside its attachment, so it is not narrowed.
	 */
	#narrow(source: RelNode, bindings: ResolvedMatch["bindings"], loc: SourceLoc): RelNode {
		if (source.kind === "Take" && source.correlation.length === 0) {
			const arms = this.#narrowUnion(source.input, bindings, loc)
			if (arms === source.input) {
				return source
			}
			const on = source.heading.map((c) => ({ left: c.name, right: c.name }))
			const back = this.cx.node(
				{ kind: "SemiJoin", left: arms, right: source, on, heading: arms.heading },
				loc
			)
			this.cx.inherit(back, arms)
			return back
		}
		return this.#narrowUnion(source, bindings, loc)
	}

	/** The arms of the union `source` its bindings' constants select, or `source` itself. */
	#narrowUnion(source: RelNode, bindings: ResolvedMatch["bindings"], loc: SourceLoc): RelNode {
		const selected = this.#selected(source, bindings, loc)
		const union = this.cx.unionOf(source)
		if (
			union === undefined ||
			source.kind !== "Union" ||
			source.groups.length < 2 ||
			selected.length === union.arms.length ||
			!entries(bindings).some(([c]) => !hasColumn(source.heading, c))
		) {
			return source
		}
		return this.#narrowUnion(only(selected) ?? this.cx.union(selected, loc), bindings, loc)
	}

	/**
	 * The arms of `source` that deliver every constant its bindings give a column of its heading (#narrow): a union's
	 * arms, a bounded union's, or the source itself as its one arm.
	 */
	#selected(
		source: RelNode,
		bindings: ResolvedMatch["bindings"],
		loc: SourceLoc
	): NonEmptyReadonlyArray<RelNode> {
		const heading = source.heading
		const constants = entries(bindings).flatMap(([column, e]) => {
			const col = columnOf(heading, column)
			return e.kind === "literal" &&
				col !== undefined &&
				this.cx.schema.admits(e.value, col.type, this.cx.patterns)
				? [{ column, value: e.value }]
				: []
		})
		const arms = this.cx.armsOf(source)
		const selected = arms.filter((arm) =>
			constants.every(({ column, value }) => this.#delivers(arm, column, value, loc))
		)
		if (!isNonEmpty(selected)) {
			return fail(
				"MalformedDescription",
				loc,
				`constants some arm of the source delivers; no arm of the source delivers the bound constants (${constants.map((c) => c.column).join(", ")})`
			)
		}
		return selected
	}

	/**
	 * Whether an arm may deliver `value` at `column`: its head literal is the value, typed at the column, or it delivers
	 * the column by a term of a type the value is one of, the type before a union widened it.
	 */
	#delivers(arm: RelNode, column: string, value: LiteralDesc, loc: SourceLoc): boolean {
		const col = columnOf(arm.heading, column)
		if (col === undefined) {
			return false
		}
		const head = this.cx.literalOf(arm)?.get(column)
		if (head !== undefined) {
			return (
				this.cx.schema.admits(value, col.type, this.cx.patterns) &&
				canonicalEquals(
					this.cx.schema.literal(value, col.type, loc, this.cx.patterns),
					head.literal,
					everyProperty
				)
			)
		}
		const delivered = defined(
			columnOf(this.cx.deliveredOf(arm), column),
			"an arm delivered each column of its heading before a union widened it"
		).type
		return this.cx.schema.admits(value, delivered, this.cx.patterns)
	}

	/**
	 * What an import's bind term binds a parameter to, read in this rule's scope: a scalar parameter is used at its
	 * declared type there, and a relation parameter is resolved where the import reads it as a source.
	 */
	#bindValue(term: ResolvedBound, param: string, loc: SourceLoc): BindValue {
		if (term.kind === "relationParam") {
			return this.cx.resolveParam(term.cell, this.scope, loc)
		}
		if (term.kind === "var") {
			return this.#slotValue(this.#userSlot(term.var, loc))
		}
		if (term.kind === "parent") {
			const slot = this.parents.get(term.column)
			return slot === undefined
				? fail(
						"MalformedDescription",
						loc,
						`a parent variable inside an attachment; ${term.column} is not one`
					)
				: this.#slotValue(slot)
		}
		if (term.kind === "param") {
			const resolved = this.cx.resolveParam(term.cell, this.scope, loc)
			if (resolved.kind === "param") {
				resolved.cell.use(this.cx.paramType(term, loc), loc)
			}
			return resolved.kind === "column"
				? this.#slotValue(this.#paramSlot(term.cell, loc))
				: resolved
		}
		if (term.kind === "literal") {
			return {
				kind: "literal",
				value: term.value,
				stated: term.type === undefined ? untyped : typed(this.cx.fieldType(term.type, loc)),
				loc
			}
		}
		return fail(
			"MalformedDescription",
			loc,
			`a bind term that is a parameter, an in-scope variable or a typed constant for parameter ${param}, not a ${term.kind} expression`
		)
	}

	/** A slot as a bind value: its column of the rule's region, at its type. */
	#slotValue(slot: Slot): BindValue {
		return { kind: "column", node: this.region, name: slot.name, type: this.slotType(slot) }
	}

	/** The leaf columns of this rule's region. */
	readonly #leaf = (
		desc: LeafDesc<Resolved>,
		loc: SourceLoc
	): { readonly name: string; readonly type: ScalarType } => {
		switch (desc.kind) {
			case "var": {
				const slot = this.#userSlot(desc.var, loc)
				return { name: slot.name, type: this.slotType(slot) }
			}
			case "parent": {
				const slot = this.#parentSlot(desc.column, loc)
				return { name: slot.name, type: this.slotType(slot) }
			}
			case "field":
			case "value":
				return fail(
					"MalformedDescription",
					loc,
					`a rule variable, parameter or literal here; a ${desc.kind} reference belongs to a contract predicate or a row check`
				)
		}
	}

	readonly #paramColumn = (
		cell: ParamCell,
		loc: SourceLoc
	): { readonly name: string; readonly type: ScalarType } => {
		const slot = this.#paramSlot(cell, loc)
		return { name: slot.name, type: this.slotType(slot) }
	}

	env(node: NodeId, loc: SourceLoc, reads: ExprReading): QueryEnv {
		return this.cx.env(node, loc, this.#leaf, this.scope, this.#paramColumn, reads)
	}

	/**
	 * A binding that fixes its column: a literal adopting the column's type, a parameter bound as the column's base, or
	 * a computed term that meets it (types.ts meets). The region holds a constant of the column's base type, or of the
	 * exact family it widens into (meetingType), whose equality with the column is the value equality the region writes;
	 * any other value is a hidden variable equated with it by the filter.
	 */
	#constant(column: HeadingColumn, e: ResolvedExpr, loc: SourceLoc): ConstantPlacement {
		comparable(column, "no constant, parameter or term fixes it", loc)
		const baseMatches = (t: ScalarType) => sameScalarType(baseOf(column.type), baseOf(t))
		if (e.kind === "literal" && e.type === undefined) {
			const literal = this.cx.schema.literal(e.value, column.type, loc, this.cx.patterns)
			const expr = this.cx.emit(literalSpec(literal, column.type))
			return { kind: "fix", expr }
		}
		if (e.kind === "param") {
			return this.#paramConstant(e, column, loc)
		}
		const term = unwrap(lowerTerm(e, this.env(this.region, loc, "value")))
		if (!meets(term.nominal, column.type)) {
			fail(
				"MalformedDescription",
				loc,
				`operands of one type: ${column.name} is ${typeLabel(column.type)}, the binding ${typeLabel(term.nominal)}`
			)
		}
		return {
			kind:
				baseMatches(term.expr.type) || meetingType(column.type, term.expr.type) !== column.type
					? "fix"
					: "filter",
			expr: term.expr
		}
	}

	/**
	 * A parameter binding that fixes its column. The parameter, of its declared type, meets the column (types.ts meets)
	 * and is bound as its type's base, as the same equality written with r.eq binds it. A column whose base is another, a
	 * regex refinement, a numeric typmod or a span's fixed width, would cast the parameter to it, and a typmod cast
	 * rounds: the column is a hidden variable equated with the parameter.
	 */
	#paramConstant(param: ParamExpr, column: HeadingColumn, loc: SourceLoc): ConstantPlacement {
		const baseMatches = (t: ScalarType) => sameScalarType(baseOf(column.type), baseOf(t))
		const cell = param.cell
		const resolved = this.cx.resolveParam(cell, this.scope, loc)
		switch (resolved.kind) {
			case "param": {
				const declared = this.cx.paramType(param, loc)
				if (!meets(declared, column.type)) {
					fail(
						"MalformedDescription",
						loc,
						`operands of one type: ${column.name} is ${typeLabel(column.type)}, parameter ${cell.name} ${typeLabel(declared)}`
					)
				}
				const bound = compareType(declared)
				const id = resolved.cell.use(declared, loc)
				return {
					kind: baseMatches(bound) ? "fix" : "filter",
					expr: this.cx.emit(paramSpec(id, "compare", bound))
				}
			}
			case "literal":
				return {
					kind: "fix",
					expr: this.cx.emit(boundConstant(this.cx.schema, resolved, column.type, this.cx.patterns))
				}
			case "column": {
				if (!compatible(resolved.type, column.type)) {
					fail(
						"MalformedDescription",
						loc,
						`operands of one type: the variable bound to parameter ${cell.name} is ${typeLabel(resolved.type)}, ${column.name} is ${typeLabel(column.type)}`
					)
				}
				if (baseMatches(resolved.type)) {
					return {
						kind: "fix",
						expr: this.cx.emit(columnSpec(resolved.node, resolved.name, resolved.type))
					}
				}
				const slot = this.#paramSlot(cell, loc)
				this.#needed.add(slot.id)
				return {
					kind: "filter",
					expr: this.cx.emit(columnSpec(this.region, slot.name, this.slotType(slot)))
				}
			}
		}
	}

	/**
	 * An occurrence with the constants its match binds, in binding order: each fixes its column, or binds a hidden
	 * variable the filter equates with the value.
	 */
	#withConstants(occ: PendingOccurrence): PendingOccurrence {
		const constants: Array<{ readonly column: string; readonly expr: ScalarExpr }> = []
		const hiddenBindings: Array<SlotBinding> = []
		for (const [column, e] of entries(occ.match.bindings)) {
			if (e.kind === "var" || e.kind === "parent") {
				continue
			}
			const at = childLoc(childLoc(occ.loc, "bindings"), column)
			const col = this.#column(occ.source, occ.heading, column, at)
			const placed = this.#constant(col, e, at)
			if (placed.kind === "fix") {
				constants.push({ column: col.name, expr: placed.expr })
				continue
			}
			const hidden = this.#hidden(col)
			hiddenBindings.push({ column: col.name, var: hidden })
			this.eqs.push({ kind: "value", hidden, value: placed.expr })
		}
		return { ...occ, bindings: [...occ.bindings, ...hiddenBindings], constants }
	}

	/**
	 * The rule's region, defined under its reserved label: its variables, each one declaration every binding of it and
	 * its correlation hold. An unbound parent variable is correlated to its parent column, an imported parameter to its
	 * outer value.
	 */
	#defineRegion(leaves: Leaves<Resolved["param"], Resolved["paramType"]>): RelNode {
		for (const v of [...leaves.vars].toSorted(compareStrings)) {
			if (!this.decls.has(v)) {
				fail(
					"MalformedDescription",
					this.loc,
					`a variable this rule declares; ${JSON.stringify(v)} is another rule's or no one's`
				)
			}
			if (this.#unbound(v)) {
				fail(
					"MalformedDescription",
					this.loc,
					`variable ${v} bound by a match: creating a variable with v does not bind it, using it in a match does`
				)
			}
		}
		const slots: Array<Slot> = [
			...this.rule.vars.flatMap((v) => {
				const s = this.user.get(v.id)
				return s === undefined ? [] : [s]
			}),
			...this.parents.values(),
			...[...this.paramSlots.values()].filter((s) => this.#needed.has(s.id)),
			...this.hidden
		]
		/** Each slot's one declaration, made at its first reader (the slots are typed by now). */
		const decls = new Map<Slot, VarDecl>()
		const declOf = (s: Slot): VarDecl => {
			const known = decls.get(s)
			if (known !== undefined) {
				return known
			}
			const decl: VarDecl = Object.freeze({ id: s.id, name: s.name, type: this.slotType(s) })
			decls.set(s, decl)
			return decl
		}
		const correlated: Array<{ readonly var: VarDecl; readonly expr: ScalarExpr }> = []
		for (const s of slots) {
			const outer =
				s.kind === "param" || (s.kind === "parent" && !this.#parentBindings.has(s.id))
					? s.outer
					: undefined
			if (outer !== undefined) {
				correlated.push({
					var: declOf(s),
					expr: this.cx.emit(columnSpec(outer.node, outer.name, outer.type))
				})
			}
		}
		const vars = slots.map(declOf)
		this.#defined = this.#occurrences.map((o) => ({
			pending: o,
			occurrence: {
				id: this.cx.b.ids.occurrence(),
				source: o.source,
				bindings: o.bindings.map((b) => ({ column: b.column, var: declOf(b.var) })),
				constants: o.constants
			}
		}))
		const occurrences: Array<Occurrence> = this.#defined.map((d) => d.occurrence)
		return this.cx.define(
			this.region,
			{
				kind: "MatchRegion",
				scope: this.cx.b.ids.scope(),
				vars,
				occurrences,
				equalities: [],
				correlated,
				heading: vars.map((v) => ({ name: v.name, type: v.type }))
			},
			this.loc
		)
	}

	/** The rule's scalar filters, and the equalities its hidden variables owe, as one Filter over the region. */
	#filter(region: RelNode): RelNode {
		const preds: Array<ScalarExpr> = []
		const { scalar } = splitWhere(this.rule.where)
		for (const [i, e] of scalar) {
			const loc = this.at("where", i)
			preds.push(unwrap(lowerPredicate(e, this.env(this.region, loc, "filter"))).expr)
		}
		const loc = this.at("where")
		for (const pending of this.eqs) {
			if (pending.kind === "slots") {
				const l = this.cx.emit(
					columnSpec(this.region, pending.left.name, this.slotType(pending.left))
				)
				const r = this.cx.emit(
					columnSpec(this.region, pending.right.name, this.slotType(pending.right))
				)
				preds.push(this.cx.opNamed("eq", [l, r], loc))
			} else {
				const h = this.cx.emit(
					columnSpec(this.region, pending.hidden.name, this.slotType(pending.hidden))
				)
				preds.push(this.cx.opNamed("eq", [h, pending.value], loc))
			}
		}
		if (preds.length === 0) {
			return region
		}
		return this.cx.node(
			{
				kind: "Filter",
				input: region,
				pred: this.cx.conjunction(preds, loc),
				heading: region.heading
			},
			this.at("where")
		)
	}

	/**
	 * The rule's negations placed after its head, each correlated binding under the head key that delivers its slot's
	 * column unchanged, when every binding the negations correlate is one and the head is a plain projection; otherwise
	 * undefined, and every negation applies over the region.
	 *
	 * A negated import whose bind map reads the rule's region (a rule or parent variable, or a parameter an
	 * enclosing import binds to an outer value) is correlated with each binding of the region:
	 * it applies over the region, where those values are still in scope.
	 */
	#lateNegations(): ReadonlyArray<LateNegation> | undefined {
		const { negations } = splitWhere(this.rule.where)
		if (negations.length === 0) {
			return undefined
		}
		const heads = entries(this.rule.head)
		if (heads.some(([, h]) => h.kind === "aggregate" || h.kind === "producer")) {
			return undefined
		}
		const slotOf = (e: ResolvedExpr): Slot | undefined =>
			e.kind === "var"
				? this.user.get(e.var)
				: e.kind === "parent"
					? this.parents.get(e.column)
					: e.kind === "param"
						? this.paramSlots.get(e.cell.name)
						: undefined
		const delivered = new Map<string, string>()
		for (const { column, slot } of this.correlation) {
			delivered.set(slot.name, column.name)
		}
		for (const [key, h] of heads) {
			const slot = h.kind === "aggregate" || h.kind === "producer" ? undefined : slotOf(h)
			if (slot !== undefined && !delivered.has(slot.name)) {
				delivered.set(slot.name, key)
			}
		}
		const late: Array<LateNegation> = []
		for (const [index, absent] of negations) {
			const readsRegion =
				absent.source.kind === "query" &&
				entries(absent.source.bind).some(
					([, term]) =>
						term.kind === "var" ||
						term.kind === "parent" ||
						(term.kind === "param" && this.paramSlots.has(term.cell.name))
				)
			if (readsRegion) {
				return undefined
			}
			const correlated = new Map<string, NegatedCorrelation>()
			for (const [column, e] of entries(absent.bindings)) {
				const slot = slotOf(e)
				if (slot === undefined) {
					if (e.kind === "var" || e.kind === "parent") {
						return undefined
					}
					continue
				}
				const on = delivered.get(slot.name)
				if (on === undefined) {
					return undefined
				}
				correlated.set(column, { region: this.#slotColumn(slot), on })
			}
			late.push({ index, absent, correlated })
		}
		return late
	}

	/** Each r.not over the region `input`, in order, each correlated binding on its slot's own column. */
	#earlyNegations(input: RelNode): RelNode {
		let node = input
		const { negations } = splitWhere(this.rule.where)
		const correlate: Correlate = (_, e, at) => {
			const slot =
				e.kind === "var"
					? this.#userSlot(e.var, at)
					: e.kind === "parent"
						? this.#parentSlot(e.column, at)
						: e.kind === "param"
							? this.paramSlots.get(e.cell.name)
							: undefined
			return slot === undefined ? undefined : { region: this.#slotColumn(slot), on: slot.name }
		}
		for (const [i, absent] of negations) {
			node = this.#negation(node, absent, this.at("where", i), correlate)
		}
		return node
	}

	/**
	 * One r.not over `left`: an AntiJoin against the negated source projected onto the columns this rule's values fix.
	 * A constant of the negation reads no variable of the rule: those correlate through the columns above. The negated
	 * source is narrowed to the arms its constants select, as a match's is (#narrow).
	 */
	#negation(
		left: RelNode,
		absent: Extract<ResolvedExpr, { readonly kind: "absent" }>,
		loc: SourceLoc,
		correlate: Correlate
	): RelNode {
		const source = this.#narrow(
			this.cx.source(absent.source, this.scope, this.rule.interiors, loc, (term, param, at) =>
				this.#bindValue(term, param, at)
			),
			absent.bindings,
			loc
		)
		const heading = source.heading
		const placed = entries(absent.bindings).map(([column, e]) =>
			this.#negatedBinding(
				source,
				heading,
				column,
				e,
				childLoc(childLoc(loc, "bindings"), column),
				correlate
			)
		)
		const bindings: Array<{ readonly column: string; readonly var: VarDecl }> = []
		const constants: Array<{ readonly column: string; readonly expr: ScalarExpr }> = []
		const vars: Array<VarDecl> = []
		const on: Array<{ readonly left: string; readonly right: string }> = []
		/** Columns fixed to a value through a variable of the negated region and a filter over it. */
		const filtered: Array<{
			readonly column: string
			readonly type: ScalarType
			readonly value: ScalarExpr
		}> = []
		for (const p of placed) {
			if (p.kind === "constant") {
				constants.push({ column: p.column, expr: p.expr })
				continue
			}
			if (p.kind === "none") {
				continue
			}
			const decl: VarDecl = Object.freeze({ id: this.cx.b.ids.var(), name: p.column, type: p.type })
			vars.push(decl)
			bindings.push({ column: p.column, var: decl })
			if (p.kind === "correlated") {
				on.push({ left: p.left, right: p.column })
			} else {
				filtered.push({ column: p.column, type: p.type, value: p.value })
			}
		}
		const occurrence = this.cx.b.ids.occurrence()
		const negated = this.cx.node(
			{
				kind: "MatchRegion",
				scope: this.cx.b.ids.scope(),
				vars,
				occurrences: [{ id: occurrence, source, bindings, constants }],
				equalities: [],
				correlated: [],
				heading: vars.map((v) => ({ name: v.name, type: v.type }))
			},
			loc
		)
		const regionOut = negated.heading
		const narrowed =
			filtered.length === 0
				? negated
				: this.cx.node(
						{
							kind: "Filter",
							input: negated,
							pred: this.cx.conjunction(
								filtered.map((f) =>
									this.cx.opNamed(
										"eq",
										[this.cx.emit(columnSpec(negated.id, f.column, f.type)), f.value],
										loc
									)
								),
								loc
							),
							heading: regionOut
						},
						loc
					)
		const fixedOnly = new Set(filtered.map((f) => f.column))
		const rightOut = regionOut.filter((c) => !fixedOnly.has(c.name))
		const right = this.cx.node(
			{
				kind: "ProjectSet",
				input: narrowed,
				out: rightOut.map((c) => ({
					name: c.name,
					expr: this.cx.emit(columnSpec(narrowed.id, c.name, c.type))
				})),
				heading: rightOut
			},
			loc
		)
		const node = this.cx.node({ kind: "AntiJoin", left, right, on, heading: left.heading }, loc)
		this.cx.inherit(node, left)
		return node
	}

	/**
	 * How a binding of a negated match lands in its region: correlated with a column of the rule's region, a constant
	 * of the negated region, a column fixed through a variable of the negated region and a filter over it, or nothing.
	 */
	#negatedBinding(
		source: RelNode,
		heading: Heading,
		column: string,
		e: ResolvedExpr,
		at: SourceLoc,
		correlate: Correlate
	): NegatedBinding {
		const col = columnOf(heading, column)
		if (col === undefined) {
			return fail("MalformedDescription", at, `a column of the negated source, not ${column}`)
		}
		const correlation = correlate(column, e, at)
		if (correlation !== undefined) {
			return this.#correlatedBinding(col, correlation, at)
		}
		if (e.kind === "literal") {
			return { kind: "constant", column, expr: this.#negatedLiteral(e, col, at) }
		}
		if (e.kind !== "param") {
			return { kind: "constant", column, expr: this.#negatedTerm(source, e, col, at) }
		}
		const resolved = this.cx.resolveParam(e.cell, this.scope, at)
		if (resolved.kind === "literal") {
			return {
				kind: "constant",
				column,
				expr: this.cx.emit(boundConstant(this.cx.schema, resolved, col.type, this.cx.patterns))
			}
		}
		if (resolved.kind !== "param") {
			return { kind: "none" }
		}
		/**
		 * Of its declared type, meeting the column, and bound as its base, as everywhere it is compared. A column of
		 * another base, a regex refinement or a numeric typmod, is a variable of the negated region equated with the
		 * parameter by a filter there, never a cast of the parameter, which for a typmod rounds.
		 */
		const declared = this.cx.paramType(e, at)
		if (!meets(declared, col.type)) {
			fail(
				"MalformedDescription",
				at,
				`operands of one type: ${col.name} is ${typeLabel(col.type)}, parameter ${e.cell.name} ${typeLabel(declared)}`
			)
		}
		const bound = compareType(declared)
		const id = resolved.cell.use(declared, at)
		const value = this.cx.emit(paramSpec(id, "compare", bound))
		return sameScalarType(baseOf(col.type), bound)
			? { kind: "constant", column, expr: value }
			: { kind: "filtered", column, type: col.type, value }
	}

	/**
	 * A negated column correlated with a region column of a compatible type, compared by `=` with no cast, as a stored
	 * foreign key compares its columns: what compatible types may differ in refines their values and leaves PostgreSQL's
	 * equality alone, a text's pattern and bounds (every text is of the deterministic collation pg_c_utf8), a numeric's
	 * typmod, a span's width. A serial column is its integer, so it correlates with its integer's values.
	 */
	#correlatedBinding(
		col: HeadingColumn,
		correlation: NegatedCorrelation,
		at: SourceLoc
	): NegatedBinding {
		const { region } = correlation
		if (!compatible(region.type, col.type)) {
			fail(
				"MalformedDescription",
				at,
				`operands of one type: ${region.name} is ${typeLabel(region.type)}, ${col.name} is ${typeLabel(col.type)}`
			)
		}
		return { kind: "correlated", column: col.name, type: col.type, left: correlation.on }
	}

	/** A literal binding of a negated match: one adopting the column's type, or one of the type it states. */
	#negatedLiteral(
		e: Extract<ResolvedExpr, { readonly kind: "literal" }>,
		col: HeadingColumn,
		at: SourceLoc
	): ScalarExpr {
		if (e.type === undefined) {
			return this.cx.emit(
				literalSpec(this.cx.schema.literal(e.value, col.type, at, this.cx.patterns), col.type)
			)
		}
		const t = this.cx.fieldType(e.type, at)
		if (!compatible(t, col.type)) {
			fail(
				"MalformedDescription",
				at,
				`operands of one type: ${col.name} is ${typeLabel(col.type)}`
			)
		}
		return this.cx.emit(literalSpec(this.cx.schema.literal(e.value, t, at, this.cx.patterns), t))
	}

	/**
	 * A computed binding of a negated match, lowered over the negated source, of a type that meets its column (types.ts
	 * meets), as a match's computed binding is (#constant): an exact integer or money value fixes a plain column of its
	 * family. An own or literal-bound parameter is a constant here; a parameter an import binds to an outer variable reads
	 * the rule's region, which the negated source cannot, like a variable.
	 */
	#negatedTerm(source: RelNode, e: ResolvedExpr, col: HeadingColumn, at: SourceLoc): ScalarExpr {
		const base = this.env(source.id, at, "value")
		const term = unwrap(
			lowerTerm(e, {
				...base,
				leaf: (d, loc) =>
					Result.err(
						unsupported(
							loc,
							`relational negation over a computed binding of ${d.kind === "var" ? `variable ${d.var}` : `a ${d.kind} reference`}; bind the variable to the column itself and compute in the rule's filter`
						)
					),
				params: {
					kind: "scope",
					lower: (param, loc) => {
						const resolved = catchRefusal(() => this.cx.resolveParam(param.cell, this.scope, loc))
						if (!resolved.ok) {
							return Result.err(resolved.error)
						}
						if (resolved.value.kind === "column") {
							return Result.err(
								unsupported(
									loc,
									`relational negation over a computed binding of parameter ${param.cell.name}, which the import binds to an outer variable; bind the variable to the column itself and compute in the rule's filter`
								)
							)
						}
						return base.params.lower(param, loc)
					}
				}
			})
		)
		if (!meets(term.nominal, col.type)) {
			fail(
				"MalformedDescription",
				at,
				`operands of one type: ${col.name} is ${typeLabel(col.type)}`
			)
		}
		return term.expr
	}

	/** A head term other than an aggregate or producer, over `input`. */
	#term(name: string, h: ResolvedExpr, input: RelNode, loc: SourceLoc): TermOut {
		const target = writtenTarget(this.scope.origin)?.relation.heading.find((c) => c.name === name)
		const targetType = target?.type
		const column = (c: HeadingColumn): TermOut => ({
			expr: this.cx.emit(columnSpec(input.id, c.name, c.type)),
			type: c.type,
			literal: undefined
		})
		const literal = (value: LiteralDesc, typing: LiteralTyping, at: SourceLoc): TermOut => {
			const admitted = typing.kind === "fixed" ? typing.type : this.cx.bareLiteralType(value, at)
			const lit = this.cx.schema.literal(value, admitted, at, this.cx.patterns)
			const type =
				lit.kind === "numeric" && isComputedNumeric(admitted)
					? literalNumeric(lit.value.parts)
					: admitted
			const head: HeadLiteral =
				typing.kind === "fixed"
					? { kind: "fixed", literal: lit }
					: { kind: "bare", literal: lit, value, loc: at }
			return { expr: this.cx.emit(literalSpec(lit, type)), type, literal: head }
		}
		if (h.kind === "var" || h.kind === "parent") {
			return column(this.#leaf(h, loc))
		}
		if (h.kind === "literal") {
			return literal(h.value, this.#literalTermType(h, targetType, loc), loc)
		}
		if (h.kind === "param") {
			return this.#paramTerm(h, loc, column, literal)
		}
		if (h.kind === "absent") {
			return fail(
				"UnsupportedOperation",
				loc,
				"r.not as a head term: relational negation is a rule-level filter"
			)
		}
		/**
		 * The column has the type the builder gives the term (its nominal type): a Compute.base or a widening cast emits
		 * no node of its own, so where the node it reads still carries the contract or typmod the term drops, the column
		 * casts it, and a child binds it as the parent's heading states it.
		 */
		const term = unwrap(lowerTerm(h, this.env(input.id, loc, "value")))
		const expr = sameScalarType(term.expr.type, term.nominal)
			? term.expr
			: this.cx.emit({
					kind: "cast",
					cast: binaryCoercion,
					args: [term.expr],
					type: term.nominal,
					nonNull: "strict",
					volatility: "immutable"
				})
		return { expr, type: term.nominal, literal: undefined }
	}

	/**
	 * How a literal head term is typed: fixed at the type it states (X.handle, Compute.literal), else at the written
	 * column's; else bare, at its value's JavaScript default, which a union retypes by its position (Checker
	 * #positionedTypes). What the rule's matches fix never types it: its value carries its type.
	 */
	#literalTermType(
		h: Extract<ResolvedExpr, { readonly kind: "literal" }>,
		targetType: ScalarType | undefined,
		loc: SourceLoc
	): LiteralTyping {
		if (h.type !== undefined) {
			return { kind: "fixed", type: this.cx.fieldType(h.type, loc) }
		}
		return targetType === undefined ? { kind: "bare" } : { kind: "fixed", type: targetType }
	}

	/**
	 * A parameter head term, emitted or written at its declared type, which a written member's column is compatible
	 * with (member.ts checkMemberHeading) and is cast into where it is written; an import's parameter bound to a literal
	 * is that literal at the type it states, else at the parameter's.
	 */
	#paramTerm(
		param: ParamExpr,
		loc: SourceLoc,
		column: (c: HeadingColumn) => TermOut,
		literal: (value: LiteralDesc, typing: LiteralTyping, at: SourceLoc) => TermOut
	): TermOut {
		const resolved = this.cx.resolveParam(param.cell, this.scope, loc)
		const role: ParamRole = writtenTarget(this.scope.origin) === undefined ? "emit" : "write"
		switch (resolved.kind) {
			case "param": {
				const declared = this.cx.paramType(param, loc)
				const id = resolved.cell.use(declared, loc)
				return {
					expr: this.cx.emit(paramSpec(id, role, declared)),
					type: declared,
					literal: undefined
				}
			}
			case "literal":
				return literal(
					resolved.value,
					{
						kind: "fixed",
						type:
							resolved.stated.kind === "typed"
								? resolved.stated.type
								: this.cx.paramType(param, loc)
					},
					resolved.loc
				)
			case "column":
				return column(this.#paramColumn(param.cell, loc))
		}
	}

	/** find: a set projection; with aggregates a Group over the complete bound tuple; with a producer a Produce. */
	#head(input: RelNode): RelNode {
		const headEntries = entries(this.rule.head)
		const corr = this.correlation
			.filter(
				({ column: c }) =>
					!headEntries.some(
						([k, h]) => k === c.name && h.kind === "parent" && h.column === c.parent
					)
			)
			.map(({ column: c, slot }) => {
				if (this.rule.head[c.name] !== undefined) {
					fail(
						"MalformedDescription",
						this.at("head", c.name),
						`a head key distinct from the attachment's correlation column ${c.name}`
					)
				}
				return { name: c.name, slot }
			})
		const aggregates: Array<readonly [string, AggregateHead]> = []
		const producers: Array<readonly [string, ProducerHead]> = []
		const plain: Array<readonly [string, ResolvedExpr]> = []
		for (const [name, h] of headEntries) {
			if (h.kind === "aggregate") {
				aggregates.push([name, h])
			} else if (h.kind === "producer") {
				producers.push([name, h])
			} else {
				plain.push([name, h])
			}
		}
		const folded = foldedOf(this.at("head"), aggregates, producers)
		if (folded === undefined) {
			const literals = new Map<string, HeadLiteral>()
			const out: Array<OutColumn> = [
				...corr.map((c) => {
					const col = this.#slotColumn(c.slot)
					return {
						name: c.name,
						expr: this.cx.emit(columnSpec(input.id, col.name, col.type)),
						type: col.type
					}
				}),
				...plain.map(([name, h]) => {
					const t = this.#term(name, h, input, this.at("head", name))
					if (t.literal !== undefined) {
						literals.set(name, t.literal)
					}
					return { name, ...t }
				})
			]
			const node = this.cx.node(
				{
					kind: "ProjectSet",
					input,
					...projectionOf(out)
				},
				this.at("head")
			)
			this.cx.setLiterals(node, literals)
			return node
		}
		return this.#grouped(input, corr, plain, folded)
	}

	/** The Group over `groupInput` of a head's aggregates, each under its result column. */
	#groupNode(
		groupInput: RelNode,
		keyColumns: ReadonlyArray<HeadingColumn>,
		aggregates: NonEmptyReadonlyArray<Placed<AggregateHead>>,
		loc: SourceLoc
	): Folding {
		const groupHeading = groupInput.heading
		const hiddenNames = new Set(this.hidden.map((h) => h.name))
		const aggs = mapNonEmpty(aggregates, ({ name, column, head }) => {
			const at = this.at("head", name)
			const { overload, call } = this.#aggregate(head, groupInput, at)
			const spec: AggregateSpec = {
				name: column,
				op: OpId(overload.op),
				filter: undefined,
				...call
			}
			return { name, spec, column: { name: column, type: overload.result } }
		})
		const node = this.cx.node(
			{
				kind: "Group",
				input: groupInput,
				bound: this.#foldInput(
					groupHeading.filter((c) => !hiddenNames.has(c.name)).map((c) => c.name)
				),
				keys: keyColumns.map((c) => c.name),
				aggs: aggs.map((a) => a.spec),
				heading: [...keyColumns, ...aggs.map((a) => a.column)]
			},
			loc
		)
		return { node, results: aggs.map(({ name, column }) => ({ name, column })) }
	}

	/**
	 * The proof that the bound tuple `columns` holds a key of every fact the rule matches (ir/rel.ts FoldInput): each
	 * match binds, by a variable, a parent variable or a constant, every field of one key of its source, so a fold over
	 * the rule's bindings reads each matched fact once. A variable a match binds is a column of the bound tuple, or a
	 * hidden one the filter equates with a variable or a value, so a bound field is a field the bound tuple fixes. A match
	 * that binds no key whole is refused (FoldOverProjection), naming its source and the key to bind: its fold would read
	 * a projection of the facts, whose repeats a set no longer holds. Distinct values are folded by matching a query of
	 * them, a set keyed by its heading.
	 */
	#foldInput(columns: KeySet): FoldInput {
		const keyed = this.#defined.map(({ pending, occurrence }) => {
			const bound = new Set([
				...occurrence.bindings.map((b) => b.column),
				...occurrence.constants.map((c) => c.column)
			])
			const keys = this.#sourceKeys(occurrence.source)
			const key = keys.find((k) => k.every((f) => bound.has(f)))
			if (key === undefined) {
				return failWith({
					_tag: "FoldOverProjection",
					at: pending.loc,
					source: sourceLabel(pending.match.source),
					key: keys[0]
				})
			}
			return { occurrence: occurrence.id, key }
		})
		return { columns, keyed }
	}

	/**
	 * The keys of a matched source, narrowest first as its declaration states them: a relation's primary key and every
	 * further key, a view's proved keys then its whole heading, a closed relation's key, a delta's relation's keys, the
	 * empty key of a context's one fact, and the whole heading of any other source (a relation parameter, a matched
	 * query or stage, a recursion's feedback), which is a set keyed by its heading.
	 */
	#sourceKeys(source: RelNode): NonEmptyReadonlyArray<KeySet> {
		const heading = source.heading.map((c) => c.name)
		switch (source.kind) {
			case "Base":
				return source.relationKind === "relation"
					? [source.primaryKey, ...source.keys]
					: appendNonEmpty<KeySet>(
							source.view.map((k) => k.fields),
							heading
						)
			case "Closed": {
				const closed = this.cx.schema.closed.get(source.closed)
				return closed === undefined ? [heading] : [closed.relation.primaryKey]
			}
			case "Context":
				return [[]]
			case "Delta":
				return isNonEmpty(source.keys) ? source.keys : [heading]
			case "InputSet":
			case "MatchRegion":
			case "Filter":
			case "ProjectSet":
			case "SemiJoin":
			case "AntiJoin":
			case "Union":
			case "Intersect":
			case "Difference":
			case "Take":
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
				return [heading]
		}
	}

	/** An aggregate applied over `groupInput`: its native overload and its call, count over no argument. */
	#aggregate(
		head: AggregateHead,
		groupInput: RelNode,
		at: SourceLoc
	): { readonly overload: AggregateOverload; readonly call: AggregateCallOver<ScalarExpr> } {
		if (head.fn === "count") {
			return { overload: countOverload(), call: { fn: "count", args: [] } }
		}
		const env = this.env(groupInput.id, at, "value")
		const arg = unwrap(
			returnsInput[head.fn] ? lowerReturned(head.arg, env) : lowerTerm(head.arg, env)
		)
		const overload = unwrap(unaryOverload(head.fn, arg.expr.type, at))
		return { overload, call: { fn: overload.fn, args: [arg.expr] } }
	}

	/** The Produce over `groupInput` of a head's one span producer, under its result column. */
	#produceNode(
		groupInput: RelNode,
		keyColumns: ReadonlyArray<HeadingColumn>,
		{ name, column, head }: Placed<ProducerHead>,
		loc: SourceLoc
	): Folding {
		const at = this.at("head", name)
		const { call, type } = this.#produced(head, groupInput, at)
		const result = { name: column, type }
		const node = this.cx.node(
			{
				kind: "Produce",
				input: groupInput,
				...call,
				carried: keyColumns.map((c) => c.name),
				out: column,
				heading: [...keyColumns, result]
			},
			loc
		)
		return { node, results: [{ name, column: result }] }
	}

	/** A span producer's call over its lowered span arguments, and the type of the spans it yields. */
	#produced(
		p: ProducerHead,
		groupInput: RelNode,
		at: SourceLoc
	): { readonly call: ProducerCallOver<ScalarExpr>; readonly type: ScalarType } {
		const env = this.env(groupInput.id, at, "value")
		const span = (a: ResolvedExpr, i: number) => {
			const t = unwrap(lowerTerm(a, env))
			if (spanBase(t.nominal) === undefined) {
				fail(
					"MalformedDescription",
					childLoc(at, i),
					`a span argument for ${p.fn}, not ${typeLabel(t.nominal)}`
				)
			}
			return t
		}
		if (p.fn === "pack") {
			const spans = span(p.args[0], 0)
			return {
				call: { producer: producerKinds.pack, args: [spans.expr] },
				type: spans.expr.type
			}
		}
		const first = span(p.args[0], 0)
		const second = span(p.args[1], 1)
		if (!compatible(second.nominal, first.nominal)) {
			fail("MalformedDescription", at, `spans of one type for ${p.fn}`)
		}
		return {
			call: { producer: producerKinds[p.fn], args: [first.expr, second.expr] },
			type: first.expr.type
		}
	}

	/**
	 * A head with aggregates or a producer: the keys are the non-aggregate terms, columns of the input; a computed
	 * key is a column a projection over the input adds; a constant key is added by a projection over the result, so it
	 * never groups.
	 */
	#grouped(
		input: RelNode,
		corr: ReadonlyArray<{ readonly name: string; readonly slot: ParentSlot }>,
		plain: ReadonlyArray<readonly [string, ResolvedExpr]>,
		folded: Folded
	): RelNode {
		const loc = this.at("head")
		const inputHeading = input.heading
		const isConstant = (h: ResolvedExpr): boolean => {
			if (h.kind === "literal") {
				return true
			}
			if (h.kind !== "param") {
				return false
			}
			const params = this.scope.params
			return params.kind === "own" || params.values.get(h.cell.name)?.kind !== "column"
		}
		/** A head key: a slot's column, or a term the projection below computes under a fresh column. */
		type Key =
			| { readonly kind: "column"; readonly name: string; readonly column: HeadingColumn }
			| {
					readonly kind: "computed"
					readonly name: string
					readonly column: string
					readonly desc: ResolvedExpr
			  }
		const keys: Array<Key> = corr.map((c) => ({
			kind: "column",
			name: c.name,
			column: this.#slotColumn(c.slot)
		}))
		const constants: Array<readonly [string, ResolvedExpr]> = []
		const internal = new Set(inputHeading.map((c) => c.name))
		const freshInternal = (stem: string) => {
			let name = stem
			for (let n = 2; internal.has(name); n++) {
				name = `${stem}_${n}`
			}
			internal.add(name)
			return name
		}
		for (const [name, h] of plain) {
			if (isConstant(h)) {
				constants.push([name, h])
			} else if (h.kind === "var" || h.kind === "parent" || h.kind === "param") {
				keys.push({
					kind: "column",
					name,
					column: h.kind === "param" ? this.#paramColumn(h.cell, loc) : this.#leaf(h, loc)
				})
			} else {
				keys.push({ kind: "computed", name, column: freshInternal(`__key_${name}`), desc: h })
			}
		}
		/** The input's columns, passed through the projection that adds the computed keys, when there is one. */
		const passed: ReadonlyArray<OutColumn> = keys.some((k) => k.kind === "computed")
			? inputHeading.map((c) => ({
					name: c.name,
					expr: this.cx.emit(columnSpec(input.id, c.name, c.type)),
					type: c.type
				}))
			: []
		const added: Array<OutColumn> = []
		/**
		 * One group key per distinct column: two head keys delivering one variable share its column, and the renaming
		 * projection below delivers it under each name.
		 */
		const keyed = keys.map((k) => {
			if (k.kind === "column") {
				return { name: k.name, column: k.column }
			}
			const t = this.#term(k.name, k.desc, input, this.at("head", k.name))
			const column: HeadingColumn = { name: k.column, type: t.type }
			added.push({ ...column, expr: t.expr })
			return { name: k.name, column }
		})
		const groupInput =
			added.length === 0
				? input
				: this.cx.node({ kind: "ProjectSet", input, ...projectionOf([...passed, ...added]) }, loc)
		const keyColumns = [...new Map(keyed.map((k) => [k.column.name, k.column])).values()]
		const keyNames = keyColumns.map((c) => c.name)
		const { node, results } =
			folded.kind === "aggregates"
				? this.#groupNode(
						groupInput,
						keyColumns,
						aggregateColumns(keyNames, folded.aggregates),
						loc
					)
				: this.#produceNode(groupInput, keyColumns, producedColumn(keyNames, folded.producer), loc)
		const renamed =
			constants.length > 0 ||
			keyed.some((k) => k.name !== k.column.name) ||
			results.some((r) => r.name !== r.column.name)
		if (!renamed) {
			return node
		}
		const literals = new Map<string, HeadLiteral>()
		const out: Array<OutColumn> = [
			...keyed.map(({ name, column: c }) => ({
				name,
				expr: this.cx.emit(columnSpec(node.id, c.name, c.type)),
				type: c.type
			})),
			...results.map(({ name, column: c }) => ({
				name,
				expr: this.cx.emit(columnSpec(node.id, c.name, c.type)),
				type: c.type
			})),
			...constants.map(([name, h]) => {
				const t = this.#term(name, h, node, this.at("head", name))
				if (t.literal !== undefined) {
					literals.set(name, t.literal)
				}
				return { name, expr: t.expr, type: t.type }
			})
		].toSorted(byName)
		const projected = this.cx.node(
			{
				kind: "ProjectSet",
				input: node,
				...projectionOf(out)
			},
			loc
		)
		this.cx.setLiterals(projected, literals)
		return projected
	}
}
