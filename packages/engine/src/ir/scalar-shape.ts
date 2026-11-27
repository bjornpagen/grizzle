import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import type { TextBounds } from "@bjornpagen/grizzle-text/regex/dfa"
import type { Patterns } from "@bjornpagen/grizzle-text/regex/parse"
import { floatSpecialNames } from "#compiler/core/canonical.ts"
import { isSha256Text } from "#compiler/core/digest.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { admittedFunctionDigest } from "#compiler/core/fingerprint.ts"
import { functionVolatilities } from "#compiler/core/function.ts"
import { type DeclaredName, nameFaultText, parseDeclaredName } from "#compiler/core/identity.ts"
import { ExprId, NodeId, ParamId } from "#compiler/core/ids.ts"
import {
	MoneyText,
	type MoneyValue,
	VectorText,
	moneyTag,
	vectorTag
} from "#compiler/ir/carriers.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { type CalendarDate, toCalendarDate } from "#compiler/ir/date.ts"
import { DecimalText, type DecimalValue, decimalTag } from "#compiler/ir/decimal.ts"
import {
	type CalledFunction,
	callNonNulls,
	type ColumnRef,
	definedOp,
	type ExprDeps,
	type ExprTable,
	type TypedLiteral,
	OpId,
	partialOp,
	patternTableOf,
	predicateProblems,
	type RangeOpParts,
	rangeOp,
	rangeOpCodes,
	type TableExpr,
	type TableExprOf,
	type VariantOp
} from "#compiler/ir/expr.ts"
import {
	admitSpelling,
	diagnosticText,
	matchFlags,
	type PatternValue
} from "#compiler/ir/pattern.ts"
import {
	type Exact,
	type Fact,
	type FactSource,
	factNames,
	factsSorted,
	type NativeProof,
	type OperandIndex,
	type OperandPremise,
	type OperationProof,
	type Precondition,
	type PreconditionProof,
	parseForms
} from "#compiler/ir/proof.ts"
import {
	type Capability,
	type CapabilitySet,
	type Carrier,
	type NumericBound,
	type NumericTypmod,
	type PatternCheck,
	type RegexCheck,
	RegexKey,
	type RegexRef,
	inRosterOrder,
	isRosterSubset,
	Roster,
	type ScalarType,
	type SpanCarrier,
	type SpanInfo,
	type TextInfo,
	type TextLanguage,
	type VariantArm,
	type VariantInfo,
	type VectorTypmod,
	capabilities,
	carriers,
	isDateType,
	isExactValue,
	isNumericValue,
	isSpanCarrier,
	spanCarriers
} from "#compiler/ir/scalar.ts"
import { type TextSearchConfiguration, textSearchConfigurations } from "#compiler/ir/search.ts"
import * as S from "#compiler/ir/shape.ts"
import {
	numericMaxFractionDigits,
	numericMaxIntegerDigits,
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale,
	numericOwnBound
} from "#compiler/scalar/values/fault.ts"
import { type Cidr, type Inet, isCidrText, isInetText } from "#compiler/scalar/values/net.ts"

/**
 * The wire form the decoder reads before the carrier's rules: every meaning-changing field optional, nested
 * descriptors already decoded.
 */
interface WireContract {
	readonly name: DeclaredName
	readonly base: ScalarType
	readonly predicate: ExprTable | undefined
	readonly facts: ReadonlyArray<Fact>
}

const factShape: S.Shape<Fact> = S.literalsShape(factNames)

/** A contract's facts: distinct, in the one order. */
const factListShape: S.Shape<ReadonlyArray<Fact>> = S.refine(
	S.uniqueArray(factShape, (f) => f, "facts"),
	factsSorted,
	"a contract's facts sorted, each once"
)

interface WireTypmod {
	readonly precision: number | undefined
	readonly scale: number | undefined
	readonly dims: number | undefined
}

interface WireSpan {
	readonly endpoint: ScalarType
	readonly width: bigint | undefined
}

interface WireScalarType {
	readonly carrier: Carrier
	readonly caps: CapabilitySet | undefined
	readonly typmod: WireTypmod | undefined
	readonly contract: WireContract | undefined
	readonly text: TextInfo | undefined
	readonly roster: Roster | undefined
	readonly only: NonEmptyReadonlyArray<string> | undefined
	readonly span: WireSpan | undefined
	readonly digits: number | undefined
	readonly bound: NumericBound | undefined
	readonly configuration: TextSearchConfiguration | undefined
	readonly variant: VariantInfo | undefined
}

const capabilityShape: S.Shape<Capability> = S.literalsShape(capabilities)

const capabilitySetShape: S.Shape<CapabilitySet> = S.refine(
	S.array(capabilityShape),
	(caps) =>
		caps.every((c, i) => {
			const prior = caps[i - 1]
			return prior === undefined || prior < c
		}),
	"a sorted capability set without repeats"
)

const numericBoundShape: S.Shape<NumericBound> = S.refine(
	S.struct({ digits: S.integer, scale: S.nonNegativeInteger }),
	(b) =>
		b.digits >= -numericMaxFractionDigits &&
		b.digits <= numericMaxIntegerDigits &&
		b.scale <= numericMaxFractionDigits,
	`a computed numeric's bound: from ${-numericMaxFractionDigits} to ${numericMaxIntegerDigits} integer digits and at most ${numericMaxFractionDigits} fraction digits`
)

const typmodShape: S.Shape<WireTypmod> = S.structStated(
	{},
	{ precision: S.integer, scale: S.integer, dims: S.positiveInteger },
	{}
)

const textBoundsShape: S.Shape<TextBounds> = S.struct({
	length: S.nonNegativeInteger,
	bytes: S.nonNegativeInteger
})

const finiteCheckShape = S.struct({ members: S.nonEmptyArray(S.string), bounds: textBoundsShape })

const patternRegexShape = S.structStated(
	{ ares: S.nonEmptyArray(S.string) },
	{ bounds: textBoundsShape },
	{}
)

/** A pattern's enforcement as the text analysis chose it (ir/scalar.ts PatternCheck). */
const patternCheckShape: S.Shape<PatternCheck> = S.tagged<PatternCheck>()("kind", {
	finite: finiteCheckShape,
	regex: patternRegexShape
})

/** A refinement's enforcement (ir/scalar.ts RegexCheck): a pattern's, or a byte bound beside one or alone. */
const regexCheckShape: S.Shape<RegexCheck> = S.tagged<RegexCheck>()("kind", {
	finite: finiteCheckShape,
	regex: patternRegexShape,
	octets: S.structStated(
		{ octets: S.nonNegativeInteger, bounds: textBoundsShape },
		{ check: patternCheckShape },
		{}
	)
})

const regexKeyShape = S.branded(RegexKey, S.nonEmptyString)

const statedPatternValue = S.struct({ pattern: S.nonEmptyString, spelling: S.string })

/**
 * A pattern value (ir/pattern.ts PatternValue), admitted again from its spelling (admitSpelling) and its language's
 * key computed again, never taken as stated: a spelling the admission refuses, or a key that is not its spelling's, is
 * refused here, so every pattern value a decode yields is admitted.
 */
export const patternValueShape: S.Shape<PatternValue> = S.plain({
	expected: "a pattern value: its spelling, admitted, and its spelling's language key",
	parse: function* (value, path) {
		const stated = yield* statedPatternValue.parse(value, path)
		const admitted = admitSpelling(stated.spelling)
		if (!admitted.ok) {
			const refusal = admitted.error
			return S.refuse(
				path,
				refusal.kind === "diagnostic"
					? `a pattern value spelled in grizzle's pattern grammar: ${diagnosticText(refusal.diagnostic, stated.spelling, matchFlags)}`
					: `a pattern value inside PostgreSQL's regex compile space: /${stated.spelling}/${matchFlags} passes its ${refusal.measure.kind} limit`
			)
		}
		return admitted.value.pattern === stated.pattern
			? admitted.value
			: S.refuse(
					path,
					`a pattern value whose key is its spelling's language key, ${admitted.value.pattern}`
				)
	}
})

/** A text's patterns (ir/scalar.ts Patterns): at least one, each its source and flags. */
export const patternsShape: S.Shape<Patterns> = S.nonEmptyArray(
	S.struct({ source: S.string, flags: S.literalsShape(["u", "su"]) })
)

const regexRefShape: S.Shape<RegexRef> = S.struct({
	patterns: patternsShape,
	key: regexKeyShape,
	check: regexCheckShape
})

/** A text descriptor's analyzed language (ir/scalar.ts TextLanguage), as the text analysis minted it. */
export const textLanguageShape: S.Shape<TextLanguage> = S.tagged<TextLanguage>()("kind", {
	every: S.struct({}),
	refined: S.struct({ key: regexKeyShape, check: regexCheckShape })
})

/** A text type's refinement (ir/scalar.ts TextInfo): the wildcard, or its regex reference. */
const textInfoShape: S.Shape<TextInfo> = S.unionShape(
	S.literalsShape(["wildcard", "pattern"]),
	regexRefShape
)

/**
 * A declared name, parsed where it is decoded: what a roster names its closed relation by and what names a contract. A
 * declared name is the decoded string itself, so a string that parses is its own decoded form.
 */
const declaredNameShape: S.Shape<DeclaredName> = S.plain({
	expected: "a declared name",
	parse: function* (value, path) {
		const parsed = parseDeclaredName(yield* S.nonEmptyString.parse(value, path))
		return parsed.ok
			? parsed.value
			: S.refuse(path, `a declared name: ${nameFaultText(parsed.error)}`)
	}
})

const rosterParts = S.struct({
	closed: declaredNameShape,
	handles: S.nonEmptyUniqueStrings("roster handles")
})

/**
 * A roster as its constructor built it (ir/scalar.ts Roster), whose parts are a declared name and distinct handles,
 * answered as it is: its canonical form is its name and the digest its constructor takes of its handles, so no plain
 * object stands for one.
 */
const rosterShape: S.Shape<Roster> = S.plain({
	expected: "a roster, a closed relation's name and its handles",
	parse: function* (value, path) {
		if (!(value instanceof Roster)) {
			return S.refuse(path, "a roster, a closed relation's name and its handles")
		}
		yield* rosterParts.parse({ closed: value.closed, handles: value.handles }, path)
		return value
	}
})

const wireShape: S.Shape<WireScalarType> = S.ref("a scalar type", () => wireBody)

/** The structure, then the carrier's rules, the first broken rule named in the refusal. */
export const scalarTypeShape: S.Shape<ScalarType> = S.plain({
	expected: "a consistent scalar type",
	parse: function* (value, path) {
		const t = narrow(yield* wireShape.parse(value, path))
		return typeof t === "string" ? S.refuse(path, `a consistent scalar type: ${t}`) : t
	}
})

const contractShape: S.Shape<WireContract> = S.structStated(
	{ name: declaredNameShape, base: scalarTypeShape, facts: factListShape },
	{ predicate: S.ref("an expression table", () => exprTableShape) },
	{}
)

const spanShape: S.Shape<WireSpan> = S.structStated(
	{ endpoint: scalarTypeShape },
	{ width: S.bigint },
	{}
)

/** One arm of a variant: its handle and its fields, each a name and a declared type (ir/scalar.ts VariantArm). */
const variantArmShape: S.Shape<VariantArm> = S.structStated(
	{
		handle: S.nonEmptyString,
		fields: S.array(S.struct({ name: S.nonEmptyString, type: scalarTypeShape }))
	},
	{ check: S.ref("an expression table", () => exprTableShape) },
	{}
)

/**
 * A variant (ir/scalar.ts VariantInfo): its declared name, its roster, and its arms, at least one, each of a live handle
 * of the roster, each once, in its handle order (inRosterOrder), each field named apart from the arm's others and from
 * `tag`.
 */
const variantShape: S.Shape<VariantInfo> = S.refine(
	S.struct({
		name: declaredNameShape,
		roster: rosterShape,
		arms: S.nonEmptyArray(variantArmShape)
	}),
	(v) =>
		inRosterOrder(
			v.roster,
			v.arms.map((arm) => arm.handle)
		) &&
		v.arms.every(
			(arm) =>
				new Set(arm.fields.map((f) => f.name)).size === arm.fields.length &&
				arm.fields.every((f) => f.name !== "tag")
		),
	"a variant's arms, each of a handle of its roster, each once in its order, each field named once and never tag"
)

/** The decoder wireShape refers to (S.ref). */
const wireBody: S.Shape<WireScalarType> = S.structStated(
	{ carrier: S.literalsShape(carriers) },
	{
		caps: capabilitySetShape,
		typmod: typmodShape,
		contract: contractShape,
		text: textInfoShape,
		roster: rosterShape,
		only: S.nonEmptyUniqueStrings("handles"),
		span: spanShape,
		digits: S.nonNegativeInteger,
		bound: numericBoundShape,
		configuration: S.literalsShape(textSearchConfigurations),
		variant: variantShape
	},
	{}
)

/**
 * A contract's wire descriptor as its variant (ir/scalar.ts ContractType), or the first broken rule: it holds its carrier
 * and the contract alone, its base holding every other field; its base has its carrier and is a value domain a field
 * declares (ir/scalar.ts ContractBase), no computed numeric's narrower bound or exact value, set or bytes; and the predicate's
 * expression rules hold against the base (expr.ts predicateProblems).
 */
const narrowContract = (t: WireScalarType, contract: WireContract): ScalarType | string => {
	if (
		t.caps !== undefined ||
		t.typmod !== undefined ||
		t.text !== undefined ||
		t.roster !== undefined ||
		t.only !== undefined ||
		t.span !== undefined ||
		t.digits !== undefined ||
		t.bound !== undefined ||
		t.variant !== undefined
	) {
		return "a contract's descriptor holds its carrier and the contract alone; its base holds the rest"
	}
	const { base } = contract
	if (base.carrier !== t.carrier) {
		return "a contract has its base's carrier"
	}
	if (
		isNumericValue(base) &&
		(base.bound.digits !== numericOwnBound.digits || base.bound.scale !== numericOwnBound.scale)
	) {
		return "a contract is over numeric(p, s) or numeric of no typmod at numeric's own limits, never a computed numeric's narrower bound"
	}
	if (isExactValue(base)) {
		return `${base.carrier} is an arithmetic result, never a contract's base`
	}
	if (base.carrier === "bits") {
		return "a set over a roster is never a contract's base"
	}
	if (base.carrier === "bytes") {
		return "bytes are never a contract's base"
	}
	if (base.carrier === "sha256") {
		return "a digest is never a contract's base"
	}
	if (base.carrier === "tsvector") {
		return "a search document is never a contract's base"
	}
	if (base.carrier === "variant") {
		return "a variant is never a contract's base"
	}
	const { name, predicate } = contract
	if (predicate !== undefined) {
		const [problem] = predicateProblems(predicate, base)
		if (problem !== undefined) {
			return `contract ${name}: ${problem}`
		}
	}
	return Object.freeze({
		carrier: base.carrier,
		contract: Object.freeze({ name, base, predicate, facts: contract.facts })
	})
}

const narrowSpan = (carrier: SpanCarrier, span: WireSpan): SpanInfo | string => {
	const { endpoint, width } = span
	const want = carrier === "range4" ? "int4" : carrier === "range8" ? "int8" : "date"
	if (endpoint.carrier !== want) {
		return `a ${carrier} span has a ${want} endpoint`
	}
	if (endpoint.carrier !== "int4" && endpoint.carrier !== "int8" && !isDateType(endpoint)) {
		return `a ${carrier} span has a ${want} endpoint`
	}
	if (width === undefined) {
		return Object.freeze({ endpoint, width })
	}
	return width > 0n ? Object.freeze({ endpoint, width }) : "a span width is positive"
}

const narrowNumericTypmod = (typmod: WireTypmod): NumericTypmod | string => {
	const { precision, scale } = typmod
	if (typmod.dims !== undefined) {
		return "numeric has no dimensions"
	}
	if (precision === undefined) {
		return scale === undefined
			? "a numeric typmod has a precision"
			: "a numeric scale needs a precision"
	}
	if (scale === undefined) {
		return "a numeric typmod has its scale: numeric(p) is numeric(p, 0)"
	}
	if (precision < 1 || precision > numericMaxPrecision) {
		return `numeric precision lies in 1..${numericMaxPrecision}`
	}
	if (scale < numericMinScale || scale > numericMaxScale) {
		return `numeric scale lies in ${numericMinScale}..${numericMaxScale}`
	}
	return Object.freeze({ precision, scale })
}

const narrowVectorTypmod = (typmod: WireTypmod | undefined): VectorTypmod | string => {
	if (typmod?.dims === undefined) {
		return "a vector type has dimensions"
	}
	if (typmod.dims > vectorMaxDimensions) {
		return `a vector has at most ${vectorMaxDimensions} dimensions`
	}
	if (typmod.precision !== undefined || typmod.scale !== undefined) {
		return "a vector has no precision or scale"
	}
	return Object.freeze({ dims: typmod.dims })
}

/**
 * A wire descriptor as its carrier's variant, or the first broken rule: a contract's (narrowContract), or a plain one.
 * Each variant is rebuilt with the keys in the wire order (carrier, caps, typmod, contract, text, roster, only, span,
 * digits, bound, configuration, variant), so decoding is idempotent.
 */
const narrow = (t: WireScalarType): ScalarType | string =>
	t.contract === undefined ? narrowPlain(t) : narrowContract(t, t.contract)

/** A plain wire descriptor as its carrier's variant, or the first broken rule. */
const narrowPlain = (t: WireScalarType): ScalarType | string => {
	const { carrier, caps } = t
	if (caps === undefined) {
		return "a plain type carries its capabilities"
	}
	if (carrier !== "text" && t.text !== undefined) {
		return "only a text type carries regex metadata"
	}
	if (carrier !== "code" && carrier !== "bits" && t.roster !== undefined) {
		return "only a closed id or a set over a roster has a roster"
	}
	if (carrier !== "code" && t.only !== undefined) {
		return "only a closed id holds a subset of its roster"
	}
	if (!isSpanCarrier(carrier) && t.span !== undefined) {
		return "only a range type has a span endpoint"
	}
	if (carrier !== "numeric" && carrier !== "vector" && t.typmod !== undefined) {
		return `${carrier} has no typmod`
	}
	if (t.digits !== undefined && carrier !== "exactInteger" && carrier !== "exactMoney") {
		return "only an exact type carries a digit bound"
	}
	if (t.bound !== undefined && carrier !== "numeric") {
		return "only a computed numeric carries a numeric bound"
	}
	if (t.configuration !== undefined && carrier !== "tsvector") {
		return "only a search document names a text search configuration"
	}
	if (t.variant !== undefined && carrier !== "variant") {
		return "only a variant states its arms"
	}
	const contract = undefined
	switch (carrier) {
		case "int2":
		case "int4":
		case "int8":
			return Object.freeze({ carrier, caps, contract })
		case "numeric": {
			if (t.typmod === undefined) {
				if (t.bound === undefined) {
					return "a numeric type declares its typmod, or a computed one carries its bound"
				}
				return Object.freeze({
					carrier,
					caps,
					typmod: undefined,
					contract: undefined,
					bound: Object.freeze({ digits: t.bound.digits, scale: t.bound.scale })
				})
			}
			if (t.bound !== undefined) {
				return "numeric(p, s) carries its typmod, never a computed bound"
			}
			const typmod = narrowNumericTypmod(t.typmod)
			return typeof typmod === "string"
				? typmod
				: Object.freeze({ carrier, caps, typmod, contract })
		}
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
			return Object.freeze({ carrier, caps, contract })
		case "text":
			if (t.text === undefined) {
				return "a text type carries regex metadata"
			}
			return Object.freeze({ carrier, caps, contract, text: t.text })
		case "code": {
			if (t.roster === undefined) {
				return "a closed id names its roster"
			}
			const { roster, only } = t
			if (only !== undefined && !isRosterSubset(roster, only)) {
				return "a closed id's subset holds handles of its roster, each once in its order, short of every handle"
			}
			return Object.freeze({ carrier, caps, contract, roster, only })
		}
		case "bits":
			if (t.roster === undefined) {
				return "a set names its roster"
			}
			return Object.freeze({ carrier, caps, contract, roster: t.roster })
		case "bytes":
		case "sha256":
			return Object.freeze({ carrier, caps, contract })
		case "range4":
		case "range8":
		case "rangeDate": {
			if (t.span === undefined) {
				return "a span type names its endpoint"
			}
			const span = narrowSpan(carrier, t.span)
			return typeof span === "string" ? span : Object.freeze({ carrier, caps, contract, span })
		}
		case "vector": {
			const typmod = narrowVectorTypmod(t.typmod)
			return typeof typmod === "string"
				? typmod
				: Object.freeze({ carrier, caps, typmod, contract })
		}
		case "tsvector":
			return t.configuration === undefined
				? "a search document names its text search configuration"
				: Object.freeze({ carrier, caps, contract, configuration: t.configuration })
		case "exactInteger":
		case "exactMoney":
			return t.digits === undefined
				? `${carrier} carries its digit bound`
				: Object.freeze({ carrier, caps, contract, digits: t.digits })
		case "variant":
			return t.variant === undefined
				? "a variant states its arms"
				: Object.freeze({ carrier, caps, contract, variant: t.variant })
	}
}

/** Decodes and checks a descriptor from unknown input (an owned, frozen copy). */
export const decodeScalarType = (value: unknown): Result.Result<ScalarType, CompileError> =>
	S.decodeWith(scalarTypeShape, value, "scalar type")

/**
 * An inet's and a cidr's text, its one form (scalar/values/net.ts), decoded by the admission every value of it is: a
 * text inet_in or cidr_in reads, printed as inet_out or cidr_out prints it, so a text of another spelling of a value is
 * no form of it.
 */
const inetShape: S.Shape<Inet> = S.plain({
	expected: "an inet as inet_out prints it",
	parse: function* (value, path) {
		const text = yield* S.string.parse(value, path)
		return isInetText(text) ? text : S.refuse(path, "an inet as inet_out prints it")
	}
})

const cidrShape: S.Shape<Cidr> = S.plain({
	expected: "a cidr as cidr_out prints it",
	parse: function* (value, path) {
		const text = yield* S.string.parse(value, path)
		return isCidrText(text) ? text : S.refuse(path, "a cidr as cidr_out prints it")
	}
})

/** A calendar date's text, its one form (ir/date.ts), decoded by the admission every date is. */
export const calendarDateShape: S.Shape<CalendarDate> = S.plain({
	expected: "a calendar date written YYYY-MM-DD, from 0001-01-01 to 9999-12-31",
	parse: function* (value, path) {
		const date = toCalendarDate(yield* S.string.parse(value, path))
		return date.ok
			? date.value
			: S.refuse(path, "a calendar date written YYYY-MM-DD, from 0001-01-01 to 9999-12-31")
	}
})

/** A SHA-256 digest's one text (core/sha256.ts sha256Text): a literal's and a Description's. */
export const sha256TextShape: S.Shape<string> = S.refine(
	S.string,
	isSha256Text,
	"a SHA-256 digest's one text, \\x and 64 hex digits"
)

export const literalShape: S.Shape<TypedLiteral> = S.tagged<TypedLiteral>()("kind", {
	int: S.struct({ value: S.bigint }),
	numeric: S.struct({
		value: S.canonicalParsed<DecimalValue>(
			decimalTag,
			(payload) => DecimalText.parse(payload),
			"an exact decimal (canonical tag d)"
		)
	}),
	float: S.struct({ value: S.canonicalFloat }),
	floatSpecial: S.struct({ value: S.literalsShape(floatSpecialNames) }),
	money: S.struct({
		value: S.canonicalParsed<MoneyValue>(
			moneyTag,
			(payload) => MoneyText.parse(payload),
			"a money amount in minor units (canonical tag m)"
		)
	}),
	bool: S.struct({ value: S.boolean }),
	text: S.struct({ value: S.string }),
	uuid: S.struct({ value: S.string }),
	sha256: S.struct({ value: sha256TextShape }),
	date: S.struct({ value: calendarDateShape }),
	inet: S.struct({ value: inetShape }),
	cidr: S.struct({ value: cidrShape }),
	handle: S.struct({ handle: S.nonEmptyString }),
	handles: S.struct({ handles: S.array(S.nonEmptyString) }),
	span: S.struct({ start: S.bigint, end: S.bigint }),
	vector: S.struct({
		value: S.canonicalParsed(
			vectorTag,
			(payload) => VectorText.parse(payload),
			"a vector of binary32 components (canonical tag v)"
		)
	}),
	pattern: S.struct({ value: patternValueShape })
})

const exprIdShape = S.branded(ExprId, S.nonEmptyString)
const nodeIdShape = S.branded(NodeId, S.nonEmptyString)
const paramIdShape = S.branded(ParamId, S.nonEmptyString)

const columnRefShape: S.Shape<ColumnRef> = S.struct({ node: nodeIdShape, name: S.nonEmptyString })

const depsShape: S.Shape<ExprDeps> = S.struct({
	params: S.uniqueIds("parameter ids", S.branded(ParamId, S.nonEmptyString)),
	nodes: S.uniqueIds("node ids", S.branded(NodeId, S.nonEmptyString))
})

/**
 * scalar.ts and this module import each other (a contract predicate is an ExprTable), so the scalar shape is read
 * at each decode (S.ref), never while the modules are evaluated.
 */
const scalarTypeRef = S.ref("a scalar type", () => scalarTypeShape)

/** A range overload decodes to its interned instance. */
const opIdShape: S.Shape<OpId> = S.unionShape(
	S.branded(OpId, S.nonEmptyString),
	S.interned(
		S.struct({
			code: S.literalsShape(rangeOpCodes),
			carrier: S.literalsShape(spanCarriers)
		}),
		(parts: RangeOpParts) => rangeOp(parts.code, parts.carrier)
	)
)

const exactShape: S.Shape<Exact> = S.struct({ units: S.bigint, scale: S.nonNegativeInteger })

const operandIndexShape: S.Shape<OperandIndex> = S.literalsShape([0, 1, 2, 3])

const preconditionShape: S.Shape<Precondition> = S.tagged<Precondition>()("kind", {
	nonzero: S.struct({ operand: operandIndexShape }),
	nonnegative: S.struct({ operand: operandIndexShape }),
	finite: S.struct({ operand: operandIndexShape }),
	integral: S.struct({ operand: operandIndexShape }),
	fits: S.struct({}),
	contract: S.struct({}),
	language: S.struct({}),
	powerDomain: S.struct({}),
	powerRange: S.struct({}),
	bucketDomain: S.struct({}),
	lexical: S.struct({ form: S.literalsShape(parseForms) }),
	bounded: S.struct({}),
	clock: S.struct({})
})

const factSourceShape: S.Shape<FactSource> = S.tagged<FactSource>()("kind", {
	literal: S.struct({}),
	contract: S.struct({ name: S.nonEmptyString }),
	guard: S.struct({}),
	type: S.struct({})
})

const premiseShape: S.Shape<OperandPremise> = S.tagged<OperandPremise>()("kind", {
	fact: S.struct({ operand: operandIndexShape, fact: factShape, source: factSourceShape }),
	interval: S.struct({
		operand: operandIndexShape,
		low: exactShape,
		high: exactShape,
		nan: S.boolean
	}),
	checked: S.struct({
		operand: operandIndexShape,
		by: S.literalsShape(["literal", "parameter", "write"])
	}),
	language: S.structStated(
		{ operand: operandIndexShape, patterns: patternsShape },
		{ bytes: S.nonNegativeInteger },
		{}
	),
	octets: S.struct({ operand: operandIndexShape, bytes: S.nonNegativeInteger }),
	scale: S.struct({ operand: operandIndexShape, scale: S.integer })
})

const preconditionProofShape: S.Shape<PreconditionProof> = S.struct({
	precondition: preconditionShape,
	premises: S.nonEmptyArray(premiseShape)
})

const proofShape: S.Shape<OperationProof> = S.nonEmptyArray(preconditionProofShape)

const nativeShape: S.Shape<NativeProof> = S.struct({ premises: S.nonEmptyArray(premiseShape) })

/**
 * Every expression has the common fields, its kind's inputs and non-null proof among them in that order, then its
 * kind's own fields, then the common optional ones.
 */
/** A declared function as a call names it (ir/expr.ts CalledFunction): its name, its volatility and its digest. */
/** A called function's fields (CalledFunction), each by its shape: what a call of it carries, beside its own. */
export const calledFunctionFields = {
	name: S.nonEmptyString,
	volatility: S.literalsShape(functionVolatilities),
	definition: S.branded(admittedFunctionDigest, S.nonEmptyString)
} as const satisfies S.ShapesOf<CalledFunction>

export const calledFunctionShape: S.Shape<CalledFunction> = S.struct(calledFunctionFields)

const common = <A, N>(args: S.Shape<A>, nonNull: S.Shape<N>) =>
	({
		id: exprIdShape,
		args,
		type: scalarTypeRef,
		nonNull,
		volatility: S.literalsShape(["immutable", "stable"]),
		deps: depsShape
	}) as const
const leaf = S.empty(exprIdShape)
const operand = S.single(exprIdShape)
const strict = S.literalsShape(["strict"])

/** A case of a tagged union as its case decodes it: each variant without the discriminator, which the union adds. */
type CaseFields<E> = E extends unknown ? Omit<E, "kind"> : never

/** The shape of an expression's outside form, its arguments by identifier: a table entry (ExprTable, dag.ts toTable). */
export const tableExprShape: S.Shape<TableExpr> = S.tagged<TableExpr>()("kind", {
	column: S.struct({
		...common(leaf, S.literalsShape(["storage", "codec"])),
		column: columnRefShape
	}),
	value: S.struct(common(leaf, S.literalsShape(["storage"]))),
	param: S.struct({
		...common(leaf, S.literalsShape(["codec"])),
		param: paramIdShape,
		role: S.literalsShape(["compare", "write", "emit"])
	}),
	literal: S.struct({ ...common(leaf, S.literalsShape(["literal"])), value: literalShape }),
	op: S.unionShape(
		S.normalized(
			S.structStated(
				{ ...common(S.array(exprIdShape), strict), op: opIdShape },
				{ proof: proofShape },
				{}
			),
			({ proof, ...e }): CaseFields<TableExprOf<"op">> =>
				proof === undefined ? { ...e, op: definedOp(e.op) } : { ...e, op: partialOp(e.op), proof }
		),
		S.normalized(
			S.struct({ ...common(S.array(exprIdShape), strict), op: opIdShape, native: nativeShape }),
			(e): CaseFields<TableExprOf<"op">> => ({ ...e, op: definedOp(e.op) })
		),
		S.normalized(
			S.struct({
				...common(S.array(exprIdShape), strict),
				op: opIdShape,
				patterns: S.nonEmptyArray(patternValueShape)
			}),
			(e): CaseFields<TableExprOf<"op">> => ({
				...e,
				op: definedOp(e.op),
				patterns: patternTableOf(e.patterns)
			})
		)
	),
	cast: S.unionShape(
		S.normalized(
			S.structStated({ ...common(operand, strict), cast: opIdShape }, { proof: proofShape }, {}),
			({ proof, ...e }): CaseFields<TableExprOf<"cast">> =>
				proof === undefined
					? { ...e, cast: definedOp(e.cast) }
					: { ...e, cast: partialOp(e.cast), proof }
		),
		S.normalized(
			S.struct({ ...common(operand, strict), cast: opIdShape, native: nativeShape }),
			(e): CaseFields<TableExprOf<"cast">> => ({ ...e, cast: definedOp(e.cast) })
		)
	),
	domainCast: S.struct({ ...common(operand, strict), proof: proofShape }),
	cond: S.struct(common(S.tripleShape(exprIdShape), S.literalsShape(["cond"]))),
	closedAt: S.struct({
		...common(S.nonEmptyArray(exprIdShape), S.literalsShape(["absentRefused"])),
		relation: S.nonEmptyString,
		field: S.nonEmptyString
	}),
	closedRow: S.struct({
		...common(S.array(exprIdShape), strict),
		relation: S.nonEmptyString
	}),
	closedHas: S.struct({
		...common(S.nonEmptyArray(exprIdShape), strict),
		relation: S.nonEmptyString
	}),
	call: S.struct({
		...common(S.array(exprIdShape), S.literalsShape(callNonNulls)),
		function: calledFunctionShape,
		params: S.array(scalarTypeShape)
	}),
	variant: S.struct({
		...common(S.array(exprIdShape), S.literalsShape(["strict", "arm"])),
		op: S.tagged<VariantOp>()("kind", {
			tag: S.struct({}),
			digest: S.struct({}),
			field: S.struct({ handle: S.nonEmptyString, field: S.nonEmptyString }),
			make: S.struct({ handle: S.nonEmptyString })
		})
	})
})

const exprTableShape: S.Shape<ExprTable> = S.struct({
	root: exprIdShape,
	exprs: S.recordShape(tableExprShape, S.nonEmptyString)
})
