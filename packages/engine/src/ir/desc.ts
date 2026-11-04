import {
	type Canonicalizable,
	type EncodeOptions,
	encode,
	everyProperty,
	fromJson,
	type Json,
	omitSourceLocs,
	type Revivers,
	toJson
} from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import {
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { isValidText } from "#compiler/core/text.ts"
import { isMoneyPayload, isVectorPayload, moneyTag, vectorTag } from "#compiler/ir/carriers.ts"
import { decimalTag, isDecimalPayload } from "#compiler/ir/decimal.ts"
import { type Fact, factNames, factsSorted } from "#compiler/ir/proof.ts"
import * as S from "#compiler/ir/shape.ts"
import { reservedSlots } from "#compiler/ir/slots.ts"

/**
 * Literals, as authored (LiteralOf): the host value. A numeric literal is a Decimal or a bigint, or an
 * exact decimal string the checker parses; a JavaScript number is a smallint, integer, real or double precision
 * literal. A Money is its owned value (Money.of), carried as "~m:"; a Vector, a caller's mutable Float32Array, is the
 * frozen snapshot of its components Vector.canonical takes, carried as "~v:". Spans and the float special values are
 * wrapped so that no literal is mistaken for a record.
 */
export type LiteralDesc =
	| string
	| number
	| boolean
	| bigint
	| Canonicalizable
	| { readonly span: { readonly start: number | bigint; readonly end: number | bigint } }
	| { readonly float: "NaN" | "Infinity" | "-Infinity" }

/** Field descriptors, aliases already normalized: decimal is numeric, bool is boolean. */
const pgScalarNames = [
	"smallint",
	"integer",
	"bigint",
	"real",
	"double precision",
	"money",
	"boolean"
] as const
export type PgScalarName = (typeof pgScalarNames)[number]

export type FieldDesc =
	| { readonly kind: "pg"; readonly type: PgScalarName }
	| { readonly kind: "numeric" }
	| { readonly kind: "numeric"; readonly precision: number; readonly scale: number }
	| { readonly kind: "serial"; readonly type: "smallserial" | "serial" | "bigserial" }
	| { readonly kind: "uuid" }
	| { readonly kind: "text"; readonly source: string; readonly flags: "u" | "su" }
	| {
			readonly kind: "contract"
			readonly name: string
			readonly base: FieldDesc
			readonly predicate: ExprDesc | undefined
			/** The facts the contract declares its predicate proves, distinct and in the one order (ir/proof.ts). */
			readonly facts: ReadonlyArray<Fact>
	  }
	| { readonly kind: "span"; readonly endpoint: FieldDesc; readonly width: bigint | undefined }
	| { readonly kind: "closedId"; readonly roster: string }
	| { readonly kind: "vector"; readonly dimensions: number }

/** The Compute catalogue. */
export const computeFns = [
	"add",
	"sub",
	"mul",
	"div",
	"mod",
	"neg",
	"quot",
	"rem",
	"abs",
	"sign",
	"round",
	"trunc",
	"ceil",
	"floor",
	"gcd",
	"lcm",
	"power",
	"sqrt",
	"least",
	"greatest",
	"widthBucket",
	"minScale",
	"lower",
	"upper",
	"width",
	"charLength",
	"cosineDistance"
] as const
export type ComputeFn = (typeof computeFns)[number]
/** The functions that take a scale argument: round(a, scale) and trunc(a, scale). */
export type ScaledComputeFn = "round" | "trunc"

const compareOps = ["eq", "ne", "lt", "le", "gt", "ge"] as const
export type CompareOp = (typeof compareOps)[number]

/**
 * Where a Description node is. A schema, its relations and statements, a query's stages (but an attach stage, located
 * at its attach entry), rules, matches and attachments, and a ChangeSet's members, are located once decoded: the
 * builders state each node's location, and the decoder locates a node a JavaScript author left unlocated by its path
 * in the description (ir/shape.ts located), so no consumer re-defaults one. Every Description type takes the form of
 * its located nodes as `L`, `Located` by default; only a description authored to be decoded, as a test states one,
 * takes another.
 */
export interface Located {
	readonly loc: SourceLoc
}

/**
 * What a Description names its variables, parent variables and interior stages by: canonical spellings in every
 * Description (`Spelled`, the default), and the builder's own reference objects in the clauses it is still building
 * (ir/open.ts Open). Every type that holds an expression takes its references as `R`.
 */
export interface Refs {
	readonly var: unknown
	readonly parent: unknown
	readonly interior: unknown
	/** The leaves an expression may hold, each a member of LeafShape: every kind in a Description, fewer where a
	 * producer builds an expression over fewer, such as a generated CHECK over its table's own fields. */
	readonly leaf: LeafShape
	/**
	 * The fields a parameter reference carries, beside its kind: its name in a Description, the parameter's cell once
	 * the checker resolves it (check/params.ts). A separate selector from `leaf`, whose kinds it never shares, so a
	 * reader generic over the references still tells a parameter from a leaf by its kind.
	 */
	readonly param: object
	/**
	 * What a scalar parameter reference states of its type beside its name: its declared field descriptor in a
	 * Description; the checker's own references may state a channel instead (check/params.ts ParamTyping).
	 */
	readonly paramType: unknown
	/**
	 * The references of the descriptions a clause holds whole: an interior stage's arms, an attachment's child and an
	 * imported query. The builder's open clauses hold finished, spelled ones.
	 */
	readonly nested: Refs
}

/** Every leaf an expression may name: a rule variable, a check's field, the contract's VALUE, or an attachment's parent
 * column. */
export type LeafShape =
	| { readonly kind: "var"; readonly var: unknown }
	| { readonly kind: "field"; readonly field: string }
	| { readonly kind: "value" }
	| { readonly kind: "parent"; readonly column: unknown }

/**
 * A Description's references with each parameter reference carrying `P`: a variable's, a parent column's and an
 * interior stage's canonical spelling, and every leaf kind. A walk over a description's parameters (mapQueryParams)
 * changes only `P`.
 */
export interface ParamsAs<P extends object, T = FieldDesc> extends Refs {
	readonly var: string
	readonly parent: string
	readonly interior: string
	readonly leaf:
		| { readonly kind: "var"; readonly var: string }
		| { readonly kind: "field"; readonly field: string }
		| { readonly kind: "value" }
		| { readonly kind: "parent"; readonly column: string }
	readonly param: P
	readonly paramType: T
	readonly nested: ParamsAs<P, T>
}

/** A Description's references: every reference spelled canonically, a parameter by its name. */
export type Spelled = ParamsAs<{ readonly name: string }>

/**
 * What a Compute.when guard tests of its subject and so establishes inside its then branch: never zero, never below
 * zero, above zero (both), never NaN or an infinity, or within two literal bounds (and so finite). The first four are
 * facts a term's TypeScript type states; within states an interval, which no type does (scalar/compute/bounds.ts).
 */
export type GuardDesc =
	| { readonly kind: "nonzero" }
	| { readonly kind: "nonnegative" }
	| { readonly kind: "positive" }
	| { readonly kind: "finite" }
	| { readonly kind: "within"; readonly low: LiteralDesc; readonly high: LiteralDesc }

/**
 * Terms and predicates in one vocabulary: one builder serves contract predicates, row checks,
 * query filters and computed outputs. `when` is the one guard of a partial operation: its then branch is computed
 * only where its guard holds of its subject, and every occurrence of the subject there has what the guard establishes.
 */
export type ExprDesc<L = Located, R extends Refs = Spelled> =
	| R["leaf"]
	| ({ readonly kind: "param"; readonly type: R["paramType"] } & R["param"])
	| { readonly kind: "literal"; readonly value: LiteralDesc; readonly type: FieldDesc | undefined }
	| {
			readonly kind: "compute"
			readonly fn: Exclude<ComputeFn, ScaledComputeFn>
			readonly args: ReadonlyArray<ExprDesc<L, R>>
	  }
	| {
			readonly kind: "compute"
			readonly fn: ScaledComputeFn
			readonly args: ReadonlyArray<ExprDesc<L, R>>
			/** round(a, scale) and trunc(a, scale); round(a) and trunc(a) state none. */
			readonly scale: number | undefined
	  }
	| { readonly kind: "cast"; readonly to: FieldDesc; readonly arg: ExprDesc<L, R> }
	| { readonly kind: "base"; readonly arg: ExprDesc<L, R> }
	| {
			readonly kind: "cond"
			readonly pred: ExprDesc<L, R>
			readonly onTrue: ExprDesc<L, R>
			readonly onFalse: ExprDesc<L, R>
	  }
	| {
			readonly kind: "when"
			readonly guard: GuardDesc
			readonly subject: ExprDesc<L, R>
			readonly proved: ExprDesc<L, R>
			readonly otherwise: ExprDesc<L, R>
	  }
	| {
			readonly kind: "compare"
			readonly op: CompareOp
			readonly left: ExprDesc<L, R>
			readonly right: ExprDesc<L, R>
	  }
	| {
			readonly kind: "between"
			readonly arg: ExprDesc<L, R>
			readonly low: ExprDesc<L, R>
			readonly high: ExprDesc<L, R>
	  }
	| {
			readonly kind: "in"
			readonly arg: ExprDesc<L, R>
			readonly values: ReadonlyArray<LiteralDesc>
	  }
	| { readonly kind: "and"; readonly args: NonEmptyReadonlyArray<ExprDesc<L, R>> }
	| { readonly kind: "or"; readonly args: NonEmptyReadonlyArray<ExprDesc<L, R>> }
	| { readonly kind: "not"; readonly arg: ExprDesc<L, R> }
	| {
			readonly kind: "allen"
			readonly left: ExprDesc<L, R>
			readonly mask: number
			readonly right: ExprDesc<L, R>
	  }
	| { readonly kind: "pointIn"; readonly point: ExprDesc<L, R>; readonly span: ExprDesc<L, R> }
	| {
			readonly kind: "absent"
			readonly source: SourceDesc<L, R>
			readonly bindings: BindingsDesc<L, R>
	  }

/** The constant a connective of no operand is, its unit: true for and, false for or. */
const connectiveUnit = (
	kind: "and" | "or"
): { readonly kind: "literal"; readonly value: boolean; readonly type: undefined } => ({
	kind: "literal",
	value: kind === "and",
	type: undefined
})

/**
 * The conjunction or disjunction of `args`, total: of no operand its unit, the constant true or false; of one, that
 * operand; of more, the connective over them. The one constructor of a connective from a list: no and or or holds no
 * operand.
 */
export const connectiveExpr = <L, R extends Refs>(
	kind: "and" | "or",
	args: ReadonlyArray<ExprDesc<L, R>>
): ExprDesc<L, R> => {
	if (!isNonEmpty(args)) {
		return connectiveUnit(kind)
	}
	return args.length === 1 ? headNonEmpty(args) : { kind, args }
}

export type BindingsDesc<L = Located, R extends Refs = Spelled> = Readonly<
	Record<string, ExprDesc<L, R>>
>

/**
 * What an imported query's bind map binds one of its parameters to: a scalar term, or, for a relation parameter, a
 * relation parameter of the importing rule by name.
 */
export type BindTermDesc<L = Located, R extends Refs = Spelled> =
	| ExprDesc<L, R>
	| ({ readonly kind: "relationParam" } & R["param"])

/** An imported query's bind map: each of its parameters bound to what the importer gives it. */
export type BindMapDesc<L = Located, R extends Refs = Spelled> = Readonly<
	Record<string, BindTermDesc<L, R>>
>

/** What `match` consumes. */
export type SourceDesc<L = Located, R extends Refs = Spelled> =
	| { readonly kind: "relation"; readonly name: string }
	| {
			readonly kind: "query"
			readonly query: QueryDesc<L, R["nested"]>
			readonly bind: BindMapDesc<L, R>
	  }
	| ({ readonly kind: "param"; readonly heading: Readonly<Record<string, FieldDesc>> } & R["param"])
	| ({ readonly kind: "paramOf"; readonly relation: string } & R["param"])
	| { readonly kind: "interior"; readonly id: R["interior"] }
	| { readonly kind: "self" }
	| { readonly kind: "delta"; readonly side: "added" | "removed"; readonly relation: string }
	| { readonly kind: "context"; readonly context: ContextDesc }
	| RowSourceDesc

/**
 * The row a write filter's membership is asked at: one fact of `heading`, whose values the membership's caller names
 * (write/entry/render.ts renderMembership); a heading of no field is the unit row. Only a writable entry's filter reads
 * it (schema/entry.ts), and only a check that reads the query as a membership admits it (check/description.ts).
 */
export interface RowSourceDesc {
	readonly kind: "row"
	readonly heading: Readonly<Record<string, FieldDesc>>
}

/**
 * A context: the session's relation parameters, bound once per Db from the verified token, holding at most one fact.
 * Its fields are claims of scalar types only (contextFieldAdmits); `claim` names the nested claim object they are read
 * from, undefined for the payload's own top level. It belongs to no schema, has no laws and is never written.
 */
export interface ContextDesc {
	readonly name: string
	readonly fields: Readonly<Record<string, FieldDesc>>
	readonly claim: string | undefined
}

/**
 * The field types a context admits: text, uuid, boolean, the integer types, a contract over one of them, and a closed
 * handle. A claim is a JSON scalar, read back through its field's cast.
 */
export const contextFieldAdmits = (desc: FieldDesc): boolean => {
	switch (desc.kind) {
		case "pg":
			return (
				desc.type === "smallint" ||
				desc.type === "integer" ||
				desc.type === "bigint" ||
				desc.type === "boolean"
			)
		case "uuid":
		case "text":
		case "closedId":
			return true
		case "contract":
			return contextFieldAdmits(desc.base)
		case "numeric":
		case "serial":
		case "span":
		case "vector":
			return false
	}
}

export type VarDesc<L = Located> = L & {
	/** The allocated VarId spelling; fingerprints rename it away. */
	readonly id: string
	/**
	 * The relation and field v took it from, which the checker names the variable's column by; undefined for a fresh
	 * variable.
	 */
	readonly origin: { readonly relation: string; readonly field: string } | undefined
}

export type MatchDesc<L = Located, R extends Refs = Spelled> = L & {
	readonly source: SourceDesc<L, R>
	readonly bindings: BindingsDesc<L, R>
}

export type HeadTermDesc<L = Located, R extends Refs = Spelled> =
	| ExprDesc<L, R>
	| { readonly kind: "aggregate"; readonly fn: "count" }
	| {
			readonly kind: "aggregate"
			readonly fn: "sum" | "mean" | "min" | "max"
			readonly arg: ExprDesc<L, R>
	  }
	| ProducerDesc<L, R>

/** A span producer in a head: pack over one span term, intersection and difference over two. */
export type ProducerDesc<L = Located, R extends Refs = Spelled> =
	| { readonly kind: "producer"; readonly fn: "pack"; readonly args: readonly [ExprDesc<L, R>] }
	| {
			readonly kind: "producer"
			readonly fn: "intersection" | "difference"
			readonly args: readonly [ExprDesc<L, R>, ExprDesc<L, R>]
	  }

/** A producer with each argument mapped by `f`, keeping its arity. */
export const mapProducer = <L, M, R1 extends Refs, R2 extends Refs>(
	p: ProducerDesc<L, R1>,
	f: (e: ExprDesc<L, R1>) => ExprDesc<M, R2>
): ProducerDesc<M, R2> =>
	p.fn === "pack"
		? { kind: "producer", fn: p.fn, args: [f(p.args[0])] }
		: { kind: "producer", fn: p.fn, args: [f(p.args[0]), f(p.args[1])] }

export interface InteriorDesc<L = Located, R extends Refs = Spelled> {
	readonly id: string
	readonly arms: NonEmptyReadonlyArray<RuleDesc<L, R>>
}

export type AttachDesc<L = Located, R extends Refs = Spelled> = L & {
	readonly name: string
	readonly child: QueryDesc<L, R>
}

export type RuleDesc<L = Located, R extends Refs = Spelled> = L & {
	readonly vars: ReadonlyArray<VarDesc<L>>
	readonly matches: ReadonlyArray<MatchDesc<L, R>>
	readonly where: ReadonlyArray<ExprDesc<L, R>>
	readonly head: Readonly<Record<string, HeadTermDesc<L, R>>>
	readonly interiors: ReadonlyArray<InteriorDesc<L, R["nested"]>>
	/** Finished.attach: attachments an arm makes before it joins a union. */
	readonly attach: ReadonlyArray<AttachDesc<L, R["nested"]>>
}

export interface OrderDesc {
	readonly column: string
	readonly dir: "asc" | "desc"
}

export type TakeDesc<R extends Refs = Spelled> =
	| { readonly kind: "literal"; readonly k: number }
	| ({ readonly kind: "param" } & R["param"])

export interface RecursiveDesc<L = Located, R extends Refs = Spelled> {
	readonly name: string
	readonly row: Readonly<Record<string, FieldDesc>>
	readonly base: NonEmptyReadonlyArray<RuleDesc<L, R>>
	readonly rec: NonEmptyReadonlyArray<RuleDesc<L, R>>
}

/**
 * A query is the chain of combinators that built it, in the order they were applied, so that a
 * description rebuilds the same query through queryFromDescription. Each stage but the first names
 * the stage it was applied to as `input`:
 *
 * - rules: query(S).rule(a).rule(b), the arms of the builder's rules; recursive: query(S).recursive(name, spec);
 * - union: Query.rule on any other query, its arms beside that query's rows, whatever its heading (a heterogeneous
 *   union, checked for a discriminant by the compiler): after a take, an attachment, a name, an approximation or a
 *   recursive definition;
 * - attach, named and approx: Query.attach, Query.named and Query.approximateNearest;
 * - order: Query.orderBy, which makes an Ordered; take: Ordered.take, whose input is always an order stage and which
 *   makes a Query again.
 *
 * An Ordered has no combinator but take, so no stage other than take reads an order stage. A query as a whole is an
 * Ordered exactly when its last stage is an order stage. Consecutive rule calls on the builder are one rules stage.
 *
 * Every stage but attach, which is located at its attach entry, carries its location.
 */
export type QueryStageDesc<L = Located, R extends Refs = Spelled> =
	| (L & { readonly kind: "rules"; readonly arms: NonEmptyReadonlyArray<RuleDesc<L, R>> })
	| (L & { readonly kind: "recursive"; readonly recursive: RecursiveDesc<L, R> })
	| (L & {
			readonly kind: "union"
			readonly input: QueryStageDesc<L, R>
			readonly arms: NonEmptyReadonlyArray<RuleDesc<L, R>>
	  })
	| {
			readonly kind: "attach"
			readonly input: QueryStageDesc<L, R>
			readonly attach: AttachDesc<L, R>
	  }
	| (L & { readonly kind: "named"; readonly input: QueryStageDesc<L, R>; readonly name: string })
	| (L & {
			readonly kind: "order"
			readonly input: QueryStageDesc<L, R>
			readonly order: ReadonlyArray<OrderDesc>
	  })
	| (L & {
			readonly kind: "take"
			readonly input: QueryStageDesc<L, R>
			readonly take: TakeDesc<R>
	  })
	| (L & {
			readonly kind: "approx"
			readonly input: QueryStageDesc<L, R>
			readonly by: string
			readonly take: number
	  })

/** A versioned query or ordered query. */
export interface QueryDesc<L = Located, R extends Refs = Spelled> {
	readonly stage: QueryStageDesc<L, R>
}

/**
 * Whether a query is an Ordered (orderBy without take), which only attach, read-backs, readers and the workload accept.
 */
export const isOrderedQuery = <L>(q: QueryDesc<L>): boolean => q.stage.kind === "order"

export interface SideDesc {
	readonly relation: string
	readonly fields: NonEmptyReadonlyArray<string>
	/** The side's selected fields and their literals: empty for a side that selects nothing. */
	readonly selection: Readonly<Record<string, LiteralDesc>>
}

/** What a capacity weighs each source fact by: one each, a field's value, or the width of a span field. */
export type WeightDesc =
	| { readonly kind: "count" }
	| { readonly kind: "field"; readonly field: string }
	| { readonly kind: "duration"; readonly field: string }

export type BoundValueDesc = bigint | { readonly ref: string }

export interface BoundDesc {
	readonly low: BoundValueDesc
	readonly high: BoundValueDesc | "*"
}

/**
 * The alternatives expansion a contained or mirrors statement came from, or undefined for one declared directly; only
 * an alternatives expansion's members carry one.
 */
type StatementOrigin = { readonly alternatives: string } | undefined

export type StatementDesc<L = Located> = L &
	(
		| {
				readonly kind: "key"
				readonly relation: string
				readonly fields: NonEmptyReadonlyArray<string>
		  }
		| { readonly kind: "mutable"; readonly relation: string }
		| {
				readonly kind: "check"
				readonly name: string
				readonly relation: string
				readonly predicate: ExprDesc<L>
		  }
		| {
				readonly kind: "contained"
				readonly left: SideDesc
				readonly right: SideDesc
				readonly origin: StatementOrigin
		  }
		| {
				readonly kind: "mirrors"
				readonly left: SideDesc
				readonly right: SideDesc
				readonly origin: StatementOrigin
		  }
		| {
				readonly kind: "capacity"
				readonly target: SideDesc
				readonly from: SideDesc
				readonly weight: WeightDesc
				readonly within: BoundDesc
		  }
	)

export type RelationDesc<L = Located> = L &
	(
		| {
				readonly kind: "relation"
				readonly name: string
				readonly fields: Readonly<Record<string, FieldDesc>>
				readonly primaryKey: readonly [string, ...Array<string>]
		  }
		| {
				readonly kind: "closed"
				readonly name: string
				readonly handles: NonEmptyReadonlyArray<string>
				readonly payload: Readonly<Record<string, FieldDesc>>
				readonly facts: Readonly<Record<string, Readonly<Record<string, LiteralDesc>>>>
		  }
		| {
				readonly kind: "derived"
				readonly name: string
				readonly query: QueryDesc<L>
				/** The derived level: 1 over base relations, n + 1 over a level-n derived relation. */
				readonly level: number
		  }
	)

export type SchemaDesc<L = Located> = L & {
	readonly name: string
	readonly relations: ReadonlyArray<RelationDesc<L>>
	readonly statements: ReadonlyArray<StatementDesc<L>>
	/** schema.extend: the base schema, under the same name. */
	readonly extends: SchemaDesc<L> | undefined
}

/**
 * Worlds. A role is a schema whose relations are defined over its base: each entry is a whole relation of the base
 * under its own name, or a world relation, a query over the base installed as a plain view. `write` and `refresh` name
 * role relations. A login is one credential and one pool for roles over one base.
 */
export type RoleEntryDesc<L = Located> =
	| (L & { readonly kind: "whole"; readonly name: string })
	| (L & { readonly kind: "world"; readonly name: string; readonly query: QueryDesc<L> })

export type RoleDesc<L = Located> = L & {
	readonly name: string
	readonly base: SchemaDesc<L>
	readonly relations: NonEmptyReadonlyArray<RoleEntryDesc<L>>
	readonly write: ReadonlyArray<string>
	readonly refresh: ReadonlyArray<string>
}

export type LoginDesc<L = Located> = L & {
	readonly name: string
	readonly base: SchemaDesc<L>
	readonly roles: NonEmptyReadonlyArray<RoleDesc<L>>
}

/**
 * ChangeSets. An array or Stream member names the slot its facts travel in; the facts are values,
 * outside the Description and outside template identity.
 */
type MemberSourceDesc<L = Located> =
	| { readonly kind: "array"; readonly slot: string }
	| { readonly kind: "stream"; readonly slot: string }
	| { readonly kind: "query"; readonly query: QueryDesc<L> }

export type MemberDesc<L = Located> = L & {
	readonly op: "insert" | "delete" | "put"
	readonly relation: string
	readonly member: MemberSourceDesc<L>
}

export interface ReadBackDesc<L = Located> {
	readonly name: string
	readonly query: QueryDesc<L>
}

export interface ChangeSetDesc<L = Located> {
	readonly schema: string
	/** One stratum unless built with ChangeSet.sequence. */
	readonly strata: ReadonlyArray<{ readonly members: ReadonlyArray<MemberDesc<L>> }>
	readonly reads: ReadonlyArray<ReadBackDesc<L>>
	/** The parameters ChangeSet.bind closed; their values travel with the ChangeSet value. */
	readonly bindings: ReadonlyArray<string>
}

export type ProgramDesc<L = Located> =
	| { readonly kind: "query"; readonly query: QueryDesc<L> }
	| { readonly kind: "changeSet"; readonly changeSet: ChangeSetDesc<L> }

/** The exported query workload. */
export interface WorkloadDesc<L = Located> {
	readonly schema: string
	readonly programs: Readonly<Record<string, ProgramDesc<L>>>
}

/**
 * How a walk over a query description's parameters spells each reference: `param` spells a reference of one
 * namespace by its name, and `imported` is the namespace of an imported query the walk reaches, whose parameters are
 * its own and never its importer's.
 */
export interface ParamSpelling<P extends object> {
	readonly param: (name: string) => P
	readonly imported: () => ParamSpelling<P>
}

class ParamWalk<P extends object> {
	readonly #spelling: ParamSpelling<P>

	constructor(spelling: ParamSpelling<P>) {
		this.#spelling = spelling
	}

	query(q: QueryDesc): QueryDesc<Located, ParamsAs<P>> {
		return { ...q, stage: this.stage(q.stage) }
	}

	stage(s: QueryStageDesc): QueryStageDesc<Located, ParamsAs<P>> {
		switch (s.kind) {
			case "rules":
				return { ...s, arms: mapNonEmpty(s.arms, (r) => this.rule(r)) }
			case "recursive":
				return {
					...s,
					recursive: {
						...s.recursive,
						base: mapNonEmpty(s.recursive.base, (r) => this.rule(r)),
						rec: mapNonEmpty(s.recursive.rec, (r) => this.rule(r))
					}
				}
			case "union":
				return { ...s, input: this.stage(s.input), arms: mapNonEmpty(s.arms, (r) => this.rule(r)) }
			case "attach":
				return {
					...s,
					input: this.stage(s.input),
					attach: { ...s.attach, child: this.query(s.attach.child) }
				}
			case "named":
			case "order":
			case "approx":
				return { ...s, input: this.stage(s.input) }
			case "take":
				return {
					...s,
					input: this.stage(s.input),
					take:
						s.take.kind === "param"
							? { kind: "param", ...this.#spelling.param(s.take.name) }
							: s.take
				}
		}
	}

	rule(r: RuleDesc): RuleDesc<Located, ParamsAs<P>> {
		return {
			...r,
			matches: r.matches.map((m) => ({
				...m,
				source: this.source(m.source),
				bindings: this.bindings(m.bindings)
			})),
			where: r.where.map((e) => this.expr(e)),
			head: Object.fromEntries(Object.entries(r.head).map(([k, h]) => [k, this.head(h)])),
			interiors: r.interiors.map((i) => ({ ...i, arms: mapNonEmpty(i.arms, (a) => this.rule(a)) })),
			attach: r.attach.map((a) => ({ ...a, child: this.query(a.child) }))
		}
	}

	bindings(b: BindingsDesc): BindingsDesc<Located, ParamsAs<P>> {
		return Object.fromEntries(Object.entries(b).map(([k, e]) => [k, this.expr(e)]))
	}

	bound(b: BindTermDesc): BindTermDesc<Located, ParamsAs<P>> {
		return b.kind === "relationParam"
			? { kind: "relationParam", ...this.#spelling.param(b.name) }
			: this.expr(b)
	}

	/** An imported query is its own namespace; only its bind map is read in this one. */
	source(s: SourceDesc): SourceDesc<Located, ParamsAs<P>> {
		switch (s.kind) {
			case "query":
				return {
					...s,
					query: new ParamWalk(this.#spelling.imported()).query(s.query),
					bind: Object.fromEntries(Object.entries(s.bind).map(([k, b]) => [k, this.bound(b)]))
				}
			case "param":
				return { kind: "param", heading: s.heading, ...this.#spelling.param(s.name) }
			case "paramOf":
				return { kind: "paramOf", relation: s.relation, ...this.#spelling.param(s.name) }
			case "relation":
			case "interior":
			case "self":
			case "delta":
			case "context":
			case "row":
				return s
		}
	}

	head(h: HeadTermDesc): HeadTermDesc<Located, ParamsAs<P>> {
		if (h.kind === "aggregate") {
			return h.fn === "count"
				? { kind: "aggregate", fn: h.fn }
				: { kind: "aggregate", fn: h.fn, arg: this.expr(h.arg) }
		}
		return h.kind === "producer" ? mapProducer(h, (e) => this.expr(e)) : this.expr(h)
	}

	expr(e: ExprDesc): ExprDesc<Located, ParamsAs<P>> {
		switch (e.kind) {
			case "param":
				return { kind: "param", type: e.type, ...this.#spelling.param(e.name) }
			case "var":
			case "field":
			case "value":
			case "parent":
			case "literal":
				return e
			case "compute":
				return { ...e, args: e.args.map((a) => this.expr(a)) }
			case "cast":
			case "base":
			case "not":
			case "in":
				return { ...e, arg: this.expr(e.arg) }
			case "cond":
				return {
					...e,
					pred: this.expr(e.pred),
					onTrue: this.expr(e.onTrue),
					onFalse: this.expr(e.onFalse)
				}
			case "when":
				return {
					...e,
					subject: this.expr(e.subject),
					proved: this.expr(e.proved),
					otherwise: this.expr(e.otherwise)
				}
			case "compare":
				return { ...e, left: this.expr(e.left), right: this.expr(e.right) }
			case "between":
				return { ...e, arg: this.expr(e.arg), low: this.expr(e.low), high: this.expr(e.high) }
			case "and":
			case "or":
				return { ...e, args: mapNonEmpty(e.args, (a) => this.expr(a)) }
			case "allen":
				return { ...e, left: this.expr(e.left), right: this.expr(e.right) }
			case "pointIn":
				return { ...e, point: this.expr(e.point), span: this.expr(e.span) }
			case "absent":
				return { ...e, source: this.source(e.source), bindings: this.bindings(e.bindings) }
		}
	}
}

/**
 * The one walk over a query description's parameters: the description with each parameter reference spelled by
 * `spelling`, in walk order, every other part unchanged.
 *
 * The walk follows the query's own rules, attachments, interiors and recursive arms, which share the query's
 * parameters. An imported query is its own namespace (`spelling.imported`): its parameters are bound by its bind map,
 * whose terms alone are the importer's. A take bound to a parameter and a relation parameter are parameters too; a
 * delta source is none, since it exists only inside the ChangeSet that defines it.
 */
export const mapQueryParams = <P extends object>(
	q: QueryDesc,
	spelling: ParamSpelling<P>
): QueryDesc<Located, ParamsAs<P>> => new ParamWalk(spelling).query(q)

/** A namespace spelled as it is: an imported query's, for a walk that reads only its importer's. */
const spelledAsIs: ParamSpelling<Spelled["param"]> = {
	param: (name) => ({ name }),
	imported: () => spelledAsIs
}

/**
 * The parameters a query description needs, by name, in walk order (mapQueryParams): a checked query's parameters are
 * exactly these, since the checker reads the cells the same walk mints (check/params.ts); a ChangeSet's are one
 * namespace, the union of its members' and read-backs', which ChangeSet.bind closes and the ChangeSet decoder's binding
 * check reads (changeSetDescShape).
 */
export const queryParamNames = (q: QueryDesc): ReadonlySet<string> => {
	const names = new Set<string>()
	mapQueryParams(q, {
		param: (name) => {
			names.add(name)
			return { name }
		},
		imported: () => spelledAsIs
	})
	return names
}

/**
 * The query with each of its own parameter uses whose name `rename` maps spelled by its image (mapQueryParams): an
 * imported query keeps its own parameters, and only the terms of its bind map are renamed. ChangeSet.bind uses it to
 * move a bound name out of the ChangeSet's namespace.
 */
export const renameQueryParams = (q: QueryDesc, rename: ReadonlyMap<string, string>): QueryDesc =>
	rename.size === 0
		? q
		: mapQueryParams(q, {
				param: (name) => ({ name: rename.get(name) ?? name }),
				imported: () => spelledAsIs
			})

/** A declared name: a nonempty string of storable text (core/text.ts), as every builder takes one. */
const name = S.refine(S.nonEmptyString, isValidText, "a nonempty storable string")
const loc = { loc: S.sourceLoc } as const

const integerOrBigint = S.unionShape(S.integer, S.bigint)

const decimalShape = S.canonicalTagged(
	decimalTag,
	isDecimalPayload,
	"an exact decimal (canonical tag d)"
)

const moneyShape = S.canonicalTagged(
	moneyTag,
	isMoneyPayload,
	"a Money in minor units (canonical tag m)"
)

const vectorShape = S.canonicalTagged(
	vectorTag,
	isVectorPayload,
	"a Vector of binary32 components (canonical tag v)"
)

export const literalDescShape: S.Shape<LiteralDesc> = S.unionShape(
	S.string,
	S.finiteNumber,
	S.boolean,
	S.bigint,
	decimalShape,
	moneyShape,
	vectorShape,
	S.struct({ span: S.struct({ start: integerOrBigint, end: integerOrBigint }) }),
	S.struct({ float: S.literalsShape(["NaN", "Infinity", "-Infinity"]) })
)

const regexFlags = S.literalsShape(["u", "su"])

const fieldDescShape: S.Shape<FieldDesc> = S.lazy("a field descriptor", () =>
	S.tagged("kind", {
		pg: S.struct({ type: S.literalsShape(pgScalarNames) }),
		numeric: S.normalized(
			S.refine(
				S.structWith({}, { precision: S.integer, scale: S.integer }),
				(f) =>
					(f.scale === undefined || f.precision !== undefined) &&
					(f.precision === undefined || (f.precision >= 1 && f.precision <= 1000)) &&
					(f.scale === undefined || (f.scale >= -1000 && f.scale <= 1000)),
				"numeric(p, s) with p in 1..1000 and s in -1000..1000, a scale only with a precision"
			),
			(f) => (f.precision === undefined ? {} : { precision: f.precision, scale: f.scale ?? 0 })
		),
		serial: S.struct({ type: S.literalsShape(["smallserial", "serial", "bigserial"]) }),
		uuid: S.struct({}),
		text: S.struct({ source: S.string, flags: regexFlags }),
		contract: S.structStated(
			{
				name,
				base: fieldDescShape,
				facts: S.refine(
					S.uniqueArray(S.literalsShape(factNames), (f) => f, "facts"),
					factsSorted,
					"a contract's facts sorted, each once"
				)
			},
			{ predicate: exprDescShape },
			{}
		),
		span: S.structStated(
			{ endpoint: fieldDescShape },
			{ width: S.refine(S.bigint, (w) => w > 0n, "a positive span width") },
			{}
		),
		closedId: S.struct({ roster: name }),
		vector: S.struct({
			dimensions: S.refine(S.positiveInteger, (n) => n <= 16000, "1..16000 dimensions")
		})
	})
)

const bindingsDescShape: S.Shape<BindingsDesc> = S.lazy("bindings", () =>
	S.recordShape(exprDescShape, S.nonEmptyString)
)

const bindMapDescShape: S.Shape<BindMapDesc> = S.lazy("a bind map", () =>
	S.recordShape(bindTermDescShape, S.nonEmptyString)
)

/**
 * A compute decodes by the function it names, so a scale on a function other than round and trunc is refused at its
 * own path.
 */
const computeArgs = {
	args: S.nonEmptyArray(S.lazy("an expression", (): S.Shape<ExprDesc> => exprDescShape))
} as const
const unscaledCompute = S.struct(computeArgs)
const scaledCompute = S.structStated(computeArgs, { scale: S.integer }, {})
/**
 * Each compute function's decoder: round and trunc take a scale, every other function none. Total over ComputeFn,
 * and its type fixes each entry, so a new function is decoded where it is added.
 */
const computeCases: {
	readonly [F in ComputeFn]: F extends ScaledComputeFn
		? typeof scaledCompute
		: typeof unscaledCompute
} = {
	add: unscaledCompute,
	sub: unscaledCompute,
	mul: unscaledCompute,
	div: unscaledCompute,
	mod: unscaledCompute,
	neg: unscaledCompute,
	quot: unscaledCompute,
	rem: unscaledCompute,
	abs: unscaledCompute,
	sign: unscaledCompute,
	round: scaledCompute,
	trunc: scaledCompute,
	ceil: unscaledCompute,
	floor: unscaledCompute,
	gcd: unscaledCompute,
	lcm: unscaledCompute,
	power: unscaledCompute,
	sqrt: unscaledCompute,
	least: unscaledCompute,
	greatest: unscaledCompute,
	widthBucket: unscaledCompute,
	minScale: unscaledCompute,
	lower: unscaledCompute,
	upper: unscaledCompute,
	width: unscaledCompute,
	charLength: unscaledCompute,
	cosineDistance: unscaledCompute
}

const exprCases = {
	var: S.struct({ var: name }),
	field: S.struct({ field: name }),
	value: S.struct({}),
	parent: S.struct({ column: name }),
	param: S.struct({ name, type: S.lazy("a field descriptor", () => fieldDescShape) }),
	literal: S.structStated(
		{ value: literalDescShape },
		{ type: S.lazy("a field descriptor", () => fieldDescShape) },
		{}
	),
	compute: S.tagged("fn", computeCases),
	cast: S.struct({
		to: S.lazy("a field descriptor", () => fieldDescShape),
		arg: S.lazy("an expression", () => exprDescShape)
	}),
	base: S.struct({ arg: S.lazy("an expression", () => exprDescShape) }),
	cond: S.struct({
		pred: S.lazy("an expression", () => exprDescShape),
		onTrue: S.lazy("an expression", () => exprDescShape),
		onFalse: S.lazy("an expression", () => exprDescShape)
	}),
	when: S.struct({
		guard: S.tagged("kind", {
			nonzero: S.struct({}),
			nonnegative: S.struct({}),
			positive: S.struct({}),
			finite: S.struct({}),
			within: S.struct({ low: literalDescShape, high: literalDescShape })
		}),
		subject: S.lazy("an expression", () => exprDescShape),
		proved: S.lazy("an expression", () => exprDescShape),
		otherwise: S.lazy("an expression", () => exprDescShape)
	}),
	compare: S.struct({
		op: S.literalsShape(compareOps),
		left: S.lazy("an expression", () => exprDescShape),
		right: S.lazy("an expression", () => exprDescShape)
	}),
	between: S.struct({
		arg: S.lazy("an expression", () => exprDescShape),
		low: S.lazy("an expression", () => exprDescShape),
		high: S.lazy("an expression", () => exprDescShape)
	}),
	in: S.struct({
		arg: S.lazy("an expression", () => exprDescShape),
		values: S.array(literalDescShape)
	}),
	and: S.struct({ args: S.array(S.lazy("an expression", () => exprDescShape)) }),
	or: S.struct({ args: S.array(S.lazy("an expression", () => exprDescShape)) }),
	not: S.struct({ arg: S.lazy("an expression", () => exprDescShape) }),
	allen: S.struct({
		left: S.lazy("an expression", () => exprDescShape),
		mask: S.refine(S.integer, (m) => m >= 1 && m <= 8191, "an Allen mask in 1..8191"),
		right: S.lazy("an expression", () => exprDescShape)
	}),
	pointIn: S.struct({
		point: S.lazy("an expression", () => exprDescShape),
		span: S.lazy("an expression", () => exprDescShape)
	}),
	absent: S.struct({
		source: S.lazy("a source", () => sourceDescShape),
		bindings: bindingsDescShape
	})
} as const

/**
 * An expression as the decoder reads it, before it parses a connective: an and or or of any number of operands, which
 * unitWhenEmpty parses into the expression it is.
 */
type ReadExpr =
	| Exclude<ExprDesc, { readonly kind: "and" | "or" }>
	| { readonly kind: "and"; readonly args: ReadonlyArray<ExprDesc> }
	| { readonly kind: "or"; readonly args: ReadonlyArray<ExprDesc> }

/** A head term as the decoder reads it: a read expression, an aggregate or a producer. */
type ReadHead = ReadExpr | Exclude<HeadTermDesc, ExprDesc>

/**
 * A connective of operands as such, and an empty one as what its builder builds (connectiveExpr): its unit, the
 * constant true or false.
 */
const unitWhenEmpty = (e: ReadExpr): ExprDesc => {
	if (e.kind !== "and" && e.kind !== "or") {
		return e
	}
	const args = e.args
	return isNonEmpty(args) ? { kind: e.kind, args } : connectiveUnit(e.kind)
}

const exprDescShape: S.Shape<ExprDesc> = S.lazy("an expression", () =>
	S.normalized<ReadExpr, ExprDesc>(S.tagged("kind", exprCases), unitWhenEmpty)
)

/** A bind map's binding as the decoder reads it: a read expression, or a relation parameter by name. */
type ReadBound = ReadExpr | Exclude<BindTermDesc, ExprDesc>

const bindTermDescShape: S.Shape<BindTermDesc> = S.normalized<ReadBound, BindTermDesc>(
	S.tagged("kind", { ...exprCases, relationParam: S.struct({ name }) }),
	(b) => (b.kind === "relationParam" ? b : unitWhenEmpty(b))
)

const headTermDescShape: S.Shape<HeadTermDesc> = S.normalized<ReadHead, HeadTermDesc>(
	S.tagged("kind", {
		...exprCases,
		aggregate: S.unionShape(
			S.struct({ fn: S.literalsShape(["count"]) }),
			S.struct({ fn: S.literalsShape(["sum", "mean", "min", "max"]), arg: exprDescShape })
		),
		producer: S.unionShape(
			S.struct({ fn: S.literalsShape(["pack"]), args: S.single(exprDescShape) }),
			S.struct({
				fn: S.literalsShape(["intersection", "difference"]),
				args: S.pairShape(exprDescShape)
			})
		)
	}),
	(h) => (h.kind === "aggregate" || h.kind === "producer" ? h : unitWhenEmpty(h))
)

const fieldMapShape = S.recordShape(fieldDescShape, name)

const contextDescShape: S.Shape<ContextDesc> = S.structStated(
	{
		name,
		fields: S.refine(
			fieldMapShape,
			(f) => Object.keys(f).length > 0 && Object.values(f).every(contextFieldAdmits),
			"a context of at least one field, each text, uuid, boolean, an integer type, a contract over one, or a closed handle"
		)
	},
	{ claim: name },
	{}
)

const sourceDescShape: S.Shape<SourceDesc> = S.lazy("a source", () =>
	S.tagged("kind", {
		relation: S.struct({ name }),
		/** An import that binds nothing has the empty binding, however it was spelled. */
		query: S.normalized(
			S.structWith(
				{ query: S.lazy("a query description", () => unorderedQueryShape) },
				{ bind: bindMapDescShape }
			),
			(q) => ({ query: q.query, bind: q.bind ?? {} })
		),
		param: S.struct({
			name,
			heading: S.refine(
				fieldMapShape,
				(f) => Object.keys(f).length > 0,
				"a relation parameter of at least one field"
			)
		}),
		paramOf: S.struct({ name, relation: name }),
		interior: S.struct({ id: name }),
		self: S.struct({}),
		delta: S.struct({ side: S.literalsShape(["added", "removed"]), relation: name }),
		context: S.struct({ context: S.lazy("a context description", () => contextDescShape) }),
		row: S.struct({ heading: fieldMapShape })
	})
)

const varDescShape: S.Shape<VarDesc> = S.located(
	S.structStated({ id: name }, { origin: S.struct({ relation: name, field: name }) }, loc)
)

const matchDescShape: S.Shape<MatchDesc> = S.located(
	S.structWith({ source: sourceDescShape, bindings: bindingsDescShape }, loc)
)

const attachDescShape: S.Shape<AttachDesc> = S.located(
	S.structWith({ name, child: S.lazy("a query description", () => queryDescShape) }, loc)
)

const ruleDescShape: S.Shape<RuleDesc> = S.lazy("a rule", () =>
	S.located(
		S.structWith(
			{
				vars: S.uniqueArray(varDescShape, (v) => v.id, "variable ids"),
				matches: S.array(matchDescShape),
				where: S.array(exprDescShape),
				head: S.recordShape(headTermDescShape, S.nonEmptyString),
				interiors: S.uniqueArray(
					S.struct({ id: name, arms: S.nonEmptyArray(ruleDescShape) }),
					(i) => i.id,
					"interior ids"
				),
				attach: S.uniqueArray(attachDescShape, (a) => a.name, "attachment names")
			},
			loc
		)
	)
)

const orderDescShape: S.Shape<OrderDesc> = S.struct({
	column: name,
	dir: S.literalsShape(["asc", "desc"])
})

const takeDescShape: S.Shape<TakeDesc> = S.tagged("kind", {
	literal: S.struct({ k: S.positiveInteger }),
	param: S.struct({ name })
})

const recursiveDescShape: S.Shape<RecursiveDesc> = S.struct({
	name,
	row: S.refine(
		fieldMapShape,
		(r) => Object.keys(r).length > 0,
		"a recursive row with at least one field"
	),
	base: S.nonEmptyArray(ruleDescShape),
	rec: S.nonEmptyArray(ruleDescShape)
})

const notOrdered = <A extends { readonly input: QueryStageDesc }>(
	shape: S.Shape<A>,
	what: string
): S.Shape<A> =>
	S.refine(
		shape,
		(stage) => stage.input.kind !== "order",
		`${what} applied to a Query, not an Ordered`
	)

const stageInput = S.lazy("a query stage", () => queryStageShape)
const arms = S.nonEmptyArray(ruleDescShape)

const queryStageShape: S.Shape<QueryStageDesc> = S.lazy("a query stage", () =>
	S.tagged("kind", {
		rules: S.located(S.structWith({ arms }, loc)),
		recursive: S.located(S.structWith({ recursive: recursiveDescShape }, loc)),
		union: S.refine(
			notOrdered(S.located(S.structWith({ input: stageInput, arms }, loc)), "rule"),
			(u) => u.input.kind !== "rules",
			"a union over a query other than the builder's rules; consecutive rule calls are one rules stage"
		),
		attach: notOrdered(S.struct({ input: stageInput, attach: attachDescShape }), "attach"),
		named: notOrdered(S.located(S.structWith({ input: stageInput, name }, loc)), "named"),
		order: notOrdered(
			S.located(
				S.structWith(
					{
						input: stageInput,
						order: S.refine(
							S.uniqueArray(orderDescShape, (o) => o.column, "order columns"),
							(o) => o.length > 0,
							"a nonempty order"
						)
					},
					loc
				)
			),
			"orderBy"
		),
		take: S.refine(
			S.located(S.structWith({ input: stageInput, take: takeDescShape }, loc)),
			(t) => t.input.kind === "order",
			"take applied to an Ordered, the result of orderBy"
		),
		approx: notOrdered(
			S.located(S.structWith({ input: stageInput, by: name, take: S.positiveInteger }, loc)),
			"approximateNearest"
		)
	})
)

const queryDescShape: S.Shape<QueryDesc> = S.lazy("a query description", () =>
	S.struct({ stage: queryStageShape })
)

/** A query that is a Query, not an Ordered: a match source, a ChangeSet member, a derived definition. */
const unorderedQueryShape: S.Shape<QueryDesc> = S.refine(
	queryDescShape,
	(q) => !isOrderedQuery(q),
	"a Query, not an Ordered: only take makes an ordered query a set again"
)

/** A side that selects nothing has the empty selection, however it was spelled. */
const sideDescShape: S.Shape<SideDesc> = S.normalized(
	S.structWith(
		{ relation: name, fields: S.nonEmptyUniqueStrings("side fields") },
		{ selection: S.recordShape(literalDescShape, S.nonEmptyString) }
	),
	(side) => ({ relation: side.relation, fields: side.fields, selection: side.selection ?? {} })
)

const boundValueShape: S.Shape<BoundValueDesc> = S.unionShape(
	S.refine(S.bigint, (n) => n >= 0n, "a nonnegative bound"),
	S.struct({ ref: name })
)

const statementOrigin = { origin: S.struct({ alternatives: name }) } as const

/** A contained or mirrors statement's fields: two sides and the alternatives expansion it came from, if any. */
const sideLinkShape = S.located(
	S.structStated({ left: sideDescShape, right: sideDescShape }, statementOrigin, loc)
)

const statementDescShape: S.Shape<StatementDesc> = S.tagged("kind", {
	key: S.located(
		S.structWith({ relation: name, fields: S.nonEmptyUniqueStrings("key fields") }, loc)
	),
	mutable: S.located(S.structWith({ relation: name }, loc)),
	check: S.located(S.structWith({ name, relation: name, predicate: exprDescShape }, loc)),
	contained: sideLinkShape,
	mirrors: sideLinkShape,
	capacity: S.located(
		S.structWith(
			{
				target: sideDescShape,
				from: sideDescShape,
				weight: S.tagged("kind", {
					count: S.struct({}),
					field: S.struct({ field: name }),
					duration: S.struct({ field: name })
				}),
				within: S.struct({
					low: boundValueShape,
					high: S.unionShape(S.literalsShape(["*"]), boundValueShape)
				})
			},
			loc
		)
	)
})

const relationDescShape: S.Shape<RelationDesc> = S.tagged("kind", {
	relation: S.located(
		S.refine(
			S.structWith(
				{
					name,
					fields: S.refine(
						fieldMapShape,
						(f) => Object.keys(f).length > 0,
						"a relation with at least one field"
					),
					primaryKey: S.nonEmptyUniqueStrings("primary key fields")
				},
				loc
			),
			(r) => r.primaryKey.every((f) => Object.hasOwn(r.fields, f)),
			"a primary key over the relation's own fields"
		)
	),
	closed: S.located(
		S.refine(
			S.structWith(
				{
					name,
					handles: S.nonEmptyUniqueStrings("handles"),
					payload: fieldMapShape,
					facts: S.recordShape(S.recordShape(literalDescShape, S.nonEmptyString), S.nonEmptyString)
				},
				loc
			),
			(c) => {
				const payload = Object.keys(c.payload).toSorted(compareStrings)
				const facts = Object.entries(c.facts)
				if (!facts.every(([h]) => c.handles.includes(h))) {
					return false
				}
				if (payload.length > 0 && facts.length !== c.handles.length) {
					return false
				}
				if (Object.hasOwn(c.payload, "id")) {
					return false
				}
				return facts.every(([, fields]) => {
					const fact = Object.keys(fields).toSorted(compareStrings)
					return fact.length === payload.length && fact.every((f, i) => f === payload[i])
				})
			},
			"one fact per handle with exactly the payload fields, and no payload field named id"
		)
	),
	derived: S.located(
		S.structWith({ name, query: unorderedQueryShape, level: S.positiveInteger }, loc)
	)
})

const schemaDescShape: S.Shape<SchemaDesc> = S.lazy("a schema description", () =>
	S.located(
		S.structStated(
			{
				name,
				relations: S.uniqueArray(relationDescShape, (r) => r.name, "relation names"),
				statements: S.array(statementDescShape)
			},
			{ extends: schemaDescShape },
			loc
		)
	)
)

const roleEntryDescShape: S.Shape<RoleEntryDesc> = S.tagged("kind", {
	whole: S.located(S.structWith({ name }, loc)),
	world: S.located(S.structWith({ name, query: unorderedQueryShape }, loc))
})

const roleDescShape: S.Shape<RoleDesc> = S.located(
	S.structWith(
		{
			name,
			base: schemaDescShape,
			relations: S.nonEmptyUniqueArray(roleEntryDescShape, (e) => e.name, "role relation names"),
			write: S.uniqueStrings("written relations", name),
			refresh: S.uniqueStrings("refreshed relations", name)
		},
		loc
	)
)

const loginDescShape: S.Shape<LoginDesc> = S.located(
	S.structWith(
		{
			name,
			base: schemaDescShape,
			roles: S.nonEmptyUniqueArray(roleDescShape, (r) => r.name, "role names")
		},
		loc
	)
)

const memberDescShape: S.Shape<MemberDesc> = S.located(
	S.structWith(
		{
			op: S.literalsShape(["insert", "delete", "put"]),
			relation: name,
			member: S.tagged("kind", {
				array: S.struct({ slot: name }),
				stream: S.struct({ slot: name }),
				query: S.struct({ query: unorderedQueryShape })
			})
		},
		loc
	)
)

/**
 * A ChangeSet's parameters are one namespace, the parameters its members' and read-backs' queries use
 * (queryParamNames): every name ChangeSet.bind closed is one of them, and none is named like a member slot its
 * enumerated members' facts are bound through (slots.ts reservedSlots).
 */
const changeSetDescShape: S.Shape<ChangeSetDesc> = S.audited(
	S.struct({
		schema: name,
		strata: S.nonEmptyArray(S.struct({ members: S.array(memberDescShape) })),
		reads: S.uniqueArray(
			S.struct({ name, query: queryDescShape }),
			(r) => r.name,
			"read-back names"
		),
		bindings: S.uniqueStrings("bound parameters", S.nonEmptyString)
	}),
	(changeSet, path) => {
		const used = new Set([
			...changeSet.strata.flatMap((s) =>
				s.members.flatMap((m) =>
					m.member.kind === "query" ? [...queryParamNames(m.member.query)] : []
				)
			),
			...changeSet.reads.flatMap((r) => [...queryParamNames(r.query)])
		])
		for (const [at, bound] of changeSet.bindings.entries()) {
			if (!used.has(bound)) {
				S.refuse(
					[...path, "bindings", at],
					`a binding of a parameter the ChangeSet declares; ${bound} is none of its members' or read-backs' parameters`
				)
			}
		}
		const reserved = changeSet.strata.flatMap((stratum, s) =>
			stratum.members.flatMap((m, i) =>
				m.member.kind === "query"
					? []
					: reservedSlots(s, m.op, m.relation).map((slot) => ({ s, i, slot }))
			)
		)
		const taken = reserved.find(({ slot }) => used.has(slot))
		if (taken !== undefined) {
			S.refuse(
				[...path, "strata", taken.s, "members", taken.i],
				`a parameter name other than the member slot ${taken.slot} the ChangeSet reserves`
			)
		}
	}
)

const workloadDescShape: S.Shape<WorkloadDesc> = S.struct({
	schema: name,
	programs: S.recordShape(
		S.tagged("kind", {
			query: S.struct({ query: queryDescShape }),
			changeSet: S.struct({ changeSet: changeSetDescShape })
		}),
		name
	)
})

/** Every Description type, by name. */
interface DescTypes {
	readonly schema: SchemaDesc
	readonly role: RoleDesc
	readonly login: LoginDesc
	readonly context: ContextDesc
	readonly statement: StatementDesc
	readonly relation: RelationDesc
	readonly query: QueryDesc
	readonly rule: RuleDesc
	readonly expr: ExprDesc
	readonly field: FieldDesc
	readonly changeSet: ChangeSetDesc
	readonly workload: WorkloadDesc
}
export type DescKind = keyof DescTypes
type DescOf<K extends DescKind> = DescTypes[K]

/** The shape of each Description type, under its name. */
const descShapes: S.ShapesOf<DescTypes> = {
	schema: schemaDescShape,
	role: roleDescShape,
	login: loginDescShape,
	context: contextDescShape,
	statement: statementDescShape,
	relation: relationDescShape,
	query: queryDescShape,
	rule: ruleDescShape,
	expr: exprDescShape,
	field: fieldDescShape,
	changeSet: changeSetDescShape,
	workload: workloadDescShape
}

const subjects: Readonly<Record<DescKind, string>> = {
	schema: "schema description",
	role: "role description",
	login: "login description",
	context: "context description",
	statement: "statement description",
	relation: "relation description",
	query: "query description",
	rule: "rule description",
	expr: "expression description",
	field: "field description",
	changeSet: "ChangeSet description",
	workload: "workload description"
}

/** A contained statement's Description, decoded as the statement decoder decodes one. */
export const decodeContainedStatement = (
	value: unknown
): Result.Result<Extract<StatementDesc, { readonly kind: "contained" }>, CompileError> =>
	S.decodeWith(S.tagged("kind", { contained: sideLinkShape }), value, subjects.statement)

/** A mirrors statement's Description, decoded as the statement decoder decodes one. */
export const decodeMirrorsStatement = (
	value: unknown
): Result.Result<Extract<StatementDesc, { readonly kind: "mirrors" }>, CompileError> =>
	S.decodeWith(S.tagged("kind", { mirrors: sideLinkShape }), value, subjects.statement)

/**
 * The Description boundary.
 *
 * THE boundary between the surface builders and the compiler. Builders (schema, query, ChangeSet, workload) record
 * these values and never touch a database; ownership and checking consume them; describeQuery and
 * queryFromDescription serialize them. A pass consumes only Descriptions and IR, never builder objects.
 *
 * Every Description is JSON-safe under the canonical serializer: no
 * null anywhere, a bigint travels as "~n:<integer>", a Decimal as "~d:<exact text>", a Money as "~m:<minor units>", a
 * Vector as "~v:[c1,...,cn]", and a string beginning with "~" is escaped. Descriptions are plain data: a
 * Description that decodes is an owned, frozen copy, and one that does not is MalformedDescription with the path of
 * the first offending value. The checks here are structural and local (shapes, required fields, closed vocabularies,
 * nonempty keys, distinct names, a ChangeSet's parameter names); scope, typing and law recognition are the checker's,
 * and names are resolved against the schema there.
 *
 * Source locations travel under the property `loc` and are excluded from semantic identity (descText omits them); see
 * Located for the nodes that always carry one.
 *
 * Decodes an in-memory value (bigints and decimals already restored) into an owned, frozen Description.
 */
export const decodeDesc = <K extends DescKind>(
	kind: K,
	value: unknown
): Result.Result<DescOf<K>, CompileError> => S.decodeWith(descShapes[kind], value, subjects[kind])

/** The JSON form, source locations included: what crosses a process boundary. */
export const descToJson = (desc: unknown): Result.Result<Json, CompileError> =>
	toJson(desc, everyProperty)

/** Restores tagged values from the JSON form, then decodes. */
export const descFromJson = <K extends DescKind>(
	kind: K,
	json: unknown,
	revivers: Revivers
): Result.Result<DescOf<K>, CompileError> =>
	Result.flatMap(fromJson(json, revivers), (value) => decodeDesc(kind, value))

const identityOptions: EncodeOptions = { omit: omitSourceLocs }

/** The canonical identity text: the canonical serialization without source locations. */
export const descText = (desc: unknown): Result.Result<string, CompileError> =>
	encode(desc, identityOptions)
