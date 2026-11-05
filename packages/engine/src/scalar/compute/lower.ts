import { canonicalTextOf, catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import {
	CompileError,
	type PreconditionKind,
	prose,
	type ProseTag,
	unsupported
} from "#compiler/core/errors.ts"
import { ExprId } from "#compiler/core/ids.ts"
import {
	derived,
	int4Max,
	int8Max,
	int8Min,
	type Limit,
	maxAllocSize
} from "#compiler/core/limits.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import {
	binary32Digits,
	binary32FractionDigits,
	binary64Digits,
	binary64FractionDigits,
	binary64MaxExponent,
	int4Digits,
	integerDigits,
	integerRanges,
	moneyDigits,
	moneyFractionDigits
} from "#compiler/ir/carriers.ts"
import type {
	ExprDesc,
	FieldDesc,
	GuardDesc,
	LiteralDesc,
	Located,
	Refs,
	Spelled
} from "#compiler/ir/desc.ts"
import {
	builtExpr,
	type Effects,
	type ExprSpec,
	type ExprTable,
	type ScalarExpr,
	type TableExpr
} from "#compiler/ir/expr.ts"
import type {
	Exact,
	Fact,
	NativeProof,
	OperandIndex,
	OperandPremise,
	OperationProof,
	Precondition,
	PreconditionProof
} from "#compiler/ir/proof.ts"
import {
	baseOf,
	contractOf,
	type ContractInfo,
	isRefined,
	numericMaxDisplayScale,
	numericMaxFractionDigits,
	numericMaxIntegerDigits,
	numericMaxResultScale,
	numericTypmodOf,
	type ScalarType,
	spanOf,
	textOf,
	typeLabel,
	type ValueType
} from "#compiler/ir/scalar.ts"
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
	factPremise,
	finiteEnds,
	finitePremise,
	hullBounds,
	insideRange,
	type IntervalPremise,
	intervalPremise,
	minus,
	mulBounds,
	negBounds,
	negExact,
	noFacts,
	ofDigits,
	ofPoint,
	ofRange,
	ofSpecial,
	pointOf,
	premiseHas,
	type Refinement,
	boundsHave,
	refine,
	scaleOfExact,
	significantRound,
	subBounds,
	tenTo
} from "#compiler/scalar/compute/bounds.ts"
import { floatNumericDigits } from "#compiler/scalar/compute/cast.ts"
import {
	admitLiteral,
	literalMember,
	literalValue,
	type RegexMember
} from "#compiler/scalar/compute/evaluate.ts"
import {
	bareLiteralKind,
	type CarriedLiteral,
	type CarrierValue
} from "#compiler/scalar/compute/literal.ts"
import { nativeProof, resultBounds } from "#compiler/scalar/compute/native.ts"
import {
	binaryCoercion,
	type CastOp,
	castOf,
	type ExtremeOp,
	extremeOf,
	type FixedFn,
	type FixedOp,
	type NativeFn,
	type NativeOp,
	nativeOp,
	overloadOf,
	registeredCast
} from "#compiler/scalar/compute/registry.ts"
import {
	anyNumeric,
	commonType,
	exactFamily,
	exactType,
	familyDigits,
	isComputedNumeric,
	isFloat,
	meetingType,
	meets,
	plainType,
	sameRegex,
	valueType,
	wideningOf,
	wildcardText,
	withoutSerial,
	withoutSpanWidth
} from "#compiler/scalar/compute/types.ts"
import { numericValue } from "#compiler/scalar/registry.ts"
import { Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"

/**
 * A lowered operand: the node's recorded entry, the type the caller's term has (nominal), the SQL type the node
 * computes (actual), which differ only where a parameter is bound as its base or a cast keeps its source's refinement,
 * its effects as its table derived them (ir/expr.ts exprEffects), and what is proved of its values: the bound domain's
 * interval and digits where its type is a number (bounds.ts Bounds), and its facts (FactSet).
 */
export interface Lowered extends Effects {
	readonly expr: ScalarExpr
	readonly nominal: ScalarType
	readonly actual: ScalarType
	readonly bounds: Bounds | undefined
	readonly facts: FactSet
}

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
			) => Result.Result<{ readonly spec: ExprSpec; readonly type: ScalarType }, CompileError>
	  }

export const noParams: { readonly kind: "none" } = Object.freeze({ kind: "none" })

/**
 * The emitter of a lowering no DAG receives (a contract predicate, a builder typing its term): each expression built
 * over its arguments (ir/expr.ts builtExpr) under a fresh label `prefix#n`.
 */
export const exprEmitter = (prefix: string): ((spec: ExprSpec) => ScalarExpr) => {
	let next = 0
	return (spec) => builtExpr(spec, ExprId(`${prefix}#${next++}`))
}

/** Whether a branch is an untyped literal, which adopts the type of the other branch. */
const isBareLiteral = <R extends Refs>(d: ExprDesc<Located, R>): boolean =>
	d.kind === "literal" && d.type === undefined

/** The predicates other packages lower: r.allen, r.pointIn and r.not. */
type LowerExtension<R extends Refs> = (
	desc: Extract<ExprDesc<Located, R>, { readonly kind: "allen" | "pointIn" | "absent" }>,
	loc: SourceLoc,
	lower: (child: ExprDesc<Located, R>) => Result.Result<Lowered, CompileError>
) => Result.Result<Lowered, CompileError>

/** No package lowers a predicate of its own here: r.allen, r.pointIn and r.not are refused. */
export const noExtension: LowerExtension<Spelled> = (desc, loc) =>
	Result.err(
		unsupported(loc, `${desc.kind}: lowered by its own package, not the Compute catalogue`)
	)

interface LowerCommon<R extends Refs> {
	/** The source location of the expression, the prefix of every diagnostic. */
	readonly loc: SourceLoc
	/**
	 * Records a node and returns its entry, built over its arguments' entries (ir/expr.ts builtExpr): a DagBuilder's
	 * `record`, or a contract predicate's table.
	 */
	readonly emit: (spec: ExprSpec) => ScalarExpr
	/** The node a leaf reference records at each use. */
	readonly leaf: (desc: LeafDesc<R>, loc: SourceLoc) => Result.Result<ExprSpec, CompileError>
	readonly params: LowerParams<R>
	/** The ScalarType of a descriptor's Description, for Compute.literal and Compute.cast (the descriptor registry). */
	readonly fieldType: (desc: FieldDesc, loc: SourceLoc) => Result.Result<ScalarType, CompileError>
}

/**
 * A lowering's mode: a query (its filters and outputs), a check (a contract predicate or a row check, which reads only
 * its VALUE or row and becomes a CHECK), or a builder typing the term it constructs.
 *
 * What each mode reads besides: a query and a check judge a literal against its regex refinement, by the text
 * package's membership they carry, and only a query lowers the predicates of other packages (a check refuses them); a
 * builder judges no literal and lowers none.
 */
export type LowerEnv<R extends Refs = Spelled> =
	| (LowerCommon<R> & {
			readonly mode: "query"
			readonly regexMember: RegexMember
			readonly extension: LowerExtension<R>
	  })
	| (LowerCommon<R> & { readonly mode: "check"; readonly regexMember: RegexMember })
	| (LowerCommon<R> & { readonly mode: "build" })

/**
 * Internal control flow: the first refusal deep inside a lowering is thrown as a Refusal and caught at the boundary
 * (catchRefusal, core/canonical.ts).
 */
const stop = (
	reason: Extract<ProseTag, "MalformedDescription" | "UnsupportedOperation" | "ContractLiteral">,
	loc: SourceLoc,
	capability: string
): never => {
	throw new Refusal(CompileError.make(prose(reason, loc, capability)))
}

const unwrap = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw new Refusal(r.error)
	}
	return r.value
}

type Role = "compare" | "operand"

/**
 * The Compute operations a check admits beside comparisons, boolean composition, Compute.cond, Compute.when and casts:
 * the ones the host evaluates for the ContractLiteral check (evaluate.ts), so a literal is judged against every
 * predicate it meets.
 */
const checkMembers: ReadonlySet<string> = new Set([
	"add",
	"sub",
	"mul",
	"div",
	"mod",
	"neg",
	"abs",
	"sign",
	"charLength",
	"lower",
	"upper",
	"width"
])

/** Money's range, a signed 64-bit count of minor units. */
const moneyLow: Exact = exactOf(int8Min.value, moneyFractionDigits.value)
const moneyHigh: Exact = exactOf(int8Max.value, moneyFractionDigits.value)

/** Every value of a carrier, before any contract: what a value of its base type can be. */
const carrierBounds = (t: ScalarType): Bounds | undefined => {
	switch (t.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return ofRange(
				integerRanges[t.carrier][0],
				integerRanges[t.carrier][1],
				integerDigits[t.carrier].value
			)
		case "numeric":
			return t.typmod === undefined
				? ofDigits(t.bound.digits, t.bound.scale, { infinite: true, nan: true })
				: ofDigits(t.typmod.precision - t.typmod.scale, Math.max(t.typmod.scale, 0), {
						infinite: false,
						nan: true
					})
		case "float4":
			return ofDigits(binary32Digits.value, binary32FractionDigits.value, {
				infinite: true,
				nan: true
			})
		case "float8":
			return ofDigits(binary64Digits.value, binary64FractionDigits.value, {
				infinite: true,
				nan: true
			})
		case "money":
			return refine(
				ofDigits(moneyDigits.value, moneyFractionDigits.value, { infinite: false, nan: false }),
				{ kind: "within", low: moneyLow, high: moneyHigh }
			)
		case "exactInteger":
			return ofDigits(t.digits, 0, { infinite: false, nan: false })
		case "exactMoney":
			return ofDigits(t.digits, moneyFractionDigits.value, { infinite: false, nan: false })
		case "bool":
		case "uuid":
		case "text":
		case "enum":
		case "range4":
		case "range8":
		case "vector":
			return undefined
	}
}

/** The levels of a contract, outermost first, down to its base. */
const contractLevels = (t: ScalarType): ReadonlyArray<ContractInfo> => {
	const levels: Array<ContractInfo> = []
	for (let c = contractOf(t); c !== undefined; c = contractOf(c.base)) {
		levels.push(c)
	}
	return levels
}

/** The bounds every value of `t` has: its base's, refined by each contract level's atoms over VALUE. */
export const boundsOfType = (t: ScalarType): Bounds | undefined => {
	const base = carrierBounds(baseOf(withoutSerial(t)))
	if (base === undefined) {
		return undefined
	}
	return contractLevels(t).reduce(
		(b, c) => (c.predicate === undefined ? b : predicateAtoms(c.predicate).reduce(refine, b)),
		base
	)
}

/**
 * The facts every value of `t` has: an integer's, an exact value's and money's finiteness by their types, and each
 * contract level's declared facts, which its build proved from its predicate (scalar/contract.ts).
 */
const factsOfType = (t: ScalarType): FactSet => {
	const facts: { [F in Fact]?: FactSet[F] } = {}
	const carrier = baseOf(withoutSerial(t)).carrier
	if (
		carrier === "int2" ||
		carrier === "int4" ||
		carrier === "int8" ||
		carrier === "money" ||
		carrier === "exactInteger" ||
		carrier === "exactMoney"
	) {
		facts.finite = { kind: "type" }
	}
	for (const c of contractLevels(t)) {
		for (const f of c.facts) {
			facts[f] = facts[f] ?? { kind: "contract", name: c.name }
		}
	}
	return Object.freeze(facts)
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

/** A carried literal's value in the bound domain: exact, a special, or no number at all. */
const literalNumber = (
	value: CarrierValue
): Exact | "nan" | "infinity" | "-infinity" | undefined => {
	if (typeof value === "bigint") {
		return exactOf(value, 0)
	}
	if (typeof value === "number") {
		return Number.isNaN(value)
			? "nan"
			: value === Number.POSITIVE_INFINITY
				? "infinity"
				: value === Number.NEGATIVE_INFINITY
					? "-infinity"
					: exactOfDouble(value)
	}
	if (value instanceof Decimal) {
		const p = value.parts
		return p.kind === "finite" ? exactOfDecimal(value) : p.kind
	}
	if (value instanceof Money) {
		return exactOf(value.minorUnits, 2)
	}
	return undefined
}

/** A stored literal entry's value in the bound domain. */
const tableNumber = (
	e: TableExpr & { readonly kind: "literal" }
): Exact | "nan" | "infinity" | "-infinity" | undefined => literalNumber(literalValue(e.value))

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
const literalComparison = (
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

/** The registry function a stored op entry names, or undefined when it names no Compute overload. */
const opFn = (e: TableExpr & { readonly kind: "op" }): NativeFn | undefined => nativeOp(e.op)?.fn

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

/** What a Compute.when guard establishes of its subject inside the guarded branch (bounds.ts Refinement). */
const guardRefinement = (
	guard: GuardDesc,
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
	guard: GuardDesc,
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
 * A fact of an operand its bounds prove where its facts state none: the interval premise of its values when every one
 * of them has the fact (bounds.ts premiseHas), as the bounds of an integer's sign prove it finite.
 */
const boundsPremise = (
	operand: OperandIndex,
	fact: Fact,
	bounds: Bounds | undefined
): IntervalPremise | undefined => {
	const p = bounds === undefined ? undefined : intervalPremise(operand, bounds)
	return p !== undefined && premiseHas(p, fact) ? p : undefined
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

/** The guard a refusal names, for the precondition it lacks. */
const guardText = (precondition: PreconditionKind, operand: string, operation: string): string => {
	switch (precondition) {
		case "nonzero":
			return `Compute.when(Compute.nonzero(${operand}), (${operand}) => ${operation}, <your value>)`
		case "nonnegative":
			return `Compute.when(Compute.nonnegative(${operand}), (${operand}) => ${operation}, <your value>)`
		case "finite":
			return `Compute.when(Compute.isFinite(${operand}), (${operand}) => ${operation}, <your value>)`
		case "fits":
		case "contract":
		case "powerDomain":
		case "bucketDomain":
			return `Compute.when(Compute.within(${operand}, <low>, <high>), (${operand}) => ${operation}, <your value>), its bounds within which the operation is defined`
	}
}

/** An expression's spelling in a refusal. */
const exprText = (e: ScalarExpr): string => {
	switch (e.kind) {
		case "column":
			return e.column.name
		case "param":
			return "parameter"
		case "value":
			return "VALUE"
		case "literal":
			return canonicalTextOf(e.value)
		case "op":
		case "cast":
		case "domainCast":
		case "cond":
			return "x"
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
				digits: Math.min(bounds.digits, numericMaxIntegerDigits.value),
				scale: bounds.scale
			})

/** How a cast converts: a registered cast, or the binary coercion that drops a refinement or widens a bound. */
type CastHow = { readonly kind: "registered"; readonly op: CastOp } | { readonly kind: "coercion" }

/** A Compute.when guard the lowering stands in the branch of: its subject, and what it establishes of it there. */
interface WhenGuard {
	readonly subject: ScalarExpr
	readonly refinement: Refinement
	readonly facts: ReadonlyArray<Fact>
}

class Lowering<R extends Refs> {
	readonly env: LowerEnv<R>
	/** The Compute.when guards whose branch the lowering stands in, innermost last. */
	readonly #guards: ReadonlyArray<WhenGuard>

	constructor(env: LowerEnv<R>, guards: ReadonlyArray<WhenGuard>) {
		this.env = env
		this.#guards = guards
	}

	get check(): boolean {
		return this.env.mode === "check"
	}

	/** The type a bare literal adopts opposite a term of type t (see the header). */
	adopt(t: ScalarType, role: Role): ScalarType {
		if (role === "compare" && contractOf(t) !== undefined) {
			return withoutSerial(t)
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

	/**
	 * A lowered node with what is proved of it: the bounds and facts its type gives every value unless the caller states
	 * what its computation proves, then refined by each enclosing Compute.when guard whose subject this node is. A
	 * numeric bound past numeric's numericMaxIntegerDigits is ResourceBound: every numeric expression's is known. A builder
	 * types its term and refuses only what is malformed; the bound is compilation's, a typed refusal of the compile.
	 */
	settle(
		entry: ScalarExpr,
		nominal: ScalarType,
		proved: { readonly bounds: Bounds | undefined; readonly facts: FactSet } | undefined
	): Lowered {
		let bounds = proved === undefined ? boundsOfType(nominal) : proved.bounds
		let facts: FactSet = proved === undefined ? factsOfType(nominal) : proved.facts
		for (const g of this.#guards) {
			if (!sameExpr(g.subject, entry)) {
				continue
			}
			bounds = bounds === undefined ? undefined : refine(bounds, g.refinement)
			const added: { [F in Fact]?: FactSet[F] } = { ...facts }
			for (const f of g.facts) {
				added[f] = { kind: "guard" }
			}
			facts = Object.freeze(added)
		}
		if (
			this.env.mode !== "build" &&
			bounds !== undefined &&
			bounds.digits > numericMaxIntegerDigits.value
		) {
			throw new Refusal(
				CompileError.make({
					_tag: "ResourceBound",
					at: this.env.loc,
					bound: {
						kind: "numericDigits",
						limit: numericMaxIntegerDigits.value,
						needed: bounds.digits
					}
				})
			)
		}
		return {
			expr: entry,
			nominal,
			actual: entry.type,
			volatility: entry.volatility,
			bounds,
			facts
		}
	}

	/** The node of `spec`, recorded: of its own type nominally and actually, its bounds and facts its type's. */
	emit(spec: ExprSpec): Lowered {
		const entry = this.env.emit(spec)
		return this.settle(entry, entry.type, undefined)
	}

	/** The node of `spec`, recorded, with the bounds and facts its computation proves. */
	/**
	 * A node of `spec` with what its computation proved: a computed numeric's type carries exactly the bounds proved of
	 * it (numericOf), the one place a numeric node is typed, so its type is its proof wherever it is read again.
	 */
	emitProved(spec: ExprSpec, bounds: Bounds | undefined, facts: FactSet): Lowered {
		const entry = this.env.emit(
			isComputedNumeric(spec.type) ? { ...spec, type: numericOf(bounds) } : spec
		)
		return this.settle(entry, entry.type, { bounds, facts })
	}

	/**
	 * What a builder records for a partial operation: a stand-in of its result type. A builder types the term it
	 * constructs before it knows where the term stands (the guard around it, its operands' facts there), so the proof of
	 * the precondition is compilation's, which lowers the whole description again in its place.
	 */
	typedOnly(type: ScalarType, bounds: Bounds | undefined): Lowered {
		return this.emitProved({ kind: "value", args: [], type, nonNull: "storage" }, bounds, noFacts)
	}

	/**
	 * A node of the registry's `op` over `args`, of `type`: an overload defined everywhere names its DefinedOp, an IEEE
	 * 754 one with the proof that PostgreSQL's own overload computes it there where its operands' premises give one
	 * (nativeProofOf) and its exact result's bounds as IEEE 754 rounds them (native.ts resultBounds), and a partial one
	 * stands only with the proof of every precondition its Totality requires, or is refused as PartialOperation (prove).
	 */
	native(
		op: NativeOp,
		args: ReadonlyArray<Lowered>,
		type: ScalarType,
		bounds: Bounds | undefined,
		at: SourceLoc,
		operation: string
	): Lowered {
		const operands = args.map((a) => a.expr)
		if (!op.partial) {
			const native = this.nativeProofOf(op, args, type)
			const rounded = resultBounds(op, type, bounds)
			return this.emitProved(
				native === undefined
					? {
							kind: "op",
							op: op.id,
							args: operands,
							type,
							nonNull: "strict",
							volatility: op.volatility
						}
					: {
							kind: "op",
							op: op.id,
							args: operands,
							type,
							nonNull: "strict",
							volatility: op.volatility,
							native
						},
				rounded,
				noFacts
			)
		}
		if (this.env.mode === "build") {
			return this.typedOnly(type, bounds)
		}
		const proof = this.proveAll(op.totality.preconditions, args, type, at, operation)
		return this.emitProved(
			{
				kind: "op",
				op: op.id,
				args: operands,
				type,
				nonNull: "strict",
				volatility: op.volatility,
				proof
			},
			bounds,
			noFacts
		)
	}

	/**
	 * The proof that PostgreSQL's own overload computes an IEEE 754 operation or rounding `op` into `type` over `args`
	 * (native.ts nativeProof), where its operands' premises give one; none for any other overload, and none in a builder,
	 * which types its term before it knows where the term stands.
	 */
	nativeProofOf(
		op: NativeOp,
		args: ReadonlyArray<Lowered>,
		type: ScalarType
	): NativeProof | undefined {
		const carrier = baseOf(type).carrier
		const [first] = args
		return op.totality.kind !== "ieee" ||
			this.env.mode === "build" ||
			first === undefined ||
			(carrier !== "float4" && carrier !== "float8")
			? undefined
			: nativeProof(op.totality.op, carrier, first.expr.type, args)
	}

	/**
	 * One proof of a partial operation's preconditions over `args`, whose premises establish them all, or the
	 * PartialOperation refusal of the first one nothing proves.
	 */
	proveAll(
		preconditions: NonEmptyReadonlyArray<Precondition>,
		args: ReadonlyArray<Lowered>,
		target: ScalarType,
		at: SourceLoc,
		operation: string
	): OperationProof {
		return mapNonEmpty(preconditions, (p) => this.prove(p, args, target, at, operation))
	}

	/**
	 * The proof of one precondition over `args`: a fact precondition by its operand's fact, a magnitude one by the
	 * operand's bounds; or the PartialOperation refusal naming the guard to write.
	 */
	prove(
		precondition: Precondition,
		args: ReadonlyArray<Lowered>,
		target: ScalarType,
		at: SourceLoc,
		operation: string
	): PreconditionProof {
		const refuse = (operand: number): never => {
			const named = args[operand]
			const text = named === undefined ? "x" : exprText(named.expr)
			throw new Refusal(
				CompileError.make({
					_tag: "PartialOperation",
					at,
					operation,
					precondition: precondition.kind,
					operand: text,
					guard: guardText(precondition.kind, text, operation)
				})
			)
		}
		switch (precondition.kind) {
			case "nonzero":
			case "nonnegative":
			case "finite": {
				const a = args[precondition.operand]
				const p =
					a === undefined
						? undefined
						: (factPremise(precondition.operand, precondition.kind, a.facts) ??
							boundsPremise(precondition.operand, precondition.kind, a.bounds))
				return p === undefined ? refuse(precondition.operand) : { precondition, premises: [p] }
			}
			case "fits": {
				const a = args[0]
				const range = fitRange(target)
				const interval = a?.bounds === undefined ? undefined : intervalPremise(0, a.bounds)
				if (
					range === undefined ||
					interval === undefined ||
					!insideRange(interval.low, interval.high, range[0], range[1])
				) {
					return refuse(0)
				}
				return { precondition, premises: [interval] }
			}
			case "contract": {
				const a = args[0]
				const interval = a?.bounds === undefined ? undefined : finitePremise(0, a.bounds)
				if (
					a?.bounds === undefined ||
					interval === undefined ||
					!contractHolds(target, a.nominal, a.bounds)
				) {
					return refuse(0)
				}
				return { precondition, premises: [interval] }
			}
			case "powerDomain": {
				const [base, exponent] = args
				const premises =
					base === undefined || exponent === undefined
						? undefined
						: powerPremises(base, exponent, target)
				return premises === undefined ? refuse(0) : { precondition, premises }
			}
			case "bucketDomain": {
				const [, low, high, count] = args
				const premises =
					low === undefined || high === undefined || count === undefined
						? undefined
						: bucketPremises(low, high, count)
				return premises === undefined ? refuse(1) : { precondition, premises }
			}
		}
	}

	/**
	 * A cast node from `arg`'s actual type to `to`, converting as `how` states: a registered cast defined everywhere, a
	 * partial one with the proof of its preconditions, or the binary coercion. In a check a conversion into a float, an
	 * IEEE 754 rounding, is refused with float arithmetic.
	 */
	castNode(arg: Lowered, to: ScalarType, how: CastHow, at: SourceLoc): Lowered {
		const conversion = conversionOf(arg.actual, to, how)
		const bounds = arg.bounds === undefined ? undefined : castBounds(arg.bounds, conversion, to)
		const facts = keptFacts(arg, conversion, to)
		if (how.kind === "coercion") {
			return this.emitProved(
				{
					kind: "cast",
					cast: binaryCoercion,
					args: [arg.expr],
					type: to,
					nonNull: "strict",
					volatility: "immutable"
				},
				bounds,
				facts
			)
		}
		const { op } = how
		if (!op.partial) {
			if (this.check && op.totality.kind === "ieee") {
				return this.floatArithmetic("cast", to, at)
			}
			const native = this.nativeProofOf(op, [arg], to)
			return this.emitProved(
				native === undefined
					? {
							kind: "cast",
							cast: op.id,
							args: [arg.expr],
							type: to,
							nonNull: "strict",
							volatility: op.volatility
						}
					: {
							kind: "cast",
							cast: op.id,
							args: [arg.expr],
							type: to,
							nonNull: "strict",
							volatility: op.volatility,
							native
						},
				bounds,
				facts
			)
		}
		if (this.env.mode === "build") {
			return this.typedOnly(to, bounds)
		}
		const proof = this.proveAll(
			op.totality.preconditions,
			[arg],
			to,
			at,
			`Compute.cast(${exprText(arg.expr)}, ${typeLabel(to)})`
		)
		return this.emitProved(
			{
				kind: "cast",
				cast: op.id,
				args: [arg.expr],
				type: to,
				nonNull: "strict",
				volatility: op.volatility,
				proof
			},
			bounds,
			facts
		)
	}

	/**
	 * A coercion into `to`'s contract or regex refinement, which PostgreSQL validates: admitted with the proof that the
	 * value satisfies it, a literal judged before any SQL (ContractLiteral), a parameter checked at bind
	 * (codec/scalar.ts paramEncoder), or a value whose bounds satisfy each contract level's predicate; else
	 * PartialOperation.
	 */
	domainCast(
		value: Lowered,
		to: ScalarType,
		checked: "literal" | "parameter" | undefined,
		at: SourceLoc
	): Lowered {
		if (this.env.mode === "build") {
			return this.typedOnly(to, value.bounds)
		}
		const proof: OperationProof = [
			checked === undefined || !this.checkedAgainst(value, to, checked, at)
				? this.prove(
						{ kind: "contract" },
						[value],
						to,
						at,
						`Compute.cast(${exprText(value.expr)}, ${typeLabel(to)})`
					)
				: {
						precondition: { kind: "contract" },
						premises: [{ kind: "checked", operand: 0, by: checked }]
					}
		]
		return this.emitProved(
			{ kind: "domainCast", args: [value.expr], type: to, nonNull: "strict", proof },
			value.bounds,
			{ ...value.facts, ...factsOfType(to) }
		)
	}

	/**
	 * Whether a literal's or a parameter's check covers `to`'s refinements: its own type carries them, which its
	 * admission judged (a literal adopting a contract, ContractLiteral) or its binding checks (a parameter of its declared
	 * type); or, a literal, it is judged against them here, a violation ContractLiteral. Undecided, the cast is proved as
	 * any value's is.
	 */
	checkedAgainst(
		value: Lowered,
		to: ScalarType,
		checked: "literal" | "parameter",
		at: SourceLoc
	): boolean {
		if (sameRefinement(value.nominal, to)) {
			return true
		}
		const env = this.env
		if (env.mode === "build" || checked !== "literal" || value.expr.kind !== "literal") {
			return false
		}
		const member = literalMember(value.expr.value, to, env.regexMember)
		if (member === false) {
			return stop(
				"ContractLiteral",
				at,
				`a literal of ${typeLabel(to)}: the literal violates its ${contractOf(to) === undefined ? "regex refinement" : "contract"}`
			)
		}
		return member === true
	}

	/**
	 * A literal node: of `type`, a computed numeric's bounded by the literal's own value, which is all it can be, with
	 * the bounds and facts of that value.
	 */
	literalNode(typed: CarriedLiteral, type: ScalarType): Lowered {
		const n = literalNumber(typed.value)
		const point = n === undefined ? undefined : typeof n === "object" ? ofPoint(n) : ofSpecial(n)
		const at = isComputedNumeric(type) ? numericOf(point) : type
		const entry = this.env.emit({
			kind: "literal",
			value: typed.literal,
			args: [],
			type: at,
			nonNull: "literal"
		})
		if (n === undefined || point === undefined || boundsOfType(at) === undefined) {
			return this.settle(entry, at, undefined)
		}
		return this.settle(entry, at, {
			bounds: point,
			facts: Object.freeze({ ...factsOfType(at), ...factsOfValue(n) })
		})
	}

	/**
	 * A literal adopting `type`, admitted as every typed slot admits one (evaluate.ts admitLiteral): the base first,
	 * then, outside a builder, the contract and the regex refinement.
	 */
	literal(value: LiteralDesc, type: ScalarType, at: SourceLoc): Lowered {
		const admitted = admitLiteral(
			value,
			type,
			this.env.mode === "build"
				? { kind: "shape" }
				: { kind: "refinements", regexMember: this.env.regexMember }
		)
		if (!admitted.ok) {
			return stop(admitted.error.reason, at, admitted.error.capability)
		}
		return this.literalNode(admitted.value, type)
	}

	/**
	 * A parameter, of its declared type: a term like any other, its serial its integer. The placeholder is bound as the
	 * type's base, never a refined domain, which is the node's actual type even where the declared type is a contract or a
	 * regex refinement: its binding checks the value against them before any SQL (codec/scalar.ts paramEncoder), so the
	 * parameter has its type's bounds and facts, a contract's declared ones among them.
	 */
	param(param: ParamRef<R>, at: SourceLoc): Lowered {
		const params = this.env.params
		if (params.kind === "none") {
			return stop(
				"UnsupportedOperation",
				at,
				"a parameter: a contract predicate or a row check reads only its value or its row"
			)
		}
		const { spec, type } = unwrap(params.lower(param, at))
		return this.settle(this.env.emit(spec), type, undefined)
	}

	/** A term: anything but an untyped literal, which takes the type of the term it meets. */
	term(desc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
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
	 * which the operation widens exactly (exactPair).
	 */
	operand(desc: ExprDesc<Located, R>, against: Lowered, role: Role, at: SourceLoc): Lowered {
		if (desc.kind === "literal" && desc.type === undefined) {
			return this.literal(desc.value, this.adopt(against.nominal, role), at)
		}
		const term = this.lower(desc, at)
		if (!meets(against.nominal, term.nominal)) {
			return stop(
				"MalformedDescription",
				at,
				`operands of one type: ${typeLabel(against.nominal)} never meets ${typeLabel(term.nominal)} without Compute.base`
			)
		}
		return term
	}

	/** Two operands that meet, each at the type it meets the other at (types.ts meetingType). */
	exactPair(a: Lowered, b: Lowered, at: SourceLoc): readonly [Lowered, Lowered] {
		return [
			this.widenTo(a, meetingType(a.nominal, b.nominal), at),
			this.widenTo(b, meetingType(b.nominal, a.nominal), at)
		]
	}

	/** A plain integer or money value widened into its exact family, at its own bound (types.ts meetingType). */
	widenExact(x: Lowered, family: "exactInteger" | "exactMoney", at: SourceLoc): Lowered {
		return this.widenTo(x, meetingType(x.nominal, exactType(family, 0)), at)
	}

	/** A value widened into `to` by the one widening (types.ts wideningOf): itself where `to` is its own type. */
	widenTo(x: Lowered, to: ScalarType, at: SourceLoc): Lowered {
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
				`${fn}: PostgreSQL has no ${fn} over ${carriers.map(typeLabel).join(", ")} that Compute admits`
			)
		}
		return op
	}

	/** LEAST or GREATEST over operands of `type`. */
	extreme(fn: "least" | "greatest", type: ScalarType, at: SourceLoc): ExtremeOp {
		const op = extremeOf(fn, baseOf(type).carrier)
		if (op === undefined) {
			return stop(
				"UnsupportedOperation",
				at,
				`${fn}: PostgreSQL has no ${fn} over ${typeLabel(type)} that Compute admits`
			)
		}
		return op
	}

	/**
	 * The result type of a fixed-result operation: an exact overload's exact type, or an exact carrier's own, bounded by
	 * its result's digits; a numeric result a computed numeric of its result's bounds; any other overload's registered
	 * result.
	 */
	resultType(op: FixedOp, bounds: Bounds | undefined): ScalarType {
		const digits = bounds?.digits ?? 0
		if (op.totality.kind === "exact") {
			return exactType(op.totality.yields === "integer" ? "exactInteger" : "exactMoney", digits)
		}
		const r = op.result
		return r === "exactInteger" || r === "exactMoney"
			? exactType(r, digits)
			: r === "numeric"
				? numericOf(bounds)
				: plainType(r)
	}

	lower(desc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		switch (desc.kind) {
			case "var":
			case "field":
			case "value":
			case "parent":
				return this.emit(unwrap(this.env.leaf(desc, at)))
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
				return { ...arg, nominal: valueType(arg.nominal) }
			}
			case "cond":
				return this.cond(desc, at)
			case "when":
				return this.when(desc, at)
			case "compare": {
				const left = this.term(desc.left, childLoc(at, desc.op, "left"))
				const right = this.operand(desc.right, left, "compare", childLoc(at, desc.op, "right"))
				return this.comparison(desc.op, [left, right], at)
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
				const values = desc.values.map((v, i) => this.literal(v, type, childLoc(at, "in", i)))
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
			case "allen":
			case "pointIn":
			case "absent": {
				if (this.env.mode !== "query") {
					return stop(
						"UnsupportedOperation",
						at,
						`${desc.kind}: lowered by its own package, not the Compute catalogue`
					)
				}
				return unwrap(
					this.env.extension(desc, at, (child) =>
						catchRefusal(() => this.lower(child, childLoc(at, desc.kind)))
					)
				)
			}
		}
	}

	predicate(desc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		const p = this.term(desc, at)
		if (baseOf(p.actual).carrier !== "bool") {
			return stop("MalformedDescription", at, `a predicate, not ${typeLabel(p.nominal)}`)
		}
		return p
	}

	/** A literal that meets no term. */
	bareLiteral(value: LiteralDesc, at: SourceLoc): Lowered {
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
		operands: ReadonlyArray<Lowered>,
		at: SourceLoc
	): Lowered {
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
		if (!first.actual.caps.includes(capability)) {
			return stop(
				"UnsupportedOperation",
				at,
				`${capability}: ${typeLabel(first.nominal)} has no ${fn}`
			)
		}
		const op = this.overload(fn, fn === "in" ? [first.actual] : args.map((a) => a.actual), at)
		return this.native(op, args, plainType("bool"), undefined, at, fn)
	}

	/** Compute.cond: a conditional over any predicate, guarding nothing (Compute.when is the one guard). */
	cond(desc: Extract<ExprDesc<Located, R>, { readonly kind: "cond" }>, at: SourceLoc): Lowered {
		const p = this.predicate(desc.pred, childLoc(at, "cond"))
		const [onTrue, onFalse] = this.branches(
			desc.onTrue,
			desc.onFalse,
			childLoc(at, "cond", "then"),
			childLoc(at, "cond", "else")
		)
		return this.conditional(p, onTrue, onFalse, at)
	}

	/**
	 * A conditional's two branches, typed: a term fixes its type and a bare literal opposite it adopts it; of two bare
	 * literals the first fixes it, at its value's own type.
	 */
	branches(
		then: ExprDesc<Located, R>,
		otherwise: ExprDesc<Located, R>,
		thenAt: SourceLoc,
		elseAt: SourceLoc
	): readonly [Lowered, Lowered] {
		if (!isBareLiteral(then)) {
			const t = this.term(then, thenAt)
			return [t, this.operand(otherwise, t, "compare", elseAt)]
		}
		if (!isBareLiteral(otherwise)) {
			const e = this.term(otherwise, elseAt)
			return [this.operand(then, e, "compare", thenAt), e]
		}
		const t = this.lower(then, thenAt)
		return [t, this.operand(otherwise, t, "compare", elseAt)]
	}

	/**
	 * The CASE over `p` of two typed branches, each converted into their common type (types.ts commonType): unchanged, by
	 * a registered widening, by the binary coercion, or into the common contract with its proof (convert). Its values
	 * are its branches' hull, and its facts the ones both branches have.
	 */
	conditional(p: Lowered, onTrue: Lowered, onFalse: Lowered, at: SourceLoc): Lowered {
		const type = commonType(onTrue.nominal, onFalse.nominal)
		const t = this.convert(onTrue, type, at)
		const e = this.convert(onFalse, type, at)
		const bounds =
			t.bounds !== undefined && e.bounds !== undefined ? hullBounds(t.bounds, e.bounds) : undefined
		const both: { [F in Fact]?: FactSet[F] } = {}
		for (const f of ["nonzero", "nonnegative", "finite"] as const) {
			const source = t.facts[f]
			if (source !== undefined && e.facts[f] !== undefined) {
				both[f] = source
			}
		}
		return this.emitProved(
			{ kind: "cond", args: [p.expr, t.expr, e.expr], type, nonNull: "cond" },
			bounds,
			Object.freeze(both)
		)
	}

	/** A value converted into `type`, a supertype of its own: unchanged, widened, coerced, or cast into a contract. */
	convert(b: Lowered, type: ScalarType, at: SourceLoc): Lowered {
		if (sameShape(b.actual, type)) {
			return b
		}
		if (contractOf(type) !== undefined && !sameRefinement(b.actual, type)) {
			const base = this.convert(b, baseOf(type), at)
			return this.domainCast(base, type, checkedKind(b.expr), at)
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
	 * Compute.when, the one guard of a partial operation: CASE WHEN <the guard over the subject> THEN <then> ELSE
	 * <otherwise> END, where every occurrence of the subject inside the then branch has what the guard establishes, its
	 * facts and its refined interval. PostgreSQL evaluates a CASE result only where its WHEN holds, and drops unsimplified
	 * the result a WHEN constant at plan time does not take (a parameter's), so the then branch never meets a value the
	 * guard excludes. A guard refines only its own subject: a precondition over constants is proved by the constants
	 * alone, never by a guard on something else, since PostgreSQL may fold a constant then branch at plan time.
	 */
	when(desc: Extract<ExprDesc<Located, R>, { readonly kind: "when" }>, at: SourceLoc): Lowered {
		const here = childLoc(at, "when")
		const subject = this.term(desc.subject, childLoc(here, "subject"))
		const guard = this.guardPredicate(desc.guard, subject, here)
		const guarded = new Lowering(this.env, [
			...this.#guards,
			{
				subject: subject.expr,
				refinement: guardRefinement(desc.guard, guard.within),
				facts: guardFacts(desc.guard, guard.within)
			}
		])
		const onTrue = guarded.term(desc.proved, childLoc(here, "proved"))
		const onFalse = this.operand(desc.otherwise, onTrue, "compare", childLoc(here, "otherwise"))
		return this.conditional(guard.predicate, onTrue, onFalse, at)
	}

	/**
	 * The predicate a guard tests over its subject, and the interval it states where it states one: `<> 0`, `>= 0`,
	 * `> 0`, `> '-Infinity' AND < 'Infinity'`, or BETWEEN two literals of the subject's type.
	 */
	guardPredicate(
		guard: GuardDesc,
		subject: Lowered,
		at: SourceLoc
	): { readonly predicate: Lowered; readonly within: readonly [Exact, Exact] | undefined } {
		const v = valueType(subject.nominal)
		const compareTo = (literal: LiteralDesc): Lowered =>
			this.literal(literal, this.adopt(subject.nominal, "compare"), at)
		switch (guard.kind) {
			case "nonzero":
				return {
					predicate: this.comparison("ne", [subject, compareTo(zeroLiteral(v))], at),
					within: undefined
				}
			case "nonnegative":
				return {
					predicate: this.comparison("ge", [subject, compareTo(zeroLiteral(v))], at),
					within: undefined
				}
			case "positive":
				return {
					predicate: this.comparison("gt", [subject, compareTo(zeroLiteral(v))], at),
					within: undefined
				}
			case "finite": {
				if (v.carrier !== "numeric" && !isFloat(v)) {
					return stop(
						"MalformedDescription",
						at,
						`Compute.isFinite over a numeric or float term, not ${typeLabel(v)}, which is finite by its type`
					)
				}
				const above = this.comparison("gt", [subject, compareTo(infiniteLiteral(v, -1))], at)
				const below = this.comparison("lt", [subject, compareTo(infiniteLiteral(v, 1))], at)
				const op = this.overload("and", [plainType("bool")], at)
				return {
					predicate: this.native(op, [above, below], plainType("bool"), undefined, at, "and"),
					within: undefined
				}
			}
			case "within": {
				const lo = compareTo(guard.low)
				const hi = compareTo(guard.high)
				const low = lo.bounds === undefined ? undefined : pointOf(lo.bounds)
				const high = hi.bounds === undefined ? undefined : pointOf(hi.bounds)
				if (low === undefined || high === undefined) {
					return stop("MalformedDescription", at, "Compute.within's bounds: two finite literals")
				}
				return { predicate: this.comparison("between", [subject, lo, hi], at), within: [low, high] }
			}
		}
	}

	cast(desc: Extract<ExprDesc<Located, R>, { readonly kind: "cast" }>, at: SourceLoc): Lowered {
		const arg = this.term(desc.arg, childLoc(at, "cast"))
		const to = withoutSerial(unwrap(this.env.fieldType(desc.to, childLoc(at, "cast", "to"))))
		return this.castTo(arg, to, childLoc(at, "cast"))
	}

	/**
	 * Compute.cast: a registered conversion of the value types, then the target's numeric typmod coercion, then a domain
	 * cast into a contract or a regex-refined text type, or the binary coercion that drops a typmod or a regex into the
	 * plain type, so the node delivered is of the type the cast names. A cast that changes nothing emits nothing. Each step is defined
	 * everywhere or proved where it stands (castNode, domainCast); a conversion into a float rounds as IEEE 754 does.
	 */
	castTo(arg: Lowered, to: ScalarType, at: SourceLoc): Lowered {
		const target = baseOf(to)
		const from = valueType(arg.actual)
		let value = arg
		if (from.carrier !== target.carrier) {
			const op = castOf(from.carrier, target.carrier)
			if (op === undefined) {
				return stop(
					"UnsupportedOperation",
					at,
					`cast: PostgreSQL has no cast from ${typeLabel(from)} to ${typeLabel(target)} that Compute admits`
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
		if (isRefined(to) && !sameRefinement(arg.actual, to)) {
			return this.domainCast(value, to, checkedKind(arg.expr), at)
		}
		const plain = contractOf(value.actual) === undefined && contractOf(to) === undefined
		const shaped =
			plain && !sameShape(value.actual, to)
				? this.castNode(value, to, { kind: "coercion" }, at)
				: value
		return { ...shaped, nominal: to, actual: plain ? to : shaped.actual }
	}

	/**
	 * A numeric value coerced into `target`'s typmod: a numeric literal as the literal of the value the coercion stores,
	 * rounded to the scale half away from zero (values/decimal.ts normalizeNumeric), so a contract over the typmod judges
	 * that literal (ContractLiteral); any other value, or a literal the precision cannot hold, by the typmod cast and its
	 * fits proof.
	 */
	typmodCoercion(value: Lowered, target: ScalarType, at: SourceLoc): Lowered {
		const literal = value.expr.kind === "literal" ? value.expr.value : undefined
		const coerced =
			literal?.kind === "numeric"
				? normalizeNumeric(Decimal.fromValue(literal.value), numericTypmodOf(target))
				: undefined
		if (coerced?.ok === true) {
			return this.literalNode(
				{ literal: { kind: "numeric", value: coerced.value }, value: coerced.value },
				target
			)
		}
		return this.castNode(
			value,
			target,
			{ kind: "registered", op: registeredCast("numeric", "numeric") },
			at
		)
	}

	compute(
		desc: Extract<ExprDesc<Located, R>, { readonly kind: "compute" }>,
		at: SourceLoc
	): Lowered {
		const { fn } = desc
		const here = childLoc(at, fn)
		if (this.check && !checkMembers.has(fn)) {
			return stop(
				"UnsupportedOperation",
				here,
				`${fn} in a contract predicate or row check: a check admits the operations the host evaluates for the ContractLiteral check, which are comparisons, between, in, boolean composition, abs, sign, arithmetic, Compute.cond, Compute.when, casts, charLength and span endpoints`
			)
		}
		const arity: Readonly<Record<string, number | undefined>> = {
			neg: 1,
			abs: 1,
			sign: 1,
			round: 1,
			trunc: 1,
			ceil: 1,
			floor: 1,
			sqrt: 1,
			minScale: 1,
			numeric: 1,
			lower: 1,
			upper: 1,
			width: 1,
			charLength: 1,
			add: 2,
			sub: 2,
			mul: 2,
			div: 2,
			mod: 2,
			quot: 2,
			rem: 2,
			gcd: 2,
			lcm: 2,
			power: 2,
			cosineDistance: 2,
			widthBucket: 4
		}
		const expected = arity[fn]
		if (expected !== undefined && desc.args.length !== expected) {
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
				const b = this.operand(arg(1), a, "operand", here)
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
					`Compute.${desc.fn}(${exprText(a.expr)}, ${exprText(b.expr)})`
				)
			}
			case "power": {
				const a = this.term(arg(0), here)
				const b = this.operand(arg(1), a, "operand", here)
				const v = valueType(a.nominal)
				const op = this.overload("power", [v, v], here)
				const bounds = powerBounds(a, b, v)
				return this.native(
					op,
					[a, b],
					this.resultType(op, bounds),
					bounds,
					here,
					`Compute.power(${exprText(a.expr)}, ${exprText(b.expr)})`
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
					return this.native(
						op,
						[a],
						this.resultType(op, bounds),
						bounds,
						here,
						`Compute.${desc.fn}`
					)
				}
				const digits = this.literal(desc.scale, plainType("int4"), childLoc(here, "scale"))
				const op = this.overload(desc.fn, [valueType(a.nominal), plainType("int4")], here)
				return this.native(
					op,
					[a, digits],
					this.resultType(op, bounds),
					bounds,
					here,
					`Compute.${desc.fn}`
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
					ofRange(
						0n,
						BigInt(numericMaxFractionDigits.value),
						String(numericMaxFractionDigits.value).length
					),
					here,
					`Compute.minScale(${exprText(a.expr)})`
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
							: ofDigits(Math.ceil(a.bounds.digits / 2) + 1, numericMaxDisplayScale.value, {
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
					`Compute.${desc.fn}(${exprText(a.expr)})`
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
					return this.operand(d, a, "compare", childLoc(here, i + 1))
				})
				const all = [a, ...others]
				const type = all.reduce((t, x) => commonType(t, x.nominal), a.nominal)
				if (!type.caps.includes("ordering")) {
					return stop(
						"UnsupportedOperation",
						here,
						`ordering: ${typeLabel(type)} has no ${desc.fn}`
					)
				}
				const converted = all.map((x) => this.convert(x, type, here))
				const op = this.extreme(desc.fn, type, here)
				const [head, ...tail] = converted
				const bounds = tail.reduce<Bounds | undefined>(
					(acc, x) =>
						acc === undefined || x.bounds === undefined ? undefined : hullBounds(acc, x.bounds),
					head?.bounds
				)
				return this.native(op, converted, type, bounds, here, desc.fn)
			}
			case "widthBucket":
				return this.widthBucket(args, here)
			case "lower":
			case "upper": {
				const s = this.span(arg(0), here)
				const endpoint = withoutSerial(s.span)
				const op = this.overload(desc.fn, [s.lowered.actual], here)
				return this.native(op, [s.lowered], endpoint, boundsOfType(endpoint), here, desc.fn)
			}
			case "width":
				return this.width(arg(0), here)
			case "charLength": {
				if (this.env.mode === "query") {
					return stop(
						"UnsupportedOperation",
						here,
						"charLength in a query: it exists only in contract predicates and row checks, because queries have no text functions"
					)
				}
				const a = this.term(arg(0), here)
				if (baseOf(a.actual).carrier !== "text") {
					return stop(
						"MalformedDescription",
						here,
						`a text term for charLength, not ${typeLabel(a.nominal)}`
					)
				}
				const op = this.overload("charLength", [a.actual], here)
				const bounds = ofRange(0n, BigInt(maxAllocSize.value), String(maxAllocSize.value).length)
				return this.native(op, [a], this.resultType(op, bounds), bounds, here, "charLength")
			}
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
	 * Compute.numeric: PostgreSQL's conversion of a value into numeric, `x::numeric`, a computed numeric typed by what
	 * the conversion proves of it (castNode, emitProved): a registered cast from an integer, money, an exact value or a
	 * float; the binary coercion from a numeric(p, s), its typmod dropped; a computed numeric itself.
	 */
	numeric(a: Lowered, at: SourceLoc): Lowered {
		const from = valueType(a.actual)
		if (isComputedNumeric(from)) {
			return a
		}
		if (from.carrier === "numeric") {
			return this.castNode(a, anyNumeric, { kind: "coercion" }, at)
		}
		const op = castOf(from.carrier, "numeric")
		return op === undefined
			? stop(
					"UnsupportedOperation",
					at,
					`Compute.numeric: PostgreSQL has no cast from ${typeLabel(from)} to numeric that Compute admits`
				)
			: this.castNode(a, anyNumeric, { kind: "registered", op }, at)
	}

	requireNumeric(t: ScalarType, fn: string, at: SourceLoc): void {
		if (baseOf(t).carrier !== "numeric") {
			stop("MalformedDescription", at, `a numeric term for ${fn}, not ${typeLabel(t)}`)
		}
	}

	/**
	 * The refusal of float arithmetic in a check, the one a check always had: its IEEE 754 rendering binds a compound
	 * operand in a scalar subquery, which a CHECK cannot hold; and of money arithmetic there, whose exact form reads money
	 * through numeric, a STABLE cast, where a CHECK is immutable.
	 */
	floatArithmetic(fn: string, t: ScalarType, at: SourceLoc): never {
		return stop(
			"UnsupportedOperation",
			at,
			`${fn} over ${typeLabel(t)} in a contract predicate or row check: float arithmetic renders through a scalar subquery and money arithmetic through money's STABLE cast to numeric, and a CHECK holds neither`
		)
	}

	/**
	 * +, -, *, / and % over one numeric family: integers and money exactly (exact integers and exact money, bounded by
	 * their operands' digits), integer division truncating over the exact integers, numeric as PostgreSQL computes it
	 * within its digit bounds, floats as IEEE 754. A divisor is proved nonzero by its facts, except a float's, whose
	 * quotient by zero IEEE 754 defines.
	 */
	arithmetic(
		fn: "add" | "sub" | "mul" | "div" | "mod",
		left: ExprDesc<Located, R>,
		right: ExprDesc<Located, R>,
		at: SourceLoc
	): Lowered {
		const a0 = this.term(left, at)
		const b0 = this.operand(right, a0, "operand", at)
		const va = valueType(a0.nominal)
		if (this.check && (isFloat(va) || va.carrier === "money" || va.carrier === "exactMoney")) {
			return this.floatArithmetic(fn, va, at)
		}
		const operation = `Compute.${fn}(${exprText(a0.expr)}, ${exprText(b0.expr)})`
		if (fn === "div" && exactFamily(va) === "exactInteger") {
			const a = this.widenExact(a0, "exactInteger", at)
			const b = this.widenExact(b0, "exactInteger", at)
			const op = this.overload("div", [a.actual, b.actual], at)
			const bounds = ofDigits(a.bounds?.digits ?? 0, 0, { infinite: false, nan: false })
			return this.native(op, [a, b], this.resultType(op, bounds), bounds, at, operation)
		}
		const [a, b] = this.exactPair(a0, b0, at)
		const op = this.overload(fn, [valueType(a.nominal), valueType(b.nominal)], at)
		const bounds = arithmeticBounds(fn, a.bounds, b.bounds)
		return this.native(op, [a, b], this.resultType(op, bounds), bounds, at, operation)
	}

	/** neg and abs: an integer's exactly, a numeric's and a float's as PostgreSQL computes them, exactly. */
	unary(fn: "neg" | "abs", a: Lowered, at: SourceLoc): Lowered {
		const op = this.overload(fn, [valueType(a.nominal)], at)
		const bounds =
			a.bounds === undefined ? undefined : fn === "neg" ? negBounds(a.bounds) : absBounds(a.bounds)
		return this.native(op, [a], this.resultType(op, bounds), bounds, at, `Compute.${fn}`)
	}

	/**
	 * sign returns the operand's value type, unconstrained. PostgreSQL has sign(numeric) and sign(double precision) only,
	 * whose results carry no typmod (a numeric(p, s) operand's sign is a numeric, 1 and not 1.00), so sign over an integer
	 * type is sign(x::numeric) cast back, proved to fit since its value is -1, 0 or 1; over real sign(x::double precision)
	 * rounded back; over an exact integer the exact sign.
	 */
	sign(a: Lowered, at: SourceLoc): Lowered {
		const v = valueType(a.actual)
		const carrier = v.carrier
		switch (carrier) {
			case "numeric":
			case "float8":
			case "exactInteger": {
				const op = this.overload("sign", [v], at)
				const bounds = signBoundsOver(carrier, a.bounds)
				return this.native(op, [a], this.resultType(op, bounds), bounds, at, "Compute.sign")
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
			case "text":
			case "enum":
			case "range4":
			case "range8":
			case "vector":
				return stop("UnsupportedOperation", at, `sign: PostgreSQL has no sign over ${typeLabel(v)}`)
		}
	}

	/** sign over a carrier PostgreSQL has none of: the operand widened to `via` by `widen`, its sign cast back by `back`. */
	signThrough(
		a: Lowered,
		v: ScalarType,
		via: "numeric" | "float8",
		widen: CastOp,
		back: CastOp,
		at: SourceLoc
	): Lowered {
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
			"Compute.sign"
		)
		return {
			...this.castNode(s, v, { kind: "registered", op: back }, at),
			nominal: valueType(a.nominal)
		}
	}

	/**
	 * gcd and lcm: over integer and bigint exact (gcd(-2^63, 0) is 2^63), over smallint and exact integers the exact
	 * integers' over the widened operands, over numeric numeric's.
	 */
	gcdLcm(
		fn: "gcd" | "lcm",
		left: ExprDesc<Located, R>,
		right: ExprDesc<Located, R>,
		at: SourceLoc
	): Lowered {
		if (right.kind === "literal" && right.type === undefined) {
			return stop("MalformedDescription", at, `${fn} takes a term or a parameter, never a literal`)
		}
		const a0 = this.term(left, at)
		const b0 = this.operand(right, a0, "operand", at)
		const widen =
			valueType(a0.nominal).carrier === "int2" ||
			valueType(a0.nominal).carrier === "exactInteger" ||
			valueType(b0.nominal).carrier === "exactInteger"
		const a = widen ? this.widenExact(a0, "exactInteger", at) : a0
		const b = widen ? this.widenExact(b0, "exactInteger", at) : b0
		const op = this.overload(fn, [valueType(a.nominal), valueType(b.nominal)], at)
		const da = a.bounds?.digits ?? 0
		const db = b.bounds?.digits ?? 0
		const bounds = ofDigits(
			fn === "gcd" ? Math.max(da, db) : da + db,
			Math.max(a.bounds?.scale ?? 0, b.bounds?.scale ?? 0),
			{
				infinite: false,
				nan: valueType(a.nominal).carrier === "numeric"
			}
		)
		return this.native(op, [a, b], this.resultType(op, bounds), bounds, at, `Compute.${fn}`)
	}

	widthBucket(args: ReadonlyArray<ExprDesc<Located, R>>, at: SourceLoc): Lowered {
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
		let nc: Lowered
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
		const bucket = ofRange(0n, BigInt(int4Max.value), int4Digits.value)
		return this.native(
			op,
			[nx, nl, nh, nc],
			this.resultType(op, bucket),
			bucket,
			at,
			"Compute.widthBucket"
		)
	}

	span(
		desc: ExprDesc<Located, R>,
		at: SourceLoc
	): { readonly lowered: Lowered; readonly span: ScalarType } {
		const s = this.term(desc, at)
		const info = spanOf(s.nominal)
		if (info === undefined) {
			return stop("MalformedDescription", at, `a span term, not ${typeLabel(s.nominal)}`)
		}
		return { lowered: s, span: info.endpoint }
	}

	/** width(s) = upper(s) - lower(s), the exact difference of its endpoints, which never overflows. */
	width(desc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		const s = this.span(desc, at)
		const endpoint = valueType(s.span)
		const point = boundsOfType(endpoint)
		const upper = this.native(
			this.overload("upper", [s.lowered.actual], at),
			[s.lowered],
			endpoint,
			point,
			at,
			"upper"
		)
		const lower = this.native(
			this.overload("lower", [s.lowered.actual], at),
			[s.lowered],
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
		return this.native(op, [upper, lower], this.resultType(op, bounds), bounds, at, "Compute.width")
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
			return ofDigits(a.digits + b.scale + 1, numericMaxDisplayScale.value, {
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

/** A rounding's result: the operand's digits and one more where it may carry, at `scale` fractional digits. */
const roundedBounds = (a: Bounds | undefined, carry: number, scale: number): Bounds | undefined =>
	a === undefined
		? undefined
		: ofDigits(a.digits + carry, scale, {
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
			return moneyFractionDigits.value
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
		case "text":
		case "enum":
		case "range4":
		case "range8":
		case "vector":
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
		case "text":
		case "enum":
		case "range4":
		case "range8":
		case "vector":
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
 * The facts a cast keeps: one that moves no value keeps every one; one that rounds keeps all but nonzero, which
 * rounding toward zero loses; a conversion into a float keeps none.
 */
const keptFacts = (arg: Lowered, conversion: Conversion, to: ScalarType): FactSet => {
	if (conversion.kind === "intoFloat") {
		return noFacts
	}
	const { nonzero: _lost, ...rest } = arg.facts
	return Object.freeze({ ...(conversion.kind === "exact" ? arg.facts : rest), ...factsOfType(to) })
}

/** The range a value must lie in to fit `target`, a narrower integer, money or a typmod, once a cast rounds it. */
export const fitRange = (target: ScalarType): readonly [Exact, Exact] | undefined => {
	const t = baseOf(target)
	switch (t.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return [exactOf(integerRanges[t.carrier][0], 0), exactOf(integerRanges[t.carrier][1], 0)]
		case "money":
			return [moneyLow, moneyHigh]
		case "numeric": {
			const typmod = t.typmod
			if (typmod === undefined) {
				return undefined
			}
			const limit = minus(tenTo(typmod.precision - typmod.scale), exactOf(1n, typmod.scale))
			return [negExact(limit), limit]
		}
		case "exactInteger":
		case "exactMoney":
		case "float4":
		case "float8":
		case "bool":
		case "uuid":
		case "text":
		case "enum":
		case "range4":
		case "range8":
		case "vector":
			return undefined
	}
}

/**
 * Whether every contract level of `to` that `from` lacks holds of every value of `b`: each level's predicate decided
 * true over the interval (predicateDecided). A level whose predicate the interval cannot decide is not proved.
 */
export const contractHolds = (to: ScalarType, from: ScalarType, b: Bounds): boolean => {
	const had = new Set(contractLevels(from).map((c) => c.name))
	return contractLevels(to).every(
		(c) => had.has(c.name) || c.predicate === undefined || predicateDecided(c.predicate, b) === true
	)
}

/**
 * A contract predicate's value over every value of an interval, where the interval decides it: its comparisons and
 * BETWEEN of VALUE with literals, under and, or and not. Anything else decides nothing (undefined).
 */
const predicateDecided = (table: ExprTable, b: Bounds): boolean | undefined => {
	const at = (id: TableExpr["id"]): TableExpr | undefined =>
		Object.hasOwn(table.exprs, id) ? table.exprs[id] : undefined
	const ends = finiteEnds(b)
	const decide = (id: TableExpr["id"]): boolean | undefined => {
		const e = at(id)
		if (e?.kind !== "op") {
			return undefined
		}
		const fn = opFn(e)
		if (fn === "and") {
			const values = e.args.map(decide)
			return values.includes(false) ? false : values.every((v) => v === true) ? true : undefined
		}
		if (fn === "or") {
			const values = e.args.map(decide)
			return values.includes(true) ? true : values.every((v) => v === false) ? false : undefined
		}
		if (fn === "not") {
			const [v] = e.args.map(decide)
			return v === undefined ? undefined : !v
		}
		const [x, y, z] = e.args.map(at)
		if (ends === undefined || x === undefined || y === undefined) {
			return undefined
		}
		if (fn === "between" && x.kind === "value" && y.kind === "literal" && z?.kind === "literal") {
			const lo = tableNumber(y)
			const hi = tableNumber(z)
			return typeof lo === "object" && typeof hi === "object"
				? insideRange(ends[0], ends[1], lo, hi) || undefined
				: undefined
		}
		return comparisonDecided(fn, x, y, ends)
	}
	return decide(table.root)
}

/** A comparison of VALUE with a finite literal over a finite interval: true where every value satisfies it. */
const comparisonDecided = (
	fn: NativeFn | undefined,
	x: TableExpr,
	y: TableExpr,
	[low, high]: readonly [Exact, Exact]
): boolean | undefined => {
	const c = literalComparison(fn, x, y)
	if (c === undefined) {
		return undefined
	}
	const v = c.value
	switch (c.op) {
		case "ge":
			return compareExact(low, v) >= 0 || undefined
		case "gt":
			return compareExact(low, v) > 0 || undefined
		case "le":
			return compareExact(high, v) <= 0 || undefined
		case "lt":
			return compareExact(high, v) < 0 || undefined
		case "eq":
			return (compareExact(low, v) === 0 && compareExact(high, v) === 0) || undefined
		case "ne":
			return compareExact(high, v) < 0 || compareExact(low, v) > 0 || undefined
	}
}

/** A finite exact value's magnitude as a double, for the coarse range checks of power. */
const magnitude = (e: Exact): number => Math.abs(Number(e.units) / 10 ** e.scale)

/**
 * power's premises: its base never below zero (a fact, so no negative base meets a fractional exponent), its base
 * never zero or its exponent never below zero (a fact, so zero meets no negative power), and both operands' finite
 * intervals, small enough that the result stays in range, as powerInRange states over numeric and double precision.
 */
const powerPremises = (
	base: Lowered,
	exponent: Lowered,
	target: ScalarType
): NonEmptyReadonlyArray<OperandPremise> | undefined => {
	const nonnegative = factPremise(0, "nonnegative", base.facts)
	const nonzero =
		factPremise(0, "nonzero", base.facts) ?? factPremise(1, "nonnegative", exponent.facts)
	const b = base.bounds === undefined ? undefined : finitePremise(0, base.bounds)
	const e = exponent.bounds === undefined ? undefined : finitePremise(1, exponent.bounds)
	if (nonnegative === undefined || nonzero === undefined || b === undefined || e === undefined) {
		return undefined
	}
	return powerInRange(b.low, b.high, e.low, e.high, target)
		? [nonnegative, nonzero, b, e]
		: undefined
}

/**
 * An upper bound on log10 x^y over a base interval [bLow, bHigh] never below zero and an exponent interval [eLow, eHigh],
 * where it is above zero: a result below 1 is an underflow at worst, which PostgreSQL rounds to zero without raising.
 * It grows past 1 only by the largest x raised to the largest positive y, x < 10^d for d the integer digits of the
 * interval's ends, or by the least x raised to the most negative y, x at least 10^-s for s the fractional digits of a
 * low end above zero. Over a low end of zero a negative exponent's result has no bound: Infinity.
 */
const powerWeight = (bLow: Exact, bHigh: Exact, eLow: Exact, eHigh: Exact): number => {
	const up = Math.max(digitsOfExact(bLow), digitsOfExact(bHigh))
	const rising = compareExact(eHigh, zero) > 0 ? weightOf(magnitudeAtMost(eHigh), up) : 0
	if (compareExact(eLow, zero) >= 0 || compareExact(bLow, oneExact) >= 0) {
		return rising
	}
	const falling =
		compareExact(bLow, zero) > 0
			? weightOf(magnitudeAtMost(eLow), scaleOfExact(bLow))
			: Number.POSITIVE_INFINITY
	return Math.max(rising, falling)
}

/** An exponent's magnitude as a double, never below it: Infinity where the double reading overflows. */
const magnitudeAtMost = (e: Exact): number => {
	const m = magnitude(e)
	return Number.isNaN(m) ? Number.POSITIVE_INFINITY : m
}

/** An exponent's magnitude times a base's digits: zero where either is zero, so an infinite exponent over no digit adds none. */
const weightOf = (exponent: number, digits: number): number =>
	exponent === 0 || digits === 0 ? 0 : exponent * digits

/**
 * The bound PostgreSQL's power_var puts on exp(y · ln x) for an exponent that is no integer (numeric.c power_var, its
 * test before exp_var, and exp_var's own): y · ln x below NUMERIC_MAX_RESULT_SCALE · 3, at which it raises 22003
 * "value overflows numeric format".
 */
const powerExpLimit: Limit = derived({
	owner: "PostgreSQL 19rc1",
	unit: "a natural logarithm",
	scope: "y · ln x of a power with an exponent that is no integer",
	from: [numericMaxResultScale],
	derivation:
		'exp_var\'s overflow test, three times the result scale: "if (fabs(val) >= NUMERIC_MAX_RESULT_SCALE * 3)" (https://github.com/postgres/postgres/blob/REL_19_RC1/src/backend/utils/adt/numeric.c#L10503)',
	compute: ([scale]) => scale.value * 3
})

/**
 * Whether power over these intervals stays inside its result carrier, as powerPremises states. Over double precision
 * a zero exponent, a base exactly zero, or a result's binary exponent, |e · log2 |b||, at most binary64's greatest over
 * every end of the intervals, so the result is finite (dpow raises 22003 on an infinite result of finite operands)
 * and, binary64's least subnormal exponent lying further from zero, never rounds to zero (it raises 22003 on a zero
 * result of a nonzero base). Over numeric, as PostgreSQL computes it (numeric.c power_var): an exponent proved one
 * integer, a point interval at an integer, is power_var_int's, which raises 22003 once its estimate of the result's
 * decimal weight passes (NUMERIC_WEIGHT_MAX + 1) · DEC_DIGITS, numericMaxIntegerDigits:
 * "if (f > (NUMERIC_WEIGHT_MAX + 1) * DEC_DIGITS)"
 * (https://github.com/postgres/postgres/blob/REL_19_RC1/src/backend/utils/adt/numeric.c#L11074), or once a product's
 * NBASE weight passes NUMERIC_WEIGHT_MAX (numeric.c#L11205-L11206). Its weight (powerWeight), an integer there, is held
 * below numericMaxIntegerDigits, so the result is at most 10^(numericMaxIntegerDigits - 1): a whole digit inside both
 * tests, whatever the estimate's rounding. Any other exponent is power_var's, exp(y · ln x), its weight held below
 * powerExpLimit / ln 10. Either rounds an underflow to zero without raising, so only the weight above 1 is bounded. An
 * integer past int32 takes power_var's way too, but a weight below numericMaxIntegerDigits holds the exponent's
 * magnitude below it, inside int32, wherever the result can grow past 1.
 */
export const powerInRange = (
	bLow: Exact,
	bHigh: Exact,
	eLow: Exact,
	eHigh: Exact,
	target: ScalarType
): boolean => {
	if (isFloat(baseOf(target))) {
		const eMag = Math.max(magnitude(eLow), magnitude(eHigh))
		const lo = magnitude(bLow)
		const hi = magnitude(bHigh)
		if (eMag === 0 || (lo === 0 && hi === 0)) {
			return true
		}
		const reach = Math.max(Math.abs(Math.log2(lo)), Math.abs(Math.log2(hi))) * eMag
		return reach <= binary64MaxExponent.value
	}
	const weight = powerWeight(bLow, bHigh, eLow, eHigh)
	const integral = compareExact(eLow, eHigh) === 0 && scaleOfExact(eLow) === 0
	return integral
		? weight < numericMaxIntegerDigits.value
		: weight * Math.LN10 < powerExpLimit.value
}

/** power's result bounds where its premises hold: its integer digits powerWeight's bound; a float's its type's. */
const powerBounds = (a: Lowered, b: Lowered, v: ScalarType): Bounds | undefined => {
	if (isFloat(v)) {
		return boundsOfType(v)
	}
	const ea = a.bounds === undefined ? undefined : finiteEnds(a.bounds)
	const eb = b.bounds === undefined ? undefined : finiteEnds(b.bounds)
	if (ea === undefined || eb === undefined) {
		return undefined
	}
	const digits = Math.ceil(powerWeight(ea[0], ea[1], eb[0], eb[1]))
	return ofDigits(Math.min(digits, numericMaxIntegerDigits.value), numericMaxDisplayScale.value, {
		infinite: false,
		nan: true
	})
}

/**
 * width_bucket's premises beyond its finite operands: its bounds' finite intervals disjoint, so the bounds differ, and
 * its count in 1..int4Max - 1, so its result count + 1 fits integer.
 */
const bucketPremises = (
	low: Lowered,
	high: Lowered,
	count: Lowered
): NonEmptyReadonlyArray<OperandPremise> | undefined => {
	const lo = low.bounds === undefined ? undefined : finitePremise(1, low.bounds)
	const hi = high.bounds === undefined ? undefined : finitePremise(2, high.bounds)
	const c = count.bounds === undefined ? undefined : finitePremise(3, count.bounds)
	if (lo === undefined || hi === undefined || c === undefined) {
		return undefined
	}
	return bucketInRange(lo.low, lo.high, hi.low, hi.high, c.low, c.high) ? [lo, hi, c] : undefined
}

/**
 * Whether width_bucket's bounds' intervals are disjoint and its count lies in 1..int4Max - 1, so its result, at most
 * count + 1, fits integer.
 */
export const bucketInRange = (
	lowLow: Exact,
	lowHigh: Exact,
	highLow: Exact,
	highHigh: Exact,
	countLow: Exact,
	countHigh: Exact
): boolean =>
	(compareExact(lowHigh, highLow) < 0 || compareExact(highHigh, lowLow) < 0) &&
	insideRange(countLow, countHigh, exactOf(1n, 0), exactOf(BigInt(int4Max.value) - 1n, 0))

/** Zero as a literal of `v`'s family, which a guard compares its subject with. */
const zeroLiteral = (v: ValueType): LiteralDesc => {
	switch (v.carrier) {
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
		case "bool":
		case "uuid":
		case "text":
		case "enum":
		case "range4":
		case "range8":
		case "vector":
			return 0
	}
}

/** An infinity of `v`'s family, -1 for the negative one. */
const infiniteLiteral = (v: ValueType, sign: 1 | -1): LiteralDesc =>
	v.carrier === "numeric"
		? sign > 0
			? Decimal.infinity
			: Decimal.negativeInfinity
		: { float: sign > 0 ? "Infinity" : "-Infinity" }

/** How a value's refinement is checked before any SQL, where it is: a literal at compile time, a parameter at bind. */
const checkedKind = (e: ScalarExpr): "literal" | "parameter" | undefined =>
	e.kind === "literal" ? "literal" : e.kind === "param" ? "parameter" : undefined

/**
 * Whether two lowered expressions compute the same value the same way: one kind, one source, one overload, one literal
 * and the same arguments, each in turn. A guard refines exactly the occurrences of its subject.
 */
const sameExpr = (a: ScalarExpr, b: ScalarExpr): boolean => {
	if (a === b) {
		return true
	}
	if (a.kind !== b.kind || a.args.length !== b.args.length) {
		return false
	}
	const alike = a.args.every((x, i) => {
		const y = b.args[i]
		return y !== undefined && sameExpr(x, y)
	})
	if (!alike) {
		return false
	}
	switch (a.kind) {
		case "column":
			return (
				b.kind === "column" && a.column.node === b.column.node && a.column.name === b.column.name
			)
		case "param":
			return b.kind === "param" && a.param === b.param
		case "value":
			return b.kind === "value"
		case "literal":
			return b.kind === "literal" && canonicalTextOf(a.value) === canonicalTextOf(b.value)
		case "op":
			return b.kind === "op" && a.op === b.op
		case "cast":
			return b.kind === "cast" && a.cast === b.cast
		case "domainCast":
		case "cond":
			return true
	}
}

/** Same carrier, numeric typmod, exact digit bound, contract name and regex refinement. */
const sameShape = (a: ScalarType, b: ScalarType): boolean => {
	if (a.carrier !== b.carrier) {
		return false
	}
	const ta = numericTypmodOf(a)
	const tb = numericTypmodOf(b)
	if (ta?.precision !== tb?.precision || ta?.scale !== tb?.scale) {
		return false
	}
	if (familyDigits(a) !== familyDigits(b)) {
		return false
	}
	if (contractOf(a)?.name !== contractOf(b)?.name) {
		return false
	}
	return sameRegex(textOf(a)?.regex, textOf(b)?.regex)
}

/** Whether a value already carries the refinement a cast target names: the same contract, or the same regex. */
const sameRefinement = (a: ScalarType, to: ScalarType): boolean => {
	const contract = contractOf(to)
	if (contract !== undefined) {
		return contractOf(a)?.name === contract.name && meets(a, to)
	}
	return sameShape(withoutSerial(a), to)
}

const compatibleCore = (a: ScalarType, b: ScalarType): boolean => meets(valueType(a), valueType(b))

const run = <R extends Refs>(
	env: LowerEnv<R>,
	f: (l: Lowering<R>) => Lowered
): Result.Result<Lowered, CompileError> => catchRefusal(() => f(new Lowering(env, [])))

/**
 * Typing and lowering of scalar expression descriptions to the scalar IR, total by construction.
 *
 * An ExprDesc<Located, R>, as a builder recorded it or a description carried it, is resolved against the static
 * overload registry into ScalarExprs, one node per Compute operation. The caller supplies the sink the nodes go to (a
 * DagBuilder's `expr`, or a contract predicate's table) and the leaves (rule variables, a check's fields, a contract's
 * VALUE, parameters), so the same typing serves query filters and outputs, contract predicates and row checks. Typing
 * follows PostgreSQL's overload resolution, never JavaScript's number-versus-bigint distinction:
 *
 * - Operands of one operation meet (types.ts meets): a contract and its bare base never meet without Compute.base, and
 *   arithmetic over a contract yields the base; an exact value meets the plain values of its family, widened exactly.
 * - A literal never stands first and has no type of its own: it adopts the type of the term it meets. In a comparison,
 *   an IN list, BETWEEN bounds or a conditional's branch it adopts that term's contract or regex refinement and is
 *   checked against it here, the ContractLiteral check; in arithmetic it adopts the term's value type, the unconstrained
 *   base, and opposite an exact value its family's plain carrier.
 * - A parameter is a term of its declared type, first included, which its caller binds; a typed constant
 *   (Compute.literal) is a term of its stated type.
 * - When both branches of Compute.cond are literals, number literals are integer and every other literal is its own
 *   host type.
 *
 * One semantics, in every mode: no node raises on a value its operands admit (registry.ts Totality). Integer and money
 * arithmetic is exact (an exact integer or exact money, its digits bounded by its operands'); float arithmetic is IEEE
 * 754; numeric arithmetic stays inside numeric's numericMaxIntegerDigits by its operands' digit bounds (a numeric field's
 * by its typmod, a computed numeric's by the bound its type carries), past which an expression is ResourceBound; and a partial operation (a
 * divisor, a root, a narrowing cast, a domain cast, power, width_bucket, min_scale) stands only with the proof of its
 * precondition (ir/proof.ts PreconditionProof): its operands' facts (a literal's value, a contract's declaration, a
 * Compute.when guard, the facts a term's TypeScript type states), or, for what rests on magnitudes no type states, the
 * bound domain (bounds.ts). Otherwise it is PartialOperation, naming the guard to write.
 *
 * The modes differ only in what they read:
 * - "query": queries and Compute outputs, which lower the predicates of other packages.
 * - "check": contract predicates and row checks, which read only their VALUE or row and admit the operations the host
 *   evaluates for the ContractLiteral check (checkMembers); float arithmetic, whose IEEE rendering binds operands in a
 *   subquery, and money arithmetic, which reads money through its STABLE cast, are refused there, since a CHECK holds
 *   neither.
 * - "build": a builder typing the term it constructs (builders.ts), before it knows where the term is used: query
 *   typing that admits charLength, which a contract predicate may use, and leaves the ContractLiteral check to
 *   compilation, where every semantic diagnostic is reported.
 *
 * Lowers a term: a Compute expression, a reference, or a typed literal.
 */
export const lowerTerm = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	env: LowerEnv<R>
): Result.Result<Lowered, CompileError> => run(env, (l) => l.term(desc, env.loc))

/**
 * The proof that every value of `from` fits `to` once cast, from `from`'s own bounds (an exact integer's digits, a
 * contract's atoms), where they prove it: what a described write's narrowing into its column rests on.
 */
export const typeFitProof = (
	preconditions: NonEmptyReadonlyArray<Precondition>,
	from: ScalarType,
	to: ScalarType
): OperationProof | undefined => {
	const b = boundsOfType(from)
	const interval = b === undefined ? undefined : intervalPremise(0, b)
	return interval === undefined ? undefined : intervalCastProof(preconditions, interval, to)
}

/**
 * The proof of a cast's preconditions over an operand every value of which `interval` bounds (operand 0): each fact by
 * the interval (bounds.ts premiseHas), fits where the interval lies in the target's fit range (fitRange), one entry per
 * precondition; undefined where one is not proved. What a described write's narrowing, a recursion's counter and a
 * fold's count total rest on.
 */
export const intervalCastProof = (
	preconditions: NonEmptyReadonlyArray<Precondition>,
	interval: IntervalPremise,
	to: ScalarType
): OperationProof | undefined => {
	const proved = (precondition: Precondition): PreconditionProof | undefined => {
		switch (precondition.kind) {
			case "nonzero":
			case "nonnegative":
			case "finite":
				return precondition.operand === interval.operand && premiseHas(interval, precondition.kind)
					? { precondition, premises: [interval] }
					: undefined
			case "fits": {
				const range = fitRange(to)
				return range !== undefined && insideRange(interval.low, interval.high, range[0], range[1])
					? { precondition, premises: [interval] }
					: undefined
			}
			case "contract":
			case "powerDomain":
			case "bucketDomain":
				return undefined
		}
	}
	const [first, ...rest] = preconditions
	const head = proved(first)
	if (head === undefined) {
		return undefined
	}
	const proofs: [PreconditionProof, ...Array<PreconditionProof>] = [head]
	for (const p of rest) {
		const proof = proved(p)
		if (proof === undefined) {
			return undefined
		}
		proofs.push(proof)
	}
	return proofs
}

/** An expression another package built, lowered as it is: its type's bounds and facts, and nothing more. */
export const loweredOf = (e: ScalarExpr): Lowered => ({
	expr: e,
	nominal: e.type,
	actual: e.type,
	volatility: e.volatility,
	bounds: boundsOfType(e.type),
	facts: factsOfType(e.type)
})

/** Lowers a predicate: a non-null SQL Boolean expression. */
export const lowerPredicate = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	env: LowerEnv<R>
): Result.Result<Lowered, CompileError> => run(env, (l) => l.predicate(desc, env.loc))
