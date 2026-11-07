import { canonicalEquals, everyProperty } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { type DeclaredName, parseDeclaredName } from "#compiler/core/identity.ts"
import { ExprId, NodeId, ParamId } from "#compiler/core/ids.ts"
import type * as Result from "#compiler/core/result.ts"
import {
	MoneyText,
	type MoneyValue,
	moneyTag,
	VectorText,
	vectorMaxDimensions,
	vectorTag
} from "#compiler/ir/carriers.ts"
import { DecimalText, type DecimalValue, decimalTag } from "#compiler/ir/decimal.ts"
import {
	type ColumnRef,
	definedOp,
	type ExprDeps,
	type ExprTable,
	type TypedLiteral,
	OpId,
	partialOp,
	predicateProblems,
	type RangeOpParts,
	rangeOp,
	rangeOpCodes,
	type TableExpr,
	type TableExprOf
} from "#compiler/ir/expr.ts"
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
	type PreconditionProof
} from "#compiler/ir/proof.ts"

import { type CalendarDate, toCalendarDate } from "#compiler/ir/date.ts"
import {
	type Capability,
	type CapabilitySet,
	type Carrier,
	capabilities,
	carriers,
	type ContractInfo,
	type IntegerCarrier,
	isExactValue,
	isNumericValue,
	type NumericBound,
	numericMaxFractionDigits,
	numericMaxIntegerDigits,
	numericMaxPrecision,
	numericMaxScale,
	numericMinScale,
	type NumericTypmod,
	numericTypmodOf,
	type PatternCheck,
	type RegexCheck,
	type RegexRef,
	RegexKey,
	type Roster,
	rosterOf,
	type ScalarType,
	type SpanCarrier,
	type SpanInfo,
	spanOf,
	type TextBounds,
	type TextInfo,
	type TextLanguage,
	textOf,
	type VectorTypmod,
	vectorTypmodOf
} from "#compiler/ir/scalar.ts"
import * as S from "#compiler/ir/shape.ts"

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
	readonly caps: CapabilitySet
	readonly typmod: WireTypmod | undefined
	readonly contract: WireContract | undefined
	readonly text: TextInfo | undefined
	readonly roster: Roster | undefined
	readonly span: WireSpan | undefined
	readonly digits: number | undefined
	readonly bound: NumericBound | undefined
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
		b.digits >= -numericMaxFractionDigits.value &&
		b.digits <= numericMaxIntegerDigits.value &&
		b.scale <= numericMaxFractionDigits.value,
	`a computed numeric's bound: from ${-numericMaxFractionDigits.value} to ${numericMaxIntegerDigits.value} integer digits and at most ${numericMaxFractionDigits.value} fraction digits`
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

const patternRegexShape = S.structStated({ pattern: S.string }, { bounds: textBoundsShape }, {})

/** A pattern's enforcement as the text analysis chose it (ir/scalar.ts PatternCheck). */
const patternCheckShape: S.Shape<PatternCheck> = S.tagged("kind", {
	finite: finiteCheckShape,
	regex: patternRegexShape
})

/** A refinement's enforcement (ir/scalar.ts RegexCheck): a pattern's, or a byte bound beside one or alone. */
const regexCheckShape: S.Shape<RegexCheck> = S.tagged("kind", {
	finite: finiteCheckShape,
	regex: patternRegexShape,
	octets: S.structStated(
		{ octets: S.nonNegativeInteger, bounds: textBoundsShape },
		{ check: patternCheckShape },
		{}
	)
})

const regexKeyShape = S.branded(RegexKey, S.nonEmptyString)

const regexRefShape: S.Shape<RegexRef> = S.struct({
	source: S.string,
	flags: S.literalsShape(["u", "su"]),
	key: regexKeyShape,
	check: regexCheckShape
})

/** A text descriptor's analyzed language (ir/scalar.ts TextLanguage), as the text analysis minted it. */
export const textLanguageShape: S.Shape<TextLanguage> = S.tagged("kind", {
	every: S.struct({}),
	refined: S.struct({ key: regexKeyShape, check: regexCheckShape })
})

const regexShape = S.unionShape(S.literalsShape(["wildcard"]), regexRefShape)

/** Bounds both stated, or both left out: a field whose every value is refused is one an input can only leave out. */
const unstated: S.Shape<never> = S.literalsShape([])

const textInfoShape: S.Shape<TextInfo> = S.unionShape(
	S.struct({
		regex: regexRefShape,
		lengthBound: S.nonNegativeInteger,
		byteBound: S.nonNegativeInteger
	}),
	S.structStated({ regex: regexShape }, { lengthBound: unstated, byteBound: unstated }, {})
)

/**
 * A declared name, parsed where it is decoded: what a roster names its closed relation by and what names a contract. A
 * declared name is the decoded string itself, so a string that parses is its own decoded form.
 */
const declaredNameShape: S.Shape<DeclaredName> = S.plain({
	expected: "a declared name",
	parse: function* (value, path) {
		const parsed = parseDeclaredName(yield* S.nonEmptyString.parse(value, path))
		return parsed.ok ? parsed.value : S.refuse(path, `a declared name: ${parsed.error}`)
	}
})

const rosterShape: S.Shape<Roster> = S.struct({
	closed: declaredNameShape,
	handles: S.nonEmptyUniqueStrings("roster handles")
})

const wireShape: S.Shape<WireScalarType> = S.lazy("a scalar type", () =>
	S.structStated(
		{ carrier: S.literalsShape(carriers), caps: capabilitySetShape },
		{
			typmod: typmodShape,
			contract: contractShape,
			text: textInfoShape,
			roster: rosterShape,
			span: spanShape,
			digits: S.nonNegativeInteger,
			bound: numericBoundShape
		},
		{}
	)
)

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
	{ predicate: S.lazy("an expression table", () => exprTableShape) },
	{}
)

const spanShape: S.Shape<WireSpan> = S.structStated(
	{ endpoint: scalarTypeShape },
	{ width: S.bigint },
	{}
)

const sameOptional = (a: unknown, b: unknown): boolean =>
	a === undefined || b === undefined ? a === b : canonicalEquals(a, b, everyProperty)

/**
 * The contract of a wire descriptor, or the first broken rule: its base has the descriptor's carrier and is a value
 * domain a field declares (ir/scalar.ts ContractBase), no computed numeric or exact value, the
 * descriptor repeats the base's meaning-changing fields unchanged, and the predicate's expression rules hold against
 * the base (expr.ts predicateProblems).
 */
const narrowContract = (t: WireScalarType, contract: WireContract): ContractInfo | string => {
	const { base } = contract
	if (base.carrier !== t.carrier) {
		return "a contract has its base's carrier"
	}
	/**
	 * The domain keeps its base's typmod, text refinement, roster and span: an outer field
	 * that differs would let a literal pass for the contract that its base, and PostgreSQL's domain, refuses.
	 */
	const baseTypmod = numericTypmodOf(base) ?? vectorTypmodOf(base)
	if (!sameOptional(t.typmod, baseTypmod)) {
		return "a contract carries its base's typmod, unchanged"
	}
	if (!sameOptional(t.text, textOf(base))) {
		return "a contract carries its base's text, unchanged"
	}
	if (!sameOptional(t.roster, rosterOf(base))) {
		return "a contract carries its base's roster, unchanged"
	}
	if (!sameOptional(t.span, spanOf(base))) {
		return "a contract carries its base's span, unchanged"
	}
	if (isNumericValue(base)) {
		return "a contract is over numeric(p, s), never a computed numeric"
	}
	if (isExactValue(base)) {
		return `${base.carrier} is an arithmetic result, never a contract's base`
	}
	if (base.carrier === "bits") {
		return "a set over a roster is never a contract's base"
	}
	const { name, predicate } = contract
	if (predicate !== undefined) {
		const [problem] = predicateProblems(predicate, base)
		if (problem !== undefined) {
			return `contract ${name}: ${problem}`
		}
	}
	return Object.freeze({ name, base, predicate, facts: contract.facts })
}

const narrowSpan = (carrier: SpanCarrier, span: WireSpan): SpanInfo | string => {
	const { endpoint, width } = span
	const want = carrier === "range4" ? "int4" : "int8"
	if (endpoint.carrier !== "int4" && endpoint.carrier !== "int8") {
		return `a ${carrier} span has an ${want} endpoint`
	}
	if (endpoint.carrier !== want) {
		return `a ${carrier} span has an ${want} endpoint`
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
	if (precision < 1 || precision > numericMaxPrecision.value) {
		return `numeric precision lies in 1..${numericMaxPrecision.value}`
	}
	if (scale < numericMinScale.value || scale > numericMaxScale.value) {
		return `numeric scale lies in ${numericMinScale.value}..${numericMaxScale.value}`
	}
	return Object.freeze({ precision, scale })
}

const narrowVectorTypmod = (typmod: WireTypmod | undefined): VectorTypmod | string => {
	if (typmod?.dims === undefined) {
		return "a vector type has dimensions"
	}
	if (typmod.dims > vectorMaxDimensions.value) {
		return `a vector has at most ${vectorMaxDimensions.value} dimensions`
	}
	if (typmod.precision !== undefined || typmod.scale !== undefined) {
		return "a vector has no precision or scale"
	}
	return Object.freeze({ dims: typmod.dims })
}

/** An integer descriptor, its contract optional. */
const integerType = (
	carrier: IntegerCarrier,
	caps: CapabilitySet,
	contract: ContractInfo | undefined
): ScalarType => Object.freeze({ carrier, caps, contract })

/**
 * A wire descriptor as its carrier's variant, or the first broken rule. Each variant is rebuilt with the keys in the
 * wire order (carrier, caps, typmod, contract, text, roster, span, digits, bound), so decoding is idempotent.
 */
const narrow = (t: WireScalarType): ScalarType | string => {
	const { carrier, caps } = t
	if (carrier !== "text" && t.text !== undefined) {
		return "only a text type carries regex metadata"
	}
	if (carrier !== "code" && carrier !== "bits" && t.roster !== undefined) {
		return "only a closed id or a set over a roster has a roster"
	}
	if (carrier !== "range4" && carrier !== "range8" && t.span !== undefined) {
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
	const contract = t.contract === undefined ? undefined : narrowContract(t, t.contract)
	if (typeof contract === "string") {
		return contract
	}
	switch (carrier) {
		case "int2":
		case "int4":
		case "int8":
			return integerType(carrier, caps, contract)
		case "numeric": {
			if (t.typmod === undefined) {
				if (t.bound === undefined) {
					return "a numeric type declares its typmod, or a computed one carries its bound"
				}
				if (contract !== undefined) {
					return "a contract is over numeric(p, s), never a computed numeric"
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
			return Object.freeze({ carrier, caps, contract })
		case "text":
			if (t.text === undefined) {
				return "a text type carries regex metadata"
			}
			return Object.freeze({ carrier, caps, contract, text: t.text })
		case "code":
			if (t.roster === undefined) {
				return "a closed id names its roster"
			}
			return Object.freeze({ carrier, caps, contract, roster: t.roster })
		case "bits":
			if (t.roster === undefined) {
				return "a set names its roster"
			}
			if (contract !== undefined) {
				return "no contract is over a set over a roster"
			}
			return Object.freeze({ carrier, caps, roster: t.roster })
		case "range4":
		case "range8": {
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
		case "exactInteger":
		case "exactMoney":
			return t.digits === undefined
				? `${carrier} carries its digit bound`
				: Object.freeze({ carrier, caps, digits: t.digits })
	}
}

/** Decodes and checks a descriptor from unknown input (an owned, frozen copy). */
export const decodeScalarType = (value: unknown): Result.Result<ScalarType, CompileError> =>
	S.decodeWith(scalarTypeShape, value, "scalar type")

/** A calendar date's text, its one form (ir/date.ts), decoded by the admission every date is. */
const calendarDateShape: S.Shape<CalendarDate> = S.plain({
	expected: "a calendar date written YYYY-MM-DD, from 0001-01-01 to 9999-12-31",
	parse: function* (value, path) {
		const date = toCalendarDate(yield* S.string.parse(value, path))
		return date.ok
			? date.value
			: S.refuse(path, "a calendar date written YYYY-MM-DD, from 0001-01-01 to 9999-12-31")
	}
})

export const literalShape: S.Shape<TypedLiteral> = S.tagged("kind", {
	int: S.struct({ value: S.bigint }),
	numeric: S.struct({
		value: S.canonicalParsed<DecimalValue>(
			decimalTag,
			(payload) => DecimalText.parse(payload),
			"an exact decimal (canonical tag d)"
		)
	}),
	float: S.struct({ value: S.canonicalFloat }),
	floatSpecial: S.struct({ value: S.literalsShape(["NaN", "Infinity", "-Infinity"]) }),
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
	date: S.struct({ value: calendarDateShape }),
	handle: S.struct({ handle: S.nonEmptyString }),
	handles: S.struct({ handles: S.array(S.nonEmptyString) }),
	span: S.struct({ start: S.bigint, end: S.bigint }),
	vector: S.struct({
		value: S.canonicalParsed(
			vectorTag,
			(payload) => VectorText.parse(payload),
			"a vector of binary32 components (canonical tag v)"
		)
	})
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
 * lazily, at decode time, never during module evaluation.
 */
const lazyScalarType = S.lazy("a scalar type", () => scalarTypeShape)

/** A range overload decodes to its interned instance. */
const opIdShape: S.Shape<OpId> = S.unionShape(
	S.branded(OpId, S.nonEmptyString),
	S.interned(
		S.struct({
			code: S.literalsShape(rangeOpCodes),
			carrier: S.literalsShape(["range4", "range8"])
		}),
		(parts: RangeOpParts) => rangeOp(parts.code, parts.carrier)
	)
)

const exactShape: S.Shape<Exact> = S.struct({ units: S.bigint, scale: S.nonNegativeInteger })

const operandIndexShape: S.Shape<OperandIndex> = S.literalsShape([0, 1, 2, 3])

const preconditionShape: S.Shape<Precondition> = S.tagged("kind", {
	nonzero: S.struct({ operand: operandIndexShape }),
	nonnegative: S.struct({ operand: operandIndexShape }),
	finite: S.struct({ operand: operandIndexShape }),
	fits: S.struct({}),
	contract: S.struct({}),
	powerDomain: S.struct({}),
	bucketDomain: S.struct({})
})

const factSourceShape: S.Shape<FactSource> = S.tagged("kind", {
	literal: S.struct({}),
	contract: S.struct({ name: S.nonEmptyString }),
	guard: S.struct({}),
	type: S.struct({})
})

const premiseShape: S.Shape<OperandPremise> = S.tagged("kind", {
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
	})
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
const common = <A, N>(args: S.Shape<A>, nonNull: S.Shape<N>) =>
	({
		id: exprIdShape,
		args,
		type: lazyScalarType,
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
export const tableExprShape: S.Shape<TableExpr> = S.tagged("kind", {
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
				patterns: S.nonEmptyArray(S.struct({ source: S.string, are: S.string }))
			}),
			(e): CaseFields<TableExprOf<"op">> => ({ ...e, op: definedOp(e.op) })
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
	})
})

export const exprTableShape: S.Shape<ExprTable> = S.struct({
	root: exprIdShape,
	exprs: S.recordShape(tableExprShape, S.nonEmptyString)
})
