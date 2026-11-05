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

import {
	type Capability,
	type CapabilitySet,
	type Carrier,
	capabilities,
	carriers,
	type ContractInfo,
	type IntegerCarrier,
	type NumericTypmod,
	numericTypmodOf,
	type RegexRef,
	RegexKey,
	type Roster,
	rosterOf,
	type ScalarType,
	type SpanCarrier,
	type SpanInfo,
	spanOf,
	type TextInfo,
	textOf,
	type ValueType,
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
	readonly serial: "always" | undefined
	readonly digits: number | undefined
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

const typmodShape: S.Shape<WireTypmod> = S.structStated(
	{},
	{ precision: S.integer, scale: S.integer, dims: S.positiveInteger },
	{}
)

const regexRefShape: S.Shape<RegexRef> = S.struct({
	source: S.string,
	flags: S.literalsShape(["u", "su"]),
	key: S.branded(RegexKey, S.nonEmptyString)
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

/** A declared name, parsed where it is decoded: what a roster names its closed relation by and what names a contract. */
const declaredNameShape: S.Shape<DeclaredName> = S.plain({
	expected: "a declared name",
	parse: (value, path) => {
		const parsed = parseDeclaredName(S.nonEmptyString.parse(value, path))
		return parsed.ok ? parsed.value : S.refuse(path, `a declared name: ${parsed.error}`)
	},
	/** A declared name is the decoded string itself, so a string that parses is its own decoded form. */
	conform: (value, path): value is DeclaredName =>
		typeof value === "string" && (parseDeclaredName(value).ok || S.refuse(path, "a declared name")),
	conformFields: S.notInPlace
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
			serial: S.literalsShape(["always"]),
			digits: S.nonNegativeInteger
		},
		{}
	)
)

/** The structure, then the carrier's rules, the first broken rule named in the refusal. */
export const scalarTypeShape: S.Shape<ScalarType> = S.plain({
	expected: "a consistent scalar type",
	parse: (value, path) => {
		const t = narrow(wireShape.parse(value, path))
		return typeof t === "string" ? S.refuse(path, `a consistent scalar type: ${t}`) : t
	},
	/**
	 * A descriptor is narrowed into a fresh one, so one not yet decoded is its own decoded form when it holds exactly
	 * what that fresh one holds.
	 */
	conform: (value, path): value is ScalarType => {
		const t = narrow(wireShape.parse(value, path))
		if (typeof t === "string") {
			return S.refuse(path, `a consistent scalar type: ${t}`)
		}
		return sameMembers(t, value)
	},
	conformFields: S.notInPlace
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
 * The contract of a wire descriptor, or the first broken rule: its base has the descriptor's carrier and is no serial
 * declaration, the descriptor repeats the base's meaning-changing fields unchanged, and the predicate's expression
 * rules hold against the base (expr.ts predicateProblems).
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
	if (t.serial !== undefined) {
		return "a contract is not itself a serial declaration"
	}
	if ("serial" in base) {
		return "a contract's base is a value domain, not a serial declaration"
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
	if ("serial" in endpoint) {
		return "a serial descriptor is not a span endpoint"
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
	if (precision < 1 || precision > 1000) {
		return "numeric precision lies in 1..1000"
	}
	if (scale < -1000 || scale > 1000) {
		return "numeric scale lies in -1000..1000"
	}
	return Object.freeze({ precision, scale })
}

const narrowVectorTypmod = (typmod: WireTypmod | undefined): VectorTypmod | string => {
	if (typmod?.dims === undefined) {
		return "a vector type has dimensions"
	}
	if (typmod.dims > 16000) {
		return "a vector has at most 16000 dimensions"
	}
	if (typmod.precision !== undefined || typmod.scale !== undefined) {
		return "a vector has no precision or scale"
	}
	return Object.freeze({ dims: typmod.dims })
}

/**
 * A serial-free integer descriptor, its contract optional. It is typed as a ValueType, which its carrier alone does
 * not decide: a serial has the same carriers.
 */
const integerType = (
	carrier: IntegerCarrier,
	caps: CapabilitySet,
	contract: ContractInfo | undefined
): ValueType => Object.freeze({ carrier, caps, contract })

/**
 * A wire descriptor as its carrier's variant, or the first broken rule. Each variant is rebuilt with the keys in the
 * wire order (carrier, caps, typmod, contract, text, roster, span, serial), so decoding is idempotent.
 */
const narrow = (t: WireScalarType): ScalarType | string => {
	const { carrier, caps } = t
	if (carrier !== "text" && t.text !== undefined) {
		return "only a text type carries regex metadata"
	}
	if (carrier !== "enum" && t.roster !== undefined) {
		return "only an enum type has a roster"
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
	if (t.serial !== undefined && carrier !== "int2" && carrier !== "int4" && carrier !== "int8") {
		return "serial generation applies to int2, int4 and int8 only"
	}
	const contract = t.contract === undefined ? undefined : narrowContract(t, t.contract)
	if (typeof contract === "string") {
		return contract
	}
	switch (carrier) {
		case "int2":
		case "int4":
		case "int8":
			return t.serial === undefined
				? integerType(carrier, caps, contract)
				: Object.freeze({ carrier, caps, serial: t.serial })
		case "numeric": {
			if (t.typmod === undefined) {
				return Object.freeze({ carrier, caps, typmod: undefined, contract })
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
			return Object.freeze({ carrier, caps, contract })
		case "text":
			if (t.text === undefined) {
				return "a text type carries regex metadata"
			}
			return Object.freeze({ carrier, caps, contract, text: t.text })
		case "enum":
			if (t.roster === undefined) {
				return "an enum type names its closed roster"
			}
			return Object.freeze({ carrier, caps, contract, roster: t.roster })
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
			if (contract !== undefined) {
				return `${carrier} is an arithmetic result, never a contract's base`
			}
			return t.digits === undefined
				? `${carrier} carries its digit bound`
				: Object.freeze({ carrier, caps, digits: t.digits })
	}
}

/**
 * Whether `a` and `b` hold the same members throughout: the same primitives, and objects and arrays of the same own
 * keys (an undefined member counted), each holding the same members, in any key order.
 */
const sameMembers = (a: unknown, b: unknown): boolean => {
	if (a === b) {
		return true
	}
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
		return false
	}
	if (Array.isArray(a) !== Array.isArray(b)) {
		return false
	}
	const keys = Object.keys(a)
	if (keys.length !== Object.keys(b).length) {
		return false
	}
	const ra: Readonly<Record<string, unknown>> = { ...a }
	const rb: Readonly<Record<string, unknown>> = { ...b }
	return keys.every((key) => Object.hasOwn(b, key) && sameMembers(ra[key], rb[key]))
}

/** Decodes and checks a descriptor from unknown input (an owned, frozen copy). */
export const decodeScalarType = (value: unknown): Result.Result<ScalarType, CompileError> =>
	S.decodeWith(scalarTypeShape, value, "scalar type")

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
	enum: S.struct({ handle: S.nonEmptyString }),
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
	cond: S.struct(common(S.tripleShape(exprIdShape), S.literalsShape(["cond"])))
})

export const exprTableShape: S.Shape<ExprTable> = S.struct({
	root: exprIdShape,
	exprs: S.recordShape(tableExprShape, S.nonEmptyString)
})
