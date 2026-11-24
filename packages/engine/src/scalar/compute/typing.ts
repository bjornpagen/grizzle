import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	concatNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Patterns, PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import { regexMaxRepeat } from "@bjornpagen/grizzle-text/regex/parse"
import { asciiFold } from "@bjornpagen/grizzle-text/text"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { int4Max, unwrap } from "#compiler/core/canonical.ts"
import { canonicalTextOf, catchRefusal, Refusal, sameContent } from "#compiler/core/canonical.ts"
import { clockReadingRange, wallRange } from "#compiler/core/clock.ts"
import { maxAllocSize } from "#compiler/core/errors.ts"
import { CompileError, prose, type ProseTag, ruleRefused } from "#compiler/core/errors.ts"
import type { FunctionDigest } from "#compiler/core/fingerprint.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { int4Digits, int8Max, int8Min, isIntegerTypmod } from "#compiler/ir/carriers.ts"
import { integerDigits, integerRanges } from "#compiler/ir/carriers.ts"
import type { ParamReading } from "#compiler/ir/clock.ts"
import { dayNumber, epochDayRange, firstCalendarDate, lastCalendarDate } from "#compiler/ir/date.ts"
import {
	type CompareOp,
	type ExprDesc,
	type FieldDesc,
	type FunctionDesc,
	functionTypeLabel,
	nullInputOf,
	type GuardDesc,
	type LiteralDesc,
	type Located,
	literalPattern,
	type Refs,
	type Spelled
} from "#compiler/ir/desc.ts"
import {
	callNonNull,
	type ExprSpec,
	type ExprSpecOver,
	type ExprTable,
	type LiveArgs,
	type PartialOp,
	type PatternTable,
	type ScalarExpr,
	type TableExpr,
	type TypedLiteral,
	type Volatility,
	withArgs
} from "#compiler/ir/expr.ts"
import { instantInputText, isInstantType } from "#compiler/ir/instant.ts"
import { matchFlags, type PatternValue } from "#compiler/ir/pattern.ts"
import type { Exact, Fact, NativeProof, OperationProof, Precondition } from "#compiler/ir/proof.ts"
import {
	baseOf,
	capsOf,
	type Carrier,
	type ContractInfo,
	enteredType,
	exactDigitsOf,
	integerTypmodOf,
	isExactValue,
	isRefined,
	languageOctets,
	languageWithin,
	numericBoundOf,
	numericTypmodOf,
	type PlainType,
	isFloat,
	type PatternLanguage,
	type RegexCheck,
	type RegexRef,
	regexRefOf,
	rosterOf,
	type ScalarType,
	spanOf,
	textBoundsOf,
	type TextInfo,
	textInfoBounds,
	textOf,
	textPatterns,
	typeLabel,
	wildcardPattern
} from "#compiler/ir/scalar.ts"
import {
	isTextSearchConfiguration,
	isTextSearchWeight,
	textQueryMaxBytes,
	textSearchConfigurations
} from "#compiler/ir/search.ts"
import {
	absBounds,
	addBounds,
	type Bounds,
	compareExact,
	digitsOfExact,
	exactOf,
	exactOfDecimal,
	exactOfDouble,
	type FactSet,
	floorOfExact,
	finiteEnds,
	greatestBounds,
	hullBounds,
	leastBounds,
	magnitudeAtLeast,
	minus,
	mulBounds,
	ownLimited,
	negBounds,
	negExact,
	noFacts,
	ofDigits,
	ofPoint,
	ofRange,
	ofSpecial,
	pointOf,
	quotientBounds,
	type Refinement,
	boundsHave,
	refine,
	refinementsOf,
	scaleOfExact,
	significantRound,
	subBounds
} from "#compiler/scalar/compute/bounds.ts"
import { floatNumericDigits } from "#compiler/scalar/compute/cast.ts"
import { binary64MinExponent } from "#compiler/scalar/compute/cast.ts"
import { admitLiteral } from "#compiler/scalar/compute/evaluate.ts"
import { bareLiteralKind, oppositeLiteralProblem } from "#compiler/scalar/compute/literal.ts"
import { type FloatCarrier, resultBounds } from "#compiler/scalar/compute/native.ts"
import { numericMaxDisplayScale } from "#compiler/scalar/compute/numeric.ts"
import {
	binaryCoercion,
	type CastOp,
	castOf,
	type CommonTypeFn,
	type CommonTypeOp,
	commonTypeOf,
	computeSpecs,
	type FixedFn,
	type FixedOp,
	type IeeeOp,
	type NativeFn,
	type NativeOp,
	nativeOp,
	overloadOf,
	registeredCast
} from "#compiler/scalar/compute/registry.ts"
import { spelling } from "#compiler/scalar/compute/spelling.ts"
import { moneyDigits } from "#compiler/scalar/compute/types.ts"
import {
	anyNumeric,
	commonType,
	exactFamily,
	exactType,
	familyDigits,
	isComputedNumeric,
	meetingType,
	meets,
	sameCarrier,
	mixesExact,
	sameRegex,
	valueType,
	wideningOf,
	wildcardText,
	withoutSpanWidth
} from "#compiler/scalar/compute/types.ts"
import { binary64Digits, decimalTextMaxBytes } from "#compiler/scalar/lexical.ts"
import { lexicalTargetOf } from "#compiler/scalar/lexical.ts"
import { binary64Precision } from "#compiler/scalar/lexical.ts"
import { plainType } from "#compiler/scalar/native.ts"
import type { MatchAdmission } from "#compiler/scalar/regex/admit.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import {
	type CharMap,
	charMapOf,
	imageBytes,
	imageFlags,
	imageOf
} from "#compiler/scalar/regex/translate.ts"
import { collapseSources } from "#compiler/scalar/regex/whitespace.ts"
import {
	capabilitiesOf,
	numericValue,
	searchType,
	storedOnly,
	type TextLookup
} from "#compiler/scalar/registry.ts"
import { Decimal, moneyFractionDigits, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { numericMaxFractionDigits, numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"
import {
	bytesMaxLength,
	textSearchStringMaxBytes,
	varlenaHeaderBytes
} from "#compiler/scalar/values/fault.ts"
import { binary32Digits } from "#compiler/scalar/values/float.ts"
import { binary32LeastExponent } from "#compiler/scalar/values/float.ts"
import { Money } from "#compiler/scalar/values/money.ts"

/**
 * The site-free typing of a scalar description (typeOf): one pass over a description that emits nothing, which a
 * builder reads to type the term it constructs and the lowering (lower.ts) replays to emit and judge the term where it
 * is compiled. What the typing decides of each node, its types, what is proved of its values, its overload, its
 * conversions and the type a literal adopts, it decides once, at no site, and nothing decides it again; what depends
 * on the site or on judgement, a refusal one site makes, a literal's ContractLiteral check, a partial operation's
 * proof, a native proof or a pattern's admission, it records on the tape (TapeEntry), in the order the lowering takes
 * it.
 */

/**
 * The most bytes a character of a UTF-8 database takes, pg_database_encoding_max_length() there: the widest UTF-8
 * sequence PostgreSQL reads, which translate allocates for each byte of its operand.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope one character of a UTF-8 database, the maxmblen pg_wchar_table holds for PG_UTF8
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/common/wchar.c#L1872
 * @quote [PG_UTF8] = {pg_utf2wchar_with_len, pg_wchar2utf_with_len, pg_utf_mblen, pg_utf_dsplen, pg_utf8_verifychar,
 *   pg_utf8_verifystr, 4},
 * @verified 2026-11-20
 */
export const utf8EncodingMaxBytes = 4

/**
 * The longest text, in UTF-8 bytes, PostgreSQL's translate reads: it allocates its result for the worst case, a widest
 * character for every byte of its operand, with its header, and refuses an allocation past MaxAllocSize with 54000,
 * "requested length too large". So a query translates only an operand whose pattern bounds its bytes within this, and a
 * check or generated column that translates a longer text fails its write.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the operand of one translate(text, text, text) call
 * @derivation translate refuses "if (unlikely(pg_mul_s32_overflow(pg_database_encoding_max_length(), m, &bytelen)) ||
 *   unlikely(pg_add_s32_overflow(bytelen, VARHDRSZ, &bytelen)) || unlikely(!AllocSizeIsValid(bytelen)))" over its
 *   operand's m bytes
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/oracle_compat.c#L854-L864, verified
 *   2026-11-20), and "#define AllocSizeIsValid(size) ((Size) (size) <= MaxAllocSize)"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/include/utils/memutils.h#L42), so m is at most
 *   (MaxAllocSize - VARHDRSZ) / maxmblen, rounded down
 * @from {@link maxAllocSize}, {@link utf8EncodingMaxBytes}, {@link varlenaHeaderBytes}
 */
export const translateMaxBytes = Math.floor(
	(maxAllocSize - varlenaHeaderBytes) / utf8EncodingMaxBytes
)

/**
 * The bytes RFC 3986 §5.2.3's merge adds to a reference's path, the `/` it begins one with where the base has an
 * authority and an empty path: all a resolved target holds past its base's bytes and its reference's
 * (resolveReference).
 *
 * @formatConstant RFC 3986 §5.2.3 merge: one "/"
 */
const mergedSlashBytes = utf8Length("/")

/**
 * The fraction digits of every binary32 value: the least subnormal 2^-k = 5^k / 10^k has exactly k of them, and every
 * other value is an integer multiple of it.
 *
 * @limitKind derived
 * @owner IEEE 754-2019 binary32
 * @unit decimal digits
 * @scope the fraction digits of every finite real value
 * @derivation -(emin - p + 1): 2^-k is 5^k / 10^k, of k fraction digits
 * @from {@link binary32LeastExponent}
 */
const binary32FractionDigits = -binary32LeastExponent

/**
 * The fraction digits of every binary64 value: those of its least subnormal, 2^-(p - 1 - emin).
 *
 * @limitKind derived
 * @owner IEEE 754-2019 binary64
 * @unit decimal digits
 * @scope the fraction digits of every finite double precision value
 * @derivation -(emin - p + 1): 2^-k is 5^k / 10^k, of k fraction digits
 * @from {@link binary64Precision}, {@link binary64MinExponent}
 */
const binary64FractionDigits = binary64Precision - 1 - binary64MinExponent

/**
 * What a leaf reference names: a rule variable, a check's field, the contract's VALUE, or an attachment's parent head
 * variable, as the expression's references admit them (ir/desc.ts Refs).
 */
export type LeafDesc<R extends Refs = Spelled> = R["leaf"]

/** A scalar parameter reference: what its references carry, and the type it states. */
export type ParamRef<R extends Refs> = { readonly type: R["paramType"] } & R["param"]

/**
 * The parameters an expression reads: none (a contract predicate or a row check reads only its value or row, and a
 * law's violation query reads only its relations), or the lowering of one: its node, and its type, the one it declares.
 */
export type LowerParams<R extends Refs> =
	| { readonly kind: "none" }
	| {
			readonly kind: "scope"
			readonly lower: (
				param: ParamRef<R>,
				loc: SourceLoc
			) => Result.Result<
				{ readonly spec: ExprSpec; readonly type: ScalarType; readonly reading: ParamReading },
				CompileError
			>
	  }

export const noParams: { readonly kind: "none" } = Object.freeze({ kind: "none" })

/** Whether a branch is an untyped literal, which adopts the type of the other branch. */
const isBareLiteral = <R extends Refs>(d: ExprDesc<Located, R>): boolean =>
	d.kind === "literal" && d.type === undefined

/** A closed relation's field, as an application of it reads the field: its name and its type. */
export interface ClosedField {
	readonly name: string
	readonly type: ScalarType
}

/**
 * What a Text.matches pattern reading a closed relation's payload field can be (lower.ts readAdmissions): a
 * str.pattern field's distinct values in row order, none where it holds no row, each admitted once where the relation
 * is read (check/closed.ts closedReads); or a field of any other type, which no pattern reads.
 */
export type PayloadPatterns =
	| { readonly kind: "patterns"; readonly admitted: ReadonlyArray<MatchAdmission> }
	| { readonly kind: "other" }

/** A payload field of a closed relation, as C.at reads it, with what a Text.matches pattern reading it can be. */
export interface ClosedPayloadField extends ClosedField {
	readonly patterns: PayloadPatterns
}

/**
 * A closed relation as C.at and C.row read it: its key fields in key order, which an application's terms meet one by
 * one, and its payload fields, one of which C.at reads.
 */
export interface ClosedHeading {
	readonly key: NonEmptyReadonlyArray<ClosedField>
	readonly payload: ReadonlyArray<ClosedPayloadField>
}

/**
 * The closed relations an expression may apply: a schema's, by name, undefined for a name that is no closed relation's;
 * or none, where no expression applies one, with the reason, which a refusal of C.at or C.row there states.
 */
export type ClosedRelations =
	| {
			readonly kind: "schema"
			readonly heading: (relation: string) => ClosedHeading | undefined
	  }
	| { readonly kind: "none"; readonly why: string }

/**
 * A part of a Text.matches pattern, in the order the pattern states it: a literal, a closed relation's payload
 * field C.at reads, or any other expression, each with the branches of the Logic.cond it stands in. The one reading of
 * what a pattern reads, which patternAdmissions admits.
 */
type PatternPart<R extends Refs> =
	| {
			readonly kind: "literal"
			readonly desc: Extract<ExprDesc<Located, R>, { readonly kind: "literal" }>
			readonly branches: ReadonlyArray<"onTrue" | "onFalse">
	  }
	| {
			readonly kind: "closedAt"
			readonly desc: Extract<ExprDesc<Located, R>, { readonly kind: "closedAt" }>
			readonly branches: ReadonlyArray<"onTrue" | "onFalse">
	  }
	| {
			readonly kind: "other"
			readonly desc: ExprDesc<Located, R>
			readonly branches: ReadonlyArray<"onTrue" | "onFalse">
	  }

/** The parts of the Text.matches pattern `desc` (PatternPart), a conditional's two branches in turn. */
const patternParts = <R extends Refs>(desc: ExprDesc<Located, R>): ReadonlyArray<PatternPart<R>> =>
	partsUnder(desc, [])

/** patternParts of `desc`, which stands in the conditional branches `branches`. */
const partsUnder = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	branches: ReadonlyArray<"onTrue" | "onFalse">
): ReadonlyArray<PatternPart<R>> => {
	switch (desc.kind) {
		case "literal":
			return [{ kind: "literal", desc, branches }]
		case "closedAt":
			return [{ kind: "closedAt", desc, branches }]
		case "cond":
			return [
				...partsUnder(desc.onTrue, [...branches, "onTrue"]),
				...partsUnder(desc.onFalse, [...branches, "onFalse"])
			]
		case "guarded":
			return partsUnder(desc.arg, branches)
		case "var":
		case "field":
		case "value":
		case "parent":
		case "param":
		case "compute":
		case "cast":
		case "base":
		case "retype":
		case "when":
		case "compare":
		case "between":
		case "in":
		case "and":
		case "or":
		case "not":
		case "closedRow":
		case "closedHas":
		case "allen":
		case "pointIn":
		case "absent":
		case "exists":
		case "call":
			return [{ kind: "other", desc, branches }]
	}
}

/**
 * Whether two operands of an equality are refinements of one base carrier that do not meet nominally (types.ts
 * sameCarrier, meets): natural and pg.bigint, two contracts over one base, a contract over a closed id and the closed id.
 * Such an equality is typed at the carrier, each operand restated at its base as Type.base restates it (Typing
 * atCarrier), and compared under the base's equality, as a containment pairs its sides. Where it holds its value is each
 * operand's, so it lies in both operands' contracts: within its scope either side may stand for the other at the
 * other's type, retyped (ExprDesc `retype`), proved by the equality and never checked.
 */
const refinedPair = (a: Typed, b: Typed): boolean =>
	!meets(a.nominal, b.nominal) && sameCarrier(a.nominal, b.nominal)

/** No closed relation, for the reason `why`: "a contract predicate reads no closed relation of the schema". */
export const noClosedRelations = (why: string): ClosedRelations =>
	Object.freeze({ kind: "none", why })

/** The site a term is compiled at, which judges what the term holds there and refuses what it cannot hold. */
export type LowerSite = "query" | "check"

/**
 * The text analysis a typing reads. A builder's term goes unanalyzed: it is typed before it is known where it stands,
 * so a language no declaration states is no type there, an operation's text is text of no pattern and a match
 * establishes nothing of its subject, a sound over-approximation of the type its compilation gives it. A compiled
 * term's is the compile's: a computed text's language by its table's text analysis (textWithin), over the compile's
 * admitted patterns (scalar/regex/patterns.ts PatternAutomata `language`).
 */
export type TextAnalysis =
	| { readonly kind: "unanalyzed" }
	| { readonly kind: "analyzed"; readonly patterns: PatternAutomata }

/** The compile's text analysis. */
type Analyzed = Extract<TextAnalysis, { readonly kind: "analyzed" }>

/**
 * A language a mapping of a text's values gives (Typing collapseType, translatedType): its patterns, each the first
 * source of a pattern's image the text analysis admits, and their language as the analysis proves it.
 */
interface DerivedLanguage {
	readonly patterns: Patterns
	readonly language: PatternLanguage
}

/** A mapping of a text's values whose image a derived language holds: collapse, or a character map's (CharMap). */
type Derivation = "collapse" | CharMap

/**
 * The one place typing state attaches to a text's own language, by its enforcement (ir/scalar.ts RegexRef `check`),
 * the value the text analysis proved of its patterns, which every type of the language holds however often a type of it
 * is made (a schema's every compile makes its fields' types again, each reading its descriptor's language): the
 * language of each mapping of its values (Derivation), analyzed where a typing first meets it and read from it after.
 * The text analysis is one function of its patterns (text/refinement.ts analyzeText), whatever table a compile reads
 * them from, so every typing of a collapse or an image over a text of the language reads one analysis of its derived
 * patterns, where each typed them again, a minimal automaton each. A WeakMap holds nothing alive and is never enumerated: it is the language's state.
 */
const derivedLanguages = new WeakMap<RegexCheck, Map<Derivation, DerivedLanguage>>()

/**
 * The derived languages of the two texts of no own language (ir/scalar.ts TextInfo): any text, and a pattern's, each a
 * value of this module's, so its state is too.
 */
const constantLanguages: {
	readonly [T in Exclude<TextInfo, RegexRef>]: Map<Derivation, DerivedLanguage>
} = { wildcard: new Map(), pattern: new Map() }

/** The derived languages a text's language holds (derivedLanguages, constantLanguages). */
const derivationsOf = (text: TextInfo): Map<Derivation, DerivedLanguage> => {
	if (typeof text !== "object") {
		return constantLanguages[text]
	}
	const known = derivedLanguages.get(text.check)
	if (known !== undefined) {
		return known
	}
	const made = new Map<Derivation, DerivedLanguage>()
	derivedLanguages.set(text.check, made)
	return made
}

/** The language `derive` makes of `text`'s by `derivation`: the one its language holds, made where it is first read. */
const derivedLanguage = (
	text: TextInfo,
	derivation: Derivation,
	derive: () => DerivedLanguage
): DerivedLanguage => {
	const derived = derivationsOf(text)
	const known = derived.get(derivation)
	if (known !== undefined) {
		return known
	}
	const made = derive()
	derived.set(derivation, made)
	return made
}

/**
 * What a site proves of every value of one of its leaves beyond the leaf's type, which every term typed there holds of
 * each occurrence of it (an `occurrences` WhenScope): a rule's series element lies between its endpoints, at least the
 * least value its low endpoint takes and at most the greatest its high endpoint takes (check/checker.ts), a fact of
 * every row its source delivers. Never what a filter tests, which may be evaluated anywhere
 * (lower/optimize/pushdown), so a leaf's values are those its source delivers wherever a term reads it.
 */
export interface HeldLeaf {
	readonly leaf: ExprSpec
	readonly bounds: Bounds
}

/** The scope a site's held leaves give every term typed there: each leaf's every occurrence cut to its bounds. */
const heldScope = (held: ReadonlyArray<HeldLeaf>): ReadonlyArray<WhenScope> =>
	held.flatMap((h) =>
		refinementsOf(h.bounds).map((refinement): WhenScope => ({
			kind: "occurrences",
			holds: {
				kind: "facts",
				subject: { kind: "stated", spec: leafSpec(h.leaf) },
				refinement,
				facts: []
			}
		}))
	)

/**
 * What a typing reads besides its description: where it stands for diagnostics, what its leaves, parameters,
 * descriptors and closed reads name, what the site holds of its leaves (HeldLeaf), and its text analysis.
 */
export interface TypingEnv<R extends Refs> {
	/** The source location of the expression, the prefix of every diagnostic. */
	readonly loc: SourceLoc
	/** The node a leaf reference records at each use. */
	readonly leaf: (desc: LeafDesc<R>, loc: SourceLoc) => Result.Result<ExprSpec, CompileError>
	readonly params: LowerParams<R>
	/** The ScalarType of a descriptor's Description, for Type.literal and Type.cast (the descriptor registry). */
	readonly fieldType: (desc: FieldDesc, loc: SourceLoc) => Result.Result<ScalarType, CompileError>
	/** The closed relations C.at and C.row apply. */
	readonly closed: ClosedRelations
	/** The declared functions Fn.call calls (DeclaredFunctions). */
	readonly functions: DeclaredFunctions
	/** What the site proves of its leaves beyond their types: none but a rule's series elements. */
	readonly held: ReadonlyArray<HeldLeaf>
	readonly analysis: TextAnalysis
}

/**
 * The declared functions a term may call (schema/function.ts fn): a query's schema's, by name, undefined for a name that
 * is no declared function's; or none, where the host evaluates the term or no schema is in reach, with the reason, which
 * a refusal of Fn.call there states.
 */
export type DeclaredFunctions =
	| { readonly kind: "schema"; readonly of: (name: string) => CallableFunction | undefined }
	| { readonly kind: "none"; readonly why: string }

/**
 * A declared function as a call reads it (schema/function-own.ts OwnedFunction): its name, its Description, which
 * states its signature and its volatility, and the digest of its Description, which the call carries.
 */
export interface CallableFunction {
	readonly name: string
	readonly desc: FunctionDesc
	readonly definition: FunctionDigest
}

/** A recorded node's arguments: the nodes recorded before it, whose emissions its emission reads. */
export interface TypedArgs {
	readonly expr: TypedNode
}

/**
 * A spec over recorded nodes, as the lowering emits it, its arguments' emissions in their place: complete, a proof
 * among it where the environment built one, as a leaf's may.
 */
export type TypedSpec = ExprSpecOver<TypedArgs>

/** A spec whose emission holds no proof, native proof or pattern table: what the typing states of a node it judges. */
type PlainSpec = Exclude<
	TypedSpec,
	| { readonly proof: OperationProof }
	| { readonly native: NativeProof }
	| { readonly patterns: PatternTable }
>

type LiteralSpec = Extract<PlainSpec, { readonly kind: "literal" }>

/** An overload or registered cast defined everywhere, which an IEEE 754 one's native proof may complete. */
type NativeSpec = Extract<PlainSpec, { readonly kind: "op" | "cast" }>

/** textregexeq's node, which the pattern table of the values its pattern can take completes. */
type MatchSpec = Extract<PlainSpec, { readonly kind: "op" }>

/** A partial overload or registered cast, which the proof of its preconditions completes. */
export type UnprovedSpec =
	| {
			readonly kind: "op"
			readonly op: PartialOp
			readonly args: ReadonlyArray<TypedNode>
			readonly type: ScalarType
			readonly nonNull: "strict"
			readonly volatility: Volatility
	  }
	| {
			readonly kind: "cast"
			readonly cast: PartialOp
			readonly args: readonly [TypedNode]
			readonly type: ScalarType
			readonly nonNull: "strict"
			readonly volatility: Volatility
	  }

/** A domain cast, which the proof that its value satisfies the target's refinement completes. */
interface DomainCastSpec {
	readonly kind: "domainCast"
	readonly args: readonly [TypedNode]
	readonly type: ScalarType
	readonly nonNull: "strict"
}

/**
 * What proves a partial node's preconditions: the caller's terms it stands for, `operands`, position by position, a
 * refusal naming `operation` and the guard to write (judged); or the value the typing wrote the cast over itself,
 * whose own interval proves them, since no caller's type states a fact of it (CastHow computed).
 */
export type ProofObligation =
	| {
			readonly kind: "judged"
			readonly preconditions: NonEmptyReadonlyArray<Precondition>
			readonly operands: ReadonlyArray<Typed>
			readonly target: ScalarType
			readonly at: SourceLoc
			readonly operation: string
	  }
	| {
			readonly kind: "computed"
			readonly preconditions: NonEmptyReadonlyArray<Precondition>
			readonly operand: Typed
			readonly target: ScalarType
	  }

/**
 * What a part of a Text.matches pattern reads (PatternPart), where it stands: a pattern literal's value, admitted
 * where it was made or decoded, as a str.regex pattern is (ir/pattern.ts admitSpelling), since its value is the
 * description's own; a closed
 * relation's payload field C.at reads, whose values the lowering batch admitted; or another kind of term, which can be
 * any text, which the lowering refuses.
 */
export type PatternRead =
	| { readonly kind: "admitted"; readonly value: PatternValue }
	| {
			readonly kind: "closedAt"
			readonly relation: string
			readonly field: string
			readonly at: SourceLoc
	  }
	| { readonly kind: "other"; readonly what: ExprDesc["kind"]; readonly at: SourceLoc }

/**
 * A predicate another package lowers (r.allen, r.pointIn, r.not), of its boolean type: its node is the one that package
 * builds where the lowering reaches it (the tape's extension entry).
 */
export interface ExtensionNode {
	readonly kind: "extension"
	readonly type: ScalarType
}

/**
 * An expression the environment built before the typing, which a leaf's spec reads: its own emission, recorded
 * nowhere (a contract violation's VALUE read through a span's endpoint, a law's column).
 */
export interface BuiltNode {
	readonly kind: "built"
	readonly expr: ScalarExpr
}

/**
 * A node the typing records: the spec the lowering emits, over the nodes recorded before it, and what the lowering
 * judges of it first. Stated, it is emitted as it is, a leaf as the environment resolved it; a literal is judged against the refinements of the type it
 * adopts (ContractLiteral); an IEEE 754 overload into a float is emitted with the proof that PostgreSQL's own overload
 * computes it where its operands' premises give one (native.ts nativeProof); a partial one with the proof of its
 * preconditions; a domain cast with the proof that its value satisfies the target's refinement; a match with the table
 * of the values its pattern can take.
 */
export type TypedNode =
	| { readonly kind: "stated"; readonly spec: TypedSpec }
	| {
			readonly kind: "literal"
			readonly spec: LiteralSpec
			readonly refinements: ScalarType
			readonly at: SourceLoc
	  }
	| {
			readonly kind: "native"
			readonly spec: NativeSpec
			readonly ieee: IeeeOp
			readonly carrier: FloatCarrier
			/** The first operand's type, a rounding's source. */
			readonly from: ScalarType
			readonly operands: ReadonlyArray<Typed>
	  }
	| { readonly kind: "proved"; readonly spec: UnprovedSpec; readonly proof: ProofObligation }
	| {
			readonly kind: "domainCast"
			readonly spec: DomainCastSpec
			readonly value: Typed
			/** The contract or regex-refined type the value is coerced into. */
			readonly target: ScalarType
			/** How the value's own refinement is checked before any SQL, where it is: a literal's, a parameter's. */
			readonly checked: "literal" | "parameter" | undefined
			readonly at: SourceLoc
	  }
	| {
			readonly kind: "matches"
			readonly spec: MatchSpec
			readonly subject: Typed
			readonly pattern: ReadonlyArray<PatternRead>
			readonly at: SourceLoc
			readonly patternAt: SourceLoc
	  }
	| ExtensionNode
	| BuiltNode

/** A node the typing records on its own entry of the tape: every node but an extension's and a built one. */
export type RecordedNode = Exclude<TypedNode, ExtensionNode | BuiltNode>

/** A predicate another package lowers. */
export type ExtensionDesc<R extends Refs> = Extract<
	ExprDesc<Located, R>,
	{ readonly kind: "allen" | "pointIn" | "absent" | "exists" }
>

/**
 * One step of a term's lowering, in the order the lowering takes them: a node judged then emitted; a predicate
 * another package lowers where it stands, typing its children under the Logic.whens around it; a refusal at one site
 * of what the term holds there (UnsupportedOperation); a numeric bound past numeric's own digits, ResourceBound
 * wherever the term is compiled; or a literal judged by the contract of the term it stands beside in arithmetic
 * (ContractLiteral).
 */
export type TapeEntry<R extends Refs> =
	| { readonly kind: "node"; readonly node: RecordedNode }
	| {
			readonly kind: "extension"
			readonly node: ExtensionNode
			readonly desc: ExtensionDesc<R>
			readonly at: SourceLoc
			readonly scope: ReadonlyArray<WhenScope>
	  }
	| {
			readonly kind: "refused"
			readonly site: LowerSite
			readonly at: SourceLoc
			readonly capability: string
	  }
	| { readonly kind: "digits"; readonly at: SourceLoc; readonly needed: number }
	| {
			readonly kind: "admits"
			readonly value: LiteralDesc
			readonly type: ScalarType
			readonly at: SourceLoc
	  }

/**
 * A typed operand: its node, the type the caller's term has (nominal), the SQL type the node computes (actual), which
 * differ only where a parameter is bound as its base or a cast keeps its source's refinement, and what is proved of
 * its values: the bound domain's interval and digits where its type is a number (bounds.ts Bounds), and its facts
 * (FactSet). Two operands share a node where one restates the other.
 *
 * Its nominal type is private to it and written once, by settle (Typing.settle), which narrows the type an operation
 * states by every guard the term stands under. A copy is no Typed, so no operation writes a term's type after settle:
 * one that states a type of its own, a collapse's or a translation's language or a cast's target, restates the term
 * (Typing.restate), and the guards narrow it again.
 */
export class Typed {
	readonly node: TypedNode
	readonly actual: ScalarType
	readonly bounds: Bounds | undefined
	readonly facts: FactSet
	/**
	 * The enclosing Logic.when guards whose parameter this value is (Typing.guarded): what each establishes of it,
	 * settled again wherever the value is restated, so a restatement of the parameter keeps it. None for any other value.
	 */
	readonly held: ReadonlyArray<WhenParameter>
	readonly #nominal: ScalarType

	constructor(
		node: TypedNode,
		nominal: ScalarType,
		actual: ScalarType,
		bounds: Bounds | undefined,
		facts: FactSet,
		held: ReadonlyArray<WhenParameter>
	) {
		this.node = node
		this.#nominal = nominal
		this.actual = actual
		this.bounds = bounds
		this.facts = facts
		this.held = held
	}

	/** The type the caller's term has, as settle stated it and the guards the term stands under narrowed it. */
	get nominal(): ScalarType {
		return this.#nominal
	}
}

/** A typed term: its root, and the tape of every node and check its lowering takes, in order. */
export interface TermTyping<R extends Refs> {
	readonly root: Typed
	readonly tape: ReadonlyArray<TapeEntry<R>>
}

/**
 * Internal control flow: the first refusal deep inside a lowering is thrown as a Refusal and caught at the boundary
 * (catchRefusal, core/canonical.ts).
 */
export const stop = (
	reason: Extract<ProseTag, "MalformedDescription" | "UnsupportedOperation" | "ContractLiteral">,
	loc: SourceLoc,
	capability: string
): never => {
	throw new Refusal(CompileError.make(prose(reason, loc, capability)))
}

/**
 * Where a bare literal stands opposite a term: compared with it (a comparison, an IN list, BETWEEN bounds, a
 * conditional's branch), an arithmetic operand beside it (+, -, *, /, %, quot, rem, power, gcd, lcm), or a text
 * operation's second operand (concat, startsWith, endsWith, contains).
 */
export type Role = "compare" | "arithmetic" | "operand"

/**
 * The type a bare literal adopts opposite a term of type `t` (see the header): compared with a contract, the contract;
 * otherwise the term's value type, a numeric's any numeric, an exact value's plain family, an operand text's any text
 * and a span's its endpoint's, so a literal is typed by the term it meets and never on its own. An arithmetic operand
 * is typed at the base and judged a value of the term's contract beside it (Typing.operand).
 */
export const adoptedType = (t: ScalarType, role: Role): ScalarType => {
	if (role === "compare" && t.contract !== undefined) {
		return t
	}
	const v = valueType(t)
	if (v.carrier === "numeric") {
		return anyNumeric
	}
	if (v.carrier === "exactInteger") {
		return plainType("int8")
	}
	if (v.carrier === "exactMoney") {
		return plainType("money")
	}
	if (role === "operand" && v.carrier === "text") {
		return wildcardText
	}
	return withoutSpanWidth(v)
}

/** Money's range, a signed 64-bit count of minor units. */
export const moneyLow: Exact = exactOf(int8Min, moneyFractionDigits)
export const moneyHigh: Exact = exactOf(int8Max, moneyFractionDigits)

/** Every value of a carrier, before any contract: what a value of its base type can be. */
const carrierBounds = (t: PlainType): Bounds | undefined => {
	switch (t.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return ofRange(
				integerRanges[t.carrier][0],
				integerRanges[t.carrier][1],
				integerDigits[t.carrier]
			)
		case "numeric":
			return t.typmod === undefined
				? ofDigits(t.bound.digits, t.bound.scale, { infinite: true, nan: true })
				: ofDigits(t.typmod.precision - t.typmod.scale, Math.max(t.typmod.scale, 0), {
						infinite: false,
						nan: !isIntegerTypmod(t.typmod)
					})
		case "float4":
			return ofDigits(binary32Digits, binary32FractionDigits, {
				infinite: true,
				nan: true
			})
		case "float8":
			return ofDigits(binary64Digits, binary64FractionDigits, {
				infinite: true,
				nan: true
			})
		case "money":
			return refine(ofDigits(moneyDigits, moneyFractionDigits, { infinite: false, nan: false }), {
				kind: "within",
				low: moneyLow,
				high: moneyHigh
			})
		case "exactInteger":
			return ofDigits(t.digits, 0, { infinite: false, nan: false })
		case "exactMoney":
			return ofDigits(t.digits, moneyFractionDigits, { infinite: false, nan: false })
		case "date":
			return dateBounds
		case "bool":
		case "uuid":
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
			return undefined
	}
}

/** The levels of a contract, outermost first, down to its base. */
export const contractLevels = (t: ScalarType): ReadonlyArray<ContractInfo> => {
	const levels: Array<ContractInfo> = []
	for (let c = t.contract; c !== undefined; c = c.base.contract) {
		levels.push(c)
	}
	return levels
}

/**
 * What a parameter's reading proves of its values beyond its type (ir/clock.ts ParamReading): nothing for a stated value,
 * which has its type's bounds; a reading of the database's clock lies in the clock's range too (core/clock.ts
 * clockReadingRange), its type's bounds refined by it, its facts its type's.
 */
const readingProof = (
	t: ScalarType,
	reading: ParamReading
): { readonly bounds: Bounds | undefined; readonly facts: FactSet } | undefined => {
	switch (reading.kind) {
		case "stated":
			return undefined
		case "clock": {
			const own = boundsOfType(t)
			const range = clockReadingRange[reading.unit]
			return {
				bounds:
					own === undefined
						? undefined
						: refine(own, {
								kind: "within",
								low: exactOf(range.low, 0),
								high: exactOf(range.high, 0)
							}),
				facts: factsOfType(t)
			}
		}
	}
}

/** The bounds every value of `t` has: its base's, refined by each contract level's atoms over VALUE. */
export const boundsOfType = (t: ScalarType): Bounds | undefined => {
	const base = carrierBounds(baseOf(t))
	if (base === undefined) {
		return undefined
	}
	return contractLevels(t).reduce(
		(b, c) => (c.predicate === undefined ? b : predicateAtoms(c.predicate).reduce(refine, b)),
		base
	)
}

/**
 * The facts every value of `t`'s SQL type has, whatever made it: an integer's, an exact value's and money's finiteness,
 * which their types state, and numeric(p, 0)'s, an integer type that holds no NaN, which grizzle refuses at every door,
 * and no infinity, which its typmod refuses (integerTypmodOf), as the TypeScript types read finiteness off an operand's
 * SQL type and, for numeric(p, 0), its host type, a bigint (types/compute/compute.ts FiniteByType).
 */
const carrierFacts = (t: ScalarType): FactSet => {
	const carrier = baseOf(t).carrier
	return carrier === "int2" ||
		carrier === "int4" ||
		carrier === "int8" ||
		carrier === "money" ||
		carrier === "exactInteger" ||
		carrier === "exactMoney" ||
		integerTypmodOf(t) !== undefined
		? finiteByType
		: noFacts
}

const finiteByType: FactSet = Object.freeze({ finite: { kind: "type" } })

/**
 * The facts every value of `t` has: its SQL type's (carrierFacts), and each contract level's declared facts, which its
 * build proved from its predicate (scalar/contract.ts).
 */
export const factsOfType = (t: ScalarType): FactSet => {
	const facts: { [F in Fact]?: FactSet[F] } = { ...carrierFacts(t) }
	for (const c of contractLevels(t)) {
		for (const f of c.facts) {
			facts[f] = facts[f] ?? { kind: "contract", name: c.name }
		}
	}
	return Object.freeze(facts)
}

/**
 * Whether no value of `t` is zero, so a float of it holds no -0: its facts state it (a contract that declares nonzero,
 * which its build proved), its bounds hold no zero (a contract's interval atoms refining its base's), or a contract
 * level's predicate states VALUE <> 0, which PostgreSQL's equality, -0 = 0, refuses -0 by too.
 */
export const excludesZero = (t: ScalarType): boolean => {
	const bounds = boundsOfType(t)
	return (
		factsOfType(t).nonzero !== undefined ||
		(bounds !== undefined && boundsHave(bounds, "nonzero")) ||
		contractLevels(t).some(
			(c) =>
				c.predicate !== undefined && predicateAtoms(c.predicate).some((a) => a.kind === "nonzero")
		)
	)
}

/** The facts a literal's own value has: NaN and Infinity are never zero nor below zero, nor finite. */
const factsOfValue = (value: Exact | "nan" | "infinity" | "-infinity"): FactSet => {
	const literal = { kind: "literal" } as const
	switch (value) {
		case "nan":
		case "infinity":
			return Object.freeze({ nonzero: literal, nonnegative: literal })
		case "-infinity":
			return Object.freeze({ nonzero: literal })
		default: {
			const sign = value.units < 0n ? -1 : value.units > 0n ? 1 : 0
			return Object.freeze({
				finite: literal,
				...(sign !== 0 ? { nonzero: literal } : {}),
				...(sign >= 0 ? { nonnegative: literal } : {})
			})
		}
	}
}

/** A date literal's value in the bound domain: its day number (ir/date.ts dayNumber); undefined for any other. */
const dateExact = (literal: TypedLiteral): Exact | undefined =>
	literal.kind === "date" ? exactOf(BigInt(dayNumber(literal.value)), 0) : undefined

/** The day numbers of every date, the first's to the last's. */
const dateBounds: Bounds = ofRange(
	BigInt(dayNumber(firstCalendarDate)),
	BigInt(dayNumber(lastCalendarDate)),
	String(dayNumber(lastCalendarDate)).length
)

/** A typed literal's value in the bound domain: exact, a special, or no number at all. */
const literalNumber = (
	literal: TypedLiteral
): Exact | "nan" | "infinity" | "-infinity" | undefined => {
	switch (literal.kind) {
		case "int":
			return exactOf(literal.value, 0)
		case "float":
			return exactOfDouble(literal.value)
		case "floatSpecial":
			switch (literal.value) {
				case "NaN":
					return "nan"
				case "Infinity":
					return "infinity"
				case "-Infinity":
					return "-infinity"
				case "-0":
					return exactOfDouble(0)
			}
		case "numeric": {
			const value = Decimal.fromValue(literal.value)
			const p = value.parts
			return p.kind === "finite" ? exactOfDecimal(value) : p.kind
		}
		case "money":
			return exactOf(Money.fromValue(literal.value).minorUnits, 2)
		case "bool":
		case "text":
		case "uuid":
		case "sha256":
		case "date":
		case "inet":
		case "cidr":
		case "handle":
		case "handles":
		case "span":
		case "vector":
		case "pattern":
			return undefined
	}
}

/** A stored literal entry's value in the bound domain. */
export const tableNumber = (
	e: TableExpr & { readonly kind: "literal" }
): Exact | "nan" | "infinity" | "-infinity" | undefined =>
	dateExact(e.value) ?? literalNumber(e.value)

const zero: Exact = exactOf(0n, 0)
const oneExact: Exact = exactOf(1n, 0)

/** The comparisons a contract predicate states of VALUE and a literal. */
type Comparison = "lt" | "le" | "gt" | "ge" | "eq" | "ne"

const comparisonOf = (fn: NativeFn | undefined): Comparison | undefined =>
	fn === "lt" || fn === "le" || fn === "gt" || fn === "ge" || fn === "eq" || fn === "ne"
		? fn
		: undefined

/** The comparison a flipped operand order states: c < VALUE is VALUE > c. */
const flippedComparison: { readonly [C in Comparison]: Comparison } = {
	lt: "gt",
	le: "ge",
	gt: "lt",
	ge: "le",
	eq: "eq",
	ne: "ne"
}

/**
 * A comparison of VALUE with a finite literal, as `VALUE op literal` whichever side the literal stands on; undefined for
 * any other term.
 */
export const literalComparison = (
	fn: NativeFn | undefined,
	x: TableExpr,
	y: TableExpr
): { readonly op: Comparison; readonly value: Exact } | undefined => {
	const op = comparisonOf(fn)
	const oriented =
		op === undefined
			? undefined
			: x.kind === "value" && y.kind === "literal"
				? { op, literal: y }
				: y.kind === "value" && x.kind === "literal"
					? { op: flippedComparison[op], literal: x }
					: undefined
	if (oriented === undefined) {
		return undefined
	}
	const v = tableNumber(oriented.literal)
	return typeof v === "object" ? { op: oriented.op, value: v } : undefined
}

/**
 * A comparison of VALUE with a finite literal as the cut it states (bounds.ts Refinement): at least or at most the
 * literal, open where strict, the literal itself, or never zero for `<> 0`; undefined where it states none here.
 */
const comparisonAtom = (
	fn: NativeFn | undefined,
	x: TableExpr,
	y: TableExpr
): Refinement | undefined => {
	const c = literalComparison(fn, x, y)
	if (c === undefined) {
		return undefined
	}
	const v = c.value
	switch (c.op) {
		case "ge":
			return { kind: "atLeast", value: v, open: false }
		case "gt":
			return { kind: "atLeast", value: v, open: true }
		case "le":
			return { kind: "atMost", value: v, open: false }
		case "lt":
			return { kind: "atMost", value: v, open: true }
		case "eq":
			return { kind: "within", low: v, high: v }
		case "ne":
			return compareExact(v, zero) === 0 ? { kind: "nonzero" } : undefined
	}
}

/**
 * The first of the facts a contract declares that its predicate, over its base's values, does not prove: from the
 * base's facts and the interval and never-zero atoms the predicate's top-level conjuncts state (predicateAtoms), or
 * undefined where it proves every one.
 */
export const unprovedFact = (
	base: ScalarType,
	predicate: ExprTable,
	facts: ReadonlyArray<Fact>
): Fact | undefined => {
	const atoms = predicateAtoms(predicate)
	const bounds = boundsOfType(base)
	const refined = bounds === undefined ? undefined : atoms.reduce(refine, bounds)
	const had = factsOfType(base)
	return facts.find(
		(f) =>
			had[f] === undefined &&
			!(f === "nonzero" && atoms.some((a) => a.kind === "nonzero")) &&
			!(refined !== undefined && boundsHave(refined, f))
	)
}

/** The registry function a stored op entry names, or undefined when it names no scalar overload. */
export const opFn = (e: TableExpr & { readonly kind: "op" }): NativeFn | undefined =>
	nativeOp(e.op)?.fn

/**
 * The atoms of a contract's predicate that state an interval of its VALUE: the comparisons and BETWEEN of VALUE with a
 * literal, at the top level of a conjunction. Every other conjunct states nothing here.
 */
const predicateAtoms = (table: ExprTable): ReadonlyArray<Refinement> => {
	const at = (id: TableExpr["id"]): TableExpr | undefined =>
		Object.hasOwn(table.exprs, id) ? table.exprs[id] : undefined
	const atoms: Array<Refinement> = []
	const visit = (id: TableExpr["id"]): void => {
		const e = at(id)
		if (e?.kind !== "op") {
			return
		}
		const fn = opFn(e)
		if (fn === "and") {
			for (const a of e.args) {
				visit(a)
			}
			return
		}
		const [x, y, z] = e.args.map(at)
		if (fn === "between" && x?.kind === "value" && y?.kind === "literal" && z?.kind === "literal") {
			const lo = tableNumber(y)
			const hi = tableNumber(z)
			if (typeof lo === "object" && typeof hi === "object") {
				atoms.push({ kind: "within", low: lo, high: hi })
			}
			return
		}
		if (x === undefined || y === undefined) {
			return
		}
		const atom = comparisonAtom(fn, x, y)
		if (atom !== undefined) {
			atoms.push(atom)
		}
	}
	visit(table.root)
	return atoms
}

/** Argument `i` of a compute description, or its refusal: an arity its kind's decoder fixed. */
const argOf = <R extends Refs>(
	desc: Extract<ExprDesc<Located, R>, { readonly kind: "compute" }>,
	i: number,
	at: SourceLoc
): ExprDesc<Located, R> =>
	desc.args[i] ?? stop("MalformedDescription", at, `argument ${i + 1} for ${desc.fn}`)

/** A part of a concatenation an equation decides (concatEquation), and where its description states it. */
interface ConcatPart<R extends Refs> {
	readonly desc: ExprDesc<Located, R>
	/** Where the part stands, and where the concatenation it is an operand of stands. */
	readonly at: SourceLoc
	readonly concat: SourceLoc
	/**
	 * The part's place in its concatenation: its first operand, a term as every operation's first is, or its second, a
	 * term or a bare literal, which adopts text of no pattern.
	 */
	readonly stands: "first" | "second"
}

/**
 * The parts of `desc`, an operand of the concatenation at `concat` standing at `at` in its place `stands`, in order: a
 * concatenation's are its operands' parts, read through every nested concatenation, so `(a || b) || c` and
 * `a || (b || c)` are both a, b and c, as concatenation is associative; any other term is its one part.
 */
const concatParts = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	at: SourceLoc,
	concat: SourceLoc,
	stands: ConcatPart<R>["stands"]
): NonEmptyReadonlyArray<ConcatPart<R>> => {
	if (desc.kind !== "compute" || desc.fn !== "concat") {
		return [{ desc, at, concat, stands }]
	}
	const here = childLoc(at, "concat")
	return concatNonEmpty(
		concatParts(argOf(desc, 0, here), childLoc(here, 0), here, "first"),
		concatParts(argOf(desc, 1, here), childLoc(here, 1), here, "second")
	)
}

/** A guard that states facts of a numeric subject: every guard but a match, which states a language. */
type FactGuard = Exclude<GuardDesc, { readonly kind: "matches" }>

/** What a Logic.when guard establishes of its subject inside the guarded branch (bounds.ts Refinement). */
const guardRefinement = (
	guard: FactGuard,
	within: readonly [Exact, Exact] | undefined
): Refinement => {
	switch (guard.kind) {
		case "nonzero":
			return { kind: "nonzero" }
		case "nonnegative":
			return { kind: "nonnegative" }
		case "positive":
			return { kind: "positive" }
		case "finite":
			return { kind: "finite" }
		case "within":
			return within === undefined
				? { kind: "finite" }
				: { kind: "within", low: within[0], high: within[1] }
	}
}

/**
 * The facts a guard gives its subject in the guarded branch, as its TypeScript signature gives them: within two finite
 * bounds is finite, nonnegative from a bound at or above zero, and nonzero from bounds on one side of zero.
 */
const guardFacts = (
	guard: FactGuard,
	within: readonly [Exact, Exact] | undefined
): ReadonlyArray<Fact> => {
	switch (guard.kind) {
		case "nonzero":
			return ["nonzero"]
		case "nonnegative":
			return ["nonnegative"]
		case "positive":
			return ["nonzero", "nonnegative"]
		case "finite":
			return ["finite"]
		case "within": {
			if (within === undefined) {
				return ["finite"]
			}
			const [low, high] = within
			const nonnegative = compareExact(low, zero) >= 0
			const nonzero = compareExact(low, zero) > 0 || compareExact(high, zero) < 0
			return [
				"finite",
				...(nonnegative ? (["nonnegative"] as const) : []),
				...(nonzero ? (["nonzero"] as const) : [])
			]
		}
	}
}

/**
 * The values of sign over an operand of `carrier` and bounds `b`: -1, 0 and 1, and NaN where a numeric operand may be
 * NaN, whose sign is NaN; a float's NaN has sign 0.
 */
const signBoundsOver = (
	carrier: "numeric" | "float8" | "exactInteger",
	b: Bounds | undefined
): Bounds => {
	const signs = ofRange(-1n, 1n, 1)
	return carrier === "numeric" && (b === undefined || b.nan)
		? hullBounds(signs, ofSpecial("nan"))
		: signs
}

/**
 * The most UTF-8 bytes a text term's value takes: a text literal's own, and any other term's its type's byte bound,
 * which an enclosing Logic.when(Num.within(Text.octetLength(x), 0, bytes), ...) narrows at every occurrence of
 * x in its branch (WhenScope), none where neither bounds its bytes. It is the one proof of a text's bytes every mode
 * reads: a `bounded` precondition's (lower.ts), and a query's regex read (lower.ts regexReadable) and translate.
 */
export const textBytes = (x: Typed): number | undefined => {
	const literal = nodeLiteral(x.node)
	return literal?.kind === "text" ? utf8Length(literal.value) : textBoundsOf(x.nominal)?.bytes
}

/**
 * The text of a translate map's `from` or `to`: a text literal, which the schema holds, so the map is seen when it
 * compiles; any other operand can be any text, so no map is known.
 */
const mapText = <R extends Refs>(
	which: "from" | "to",
	desc: ExprDesc<Located, R>,
	at: SourceLoc
): string =>
	desc.kind === "literal" && desc.type === undefined && typeof desc.value === "string"
		? desc.value
		: stop(
				"MalformedDescription",
				at,
				`a text literal as translate's ${which}, which states its map when the schema compiles, not a ${desc.kind}`
			)

/** Whether Num.within guards a value of `carrier`: a number's, the numeric family (scalar/compute/tables.ts). */
export const withinGuards = (carrier: Carrier): boolean => {
	switch (carrier) {
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "exactInteger":
		case "exactMoney":
			return true
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
			return false
	}
}

/**
 * The computed numeric of a node's proved bounds: their integer and fraction digits; numeric's own limits where nothing
 * is proved (anyNumeric). No numeric value has more integer digits than numeric's own limit, so a bound past it, an
 * expression that may overflow, types as that limit: the refusal is the lowering's, which refuses such a bound as
 * ResourceBound (numericDigits) where the expression is compiled.
 */
const numericOf = (bounds: Bounds | undefined): ScalarType =>
	bounds === undefined
		? anyNumeric
		: numericValue({
				digits: Math.min(bounds.digits, numericMaxIntegerDigits),
				scale: bounds.scale
			})

/**
 * The bounds of Text.parseDecimal's value where its operand has at most `bytes` UTF-8 bytes: at most as many digits
 * before its point as the decimal text it parses has bytes and, the point taking one, one fewer after it, finite and
 * never NaN. The parse is defined only within decimalTextMaxBytes (its lexical precondition, which the lowering proves),
 * so the text it parses has at most that many bytes whatever the operand's own bound: a value's digits are read from
 * the lesser of the two, and a text bounded only by regexTextMaxBytes, as every regex-matched text is, makes bounds of
 * decimalTextMaxBytes digits, where its 268,435,454 bytes made two exact powers of ten of as many digits.
 */
const decimalBounds = (bytes: number): Bounds => {
	const parsed = Math.min(bytes, decimalTextMaxBytes)
	return ofDigits(parsed, Math.max(parsed - 1, 0), { infinite: false, nan: false })
}

/**
 * How a cast converts: a registered cast over a caller's term, whose preconditions its facts and bounds prove (prove);
 * a registered cast the lowering writes over a value it computed itself, whose preconditions that value's own interval
 * proves (intervalCastProof), since no caller's type states a fact of it; or the binary coercion that drops a
 * refinement or widens a bound.
 */
type CastHow =
	| { readonly kind: "registered"; readonly op: CastOp }
	| { readonly kind: "computed"; readonly op: CastOp }
	| { readonly kind: "coercion" }

/**
 * What a Logic.when guard the typing stands in the branch of establishes of a term there: the term's node, and the
 * refined interval and the facts a numeric guard states, or the language a match states, which retypes a text term as
 * text of the pattern's language.
 */
type WhenGuard =
	| {
			readonly kind: "facts"
			readonly subject: TypedNode
			readonly refinement: Refinement
			readonly facts: ReadonlyArray<Fact>
	  }
	| { readonly kind: "language"; readonly subject: TypedNode; readonly type: ScalarType }

/**
 * What a Logic.when establishes inside its branch, and where: of its parameter, what its guard tests of its subject,
 * which only a guarded node of that guard over that subject holds (Typing.guarded), and every restatement of one,
 * since TypeScript narrows a branch's parameter and never a term the branch reads past it; or, where its subject is a
 * text's byte count, Text.octetLength(x), x within the guard's high end of bytes at every occurrence of x, a bound no
 * TypeScript type states and which no parameter carries, since the branch's parameter is the count. A node is the
 * subject, or an occurrence of it, where it records the subject's node (sameNode).
 */
export type WhenScope =
	| { readonly kind: "parameter"; readonly guard: GuardDesc; readonly holds: WhenGuard }
	| { readonly kind: "occurrences"; readonly holds: WhenGuard }

/** What a Logic.when establishes of its parameter (WhenScope). */
type WhenParameter = Extract<WhenScope, { readonly kind: "parameter" }>

/**
 * The type a node of `type` is recorded at, with the bounds its computation proved: a computed numeric's carries
 * exactly them (numericOf), so its type is its proof wherever it is read again; any other type is its own.
 */
const provedType = (type: ScalarType, bounds: Bounds | undefined): ScalarType =>
	isComputedNumeric(type) ? numericOf(bounds) : type

/**
 * The type an operation's node is recorded at, with the bounds it made (bounds.ts ownLimited): provedType's, and an
 * exact result's digit bound the made bounds' own, at numeric's own limit where an operand is bounded by nothing but it,
 * so an exact field's own arithmetic, `x + x` over an exactInteger, is of the field's type, its overflow PostgreSQL's
 * 22003 as a pg.numeric's is.
 */
const madeType = (type: ScalarType, bounds: Bounds | undefined): ScalarType =>
	isExactValue(type) && bounds !== undefined
		? exactType(type.carrier, bounds.digits)
		: provedType(type, bounds)

/**
 * The node of an overload or registered cast defined everywhere, `spec`, over `args`: an IEEE 754 one into a float,
 * `carried` the type it computes into, with the proof the lowering gives it where its operands' premises establish
 * that PostgreSQL's own overload computes it (native.ts nativeProof); any other as it is.
 */
const nativeNode = (
	op: Extract<NativeOp | CastOp, { readonly partial: false }>,
	spec: NativeSpec,
	args: ReadonlyArray<Typed>,
	carried: ScalarType
): RecordedNode => {
	const carrier = baseOf(carried).carrier
	const [first] = args
	return op.totality.kind !== "ieee" ||
		first === undefined ||
		(carrier !== "float4" && carrier !== "float8")
		? { kind: "stated", spec }
		: {
				kind: "native",
				spec,
				ieee: op.totality.op,
				carrier,
				from: nodeType(first.node),
				operands: args
			}
}

/** The literal a node records, a typed literal's or a leaf's; undefined for any other node. */
export const nodeLiteral = (node: TypedNode): TypedLiteral | undefined =>
	node.kind === "literal"
		? node.spec.value
		: node.kind === "stated" && node.spec.kind === "literal"
			? node.spec.value
			: undefined

/** The SQL type a node computes: its spec's, an extension's predicate's, a built expression's own. */
const nodeType = (node: TypedNode): ScalarType => {
	switch (node.kind) {
		case "extension":
			return node.type
		case "built":
			return node.expr.type
		case "stated":
		case "literal":
		case "native":
		case "proved":
		case "domainCast":
		case "matches":
			return node.spec.type
	}
}

/** A built expression's node. */
const builtNode = (expr: ScalarExpr): TypedNode => ({ kind: "built", expr })

/** A leaf's spec as the environment resolved it, over the nodes of the expressions it built for it to read. */
const leafSpec = (spec: ExprSpec): TypedSpec => withArgs<LiveArgs, TypedArgs>(spec, builtNode)

/** How a value's refinement is checked before any SQL, where it is: a literal at compile time, a parameter at bind. */
const checkedKind = (node: TypedNode): "literal" | "parameter" | undefined =>
	nodeLiteral(node) !== undefined
		? "literal"
		: node.kind === "stated" && node.spec.kind === "param"
			? "parameter"
			: undefined

/** A stated node's spelling in a refusal. */
const specText = (spec: TypedSpec): string => {
	switch (spec.kind) {
		case "column":
			return spec.column.name
		case "param":
			return "parameter"
		case "value":
			return "VALUE"
		case "literal":
			return canonicalTextOf(spec.value)
		case "op":
		case "cast":
		case "domainCast":
		case "cond":
			return "x"
		case "closedAt":
			return `${spec.relation}.at(${JSON.stringify(spec.field)}, …)`
		case "closedRow":
			return `${spec.relation}.row(…)`
		case "closedHas":
			return `${spec.relation}.has(…)`
		case "call":
			return `${spec.function.name}(…)`
	}
}

/** A node's spelling in a refusal: a leaf's name, a literal's text, a closed read's call, any operation `x`. */
export const nodeText = (node: TypedNode): string => {
	switch (node.kind) {
		case "stated":
			return specText(node.spec)
		case "literal":
			return canonicalTextOf(node.spec.value)
		case "built":
			return specText(leafSpec(node.expr))
		case "native":
		case "proved":
		case "domainCast":
		case "matches":
		case "extension":
			return "x"
	}
}

/**
 * A node's computation as its emission states it: its spec's kind, what names it, and its arguments, a built
 * expression's its own over its arguments' nodes; none for an extension's, whose node another package builds.
 */
const shapeOf = (node: TypedNode): TypedSpec | UnprovedSpec | DomainCastSpec | undefined => {
	switch (node.kind) {
		case "built":
			return leafSpec(node.expr)
		case "extension":
			return undefined
		case "stated":
		case "literal":
		case "native":
		case "proved":
		case "domainCast":
		case "matches":
			return node.spec
	}
}

/**
 * Whether two nodes compute the same value the same way, which is whether their emissions do: one kind, one source,
 * one overload, one literal and the same arguments, each in turn, a domain cast and a conditional by their arguments
 * alone, a built expression by its own computation. How a guarded node finds the Logic.when whose parameter it is,
 * and a byte guard the occurrences of its text (WhenScope). A predicate another package lowers is its own node alone:
 * no guard's subject is a boolean, so none is a subject or an occurrence of one.
 */
export const sameNode = (a: TypedNode, b: TypedNode): boolean => {
	if (a === b || (a.kind === "built" && b.kind === "built" && a.expr === b.expr)) {
		return true
	}
	const x = shapeOf(a)
	const y = shapeOf(b)
	if (x === undefined || y === undefined) {
		return false
	}
	const xs: ReadonlyArray<TypedNode> = x.args
	const ys: ReadonlyArray<TypedNode> = y.args
	if (x.kind !== y.kind || xs.length !== ys.length) {
		return false
	}
	const alike = xs.every((n, i) => {
		const m = ys[i]
		return m !== undefined && sameNode(n, m)
	})
	if (!alike) {
		return false
	}
	switch (x.kind) {
		case "column":
			return (
				y.kind === "column" && x.column.node === y.column.node && x.column.name === y.column.name
			)
		case "param":
			return y.kind === "param" && x.param === y.param
		case "value":
			return y.kind === "value"
		case "literal":
			return y.kind === "literal" && canonicalTextOf(x.value) === canonicalTextOf(y.value)
		case "op":
			return y.kind === "op" && x.op === y.op
		case "cast":
			return y.kind === "cast" && x.cast === y.cast
		case "domainCast":
		case "cond":
			return true
		case "closedAt":
			return y.kind === "closedAt" && x.relation === y.relation && x.field === y.field
		case "closedRow":
			return y.kind === "closedRow" && x.relation === y.relation
		case "closedHas":
			return y.kind === "closedHas" && x.relation === y.relation
		case "call":
			return y.kind === "call" && x.function.definition === y.function.definition
	}
}

/**
 * The refusal of float arithmetic in a check, the one a check always had: its IEEE 754 rendering binds a compound
 * operand in a scalar subquery, which a CHECK cannot hold; and of money arithmetic there, whose exact form reads money
 * through numeric, a STABLE cast, where a CHECK is immutable.
 */
const floatArithmeticText = (fn: string, t: ScalarType): string =>
	`${fn} over ${typeLabel(t)} in a contract predicate or row check: float arithmetic renders through a scalar subquery and money arithmetic through money's STABLE cast to numeric, and a CHECK holds neither`

/**
 * The closed relation `relation` a read `read` applies, or its refusal: UnsupportedOperation where the expression
 * applies none, with the reason, and MalformedDescription for a name that is no closed relation's.
 */
export const closedHeadingOf = (
	closed: ClosedRelations,
	read: "C.at" | "C.row" | "C.has",
	relation: string,
	at: SourceLoc
): ClosedHeading => {
	if (closed.kind === "none") {
		return stop("UnsupportedOperation", at, `${read} here: ${closed.why}`)
	}
	return (
		closed.heading(relation) ??
		stop("MalformedDescription", at, `a closed relation named ${JSON.stringify(relation)}`)
	)
}

/**
 * What each part of the Text.matches pattern `desc` reads (patternParts), each where it stands, the branches of the
 * Logic.cond it stands in below `at`.
 */
const patternReads = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	at: SourceLoc
): ReadonlyArray<PatternRead> =>
	patternParts(desc).map((part) =>
		patternRead(
			part,
			part.branches.reduce((loc, branch) => childLoc(loc, branch), at)
		)
	)

/** What one part of a Text.matches pattern reads, standing at `at`. */
const patternRead = <R extends Refs>(part: PatternPart<R>, at: SourceLoc): PatternRead => {
	switch (part.kind) {
		case "literal": {
			const value = literalPattern(part.desc.value)
			return value === undefined
				? stop(
						"MalformedDescription",
						at,
						"a pattern literal as matches's pattern, its pattern value (Text.pattern): a text literal is no pattern"
					)
				: { kind: "admitted", value }
		}
		case "closedAt":
			return { kind: "closedAt", relation: part.desc.relation, field: part.desc.field, at }
		case "other":
			return { kind: "other", what: part.desc.kind, at }
	}
}

class Typing<R extends Refs> {
	readonly env: TypingEnv<R>
	/** What the Logic.whens whose branch the typing stands in establish there, outermost first. */
	readonly #scope: ReadonlyArray<WhenScope>
	/** The tape every node and check of the term is recorded on, in the order the lowering emits and judges them. */
	readonly #tape: Array<TapeEntry<R>>

	constructor(env: TypingEnv<R>, scope: ReadonlyArray<WhenScope>, tape: Array<TapeEntry<R>>) {
		this.env = env
		this.#scope = scope
		this.#tape = tape
	}

	/** `node`, recorded on the tape: the lowering judges and emits it here, after every node recorded before it. */
	record<N extends RecordedNode>(node: N): N {
		this.#tape.push({ kind: "node", node })
		return node
	}

	/** The refusal at `site` of what the term holds there (UnsupportedOperation), recorded where the lowering refuses it. */
	refusedAt(site: LowerSite, at: SourceLoc, capability: string): void {
		this.#tape.push({ kind: "refused", site, at, capability })
	}

	/**
	 * The bounds of a numeric operand, which settle gives every value of a carrier with a numeric domain, its type's where
	 * nothing more is proved; a value of any other carrier is no number here.
	 */
	boundsOf(x: Typed, at: SourceLoc): Bounds {
		return x.bounds ?? stop("MalformedDescription", at, `a number, not ${typeLabel(x.nominal)}`)
	}

	/**
	 * A conditional's branch opposite the term `t`: a term that meets it, or a bare literal of t's own type. Opposite an
	 * exact value the literal is its family's plain carrier's (adoptedType), converted into t's exact type where its
	 * value lies within t's digits and refused where it does not, so the conditional is of t's type as its builder typed
	 * it, never wider.
	 */
	branchOperand(desc: ExprDesc<Located, R>, t: Typed, at: SourceLoc): Typed {
		const x = this.operand(desc, t, "compare", at)
		const digits = exactDigitsOf(t.nominal)
		if (!isBareLiteral(desc) || digits === undefined) {
			return x
		}
		if (this.boundsOf(x, at).digits > digits) {
			return stop(
				"MalformedDescription",
				at,
				`a literal beside an exact value of ${digits} digits: a value within them, as the exact value's type holds`
			)
		}
		return this.convert(x, t.nominal, at)
	}

	/**
	 * Refuses `other` beside `first` where the two are an exact value and a plain value of its family (mixesExact), at
	 * `other`, the operand whose type differs from the first's: the remedy is a cast of the exact one into the plain
	 * one's type, since no type of a field is exact. A bare literal adopts its term's type and is never `other`.
	 */
	exactBeside(first: Typed, other: Typed, at: SourceLoc): void {
		if (mixesExact(first.nominal, other.nominal)) {
			stop(
				"MalformedDescription",
				at,
				"operands of one type: an exact value beside a plain value of its family; Type.cast the exact one into the plain one's type"
			)
		}
	}

	/** The type a bare literal adopts opposite a term of type t (adoptedType). */
	adopt(t: ScalarType, role: Role): ScalarType {
		return adoptedType(t, role)
	}

	/** A bare literal compared with a term of type `t`: refused where t does not hold it as written (oppositeLiteralProblem). */
	asWritten(value: LiteralDesc, t: ScalarType, at: SourceLoc): void {
		const problem = oppositeLiteralProblem(value, t)
		if (problem !== undefined) {
			stop("MalformedDescription", at, `a literal compared with ${typeLabel(t)}: ${problem}`)
		}
	}

	/**
	 * A typed node with what is proved of it: the bounds and facts its type gives every value unless the caller states
	 * what its computation proves, beside which it keeps its SQL type's own facts (carrierFacts), then refined, outermost
	 * first, by what each enclosing Logic.when establishes of it (WhenScope): the guard whose parameter it is, among
	 * `held`, and the byte guard of a text it is an occurrence of (sameNode), a match retyping it as text of its
	 * pattern's language. Bounds a computation does not prove are its type's own, so every value of a carrier with a
	 * numeric domain stands with bounds, and a guard narrows it whatever its operands proved; only a carrier with none
	 * (boundsOfType) stands without. A numeric bound past numeric's numericMaxIntegerDigits is ResourceBound wherever
	 * the term is compiled, which the tape records here: a builder types its term and refuses only what is malformed.
	 */
	settle(
		entry: TypedNode,
		stated: ScalarType,
		actual: ScalarType,
		proved: { readonly bounds: Bounds | undefined; readonly facts: FactSet } | undefined,
		held: ReadonlyArray<WhenParameter>
	): Typed {
		let nominal = stated
		let bounds = proved?.bounds ?? boundsOfType(nominal)
		let facts: FactSet =
			proved === undefined
				? factsOfType(nominal)
				: Object.freeze({ ...carrierFacts(nominal), ...proved.facts })
		for (const scope of this.#scope) {
			const holds =
				scope.kind === "parameter" ? held.includes(scope) : sameNode(scope.holds.subject, entry)
			if (!holds) {
				continue
			}
			const g = scope.holds
			if (g.kind === "language") {
				nominal = g.type
				continue
			}
			bounds = bounds === undefined ? undefined : refine(bounds, g.refinement)
			const added: { [F in Fact]?: FactSet[F] } = { ...facts }
			for (const f of g.facts) {
				added[f] = { kind: "guard" }
			}
			facts = Object.freeze(added)
		}
		if (bounds !== undefined && bounds.digits > numericMaxIntegerDigits) {
			this.#tape.push({ kind: "digits", at: this.env.loc, needed: bounds.digits })
		}
		return new Typed(entry, nominal, actual, bounds, facts, held)
	}

	/**
	 * `term` at the type `stated` and the SQL type `actual`, with its bounds and `facts`, settled again, so the guards
	 * it stands under narrow the type the operation states: how an operation states the type of the term it makes or
	 * passes on, a collapse's or a translation's language, a cast's target or a value's base, never by writing it after
	 * settle. A parameter restated is the parameter still (held).
	 */
	restate(term: Typed, stated: ScalarType, actual: ScalarType, facts: FactSet): Typed {
		return this.settle(term.node, stated, actual, { bounds: term.bounds, facts }, term.held)
	}

	/** The node of `spec`, recorded: of its own type nominally and actually, its bounds and facts its type's. */
	emit(spec: TypedSpec): Typed {
		const node = this.record({ kind: "stated", spec })
		return this.settle(node, spec.type, spec.type, undefined, [])
	}

	/**
	 * `node`, recorded, at the type its spec states, with what its computation proved: a node whose type is its purpose,
	 * a coercion at its target, and a conditional, LEAST and GREATEST at their operands' common type, since each is one
	 * of its operands; the proved bounds lie within that type.
	 */
	emitAt(node: RecordedNode, type: ScalarType, bounds: Bounds | undefined, facts: FactSet): Typed {
		return this.settle(this.record(node), type, type, { bounds, facts }, [])
	}

	/**
	 * A node of the registry's `op` over `args`, of `type`: an overload defined everywhere names its DefinedOp, an IEEE
	 * 754 one with the proof that PostgreSQL's own overload computes it there where its operands' premises give one
	 * (nativeNode) and its exact result's bounds as IEEE 754 rounds them (native.ts resultBounds), and a partial one
	 * stands only with the proof of every precondition its Totality requires, which the lowering judges.
	 */
	native(
		op: NativeOp,
		args: ReadonlyArray<Typed>,
		type: ScalarType,
		bounds: Bounds | undefined,
		at: SourceLoc,
		operation: string
	): Typed {
		return this.nativeJudged(op, args, args, type, bounds, at, operation)
	}

	/**
	 * A node of `op` over the operands it reads, `args`, its preconditions judged over the caller's terms they stand for,
	 * `judged`, position by position: an exact widening the typing puts between a term and the node keeps every fact
	 * of the term, so the proof is the term's, and a refusal names the term and the remedy its own type has. A computed
	 * numeric's type carries exactly the bounds proved of it (provedType), at numeric's own limit where an operand is
	 * bounded by nothing but that limit (bounds.ts ownLimited).
	 */
	nativeJudged(
		op: NativeOp,
		args: ReadonlyArray<Typed>,
		judged: ReadonlyArray<Typed>,
		type: ScalarType,
		bounds: Bounds | undefined,
		at: SourceLoc,
		operation: string
	): Typed {
		const made =
			bounds === undefined
				? undefined
				: ownLimited(
						bounds,
						args.map((a) => a.bounds)
					)
		if (!op.partial) {
			const rounded = resultBounds(op, type, made)
			const stated = madeType(type, rounded)
			return this.emitAt(this.totalNode(op, args, stated, type), stated, rounded, noFacts)
		}
		const node: RecordedNode = {
			kind: "proved",
			spec: {
				kind: "op",
				op: op.id,
				args: args.map((a) => a.node),
				type: madeType(type, made),
				nonNull: "strict",
				volatility: op.volatility
			},
			proof: {
				kind: "judged",
				preconditions: op.totality.preconditions,
				operands: judged,
				target: type,
				at,
				operation
			}
		}
		return this.emitAt(node, node.spec.type, made, noFacts)
	}

	/**
	 * The node of an overload defined everywhere over `args`, of `type`: its DefinedOp, with the proof that PostgreSQL's
	 * own overload computes it where it stands if it is IEEE 754 into a float (`carried`, the type it computes into),
	 * which the lowering proves from its operands (native.ts nativeProof).
	 */
	totalNode(
		op: Extract<NativeOp, { readonly partial: false }>,
		args: ReadonlyArray<Typed>,
		type: ScalarType,
		carried: ScalarType
	): RecordedNode {
		const spec: NativeSpec = {
			kind: "op",
			op: op.id,
			args: args.map((a) => a.node),
			type,
			nonNull: "strict",
			volatility: op.volatility
		}
		return nativeNode(op, spec, args, carried)
	}

	/**
	 * A cast node from `arg`'s actual type to `to`, converting as `how` states: a registered cast defined everywhere, a
	 * partial one with the proof of its preconditions, or the binary coercion. The coercion drops a refinement or widens
	 * a bound and never adds one, so its node is of `to`'s entered type (ir/scalar.ts enteredType), the text of every
	 * value where `to` is a pattern's, and the value stands at `to`, which a language only compilation proves (a guard's,
	 * a translation's image, a concatenation's bound) may be: no coercion names a text domain, and only a domain cast,
	 * into a type its caller declared, does. In a check a conversion into a float, an IEEE 754 rounding, is refused with
	 * float arithmetic.
	 */
	castNode(arg: Typed, to: ScalarType, how: CastHow, at: SourceLoc): Typed {
		const conversion = conversionOf(arg.actual, to, how)
		const bounds = arg.bounds === undefined ? undefined : castBounds(arg.bounds, conversion, to)
		const facts = keptFacts(arg, conversion, to)
		if (how.kind === "coercion") {
			const entered = enteredType(to)
			const node = this.record({
				kind: "stated",
				spec: {
					kind: "cast",
					cast: binaryCoercion,
					args: [arg.node],
					type: entered,
					nonNull: "strict",
					volatility: "immutable"
				}
			})
			return this.settle(node, to, entered, { bounds, facts }, [])
		}
		const { op } = how
		if (!op.partial) {
			if (op.totality.kind === "ieee") {
				this.refusedAt("check", at, floatArithmeticText("cast", to))
			}
			const type = provedType(to, bounds)
			return this.emitAt(
				nativeNode(
					op,
					{
						kind: "cast",
						cast: op.id,
						args: [arg.node],
						type,
						nonNull: "strict",
						volatility: op.volatility
					},
					[arg],
					to
				),
				type,
				bounds,
				facts
			)
		}
		const type = provedType(to, bounds)
		const preconditions = op.totality.preconditions
		const node: RecordedNode = {
			kind: "proved",
			spec: {
				kind: "cast",
				cast: op.id,
				args: [arg.node],
				type,
				nonNull: "strict",
				volatility: op.volatility
			},
			proof:
				how.kind === "computed"
					? { kind: "computed", preconditions, operand: arg, target: to }
					: {
							kind: "judged",
							preconditions,
							operands: [arg],
							target: to,
							at,
							operation: `Type.cast(${nodeText(arg.node)}, ${typeLabel(to)})`
						}
		}
		return this.emitAt(node, type, bounds, facts)
	}

	/**
	 * A coercion into `to`'s contract or regex refinement, which PostgreSQL validates: the lowering admits it with the
	 * proof that the value satisfies it, a literal judged before any SQL (ContractLiteral), a parameter PostgreSQL checks
	 * as it binds it (lower/conservative/context.ts paramTypeRef), or a value whose bounds satisfy each contract level's
	 * predicate; else PartialOperation. `checked` is how the value's own refinement is checked before any SQL.
	 */
	domainCast(
		value: Typed,
		to: ScalarType,
		checked: "literal" | "parameter" | undefined,
		at: SourceLoc
	): Typed {
		const type = provedType(to, value.bounds)
		return this.emitAt(
			{
				kind: "domainCast",
				spec: { kind: "domainCast", args: [value.node], type, nonNull: "strict" },
				value,
				target: to,
				checked,
				at
			},
			type,
			value.bounds,
			{ ...value.facts, ...factsOfType(to) }
		)
	}

	/**
	 * A literal node: of `type`, a computed numeric's bounded by the literal's own value, which is all it can be, with
	 * the bounds and facts of that value; judged, where `judged` states it, against the refinements of the type it adopts.
	 */
	literalNode(
		literal: TypedLiteral,
		type: ScalarType,
		judged: { readonly refinements: ScalarType; readonly at: SourceLoc } | undefined
	): Typed {
		const date = dateExact(literal)
		const n = date ?? literalNumber(literal)
		const point = n === undefined ? undefined : typeof n === "object" ? ofPoint(n) : ofSpecial(n)
		const at = isComputedNumeric(type) ? numericOf(point) : type
		const spec: LiteralSpec = {
			kind: "literal",
			value: literal,
			args: [],
			type: at,
			nonNull: "literal"
		}
		const entry = this.record<RecordedNode>(
			judged === undefined
				? { kind: "stated", spec }
				: { kind: "literal", spec, refinements: judged.refinements, at: judged.at }
		)
		if (n === undefined || point === undefined || boundsOfType(at) === undefined) {
			return this.settle(entry, at, at, undefined, [])
		}
		return this.settle(
			entry,
			at,
			at,
			{
				bounds: point,
				facts:
					date === undefined
						? Object.freeze({ ...factsOfType(at), ...factsOfValue(n) })
						: factsOfType(at)
			},
			[]
		)
	}

	/**
	 * A literal adopting `type`, admitted as every typed slot admits one (evaluate.ts admitLiteral): the base here, then,
	 * where the term is compiled, the contract and the regex refinement, which the lowering judges.
	 */
	literal(value: LiteralDesc, type: ScalarType, at: SourceLoc): Typed {
		if (isInstantType(type)) {
			return stop("MalformedDescription", at, instantInputText("literal"))
		}
		const admitted = admitLiteral(value, type, { kind: "shape" }, "stored")
		if (!admitted.ok) {
			return stop(admitted.error.reason, at, admitted.error.capability)
		}
		return this.literalNode(admitted.value, type, { refinements: type, at })
	}

	/**
	 * A parameter, of its declared type: a term like any other. Its placeholder is typed by its
	 * refinement's domain where its declared type is a contract or a pattern (lower/conservative/context.ts
	 * paramTypeRef), which PostgreSQL checks the value against as it binds it, so the parameter has its type's bounds and
	 * facts, a contract's declared ones among them.
	 */
	param(param: ParamRef<R>, at: SourceLoc): Typed {
		const params = this.env.params
		if (params.kind === "none") {
			throw new Refusal(ruleRefused(at, "a schema predicate reads no parameter"))
		}
		const { spec, type, reading } = unwrap(params.lower(param, at))
		const node = this.record({ kind: "stated", spec: leafSpec(spec) })
		return this.settle(node, type, spec.type, readingProof(type, reading), [])
	}

	/**
	 * A term read whole, as a head reads it or a field is written from it: a bare reference of any type, bytes among them,
	 * or any other term (term), whose operands an operation reads.
	 */
	whole(desc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		return isReference(desc)
			? this.emit(leafSpec(unwrap(this.env.leaf(desc, at))))
			: this.term(desc, at)
	}

	/**
	 * A reference an operation reads: refused where its type is stored only (scalar/registry.ts storedOnly), as bytes is,
	 * so no comparison, computation, cast, conditional or guard reads one; Crypto.sha256 reads its operand whole
	 * (sha256).
	 */
	reference(desc: LeafDesc<R>, at: SourceLoc): Typed {
		const leaf = this.emit(leafSpec(unwrap(this.env.leaf(desc, at))))
		return storedOnly(leaf.nominal)
			? stop(
					"UnsupportedOperation",
					at,
					`storage: ${typeLabel(leaf.nominal)} is stored only, read whole as a head or a written value, so no scalar operation, rule, selection or filter reads it`
				)
			: leaf
	}

	/** A term: anything but an untyped literal, which takes the type of the term it meets. */
	term(desc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		if (desc.kind === "literal" && desc.type === undefined) {
			return stop(
				"MalformedDescription",
				at,
				"a term here: a literal takes the type of the term it meets and never stands first"
			)
		}
		return this.lower(desc, at)
	}

	/**
	 * An operand opposite `against`: a bare literal adopts its type, anything else, a parameter among them, is a term that
	 * meets it (types.ts meets). Opposite an exact value a bare literal adopts its family's plain carrier (bigint, money),
	 * which the operation widens exactly (exactPair). A bare literal compared with a term is a value of the term's type as
	 * written, refused where it has more digits than a numeric(p, s) term holds (literal.ts oppositeLiteralProblem), as a
	 * match's binding and a side's selector are: the comparison reads it exactly, never rounded. A bare literal beside a
	 * contract's term in arithmetic is a value opposite that term, so it is a value of its type, as README reads a value
	 * opposite a term: the contract judges it where the term is compiled (ContractLiteral, the tape's admission), and the
	 * operation reads it at the base it computes over.
	 */
	operand(desc: ExprDesc<Located, R>, against: Typed, role: Role, at: SourceLoc): Typed {
		if (desc.kind === "literal" && desc.type === undefined) {
			if (role === "compare") {
				this.asWritten(desc.value, against.nominal, at)
			}
			const literal = this.literal(desc.value, this.adopt(against.nominal, role), at)
			if (role === "arithmetic" && against.nominal.contract !== undefined) {
				this.#tape.push({ kind: "admits", value: desc.value, type: against.nominal, at })
			}
			return literal
		}
		const term = this.lower(desc, at)
		if (!meets(against.nominal, term.nominal)) {
			return stop(
				"MalformedDescription",
				at,
				`operands of one type: ${typeLabel(against.nominal)} never meets ${typeLabel(term.nominal)} without Type.base`
			)
		}
		return term
	}

	/**
	 * A retype (ir/desc.ts RetypeDesc): its argument restated at `to`, a type of the argument's own base carrier, with
	 * `to`'s facts, proved by the equality of its scope that navigation substituted it under (`refined`): the value is
	 * the argument's, so it lies in `to`'s contract as in the argument's. No node and no check: it prints as its
	 * argument. A retype across two carriers is no equality's, and is refused.
	 */
	retype(desc: Extract<ExprDesc<Located, R>, { readonly kind: "retype" }>, at: SourceLoc): Typed {
		const arg = this.term(desc.arg, childLoc(at, "retype"))
		const to = unwrap(this.env.fieldType(desc.to, childLoc(at, "retype", "to")))
		if (!sameCarrier(arg.nominal, to)) {
			return stop(
				"MalformedDescription",
				at,
				`a retype within one base carrier: ${typeLabel(arg.nominal)} is of another than ${typeLabel(to)}`
			)
		}
		return this.restate(arg, to, arg.actual, Object.freeze({ ...arg.facts, ...factsOfType(to) }))
	}

	/**
	 * An equality's operand opposite `against`: what any comparison's operand is (`operand`), or a term of its base
	 * carrier of another type (`refinedPair`), which the equality types at the carrier.
	 */
	equated(desc: ExprDesc<Located, R>, against: Typed, at: SourceLoc): Typed {
		if (desc.kind === "literal" && desc.type === undefined) {
			return this.operand(desc, against, "compare", at)
		}
		const term = this.lower(desc, at)
		if (!meets(against.nominal, term.nominal) && !refinedPair(against, term)) {
			return stop(
				"MalformedDescription",
				at,
				`operands of one type: ${typeLabel(against.nominal)} never meets ${typeLabel(term.nominal)} without Type.base`
			)
		}
		return term
	}

	/** A term at its base carrier, as Type.base restates it: its node and its bounds its own. */
	atCarrier(term: Typed): Typed {
		return this.restate(term, valueType(term.nominal), term.actual, term.facts)
	}

	/** Two operands that meet, each at the type it meets the other at (types.ts meetingType). */
	exactPair(a: Typed, b: Typed, at: SourceLoc): readonly [Typed, Typed] {
		return [
			this.widenTo(a, meetingType(a.nominal, b.nominal), at),
			this.widenTo(b, meetingType(b.nominal, a.nominal), at)
		]
	}

	/** A plain integer or money value widened into its exact family, at its own bound (types.ts meetingType). */
	widenExact(x: Typed, family: "exactInteger" | "exactMoney", at: SourceLoc): Typed {
		return this.widenTo(x, meetingType(x.nominal, exactType(family, 0)), at)
	}

	/** A value widened into `to` by the one widening (types.ts wideningOf): itself where `to` is its own type. */
	widenTo(x: Typed, to: ScalarType, at: SourceLoc): Typed {
		if (to === x.nominal) {
			return x
		}
		const how = wideningOf(x.nominal, to)
		if (how === undefined) {
			return stop(
				"UnsupportedOperation",
				at,
				`no widening of ${typeLabel(x.nominal)} into ${typeLabel(to)}`
			)
		}
		return this.castNode(x, to, how, at)
	}

	overload(
		fn: Exclude<FixedFn, "cast">,
		carriers: ReadonlyArray<ScalarType>,
		at: SourceLoc
	): FixedOp {
		const op = overloadOf(
			fn,
			carriers.map((t) => baseOf(t).carrier)
		)
		if (op === undefined) {
			return stop(
				"UnsupportedOperation",
				at,
				`${fn}: PostgreSQL has no ${fn} over ${carriers.map(typeLabel).join(", ")} that grizzle admits`
			)
		}
		return op
	}

	/** The overload of `fn` typed by its operands' common type, over operands of `type`. */
	commonOp(fn: CommonTypeFn, type: ScalarType, at: SourceLoc): CommonTypeOp {
		const op = commonTypeOf(fn, baseOf(type).carrier)
		if (op === undefined) {
			return stop(
				"UnsupportedOperation",
				at,
				`${fn}: PostgreSQL has no ${fn} over ${typeLabel(type)} that grizzle admits`
			)
		}
		return op
	}

	/**
	 * The result type of a fixed-result operation: an exact overload's exact type, or an exact carrier's own, bounded by
	 * its result's digits, which numeric operands always prove (settle); a numeric result a computed numeric of its
	 * result's bounds; a text result text of no pattern, which every text meets; any other overload's registered result.
	 */
	resultType(op: FixedOp, bounds: Bounds | undefined): ScalarType {
		const digits = (): number =>
			(
				bounds ??
				stop(
					"MalformedDescription",
					this.env.loc,
					`numeric operands of ${op.fn}, whose exact result has the digits they bound`
				)
			).digits
		if (op.totality.kind === "exact") {
			return exactType(op.totality.yields === "integer" ? "exactInteger" : "exactMoney", digits())
		}
		const r = op.result
		return r === "exactInteger" || r === "exactMoney"
			? exactType(r, digits())
			: r === "numeric"
				? numericOf(bounds)
				: r === "text"
					? wildcardText
					: r === "tsvector"
						? stop(
								"MalformedDescription",
								this.env.loc,
								`${op.fn}'s search document, whose type is the configuration it is parsed under, which its typing states`
							)
						: plainType(r)
	}

	lower(desc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		switch (desc.kind) {
			case "var":
			case "field":
			case "value":
			case "parent":
				return this.reference(desc, at)
			case "param":
				return this.param(desc, at)
			case "literal": {
				if (desc.type !== undefined) {
					const t = unwrap(this.env.fieldType(desc.type, at))
					return this.literal(desc.value, t, at)
				}
				return this.bareLiteral(desc.value, at)
			}
			case "compute":
				return this.compute(desc, at)
			case "cast":
				return this.cast(desc, at)
			case "base": {
				const arg = this.term(desc.arg, childLoc(at, "base"))
				return this.restate(arg, valueType(arg.nominal), arg.actual, arg.facts)
			}
			case "retype":
				return this.retype(desc, at)
			case "guarded":
				return this.guarded(desc, at)
			case "cond":
				return this.cond(desc, at)
			case "when":
				return this.when(desc, at)
			case "compare": {
				const equation = this.concatEquation(desc, at)
				if (equation !== undefined) {
					return equation
				}
				const left = this.term(desc.left, childLoc(at, desc.op, "left"))
				const right =
					desc.op === "eq"
						? this.equated(desc.right, left, childLoc(at, desc.op, "right"))
						: this.operand(desc.right, left, "compare", childLoc(at, desc.op, "right"))
				return this.comparison(
					desc.op,
					refinedPair(left, right) ? [this.atCarrier(left), this.atCarrier(right)] : [left, right],
					at
				)
			}
			case "between": {
				const arg = this.term(desc.arg, childLoc(at, "between"))
				const low = this.operand(desc.low, arg, "compare", childLoc(at, "between", "low"))
				const high = this.operand(desc.high, arg, "compare", childLoc(at, "between", "high"))
				return this.comparison("between", [arg, low, high], at)
			}
			case "in": {
				const arg = this.term(desc.arg, childLoc(at, "in"))
				const type = this.adopt(arg.nominal, "compare")
				const values = desc.values.map((v, i) => {
					this.asWritten(v, arg.nominal, childLoc(at, "in", i))
					return this.literal(v, type, childLoc(at, "in", i))
				})
				return this.comparison("in", [arg, ...values], at)
			}
			case "and":
			case "or": {
				const args = desc.args.map((a, i) => this.predicate(a, childLoc(at, desc.kind, i)))
				const op = this.overload(desc.kind, [plainType("bool")], at)
				return this.native(op, args, plainType("bool"), undefined, at, desc.kind)
			}
			case "not": {
				const arg = this.predicate(desc.arg, childLoc(at, "not"))
				const op = this.overload("not", [plainType("bool")], at)
				return this.native(op, [arg], plainType("bool"), undefined, at, "not")
			}
			case "closedAt":
				return this.closedAt(desc, at)
			case "closedRow":
				return this.closedRow(desc, at)
			case "closedHas":
				return this.closedHas(desc, at)
			case "call":
				return this.call(desc, at)
			case "allen":
			case "pointIn":
			case "absent":
			case "exists":
				return this.extension(desc, at)
		}
	}

	/**
	 * A predicate another package lowers, r.allen, r.pointIn, r.not or an existence: a boolean, whose children that
	 * package types and lowers where the lowering reaches it, under the Logic.whens it stands in (the tape's extension
	 * entry). Only a query lowers one; a check refuses it there.
	 */
	extension(desc: ExtensionDesc<R>, at: SourceLoc): Typed {
		const bool = plainType("bool")
		const node: ExtensionNode = { kind: "extension", type: bool }
		this.#tape.push({ kind: "extension", node, desc, at, scope: this.#scope })
		return new Typed(node, bool, bool, boundsOfType(bool), factsOfType(bool), [])
	}

	/**
	 * Two texts for a text operation: a text term, then a text term or a bare literal, which adopts text of no pattern.
	 * Texts of any two patterns meet, as PostgreSQL compares them.
	 */
	texts(
		fn: string,
		first: ExprDesc<Located, R>,
		second: ExprDesc<Located, R>,
		at: SourceLoc
	): readonly [Typed, Typed] {
		const a = this.term(first, childLoc(at, 0))
		return [a, this.textOperand(fn, a, second, at)]
	}

	/** The first operand of a text operation, `a`, refused where it is no text term. */
	textSubject(fn: string, a: Typed, at: SourceLoc): void {
		if (baseOf(a.actual).carrier !== "text") {
			stop("MalformedDescription", at, `a text term for ${fn}, not ${typeLabel(a.nominal)}`)
		}
	}

	/** An operand of a text operation, `b`, refused where it is no text. */
	textValue(fn: string, b: Typed, at: SourceLoc): Typed {
		if (baseOf(b.actual).carrier !== "text") {
			return stop(
				"MalformedDescription",
				at,
				`a text operand for ${fn}, not ${typeLabel(b.nominal)}`
			)
		}
		return b
	}

	/** The second operand of a text operation over the text term `a`: a text term, or a bare literal of text. */
	textOperand(fn: string, a: Typed, second: ExprDesc<Located, R>, at: SourceLoc): Typed {
		this.textSubject(fn, a, at)
		return this.textValue(fn, this.operand(second, a, "operand", childLoc(at, 1)), at)
	}

	/**
	 * Text.concat(a, b), PostgreSQL's textcat: the node computes text, and the term is text of no pattern within the
	 * sum of its operands' bytes where both are bounded, a text literal by its own and a term by its type's byte bound,
	 * since a || b takes a's bytes and b's; any text where either is unbounded, or where the text goes unanalyzed.
	 */
	concat(first: ExprDesc<Located, R>, second: ExprDesc<Located, R>, at: SourceLoc): Typed {
		const [a, b] = this.texts("concat", first, second, at)
		const op = this.overload("concat", [a.actual, b.actual], at)
		const node = this.native(op, [a, b], wildcardText, undefined, at, spelling.concat)
		const aBytes = textBytes(a)
		const bBytes = textBytes(b)
		const analysis = this.env.analysis
		return analysis.kind === "unanalyzed" || aBytes === undefined || bBytes === undefined
			? node
			: this.restate(
					node,
					this.textWithin([wildcardPattern], aBytes + bBytes, analysis.patterns.language, at),
					node.actual,
					node.facts
				)
	}

	/**
	 * Text.resolveReference(base, reference), the target of `reference` resolved against `base` as RFC 3986 §5.2
	 * defines it (registry.ts textResolveReference): the node computes text, and the term is text of no pattern within
	 * the sum of its operands' bytes and one more where both are bounded, since the target takes its components from
	 * the reference and the base, each at most once, its path the base's merged with the reference's, which adds a `/`
	 * where the base has an authority and an empty path, and removing dot segments never lengthens a path; any text
	 * where either is unbounded, or where the text goes unanalyzed. Its SQL builds the target by concatenation, which
	 * PostgreSQL refuses past 1 GB, so a query holds it only over operands whose types bound that sum within the most
	 * bytes one varlena holds (values/fault.ts bytesMaxLength), and a check or generated field over longer texts fails
	 * its write, as a concatenation does.
	 */
	resolveReference(
		baseDesc: ExprDesc<Located, R>,
		referenceDesc: ExprDesc<Located, R>,
		at: SourceLoc
	): Typed {
		const [base, reference] = this.texts("resolveReference", baseDesc, referenceDesc, at)
		const op = this.overload("resolveReference", [base.actual, reference.actual], at)
		const node = this.native(
			op,
			[base, reference],
			wildcardText,
			undefined,
			at,
			spelling.resolveReference
		)
		const baseBytes = textBytes(base)
		const referenceBytes = textBytes(reference)
		const bytes =
			baseBytes === undefined || referenceBytes === undefined
				? undefined
				: baseBytes + referenceBytes + mergedSlashBytes
		if (bytes === undefined || bytes > bytesMaxLength) {
			this.refusedAt(
				"query",
				at,
				`resolveReference in a query over texts whose patterns bound the target within ${bytesMaxLength} bytes: its target is built by concatenation, which PostgreSQL refuses past 1 GB, and a read never fails on a value; ${bytes === undefined ? "an operand's pattern bounds no length" : `the operands' patterns bound it at ${bytes} bytes`}, so bound them, or resolve in a contract predicate, row check or generated field`
			)
		}
		const analysis = this.env.analysis
		return analysis.kind === "unanalyzed" || bytes === undefined
			? node
			: this.restate(
					node,
					this.textWithin([wildcardPattern], bytes, analysis.patterns.language, at),
					node.actual,
					node.facts
				)
	}

	/**
	 * An equation of a text with a concatenation, `t = p1 || … || pn` or its negation, its parts read through every nested
	 * concatenation (concatParts), so n is at least two: `octet_length(t) = Σ octet_length(pi) AND t = CASE WHEN
	 * Σ octet_length(pi) > bytesMaxLength THEN '' ELSE p1 || … || pn END`, an equality of t with the parts built in order,
	 * so a probe that knows the parts reads t by its key, never every t of the rows its other columns find.
	 *
	 * It is total: the concatenation is built only where its bytes, Σ octet_length(pi) summed exactly (exact integers,
	 * bigint), are within the most bytes one varlena holds (values/fault.ts bytesMaxLength), so textcat never allocates
	 * past MaxAllocSize, at any site: a fold's combine over concat (ir/monoid.ts) is such an equation, and so stands in a
	 * law's violation query and its CHECK, and a query decides an equation over any number of parts. Past it the CASE
	 * gives the empty text, which decides nothing: t is a value PostgreSQL holds, of at most bytesMaxLength bytes, so its
	 * length is not the parts' and the first conjunct is false there.
	 *
	 * It is three-valued exactly as `t = p1 || … || pn` is: every octet_length is NULL where its operand is, so the sum is
	 * NULL where any part is, the CASE takes its ELSE there, the concatenation, NULL as textcat is at a NULL operand, and
	 * both conjuncts are NULL; where every operand is a text, the conjuncts are false together past the bound, and within
	 * it the second is the equation itself, which the first, the lengths' agreement, only restates. Lengths are bytes, as
	 * texteq and textcat read them, so a part of multibyte characters, or an empty one, lies where it does. Undefined for
	 * any other comparison.
	 */
	concatEquation(
		desc: Extract<ExprDesc<Located, R>, { readonly kind: "compare" }>,
		at: SourceLoc
	): Typed | undefined {
		if (desc.op !== "eq" && desc.op !== "ne") {
			return undefined
		}
		const sides =
			desc.right.kind === "compute" && desc.right.fn === "concat"
				? { whole: desc.left, cat: desc.right }
				: desc.left.kind === "compute" && desc.left.fn === "concat"
					? { whole: desc.right, cat: desc.left }
					: undefined
		if (sides === undefined) {
			return undefined
		}
		const { whole, cat } = sides
		const here = childLoc(at, desc.op, "concat")
		const [first, ...before] = concatParts(argOf(cat, 0, here), childLoc(here, 0), here, "first")
		const after = concatParts(argOf(cat, 1, here), childLoc(here, 1), here, "second")
		const p = this.firstPart(first)
		const rest = mapNonEmpty(concatNonEmpty(before, after), (part) => this.concatPart(part, p))
		const t =
			whole.kind === "literal" && whole.type === undefined
				? this.literal(whole.value, wildcardText, here)
				: this.textOperand("an equation with a concatenation", p, whole, here)
		const bytesOf = (x: Typed): Typed =>
			this.native(
				this.overload("octetLength", [x.actual], here),
				[x],
				plainType("int4"),
				ofRange(0n, BigInt(bytesMaxLength), String(bytesMaxLength).length),
				here,
				"octet_length"
			)
		const [lp, ...lengths] = mapNonEmpty([p, ...rest], bytesOf)
		const bytes = lengths.reduce((sum, l) => {
			const [x, y] = this.exactPair(sum, l, here)
			const add = this.overload("add", [valueType(x.nominal), valueType(y.nominal)], here)
			const bounds = arithmeticBounds("add", x.bounds, y.bounds)
			return this.native(add, [x, y], this.resultType(add, bounds), bounds, here, "length")
		}, lp)
		const built = rest.reduce(
			(a, b) =>
				this.native(
					this.overload("concat", [a.actual, b.actual], here),
					[a, b],
					wildcardText,
					undefined,
					here,
					"concat"
				),
			p
		)
		const past = this.comparison(
			"gt",
			[bytes, this.literal(bytesMaxLength, plainType("int4"), here)],
			here
		)
		const guarded = this.conditional(past, this.literal("", wildcardText, here), built, here)
		const bool = plainType("bool")
		const holds = this.native(
			this.overload("and", [bool], here),
			[this.comparison("eq", [bytesOf(t), bytes], here), this.comparison("eq", [t, guarded], here)],
			bool,
			undefined,
			here,
			"and"
		)
		return desc.op === "eq"
			? holds
			: this.native(this.overload("not", [bool], here), [holds], bool, undefined, here, "not")
	}

	/** A part standing first in its concatenation: a text term, as every operation's first operand is. */
	firstPart(part: ConcatPart<R>): Typed {
		const a = this.term(part.desc, part.at)
		return baseOf(a.actual).carrier === "text"
			? a
			: stop(
					"MalformedDescription",
					part.concat,
					`a text term for concat, not ${typeLabel(a.nominal)}`
				)
	}

	/**
	 * A part of a concatenation's equation after its first, `first`, typed by its place (ConcatPart): first in its own
	 * concatenation a text term, second a text term or a bare literal, which adopts text of no pattern opposite `first`,
	 * as every text meets every other.
	 */
	concatPart(part: ConcatPart<R>, first: Typed): Typed {
		if (part.stands === "first") {
			return this.firstPart(part)
		}
		const b = this.operand(part.desc, first, "operand", part.at)
		return baseOf(b.actual).carrier === "text"
			? b
			: stop(
					"MalformedDescription",
					part.concat,
					`a text operand for concat, not ${typeLabel(b.nominal)}`
				)
	}

	/**
	 * Text.matches(subject, pattern), PostgreSQL's textregexeq: whether the subject holds a match of the pattern,
	 * which is a text term or a literal read under the flags "u", in grizzle's pattern grammar. The node reads what each
	 * part of the pattern can be (patternReads), whose every value the lowering admits as a str.regex pattern is, its
	 * grammar and PostgreSQL's regex compile space (scalar/regex/admit.ts admitMatch), and carries each one's source,
	 * whose ARE the SQL lowering spells for `~` in its place (PatternTable).
	 */
	matches(
		subjectDesc: ExprDesc<Located, R>,
		patternDesc: ExprDesc<Located, R>,
		at: SourceLoc
	): Typed {
		return this.matchesOver(this.term(subjectDesc, childLoc(at, 0)), patternDesc, at)
	}

	/**
	 * The pattern operand of a Text.matches over the text term `subject`, standing at `here`, as patternParts reads
	 * its parts: a pattern literal, its pattern value (ir/pattern.ts PatternValue), a text of no refinement that only a
	 * match reads; a Logic.cond, its predicate and each branch a pattern operand in turn; any other a text operand, a
	 * closed read among them, whose values patternReads reads. `at` is the match's place, where a refusal of no text is.
	 */
	patternOperand(
		subject: Typed,
		desc: ExprDesc<Located, R>,
		here: SourceLoc,
		at: SourceLoc
	): Typed {
		const value =
			desc.kind === "literal" && desc.type === undefined ? literalPattern(desc.value) : undefined
		if (value !== undefined) {
			return this.literalNode({ kind: "pattern", value }, wildcardText, undefined)
		}
		if (desc.kind !== "cond") {
			return this.textValue("matches", this.operand(desc, subject, "operand", here), at)
		}
		const p = this.predicate(desc.pred, childLoc(here, "cond"))
		const onTrue = this.patternOperand(subject, desc.onTrue, childLoc(here, "cond", "then"), at)
		const onFalse = this.patternOperand(subject, desc.onFalse, childLoc(here, "cond", "else"), at)
		return this.conditional(p, onTrue, onFalse, here)
	}

	/** Text.matches over a subject already typed: a guard's (whenScope), or a call's (matches). */
	matchesOver(subject: Typed, patternDesc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		this.textSubject("matches", subject, at)
		const pattern = this.patternOperand(subject, patternDesc, childLoc(at, 1), at)
		const op = this.overload("matches", [subject.actual, pattern.actual], at)
		if (op.partial) {
			throw defect("textregexeq, which the registry defines on every text and pattern")
		}
		const bool = plainType("bool")
		const patternAt = childLoc(at, "pattern")
		return this.emitAt(
			{
				kind: "matches",
				spec: {
					kind: "op",
					op: op.id,
					args: [subject.node, pattern.node],
					type: bool,
					nonNull: "strict",
					volatility: op.volatility
				},
				subject,
				pattern: patternReads(patternDesc, patternAt),
				at,
				patternAt
			},
			bool,
			undefined,
			noFacts
		)
	}

	/**
	 * Text.translate(x, from, to), PostgreSQL's translate: x with each character of from replaced by the character of
	 * to at its position. from and to are text literals the schema holds, of one length, from holding each character
	 * once (scalar/regex/translate.ts charMapOf), so the map is seen here and replaces each character by one. The node
	 * computes text; the term is text of the image of x's language under the map, within the bytes the image of a value
	 * of x's type takes where its type bounds them (translatedType). PostgreSQL allocates the result for four bytes of
	 * every byte of x and refuses one past MaxAllocSize, and a read never fails on a value, so a query translates only an
	 * x whose bytes are proved within translateMaxBytes (textBytes: its type's bound, or the Logic.when bounding its
	 * octetLength whose branch it stands in); a check or generated field translates any text, and its
	 * write fails on a longer one. Unanalyzed, the term is text of no pattern.
	 */
	translate(
		subjectDesc: ExprDesc<Located, R>,
		fromDesc: ExprDesc<Located, R>,
		toDesc: ExprDesc<Located, R>,
		at: SourceLoc
	): Typed {
		const x = this.term(subjectDesc, childLoc(at, 0))
		if (baseOf(x.actual).carrier !== "text") {
			return stop(
				"MalformedDescription",
				at,
				`a text term for translate, not ${typeLabel(x.nominal)}`
			)
		}
		const from = mapText("from", fromDesc, childLoc(at, 1))
		const to = mapText("to", toDesc, childLoc(at, 2))
		const map = charMapOf(from, to)
		if (!map.ok) {
			return stop("MalformedDescription", at, map.error)
		}
		const bytes = textBytes(x)
		if (bytes === undefined || bytes > translateMaxBytes) {
			this.refusedAt(
				"query",
				at,
				`translate in a query over a text whose pattern bounds it within ${translateMaxBytes} bytes: PostgreSQL's translate allocates four bytes for every byte of its operand and refuses past 1 GB, and a read never fails on a value; ${bytes === undefined ? "the operand's pattern bounds no length" : `the operand's pattern bounds it at ${bytes} bytes`}, so bound it, or translate in a contract predicate, row check or generated field`
			)
		}
		const f = this.literal(from, wildcardText, childLoc(at, 1))
		const t = this.literal(to, wildcardText, childLoc(at, 2))
		const op = this.overload("translate", [x.actual, f.actual, t.actual], at)
		const node = this.native(op, [x, f, t], wildcardText, undefined, at, spelling.translate)
		return this.mapped(x, node, map.value, at)
	}

	/**
	 * Text.lowerAscii(x), ASCII's case fold, translate's by the capitals and their small letters (core/text.ts
	 * asciiFold), every other character as it is: lower under the C collation (registry.ts textLowerAscii), one node
	 * wherever it stands, a query, a CHECK and a generated field alike, which allocates x's own length, so it is defined
	 * on every text, and typed as that translation is (mapped).
	 */
	lowerAscii(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		const x = this.term(subjectDesc, childLoc(at, 0))
		if (baseOf(x.actual).carrier !== "text") {
			return stop(
				"MalformedDescription",
				at,
				`a text term for lowerAscii, not ${typeLabel(x.nominal)}`
			)
		}
		const op = this.overload("lowerAscii", [x.actual], at)
		const node = this.native(op, [x], wildcardText, undefined, at, spelling.lowerAscii)
		return this.mapped(x, node, asciiFold, at)
	}

	/**
	 * Xml.isPattern(x), whether a text term is an XML Schema 1.0 pattern (registry.ts textIsXsdPattern): a
	 * predicate over any text, defined on every value, its SQL a call of the installation's library function.
	 */
	isXsdPattern(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		const x = this.term(subjectDesc, childLoc(at, 0))
		if (baseOf(x.actual).carrier !== "text") {
			return stop(
				"MalformedDescription",
				at,
				`a text term for isXsdPattern, not ${typeLabel(x.nominal)}`
			)
		}
		const op = this.overload("isXsdPattern", [x.actual], at)
		return this.native(op, [x], plainType("bool"), undefined, at, spelling.isXsdPattern)
	}

	/**
	 * A node that computes x's image under a map, as text of that image (translatedType); unanalyzed, or over a text of
	 * no TextInfo, as it is.
	 */
	mapped(x: Typed, node: Typed, map: CharMap, at: SourceLoc): Typed {
		const text = textOf(x.nominal)
		const analysis = this.env.analysis
		return analysis.kind === "unanalyzed" || text === undefined
			? node
			: this.restate(node, this.translatedType(text, map, analysis, at), node.actual, node.facts)
	}

	/**
	 * Text of the image of `text`'s language under a map (image), typed as str.bytes declares it (textWithin): within
	 * the most bytes the image of a text of `text`'s byte and character bounds over its patterns' characters takes
	 * (scalar/regex/translate.ts imageBytes), where its type bounds its bytes, which is its own bound for a map that
	 * takes no character to a wider one, an ASCII case fold or whiteSpace replace among them.
	 */
	translatedType(text: TextInfo, map: CharMap, analysis: Analyzed, at: SourceLoc): ScalarType {
		const bounds = textInfoBounds(text)
		return this.textOfLanguage(
			derivedLanguage(text, map, () => {
				const patterns = this.image(text, map, analysis)
				return { patterns, language: unwrap(analysis.patterns.language(patterns)) }
			}),
			bounds === undefined
				? undefined
				: imageBytes(textPatterns(text), map, bounds, analysis.patterns),
			at
		)
	}

	/**
	 * The patterns of the image of a language under a map, the conjunction of its patterns' images
	 * (scalar/regex/translate.ts imageOf), which holds the image of every value of the language: each the exact image,
	 * or, where the exact source passes a measure of PostgreSQL's regex compile space that the pattern itself fits, the
	 * image of that pattern alone, which holds every value of the image.
	 */
	image(regex: TextInfo, map: CharMap, analysis: Analyzed): Patterns {
		return mapNonEmpty(textPatterns(regex), (pattern): PatternSource => {
			const sources = imageOf(pattern, map, analysis.patterns)
			const exact = { source: sources.exact, flags: imageFlags }
			return analysis.patterns.language([exact]).ok
				? exact
				: { source: sources.within, flags: imageFlags }
		})
	}

	/**
	 * Text.collapse(x), XML Schema's whiteSpace collapse: each run of tab, LF, CR and space one space, and none at
	 * either end, by replace alone (registry.ts textCollapse), defined on every text, so a query collapses any text as a
	 * check does. The node computes text; the term is text of a language holding the image of x's, exactly where it is
	 * cheap to state, within x's byte bound (collapseType); unanalyzed, text of no pattern.
	 */
	collapse(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		const x = this.term(subjectDesc, childLoc(at, 0))
		if (baseOf(x.actual).carrier !== "text") {
			return stop(
				"MalformedDescription",
				at,
				`a text term for collapse, not ${typeLabel(x.nominal)}`
			)
		}
		const text = textOf(x.nominal)
		const op = this.overload("collapse", [x.actual], at)
		const node = this.native(op, [x], wildcardText, undefined, at, spelling.collapse)
		const analysis = this.env.analysis
		return analysis.kind === "unanalyzed" || text === undefined
			? node
			: this.restate(node, this.collapseType(text, analysis, at), node.actual, node.facts)
	}

	/**
	 * Text of a language holding the image of `text`'s under collapse, within `text`'s byte bound, which collapse never
	 * lengthens, typed as str.bytes declares it (textWithin): the conjunction of each of its patterns' images
	 * (scalar/regex/whitespace.ts collapseSources), each the first of its sources the text analysis admits, held to its
	 * measures as a str.regex is; a pattern none of whose sources it admits states nothing, and a text none of whose
	 * patterns states anything is any text.
	 */
	collapseType(text: TextInfo, analysis: Analyzed, at: SourceLoc): ScalarType {
		const bounds = textInfoBounds(text)
		return this.textOfLanguage(
			derivedLanguage(text, "collapse", () => {
				const images = textPatterns(text).flatMap((pattern): ReadonlyArray<PatternSource> => {
					const admitted = collapseSources(pattern, bounds?.length, analysis.patterns).find(
						(c) => analysis.patterns.language([{ source: c.source, flags: c.flags }]).ok
					)
					return admitted === undefined ? [] : [{ source: admitted.source, flags: admitted.flags }]
				})
				const patterns: Patterns = isNonEmpty(images) ? images : [wildcardPattern]
				return { patterns, language: unwrap(analysis.patterns.language(patterns)) }
			}),
			bounds?.bytes,
			at
		)
	}

	/**
	 * Text.parseDouble(x): the double x's decimal text names, IEEE 754-2019's conversion from decimal character
	 * sequences, rounded to the nearest, ties to even, ±Infinity past the greatest finite double and a zero of the
	 * mantissa's sign below half the least subnormal; `INF`, `-INF` and `NaN` their own. The registry's one overload,
	 * text to double precision, admits its operand, and it is defined where x is a member of every double's text, XML
	 * Schema 1.0's xs:double lexical space, its digits and exponent of any length (the lexical
	 * precondition over `doubleText`, which the lowering proves). Its SQL reads no regex and allocates nothing past x's
	 * own size, so it stands in a query over any text as in a check or a generated field.
	 */
	parseDouble(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		const x = this.term(subjectDesc, childLoc(at, 0))
		const op = this.overload("parseDouble", [x.actual], at)
		const type = this.resultType(op, undefined)
		return this.native(
			op,
			[x],
			type,
			boundsOfType(type),
			at,
			`Text.parseDouble(${nodeText(x.node)})`
		)
	}

	/**
	 * Text.utf16Length(x): x's UTF-16 code units, JavaScript's String.length (registry.ts textUtf16Length), at most
	 * MaxAllocSize as char_length is. It exists where char_length does, in contract predicates, row checks and generated
	 * fields, never in a query, and it is defined where x is within regexTextMaxBytes (`bounded`), which x's byte bound
	 * proves: its type's, or the guard Logic.when(Num.within(Text.octetLength(x), 0, bytes), ...) whose branch
	 * it stands in; nothing else does, so no law that reads it raises on a long text.
	 */
	utf16Length(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		this.refusedAt(
			"query",
			at,
			"utf16Length in a query: it exists only in contract predicates and row checks, because queries have no text functions"
		)
		const x = this.term(subjectDesc, childLoc(at, 0))
		if (baseOf(x.actual).carrier !== "text") {
			return stop(
				"MalformedDescription",
				at,
				`a text term for utf16Length, not ${typeLabel(x.nominal)}`
			)
		}
		const op = this.overload("utf16Length", [x.actual], at)
		const bounds = ofRange(0n, BigInt(maxAllocSize), String(maxAllocSize).length)
		return this.native(
			op,
			[x],
			this.resultType(op, bounds),
			bounds,
			at,
			`Text.utf16Length(${nodeText(x.node)})`
		)
	}

	/**
	 * Text.parseDecimal(x): the numeric x's decimal text names, exactly, by xs:decimal's lexical mapping, a computed
	 * numeric of no typmod. The registry's one overload, text to numeric, admits its operand, and it is defined where x
	 * is a member of every decimal text within decimalTextMaxBytes, the grammar of XML Schema 1.1's xs:decimal lexical
	 * space within the bytes whose every value numeric holds (the lexical precondition over `decimalText`, which the
	 * lowering proves from x's language and its byte bound). Its value has at most as many integer digits as the text it
	 * parses has bytes, x's bound or decimalTextMaxBytes, whichever is less, and one fewer fraction digits (decimalBounds),
	 * so x's byte bound proves the cast of it into a numeric(p, s) that holds them; a literal's, which no type bounds, is
	 * numeric's own.
	 */
	parseDecimal(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		const x = this.term(subjectDesc, childLoc(at, 0))
		const op = this.overload("parseDecimal", [x.actual], at)
		const bytes = textBoundsOf(x.nominal)?.bytes
		const bounds = bytes === undefined ? undefined : decimalBounds(bytes)
		return this.native(
			op,
			[x],
			this.resultType(op, bounds),
			bounds,
			at,
			`Text.parseDecimal(${nodeText(x.node)})`
		)
	}

	/**
	 * Num.floatBits(x): a float's identity image (registry.ts floatBitsOf), the bits of its IEEE 754 binary64
	 * encoding as a signed bigint, a real widened exactly first, NaN's in one form: a total node, of every bigint, which
	 * a key, a reference and an arbiter read natively.
	 */
	floatBits(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		const x = this.term(subjectDesc, at)
		const carrier = baseOf(x.actual).carrier
		if (carrier !== "float4" && carrier !== "float8") {
			return stop(
				"MalformedDescription",
				at,
				`a real or double precision term for floatBits, not ${typeLabel(x.nominal)}`
			)
		}
		const type = plainType("int8")
		return this.native(
			this.overload("floatBits", [x.actual], at),
			[x],
			type,
			boundsOfType(type),
			at,
			spelling.floatBits
		)
	}

	/**
	 * Net.within(a, b), Net.strictlyWithin(a, b) and Net.overlaps(a, b): PostgreSQL's `a <<= b`, `a << b` and `a && b`
	 * over the network types (registry.ts netContainment), each operand an inet or a cidr, a contract over one among
	 * them, of either type whatever the other's, since an address is tested against a network as each is stored; a
	 * literal takes the first operand's type, as every literal takes the type of the term it meets. Each is false across
	 * the address families and defined on every pair of values, so it stands in a query, a check and a law alike.
	 */
	netContainment(
		fn: "netWithin" | "netStrictlyWithin" | "netOverlaps",
		aDesc: ExprDesc<Located, R>,
		bDesc: ExprDesc<Located, R>,
		at: SourceLoc
	): Typed {
		const a = this.term(aDesc, childLoc(at, 0))
		const b =
			bDesc.kind === "literal" && bDesc.type === undefined
				? this.literal(bDesc.value, this.adopt(a.nominal, "compare"), childLoc(at, 1))
				: this.lower(bDesc, childLoc(at, 1))
		for (const operand of [a, b]) {
			if (!capsOf(operand.actual).includes("netContainment")) {
				return stop(
					"UnsupportedOperation",
					at,
					`netContainment: ${spelling[fn]} reads an inet or a cidr on each side, not ${typeLabel(operand.nominal)}`
				)
			}
		}
		const op = this.overload(fn, [a.actual, b.actual], at)
		return this.native(op, [a, b], plainType("bool"), undefined, at, spelling[fn])
	}

	/**
	 * Crypto.sha256(x): the SHA-256 digest of a bytes value, or of a text's UTF-8 bytes, its 32 bytes, `sha256(x)` and
	 * `<textDigest>(x)` (registry.ts bytesDigest, textSha256), a digest (ir/scalar.ts DigestType). It is the one
	 * operation that reads a bytes value, which it reads whole, as a head does (whole): no operation yields bytes, so a
	 * bytes operand is a bytes reference, a row's field or a variable; a text operand is any text term. Its SQL
	 * allocates 32 bytes whatever x's length, so it stands in a query as in a check or a generated field.
	 */
	sha256(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		const x = this.whole(subjectDesc, childLoc(at, 0))
		const carrier = baseOf(x.actual).carrier
		if (carrier !== "bytes" && carrier !== "text") {
			return stop(
				"MalformedDescription",
				at,
				`a bytes or text term for sha256, not ${typeLabel(x.nominal)}`
			)
		}
		const op = this.overload("sha256", [x.actual], at)
		return this.native(op, [x], plainType("sha256"), undefined, at, spelling.sha256)
	}

	/**
	 * Time.wall(t, zone): the zone's wall clock at the instant t, both in milliseconds, t's since the Unix epoch and the
	 * wall clock's since the local epoch, as PostgreSQL's tzdata reads the zone (registry.ts zoneWall). t is a bigint
	 * term, never an instant, which counts microseconds: its milliseconds are Num.div(Type.base(at),
	 * 1000n) cast into a bigint. zone is a closed id of a zone roster (closed.zones), whose code its roster's names
	 * constant reads as the zone's IANA name. It is defined where t lies in timestamptz's range (`clock`), which t's
	 * bounds prove, a millis reading of the database's clock's among them, or a Num.within guard. Its value lies in
	 * wallRange, an instant moved by at most a TZif offset. The host holds no tzdata, so it stands in a query alone
	 * (computeSpecs `check`).
	 */
	wall(instantDesc: ExprDesc<Located, R>, zoneDesc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		const instant = this.term(instantDesc, childLoc(at, 0))
		if (isInstantType(instant.nominal)) {
			return stop(
				"UnsupportedOperation",
				at,
				`Time.wall over an instant's microseconds: it reads milliseconds since the Unix epoch, Type.cast(Num.div(Type.base(${nodeText(instant.node)}), 1000n), pg.bigint)`
			)
		}
		if (baseOf(instant.actual).carrier !== "int8") {
			return stop(
				"MalformedDescription",
				at,
				`a bigint term of milliseconds since the Unix epoch for Time.wall, not ${typeLabel(instant.nominal)}`
			)
		}
		const zone = this.term(zoneDesc, childLoc(at, 1))
		const roster = rosterOf(zone.actual)
		if (baseOf(zone.actual).carrier !== "code" || roster?.order !== "zones") {
			return stop(
				"MalformedDescription",
				at,
				`a closed id of a zone roster, closed.zones(name, zones), for Time.wall's zone, not ${typeLabel(zone.nominal)}`
			)
		}
		const op = this.overload("wall", [instant.actual, zone.actual], at)
		const type = plainType("int8")
		const digits = String(-wallRange.low > wallRange.high ? -wallRange.low : wallRange.high).length
		return this.native(
			op,
			[instant, zone],
			type,
			ofRange(wallRange.low, wallRange.high, digits),
			at,
			spelling.wall
		)
	}

	/**
	 * Time.epochDay(x): a date's days after 1970-01-01, negative before it (registry.ts dateEpochDay), an integer of
	 * epochDayRange, since every date grizzle holds is from 0001-01-01 to 9999-12-31; defined on every date, so it
	 * stands in a query, a check and a generated field alike, the host computing it by the same day count.
	 */
	epochDay(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		const x = this.term(subjectDesc, childLoc(at, 0))
		if (baseOf(x.actual).carrier !== "date") {
			return stop(
				"MalformedDescription",
				at,
				`a date term for Time.epochDay, not ${typeLabel(x.nominal)}`
			)
		}
		const op = this.overload("epochDay", [x.actual], at)
		const digits = String(
			-epochDayRange.low > epochDayRange.high ? -epochDayRange.low : epochDayRange.high
		).length
		return this.native(
			op,
			[x],
			plainType("int4"),
			ofRange(epochDayRange.low, epochDayRange.high, digits),
			at,
			spelling.epochDay
		)
	}

	/**
	 * Time.dateOfEpochDay(n): the date n days after 1970-01-01 (registry.ts dateOfEpochDayFrom), n an integer or a
	 * bigint term, an exact integer cast into one first. It is defined where n is the epoch day of a date
	 * grizzle holds, within epochDayRange (`fits`, compute/lower.ts fitRange), which n's bounds prove or a Num.within
	 * guard; it stands in a query, a check and a generated field alike.
	 */
	dateOfEpochDay(daysDesc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		const n = this.term(daysDesc, childLoc(at, 0))
		const carrier = baseOf(n.actual).carrier
		if (carrier !== "int4" && carrier !== "int8") {
			return stop(
				"MalformedDescription",
				at,
				`an integer or bigint term of days after 1970-01-01 for Time.dateOfEpochDay, not ${typeLabel(n.nominal)}${carrier === "exactInteger" ? ": cast an exact integer into one, Type.cast(n, pg.bigint)" : ""}`
			)
		}
		const op = this.overload("dateOfEpochDay", [n.actual], at)
		return this.native(op, [n], plainType("date"), undefined, at, spelling.dateOfEpochDay)
	}

	/**
	 * textDocument(configuration, weight, text, ...), the term of searchDocument(configuration, [weight, text], ...): a search document, the tsvector PostgreSQL parses from its
	 * texts under `configuration`, each text's positions labelled by the weight before it and the parts concatenated in
	 * their order (registry.ts searchPart and tsvector's ||), of the configuration's type (ir/scalar.ts SearchType). The
	 * configuration and each weight are literals, a configuration of pg_catalog's and a weight label, which the schema
	 * holds; each text is a text term. It is a generated field's alone: the host evaluates no part of it, and a query reads
	 * a document a field stores, so a document in a query is refused, and a check, whose verdict is a boolean, reaches one
	 * only through a match, which a check refuses.
	 */
	textDocument(args: ReadonlyArray<ExprDesc<Located, R>>, at: SourceLoc): Typed {
		this.refusedAt(
			"query",
			at,
			"textDocument in a query: a search document is a generated field's, which PostgreSQL parses where it writes its row, and a query matches and ranks the document the field stores"
		)
		const [configurationDesc, ...parts] = args
		const configuration =
			configurationDesc?.kind === "literal" &&
			configurationDesc.type === undefined &&
			isTextSearchConfiguration(configurationDesc.value)
				? configurationDesc.value
				: stop(
						"MalformedDescription",
						childLoc(at, 0),
						`a text search configuration of pg_catalog's as textDocument's first argument: ${textSearchConfigurations.join(", ")}`
					)
		if (parts.length === 0 || parts.length % 2 !== 0) {
			return stop(
				"MalformedDescription",
				at,
				"a search document of at least one part, each a weight label and a text term"
			)
		}
		const type = searchType(configuration)
		const part = (i: number): Typed => {
			const weightDesc = parts[i]
			const textDesc = parts[i + 1]
			const weightAt = childLoc(at, i + 1)
			const textAt = childLoc(at, i + 2)
			const weight =
				weightDesc?.kind === "literal" &&
				weightDesc.type === undefined &&
				isTextSearchWeight(weightDesc.value)
					? this.literal(weightDesc.value, wildcardText, weightAt)
					: stop(
							"MalformedDescription",
							weightAt,
							"a weight label of a search document's part: A, B, C or D"
						)
			const text = this.term(
				textDesc ?? stop("MalformedDescription", textAt, "a text term of a search document's part"),
				textAt
			)
			if (baseOf(text.actual).carrier !== "text") {
				return stop(
					"MalformedDescription",
					textAt,
					`a text term of a search document's part, not ${typeLabel(text.nominal)}`
				)
			}
			const op = this.overload("searchPart", [text.actual, weight.actual], at)
			return this.native(op, [text, weight], type, undefined, at, "searchDocument")
		}
		let document = part(0)
		for (let i = 2; i < parts.length; i += 2) {
			const next = part(i)
			const op = this.overload("searchConcat", [document.actual, next.actual], at)
			document = this.native(op, [document, next], type, undefined, at, "searchDocument")
		}
		return document
	}

	/**
	 * A match or a rank of a search document against a query's text (registry.ts textSearchOf): the document a search
	 * document's term, the query a text term or a string, parsed by websearch_to_tsquery or plainto_tsquery under the
	 * document's own configuration, so no query is ever read under another. A match is a boolean, a rank a real. In a
	 * query the text's bytes are proved within textQueryMaxBytes, by its type or a byte guard whose branch the read stands
	 * in, since PostgreSQL refuses a tsquery past its operands' bound and a read never fails on a value; a check refuses
	 * every match and rank (computeSpecs), which only PostgreSQL computes.
	 */
	textSearch(
		fn:
			| "websearchMatches"
			| "plainMatches"
			| "websearchRank"
			| "plainRank"
			| "websearchRankCd"
			| "plainRankCd",
		documentDesc: ExprDesc<Located, R>,
		queryDesc: ExprDesc<Located, R>,
		at: SourceLoc
	): Typed {
		const document = this.term(documentDesc, childLoc(at, 0))
		if (baseOf(document.actual).carrier !== "tsvector") {
			return stop(
				"UnsupportedOperation",
				childLoc(at, 0),
				`textSearch: ${fn} reads a search document, not ${typeLabel(document.nominal)}`
			)
		}
		const queryAt = childLoc(at, 1)
		const query =
			queryDesc.kind === "literal" && queryDesc.type === undefined
				? this.literal(queryDesc.value, wildcardText, queryAt)
				: this.term(queryDesc, queryAt)
		if (baseOf(query.actual).carrier !== "text") {
			return stop(
				"MalformedDescription",
				queryAt,
				`a query's text for ${fn}, not ${typeLabel(query.nominal)}`
			)
		}
		const bytes = textBytes(query)
		if (bytes === undefined || bytes > textQueryMaxBytes) {
			this.refusedAt(
				"query",
				queryAt,
				`${fn} in a query over a text whose pattern bounds it within ${textQueryMaxBytes} bytes: PostgreSQL refuses a query whose operands pass ${textSearchStringMaxBytes} bytes, and a read never fails on a value; ${bytes === undefined ? "the query's pattern bounds no length" : `the query's pattern bounds it at ${bytes} bytes`}, so bound it by its type or by Logic.when(Num.within(Text.octetLength(q), 0, ${textQueryMaxBytes}), ...)`
			)
		}
		const op = this.overload(fn, [document.actual, query.actual], at)
		if (fn === "websearchMatches" || fn === "plainMatches") {
			return this.native(
				op,
				[document, query],
				plainType("bool"),
				undefined,
				at,
				spelling.textMatches
			)
		}
		const rank = plainType("float4")
		const label =
			fn === "websearchRankCd" || fn === "plainRankCd" ? spelling.textRankCd : spelling.textRank
		return this.native(op, [document, query], rank, boundsOfType(rank), at, label)
	}

	/** A set over a roster, and the roster, or the refusal of a term of another type: it has no set algebra. */
	set(
		fn: string,
		x: Typed,
		at: SourceLoc
	): { readonly set: Typed; readonly roster: { readonly handles: ReadonlyArray<string> } } {
		const base = baseOf(x.nominal)
		if (base.carrier !== "bits") {
			return stop(
				"UnsupportedOperation",
				at,
				`setAlgebra: ${typeLabel(x.nominal)} has no ${fn}; it is a set over a roster's`
			)
		}
		return { set: x, roster: base.roster }
	}

	/**
	 * Bits.singleton(id): the set over a closed id's roster holding exactly its handle, the empty set with the id's
	 * code's bit set (registry.ts setAdjoin), so it is the set Bits.of writes for that one handle. A NULL id gives NULL,
	 * and a term of any other type has no singleton.
	 */
	singleton(id: Typed, at: SourceLoc): Typed {
		const base = baseOf(id.nominal)
		if (base.carrier !== "code") {
			return stop(
				"UnsupportedOperation",
				at,
				`setAlgebra: ${typeLabel(id.nominal)} has no singleton; it is a closed id's`
			)
		}
		const type: ScalarType = Object.freeze({
			carrier: "bits",
			caps: capabilitiesOf("bits"),
			contract: undefined,
			roster: base.roster
		})
		const empty = this.literal({ handles: [] }, type, childLoc(at, "empty"))
		return this.emitAt(
			this.totalNode(this.commonOp("adjoin", type, at), [empty, id], type, type),
			type,
			undefined,
			noFacts
		)
	}

	/**
	 * Two sets of one roster: the second a term or a parameter of the first's roster, or a set value over it (Bits.of),
	 * a bare literal that adopts the first's type as an operand does, so its handles are coded by the first's roster. A
	 * set over another roster is another universe, whose codes mean other handles.
	 */
	sets(
		fn: string,
		first: ExprDesc<Located, R>,
		second: ExprDesc<Located, R>,
		at: SourceLoc
	): readonly [Typed, Typed] {
		const a = this.set(fn, this.term(first, childLoc(at, 0)), at).set
		if (second.kind === "literal" && second.type === undefined) {
			return [a, this.literal(second.value, this.adopt(a.nominal, "operand"), childLoc(at, 1))]
		}
		const b = this.set(fn, this.term(second, childLoc(at, 1)), at).set
		if (!meets(a.nominal, b.nominal)) {
			return stop(
				"MalformedDescription",
				at,
				`sets of one roster for ${fn}: ${typeLabel(a.nominal)} never meets ${typeLabel(b.nominal)}`
			)
		}
		return [a, b]
	}

	/**
	 * The closed relation `relation` a read `read` applies, or its refusal: UnsupportedOperation where the expression
	 * applies none, with the reason, and MalformedDescription for a name that is no closed relation's.
	 */
	closedHeading(read: "C.at" | "C.row" | "C.has", relation: string, at: SourceLoc): ClosedHeading {
		return closedHeadingOf(this.env.closed, read, relation, at)
	}

	/**
	 * Argument `i` of a closed read, `d`, as the key field it stands at: a bare literal adopts its type, a term meets it.
	 * A read states one argument per key field it fixes, so an argument past the key is refused.
	 */
	keyTerm(
		d: ExprDesc<Located, R>,
		i: number,
		key: ReadonlyArray<ClosedField>,
		at: SourceLoc
	): Typed {
		const field = key[i]
		const here = childLoc(at, i)
		if (field === undefined) {
			return stop("MalformedDescription", here, "a term per key field, and no more")
		}
		if (d.kind === "literal" && d.type === undefined) {
			return this.literal(d.value, field.type, here)
		}
		const term = this.lower(d, here)
		if (!meets(field.type, term.nominal)) {
			return stop(
				"MalformedDescription",
				here,
				`a term of key field ${field.name}'s type ${typeLabel(field.type)}, not ${typeLabel(term.nominal)}`
			)
		}
		return this.convert(term, field.type, here)
	}

	/**
	 * A full key of the closed relation `heading` reads, C.at's and C.has's arguments `args`: one term per key field, in
	 * key order (keyTerm), so nonempty as the key is.
	 */
	fullKey(
		read: "C.at" | "C.has",
		relation: string,
		args: NonEmptyReadonlyArray<ExprDesc<Located, R>>,
		heading: ClosedHeading,
		at: SourceLoc
	): NonEmptyReadonlyArray<TypedNode> {
		if (args.length !== heading.key.length) {
			return stop(
				"MalformedDescription",
				at,
				`${heading.key.length} key terms for ${relation}.${read === "C.at" ? "at" : "has"}, one per key field`
			)
		}
		return mapNonEmpty(args, (d, i) => this.keyTerm(d, i, heading.key, at).node)
	}

	/**
	 * C.at(field, t…): payload field `field` of the closed relation at the key its terms are, one per key field in key
	 * order, of that field's type, with its bounds and facts as any value of that type has them: every row's payload is
	 * admitted by it, and a key the relation holds no tuple at reads NULL, which its reader refuses. The rows are not
	 * read: the TypeScript types type the read by its field alone, and a row's change is data, never a new type.
	 */
	closedAt(
		desc: Extract<ExprDesc<Located, R>, { readonly kind: "closedAt" }>,
		at: SourceLoc
	): Typed {
		const here = childLoc(at, "at")
		const heading = this.closedHeading("C.at", desc.relation, here)
		const payload = heading.payload.find((f) => f.name === desc.field)
		if (payload === undefined) {
			return stop(
				"MalformedDescription",
				here,
				`a payload field of ${desc.relation} named ${JSON.stringify(desc.field)}`
			)
		}
		return this.emit({
			kind: "closedAt",
			relation: desc.relation,
			field: desc.field,
			args: this.fullKey("C.at", desc.relation, desc.args, heading, here),
			type: payload.type,
			nonNull: "absentRefused"
		})
	}

	/**
	 * Fn.call(f, args): the value of a declared function the schema declares (DeclaredFunctions), one that returns
	 * a value and is immutable or stable, a term being a function of its operands, at one term per declared argument,
	 * each a value of a type that meets the argument's declared type, a bare literal admitted at it (callArgument). Its
	 * value is of its declared result type, which the lowering casts it to, so it has the facts that type states.
	 */
	call(desc: Extract<ExprDesc<Located, R>, { readonly kind: "call" }>, at: SourceLoc): Typed {
		const here = childLoc(at, "call")
		const functions = this.env.functions
		if (functions.kind === "none") {
			return stop(
				"UnsupportedOperation",
				here,
				`a call of declared function ${desc.function}: ${functions.why}`
			)
		}
		const fn = functions.of(desc.function)
		if (fn === undefined) {
			return stop(
				"MalformedDescription",
				here,
				`a declared function of the schema; ${desc.function} is none`
			)
		}
		const returns = fn.desc.returns
		if (returns.kind !== "value") {
			return stop(
				"MalformedDescription",
				here,
				`a declared function that returns a value as a term; ${fn.name} returns ${functionTypeLabel(returns)}`
			)
		}
		if (fn.desc.volatility === "volatile") {
			return stop(
				"UnsupportedOperation",
				here,
				`an immutable or stable function as a term, a function of its operands; ${fn.name} is volatile, which a match calls as a source`
			)
		}
		const named = Object.keys(desc.args)
		const declared = fn.desc.args.map((a) => a.name)
		const stray = named.filter((a) => !declared.includes(a))
		const missing = declared.filter((a) => !named.includes(a))
		if (stray.length > 0 || missing.length > 0) {
			return stop(
				"MalformedDescription",
				here,
				`the arguments of function ${fn.name}, ${declared.length === 0 ? "none" : declared.join(", ")}; ${[...missing.map((a) => `${a} is missing`), ...stray.map((a) => `${a} is none of them`)].join(", ")}`
			)
		}
		const args = fn.desc.args.map((a) => {
			const where = childLoc(here, a.name)
			if (a.type.kind !== "value") {
				return stop(
					"MalformedDescription",
					where,
					`a function of value arguments as a term; ${fn.name} takes ${functionTypeLabel(a.type)} at ${a.name}`
				)
			}
			const type = unwrap(this.env.fieldType(a.type.type, where))
			const term = defined(desc.args[a.name], "an argument the call names, checked above")
			return { type, node: this.callArgument(term, type, a.name, where).node }
		})
		const type = unwrap(this.env.fieldType(returns.type, here))
		return this.emit({
			kind: "call",
			function: { name: fn.name, volatility: fn.desc.volatility, definition: fn.definition },
			params: args.map((a) => a.type),
			args: args.map((a) => a.node),
			type,
			nonNull: callNonNull[nullInputOf(fn.desc)],
			volatility: fn.desc.volatility === "stable" ? "stable" : "immutable"
		})
	}

	/** A call's argument at its declared type `type`: a bare literal admitted at it, any other term one that meets it. */
	callArgument(d: ExprDesc<Located, R>, type: ScalarType, arg: string, at: SourceLoc): Typed {
		if (d.kind === "literal" && d.type === undefined) {
			return this.literal(d.value, type, at)
		}
		const term = this.lower(d, at)
		if (!meets(type, term.nominal)) {
			return stop(
				"MalformedDescription",
				at,
				`a term of argument ${arg}'s type ${typeLabel(type)}, not ${typeLabel(term.nominal)}`
			)
		}
		return this.convert(term, type, at)
	}

	/**
	 * C.has(t…): whether the closed relation holds a tuple at the key its terms are, one per key field in key order, a
	 * boolean: false at a key it holds no tuple at, so absence is a truth value, and NULL only at a NULL key term. It
	 * reads the relation's key set alone, never a payload.
	 */
	closedHas(
		desc: Extract<ExprDesc<Located, R>, { readonly kind: "closedHas" }>,
		at: SourceLoc
	): Typed {
		const here = childLoc(at, "has")
		const heading = this.closedHeading("C.has", desc.relation, here)
		return this.emit({
			kind: "closedHas",
			relation: desc.relation,
			args: this.fullKey("C.has", desc.relation, desc.args, heading, here),
			type: plainType("bool"),
			nonNull: "strict"
		})
	}

	/**
	 * C.row(t…): the completions of the key prefix its terms are, one per key field but the last: a set over the last
	 * key field's roster. A prefix that leaves more than one key field open is no set over one roster, so it is refused.
	 */
	closedRow(
		desc: Extract<ExprDesc<Located, R>, { readonly kind: "closedRow" }>,
		at: SourceLoc
	): Typed {
		const here = childLoc(at, "row")
		const heading = this.closedHeading("C.row", desc.relation, here)
		const open = heading.key[desc.args.length]
		if (desc.args.length !== heading.key.length - 1 || open === undefined) {
			return stop(
				"MalformedDescription",
				here,
				`${heading.key.length - 1} key terms for ${desc.relation}.row, one per key field but the last`
			)
		}
		const roster = rosterOf(baseOf(open.type))
		if (roster === undefined || baseOf(open.type).carrier !== "code") {
			return stop(
				"UnsupportedOperation",
				here,
				`a set over a roster: ${desc.relation}'s last key field ${open.name} is ${typeLabel(open.type)}, no closed id`
			)
		}
		const args = desc.args.map((d, i) => this.keyTerm(d, i, heading.key, here))
		const type: ScalarType = Object.freeze({
			carrier: "bits",
			caps: capabilitiesOf("bits"),
			contract: undefined,
			roster
		})
		return this.emitAt(
			{
				kind: "stated",
				spec: {
					kind: "closedRow",
					relation: desc.relation,
					args: args.map((a) => a.node),
					type,
					nonNull: "strict"
				}
			},
			type,
			undefined,
			noFacts
		)
	}

	predicate(desc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		const p = this.term(desc, at)
		if (baseOf(p.actual).carrier !== "bool") {
			return stop("MalformedDescription", at, `a predicate, not ${typeLabel(p.nominal)}`)
		}
		return p
	}

	/** A literal that meets no term. */
	bareLiteral(value: LiteralDesc, at: SourceLoc): Typed {
		const kind = bareLiteralKind(value)
		const type = (() => {
			switch (kind) {
				case "integer":
					return plainType("int4")
				case "bigint":
					return plainType("int8")
				case "numeric":
					return anyNumeric
				case "money":
					return plainType("money")
				case "boolean":
					return plainType("bool")
				case "text":
					return wildcardText
				case undefined:
					return stop(
						"MalformedDescription",
						at,
						"a literal that meets no term: an integer, a bigint, a Decimal, a Money, a boolean or a string"
					)
			}
		})()
		return this.literal(value, type, at)
	}

	/**
	 * A comparison, BETWEEN or IN: over an exact value and plain values of its family, those widened into the exact
	 * carrier, a value comparison.
	 */
	comparison(
		fn: "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "between" | "in",
		operands: ReadonlyArray<Typed>,
		at: SourceLoc
	): Typed {
		const exact = operands.find((a) => exactFamily(a.nominal) === valueType(a.nominal).carrier)
		const args =
			exact === undefined
				? operands
				: operands.map((a) => this.widenTo(a, meetingType(a.nominal, exact.nominal), at))
		const [first] = args
		if (first === undefined) {
			return stop("MalformedDescription", at, `an operand for ${fn}`)
		}
		const capability = fn === "eq" || fn === "ne" || fn === "in" ? "equality" : "ordering"
		if (!capsOf(first.actual).includes(capability)) {
			return stop(
				"UnsupportedOperation",
				at,
				`${capability}: ${typeLabel(first.nominal)} has no ${fn}`
			)
		}
		const op = this.overload(fn, fn === "in" ? [first.actual] : args.map((a) => a.actual), at)
		return this.native(op, args, plainType("bool"), undefined, at, fn)
	}

	/** Logic.cond: a conditional over any predicate, guarding nothing (Logic.when is the one guard). */
	cond(desc: Extract<ExprDesc<Located, R>, { readonly kind: "cond" }>, at: SourceLoc): Typed {
		const p = this.predicate(desc.pred, childLoc(at, "cond"))
		const [onTrue, onFalse] = this.branches(
			desc.onTrue,
			desc.onFalse,
			childLoc(at, "cond", "then"),
			childLoc(at, "cond", "else")
		)
		if (!isBareLiteral(desc.onTrue) && !isBareLiteral(desc.onFalse)) {
			this.exactBeside(onTrue, onFalse, childLoc(at, "cond", "else"))
		}
		return this.conditional(p, onTrue, onFalse, at)
	}

	/**
	 * A conditional's two branches, typed: a term fixes its type and a bare literal opposite it adopts it
	 * (branchOperand); of two bare literals the first fixes it, at its value's own type.
	 */
	branches(
		then: ExprDesc<Located, R>,
		otherwise: ExprDesc<Located, R>,
		thenAt: SourceLoc,
		elseAt: SourceLoc
	): readonly [Typed, Typed] {
		if (!isBareLiteral(then)) {
			const t = this.term(then, thenAt)
			return [t, this.branchOperand(otherwise, t, elseAt)]
		}
		if (!isBareLiteral(otherwise)) {
			const e = this.term(otherwise, elseAt)
			return [this.branchOperand(then, e, thenAt), e]
		}
		const t = this.lower(then, thenAt)
		return [t, this.operand(otherwise, t, "compare", elseAt)]
	}

	/**
	 * The CASE over `p` of two typed branches, each converted into their common type (types.ts commonType): unchanged, by
	 * a registered widening, by the binary coercion, or into the common contract with its proof (convert). Its values
	 * are its branches' hull, and its facts its SQL type's alone (settle), as every operation's result: the TypeScript
	 * type of Logic.cond and Logic.when states none of its branches'.
	 */
	conditional(p: Typed, onTrue: Typed, onFalse: Typed, at: SourceLoc): Typed {
		const type = commonType(onTrue.nominal, onFalse.nominal)
		const t = this.convert(onTrue, type, at)
		const e = this.convert(onFalse, type, at)
		const bounds =
			t.bounds !== undefined && e.bounds !== undefined ? hullBounds(t.bounds, e.bounds) : undefined
		return this.emitAt(
			{
				kind: "stated",
				spec: { kind: "cond", args: [p.node, t.node, e.node], type, nonNull: "cond" }
			},
			type,
			bounds,
			noFacts
		)
	}

	/** A value converted into `type`, a supertype of its own: unchanged, widened, coerced, or cast into a contract. */
	convert(b: Typed, type: ScalarType, at: SourceLoc): Typed {
		if (sameShape(b.actual, type)) {
			return b
		}
		if (type.contract !== undefined && !sameRefinement(b.actual, type)) {
			const base = this.convert(b, baseOf(type), at)
			return this.domainCast(base, type, checkedKind(b.node), at)
		}
		const from = valueType(b.actual)
		const to = baseOf(type)
		if (from.carrier !== to.carrier) {
			const op = castOf(from.carrier, to.carrier)
			if (op === undefined) {
				return stop(
					"UnsupportedOperation",
					at,
					`no conversion of ${typeLabel(from)} into ${typeLabel(to)}`
				)
			}
			return this.castNode(b, type, { kind: "registered", op }, at)
		}
		return this.castNode(b, type, { kind: "coercion" }, at)
	}

	/**
	 * Logic.when, the one guard of a partial operation: CASE WHEN <the guard over the subject> THEN <then> ELSE
	 * <otherwise> END, where the branch's parameter, each guarded node of the guard over the subject inside the then
	 * branch, has what the guard establishes, its facts and its refined interval (guarded); the subject read past the
	 * parameter keeps its own, as TypeScript types it, which narrows a callback's parameter and never a term the callback
	 * captures. PostgreSQL evaluates a CASE result only where its WHEN holds, and drops unsimplified the result a WHEN
	 * constant at plan time does not take (a parameter's), so the then branch never meets a value the guard excludes. A
	 * guard refines only its own parameter: a precondition over constants is proved by the constants alone, never by a
	 * guard on something else, since PostgreSQL may fold a constant then branch at plan time.
	 */
	when(desc: Extract<ExprDesc<Located, R>, { readonly kind: "when" }>, at: SourceLoc): Typed {
		const here = childLoc(at, "when")
		const subject = this.term(desc.subject, childLoc(here, "subject"))
		const guard = this.guardPredicate(desc.guard, subject, here)
		const branch = new Typing(
			this.env,
			[...this.#scope, ...this.whenScope(desc.guard, desc.subject, subject, guard.within, here)],
			this.#tape
		)
		const onTrue = branch.term(desc.proved, childLoc(here, "proved"))
		const onFalse = this.branchOperand(desc.otherwise, onTrue, childLoc(here, "otherwise"))
		if (!isBareLiteral(desc.otherwise)) {
			this.exactBeside(onTrue, onFalse, childLoc(here, "otherwise"))
		}
		return this.conditional(guard.predicate, onTrue, onFalse, at)
	}

	/**
	 * A Logic.when branch's parameter (ir/desc.ts GuardedDesc): its subject, with what each enclosing Logic.when of
	 * its guard over that subject establishes there, which every restatement of it keeps (settle, `held`): the when whose
	 * subject's node is the node the parameter's subject records (sameNode). Outside every such when it is its subject
	 * with its own facts, so a copy of a parameter read past its branch proves nothing. The node is a proof's alone: it
	 * records no node and no location of its own.
	 */
	guarded(desc: Extract<ExprDesc<Located, R>, { readonly kind: "guarded" }>, at: SourceLoc): Typed {
		const arg = this.term(desc.arg, at)
		const whens = this.#scope.flatMap((scope) =>
			scope.kind === "parameter" &&
			sameContent(scope.guard, desc.guard) &&
			sameNode(scope.holds.subject, arg.node)
				? [scope]
				: []
		)
		return this.settle(
			arg.node,
			arg.nominal,
			arg.actual,
			{ bounds: arg.bounds, facts: arg.facts },
			[...arg.held, ...whens]
		)
	}

	/**
	 * What a guard establishes inside its branch (WhenScope): of its parameter, a numeric guard's facts and refined
	 * interval, or a match's language of the subject's own patterns and the match's together, within the subject's own
	 * byte bound, the type str.bytes(bound, str.and(subject, str.regex(pattern))) declares, without the bound where the
	 * subject has none, and str.regex(pattern) alone where the subject is any text; and where its subject is a text's
	 * byte count, Text.octetLength(x), x within the interval's high end of bytes at every occurrence of it
	 * (bytesGuard). Unanalyzed, a language is no type, so a match establishes nothing and a byte count's occurrences
	 * keep theirs.
	 */
	whenScope(
		guard: GuardDesc,
		subjectDesc: ExprDesc<Located, R>,
		subject: Typed,
		within: readonly [Exact, Exact] | undefined,
		at: SourceLoc
	): ReadonlyArray<WhenScope> {
		const analysis = this.env.analysis
		if (guard.kind !== "matches") {
			const parameter: WhenScope = {
				kind: "parameter",
				guard,
				holds: {
					kind: "facts",
					subject: subject.node,
					refinement: guardRefinement(guard, within),
					facts: guardFacts(guard, within)
				}
			}
			const counted = unguarded(subjectDesc)
			if (
				analysis.kind === "unanalyzed" ||
				within === undefined ||
				counted.kind !== "compute" ||
				counted.fn !== "octetLength"
			) {
				return [parameter]
			}
			const text = this.term(argOf(counted, 0, at), childLoc(at, "subject", 0))
			const bytes = this.bytesGuard(text, within[1], analysis.patterns.language, at)
			return bytes === undefined ? [parameter] : [parameter, { kind: "occurrences", holds: bytes }]
		}
		if (analysis.kind === "unanalyzed") {
			return []
		}
		const own = regexRefOf(subject.nominal)
		const type = this.textWithin(
			appendNonEmpty(own === undefined ? [] : own.patterns, {
				source: guard.pattern.spelling,
				flags: matchFlags
			}),
			own === undefined ? undefined : textInfoBounds(own)?.bytes,
			analysis.patterns.language,
			childLoc(at, "pattern")
		)
		return [{ kind: "parameter", guard, holds: { kind: "language", subject: subject.node, type } }]
	}

	/**
	 * What a bound on a text's byte count gives the text inside the guard's branch: its patterns' language within
	 * `high` bytes, none below zero, the type str.bytes(high, its text) declares; nothing where its type already
	 * bounds it so. A wildcard text's pattern is every text's, `^.*$` under `su`.
	 */
	bytesGuard(text: Typed, high: Exact, analyze: TextLookup, at: SourceLoc): WhenGuard | undefined {
		const info = textOf(text.nominal)
		const ceiling = floorOfExact(high)
		const octets = ceiling < 0n ? 0 : Number(ceiling)
		const bytes = info === undefined ? undefined : textInfoBounds(info)?.bytes
		if (info === undefined || (bytes !== undefined && bytes <= octets)) {
			return undefined
		}
		return {
			kind: "language",
			subject: text.node,
			type: this.textWithin(textPatterns(info), octets, analyze, at)
		}
	}

	/**
	 * Text of `patterns`' language within `octets` UTF-8 bytes, typed as str.bytes(octets, text) declares it for a text
	 * of those patterns, or as that text does where no bound is given: the patterns analyzed by `analyze`, the text
	 * analysis, and cut by ir/scalar.ts languageWithin, so a language and a bound have the one type a declaration of them
	 * has.
	 */
	textWithin(
		patterns: Patterns,
		octets: number | undefined,
		analyze: TextLookup,
		at: SourceLoc
	): ScalarType {
		return this.textOfLanguage({ patterns, language: unwrap(analyze(patterns)) }, octets, at)
	}

	/**
	 * Text of a language its patterns prove (DerivedLanguage) within `octets` UTF-8 bytes, typed as textWithin types it.
	 */
	textOfLanguage(derived: DerivedLanguage, octets: number | undefined, at: SourceLoc): ScalarType {
		const { patterns } = derived
		const language =
			octets === undefined ? derived.language : languageWithin(derived.language, octets)
		return unwrap(
			this.env.fieldType({ kind: "text", patterns, bytes: languageOctets(language), language }, at)
		)
	}

	/**
	 * The predicate a guard tests over its subject, and the interval it states where it states one: `<> 0`, `>= 0`,
	 * `> 0`, `> '-Infinity' AND < 'Infinity'`, BETWEEN two literals of the subject's type, or a match of its pattern. A
	 * fact guard's constant is a value of the subject's value type, never of its contract: a guard tests any value its
	 * subject's SQL type holds, and a contract need hold no zero, and a numeric typmod no infinity.
	 */
	guardPredicate(
		guard: GuardDesc,
		subject: Typed,
		at: SourceLoc
	): { readonly predicate: Typed; readonly within: readonly [Exact, Exact] | undefined } {
		const v = valueType(subject.nominal)
		const compareTo = (literal: LiteralDesc): Typed =>
			this.literal(literal, this.adopt(v, "compare"), at)
		const bounded = (literal: LiteralDesc): Typed =>
			this.literal(literal, this.adopt(subject.nominal, "compare"), at)
		switch (guard.kind) {
			case "nonzero":
			case "nonnegative":
			case "positive":
			case "finite": {
				const tests = constantGuardTests(guard.kind, v)
				if (!tests.ok) {
					return stop("MalformedDescription", at, tests.error)
				}
				const [first, ...rest] = mapNonEmpty(tests.value, ([op, constant]) =>
					this.comparison(op, [subject, compareTo(constant)], at)
				)
				return {
					predicate: isNonEmpty(rest)
						? this.native(
								this.overload("and", [plainType("bool")], at),
								[first, ...rest],
								plainType("bool"),
								undefined,
								at,
								"and"
							)
						: first,
					within: undefined
				}
			}
			case "within": {
				if (!withinGuards(v.carrier)) {
					return stop(
						"MalformedDescription",
						at,
						`Num.within over a number, not ${typeLabel(subject.nominal)}`
					)
				}
				const lo = bounded(guard.low)
				const hi = bounded(guard.high)
				const low = lo.bounds === undefined ? undefined : pointOf(lo.bounds)
				const high = hi.bounds === undefined ? undefined : pointOf(hi.bounds)
				if (low === undefined || high === undefined) {
					return stop("MalformedDescription", at, "Num.within's bounds: two finite literals")
				}
				return { predicate: this.comparison("between", [subject, lo, hi], at), within: [low, high] }
			}
			case "matches":
				return {
					predicate: this.matchesOver(subject, { kind: "literal", value: guard.pattern }, at),
					within: undefined
				}
		}
	}

	cast(desc: Extract<ExprDesc<Located, R>, { readonly kind: "cast" }>, at: SourceLoc): Typed {
		const arg = this.term(desc.arg, childLoc(at, "cast"))
		const to = unwrap(this.env.fieldType(desc.to, childLoc(at, "cast", "to")))
		return this.castTo(arg, to, childLoc(at, "cast"))
	}

	/**
	 * Type.cast: a registered conversion of the value types, then the target's numeric typmod coercion, then a domain
	 * cast into a contract or a regex-refined text type, or the binary coercion that drops a typmod or a regex into the
	 * plain type, so the node delivered is of the type the cast names. A cast that changes nothing records nothing. Each
	 * step is defined everywhere or proved where it stands (castNode, domainCast); a conversion into a float rounds as
	 * IEEE 754 does. A cast into a computed numeric's bound narrower than numeric's own (pg.numeric.within) stands only
	 * where its operand's bounds prove every value within it, since nothing rounds into it.
	 */
	castTo(arg: Typed, to: ScalarType, at: SourceLoc): Typed {
		const target = baseOf(to)
		const from = valueType(arg.actual)
		if (from.carrier === "text" && target.carrier !== "text") {
			return this.parse(arg, to, at)
		}
		let value = arg
		if (from.carrier !== target.carrier) {
			const op = castOf(from.carrier, target.carrier)
			if (op === undefined) {
				return stop(
					"UnsupportedOperation",
					at,
					`cast: PostgreSQL has no cast from ${typeLabel(from)} to ${typeLabel(target)} that grizzle admits`
				)
			}
			value = this.castNode(
				arg,
				numericTypmodOf(target) === undefined ? target : anyNumeric,
				{ kind: "registered", op },
				at
			)
		} else if (target.carrier !== "numeric" && !compatibleCore(from, target)) {
			return stop(
				"UnsupportedOperation",
				at,
				`cast: ${typeLabel(from)} and ${typeLabel(target)} are different types with no cast between them`
			)
		}
		if (numericTypmodOf(target) !== undefined && !sameShape(valueType(value.actual), target)) {
			value = this.typmodCoercion(value, target, at)
		}
		const bound = numericBoundOf(target)
		if (
			bound !== undefined &&
			(bound.digits < numericMaxIntegerDigits || bound.scale < numericMaxFractionDigits) &&
			!(
				arg.bounds !== undefined &&
				arg.bounds.digits <= bound.digits &&
				arg.bounds.scale <= bound.scale
			)
		) {
			return stop(
				"UnsupportedOperation",
				at,
				`cast: into ${typeLabel(target)}, a computed numeric's bound, which no conversion rounds into: its operand's bounds prove no value of ${typeLabel(arg.actual)} within it; cast into pg.numeric, or into pg.numeric(p, s) under a guard that proves the value fits`
			)
		}
		if (isRefined(to) && !sameRefinement(arg.actual, to)) {
			return this.domainCast(value, to, checkedKind(arg.node), at)
		}
		const plain = value.actual.contract === undefined && to.contract === undefined
		const shaped =
			plain && !sameShape(value.actual, to)
				? this.castNode(value, to, { kind: "coercion" }, at)
				: value
		return this.restate(shaped, to, plain ? to : shaped.actual, shaped.facts)
	}

	/**
	 * A parse, Type.cast of a text into a type with a lexical form (scalar/lexical.ts): one cast node at the target's
	 * base, its numeric typmod included, since the form is the typmod's, defined where the text is a member of the form
	 * (the lexical precondition, which the lowering proves); then a domain cast into a contract over the base, which the
	 * parsed value's bounds, the base's own, prove or refuse. A base with no lexical form has no parse.
	 */
	parse(arg: Typed, to: ScalarType, at: SourceLoc): Typed {
		const target = baseOf(to)
		const op = castOf("text", target.carrier)
		if (op === undefined || lexicalTargetOf(target) === undefined) {
			return stop(
				"UnsupportedOperation",
				at,
				`cast: ${typeLabel(target)} has no lexical form a text parses into; the forms are an integer type's, numeric(p, s) with 0 <= s <= p and at most ${regexMaxRepeat} digits on either side of its point, double precision's, boolean's and date's; Text.parseDecimal(x) reads any decimal text into numeric exactly`
			)
		}
		if (!op.partial) {
			throw defect(
				`a parse, defined where its text is a member of its lexical form: ${typeLabel(target)}`
			)
		}
		const bounds = boundsOfType(target)
		const type = provedType(target, bounds)
		const value = this.emitAt(
			{
				kind: "proved",
				spec: {
					kind: "cast",
					cast: op.id,
					args: [arg.node],
					type,
					nonNull: "strict",
					volatility: op.volatility
				},
				proof: {
					kind: "judged",
					preconditions: op.totality.preconditions,
					operands: [arg],
					target,
					at,
					operation: `Type.cast(${nodeText(arg.node)}, ${typeLabel(target)})`
				}
			},
			type,
			bounds,
			factsOfType(target)
		)
		return isRefined(to)
			? this.domainCast(value, to, undefined, at)
			: this.restate(value, to, value.actual, value.facts)
	}

	/**
	 * A numeric value coerced into `target`'s typmod: a numeric literal as the literal of the value the coercion stores,
	 * rounded to the scale half away from zero (values/decimal.ts normalizeNumeric), so a contract over the typmod judges
	 * that literal (ContractLiteral); any other value, or a literal the precision cannot hold, by the typmod cast and its
	 * fits proof.
	 */
	typmodCoercion(value: Typed, target: ScalarType, at: SourceLoc): Typed {
		const literal = nodeLiteral(value.node)
		const coerced =
			literal?.kind === "numeric"
				? normalizeNumeric(Decimal.fromValue(literal.value), numericTypmodOf(target))
				: undefined
		if (coerced?.ok === true) {
			return this.literalNode({ kind: "numeric", value: coerced.value }, target, undefined)
		}
		return this.castNode(
			value,
			target,
			{ kind: "registered", op: registeredCast("numeric", "numeric") },
			at
		)
	}

	compute(desc: Extract<ExprDesc<Located, R>, { readonly kind: "compute" }>, at: SourceLoc): Typed {
		const { fn } = desc
		const here = childLoc(at, fn)
		if (!computeSpecs[fn].check) {
			this.refusedAt(
				"check",
				here,
				`${fn} in a contract predicate or row check: a check admits the operations the host evaluates for the ContractLiteral check, which are comparisons, between, in, boolean composition, abs, sign, arithmetic, Logic.cond, Logic.when, casts, charLength, octetLength, utf16Length, span endpoints, greatest and the set algebra`
			)
		}
		const expected = computeSpecs[fn].arity
		if (expected !== "variadic" && desc.args.length !== expected) {
			return stop(
				"MalformedDescription",
				here,
				`${expected} argument(s) for ${fn}, not ${desc.args.length}`
			)
		}
		const args = desc.args
		const arg = (i: number): ExprDesc<Located, R> => {
			const a = args[i]
			if (a === undefined) {
				return stop("MalformedDescription", here, `argument ${i + 1} for ${fn}`)
			}
			return a
		}
		switch (desc.fn) {
			case "add":
			case "sub":
			case "mul":
			case "div":
			case "mod":
				return this.arithmetic(desc.fn, arg(0), arg(1), here)
			case "neg":
			case "abs":
				return this.unary(desc.fn, this.term(arg(0), here), here)
			case "sign":
				return this.sign(this.term(arg(0), here), here)
			case "quot":
			case "rem": {
				const a = this.term(arg(0), here)
				const b = this.operand(arg(1), a, "arithmetic", here)
				this.requireNumeric(valueType(a.nominal), desc.fn, here)
				const op = this.overload(desc.fn, [valueType(a.nominal), valueType(b.nominal)], here)
				const bounds =
					a.bounds === undefined || b.bounds === undefined
						? undefined
						: desc.fn === "quot"
							? ofDigits(a.bounds.digits + b.bounds.scale, 0, {
									infinite: false,
									nan: a.bounds.nan || b.bounds.nan
								})
							: ofDigits(
									Math.min(a.bounds.digits, b.bounds.digits),
									Math.max(a.bounds.scale, b.bounds.scale),
									{
										infinite: false,
										nan: true
									}
								)
				return this.native(
					op,
					[a, b],
					this.resultType(op, bounds),
					bounds,
					here,
					`${spelling[desc.fn]}(${nodeText(a.node)}, ${nodeText(b.node)})`
				)
			}
			case "power": {
				const a = this.term(arg(0), here)
				const b = this.operand(arg(1), a, "arithmetic", here)
				const v = valueType(a.nominal)
				const op = this.overload("power", [v, v], here)
				const bounds = powerBounds(a, b, v)
				return this.native(
					op,
					[a, b],
					this.resultType(op, bounds),
					bounds,
					here,
					`Num.power(${nodeText(a.node)}, ${nodeText(b.node)})`
				)
			}
			case "round":
			case "trunc": {
				const a = this.term(arg(0), here)
				this.requireNumeric(a.nominal, desc.fn, here)
				const bounds = roundedBounds(
					a.bounds,
					desc.fn === "round" ? 1 : 0,
					Math.max(desc.scale ?? 0, 0)
				)
				if (desc.scale === undefined) {
					const op = this.overload(desc.fn, [valueType(a.nominal)], here)
					return this.native(op, [a], this.resultType(op, bounds), bounds, here, spelling[desc.fn])
				}
				const digits = this.literal(desc.scale, plainType("int4"), childLoc(here, "scale"))
				const op = this.overload(desc.fn, [valueType(a.nominal), plainType("int4")], here)
				return this.native(
					op,
					[a, digits],
					this.resultType(op, bounds),
					bounds,
					here,
					spelling[desc.fn]
				)
			}
			case "minScale": {
				const a = this.term(arg(0), here)
				this.requireNumeric(a.nominal, desc.fn, here)
				const op = this.overload("minScale", [anyNumeric], here)
				return this.native(
					op,
					[a],
					plainType("int4"),
					ofRange(0n, BigInt(numericMaxFractionDigits), String(numericMaxFractionDigits).length),
					here,
					`Num.minScale(${nodeText(a.node)})`
				)
			}
			case "numeric":
				return this.numeric(this.term(arg(0), here), here)
			case "ceil":
			case "floor":
			case "sqrt": {
				const a = this.term(arg(0), here)
				const v = valueType(a.nominal)
				if (desc.fn !== "sqrt") {
					this.requireNumeric(v, desc.fn, here)
				}
				const op = this.overload(desc.fn, [v], here)
				const bounds =
					desc.fn === "sqrt"
						? a.bounds === undefined
							? undefined
							: ofDigits(Math.ceil(a.bounds.digits / 2) + 1, numericMaxDisplayScale, {
									infinite: a.bounds.high.kind === "infinite",
									nan: true
								})
						: roundedBounds(a.bounds, 1, 0)
				return this.native(
					op,
					[a],
					this.resultType(op, bounds),
					bounds,
					here,
					`${spelling[desc.fn]}(${nodeText(a.node)})`
				)
			}
			case "gcd":
			case "lcm":
				return this.gcdLcm(desc.fn, arg(0), arg(1), here)
			case "least":
			case "greatest": {
				const [, ...rest] = args
				const a = this.term(arg(0), childLoc(here, 0))
				const others = rest.map((d, i) => {
					if (d.kind === "literal" && d.type === undefined) {
						return stop(
							"MalformedDescription",
							childLoc(here, i + 1),
							`${desc.fn} takes terms or parameters, never a bare literal`
						)
					}
					const x = this.operand(d, a, "compare", childLoc(here, i + 1))
					this.exactBeside(a, x, childLoc(here, i + 1))
					return x
				})
				const all = [a, ...others]
				const type = all.reduce((t, x) => commonType(t, x.nominal), a.nominal)
				if (!capsOf(type).includes("ordering")) {
					return stop(
						"UnsupportedOperation",
						here,
						`ordering: ${typeLabel(type)} has no ${desc.fn}`
					)
				}
				const converted = all.map((x) => this.convert(x, type, here))
				const op = this.commonOp(desc.fn, type, here)
				const [head, ...tail] = converted
				const combined = desc.fn === "least" ? leastBounds : greatestBounds
				const bounds = tail.reduce<Bounds | undefined>(
					(acc, x) =>
						acc === undefined || x.bounds === undefined ? undefined : combined(acc, x.bounds),
					head?.bounds
				)
				return this.emitAt(
					this.totalNode(op, converted, type, type),
					type,
					resultBounds(op, type, bounds),
					noFacts
				)
			}
			case "union":
			case "intersection":
			case "difference": {
				const [a, b] = this.sets(desc.fn, arg(0), arg(1), here)
				return this.emitAt(
					this.totalNode(this.commonOp(desc.fn, a.nominal, here), [a, b], a.nominal, a.nominal),
					a.nominal,
					undefined,
					noFacts
				)
			}
			case "subset":
			case "disjoint": {
				const [a, b] = this.sets(desc.fn, arg(0), arg(1), here)
				const op = this.overload(desc.fn, [a.actual, b.actual], here)
				return this.native(op, [a, b], plainType("bool"), undefined, here, spelling[desc.fn])
			}
			case "singleton":
				return this.singleton(this.term(arg(0), here), here)
			case "cardinality": {
				const a = this.set(desc.fn, this.term(arg(0), here), here)
				const op = this.overload("cardinality", [a.set.actual], here)
				const members = BigInt(a.roster.handles.length)
				return this.native(
					op,
					[a.set],
					plainType("int8"),
					ofRange(0n, members, String(members).length),
					here,
					spelling.cardinality
				)
			}
			case "widthBucket":
				return this.widthBucket(args, here)
			case "lower":
			case "upper": {
				const s = this.span(arg(0), here)
				const endpoint = s.span
				const op = this.overload(desc.fn, [s.typed.actual], here)
				return this.native(op, [s.typed], endpoint, boundsOfType(endpoint), here, desc.fn)
			}
			case "width":
				return this.width(arg(0), here)
			case "charLength":
			case "octetLength": {
				if (desc.fn === "charLength") {
					this.refusedAt(
						"query",
						here,
						"charLength in a query: it exists only in contract predicates and row checks, because queries have no text functions"
					)
				}
				const a = this.term(arg(0), here)
				if (baseOf(a.actual).carrier !== "text") {
					return stop(
						"MalformedDescription",
						here,
						`a text term for ${desc.fn}, not ${typeLabel(a.nominal)}`
					)
				}
				const op = this.overload(desc.fn, [a.actual], here)
				const bounds = ofRange(0n, BigInt(maxAllocSize), String(maxAllocSize).length)
				return this.native(op, [a], this.resultType(op, bounds), bounds, here, desc.fn)
			}
			case "utf16Length":
				return this.utf16Length(arg(0), here)
			case "concat":
				this.refusedAt(
					"query",
					here,
					"concat in a query beside an equation: a concatenation allocates its result, which PostgreSQL refuses past 1 GB, and a read never fails on a value; a query compares a text with a concatenation, which builds it only within the bytes one varlena holds, and every other concatenation stands in contract predicates, row checks, generated fields and folds"
				)
				return this.concat(arg(0), arg(1), here)
			case "startsWith":
			case "endsWith":
			case "contains": {
				const [a, b] = this.texts(desc.fn, arg(0), arg(1), here)
				const op = this.overload(desc.fn, [a.actual, b.actual], here)
				return this.native(op, [a, b], plainType("bool"), undefined, here, spelling[desc.fn])
			}
			case "matches":
				return this.matches(arg(0), arg(1), here)
			case "translate":
				return this.translate(arg(0), arg(1), arg(2), here)
			case "lowerAscii":
				return this.lowerAscii(arg(0), here)
			case "resolveReference":
				return this.resolveReference(arg(0), arg(1), here)
			case "isXsdPattern":
				return this.isXsdPattern(arg(0), here)
			case "collapse":
				return this.collapse(arg(0), here)
			case "parseDouble":
				return this.parseDouble(arg(0), here)
			case "parseDecimal":
				return this.parseDecimal(arg(0), here)
			case "sha256":
				return this.sha256(arg(0), here)
			case "floatBits":
				return this.floatBits(arg(0), here)
			case "textDocument":
				return this.textDocument(args, here)
			case "websearchMatches":
			case "plainMatches":
			case "websearchRank":
			case "plainRank":
			case "websearchRankCd":
			case "plainRankCd":
				return this.textSearch(desc.fn, arg(0), arg(1), here)
			case "netWithin":
			case "netStrictlyWithin":
			case "netOverlaps":
				return this.netContainment(desc.fn, arg(0), arg(1), here)
			case "wall":
				return this.wall(arg(0), arg(1), here)
			case "epochDay":
				return this.epochDay(arg(0), here)
			case "dateOfEpochDay":
				return this.dateOfEpochDay(arg(0), here)
			case "cosineDistance": {
				const a = this.term(arg(0), here)
				const b = this.operand(arg(1), a, "compare", here)
				const v = baseOf(a.nominal)
				if (v.carrier !== "vector") {
					return stop(
						"UnsupportedOperation",
						here,
						"vectorDistance: cosine distance is defined only over a vector"
					)
				}
				const op = this.overload("cosineDistance", [v, v], here)
				return this.native(
					op,
					[a, b],
					this.resultType(op, undefined),
					boundsOfType(plainType("float8")),
					here,
					"cosineDistance"
				)
			}
		}
	}

	/**
	 * Num.numeric: PostgreSQL's conversion of a number into numeric, `x::numeric`, a computed numeric typed by what
	 * the conversion proves of it: a registered cast from an integer, money, an exact value or a float, defined on every
	 * value (castNode); the binary coercion from a numeric(p, s), its typmod dropped, into its value's proved bound
	 * (numericOf); a computed numeric itself. A text is no number: its cast into numeric is a parse, defined only on its
	 * lexical form, which Type.cast states with its proof, so Num.numeric refuses it whatever the operand.
	 */
	numeric(a: Typed, at: SourceLoc): Typed {
		const from = valueType(a.actual)
		if (isComputedNumeric(from)) {
			return a
		}
		if (from.carrier === "numeric") {
			return this.castNode(a, numericOf(a.bounds), { kind: "coercion" }, at)
		}
		const op = castOf(from.carrier, "numeric")
		return op === undefined || op.partial
			? stop(
					"UnsupportedOperation",
					at,
					`Num.numeric: a conversion of a number into numeric, and ${typeLabel(from)} is no number; a text becomes one by Text.parseDecimal(x), or by Type.cast(x, T) into a type with a lexical form, under Logic.when(Text.matches(x, lexicalForm(T)), …)`
				)
			: this.castNode(a, anyNumeric, { kind: "registered", op }, at)
	}

	requireNumeric(t: ScalarType, fn: string, at: SourceLoc): void {
		if (baseOf(t).carrier !== "numeric") {
			stop("MalformedDescription", at, `a numeric term for ${fn}, not ${typeLabel(t)}`)
		}
	}

	/**
	 * +, -, *, / and % over one numeric family: integers and money exactly (exact integers and exact money, bounded by
	 * their operands' digits), integer division truncating over the exact integers, numeric as PostgreSQL computes it
	 * within its digit bounds, floats as IEEE 754, which with money a check refuses. A divisor is proved nonzero by its
	 * facts, except a float's, whose quotient by zero is defined (registry.ts Totality ieee); the caller's divisor is
	 * judged, the exact value it is widened into keeping its facts (nativeJudged).
	 */
	arithmetic(
		fn: "add" | "sub" | "mul" | "div" | "mod",
		left: ExprDesc<Located, R>,
		right: ExprDesc<Located, R>,
		at: SourceLoc
	): Typed {
		const a0 = this.term(left, at)
		const b0 = this.operand(right, a0, "arithmetic", at)
		const va = valueType(a0.nominal)
		if (isFloat(va) || va.carrier === "money" || va.carrier === "exactMoney") {
			this.refusedAt("check", at, floatArithmeticText(fn, va))
		}
		const operation = `${spelling[fn]}(${nodeText(a0.node)}, ${nodeText(b0.node)})`
		if (va.carrier === "date") {
			return stop(
				"UnsupportedOperation",
				at,
				`${fn}: PostgreSQL has no ${fn} over ${typeLabel(a0.nominal)}, ${typeLabel(b0.nominal)} that grizzle admits`
			)
		}
		if (fn === "div" && exactFamily(va) === "exactInteger") {
			const a = this.widenExact(a0, "exactInteger", at)
			const b = this.widenExact(b0, "exactInteger", at)
			const op = this.overload("div", [a.actual, b.actual], at)
			const dividend = this.boundsOf(a, at)
			const bounds =
				(b.bounds === undefined ? undefined : quotientBounds(dividend, b.bounds)) ??
				ofDigits(dividend.digits, 0, { infinite: false, nan: false })
			return this.nativeJudged(
				op,
				[a, b],
				[a0, b0],
				this.resultType(op, bounds),
				bounds,
				at,
				operation
			)
		}
		const [a, b] = this.exactPair(a0, b0, at)
		const op = this.overload(fn, [valueType(a.nominal), valueType(b.nominal)], at)
		const bounds = arithmeticBounds(fn, a.bounds, b.bounds)
		return this.nativeJudged(
			op,
			[a, b],
			[a0, b0],
			this.resultType(op, bounds),
			bounds,
			at,
			operation
		)
	}

	/**
	 * neg and abs: an integer's exactly, a numeric's and a float's as PostgreSQL computes them, exactly. A negation keeps
	 * its operand's facts but its sign (negationFacts).
	 */
	unary(fn: "neg" | "abs", a: Typed, at: SourceLoc): Typed {
		const op = this.overload(fn, [valueType(a.nominal)], at)
		const bounds =
			a.bounds === undefined ? undefined : fn === "neg" ? negBounds(a.bounds) : absBounds(a.bounds)
		const type = this.resultType(op, bounds)
		const result = this.native(op, [a], type, bounds, at, spelling[fn])
		return fn === "neg"
			? this.restate(
					result,
					type,
					result.actual,
					Object.freeze({ ...negationFacts(a.facts), ...result.facts })
				)
			: result
	}

	/**
	 * sign returns the operand's value type, unconstrained. PostgreSQL has sign(numeric) and sign(double precision) only,
	 * whose results carry no typmod (a numeric(p, s) operand's sign is a numeric, 1 and not 1.00), so sign over an integer
	 * type is sign(x::numeric) cast back, proved to fit since its value is -1, 0 or 1; over real sign(x::double precision)
	 * rounded back; over an exact integer the exact sign.
	 */
	sign(a: Typed, at: SourceLoc): Typed {
		const v = valueType(a.actual)
		const carrier = v.carrier
		switch (carrier) {
			case "numeric":
			case "float8":
			case "exactInteger": {
				const op = this.overload("sign", [v], at)
				const bounds = signBoundsOver(carrier, a.bounds)
				return this.native(op, [a], this.resultType(op, bounds), bounds, at, spelling.sign)
			}
			case "int2":
			case "int4":
			case "int8":
				return this.signThrough(
					a,
					v,
					"numeric",
					registeredCast(carrier, "numeric"),
					registeredCast("numeric", carrier),
					at
				)
			case "float4":
				return this.signThrough(
					a,
					v,
					"float8",
					registeredCast("float4", "float8"),
					registeredCast("float8", "float4"),
					at
				)
			case "money":
			case "exactMoney":
			case "bool":
			case "uuid":
			case "date":
			case "inet":
			case "cidr":
			case "text":
			case "bytes":
			case "sha256":
			case "code":
			case "bits":
			case "range4":
			case "range8":
			case "rangeDate":
			case "vector":
			case "tsvector":
				return stop("UnsupportedOperation", at, `sign: PostgreSQL has no sign over ${typeLabel(v)}`)
		}
	}

	/** sign over a carrier PostgreSQL has none of: the operand widened to `via` by `widen`, its sign cast back by `back`. */
	signThrough(
		a: Typed,
		v: ScalarType,
		via: "numeric" | "float8",
		widen: CastOp,
		back: CastOp,
		at: SourceLoc
	): Typed {
		const wide = this.castNode(
			a,
			via === "numeric" ? anyNumeric : plainType(via),
			{ kind: "registered", op: widen },
			at
		)
		const op = this.overload("sign", [wide.actual], at)
		const signBounds = ofRange(-1n, 1n, 1)
		const s = this.native(
			op,
			[wide],
			this.resultType(op, signBounds),
			signBounds,
			at,
			spelling.sign
		)
		const signed = this.castNode(s, v, { kind: "computed", op: back }, at)
		return this.restate(signed, valueType(a.nominal), signed.actual, signed.facts)
	}

	/**
	 * gcd and lcm: over integer and bigint exact (gcd(-2^63, 0) is 2^63), over smallint and exact integers the exact
	 * integers' over the widened operands, over numeric numeric's, at the larger of the operands' scales S. Their integer
	 * digits, for operands below 10^da and 10^db: x·10^S and y·10^S are integers X and Y, gcd(x, y) is gcd(X, Y)/10^S, at
	 * most the larger of |x| and |y|, so below 10^max(da, db); lcm(x, y) is lcm(X, Y)/10^S, at most |X·Y|/10^S, so below
	 * 10^(da + S + db + S)/10^S = 10^(da + db + S). The lcm bound is reached: lcm(999.99, 999.98) is 99997000.02, eight
	 * integer digits from two of three.
	 */
	gcdLcm(
		fn: "gcd" | "lcm",
		left: ExprDesc<Located, R>,
		right: ExprDesc<Located, R>,
		at: SourceLoc
	): Typed {
		if (right.kind === "literal" && right.type === undefined) {
			return stop("MalformedDescription", at, `${fn} takes a term or a parameter, never a literal`)
		}
		const a0 = this.term(left, at)
		const b0 = this.operand(right, a0, "arithmetic", at)
		const widen =
			valueType(a0.nominal).carrier === "int2" ||
			valueType(a0.nominal).carrier === "exactInteger" ||
			valueType(b0.nominal).carrier === "exactInteger"
		const a = widen ? this.widenExact(a0, "exactInteger", at) : a0
		const b = widen ? this.widenExact(b0, "exactInteger", at) : b0
		const op = this.overload(fn, [valueType(a.nominal), valueType(b.nominal)], at)
		const ba = this.boundsOf(a, at)
		const bb = this.boundsOf(b, at)
		const da = ba.digits
		const db = bb.digits
		const scale = Math.max(ba.scale, bb.scale)
		const bounds = ofDigits(fn === "gcd" ? Math.max(da, db) : da + db + scale, scale, {
			infinite: false,
			nan: valueType(a.nominal).carrier === "numeric"
		})
		return this.native(op, [a, b], this.resultType(op, bounds), bounds, at, spelling[fn])
	}

	widthBucket(args: ReadonlyArray<ExprDesc<Located, R>>, at: SourceLoc): Typed {
		const [x, low, high, count] = args
		if (x === undefined || low === undefined || high === undefined || count === undefined) {
			return stop("MalformedDescription", at, "4 argument(s) for widthBucket")
		}
		const nx = this.term(x, childLoc(at, "operand"))
		const nl = this.term(low, childLoc(at, "low"))
		const nh = this.term(high, childLoc(at, "high"))
		for (const [t, which] of [
			[nx, "operand"],
			[nl, "low"],
			[nh, "high"]
		] as const) {
			this.requireNumeric(t.nominal, `widthBucket's ${which}`, at)
		}
		const int4 = plainType("int4")
		/** The count, an int4: a bare literal adopts it, any other term is an integer, int2 widened. */
		let nc: Typed
		if (count.kind === "literal" && count.type === undefined) {
			nc = this.literal(count.value, int4, childLoc(at, "count"))
		} else {
			nc = this.term(count, childLoc(at, "count"))
			const c = valueType(nc.nominal).carrier
			if (c === "int2") {
				nc = this.castNode(nc, int4, { kind: "registered", op: registeredCast("int2", "int4") }, at)
			} else if (c !== "int4") {
				return stop(
					"MalformedDescription",
					childLoc(at, "count"),
					`an integer count, not ${typeLabel(nc.nominal)}`
				)
			}
		}
		const op = this.overload("widthBucket", [anyNumeric, anyNumeric, anyNumeric, int4], at)
		const bucket = ofRange(0n, BigInt(int4Max), int4Digits)
		return this.native(
			op,
			[nx, nl, nh, nc],
			this.resultType(op, bucket),
			bucket,
			at,
			spelling.widthBucket
		)
	}

	span(
		desc: ExprDesc<Located, R>,
		at: SourceLoc
	): { readonly typed: Typed; readonly span: ScalarType } {
		const s = this.term(desc, at)
		const info = spanOf(s.nominal)
		if (info === undefined) {
			return stop("MalformedDescription", at, `a span term, not ${typeLabel(s.nominal)}`)
		}
		return { typed: s, span: info.endpoint }
	}

	/** width(s) = upper(s) - lower(s), the exact difference of its endpoints, which never overflows. */
	width(desc: ExprDesc<Located, R>, at: SourceLoc): Typed {
		const s = this.span(desc, at)
		const endpoint = valueType(s.span)
		const point = boundsOfType(endpoint)
		const upper = this.native(
			this.overload("upper", [s.typed.actual], at),
			[s.typed],
			endpoint,
			point,
			at,
			"upper"
		)
		const lower = this.native(
			this.overload("lower", [s.typed.actual], at),
			[s.typed],
			endpoint,
			point,
			at,
			"lower"
		)
		const op = this.overload("sub", [endpoint, endpoint], at)
		const bounds =
			upper.bounds !== undefined && lower.bounds !== undefined
				? subBounds(upper.bounds, lower.bounds)
				: undefined
		return this.native(op, [upper, lower], this.resultType(op, bounds), bounds, at, spelling.width)
	}
}

/** The bounds of an arithmetic result over its operands' bounds: exact interval arithmetic, digits for a quotient. */
const arithmeticBounds = (
	fn: "add" | "sub" | "mul" | "div" | "mod",
	a: Bounds | undefined,
	b: Bounds | undefined
): Bounds | undefined => {
	if (a === undefined || b === undefined) {
		return undefined
	}
	switch (fn) {
		case "add":
			return addBounds(a, b)
		case "sub":
			return subBounds(a, b)
		case "mul":
			return mulBounds(a, b)
		case "div":
			return ofDigits(a.digits + b.scale + 1, numericMaxDisplayScale, {
				infinite: a.low.kind === "infinite" || a.high.kind === "infinite",
				nan: a.nan || b.nan
			})
		case "mod":
			return ofDigits(Math.min(a.digits, b.digits), Math.max(a.scale, b.scale), {
				infinite: false,
				nan: a.nan || b.nan
			})
	}
}

/**
 * A rounding's result at `scale` fractional digits: the operand's digits, and one more where it may carry. A value below
 * one unit at that scale rounds to zero or to the unit itself, so its digits count from the unit's.
 */
const roundedBounds = (a: Bounds | undefined, carry: number, scale: number): Bounds | undefined =>
	a === undefined
		? undefined
		: ofDigits(Math.max(a.digits, -scale) + carry, scale, {
				infinite: a.low.kind === "infinite" || a.high.kind === "infinite",
				nan: a.nan
			})

/**
 * How a cast moves its operand's value, which every cast proof reads (castBounds, keptFacts): a binary coercion and an
 * exact conversion (an integer, an exact integer or money into a wider carrier, numeric or money, numeric into bare
 * numeric) not at all; a rounding into an integer, money or a numeric typmod's scale by less than one unit at that
 * scale; a float into numeric to its significant digits (cast.ts floatNumericDigits), by up to half a unit in the last
 * of them, which may be many units; and a conversion into a float to the float's precision.
 */
type Conversion =
	| { readonly kind: "exact" }
	| { readonly kind: "rounding"; readonly scale: number }
	| { readonly kind: "significant"; readonly digits: number }
	| { readonly kind: "intoFloat" }

/** The fractional digits a rounding conversion into `target` keeps: an integer's none, money's two, a typmod's own. */
const roundingScale = (target: ScalarType): number => {
	const t = baseOf(target)
	switch (t.carrier) {
		case "money":
		case "exactMoney":
			return moneyFractionDigits
		case "numeric":
			return t.typmod === undefined ? t.bound.scale : t.typmod.scale
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
			return 0
	}
}

const conversionOf = (from: ScalarType, to: ScalarType, how: CastHow): Conversion => {
	const target = baseOf(to)
	if (isFloat(target)) {
		return { kind: "intoFloat" }
	}
	if (how.kind === "coercion") {
		return { kind: "exact" }
	}
	const source = valueType(from).carrier
	switch (source) {
		case "float4":
		case "float8":
			return target.carrier === "numeric"
				? { kind: "significant", digits: floatNumericDigits[source] }
				: { kind: "rounding", scale: roundingScale(to) }
		case "numeric":
			return target.carrier === "numeric" && numericTypmodOf(target) === undefined
				? { kind: "exact" }
				: { kind: "rounding", scale: roundingScale(to) }
		case "int2":
		case "int4":
		case "int8":
		case "exactInteger":
		case "money":
		case "exactMoney":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
			return { kind: "exact" }
	}
}

/**
 * The ends of a cast's result over its operand's finite ends [low, high], as `conversion` moves a value. A rounding is
 * monotone, so an end already at the target's scale is its own image, and another moves by less than one unit there.
 */
const convertedEnds = (
	ends: readonly [Exact, Exact],
	conversion: Exclude<Conversion, { readonly kind: "intoFloat" }>
): readonly [Exact, Exact] => {
	const [low, high] = ends
	switch (conversion.kind) {
		case "exact":
			return ends
		case "rounding": {
			const unit = exactOf(1n, conversion.scale)
			const kept = (x: Exact): boolean => scaleOfExact(x) <= conversion.scale
			return [kept(low) ? low : minus(low, unit), kept(high) ? high : minus(high, negExact(unit))]
		}
		case "significant":
			return [significantRound(low, conversion.digits), significantRound(high, conversion.digits)]
	}
}

/**
 * A cast's result bounds: the target type's, cut to the operand's interval as its conversion moves it; an operand with
 * an infinite edge (a float), which has no finite interval, keeps its own integer and fraction digits within the
 * target's, a conversion moving no magnitude past them; a conversion into a float keeps its target's.
 */
const castBounds = (a: Bounds, conversion: Conversion, to: ScalarType): Bounds | undefined => {
	const target = boundsOfType(to)
	if (target === undefined || conversion.kind === "intoFloat") {
		return target
	}
	const ends = finiteEnds(a)
	if (ends === undefined) {
		return ofDigits(Math.min(a.digits, target.digits), Math.min(a.scale, target.scale), {
			infinite: isInfinite(a) && isInfinite(target),
			nan: a.nan && target.nan
		})
	}
	const [low, high] = convertedEnds(ends, conversion)
	return refine(target, { kind: "within", low, high })
}

/** Whether bounds admit an infinity: an edge of theirs is infinite. */
const isInfinite = (b: Bounds): boolean => b.low.kind === "infinite" || b.high.kind === "infinite"

/**
 * The facts a negation keeps of its operand's, each from its source: -x is finite where x is, and zero only where x is;
 * x never below zero makes -x never above it, which no fact states, so that one is not kept.
 */
const negationFacts = (facts: FactSet): FactSet => {
	const { nonnegative: _flipped, ...kept } = facts
	return Object.freeze(kept)
}

/**
 * The facts a cast keeps: one that moves no value keeps every one; one that rounds keeps all but nonzero, which
 * rounding toward zero loses; a conversion into a float keeps none.
 */
const keptFacts = (
	arg: { readonly facts: FactSet },
	conversion: Conversion,
	to: ScalarType
): FactSet => {
	if (conversion.kind === "intoFloat") {
		return noFacts
	}
	const { nonzero: _lost, ...rest } = arg.facts
	return Object.freeze({ ...(conversion.kind === "exact" ? arg.facts : rest), ...factsOfType(to) })
}

/**
 * An upper bound on log10 x^y over a base interval [bLow, bHigh] never below zero and an exponent interval [eLow, eHigh],
 * where it is above zero: a result below 1 is an underflow at worst, which PostgreSQL rounds to zero without raising.
 * It grows past 1 only by the largest x raised to the largest positive y, x < 10^d for d the integer digits of the
 * interval's ends, or by the least x raised to the most negative y, x at least 10^-s for s the fractional digits of a
 * low end above zero. Over a low end of zero a negative exponent's result has no bound: Infinity.
 */
export const powerWeight = (bLow: Exact, bHigh: Exact, eLow: Exact, eHigh: Exact): number => {
	const up = Math.max(digitsOfExact(bLow), digitsOfExact(bHigh))
	const rising = compareExact(eHigh, zero) > 0 ? weightOf(magnitudeAtLeast(eHigh), up) : 0
	if (compareExact(eLow, zero) >= 0 || compareExact(bLow, oneExact) >= 0) {
		return rising
	}
	const falling =
		compareExact(bLow, zero) > 0
			? weightOf(magnitudeAtLeast(eLow), scaleOfExact(bLow))
			: Number.POSITIVE_INFINITY
	return Math.max(rising, falling)
}

/** An exponent's magnitude times a base's digits: zero where either is zero, so an infinite exponent over no digit adds none. */
const weightOf = (exponent: number, digits: number): number =>
	exponent === 0 || digits === 0 ? 0 : exponent * digits

/**
 * power's result bounds where its premises hold: a float's its type's; a numeric's integer digits one past the whole
 * part of powerWeight's bound w. The result reaches 10^w itself, so w digits never suffice: x^0 and 1^y are 1, one
 * integer digit where w is 0, and a least base 10^-s raised to -y is 10^(s·y) exactly.
 */
const powerBounds = (
	a: { readonly bounds: Bounds | undefined },
	b: { readonly bounds: Bounds | undefined },
	v: ScalarType
): Bounds | undefined => {
	if (isFloat(v)) {
		return boundsOfType(v)
	}
	const ea = a.bounds === undefined ? undefined : finiteEnds(a.bounds)
	const eb = b.bounds === undefined ? undefined : finiteEnds(b.bounds)
	if (ea === undefined || eb === undefined) {
		return undefined
	}
	const digits = Math.floor(powerWeight(ea[0], ea[1], eb[0], eb[1])) + 1
	return ofDigits(Math.min(digits, numericMaxIntegerDigits), numericMaxDisplayScale, {
		infinite: false,
		nan: true
	})
}

/** A Logic.when guard whose test compares its subject's value with constants alone (constantGuardTests). */
export type ConstantGuard = "nonzero" | "nonnegative" | "positive" | "finite"

/** Each constant guard's builder, as its diagnostics name it. */
export const constantGuardNames: { readonly [G in ConstantGuard]: string } = {
	nonzero: spelling.nonzero,
	nonnegative: spelling.nonnegative,
	positive: spelling.positive,
	finite: spelling.isFinite
}

/** Zero of a number's carrier; none of another carrier, whose values a sign guard compares with no zero. */
const zeroOf = (carrier: Carrier): LiteralDesc | undefined => {
	switch (carrier) {
		case "int8":
		case "exactInteger":
			return 0n
		case "numeric":
			return Decimal.zero
		case "money":
		case "exactMoney":
			return Money.zero
		case "int2":
		case "int4":
		case "float4":
		case "float8":
			return 0
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "text":
		case "bytes":
		case "sha256":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "tsvector":
			return undefined
	}
}

/**
 * The values of a numeric's or a float's carrier that are not finite, each a literal of the carrier: its negative and its
 * positive infinity and NaN; none of another carrier, finite by its type.
 */
const specialsOf = (
	carrier: Carrier
):
	| { readonly low: LiteralDesc; readonly high: LiteralDesc; readonly nan: LiteralDesc }
	| undefined =>
	carrier === "numeric"
		? { low: Decimal.negativeInfinity, high: Decimal.infinity, nan: Decimal.nan }
		: carrier === "float4" || carrier === "float8"
			? { low: { float: "-Infinity" }, high: { float: "Infinity" }, nan: { float: "NaN" } }
			: undefined

/**
 * The comparisons that hold of exactly the finite values of `value`'s type, by the values its type holds that are not
 * (carrierBounds): `> -Infinity AND < Infinity` where it holds the infinities, as a float and a numeric of no typmod do,
 * and NaN, which PostgreSQL orders above them; `<> 'NaN'` where it holds NaN alone, as numeric(p, s) does, its typmod
 * refusing an infinity (PostgreSQL 19's numeric.c apply_typmod_special: "A field with precision %d, scale %d cannot
 * hold an infinite value"), so its guard compares it with no value it cannot hold; none where its type proves it finite
 * (carrierFacts), as numeric(p, 0)'s does, which holds neither, and every type of another carrier's.
 */
const finiteTests = (
	value: ScalarType
): NonEmptyReadonlyArray<readonly [CompareOp, LiteralDesc]> | undefined => {
	const specials = specialsOf(baseOf(value).carrier)
	const bounds = carrierBounds(baseOf(value))
	if (specials === undefined || bounds === undefined || carrierFacts(value).finite !== undefined) {
		return undefined
	}
	return isInfinite(bounds)
		? [
				["gt", specials.low],
				["lt", specials.high]
			]
		: [["ne", specials.nan]]
}

/**
 * The comparisons a constant guard tests its subject's value by, each with its constant, a value of the subject's value
 * carrier: `<> 0`, `>= 0` and `> 0` of a number, and of a numeric or a float the comparisons that hold of exactly its
 * type's finite values (finiteTests); or the refusal of a subject of another carrier, or of a type that is finite by
 * itself. What a guard's builder records (builders.ts factGuard) and what a Logic.when's lowering tests
 * (Typing.guardPredicate), one table.
 */
export const constantGuardTests = (
	guard: ConstantGuard,
	value: ScalarType
): Result.Result<NonEmptyReadonlyArray<readonly [CompareOp, LiteralDesc]>, string> => {
	if (guard === "finite") {
		const tests = finiteTests(value)
		return tests === undefined
			? Result.err(
					`Num.isFinite over a term that may be NaN or infinite, not ${typeLabel(value)}, which is finite by its type`
				)
			: Result.ok(tests)
	}
	const constant = zeroOf(value.carrier)
	const op = guard === "nonzero" ? "ne" : guard === "nonnegative" ? "ge" : "gt"
	return constant === undefined
		? Result.err(`${constantGuardNames[guard]} over a number, not ${typeLabel(value)}`)
		: Result.ok([[op, constant]])
}

/**
 * Same carrier, numeric typmod, computed numeric bound, exact digit bound, contract name and regex refinement: every
 * field a conversion changes.
 */
const sameShape = (a: ScalarType, b: ScalarType): boolean => {
	if (a.carrier !== b.carrier) {
		return false
	}
	const ta = numericTypmodOf(a)
	const tb = numericTypmodOf(b)
	if (ta?.precision !== tb?.precision || ta?.scale !== tb?.scale) {
		return false
	}
	const ba = numericBoundOf(a)
	const bb = numericBoundOf(b)
	if (ba?.digits !== bb?.digits || ba?.scale !== bb?.scale) {
		return false
	}
	if (familyDigits(a) !== familyDigits(b)) {
		return false
	}
	if (a.contract?.name !== b.contract?.name) {
		return false
	}
	return sameRegex(textOf(a), textOf(b))
}

/** Whether a value already carries the refinement a cast target names: the same contract, or the same regex. */
export const sameRefinement = (a: ScalarType, to: ScalarType): boolean => {
	const { contract } = to
	if (contract !== undefined) {
		return a.contract?.name === contract.name && meets(a, to)
	}
	return sameShape(a, to)
}

const compatibleCore = (a: ScalarType, b: ScalarType): boolean => meets(valueType(a), valueType(b))

/**
 * Whether a description is a bare reference: a variable, a row's field, a contract's VALUE or a parent's column, the
 * leaf kinds, which no other arm of a description holds.
 */
const isReference = <R extends Refs>(desc: ExprDesc<Located, R>): desc is LeafDesc<R> =>
	desc.kind === "var" || desc.kind === "field" || desc.kind === "value" || desc.kind === "parent"

/** A description read past its guarded nodes: the term a Logic.when branch's parameter is (ir/desc.ts GuardedDesc). */
const unguarded = <R extends Refs>(desc: ExprDesc<Located, R>): ExprDesc<Located, R> =>
	desc.kind === "guarded" ? unguarded(desc.arg) : desc

/** The typing of a term by `f`, from the scope of no Logic.when, with the tape it recorded. */
const typed = <R extends Refs>(
	env: TypingEnv<R>,
	f: (t: Typing<R>) => Typed
): Result.Result<TermTyping<R>, CompileError> => {
	const tape: Array<TapeEntry<R>> = []
	return Result.map(
		catchRefusal(() => f(new Typing(env, heldScope(env.held), tape))),
		(root): TermTyping<R> => ({ root, tape })
	)
}

/**
 * The site-free typing of a scalar description, in one pass that emits nothing.
 *
 * An ExprDesc<Located, R>, as a builder records it or a description carries it, is resolved against the static
 * overload registry: each node's type (nominal and actual), what is proved of its values (bounds and facts), its chosen
 * overload, the conversions between its operands and it, and the type a literal adopts. The environment supplies the
 * leaves (rule variables, a check's fields, a contract's VALUE, a builder's placeholders), the parameters, the
 * descriptors, the closed relations and the text analysis (TextAnalysis), so the same typing serves a builder, which
 * types its term before it knows where the term stands, and every site a term is compiled at. Typing follows
 * PostgreSQL's overload resolution, never JavaScript's number-versus-bigint distinction:
 *
 * - Operands of one operation meet (types.ts meets): a contract and its bare base never meet without Type.base, and
 *   arithmetic over a contract yields the base; an exact value meets the plain values of its family, widened exactly.
 * - A literal never stands first and has no type of its own: it adopts the type of the term it meets. In a comparison,
 *   an IN list, BETWEEN bounds or a conditional's branch it adopts that term's contract or regex refinement; in
 *   arithmetic it adopts the term's value type, the unconstrained base, opposite an exact value its family's plain
 *   carrier.
 * - A parameter is a term of its declared type, first included, which its caller binds; a typed constant
 *   (Type.literal) is a term of its stated type.
 * - When both branches of Logic.cond are literals, number literals are integer and every other literal is its own
 *   host type.
 *
 * What the term's lowering does beside it is recorded on the tape in the order it does it (TapeEntry): the nodes it
 * emits, each with what it judges first (TypedNode), the refusals of one site, and the judgements of every compiled
 * site, a literal's ContractLiteral check and a numeric bound past numeric's own digits (ResourceBound). Nothing here
 * depends on where the term is compiled: a typing refuses only a description no site types.
 *
 * Types a term: a scalar expression, a reference, or a typed literal.
 */
export const typeOf = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	env: TypingEnv<R>
): Result.Result<TermTyping<R>, CompileError> => typed(env, (t) => t.whole(desc, env.loc))

/** Types a predicate: a boolean term. */
export const typePredicate = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	env: TypingEnv<R>
): Result.Result<TermTyping<R>, CompileError> => typed(env, (t) => t.predicate(desc, env.loc))

/**
 * Types a term a function returns unchanged, the argument of min or max: delivered with the contract the term has.
 * Where its node computes it without that contract, a parameter bound as its base or a Type.base whose node still
 * carries the contract it drops, the node is converted into the term's own type, as LEAST and GREATEST convert their
 * operands (Typing.convert).
 */
export const typeReturned = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	env: TypingEnv<R>
): Result.Result<TermTyping<R>, CompileError> =>
	typed(env, (t) => {
		const x = t.whole(desc, env.loc)
		return x.actual.contract?.name === x.nominal.contract?.name
			? x
			: t.convert(x, x.nominal, env.loc)
	})

/**
 * Types a child of a predicate another package lowers (r.allen, r.pointIn), as that package reads it, at `at`: a term,
 * or a bare literal at its own value's type, under the Logic.whens the predicate stands in (`scope`).
 */
export const typeWithin = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	env: TypingEnv<R>,
	scope: ReadonlyArray<WhenScope>,
	at: SourceLoc
): Result.Result<TermTyping<R>, CompileError> => {
	const tape: Array<TapeEntry<R>> = []
	return Result.map(
		catchRefusal(() => new Typing(env, [...heldScope(env.held), ...scope], tape).lower(desc, at)),
		(root): TermTyping<R> => ({ root, tape })
	)
}
