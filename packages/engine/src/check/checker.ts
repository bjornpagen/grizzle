import { emptyAllenMask, parseAllenMask } from "#compiler/allen/mask.ts"
import { allenExpr } from "#compiler/check/allen.ts"
import { approximate } from "#compiler/check/approximate/index.ts"
import { completeStated } from "#compiler/check/complete.ts"
import type { CheckedNodeSpec, ScopedServices, StageScope } from "#compiler/check/context.ts"
import { type Declared, DeclarationTable } from "#compiler/check/declarations.ts"
import { only } from "#compiler/check/defined.ts"
import { fail, failWith } from "#compiler/check/fail.ts"
import {
	declaredKeys,
	deliversFloat,
	groupedZeroed,
	type MergeRule,
	type RegionMatches,
	regionMatches,
	type StatedMerge
} from "#compiler/check/merge.ts"
import type { StatedOrder } from "#compiler/check/order.ts"
import type {
	ParamCell,
	ParamTable,
	Resolved,
	ResolvedAttach,
	ResolvedBound,
	ResolvedExpr,
	ResolvedHead,
	ResolvedImport,
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
	type RelationalFilter,
	ruleLeaves,
	splitWhere
} from "#compiler/check/scan.ts"

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { MemberRelation, SchemaReading } from "#compiler/check/schema.ts"
import type { CheckSession } from "#compiler/check/session.ts"
import { allenMaskMax } from "#compiler/core/allen.ts"
import { canonicalEquals, canonicalTextOf, catchRefusal, unwrap } from "#compiler/core/canonical.ts"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import type { NodeId, ParamId, VarId } from "#compiler/core/ids.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { type Comparator, compareStrings, mapInput } from "#compiler/core/order.ts"
import { DagBuilder, type ReservedNode } from "#compiler/ir/builder.ts"
import {
	type ClockBinding,
	type ParamReading,
	readingOf,
	statedReading
} from "#compiler/ir/clock.ts"
import { deliverySpine, relNode } from "#compiler/ir/dag.ts"
import {
	bindTerms,
	exprChildren,
	descText,
	type FieldDesc,
	functionTypeLabel,
	type LiteralDesc,
	type NamedDesc,
	type OrderDesc,
	type VarDesc,
	valueHeading
} from "#compiler/ir/desc.ts"
import { isInstantType } from "#compiler/ir/instant.ts"
import type { OwnedFunction } from "#compiler/schema/function-own.ts"

import { int4Max } from "#compiler/core/canonical.ts"
import {
	type ExprSpec,
	type DefinedOp,
	type TypedLiteral,
	OpId,
	type ParamRole,
	type ScalarExpr,
	storedColumn
} from "#compiler/ir/expr.ts"
import { headingColumns } from "#compiler/ir/law.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	type AggregateCallOver,
	type AggregateSpec,
	builtSides,
	type CallArg,
	type CompletedOrder,
	conservativeMeta,
	type Correlation,
	type DeclaredKey,
	type FoldInput,
	type Heading,
	type HeadingColumn,
	inputsOf,
	type KeySet,
	type LiveRefs,
	type Occurrence,
	type ProducerCallOver,
	type ProducerKind,
	type RelNode,
	semiJoinRight,
	seriesArguments,
	seriesHeading,
	splitArgument,
	type TakeBound,
	type TextSplit,
	tokensHeading,
	unionArms,
	type VarDecl
} from "#compiler/ir/rel.ts"
import {
	baseOf,
	type Carrier,
	isFloat,
	languageOctets,
	languageWithin,
	type PlainType,
	sameScalarType,
	type ScalarType,
	type SpanCarrier,
	type TextInfo,
	textInfoBounds,
	textOf,
	textPatterns,
	typeLabel
} from "#compiler/ir/scalar.ts"
import {
	type AggregateOverload,
	countOverload,
	returnsInput,
	unaryOverload
} from "#compiler/scalar/aggregate.ts"
import { type Bounds, seriesBounds } from "#compiler/scalar/compute/bounds.ts"
import { bareLiteralKind } from "#compiler/scalar/compute/literal.ts"
import {
	type LowerEnv,
	type Lowered,
	loweredOf,
	lowerPredicate,
	lowerReturned,
	lowerTerm
} from "#compiler/scalar/compute/lower.ts"
import {
	binaryCoercion,
	canonicalZeroSpec,
	definedIdOf,
	definedRangeOp,
	overloadOf
} from "#compiler/scalar/compute/registry.ts"
import { type Typing, typed, untyped } from "#compiler/scalar/compute/term.ts"
import {
	anyNumeric,
	compatible,
	exactType,
	familyDigits,
	isComputedNumeric,
	literalNumeric,
	meetingType,
	meets,
	sameCarrier,
	wildcardText,
	widening
} from "#compiler/scalar/compute/types.ts"
import {
	adoptedType,
	type ClosedRelations,
	type HeldLeaf,
	type LeafDesc,
	type LowerParams,
	noClosedRelations,
	type ParamRef
} from "#compiler/scalar/compute/typing.ts"
import { type PlainCarrier, plainType } from "#compiler/scalar/native.ts"
import type { CompilePatterns, PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { tokenSource } from "#compiler/scalar/regex/whitespace.ts"
import { hasCapability, spanType } from "#compiler/scalar/registry.ts"
import { textLookup } from "#compiler/text/refinement.ts"
/**
 * How a query is read: as rows (execute, get, compile, attach, derived, a ChangeSet member), as a page, as a
 * ChangeSet's read-back, which may read delta.added and delta.removed sources, as a write filter's membership, which
 * reads the row it is asked at (schema/entry.ts), or as a rule probe over its region (analysis/theory/query.ts
 * regionProbe), which reads the rows a transaction wrote of the relation it probes as delta.added, their images after
 * each statement, and delta.removed, their images before. A read-back may name the delta of any ordinary relation: one
 * the ChangeSet does not write is empty, which the write program supplies. A region's rows are row images, several of
 * one key where statements rewrote a row, so its delta declares no key.
 */
export type QueryRead = "rows" | "page" | "readBack" | "membership" | "region"

export interface CheckOptions {
	readonly read: QueryRead
	/**
	 * The label of the query's location in diagnostics: "query", `read <name>`, `<op> <relation>`, `derived <name>`.
	 */
	readonly label: string
	/** The program parameters its served member binds to the database's clock (workload clocked), each a reading of the
	 * clock's range (ir/clock.ts ParamReading); none for a query no member clocks. */
	readonly clock: ClockBinding
	/** What the checks of its compile share (check/session.ts). */
	readonly session: CheckSession
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

/**
 * A bound value's part of a key (`importedKey`, Checker `#closedCall`), and whether it is closed: a parameter by its
 * name and a constant by its canonical text, closed; an outer value by the node and the column it is read through, not
 * closed, the same rows wherever that node's row is read; and the rows of a query a relation parameter is bound to by
 * that query's own import's key, closed where it is.
 */
const boundPart = (session: CheckSession, value: BindValue): ImportKey => {
	switch (value.kind) {
		case "param":
			return { text: `p:${value.cell.name}`, closed: true }
		case "literal":
			return { text: `l:${canonicalTextOf([value.value, value.stated])}`, closed: true }
		case "column":
			return { text: `c:${value.node}:${value.name}`, closed: false }
		case "rows": {
			const key = importedKey(session, value.query, value.values)
			return { text: `r(${key.text})`, closed: key.closed }
		}
	}
}

/**
 * The key two imports share exactly when they read the same rows (Checker `#imported`): the imported query, by its
 * identity (check/session.ts queryIdentity), which one resolution of the compile's Descriptions gives every import of
 * it, of one Description object or of several of one identity, in every query it checks (check/session.ts
 * CheckSession), and each bound value (`boundPart`), a parameter by its name, the one parameter of
 * that name its query, or its ChangeSet, whose members' and read-backs' parameters are one namespace, declares, a
 * constant by its canonical text, the rows of a query by that query's import's key, so one guard bound into the
 * imports of several members is one node, and an outer value by the node and the column it is read through: every
 * match of one query at one node's values reads one import, correlated to that node, which the CTE policy computes once
 * at the scope those values come from (lower/optimize/cte-policy rule 3b), where a node built at every match multiplied
 * the query by the import's reads, at every level of a chain of definitions (analysis/theory/navigate.ts sharedImports),
 * and a lookup bound to an attachment's parent row at every read under it (edullm's sittingItem: one session's start,
 * read by every value row of its record, 147K nodes). An import's key is its every bound value's, so every import has
 * one.
 */
const importedKey = (
	session: CheckSession,
	query: ResolvedQuery,
	values: ReadonlyMap<string, BindValue>
): ImportKey => {
	const parts = [`q${session.place(query)}`]
	let closed = true
	for (const [param, value] of [...values].toSorted(([a], [b]) => compareStrings(a, b))) {
		const part = boundPart(session, value)
		closed = closed && part.closed
		parts.push(`${param}=${part.text}`)
	}
	return { text: parts.join(" "), closed }
}

/**
 * An import's key (`importedKey`): its text, and whether the import is closed, every value it is bound to a parameter,
 * a constant or closed rows, the key the session records on the completed DAG (Checker `root`), or bound to an outer
 * value under region reads, a key of one rule statement's DAG alone.
 */
interface ImportKey {
	readonly text: string
	readonly closed: boolean
}

/**
 * The node at the head of `node`'s chain of attachments: `node` itself unless it is an attachment, which the checker
 * builds over its parent's heading (Checker `#attach`) and which delivers each row of its parent as it stands, its
 * child's rows beside it, so each of its columns holds in every row the value its parent's does, and so, down the
 * chain, the head's. A link that renames, filters or groups is no attachment, and the chain stops there.
 */
const attachmentHead = (node: RelNode): RelNode =>
	node.kind === "Attach" ? attachmentHead(node.parent) : node

interface ParentScope {
	/** The parent's label, which the child's correlation references name. */
	readonly node: NodeId
	/** The node at the head of the parent's chain of attachments (attachmentHead), whose columns the parent's are. */
	readonly head: NodeId
	readonly heading: Heading
	readonly columns: ReadonlyArray<ParentColumn>
}

/**
 * What an imported query's scalar parameter is bound to: one of the importer's own parameters, a typed constant, or an
 * outer value read through a column of the importer's region. A constant carries the bind entry where it was written:
 * it is admitted at the imported parameter's declared type, and a refusal of it names the bind entry.
 */
type ScalarBinding =
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

/** How a scope reads the terms of a bind map written in it: each term, by the parameter it binds, at its location. */
type Binder = (term: ResolvedBound, param: string, loc: SourceLoc) => BindValue

/**
 * What an imported query's parameter is bound to: a scalar binding, one of the importer's own relation parameters
 * among them (`param`, whose cell a use reads as a relation), or the rows of a query (`rows`), which a use of the
 * parameter reads as an import of that query at `values`, its bind map's values read in the scope that wrote it, so the
 * substitution is hygienic: the query's parameters and variables are its writer's, never the import's it stands in.
 */
type BindValue =
	| ScalarBinding
	| {
			readonly kind: "rows"
			readonly query: ResolvedQuery
			readonly values: ReadonlyMap<string, BindValue>
	  }

/**
 * A bound constant at a use of `type`: the use's literal, refused when the bind entry states a type the use's is not
 * compatible with.
 */
/**
 * The keys a Delta of a relation is read by, one array for each relation and each of its readings (`declared`, its
 * declared keys; `none`, under a region read or of a world relation), held by every Delta of it: the schema's own
 * object, by which the logical analysis reads a reading's properties once for every Delta of every query
 * (logical/props.ts leafProps).
 */
const deltaKeysOf = new WeakMap<object, Map<"declared" | "none", ReadonlyArray<DeclaredKey>>>()

/** The keys of `info`'s Delta under `reading`, built by `keys` the first time and read after (deltaKeysOf). */
const deltaKeys = (
	info: object,
	reading: "declared" | "none",
	keys: () => ReadonlyArray<DeclaredKey>
): ReadonlyArray<DeclaredKey> => {
	const byReading =
		deltaKeysOf.get(info) ?? new Map<"declared" | "none", ReadonlyArray<DeclaredKey>>()
	if (byReading.size === 0) {
		deltaKeysOf.set(info, byReading)
	}
	const known = byReading.get(reading)
	const read = known ?? Object.freeze(keys())
	if (known === undefined) {
		byReading.set(reading, read)
	}
	return read
}

const boundConstant = (
	schema: SchemaReading,
	constant: Extract<ScalarBinding, { readonly kind: "literal" }>,
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
	return literalSpec(schema.literal(constant.value, type, constant.loc, patterns, "stored"), type)
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
	| { readonly kind: "region" }
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

/**
 * What a scope's own rows are a set of, which decides whether a merge of them takes one zero for another: a ChangeSet
 * member root's rows are the facts it writes, a set by fact identity, -0 and +0 two facts, which the write forms at its
 * input (write/insert/input.ts inputSet), so neither its head nor its union's arms take the canonical zero and a -0 the
 * caller states is the -0 stored; every other scope's rows are values, a set under PostgreSQL's equality, whose merges
 * deliver the canonical zero (check/merge.ts).
 */
type RowsOf = "facts" | "values"

const rowsOf = (origin: ScopeOrigin): RowsOf =>
	writtenTarget(origin) === undefined ? "values" : "facts"

/**
 * A stage's rows: its node, the order they carry, and the attachment names they carry (`carries`), which a stage
 * after it in the chain reads (a second attachment of a name, a union's arm, a take): an attachment's Attach node's
 * in the query's own scope; under an import, where an attachment builds no node a row is read from (Checker attachIn),
 * the chain's own, never recorded on the node its rows are read from, which another chain may share (one search for
 * one identity, check/approximate).
 */
interface StageOut {
	readonly node: RelNode
	readonly order: StageOrder
	readonly carries: ReadonlySet<string>
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
		case "region":
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
/** A parent variable's slot: its parent column (`outer`), and the head of the parent's chain of attachments. */
type ParentSlot = SlotOf<"parent"> & { readonly outer: Outer; readonly head: NodeId }
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
 * the one it states (X.handle, Type.literal), the declared type of the imported parameter it is bound to, or the
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

/** A relational filter the rule applies after its head: its place in the rule's where and each correlated binding's. */
interface LateFilter {
	readonly index: number
	readonly filter: RelationalFilter
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
type SpanBase = Extract<PlainType, { readonly carrier: SpanCarrier }>
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
	pack: "spanPack",
	span: "spanFromEnds"
} as const satisfies Readonly<Record<ProducerHead["fn"], ProducerKind>>

/**
 * r.span(start, end): two endpoints of one type, the type a span is over (scalar/registry.ts spanType), and the span
 * over it they bound. An instant is no endpoint: it is the database's alone, stamped or read from a stored row, where a
 * span's ends are values (ir/instant.ts instantName).
 */
const spanFromEnds = (
	args: readonly [ResolvedExpr, ResolvedExpr],
	env: LowerEnv<Resolved>,
	at: SourceLoc
): { readonly call: ProducerCallOver<ScalarExpr>; readonly type: ScalarType } => {
	const first = unwrap(lowerTerm(args[0], env))
	const last = unwrap(lowerTerm(args[1], env))
	const spanned = spanType(first.nominal, undefined, childLoc(at, 0))
	if (!spanned.ok || isInstantType(first.nominal)) {
		return fail(
			"MalformedDescription",
			childLoc(at, 0),
			`a span endpoint for span, integer, bigint, date or a contract over one, not ${typeLabel(first.nominal)}`
		)
	}
	if (!compatible(last.nominal, first.nominal)) {
		return fail("MalformedDescription", childLoc(at, 1), "endpoints of one type for span")
	}
	return {
		call: { producer: producerKinds.span, args: [first.expr, last.expr] },
		type: spanned.value
	}
}

const int4TakeCapability = `a positive integer bound for take, at most ${int4Max}`

/**
 * A take bound has one domain, int4's positive range, however it is spelled: a literal, or a parameter an import
 * binds to a literal (the parameter itself is typed int4).
 * A literal take is positive by its description (ir/desc.ts takeDescShape), and a nonpositive bound breaks a rule of the
 * relational DAG too, but an imported query's take bound by `bind` to a literal reaches here first: this refuses it at
 * the query that binds it, in int4's terms.
 */
const int4TakeBound = (k: bigint, loc: SourceLoc): TakeBound => {
	if (k < 1n || k > BigInt(int4Max)) {
		fail("MalformedDescription", loc, int4TakeCapability)
	}
	return { kind: "literal", k }
}

/**
 * The checker: a ResolvedQuery to a LogicalQuery DAG.
 *
 * It resolves every name a query description uses against the schema, types every expression through the scalar
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
 *   parent variable of a parent with columns is AttachedParentUnbound, a cross product; under a parent of no columns,
 *   which holds at most one row, it is its own result (query(S).reads); a page over a query correlated to a parent is
 *   AttachedPage.
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
 *   Checked against a role, a query reads only the contexts the role declares, as it declares them: a Db of the role
 *   holds facts of those alone, and any other is outside the role (OutsideRole context).
 *
 * Recursive and approximate stages are plug-ins (context.ts). A query reads only what its schema declares: checked
 * against a role, only the role's relations.
 */
/** A union node's arms and discriminant, as the checker records them (Checker `#unions`). */
interface UnionArms {
	readonly arms: NonEmptyReadonlyArray<RelNode>
	readonly discriminant: ReadonlyArray<string>
}

/** A use of one of the query's own parameters, as its cell records it (check/params.ts ParamCell `use`, `relationUse`). */
type ParamUse =
	| {
			readonly kind: "scalar"
			readonly name: string
			readonly type: ScalarType
			readonly loc: SourceLoc
	  }
	| {
			readonly kind: "relation"
			readonly name: string
			readonly heading: Heading
			readonly loc: SourceLoc
	  }
	| { readonly kind: "bound"; readonly name: string; readonly loc: SourceLoc }

/**
 * A closed import checked once for its compile (check/session.ts closedImports, Checker `#closedImport`): its root, its
 * own stated orders and merges completed over its own DAG (complete.ts), nothing outside it being in its scope, and
 * what its check recorded beside its nodes, which every check that reads it adopts as its own check of it would have
 * recorded it (`#adopt`): the literal head columns, union arms, delivered headings and carried attachments of its own
 * nodes (`#ownNodes`; a closed import it reads is recorded in its own record, which its readers adopt with it), the
 * closed imports it read by their keys, its declarations (DuplicateIdentity), its searches, and its uses of
 * the reader's own parameters, which every reader at its key binds by name alike, so the reader's parameters are
 * typed by them (check/params.ts).
 */
export interface ClosedImport {
	readonly node: RelNode
	readonly literals: ReadonlyArray<readonly [RelNode, Map<string, HeadLiteral>]>
	readonly unions: ReadonlyArray<readonly [RelNode, UnionArms]>
	readonly delivered: ReadonlyArray<readonly [RelNode, Heading]>
	readonly attached: ReadonlyArray<readonly [RelNode, ReadonlySet<string>]>
	readonly imports: ReadonlyArray<readonly [string, RelNode]>
	readonly declared: ReadonlyArray<Declared>
	readonly searches: ReadonlyArray<readonly [string, RelNode]>
	readonly uses: ReadonlyArray<ParamUse>
}

/** What a check recorded beside a closed import's own nodes (Checker `#nodeFacts`), each fact under its node. */
interface NodeFacts {
	readonly literals: Array<readonly [RelNode, Map<string, HeadLiteral>]>
	readonly unions: Array<readonly [RelNode, UnionArms]>
	readonly delivered: Array<readonly [RelNode, Heading]>
	readonly attached: Array<readonly [RelNode, ReadonlySet<string>]>
}

/**
 * A closed import's check (Checker `#checkedImport`), and whether the compile's other checks may read it: not where it
 * holds a node of its reader's own, a search the reader built before it (Checker `#searches`) or an import no other
 * check may read, which another reader would hold none of.
 */
interface CheckedImport {
	readonly imported: ClosedImport
	readonly shared: boolean
}

export class Checker {
	readonly schema: SchemaReading
	readonly options: CheckOptions
	readonly b: DagBuilder
	/**
	 * The literal head columns of every arm node, for typing a bare one by its position in a union, for discriminants
	 * and for narrowing a matched union.
	 */
	readonly #literals = new Map<RelNode, Map<string, HeadLiteral>>()
	/** The arms of every union node, for flattening a further rule and for narrowing a matched union. */
	readonly #unions = new Map<RelNode, UnionArms>()
	/**
	 * The heading each union arm a widening projection rewrote delivered before it was widened (#widenArm): its columns'
	 * own types, which bound the values the arm delivers, for selecting a matched union's arms (RuleCheck #delivers).
	 */
	readonly #delivered = new Map<RelNode, Heading>()
	/**
	 * The attachment names each node's rows carry, never empty: an Attach's and its parent's, those of the rows a node
	 * keeps (#inherit), those of every arm of a union, and under an import a rule's own node's, its attachments'
	 * (RuleCheck run). Each is a node this check built where it records it: a stage chain's attachments under an
	 * import travel with the chain (StageOut carries), never on the node its rows are read from. A node it holds none
	 * for carries none (`carried`).
	 */
	readonly #attached = new Map<RelNode, ReadonlySet<string>>()
	/** The contracts and contexts the query declares itself, each once (DuplicateIdentity). */
	readonly #declarations = new DeclarationTable()
	/**
	 * The query's closed imports, each built once by its key (`importedKey`): every import of one query whose bind map
	 * binds each of its parameters to a parameter or a constant reads the same rows wherever it stands, so it is one node,
	 * every reader of it a reader of that node, where a node built at every import expanded the Description's sharing
	 * into a tree (a bound query read at many places, a call's rows argument at every read of the call's fields).
	 */
	readonly #imported = new Map<string, RelNode>()
	/** The imports bound to outer values, each built once by its key (`importedKey`), correlated to the values' node. */
	readonly #regional = new Map<string, RelNode>()
	/**
	 * Each import's node by its key (`#imported`, `#regional`), which a call over it reads its argument's key by
	 * (`#callArgs`): a closed import's closed, a correlated one's correlated to the node its values are read from.
	 */
	readonly #importKeys = new Map<RelNode, ImportKey>()
	/**
	 * The admitted patterns the query's compile reads (scalar/regex/patterns.ts), its session's (session.ts
	 * CheckSession patterns): each parsed, and minimized where a proof compares it, once for every check of the compile.
	 */
	readonly patterns: CompilePatterns
	/**
	 * The order the user stated for each Take, OrderedResult and ordered Attach, completed once the DAG is built
	 * (order.ts).
	 */
	#stated = new Map<RelNode, StatedOrder>()
	/** Each projection whose floats a merge may take one of two zeros of, with its rule (check/merge.ts). */
	#merges = new Map<RelNode, StatedMerge>()
	/** The labels reserved and not yet defined: the regions of the rules being checked, the recursions being checked. */
	readonly #reserved = new Set<NodeId>()
	/** The approximate searches built, by the identity of their sealed source, score and bound (approximate/). */
	readonly #searches = new Map<string, RelNode>()
	/** The query's own parameters (check/params.ts resolveQuery), on whose cells an adopted import's uses are made again. */
	readonly #params: ParamTable
	/** The key of this check's closed imports among the compile's (`#closedImport`): its reading and its clock. */
	readonly #reading: string
	/**
	 * The uses of the query's own parameters each closed import this check is checking made (`#checkedImport`), innermost
	 * last: each journal takes every use made while it is open (`useParam`), an adopted import's among them.
	 */
	readonly #uses: Array<Array<ParamUse>> = []
	/** The searches each closed import being checked holds, innermost last, an adopted import's among them. */
	readonly #searchJournals: Array<Map<string, RelNode>> = []
	/** The roots of the closed imports this check built that no other check may read (CheckedImport `shared`). */
	readonly #private = new Set<RelNode>()
	/** The root of each closed import this check read (`#imported`), which every completion keeps as it is. */
	readonly #importRoots = new Set<RelNode>()
	/** The closed imports each closed import being checked read, by key, innermost last (`#readImport`). */
	readonly #importJournals: Array<Array<readonly [string, RelNode]>> = []

	constructor(schema: SchemaReading, options: CheckOptions, params: ParamTable) {
		this.schema = schema
		this.options = options
		this.patterns = options.session.patterns
		this.b = new DagBuilder(options.session.ids)
		this.#params = params
		this.#reading = `${options.read} ${canonicalTextOf(options.clock)}`
	}

	/** Records a use of `cell` as a scalar of `type` (ParamCell `use`), journaled where it is one of the query's own. */
	useParam(cell: ParamCell, type: ScalarType, loc: SourceLoc): ParamId {
		const id = cell.use(type, loc)
		if (this.#params.owns(cell)) {
			for (const journal of this.#uses) {
				journal.push({ kind: "scalar", name: cell.name, type, loc })
			}
		}
		return id
	}

	/** Records a use of `cell` as a relation of `heading` (ParamCell `relationUse`), journaled as `useParam` journals. */
	useRelationParam(cell: ParamCell, heading: Heading, loc: SourceLoc): ParamId {
		const id = cell.relationUse(heading, loc)
		if (this.#params.owns(cell)) {
			for (const journal of this.#uses) {
				journal.push({ kind: "relation", name: cell.name, heading, loc })
			}
		}
		return id
	}

	/**
	 * Records a use of `cell` as a relation parameter its ChangeSet binds to a query (ParamCell `boundUse`), journaled as
	 * `useParam` journals.
	 */
	useBoundParam(cell: ParamCell, loc: SourceLoc): ParamId {
		const id = cell.boundUse(loc)
		if (this.#params.owns(cell)) {
			for (const journal of this.#uses) {
				journal.push({ kind: "bound", name: cell.name, loc })
			}
		}
		return id
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

	/** The canonical zero of a float term (scalar/compute/registry.ts canonicalZeroSpec), of its type. */
	canonicalZero(expr: ScalarExpr): ScalarExpr {
		const spec = canonicalZeroSpec(expr)
		if (spec === undefined) {
			throw defect(`a canonical zero of ${typeLabel(expr.type)}`)
		}
		return this.emit(spec)
	}

	/**
	 * Records a projection whose floats a merge may take one of two zeros of, under `rule`, which the completion settles
	 * (check/merge.ts): a projection that delivers no float merges none, and is not recorded.
	 */
	stateMerge(projection: RelNode, rule: MergeRule, at: SourceLoc): void {
		if (projection.kind === "ProjectSet" && deliversFloat(projection)) {
			this.#merges.set(projection, { projection, rule, at })
		}
	}

	/**
	 * `node` as a node whose rows a union or a recursion may merge with another's: every float it delivers the canonical
	 * zero (check/merge.ts). The projection that delivers its rows, when a merge records it (stateMerge), takes the
	 * canonical zero of every float, its rule made `always`; otherwise a projection over it delivers each float's.
	 */
	canonicalArm(node: RelNode, loc: SourceLoc): RelNode {
		if (this.#mergesAlways(node)) {
			return node
		}
		const out = node.heading.map((c) => {
			const column = this.emit(storedColumn(node.id, c.name, c.type))
			return { name: c.name, expr: isFloat(c.type) ? this.canonicalZero(column) : column }
		})
		const arm = this.node({ kind: "ProjectSet", input: node, out, heading: node.heading }, loc)
		this.#delivered.set(arm, this.deliveredOf(node))
		const literals = this.#literals.get(node)
		if (literals !== undefined) {
			this.#literals.set(arm, literals)
		}
		return arm
	}

	/**
	 * Whether every float `node` delivers is the canonical zero once each projection a merge records that delivers its
	 * rows is made `always`, which this makes it: a node of no float column, a recorded projection, or a node that passes
	 * on the rows of inputs that all are, unchanged (a filter, a take, an ordered result, a step, a semi- or anti-join's
	 * left side, a union's arms, and a projection that widens them, whose casts keep a zero's sign).
	 */
	#mergesAlways(node: RelNode): boolean {
		const merge = this.#merges.get(node)
		if (merge !== undefined) {
			this.#merges.set(node, { ...merge, rule: { kind: "always" } })
			return true
		}
		if (!node.heading.some((c) => isFloat(c.type))) {
			return true
		}
		switch (node.kind) {
			case "Filter":
			case "Take":
			case "ProjectSet":
			case "OrderedResult":
			case "Step":
				return this.#mergesAlways(node.input)
			case "SemiJoin":
			case "AntiJoin":
			case "Difference":
				return this.#mergesAlways(node.left)
			case "Intersect":
				return [this.#mergesAlways(node.left), this.#mergesAlways(node.right)].every(Boolean)
			case "Union":
				return unionArms(node.groups)
					.map((arm) => this.#mergesAlways(arm))
					.every(Boolean)
			case "Base":
			case "Closed":
			case "Context":
			case "InputSet":
			case "Delta":
			case "MatchRegion":
			case "Group":
			case "Produce":
			case "Recursive":
			case "SelfRef":
			case "ApproximateNearest":
			case "Attach":
			case "Forbid":
			case "Window":
			case "OrderedSetAggregate":
			case "Call":
				return false
		}
	}

	fieldType(desc: FieldDesc, loc: SourceLoc): ScalarType {
		return this.schema.queryFieldType(desc, loc, this.#declarations, this.patterns)
	}

	/**
	 * A scalar parameter's declared type (scalar/compute/typing.ts Typing.param). A channel (ir/desc.ts Channel) declares none: its
	 * import binds it to a column, which every use of it reads, and a channel bound to anything else is refused here.
	 */
	paramType(param: ParamExpr, loc: SourceLoc): ScalarType {
		if (param.type.kind === "channel") {
			return fail(
				"MalformedDescription",
				loc,
				`parameter ${param.cell.name} bound to a column: a channel is read as the column its import binds it to`
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
			fieldType: (desc, loc) => this.fieldType(desc, loc),
			canonicalArm: (node, loc) => this.canonicalArm(node, loc)
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
	 * role delivers them in one (rootOrder). Its parameters are the table's once the pass is final (check/index.ts). Its
	 * completion keeps every closed import's root as it is (`#importRoots`), so each stands in the DAG as this check read
	 * it, under the key the session holds for it (`#readImport`, CheckSession `closed`).
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
		const completed: LogicalQuery["dag"] = unwrap(
			completeStated(
				this.b.build([root]),
				this.b,
				this.#stated,
				this.#merges,
				this.#importRoots,
				this.options.session.analyses
			)
		)
		return completed
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
			case "rules": {
				const node = this.arms(s.arms, scope, childLoc(here, "arms"))
				return { node, order: unordered, carries: this.carried(node) }
			}
			case "recursive": {
				const node = recursion.check(s, scope, here, this.services())
				return { node, order: unordered, carries: this.carried(node) }
			}
			case "union": {
				const input = this.stage(s.input, scope)
				const prior = this.#unions.get(input.node)?.arms
				const added = s.arms.map((arm) => this.rule(arm, scope))
				/** The input's rows are an arm of their own, with the names their chain attached, where no union is below. */
				const node = this.union(
					[...(prior ?? [input.node]), ...added],
					here,
					rowsOf(scope.origin),
					(arm) => (prior === undefined && arm === input.node ? input.carries : this.carried(arm))
				)
				return { node, order: unordered, carries: this.carried(node) }
			}
			case "attach": {
				const input = this.stage(s.input, scope)
				const attached = this.attachIn(input.node, input.carries, s.attach, scope, here)
				return { ...attached, order: keptOrder(input.order) }
			}
			case "named": {
				const input = this.stage(s.input, scope)
				return { ...input, order: keptOrder(input.order) }
			}
			case "order": {
				const input = this.stage(s.input, scope)
				return {
					...input,
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
					order: { kind: "delivered", stated },
					carries: input.carries
				}
			}
			case "approx": {
				const input = this.stage(s.input, scope)
				return {
					node: approximate.check(s, input.node, here, this.services()),
					order: unordered,
					carries: carriesNone
				}
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
						expr: this.emit(storedColumn(origin.parent.node, c.parent, c.type))
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
				return { kind: "param", param: this.useParam(resolved.cell, int4, loc) }
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
		return only(nodes) ?? this.union(nodes, loc, rowsOf(scope.origin), (arm) => this.carried(arm))
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
	carried(node: RelNode): ReadonlySet<string> {
		return this.#attached.get(node) ?? carriesNone
	}

	/**
	 * Records the attachment names the rows of `node`, a node this check built, carry, none recorded for none
	 * (#attached): an Attach's, a union's, and a rule's own node's, its attachments' (RuleCheck run), which under an
	 * import, where an attachment builds no node a row is read from (attachIn), is the rule's node.
	 */
	carry(node: RelNode, carries: ReadonlySet<string>): void {
		if (carries.size > 0) {
			this.#attached.set(node, carries)
		}
	}

	/**
	 * A union fact can come from several arms of one heading, so which arm's attachment it would carry is undetermined:
	 * an arm whose rows carry an attachment (its `carried`: a rule's node's, a stage's StageOut carries), through
	 * whatever stage keeps its rows, shares its heading with no other arm. The union's rows carry every arm's
	 * attachments.
	 *
	 * A union of several headings delivers each heading group only as a query's result (ir/dag.ts deliverySpine): a
	 * take, an attachment or any stage over it has the columns its groups share for its heading, so as an arm it would
	 * deliver those alone, and is refused.
	 */
	union(
		arms: NonEmptyReadonlyArray<RelNode>,
		loc: SourceLoc,
		setOf: RowsOf,
		carried: (arm: RelNode) => ReadonlySet<string>
	): RelNode {
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
			if (g.arms.length > 1 && g.arms.some((a) => carried(a).size > 0)) {
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
				const w = this.#widenArm(a, carried(a), g.target, loc)
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
						(theirs, oi) => oi < gi && mine.some((t) => theirs.some((u) => canonicalEquals(t, u)))
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
		/**
		 * The arms of one heading group meet, and a union of values may take a row of one for an equal row of another, so
		 * each delivers its floats' canonical zeros (canonicalArm); a member root's arms are its facts, which its write
		 * forms into one set by their identity, and keep theirs (RowsOf). Arms of two groups are told apart by their
		 * discriminant and never meet.
		 */
		const mergedGroups = mapNonEmpty(widenedGroups, (g) => ({
			arms:
				g.arms.length > 1 && setOf === "values"
					? mapNonEmpty(g.arms, (a) => this.canonicalArm(a, loc))
					: g.arms
		}))
		const groupHeadings = mapNonEmpty(mergedGroups, (g) => ({
			heading: g.arms[0].heading,
			arms: g.arms
		}))
		const firstGroup = groupHeadings[0]
		const heading: Heading =
			widenedGroups.length === 1
				? firstGroup.heading
				: firstGroup.heading.filter((c) => common.includes(c.name))
		const node = this.node({ kind: "Union", groups: groupHeadings, discriminant, heading }, loc)
		const [firstWidened, ...moreWidened] = mergedGroups
		const flat: NonEmptyReadonlyArray<RelNode> = [
			...firstWidened.arms,
			...moreWidened.flatMap((g) => g.arms)
		]
		this.#unions.set(node, { arms: flat, discriminant })
		this.carry(node, new Set(arms.flatMap((a) => [...carried(a)])))
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
				termTypes.getOrInsertComputed(column.name, () => []).push(column.type)
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
			this.schema.admits(d.bare.value, agreed, this.patterns, "stored")
				? agreed
				: d.column.type
		)
	}

	/**
	 * An arm whose columns take a wider type than it delivers, rewritten by a projection that casts them; its literal
	 * columns stay literals, retyped, so it keeps its discriminant. A projection keeps no attachment of the rows it
	 * reads, so an arm whose rows carry one (`carried`) is refused.
	 */
	#widenArm(
		arm: RelNode,
		carried: ReadonlySet<string>,
		target: ReadonlyMap<string, ScalarType>,
		loc: SourceLoc
	): RelNode {
		const heading = arm.heading
		const changes = heading.filter((c) => {
			const t = target.get(c.name)
			return t !== undefined && !sameScalarType(t, c.type)
		})
		const [changed] = changes
		if (changed === undefined) {
			return arm
		}
		if (carried.size > 0) {
			fail(
				"UnsupportedOperation",
				loc,
				`union arm with an attachment whose column ${changed.name} differs in refinement or typmod from the other arms'; cast it to one type with Type.cast`
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
						: {
								...head,
								literal: this.schema.literal(head.value, t, head.loc, this.patterns, "stored")
							}
				kept.set(c.name, retyped)
				return { name: c.name, expr: this.emit(literalSpec(retyped.literal, t)), type: t }
			}
			const col = this.emit(storedColumn(arm.id, c.name, c.type))
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
		carried: ReadonlySet<string>,
		desc: ResolvedAttach,
		scope: Scope,
		loc: SourceLoc
	): RelNode {
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
		/**
		 * A child that reads none of a parent's columns is the same child under every parent row, a cross product of the
		 * two, which is refused; under a parent of no columns, which holds at most one row, there is no column to read
		 * and no product: the child is its own result, beside the parent's one row, as query(S).reads builds a record of
		 * reads (query/build/query.ts readsOf).
		 */
		const crossProduct = use.columns.size === 0 && isNonEmpty(heading)
		if (crossProduct) {
			fail(
				"AttachedParentUnbound",
				loc,
				`a child that binds a parent variable: attachment ${desc.name} reads none of ${heading.map((c) => c.name).join(", ")}`
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
			origin: {
				kind: "attachChild",
				parent: { node: parent.id, head: attachmentHead(parent).id, heading, columns }
			},
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
		this.carry(node, new Set([...carried, desc.name]))
		return node
	}

	/**
	 * An attachment as a stage or a rule of `scope` declares it over `parent`, whose rows carry the attachment names
	 * `carried`, with the names its rows carry then (`carries`), the attachment's among them. Under an import
	 * (`scope.params.kind === "bound"`), an attachment is no row the importer reads: it is checked as any attachment
	 * (its refusals, its parameter uses, so the import's complete-bind check sees the child's parameters), and the parent
	 * is returned, its chain carrying the attachment's name (StageOut carries, RuleCheck run), so a second attachment of
	 * that name is still refused, and nothing is recorded on the parent, which another chain may share (one search for
	 * one identity), so no other chain's attachment is ever this one's. No root reaches the Attach node it built, so no
	 * statement delivers it and no Attach the importer reaches lies off its delivery spine (ir/dag.ts deliverySpine);
	 * order.ts completes its stated order like any other, and nothing reads it.
	 */
	attachIn(
		parent: RelNode,
		carried: ReadonlySet<string>,
		desc: ResolvedAttach,
		scope: Scope,
		loc: SourceLoc
	): { readonly node: RelNode; readonly carries: ReadonlySet<string> } {
		const node = this.#attach(parent, carried, desc, scope, loc)
		const carries = new Set([...carried, desc.name])
		return { node: scope.params.kind === "own" ? node : parent, carries }
	}

	/**
	 * What a parameter reference reads in `scope`: in the query's own scope its own cell, under an import what the
	 * import's bind map binds the parameter to, by the name the bind map spells it by.
	 */
	#bound(cell: ParamCell, scope: Scope, loc: SourceLoc): BindValue {
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

	/** What a scalar parameter's reference reads in `scope` (#bound): never rows, which only a relation parameter takes. */
	#resolveParam(cell: ParamCell, scope: Scope, loc: SourceLoc): ScalarBinding {
		const bound = this.#bound(cell, scope, loc)
		return bound.kind === "rows"
			? fail(
					"MalformedDescription",
					loc,
					`a term for parameter ${cell.name}, which is used as a scalar; the import binds it to the rows of a query`
				)
			: bound
	}

	rule(rule: ResolvedRule, scope: Scope): RelNode {
		return new RuleCheck(this, rule, scope, rule.loc).run()
	}

	source(
		src: ResolvedSource,
		scope: Scope,
		interiors: ReadonlyArray<ResolvedInterior>,
		loc: SourceLoc,
		bind: Binder
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
						generated: info.generated,
						heading: headingColumns(info.heading)
					},
					loc
				)
			}
			case "query":
				return this.#importSource(src, loc, bind)
			case "step": {
				const input = this.#importSource(src, loc, bind)
				return this.node({ kind: "Step", input, heading: input.heading }, loc)
			}
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
				if (this.options.read !== "readBack" && this.options.read !== "region") {
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
				 * any world relation's delta is typed by its checked heading in canonical order (compareStrings), the order
				 * the write front end delivers it in: empty, its target's projected onto its head, or refused there.
				 */
				const info = this.schema.relation(src.relation, loc)
				if (info.kind === "world" || info.kind === "derived") {
					const heading = info.analysis.read.heading.toSorted(byName)
					return this.node(
						{
							kind: "Delta",
							relation: info.name,
							side: src.side,
							keys: deltaKeys(info, "none", () => []),
							heading
						},
						loc
					)
				}
				if (info.kind !== "relation") {
					return fail(
						"MalformedDescription",
						loc,
						`a delta of an ordinary, stored derived or world relation; ${info.name} is ${info.kind}, which nothing writes`
					)
				}
				return this.node(
					{
						kind: "Delta",
						relation: info.name,
						side: src.side,
						keys:
							this.options.read === "region"
								? deltaKeys(info, "none", () => [])
								: deltaKeys(info, "declared", () => [info.primaryKey, ...info.keys]),
						heading: headingColumns(info.heading)
					},
					loc
				)
			}
			case "context":
				return this.#contextSource(src, loc)
			case "call":
				return this.#callSource(src, loc, bind)
			case "callField":
				return this.#callFieldSource(src, loc, bind)
			case "split":
				return this.#splitSource(src, loc, bind)
			case "series":
				return fail(
					"UnsupportedOperation",
					loc,
					"r.series as a relational filter's source: a series is a match of its rule, its element between its ends; compare a value with the ends instead"
				)
		}
	}

	/**
	 * A series (r.series), a call of grizzle's series (CallFunction `series`): each integer from its low end to its high
	 * end, both included, none where the low end lies above the high end. Each end is a term of the scope the match
	 * stands in, lowered there (`lower`) and of an integer type; the element `at` is an exact integer of the wider end's
	 * digits, as integer arithmetic computes one, and lies between the least value the low end takes and the greatest
	 * the high end takes (seriesBounds), which the rule
	 * holds of every variable bound to it (typing.ts HeldLeaf): a fact of every row the series delivers, wherever a
	 * term reads it, so no filter is a premise of it.
	 */
	series(
		src: Extract<ResolvedSource, { readonly kind: "series" }>,
		loc: SourceLoc,
		lower: (e: ResolvedExpr, at: SourceLoc) => Lowered
	): { readonly node: RelNode; readonly element: Bounds } {
		const end = (e: ResolvedExpr, name: string): Lowered => {
			const at = childLoc(loc, name)
			const term = lower(e, at)
			if (!seriesCarriers.has(baseOf(term.nominal).carrier)) {
				return fail(
					"MalformedDescription",
					at,
					`an integer for r.series' ${name} end, an integer, bigint or exact integer term; it is ${typeLabel(term.nominal)}`
				)
			}
			return term
		}
		const low = end(src.low, seriesArguments.low)
		const high = end(src.high, seriesArguments.high)
		const type = exactType(
			"exactInteger",
			Math.max(
				defined(familyDigits(low.nominal), "an integer's digits"),
				defined(familyDigits(high.nominal), "an integer's digits")
			)
		)
		const node = this.node(
			{
				kind: "Call",
				function: { kind: "series" },
				args: [
					{ kind: "value", name: seriesArguments.low, expr: low.expr, type },
					{ kind: "value", name: seriesArguments.high, expr: high.expr, type }
				],
				heading: [{ name: seriesHeading.at, type }]
			},
			loc
		)
		return {
			node,
			element: seriesBounds(
				defined(low.bounds, "an integer term's bounds"),
				defined(high.bounds, "an integer term's bounds")
			)
		}
	}

	/**
	 * A call of a declared function that returns rows (Fn.rows): the function its level declares, its arguments
	 * (#callArgs). The call's heading is its result's, each field at its declared type, which the lowering casts the
	 * function's value to. A volatile function's every call is an evaluation of its own, never one node for several; an
	 * immutable or stable one's closed calls at one argument tuple are one node (#closedCall).
	 */
	#callSource(
		src: Extract<ResolvedSource, { readonly kind: "call" }>,
		loc: SourceLoc,
		bind: Binder
	): RelNode {
		const fn = this.#declaredFunction(src.function, loc)
		const returns = fn.desc.returns
		if (returns.kind !== "rows") {
			return fail(
				"MalformedDescription",
				loc,
				`a declared function that returns rows as a source; ${fn.name} returns ${functionTypeLabel(returns)}`
			)
		}
		const returned = valueHeading(returns.heading)
		if (returned === undefined) {
			return fail(
				"MalformedDescription",
				loc,
				`a declared function whose rows a query reads, of values alone; a field of ${fn.name}'s rows holds rows or a row, which another function's body reads`
			)
		}
		const called = this.#callArgs(fn, src.args, loc, bind)
		const build = (args: ReadonlyArray<CallArg<LiveRefs>>): RelNode =>
			this.node(
				{
					kind: "Call",
					function: {
						kind: "declared",
						name: fn.name,
						volatility: fn.desc.volatility,
						definition: fn.definition
					},
					args,
					heading: this.#calledHeading(returned, loc)
				},
				loc
			)
		return fn.desc.volatility === "volatile"
			? build(called.args)
			: this.#closedCall(`rows ${fn.name}`, called, build)
	}

	/**
	 * A read of a field of a call of a declared function that returns one row (Fn.row): the function its level
	 * declares, immutable or stable, so every read of a field of one call at one argument tuple reads one evaluation of
	 * it; the field, one of its row's that holds rows of a heading of values; its arguments (#callArgs). The read's
	 * heading is the field's heading, each field at its declared type, which the lowering casts the function's value to.
	 */
	#callFieldSource(
		src: Extract<ResolvedSource, { readonly kind: "callField" }>,
		loc: SourceLoc,
		bind: Binder
	): RelNode {
		const fn = this.#declaredFunction(src.function, loc)
		const returns = fn.desc.returns
		if (returns.kind !== "row") {
			return fail(
				"MalformedDescription",
				loc,
				`a declared function that returns one row, whose fields a query reads; ${fn.name} returns ${functionTypeLabel(returns)}`
			)
		}
		if (fn.desc.volatility === "volatile") {
			return fail(
				"MalformedDescription",
				loc,
				`an immutable or stable function, whose one evaluation at its arguments every read of its row's fields shares; ${fn.name} is volatile`
			)
		}
		const field = returns.heading.find((f) => f.name === src.field)
		const read = field?.type.kind === "rows" ? valueHeading(field.type.heading) : undefined
		if (read === undefined) {
			return fail(
				"MalformedDescription",
				childLoc(loc, "field"),
				`a field of ${fn.name}'s row that holds rows of values alone; ${field === undefined ? `its row has no field ${src.field}` : `${src.field} holds ${functionTypeLabel(field.type)}, which another function's body reads`}`
			)
		}
		return this.#closedCall(
			`field ${fn.name}.${src.field}`,
			this.#callArgs(fn, src.args, loc, bind),
			(args) =>
				this.node(
					{
						kind: "Call",
						function: {
							kind: "field",
							field: src.field,
							row: mapNonEmpty(returns.heading, (f) => f.name),
							name: fn.name,
							volatility: fn.desc.volatility,
							definition: fn.definition
						},
						args,
						heading: this.#calledHeading(read, loc)
					},
					loc
				)
		)
	}

	/** The heading of rows a call delivers: each of the heading's fields at its declared type. */
	#calledHeading(heading: ReadonlyArray<NamedDesc<FieldDesc>>, loc: SourceLoc): Heading {
		return heading.map((f) => ({
			name: f.name,
			type: this.fieldType(f.type, childLoc(loc, f.name))
		}))
	}

	/**
	 * A call's arguments, in its function's parameters' order (ir/rel.ts CallArg), each by its declared name and none
	 * other (#callArguments). A value argument is bound as an import's parameter is (`bind`): a variable of the region the
	 * call is matched in, a parent variable, a parameter or a typed constant, of a type that meets the argument's
	 * declared type. A rows argument is a query imported under its bind map (#importSource), whose heading holds each
	 * field of the argument's heading at a type that meets the field's.
	 */
	#callArgs(
		fn: OwnedFunction,
		given: Extract<ResolvedSource, { readonly kind: "call" }>["args"],
		loc: SourceLoc,
		bind: Binder
	): { readonly args: ReadonlyArray<CallArg<LiveRefs>>; readonly key: ImportKey | undefined } {
		this.#callArguments(fn, Object.keys(given), loc)
		/** Each argument's part of the call's key (`#closedCall`), none for rows no import of this check delivers. */
		const parts: Array<ImportKey | undefined> = []
		const args = fn.desc.args.map((declared): CallArg<LiveRefs> => {
			const at = childLoc(childLoc(loc, "args"), declared.name)
			const arg = defined(given[declared.name], "an argument #callArguments found")
			if (declared.type.kind === "value") {
				if (arg.kind === "rows") {
					return fail("MalformedDescription", at, `a value for argument ${declared.name}, not rows`)
				}
				const type = this.fieldType(declared.type.type, at)
				const value = bind(arg, declared.name, at)
				const part = boundPart(this.options.session, value)
				parts.push({ text: `${declared.name}=${part.text}`, closed: part.closed })
				return {
					kind: "value",
					name: declared.name,
					expr: this.#boundArgument(value, type, declared.name, at),
					type
				}
			}
			if (arg.kind !== "rows") {
				return fail("MalformedDescription", at, `rows for argument ${declared.name}, not a value`)
			}
			const heading =
				declared.type.kind === "rows" ? valueHeading(declared.type.heading) : undefined
			if (heading === undefined) {
				return fail(
					"MalformedDescription",
					at,
					`an argument a query passes, a value or rows of values alone; ${fn.name} takes ${functionTypeLabel(declared.type)} at ${declared.name}, of a heading a query builds no rows of, which another function's body passes`
				)
			}
			const rows = this.#importSource(arg, at, bind)
			const imported = this.#importKeys.get(rows)
			parts.push(
				imported === undefined
					? undefined
					: { text: `${declared.name}=r(${imported.text})`, closed: imported.closed }
			)
			const columns = mapNonEmpty(heading, (f) => {
				const type = this.fieldType(f.type, childLoc(at, f.name))
				const delivered = columnOf(rows.heading, f.name)
				if (delivered === undefined || !compatible(delivered.type, type)) {
					fail(
						"MalformedDescription",
						childLoc(at, f.name),
						`a query delivering ${f.name} of ${typeLabel(type)} for argument ${declared.name}; it ${delivered === undefined ? "delivers no such column" : `delivers ${typeLabel(delivered.type)}`}`
					)
				}
				return { name: f.name, type }
			})
			return { kind: "rows", name: declared.name, rows, columns }
		})
		const keyed = parts.flatMap((p) => (p === undefined ? [] : [p]))
		return {
			args,
			key:
				keyed.length === parts.length
					? { text: keyed.map((p) => p.text).join(" "), closed: keyed.every((p) => p.closed) }
					: undefined
		}
	}

	/**
	 * A call of a declared function as one node of the query (`#imported`, `#regional`): `build` builds it at `args`,
	 * once for every read of one function at arguments of one key, a read of one field of it or of its rows: at closed
	 * arguments as a closed import is (`#closedImport`), at outer values as a correlated import is, once in this check
	 * (`#correlatedImport`); at once where a rows argument is no import's.
	 */
	#closedCall(
		read: string,
		called: {
			readonly args: ReadonlyArray<CallArg<LiveRefs>>
			readonly key: ImportKey | undefined
		},
		build: (args: ReadonlyArray<CallArg<LiveRefs>>) => RelNode
	): RelNode {
		if (called.key === undefined) {
			return build(called.args)
		}
		const key = { text: `${read} ${called.key.text}`, closed: called.key.closed }
		return key.closed
			? this.#closedImport(key.text, () => build(called.args))
			: this.#correlatedImport(key, () => build(called.args))
	}

	/**
	 * A split of a text (ir/rel.ts TextSplit), a call of one of grizzle's splits (CallFunction `split`). Its one
	 * argument is bound as a call's value argument is (`bind`), a text: a variable at its own type, a parameter or a
	 * constant at any text's. Its heading is its split's (#splitHeading).
	 */
	#splitSource(
		src: Extract<ResolvedSource, { readonly kind: "split" }>,
		loc: SourceLoc,
		bind: Binder
	): RelNode {
		const at = childLoc(loc, splitArgument)
		const value = bind(src.text, splitArgument, at)
		const type = value.kind === "column" ? value.type : wildcardText
		const text = textOf(type)
		if (text === undefined) {
			return fail(
				"MalformedDescription",
				at,
				`a text for r.${src.split}; the variable bound to it is ${typeLabel(type)}`
			)
		}
		return this.node(
			{
				kind: "Call",
				function: { kind: "split", split: src.split },
				args: [
					{
						kind: "value",
						name: splitArgument,
						expr: this.#boundArgument(value, type, splitArgument, at),
						type
					}
				],
				heading: this.#splitHeading(src.split, text, loc)
			},
			loc
		)
	}

	/**
	 * A split's heading over a text of refinement `text`: a token split's (`tokensHeading`), `at`, a token's place, the
	 * count of the tokens before it, of a count's type, natural, and `token`, a run of the text's characters but XML
	 * whitespace within the text's byte bound, the one its refinement proves (#tokenType).
	 */
	#splitHeading(split: TextSplit, text: TextInfo, loc: SourceLoc): Heading {
		const headings: { readonly [K in TextSplit]: () => Heading } = {
			tokens: () => [
				{ name: tokensHeading.at, type: countOverload().result },
				{ name: tokensHeading.token, type: this.#tokenType(text, loc) }
			]
		}
		return headings[split]()
	}

	/**
	 * A token's type over a text of refinement `text`: a run of the characters its language holds but XML whitespace
	 * (scalar/regex/whitespace.ts tokenSource), within the text's byte bound where its refinement proves one, since a
	 * token is a stretch of it, typed as str.bytes declares it, so a token is a text of a bound wherever its text is,
	 * inside every pattern that holds a run of those characters, and a query's Text.matches reads it there.
	 */
	#tokenType(text: TextInfo, loc: SourceLoc): ScalarType {
		const source = tokenSource(textPatterns(text), this.patterns)
		const pattern = unwrap(textLookup([source]))
		const bytes = textInfoBounds(text)?.bytes
		const language = bytes === undefined ? pattern : languageWithin(pattern, bytes)
		return this.schema.queryFieldType(
			{ kind: "text", patterns: [source], bytes: languageOctets(language), language },
			loc,
			this.#declarations,
			this.patterns
		)
	}

	/** The declared function a call names, refused where no level of the schema declares one of that name. */
	#declaredFunction(name: string, loc: SourceLoc): OwnedFunction {
		return (
			this.schema.owned.functions[name] ??
			fail("MalformedDescription", loc, `a declared function of the schema; ${name} is none`)
		)
	}

	/** A call's arguments are its function's, each named once: none missing, none another. */
	#callArguments(fn: OwnedFunction, named: ReadonlyArray<string>, loc: SourceLoc): void {
		const declared = fn.desc.args.map((a) => a.name)
		const missing = declared.filter((a) => !named.includes(a))
		const stray = named.filter((a) => !declared.includes(a))
		if (missing.length > 0 || stray.length > 0) {
			fail(
				"MalformedDescription",
				childLoc(loc, "args"),
				`the arguments of function ${fn.name}, ${declared.length === 0 ? "none" : declared.join(", ")}; ${[...missing.map((a) => `${a} is missing`), ...stray.map((a) => `${a} is none of them`)].join(", ")}`
			)
		}
	}

	/**
	 * A call's value argument as an expression of the scope the call stands in: a variable read through its column of
	 * the region, of a type that meets the argument's declared type; a parameter used at the declared type, bound as its
	 * base; a constant admitted at it.
	 */
	#boundArgument(value: BindValue, type: ScalarType, arg: string, loc: SourceLoc): ScalarExpr {
		switch (value.kind) {
			case "column":
				if (!compatible(value.type, type)) {
					fail(
						"MalformedDescription",
						loc,
						`a value of ${typeLabel(type)} for argument ${arg}; the variable bound to it is ${typeLabel(value.type)}`
					)
				}
				return this.emit(storedColumn(value.node, value.name, value.type))
			case "param":
				return this.emit(
					paramSpec(this.useParam(value.cell, type, loc), "compare", compareType(type))
				)
			case "literal":
				return this.emit(boundConstant(this.schema, value, type, this.patterns))
			case "rows":
				return fail(
					"MalformedDescription",
					loc,
					`a value of ${typeLabel(type)} for argument ${arg}, not the rows of a query`
				)
		}
	}

	#contextSource(
		src: Extract<ResolvedSource, { readonly kind: "context" }>,
		loc: SourceLoc
	): RelNode {
		const context = src.context
		const text = unwrap(descText(context))
		/**
		 * A Db of a role holds facts of exactly the contexts the role declares, decoded from its token: a program on
		 * the role matches one of them, as the role declares it, or would read a context no Db of the role holds, which
		 * is outside the role.
		 */
		const world = this.schema.world
		if (world.kind === "role") {
			const held = world.role.contexts[context.name]
			if (held === undefined) {
				failWith({
					_tag: "OutsideRole",
					at: loc,
					role: world.role.name,
					access: {
						kind: "context",
						context: context.name,
						declared: Object.keys(world.role.contexts)
					}
				})
			}
			if (unwrap(descText(held)) !== text) {
				failWith({
					_tag: "DuplicateIdentity",
					at: loc,
					duplicate: { kind: "context", name: context.name, earlier: world.role.loc }
				})
			}
		}
		this.#declarations.declare("context", context.name, { text, loc })
		const heading: Heading = entries(context.fields).map(([name, d]) => ({
			name,
			type: this.fieldType(d, childLoc(loc, name))
		}))
		return this.node({ kind: "Context", context: context.name, heading }, loc)
	}

	#importSource(src: ResolvedImport, loc: SourceLoc, bind: Binder): RelNode {
		const values = this.boundValues(src, loc, bind)
		return this.#keyedImport(src, values, loc, importedKey(this.options.session, src.query, values))
	}

	/** The values an import's bind map binds its parameters to. */
	boundValues(
		src: Pick<Extract<ResolvedSource, { readonly kind: "query" | "step" }>, "bind">,
		loc: SourceLoc,
		bind: Binder
	): ReadonlyMap<string, BindValue> {
		const values = new Map<string, BindValue>()
		for (const [param, term] of entries(src.bind)) {
			values.set(param, bind(term, param, childLoc(childLoc(loc, "bind"), param)))
		}
		return values
	}

	/**
	 * The import of `src` at `values`: one node for every import at one key, a closed one's among the closed imports
	 * (`#imported`), one bound to an outer value among the correlated ones (`#regional`), this check's alone.
	 */
	#keyedImport(
		src: Pick<Extract<ResolvedSource, { readonly kind: "query" | "step" }>, "query">,
		values: ReadonlyMap<string, BindValue>,
		loc: SourceLoc,
		key: ImportKey
	): RelNode {
		return key.closed
			? this.#closedImport(key.text, () => this.#importAt(src, values, loc))
			: this.#correlatedImport(key, () => this.#importAt(src, values, loc))
	}

	/**
	 * The correlated import of `key` (`importedKey`, `#closedCall`), bound to outer values: one node for every read of it
	 * in this check (`#regional`), correlated to the node its values are read from, whose rows it reads wherever that
	 * node's row is read; `build`'s at its first read.
	 */
	#correlatedImport(key: ImportKey, build: () => RelNode): RelNode {
		const known = this.#regional.get(key.text)
		if (known !== undefined) {
			return known
		}
		const node = build()
		this.#regional.set(key.text, node)
		this.#importKeys.set(node, key)
		return node
	}

	/**
	 * The closed import of `key` (`importedKey`, `#closedCall`), one node for every read of it: the one this check read
	 * at it; else the one a check of the compile built over this schema under this check's reading and clock, adopted
	 * (`#adopt`); else `build`'s, checked here (`#checkedImport`), which every later check of the compile reads.
	 */
	#closedImport(key: string, build: () => RelNode): RelNode {
		const known = this.#imported.get(key)
		if (known !== undefined) {
			return known
		}
		const compiled = this.options.session.closedImports(this.schema)
		const at = `${this.#reading} ${key}`
		const prior = compiled.get(at)
		const imported = prior ?? this.#checkedImport(build, at, compiled)
		if (prior !== undefined) {
			this.#adopt(prior)
		}
		this.#readImport(key, imported.node)
		return imported.node
	}

	/**
	 * Records `node` as the closed import this check read at `key`, journaled for every closed import being checked, and
	 * keys it in the session (CheckSession `closed`): a write's DAG merges it by that key (write/frontend/dag.ts
	 * QueryMerger), and every analysis of the compile shares its annotations by it (CheckSession `analyses`).
	 */
	#readImport(key: string, node: RelNode): void {
		this.#imported.set(key, node)
		this.#importKeys.set(node, { text: key, closed: true })
		this.#importRoots.add(node)
		this.options.session.closed(node, key)
		for (const journal of this.#importJournals) {
			journal.push([key, node])
		}
	}

	/**
	 * A closed import checked: `build`'s node, its own stated orders and merges, which `build` stated in this check and
	 * which no node outside it reads, taken from this check's and completed over the import's DAG alone (complete.ts),
	 * and what its check recorded (ClosedImport), each node's facts carried over to the node the completion stands in its
	 * place (`#adoptNodes`). The compile's other checks read it at `at` in `compiled` unless it holds a node of this
	 * check's own (CheckedImport `shared`).
	 */
	#checkedImport(
		build: () => RelNode,
		at: string,
		compiled: Map<string, ClosedImport>
	): ClosedImport {
		const checked = this.#importChecked(build)
		if (checked.shared) {
			compiled.set(at, checked.imported)
		} else {
			this.#private.add(checked.imported.node)
		}
		return checked.imported
	}

	#importChecked(build: () => RelNode): CheckedImport {
		const searchesBefore = [...this.#searches.values()]
		const searchCount = this.#searches.size
		/**
		 * The import's own stated orders and merges, its check's alone: nothing it reads is outside it but closed imports,
		 * whose orders and merges their own checks took. A refusal its check throws ends this check, so the tables and
		 * journals it leaves in place are never read.
		 */
		const outer = { stated: this.#stated, merges: this.#merges }
		this.#stated = new Map()
		this.#merges = new Map()
		const uses: Array<ParamUse> = []
		const searches = new Map<string, RelNode>()
		const reads: Array<readonly [string, RelNode]> = []
		this.#uses.push(uses)
		this.#searchJournals.push(searches)
		this.#importJournals.push(reads)
		const checked = this.#declarations.journaled(build)
		this.#uses.pop()
		this.#searchJournals.pop()
		this.#importJournals.pop()
		const built = checked.value
		const stated = this.#stated
		const merges = this.#merges
		this.#stated = outer.stated
		this.#merges = outer.merges
		const node =
			stated.size === 0 && merges.size === 0
				? built
				: unwrap(
						completeStated(
							this.b.build([built] as const),
							this.b,
							stated,
							merges,
							this.#importRoots,
							this.options.session.analyses
						)
					).roots[0]
		const nodes = this.#ownNodes(built)
		const held = new Set(nodes)
		const standIns =
			node === built ? undefined : new Map(this.#ownNodes(node).map((n) => [n.id, n] as const))
		const completed = (n: RelNode): RelNode => standIns?.get(n.id) ?? n
		const facts: NodeFacts = { literals: [], unions: [], delivered: [], attached: [] }
		for (const n of nodes) {
			if (n === built || !this.#importRoots.has(n)) {
				this.#nodeFacts(n, completed, facts)
			}
		}
		const own = [...this.#searches].slice(searchCount)
		const imported: ClosedImport = {
			node,
			...facts,
			imports: reads.map(([key, n]) => [key, completed(n)] as const),
			declared: checked.declared,
			searches: [...new Map([...searches, ...own])].map(
				([identity, n]) => [identity, completed(n)] as const
			),
			uses
		}
		if (node !== built) {
			this.#adoptNodes(imported)
		}
		return {
			imported,
			shared:
				!searchesBefore.some((s) => held.has(s)) && ![...this.#private].some((p) => held.has(p))
		}
	}

	/**
	 * The nodes of a closed import's DAG that are its own, from `root`: every node it reaches but those of the closed
	 * imports it reads (`#importRoots`), each of which stands among them by its root alone, its own nodes its own record's
	 * (ClosedImport), so a record's facts are its import's own and an import read inside another is recorded once.
	 */
	#ownNodes(root: RelNode): ReadonlyArray<RelNode> {
		const out: Array<RelNode> = []
		const seen = new Set<RelNode>()
		const pending = [root]
		for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
			if (seen.has(node)) {
				continue
			}
			seen.add(node)
			out.push(node)
			if (node !== root && this.#importRoots.has(node)) {
				continue
			}
			appendAll(pending, inputsOf(node))
		}
		return out
	}

	/**
	 * Records what this check recorded beside `node`, a node of a closed import's own, in `facts`, under the node the
	 * import's completion stands in its place (`completed`).
	 */
	#nodeFacts(node: RelNode, completed: (node: RelNode) => RelNode, facts: NodeFacts): void {
		const at = completed(node)
		const literals = this.#literals.get(node)
		if (literals !== undefined) {
			facts.literals.push([at, literals])
		}
		const union = this.#unions.get(node)
		if (union !== undefined) {
			facts.unions.push([
				at,
				{ arms: mapNonEmpty(union.arms, completed), discriminant: union.discriminant }
			])
		}
		const delivered = this.#delivered.get(node)
		if (delivered !== undefined) {
			facts.delivered.push([at, delivered])
		}
		const attached = this.#attached.get(node)
		if (attached !== undefined) {
			facts.attached.push([at, attached])
		}
	}

	/**
	 * Adopts a closed import another check of the compile checked (`#closedImport`): records what its check recorded as
	 * this check's own check of it would have, its nodes' facts (`#adoptNodes`), its declarations, its searches and its
	 * uses of the parameters it is bound to, which are this query's own of the same names, in the order it made them,
	 * each journaled for every closed import this check is checking around it.
	 */
	#adopt(imported: ClosedImport): void {
		this.#adoptNodes(imported)
		this.#declarations.replay(imported.declared)
		for (const [identity, search] of imported.searches) {
			if (!this.#searches.has(identity)) {
				this.#searches.set(identity, search)
			}
			for (const journal of this.#searchJournals) {
				journal.set(identity, search)
			}
		}
		for (const use of imported.uses) {
			const cell = defined(
				this.#params.cell(use.name),
				"a parameter of the reader's own that an import of its key is bound to by name"
			)
			switch (use.kind) {
				case "scalar":
					this.useParam(cell, use.type, use.loc)
					break
				case "relation":
					this.useRelationParam(cell, use.heading, use.loc)
					break
				case "bound":
					this.useBoundParam(cell, use.loc)
					break
			}
		}
	}

	/**
	 * Records a closed import's own nodes' facts and the closed imports it read (ClosedImport) as this check's own, each
	 * of those it has not read with its own record's, in the compile's table for this check's reading.
	 */
	#adoptNodes(imported: ClosedImport): void {
		for (const [node, literals] of imported.literals) {
			this.#literals.set(node, literals)
		}
		for (const [node, union] of imported.unions) {
			this.#unions.set(node, union)
		}
		for (const [node, delivered] of imported.delivered) {
			this.#delivered.set(node, delivered)
		}
		for (const [node, attached] of imported.attached) {
			this.#attached.set(node, attached)
		}
		for (const [key, node] of imported.imports) {
			if (this.#imported.has(key)) {
				continue
			}
			this.#readImport(key, node)
			const nested = this.options.session.closedImports(this.schema).get(`${this.#reading} ${key}`)
			if (nested !== undefined) {
				this.#adoptNodes(nested)
			}
		}
	}

	/** The query `src` imports, its parameters bound to `values`, each of which it must read. */
	#importAt(
		src: Pick<Extract<ResolvedSource, { readonly kind: "query" | "step" }>, "query">,
		values: ReadonlyMap<string, BindValue>,
		loc: SourceLoc
	): RelNode {
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
				failWith({
					_tag: "Refused",
					at: childLoc(childLoc(loc, "bind"), param),
					refusal: "a bind map names only the imported query's parameters"
				})
			}
		}
		return out.node
	}

	/**
	 * A relation parameter's rows: in the query's own scope, or bound to one of the importer's relation parameters, the
	 * caller's rows of its declared heading, or, where its compile's ChangeSet binds it to a query whose one evaluation
	 * it carries (CheckSession `bound`), that evaluation's InputSet, of the heading it delivers, which must be the
	 * declared one's fields at types that meet them (#deliversHeading); bound to the rows of a query, that query imported here, at this use, under
	 * its own bind map read in the scope that wrote it (BindValue `rows`), delivering exactly the declared heading's
	 * columns, each at a type that meets the field's (compatible), so the import reads the query's rows where it read
	 * the caller's.
	 */
	#paramSource(
		src: Extract<ResolvedSource, { readonly kind: "param" | "paramOf" }>,
		scope: Scope,
		loc: SourceLoc
	): RelNode {
		const heading =
			src.kind === "param"
				? this.#declaredHeading(src.heading, loc)
				: this.#relationHeading(src.relation, loc)
		const resolved = this.#bound(src.cell, scope, loc)
		switch (resolved.kind) {
			case "param": {
				const evaluation = this.#params.owns(resolved.cell)
					? this.options.session.bound.get(resolved.cell.name)
					: undefined
				if (evaluation !== undefined) {
					this.#deliversHeading(src.cell.name, heading, evaluation, loc)
					const param = this.useBoundParam(resolved.cell, loc)
					return this.node(
						{ kind: "InputSet", input: { kind: "bound", param }, heading: evaluation },
						loc
					)
				}
				const param = this.useRelationParam(resolved.cell, heading, loc)
				return this.node({ kind: "InputSet", input: { kind: "declared", param }, heading }, loc)
			}
			case "rows":
				return this.#boundRows(src.cell.name, heading, resolved, loc)
			case "literal":
			case "column":
				return fail(
					"MalformedDescription",
					loc,
					`relation parameter ${src.cell.name} bound to a relation-valued term: the importer's relation parameter, or the rows of a query`
				)
		}
	}

	/** The rows a relation parameter is bound to (#paramSource), of exactly its declared heading. */
	#boundRows(
		name: string,
		heading: Heading,
		bound: Extract<BindValue, { readonly kind: "rows" }>,
		loc: SourceLoc
	): RelNode {
		const rows = this.#keyedImport(
			bound,
			bound.values,
			loc,
			importedKey(this.options.session, bound.query, bound.values)
		)
		this.#deliversHeading(name, heading, rows.heading, loc)
		return rows
	}

	/**
	 * Refuses rows of the heading `delivered` for relation parameter `name` of the declared `heading` unless they deliver
	 * exactly its fields, each at a type that meets the field's (compatible): a query it is bound to, at a use
	 * (#boundRows), or the one evaluation its ChangeSet carries (#paramSource).
	 */
	#deliversHeading(
		name: string,
		heading: Heading,
		deliveredHeading: Heading,
		loc: SourceLoc
	): void {
		const stray = deliveredHeading.filter((c) => columnOf(heading, c.name) === undefined)
		for (const f of heading) {
			const delivered = columnOf(deliveredHeading, f.name)
			if (delivered === undefined) {
				failWith({
					_tag: "Refused",
					at: childLoc(loc, f.name),
					refusal: "a relation parameter binds a query that delivers exactly its heading's fields"
				})
			}
			if (!compatible(delivered.type, f.type)) {
				fail(
					"MalformedDescription",
					childLoc(loc, f.name),
					`a query delivering ${f.name} of ${typeLabel(f.type)} for relation parameter ${name}; it delivers ${typeLabel(delivered.type)}`
				)
			}
		}
		if (stray.length > 0) {
			failWith({
				_tag: "Refused",
				at: loc,
				refusal: "a relation parameter binds a query that delivers exactly its heading's fields"
			})
		}
	}

	/**
	 * A relation parameter's or a row's declared heading: each field typed, since how a field is written is no part of
	 * its type. A heading of no field is the unit relation (ir/rel.ts Heading), as the fill of a query entry of no head
	 * field declares; a user's relation parameter has
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
		reads: ExprReading,
		held: ReadonlyArray<HeldLeaf>
	): QueryEnv {
		return {
			mode: "query",
			loc,
			held,
			closed: reads === "filter" ? this.schema.closedReads : deliveredValue,
			functions: (name) => this.schema.owned.functions[name],
			emit: (spec) => this.emit(spec),
			leaf: (desc, at) =>
				catchRefusal(() => {
					const c = leaf(desc, at)
					return storedColumn(node, c.name, c.type)
				}),
			params: {
				kind: "scope",
				lower: (param, at) =>
					catchRefusal(() => this.#paramUse(param, at, scope, node, paramColumn))
			},
			fieldType: (desc, at) =>
				catchRefusal(() => this.schema.queryFieldType(desc, at, this.#declarations, this.patterns)),
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
	): { readonly spec: ExprSpec; readonly type: ScalarType; readonly reading: ParamReading } {
		const cell = param.cell
		const resolved = this.#resolveParam(cell, scope, loc)
		if (resolved.kind === "column") {
			const c = paramColumn(cell, loc)
			const spec = storedColumn(node, c.name, c.type)
			if (param.type.kind === "channel") {
				return { spec, type: c.type, reading: statedReading }
			}
			const type = this.paramType(param, loc)
			if (!compatible(c.type, type)) {
				fail(
					"MalformedDescription",
					loc,
					`operands of one type: the variable bound to parameter ${cell.name} is ${typeLabel(c.type)}, declared ${typeLabel(type)}`
				)
			}
			return { spec, type, reading: statedReading }
		}
		const type = this.paramType(param, loc)
		return resolved.kind === "param"
			? {
					spec: paramSpec(this.useParam(resolved.cell, type, loc), "compare", compareType(type)),
					type,
					reading: readingOf(this.options.clock, resolved.cell.name)
				}
			: {
					spec: boundConstant(this.schema, resolved, type, this.patterns),
					type,
					reading: statedReading
				}
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
	 * family: the plain one widened into the exact carrier, as the comparison Logic writes is (typing.ts comparison).
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
	 * one IR spelling of a mask); r.not and an existence are rule-level filters, never scalar operands.
	 *
	 * A window literal takes its type from the point: a span over the point's type, as r.pointIn(t, window) writes a
	 * time window. A parameter is a term of its declared type.
	 */
	#extension(
		desc: Extract<ResolvedExpr, { readonly kind: "allen" | "pointIn" | "absent" | "exists" }>,
		lower: (child: ResolvedExpr) => Result.Result<Lowered, CompileError>,
		loc: SourceLoc
	): Lowered {
		const bool = plainType("bool")
		const lowered = loweredOf
		/** A bare literal operand adopts `against`'s type; anything else, a parameter among them, meets it compatibly. */
		const operand = (d: ResolvedExpr, against: ScalarType, at: SourceLoc): ScalarExpr => {
			const adopted = adoptedType(against, "compare")
			if (d.kind === "literal" && d.type === undefined) {
				return this.emit(
					literalSpec(this.schema.literal(d.value, adopted, at, this.patterns, "compared"), adopted)
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
			case "exists":
				return fail(
					"UnsupportedOperation",
					loc,
					"an existence inside a scalar expression: a relational existence is a rule-level filter, alone or in a top-level conjunction"
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
				const window = spanType(point.nominal, undefined, at)
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
				"a head literal whose type something fixes: an integer, a bigint, a Decimal, a Money, a boolean or a string, or a typed Type.literal"
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

	resolveParam(cell: ParamCell, scope: Scope, loc: SourceLoc): ScalarBinding {
		return this.#resolveParam(cell, scope, loc)
	}

	/** What a relation parameter of the importer, bound in turn to an import's, reads in `scope` (#bound). */
	resolveBound(cell: ParamCell, scope: Scope, loc: SourceLoc): BindValue {
		return this.#bound(cell, scope, loc)
	}
}

/** How a refusal names the source a match reads: its relation, parameter, context, delta, or the kind of source it is. */
const sourceLabel = (src: ResolvedSource): string => {
	switch (src.kind) {
		case "relation":
			return src.name
		case "query":
			return "the matched query"
		case "step":
			return "a navigation step"
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
		case "call":
			return `the rows of function ${src.function}`
		case "callField":
			return `the rows of field ${src.field} of function ${src.function}`
		case "split":
			return `the ${src.split} of a text`
		case "series":
			return "a series"
	}
}

/** The rule variables a term reads, at any depth of it. */
const readVars = (e: ResolvedExpr): ReadonlyArray<string> =>
	e.kind === "var" ? [e.var] : exprChildren(e).flatMap((c) => readVars(c.term))

/** The carriers a series' ends are of (Checker.series): an integer's, a bigint's and an exact integer's. */
const seriesCarriers: ReadonlySet<Carrier> = new Set<Carrier>([
	"int2",
	"int4",
	"int8",
	"exactInteger"
])

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
	/**
	 * The variables a series' element is bound to, each by its id, with the element's bounds (Checker.series): what
	 * every term of the rule holds of it (typing.ts HeldLeaf).
	 */
	#elements: ReadonlyArray<{ readonly id: string; readonly bounds: Bounds }> = []
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
		const { region, matches } = this.#defineRegion(leaves)
		let node = this.#filter(region)
		/**
		 * A negation that reads only columns the head delivers unchanged applies after the projection, over fewer
		 * columns: projecting first and negating on the delivered columns keeps the same
		 * set.
		 */
		const late = this.#lateFilters()
		if (late === undefined) {
			node = this.#earlyFilters(node)
		}
		node = this.#head(node, matches)
		for (const n of late ?? []) {
			node = this.#relational(node, n.filter, this.at("where", n.index), (column) =>
				n.correlated.get(column)
			)
		}
		let carries = this.cx.carried(node)
		for (const a of this.rule.attach) {
			const attached = this.cx.attachIn(node, carries, a, this.scope, a.loc)
			node = attached.node
			carries = attached.carries
		}
		this.cx.carry(node, carries)
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
					outer: { node: origin.parent.node, name: column.parent, type: column.type },
					head: origin.parent.head
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
		const waiting = (m: ResolvedMatch): ReadonlyArray<string> =>
			bindTerms(m.source).flatMap(([, e]) => readVars(e).filter((x) => this.#unbound(x)))
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
			const series =
				match.source.kind === "series"
					? this.cx.series(match.source, loc, (e, at) =>
							unwrap(lowerTerm(e, this.env(this.region, at, "value")))
						)
					: undefined
			const source =
				series?.node ??
				this.cx.source(match.source, this.scope, this.rule.interiors, loc, (term, param, at) =>
					this.#bindValue(term, param, at, this.region)
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
					const bound = this.#bindUser(
						e.var,
						this.#reservedSlot(e.var, childLoc(loc, column)),
						col,
						loc
					)
					if (series !== undefined && column === seriesHeading.at) {
						this.#elements = [...this.#elements, { id: e.var, bounds: series.element }]
					}
					return [bound]
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
			const right = defined(
				semiJoinRight(builtSides, arms, source),
				"the narrowed arms are built after the take they narrow, so no expression of the take reads them"
			)
			const back = this.cx.node(
				{ kind: "SemiJoin", left: arms, right, on, heading: arms.heading },
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
		return this.#narrowUnion(
			only(selected) ?? this.cx.union(selected, loc, "values", (arm) => this.cx.carried(arm)),
			bindings,
			loc
		)
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
				this.cx.schema.admits(e.value, col.type, this.cx.patterns, "compared")
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
				this.cx.schema.admits(value, col.type, this.cx.patterns, "compared") &&
				canonicalEquals(
					this.cx.schema.literal(value, col.type, loc, this.cx.patterns, "compared"),
					head.literal
				)
			)
		}
		const delivered = defined(
			columnOf(this.cx.deliveredOf(arm), column),
			"an arm delivered each column of its heading before a union widened it"
		).type
		return this.cx.schema.admits(value, delivered, this.cx.patterns, "compared")
	}

	/**
	 * What an import's bind term binds a parameter to, read in this rule's scope: a scalar parameter is used at its
	 * declared type there, a relation parameter is resolved where the import reads it as a source, and the rows of a
	 * query are that query at its bind map's values, each read here as this term is (BindValue `rows`). A rule variable
	 * is read through a column of `node`, the node the import is read over: a match's import over the rule's region, and a
	 * relational filter's over the node it filters, which delivers the region's columns unchanged (`#relational`).
	 *
	 * A parent variable is bound to its column of the head of the parent's chain of attachments (ParentSlot `head`,
	 * attachmentHead), the value the attachment equates every binding of it with, whichever match of the rule binds it,
	 * before the import's source or after, or none: an outer reference to the delivered rows, which the attachment's
	 * statement carries in its parent key (lower/conservative/deliver.ts parentColumnsRead reads one to any node of the
	 * rows' spine, the head among them). So every attachment of one chain that imports one query at one parent column
	 * reads one node, where each bound it at its own parent, the attachment before it, and each import was a node of
	 * its own: edullm's decideStage read-back, every attachment of a session's record importing the session's start at
	 * the session's terms, was 34K nodes, and is 4.6K.
	 *
	 * A parameter is bound to the value its importer bound it to, a column of the unit, of an enclosing region or of an
	 * attachment's parent among them, in every reading, never to a column of this rule's region that re-exposes it: so
	 * every read of one query at that value, at any depth below the rows that bind it, has one key (`importedKey`) and is
	 * one node, correlated to the value's node, which the lowering holds once in the outermost region every read lies in
	 * that sees the value (lower/optimize/cte-policy holdingRegion, rule 3b). Bound at each reader's own region's column,
	 * it was a node of each reader's region, inlined at every read; bound at the outermost region that re-exposed it, the
	 * rules of a union each bound it at their own region's: edullm's decideStage read-back, each argument of a session's
	 * run importing the session's lookup at the parent's terms, was 113K nodes, 58K, and is 34K.
	 */
	#bindValue(term: ResolvedBound, param: string, loc: SourceLoc, node: NodeId): BindValue {
		if (term.kind === "relationParam") {
			return this.cx.resolveBound(term.cell, this.scope, loc)
		}
		if (term.kind === "rows") {
			return {
				kind: "rows",
				query: term.query,
				values: this.cx.boundValues(term, loc, (t, p, at) => this.#bindValue(t, p, at, node))
			}
		}
		if (term.kind === "var") {
			return this.#slotValue(this.#userSlot(term.var, loc), node)
		}
		if (term.kind === "parent") {
			const slot = this.parents.get(term.column)
			if (slot === undefined) {
				return fail(
					"MalformedDescription",
					loc,
					`a parent variable inside an attachment; ${term.column} is not one`
				)
			}
			return { kind: "column", ...slot.outer, node: slot.head }
		}
		if (term.kind === "param") {
			const resolved = this.cx.resolveParam(term.cell, this.scope, loc)
			if (resolved.kind === "param") {
				this.cx.useParam(resolved.cell, this.cx.paramType(term, loc), loc)
			}
			return resolved
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

	/** A slot as a bind value: its column of `node`, the rule's region or a node over it, at its type. */
	#slotValue(slot: Slot, node: NodeId): BindValue {
		return { kind: "column", node, name: slot.name, type: this.slotType(slot) }
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
		const held = this.#elements.map((e): HeldLeaf => {
			const slot = this.#userSlot(e.id, loc)
			return { leaf: storedColumn(node, slot.name, this.slotType(slot)), bounds: e.bounds }
		})
		return this.cx.env(node, loc, this.#leaf, this.scope, this.#paramColumn, reads, held)
	}

	/**
	 * A binding that fixes its column: a bare literal, a value of the column's type as written, refused where it has more
	 * digits than the type holds (scalar/compute/literal.ts LiteralMeeting `compared`), since the binding compares the
	 * column with it exactly; a parameter bound as the column's base; or a computed term that meets it (types.ts meets). The region holds a constant of the column's base type, or of the
	 * exact family it widens into (meetingType), whose equality with the column is the value equality the region writes;
	 * any other value is a hidden variable equated with it by the filter.
	 */
	#constant(column: HeadingColumn, e: ResolvedExpr, loc: SourceLoc): ConstantPlacement {
		comparable(column, "no constant, parameter or term fixes it", loc)
		const baseMatches = (t: ScalarType) => sameScalarType(baseOf(column.type), baseOf(t))
		if (e.kind === "literal" && e.type === undefined) {
			const literal = this.cx.schema.literal(
				e.value,
				column.type,
				loc,
				this.cx.patterns,
				"compared"
			)
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
				const id = this.cx.useParam(resolved.cell, declared, loc)
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
						expr: this.cx.emit(storedColumn(resolved.node, resolved.name, resolved.type))
					}
				}
				const slot = this.#paramSlot(cell, loc)
				this.#needed.add(slot.id)
				return {
					kind: "filter",
					expr: this.cx.emit(storedColumn(this.region, slot.name, this.slotType(slot)))
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
	#defineRegion(leaves: Leaves<Resolved["param"], Resolved["paramType"]>): {
		readonly region: RelNode
		readonly matches: RegionMatches
	} {
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
					expr: this.cx.emit(storedColumn(outer.node, outer.name, outer.type))
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
		const region = this.cx.define(
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
		return { region, matches: regionMatches({ vars, occurrences, correlated }) }
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
					storedColumn(this.region, pending.left.name, this.slotType(pending.left))
				)
				const r = this.cx.emit(
					storedColumn(this.region, pending.right.name, this.slotType(pending.right))
				)
				preds.push(this.cx.opNamed("eq", [l, r], loc))
			} else {
				const h = this.cx.emit(
					storedColumn(this.region, pending.hidden.name, this.slotType(pending.hidden))
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
	 * The rule's relational filters, its negations and existences, placed after its head, each correlated binding under
	 * the head key that delivers its slot's column unchanged, when every binding the filters correlate is one and the
	 * head is a plain projection; otherwise undefined, and every filter applies over the region. Either filter keeps or
	 * drops a row by the columns it correlates alone, so it keeps the same set over the projection that delivers them.
	 *
	 * A filtered import whose bind map reads the rule's region (a rule or parent variable, or a parameter an enclosing
	 * import binds to an outer value) is correlated with each binding of the region: it applies over the region, where
	 * those values are still in scope.
	 */
	#lateFilters(): ReadonlyArray<LateFilter> | undefined {
		const { relational } = splitWhere(this.rule.where)
		if (relational.length === 0) {
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
		const late: Array<LateFilter> = []
		for (const [index, filter] of relational) {
			const readsRegion =
				(filter.source.kind === "query" || filter.source.kind === "step") &&
				entries(filter.source.bind).some(
					([, term]) =>
						term.kind === "var" ||
						term.kind === "parent" ||
						(term.kind === "param" && this.paramSlots.has(term.cell.name))
				)
			if (readsRegion) {
				return undefined
			}
			const correlated = new Map<string, NegatedCorrelation>()
			for (const [column, e] of entries(filter.bindings)) {
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
			late.push({ index, filter, correlated })
		}
		return late
	}

	/** Each relational filter over the region `input`, in order, each correlated binding on its slot's own column. */
	#earlyFilters(input: RelNode): RelNode {
		let node = input
		const { relational } = splitWhere(this.rule.where)
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
		for (const [i, filter] of relational) {
			node = this.#relational(node, filter, this.at("where", i), correlate)
		}
		return node
	}

	/**
	 * One relational filter over `left`: r.not an AntiJoin, and an existence a SemiJoin, against the filtered source
	 * projected onto the columns this rule's values fix. A constant of the filter reads no variable of the rule: those
	 * correlate through the columns above. The filtered source is narrowed to the arms its constants select, as a
	 * match's is (#narrow). An existence's source reads nothing of `left` but the columns it correlates, as a semi-join's
	 * right side does (ir/rel.ts SemiJoinRight): one whose import binds a parameter to the rule's region is refused.
	 */
	#relational(
		left: RelNode,
		filter: RelationalFilter,
		loc: SourceLoc,
		correlate: Correlate
	): RelNode {
		const source = this.#narrow(
			this.cx.source(filter.source, this.scope, this.rule.interiors, loc, (term, param, at) =>
				this.#bindValue(term, param, at, left.id)
			),
			filter.bindings,
			loc
		)
		const heading = source.heading
		const placed = entries(filter.bindings).map(([column, e]) =>
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
										[this.cx.emit(storedColumn(negated.id, f.column, f.type)), f.value],
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
					expr: this.cx.emit(storedColumn(narrowed.id, c.name, c.type))
				})),
				heading: rightOut
			},
			loc
		)
		const node = this.cx.node(
			filter.kind === "absent"
				? { kind: "AntiJoin", left, right, on, heading: left.heading }
				: {
						kind: "SemiJoin",
						left,
						right:
							semiJoinRight(builtSides, left, right) ??
							fail(
								"UnsupportedOperation",
								loc,
								"an existence whose source reads the rule's region beyond the columns it binds"
							),
						on,
						heading: left.heading
					},
			loc
		)
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
		 * Of its declared type, meeting the column or of its base carrier, as a negation's correlated column is
		 * (#correlatedBinding), and bound as its base, as everywhere it is compared. A column of another base, a regex
		 * refinement or a numeric typmod, is a variable of the negated region equated with the parameter by a filter
		 * there, never a cast of the parameter, which for a typmod rounds.
		 */
		const declared = this.cx.paramType(e, at)
		if (!meets(declared, col.type) && !sameCarrier(declared, col.type)) {
			fail(
				"MalformedDescription",
				at,
				`operands of one type: ${col.name} is ${typeLabel(col.type)}, parameter ${e.cell.name} ${typeLabel(declared)}`
			)
		}
		const bound = compareType(declared)
		const id = this.cx.useParam(resolved.cell, declared, at)
		const value = this.cx.emit(paramSpec(id, "compare", bound))
		return sameScalarType(baseOf(col.type), bound)
			? { kind: "constant", column, expr: value }
			: { kind: "filtered", column, type: col.type, value }
	}

	/**
	 * A negated column correlated with a region column of its base carrier (scalar/compute/types.ts sameCarrier),
	 * compared by `=` with no cast, as a stored foreign key compares its columns: a negation tests the inclusion a
	 * containment states, and what types of one base carrier may differ in refines their values and leaves PostgreSQL's
	 * equality alone, a contract at any level, natural's and an instant's among them, a text's pattern and bounds (every
	 * text is of the deterministic collation pg_c_utf8), a numeric's typmod, a span's width. So a containment's violation
	 * query, an anti-join of its target bound to its source's terms, holds across refining types as its foreign key does.
	 */
	#correlatedBinding(
		col: HeadingColumn,
		correlation: NegatedCorrelation,
		at: SourceLoc
	): NegatedBinding {
		const { region } = correlation
		if (!sameCarrier(region.type, col.type)) {
			fail(
				"MalformedDescription",
				at,
				`operands of one type: ${region.name} is ${typeLabel(region.type)}, ${col.name} is ${typeLabel(col.type)}`
			)
		}
		return { kind: "correlated", column: col.name, type: col.type, left: correlation.on }
	}

	/**
	 * A literal binding of a negated match: a bare one a value of the column's type as written (LiteralMeeting
	 * `compared`), as a match's binding is, or one of the type it states, at that type.
	 */
	#negatedLiteral(
		e: Extract<ResolvedExpr, { readonly kind: "literal" }>,
		col: HeadingColumn,
		at: SourceLoc
	): ScalarExpr {
		if (e.type === undefined) {
			return this.cx.emit(
				literalSpec(
					this.cx.schema.literal(e.value, col.type, at, this.cx.patterns, "compared"),
					col.type
				)
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
		return this.cx.emit(
			literalSpec(this.cx.schema.literal(e.value, t, at, this.cx.patterns, "stored"), t)
		)
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
			expr: this.cx.emit(storedColumn(input.id, c.name, c.type)),
			type: c.type,
			literal: undefined
		})
		const literal = (value: LiteralDesc, typing: LiteralTyping, at: SourceLoc): TermOut => {
			const admitted = typing.kind === "fixed" ? typing.type : this.cx.bareLiteralType(value, at)
			const lit = this.cx.schema.literal(value, admitted, at, this.cx.patterns, "stored")
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
		if (h.kind === "exists") {
			return fail(
				"UnsupportedOperation",
				loc,
				"an existence as a head term: a relational existence is a rule-level filter"
			)
		}
		/**
		 * The column has the type the builder gives the term (its nominal type): a Type.base or a widening cast emits
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
	 * How a literal head term is typed: fixed at the type it states (X.handle, Type.literal), else at the written
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
	 * A parameter head term, emitted or written at its declared type, at which a written member's column enters its
	 * field (member.ts checkMemberHeading); an import's parameter bound to a literal is that literal at the type it
	 * states, else at the parameter's.
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
				const id = this.cx.useParam(resolved.cell, declared, loc)
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
	#head(input: RelNode, matches: RegionMatches): RelNode {
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
						expr: this.cx.emit(storedColumn(input.id, col.name, col.type)),
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
			const projection = projectionOf(out)
			const node = this.cx.node({ kind: "ProjectSet", input, ...projection }, this.at("head"))
			this.cx.setLiterals(node, literals)
			if (rowsOf(this.scope.origin) === "values") {
				this.cx.stateMerge(node, { kind: "matches", input, region: matches }, this.at("head"))
			}
			return node
		}
		return this.#grouped(input, corr, plain, folded, matches)
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

	/** The keys of a matched source as its declaration states them (check/merge.ts declaredKeys). */
	#sourceKeys(source: RelNode): NonEmptyReadonlyArray<KeySet> {
		return declaredKeys(source, (name) => this.cx.schema.closed.get(name)?.relation.primaryKey)
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
		switch (p.fn) {
			case "pack": {
				const spans = span(p.args[0], 0)
				return {
					call: { producer: producerKinds.pack, args: [spans.expr] },
					type: spans.expr.type
				}
			}
			case "intersection":
			case "difference": {
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
			case "span":
				return spanFromEnds(p.args, env, at)
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
		folded: Folded,
		matches: RegionMatches
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
					expr: this.cx.emit(storedColumn(input.id, c.name, c.type)),
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
		/** A float the group delivers is the canonical zero where a group may take it as one of several (groupedZeroed). */
		const correlations = new Set(corr.map((c) => c.name))
		const zeroed = groupedZeroed(matches, inputHeading, new Set(keyNames), (source) =>
			this.#sourceKeys(source)
		)
		const keyRole = (name: string): "correlation" | "key" =>
			correlations.has(name) ? "correlation" : "key"
		const read = (c: HeadingColumn, delivered: "correlation" | "key" | "result"): ScalarExpr => {
			const column = this.cx.emit(storedColumn(node.id, c.name, c.type))
			return zeroed(c, delivered) ? this.cx.canonicalZero(column) : column
		}
		const projected =
			constants.length > 0 ||
			keyed.some((k) => k.name !== k.column.name || zeroed(k.column, keyRole(k.name))) ||
			results.some((r) => r.name !== r.column.name || zeroed(r.column, "result"))
		if (!projected) {
			return node
		}
		const literals = new Map<string, HeadLiteral>()
		const out: Array<OutColumn> = [
			...keyed.map(({ name, column: c }) => ({ name, expr: read(c, keyRole(name)), type: c.type })),
			...results.map(({ name, column: c }) => ({ name, expr: read(c, "result"), type: c.type })),
			...constants.map(([name, h]) => {
				const t = this.#term(name, h, node, this.at("head", name))
				if (t.literal !== undefined) {
					literals.set(name, t.literal)
				}
				return { name, expr: t.expr, type: t.type }
			})
		].toSorted(byName)
		const projection = this.cx.node({ kind: "ProjectSet", input: node, ...projectionOf(out) }, loc)
		this.cx.setLiterals(projection, literals)
		return projection
	}
}
