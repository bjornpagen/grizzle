import { Array as Arr } from "effect"
import type { AllenMask } from "#compiler/allen/mask.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { IdentifierFeature } from "#test/support/kernel/dict.ts"
import { scalarOfSpec } from "#test/support/oracle/gen/domain.ts"
import type { CompareOp } from "#test/support/oracle/gen/ops.ts"
import type { Perturbation } from "#test/support/oracle/perturb.ts"

/**
 * The field types a generated schema declares, each a public descriptor (build.ts) with the ScalarType the schema
 * compiler derives for it (generate.ts): integer, bigint, bare numeric (every display scale kept, so never a key),
 * numeric(5,2), double precision, money, boolean, the generated bounded text, unbounded prose (str.regex("^.*$", "su"),
 * whose values come from the literal dictionary and include what array_out must quote), uuid, and the handle of the
 * case's closed roster.
 */
export const fieldKinds = [
	"int4",
	"int8",
	"numeric",
	"fixed",
	"float8",
	"money",
	"bool",
	"text",
	"prose",
	"uuid",
	"handle"
] as const

/**
 * Field kinds a gate adds to a relation; the general draw (fieldKinds) never draws them: a span over integer and over
 * bigint, and the contract Tick over bigint (span(pg.integer), span(pg.bigint), contract("Tick", pg.bigint)).
 */
const gatedKinds = ["span4", "span8", "tick"] as const
export type FieldKind = (typeof fieldKinds)[number] | (typeof gatedKinds)[number]

/**
 * The kinds a key may hold: those whose values a key constraint, the codec and the reference identify alike, every
 * value one spelling or coerced to one by the column's typmod.
 */
export const keyKinds: Arr.NonEmptyReadonlyArray<FieldKind> = [
	"int4",
	"int8",
	"fixed",
	"bool",
	"text",
	"uuid",
	"handle"
]

export interface ProgramField {
	readonly name: string
	readonly kind: FieldKind
	readonly type: ScalarType
}

export interface Stored {
	readonly kind: "stored"
	readonly name: string
	readonly fields: Arr.NonEmptyReadonlyArray<ProgramField>
	readonly primaryKey: Arr.NonEmptyReadonlyArray<ProgramField>
	/** key(...) statements beside the primary key. */
	readonly candidates: ReadonlyArray<Arr.NonEmptyReadonlyArray<ProgramField>>
}

/** The case's closed roster, matchable as a relation of its handles under the field `id`. */
export interface Roster {
	readonly kind: "roster"
	readonly name: string
	readonly handles: Arr.NonEmptyReadonlyArray<string>
	readonly id: ProgramField
}

/**
 * A relation-valued parameter: its name, the stored relation whose heading it takes (r.relation(name, R)), and the rows
 * the read binds, facts of that relation.
 */
export interface RelationParam {
	readonly name: string
	readonly relation: Stored
	readonly rows: ReadonlyArray<ProgramFact>
}

/**
 * How an imported query's parameter is bound by Query.bind: to a variable of the importing rule bound by an earlier
 * match, or to a parameter of the importing read.
 */
export interface ImportBind {
	readonly param: Param
	readonly to:
		| { readonly kind: "var"; readonly var: Var }
		| { readonly kind: "param"; readonly param: Param }
}

/**
 * An earlier read's query matched as a source: that read's root, its attachments kept or dropped as drawn, delivered as
 * a set, its heading each head variable's field under its head key, and every one of its parameters bound. Either way
 * the import reads only its root's rows: an attachment delivers children to a read's rows, never rows to a match.
 */
export interface Imported {
	readonly kind: "import"
	readonly read: number
	readonly query: Query<never>
	readonly fields: Arr.NonEmptyReadonlyArray<ProgramField>
	readonly binds: ReadonlyArray<ImportBind>
}

/** An interior stage of the rule (r.interior), its heading its head variables' fields under their head keys. */
export interface Interior {
	readonly kind: "interior"
	readonly rule: Rule<never>
	readonly fields: Arr.NonEmptyReadonlyArray<ProgramField>
}

/** A relation-valued parameter matched as a source, under its relation's fields. */
export interface RelationSource {
	readonly kind: "relation param"
	readonly param: RelationParam
	readonly fields: Arr.NonEmptyReadonlyArray<ProgramField>
}

/**
 * The transitive closure of one relation's edges from field `from` to field `to`, each edge kept only where from < to
 * (so the closure is acyclic): query(S).recursive(name, ...), its heading src and dst of from's kind and type.
 */
export interface Closure {
	readonly kind: "closure"
	readonly name: string
	readonly edge: Stored
	readonly from: ProgramField
	readonly to: ProgramField
	readonly fields: readonly [ProgramField, ProgramField]
}

export type Derived = Imported | Interior | RelationSource | Closure

export type Source = Stored | Roster | Derived

export const sourceFields = (source: Source): Arr.NonEmptyReadonlyArray<ProgramField> => {
	switch (source.kind) {
		case "stored":
			return source.fields
		case "roster":
			return [source.id]
		case "import":
		case "interior":
		case "relation param":
		case "closure":
			return source.fields
	}
}

/** How the names of a schema and its queries were drawn (kernel/dict.ts), for the suite's features. */
export type NameKind = IdentifierFeature | "fallback"

export interface ProgramSchema {
	readonly relations: Arr.NonEmptyReadonlyArray<Stored>
	readonly roster: Roster
	readonly nameKinds: ReadonlySet<NameKind>
}

/**
 * A stored fact: one literal per field, in field order. Facts of one relation are distinct at every key by native
 * equality; their other fields spell each value as the fact drew it, so 1.0 and 1.00 meet in one column.
 */
export type ProgramFact = ReadonlyArray<TypedLiteral>

/** A variable, typed by the field it was minted from. */
export interface Var {
	readonly id: number
	readonly field: ProgramField
}

/**
 * How a parameter is declared: with its compared field's base descriptor (compareParamType), or with the field's own
 * descriptor, a contract's or a typmod's.
 */
export type ParamDeclaration =
	| { readonly kind: "base" }
	| { readonly kind: "field"; readonly field: ProgramField }

/**
 * A parameter: its name, unique in the case, the type it is bound as (a compared field's base for a base declaration,
 * the field's own type for a field declaration), the value the read binds, and how it is declared.
 */
export interface Param {
	readonly name: string
	readonly type: ScalarType
	readonly value: TypedLiteral
	readonly declaration: ParamDeclaration
}

/** A column of a heading: a head key and its type. */
export interface Column {
	readonly name: string
	readonly type: ScalarType
}

/** A column of the parent's heading, which a child query reads where it binds a field. */
export interface ParentColumn {
	readonly kind: "parent"
	readonly column: Column
}

/**
 * What a binding or a comparison's right side holds. `P` is ParentColumn in an attachment's child and never elsewhere.
 */
export type Operand<P> =
	| { readonly kind: "var"; readonly var: Var }
	| { readonly kind: "literal"; readonly literal: TypedLiteral }
	| { readonly kind: "param"; readonly param: Param }
	| P

/** A field bound in a match; a field the match leaves out is existential. */
export interface Binding<P> {
	readonly field: ProgramField
	readonly operand: Operand<P>
}

export interface Match<P> {
	readonly source: Source
	readonly bindings: Arr.NonEmptyReadonlyArray<Binding<P>>
}

export interface Comparison {
	readonly op: CompareOp
	readonly left: Var
	readonly right: Operand<never>
}

/** r.not(source, bindings): no fact of the source agrees with the variables. */
export interface Negation {
	readonly source: Stored
	readonly bindings: Arr.NonEmptyReadonlyArray<{ readonly field: ProgramField; readonly var: Var }>
}

/** r.between(left, low, high): low <= left <= high. */
export interface Between {
	readonly left: Var
	readonly low: Operand<never>
	readonly high: Operand<never>
}

/** r.inSet(left, values): left equals one of the values. */
export interface InSet {
	readonly left: Var
	readonly values: Arr.NonEmptyReadonlyArray<TypedLiteral>
}

/** r.allen(left, mask, right) over two span variables: their Allen relation is one the mask holds. */
export interface AllenAtom {
	readonly left: Var
	readonly mask: AllenMask
	readonly right: Var
}

/**
 * r.pointIn(point, span): the point lies in the half-open span; the point is of the span's endpoint type.
 * r.pointIn takes a term first, so the point is a variable of the span's endpoint type, never a literal or a parameter.
 */
export interface PointIn {
	readonly point: Var
	readonly span: Var
}

/** The endpoint type of a span variable: integer for a span over integer, bigint for one over bigint. */
export const endpointType = (span: Var): ScalarType =>
	span.field.type.carrier === "range8"
		? scalarOfSpec({ carrier: "int8" })
		: scalarOfSpec({ carrier: "int4" })

export const aggregateFns = ["count", "sum", "mean", "min", "max"] as const
export type AggregateFn = (typeof aggregateFns)[number]

/**
 * A Compute term over one numeric variable (int4, int8, numeric, numeric(5,2) or Tick): Compute.base(v), a contract's
 * base value and identity elsewhere; Compute.cast(v, pg.numeric); or Compute.cond(r.<op>(v, than), v, otherwise).
 */
export type ComputedTerm =
	| { readonly kind: "base"; readonly arg: Var }
	| { readonly kind: "cast numeric"; readonly arg: Var }
	| {
			readonly kind: "cond"
			readonly arg: Var
			readonly op: CompareOp
			readonly than: TypedLiteral
			readonly otherwise: TypedLiteral
	  }

/** The field kinds a head literal takes (r.literal): a JavaScript number, a bigint, a string or a boolean. */
export const literalKinds = ["int4", "int8", "text", "bool"] as const
export type LiteralKind = (typeof literalKinds)[number]

/**
 * A head key: a variable, an aggregate over the rule's distinct complete bindings, a Compute term, which keys an
 * aggregate's groups beside its variables, or a literal (r.literal), typed as the checker types a literal that meets no
 * term (a union's arms state one each, to tell their rows apart).
 */
export type HeadItem =
	| { readonly kind: "var"; readonly name: string; readonly var: Var }
	| { readonly kind: "count"; readonly name: string; readonly type: ScalarType }
	| {
			readonly kind: "fold"
			readonly name: string
			readonly fn: Exclude<AggregateFn, "count">
			readonly arg: Var
			readonly type: ScalarType
	  }
	| {
			readonly kind: "computed"
			readonly name: string
			readonly term: ComputedTerm
			readonly type: ScalarType
	  }
	| {
			readonly kind: "literal"
			readonly name: string
			readonly literal: TypedLiteral
			readonly type: ScalarType
	  }

export interface Rule<P> {
	readonly matches: Arr.NonEmptyReadonlyArray<Match<P>>
	readonly where: ReadonlyArray<Comparison>
	readonly between: ReadonlyArray<Between>
	readonly inSets: ReadonlyArray<InSet>
	readonly allens: ReadonlyArray<AllenAtom>
	readonly pointIns: ReadonlyArray<PointIn>
	readonly negations: ReadonlyArray<Negation>
	readonly head: ReadonlyArray<HeadItem>
}

/**
 * Whether a rule filters its bindings by anything but its matches: a comparison, a range, a set, an Allen atom or a
 * point membership. The delivery proofs read it where they read "no comparison".
 */
export const hasFilter = <P>(rule: Rule<P>): boolean =>
	rule.where.length > 0 ||
	rule.between.length > 0 ||
	rule.inSets.length > 0 ||
	rule.allens.length > 0 ||
	rule.pointIns.length > 0

export const isAggregate = <P>(rule: Rule<P>): boolean =>
	Arr.some(rule.head, (h) => h.kind === "count" || h.kind === "fold")

export interface OrderKey {
	readonly column: Column
	readonly dir: "asc" | "desc"
}

/** A set, or the first k of a total order over every column of the heading: .orderBy(...).take(k). */
export type ProgramBound =
	| { readonly kind: "set" }
	| {
			readonly kind: "take"
			readonly order: Arr.NonEmptyReadonlyArray<OrderKey>
			readonly k: number
	  }

/** Arms of one heading, bounded, named or not (.named(name) after the bound), then attached to. */
export interface Query<P> {
	readonly heading: ReadonlyArray<Column>
	readonly arms: Arr.NonEmptyReadonlyArray<Rule<P>>
	readonly bound: ProgramBound
	readonly stage: { readonly kind: "unnamed" } | { readonly kind: "named"; readonly name: string }
	readonly attachments: ReadonlyArray<Attachment>
}

/**
 * How an attachment states its children are delivered, attach's third argument: every child as an array, at most one
 * as an Option, exactly one as the child itself, or the arm of one handle, Some of the child in the parent rows whose
 * `field` holds `handle` and None in the others. An attachment states only a delivery the language proves of its child
 * (delivery.ts).
 */
export type StatedDelivery =
	| { readonly kind: "array" }
	| { readonly kind: "option" }
	| { readonly kind: "one" }
	| { readonly kind: "arm"; readonly field: Column; readonly handle: string }

/**
 * An attachment: its child binds at least one parent column in a match, since the language refuses an attachment
 * correlated with nothing (AttachedParentUnbound); the generator attaches only where it can bind one.
 */
export interface Attachment {
	readonly name: string
	readonly child: Query<ParentColumn>
	readonly delivery: StatedDelivery
}

/** How the root is delivered: a set, or in a total order over its heading, and then also paged. */
export type Delivery =
	| { readonly kind: "set" }
	| {
			readonly kind: "ordered"
			readonly order: Arr.NonEmptyReadonlyArray<OrderKey>
			readonly pageSize: number
	  }

export interface Root extends Query<never> {
	readonly delivery: Delivery
}

/**
 * A refusal the read provokes besides its answer, at the public boundary: a parameter of the wrong host type (encode),
 * a page size outside 1..pageMaxSize (request), or a cursor its codec cannot read (cursor). Each must be its typed
 * error, and the read after it must answer as before.
 */
export type Probe =
	| { readonly kind: "none" }
	| { readonly kind: "encode"; readonly param: Param }
	| { readonly kind: "page size"; readonly size: number }
	| { readonly kind: "cursor" }

/**
 * A heterogeneous union at the root: arms of more than one head key set, each arm in the heading group of its key set,
 * the groups in the order their first arm appears, every arm stating the discriminant, a head key bound to a literal in
 * every arm whose literals tell the groups apart (check/checker.ts MissingDiscriminant). It is delivered as a set:
 * nothing attaches to it, which the language refuses ("an attached heterogeneous union"), and it reads no parameter.
 */
export interface MixedRoot {
	/** Each group's heading: the head columns its arms find, in their head's order. */
	readonly groups: Arr.NonEmptyReadonlyArray<ReadonlyArray<Column>>
	/** The arms in the order the query states them, each in its group. */
	readonly arms: Arr.NonEmptyReadonlyArray<{ readonly group: number; readonly rule: Rule<never> }>
	readonly discriminant: Arr.NonEmptyReadonlyArray<string>
}

export type ProgramRead =
	| {
			readonly kind: "query"
			readonly query: Root
			readonly params: ReadonlyArray<Param>
			/** The relation-valued parameters its root's matches read. */
			readonly relations: ReadonlyArray<RelationParam>
			readonly probe: Probe
	  }
	| { readonly kind: "mixed"; readonly root: MixedRoot }
	| {
			readonly kind: "key"
			readonly relation: Stored
			readonly key: Arr.NonEmptyReadonlyArray<ProgramField>
			readonly candidate: boolean
			readonly values: Arr.NonEmptyReadonlyArray<TypedLiteral>
	  }
	| { readonly kind: "handle"; readonly handle: string }

/**
 * The program language of the public-boundary differential: what an application writes against grizzle's public API,
 * held as a value.
 *
 * A case is a schema, the facts its relations hold, the planner settings one side runs under, and reads. A read is a
 * query or a keyed lookup. A query is the builder's language: rules of matches, comparisons, negations and a head; arms
 * of one heading; an ordered take; attachments of correlated child queries, nested once; and a final order the root may
 * be delivered and paged in. Two interpretations read the same value, which is the point of the suite:
 *
 * - build.ts calls the public builders, whose Descriptions grizzle checks, lowers, runs and decodes;
 * - meaning.ts translates the program to IR by its own rules, for the reference evaluator, never through grizzle's
 *   checker.
 *
 * So a builder or checker that mistranslates (records `lt` as `gt`, binds the wrong field, groups by the wrong
 * columns) and an adapter that assembles results wrongly (stitches children by spelling, decodes a value wrongly,
 * wraps get's row wrongly) both meet an independent answer.
 *
 * The representation holds only programs the language admits: a parent column can occur only in an attachment's child
 * (Query<ParentColumn>, never the root's Query<never>), a negation binds variables only, a comparison's left side is a
 * variable, a match binds at least one field, an ordered delivery and its page size exist together, and a refusal
 * probe carries what it needs (a parameter to mistype, an ordered root to page).
 *
 * Besides stored relations and the roster, a root rule's later matches may read a derived source: an earlier read's
 * query imported through Query.bind, an interior stage of the rule (r.interior), a relation-valued parameter
 * (r.relation) or an acyclic closure (query(S).recursive); a rule filters by comparisons, ranges (r.between), sets
 * (r.inSet), Allen relations (r.allen) and point memberships (r.pointIn); a head may hold Compute terms; and a query may
 * be named (Query.named).
 */
export interface ProgramCase {
	readonly schema: ProgramSchema
	readonly facts: ReadonlyMap<string, ReadonlyArray<ProgramFact>>
	/** The planner settings one side of every read runs under (perturb.ts): plan diversity without large data. */
	readonly perturbation: Perturbation
	readonly reads: Arr.NonEmptyReadonlyArray<ProgramRead>
}
