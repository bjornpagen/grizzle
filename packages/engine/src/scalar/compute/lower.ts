import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { regexDfaMaxStates, regexDfaMaxWork } from "@bjornpagen/grizzle-text/regex/limits"
import { catchRefusal, int4Max, Refusal, unwrap } from "#compiler/core/canonical.ts"
import { clockReadingRange } from "#compiler/core/clock.ts"
import { regexTextMaxBytes } from "#compiler/core/errors.ts"
import {
	CompileError,
	type Guard,
	type GuardTest,
	type PreconditionKind
} from "#compiler/core/errors.ts"
import { ExprId } from "#compiler/core/ids.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { integerRanges } from "#compiler/ir/carriers.ts"
import { epochDayRange } from "#compiler/ir/date.ts"
import type { ExprDesc, FieldDesc, Located, Refs, Spelled } from "#compiler/ir/desc.ts"
import {
	builtExpr,
	type Effects,
	type ExprSpec,
	type ExprTable,
	type LiveArgs,
	type PatternTable,
	patternTableOf,
	type ScalarExpr,
	type TableExpr,
	withArgs
} from "#compiler/ir/expr.ts"
import type {
	Exact,
	Fact,
	OperandPremise,
	OperationProof,
	ParseForm,
	Precondition,
	PreconditionProof
} from "#compiler/ir/proof.ts"
import {
	baseOf,
	type ContractInfo,
	octetsOf,
	integerTypmodOf,
	isFloat,
	patternsText,
	type RegexRef,
	regexRefOf,
	type ScalarType,
	textInfoBounds,
	textOf,
	textPatterns,
	typeLabel
} from "#compiler/ir/scalar.ts"
import {
	type Bounds,
	compareExact,
	exactOf,
	type FactSet,
	factPremise,
	finiteEnds,
	finitePremise,
	insideRange,
	type IntervalPremise,
	intervalPremise,
	log2Magnitude,
	magnitudeAtLeast,
	minus,
	negExact,
	premiseHas,
	scaleOfExact,
	tenTo
} from "#compiler/scalar/compute/bounds.ts"
import { parseBy } from "#compiler/scalar/compute/cast.ts"
import { admitLiteral, literalMember, refined } from "#compiler/scalar/compute/evaluate.ts"
import { nativeProof } from "#compiler/scalar/compute/native.ts"
import type { NativeFn } from "#compiler/scalar/compute/registry.ts"
import { spelling } from "#compiler/scalar/compute/spelling.ts"
import { valueType } from "#compiler/scalar/compute/types.ts"
import {
	boundsOfType,
	type ClosedRelations,
	closedHeadingOf,
	contractLevels,
	type ExtensionDesc,
	factsOfType,
	type HeldLeaf,
	type LeafDesc,
	literalComparison,
	nodeLiteral,
	type LowerParams,
	moneyHigh,
	moneyLow,
	nodeText,
	opFn,
	type PatternRead,
	powerWeight,
	type RecordedNode,
	sameRefinement,
	stop,
	tableNumber,
	type TapeEntry,
	type TermTyping,
	textBytes,
	type LeafRead,
	type Typed,
	type TypedArgs,
	type TypedNode,
	type TypedSpec,
	typeOf,
	typePredicate,
	typeReturned,
	typeWithin,
	type TypingEnv,
	type CallableFunction,
	unprovedFact,
	withinGuards
} from "#compiler/scalar/compute/typing.ts"
import { castSpelling } from "#compiler/scalar/contract.ts"
import { binary64MaxExponent, decimalTextMaxBytes } from "#compiler/scalar/lexical.ts"
import {
	formOctets,
	formSource,
	type LexicalTarget,
	parseTargetOf
} from "#compiler/scalar/lexical.ts"
import { type MatchAdmission, matchValueAt } from "#compiler/scalar/regex/admit.ts"
import {
	type BoundedLanguage,
	formIncludes,
	languageIncludes,
	languageOf,
	patternIncludes
} from "#compiler/scalar/regex/inclusion.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { numericMaxIntegerDigits, numericMaxPrecision } from "#compiler/scalar/values/fault.ts"

/**
 * The internal limit on a calculation's result scale, NUMERIC_MAX_RESULT_SCALE.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit decimal digits
 * @scope the scale of an intermediate numeric result, which exp_var's input bound is three times
 * @derivation numeric.h: "#define NUMERIC_MAX_RESULT_SCALE (NUMERIC_MAX_PRECISION * 2)"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/include/utils/numeric.h#L46)
 * @from {@link numericMaxPrecision}
 */
const numericMaxResultScale = numericMaxPrecision * 2

/**
 * The bound PostgreSQL's power_var puts on exp(y · ln x) for an exponent that is no integer (numeric.c power_var, its
 * test before exp_var, and exp_var's own): y · ln x below NUMERIC_MAX_RESULT_SCALE · 3, at which it raises 22003
 * "value overflows numeric format".
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit a natural logarithm
 * @scope y · ln x of a power with an exponent that is no integer
 * @derivation exp_var's overflow test, three times the result scale: "if (fabs(val) >= NUMERIC_MAX_RESULT_SCALE * 3)"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/numeric.c#L10503)
 * @from {@link numericMaxResultScale}
 */
const powerExpLimit = numericMaxResultScale * 3

/**
 * A lowered term: its expression, the type the caller's term has (nominal), the SQL type the node computes (actual),
 * which differ only where a parameter is bound as its base or a cast keeps its source's refinement, its effects as its
 * table derived them (ir/expr.ts exprEffects), and what is proved of its values: the bound domain's interval and digits
 * where its type is a number (bounds.ts Bounds), and its facts (FactSet), as its typing (typing.ts Typed) states them.
 */
export class Lowered implements Effects {
	readonly expr: ScalarExpr
	readonly nominal: ScalarType
	readonly actual: ScalarType
	readonly volatility: Effects["volatility"]
	readonly bounds: Bounds | undefined
	readonly facts: FactSet

	constructor(
		expr: ScalarExpr,
		nominal: ScalarType,
		actual: ScalarType,
		bounds: Bounds | undefined,
		facts: FactSet
	) {
		this.expr = expr
		this.nominal = nominal
		this.actual = actual
		this.volatility = expr.volatility
		this.bounds = bounds
		this.facts = facts
	}
}

/**
 * The emitter of a lowering no DAG receives (a contract predicate, a generated field, a fold's combine): each
 * expression built over its arguments (ir/expr.ts builtExpr) under a fresh label `prefix#n`.
 */
export const exprEmitter = (prefix: string): ((spec: ExprSpec) => ScalarExpr) => {
	let next = 0
	return (spec) => builtExpr(spec, ExprId(`${prefix}#${next++}`))
}

/** The predicates other packages lower: r.allen, r.pointIn and r.not. */
export type LowerExtension<R extends Refs> = (
	desc: ExtensionDesc<R>,
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
	/** The node a leaf reference records at each use (typing.ts LeafRead). */
	readonly leaf: (desc: LeafDesc<R>, loc: SourceLoc) => Result.Result<LeafRead, CompileError>
	readonly params: LowerParams<R>
	/** The ScalarType of a descriptor's Description, for Type.literal and Type.cast (the descriptor registry). */
	readonly fieldType: (desc: FieldDesc, loc: SourceLoc) => Result.Result<ScalarType, CompileError>
	/** The closed relations C.at and C.row apply. */
	readonly closed: ClosedRelations
	/**
	 * The admitted patterns the lowering reads, its compile's table (scalar/regex/patterns.ts): a literal's membership
	 * in a regex refinement, a language's inclusion in another or in a lexical form, a translation's image, and the text
	 * analysis of a language the term computes, which its typing reads (typing.ts TextAnalysis).
	 */
	readonly patterns: PatternAutomata
}

/**
 * Where a term is compiled (typing.ts LowerSite): in a query (its filters and outputs), which alone lowers the
 * predicates of other packages, or in a check (a contract predicate or a row check, which reads only its VALUE or row
 * and becomes a CHECK). Each judges a literal against its refinements, by its patterns, and analyzes a language the
 * term computes.
 */
export type LowerEnv<R extends Refs = Spelled> =
	| (LowerCommon<R> & {
			readonly mode: "query"
			/** What the query's site proves of its leaves beyond their types (typing.ts HeldLeaf). */
			readonly held: ReadonlyArray<HeldLeaf>
			readonly extension: LowerExtension<R>
			/** The declared functions of the query's schema, by name, which a Fn.call term calls. */
			readonly functions: (name: string) => CallableFunction | undefined
	  })
	| (LowerCommon<R> & { readonly mode: "check" })

/** The typing a lowering reads: its environment's names, its text analyzed by the compile's patterns. */
const typingEnvOf = <R extends Refs>(env: LowerEnv<R>): TypingEnv<R> => ({
	loc: env.loc,
	leaf: env.leaf,
	params: env.params,
	fieldType: env.fieldType,
	closed: env.closed,
	functions:
		env.mode === "query"
			? { kind: "schema", of: env.functions }
			: {
					kind: "none",
					why: "PostgreSQL alone evaluates a declared function, and the host evaluates a check, a contract predicate and a generated field"
				},
	held: env.mode === "query" ? env.held : [],
	analysis: { kind: "analyzed", patterns: env.patterns }
})

/** The premise that every value of an operand is a member of a refinement's language. */
type LanguagePremise = Extract<OperandPremise, { readonly kind: "language" }>

/**
 * The premise that every value of `a` is a value of the language `outer`, a cast's target's refinement within its byte
 * bound or a parse's lexical form within its: a's refinement, its type's, a Text.matches guard's or a translation's
 * image (the nominal type), its language within its proved bytes (scalar/regex/inclusion.ts languageOf) included in
 * the outer one, every value within the outer bound (languageIncludes, the one inclusion judgment of texts, which the
 * tests' proof kernel decides again from the premise), the premise stating a's language and those bytes. Undefined
 * where a has no refinement, or its language holds a value the outer does not. Where comparing the two automata passes
 * the text analysis's bounds nothing is decided, which is ResourceBound naming them, since no guard is missing: a
 * smaller pattern or a match guard decides it. A LearnerId of 69 bytes casts into a Timeback user of 255 characters by
 * proof, though `^.+$` lies inside `^.{1,255}$` only within its bound.
 */
const languagePremise = (
	a: Typed,
	outerText: string,
	outer: BoundedLanguage,
	patterns: PatternAutomata,
	at: SourceLoc
): LanguagePremise | undefined => {
	const regex = regexRefOf(a.nominal)
	if (regex === undefined) {
		return undefined
	}
	const inner = languageOf(regex)
	switch (languageIncludes(inner, outer, patterns)) {
		case "included":
			return { kind: "language", operand: 0, patterns: inner.patterns, bytes: inner.octets }
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
						outer: outerText,
						states: regexDfaMaxStates,
						work: regexDfaMaxWork
					}
				})
			)
	}
}

/**
 * What proves a parse's operand a member of its lexical form, the target `form` (scalar/lexical.ts parseTargetOf):
 * a text literal by its own value, checked as the host parses it; any other text by its refinement whose language
 * within its bytes is included in the form's pattern within the form's byte bound where it has one (languagePremise,
 * the one inclusion judgment of texts, over formSource and formOctets). Undefined where neither proves it: a parse into
 * a type of no form, a text of no refinement, one whose language holds a value the form's pattern does not, or one of
 * more bytes.
 */
const lexicalPremise = (
	a: Typed,
	form: LexicalTarget | undefined,
	at: SourceLoc,
	patterns: PatternAutomata
): OperandPremise | undefined => {
	if (form === undefined) {
		return undefined
	}
	const literal = nodeLiteral(a.node)
	if (literal?.kind === "text") {
		return parseBy(form, literal.value).ok
			? { kind: "checked", operand: 0, by: "literal" }
			: undefined
	}
	return languagePremise(
		a,
		`/${formSource(form)}/u`,
		{ patterns: [{ source: formSource(form), flags: "u" }], octets: formOctets(form) },
		patterns,
		at
	)
}

/**
 * The refinement of a regex-refined text type with no contract, whose cast a language included in it proves: undefined
 * for any other type, whose contract's predicate the operand's bounds decide.
 */
const refinementOf = (target: ScalarType): RegexRef | undefined =>
	target.contract === undefined ? regexRefOf(target) : undefined

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
 * The remedy of a parse whose operand is not proved a member of its form: Text.matches of the form's pattern
 * (parseRemedy); and for a form whose byte bound cuts its pattern (formOctets), a bound on the operand's bytes at it
 * where the operand's language already lies inside the pattern, as for a cast into str.bytes.
 */
const lexicalRemedy = (
	form: ParseForm,
	operand: Typed,
	target: ScalarType,
	patterns: PatternAutomata
): GuardTest => {
	const matches: GuardTest = { kind: "matches", pattern: parseRemedy[form] }
	const lexical = parseTargetOf(form, target)
	const octets = lexical === undefined ? undefined : formOctets(lexical)
	const regex = regexRefOf(operand.nominal)
	if (lexical === undefined || octets === undefined || regex === undefined) {
		return matches
	}
	return formIncludes(regex.patterns, lexical, patterns).kind === "included"
		? { kind: "octets", bytes: octets }
		: matches
}

/**
 * The test a guard of `precondition` puts over an operand of type `operand`: a fact's own test, Num.within for a
 * magnitude, Text.matches for a text's language or a parse's form (parseRemedy). A contract proves its predicate of an operand by
 * its bounds, which Num.within narrows over a number and no scalar test over a text, a boolean, a uuid or a date,
 * so over those only a value of the contract's type proves it. A fact the contract of an operand that has its type's
 * facts implies without declaring it is remedied by the declaration (undeclaredBy), since a contract's facts are
 * exactly the ones it declares; an operation's result has none of them, so no declaration remedies it.
 */
const guardTest = (
	precondition: Precondition,
	operand: Typed,
	target: ScalarType,
	patterns: PatternAutomata
): GuardTest => {
	switch (precondition.kind) {
		case "nonzero":
		case "nonnegative":
		case "finite": {
			const contract = hasTypeFacts(operand.node)
				? undeclaredBy(operand.nominal, precondition.kind)
				: undefined
			return contract === undefined
				? factTests[precondition.kind]
				: { kind: "proves", contract: contract.name }
		}
		case "fits":
		case "powerRange":
		case "bucketDomain":
		case "clock":
			return { kind: "within" }
		case "integral":
			return { kind: "integral" }
		case "powerDomain":
			return { kind: "positive" }
		case "contract":
			return withinGuards(valueType(operand.nominal).carrier)
				? { kind: "within" }
				: { kind: "typed" }
		case "language":
			return languageRemedy(operand, target, patterns)
		case "lexical":
			return lexicalRemedy(precondition.form, operand, target, patterns)
		case "bounded":
			return { kind: "octets", bytes: regexTextMaxBytes }
	}
}

/**
 * The remedy of a cast into a regex-refined text whose operand's language is not proved inside the target's: where the
 * operand's bytes are within the target's str.bytes bound, or it has none, its pattern is the shortfall, which
 * Text.matches of the target's pattern remedies. Where its bytes are the shortfall, a bound on them at the target's
 * bound, Num.within(Text.octetLength(x), 0, bytes), remedies it once its pattern lies inside the target's, and
 * the match first where it does not, in a query as in a check.
 */
const languageRemedy = (
	operand: Typed,
	target: ScalarType,
	patterns: PatternAutomata
): GuardTest => {
	const refinement = refinementOf(target)
	const octets = refinement === undefined ? undefined : octetsOf(refinement.check)
	const text = textOf(operand.nominal)
	if (refinement === undefined || octets === undefined || text === undefined) {
		return { kind: "matches", pattern: "target" }
	}
	const bytes = textInfoBounds(text)?.bytes
	if (bytes !== undefined && bytes <= octets) {
		return { kind: "matches", pattern: "target" }
	}
	return patternIncludes(textPatterns(text), refinement.patterns, patterns).kind === "included"
		? { kind: "octets", bytes: octets }
		: { kind: "matches", pattern: "target" }
}

/** The scalar test that proves each fact of its subject. */
const factTests: { readonly [F in Fact]: GuardTest } = {
	nonzero: { kind: "nonzero" },
	nonnegative: { kind: "nonnegative" },
	finite: { kind: "isFinite" }
}

/**
 * Whether a node's values have every fact its type states (factsOfType): a column, a parameter, the contract's VALUE, a
 * literal, a cast into the type and a variant's operation, whose arm field is its attribute's, typed by the field's own
 * type, do; an operation's result, a conditional's and a closed read's have their SQL type's alone (settle).
 */
const hasTypeFacts = (node: TypedNode): boolean => {
	switch (
		node.kind === "extension" ? "op" : node.kind === "built" ? node.expr.kind : node.spec.kind
	) {
		case "column":
		case "param":
		case "value":
		case "literal":
		case "cast":
		case "domainCast":
		case "variant":
			return true
		case "op":
		case "cond":
		case "closedAt":
		case "closedRow":
		case "closedHas":
		case "call":
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
 * The remedy a refusal of `precondition` names: its guard test, and the Logic.when to write over `operand` around
 * `operation`, or the fact to add to a contract's `proves`.
 */
const guardOf = (
	precondition: PreconditionKind,
	remedy: GuardTest,
	operand: string,
	operation: string
): Guard => {
	const when = (check: string): string =>
		`Logic.when(${check}, (${operand}) => ${operation}, <your value>)`
	switch (remedy.kind) {
		case "proves":
			return {
				remedy,
				text: `contract ${remedy.contract}'s predicate implies it, and a contract's facts are the ones it declares: contract("${remedy.contract}", <base>, <predicate>, { proves: [..., "${precondition}"] })`
			}
		case "nonzero":
			return { remedy, text: when(`Num.nonzero(${operand})`) }
		case "nonnegative":
			return { remedy, text: when(`Num.nonnegative(${operand})`) }
		case "positive":
			return { remedy, text: when(`Num.positive(${operand})`) }
		case "isFinite":
			return { remedy, text: when(`Num.isFinite(${operand})`) }
		case "within":
			return {
				remedy,
				text: `${when(`Num.within(${operand}, <low>, <high>)`)}, its bounds within which the operation is defined`
			}
		case "matches":
			switch (remedy.pattern) {
				case "target":
					return {
						remedy,
						text: `a text whose type's pattern lies inside the target's, or ${when(`Text.matches(${operand}, <the target's pattern>)`)}`
					}
				case "lexicalForm":
					return {
						remedy,
						text: `a text whose type proves the target's lexical form, str.regex(lexicalForm(<target>).source) or a refinement of it, or ${when(`Text.matches(${operand}, lexicalForm(<target>))`)}`
					}
				case "doubleText":
					return {
						remedy,
						text: `a text whose type proves a double's decimal text, str.regex(doubleText.source) or a refinement of it, or ${when(`Text.matches(${operand}, doubleText)`)}`
					}
				case "decimalText": {
					const bytes = decimalTextMaxBytes
					const within = `Logic.when(Num.within(Text.octetLength(${operand}), 0, ${bytes}), () => ${operation}, <your value>)`
					return {
						remedy,
						text: `a text whose type proves a decimal text of at most ${bytes} bytes, str.bytes(${bytes}, str.regex(decimalText.source)) or a refinement of it, or, where octetLength stands, Logic.when(Text.matches(${operand}, decimalText), (${operand}) => ${within}, <your value>)`
					}
				}
			}
		case "octets":
			return {
				remedy,
				text: `Logic.when(Num.within(Text.octetLength(${operand}), 0, ${remedy.bytes}), () => ${operation}, <your value>)`
			}
		case "integral":
			return {
				remedy,
				text: `a value whose type has no fraction digits (an integer, numeric(p, 0) or an exact integer), or the text ${operand} was parsed from cast into the target itself, Logic.when(Text.matches(<text>, lexicalForm(<target>)), (t) => Type.cast(t, <target>), <your value>): no guard bounds ${operand}'s fraction digits, and nothing rounds into the target`
			}
		case "typed":
			return {
				remedy,
				text: `a value of the target's type, a parameter its binding checks or a literal its admission judges: no scalar test over ${operand}'s type proves the target's contract`
			}
	}
}

/**
 * The lowering of a typed term where it is compiled: its tape's entries taken in order (typing.ts TapeEntry), each node
 * judged then emitted, each refusal of the site and each judgement every compiled site makes, made where it stands.
 * What a node is, its types, its bounds and facts, its overload and its conversions, is its typing's; the lowering adds
 * only what the site and judgement decide: a partial operation's proof, a native proof, a literal's ContractLiteral
 * check, a pattern's admission, and the refusals of what the site cannot hold.
 */
class Lowering<R extends Refs> {
	readonly env: LowerEnv<R>
	/** The expression each node of the tape emitted, recorded before every node that reads it. */
	readonly #emitted = new Map<TypedNode, ScalarExpr>()

	constructor(env: LowerEnv<R>) {
		this.env = env
	}

	/** The expression a node stands for: a built one's own, a recorded one's emission. */
	exprOf(node: TypedNode): ScalarExpr {
		return node.kind === "built"
			? node.expr
			: defined(this.#emitted.get(node), "a node the tape recorded before the nodes that read it")
	}

	/** The lowered term a typed one is, its expression its node's emission. */
	lowered(typed: Typed): Lowered {
		return new Lowered(
			this.exprOf(typed.node),
			typed.nominal,
			typed.actual,
			typed.bounds,
			typed.facts
		)
	}

	/** Takes each entry of a tape, in its order: the one order the lowering emits and judges a term in. */
	replay(tape: ReadonlyArray<TapeEntry<R>>): void {
		for (const entry of tape) {
			switch (entry.kind) {
				case "node":
					this.#emitted.set(entry.node, this.node(entry.node))
					break
				case "extension":
					this.#emitted.set(entry.node, this.extension(entry).expr)
					break
				case "refused":
					if (this.env.mode === entry.site) {
						stop("UnsupportedOperation", entry.at, entry.capability)
					}
					break
				case "digits":
					throw new Refusal(
						CompileError.make({
							_tag: "ResourceBound",
							at: entry.at,
							bound: {
								kind: "numericDigits",
								limit: numericMaxIntegerDigits,
								needed: entry.needed
							}
						})
					)
				case "admits": {
					const judged = admitLiteral(
						entry.value,
						entry.type,
						{ kind: "refinements", patterns: this.env.patterns },
						"stored"
					)
					if (!judged.ok) {
						stop(judged.error.reason, entry.at, judged.error.capability)
					}
					break
				}
			}
		}
	}

	/** The expression of `spec`, recorded over its arguments' expressions. */
	emit(spec: TypedSpec): ScalarExpr {
		return this.env.emit(withArgs<TypedArgs, LiveArgs>(spec, (n) => this.exprOf(n)))
	}

	/** A recorded node, judged as its kind states, then emitted. */
	node(node: RecordedNode): ScalarExpr {
		switch (node.kind) {
			case "stated":
				return this.emit(node.spec)
			case "literal": {
				const admitted = refined(node.spec.value, node.refinements, this.env.patterns)
				if (!admitted.ok) {
					return stop(admitted.error.reason, node.at, admitted.error.capability)
				}
				return this.emit(node.spec)
			}
			case "native": {
				const native = nativeProof(node.ieee, node.carrier, node.from, node.operands)
				return this.emit(native === undefined ? node.spec : { ...node.spec, native })
			}
			case "proved": {
				const obligation = node.proof
				const proof =
					obligation.kind === "computed"
						? computedCastProof(obligation.preconditions, obligation.operand, obligation.target)
						: this.proveAll(
								obligation.preconditions,
								obligation.operands,
								obligation.target,
								obligation.at,
								obligation.operation
							)
				return this.emit({ ...node.spec, proof })
			}
			case "domainCast":
				return this.emit({ ...node.spec, proof: this.domainProof(node) })
			case "matches": {
				const patterns = this.patternTable(node.pattern, node.patternAt)
				this.regexReadable(spelling.matches, node.subject, node.at)
				return this.emit({ ...node.spec, patterns })
			}
		}
	}

	/**
	 * A predicate another package lowers, in a query, which lowers each child it reads: typed under the Logic.whens
	 * the predicate stands in, then lowered here. A check refuses it.
	 */
	extension(entry: Extract<TapeEntry<R>, { readonly kind: "extension" }>): Lowered {
		const env = this.env
		if (env.mode !== "query") {
			return stop(
				"UnsupportedOperation",
				entry.at,
				`${entry.desc.kind}: lowered by its own package, not the scalar catalogue`
			)
		}
		const at = childLoc(entry.at, entry.desc.kind)
		return unwrap(
			env.extension(entry.desc, entry.at, (child) =>
				catchRefusal(() => {
					const typed = unwrap(typeWithin(child, typingEnvOf(env), entry.scope, at))
					this.replay(typed.tape)
					return this.lowered(typed.root)
				})
			)
		)
	}

	/**
	 * The proof of a domain cast's coercion into its target's contract or regex refinement, which PostgreSQL validates:
	 * a literal judged before any SQL (ContractLiteral), a parameter PostgreSQL checks as it binds it
	 * (lower/conservative/context.ts paramTypeRef), or a value whose bounds satisfy each contract level's predicate;
	 * else PartialOperation.
	 */
	domainProof(node: Extract<TypedNode, { readonly kind: "domainCast" }>): OperationProof {
		const { value, target: to, checked, at } = node
		const precondition: Precondition =
			refinementOf(to) === undefined ? { kind: "contract" } : { kind: "language" }
		return [
			checked === undefined || !this.checkedAgainst(value, to, checked, at)
				? this.prove(precondition, [value], to, at, castSpelling(nodeText(value.node), to))
				: {
						precondition,
						premises: [{ kind: "checked", operand: 0, by: checked }]
					}
		]
	}

	/**
	 * Whether a literal's or a parameter's check covers `to`'s refinements: its own type carries them, which its
	 * admission judged (a literal adopting a contract, ContractLiteral) or its binding checks (a parameter of its declared
	 * type); or, a literal, it is judged against them here, a violation ContractLiteral. Undecided, the cast is proved as
	 * any value's is.
	 */
	checkedAgainst(
		value: Typed,
		to: ScalarType,
		checked: "literal" | "parameter",
		at: SourceLoc
	): boolean {
		if (sameRefinement(value.nominal, to)) {
			return true
		}
		const literal = nodeLiteral(value.node)
		if (checked !== "literal" || literal === undefined) {
			return false
		}
		const member = literalMember(literal, to, this.env.patterns)
		if (member === false) {
			return stop(
				"ContractLiteral",
				at,
				`a literal of ${typeLabel(to)}: the literal violates its ${to.contract === undefined ? "regex refinement" : "contract"}`
			)
		}
		return member === true
	}

	/**
	 * One proof of a partial operation's preconditions over `args`, whose premises establish them all, or the
	 * PartialOperation refusal of the first one nothing proves.
	 */
	proveAll(
		preconditions: NonEmptyReadonlyArray<Precondition>,
		args: ReadonlyArray<Typed>,
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
		args: ReadonlyArray<Typed>,
		target: ScalarType,
		at: SourceLoc,
		operation: string
	): PreconditionProof {
		const refuse = (operand: number): never => {
			const named = defined(args[operand], "the operand a precondition names")
			const text = nodeText(named.node)
			throw new Refusal(
				CompileError.make({
					_tag: "PartialOperation",
					at,
					operation,
					precondition: precondition.kind,
					operand: text,
					guard: guardOf(
						precondition.kind,
						guardTest(precondition, named, target, this.env.patterns),
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
			case "integral": {
				const a = args[precondition.operand]
				return a?.bounds === undefined || a.bounds.scale > 0
					? refuse(precondition.operand)
					: {
							precondition,
							premises: [{ kind: "scale", operand: precondition.operand, scale: a.bounds.scale }]
						}
			}
			case "fits": {
				const a = args[0]
				const interval = a?.bounds === undefined ? undefined : intervalPremise(0, a.bounds)
				if (interval === undefined || !fitsTarget(target, interval)) {
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
								languageOf(refinement),
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
			case "clock": {
				const a = args[0]
				const interval = a?.bounds === undefined ? undefined : intervalPremise(0, a.bounds)
				return interval === undefined || !withinClock(interval)
					? refuse(0)
					: { precondition, premises: [interval] }
			}
		}
	}

	/**
	 * In a query, the refusal of a regex read, `~`, over a text whose bytes are not proved within regexTextMaxBytes
	 * (typing.ts textBytes, the one proof every mode reads: its type's byte bound, or the enclosing Logic.when that
	 * bounds Text.octetLength of it): PostgreSQL's regex engine widens its subject to four bytes for every byte before
	 * it matches and refuses an allocation past 1 GB, and a read never fails on a value. A check or a generated field
	 * reads any text, and its write fails on a longer one.
	 */
	regexReadable(what: string, subject: Typed, at: SourceLoc): void {
		const bytes = textBytes(subject)
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
	 * (readAdmissions), read in the order the pattern states them, so a refusal names the first refused value it states.
	 */
	patternTable(reads: ReadonlyArray<PatternRead>, at: SourceLoc): PatternTable {
		const admitted = reads.flatMap((read) => this.readAdmissions(read))
		if (!isNonEmpty(admitted)) {
			return stop(
				"UnsupportedOperation",
				at,
				"a pattern of at least one value: the closed relation it reads holds no row, so the match could never be stated"
			)
		}
		return patternTableOf(mapNonEmpty(admitted, (a) => unwrap(matchValueAt(a, at))))
	}

	/**
	 * The values one part of a matches pattern can take: a literal's source, which its typing admitted; each value of a
	 * closed relation's text payload field that C.at reads, whatever its key, as the lowering batch admitted it
	 * (ClosedRelations.admitted). Any other part, a field, a parameter or a computed text, can be any text, so no measure
	 * bounds it, and it is refused, naming what it is.
	 */
	readAdmissions(read: PatternRead): ReadonlyArray<MatchAdmission> {
		switch (read.kind) {
			case "admitted":
				return [{ kind: "admitted", source: read.value.spelling, value: read.value }]
			case "closedAt":
				return this.payloadAdmissions(read.relation, read.field, read.at)
			case "other":
				return stop(
					"UnsupportedOperation",
					read.at,
					`a pattern whose every value is seen when the schema compiles: matches's pattern is a text literal, a closed relation's str.pattern payload (C.at) or a Logic.cond of them, each value admitted inside PostgreSQL's regex compile space; a ${read.what} can be any text, so no measure bounds it`
				)
		}
	}

	/**
	 * The admitted values of the str.pattern payload field `field` of the closed relation `relation`, which C.at reads as
	 * a matches pattern: each admitted once, where the schema's closed relations are read (check/closed.ts closedReads).
	 */
	payloadAdmissions(relation: string, field: string, at: SourceLoc): ReadonlyArray<MatchAdmission> {
		const { closed } = this.env
		const heading = closedHeadingOf(closed, "C.at", relation, at)
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
				`a str.pattern payload as matches's pattern, whose values the schema admits as patterns: ${relation}.${field} is ${typeLabel(payload.type)}`
			)
		}
		return payload.patterns.admitted
	}
}

/**
 * Whether every value an interval premise admits fits `target` once a cast rounds it: inside its range (fitRange), and
 * NaN among them only where the target holds NaN, which an integer numeric's, numeric(p, 0), does not (ir/carriers.ts
 * isIntegerTypmod); an integer's NaN is its cast's "finite" precondition.
 */
const fitsTarget = (target: ScalarType, interval: IntervalPremise): boolean => {
	const range = fitRange(target)
	return (
		range !== undefined &&
		insideRange(interval.low, interval.high, range[0], range[1]) &&
		!(interval.nan && integerTypmodOf(target) !== undefined)
	)
}

/**
 * The instants a millis reading of the database's clock can be, as a proved interval's ends (core/clock.ts
 * clockReadingRange): the operand Time.wall's `clock` precondition holds within.
 */
const clockRange: readonly [Exact, Exact] = [
	exactOf(clockReadingRange.millis.low, 0),
	exactOf(clockReadingRange.millis.high, 0)
]

/** Whether every value an interval premise admits is an instant of clockRange, NaN none of them. */
export const withinClock = (interval: IntervalPremise): boolean =>
	!interval.nan && insideRange(interval.low, interval.high, clockRange[0], clockRange[1])

/**
 * The range a value must lie in to fit `target`, a narrower integer, money, a typmod or an exact integer's digits
 * (|x| < 10^digits), once a cast rounds it, a cast into an exact integer rounding nothing (its `integral`); or a
 * date, the epoch days of the dates grizzle holds (ir/date.ts epochDayRange), the one integer a date is made of
 * (Time.dateOfEpochDay).
 */
export const fitRange = (target: ScalarType): readonly [Exact, Exact] | undefined => {
	const t = baseOf(target)
	switch (t.carrier) {
		case "date":
			return [exactOf(epochDayRange.low, 0), exactOf(epochDayRange.high, 0)]
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
		case "exactInteger": {
			const limit = minus(tenTo(t.digits), exactOf(1n, 0))
			return [negExact(limit), limit]
		}
		case "exactMoney":
		case "float4":
		case "float8":
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
		case "variant":
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
	base: Typed,
	exponent: Typed
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
	base: Typed,
	exponent: Typed,
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
 * (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/adt/numeric.c#L11074), or once a product's
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

/**
 * width_bucket's premises beyond its finite operands: its bounds' finite intervals disjoint, so the bounds differ, and
 * its count in 1..int4Max - 1, so its result count + 1 fits integer.
 */
const bucketPremises = (
	low: Typed,
	high: Typed,
	count: Typed
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

/**
 * The proof of a cast the lowering writes over a value it computed itself (CastHow computed), from that value's own
 * interval: the lowering writes one only where the interval proves it, so a value it does not prove is a defect.
 */
const computedCastProof = (
	preconditions: NonEmptyReadonlyArray<Precondition>,
	arg: Typed,
	to: ScalarType
): OperationProof => {
	const interval = arg.bounds === undefined ? undefined : intervalPremise(0, arg.bounds)
	const proof = interval === undefined ? undefined : intervalCastProof(preconditions, interval, to)
	if (proof === undefined) {
		defect(
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
			case "fits":
				return fitsTarget(to, interval) ? { precondition, premises: [interval] } : undefined
			case "integral":
			case "contract":
			case "language":
			case "powerDomain":
			case "powerRange":
			case "bucketDomain":
			case "lexical":
			case "bounded":
			case "clock":
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

/**
 * The lowering of a term its typing (typing.ts typeOf) gives: typed once, then its tape replayed where it is compiled
 * (Lowering), so a refusal of its typing is every site's and comes first, and every other is the site's or a
 * judgement's, made where the tape records it.
 */
const lowered = <R extends Refs>(
	env: LowerEnv<R>,
	typing: (env: TypingEnv<R>) => Result.Result<TermTyping<R>, CompileError>
): Result.Result<Lowered, CompileError> =>
	Result.flatMap(typing(typingEnvOf(env)), (typed) =>
		catchRefusal(() => {
			const lowering = new Lowering(env)
			lowering.replay(typed.tape)
			return lowering.lowered(typed.root)
		})
	)

/**
 * Lowering of scalar expression descriptions to the scalar IR, total by construction: a description typed once, site
 * free (typing.ts typeOf), and emitted where it is compiled, each node with what the site and judgement decide of it.
 *
 * The caller supplies the sink the nodes go to (a DagBuilder's `expr`, or a contract predicate's table) and the leaves
 * (rule variables, a check's fields, a contract's VALUE, parameters), so the same lowering serves query filters and
 * outputs, contract predicates and row checks. One semantics, at every site: no node raises on a value its operands
 * admit (registry.ts Totality). Integer and money arithmetic is exact (an exact integer or exact money, its digits
 * bounded by its operands'); float arithmetic is IEEE 754; numeric arithmetic stays inside numeric's
 * numericMaxIntegerDigits by its operands' digit bounds (a numeric field's by its typmod, a computed numeric's by the
 * bound its type carries), past which an expression is ResourceBound, but over an operand bounded by nothing but that
 * limit, pg.numeric's, which PostgreSQL enforces with 22003 (scalar/values/fault.ts resultDigits); and a partial
 * operation (a divisor, a root, a
 * narrowing cast, a domain cast, power, width_bucket, min_scale) stands only with the proof of its precondition
 * (ir/proof.ts PreconditionProof): its operands' facts (a literal's value, a contract's declaration, a Logic.when
 * guard, the facts a term's TypeScript type states), or, for what rests on magnitudes no type states, the bound domain
 * (bounds.ts). Otherwise it is PartialOperation, naming the guard to write. A literal adopting a contract or a regex
 * refinement is checked against it here, the ContractLiteral check.
 *
 * The sites differ only in what they hold:
 * - "query": queries and scalar outputs, which lower the predicates of other packages and refuse a text function,
 *   a concatenation but in an equation, and a regex read or a translation of a text no pattern bounds within the bytes
 *   PostgreSQL allocates for.
 * - "check": contract predicates and row checks, which read only their VALUE or row and admit the operations the host
 *   evaluates for the ContractLiteral check (registry.ts computeSpecs, check); float arithmetic, whose IEEE rendering
 *   binds operands in a subquery, and money arithmetic, which reads money through its STABLE cast, are refused there,
 *   since a CHECK holds neither.
 *
 * Lowers a term: a scalar expression, a reference, or a typed literal.
 */
export const lowerTerm = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	env: LowerEnv<R>
): Result.Result<Lowered, CompileError> => lowered(env, (typing) => typeOf(desc, typing))

/**
 * Lowers a term a function returns unchanged, the argument of min or max: delivered with the contract the term has
 * (typing.ts typeReturned).
 */
export const lowerReturned = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	env: LowerEnv<R>
): Result.Result<Lowered, CompileError> => lowered(env, (typing) => typeReturned(desc, typing))

/** Lowers a predicate: a non-null SQL Boolean expression. */
export const lowerPredicate = <R extends Refs>(
	desc: ExprDesc<Located, R>,
	env: LowerEnv<R>
): Result.Result<Lowered, CompileError> => lowered(env, (typing) => typePredicate(desc, typing))

/** An expression another package built, lowered as it is: its type's bounds and facts, and nothing more. */
export const loweredOf = (e: ScalarExpr): Lowered =>
	new Lowered(e, e.type, e.type, boundsOfType(e.type), factsOfType(e.type))
