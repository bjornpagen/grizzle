import { allenMaskMax } from "#compiler/core/allen.ts"
import { nominal } from "#compiler/core/brand.ts"
import {
	type Canonicalizable,
	canonicalFormat,
	type EncodeOptions,
	encode,
	everyProperty,
	type Json,
	omitSourceLocs,
	ownedText,
	toJson
} from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import {
	concatNonEmpty,
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { compareStrings, type Direction, directions } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { isValidText } from "#compiler/core/text.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import {
	isMoneyPayload,
	isVectorPayload,
	moneyTag,
	vectorMaxDimensions,
	vectorTag
} from "#compiler/ir/carriers.ts"
import type { CalendarDate } from "#compiler/ir/date.ts"
import { decimalTag, isDecimalPayload } from "#compiler/ir/decimal.ts"
import { type FloatSpecialName, floatSpecialNames } from "#compiler/ir/expr.ts"
import { type Fact, factNames, factsSorted } from "#compiler/ir/proof.ts"
import { calendarDateShape, patternsShape, textLanguageShape } from "#compiler/ir/scalar-shape.ts"
import {
	languageOctets,
	type NumericBound,
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale,
	type Patterns,
	type TextLanguage
} from "#compiler/ir/scalar.ts"
import * as S from "#compiler/ir/shape.ts"
import { reservedSlots } from "#compiler/ir/slots.ts"

/**
 * Literals, as authored (LiteralOf): the host value. A numeric literal is a Decimal or a bigint, or an
 * exact decimal string the checker parses; a JavaScript number is a smallint, integer, real or double precision
 * literal. A Money is its owned value (Money.of), carried as "~m:"; a Vector, a caller's mutable Float32Array, is the
 * frozen snapshot of its components Vector.canonical takes, carried as "~v:". Spans and the float special values are
 * wrapped so that no literal is mistaken for a record. A set over a roster is its handles in the roster's declared order,
 * each once; none is the empty set.
 */
export type LiteralDesc =
	| string
	| number
	| boolean
	| bigint
	| Canonicalizable
	| {
			readonly span: {
				readonly start: number | bigint | CalendarDate
				readonly end: number | bigint | CalendarDate
			}
	  }
	| { readonly float: FloatSpecialName }
	| { readonly handles: ReadonlyArray<string> }

/** Field descriptors, aliases already normalized: decimal is numeric, bool is boolean. */
export const pgScalarNames = [
	"smallint",
	"integer",
	"bigint",
	"real",
	"double precision",
	"money",
	"boolean",
	"date"
] as const
export type PgScalarName = (typeof pgScalarNames)[number]

/**
 * An authored field's descriptor, as a declaration states it and the Description boundary carries it
 * (fieldDescShape): numeric is numeric(p, s), its precision and scale both declared. No declaration states a computed
 * numeric, so none has an arm here; a derived relation's inferred field is an InferredFieldDesc. A set over a roster
 * (bits) is bit(n), one bit per code the roster has minted, holes included.
 */
export type FieldDesc =
	| { readonly kind: "pg"; readonly type: PgScalarName }
	| { readonly kind: "numeric"; readonly precision: number; readonly scale: number }
	| { readonly kind: "uuid" }
	| { readonly kind: "bytes" }
	| {
			readonly kind: "text"
			/** The text's patterns as declared: one for str.regex, the members of each text str.and joins. */
			readonly patterns: Patterns
			/**
			 * The most UTF-8 bytes a value holds, str.bytes's bound where it cuts the pattern's language; none for a text of
			 * its pattern alone.
			 */
			readonly bytes: number | undefined
			/** The patterns' language as the text analysis proved it where the descriptor was admitted, cut to `bytes`. */
			readonly language: TextLanguage
	  }
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
	| { readonly kind: "bits"; readonly roster: string }
	| { readonly kind: "vector"; readonly dimensions: number }

/** Visits every descriptor inside `desc`: itself, then a contract's base's and a span's endpoint's, depth first. */
export const nestedFields = (desc: FieldDesc, visit: (d: FieldDesc) => void): void => {
	visit(desc)
	if (desc.kind === "contract") {
		nestedFields(desc.base, visit)
	} else if (desc.kind === "span") {
		nestedFields(desc.endpoint, visit)
	}
}

/**
 * A derived relation's inferred field descriptor (analysis/derived/fields.ts fieldDescOf): the one a declaration of the
 * field's type writes, or a computed numeric, PostgreSQL's numeric of no typmod with the bound its definition proves
 * (ir/scalar.ts NumericBound), a sum's or a mean's. A contract's base and a span's endpoint are a declaration's, so
 * they stay authored.
 */
export type InferredFieldDesc =
	| FieldDesc
	| { readonly kind: "computedNumeric"; readonly bound: NumericBound }

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
	"numeric",
	"lower",
	"upper",
	"width",
	"charLength",
	"octetLength",
	"concat",
	"startsWith",
	"endsWith",
	"matches",
	"translate",
	"collapse",
	"parseDouble",
	"parseDecimal",
	"cosineDistance",
	"union",
	"intersection",
	"difference",
	"cardinality",
	"subset",
	"disjoint",
	"singleton"
] as const
export type ComputeFn = (typeof computeFns)[number]
/** The functions that take a scale argument: round(a, scale) and trunc(a, scale). */
export type ScaledComputeFn = "round" | "trunc"

export const compareOps = ["eq", "ne", "lt", "le", "gt", "ge"] as const
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
 * zero, above zero (both), never NaN or an infinity, within two literal bounds (and so finite), or a match of a
 * literal pattern. The first four are facts a term's TypeScript type states; within states an interval, which no type
 * does (scalar/compute/bounds.ts); matches retypes a text subject as text of the pattern's language, the type
 * str.regex(pattern) declares, the pattern read under the flags "u" (scalar/regex/admit.ts matchFlags).
 */
export type GuardDesc =
	| { readonly kind: "nonzero" }
	| { readonly kind: "nonnegative" }
	| { readonly kind: "positive" }
	| { readonly kind: "finite" }
	| { readonly kind: "within"; readonly low: LiteralDesc; readonly high: LiteralDesc }
	| { readonly kind: "matches"; readonly pattern: string }

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
	| {
			/**
			 * C.at(field, t…): payload field `field` of the fact of closed relation `relation` whose key is `args`, one term
			 * per key field in key order. A key no fact holds reads NULL, never a value, so a predicate's IS TRUE refuses it
			 * and a generated column's NOT NULL does.
			 */
			readonly kind: "closedAt"
			readonly relation: string
			readonly field: string
			readonly args: NonEmptyReadonlyArray<ExprDesc<L, R>>
	  }
	| {
			/**
			 * C.row(t…): the values of the last key field of closed relation `relation` that complete the key prefix `args`,
			 * one term per key field but the last, in key order: a set over that field's roster. A prefix that leaves more
			 * than one key field open is no set over one roster, so none is expressible.
			 */
			readonly kind: "closedRow"
			readonly relation: string
			readonly args: ReadonlyArray<ExprDesc<L, R>>
	  }
	| {
			/**
			 * C.has(t…): whether closed relation `relation` holds a fact whose key is `args`, one term per key field in key
			 * order. A key no fact holds is false, never NULL, so absence is a truth value a predicate branches on; a NULL
			 * key term is NULL, as at every other read.
			 */
			readonly kind: "closedHas"
			readonly relation: string
			readonly args: NonEmptyReadonlyArray<ExprDesc<L, R>>
	  }

/** The boolean field descriptor, the one a connective's unit is typed by. */
export const booleanField: { readonly kind: "pg"; readonly type: "boolean" } = Object.freeze({
	kind: "pg",
	type: "boolean"
})

/**
 * The constant a connective of no operand is, its unit: true for and, false for or, typed boolean (booleanField), so it
 * stands as a predicate on its own where an untyped literal meets no term.
 */
const connectiveUnit = (
	kind: "and" | "or"
): { readonly kind: "literal"; readonly value: boolean; readonly type: typeof booleanField } => ({
	kind: "literal",
	value: kind === "and",
	type: booleanField
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
		case "bytes":
		case "span":
		case "bits":
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
	readonly dir: Direction
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
 * A query is the chain of combinators that built it, in the order they were applied. Each stage but the first names
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

/**
 * A term of a law side, read off one fact of its relation: a field's value, or pred of a natural field, its value less
 * one, defined only where the value is above zero. pred is one level deep: no term is pred of a pred.
 */
export type TermDesc =
	| { readonly kind: "field"; readonly field: string }
	| { readonly kind: "pred"; readonly field: string }

/** A term as a label, a display and a refusal spell it: a field by its name, pred of one as `pred(field)`. */
export const termText = (term: TermDesc): string =>
	term.kind === "field" ? term.field : `pred(${term.field})`

/** A term's identity: a field and pred of it are two terms. */
const termKey = (term: TermDesc): string => `${term.kind} ${term.field}`

/**
 * The field terms of a side, when every term is a field: the one reading of "a side over fields", which a candidate
 * key, a containment between closed relations and a coverage law each are. Undefined when a term is a pred term.
 */
export const fieldTermsOf = <T extends TermDesc>(
	terms: NonEmptyReadonlyArray<T>
): NonEmptyReadonlyArray<Extract<T, { readonly kind: "field" }>> | undefined => {
	const fields = terms.filter(
		(t): t is Extract<T, { readonly kind: "field" }> => t.kind === "field"
	)
	return isNonEmpty(fields) && fields.length === terms.length ? fields : undefined
}

/**
 * Which facts of its relation a law side reads: those every conjunct holds of, each a row predicate over the fact's
 * own fields in the row-check language a check is written in. Ownership holds them in canonical order, each once and
 * none a conjunction or the constant true (own.ts canonicalSelection), so a side that selects nothing, however it was
 * spelled, has no conjunct and reads every fact.
 */
export interface SelectionDesc {
	readonly conjuncts: ReadonlyArray<ExprDesc>
}

/** The selection of every fact: no conjunct. */
export const everyFact: SelectionDesc = Object.freeze({ conjuncts: Object.freeze([]) })

/**
 * The conjuncts a selection's predicate states: a conjunction's operands, through every nested conjunction, the
 * constant true, a conjunction's unit, stating none; any other predicate is one conjunct.
 */
export const conjunctsOf = (predicate: ExprDesc): ReadonlyArray<ExprDesc> => {
	switch (predicate.kind) {
		case "and":
			return predicate.args.flatMap(conjunctsOf)
		case "literal":
			return predicate.value === true ? [] : [predicate]
		case "var":
		case "field":
		case "value":
		case "parent":
		case "param":
		case "compute":
		case "cast":
		case "base":
		case "cond":
		case "when":
		case "compare":
		case "between":
		case "in":
		case "or":
		case "not":
		case "allen":
		case "pointIn":
		case "absent":
		case "closedAt":
		case "closedRow":
		case "closedHas":
			return [predicate]
	}
}

/**
 * A law side, a partial projection: for each fact of `relation` its selection admits, the tuple of its terms, read
 * where every term is defined. `on(select(R, φ), t…)` is { (t…)(r) | r ∈ R, φ(r), and every tᵢ(r) is defined }.
 */
export interface SideDesc {
	readonly relation: string
	readonly terms: NonEmptyReadonlyArray<TermDesc>
	readonly selection: SelectionDesc
}

/**
 * The field names a side's terms are when a key over it is a candidate key of its relation: the side reads every fact,
 * and every term is a field. Undefined for a side that selects or reads a pred term, over which a key constrains only
 * the facts it reads, so it is no key of the relation.
 */
export const candidateKeyFields = (side: SideDesc): NonEmptyReadonlyArray<string> | undefined => {
	const fields = side.selection.conjuncts.length === 0 ? fieldTermsOf(side.terms) : undefined
	return fields === undefined ? undefined : mapNonEmpty(fields, (t) => t.field)
}

/** The closed set of monoids a fold combines by: one vocabulary, which the fold's description and the IR read. */
export const monoidNames = ["count", "sum", "or", "twos", "max", "concat"] as const
export type MonoidName = (typeof monoidNames)[number]

/** fin(O, n): the slots of O's drawn count n, a family's second argument and never a side. */
export interface SlotsDesc {
	readonly owner: string
	readonly count: string
}

/**
 * A closed relation's key field that holds one of the slots of `fin`, fin(O, n): O a closed relation whose key pairs
 * with the relation's first key fields, and n a natural field of O that counts each owner's slots.
 */
export interface KeySlotDesc {
	readonly field: string
	readonly fin: SlotsDesc
}

/** An alternatives arm: a roster handle and its arm relation's key side. */
export interface ArmDesc {
	readonly handle: string
	readonly arm: SideDesc
}

/**
 * A schema's laws. A key is UNIQUE over one side's terms. A containment states that its left side's tuples are among
 * its right side's; mirrors is no statement of its own, but the two containments it is sugar for.
 *
 * - A family, ordered(on(F, g…, i), fin(O, n)) or counted(on(F, g…), fin(O, n)), indexes each owner's members by
 *   exactly 0 … n − 1: `member` reads every fact of F, its terms the group g… paired with O's primary key, then an
 *   ordered family's drawn index.
 * - A tree, tree(on(T, "parent", "at"), fin(T, n), { root }), is the ordered family of T over itself whose every row
 *   but its root, the one self-parented row, is a member, with T's drawn `start` and `end` its pre-order interval and
 *   `root` the caller's field each tree's rows share.
 * - A fold, fold(family, Monoid.m, step, end), combines its family's members' step values by `monoid` in slot order
 *   into each owner's end fields: the family by its slots, `step` over the member and `end` over the owner. Its step is
 *   read per member row, each member once by its key in the family, where a key's or a containment's side is a set of
 *   tuples: two members of one step value both step.
 * - alternatives(parent, discriminator, roster, arms) is its own statement, which expandAlternatives states.
 */
export type StatementDesc<L = Located> = L &
	(
		| { readonly kind: "key"; readonly side: SideDesc }
		| { readonly kind: "mutable"; readonly relation: string }
		| {
				readonly kind: "check"
				readonly name: string
				readonly relation: string
				readonly predicate: ExprDesc<L>
		  }
		| { readonly kind: "contained"; readonly left: SideDesc; readonly right: SideDesc }
		| {
				readonly kind: "family"
				readonly order: "ordered" | "counted"
				readonly member: SideDesc
				readonly slots: SlotsDesc
		  }
		| {
				readonly kind: "tree"
				readonly member: SideDesc
				readonly slots: SlotsDesc
				readonly root: string
		  }
		| {
				readonly kind: "fold"
				readonly family: SlotsDesc
				readonly monoid: MonoidName
				readonly step: SideDesc
				readonly end: SideDesc
		  }
		| {
				readonly kind: "alternatives"
				/** The parent's key side, every fact of the parent relation. */
				readonly parent: SideDesc
				/** The parent's closed-id field over `roster` whose handle selects each fact's arm. */
				readonly discriminator: string
				readonly roster: string
				readonly arms: NonEmptyReadonlyArray<ArmDesc>
		  }
	)

/** A contained statement's Description. */
export type ContainedDesc<L = Located> = Extract<StatementDesc<L>, { readonly kind: "contained" }>

/** An alternatives statement's Description. */
export type AlternativesDesc<L = Located> = Extract<
	StatementDesc<L>,
	{ readonly kind: "alternatives" }
>

/** The parent side selected by its discriminator holding one of `handles`: `eq` for one, `in` for several. */
const discriminated = (a: AlternativesDesc, handles: NonEmptyReadonlyArray<string>): SideDesc => {
	const tag: ExprDesc = { kind: "field", field: a.discriminator }
	const [only, ...rest] = handles
	const predicate: ExprDesc =
		rest.length === 0
			? {
					kind: "compare",
					op: "eq",
					left: tag,
					right: { kind: "literal", value: only, type: undefined }
				}
			: { kind: "in", arg: tag, values: handles }
	return { ...a.parent, selection: { conjuncts: [predicate] } }
}

/**
 * The containments an alternatives statement states: per arm relation, its key in the parent selected by the handles
 * it is the arm of (`in` for several, `eq` for one); per armed handle, the parent selected by that handle in its arm.
 * There is no head: the discriminator's roster domain types the discriminator. Arm relations are in the order their
 * first handle has in `arms`; the reverse containments follow, in `arms`' order. Pure: ownership and the theory call it.
 */
export const expandAlternatives = (a: AlternativesDesc): NonEmptyReadonlyArray<ContainedDesc> => {
	const byRelation = new Map<string, { readonly arm: SideDesc; readonly handles: Array<string> }>()
	for (const { handle, arm } of a.arms) {
		const group = byRelation.get(arm.relation)
		if (group === undefined) {
			byRelation.set(arm.relation, { arm, handles: [handle] })
		} else {
			group.handles.push(handle)
		}
	}
	const forward = [...byRelation.values()].flatMap(
		({ arm, handles }): ReadonlyArray<ContainedDesc> => {
			const [first, ...rest] = handles
			return first === undefined
				? []
				: [{ kind: "contained", left: arm, right: discriminated(a, [first, ...rest]), loc: a.loc }]
		}
	)
	const reverse = mapNonEmpty(a.arms, ({ handle, arm }): ContainedDesc => ({
		kind: "contained",
		left: discriminated(a, [handle]),
		right: arm,
		loc: a.loc
	}))
	return concatNonEmpty(forward, reverse)
}

/**
 * How a stored relation's field is written; only a caller's field is in an insert's head. The union is closed: a way of
 * writing a field is an arm here, which every consumer handles.
 *
 * - caller: by the caller.
 * - generated: by PostgreSQL from the field's own row, a STORED generated column.
 * - drawn: by grizzle from the nested arrays its caller writes: a family's index or count, or a tree's start or end,
 *   which exactly one family or tree statement names.
 * - accumulated: by grizzle on the host, and proved by PostgreSQL: a fold's accumulator or a copy along a family axis,
 *   `start` at the axis's base, which exactly one fold or axis containment carries.
 * - serial: by its sequence, GENERATED ALWAYS AS IDENTITY, its field's type its integer.
 */
export type Writing<L = Located> =
	| { readonly kind: "caller" }
	| {
			readonly kind: "generated"
			/** A row-local expression over the relation's own fields and closed reads, of the field's declared type. */
			readonly expr: ExprDesc<L>
	  }
	| { readonly kind: "drawn" }
	| {
			readonly kind: "accumulated"
			/** The field's value at its axis's base: slot 0, the empty family, or a tree's root. */
			readonly start: LiteralDesc
	  }
	| { readonly kind: "serial" }

/** A stored relation's field as declared: its type, and how it is written. */
export interface FieldDecl<L = Located> {
	readonly type: FieldDesc
	readonly writing: Writing<L>
}

/**
 * The field descriptors of a relation's declarations: each field's type alone, as a heading, a cast or a context reads
 * it.
 */
export const fieldTypes = <L>(
	fields: Readonly<Record<string, FieldDecl<L>>>
): Readonly<Record<string, FieldDesc>> =>
	Object.fromEntries(Object.entries(fields).map(([name, decl]) => [name, decl.type]))

/**
 * A schema's relations. An ordinary relation stores the facts its callers write. A roster (closed) introduces its
 * handles, in declared order, which is their codes' order. A closed relation (closedRelation) relates existing values,
 * the closed ids of its key and its payload, by rows fixed when the schema compiles: its key is required, a set lists
 * every field, and no two rows share a key. A derived relation is a named query, its rows its definition's, which
 * PostgreSQL stores as a materialized view where it is materialized.
 */
export type RelationDesc<L = Located> = L &
	(
		| {
				readonly kind: "relation"
				readonly name: string
				readonly fields: Readonly<Record<string, FieldDecl<L>>>
				readonly primaryKey: readonly [string, ...Array<string>]
		  }
		| {
				readonly kind: "closed"
				readonly name: string
				readonly handles: NonEmptyReadonlyArray<string>
		  }
		| {
				readonly kind: "closedRelation"
				readonly name: string
				readonly fields: Readonly<Record<string, FieldDesc>>
				/** The key fields, closed ids, in the order the key's mixed radix reads them. */
				readonly key: NonEmptyReadonlyArray<string>
				/**
				 * The key fields that hold slots of a fin coordinate, in key order, each with its fin: none for a key that is a
				 * product of closed ids.
				 */
				readonly slots: ReadonlyArray<KeySlotDesc>
				/** Each row a value of every field, its key fields' values handles of their rosters. */
				readonly rows: ReadonlyArray<Readonly<Record<string, LiteralDesc>>>
		  }
		| {
				readonly kind: "derived"
				readonly name: string
				readonly query: QueryDesc<L>
				/** The derived level: 1 over base relations, n + 1 over a level-n derived relation. */
				readonly level: number
				/** Whether PostgreSQL stores its rows: never, every read and rule reading its definition; or as a
				 * materialized view, which a read reads as of its last refresh. */
				readonly storage: DerivedStorage
		  }
	)

/**
 * How a derived relation is held: `live`, its definition alone, which every query matching it and every rule over it
 * reads; or `materialized`, a materialized view of its rows besides, which a query reads as of its last refresh. A rule
 * over either reads its definition.
 */
const derivedStorages = ["live", "materialized"] as const
export type DerivedStorage = (typeof derivedStorages)[number]

/**
 * Whether a role holds a relation: whether PostgreSQL holds its rows, so neither a closed relation, whose rows are its
 * constants, nor a live derived relation, whose rows are its definition's over the relations it reads.
 */
export const heldRelation = (relation: RelationDesc): boolean => {
	switch (relation.kind) {
		case "relation":
		case "closed":
			return true
		case "closedRelation":
			return false
		case "derived":
			return relation.storage === "materialized"
	}
}

export type SchemaDesc<L = Located> = L & {
	readonly name: string
	readonly relations: ReadonlyArray<SchemaRelationOf<L>>
	readonly statements: ReadonlyArray<StatementDesc<L>>
	/** schema.extend: the level this one builds on, under its own name. */
	readonly extends: SchemaDesc<L> | undefined
}

/**
 * A relation of a decoded schema: every closed relation in one is admitted (AdmittedClosedRelation), its rows proved
 * values of its fields' types once, so nothing that reads a schema proves them again. An authored description's
 * relations are written as they are, and admitted where it is decoded (schema/admit.ts).
 */
export type SchemaRelationDesc =
	| Exclude<RelationDesc, { readonly kind: "closedRelation" }>
	| AdmittedClosedRelation

type SchemaRelationOf<L> = [L] extends [Located] ? SchemaRelationDesc : RelationDesc<L>

/**
 * A schema description decoded before its closed relations are admitted: what a schema's admission reads
 * (schema/admit.ts), each closed relation as it was written.
 */
export type UnadmittedSchemaDesc = Located & {
	readonly name: string
	readonly relations: ReadonlyArray<RelationDesc>
	readonly statements: ReadonlyArray<StatementDesc>
	readonly extends: UnadmittedSchemaDesc | undefined
}

/**
 * Worlds. A role is relations defined over its base, a schema: each entry is a whole relation of the base under its
 * own name, or a world relation, a query over the base installed as a plain view. `write` and `refresh` name role
 * relations. A login is one credential and one pool for roles over one base.
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
			case "closedAt":
			case "closedHas":
				return { ...e, args: mapNonEmpty(e.args, (a) => this.expr(a)) }
			case "closedRow":
				return { ...e, args: e.args.map((a) => this.expr(a)) }
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

/** A span literal's endpoint: an integer's or a bigint's, or a date's text. */
const spanEndpointShape = S.unionShape(S.integer, S.bigint, calendarDateShape)

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
	S.struct({ span: S.struct({ start: spanEndpointShape, end: spanEndpointShape }) }),
	S.struct({ float: S.literalsShape(floatSpecialNames) }),
	S.struct({ handles: S.uniqueStrings("a set's handles", S.nonEmptyString) })
)

const fieldDescShape: S.Shape<FieldDesc> = S.lazy("a field descriptor", () =>
	S.tagged("kind", {
		pg: S.struct({ type: S.literalsShape(pgScalarNames) }),
		numeric: S.refine(
			S.struct({ precision: S.integer, scale: S.integer }),
			(f) =>
				f.precision >= 1 &&
				f.precision <= numericMaxPrecision.value &&
				f.scale >= numericMinScale.value &&
				f.scale <= numericMaxScale.value,
			`numeric(p, s), both declared, p in 1..${numericMaxPrecision.value} and s in ${numericMinScale.value}..${numericMaxScale.value}`
		),
		uuid: S.struct({}),
		bytes: S.struct({}),
		text: S.refine(
			S.structStated(
				{ patterns: patternsShape, language: textLanguageShape },
				{ bytes: S.nonNegativeInteger },
				{}
			),
			(t) => t.bytes === languageOctets(t.language),
			"a text's byte bound, the one its language enforces"
		),
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
		bits: S.struct({ roster: name }),
		vector: S.struct({
			dimensions: S.refine(
				S.positiveInteger,
				(n) => n <= vectorMaxDimensions.value,
				`1..${vectorMaxDimensions.value} dimensions`
			)
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
	numeric: unscaledCompute,
	lower: unscaledCompute,
	upper: unscaledCompute,
	width: unscaledCompute,
	charLength: unscaledCompute,
	octetLength: unscaledCompute,
	concat: unscaledCompute,
	startsWith: unscaledCompute,
	endsWith: unscaledCompute,
	matches: unscaledCompute,
	translate: unscaledCompute,
	collapse: unscaledCompute,
	parseDouble: unscaledCompute,
	parseDecimal: unscaledCompute,
	cosineDistance: unscaledCompute,
	union: unscaledCompute,
	intersection: unscaledCompute,
	difference: unscaledCompute,
	cardinality: unscaledCompute,
	subset: unscaledCompute,
	disjoint: unscaledCompute,
	singleton: unscaledCompute
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
			within: S.struct({ low: literalDescShape, high: literalDescShape }),
			matches: S.struct({ pattern: S.string })
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
		mask: S.refine(
			S.integer,
			(m) => m >= 1 && m <= allenMaskMax,
			`an Allen mask in 1..${allenMaskMax}`
		),
		right: S.lazy("an expression", () => exprDescShape)
	}),
	pointIn: S.struct({
		point: S.lazy("an expression", () => exprDescShape),
		span: S.lazy("an expression", () => exprDescShape)
	}),
	absent: S.struct({
		source: S.lazy("a source", () => sourceDescShape),
		bindings: bindingsDescShape
	}),
	closedAt: S.struct({
		relation: name,
		field: name,
		args: S.nonEmptyArray(S.lazy("an expression", () => exprDescShape))
	}),
	closedRow: S.struct({
		relation: name,
		args: S.array(S.lazy("an expression", () => exprDescShape))
	}),
	closedHas: S.struct({
		relation: name,
		args: S.nonEmptyArray(S.lazy("an expression", () => exprDescShape))
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
	S.recognized(
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
)

const orderDescShape: S.Shape<OrderDesc> = S.struct({
	column: name,
	dir: S.literalsShape(directions)
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
	S.recognized(
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
)

const queryDescShape: S.Shape<QueryDesc> = S.lazy("a query description", () =>
	S.recognized(S.struct({ stage: queryStageShape }))
)

/** A query that is a Query, not an Ordered: a match source, a ChangeSet member, a derived definition. */
const unorderedQueryShape: S.Shape<QueryDesc> = S.refine(
	queryDescShape,
	(q) => !isOrderedQuery(q),
	"a Query, not an Ordered: only take makes an ordered query a set again"
)

const termDescShape: S.Shape<TermDesc> = S.tagged("kind", {
	field: S.struct({ field: name }),
	pred: S.struct({ field: name })
})

const selectionDescShape: S.Shape<SelectionDesc> = S.struct({ conjuncts: S.array(exprDescShape) })

const sideTerms = S.nonEmptyUniqueArray(termDescShape, termKey, "side terms")

/** A side's terms are distinct: a field and pred of it are two terms, each at most once. */
const sideDescShape: S.Shape<SideDesc> = S.struct({
	relation: name,
	terms: sideTerms,
	selection: selectionDescShape
})

/** A side's relation and terms, as a decode of the side reads them, its selection passed over. */
const sideTermsShape = S.struct({ relation: name, terms: sideTerms })

/** A contained statement's fields: its two sides. */
const sideLinkShape = S.located(S.structWith({ left: sideDescShape, right: sideDescShape }, loc))

const slotsDescShape: S.Shape<SlotsDesc> = S.struct({ owner: name, count: name })

/**
 * A side over every fact of its relation, which no selection narrows: a family's or a tree's member, whose slots are
 * counted over every fact, and an alternatives statement's parent and arms, its relations' keys.
 */
const memberShape: S.Shape<SideDesc> = S.refine(
	sideDescShape,
	(side) => side.selection.conjuncts.length === 0,
	"a member side over every fact of its relation, which no selection narrows"
)

const statementDescShape: S.Shape<StatementDesc> = S.tagged("kind", {
	key: S.located(S.structWith({ side: sideDescShape }, loc)),
	mutable: S.located(S.structWith({ relation: name }, loc)),
	check: S.located(S.structWith({ name, relation: name, predicate: exprDescShape }, loc)),
	contained: sideLinkShape,
	family: S.located(
		S.structWith(
			{
				order: S.literalsShape(["ordered", "counted"]),
				member: memberShape,
				slots: slotsDescShape
			},
			loc
		)
	),
	tree: S.located(S.structWith({ member: memberShape, slots: slotsDescShape, root: name }, loc)),
	fold: S.located(
		S.structWith(
			{
				family: slotsDescShape,
				monoid: S.literalsShape(monoidNames),
				step: sideDescShape,
				end: sideDescShape
			},
			loc
		)
	),
	alternatives: S.located(
		S.structWith(
			{
				parent: memberShape,
				discriminator: name,
				roster: name,
				arms: S.nonEmptyUniqueArray(
					S.struct({ handle: name, arm: memberShape }),
					(a) => a.handle,
					"arm handles"
				)
			},
			loc
		)
	)
})

const writingShape: S.Shape<Writing> = S.tagged("kind", {
	caller: S.struct({}),
	generated: S.struct({ expr: exprDescShape }),
	drawn: S.struct({}),
	accumulated: S.struct({ start: literalDescShape }),
	serial: S.struct({})
})

/** The integer types a sequence draws: smallint, integer and bigint. */
const serialTypes: ReadonlyArray<PgScalarName> = ["smallint", "integer", "bigint"]

/** A serial field is of an integer type, which its sequence draws. */
const fieldDeclShape: S.Shape<FieldDecl> = S.refine(
	S.struct({ type: fieldDescShape, writing: writingShape }),
	(d) => d.writing.kind !== "serial" || (d.type.kind === "pg" && serialTypes.includes(d.type.type)),
	"a serial field of smallint, integer or bigint, which its sequence draws"
)

/**
 * Whether a field may be in a primary key: one whose value a fact holds when it is written, its caller's, its
 * sequence's or its family's. A generated or accumulated field is computed from the row it would identify.
 */
const keyWriting = (decl: FieldDecl | undefined): boolean => {
	switch (decl?.writing.kind) {
		case "caller":
		case "serial":
		case "drawn":
			return true
		case "generated":
		case "accumulated":
		case undefined:
			return false
	}
}

/**
 * The field types a closed relation's field may have: a closed id, which a key field always is, or an open type its
 * rows' values are coded by within the relation. A span and a vector have no finite code space a cell reads, a set
 * is no row's value, and bytes have no literal.
 */
const closedFieldAdmits = (desc: FieldDesc): boolean => {
	switch (desc.kind) {
		case "pg":
		case "numeric":
		case "uuid":
		case "text":
		case "closedId":
			return true
		case "contract":
			return closedFieldAdmits(desc.base)
		case "bytes":
		case "span":
		case "bits":
		case "vector":
			return false
	}
}

/**
 * The values that tell two rows' keys apart: their key fields' values, in key order, when each is a handle, the one
 * value a closed id holds; undefined when one is not.
 */
const rowKeyValues = (
	key: NonEmptyReadonlyArray<string>,
	row: Readonly<Record<string, LiteralDesc>>
): ReadonlyArray<string> | undefined => {
	const values = key.map((f) => row[f])
	return values.every((v): v is string => typeof v === "string") ? values : undefined
}

declare const admittedBrand: unique symbol

/**
 * A closed relation's description as its admission made it, the brand's doors being closed.relation()'s
 * (schema/relation.ts admitClosedRelation) and a decoded schema's (schema/admit.ts): its rows proved there, one per
 * key, each a value of exactly the relation's fields and of each field's base type, a closed id one of its roster's
 * handles, and the rest decoded. A refinement a field's type carries (a contract's predicate, a pattern) is judged
 * where the schema is checked, which alone reads a contract's predicate.
 */
export type AdmittedClosedRelation = Extract<RelationDesc, { readonly kind: "closedRelation" }> & {
	readonly [admittedBrand]: true
}

/**
 * Each admitted closed relation's description, by its identity: a handle registry, which a decode of a schema reads to
 * pass it through unchanged, the one closed relation a decoded schema holds. Only the brand's doors register one,
 * frozen, so a description a caller built or edited is no admitted one.
 */
const admittedDescs = new WeakMap<object, AdmittedClosedRelation>()

const mintAdmitted = nominal<
	Extract<RelationDesc, { readonly kind: "closedRelation" }>,
	AdmittedClosedRelation
>()

/**
 * The brand's one mint: a closed relation's description its caller admitted (closed.relation()'s admission, or its
 * schema's), registered and frozen with its rows.
 */
export const recordAdmitted = (
	desc: Extract<RelationDesc, { readonly kind: "closedRelation" }>
): AdmittedClosedRelation => {
	for (const row of desc.rows) {
		Object.freeze(row)
	}
	Object.freeze(desc.rows)
	const admitted = mintAdmitted(Object.freeze(desc))
	admittedDescs.set(admitted, admitted)
	return admitted
}

/** The admitted closed relation a description is, when an admission made it; none for any other value. */
export const admittedRelation = (value: unknown): AdmittedClosedRelation | undefined =>
	typeof value === "object" && value !== null ? admittedDescs.get(value) : undefined

/** A relation description's shape, an admitted closed relation's description passed through as it stands. */
const admittedOr = (shape: S.Shape<RelationDesc>): S.Shape<RelationDesc> =>
	S.plain({
		expected: shape.expected,
		parse: function* (value, path) {
			const admitted =
				typeof value === "object" && value !== null ? admittedDescs.get(value) : undefined
			return admitted ?? (yield* shape.parse(value, path))
		}
	})

/** A relation description's shape, a closed relation's decoded as written, its rows not admitted. */
const relationDescShape: S.Shape<RelationDesc> = admittedOr(
	S.tagged("kind", {
		relation: S.located(
			S.refine(
				S.structWith(
					{
						name,
						fields: S.refine(
							S.recordShape(fieldDeclShape, name),
							(f) => Object.keys(f).length > 0,
							"a relation with at least one field"
						),
						primaryKey: S.nonEmptyUniqueStrings("primary key fields")
					},
					loc
				),
				(r) => r.primaryKey.every((f) => keyWriting(r.fields[f])),
				"a primary key over the relation's own fields, each one its caller writes, its sequence draws or its family draws"
			)
		),
		closed: S.located(S.structWith({ name, handles: S.nonEmptyUniqueStrings("handles") }, loc)),
		closedRelation: S.located(
			S.refine(
				S.structWith(
					{
						name,
						fields: S.refine(
							fieldMapShape,
							(f) => Object.keys(f).length > 0 && Object.values(f).every(closedFieldAdmits),
							"a closed relation of at least one field, each a closed id or an open type that is no serial, span, set, vector or bytes"
						),
						key: S.nonEmptyUniqueStrings("key fields"),
						slots: S.uniqueArray(
							S.struct({ field: name, fin: slotsDescShape }),
							(slot) => slot.field,
							"slot fields"
						),
						rows: S.array(S.recordShape(literalDescShape, name))
					},
					loc
				),
				(c) => {
					const fields = Object.keys(c.fields).toSorted(compareStrings)
					if (!c.key.every((f) => c.fields[f]?.kind === "closedId")) {
						return false
					}
					const slotted = c.slots.map((slot) => c.key.indexOf(slot.field))
					if (!slotted.every((at, i) => at >= 0 && at > (slotted[i - 1] ?? -1))) {
						return false
					}
					const keys = new TupleMap<ReadonlyArray<string>, Readonly<Record<string, LiteralDesc>>>()
					for (const row of c.rows) {
						const own = Object.keys(row).toSorted(compareStrings)
						if (own.length !== fields.length || !own.every((f, i) => f === fields[i])) {
							return false
						}
						const values = rowKeyValues(c.key, row)
						if (values === undefined || keys.has(values)) {
							return false
						}
						keys.set(values, row)
					}
					return true
				},
				"a key of the relation's own closed-id fields, its slots key fields in key order, each row a value of exactly its fields, its key values handles, and no two rows of one key"
			)
		),
		derived: S.located(
			S.structWith(
				{
					name,
					query: unorderedQueryShape,
					level: S.positiveInteger,
					storage: S.literalsShape(derivedStorages)
				},
				loc
			)
		)
	})
)

/**
 * A decoded schema's relation: an admitted closed relation as it stands, any other relation decoded, and a closed
 * relation no admission made refused, since a schema holds only admitted ones (SchemaRelationDesc).
 */
const schemaRelationShape: S.Shape<SchemaRelationDesc> = S.plain({
	expected: relationDescShape.expected,
	parse: function* (value, path) {
		const admitted =
			typeof value === "object" && value !== null ? admittedDescs.get(value) : undefined
		if (admitted !== undefined) {
			return admitted
		}
		const decoded = yield* relationDescShape.parse(value, path)
		if (decoded.kind === "closedRelation") {
			return S.refuse(
				path,
				"a closed relation admitted by closed.relation(...) or by its schema's admission (schema/admit.ts)"
			)
		}
		return decoded
	}
})

const schemaDescShape: S.Shape<SchemaDesc> = S.lazy("a schema description", () =>
	S.located(
		S.structStated(
			{
				name,
				relations: S.uniqueArray(schemaRelationShape, (r) => r.name, "relation names"),
				statements: S.array(statementDescShape)
			},
			{ extends: schemaDescShape },
			loc
		)
	)
)

const unadmittedSchemaShape: S.Shape<UnadmittedSchemaDesc> = S.lazy("a schema description", () =>
	S.located(
		S.structStated(
			{
				name,
				relations: S.uniqueArray(relationDescShape, (r) => r.name, "relation names"),
				statements: S.array(statementDescShape)
			},
			{ extends: unadmittedSchemaShape },
			loc
		)
	)
)

/**
 * A schema description decoded with its closed relations as written, which its admission admits (schema/admit.ts)
 * before the schema is decoded as one.
 */
export const decodeUnadmittedSchema = (
	value: unknown
): Result.Result<UnadmittedSchemaDesc, CompileError> =>
	S.decodeWith(unadmittedSchemaShape, value, "schema description")

const roleEntryDescShape: S.Shape<RoleEntryDesc> = S.tagged("kind", {
	whole: S.located(S.structWith({ name }, loc)),
	world: S.located(S.structWith({ name, query: unorderedQueryShape }, loc))
})

const roleRelations = S.nonEmptyUniqueArray(
	roleEntryDescShape,
	(e) => e.name,
	"role relation names"
)
const roleWrite = S.uniqueStrings("written relations", name)
const roleRefresh = S.uniqueStrings("refreshed relations", name)

const roleDescShape: S.Shape<RoleDesc> = S.located(
	S.structWith(
		{
			name,
			base: schemaDescShape,
			relations: roleRelations,
			write: roleWrite,
			refresh: roleRefresh
		},
		loc
	)
)

/** What a role states over its base: the role's own parts, which a role's Description holds beside the base. */
type RoleParts = Omit<RoleDesc, "base">

/** A role's own parts as a decode of the whole role reads them, its base passed over. */
const rolePartsShape: S.Shape<RoleParts> = S.located(
	S.structWith({ name, relations: roleRelations, write: roleWrite, refresh: roleRefresh }, loc)
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

/**
 * A Description node built from parts already decoded, held as a decode holds one: frozen, its location kept
 * (ir/shape.ts keptLoc). Every part is read by its own decode once, where it enters, so a node over decoded parts
 * reads none of them again; a list the node's builder made is frozen by it.
 */
export const builtNode = <N extends Located>(node: N): N =>
	Object.freeze({ ...node, loc: S.keptLoc(node.loc) })

/**
 * A schema level's Description over parts already decoded: its relations, each closed relation admitted, and its
 * statements, as their builders or ownership hold them, the level below it, a declared name and its location. No
 * relation name repeats, which a level's record of relations, keyed by name, holds.
 */
export const schemaLevelDesc = (level: {
	readonly name: string
	readonly relations: ReadonlyArray<SchemaRelationDesc>
	readonly statements: ReadonlyArray<StatementDesc>
	readonly extends: SchemaDesc | undefined
	readonly loc: SourceLoc
}): SchemaDesc =>
	builtNode({
		name: level.name,
		relations: Object.freeze(level.relations),
		statements: Object.freeze(level.statements),
		extends: level.extends,
		loc: level.loc
	})

/** A role's Description over its base from its own parts, each already decoded. */
const roleDescOver = (base: SchemaDesc, role: RoleParts): RoleDesc =>
	builtNode({
		name: role.name,
		base,
		relations: Object.freeze(role.relations),
		write: Object.freeze(role.write),
		refresh: Object.freeze(role.refresh),
		loc: role.loc
	})

/**
 * A role's Description over its base, decoded already: the role's own parts, which its caller wrote, decoded as a
 * decode of the whole role decodes them.
 */
export const decodeRoleOver = (
	base: SchemaDesc,
	role: unknown
): Result.Result<RoleDesc, CompileError> =>
	Result.map(S.decodeWith(rolePartsShape, role, subjects.role), (parts) =>
		roleDescOver(base, parts)
	)

/** A login's Description over its base and its roles, each already decoded, under distinct names. */
const loginDescOver = (
	base: SchemaDesc,
	login: {
		readonly name: string
		readonly roles: NonEmptyReadonlyArray<RoleDesc>
		readonly loc: SourceLoc
	}
): LoginDesc =>
	builtNode({ name: login.name, base, roles: Object.freeze(login.roles), loc: login.loc })

/**
 * A login's Description over its base and its roles, each already decoded, as its caller listed them: refused, as a
 * decode of the whole login refuses it, at the first role whose name repeats an earlier one's.
 */
export const admitLoginRoles = (
	base: SchemaDesc,
	login: {
		readonly name: string
		readonly roles: NonEmptyReadonlyArray<RoleDesc>
		readonly loc: SourceLoc
	}
): Result.Result<LoginDesc, CompileError> => {
	const repeated = S.repeatedAt(subjects.login, ["roles"], login.roles, (r) => r.name, "role names")
	return repeated === undefined ? Result.ok(loginDescOver(base, login)) : Result.err(repeated)
}

/**
 * A side's Description: its relation and terms, which its caller wrote, decoded as a statement's side decodes them,
 * over its selection, whose conjuncts the selection's predicate decoded.
 */
export const decodeSide = (
	value: unknown,
	selection: SelectionDesc
): Result.Result<SideDesc, CompileError> =>
	Result.map(S.decodeWith(sideTermsShape, value, "side description"), (side) =>
		Object.freeze({ relation: side.relation, terms: side.terms, selection })
	)

/**
 * The Description boundary.
 *
 * THE boundary between the surface builders and the compiler. Builders (schema, query, ChangeSet, workload) record
 * these values and never touch a database; ownership and checking consume them; describeQuery serializes them. A
 * pass consumes only Descriptions and IR, never builder objects.
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

const identityOptions: EncodeOptions = { omit: omitSourceLocs }

/** The canonical identity text: the canonical serialization without source locations. */
export const descText = (desc: unknown): Result.Result<string, CompileError> =>
	encode(desc, identityOptions)

declare const contentDigestBrand: unique symbol

/**
 * The digest of a description's content, minted only by contentDigest: SHA-256 over its canonical text without source
 * locations, under the domain of what it digests, so two values of one content and domain share it and no others do.
 */
export type ContentDigest = string & { readonly [contentDigestBrand]: true }

/**
 * What a content digest digests: a relation's description, one level of a schema over the level below it
 * (schema/levels.ts SchemaContent), or a role over its base.
 */
type ContentDomain = "relation" | "schema-level" | "role"

const mintContentDigest = nominal<string, ContentDigest>()

/**
 * The content digest of a value the builders made, which encodes by construction: the bytes hashed are
 * "<canonical format>\n<domain>\n<canonical text>", the text without source locations. Each value's is computed once,
 * when it is built, and every identity comparison of built values compares these digests.
 */
export const contentDigest = (domain: ContentDomain, value: unknown): ContentDigest =>
	mintContentDigest(
		sha256Hex(`${canonicalFormat}\n${domain}\n${ownedText(value, identityOptions)}`)
	)
