import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import { regexDfaMaxStates, regexDfaMaxWork } from "#compiler/core/limits.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { codePoints } from "#compiler/core/text.ts"
import {
	finiteCheck,
	languageKey,
	languageWithin,
	type PatternCheck,
	type PatternLanguage,
	type Patterns,
	patternsText,
	type RegexCheck,
	type RegexKey,
	regexCheck,
	type TextBounds,
	type TextInfo,
	textBounds,
	textInfoOf
} from "#compiler/ir/scalar.ts"
import { admitPattern } from "#compiler/scalar/regex/admit.ts"
import { toAre } from "#compiler/scalar/regex/are.ts"
import { utf8Width } from "#compiler/scalar/regex/charset.ts"
import {
	type CanonicalDfa,
	type DfaLimits,
	dfaKey,
	intersectionDfa,
	isUniversal,
	longest,
	membersWithin,
	minimalDfa
} from "#compiler/scalar/regex/dfa.ts"
import { canonicalText, type LiveNode, type RegexNode } from "#compiler/scalar/regex/ir.ts"
import type { Nfa } from "#compiler/scalar/regex/nfa.ts"
import type { RegexFlags } from "#compiler/scalar/regex/parse.ts"
import type { DescriptorLanguage, TextLookup } from "#compiler/scalar/registry.ts"
import type { CreateDomain, Expr } from "#compiler/sql/ast.ts"
import { and, binary, call, cUtf8Collation, le, lit, types } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { structuralBounds } from "#compiler/text/bounds.ts"

/**
 * The host's bounds on a pattern's subset construction (core/limits.ts regexDfaMaxStates, regexDfaMaxWork): past
 * either, the analysis knows the language by its structure alone.
 */
const dfaLimits: DfaLimits = Object.freeze({
	maxStates: regexDfaMaxStates.value,
	maxWork: regexDfaMaxWork.value
})

/**
 * How PostgreSQL enforces the refinement: no check for a tautology over admitted text, else its language's enforcement
 * (ir/scalar.ts PatternCheck), with the bounds it proves on every member.
 */
type TextCheck = { readonly kind: "tautology" } | PatternCheck

/** The check of patterns every admitted text matches: none, one frozen value for every such conjunction. */
const tautology: TextCheck = Object.freeze({ kind: "tautology" })

/**
 * A non-empty language as the analysis knows it: by its canonical automaton when the DFA bounds reach one, and
 * otherwise by its normalized IR alone, a conjunction's by its members' IRs.
 */
export type Known =
	| { readonly kind: "automaton"; readonly dfa: CanonicalDfa }
	| { readonly kind: "structure" }

/**
 * One pattern of a text's conjunction as the analysis knows it alone: its source and flags as declared, its normalized
 * IR with the flags folded in, a node of a language with a member, the ARE translation of the IR (the differential
 * tests run it for every pattern), and its language as the analysis knows it.
 */
export interface PatternAnalysis {
	readonly source: string
	readonly flags: RegexFlags
	readonly ir: LiveNode
	readonly are: string
	readonly known: Known
}

export interface TextRefinement {
	/** Each pattern of the conjunction, in declared order, analyzed alone. */
	readonly members: NonEmptyReadonlyArray<PatternAnalysis>
	/** The conjunction's language: its intersection's canonical automaton within the DFA bounds, else its structure. */
	readonly known: Known
	readonly check: TextCheck
	/**
	 * The canonical key of the conjunction's language: the canonical text of its intersection's minimal DFA ("dfa:...")
	 * when the bounded constructions succeed, otherwise the keys of the members that test anything (testing), joined by
	 * "&" in declared order, each its own minimal DFA's text or its normalized IR ("ir:..."). Equal keys recognize the
	 * same values; the converse holds for two "dfa:" keys.
	 */
	readonly key: string
	/** SHA-256 of the key, the language's identity (ir/scalar.ts languageKey). */
	readonly digest: RegexKey
}

/** The bounds a refinement proves on every member, where it proves them. */
export const refinementBounds = (refinement: TextRefinement): TextBounds | undefined =>
	refinement.check.kind === "tautology" ? undefined : refinement.check.bounds

const boundsOfMembers = (members: ReadonlyArray<string>): TextBounds => {
	let length = 0
	let bytes = 0
	for (const m of members) {
		const cps = codePoints(m)
		length = Math.max(length, cps.length)
		bytes = Math.max(
			bytes,
			cps.reduce((n, c) => n + utf8Width(c), 0)
		)
	}
	return textBounds(length, bytes)
}

/** A nontrivial check with the UTF-8 bytes its predicate prints in (predicateBytes). */
interface Measured {
	readonly check: PatternCheck
	readonly bytes: number
}

const measured = (check: PatternCheck): Measured => ({ check, bytes: predicateBytes(check) })

/**
 * The enforcement of a finite language whose predicate prints in fewer bytes, the IN list where the two print alike.
 * Both recognize exactly the language, so their printed size is all that tells them apart.
 */
const shorter = (inList: Measured, regex: Measured): Measured =>
	inList.bytes <= regex.bytes ? inList : regex

/** The bounds a pattern proves of its own language: its automaton's longest member, or its IR's structure's. */
const ownBounds = (pattern: PatternAnalysis): TextBounds | undefined => {
	switch (pattern.known.kind) {
		case "automaton":
			return longest(pattern.known.dfa)
		case "structure":
			return structuralBounds(pattern.ir)
	}
}

/** The tighter of two proved bounds, each holding every member of the intersection of their languages. */
const tighter = (a: TextBounds | undefined, b: TextBounds | undefined): TextBounds | undefined =>
	a === undefined
		? b
		: b === undefined
			? a
			: textBounds(Math.min(a.length, b.length), Math.min(a.bytes, b.bytes))

/**
 * The enforcement of a conjunction's language, from what it tests (`testing`) and its language as the analysis knows it:
 * a tautology where no member tests anything; else, from its intersection's automaton, whichever of two equivalent forms
 * prints shorter (shorter), the testing members' AREs with the automaton's bounds or, for a finite language,
 * `VALUE IN (...)` of its members; from its structure alone, the testing members' AREs with the tightest of their own
 * bounds.
 *
 * The regex is measured first, and the members are listed only while they could still print within its bytes: each
 * member's literal prints in at least memberBytes and the member's own UTF-8 bytes, so the IN list of members that
 * weigh more (membersWithin) is longer than the regex, and a large language with short patterns is never listed.
 */
const choose = (testing: ReadonlyArray<Testing>, known: Known): TextCheck => {
	if (!isNonEmpty(testing)) {
		return tautology
	}
	const ares = mapNonEmpty(testing, (t) => t.pattern.are)
	switch (known.kind) {
		case "automaton": {
			const { dfa } = known
			const regex = measured(regexCheck(ares, longest(dfa)))
			const members = membersWithin(dfa, memberBytes, regex.bytes)
			if (members === undefined || !isNonEmpty(members)) {
				return regex.check
			}
			const inList = measured(finiteCheck(members, boundsOfMembers(members)))
			return shorter(inList, regex).check
		}
		case "structure": {
			const [first, ...rest] = mapNonEmpty(testing, (t) => ownBounds(t.pattern))
			return regexCheck(ares, rest.reduce(tighter, first))
		}
	}
}

/** A pattern's own canonical key: its minimal DFA's canonical text, or its normalized IR above the DFA bound. */
const patternKey = (pattern: PatternAnalysis): string => {
	switch (pattern.known.kind) {
		case "automaton":
			return `dfa:${dfaKey(pattern.known.dfa)}`
		case "structure":
			return `ir:${canonicalText(pattern.ir)}`
	}
}

/** A member of a conjunction that tests something, with its own key (patternKey). */
interface Testing {
	readonly pattern: PatternAnalysis
	readonly key: string
}

/**
 * The canonical key of a conjunction's language (TextRefinement.key): its intersection's minimal DFA's canonical text,
 * or the testing members' own keys in order above the DFA bound, so one pattern's key is its own.
 */
const keyOf = (testing: ReadonlyArray<Testing>, known: Known): string => {
	switch (known.kind) {
		case "automaton":
			return `dfa:${dfaKey(known.dfa)}`
		case "structure":
			return testing.map((t) => t.key).join("&")
	}
}

/**
 * The members of a conjunction that test anything, in declared order: each but those the analysis proves every admitted
 * text matches, which add no test to the conjunction, and each of one language once (patternKey), which tests what its
 * first does. They are what the conjunction's check reads and what its key names above the DFA bound.
 */
const testingOf = (members: ReadonlyArray<PatternAnalysis>): ReadonlyArray<Testing> => {
	const seen = new Set<string>()
	return members.flatMap((pattern): ReadonlyArray<Testing> => {
		const key = patternKey(pattern)
		const tests =
			!(pattern.known.kind === "automaton" && isUniversal(pattern.known.dfa)) && !seen.has(key)
		seen.add(key)
		return tests ? [{ pattern, key }] : []
	})
}

/**
 * A pattern's language: empty (no admitted text value matches it), or not, as the analysis knows it.
 * A nonempty one holds its IR as a node of a language with a member.
 */
type Language =
	| { readonly kind: "empty" }
	| { readonly kind: "nonEmpty"; readonly ir: LiveNode; readonly known: Known }

/**
 * The language of a pattern's IR from its NFA: what analyzePattern classifies an admitted pattern by. It is empty
 * exactly when the IR is never, which the IR's constructors make it exactly when no admitted text value matches it
 * (ir.ts), so a live IR's language is non-empty whether or not the DFA bounds reach its automaton.
 */
export const languageOf = (ir: RegexNode, nfa: Nfa): Language => {
	if (ir.kind === "never") {
		return { kind: "empty" }
	}
	const outcome = minimalDfa(nfa, dfaLimits)
	switch (outcome.kind) {
		case "bounded":
			return { kind: "nonEmpty", ir, known: { kind: "structure" } }
		case "minimal":
			return { kind: "nonEmpty", ir, known: { kind: "automaton", dfa: outcome.dfa } }
	}
}

/**
 * One pattern analyzed alone: admitted as every pattern grizzle hands PostgreSQL is admitted (scalar/regex/admit.ts
 * admitPattern), its grammar with source-located diagnostics and PostgreSQL's regex compile space, a pattern past one of
 * its measures refused as ResourceBound; refused as UnsupportedOperation where no admitted text value matches it, its IR
 * never (languageOf), however large; else its IR, its ARE (scalar/regex/are.ts) and its language as the host's bounds
 * let the analysis know it. `loc` places a refusal; diagnostics point one level deeper, at the pattern offset of the
 * construct (`... .pattern[3]`).
 */
const analyzePattern = (
	source: string,
	flags: RegexFlags,
	loc: SourceLoc
): Result.Result<PatternAnalysis, CompileError> => {
	const admitted = admitPattern(source, flags, loc)
	if (!admitted.ok) {
		return admitted
	}
	const { ir, nfa } = admitted.value
	const language = languageOf(ir, nfa)
	if (language.kind === "empty") {
		return Result.err(
			unsupported(
				childLoc(loc, "pattern"),
				`/${source}/${flags} matches no admitted text value, so no fact could ever hold the field`
			)
		)
	}
	return Result.ok(
		Object.freeze({
			source,
			flags,
			ir: language.ir,
			are: toAre(language.ir),
			known: language.known
		})
	)
}

/** Each pattern analyzed alone (analyzePattern) in order, or the first one's refusal. */
const analyzeEach = (
	patterns: Patterns,
	loc: SourceLoc
): Result.Result<NonEmptyReadonlyArray<PatternAnalysis>, CompileError> => {
	const [first, ...rest] = patterns
	const head = analyzePattern(first.source, first.flags, loc)
	if (!head.ok) {
		return head
	}
	const tail: Array<PatternAnalysis> = []
	for (const pattern of rest) {
		const analyzed = analyzePattern(pattern.source, pattern.flags, loc)
		if (!analyzed.ok) {
			return analyzed
		}
		tail.push(analyzed.value)
	}
	return Result.ok([head.value, ...tail])
}

/**
 * The language of a conjunction of analyzed patterns: its intersection's canonical automaton where every member's
 * automaton is known and their product stays within the DFA bounds (scalar/regex/dfa.ts intersectionDfa), one member's
 * its own; else its members' structure.
 */
const conjunctionKnown = (members: NonEmptyReadonlyArray<PatternAnalysis>): Known => {
	const dfas = members.flatMap((pattern) =>
		pattern.known.kind === "automaton" ? [pattern.known.dfa] : []
	)
	const product =
		dfas.length === members.length && isNonEmpty(dfas)
			? intersectionDfa(dfas, dfaLimits)
			: undefined
	return product?.kind === "minimal"
		? { kind: "automaton", dfa: product.dfa }
		: { kind: "structure" }
}

/**
 * Text refinements: declared patterns, checked, analyzed and lowered.
 *
 * `analyzeText` is what schema compilation calls for every text descriptor, str.regex's one pattern or str.and's
 * conjunction. It analyzes each pattern alone (analyzePattern), so each is held to PostgreSQL's limits on its own, and
 * refuses, as UnsupportedOperation, a conjunction no admitted text value matches, which the intersection of the
 * members' automata proves within the DFA bounds; past them the conjunction is admitted, and PostgreSQL's CHECK refuses
 * every value of an empty one. Then it chooses the PostgreSQL enforcement:
 *
 * - a tautology over admitted text erases: no CHECK, no domain, the column is plain text;
 * - a proved finite language becomes `VALUE IN (...)`, which recognizes exactly the same values, where that predicate
 *   prints in no more bytes than the regexes' (choose);
 * - anything else is `VALUE ~ '<ARE>'` of each testing member's translated pattern (scalar/regex/are.ts), joined by
 *   AND.
 *
 * It also derives the canonical key that domain sharing uses (core/identity.ts textDomain), and the proved length and
 * byte bounds that the key representability check consumes. Nothing here validates application data.
 *
 * Checks, analyzes and lowers declared patterns, whose sources and flags the description's boundary admitted
 * (field.ts admitRegex, the description decoder). `loc` is the descriptor's source location, where every refusal is
 * placed; a pattern's diagnostic names it.
 */
export const analyzeText = (
	patterns: Patterns,
	loc: SourceLoc
): Result.Result<TextRefinement, CompileError> =>
	Result.flatMap(analyzeEach(patterns, loc), (members) => {
		const known = conjunctionKnown(members)
		if (known.kind === "automaton" && known.dfa.states.length === 0) {
			return Result.err(
				unsupported(
					childLoc(loc, "pattern"),
					`${patternsText(patterns)} match no admitted text value together, so no value is ever of their type`
				)
			)
		}
		const testing = testingOf(members)
		const key = keyOf(testing, known)
		return Result.ok(
			Object.freeze({
				members,
				known,
				check: choose(testing, known),
				key,
				digest: languageKey(key)
			})
		)
	})

/**
 * What a text descriptor carries of its analyzed patterns (ir/scalar.ts TextLanguage): a proved tautology admits every
 * value; any other conjunction carries its language's key and its enforcement, with the bounds that proves.
 */
const textLanguage = (refinement: TextRefinement): PatternLanguage => {
	const check = refinement.check
	return check.kind === "tautology"
		? Object.freeze({ kind: "every" })
		: Object.freeze({ kind: "refined", key: refinement.digest, check })
}

/**
 * The text metadata of the refinement's ScalarType (ir/scalar.ts textInfoOf): a proved tautology is the canonical
 * wildcard, which is unbounded; any other conjunction keeps its patterns as the declaration wrote them, with its
 * language's key, its enforcement and its proved bounds.
 */
export const textInfo = (refinement: TextRefinement): TextInfo =>
	textInfoOf(
		mapNonEmpty(refinement.members, (pattern) =>
			Object.freeze({ source: pattern.source, flags: pattern.flags })
		),
		textLanguage(refinement)
	)

/**
 * The analyzed language of a conjunction of patterns, a refusal located at the patterns: what a text descriptor is
 * admitted with (text/field.ts), and what a lowering types patterns it computes by (scalar/registry.ts TextLookup). Each
 * call analyzes: a descriptor carries its language from its admission on, so no later pass calls it for declared
 * patterns.
 */
export const textLookup: TextLookup = (patterns) =>
	Result.map(analyzeText(patterns, SourceLoc(patternsText(patterns), [])), textLanguage)

/**
 * The analyzed language of a conjunction of patterns cut to `octets` UTF-8 bytes (languageWithin), a refusal located at
 * the patterns: what a text descriptor of a byte bound is admitted with.
 */
export const textLookupWithin =
	(octets: number): DescriptorLanguage =>
	(patterns) =>
		Result.map(textLookup(patterns), (pattern) => languageWithin(pattern, octets))

/** A domain CHECK's VALUE. */
export const domainValue: Expr = Object.freeze({ kind: "domainValue" })

/** A member of `VALUE IN (...)`: the text literal its list holds. */
const memberLiteral = (member: string): Expr => lit.text(member, types.text)

/**
 * The fewest UTF-8 bytes a member adds to `VALUE IN (...)`, the empty text's literal: any member's literal is that one
 * with the member's UTF-8 bytes inside its quotes, and more where a quote is doubled.
 */
const memberBytes = utf8Length(printExpr(memberLiteral("")))

/**
 * The terms of a language's membership predicate over `value`, which AND joins: `value IN (...)` of its members, or
 * `value ~ '<ARE>'` of each ARE of its conjunction.
 */
const patternTerms = (check: PatternCheck, value: Expr): NonEmptyReadonlyArray<Expr> => {
	switch (check.kind) {
		case "finite":
			return [
				{
					kind: "inList",
					expr: value,
					list: mapNonEmpty(check.members, memberLiteral),
					not: false
				}
			]
		case "regex":
			return mapNonEmpty(check.ares, (are) => binary("~", value, lit.text(are, types.text)))
	}
}

/** A byte bound's test over `value`: `octet_length(value) <= octets`. */
const octetsTest = (octets: number, value: Expr): Expr =>
	le(call("octet_length", [value]), lit.int(octets, types.integer))

/**
 * The terms of the membership predicate over `value` (domainValue inside a domain CHECK), which AND joins, a contract's
 * among its predicate's: a language's (patternTerms), or a byte bound's test before them, so PostgreSQL's regex engine
 * never reads a value past the bound.
 */
export const membershipTerms = (check: RegexCheck, value: Expr): NonEmptyReadonlyArray<Expr> => {
	switch (check.kind) {
		case "finite":
		case "regex":
			return patternTerms(check, value)
		case "octets":
			return check.check === undefined
				? [octetsTest(check.octets, value)]
				: [octetsTest(check.octets, value), ...patternTerms(check.check, value)]
	}
}

/**
 * The membership predicate over `value` (domainValue inside a domain CHECK), without the wrapper the printer adds to
 * every CHECK: its terms (membershipTerms) joined by AND, one term alone.
 */
export const membership = (check: RegexCheck, value: Expr): Expr =>
	and(membershipTerms(check, value))

/**
 * The UTF-8 bytes a check's predicate over VALUE prints in, what choose compares two equivalent checks by. Every CHECK
 * prints its predicate in one place whatever its form, alone inside `CHECK (VALUE IS NULL OR (...) IS TRUE)` or as a
 * term of a contract's conjunction, so the predicates' bytes order the statements as the statements' own bytes do.
 */
const predicateBytes = (check: PatternCheck): number =>
	utf8Length(printExpr(and(patternTerms(check, domainValue))))

/**
 * The compiler-owned structural domain of a nontrivial refinement:
 * `CREATE DOMAIN <schema>.__text_<slug> AS text COLLATE pg_catalog.pg_c_utf8 CONSTRAINT __text_<slug>__check
 * CHECK (VALUE IS NULL OR (...) IS TRUE)`, with no NOT NULL.
 */
export const textDomainDdl = (
	check: RegexCheck,
	target: { readonly schema: string; readonly name: string; readonly constraint: string }
): CreateDomain => ({
	kind: "createDomain",
	name: { schema: target.schema, name: target.name },
	base: types.text,
	collation: cUtf8Collation,
	constraints: [{ name: target.constraint, predicate: membership(check, domainValue) }]
})
