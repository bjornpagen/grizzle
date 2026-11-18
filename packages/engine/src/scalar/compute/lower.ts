import { int4Max } from "#compiler/core/canonical.ts"
import { canonicalTextOf, catchRefusal, Refusal, sameContent } from "#compiler/core/canonical.ts"
import { maxAllocSize, regexTextMaxBytes } from "#compiler/core/errors.ts"
import {
	CompileError,
	type Guard,
	type GuardTest,
	type PreconditionKind,
	ruleRefused
} from "#compiler/core/errors.ts"
import { ExprId } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import {
	appendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { asciiFold } from "#compiler/core/text.ts"
import { int4Digits } from "#compiler/ir/carriers.ts"
import { integerRanges } from "#compiler/ir/carriers.ts"
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
	type PatternTable,
	patternTableOf,
	type ScalarExpr,
	type TableExpr,
	type TypedLiteral
} from "#compiler/ir/expr.ts"
import type {
	Exact,
	Fact,
	NativeProof,
	OperandPremise,
	OperationProof,
	ParseForm,
	Precondition,
	PreconditionProof
} from "#compiler/ir/proof.ts"
import {
	type ContractInfo,
	type PatternSource,
	type Patterns,
	type RegexRef,
	type ScalarType,
	type TextInfo,
	baseOf,
	contractOf,
	enteredType,
	exactDigitsOf,
	isRefined,
	languageOctets,
	languageWithin,
	numericTypmodOf,
	octetsOf,
	patternsText,
	rosterOf,
	spanOf,
	textBounds,
	textOf,
	textPatterns,
	typeLabel,
	wildcardPattern
} from "#compiler/ir/scalar.ts"
import {
	absBounds,
	type Bounds,
	compareExact,
	exactOf,
	type FactSet,
	floorOfExact,
	factPremise,
	finiteEnds,
	finitePremise,
	hullBounds,
	insideRange,
	type IntervalPremise,
	intervalPremise,
	log2Magnitude,
	magnitudeAtLeast,
	minus,
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
	refine,
	scaleOfExact,
	subBounds,
	tenTo
} from "#compiler/scalar/compute/bounds.ts"
import { parseBy } from "#compiler/scalar/compute/cast.ts"
import { admitLiteral, literalMember } from "#compiler/scalar/compute/evaluate.ts"
import { bareLiteralKind } from "#compiler/scalar/compute/literal.ts"
import { nativeProof, resultBounds } from "#compiler/scalar/compute/native.ts"
import { numericMaxDisplayScale } from "#compiler/scalar/compute/numeric.ts"
import {
	binaryCoercion,
	type CastOp,
	castOf,
	type CommonTypeFn,
	type CommonTypeOp,
	commonTypeOf,
	computeSpecs,
	digestText,
	type FixedFn,
	type FixedOp,
	type NativeFn,
	type NativeOp,
	overloadOf,
	registeredCast
} from "#compiler/scalar/compute/registry.ts"
import {
	anyNumeric,
	commonType,
	exactFamily,
	exactType,
	isComputedNumeric,
	isFloat,
	meetingType,
	meets,
	mixesExact,
	valueType,
	wideningOf,
	wildcardText
} from "#compiler/scalar/compute/types.ts"
import {
	adoptedType,
	arithmeticBounds,
	argOf,
	boundsOfType,
	carrierFacts,
	castBounds,
	type CastHow,
	type ClosedField,
	type ClosedHeading,
	type ClosedRelations,
	compatibleCore,
	constantGuardTests,
	contractLevels,
	conversionOf,
	dateExact,
	decimalBounds,
	factsOfType,
	factsOfValue,
	guardFacts,
	guardRefinement,
	isBareLiteral,
	isReference,
	keptFacts,
	type LeafDesc,
	literalComparison,
	literalNumber,
	type LowerParams,
	mapText,
	moneyHigh,
	moneyLow,
	negationFacts,
	numericOf,
	opFn,
	type ParamRef,
	type PatternPart,
	patternParts,
	powerWeight,
	type Role,
	roundedBounds,
	sameRefinement,
	sameShape,
	signBoundsOver,
	stop,
	tableNumber,
	translateMaxBytes,
	unprovedFact,
	unwrapOrRefuse,
	withinGuards
} from "#compiler/scalar/compute/typing.ts"
import {
	binary64MaxExponent,
	decimalTextMaxBytes,
	regexMaxRepeat
} from "#compiler/scalar/lexical.ts"
import {
	formOctets,
	formSource,
	type LexicalTarget,
	lexicalTargetOf,
	parseTargetOf
} from "#compiler/scalar/lexical.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { admitMatch, type MatchAdmission, matchSourceAt } from "#compiler/scalar/regex/admit.ts"
import { regexDfaMaxStates, regexDfaMaxWork } from "#compiler/scalar/regex/inclusion.ts"
import {
	bytesWithin,
	formIncludes,
	type Inclusion,
	patternIncludes
} from "#compiler/scalar/regex/inclusion.ts"
import { matchFlags } from "#compiler/scalar/regex/matcher.ts"
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
	inferredType,
	storedOnly,
	type TextLookup
} from "#compiler/scalar/registry.ts"
import { Decimal, normalizeNumeric } from "#compiler/scalar/values/decimal.ts"
import { numericMaxFractionDigits, numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"
import { numericMaxPrecision } from "#compiler/scalar/values/fault.ts"

/**
 * The internal limit on a calculation's result scale, NUMERIC_MAX_RESULT_SCALE.
 *
 * @limitKind derived
 * @owner PostgreSQL 19rc2
 * @unit decimal digits
 * @scope the scale of an intermediate numeric result, which exp_var's input bound is three times
 * @derivation numeric.h: "#define NUMERIC_MAX_RESULT_SCALE (NUMERIC_MAX_PRECISION * 2)"
 *   (https://github.com/postgres/postgres/blob/REL_19_RC2/src/include/utils/numeric.h#L46)
 * @from {@link numericMaxPrecision}
 */
const numericMaxResultScale = numericMaxPrecision * 2

/**
 * The bound PostgreSQL's power_var puts on exp(y · ln x) for an exponent that is no integer (numeric.c power_var, its
 * test before exp_var, and exp_var's own): y · ln x below NUMERIC_MAX_RESULT_SCALE · 3, at which it raises 22003
 * "value overflows numeric format".
 *
 * @limitKind derived
 * @owner PostgreSQL 19rc2
 * @unit a natural logarithm
 * @scope y · ln x of a power with an exponent that is no integer
 * @derivation exp_var's overflow test, three times the result scale: "if (fabs(val) >= NUMERIC_MAX_RESULT_SCALE * 3)"
 *   (https://github.com/postgres/postgres/blob/REL_19_RC2/src/backend/utils/adt/numeric.c#L10503)
 * @from {@link numericMaxResultScale}
 */
const powerExpLimit = numericMaxResultScale * 3

/**
 * A lowered operand: the node's recorded entry, the type the caller's term has (nominal), the SQL type the node
 * computes (actual), which differ only where a parameter is bound as its base or a cast keeps its source's refinement,
 * its effects as its table derived them (ir/expr.ts exprEffects), and what is proved of its values: the bound domain's
 * interval and digits where its type is a number (bounds.ts Bounds), and its facts (FactSet).
 *
 * Its nominal type is private to it and written once, by settle (Lowering.settle), which narrows the type an operation
 * states by every guard the term stands under. A copy is no Lowered, so no operation writes a term's type after
 * settle: one that states a type of its own, a collapse's or a translation's language or a cast's target, restates the
 * term (Lowering.restate), and the guards narrow it again.
 */
export class Lowered implements Effects {
	readonly expr: ScalarExpr
	readonly actual: ScalarType
	readonly volatility: Effects["volatility"]
	readonly bounds: Bounds | undefined
	readonly facts: FactSet
	/**
	 * The enclosing Compute.when guards whose parameter this value is (Lowering.guarded): what each establishes of it,
	 * settled again wherever the value is restated, so a restatement of the parameter keeps it. None for any other value.
	 */
	readonly held: ReadonlyArray<WhenParameter>
	readonly #nominal: ScalarType

	constructor(
		expr: ScalarExpr,
		nominal: ScalarType,
		actual: ScalarType,
		bounds: Bounds | undefined,
		facts: FactSet,
		held: ReadonlyArray<WhenParameter>
	) {
		this.expr = expr
		this.#nominal = nominal
		this.actual = actual
		this.volatility = expr.volatility
		this.bounds = bounds
		this.facts = facts
		this.held = held
	}

	/** The type the caller's term has, as settle stated it and the guards the term stands under narrowed it. */
	get nominal(): ScalarType {
		return this.#nominal
	}
}

/**
 * The emitter of a lowering no DAG receives (a contract predicate, a builder typing its term): each expression built
 * over its arguments (ir/expr.ts builtExpr) under a fresh label `prefix#n`.
 */
export const exprEmitter = (prefix: string): ((spec: ExprSpec) => ScalarExpr) => {
	let next = 0
	return (spec) => builtExpr(spec, ExprId(`${prefix}#${next++}`))
}

/** The predicates other packages lower: r.allen, r.pointIn and r.not. */
export type LowerExtension<R extends Refs> = (
	desc: Extract<ExprDesc<Located, R>, { readonly kind: "allen" | "pointIn" | "absent" }>,
	loc: SourceLoc,
	lower: (child: ExprDesc<Located, R>) => Result.Result<Lowered, CompileError>
) => Result.Result<Lowered, CompileError>

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
	/** The closed relations C.at and C.row apply. */
	readonly closed: ClosedRelations
	/**
	 * The admitted patterns the lowering reads, its compile's table (scalar/regex/patterns.ts): a literal's membership
	 * in a regex refinement, a language's inclusion in another or in a lexical form, a translation's image.
	 */
	readonly patterns: PatternAutomata
}

/**
 * A lowering's mode: a query (its filters and outputs), a check (a contract predicate or a row check, which reads only
 * its VALUE or row and becomes a CHECK), or a builder typing the term it constructs.
 *
 * What each mode reads besides: a query and a check judge a literal against its regex refinement, by the patterns
 * every mode carries (LowerCommon.patterns), and analyze a pattern they compute, and only a query lowers the
 * predicates of other packages (a check refuses them); a builder judges no literal and lowers none.
 */
export type LowerEnv<R extends Refs = Spelled> =
	| (LowerCommon<R> & {
			readonly mode: "query"
			readonly patternLanguage: TextLookup
			readonly extension: LowerExtension<R>
	  })
	| (LowerCommon<R> & {
			readonly mode: "check"
			readonly patternLanguage: TextLookup
	  })
	| (LowerCommon<R> & { readonly mode: "build" })

/** The premise that every value of an operand is a member of a refinement's language. */
type LanguagePremise = Extract<OperandPremise, { readonly kind: "language" }>

/**
 * The premise that every value of a refinement's language lies within `octets` UTF-8 bytes, a target's byte bound, with
 * the most bytes such a value takes: its own bound where the target has none or the bound lies within it, else the
 * longest member of its language within its bound (scalar/regex/inclusion.ts bytesWithin), which a language whose
 * characters fill the bound no closer holds below it. Undefined where a value takes more, the refinement bounds no
 * bytes, or the walk would pass the analysis's bounds, which a guard of the operand's bytes decides.
 */
const premiseWithin = (
	regex: RegexRef,
	octets: number | undefined,
	patterns: PatternAutomata
): LanguagePremise | undefined => {
	const premise = (bytes: number | undefined): LanguagePremise => ({
		kind: "language",
		operand: 0,
		patterns: regex.patterns,
		bytes
	})
	const bound = regex.check.bounds?.bytes
	if (octets === undefined || (bound !== undefined && bound <= octets)) {
		return premise(bound)
	}
	if (bound === undefined) {
		return undefined
	}
	const longest = bytesWithin(regex.patterns, bound, patterns)
	return longest.kind === "within" && longest.bytes <= octets ? premise(longest.bytes) : undefined
}

/**
 * The premise that every value of `a` is a member of a language, the one `includes` compares a pattern's with, within
 * `octets` UTF-8 bytes where the target bounds them: a's refinement, its type's, a Compute.matches guard's or a
 * translation's image (the nominal type), whose language is included in it (scalar/regex/inclusion.ts), with the most
 * bytes a value of it takes (premiseWithin). Undefined where a has no refinement, its language holds a value the other
 * does not, or a value of more bytes. Where comparing the two automata passes the text analysis's bounds nothing is
 * decided, which is ResourceBound naming them, since no guard is missing: a smaller pattern or a match guard decides
 * it.
 */
const languagePremise = (
	a: Lowered,
	outer: string,
	includes: (inner: RegexRef) => Inclusion,
	octets: number | undefined,
	patterns: PatternAutomata,
	at: SourceLoc
): LanguagePremise | undefined => {
	const regex = textOf(a.nominal)?.regex
	if (regex === undefined || regex === "wildcard") {
		return undefined
	}
	const verdict = includes(regex)
	switch (verdict.kind) {
		case "included":
			return premiseWithin(regex, octets, patterns)
		case "refuted":
			return undefined
		case "bounded":
			throw new Refusal(
				CompileError.make({
					_tag: "ResourceBound",
					at,
					bound: {
						kind: "regexInclusion",
						inner: patternsText(regex.patterns),
						outer,
						states: regexDfaMaxStates,
						work: regexDfaMaxWork
					}
				})
			)
	}
}

/**
 * What proves a parse's operand a member of its lexical form, the target `form` (scalar/lexical.ts parseTargetOf):
 * a text literal by its own value, checked as the host parses it; any other text by its refinement whose language is
 * included in the form's pattern (languagePremise, scalar/lexical.ts formIncludes) and whose bytes lie within the
 * form's byte bound where it has one (formOctets). Undefined where neither proves it: a parse into a type of no form, a
 * text of no refinement, one whose language holds a value the form's pattern does not, or one of more bytes.
 */
const lexicalPremise = (
	a: Lowered,
	form: LexicalTarget | undefined,
	at: SourceLoc,
	patterns: PatternAutomata
): OperandPremise | undefined => {
	if (form === undefined) {
		return undefined
	}
	if (a.expr.kind === "literal" && a.expr.value.kind === "text") {
		return parseBy(form, a.expr.value.value).ok
			? { kind: "checked", operand: 0, by: "literal" }
			: undefined
	}
	return languagePremise(
		a,
		`/${formSource(form)}/u`,
		(regex) => formIncludes(regex.patterns, form, patterns),
		formOctets(form),
		patterns,
		at
	)
}

/**
 * The refinement of a regex-refined text type with no contract, whose cast a language included in it proves: undefined
 * for any other type, whose contract's predicate the operand's bounds decide.
 */
const refinementOf = (target: ScalarType): RegexRef | undefined => {
	const regex = textOf(target)?.regex
	return contractOf(target) !== undefined || regex === undefined || regex === "wildcard"
		? undefined
		: regex
}

/**
 * The most UTF-8 bytes a text term's value takes: a text literal's own, and any other term's its type's byte bound,
 * none where its type bounds no bytes.
 */
const textBytes = (x: Lowered): number | undefined =>
	x.expr.kind === "literal" && x.expr.value.kind === "text"
		? utf8Length(x.expr.value.value)
		: textOf(x.nominal)?.byteBound

/**
 * The pattern a parse's guard matches its text against: the target's lexical form, every double's decimal text, or
 * every decimal text.
 */
const parseRemedy: { readonly [F in ParseForm]: "lexicalForm" | "doubleText" | "decimalText" } = {
	target: "lexicalForm",
	doubleText: "doubleText",
	decimalText: "decimalText"
}

/**
 * The remedy of a parse whose operand is not proved a member of its form: Compute.matches of the form's pattern
 * (parseRemedy); and for a form whose byte bound cuts its pattern (formOctets), a bound on the operand's bytes at it
 * where the operand's language already lies inside the pattern and octetLength stands, as for a cast into str.bytes.
 */
const lexicalRemedy = (
	form: ParseForm,
	operand: Lowered,
	target: ScalarType,
	mode: LowerEnv["mode"],
	patterns: PatternAutomata
): GuardTest => {
	const matches: GuardTest = { kind: "matches", pattern: parseRemedy[form] }
	const lexical = parseTargetOf(form, target)
	const octets = lexical === undefined ? undefined : formOctets(lexical)
	const regex = textOf(operand.nominal)?.regex
	if (
		lexical === undefined ||
		octets === undefined ||
		mode === "query" ||
		regex === undefined ||
		regex === "wildcard"
	) {
		return matches
	}
	return formIncludes(regex.patterns, lexical, patterns).kind === "included"
		? { kind: "octets", bytes: octets }
		: matches
}

/**
 * The test a guard of `precondition` puts over an operand of type `operand`: a fact's own test, Compute.within for a
 * magnitude, Compute.matches for a text's language or a parse's form (parseRemedy). A contract proves its predicate of an operand by
 * its bounds, which Compute.within narrows over a number and no Compute test over a text, a boolean, a uuid or a date,
 * so over those only a value of the contract's type proves it. A fact the contract of an operand that has its type's
 * facts implies without declaring it is remedied by the declaration (undeclaredBy), since a contract's facts are
 * exactly the ones it declares; an operation's result has none of them, so no declaration remedies it.
 */
const guardTest = (
	precondition: Precondition,
	operand: Lowered,
	target: ScalarType,
	mode: LowerEnv["mode"],
	patterns: PatternAutomata
): GuardTest => {
	switch (precondition.kind) {
		case "nonzero":
		case "nonnegative":
		case "finite": {
			const contract = hasTypeFacts(operand.expr)
				? undeclaredBy(operand.nominal, precondition.kind)
				: undefined
			return contract === undefined
				? factTests[precondition.kind]
				: { kind: "proves", contract: contract.name }
		}
		case "fits":
		case "powerRange":
		case "bucketDomain":
			return { kind: "within" }
		case "powerDomain":
			return { kind: "positive" }
		case "contract":
			return withinGuards(valueType(operand.nominal).carrier)
				? { kind: "within" }
				: { kind: "typed" }
		case "language":
			return languageRemedy(operand, target, mode, patterns)
		case "lexical":
			return lexicalRemedy(precondition.form, operand, target, mode, patterns)
		case "bounded":
			return { kind: "octets", bytes: regexTextMaxBytes }
	}
}

/**
 * The remedy of a cast into a regex-refined text whose operand's language is not proved inside the target's: where the
 * operand's bytes are within the target's str.bytes bound, or it has none, its pattern is the shortfall, which
 * Compute.matches of the target's pattern remedies. Where its bytes are the shortfall, a bound on them at the target's
 * bound, Compute.within(Compute.octetLength(x), 0, bytes), remedies it once its pattern lies inside the target's, and
 * the match first where it does not; a byte bound stands only where octetLength does, so in a query only a value of the
 * target's type remedies it.
 */
const languageRemedy = (
	operand: Lowered,
	target: ScalarType,
	mode: LowerEnv["mode"],
	patterns: PatternAutomata
): GuardTest => {
	const refinement = refinementOf(target)
	const octets = refinement === undefined ? undefined : octetsOf(refinement.check)
	const text = textOf(operand.nominal)
	if (refinement === undefined || octets === undefined || text === undefined) {
		return { kind: "matches", pattern: "target" }
	}
	if (text.byteBound !== undefined && text.byteBound <= octets) {
		return { kind: "matches", pattern: "target" }
	}
	if (mode === "query") {
		return { kind: "typed" }
	}
	return patternIncludes(textPatterns(text.regex), refinement.patterns, patterns).kind ===
		"included"
		? { kind: "octets", bytes: octets }
		: { kind: "matches", pattern: "target" }
}

/** The Compute test that proves each fact of its subject. */
const factTests: { readonly [F in Fact]: GuardTest } = {
	nonzero: { kind: "nonzero" },
	nonnegative: { kind: "nonnegative" },
	finite: { kind: "isFinite" }
}

/**
 * Whether a node's values have every fact its type states (factsOfType): a column, a parameter, the contract's VALUE, a
 * literal and a cast into the type do; an operation's result, a conditional's and a closed read's have their SQL type's
 * alone (settle).
 */
const hasTypeFacts = (e: ScalarExpr): boolean => {
	switch (e.kind) {
		case "column":
		case "param":
		case "value":
		case "literal":
		case "cast":
		case "domainCast":
			return true
		case "op":
		case "cond":
		case "closedAt":
		case "closedRow":
		case "closedHas":
			return false
	}
}

/**
 * The outermost contract level of `t` whose predicate implies `fact` (unprovedFact), where `t` does not declare it: the
 * contract whose `proves` the fact belongs in. Undefined where `t` declares the fact, an operation having dropped it,
 * or where no level's predicate implies it.
 */
const undeclaredBy = (t: ScalarType, fact: Fact): ContractInfo | undefined =>
	factsOfType(t)[fact] === undefined
		? contractLevels(t).find(
				(c) => c.predicate !== undefined && unprovedFact(c.base, c.predicate, [fact]) === undefined
			)
		: undefined

/**
 * The remedy a refusal of `precondition` names: its guard test, and the Compute.when to write over `operand` around
 * `operation`, or the fact to add to a contract's `proves`.
 */
const guardOf = (
	precondition: PreconditionKind,
	remedy: GuardTest,
	operand: string,
	operation: string
): Guard => {
	const when = (check: string): string =>
		`Compute.when(${check}, (${operand}) => ${operation}, <your value>)`
	switch (remedy.kind) {
		case "proves":
			return {
				remedy,
				text: `contract ${remedy.contract}'s predicate implies it, and a contract's facts are the ones it declares: contract("${remedy.contract}", <base>, <predicate>, { proves: [..., "${precondition}"] })`
			}
		case "nonzero":
			return { remedy, text: when(`Compute.nonzero(${operand})`) }
		case "nonnegative":
			return { remedy, text: when(`Compute.nonnegative(${operand})`) }
		case "positive":
			return { remedy, text: when(`Compute.positive(${operand})`) }
		case "isFinite":
			return { remedy, text: when(`Compute.isFinite(${operand})`) }
		case "within":
			return {
				remedy,
				text: `${when(`Compute.within(${operand}, <low>, <high>)`)}, its bounds within which the operation is defined`
			}
		case "matches":
			switch (remedy.pattern) {
				case "target":
					return {
						remedy,
						text: `a text whose type's pattern lies inside the target's, or ${when(`Compute.matches(${operand}, <the target's pattern>)`)}`
					}
				case "lexicalForm":
					return {
						remedy,
						text: `a text whose type proves the target's lexical form, str.regex(lexicalForm(<target>).source) or a refinement of it, or ${when(`Compute.matches(${operand}, lexicalForm(<target>))`)}`
					}
				case "doubleText":
					return {
						remedy,
						text: `a text whose type proves a double's decimal text, str.regex(doubleText.source) or a refinement of it, or ${when(`Compute.matches(${operand}, doubleText)`)}`
					}
				case "decimalText": {
					const bytes = decimalTextMaxBytes
					const within = `Compute.when(Compute.within(Compute.octetLength(${operand}), 0, ${bytes}), () => ${operation}, <your value>)`
					return {
						remedy,
						text: `a text whose type proves a decimal text of at most ${bytes} bytes, str.bytes(${bytes}, str.regex(decimalText.source)) or a refinement of it, or, where octetLength stands, Compute.when(Compute.matches(${operand}, decimalText), (${operand}) => ${within}, <your value>)`
					}
				}
			}
		case "octets":
			return {
				remedy,
				text: `Compute.when(Compute.within(Compute.octetLength(${operand}), 0, ${remedy.bytes}), () => ${operation}, <your value>)`
			}
		case "typed":
			return {
				remedy,
				text: `a value of the target's type, a parameter its binding checks or a literal its admission judges: no Compute test over ${operand}'s type proves the target's contract`
			}
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
		case "closedAt":
			return `${e.relation}.at(${JSON.stringify(e.field)}, …)`
		case "closedRow":
			return `${e.relation}.row(…)`
		case "closedHas":
			return `${e.relation}.has(…)`
	}
}

/**
 * What a Compute.when guard the lowering stands in the branch of establishes of a term there: the term, and the
 * refined interval and the facts a numeric guard states, or the language a match states, which retypes a text term as
 * text of the pattern's language.
 */
type WhenGuard =
	| {
			readonly kind: "facts"
			readonly subject: ScalarExpr
			readonly refinement: Refinement
			readonly facts: ReadonlyArray<Fact>
	  }
	| { readonly kind: "language"; readonly subject: ScalarExpr; readonly type: ScalarType }

/**
 * What a Compute.when establishes inside its branch, and where: of its parameter, what its guard tests of its subject,
 * which only a guarded node of that guard over that subject holds (Lowering.guarded), and every restatement of one,
 * since TypeScript narrows a branch's parameter and never a term the branch reads past it; or, where its subject is a
 * text's byte count, Compute.octetLength(x), x within the guard's high end of bytes at every occurrence of x, a bound no
 * TypeScript type states and which no parameter carries, since the branch's parameter is the count.
 */
type WhenScope =
	| { readonly kind: "parameter"; readonly guard: GuardDesc; readonly holds: WhenGuard }
	| { readonly kind: "occurrences"; readonly holds: WhenGuard }

/** What a Compute.when establishes of its parameter (WhenScope). */
type WhenParameter = Extract<WhenScope, { readonly kind: "parameter" }>

class Lowering<R extends Refs> {
	readonly env: LowerEnv<R>
	/** What the Compute.whens whose branch the lowering stands in establish there, outermost first. */
	readonly #scope: ReadonlyArray<WhenScope>

	constructor(env: LowerEnv<R>, scope: ReadonlyArray<WhenScope>) {
		this.env = env
		this.#scope = scope
	}

	get check(): boolean {
		return this.env.mode === "check"
	}

	/**
	 * The bounds of a numeric operand, which settle gives every value of a carrier with a numeric domain, its type's where
	 * nothing more is proved; a value of any other carrier is no number here.
	 */
	boundsOf(x: Lowered, at: SourceLoc): Bounds {
		return x.bounds ?? stop("MalformedDescription", at, `a number, not ${typeLabel(x.nominal)}`)
	}

	/**
	 * A conditional's branch opposite the term `t`: a term that meets it, or a bare literal of t's own type. Opposite an
	 * exact value the literal is its family's plain carrier's (adoptedType), converted into t's exact type where its
	 * value lies within t's digits and refused where it does not, so the conditional is of t's type as its builder typed
	 * it, never wider.
	 */
	branchOperand(desc: ExprDesc<Located, R>, t: Lowered, at: SourceLoc): Lowered {
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
	exactBeside(first: Lowered, other: Lowered, at: SourceLoc): void {
		if (mixesExact(first.nominal, other.nominal)) {
			stop(
				"MalformedDescription",
				at,
				"operands of one type: an exact value beside a plain value of its family; Compute.cast the exact one into the plain one's type"
			)
		}
	}

	/** The type a bare literal adopts opposite a term of type t (adoptedType). */
	adopt(t: ScalarType, role: Role): ScalarType {
		return adoptedType(t, role)
	}

	/**
	 * A lowered node with what is proved of it: the bounds and facts its type gives every value unless the caller states
	 * what its computation proves, beside which it keeps its SQL type's own facts (carrierFacts), then refined, outermost
	 * first, by what each enclosing Compute.when establishes of it (WhenScope): the guard whose parameter it is, among
	 * `held`, and the byte guard of a text it is an occurrence of, a match retyping it as text of its pattern's language.
	 * Bounds a computation does not prove are its type's own, so every value of a carrier with a numeric domain stands
	 * with bounds, and a guard narrows it whatever its operands proved; only a carrier with none (boundsOfType) stands
	 * without. A numeric bound past numeric's numericMaxIntegerDigits is ResourceBound: every numeric expression's is
	 * known. A builder types its term and refuses only what is malformed; the bound is compilation's, a typed refusal of
	 * the compile.
	 */
	settle(
		entry: ScalarExpr,
		stated: ScalarType,
		actual: ScalarType,
		proved: { readonly bounds: Bounds | undefined; readonly facts: FactSet } | undefined,
		held: ReadonlyArray<WhenParameter>
	): Lowered {
		let nominal = stated
		let bounds = proved?.bounds ?? boundsOfType(nominal)
		let facts: FactSet =
			proved === undefined
				? factsOfType(nominal)
				: Object.freeze({ ...carrierFacts(nominal), ...proved.facts })
		for (const scope of this.#scope) {
			const holds =
				scope.kind === "parameter" ? held.includes(scope) : sameExpr(scope.holds.subject, entry)
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
		if (
			this.env.mode !== "build" &&
			bounds !== undefined &&
			bounds.digits > numericMaxIntegerDigits
		) {
			throw new Refusal(
				CompileError.make({
					_tag: "ResourceBound",
					at: this.env.loc,
					bound: {
						kind: "numericDigits",
						limit: numericMaxIntegerDigits,
						needed: bounds.digits
					}
				})
			)
		}
		return new Lowered(entry, nominal, actual, bounds, facts, held)
	}

	/**
	 * `term` at the type `stated` and the SQL type `actual`, with its bounds and `facts`, settled again, so the guards
	 * it stands under narrow the type the operation states: how an operation states the type of the term it makes or
	 * passes on, a collapse's or a translation's language, a cast's target or a value's base, never by writing it after
	 * settle. A parameter restated is the parameter still (held).
	 */
	restate(term: Lowered, stated: ScalarType, actual: ScalarType, facts: FactSet): Lowered {
		return this.settle(term.expr, stated, actual, { bounds: term.bounds, facts }, term.held)
	}

	/** The node of `spec`, recorded: of its own type nominally and actually, its bounds and facts its type's. */
	emit(spec: ExprSpec): Lowered {
		const entry = this.env.emit(spec)
		return this.settle(entry, entry.type, entry.type, undefined, [])
	}

	/**
	 * A node of `spec` with what its computation proved: a computed numeric's type carries exactly the bounds proved of
	 * it (numericOf), so its type is its proof wherever it is read again; bounds it proves nothing of are its type's
	 * (settle).
	 */
	emitProved(spec: ExprSpec, bounds: Bounds | undefined, facts: FactSet): Lowered {
		return this.emitAt(
			isComputedNumeric(spec.type) ? { ...spec, type: numericOf(bounds) } : spec,
			bounds,
			facts
		)
	}

	/**
	 * A node of `spec` at the type `spec` states, with what its computation proved: a node whose type is its purpose, a
	 * coercion at its target, and a conditional, LEAST and GREATEST at their operands' common type, since each is one of
	 * its operands; the proved bounds lie within that type.
	 */
	emitAt(spec: ExprSpec, bounds: Bounds | undefined, facts: FactSet): Lowered {
		const entry = this.env.emit(spec)
		return this.settle(entry, entry.type, entry.type, { bounds, facts }, [])
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
		return this.nativeJudged(op, args, args, type, bounds, at, operation)
	}

	/**
	 * A node of `op` over the operands it reads, `args`, its preconditions judged over the caller's terms they stand for,
	 * `judged`, position by position: an exact widening the lowering puts between a term and the node keeps every fact
	 * of the term, so the proof is the term's, and a refusal names the term and the remedy its own type has.
	 */
	nativeJudged(
		op: NativeOp,
		args: ReadonlyArray<Lowered>,
		judged: ReadonlyArray<Lowered>,
		type: ScalarType,
		bounds: Bounds | undefined,
		at: SourceLoc,
		operation: string
	): Lowered {
		const operands = args.map((a) => a.expr)
		if (!op.partial) {
			return this.emitProved(
				this.totalSpec(op, args, type),
				resultBounds(op, type, bounds),
				noFacts
			)
		}
		if (this.env.mode === "build") {
			return this.typedOnly(type, bounds)
		}
		const proof = this.proveAll(op.totality.preconditions, judged, type, at, operation)
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
	 * The node of an overload defined everywhere over `args`, of `type`: its DefinedOp, with the proof that PostgreSQL's
	 * own overload computes it where it stands if it is IEEE 754 (nativeProofOf).
	 */
	totalSpec(
		op: Extract<NativeOp, { readonly partial: false }>,
		args: ReadonlyArray<Lowered>,
		type: ScalarType
	): ExprSpec {
		const operands = args.map((a) => a.expr)
		const native = this.nativeProofOf(op, args, type)
		return native === undefined
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
				}
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
	 * The proof of one precondition over `args`: a fact precondition by its operand's fact alone, the facts its
	 * TypeScript type states, so a contract proves only the facts it declares; a magnitude one by the operand's bounds;
	 * or the PartialOperation refusal naming the guard to write.
	 */
	prove(
		precondition: Precondition,
		args: ReadonlyArray<Lowered>,
		target: ScalarType,
		at: SourceLoc,
		operation: string
	): PreconditionProof {
		const refuse = (operand: number): never => {
			const named = defined(args[operand], "the operand a precondition names")
			const text = exprText(named.expr)
			throw new Refusal(
				CompileError.make({
					_tag: "PartialOperation",
					at,
					operation,
					precondition: precondition.kind,
					operand: text,
					guard: guardOf(
						precondition.kind,
						guardTest(precondition, named, target, this.env.mode, this.env.patterns),
						text,
						operation
					)
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
						: factPremise(precondition.operand, precondition.kind, a.facts)
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
			case "language": {
				const a = args[0]
				const refinement = refinementOf(target)
				const premise =
					a === undefined || refinement === undefined
						? undefined
						: languagePremise(
								a,
								patternsText(refinement.patterns),
								(regex) => patternIncludes(regex.patterns, refinement.patterns, this.env.patterns),
								octetsOf(refinement.check),
								this.env.patterns,
								at
							)
				return premise === undefined ? refuse(0) : { precondition, premises: [premise] }
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
						: powerSignPremises(base, exponent)
				return premises === undefined ? refuse(0) : { precondition, premises }
			}
			case "powerRange": {
				const [base, exponent] = args
				const premises =
					base === undefined || exponent === undefined
						? undefined
						: powerRangePremises(base, exponent, target)
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
			case "lexical": {
				const a = args[0]
				const premise =
					a === undefined
						? undefined
						: lexicalPremise(a, parseTargetOf(precondition.form, target), at, this.env.patterns)
				return premise === undefined ? refuse(0) : { precondition, premises: [premise] }
			}
			case "bounded": {
				const a = args[0]
				const bytes = a === undefined ? undefined : textBytes(a)
				return bytes === undefined || bytes > regexTextMaxBytes
					? refuse(0)
					: { precondition, premises: [{ kind: "octets", operand: 0, bytes }] }
			}
		}
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
	castNode(arg: Lowered, to: ScalarType, how: CastHow, at: SourceLoc): Lowered {
		const conversion = conversionOf(arg.actual, to, how)
		const bounds = arg.bounds === undefined ? undefined : castBounds(arg.bounds, conversion, to)
		const facts = keptFacts(arg, conversion, to)
		if (how.kind === "coercion") {
			const entry = this.env.emit({
				kind: "cast",
				cast: binaryCoercion,
				args: [arg.expr],
				type: enteredType(to),
				nonNull: "strict",
				volatility: "immutable"
			})
			return this.settle(entry, to, entry.type, { bounds, facts }, [])
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
		const proof =
			how.kind === "computed"
				? computedCastProof(op.totality.preconditions, arg, to)
				: this.proveAll(
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
	 * value satisfies it, a literal judged before any SQL (ContractLiteral), a parameter PostgreSQL checks as it binds it
	 * (lower/conservative/context.ts paramTypeRef), or a value whose bounds satisfy each contract level's predicate; else
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
		const precondition: Precondition =
			refinementOf(to) === undefined ? { kind: "contract" } : { kind: "language" }
		const proof: OperationProof = [
			checked === undefined || !this.checkedAgainst(value, to, checked, at)
				? this.prove(
						precondition,
						[value],
						to,
						at,
						`Compute.cast(${exprText(value.expr)}, ${typeLabel(to)})`
					)
				: {
						precondition,
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
		const member = literalMember(value.expr.value, to, env.patterns)
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
	literalNode(literal: TypedLiteral, type: ScalarType): Lowered {
		const date = dateExact(literal)
		const n = date ?? literalNumber(literal)
		const point = n === undefined ? undefined : typeof n === "object" ? ofPoint(n) : ofSpecial(n)
		const at = isComputedNumeric(type) ? numericOf(point) : type
		const entry = this.env.emit({
			kind: "literal",
			value: literal,
			args: [],
			type: at,
			nonNull: "literal"
		})
		if (n === undefined || point === undefined || boundsOfType(at) === undefined) {
			return this.settle(entry, at, entry.type, undefined, [])
		}
		return this.settle(
			entry,
			at,
			entry.type,
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
	 * A literal adopting `type`, admitted as every typed slot admits one (evaluate.ts admitLiteral): the base first,
	 * then, outside a builder, the contract and the regex refinement.
	 */
	literal(value: LiteralDesc, type: ScalarType, at: SourceLoc): Lowered {
		const admitted = admitLiteral(
			value,
			type,
			this.env.mode === "build"
				? { kind: "shape" }
				: { kind: "refinements", patterns: this.env.patterns }
		)
		if (!admitted.ok) {
			return stop(admitted.error.reason, at, admitted.error.capability)
		}
		return this.literalNode(admitted.value, type)
	}

	/**
	 * A parameter, of its declared type: a term like any other, its serial its integer. Its placeholder is typed by its
	 * refinement's domain where its declared type is a contract or a pattern (lower/conservative/context.ts
	 * paramTypeRef), which PostgreSQL checks the value against as it binds it, so the parameter has its type's bounds and
	 * facts, a contract's declared ones among them.
	 */
	param(param: ParamRef<R>, at: SourceLoc): Lowered {
		const params = this.env.params
		if (params.kind === "none") {
			throw new Refusal(ruleRefused(at, "a schema predicate reads no parameter"))
		}
		const { spec, type } = unwrapOrRefuse(params.lower(param, at))
		const entry = this.env.emit(spec)
		return this.settle(entry, type, entry.type, undefined, [])
	}

	/**
	 * A term read whole, as a head reads it or a field is written from it: a bare reference of any type, bytes among them,
	 * or any other term (term), whose operands an operation reads.
	 */
	whole(desc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		return isReference(desc)
			? this.emit(unwrapOrRefuse(this.env.leaf(desc, at)))
			: this.term(desc, at)
	}

	/**
	 * A reference an operation reads: refused where its type is stored only (scalar/registry.ts storedOnly), as bytes is,
	 * so no comparison, computation, cast, conditional or guard reads one; Compute.sha256 reads its operand whole
	 * (sha256).
	 */
	reference(desc: LeafDesc<R>, at: SourceLoc): Lowered {
		const leaf = this.emit(unwrapOrRefuse(this.env.leaf(desc, at)))
		return storedOnly(leaf.nominal)
			? stop(
					"UnsupportedOperation",
					at,
					`storage: ${typeLabel(leaf.nominal)} is stored only, read whole as a head or a written value, so no Compute operation, rule, selection or filter reads it`
				)
			: leaf
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
	 * which the operation widens exactly (exactPair). A bare literal beside a contract's term in arithmetic is a value
	 * opposite that term, so it is a value of its type, as README reads a value opposite a term: the contract judges it
	 * (ContractLiteral, where compilation reads the contract), and the operation reads it at the base it computes over.
	 */
	operand(desc: ExprDesc<Located, R>, against: Lowered, role: Role, at: SourceLoc): Lowered {
		if (desc.kind === "literal" && desc.type === undefined) {
			const literal = this.literal(desc.value, this.adopt(against.nominal, role), at)
			if (
				role === "arithmetic" &&
				this.env.mode !== "build" &&
				contractOf(against.nominal) !== undefined
			) {
				const judged = admitLiteral(desc.value, against.nominal, {
					kind: "refinements",
					patterns: this.env.patterns
				})
				if (!judged.ok) {
					return stop(judged.error.reason, at, judged.error.capability)
				}
			}
			return literal
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

	/** The overload of `fn` typed by its operands' common type, over operands of `type`. */
	commonOp(fn: CommonTypeFn, type: ScalarType, at: SourceLoc): CommonTypeOp {
		const op = commonTypeOf(fn, baseOf(type).carrier)
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
					: plainType(r)
	}

	lower(desc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
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
					const t = inferredType(desc.type, (d) => unwrapOrRefuse(this.env.fieldType(d, at)))
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
			case "closedAt":
				return this.closedAt(desc, at)
			case "closedRow":
				return this.closedRow(desc, at)
			case "closedHas":
				return this.closedHas(desc, at)
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
				return unwrapOrRefuse(
					this.env.extension(desc, at, (child) =>
						catchRefusal(() => this.lower(child, childLoc(at, desc.kind)))
					)
				)
			}
		}
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
	): readonly [Lowered, Lowered] {
		const a = this.term(first, childLoc(at, 0))
		return [a, this.textOperand(fn, a, second, at)]
	}

	/** The second operand of a text operation over the text term `a`: a text term, or a bare literal of text. */
	textOperand(fn: string, a: Lowered, second: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		if (baseOf(a.actual).carrier !== "text") {
			return stop("MalformedDescription", at, `a text term for ${fn}, not ${typeLabel(a.nominal)}`)
		}
		const b = this.operand(second, a, "operand", childLoc(at, 1))
		if (baseOf(b.actual).carrier !== "text") {
			return stop(
				"MalformedDescription",
				at,
				`a text operand for ${fn}, not ${typeLabel(b.nominal)}`
			)
		}
		return b
	}

	/**
	 * Compute.concat(a, b), PostgreSQL's textcat: the node computes text, and the term is text of no pattern within the
	 * sum of its operands' bytes where both are bounded, a text literal by its own and a term by its type's byte bound,
	 * since a || b takes a's bytes and b's; any text where either is unbounded. A builder types the term as text of no
	 * pattern.
	 */
	concat(first: ExprDesc<Located, R>, second: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		const [a, b] = this.texts("concat", first, second, at)
		const op = this.overload("concat", [a.actual, b.actual], at)
		const node = this.native(op, [a, b], wildcardText, undefined, at, "Compute.concat")
		const aBytes = textBytes(a)
		const bBytes = textBytes(b)
		return this.env.mode === "build" || aBytes === undefined || bBytes === undefined
			? node
			: this.restate(
					node,
					this.textWithin([wildcardPattern], aBytes + bBytes, this.env.patternLanguage, at),
					node.actual,
					node.facts
				)
	}

	/**
	 * An equation of a text with a concatenation, `t = p || q` or its negation, decided without building the
	 * concatenation: `CASE WHEN char_length(t) = char_length(p) + char_length(q) THEN starts_with(t, p) AND right(t,
	 * char_length(q)) = q ELSE <the lengths' equation> END`, which holds exactly where t is p then q, since its first
	 * characters are p's and the rest, of q's length, are q's. It is three-valued exactly as `t = p || q` is: the
	 * lengths' equation reads all three operands, so it is NULL where any is, and the CASE takes it there, where a
	 * conjunction would let a false prefix or suffix decide. No operand is longer than a value PostgreSQL already
	 * holds, so nothing allocates past MaxAllocSize, in any mode: a fold's combine over concat (ir/monoid.ts) is such an
	 * equation, and so stands in a law's violation query and its CHECK. Undefined for any other comparison.
	 */
	concatEquation(
		desc: Extract<ExprDesc<Located, R>, { readonly kind: "compare" }>,
		at: SourceLoc
	): Lowered | undefined {
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
		const [p, q] = this.texts("concat", argOf(cat, 0, here), argOf(cat, 1, here), here)
		const t =
			whole.kind === "literal" && whole.type === undefined
				? this.literal(whole.value, wildcardText, here)
				: this.textOperand("an equation with a concatenation", p, whole, here)
		const lengthOf = (x: Lowered): Lowered =>
			this.native(
				this.overload("charLength", [x.actual], here),
				[x],
				plainType("int4"),
				ofRange(0n, BigInt(maxAllocSize), String(maxAllocSize).length),
				here,
				"char_length"
			)
		const [lp, lq] = this.exactPair(lengthOf(p), lengthOf(q), here)
		const add = this.overload("add", [valueType(lp.nominal), valueType(lq.nominal)], here)
		const bounds = arithmeticBounds("add", lp.bounds, lq.bounds)
		const sum = this.native(add, [lp, lq], this.resultType(add, bounds), bounds, here, "length")
		const bool = plainType("bool")
		const test = (fn: "startsWith" | "endsWith", b: Lowered): Lowered =>
			this.native(this.overload(fn, [t.actual, b.actual], here), [t, b], bool, undefined, here, fn)
		const lengths = this.comparison("eq", [lengthOf(t), sum], here)
		const parts = this.native(
			this.overload("and", [bool], here),
			[test("startsWith", p), test("endsWith", q)],
			bool,
			undefined,
			here,
			"and"
		)
		const holds = this.conditional(lengths, parts, lengths, here)
		return desc.op === "eq"
			? holds
			: this.native(this.overload("not", [bool], here), [holds], bool, undefined, here, "not")
	}

	/**
	 * Compute.matches(subject, pattern), PostgreSQL's textregexeq: whether the subject holds a match of the pattern,
	 * which is a text term or a literal read under the flags "u", in grizzle's pattern grammar. Every value the pattern
	 * can take is seen here (patternAdmissions) and admitted as a str.regex pattern is, its grammar and PostgreSQL's
	 * regex compile space (scalar/regex/admit.ts admitMatch), and the node carries each one's source, whose ARE the SQL
	 * lowering spells for `~` in its place (PatternTable). A builder types the predicate alone: it sees no operand's
	 * value, and admits a literal pattern where it builds the call.
	 */
	matches(
		subjectDesc: ExprDesc<Located, R>,
		patternDesc: ExprDesc<Located, R>,
		at: SourceLoc
	): Lowered {
		return this.matchesOver(this.term(subjectDesc, childLoc(at, 0)), patternDesc, at)
	}

	/** Compute.matches over a subject already lowered: a guard's (whenScope), or a call's (matches). */
	matchesOver(subject: Lowered, patternDesc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		const pattern = this.textOperand("matches", subject, patternDesc, at)
		const op = this.overload("matches", [subject.actual, pattern.actual], at)
		if (this.env.mode === "build" || op.partial) {
			return this.typedOnly(plainType("bool"), undefined)
		}
		const patterns = this.patternTable(patternDesc, childLoc(at, "pattern"))
		this.regexReadable("Compute.matches", subject, at)
		return this.emitAt(
			{
				kind: "op",
				op: op.id,
				args: [subject.expr, pattern.expr],
				type: plainType("bool"),
				nonNull: "strict",
				volatility: op.volatility,
				patterns
			},
			undefined,
			noFacts
		)
	}

	/**
	 * In a query, the refusal of a regex read, `~`, over a text whose pattern does not bound its bytes within
	 * regexTextMaxBytes: PostgreSQL's regex engine widens its subject to four bytes for every byte before it matches and
	 * refuses an allocation past 1 GB, and a read never fails on a value. A check or a generated field reads any text,
	 * and its write fails on a longer one.
	 */
	regexReadable(what: string, subject: Lowered, at: SourceLoc): void {
		const bytes = textOf(subject.nominal)?.byteBound
		if (this.env.mode === "query" && (bytes === undefined || bytes > regexTextMaxBytes)) {
			stop(
				"UnsupportedOperation",
				at,
				`${what} in a query over a text whose pattern bounds it within ${regexTextMaxBytes} bytes: PostgreSQL's regex engine widens its subject to four bytes for every byte and refuses past 1 GB, and a read never fails on a value; ${bytes === undefined ? "the subject's pattern bounds no length" : `the subject's pattern bounds it at ${bytes} bytes`}, so bound it, or read it in a contract predicate, row check or generated field`
			)
		}
	}

	/**
	 * The table of the values a matches pattern can take (ir/expr.ts patternTableOf), each admitted once
	 * (patternAdmissions), read in the order the pattern states them, so a refusal names the first refused value it
	 * states.
	 */
	patternTable(desc: ExprDesc<Located, R>, at: SourceLoc): PatternTable {
		const admitted = this.patternAdmissions(desc, at)
		if (!isNonEmpty(admitted)) {
			return stop(
				"UnsupportedOperation",
				at,
				"a pattern of at least one value: the closed relation it reads holds no row, so the match could never be stated"
			)
		}
		return patternTableOf(mapNonEmpty(admitted, (a) => unwrapOrRefuse(matchSourceAt(a, at))))
	}

	/**
	 * The values a matches pattern can take, each a source text admitted (scalar/regex/admit.ts admitMatch), part by part
	 * (patternParts): a text literal's own; each value of a closed relation's text payload field that C.at reads, whatever
	 * its key, as the lowering batch admitted it (ClosedRelations.admitted). Any other part, a field, a parameter or a
	 * computed text, can be any text, so no measure bounds it, and it is refused, naming what it is.
	 */
	patternAdmissions(desc: ExprDesc<Located, R>, at: SourceLoc): ReadonlyArray<MatchAdmission> {
		return patternParts(desc).flatMap((part) =>
			this.partAdmissions(
				part,
				part.branches.reduce((loc, branch) => childLoc(loc, branch), at)
			)
		)
	}

	/** The admitted values of one part of a matches pattern (patternAdmissions), stated at `at`. */
	partAdmissions(part: PatternPart<R>, at: SourceLoc): ReadonlyArray<MatchAdmission> {
		switch (part.kind) {
			case "literal":
				return typeof part.desc.value === "string"
					? [admitMatch(part.desc.value)]
					: stop("MalformedDescription", at, "a text literal as matches's pattern")
			case "closedAt":
				return this.payloadAdmissions(part.desc.relation, part.desc.field, at)
			case "other":
				return stop(
					"UnsupportedOperation",
					at,
					`a pattern whose every value is seen when the schema compiles: matches's pattern is a text literal, a closed relation's text payload (C.at) or a Compute.cond of them, each value admitted inside PostgreSQL's regex compile space; a ${part.desc.kind} can be any text, so no measure bounds it`
				)
		}
	}

	/**
	 * The admitted values of the text payload field `field` of the closed relation `relation`, which C.at reads as a
	 * matches pattern: the lowering batch admitted each once, since its expressions read the field so (patternParts).
	 */
	payloadAdmissions(relation: string, field: string, at: SourceLoc): ReadonlyArray<MatchAdmission> {
		const heading = this.closedHeading("C.at", relation, at)
		const payload = heading.payload.find((f) => f.name === field)
		if (payload === undefined) {
			return stop(
				"MalformedDescription",
				at,
				`a payload field of ${relation} named ${JSON.stringify(field)}`
			)
		}
		if (payload.patterns.kind === "other") {
			return stop(
				"MalformedDescription",
				at,
				`a text payload as matches's pattern: ${relation}.${field} is ${typeLabel(payload.type)}`
			)
		}
		const { closed } = this.env
		const admitted = closed.kind === "schema" ? closed.admitted(relation, field) : undefined
		if (admitted === undefined) {
			throw defect(
				`the lowering batch admitted ${relation}.${field}, which a matches pattern of its expressions reads`
			)
		}
		return admitted
	}

	/**
	 * Compute.translate(x, from, to), PostgreSQL's translate: x with each character of from replaced by the character of
	 * to at its position. from and to are text literals the schema holds, of one length, from holding each character
	 * once (scalar/regex/translate.ts charMapOf), so the map is seen here and replaces each character by one. The node
	 * computes text; the term is text of the image of x's language under the map, within the bytes the image of a value
	 * of x's type takes where its type bounds them (translatedType). PostgreSQL allocates the result for four bytes of
	 * every byte of x and refuses one past MaxAllocSize, and a read never fails on a value, so a query translates only an
	 * x whose type bounds its bytes within translateMaxBytes; a check or generated field translates any text, and its
	 * write fails on a longer one. A builder types the term as text of no pattern: it sees no type's language.
	 */
	translate(
		subjectDesc: ExprDesc<Located, R>,
		fromDesc: ExprDesc<Located, R>,
		toDesc: ExprDesc<Located, R>,
		at: SourceLoc
	): Lowered {
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
		const bytes = textOf(x.nominal)?.byteBound
		if (this.env.mode === "query" && (bytes === undefined || bytes > translateMaxBytes)) {
			return stop(
				"UnsupportedOperation",
				at,
				`translate in a query over a text whose pattern bounds it within ${translateMaxBytes} bytes: PostgreSQL's translate allocates four bytes for every byte of its operand and refuses past 1 GB, and a read never fails on a value; ${bytes === undefined ? "the operand's pattern bounds no length" : `the operand's pattern bounds it at ${bytes} bytes`}, so bound it, or translate in a contract predicate, row check or generated field`
			)
		}
		const f = this.literal(from, wildcardText, childLoc(at, 1))
		const t = this.literal(to, wildcardText, childLoc(at, 2))
		const op = this.overload("translate", [x.actual, f.actual, t.actual], at)
		const node = this.native(op, [x, f, t], wildcardText, undefined, at, "Compute.translate")
		return this.mapped(x, node, map.value, at)
	}

	/**
	 * Compute.lowerAscii(x), ASCII's case fold, translate's by the capitals and their small letters (core/text.ts
	 * asciiFold), every other character as it is: lower under the C collation (registry.ts textLowerAscii), one node
	 * wherever it stands, a query, a CHECK and a generated field alike, which allocates x's own length, so it is defined
	 * on every text, and typed as that translation is (mapped). A builder types the term as text of no pattern.
	 */
	lowerAscii(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		const x = this.term(subjectDesc, childLoc(at, 0))
		if (baseOf(x.actual).carrier !== "text") {
			return stop(
				"MalformedDescription",
				at,
				`a text term for lowerAscii, not ${typeLabel(x.nominal)}`
			)
		}
		const op = this.overload("lowerAscii", [x.actual], at)
		const node = this.native(op, [x], wildcardText, undefined, at, "Compute.lowerAscii")
		return this.mapped(x, node, asciiFold, at)
	}

	/**
	 * A node that computes x's image under a map, as text of that image (translatedType); a builder's, or one over a text
	 * of no TextInfo, as it is.
	 */
	mapped(x: Lowered, node: Lowered, map: CharMap, at: SourceLoc): Lowered {
		const text = textOf(x.nominal)
		return this.env.mode === "build" || text === undefined
			? node
			: this.restate(
					node,
					this.translatedType(text, map, this.env.patternLanguage, at),
					node.actual,
					node.facts
				)
	}

	/**
	 * Text of the image of `text`'s language under a map (image), typed as str.bytes declares it (textWithin): within
	 * the most bytes the image of a text of `text`'s byte and character bounds over its patterns' characters takes
	 * (scalar/regex/translate.ts imageBytes), where its type bounds its bytes, which is its own bound for a map that
	 * takes no character to a wider one, an ASCII case fold or whiteSpace replace among them.
	 */
	translatedType(text: TextInfo, map: CharMap, analyze: TextLookup, at: SourceLoc): ScalarType {
		return this.textWithin(
			this.image(text.regex, map, analyze),
			text.byteBound === undefined
				? undefined
				: imageBytes(
						textPatterns(text.regex),
						map,
						textBounds(text.lengthBound, text.byteBound),
						this.env.patterns
					),
			analyze,
			at
		)
	}

	/**
	 * The patterns of the image of a language under a map, the conjunction of its patterns' images
	 * (scalar/regex/translate.ts imageOf), which holds the image of every value of the language: each the exact image,
	 * or, where the exact source passes a measure of PostgreSQL's regex compile space that the pattern itself fits, the
	 * image of that pattern alone, which holds every value of the image.
	 */
	image(regex: TextInfo["regex"], map: CharMap, analyze: TextLookup): Patterns {
		return mapNonEmpty(textPatterns(regex), (pattern): PatternSource => {
			const sources = imageOf(pattern, map, this.env.patterns)
			const exact = { source: sources.exact, flags: imageFlags }
			return analyze([exact]).ok ? exact : { source: sources.within, flags: imageFlags }
		})
	}

	/**
	 * Compute.collapse(x), XML Schema's whiteSpace collapse: each run of tab, LF, CR and space one space, and none at
	 * either end, by replace alone (registry.ts textCollapse), defined on every text, so a query collapses any text as a
	 * check does. The node computes text; the term is text of a language holding the image of x's, exactly where it is
	 * cheap to state, within x's byte bound (collapseType). A builder types the term as text of no pattern.
	 */
	collapse(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
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
		const node = this.native(op, [x], wildcardText, undefined, at, "Compute.collapse")
		return this.env.mode === "build" || text === undefined
			? node
			: this.restate(
					node,
					this.collapseType(text, this.env.patternLanguage, at),
					node.actual,
					node.facts
				)
	}

	/**
	 * Text of a language holding the image of `text`'s under collapse, within `text`'s byte bound, which collapse never
	 * lengthens, typed as str.bytes declares it (textWithin): the conjunction of each of its patterns' images
	 * (scalar/regex/whitespace.ts collapseSources), each the first of its sources the text analysis admits, held to its
	 * measures as a str.regex is; a pattern none of whose sources it admits states nothing, and a text none of whose
	 * patterns states anything is any text.
	 */
	collapseType(text: TextInfo, analyze: TextLookup, at: SourceLoc): ScalarType {
		const images = textPatterns(text.regex).flatMap((pattern): ReadonlyArray<PatternSource> => {
			const admitted = collapseSources(pattern, text.lengthBound, this.env.patterns).find(
				(c) => analyze([{ source: c.source, flags: c.flags }]).ok
			)
			return admitted === undefined ? [] : [{ source: admitted.source, flags: admitted.flags }]
		})
		return this.textWithin(
			isNonEmpty(images) ? images : [wildcardPattern],
			text.byteBound,
			analyze,
			at
		)
	}

	/**
	 * Compute.parseDouble(x): the double x's decimal text names, IEEE 754-2019's conversion from decimal character
	 * sequences, rounded to the nearest, ties to even, ±Infinity past the greatest finite double and a zero of the
	 * mantissa's sign below half the least subnormal; `INF`, `+INF`, `-INF` and `NaN` their own. The registry's one
	 * overload, text to double precision, admits its operand, and it is defined where x is a member of every double's
	 * text, the grammar of XML Schema 1.1's xs:double lexical space, its digits and exponent of any length (the lexical
	 * precondition over `doubleText`, proved by `prove`). Its SQL reads no regex and allocates nothing past x's own size,
	 * so it stands in a query over any text as in a check or a generated field.
	 */
	parseDouble(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		const x = this.term(subjectDesc, childLoc(at, 0))
		const op = this.overload("parseDouble", [x.actual], at)
		const type = this.resultType(op, undefined)
		return this.native(
			op,
			[x],
			type,
			boundsOfType(type),
			at,
			`Compute.parseDouble(${exprText(x.expr)})`
		)
	}

	/**
	 * Compute.utf16Length(x): x's UTF-16 code units, JavaScript's String.length (registry.ts textUtf16Length), at most
	 * MaxAllocSize as char_length is. It exists where char_length does, in contract predicates, row checks and generated
	 * fields, never in a query, and it is defined where x is within regexTextMaxBytes (`bounded`), which x's byte bound
	 * proves: its type's, or the guard Compute.when(Compute.within(Compute.octetLength(x), 0, bytes), ...) whose branch
	 * it stands in; nothing else does, so no law that reads it raises on a long text.
	 */
	utf16Length(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		if (this.env.mode === "query") {
			return stop(
				"UnsupportedOperation",
				at,
				"utf16Length in a query: it exists only in contract predicates and row checks, because queries have no text functions"
			)
		}
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
			`Compute.utf16Length(${exprText(x.expr)})`
		)
	}

	/**
	 * Compute.parseDecimal(x): the numeric x's decimal text names, exactly, by xs:decimal's lexical mapping, a computed
	 * numeric of no typmod. The registry's one overload, text to numeric, admits its operand, and it is defined where x
	 * is a member of every decimal text within decimalTextMaxBytes, the grammar of XML Schema 1.1's xs:decimal lexical
	 * space within the bytes whose every value numeric holds (the lexical precondition over `decimalText`, proved by
	 * `prove` from x's language and its byte bound). Its value has at most as many integer digits as x has bytes and one
	 * fewer fraction digits (decimalBounds), so x's byte bound proves the cast of it into a numeric(p, s) that holds
	 * them; a literal's, which no type bounds, is numeric's own.
	 */
	parseDecimal(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		const x = this.term(subjectDesc, childLoc(at, 0))
		const op = this.overload("parseDecimal", [x.actual], at)
		const bytes = textOf(x.nominal)?.byteBound
		const bounds = bytes === undefined ? undefined : decimalBounds(bytes)
		return this.native(
			op,
			[x],
			this.resultType(op, bounds),
			bounds,
			at,
			`Compute.parseDecimal(${exprText(x.expr)})`
		)
	}

	/**
	 * Compute.sha256(x): the SHA-256 digest of a bytes value as 64 lowercase hex digits, `encode(sha256(x), 'hex')`, the
	 * one operation that reads a bytes value, which it reads whole, as a head does (whole): no operation yields bytes, so
	 * its operand is a bytes reference, a row's field or a variable. The node computes text; the term is text of
	 * digestText's language (registry.ts), whose pattern bounds it at 64 bytes, so a cast into a text type whose language
	 * holds it is proved, and a literal opposite it is judged by it. Its SQL allocates 64 characters whatever x's length,
	 * so it stands in a query as in a check or a generated field. A builder types the term as text of no pattern: it sees
	 * no type's language.
	 */
	sha256(subjectDesc: ExprDesc<Located, R>, at: SourceLoc): Lowered {
		const x = this.whole(subjectDesc, childLoc(at, 0))
		if (baseOf(x.actual).carrier !== "bytes") {
			return stop(
				"MalformedDescription",
				at,
				`a bytes term for sha256, not ${typeLabel(x.nominal)}`
			)
		}
		const op = this.overload("sha256", [x.actual], at)
		const node = this.native(op, [x], wildcardText, undefined, at, "Compute.sha256")
		return this.env.mode === "build"
			? node
			: this.restate(
					node,
					this.textWithin([digestText], undefined, this.env.patternLanguage, at),
					node.actual,
					node.facts
				)
	}

	/** A set over a roster, and the roster, or the refusal of a term of another type: it has no set algebra. */
	set(
		fn: string,
		x: Lowered,
		at: SourceLoc
	): { readonly set: Lowered; readonly roster: { readonly handles: ReadonlyArray<string> } } {
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
	 * Compute.singleton(id): the set over a closed id's roster holding exactly its handle, the empty set with the id's
	 * code's bit set (registry.ts setAdjoin), so it is the set Bits.of writes for that one handle. A NULL id gives NULL,
	 * and a term of any other type has no singleton.
	 */
	singleton(id: Lowered, at: SourceLoc): Lowered {
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
			roster: base.roster
		})
		const empty = this.literal({ handles: [] }, type, childLoc(at, "empty"))
		return this.emitAt(
			this.totalSpec(this.commonOp("adjoin", type, at), [empty, id], type),
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
	): readonly [Lowered, Lowered] {
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
		const { closed } = this.env
		if (closed.kind === "none") {
			return stop("UnsupportedOperation", at, `${read} here: ${closed.why}`)
		}
		return (
			closed.heading(relation) ??
			stop("MalformedDescription", at, `a closed relation named ${JSON.stringify(relation)}`)
		)
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
	): Lowered {
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
	): NonEmptyReadonlyArray<ScalarExpr> {
		if (args.length !== heading.key.length) {
			return stop(
				"MalformedDescription",
				at,
				`${heading.key.length} key terms for ${relation}.${read === "C.at" ? "at" : "has"}, one per key field`
			)
		}
		return mapNonEmpty(args, (d, i) => this.keyTerm(d, i, heading.key, at).expr)
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
	): Lowered {
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
	 * C.has(t…): whether the closed relation holds a tuple at the key its terms are, one per key field in key order, a
	 * boolean: false at a key it holds no tuple at, so absence is a truth value, and NULL only at a NULL key term. It
	 * reads the relation's key set alone, never a payload.
	 */
	closedHas(
		desc: Extract<ExprDesc<Located, R>, { readonly kind: "closedHas" }>,
		at: SourceLoc
	): Lowered {
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
	): Lowered {
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
		return this.emitProved(
			{
				kind: "closedRow",
				relation: desc.relation,
				args: args.map((a) => a.expr),
				type: Object.freeze({ carrier: "bits", caps: capabilitiesOf("bits"), roster }),
				nonNull: "strict"
			},
			undefined,
			noFacts
		)
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
	): readonly [Lowered, Lowered] {
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
	 * type of Compute.cond and Compute.when states none of its branches'.
	 */
	conditional(p: Lowered, onTrue: Lowered, onFalse: Lowered, at: SourceLoc): Lowered {
		const type = commonType(onTrue.nominal, onFalse.nominal)
		const t = this.convert(onTrue, type, at)
		const e = this.convert(onFalse, type, at)
		const bounds =
			t.bounds !== undefined && e.bounds !== undefined ? hullBounds(t.bounds, e.bounds) : undefined
		return this.emitAt(
			{ kind: "cond", args: [p.expr, t.expr, e.expr], type, nonNull: "cond" },
			bounds,
			noFacts
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
	 * <otherwise> END, where the branch's parameter, each guarded node of the guard over the subject inside the then
	 * branch, has what the guard establishes, its facts and its refined interval (guarded); the subject read past the
	 * parameter keeps its own, as TypeScript types it, which narrows a callback's parameter and never a term the callback
	 * captures. PostgreSQL evaluates a CASE result only where its WHEN holds, and drops unsimplified the result a WHEN
	 * constant at plan time does not take (a parameter's), so the then branch never meets a value the guard excludes. A
	 * guard refines only its own parameter: a precondition over constants is proved by the constants alone, never by a
	 * guard on something else, since PostgreSQL may fold a constant then branch at plan time.
	 */
	when(desc: Extract<ExprDesc<Located, R>, { readonly kind: "when" }>, at: SourceLoc): Lowered {
		const here = childLoc(at, "when")
		const subject = this.term(desc.subject, childLoc(here, "subject"))
		const guard = this.guardPredicate(desc.guard, subject, here)
		const branch = new Lowering(this.env, [
			...this.#scope,
			...this.whenScope(desc.guard, desc.subject, subject, guard.within, here)
		])
		const onTrue = branch.term(desc.proved, childLoc(here, "proved"))
		const onFalse = this.branchOperand(desc.otherwise, onTrue, childLoc(here, "otherwise"))
		if (!isBareLiteral(desc.otherwise)) {
			this.exactBeside(onTrue, onFalse, childLoc(here, "otherwise"))
		}
		return this.conditional(guard.predicate, onTrue, onFalse, at)
	}

	/**
	 * A Compute.when branch's parameter (ir/desc.ts GuardedDesc): its subject, with what each enclosing Compute.when of
	 * its guard over that subject establishes there, which every restatement of it keeps (settle, `held`). Outside every
	 * such when it is its subject with its own facts, so a copy of a parameter read past its branch proves nothing. The
	 * node is a proof's alone: it records no node and no location of its own.
	 */
	guarded(
		desc: Extract<ExprDesc<Located, R>, { readonly kind: "guarded" }>,
		at: SourceLoc
	): Lowered {
		const arg = this.term(desc.arg, at)
		const whens = this.#scope.flatMap((scope) =>
			scope.kind === "parameter" &&
			sameContent(scope.guard, desc.guard) &&
			sameExpr(scope.holds.subject, arg.expr)
				? [scope]
				: []
		)
		return this.settle(
			arg.expr,
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
	 * byte count, Compute.octetLength(x), x within the interval's high end of bytes at every occurrence of it
	 * (bytesGuard). A builder proves nothing, so in its branch the subject keeps its type.
	 */
	whenScope(
		guard: GuardDesc,
		subjectDesc: ExprDesc<Located, R>,
		subject: Lowered,
		within: readonly [Exact, Exact] | undefined,
		at: SourceLoc
	): ReadonlyArray<WhenScope> {
		const env = this.env
		if (guard.kind !== "matches") {
			const parameter: WhenScope = {
				kind: "parameter",
				guard,
				holds: {
					kind: "facts",
					subject: subject.expr,
					refinement: guardRefinement(guard, within),
					facts: guardFacts(guard, within)
				}
			}
			const counted = unguarded(subjectDesc)
			if (
				env.mode === "build" ||
				within === undefined ||
				counted.kind !== "compute" ||
				counted.fn !== "octetLength"
			) {
				return [parameter]
			}
			const text = this.term(argOf(counted, 0, at), childLoc(at, "subject", 0))
			const bytes = this.bytesGuard(text, within[1], env.patternLanguage, at)
			return bytes === undefined ? [parameter] : [parameter, { kind: "occurrences", holds: bytes }]
		}
		if (env.mode === "build") {
			return []
		}
		const own = textOf(subject.nominal)
		const type = this.textWithin(
			appendNonEmpty(own === undefined || own.regex === "wildcard" ? [] : own.regex.patterns, {
				source: guard.pattern,
				flags: matchFlags
			}),
			own?.byteBound,
			env.patternLanguage,
			childLoc(at, "pattern")
		)
		return [{ kind: "parameter", guard, holds: { kind: "language", subject: subject.expr, type } }]
	}

	/**
	 * What a bound on a text's byte count gives the text inside the guard's branch: its patterns' language within
	 * `high` bytes, none below zero, the type str.bytes(high, its text) declares; nothing where its type already
	 * bounds it so. A wildcard text's pattern is every text's, `^.*$` under `su`.
	 */
	bytesGuard(
		text: Lowered,
		high: Exact,
		analyze: TextLookup,
		at: SourceLoc
	): WhenGuard | undefined {
		const info = textOf(text.nominal)
		const ceiling = floorOfExact(high)
		const octets = ceiling < 0n ? 0 : Number(ceiling)
		if (info === undefined || (info.byteBound !== undefined && info.byteBound <= octets)) {
			return undefined
		}
		return {
			kind: "language",
			subject: text.expr,
			type: this.textWithin(textPatterns(info.regex), octets, analyze, at)
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
		const pattern = unwrapOrRefuse(analyze(patterns))
		const language = octets === undefined ? pattern : languageWithin(pattern, octets)
		return unwrapOrRefuse(
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
		subject: Lowered,
		at: SourceLoc
	): { readonly predicate: Lowered; readonly within: readonly [Exact, Exact] | undefined } {
		const v = valueType(subject.nominal)
		const compareTo = (literal: LiteralDesc): Lowered =>
			this.literal(literal, this.adopt(v, "compare"), at)
		const bounded = (literal: LiteralDesc): Lowered =>
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
						`Compute.within over a number, not ${typeLabel(subject.nominal)}`
					)
				}
				const lo = bounded(guard.low)
				const hi = bounded(guard.high)
				const low = lo.bounds === undefined ? undefined : pointOf(lo.bounds)
				const high = hi.bounds === undefined ? undefined : pointOf(hi.bounds)
				if (low === undefined || high === undefined) {
					return stop("MalformedDescription", at, "Compute.within's bounds: two finite literals")
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

	cast(desc: Extract<ExprDesc<Located, R>, { readonly kind: "cast" }>, at: SourceLoc): Lowered {
		const arg = this.term(desc.arg, childLoc(at, "cast"))
		const to = unwrapOrRefuse(this.env.fieldType(desc.to, childLoc(at, "cast", "to")))
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
		return this.restate(shaped, to, plain ? to : shaped.actual, shaped.facts)
	}

	/**
	 * A parse, Compute.cast of a text into a type with a lexical form (scalar/lexical.ts): one cast node at the target's
	 * base, its numeric typmod included, since the form is the typmod's, defined where the text is a member of the form
	 * (the lexical precondition, proved by `prove`); then a domain cast into a contract over the base, which the
	 * parsed value's bounds, the base's own, prove or refuse. A base with no lexical form has no parse.
	 */
	parse(arg: Lowered, to: ScalarType, at: SourceLoc): Lowered {
		const target = baseOf(to)
		const op = castOf("text", target.carrier)
		if (op === undefined || lexicalTargetOf(target) === undefined) {
			return stop(
				"UnsupportedOperation",
				at,
				`cast: ${typeLabel(target)} has no lexical form a text parses into; the forms are an integer type's, numeric(p, s) with 0 <= s <= p and at most ${regexMaxRepeat} digits on either side of its point, double precision's, boolean's and date's; Compute.parseDecimal(x) reads any decimal text into numeric exactly`
			)
		}
		if (!op.partial) {
			throw defect(
				`a parse, defined where its text is a member of its lexical form: ${typeLabel(target)}`
			)
		}
		const bounds = boundsOfType(target)
		const value =
			this.env.mode === "build"
				? this.typedOnly(target, bounds)
				: this.emitProved(
						{
							kind: "cast",
							cast: op.id,
							args: [arg.expr],
							type: target,
							nonNull: "strict",
							volatility: op.volatility,
							proof: this.proveAll(
								op.totality.preconditions,
								[arg],
								target,
								at,
								`Compute.cast(${exprText(arg.expr)}, ${typeLabel(target)})`
							)
						},
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
	typmodCoercion(value: Lowered, target: ScalarType, at: SourceLoc): Lowered {
		const literal = value.expr.kind === "literal" ? value.expr.value : undefined
		const coerced =
			literal?.kind === "numeric"
				? normalizeNumeric(Decimal.fromValue(literal.value), numericTypmodOf(target))
				: undefined
		if (coerced?.ok === true) {
			return this.literalNode({ kind: "numeric", value: coerced.value }, target)
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
		if (this.check && !computeSpecs[fn].check) {
			return stop(
				"UnsupportedOperation",
				here,
				`${fn} in a contract predicate or row check: a check admits the operations the host evaluates for the ContractLiteral check, which are comparisons, between, in, boolean composition, abs, sign, arithmetic, Compute.cond, Compute.when, casts, charLength, octetLength, utf16Length, span endpoints, greatest and the set algebra`
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
					`Compute.${desc.fn}(${exprText(a.expr)}, ${exprText(b.expr)})`
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
					ofRange(0n, BigInt(numericMaxFractionDigits), String(numericMaxFractionDigits).length),
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
					const x = this.operand(d, a, "compare", childLoc(here, i + 1))
					this.exactBeside(a, x, childLoc(here, i + 1))
					return x
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
				const op = this.commonOp(desc.fn, type, here)
				const [head, ...tail] = converted
				const bounds = tail.reduce<Bounds | undefined>(
					(acc, x) =>
						acc === undefined || x.bounds === undefined ? undefined : hullBounds(acc, x.bounds),
					head?.bounds
				)
				return this.emitAt(
					this.totalSpec(op, converted, type),
					resultBounds(op, type, bounds),
					noFacts
				)
			}
			case "union":
			case "intersection":
			case "difference": {
				const [a, b] = this.sets(desc.fn, arg(0), arg(1), here)
				return this.emitAt(
					this.totalSpec(this.commonOp(desc.fn, a.nominal, here), [a, b], a.nominal),
					undefined,
					noFacts
				)
			}
			case "subset":
			case "disjoint": {
				const [a, b] = this.sets(desc.fn, arg(0), arg(1), here)
				const op = this.overload(desc.fn, [a.actual, b.actual], here)
				return this.native(op, [a, b], plainType("bool"), undefined, here, `Compute.${desc.fn}`)
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
					"Compute.cardinality"
				)
			}
			case "widthBucket":
				return this.widthBucket(args, here)
			case "lower":
			case "upper": {
				const s = this.span(arg(0), here)
				const endpoint = s.span
				const op = this.overload(desc.fn, [s.lowered.actual], here)
				return this.native(op, [s.lowered], endpoint, boundsOfType(endpoint), here, desc.fn)
			}
			case "width":
				return this.width(arg(0), here)
			case "charLength":
			case "octetLength": {
				if (this.env.mode === "query") {
					return stop(
						"UnsupportedOperation",
						here,
						`${desc.fn} in a query: it exists only in contract predicates and row checks, because queries have no text functions`
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
			case "concat": {
				if (this.env.mode === "query") {
					return stop(
						"UnsupportedOperation",
						here,
						"concat in a query beside an equation: a concatenation allocates its result, which PostgreSQL refuses past 1 GB, and a read never fails on a value; a query compares a text with a concatenation, which is decided without building it, and every other concatenation stands in contract predicates, row checks, generated fields and folds"
					)
				}
				return this.concat(arg(0), arg(1), here)
			}
			case "startsWith":
			case "endsWith": {
				const [a, b] = this.texts(desc.fn, arg(0), arg(1), here)
				const op = this.overload(desc.fn, [a.actual, b.actual], here)
				return this.native(op, [a, b], plainType("bool"), undefined, here, `Compute.${desc.fn}`)
			}
			case "matches":
				return this.matches(arg(0), arg(1), here)
			case "translate":
				return this.translate(arg(0), arg(1), arg(2), here)
			case "lowerAscii":
				return this.lowerAscii(arg(0), here)
			case "collapse":
				return this.collapse(arg(0), here)
			case "parseDouble":
				return this.parseDouble(arg(0), here)
			case "parseDecimal":
				return this.parseDecimal(arg(0), here)
			case "sha256":
				return this.sha256(arg(0), here)
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
	 * Compute.numeric: PostgreSQL's conversion of a number into numeric, `x::numeric`, a computed numeric typed by what
	 * the conversion proves of it: a registered cast from an integer, money, an exact value or a float, defined on every
	 * value (castNode, emitProved); the binary coercion from a numeric(p, s), its typmod dropped, into its value's proved
	 * bound (numericOf); a computed numeric itself. A text is no number: its cast into numeric is a parse, defined only on
	 * its lexical form, which Compute.cast states with its proof, so Compute.numeric refuses it whatever the operand.
	 */
	numeric(a: Lowered, at: SourceLoc): Lowered {
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
					`Compute.numeric: a conversion of a number into numeric, and ${typeLabel(from)} is no number; a text becomes one by Compute.parseDecimal(x), or by Compute.cast(x, T) into a type with a lexical form, under Compute.when(Compute.matches(x, lexicalForm(T)), …)`
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
	 * quotient by zero IEEE 754 defines; the caller's divisor is judged, the exact value it is widened into keeping its
	 * facts (nativeJudged).
	 */
	arithmetic(
		fn: "add" | "sub" | "mul" | "div" | "mod",
		left: ExprDesc<Located, R>,
		right: ExprDesc<Located, R>,
		at: SourceLoc
	): Lowered {
		const a0 = this.term(left, at)
		const b0 = this.operand(right, a0, "arithmetic", at)
		const va = valueType(a0.nominal)
		if (this.check && (isFloat(va) || va.carrier === "money" || va.carrier === "exactMoney")) {
			return this.floatArithmetic(fn, va, at)
		}
		const operation = `Compute.${fn}(${exprText(a0.expr)}, ${exprText(b0.expr)})`
		if (va.carrier === "date") {
			return stop(
				"UnsupportedOperation",
				at,
				`${fn}: PostgreSQL has no ${fn} over ${typeLabel(a0.nominal)}, ${typeLabel(b0.nominal)} that Compute admits`
			)
		}
		if (fn === "div" && exactFamily(va) === "exactInteger") {
			const a = this.widenExact(a0, "exactInteger", at)
			const b = this.widenExact(b0, "exactInteger", at)
			const op = this.overload("div", [a.actual, b.actual], at)
			const bounds = ofDigits(this.boundsOf(a, at).digits, 0, { infinite: false, nan: false })
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
	unary(fn: "neg" | "abs", a: Lowered, at: SourceLoc): Lowered {
		const op = this.overload(fn, [valueType(a.nominal)], at)
		const bounds =
			a.bounds === undefined ? undefined : fn === "neg" ? negBounds(a.bounds) : absBounds(a.bounds)
		const type = this.resultType(op, bounds)
		const result = this.native(op, [a], type, bounds, at, `Compute.${fn}`)
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
			case "date":
			case "text":
			case "bytes":
			case "code":
			case "bits":
			case "range4":
			case "range8":
			case "rangeDate":
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
	): Lowered {
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
		const bucket = ofRange(0n, BigInt(int4Max), int4Digits)
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
		case "date":
		case "text":
		case "bytes":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
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

/**
 * power's sign premises, the facts its TypeScript type states: its base never below zero, so no negative base meets a
 * fractional exponent, and its base never zero or its exponent never below zero, so zero meets no negative power.
 */
const powerSignPremises = (
	base: Lowered,
	exponent: Lowered
): NonEmptyReadonlyArray<OperandPremise> | undefined => {
	const nonnegative = factPremise(0, "nonnegative", base.facts)
	const nonzero =
		factPremise(0, "nonzero", base.facts) ?? factPremise(1, "nonnegative", exponent.facts)
	return nonnegative === undefined || nonzero === undefined ? undefined : [nonnegative, nonzero]
}

/**
 * power's range premises, which only the bound domain decides: both operands' finite intervals, small enough that the
 * result stays in range, as powerInRange states over numeric and double precision.
 */
const powerRangePremises = (
	base: Lowered,
	exponent: Lowered,
	target: ScalarType
): NonEmptyReadonlyArray<OperandPremise> | undefined => {
	const b = base.bounds === undefined ? undefined : finitePremise(0, base.bounds)
	const e = exponent.bounds === undefined ? undefined : finitePremise(1, exponent.bounds)
	return b === undefined || e === undefined || !powerInRange(b.low, b.high, e.low, e.high, target)
		? undefined
		: [b, e]
}

/**
 * Whether power over these intervals stays inside its result carrier, as powerRangePremises states. Over double precision
 * a zero exponent or a base exactly zero, each decided on its digits; or a base interval clear of zero whose result's
 * binary exponent, |e · log2 |b||, is at most binary64's greatest over every end of the intervals, so the result is
 * finite (dpow raises 22003 on an infinite result of finite operands) and, binary64's least subnormal exponent lying
 * further from zero, never rounds to zero (it raises 22003 on a zero result of a nonzero base). An interval holding
 * zero holds bases as near it as any, whose powers reach both. Each log2 |b| is read from b's digits (log2Magnitude)
 * and each |e| as the least double at or above it (magnitudeAtLeast), never through a double of the value, which
 * rounds to zero below 2^-1074: a reading within an ulp, a whole binade inside the overflow and fifty inside the
 * underflow. Over numeric, as PostgreSQL computes it (numeric.c power_var): an exponent proved one
 * integer, a point interval at an integer, is power_var_int's, which raises 22003 once its estimate of the result's
 * decimal weight passes (NUMERIC_WEIGHT_MAX + 1) · DEC_DIGITS, numericMaxIntegerDigits:
 * "if (f > (NUMERIC_WEIGHT_MAX + 1) * DEC_DIGITS)"
 * (https://github.com/postgres/postgres/blob/REL_19_RC2/src/backend/utils/adt/numeric.c#L11074), or once a product's
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
		if ((eLow.units === 0n && eHigh.units === 0n) || (bLow.units === 0n && bHigh.units === 0n)) {
			return true
		}
		if (bLow.units <= 0n && bHigh.units >= 0n) {
			return false
		}
		const reach =
			Math.max(Math.abs(log2Magnitude(bLow)), Math.abs(log2Magnitude(bHigh))) *
			Math.max(magnitudeAtLeast(eLow), magnitudeAtLeast(eHigh))
		return reach <= binary64MaxExponent
	}
	const weight = powerWeight(bLow, bHigh, eLow, eHigh)
	const integral = compareExact(eLow, eHigh) === 0 && scaleOfExact(eLow) === 0
	return integral ? weight < numericMaxIntegerDigits : weight * Math.LN10 < powerExpLimit
}

/**
 * power's result bounds where its premises hold: a float's its type's; a numeric's integer digits one past the whole
 * part of powerWeight's bound w. The result reaches 10^w itself, so w digits never suffice: x^0 and 1^y are 1, one
 * integer digit where w is 0, and a least base 10^-s raised to -y is 10^(s·y) exactly.
 */
const powerBounds = (a: Lowered, b: Lowered, v: ScalarType): Bounds | undefined => {
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
	insideRange(countLow, countHigh, exactOf(1n, 0), exactOf(BigInt(int4Max) - 1n, 0))

/** How a value's refinement is checked before any SQL, where it is: a literal at compile time, a parameter at bind. */
const checkedKind = (e: ScalarExpr): "literal" | "parameter" | undefined =>
	e.kind === "literal" ? "literal" : e.kind === "param" ? "parameter" : undefined

/**
 * Whether two lowered expressions compute the same value the same way: one kind, one source, one overload, one literal
 * and the same arguments, each in turn: how a guarded node finds the Compute.when whose parameter it is, and a byte
 * guard the occurrences of its text (WhenScope).
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
		case "closedAt":
			return b.kind === "closedAt" && a.relation === b.relation && a.field === b.field
		case "closedRow":
			return b.kind === "closedRow" && a.relation === b.relation
		case "closedHas":
			return b.kind === "closedHas" && a.relation === b.relation
	}
}

/** A description read past its guarded nodes: the term a Compute.when branch's parameter is (ir/desc.ts GuardedDesc). */
const unguarded = <R extends Refs>(desc: ExprDesc<Located, R>): ExprDesc<Located, R> =>
	desc.kind === "guarded" ? unguarded(desc.arg) : desc

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
 *   base, opposite an exact value its family's plain carrier, and is judged by the contract of the term it stands
 *   beside, the ContractLiteral check too.
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
 *   evaluates for the ContractLiteral check (registry.ts computeSpecs, check); float arithmetic, whose IEEE rendering binds operands in a
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
): Result.Result<Lowered, CompileError> => run(env, (l) => l.whole(desc, env.loc))

/**
 * Lowers a term a function returns unchanged, the argument of min or max: delivered with the contract the term has.
 * Where its node computes it without that contract, a parameter bound as its base or a Compute.base whose node still
 * carries the contract it drops, the node is converted into the term's own type, as LEAST and GREATEST convert their
 * operands (Lowering.convert).
 */
export const lowerReturned = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	env: LowerEnv<R>
): Result.Result<Lowered, CompileError> =>
	run(env, (l) => {
		const t = l.whole(desc, env.loc)
		return contractOf(t.actual)?.name === contractOf(t.nominal)?.name
			? t
			: l.convert(t, t.nominal, env.loc)
	})

/**
 * The proof of a cast the lowering writes over a value it computed itself (CastHow computed), from that value's own
 * interval: the lowering writes one only where the interval proves it, so a value it does not prove is a defect.
 */
const computedCastProof = (
	preconditions: NonEmptyReadonlyArray<Precondition>,
	arg: Lowered,
	to: ScalarType
): OperationProof => {
	const interval = arg.bounds === undefined ? undefined : intervalPremise(0, arg.bounds)
	const proof = interval === undefined ? undefined : intervalCastProof(preconditions, interval, to)
	if (proof === undefined) {
		throw defect(
			`a cast the lowering writes into ${typeLabel(to)}, over a value whose own interval proves it`
		)
	}
	return proof
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
			case "language":
			case "powerDomain":
			case "powerRange":
			case "bucketDomain":
			case "lexical":
			case "bounded":
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
export const loweredOf = (e: ScalarExpr): Lowered =>
	new Lowered(e, e.type, e.type, boundsOfType(e.type), factsOfType(e.type), [])

/** Lowers a predicate: a non-null SQL Boolean expression. */
export const lowerPredicate = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	env: LowerEnv<R>
): Result.Result<Lowered, CompileError> => run(env, (l) => l.predicate(desc, env.loc))
