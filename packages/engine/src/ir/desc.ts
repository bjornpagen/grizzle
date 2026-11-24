import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	concatNonEmpty,
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import type { WellFormedText } from "@bjornpagen/grizzle-text/utf8"
import { allenMaskMax } from "#compiler/core/allen.ts"
import { nominal } from "#compiler/core/brand.ts"
import {
	type Canonicalizable,
	encode,
	encodeOver,
	everyProperty,
	type FloatSpecialName,
	floatSpecialNames,
	type Json,
	type StandIn,
	standInTag,
	transportJson,
	withoutSourceLocs
} from "#compiler/core/canonical.ts"
import { clockUnits } from "#compiler/core/clock.ts"
import { isSha256Text } from "#compiler/core/digest.ts"
import { type CompileError, ruleRefused } from "#compiler/core/errors.ts"
import { type IdentityDigest, IdentityDigests } from "#compiler/core/fingerprint.ts"
import {
	type DeclaredLanguage,
	declaredLanguages,
	type FunctionNullInput,
	type FunctionVolatility,
	functionVolatilities
} from "#compiler/core/function.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings, type Direction, directions } from "#compiler/core/order.ts"
import { deepFreeze, isList, isPlainRecord, isRecord, mapRecord } from "#compiler/core/record.ts"
import { type CanonicalSet, tupleKeyedSet } from "#compiler/core/set.ts"
import { isValidText } from "#compiler/core/text.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { isMoneyPayload, isVectorPayload, moneyTag, vectorTag } from "#compiler/ir/carriers.ts"
import type { ClockBinding } from "#compiler/ir/clock.ts"
import type { CalendarDate } from "#compiler/ir/date.ts"
import { decimalTag, isDecimalPayload } from "#compiler/ir/decimal.ts"
import type { PatternValue } from "#compiler/ir/pattern.ts"
import { type Fact, factNames, factsSorted } from "#compiler/ir/proof.ts"
import { type DeltaSide, seriesArguments, type TextSplit } from "#compiler/ir/rel.ts"
import {
	calendarDateShape,
	patternValueShape,
	patternsShape,
	textLanguageShape
} from "#compiler/ir/scalar-shape.ts"
import {
	type ExactValueCarrier,
	exactValueCarriers,
	type NumericBound,
	type RosterHandles,
	type RosterOrder,
	type TextLanguage,
	languageOctets
} from "#compiler/ir/scalar.ts"
import { type TextSearchConfiguration, textSearchConfigurations } from "#compiler/ir/search.ts"
import * as S from "#compiler/ir/shape.ts"
import { reservedSlot } from "#compiler/ir/slots.ts"
import { numericBoundRefusal } from "#compiler/scalar/values/decimal.ts"
import {
	numericMaxFractionDigits,
	numericMaxIntegerDigits,
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale
} from "#compiler/scalar/values/fault.ts"

/**
 * Literals, as authored (LiteralOf): the host value. A numeric literal is a Decimal or a bigint, or an
 * exact decimal string the checker parses; a JavaScript number is a smallint, integer, real or double precision
 * literal. A Money is its owned value (Money.of), carried as "~m:"; a Vector, a caller's mutable Float32Array, is the
 * frozen snapshot of its components Vector.canonical takes, carried as "~v:". Spans and the float special values are
 * wrapped so that no literal is mistaken for a record. A set over a roster is its handles in the roster's declared order,
 * each once; none is the empty set. A digest is its one text (core/sha256.ts sha256Text), wrapped as `{ sha256 }`. A Text.matches pattern is its pattern value (ir/pattern.ts PatternValue), its
 * language's key and its spelling, the spelling no part of its identity, so two spellings of one language are one
 * description.
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
	| { readonly sha256: string }
	| PatternValue

/** The pattern value a literal is (ir/pattern.ts PatternValue), the one literal that holds a spelling; undefined for any other. */
export const literalPattern = (value: LiteralDesc): PatternValue | undefined =>
	typeof value === "object" && "spelling" in value ? value : undefined

/**
 * The pg descriptors' types, each by the one name PostgreSQL prints for it: `numeric` is numeric of no typmod, every
 * value numeric holds, as format_type prints it (pg.numeric), and numeric(p, s) is the numeric arm of FieldDesc.
 */
export const pgScalarNames = [
	"smallint",
	"integer",
	"bigint",
	"numeric",
	"real",
	"double precision",
	"money",
	"boolean",
	"date",
	"inet",
	"cidr"
] as const
export type PgScalarName = (typeof pgScalarNames)[number]

/**
 * A field's descriptor, as a declaration states it, the Description boundary carries it (fieldDescShape) and a derived
 * relation's heading infers it (schema/field-desc.ts fieldDescOf): numeric is numeric(p, s), its precision and
 * scale both declared, and `pg` numeric is numeric of no typmod, which holds every numeric value (ir/scalar.ts
 * NumericValueType at numeric's own limits); computedNumeric is numeric of no typmod within a narrower bound
 * (ir/scalar.ts NumericBound), a sum's, a mean's or an operation's, which a derived relation's column carries and a
 * stored field holds exactly (pg.numeric.within), its bound a column CHECK; a bound at numeric's own limits is
 * pg.numeric's, so no type has two descriptors. An exact value (exact) is an exact integer or exact money of any size,
 * the type integer and money arithmetic delivers (ir/scalar.ts ExactType) at numeric's own limit. A set over a roster
 * (bits) is bit(n), one bit per code the roster has minted, holes included. A pattern is a closed relation's text of
 * Text.matches patterns (str.pattern), each value a pattern of grizzle's grammar admitted once where the relation is
 * read, its ARE planned beside its dictionary.
 */
export type FieldDesc =
	| { readonly kind: "pg"; readonly type: PgScalarName }
	| { readonly kind: "numeric"; readonly precision: number; readonly scale: number }
	| { readonly kind: "exact"; readonly carrier: ExactValueCarrier }
	| { readonly kind: "computedNumeric"; readonly bound: NumericBound }
	| { readonly kind: "uuid" }
	| { readonly kind: "bytes" }
	| { readonly kind: "sha256" }
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
	| { readonly kind: "pattern" }
	| {
			readonly kind: "contract"
			readonly name: string
			readonly base: FieldDesc
			readonly predicate: ExprDesc | undefined
			/** The facts the contract declares its predicate proves, distinct and in the one order (ir/proof.ts). */
			readonly facts: ReadonlyArray<Fact>
	  }
	| { readonly kind: "span"; readonly endpoint: FieldDesc; readonly width: bigint | undefined }
	| {
			readonly kind: "closedId"
			readonly roster: string
			/**
			 * The handles of the roster a value is one of, a subset of them in the roster's order (scalar/closed-id.ts
			 * readSubset); none for every handle, which a subset of every handle is too, so one set has one spelling.
			 */
			readonly only: NonEmptyReadonlyArray<string> | undefined
	  }
	| { readonly kind: "bits"; readonly roster: string }
	| { readonly kind: "vector"; readonly dimensions: number }
	| {
			readonly kind: "search"
			/** The text search configuration the document is parsed under, its identity as a type (ir/search.ts). */
			readonly configuration: TextSearchConfiguration
	  }

/** Visits every descriptor inside `desc`: itself, then a contract's base's and a span's endpoint's, depth first. */
export const nestedFields = (desc: FieldDesc, visit: (d: FieldDesc) => void): void => {
	visit(desc)
	if (desc.kind === "contract") {
		nestedFields(desc.base, visit)
	} else if (desc.kind === "span") {
		nestedFields(desc.endpoint, visit)
	}
}

/** The scalar catalogue. */
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
	"utf16Length",
	"concat",
	"startsWith",
	"endsWith",
	"contains",
	"matches",
	"translate",
	"lowerAscii",
	"collapse",
	"resolveReference",
	"cutBefore",
	"cutFrom",
	"replace",
	"isXsdPattern",
	"parseDouble",
	"parseDecimal",
	"sha256",
	"floatBits",
	"cosineDistance",
	"textDocument",
	"websearchMatches",
	"plainMatches",
	"websearchRank",
	"plainRank",
	"websearchRankCd",
	"plainRankCd",
	"union",
	"intersection",
	"difference",
	"cardinality",
	"subset",
	"disjoint",
	"singleton",
	"netWithin",
	"netStrictlyWithin",
	"netOverlaps",
	"wall",
	"epochDay",
	"dateOfEpochDay"
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
	 * Description an author writes; in one grizzle writes itself (Inferred) and in the checker's own references, a
	 * channel may stand instead (ParamTyping).
	 */
	readonly paramType: unknown
	/**
	 * What a typed literal states of its type beside its value: a field descriptor, a derived relation's computed numeric
	 * column's among them (analysis/theory/query.ts).
	 */
	readonly literalType: FieldDesc
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
 * A Description's references with each parameter reference carrying `P` and a scalar parameter's type `T`: a
 * variable's, a parent column's and an interior stage's canonical spelling, and every leaf kind. A walk over a
 * description's parameters (mapQueryParams) changes only `P`.
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
	readonly literalType: FieldDesc
	readonly nested: ParamsAs<P, T>
}

/** A Description's references: every reference spelled canonically, a parameter by its name. */
export type Spelled = ParamsAs<{ readonly name: string }>

/**
 * A parameter of an imported query that grizzle writes itself, typed by the column its import's bind map binds it to
 * rather than by a declared descriptor: a factored recursive step's state (check/recursion/factor.ts), and a trigger
 * probe's term read inside the side it meets (analysis/theory/query.ts), which may be a derived relation's computed
 * numeric column, whose type no field descriptor states. The checker reads it as that column wherever the import reads
 * it, and refuses it bound to anything but a column.
 */
export interface Channel {
	readonly kind: "channel"
}

/** What a scalar parameter reference states of its type: a declared field descriptor, or a channel. */
export type ParamTyping = FieldDesc | Channel

/**
 * The references of a Description grizzle writes itself, a rule's query over a derived relation's definition
 * (analysis/theory/query.ts): spelled as an author's are, a definition's head literal standing at its column's own type,
 * a computed numeric's among them, but a parameter of an imported query may be a channel (Channel). An authored
 * Description is one of these.
 */
export type Inferred = ParamsAs<{ readonly name: string }, ParamTyping>
export type InferredExpr = ExprDesc<Located, Inferred>
export type InferredBindings = BindingsDesc<Located, Inferred>
export type InferredHead = HeadTermDesc<Located, Inferred>
export type InferredMatch = MatchDesc<Located, Inferred>
export type InferredQuery = QueryDesc<Located, Inferred>
export type InferredStage = QueryStageDesc<Located, Inferred>
export type InferredRule = RuleDesc<Located, Inferred>
export type InferredSource = SourceDesc<Located, Inferred>

/**
 * What a Logic.when guard tests of its subject and so establishes of its parameter inside its then branch: never
 * zero, never below zero, above zero (both), never NaN or an infinity, within two literal bounds (and so finite), or a
 * match of a literal pattern, its pattern value (ir/pattern.ts PatternValue). The first four are facts a term's
 * TypeScript type states; within states an interval, which no type does (scalar/compute/bounds.ts); matches retypes a
 * text subject as text of the pattern's language, the type str.regex(pattern) declares, the pattern read under the
 * flags "u" (ir/pattern.ts matchFlags).
 */
export type GuardDesc =
	| { readonly kind: "nonzero" }
	| { readonly kind: "nonnegative" }
	| { readonly kind: "positive" }
	| { readonly kind: "finite" }
	| { readonly kind: "within"; readonly low: LiteralDesc; readonly high: LiteralDesc }
	| { readonly kind: "matches"; readonly pattern: PatternValue }

/**
 * A Logic.when branch's parameter: `arg`, the when's subject, read where the when's `guard` holds of it, so the
 * lowering gives it what the guard establishes inside the when's branch (scalar/compute/typing.ts guarded). It stands
 * in for `arg` (core/canonical.ts standInTag): its identity text, digests, names and SQL are arg's, and only the JSON
 * form a Description crosses a process boundary in (descToJson) writes it, so a decode restores it.
 */
export interface GuardedDesc<L = Located, R extends Refs = Spelled> extends StandIn<"arg"> {
	readonly kind: "guarded"
	readonly guard: GuardDesc
	readonly arg: ExprDesc<L, R>
}

/**
 * The parameter of a Logic.when of `guard` over the subject `arg`: arg, guarded (GuardedDesc), a node like any other,
 * frozen with the description that holds it.
 */
export const guardedExpr = <L, R extends Refs>(
	guard: GuardDesc,
	arg: ExprDesc<L, R>
): GuardedDesc<L, R> => ({ kind: "guarded", guard, arg, [standInTag]: "arg" })

/**
 * An expression's leaves, the nodes that hold no term: a leaf of the references' (a rule variable, a check's field, the
 * contract's VALUE or a parent column), a scalar parameter and a literal.
 */
export type ExprLeaf<R extends Refs = Spelled> =
	| R["leaf"]
	| ({ readonly kind: "param"; readonly type: R["paramType"] } & R["param"])
	| { readonly kind: "literal"; readonly value: LiteralDesc; readonly type?: R["literalType"] }

/**
 * Terms and predicates in one vocabulary: one builder serves contract predicates, row checks,
 * query filters and computed outputs. `when` is the one guard of a partial operation: its then branch is computed
 * only where its guard holds of its subject, and the branch's parameter, a `guarded` node of the guard over the subject
 * (guardedExpr), is the one term there that has what the guard establishes; an occurrence of the subject read past the
 * parameter keeps its own facts, as TypeScript, which narrows a callback's parameter and never a term it captures,
 * types it. A `guarded` node is a proof's alone: it computes, prints and hashes as its `arg` (a stand-in,
 * core/canonical.ts standInTag), so a Description's identity text, digests and SQL are its subject's.
 */
/**
 * A term retyped to `to`, a type of its own base carrier (scalar/compute/types.ts sameCarrier), proved by an equality
 * of its scope and never checked: where `x = t` holds between two refinements of one carrier, its value is each side's,
 * so it lies in both sides' contracts, and t may stand for x at x's type. The engine writes it where its own query binds
 * a variable at a field of another refining type that an equality holds it to, a probe's guard at the guarded relation
 * (analysis/theory/query.ts standingAt); no builder does. It is typed as its argument restated at `to`
 * (scalar/compute/typing.ts Typing.retype), so it computes, prints and hashes as its argument: no node, no cast.
 */
export interface RetypeDesc<L = Located, R extends Refs = Spelled> {
	readonly kind: "retype"
	readonly to: FieldDesc
	readonly arg: ExprDesc<L, R>
}

export type ExprDesc<L = Located, R extends Refs = Spelled> =
	| ExprLeaf<R>
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
	| RetypeDesc<L, R>
	| GuardedDesc<L, R>
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
			 * A relational existence, which grizzle writes and no author does: whether `source` holds a fact at `bindings`,
			 * the positive twin of `absent`, a rule-level filter as it is. The checker reads it as a SemiJoin of the rule's
			 * region (ir/rel.ts), whose right side reads nothing of the region but the columns `bindings` correlates, and
			 * every lowering prints it EXISTS, which PostgreSQL plans as a semi-join.
			 */
			readonly kind: "exists"
			readonly source: SourceDesc<L, R>
			readonly bindings: BindingsDesc<L, R>
	  }
	| {
			/**
			 * Fn.call(f, args) of a declared function `function` that returns a value: a term for each of its
			 * arguments by the argument's name, each a value of the argument's type. The host never evaluates one: a call
			 * is read in SQL alone, and no contract predicate, row check or generated field holds one.
			 */
			readonly kind: "call"
			readonly function: string
			readonly args: Readonly<Record<string, ExprDesc<L, R>>>
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
 * A row check's refusal of a row, `(p) IS NOT TRUE`: true where its predicate p is false or NULL, false where p is
 * true, as a table's `CHECK ((p) IS TRUE)` refuses a row and a derived relation's rule's violation query filters its
 * rows, so the two discharges of one check agree at NULL (README, a row check refuses a row its condition leaves
 * unknown). Written CASE WHEN p THEN FALSE ELSE TRUE END, a NULL p taking the ELSE arm.
 */
export const refusalCondition = <L, R extends Refs>(predicate: ExprDesc<L, R>): ExprDesc<L, R> => ({
	kind: "cond",
	pred: predicate,
	onTrue: connectiveUnit("or"),
	onFalse: connectiveUnit("and")
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
 * A term an expression holds in its own scope, one of its children, with the segments the checker locates it below the
 * expression by (core/loc.ts childLoc): an operand of a list by its index, a named operand by its name, the arg a
 * guarded node stands in for by none, since it stands where the node does (GuardedDesc), a binding of an absent by
 * "bindings" and its column, and a term its source's bind map binds a parameter to by "bind" and the parameter.
 */
export interface ExprChild<L, R extends Refs> {
	readonly term: ExprDesc<L, R>
	readonly at: ReadonlyArray<string | number>
}

/** The segments of the named operands, one list each, shared by every child that stands at one. */
const named = {
	arg: ["arg"],
	pred: ["pred"],
	onTrue: ["onTrue"],
	onFalse: ["onFalse"],
	subject: ["subject"],
	proved: ["proved"],
	otherwise: ["otherwise"],
	left: ["left"],
	right: ["right"],
	low: ["low"],
	high: ["high"],
	point: ["point"],
	span: ["span"]
} as const satisfies Readonly<Record<string, readonly [string]>>

const standsWhereItsNodeDoes: ReadonlyArray<never> = Object.freeze([])

/**
 * The children of `e`: every term it holds in its own scope, in the order its description states them, each with the
 * segments it is located at (ExprChild). A leaf holds none. An absent holds the terms its source's bind map binds its
 * scalar parameters to, then its bindings: the bind map is read in the importing rule's scope, and the query the source
 * imports is a scope of its own, none of whose terms is a child of `e`. With mapExpr, the one spelling of which terms
 * each kind of expression holds, which every structural walk over expressions reads.
 */
export const exprChildren = <L, R extends Refs>(
	e: ExprDesc<L, R>
): ReadonlyArray<ExprChild<L, R>> => {
	const listed = (terms: ReadonlyArray<ExprDesc<L, R>>): ReadonlyArray<ExprChild<L, R>> =>
		terms.map((term, i) => ({ term, at: [i] }))
	switch (e.kind) {
		case "var":
		case "field":
		case "value":
		case "parent":
		case "param":
		case "literal":
			return []
		case "compute":
		case "and":
		case "or":
		case "closedAt":
		case "closedRow":
		case "closedHas":
			return listed(e.args)
		case "cast":
		case "base":
		case "retype":
		case "not":
		case "in":
			return [{ term: e.arg, at: named.arg }]
		case "guarded":
			return [{ term: e.arg, at: standsWhereItsNodeDoes }]
		case "cond":
			return [
				{ term: e.pred, at: named.pred },
				{ term: e.onTrue, at: named.onTrue },
				{ term: e.onFalse, at: named.onFalse }
			]
		case "when":
			return [
				{ term: e.subject, at: named.subject },
				{ term: e.proved, at: named.proved },
				{ term: e.otherwise, at: named.otherwise }
			]
		case "compare":
		case "allen":
			return [
				{ term: e.left, at: named.left },
				{ term: e.right, at: named.right }
			]
		case "between":
			return [
				{ term: e.arg, at: named.arg },
				{ term: e.low, at: named.low },
				{ term: e.high, at: named.high }
			]
		case "pointIn":
			return [
				{ term: e.point, at: named.point },
				{ term: e.span, at: named.span }
			]
		case "call":
			return Object.entries(e.args).map(([arg, term]) => ({ term, at: ["args", arg] }))
		case "absent":
		case "exists":
			return [
				...bindTerms(e.source).map(([param, term]) => ({ term, at: ["bind", param] })),
				...Object.entries(e.bindings).map(([column, term]) => ({ term, at: ["bindings", column] }))
			]
	}
}

/**
 * The terms a source's bind map binds its scalar parameters to, by parameter, in the importing rule's scope: an
 * imported query's and a navigation step's, and those of the bind map of each query a relation parameter is bound to
 * (`<param>.<its param>`); every other source binds none, and a relation parameter of the importer is no term.
 */
export const bindTerms = <L, R extends Refs>(
	s: SourceDesc<L, R>
): ReadonlyArray<readonly [string, ExprDesc<L, R>]> => {
	const scalar = (
		bind: BindMapDesc<L, R>,
		at: (param: string) => string
	): ReadonlyArray<readonly [string, ExprDesc<L, R>]> =>
		Object.entries(bind).flatMap(([param, b]) =>
			b.kind === "relationParam"
				? []
				: b.kind === "rows"
					? scalar(b.bind, (inner) => `${at(param)}.${inner}`)
					: [[at(param), b] as const]
		)
	switch (s.kind) {
		case "query":
		case "step":
			return scalar(s.bind, (param) => param)
		case "call":
		case "callField":
			return Object.entries(s.args).flatMap(([arg, a]) =>
				a.kind === "rows" ? scalar(a.bind, (param) => `${arg}.${param}`) : [[arg, a] as const]
			)
		case "split":
			return Object.entries(s.args)
		case "series":
			return [
				[seriesArguments.low, s.low],
				[seriesArguments.high, s.high]
			]
		case "relation":
		case "param":
		case "paramOf":
		case "interior":
		case "self":
		case "delta":
		case "context":
		case "row":
			return []
	}
}

/**
 * How mapExpr rebuilds an expression over references R as one over references S: each leaf by `leaf`, each child by
 * `term`, and an absent's source by `source`, which holds the bind map read in the expression's scope and the query
 * that is a scope of its own.
 */
export interface ExprMap<L, R extends Refs, S extends Refs> {
	readonly leaf: (e: ExprLeaf<R>) => ExprDesc<L, S>
	readonly term: (e: ExprDesc<L, R>) => ExprDesc<L, S>
	readonly source: (s: SourceDesc<L, R>) => SourceDesc<L, S>
}

/** Every field `e` reads, each once, in the order its description states them, depth first (exprChildren). */
export const exprFieldReads = <L, R extends Refs>(e: ExprDesc<L, R>): ReadonlyArray<string> => {
	const out = new Set<string>()
	const visit = (x: ExprDesc<L, R>): void => {
		if (x.kind === "field") {
			out.add(x.field)
		}
		for (const { term } of exprChildren(x)) {
			visit(term)
		}
	}
	visit(e)
	return [...out]
}

/**
 * `e` rebuilt by `m` (ExprMap): a leaf as `m.leaf` makes it, any other node with each child (exprChildren) mapped by
 * `m.term`, an absent's source by `m.source` before its bindings, and every other part as it is.
 */
export const mapExpr = <L, R extends Refs, S extends Refs>(
	e: ExprDesc<L, R>,
	m: ExprMap<L, R, S>
): ExprDesc<L, S> => {
	const term = (x: ExprDesc<L, R>): ExprDesc<L, S> => m.term(x)
	switch (e.kind) {
		case "var":
		case "field":
		case "value":
		case "parent":
		case "param":
		case "literal":
			return m.leaf(e)
		case "compute":
		case "closedRow":
			return { ...e, args: e.args.map(term) }
		case "and":
		case "or":
		case "closedAt":
		case "closedHas":
			return { ...e, args: mapNonEmpty(e.args, term) }
		case "cast":
		case "base":
		case "retype":
		case "guarded":
		case "not":
		case "in":
			return { ...e, arg: term(e.arg) }
		case "cond":
			return { ...e, pred: term(e.pred), onTrue: term(e.onTrue), onFalse: term(e.onFalse) }
		case "when":
			return {
				...e,
				subject: term(e.subject),
				proved: term(e.proved),
				otherwise: term(e.otherwise)
			}
		case "compare":
		case "allen":
			return { ...e, left: term(e.left), right: term(e.right) }
		case "between":
			return { ...e, arg: term(e.arg), low: term(e.low), high: term(e.high) }
		case "pointIn":
			return { ...e, point: term(e.point), span: term(e.span) }
		case "call":
			return { ...e, args: mapRecord(e.args, term) }
		case "absent":
		case "exists":
			return { ...e, source: m.source(e.source), bindings: mapBindingTerms(e.bindings, term) }
	}
}

/** Bindings with each term mapped by `f`, in their order. */
export const mapBindingTerms = <L, R extends Refs, S extends Refs>(
	b: BindingsDesc<L, R>,
	f: (e: ExprDesc<L, R>) => ExprDesc<L, S>
): BindingsDesc<L, S> =>
	Object.fromEntries(Object.entries(b).map(([column, e]) => [column, f(e)] as const))

/**
 * A bind map with each scalar term mapped by `f`, and so the bind map of each query's rows it binds a relation
 * parameter to, at any depth; a relation parameter of the importer is no term and stays as it is.
 */
export const mapBindMap = <L, R extends Refs>(
	bind: BindMapDesc<L, R>,
	f: (e: ExprDesc<L, R>) => ExprDesc<L, R>
): BindMapDesc<L, R> =>
	mapRecord(bind, (b): BindTermDesc<L, R> =>
		b.kind === "relationParam"
			? b
			: b.kind === "rows"
				? { ...b, bind: mapBindMap(b.bind, f) }
				: f(b)
	)

/** A source with each term its bind map binds (bindTerms) mapped by `f`, the query it imports kept whole. */
export const mapBindTerms = <L, R extends Refs>(
	s: SourceDesc<L, R>,
	f: (e: ExprDesc<L, R>) => ExprDesc<L, R>
): SourceDesc<L, R> => {
	const mapped = (bind: BindMapDesc<L, R>): BindMapDesc<L, R> => mapBindMap(bind, f)
	switch (s.kind) {
		case "query":
		case "step":
			return { ...s, bind: mapped(s.bind) }
		case "call":
		case "callField":
			return {
				...s,
				args: mapRecord(s.args, (a): CallArgDesc<L, R> =>
					a.kind === "rows" ? { ...a, bind: mapped(a.bind) } : f(a)
				)
			}
		case "split":
			return { ...s, args: mapRecord(s.args, f) }
		case "series":
			return { ...s, low: f(s.low), high: f(s.high) }
		case "relation":
		case "param":
		case "paramOf":
		case "interior":
		case "self":
		case "delta":
		case "context":
		case "row":
			return s
	}
}

/**
 * `e` with each child (exprChildren) mapped by `f` and every other part as it is: the bind map of an absent's source
 * among them, and the query it imports kept whole.
 */
export const mapExprChildren = <L, R extends Refs>(
	e: ExprDesc<L, R>,
	f: (term: ExprDesc<L, R>) => ExprDesc<L, R>
): ExprDesc<L, R> => mapExpr(e, { leaf: (x) => x, term: f, source: (s) => mapBindTerms(s, f) })

/**
 * A query read under a bind map, its parameters bound by its reader in the reader's scope: an imported query's source
 * (SourceDesc query and step), a call's rows argument and a relation parameter's bound rows (RowsDesc) alike.
 */
export interface ImportDesc<L = Located, R extends Refs = Spelled> {
	readonly query: QueryDesc<L, R["nested"]>
	readonly bind: BindMapDesc<L, R>
}

/**
 * The rows of a query read where a relation is taken, a call's rows argument or a relation parameter's binding: the
 * query, its own scope, and the bind map its reader binds its parameters by (ImportDesc). No term is of kind "rows",
 * so the kind tells them apart from a term.
 */
export interface RowsDesc<L = Located, R extends Refs = Spelled> extends ImportDesc<L, R> {
	readonly kind: "rows"
}

/**
 * A relation-valued term a relation parameter of an imported query is bound to, of the parameter's heading: a relation
 * parameter of the importing rule by name, or the rows of a query (RowsDesc), a query or a bound query over a level the
 * import's level is a level of or that is a level of it, read in the importing rule's scope, as a scalar binding is.
 */
export type RelationTermDesc<L = Located, R extends Refs = Spelled> =
	| ({ readonly kind: "relationParam" } & R["param"])
	| RowsDesc<L, R>

/**
 * What an imported query's bind map binds one of its parameters to: a scalar parameter a term, and a relation
 * parameter a relation-valued term (RelationTermDesc).
 */
export type BindTermDesc<L = Located, R extends Refs = Spelled> =
	| ExprDesc<L, R>
	| RelationTermDesc<L, R>

/** An imported query's bind map: each of its parameters bound to what the importer gives it. */
export type BindMapDesc<L = Located, R extends Refs = Spelled> = Readonly<
	Record<string, BindTermDesc<L, R>>
>

/**
 * What a call of a set-returning declared function gives one of its arguments: a value, the term itself, of the
 * caller's scope, a variable, a parent variable, a parameter or a typed constant, as a bind map binds one; or the rows
 * of a query whose heading is the argument's heading, its parameters bound by the caller as an import's are (`bind`),
 * which the call passes as an array of the argument's row type. No term is of kind "rows", so the kind tells them apart.
 */
export type CallArgDesc<L = Located, R extends Refs = Spelled> = ExprDesc<L, R> | RowsDesc<L, R>

/**
 * The declared functions a Description calls, by name, at any depth: each call term (ExprDesc call) and each call
 * source (SourceDesc call and callField) it holds, through its imports, attachments, interiors, rows arguments, members
 * and read-backs alike. A Description is plain data, records and lists, and a call is a node of kind "call" or
 * "callField" that names a `function`, so the walk needs no case for any other. A Description shares a part by
 * reference wherever it reads it (an imported query at every import, a bound query at every read), so the walk reads
 * each record and list once, where reading it at every reference expanded the sharing into a tree; the functions are a
 * set, which a second reading adds nothing to.
 */
export const callsOf = (desc: unknown): ReadonlySet<string> => {
	const out = new Set<string>()
	const read = new Set<object>()
	const walk = (node: unknown): void => {
		if (typeof node !== "object" || node === null || read.has(node)) {
			return
		}
		read.add(node)
		if (Array.isArray(node)) {
			for (const item of node) {
				walk(item)
			}
			return
		}
		if (!isRecord(node)) {
			return
		}
		const record = node
		const called = record["function"]
		if (
			(record["kind"] === "call" || record["kind"] === "callField") &&
			typeof called === "string"
		) {
			out.add(called)
		}
		for (const value of Object.values(record)) {
			walk(value)
		}
	}
	walk(desc)
	return out
}

/** What `match` consumes. */
export type SourceDesc<L = Located, R extends Refs = Spelled> =
	| { readonly kind: "relation"; readonly name: string }
	| {
			readonly kind: "query"
			readonly query: QueryDesc<L, R["nested"]>
			readonly bind: BindMapDesc<L, R>
	  }
	| {
			/**
			 * A step of a navigation (analysis/theory/query.ts navigate), which grizzle writes and no author does: an
			 * imported query read apart from every other source of the rule that reads it, its channels (Channel) bound by
			 * `bind` to what the steps before it bound. The checker reads it as the import it holds, under a Step node
			 * (ir/rel.ts Step), which every lowering prints as a subquery the planner never merges into its reader.
			 */
			readonly kind: "step"
			readonly query: QueryDesc<L, R["nested"]>
			readonly bind: BindMapDesc<L, R>
	  }
	| ({ readonly kind: "param"; readonly heading: Readonly<Record<string, FieldDesc>> } & R["param"])
	| ({ readonly kind: "paramOf"; readonly relation: string } & R["param"])
	| {
			/**
			 * Fn.call(f, args) of a declared function `function` that returns rows: its result's rows, matched like a
			 * table, each argument by its name (CallArgDesc), each read where the match stands.
			 */
			readonly kind: "call"
			readonly function: string
			readonly args: Readonly<Record<string, CallArgDesc<L, R>>>
	  }
	| {
			/**
			 * Fn.row(f, args)[field] of a declared function `function` that returns one row: the rows `field` holds,
			 * a field of the row of rows of a heading of values, matched like a table, each argument by its name
			 * (CallArgDesc), each read where the match stands, as a call's rows are (`call`). Every read of a field of one
			 * call at one argument tuple reads one evaluation of it.
			 */
			readonly kind: "callField"
			readonly function: string
			readonly args: Readonly<Record<string, CallArgDesc<L, R>>>
			readonly field: string
	  }
	| {
			/**
			 * One of grizzle's splits of a text into rows (ir/rel.ts TextSplit): r.tokens(text), the tokens of a
			 * whitespace-separated list (XML Schema Part 2 §3.3.10, a list's lexical space), each a fact of
			 * `tokensHeading`; r.split(text, separator), the text's pieces between its separators, each a fact of
			 * `piecesHeading`; r.rest(text, prefix), the text after its prefix, one fact of `restHeading` or none; and
			 * r.decodedPath(text), the path a percent-encoded path spells, one fact of `decodedPathHeading` or none.
			 * `args` holds the split's arguments by name (ir/rel.ts splitArguments), each a term of the scope the match
			 * stands in, a variable, a parent variable, a parameter or a typed constant, as a call's value argument is, so
			 * the facts are a function of the binding the match stands at.
			 */
			readonly kind: "split"
			readonly split: TextSplit
			readonly args: Readonly<Record<string, ExprDesc<L, R>>>
	  }
	| {
			/**
			 * r.series(low, high): each integer from `low` to `high`, both included, a fact of `seriesHeading` each,
			 * none where `low` lies above `high`. Each end is a term of the scope the match stands in, of an integer type,
			 * computed from its variables, parameters and constants, so the facts are a function of the binding the match
			 * stands at, and every one lies between the least value `low` takes and the greatest `high` takes, which a
			 * term of the rule reads of it (check/checker.ts, typing.ts HeldLeaf).
			 */
			readonly kind: "series"
			readonly low: ExprDesc<L, R>
			readonly high: ExprDesc<L, R>
	  }
	| { readonly kind: "interior"; readonly id: R["interior"] }
	| { readonly kind: "self" }
	| { readonly kind: "delta"; readonly side: DeltaSide; readonly relation: string }
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
 * Where a context's one fact comes from, which its declaration states once: `token`, the claims the layer's verify
 * returns for the Db's token, read from the payload's top level or from the nested claim object `claim` names; or
 * `attested`, the facts the server itself states where it opens the Db (Db.open's `attested`, an HTTP handler's
 * `attest` of its request), which no token, request body or other client input reaches. A context is of one source,
 * so no claim of a client's stands for a fact its server attests.
 */
export type ContextFactSource =
	| { readonly kind: "token"; readonly claim: string | undefined }
	| { readonly kind: "attested" }

/** The kinds of a context's source (ContextFactSource). */
export type ContextFactSourceKind = ContextFactSource["kind"]

/**
 * A context: the session's relation parameters, bound once per Db, holding at most one fact, from its source
 * (ContextFactSource). Its fields are scalar types only (contextFieldAdmits). It belongs to no schema, has no laws and
 * is never written.
 */
export interface ContextDesc {
	readonly name: string
	readonly fields: Readonly<Record<string, FieldDesc>>
	readonly source: ContextFactSource
}

/**
 * The field types a context admits: text, uuid, boolean, the integer types, inet and cidr, a contract over one of them,
 * and a closed handle. A claim is a JSON scalar, read back through its field's cast.
 */
export const contextFieldAdmits = (desc: FieldDesc): boolean => {
	switch (desc.kind) {
		case "pg":
			return (
				desc.type === "smallint" ||
				desc.type === "integer" ||
				desc.type === "bigint" ||
				desc.type === "boolean" ||
				desc.type === "inet" ||
				desc.type === "cidr"
			)
		case "uuid":
		case "text":
		case "closedId":
			return true
		case "contract":
			return desc.name !== "instant" && contextFieldAdmits(desc.base)
		case "numeric":
		case "exact":
		case "computedNumeric":
		case "pattern":
		case "bytes":
		case "sha256":
		case "span":
		case "bits":
		case "vector":
		case "search":
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

/** A span producer in a head: pack over one span term, intersection and difference over two, and span over a start
 * and an end, two endpoints of one type. */
export type ProducerDesc<L = Located, R extends Refs = Spelled> =
	| { readonly kind: "producer"; readonly fn: "pack"; readonly args: readonly [ExprDesc<L, R>] }
	| {
			readonly kind: "producer"
			readonly fn: "intersection" | "difference" | "span"
			readonly args: readonly [ExprDesc<L, R>, ExprDesc<L, R>]
	  }

/** A producer with each argument mapped by `f`, keeping its arity. */
const mapProducer = <L, M, R1 extends Refs, R2 extends Refs>(
	p: ProducerDesc<L, R1>,
	f: (e: ExprDesc<L, R1>) => ExprDesc<M, R2>
): ProducerDesc<M, R2> =>
	p.fn === "pack"
		? { kind: "producer", fn: p.fn, args: [f(p.args[0])] }
		: { kind: "producer", fn: p.fn, args: [f(p.args[0]), f(p.args[1])] }

/**
 * The scalar terms a head term holds: an aggregate's argument, none for count, a producer's arguments, or the term
 * itself where it is a scalar expression.
 */
export const headTerms = <L, R extends Refs>(
	h: HeadTermDesc<L, R>
): ReadonlyArray<ExprDesc<L, R>> =>
	h.kind === "aggregate" ? (h.fn === "count" ? [] : [h.arg]) : h.kind === "producer" ? h.args : [h]

/** A head term with each scalar term it holds (headTerms) mapped by `f`, keeping its kind and arity. */
export const mapHeadTerms = <L, M, R1 extends Refs, R2 extends Refs>(
	h: HeadTermDesc<L, R1>,
	f: (e: ExprDesc<L, R1>) => ExprDesc<M, R2>
): HeadTermDesc<M, R2> =>
	h.kind === "aggregate"
		? h.fn === "count"
			? { kind: "aggregate", fn: h.fn }
			: { kind: "aggregate", fn: h.fn, arg: f(h.arg) }
		: h.kind === "producer"
			? mapProducer(h, f)
			: f(h)

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

/** The fields a definition derives: its first rules' head, through every stage that keeps its input's heading. */
export const definitionFields = <L>(query: QueryDesc<L>): ReadonlyArray<string> => {
	const fields = (stage: QueryStageDesc<L>): ReadonlyArray<string> => {
		switch (stage.kind) {
			case "rules":
				return Object.keys(stage.arms[0].head)
			case "recursive":
				return Object.keys(stage.recursive.row)
			case "union":
			case "named":
			case "order":
			case "take":
			case "approx":
				return fields(stage.input)
			case "attach":
				return [...fields(stage.input), stage.attach.name]
		}
	}
	return fields(query.stage)
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
export const conjunctsOf = (predicate: ExprDesc): ReadonlyArray<ExprDesc> =>
	predicate.kind === "and"
		? predicate.args.flatMap(conjunctsOf)
		: predicate.kind === "literal" && predicate.value === true
			? []
			: [predicate]

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
 * - A tree, tree(on(T, "parent", "at"), fin(T, n), { root }), is the ordered family of T over itself, T keyed by its
 *   root fields `root`, the caller's fields each tree's rows share, then its drawn `start`, whose every row but each
 *   root, the one self-parented row of its tree, is a member, its drawn `parent` its parent's start, with T's drawn
 *   `start` and `end` its pre-order interval.
 * - A fold, fold(family, Monoid.m, step, end), combines its family's members' step values by `monoid` in slot order
 *   into each owner's end fields: the family by its slots, `step` over the member and `end` over the owner. Its step is
 *   read per member row, each member once by its key in the family, where a key's or a containment's side is a set of
 *   tuples: two members of one step value both step.
 * - alternatives(parent, discriminator, roster, arms) is its own statement, which expandAlternatives states.
 * - race(R) makes R's primary key first come, first held: an insertion at a key another row holds meets that row,
 *   never refused for differing from it (ir/law.ts Inserts).
 * - unit(name, heading) declares a unit: a key a family of rows sits under, each value of it one lock. It names no
 *   relation: every stored relation whose primary key leads with its heading's fields, by name and type in order, sits
 *   under it (schema/own.ts OwnedUnit), and states no law.
 * - series(R) declares R's one primary key field, natural or a contract over an integer (scalar/natural.ts isDrawnType),
 *   a series, 0, 1, 2, … with no gap, which expandSeries states, whose appends queue on one lock of their own: the only
 *   lock no key splits.
 */
export type StatementDesc<L = Located> = L &
	(
		| { readonly kind: "key"; readonly side: SideDesc }
		| { readonly kind: "mutable"; readonly relation: string }
		| { readonly kind: "race"; readonly relation: string }
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
				readonly root: NonEmptyReadonlyArray<string>
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
		| {
				readonly kind: "unit"
				/** The unit's name, its lock's: a value of its key is one lock, which no other unit's value is. */
				readonly name: string
				/** The unit's key: its fields in order, each with its type, which every member's primary key leads with. */
				readonly heading: NonEmptyReadonlyArray<UnitFieldDesc>
		  }
		| {
				readonly kind: "series"
				/** The series' relation, whose primary key is `field` alone. */
				readonly relation: string
				/** Its one primary key field, of a drawn type, which runs 0, 1, 2, … with no gap. */
				readonly field: string
		  }
	)

/** A field of a unit's key: its name and its type, which a member's field of that name is of. */
export interface UnitFieldDesc {
	readonly field: string
	readonly type: FieldDesc
}

/** A unit statement's Description. */
export type UnitDesc<L = Located> = Extract<StatementDesc<L>, { readonly kind: "unit" }>

/** A series statement's Description. */
export type SeriesDesc<L = Located> = Extract<StatementDesc<L>, { readonly kind: "series" }>

/**
 * The containment a series statement states: each number's predecessor is a number of the series, so its numbers run
 * from 0 with no gap. Pure: ownership and the theory call it.
 */
export const expandSeries = (s: SeriesDesc): ContainedDesc => ({
	kind: "contained",
	left: {
		relation: s.relation,
		terms: [{ kind: "pred", field: s.field }],
		selection: { conjuncts: [] }
	},
	right: {
		relation: s.relation,
		terms: [{ kind: "field", field: s.field }],
		selection: { conjuncts: [] }
	},
	loc: s.loc
})

/** Whether two field types are one type: one canonical text (descText), a type's identity. */
const sameFieldType = (a: FieldDesc, b: FieldDesc): boolean => {
	const left = descText(a)
	const right = descText(b)
	return left.ok && right.ok && left.value === right.value
}

/**
 * Whether a key leads with the fields of `heading`, a unit's or another's: its first fields are the heading's, by name
 * and in order, each of the heading's type (`typeOf` a field's type), so every row keyed by it holds the heading's key
 * there. A relation whose primary key leads with a unit's heading sits under the unit, and two units one of whose
 * headings leads with the other's would nest.
 */
export const leadsWithHeading = (
	heading: NonEmptyReadonlyArray<UnitFieldDesc>,
	key: ReadonlyArray<string>,
	typeOf: (field: string) => FieldDesc | undefined
): boolean =>
	heading.length <= key.length &&
	heading.every((f, at) => {
		const type = typeOf(f.field)
		return key[at] === f.field && type !== undefined && sameFieldType(type, f.type)
	})

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
					right: { kind: "literal", value: only }
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
		byRelation.getOrInsertComputed(arm.relation, () => ({ arm, handles: [] })).handles.push(handle)
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
 * - caller: by the caller, a field of instant's type among them, a stored copy of an instant a read delivered
 *   (instant.stored), which the database draws nothing of.
 * - instant: by the database's clock, a field of instant's type (ir/instant.ts instantName), stamped by the insert that
 *   adds its row where it is its relation's clock, or carried from a stored instant where it is a reference, as the
 *   schema's laws make it (analysis/theory/instants.ts). So an instant the database draws and one stored as it is are
 *   two writings of one type, never a flag.
 * - generated: by PostgreSQL from the field's own row, a STORED generated column.
 * - drawn: by grizzle from the nested arrays its caller writes: a family's index or count, or a tree's start or end,
 *   which exactly one family or tree statement names.
 * - accumulated: by grizzle on the host, and proved by PostgreSQL: a fold's accumulator or a copy along a family axis,
 *   `start` at the axis's base, which exactly one fold or axis containment carries.
 * - place: by the insert that adds its row, a natural the database stamps one past its group's greatest, 0 for the
 *   first, so every group's places run gapless from 0 in the order its rows were inserted; `order` how a migration that
 *   adds the place numbers the rows it finds stored (PlaceOrderDesc, ir/instant.ts PlaceHead).
 */
export type Writing<L = Located> =
	| { readonly kind: "caller" }
	| { readonly kind: "instant" }
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
	| { readonly kind: "place"; readonly order: PlaceOrderDesc }

/**
 * How a migration that adds a place to a table holding rows numbers them (ir/instant.ts PlaceOrder), the one thing a
 * place's declaration says beyond the place itself: `unordered`, which states no order, so a migration adds it only
 * where every stored row stands alone in its group and takes place 0; or `by`, the relation's field that orders each
 * group's stored rows.
 */
export type PlaceOrderDesc =
	| { readonly kind: "unordered" }
	| { readonly kind: "by"; readonly by: string }

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
 * handles: an ordered roster's in declared order, which is their codes' order and comparison order; an unordered one's,
 * which states `order`, a set in one canonical order (ir/scalar.ts Roster), whose codes follow no order. An ordered
 * roster states nothing beside its name and handles, whose order is its own, so its canonical form, and every
 * fingerprint over it, is its name and handles alone. A closed relation (closedRelation) relates existing values,
 * the closed ids of its key and its payload, by rows fixed when the schema compiles: its key is required, a set lists
 * every field, and no two rows share a key. A derived relation is a named query, its rows its definition's, which
 * PostgreSQL stores in a table the judge's upkeep keeps where it is stored.
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
				readonly handles: ReadonlyArray<string>
		  }
		| {
				readonly kind: "closed"
				readonly name: string
				readonly handles: ReadonlyArray<string>
				readonly order: StatedRosterOrder
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
				/** Each row a value of every field, its key fields' values handles of their rosters, as written. */
				readonly rows: ReadonlyArray<ClosedRow>
		  }
		| {
				readonly kind: "derived"
				readonly name: string
				readonly query: QueryDesc<L>
				/** The derived level: 1 over base relations, n + 1 over a level-n derived relation. */
				readonly level: number
				/** Whether PostgreSQL stores its rows: never, every read and rule reading its definition; or in a
				 * table of its own, which grizzle keeps equal to its definition at every COMMIT. */
				readonly storage: DerivedStorage
		  }
	)

/**
 * How a derived relation is held: `live`, its definition alone, which every query matching it and every rule over it
 * reads; or `stored`, its rows in a table of its own, which grizzle keeps equal to its definition at every COMMIT, for
 * every writer, admitted only where its definition is unit-local (analysis/theory/unit.ts storedUnit): the judge's
 * phase A replaces its rows at the units a transaction wrote (physical/ddl/rules.ts), and the migration that creates it
 * fills it (deploy/diff/diff.ts).
 */
const derivedStorages = ["live", "stored"] as const
export type DerivedStorage = (typeof derivedStorages)[number]

/** Whether PostgreSQL holds a derived relation's rows: a stored one's, in its table. */
export const derivedHeld = (storage: DerivedStorage): boolean => storage === "stored"

/** A closed relation's row: a value of each of its fields. */
export type ClosedRow = Readonly<Record<string, LiteralDesc>>

/**
 * The orders a roster's Description states: an unordered roster's, whose handles' order is no order of theirs, and a
 * zone roster's, whose handles are time zones. An ordered roster's handles are its order, which it states by stating
 * none (RelationDesc), so its canonical form is its name and handles alone. The Description's type and its decoder
 * (relationDescShape's `closed`) both read this one list.
 */
const statedRosterOrders = ["unordered", "zones"] as const satisfies ReadonlyArray<RosterOrder>
type StatedRosterOrder = (typeof statedRosterOrders)[number]

/** A roster's Description: an ordered roster's, or an unordered or zone one's, which states its order. */
export type RosterDesc<L = Located> = Extract<RelationDesc<L>, { readonly kind: "closed" }>

/** The order a roster's Description states: an unordered or zone roster's states it, and an ordered one's handles are
 * its order. */
export const rosterOrderOf = (desc: RosterDesc): RosterOrder =>
	"order" in desc ? desc.order : "ordered"

/** What a roster's Description declares beside its name: its order and its handles in that order. */
export const declaredRoster = (desc: RosterDesc): RosterHandles => ({
	order: rosterOrderOf(desc),
	handles: desc.handles
})

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
			return derivedHeld(relation.storage)
	}
}

/** A field of a declared function's heading, or one of its arguments: its declared name and its type. */
export interface NamedDesc<T> {
	readonly name: string
	readonly type: T
}

/**
 * The heading of the rows a declared function takes or returns (schema/function.ts rows): its fields in code point
 * order of their names, never the order a record's keys were written in, at least one, each of a type a signature
 * takes, which installs as a row type, its attributes in that order.
 */
export type HeadingDesc = NonEmptyReadonlyArray<NamedDesc<FunctionTypeDesc>>

/**
 * What a declared function takes as an argument, gives as its result or holds in a field of a heading: one value of a
 * field's type; rows of a heading, which installs as a row type, an array of it as an argument or a field and a set of
 * it as a result; or one row of a heading (schema/function.ts row), a value of its row type, a composite.
 */
export type FunctionTypeDesc =
	| { readonly kind: "value"; readonly type: FieldDesc }
	| { readonly kind: "rows"; readonly heading: HeadingDesc }
	| { readonly kind: "row"; readonly heading: HeadingDesc }

/** What a function type is, as a refusal names it: a value, rows, or one row. */
export const functionTypeLabel = (t: FunctionTypeDesc): string => {
	switch (t.kind) {
		case "value":
			return "a value"
		case "rows":
			return "rows"
		case "row":
			return "one row"
	}
}

/**
 * A heading as a query reads or builds its rows: each field a value of a field's type, or undefined for a heading with
 * a field of rows or of a row of another, which no relation's field holds, so a query neither reads a set of its rows
 * nor builds an array of them, and only a function's body passes one.
 */
export const valueHeading = (
	heading: HeadingDesc
): NonEmptyReadonlyArray<NamedDesc<FieldDesc>> | undefined => {
	const fields: Array<NamedDesc<FieldDesc>> = []
	for (const f of heading) {
		if (f.type.kind !== "value") {
			return undefined
		}
		fields.push({ name: f.name, type: f.type.type })
	}
	return isNonEmpty(fields) ? fields : undefined
}

/**
 * A declared function's body (schema/function.ts fn.body): the application's text, and between its runs the row types
 * it names, each a heading the function's own signature or a callee's holds, which the installation names by its row
 * type's name alone (physical/ddl/functions.ts), so the text installed is `text`, then each named row type's name and
 * the text after it. A body that names none is its text alone, `named` empty.
 */
export interface FunctionBodyDesc {
	readonly text: string
	readonly named: ReadonlyArray<{ readonly rowType: HeadingDesc; readonly text: string }>
}

/**
 * What every declared function's Description states (FunctionDesc): its name, the declared functions its body calls,
 * its arguments in code point order of their names, its parameters' order, what it returns, its volatility, and its
 * body in its language, the application's own text, which PostgreSQL stores byte for byte.
 */
interface DeclaredFunctionDesc {
	readonly name: string
	/**
	 * The declared functions its body calls, by name, each once, in code point order: its call graph, which the
	 * installation creates its functions in the order of, its callees first, so PostgreSQL validates an SQL body whose
	 * callees all stand as it creates it.
	 */
	readonly calls: ReadonlyArray<string>
	readonly args: ReadonlyArray<NamedDesc<FunctionTypeDesc>>
	readonly returns: FunctionTypeDesc
	readonly volatility: FunctionVolatility
	readonly language: DeclaredLanguage
	readonly body: FunctionBodyDesc
}

/**
 * The null inputs a function's Description states: a strict function's, whose body runs only where every argument is
 * a value. A function called on NULL input states none, as PostgreSQL's CREATE FUNCTION states none for it, so its
 * canonical form, and every fingerprint over it, is what it was before a function could be strict. The Description's
 * type and its decoder (functionDescShape) both read this one list.
 */
const statedNullInputs = ["strict"] as const satisfies ReadonlyArray<FunctionNullInput>
type StatedNullInput = (typeof statedNullInputs)[number]

/**
 * A function the application declares in a level (schema/function.ts fn): what every one states
 * (DeclaredFunctionDesc), and its null input where it is strict (nullInputOf).
 */
export type FunctionDesc<L = Located> = L &
	(DeclaredFunctionDesc | (DeclaredFunctionDesc & { readonly nullInput: StatedNullInput }))

/** What a declared function does with a NULL argument: a strict one's Description states it, and every other is called. */
export const nullInputOf = (desc: FunctionDesc): FunctionNullInput =>
	"nullInput" in desc ? desc.nullInput : "called"

export type SchemaDesc<L = Located> = L & {
	readonly name: string
	readonly relations: ReadonlyArray<SchemaRelationOf<L>>
	readonly statements: ReadonlyArray<StatementDesc<L>>
	/**
	 * The functions the level declares, by name, at least one; the member is absent from a level that declares none, its
	 * one spelling of none, so a schema that declares no function has the text and fingerprint it had before a level
	 * could declare one.
	 */
	readonly functions?: NonEmptyReadonlyArray<FunctionDesc<L>>
	/**
	 * schema.extend: the levels this one builds on, under its own name, none for a root. A list, a level over several
	 * bases its one representation, of at most one base until such a level is built (SchemaBases): schema.extend refuses
	 * a second, as the decoder does.
	 */
	readonly bases: SchemaBases<SchemaDesc<L>>
}

/** A level's bases, of a level D: none for a root, or the one level it extends. */
export type SchemaBases<D> = readonly [] | readonly [D]

/**
 * A description's levels, root first and `desc` last, each level once: each level's bases before it (SchemaBases), the
 * one order every reader of a schema's levels reads them in.
 */
export const levelChain = <D extends { readonly bases: SchemaBases<D> }>(
	desc: D
): NonEmptyReadonlyArray<D> => {
	const [base] = desc.bases
	return base === undefined ? [desc] : appendNonEmpty(levelChain(base), desc)
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
	readonly functions?: NonEmptyReadonlyArray<FunctionDesc>
	readonly bases: SchemaBases<UnadmittedSchemaDesc>
}

/**
 * Worlds. A role is relations defined over its base, a schema: each entry is a whole relation of the base under its
 * own name; a world relation, a query over the base installed as a view; or a scoped relation, a relation of the base
 * under its own name held by its owner's rows, its query the row predicate scopedEntriesOf built (schema/scope.ts),
 * which ownership parses as a scope. `write` names role relations. A login is one credential and one pool
 * for roles over one base.
 */
export type RoleEntryDesc<L = Located> =
	| (L & { readonly kind: "whole"; readonly name: string })
	| (L & { readonly kind: "world"; readonly name: string; readonly query: QueryDesc<L> })
	| (L & { readonly kind: "scoped"; readonly name: string; readonly query: QueryDesc<L> })

/**
 * How a role writes the role relations it names: by every operation its programs make (`write`), or by inserting alone
 * (`insert`), a role that holds no DELETE or UPDATE on any of them (physical/ddl/roles.ts grantedPrivileges). A role
 * states one of the two.
 */
export type RoleWriting =
	| { readonly write: ReadonlyArray<string> }
	| { readonly insert: NonEmptyReadonlyArray<string> }

export type RoleDesc<L = Located> = L & {
	readonly name: string
	readonly base: SchemaDesc<L>
	readonly relations: NonEmptyReadonlyArray<RoleEntryDesc<L>>
	/**
	 * The contexts the role declares, each name once: the facts its Db's claims hold, decoded from the verified token,
	 * and the only contexts its query entries and its programs match.
	 */
	readonly contexts: ReadonlyArray<ContextDesc>
} & RoleWriting

/** The role relations a role writes, by whichever of `write` and `insert` it states. */
/** The key a role states its written relations under. */
export type RoleWritingKey = "write" | "insert"
export const writtenNames = (writing: RoleWriting): ReadonlyArray<string> =>
	"insert" in writing ? writing.insert : writing.write

export type LoginDesc<L = Located> = L & {
	readonly name: string
	readonly base: SchemaDesc<L>
	readonly roles: NonEmptyReadonlyArray<RoleDesc<L>>
}

/**
 * What a field-equality member equates one field of its relation to: a parameter, by its name and declared type, or a
 * literal, whose type the checker reads from the field it meets, as a head literal's (query/build/terms.ts
 * literalTerm).
 */
export type EqualedDesc =
	| { readonly kind: "param"; readonly name: string; readonly type: FieldDesc }
	| { readonly kind: "literal"; readonly value: LiteralDesc }

/**
 * ChangeSets. An array or Stream member names the slot its facts travel in; the facts are values,
 * outside the Description and outside template identity. A query member is its query. A field-equality member,
 * `equal`, is the facts of its relation whose named fields equal what it equates them to, each a parameter or a
 * literal: the query that matches the relation's facts as its member writes them and keeps those whose fields are
 * equal, which the write front end makes of it where it knows the member's heading (write/frontend/equal.ts), so
 * the planner holds it as the query member it is (PlannedMemberDesc).
 */
type MemberSourceDesc<L = Located> =
	| { readonly kind: "array"; readonly slot: string }
	| { readonly kind: "stream"; readonly slot: string }
	| { readonly kind: "query"; readonly query: QueryDesc<L> }
	| { readonly kind: "equal"; readonly fields: Readonly<Record<string, EqualedDesc>> }

/**
 * The fields of an insert's host rows the call computes (ChangeSet.insert's third argument): `query`, one rule that
 * matches nothing and finds each field's value, a term over the call's scalar parameters, its clock reading and
 * literals, so one row, one value of each field for the whole call. Every array and Stream insert of its relation in its
 * stratum leaves those fields out and takes them from it (write/frontend/compile.ts); it writes no row of its own.
 */
export interface ComputedSourceDesc<L = Located> {
	readonly kind: "computed"
	readonly query: QueryDesc<L>
}

/** What an insert member's facts are: a member's source, or the fields its stratum's host rows leave out for the call
 * to compute. */
export type InsertSourceDesc<L = Located> = MemberSourceDesc<L> | ComputedSourceDesc<L>

/** What a member does to its relation's facts: inserts, deletes or puts them. */
export type WriteOp = "insert" | "delete" | "put"

/**
 * A member: a write of its relation, `op` its facts' operation, an insert's facts its source or the fields its host
 * rows leave out for the call to compute.
 */
export type MemberDesc<L = Located> = L &
	(
		| {
				readonly op: "insert"
				readonly relation: string
				readonly member: InsertSourceDesc<L>
		  }
		| {
				readonly op: "delete" | "put"
				readonly relation: string
				readonly member: MemberSourceDesc<L>
		  }
	)

/** A write member of facts: every write member but an insert's computed fields (ComputedSourceDesc), which writes no
 * row of its own. */
export type FactsMemberDesc<L = Located> = L & {
	readonly op: WriteOp
	readonly relation: string
	readonly member: MemberSourceDesc<L>
}

/** A member as the planner reads it: an array, a Stream or a query, a field-equality member made its query. */
export type PlannedMemberDesc<L = Located> = L & {
	readonly op: WriteOp
	readonly relation: string
	readonly member: Exclude<MemberSourceDesc<L>, { readonly kind: "equal" }>
}

/** The parameters a field-equality member's fields name, by name. */
export const equalParamNames = (
	fields: Readonly<Record<string, EqualedDesc>>
): ReadonlySet<string> =>
	new Set(Object.values(fields).flatMap((e) => (e.kind === "param" ? [e.name] : [])))

/** A field-equality member's fields with each parameter whose name `rename` maps spelled by its image, frozen as a
 * decoded Description is; ChangeSet.bind uses it as it uses renameQueryParams. */
export const renameEqualParams = (
	fields: Readonly<Record<string, EqualedDesc>>,
	rename: ReadonlyMap<string, string>
): Readonly<Record<string, EqualedDesc>> =>
	Object.freeze(
		Object.fromEntries(
			Object.entries(fields).map(([field, e]): readonly [string, EqualedDesc] => [
				field,
				e.kind === "param" ? Object.freeze({ ...e, name: rename.get(e.name) ?? e.name }) : e
			])
		)
	)

/** The parameters a member needs, by name: a query's and a computed record's (queryParamNames), a field-equality
 * member's, an array's or a Stream's none, its facts being values. */
export const memberParamNames = (member: InsertSourceDesc): ReadonlySet<string> => {
	switch (member.kind) {
		case "array":
		case "stream":
			return new Set()
		case "query":
		case "computed":
			return queryParamNames(member.query)
		case "equal":
			return equalParamNames(member.fields)
	}
}

export interface ReadBackDesc<L = Located> {
	readonly name: string
	readonly query: QueryDesc<L>
}

/**
 * A ChangeSet's Description names no schema, as a QueryDesc names none: a ChangeSet value carries what it was built
 * over, and a described ChangeSet compiles against the schema its caller names.
 */
export interface ChangeSetDesc<L = Located> {
	/** One stratum unless built with ChangeSet.sequence. */
	readonly strata: ReadonlyArray<{ readonly members: ReadonlyArray<MemberDesc<L>> }>
	readonly reads: ReadonlyArray<ReadBackDesc<L>>
	/** The parameters ChangeSet.bind closed with a value; their values travel with the ChangeSet value. */
	readonly bindings: ReadonlyArray<string>
	/**
	 * The relation parameters ChangeSet.bind closed with a query or a bound query (BoundRowsDesc), each an input of the
	 * call evaluated once, before the first stratum of the part it was bound on, which every member and read-back that
	 * reads the parameter reads. Its members and read-backs read the parameter by its name, as they read one bound to a
	 * value, never a copy of its query.
	 */
	readonly boundRows: Readonly<Record<string, BoundRowsDesc<L>>>
}

/**
 * A relation parameter a ChangeSet binds to rows (ChangeSetDesc `boundRows`): `rows`, a query or a bound query
 * (RowsDesc), its bind map read in the ChangeSet's namespace, and `stratum`, the first stratum of the part the bind was
 * made on, a binding being scoped to that part as a let is to its body: the rows are evaluated once, in the state before
 * that stratum, after every write of the strata before it. A bind on the whole ChangeSet is at its stratum 0;
 * ChangeSet.sequence places each binding of its second part after the first part's strata, and union keeps each where
 * it was, as both place the members.
 */
export interface BoundRowsDesc<L = Located> {
	readonly stratum: number
	readonly rows: RowsDesc<L>
}

/** A ChangeSet's Description as the planner reads it: every member a PlannedMemberDesc (write/frontend/compile.ts). */
export interface PlannedChangeSetDesc<L = Located> {
	readonly strata: ReadonlyArray<{ readonly members: ReadonlyArray<PlannedMemberDesc<L>> }>
	readonly reads: ReadonlyArray<ReadBackDesc<L>>
	readonly bindings: ReadonlyArray<string>
	readonly boundRows: Readonly<Record<string, BoundRowsDesc<L>>>
}

/**
 * A program of a workload as its member serves it: a query or ordered query read live (`query`), its watch woken by
 * each change of what it reads; one answered at its call's instant alone and never live (`answered`, workload
 * answered), since no change wakes it; a ChangeSet; or one of an answered read and a ChangeSet with parameters bound
 * to the database's clock (`clocked`), so a clocked read is an answered one with its clock, time passing being no
 * change.
 */
export type ProgramDesc<L = Located> =
	| { readonly kind: "query"; readonly query: QueryDesc<L> }
	| { readonly kind: "answered"; readonly query: QueryDesc<L> }
	| { readonly kind: "changeSet"; readonly changeSet: ChangeSetDesc<L> }
	| {
			readonly kind: "clocked"
			readonly clock: ClockBinding
			readonly program: ClockedProgramDesc<L>
	  }

/**
 * A program a served member binds parameters of to the database's clock, by their declared names, each with its unit
 * (workload clocked): an answered query or ordered query, which no change wakes, or a ChangeSet. A live read binds
 * none, so none is clocked.
 */
export type ClockedProgramDesc<L = Located> = Extract<
	ProgramDesc<L>,
	{ readonly kind: "answered" | "changeSet" }
>

/**
 * The program a member runs, whatever parameters it binds to the clock: a live read, an answered one or a ChangeSet,
 * a clocked one's program.
 */
export const unclocked = <L>(
	program: ProgramDesc<L>
): Exclude<ProgramDesc<L>, { readonly kind: "clocked" }> =>
	program.kind === "clocked" ? program.program : program

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

/** The references a walk over parameters reads: spelled, its scalar parameters typed by `T`. */
type SpelledAs<T> = ParamsAs<Spelled["param"], T>

/** Whether two values of a part are one: the same value, or two lists or plain records holding the same values alike. */
const sameParts = (a: unknown, b: unknown): boolean => {
	if (a === b) {
		return true
	}
	if (isList(a) && isList(b)) {
		return a.length === b.length && a.every((x, i) => x === b[i])
	}
	if (isPlainRecord(a) && isPlainRecord(b)) {
		const keys = Object.keys(b)
		return (
			Object.keys(a).length === keys.length &&
			keys.every((k) => Object.hasOwn(a, k) && a[k] === b[k])
		)
	}
	return false
}

/**
 * Whether the part `old` holds what its rebuilt `fresh` holds: the same keys, each value the same, or a list or plain
 * record of the same values (`sameParts`, as a walk rebuilds one around parts it kept): then `old` is what `fresh` is.
 */
const holdsSame = <B extends object>(old: object, fresh: B): old is B => {
	if (!isPlainRecord(old) || !isPlainRecord(fresh)) {
		return false
	}
	const keys = Object.keys(fresh)
	return (
		Object.keys(old).length === keys.length &&
		keys.every((k) => Object.hasOwn(old, k) && sameParts(old[k], fresh[k]))
	)
}

class ParamWalk<P extends object, T> {
	readonly #spelling: ParamSpelling<P>
	/**
	 * Each imported query the walk has reached, walked: a Description shares an imported query by reference wherever it
	 * imports it (a bound query read at many places, a call's rows argument), and each is its own namespace, whose
	 * parameters only its bind map binds, so one walk of it serves every import of it, where a walk at every import
	 * expanded the Description's sharing into a tree.
	 */
	readonly #imported: ImportedWalks<P, T>

	constructor(spelling: ParamSpelling<P>, imported: ImportedWalks<P, T>) {
		this.#spelling = spelling
		this.#imported = imported
	}

	/**
	 * The part `old` rebuilt as `fresh`, as this walk keeps it: rebuilt, for a walk whose output is read apart from its
	 * input; RelationBinding keeps `old` itself where nothing in it changed (holdsSame).
	 */
	protected kept<B extends object>(_old: object, fresh: B): B {
		return fresh
	}

	query(q: QueryDesc<Located, SpelledAs<T>>): QueryDesc<Located, ParamsAs<P, T>> {
		return this.kept(q, { ...q, stage: this.stage(q.stage) })
	}

	stage(s: QueryStageDesc<Located, SpelledAs<T>>): QueryStageDesc<Located, ParamsAs<P, T>> {
		return this.kept(s, this.#rebuiltStage(s))
	}

	/** A stage with each of its parts walked, rebuilt (`stage` keeps it where nothing in it changed). */
	#rebuiltStage(s: QueryStageDesc<Located, SpelledAs<T>>): QueryStageDesc<Located, ParamsAs<P, T>> {
		switch (s.kind) {
			case "rules":
				return { ...s, arms: mapNonEmpty(s.arms, (r) => this.rule(r)) }
			case "recursive":
				return {
					...s,
					recursive: this.kept(s.recursive, {
						...s.recursive,
						base: mapNonEmpty(s.recursive.base, (r) => this.rule(r)),
						rec: mapNonEmpty(s.recursive.rec, (r) => this.rule(r))
					})
				}
			case "union":
				return { ...s, input: this.stage(s.input), arms: mapNonEmpty(s.arms, (r) => this.rule(r)) }
			case "attach":
				return {
					...s,
					input: this.stage(s.input),
					attach: this.kept(s.attach, { ...s.attach, child: this.query(s.attach.child) })
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
							? this.kept(s.take, { kind: "param" as const, ...this.#spelling.param(s.take.name) })
							: s.take
				}
		}
	}

	rule(r: RuleDesc<Located, SpelledAs<T>>): RuleDesc<Located, ParamsAs<P, T>> {
		return this.kept(r, {
			...r,
			matches: r.matches.map((m) =>
				this.kept(m, {
					...m,
					source: this.source(m.source),
					bindings: this.bindings(m.bindings)
				})
			),
			where: r.where.map((e) => this.expr(e)),
			head: Object.fromEntries(Object.entries(r.head).map(([k, h]) => [k, this.head(h)])),
			interiors: r.interiors.map((i) =>
				this.kept(i, { ...i, arms: mapNonEmpty(i.arms, (a) => this.rule(a)) })
			),
			attach: r.attach.map((a) => this.kept(a, { ...a, child: this.query(a.child) }))
		})
	}

	bindings(b: BindingsDesc<Located, SpelledAs<T>>): BindingsDesc<Located, ParamsAs<P, T>> {
		return this.kept(
			b,
			mapBindingTerms(b, (e) => this.expr(e))
		)
	}

	bound(b: BindTermDesc<Located, SpelledAs<T>>): BindTermDesc<Located, ParamsAs<P, T>> {
		return b.kind === "relationParam"
			? this.kept(b, { kind: "relationParam", ...this.#spelling.param(b.name) })
			: b.kind === "rows"
				? this.rows(b)
				: this.expr(b)
	}

	/** Rows of a query: the query its own namespace, its bind map read in this one, as an import's is. */
	rows(a: RowsDesc<Located, SpelledAs<T>>): RowsDesc<Located, ParamsAs<P, T>> {
		return this.kept(a, {
			kind: "rows",
			query: this.#importedQuery(a.query),
			bind: mapRecord(a.bind, (b) => this.bound(b))
		})
	}

	/** An imported query, walked once in a namespace of its own (`#imported`). */
	#importedQuery(q: QueryDesc<Located, SpelledAs<T>>): QueryDesc<Located, ParamsAs<P, T>> {
		const known = this.#imported.get(q)
		if (known !== undefined) {
			return known
		}
		const walked = new ParamWalk<P, T>(this.#spelling.imported(), this.#imported).query(q)
		this.#imported.set(q, walked)
		return walked
	}

	/** An imported query is its own namespace; only its bind map is read in this one. */
	source(s: SourceDesc<Located, SpelledAs<T>>): SourceDesc<Located, ParamsAs<P, T>> {
		switch (s.kind) {
			case "query":
			case "step":
				return this.kept(s, {
					...s,
					query: this.#importedQuery(s.query),
					bind: Object.fromEntries(Object.entries(s.bind).map(([k, b]) => [k, this.bound(b)]))
				})
			case "param":
				return this.kept(s, { kind: "param", heading: s.heading, ...this.#spelling.param(s.name) })
			case "paramOf":
				return this.kept(s, {
					kind: "paramOf",
					relation: s.relation,
					...this.#spelling.param(s.name)
				})
			case "call":
			case "callField":
				return this.kept(s, {
					...s,
					args: mapRecord(s.args, (a) => (a.kind === "rows" ? this.rows(a) : this.expr(a)))
				})
			case "split":
				return this.kept(s, {
					kind: "split",
					split: s.split,
					args: mapRecord(s.args, (a) => this.expr(a))
				})
			case "series":
				return this.kept(s, { kind: "series", low: this.expr(s.low), high: this.expr(s.high) })
			case "relation":
			case "interior":
			case "self":
			case "delta":
			case "context":
			case "row":
				return s
		}
	}

	head(h: HeadTermDesc<Located, SpelledAs<T>>): HeadTermDesc<Located, ParamsAs<P, T>> {
		return this.kept(
			h,
			mapHeadTerms(h, (e) => this.expr(e))
		)
	}

	expr(e: ExprDesc<Located, SpelledAs<T>>): ExprDesc<Located, ParamsAs<P, T>> {
		return this.kept(
			e,
			mapExpr(e, {
				leaf: (x) =>
					x.kind === "param"
						? this.kept(x, { kind: "param", type: x.type, ...this.#spelling.param(x.name) })
						: x,
				term: (x) => this.expr(x),
				source: (x) => this.source(x)
			})
		)
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
export const mapQueryParams = <P extends object, T = FieldDesc>(
	q: QueryDesc<Located, SpelledAs<T>>,
	spelling: ParamSpelling<P>,
	imported: ImportedWalks<P, T>
): QueryDesc<Located, ParamsAs<P, T>> => new ParamWalk<P, T>(spelling, imported).query(q)

/**
 * Each imported query a walk over parameters has walked, by the imported query (ParamWalk `#imported`): one walk's own,
 * or, where the walk's spelling of an imported query depends on that query alone, every walk's of that spelling
 * (check/params.ts resolveQuery).
 */
export interface ImportedWalks<P extends object, T> {
	get(q: QueryDesc<Located, SpelledAs<T>>): QueryDesc<Located, ParamsAs<P, T>> | undefined
	set(q: QueryDesc<Located, SpelledAs<T>>, walked: QueryDesc<Located, ParamsAs<P, T>>): unknown
}

/** A namespace spelled as it is: an imported query's, for a walk that reads only its importer's. */
const spelledAsIs: ParamSpelling<Spelled["param"]> = {
	param: (name) => ({ name }),
	imported: () => spelledAsIs
}

/**
 * Each parameter reference of a query description's own namespace, read in ParamWalk's order by `read`, the description
 * rebuilt nowhere: ParamWalk's reading, by the same cases in the same order. An imported query is its own namespace, so
 * the walk reads its bind map and never enters it, where ParamWalk spelled it as it is, rebuilt.
 */
class ParamReads<T> {
	readonly #read: (name: string) => void

	constructor(read: (name: string) => void) {
		this.#read = read
	}

	query(q: QueryDesc<Located, SpelledAs<T>>): void {
		this.stage(q.stage)
	}

	stage(s: QueryStageDesc<Located, SpelledAs<T>>): void {
		switch (s.kind) {
			case "rules":
				this.rules(s.arms)
				return
			case "recursive":
				this.rules(s.recursive.base)
				this.rules(s.recursive.rec)
				return
			case "union":
				this.stage(s.input)
				this.rules(s.arms)
				return
			case "attach":
				this.stage(s.input)
				this.query(s.attach.child)
				return
			case "named":
			case "order":
			case "approx":
				this.stage(s.input)
				return
			case "take":
				this.stage(s.input)
				if (s.take.kind === "param") {
					this.#read(s.take.name)
				}
				return
		}
	}

	rules(arms: ReadonlyArray<RuleDesc<Located, SpelledAs<T>>>): void {
		for (const r of arms) {
			this.rule(r)
		}
	}

	rule(r: RuleDesc<Located, SpelledAs<T>>): void {
		for (const m of r.matches) {
			this.source(m.source)
			this.terms(Object.values(m.bindings))
		}
		this.terms(r.where)
		for (const h of Object.values(r.head)) {
			this.terms(headTerms(h))
		}
		for (const i of r.interiors) {
			this.rules(i.arms)
		}
		for (const a of r.attach) {
			this.query(a.child)
		}
	}

	terms(terms: ReadonlyArray<ExprDesc<Located, SpelledAs<T>>>): void {
		for (const e of terms) {
			this.expr(e)
		}
	}

	/** A bind map, read in this namespace: a relation parameter by its name, rows by their own bind map. */
	bindMap(bind: BindMapDesc<Located, SpelledAs<T>>): void {
		for (const b of Object.values(bind)) {
			if (b.kind === "relationParam") {
				this.#read(b.name)
			} else if (b.kind === "rows") {
				this.bindMap(b.bind)
			} else {
				this.expr(b)
			}
		}
	}

	source(s: SourceDesc<Located, SpelledAs<T>>): void {
		switch (s.kind) {
			case "query":
			case "step":
				this.bindMap(s.bind)
				return
			case "param":
			case "paramOf":
				this.#read(s.name)
				return
			case "call":
			case "callField":
				for (const a of Object.values(s.args)) {
					if (a.kind === "rows") {
						this.bindMap(a.bind)
					} else {
						this.expr(a)
					}
				}
				return
			case "split":
				for (const a of Object.values(s.args)) {
					this.expr(a)
				}
				return
			case "series":
				this.expr(s.low)
				this.expr(s.high)
				return
			case "relation":
			case "interior":
			case "self":
			case "delta":
			case "context":
			case "row":
				return
		}
	}

	expr(e: ExprDesc<Located, SpelledAs<T>>): void {
		switch (e.kind) {
			case "param":
				this.#read(e.name)
				return
			case "absent":
			case "exists":
				this.source(e.source)
				this.terms(Object.values(e.bindings))
				return
			case "var":
			case "field":
			case "value":
			case "parent":
			case "literal":
			case "compute":
			case "and":
			case "or":
			case "closedAt":
			case "closedRow":
			case "closedHas":
			case "cast":
			case "base":
			case "retype":
			case "guarded":
			case "not":
			case "in":
			case "cond":
			case "when":
			case "compare":
			case "allen":
			case "between":
			case "pointIn":
			case "call":
				for (const child of exprChildren(e)) {
					this.expr(child.term)
				}
				return
		}
	}
}

/**
 * The parameters a query description needs, by name, in walk order (mapQueryParams, whose reading ParamReads is): a
 * checked query's parameters are exactly these, since the checker reads the cells the same walk mints
 * (check/params.ts); a ChangeSet's are one namespace, the union of its members' and read-backs', which ChangeSet.bind
 * closes and the ChangeSet decoder's binding check reads (changeSetDescShape).
 */
export const queryParamNames = <T = FieldDesc>(
	q: QueryDesc<Located, SpelledAs<T>>
): ReadonlySet<string> => {
	const names = new Set<string>()
	new ParamReads<T>((name) => names.add(name)).query(q)
	return names
}

/**
 * The query with each of its own parameter uses whose name `rename` maps spelled by its image (ParamRenaming), frozen
 * throughout as a decoded Description is: an imported query keeps its own parameters, and only the terms of its bind map
 * are renamed. ChangeSet.bind uses it to move a bound name out of the ChangeSet's namespace, and a ChangeSet's
 * combination to name its parts' private parameters (write/changeset/value.ts canonicalParts).
 */
export const renameQueryParams = (q: QueryDesc, rename: ReadonlyMap<string, string>): QueryDesc =>
	rename.size === 0 ? q : deepFreeze(new ParamRenaming(rename).query(q))

/**
 * The parameters the rows a relation parameter is bound to read in the namespace that binds them: its bind map's terms'
 * (ParamReads bindMap), the bound query's own being its own namespace's. A ChangeSet's bound rows (ChangeSetDesc
 * `boundRows`) read the ChangeSet's.
 */
export const rowsParamNames = (rows: RowsDesc): ReadonlySet<string> => {
	const names = new Set<string>()
	new ParamReads<FieldDesc>((name) => names.add(name)).bindMap(rows.bind)
	return names
}

/** The rows with each parameter of the binding namespace their bind map reads whose name `rename` maps spelled by its
 * image (renameQueryParams' reading of a bind map), frozen as a decoded Description is. */
export const renameRowsParams = (rows: RowsDesc, rename: ReadonlyMap<string, string>): RowsDesc =>
	rename.size === 0 ? rows : deepFreeze(new ParamRenaming(rename).rows(rows))

/** A relation parameter as a source a rule matches: over a declared heading, or over a relation's (Rule.relation). */
export type RelationParamSourceDesc<L = Located, R extends Refs = Spelled> = Extract<
	SourceDesc<L, R>,
	{ readonly kind: "param" | "paramOf" }
>

/** Where a ChangeSet's binding of relation parameter `name` to rows stands (ChangeSetDesc `boundRows`). */
export const boundRowsLoc = (name: string): SourceLoc => SourceLoc("ChangeSet", ["boundRows", name])

/**
 * The query that delivers the rows a relation parameter `name` is bound to as they are (ChangeSetDesc `boundRows`): one
 * rule matching an import of the rows' query under their bind map, each field it delivers (definitionFields) bound to a
 * variable of its own scope, the parameter's name, and delivered under its own name, its parameters the bind map's, read
 * in the namespace that binds them. A write evaluates it once, before the first stratum of the part it was bound on
 * (BoundRowsDesc `stratum`), where a reader runs in another state (write/frontend/compile.ts).
 */
export const boundRowsQuery = (name: string, rows: RowsDesc, loc: SourceLoc): QueryDesc => {
	const fields = definitionFields(rows.query)
	const vars = fields.map((field): VarDesc => ({ id: `${name}.${field}`, origin: undefined, loc }))
	const terms: Readonly<Record<string, ExprDesc>> = Object.fromEntries(
		fields.map((field): readonly [string, ExprDesc] => [
			field,
			{ kind: "var", var: `${name}.${field}` }
		])
	)
	const query: QueryDesc = {
		stage: {
			kind: "rules",
			loc,
			arms: [
				{
					loc,
					vars,
					matches: [
						{ loc, source: { kind: "query", query: rows.query, bind: rows.bind }, bindings: terms }
					],
					where: [],
					head: terms,
					interiors: [],
					attach: []
				}
			]
		}
	}
	return deepFreeze(query)
}

/**
 * The query that delivers a relation parameter's rows as they are: one rule matching `source`, each of the parameter's
 * fields, `fields`, bound to a variable of its own scope, the parameter's name, and delivered under its own name. A
 * match of the parameter is a match of an import of it (bindRelationParams), which the import's bind map binds.
 */
export const identityQuery = (
	source: RelationParamSourceDesc,
	fields: NonEmptyReadonlyArray<string>,
	loc: SourceLoc
): QueryDesc => {
	const vars = mapNonEmpty(fields, (field): VarDesc => ({
		id: `${source.name}.${field}`,
		origin: undefined,
		loc
	}))
	const terms: Readonly<Record<string, ExprDesc>> = Object.fromEntries(
		fields.map((field): readonly [string, ExprDesc] => [
			field,
			{ kind: "var", var: `${source.name}.${field}` }
		])
	)
	const query: QueryDesc = {
		stage: {
			kind: "rules",
			loc,
			arms: [
				{
					loc,
					vars,
					matches: [{ loc, source, bindings: terms }],
					where: [],
					head: terms,
					interiors: [],
					attach: []
				}
			]
		}
	}
	return deepFreeze(query)
}

/**
 * The imported queries of a walk that spells every name as it is (spelledAsIs): each the query itself, never walked, so
 * a query several imports share stays one value, by which a compile's checks key the imports (check/checker.ts
 * importedKey).
 */
const unwalkedImports: ImportedWalks<Spelled["param"], FieldDesc> = {
	get: (q) => q,
	set: () => undefined
}

/**
 * A walk over a query's own namespace that rewrites some of its parts and shares the rest: an imported query is its own
 * namespace, the query itself, never walked (unwalkedImports), and a part the walk leaves as it was is that part itself
 * (holdsSame), so the walked query shares every part but the containers on the way to what it rewrote, and only those
 * are digested again (core/fingerprint.ts IdentityDigests). Where every part was rebuilt and each import walked anew,
 * a walk copied the query's whole graph, its imports' included: a binding digested again every condition beside the
 * parameter it bound (write/changeset/value.ts bindRows), and the canonical naming of metis's composed programs copied
 * their members' graphs at every union and sequence, millions of frozen parts digested as its modules loaded.
 */
class SharingWalk extends ParamWalk<Spelled["param"], FieldDesc> {
	constructor(spelling: ParamSpelling<Spelled["param"]>) {
		super(spelling, unwalkedImports)
	}

	protected override kept<B extends object>(old: object, fresh: B): B {
		return holdsSame(old, fresh) ? old : inKeyOrderOf(old, fresh)
	}
}

/**
 * `fresh`, a part a walk rebuilt, in the key order of the part `old` it rebuilt where it holds exactly `old`'s keys, as
 * a decode of the Description holds it (ir/shape.ts, its key order included): a renamed parameter's use is written as
 * its use was, its name in its place.
 */
const inKeyOrderOf = <B extends object>(old: object, fresh: B): B => {
	if (!isPlainRecord(old) || !isPlainRecord(fresh)) {
		return fresh
	}
	const keys = Object.keys(fresh)
	return Object.keys(old).length === keys.length && keys.every((k) => Object.hasOwn(old, k))
		? { ...old, ...fresh }
		: fresh
}

/**
 * A walk over a query's own namespace that spells each parameter `rename` maps by its image (renameQueryParams,
 * renameRowsParams), sharing every part it leaves as it was (SharingWalk).
 */
class ParamRenaming extends SharingWalk {
	constructor(rename: ReadonlyMap<string, string>) {
		super({ param: (name) => ({ name: rename.get(name) ?? name }), imported: () => spelledAsIs })
	}
}

/**
 * A walk over a query's own namespace that binds the relation parameters `rows` names (bindRelationParams), sharing
 * every part it leaves as it was (SharingWalk): a bind term of one is its rows, and a match of one is a match of an
 * import of its identity query (`identity`), the parameter bound to its rows. The rows are written in the namespace
 * that binds them, so they are no use of the parameter and are never bound again.
 */
class RelationBinding extends SharingWalk {
	readonly #rows: ReadonlyMap<string, RowsDesc>
	readonly #identity: (source: RelationParamSourceDesc) => QueryDesc

	constructor(
		rows: ReadonlyMap<string, RowsDesc>,
		identity: (source: RelationParamSourceDesc) => QueryDesc
	) {
		super(spelledAsIs)
		this.#rows = rows
		this.#identity = identity
	}

	override source(s: SourceDesc): SourceDesc {
		if (s.kind !== "param" && s.kind !== "paramOf") {
			return super.source(s)
		}
		const rows = this.#rows.get(s.name)
		return rows === undefined
			? s
			: { kind: "query", query: this.#identity(s), bind: { [s.name]: rows } }
	}

	override bound(b: BindTermDesc): BindTermDesc {
		return b.kind === "relationParam" ? (this.#rows.get(b.name) ?? b) : super.bound(b)
	}
}

/**
 * The query with each of its own uses of the relation parameters `rows` names bound to their rows (a ChangeSet's bound
 * rows that only readers in the state they are evaluated in read, write/frontend/compile.ts `inlined`), in the one
 * binding form an import's bind map writes (RelationTermDesc): a bind term of one is its rows, and a match of
 * one a match of an import of its identity query (identityQuery, built by `identity`), the parameter bound to its
 * rows. An imported query keeps its own parameters, and only the terms of its bind map are bound. Frozen throughout, as
 * renameQueryParams' query is.
 */
export const bindRelationParams = (
	q: QueryDesc,
	rows: ReadonlyMap<string, RowsDesc>,
	identity: (source: RelationParamSourceDesc) => QueryDesc
): QueryDesc => deepFreeze(new RelationBinding(rows, identity).query(q))

/**
 * A walk that reads a query's own parameters with what each use states of it (passedThrough): a scalar parameter's
 * declared type, a relation parameter as one, and a take bound to a parameter, whose type no use declares.
 */
class ParamUses extends ParamWalk<Spelled["param"], FieldDesc> {
	/** Each parameter's first use, as the term that passes it through. */
	readonly terms = new Map<string, BindTermDesc>()
	/** The parameters a take is bound to. */
	readonly takes = new Set<string>()

	constructor() {
		super(spelledAsIs, unwalkedImports)
	}

	#use(name: string, term: BindTermDesc): void {
		this.terms.getOrInsert(name, term)
	}

	override stage(s: QueryStageDesc): QueryStageDesc {
		if (s.kind === "take" && s.take.kind === "param") {
			this.takes.add(s.take.name)
		}
		return super.stage(s)
	}

	override source(s: SourceDesc): SourceDesc {
		if (s.kind === "param" || s.kind === "paramOf") {
			this.#use(s.name, { kind: "relationParam", name: s.name })
		}
		return super.source(s)
	}

	override bound(b: BindTermDesc): BindTermDesc {
		if (b.kind === "relationParam") {
			this.#use(b.name, b)
		}
		return super.bound(b)
	}

	override expr(e: ExprDesc): ExprDesc {
		if (e.kind === "param") {
			this.#use(e.name, { kind: "param", name: e.name, type: e.type })
		}
		return super.expr(e)
	}
}

/**
 * A walk that reads the parameters a query's own namespace uses as scalars: a parameter term, and a take bound to a
 * parameter (scalarParamNames).
 */
class ScalarUses extends ParamWalk<Spelled["param"], FieldDesc> {
	readonly names = new Set<string>()

	constructor() {
		super(spelledAsIs, unwalkedImports)
	}

	override stage(s: QueryStageDesc): QueryStageDesc {
		if (s.kind === "take" && s.take.kind === "param") {
			this.names.add(s.take.name)
		}
		return super.stage(s)
	}

	override expr(e: ExprDesc): ExprDesc {
		if (e.kind === "param") {
			this.names.add(e.name)
		}
		return super.expr(e)
	}
}

/**
 * The parameters a query's own namespace uses as scalars, each taking one value, which no query's rows bind
 * (ChangeSet.bind refuses one): its parameter terms and a take bound to a parameter, never a relation parameter's use.
 */
export const scalarParamNames = (q: QueryDesc): ReadonlySet<string> => {
	const uses = new ScalarUses()
	uses.query(q)
	return uses.names
}

/**
 * The bind map that passes each of a query's own parameters through under its own name (ChangeSet.bind): a scalar
 * parameter to the parameter of its name at its declared type, a relation parameter to the relation parameter of its
 * name, so the query's rows, imported under it, read the parameters of the namespace that imports them, where one name
 * is one parameter and its uses agree. A take bound to a parameter is stated by no use's type, so a query with one passes
 * nothing through: `untyped` names it.
 */
export const passedThrough = (
	q: QueryDesc
):
	| { readonly kind: "bind"; readonly bind: BindMapDesc }
	| { readonly kind: "untyped"; readonly param: string } => {
	const uses = new ParamUses()
	uses.query(q)
	const [untyped] = [...uses.takes].filter((name) => !uses.terms.has(name))
	return untyped === undefined
		? { kind: "bind", bind: Object.fromEntries(uses.terms) }
		: { kind: "untyped", param: untyped }
}

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
	S.struct({ handles: S.uniqueStrings("a set's handles", S.nonEmptyString) }),
	S.struct({
		sha256: S.refine(S.string, isSha256Text, "a SHA-256 digest's one text, \\x and 64 hex digits")
	}),
	patternValueShape
)

/**
 * A field descriptor's Description as a caller's Description holds one. A descriptor's own is its builder's, frozen
 * (scalar/registry.ts defineField), and a Description its builder makes over descriptors holds theirs as they are.
 */
const fieldDescShape: S.Shape<FieldDesc> = S.ref("a field descriptor", () => fieldDescBody)

const bindingsDescShape: S.Shape<BindingsDesc> = S.ref("bindings", () => bindingsDescBody)

const bindMapDescShape: S.Shape<BindMapDesc> = S.ref("a bind map", () => bindMapDescBody)

/**
 * A compute decodes by the function it names, so a scale on a function other than round and trunc is refused at its
 * own path.
 */
const computeArgs = {
	args: S.nonEmptyArray(S.ref("an expression", (): S.Shape<ExprDesc> => exprDescShape))
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
	utf16Length: unscaledCompute,
	concat: unscaledCompute,
	startsWith: unscaledCompute,
	endsWith: unscaledCompute,
	contains: unscaledCompute,
	matches: unscaledCompute,
	translate: unscaledCompute,
	lowerAscii: unscaledCompute,
	collapse: unscaledCompute,
	resolveReference: unscaledCompute,
	cutBefore: unscaledCompute,
	cutFrom: unscaledCompute,
	replace: unscaledCompute,
	isXsdPattern: unscaledCompute,
	parseDouble: unscaledCompute,
	parseDecimal: unscaledCompute,
	sha256: unscaledCompute,
	floatBits: unscaledCompute,
	cosineDistance: unscaledCompute,
	textDocument: unscaledCompute,
	websearchMatches: unscaledCompute,
	plainMatches: unscaledCompute,
	websearchRank: unscaledCompute,
	plainRank: unscaledCompute,
	websearchRankCd: unscaledCompute,
	plainRankCd: unscaledCompute,
	union: unscaledCompute,
	intersection: unscaledCompute,
	difference: unscaledCompute,
	cardinality: unscaledCompute,
	subset: unscaledCompute,
	disjoint: unscaledCompute,
	singleton: unscaledCompute,
	netWithin: unscaledCompute,
	netStrictlyWithin: unscaledCompute,
	netOverlaps: unscaledCompute,
	wall: unscaledCompute,
	epochDay: unscaledCompute,
	dateOfEpochDay: unscaledCompute
}

const guardDescShape: S.Shape<GuardDesc> = S.tagged("kind", {
	nonzero: S.struct({}),
	nonnegative: S.struct({}),
	positive: S.struct({}),
	finite: S.struct({}),
	within: S.struct({ low: literalDescShape, high: literalDescShape }),
	matches: S.struct({ pattern: patternValueShape })
})

const exprCases = {
	var: S.struct({ var: name }),
	field: S.struct({ field: name }),
	value: S.struct({}),
	parent: S.struct({ column: name }),
	param: S.struct({ name, type: S.ref("a field descriptor", () => fieldDescShape) }),
	literal: S.structWith(
		{ value: literalDescShape },
		{ type: S.ref("a field descriptor", () => fieldDescShape) }
	),
	compute: S.tagged("fn", computeCases),
	cast: S.struct({
		to: S.ref("a field descriptor", () => fieldDescShape),
		arg: S.ref("an expression", () => exprDescShape)
	}),
	base: S.struct({ arg: S.ref("an expression", () => exprDescShape) }),
	cond: S.struct({
		pred: S.ref("an expression", () => exprDescShape),
		onTrue: S.ref("an expression", () => exprDescShape),
		onFalse: S.ref("an expression", () => exprDescShape)
	}),
	guarded: S.struct({ guard: guardDescShape, arg: S.ref("an expression", () => exprDescShape) }),
	when: S.struct({
		guard: guardDescShape,
		subject: S.ref("an expression", () => exprDescShape),
		proved: S.ref("an expression", () => exprDescShape),
		otherwise: S.ref("an expression", () => exprDescShape)
	}),
	compare: S.struct({
		op: S.literalsShape(compareOps),
		left: S.ref("an expression", () => exprDescShape),
		right: S.ref("an expression", () => exprDescShape)
	}),
	between: S.struct({
		arg: S.ref("an expression", () => exprDescShape),
		low: S.ref("an expression", () => exprDescShape),
		high: S.ref("an expression", () => exprDescShape)
	}),
	in: S.struct({
		arg: S.ref("an expression", () => exprDescShape),
		values: S.array(literalDescShape)
	}),
	and: S.struct({ args: S.array(S.ref("an expression", () => exprDescShape)) }),
	or: S.struct({ args: S.array(S.ref("an expression", () => exprDescShape)) }),
	not: S.struct({ arg: S.ref("an expression", () => exprDescShape) }),
	allen: S.struct({
		left: S.ref("an expression", () => exprDescShape),
		mask: S.refine(
			S.integer,
			(m) => m >= 1 && m <= allenMaskMax,
			`an Allen mask in 1..${allenMaskMax}`
		),
		right: S.ref("an expression", () => exprDescShape)
	}),
	pointIn: S.struct({
		point: S.ref("an expression", () => exprDescShape),
		span: S.ref("an expression", () => exprDescShape)
	}),
	absent: S.struct({
		source: S.ref("a source", () => sourceDescShape),
		bindings: bindingsDescShape
	}),
	closedAt: S.struct({
		relation: name,
		field: name,
		args: S.nonEmptyArray(S.ref("an expression", () => exprDescShape))
	}),
	closedRow: S.struct({
		relation: name,
		args: S.array(S.ref("an expression", () => exprDescShape))
	}),
	closedHas: S.struct({
		relation: name,
		args: S.nonEmptyArray(S.ref("an expression", () => exprDescShape))
	}),
	call: S.struct({
		function: name,
		args: S.recordShape(
			S.ref("an expression", () => exprDescShape),
			S.nonEmptyString
		)
	})
} as const

/**
 * An expression as the decoder reads it, before it parses a connective or a parameter: an and or or of any number of
 * operands, and a guarded node's guard and arg, which exprOfRead parses into the expression each is.
 */
type ReadExpr =
	| Exclude<ExprDesc, { readonly kind: "and" | "or" | "guarded" }>
	| { readonly kind: "and"; readonly args: ReadonlyArray<ExprDesc> }
	| { readonly kind: "or"; readonly args: ReadonlyArray<ExprDesc> }
	| { readonly kind: "guarded"; readonly guard: GuardDesc; readonly arg: ExprDesc }

/** A head term as the decoder reads it: a read expression, an aggregate or a producer. */
type ReadHead = ReadExpr | Exclude<HeadTermDesc, ExprDesc>

/**
 * A connective of operands as such, and an empty one as what its builder builds (connectiveExpr): its unit, the
 * constant true or false; a guarded node as the stand-in its constructor makes (guardedExpr).
 */
const exprOfRead = (e: ReadExpr): ExprDesc => {
	if (e.kind === "guarded") {
		return guardedExpr(e.guard, e.arg)
	}
	if (e.kind !== "and" && e.kind !== "or") {
		return e
	}
	const args = e.args
	return isNonEmpty(args) ? { kind: e.kind, args } : connectiveUnit(e.kind)
}

const exprDescShape: S.Shape<ExprDesc> = S.ref("an expression", () => exprDescBody)

/** The decoder exprDescShape refers to (S.ref). */
const exprDescBody: S.Shape<ExprDesc> = S.normalized<ReadExpr, ExprDesc>(
	S.tagged("kind", exprCases),
	exprOfRead
)

/**
 * A bind map's binding as the decoder reads it: a read expression, a relation parameter by name, or the rows of a query
 * under its own bind map (RelationTermDesc).
 */
type ReadBound = ReadExpr | RelationTermDesc

const bindTermDescShape: S.Shape<BindTermDesc> = S.normalized<ReadBound, BindTermDesc>(
	S.tagged("kind", {
		...exprCases,
		relationParam: S.struct({ name }),
		rows: S.ref("a query's rows", () => importDescShape)
	}),
	(b) => (b.kind === "relationParam" || b.kind === "rows" ? b : exprOfRead(b))
)

/** The decoder fieldDescShape refers to (S.ref). */
const fieldDescBody: S.Shape<FieldDesc> = S.tagged("kind", {
	pg: S.struct({ type: S.literalsShape(pgScalarNames) }),
	numeric: S.refine(
		S.struct({ precision: S.integer, scale: S.integer }),
		(f) =>
			f.precision >= 1 &&
			f.precision <= numericMaxPrecision &&
			f.scale >= numericMinScale &&
			f.scale <= numericMaxScale,
		`numeric(p, s), both declared, p in 1..${numericMaxPrecision} and s in ${numericMinScale}..${numericMaxScale}`
	),
	exact: S.struct({ carrier: S.literalsShape(exactValueCarriers) }),
	computedNumeric: S.refine(
		S.struct({ bound: S.struct({ digits: S.integer, scale: S.integer }) }),
		(f) => numericBoundRefusal(f.bound.digits, f.bound.scale) === undefined,
		`a computed numeric's bound narrower than numeric's own limits: digits -${numericMaxFractionDigits}..${numericMaxIntegerDigits} and a scale 0..${numericMaxFractionDigits}`
	),
	uuid: S.struct({}),
	bytes: S.struct({}),
	sha256: S.struct({}),
	text: S.refine(
		S.structStated(
			{ patterns: patternsShape, language: textLanguageShape },
			{ bytes: S.nonNegativeInteger },
			{}
		),
		(t) => t.bytes === languageOctets(t.language),
		"a text's byte bound, the one its language enforces"
	),
	pattern: S.struct({}),
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
	closedId: S.structStated({ roster: name }, { only: S.nonEmptyUniqueStrings("handles") }, {}),
	bits: S.struct({ roster: name }),
	vector: S.struct({
		dimensions: S.refine(
			S.positiveInteger,
			(n) => n <= vectorMaxDimensions,
			`1..${vectorMaxDimensions} dimensions`
		)
	}),
	search: S.struct({ configuration: S.literalsShape(textSearchConfigurations) })
})

/** The decoder bindingsDescShape refers to (S.ref). */
const bindingsDescBody: S.Shape<BindingsDesc> = S.recordShape(exprDescShape, S.nonEmptyString)

/** The decoder bindMapDescShape refers to (S.ref). */
const bindMapDescBody: S.Shape<BindMapDesc> = S.recordShape(bindTermDescShape, S.nonEmptyString)

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
				fn: S.literalsShape(["intersection", "difference", "span"]),
				args: S.pairShape(exprDescShape)
			})
		)
	}),
	(h) => (h.kind === "aggregate" || h.kind === "producer" ? h : exprOfRead(h))
)

const fieldMapShape = S.recordShape(fieldDescShape, name)

/** What a context's fields must be: at least one, each a type a context admits (contextFieldAdmits). */
const contextFieldsCapability =
	"a context of at least one field, each text, uuid, boolean, an integer type, inet, cidr, a contract over one, or a closed handle"

/**
 * A context's source (ContextFactSource): a token's, with the nested claim object its fields are read from, or
 * attested.
 */
const contextSourceShape: S.Shape<ContextFactSource> = S.tagged("kind", {
	token: S.structStated({}, { claim: name }, {}),
	attested: S.struct({})
})

const contextDescShape: S.Shape<ContextDesc> = S.struct({
	name,
	fields: S.refine(
		fieldMapShape,
		(f) => Object.keys(f).length > 0 && Object.values(f).every(contextFieldAdmits),
		contextFieldsCapability
	),
	source: contextSourceShape
})

/**
 * A query read under a bind map, an import's and a call's rows argument's alike: an import that binds nothing has the
 * empty binding, however it was spelled.
 */
const importDescShape: S.Shape<{ readonly query: QueryDesc; readonly bind: BindMapDesc }> =
	S.normalized(
		S.structWith(
			{ query: S.ref("a query description", () => unorderedQueryShape) },
			{ bind: bindMapDescShape }
		),
		(q) => ({ query: q.query, bind: q.bind ?? {} })
	)

const sourceDescShape: S.Shape<SourceDesc> = S.ref("a source", () => sourceDescBody)

/** The decoder sourceDescShape refers to (S.ref). */
const sourceDescBody: S.Shape<SourceDesc> = S.tagged("kind", {
	relation: S.struct({ name }),
	query: importDescShape,
	param: S.struct({
		name,
		heading: S.refine(
			fieldMapShape,
			(f) => Object.keys(f).length > 0,
			"a relation parameter of at least one field"
		)
	}),
	paramOf: S.struct({ name, relation: name }),
	call: S.struct({
		function: name,
		args: S.recordShape(
			S.ref("a call's argument", () => callArgDescShape),
			S.nonEmptyString
		)
	}),
	callField: S.struct({
		function: name,
		args: S.recordShape(
			S.ref("a call's argument", () => callArgDescShape),
			S.nonEmptyString
		),
		field: name
	}),
	split: S.struct({
		split: S.tagged("kind", {
			tokens: S.struct({}),
			pieces: S.struct({ separator: S.nonEmptyString }),
			rest: S.struct({}),
			decodedPath: S.struct({})
		}),
		args: S.recordShape(
			S.ref("an expression", () => exprDescShape),
			S.nonEmptyString
		)
	}),
	series: S.struct({
		low: S.ref("an expression", () => exprDescShape),
		high: S.ref("an expression", () => exprDescShape)
	}),
	interior: S.struct({ id: name }),
	self: S.struct({}),
	delta: S.struct({ side: S.literalsShape(["added", "removed", "met"]), relation: name }),
	context: S.struct({ context: S.ref("a context description", () => contextDescShape) }),
	row: S.struct({ heading: fieldMapShape })
})

/** A call's argument: rows of a query and the bind map of its parameters, or a value's term itself. */
const callArgDescShape: S.Shape<CallArgDesc> = S.unionShape(
	S.tagged("kind", { rows: importDescShape }),
	S.ref("an expression", () => exprDescShape)
)

const varDescShape: S.Shape<VarDesc> = S.located(
	S.structStated({ id: name }, { origin: S.struct({ relation: name, field: name }) }, loc)
)

const matchDescShape: S.Shape<MatchDesc> = S.located(
	S.structWith({ source: sourceDescShape, bindings: bindingsDescShape }, loc)
)

const attachDescShape: S.Shape<AttachDesc> = S.located(
	S.structWith({ name, child: S.ref("a query description", () => queryDescShape) }, loc)
)

const ruleDescShape: S.Shape<RuleDesc> = S.ref("a rule", () => ruleDescBody)

/** The decoder ruleDescShape refers to (S.ref). */
const ruleDescBody: S.Shape<RuleDesc> = S.located(
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

const stageInput = S.ref("a query stage", () => queryStageShape)
const arms = S.nonEmptyArray(ruleDescShape)

const queryStageShape: S.Shape<QueryStageDesc> = S.ref("a query stage", () => queryStageBody)

/** The decoder queryStageShape refers to (S.ref). */
const queryStageBody: S.Shape<QueryStageDesc> = S.tagged("kind", {
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

const queryDescShape: S.Shape<QueryDesc> = S.ref("a query description", () => queryDescBody)

/** The decoder queryDescShape refers to (S.ref). */
const queryDescBody: S.Shape<QueryDesc> = S.struct({ stage: queryStageShape })

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

/** A side's terms are distinct: a field and pred of it are two terms, each at most once. */
const sideDescShape: S.Shape<SideDesc> = S.struct({
	relation: name,
	terms: S.nonEmptyUniqueArray(termDescShape, termKey, "side terms"),
	selection: selectionDescShape
})

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
	race: S.located(S.structWith({ relation: name }, loc)),
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
	tree: S.located(
		S.structWith(
			{
				member: memberShape,
				slots: slotsDescShape,
				root: S.nonEmptyUniqueArray(name, (n) => n, "a tree's root fields")
			},
			loc
		)
	),
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
	),
	unit: S.located(
		S.structWith(
			{
				name,
				heading: S.nonEmptyUniqueArray(
					S.struct({ field: name, type: fieldDescShape }),
					(f) => f.field,
					"a unit's fields"
				)
			},
			loc
		)
	),
	series: S.located(S.structWith({ relation: name, field: name }, loc))
})

const writingShape: S.Shape<Writing> = S.tagged("kind", {
	caller: S.struct({}),
	instant: S.struct({}),
	generated: S.struct({ expr: exprDescShape }),
	drawn: S.struct({}),
	accumulated: S.struct({ start: literalDescShape }),
	place: S.struct({
		order: S.tagged("kind", { unordered: S.struct({}), by: S.struct({ by: S.string }) })
	})
})

const fieldDeclShape: S.Shape<FieldDecl> = S.struct({ type: fieldDescShape, writing: writingShape })

/**
 * Whether a field may be in a primary key: one whose value a fact holds when it is written, its caller's, its
 * family's, its insert's place or the database's clock's instant, or one generated from its caller's fields, a key
 * generation, which grizzle writes as its generation's value (law.ts FieldWriting keyGenerated; that it reads its
 * caller's fields alone is check/generated.ts keyGeneratedRule's, where the schema is checked). An accumulated field is
 * computed from the row it would identify.
 */
const keyWriting = (decl: FieldDecl | undefined): boolean => {
	switch (decl?.writing.kind) {
		case "caller":
		case "instant":
		case "drawn":
		case "place":
		case "generated":
			return true
		case "accumulated":
		case undefined:
			return false
	}
}

/**
 * The field types a closed relation's field may have: a closed id, which a key field always is, or an open type its
 * rows' values are coded by within the relation. A span and a vector have no finite code space a cell reads, a set
 * is no row's value, bytes have no literal, a search document is PostgreSQL's parse of a row's texts, never a literal,
 * an exact value of any size has no literal a constant spells (a closed row's integer is a bigint's or a
 * pg.numeric(p, 0)'s, its amount a money's), and an instant is the database's clock's, never a row's literal
 * (ir/instant.ts).
 */
const closedFieldAdmits = (desc: FieldDesc): boolean => {
	switch (desc.kind) {
		case "pg":
		case "numeric":
		case "computedNumeric":
		case "uuid":
		case "text":
		case "pattern":
		case "closedId":
			return true
		case "contract":
			return desc.name !== "instant" && closedFieldAdmits(desc.base)
		case "exact":
		case "bytes":
		case "sha256":
		case "span":
		case "bits":
		case "vector":
		case "search":
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

/** A closed relation's description as written, its rows a list. */
type WrittenClosedRelation = Extract<RelationDesc, { readonly kind: "closedRelation" }>

/**
 * A closed relation's description as its admission made it, the brand's doors being closed.relation()'s
 * (schema/relation.ts admitClosedRelation) and a decoded schema's (schema/admit.ts): its rows proved there, one per
 * key, each a value of exactly the relation's fields and of each field's base type, a closed id one of its roster's
 * handles, and the rest decoded. Its rows are a set told apart by their keys' handles (core/set.ts tupleKeyedSet), so
 * their order is never the order they were written in. A refinement a field's type carries (a contract's predicate, a
 * pattern) is judged where the schema is checked, which alone reads a contract's predicate.
 */
export type AdmittedClosedRelation = Omit<WrittenClosedRelation, "rows"> & {
	readonly rows: CanonicalSet<ClosedRow>
	readonly [admittedBrand]: true
}

const mintAdmitted = nominal<
	Omit<WrittenClosedRelation, "rows"> & { readonly rows: CanonicalSet<ClosedRow> },
	AdmittedClosedRelation
>()

/**
 * A closed row's key: its key fields' handles, in key order, its identity among its relation's rows. Each admission
 * door proves every key cell a handle before it reads a row's key, so a cell that is none is a defect.
 */
export const closedRowKey = (
	key: NonEmptyReadonlyArray<string>,
	row: ClosedRow
): ReadonlyArray<string> =>
	defined(rowKeyValues(key, row), "an admitted closed relation's key cells are handles")

/**
 * The brand's one mint: a closed relation's description its caller admitted (closed.relation()'s admission, or its
 * schema's), frozen, its rows the set of the rows written, one per key, in the order of their keys' canonical texts.
 * The brand is the type alone: a description that crosses a decode is a caller's, and its decode admits it again.
 */
export const recordAdmitted = (desc: WrittenClosedRelation): AdmittedClosedRelation => {
	for (const row of desc.rows) {
		Object.freeze(row)
	}
	return mintAdmitted(
		Object.freeze({ ...desc, rows: tupleKeyedSet(desc.rows, (row) => closedRowKey(desc.key, row)) })
	)
}

/** What a closed relation's fields must be: at least one, each one a closed relation admits (closedFieldAdmits). */
const closedFieldsCapability =
	"a closed relation of at least one field, each a closed id or an open type that is no span, set, vector, bytes or exact value, and no field grizzle or PostgreSQL writes"

/** What a closed relation must be beside its fields' own rules: its key, its slots and its rows as one. */
const closedRelationCapability =
	"a key of the relation's own closed-id fields, its slots key fields in key order, each row a value of exactly its fields, its key values handles, and no two rows of one key"

const closedKeyShape = S.nonEmptyUniqueStrings("key fields")

const keySlotsShape = S.uniqueArray(
	S.struct({ field: name, fin: slotsDescShape }),
	(slot) => slot.field,
	"slot fields"
)

/** Whether a closed relation's key is of its own closed-id fields, and its slots key fields in key order. */
const closedKeyHolds = (
	key: ReadonlyArray<string>,
	slots: ReadonlyArray<KeySlotDesc>,
	closedId: (field: string) => boolean
): boolean => {
	if (!key.every(closedId)) {
		return false
	}
	const slotted = slots.map((slot) => key.indexOf(slot.field))
	return slotted.every((at, i) => at >= 0 && at > (slotted[i - 1] ?? -1))
}

/** A relation description's shape, a closed relation's decoded as written, its rows not admitted. */
const atLeastOneField = "a relation with at least one field"

const primaryKeyShape = S.nonEmptyUniqueStrings("primary key fields")

const keyOverOwnFields =
	"a primary key over the relation's own fields, each one its caller writes, its family draws or its row generates"

const relationDescShape: S.Shape<RelationDesc> = S.tagged("kind", {
	relation: S.located(
		S.refine(
			S.structWith(
				{
					name,
					fields: S.refine(
						S.recordShape(fieldDeclShape, name),
						(f) => Object.keys(f).length > 0,
						atLeastOneField
					),
					primaryKey: primaryKeyShape
				},
				loc
			),
			(r) => r.primaryKey.every((f) => keyWriting(r.fields[f])),
			keyOverOwnFields
		)
	),
	closed: S.located(
		S.structWith(
			{ name, handles: S.nonEmptyUniqueStrings("handles") },
			{ ...loc, order: S.literalsShape(statedRosterOrders) }
		)
	),
	closedRelation: S.located(
		S.refine(
			S.structWith(
				{
					name,
					fields: S.refine(
						fieldMapShape,
						(f) => Object.keys(f).length > 0 && Object.values(f).every(closedFieldAdmits),
						closedFieldsCapability
					),
					key: closedKeyShape,
					slots: keySlotsShape,
					rows: S.array(S.recordShape(literalDescShape, name))
				},
				loc
			),
			(c) => {
				if (!closedKeyHolds(c.key, c.slots, (f) => c.fields[f]?.kind === "closedId")) {
					return false
				}
				const fields = Object.keys(c.fields).toSorted(compareStrings)
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
			closedRelationCapability
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

/**
 * A decoded schema's relation: any relation but a closed one decoded, and a closed relation refused, since a schema holds
 * only admitted ones (SchemaRelationDesc), which a raw schema's admission makes (schema/admit.ts admitSchemaDesc).
 */
const schemaRelationShape: S.Shape<SchemaRelationDesc> = S.plain({
	expected: relationDescShape.expected,
	parse: function* (value, path) {
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

const functionTypeShape: S.Shape<FunctionTypeDesc> = S.ref("a function's type", () =>
	S.tagged("kind", {
		value: S.struct({ type: fieldDescShape }),
		rows: S.struct({ heading: headingShape }),
		row: S.struct({ heading: headingShape })
	})
)

const headingShape: S.Shape<HeadingDesc> = S.ref("a heading", () =>
	S.nonEmptyUniqueArray(
		S.struct({ name, type: functionTypeShape }),
		(f) => f.name,
		"heading field names"
	)
)

/** A run of a declared function's body: storable text. */
const bodyTextShape = S.refine(S.string, isValidText, "a body of storable text")

/** A declared function's body: its text, and each row type it names with the text after it. */
const functionBodyShape: S.Shape<FunctionBodyDesc> = S.struct({
	text: bodyTextShape,
	named: S.array(S.struct({ rowType: headingShape, text: bodyTextShape }))
})

/** A declared function's Description: its arguments named apart, and a body of storable text. */
const functionDescShape: S.Shape<FunctionDesc> = S.located(
	S.structWith(
		{
			name,
			calls: S.refine(
				S.uniqueStrings("called functions", name),
				(calls) => calls.every((c, i) => i === 0 || (calls[i - 1] ?? "") < c),
				"called functions in code point order"
			),
			args: S.uniqueArray(
				S.struct({ name, type: functionTypeShape }),
				(a) => a.name,
				"argument names"
			),
			returns: functionTypeShape,
			volatility: S.literalsShape(functionVolatilities),
			language: S.literalsShape(declaredLanguages),
			body: functionBodyShape
		},
		{ ...loc, nullInput: S.literalsShape(statedNullInputs) }
	)
)

const functionsShape = S.nonEmptyUniqueArray(functionDescShape, (f) => f.name, "function names")

const schemaDescShape: S.Shape<SchemaDesc> = S.ref("a schema description", () => schemaDescBody)

/** The decoder schemaDescShape refers to (S.ref). */
const schemaDescBody: S.Shape<SchemaDesc> = S.located(
	S.structWith(
		{
			name,
			relations: S.uniqueArray(schemaRelationShape, (r) => r.name, "relation names"),
			statements: S.array(statementDescShape),
			bases: S.atMostOne(schemaDescShape)
		},
		{ ...loc, functions: functionsShape }
	)
)

const unadmittedSchemaShape: S.Shape<UnadmittedSchemaDesc> = S.ref(
	"a schema description",
	() => unadmittedSchemaBody
)

/** The decoder unadmittedSchemaShape refers to (S.ref). */
const unadmittedSchemaBody: S.Shape<UnadmittedSchemaDesc> = S.located(
	S.structWith(
		{
			name,
			relations: S.uniqueArray(relationDescShape, (r) => r.name, "relation names"),
			statements: S.array(statementDescShape),
			bases: S.atMostOne(unadmittedSchemaShape)
		},
		{ ...loc, functions: functionsShape }
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
	world: S.located(S.structWith({ name, query: unorderedQueryShape }, loc)),
	scoped: S.located(S.structWith({ name, query: unorderedQueryShape }, loc))
})

const roleRelations = S.nonEmptyUniqueArray(
	roleEntryDescShape,
	(e) => e.name,
	"role relation names"
)
const roleWrite = S.uniqueStrings("written relations", name)
const roleInsert = S.nonEmptyUniqueStrings("inserted relations")
const roleContexts = S.uniqueArray(contextDescShape, (c) => c.name, "declared contexts")

const roleDescShape: S.Shape<RoleDesc> = S.located(
	S.unionShape(
		S.structWith(
			{
				name,
				base: schemaDescShape,
				relations: roleRelations,
				write: roleWrite,
				contexts: roleContexts
			},
			loc
		),
		S.structWith(
			{
				name,
				base: schemaDescShape,
				relations: roleRelations,
				insert: roleInsert,
				contexts: roleContexts
			},
			loc
		)
	)
)

/** What a role states over its base: the role's own parts, which a role's Description holds beside the base. */
type RoleParts = Located & {
	readonly name: string
	readonly relations: NonEmptyReadonlyArray<RoleEntryDesc>
	readonly contexts: ReadonlyArray<ContextDesc>
} & RoleWriting

/**
 * and location, each query entry's query the Description the builder decoded where it took it (schema/protocol.ts
 * queryDescOf).
 */
export type RoleInput = {
	readonly name: string
	readonly relations: ReadonlyArray<RoleEntryDesc>
	readonly contexts: ReadonlyArray<ContextDesc>
	readonly loc: SourceLoc
} & RoleWriting

/** A role entry as a decode of its role reads what its caller wrote of it: its kind, its name and its location. */
type RoleEntryPart = Located & { readonly kind: RoleEntryDesc["kind"]; readonly name: string }

const roleEntryPartShape: S.Shape<RoleEntryPart> = S.tagged("kind", {
	whole: S.located(S.structWith({ name }, loc)),
	world: S.located(S.structWith({ name }, loc)),
	scoped: S.located(S.structWith({ name }, loc))
})

/** A declared context as a decode of its role reads what its caller wrote of it: its name, each name once. */
const roleContextNames = S.uniqueArray(S.struct({ name }), (c) => c.name, "declared contexts")

/**
 * What a decode of a whole role reads of the parts its caller wrote, each at its place in the role: its name, its
 * entries' kinds, names and locations, its written relations, its declared contexts' names and its
 * location; a query entry's query and a context's Description are no part of it, each decoded where it was taken.
 */
const roleWrittenShape = S.located(
	S.unionShape(
		S.structWith(
			{
				name,
				relations: S.nonEmptyUniqueArray(roleEntryPartShape, (e) => e.name, "role relation names"),
				write: roleWrite,
				contexts: roleContextNames
			},
			loc
		),
		S.structWith(
			{
				name,
				relations: S.nonEmptyUniqueArray(roleEntryPartShape, (e) => e.name, "role relation names"),
				insert: roleInsert,
				contexts: roleContextNames
			},
			loc
		)
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

/** What a field-equality member equates a field to: a parameter by name and declared type, or a literal. */
const equaledDescShape: S.Shape<EqualedDesc> = S.tagged("kind", {
	param: S.struct({ name, type: fieldDescShape }),
	literal: S.struct({ value: literalDescShape })
})

/** A write member's source: an array, a Stream, a query or a field-equality member. */
const writeSourceShape = S.tagged("kind", {
	array: S.struct({ slot: name }),
	stream: S.struct({ slot: name }),
	query: S.struct({ query: unorderedQueryShape }),
	equal: S.struct({ fields: S.recordShape(equaledDescShape, name) })
})

/** A write member of `op`: its relation and its source. */
const writeMemberShape = S.structWith({ relation: name, member: writeSourceShape }, loc)

/** An insert member's source: a write member's, or the computed fields of its stratum's host rows. */
const insertSourceShape = S.tagged("kind", {
	array: S.struct({ slot: name }),
	stream: S.struct({ slot: name }),
	query: S.struct({ query: unorderedQueryShape }),
	equal: S.struct({ fields: S.recordShape(equaledDescShape, name) }),
	computed: S.struct({ query: unorderedQueryShape })
})

const memberDescShape: S.Shape<MemberDesc> = S.located(
	S.tagged("op", {
		insert: S.structWith({ relation: name, member: insertSourceShape }, loc),
		delete: writeMemberShape,
		put: writeMemberShape
	})
)

/** Whether a member's facts travel in a slot of their own: an array's or a Stream's, never a query's or a field-equality
 * member's, whose facts its statement reads. */
export const enumeratedMember = (member: MemberDesc["member"]): boolean => {
	switch (member.kind) {
		case "array":
		case "stream":
			return true
		case "query":
		case "equal":
		case "computed":
			return false
	}
}

/**
 * A ChangeSet's parameters are one namespace, the parameters its members and read-backs use
 * (memberParamNames): every name ChangeSet.bind closed is one of them, and none is named like a member slot its
 * enumerated members' facts are bound through (slots.ts reservedSlot).
 */
const changeSetDescShape: S.Shape<ChangeSetDesc> = S.audited(
	S.struct({
		strata: S.nonEmptyArray(S.struct({ members: S.array(memberDescShape) })),
		reads: S.uniqueArray(
			S.struct({ name, query: queryDescShape }),
			(r) => r.name,
			"read-back names"
		),
		bindings: S.uniqueStrings("bound parameters", S.nonEmptyString),
		boundRows: S.recordShape(
			S.struct({
				stratum: S.nonNegativeInteger,
				rows: S.tagged("kind", { rows: importDescShape })
			}),
			name
		)
	}),
	(changeSet, refuseAt) => {
		const read = new Set([
			...changeSet.strata.flatMap((s) => s.members.flatMap((m) => [...memberParamNames(m.member)])),
			...changeSet.reads.flatMap((r) => [...queryParamNames(r.query)])
		])
		const used = new Set([
			...read,
			...Object.values(changeSet.boundRows).flatMap((bound) => [...rowsParamNames(bound.rows)])
		])
		for (const [at, bound] of changeSet.bindings.entries()) {
			if (!used.has(bound)) {
				refuseAt(
					["bindings", at],
					`a binding of a parameter the ChangeSet declares; ${bound} is none of its members' or read-backs' parameters`
				)
			}
		}
		for (const [bound, { stratum }] of Object.entries(changeSet.boundRows)) {
			if (!read.has(bound) || changeSet.bindings.includes(bound)) {
				refuseAt(
					["boundRows", bound],
					`a binding of a relation parameter its members or read-backs read, bound once; ${bound} is none, or is bound to a value too`
				)
			}
			/** Each reader of a binding runs at or after the stratum it is evaluated before: a member of that stratum or a
			 * later one, a binding evaluated there or later, or a read-back, read after the last stratum. */
			const early = [
				...changeSet.strata.flatMap((s, at) =>
					s.members.some((m) => memberParamNames(m.member).has(bound)) ? [at] : []
				),
				...Object.values(changeSet.boundRows).flatMap((other) =>
					rowsParamNames(other.rows).has(bound) ? [other.stratum] : []
				)
			].some((at) => at < stratum)
			if (stratum >= changeSet.strata.length || early) {
				refuseAt(
					["boundRows", bound, "stratum"],
					`a stratum of the ChangeSet at or before every stratum whose members or bindings read ${bound}`
				)
			}
		}
		const reserved = changeSet.strata.flatMap((stratum, s) =>
			stratum.members.flatMap((m, i) =>
				enumeratedMember(m.member) ? [{ s, i, slot: reservedSlot(s, m.op, m.relation) }] : []
			)
		)
		const taken = reserved.find(({ slot }) => used.has(slot))
		if (taken !== undefined) {
			refuseAt(
				["strata", taken.s, "members", taken.i],
				`a parameter name other than the member slot ${taken.slot} the ChangeSet reserves`
			)
		}
	}
)

const clockedProgramShape: S.Shape<ClockedProgramDesc> = S.tagged("kind", {
	answered: S.struct({ query: queryDescShape }),
	changeSet: S.struct({ changeSet: changeSetDescShape })
})

/** A clock binding: at least one declared parameter's name, each with the unit it reads the clock in. */
const clockBindingShape: S.Shape<ClockBinding> = S.refine(
	S.recordShape(S.literalsShape(clockUnits), name),
	(binding) => Object.keys(binding).length > 0,
	"a binding of at least one parameter to the database's clock"
)

const workloadDescShape: S.Shape<WorkloadDesc> = S.struct({
	schema: name,
	programs: S.recordShape(
		S.tagged("kind", {
			query: S.struct({ query: queryDescShape }),
			answered: S.struct({ query: queryDescShape }),
			changeSet: S.struct({ changeSet: changeSetDescShape }),
			clocked: S.struct({ clock: clockBindingShape, program: clockedProgramShape })
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
 * An ordinary relation's Description over its declared name and its fields' declarations, each a registered
 * descriptor's decoded type and its writing: the relation's own parts, its fields' names and its caller's primary key,
 * held as a decode of the whole relation holds them, with its refusals at its paths (each field name a declared name, a
 * field at least, a primary key of distinct names of its own key-writing fields), and the declarations as they are.
 */
export const relationOver = (
	relationName: string,
	fields: Readonly<Record<string, FieldDecl>>,
	primaryKey: unknown,
	at: SourceLoc
): Result.Result<Extract<RelationDesc, { readonly kind: "relation" }>, CompileError> =>
	Result.map(
		S.decodeWith(
			S.refine(
				S.struct({
					fields: S.refine(
						S.recordShape(S.boolean, name),
						(f) => Object.keys(f).length > 0,
						atLeastOneField
					),
					primaryKey: primaryKeyShape
				}),
				(r) => r.primaryKey.every((f) => keyWriting(fields[f])),
				keyOverOwnFields
			),
			{
				fields: Object.fromEntries(Object.keys(fields).map((field) => [field, true] as const)),
				primaryKey
			},
			subjects.relation
		),
		(parts) =>
			builtNode({
				kind: "relation",
				name: relationName,
				fields: Object.freeze(
					Object.fromEntries(
						Object.entries(fields).map(([field, decl]) => [field, Object.freeze(decl)] as const)
					)
				),
				primaryKey: parts.primaryKey,
				loc: at
			})
	)

/**
 * A schema level's Description over parts already decoded: its relations, each closed relation admitted, and its
 * statements, as their builders or ownership hold them, the level below it, a declared name and its location. No
 * relation name repeats, which a level's record of relations, keyed by name, holds.
 */
export const schemaLevelDesc = (level: {
	readonly name: string
	readonly relations: ReadonlyArray<SchemaRelationDesc>
	readonly statements: ReadonlyArray<StatementDesc>
	readonly functions: ReadonlyArray<FunctionDesc>
	readonly bases: SchemaBases<SchemaDesc>
	readonly loc: SourceLoc
}): SchemaDesc =>
	builtNode({
		name: level.name,
		relations: Object.freeze(level.relations),
		statements: Object.freeze(level.statements),
		...(isNonEmpty(level.functions) ? { functions: Object.freeze(level.functions) } : {}),
		bases: Object.freeze(level.bases),
		loc: level.loc
	})

/** A role's Description over its base from its own parts, each already decoded. */
const roleDescOver = (base: SchemaDesc, role: RoleParts): RoleDesc =>
	builtNode({
		name: role.name,
		base,
		relations: Object.freeze(role.relations),
		...("insert" in role
			? { insert: Object.freeze(role.insert) }
			: { write: Object.freeze(role.write) }),
		contexts: Object.freeze(role.contexts),
		loc: role.loc
	})

/**
 * A role's Description over its base, decoded already, from its own parts: what its caller wrote of them decoded as a
 * decode of the whole role decodes it there (roleWrittenShape), each query entry's query as its builder decoded it,
 * frozen with the rest.
 */
export const decodeRoleOver = (
	base: SchemaDesc,
	role: RoleInput
): Result.Result<RoleDesc, CompileError> =>
	Result.map(
		S.decodeWith(
			roleWrittenShape,
			{
				...role,
				relations: role.relations.map((e) => ({ kind: e.kind, name: e.name, loc: e.loc })),
				contexts: role.contexts.map((c) => ({ name: c.name }))
			},
			subjects.role
		),
		(written) => {
			const [first, ...rest] = role.relations
			return roleDescOver(base, {
				name: written.name,
				relations: deepFreeze([defined(first, "an entry of a role its decode admitted"), ...rest]),
				...("insert" in written ? { insert: written.insert } : { write: written.write }),
				contexts: deepFreeze([...role.contexts]),
				loc: written.loc
			})
		}
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
 * A side's Description over its relation, its terms and its selection, each read where it entered: a declared
 * relation's name, terms each a field or pred of a declared name, and a selection whose conjuncts the selection's
 * predicate decoded. Refused at the first term that repeats an earlier one, a rule the types name too.
 */
export const sideOver = (
	relation: string,
	terms: NonEmptyReadonlyArray<TermDesc>,
	selection: SelectionDesc
): Result.Result<SideDesc, CompileError> => {
	const repeated = S.firstRepeatAt(terms, termKey)
	return repeated === undefined
		? Result.ok(Object.freeze({ relation, terms: Object.freeze(terms), selection }))
		: Result.err(
				ruleRefused(
					SourceLoc("side description", ["terms", repeated]),
					"a side lists each term once"
				)
			)
}

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

/**
 * A closed relation's Description over its declared name, its fields' decoded types, its caller's key and the slots its
 * key's fields hold, its rows not yet admitted (schema/relation.ts admitClosedRelation): what its caller wrote held as
 * a decode of the whole relation holds it, with its refusals at its paths (each field name a declared name, at least
 * one field and each one a closed relation admits, a key of distinct names, distinct slot fields, a key of the
 * relation's own closed-id fields whose slots are key fields in key order), and the fields' types as they are.
 */
export const closedRelationOver = (
	relationName: string,
	fields: Readonly<Record<string, FieldDesc>>,
	key: unknown,
	slots: ReadonlyArray<KeySlotDesc>,
	at: SourceLoc
): Result.Result<Extract<RelationDesc, { readonly kind: "closedRelation" }>, CompileError> =>
	Result.map(
		S.decodeWith(
			S.refine(
				S.struct({
					fields: S.refine(
						S.recordShape(S.boolean, name),
						(f) => Object.keys(f).length > 0 && Object.values(f).every((admits) => admits),
						closedFieldsCapability
					),
					key: closedKeyShape,
					slots: keySlotsShape
				}),
				(c) => closedKeyHolds(c.key, c.slots, (f) => fields[f]?.kind === "closedId"),
				closedRelationCapability
			),
			{
				fields: Object.fromEntries(
					Object.entries(fields).map(([field, desc]) => [field, closedFieldAdmits(desc)] as const)
				),
				key,
				slots
			},
			subjects.relation
		),
		(parts) =>
			builtNode({
				kind: "closedRelation",
				name: relationName,
				fields: Object.freeze({ ...fields }),
				key: parts.key,
				slots: parts.slots,
				rows: Object.freeze([]),
				loc: at
			})
	)

/**
 * A context's Description over its declared name, its fields' decoded types and its source (schema/world.ts
 * admitContext, admitAttested): what its caller wrote held as a decode of the whole context holds it, with its refusals
 * at its paths (each field name a declared name, at least one field and each one a context admits, a claim object's
 * declared name), and the fields' types as they are.
 */
export const contextOver = <Source extends ContextFactSource>(
	contextName: string,
	fields: Readonly<Record<string, FieldDesc>>,
	source: Source
): Result.Result<ContextDesc & { readonly source: Source }, CompileError> =>
	Result.map(
		S.decodeWith(
			S.struct({
				name,
				fields: S.refine(
					S.recordShape(S.boolean, name),
					(f) => Object.keys(f).length > 0 && Object.values(f).every((admits) => admits),
					contextFieldsCapability
				),
				source: contextSourceShape
			}),
			{
				name: contextName,
				fields: Object.fromEntries(
					Object.entries(fields).map(([field, desc]) => [field, contextFieldAdmits(desc)] as const)
				),
				source
			},
			subjects.context
		),
		(parts): ContextDesc & { readonly source: Source } =>
			Object.freeze({ name: parts.name, fields: Object.freeze({ ...fields }), source })
	)

/**
 * A caller's declared name decoded as the part at `keys` of a Description of kind `kind` (S.decodeAt): the refusal a
 * decode of the whole Description gives it there, for a builder that places the name in a Description it builds from
 * parts already decoded.
 */
export const declaredNameAt = (
	kind: DescKind,
	keys: S.Path,
	value: unknown
): Result.Result<string, CompileError> => S.decodeAt(name, value, subjects[kind], keys)

/**
 * The JSON form, source locations included: what crosses a process boundary, and decodes as the Description it was, a
 * guarded node as itself (core/canonical.ts transportJson). Its identity text is descText's, which reads the node as its
 * subject.
 */
export const descToJson = (desc: unknown): Result.Result<Json, CompileError> =>
	transportJson(desc, everyProperty)

/** The canonical identity text: the canonical serialization without source locations. */
export const descText = (desc: unknown): Result.Result<WellFormedText, CompileError> =>
	encode(desc, withoutSourceLocs)

/**
 * The identity digests of Descriptions (core/fingerprint.ts IdentityDigests), one for the process: a frozen part's
 * identity is its content's, without source locations, for as long as it lives, so each is digested once however many
 * levels, ChangeSets, owned schemas and navigations read it. Each schema, fragment, role and owned schema made digests of
 * its own, so a part a ChangeSet over a role bound in from its base, or a navigation read beside the ChangeSets of its
 * level, was digested again in each: edullm's qti-database configuration, imported, digested 351,000 of its 1,312,678
 * containers a second time in another level's digests, for 27,016 distinct identities.
 */
export const descIdentities: IdentityDigests = new IdentityDigests(withoutSourceLocs, [])

/**
 * The identity digest of `desc` (core/fingerprint.ts identityDigest): one exactly when descText is one, each frozen
 * part it holds digested once for the process (descIdentities), where descText is the size of the tree its sharing
 * expands into.
 */
export const descIdentity = (desc: unknown): Result.Result<IdentityDigest, CompileError> =>
	descIdentities.of(desc)

/**
 * The canonical identity text of `desc`, a plain record each of whose members `written` holds has the identity text it
 * maps the member to: descText's, those members written from their texts rather than encoded again (core/canonical.ts
 * encodeOver).
 */
export const descTextOver = (
	desc: unknown,
	written: ReadonlyMap<string, WellFormedText>
): Result.Result<WellFormedText, CompileError> => encodeOver(desc, withoutSourceLocs, written)
