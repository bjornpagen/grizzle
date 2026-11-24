import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import { utf8Width } from "@bjornpagen/grizzle-text/regex/charset"
import { type TextBounds, textBounds } from "@bjornpagen/grizzle-text/regex/dfa"
import {
	dfaKey,
	intersectionDfa,
	isUniversal,
	longest,
	membersWithin
} from "@bjornpagen/grizzle-text/regex/dfa"
import type { RegexNode } from "@bjornpagen/grizzle-text/regex/ir"
import { regexDfaLimits } from "@bjornpagen/grizzle-text/regex/limits"
import type { PatternSource, Patterns, RegexFlags } from "@bjornpagen/grizzle-text/regex/parse"
import { toAre } from "@bjornpagen/grizzle-text/regex/print"
import { codePoints } from "@bjornpagen/grizzle-text/text"
import { utf8Length } from "@bjornpagen/grizzle-text/utf8"
import { type CompileError, unsupported } from "#compiler/core/errors.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { type Known, knownOf, ownKey } from "#compiler/ir/pattern.ts"
import {
	finiteCheck,
	languageKey,
	type PatternCheck,
	type PatternLanguage,
	patternsText,
	type RegexCheck,
	type RegexKey,
	regexCheck
} from "#compiler/ir/scalar.ts"
import { refusalAt } from "#compiler/scalar/regex/admit.ts"
import { CompilePatterns, type PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import type { TextLookup } from "#compiler/scalar/registry.ts"
import type { Collation, Expr, TypeRef } from "#compiler/sql/ast.ts"
import { and, binary, call, cUtf8Collation, isIn, le, lit, types } from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { structuralBounds } from "#compiler/text/bounds.ts"

/**
 * How PostgreSQL enforces the refinement: no check for a tautology over admitted text, else its language's enforcement
 * (ir/scalar.ts PatternCheck), with the bounds it proves on every member.
 */
type TextCheck = { readonly kind: "tautology" } | PatternCheck

/** The check of patterns every admitted text matches: none, one frozen value for every such conjunction. */
const tautology: TextCheck = Object.freeze({ kind: "tautology" })

/**
 * One pattern of a text's conjunction as the analysis knows it alone: its source and flags as declared, its normalized
 * IR with the flags folded in, never for the empty language, which the conjunction's analysis refuses, the ARE translation of the IR (the differential
 * tests run it for every pattern), and its language as the analysis knows it.
 */
export interface PatternAnalysis {
	readonly source: string
	readonly flags: RegexFlags
	readonly ir: RegexNode
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

/** A member of a conjunction that tests something, with its own key (ir/pattern.ts ownKey). */
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
 * text matches, which add no test to the conjunction, and each of one language once (ir/pattern.ts ownKey), which tests what its
 * first does. They are what the conjunction's check reads and what its key names above the DFA bound.
 */
const testingOf = (members: ReadonlyArray<PatternAnalysis>): ReadonlyArray<Testing> => {
	const seen = new Set<string>()
	return members.flatMap((pattern): ReadonlyArray<Testing> => {
		const key = ownKey(pattern.ir, pattern.known)
		const tests =
			!(pattern.known.kind === "automaton" && isUniversal(pattern.known.dfa)) && !seen.has(key)
		seen.add(key)
		return tests ? [{ pattern, key }] : []
	})
}

/**
 * One pattern analyzed alone, read from `table`, the table of the compile it serves: admitted as every pattern grizzle
 * hands PostgreSQL is admitted (ir/pattern.ts admitParsed), its grammar with source-located diagnostics and
 * PostgreSQL's regex compile space, a pattern past one of its measures refused as ResourceBound (scalar/regex/admit.ts
 * refusalAt); else its IR, its ARE (scalar/regex/print.ts) and its language as the host's bounds let the analysis know
 * it (ir/pattern.ts knownOf, of the table's minimal DFA). The empty language is one as any other here; a conjunction of
 * it, alone or beside others, is refused as every conjunction no text matches is (analyzeText). `loc` places a refusal;
 * diagnostics point one level deeper, at the pattern offset of the construct (`... .pattern[3]`).
 */
const analyzePattern = (
	pattern: PatternSource,
	loc: SourceLoc,
	table: CompilePatterns
): Result.Result<PatternAnalysis, CompileError> => {
	const { source, flags } = pattern
	const admitted = table.admitted(pattern)
	if (!admitted.ok) {
		return Result.err(refusalAt(admitted.error, source, flags, loc))
	}
	const ir = admitted.value
	return Result.ok(
		Object.freeze({ source, flags, ir, are: toAre(ir), known: knownOf(table.minimal(pattern)) })
	)
}

/** Each pattern analyzed alone (analyzePattern) in order, or the first one's refusal. */
const analyzeEach = (
	patterns: Patterns,
	loc: SourceLoc,
	table: CompilePatterns
): Result.Result<NonEmptyReadonlyArray<PatternAnalysis>, CompileError> => {
	const [first, ...rest] = patterns
	const head = analyzePattern(first, loc, table)
	if (!head.ok) {
		return head
	}
	const tail: Array<PatternAnalysis> = []
	for (const pattern of rest) {
		const analyzed = analyzePattern(pattern, loc, table)
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
			? intersectionDfa(dfas, regexDfaLimits)
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
 * placed; a pattern's diagnostic names it. It reads each pattern from a table of its own (analyzeTextIn); a compile
 * analyzes in its own table (AnalyzedPatterns).
 */
export const analyzeText = (
	patterns: Patterns,
	loc: SourceLoc
): Result.Result<TextRefinement, CompileError> =>
	analyzeTextIn(patterns, loc, new CompilePatterns())

/** The text analysis of `patterns` (analyzeText), each pattern read from `table`. */
const analyzeTextIn = (
	patterns: Patterns,
	loc: SourceLoc,
	table: CompilePatterns
): Result.Result<TextRefinement, CompileError> =>
	Result.flatMap(analyzeEach(patterns, loc, table), (members) => {
		const known = conjunctionKnown(members)
		if (known.kind === "automaton" && known.dfa.states.length === 0) {
			return Result.err(
				unsupported(
					childLoc(loc, "pattern"),
					members.length === 1
						? `${patternsText(patterns)} matches no admitted text value, so no value is ever of its type`
						: `${patternsText(patterns)} match no admitted text value together, so no value is ever of their type`
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
export const textLanguage = (refinement: TextRefinement): PatternLanguage => {
	const check = refinement.check
	return check.kind === "tautology"
		? Object.freeze({ kind: "every" })
		: Object.freeze({ kind: "refined", key: refinement.digest, check })
}

/** The analyzed language of a conjunction of patterns read from `table`, a refusal located at the patterns. */
const languageIn = (
	patterns: Patterns,
	table: CompilePatterns
): Result.Result<PatternLanguage, CompileError> =>
	Result.map(analyzeTextIn(patterns, SourceLoc(patternsText(patterns), []), table), textLanguage)

/**
 * The analyzed language of a conjunction of patterns, a refusal located at the patterns, from a table of its own: what a
 * text descriptor is admitted with (text/field.ts). A descriptor carries its language from its admission on, so no
 * later pass analyzes declared patterns; a compile types the patterns it computes by its own table's languages
 * (AnalyzedPatterns).
 */
export const textLookup: TextLookup = (patterns) => languageIn(patterns, new CompilePatterns())

/**
 * The patterns one compile meets (scalar/regex/patterns.ts CompilePatterns) with the text analysis of each conjunction
 * of them the compile types (scalar/regex/patterns.ts PatternAutomata `language`), analyzed the first time it is read
 * over the table's own admissions and minimal DFAs and read from the table after: the language of a conjunction is its
 * patterns' alone, in their order, so a compile's every typing of a text of one conjunction, a Logic.when's match or a
 * byte guard over a text of its patterns, reads one analysis: O(c) analyses for the c distinct conjunctions a compile
 * types, where each of its typings analyzed every member again. Over edullm's QTI schema's laws (qti-pie 1bf7dcc's lawsOf) 90 typings of 15 conjunctions analyzed 173 members of
 * 9 patterns; with the compile's one table (scalar/regex/patterns.ts CompilePatterns) lawsOf's CPU went from 5,549 ms
 * to 5,215 ms median, eight interleaved runs on the loaded machine. The text analysis is a layer above the patterns, so
 * it is this module's to add to the compile's table.
 */
export class AnalyzedPatterns extends CompilePatterns implements PatternAutomata {
	/** Each conjunction's language, by its patterns' flags and sources in order. */
	readonly #languages = new TupleMap<
		ReadonlyArray<string>,
		Result.Result<PatternLanguage, CompileError>
	>()

	readonly language: TextLookup = (patterns) =>
		this.#languages.getOrInsertComputed(
			patterns.flatMap((p) => [p.flags, p.source]),
			() => languageIn(patterns, this)
		)
}

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
			return [isIn(value, mapNonEmpty(check.members, memberLiteral))]
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
 * The definition of the compiler-owned structural domain of a nontrivial refinement (physical/ddl/domains.ts
 * DomainDefinition), created as `CREATE DOMAIN <schema>.__text_<slug> AS text COLLATE pg_catalog.pg_c_utf8 CONSTRAINT __text_<slug>__check
 * CHECK (VALUE IS NULL OR (...) IS TRUE)`, with no NOT NULL: text in pg_c_utf8 under the pattern's membership.
 */
export const textDomainDefinition = (
	check: RegexCheck
): { readonly base: TypeRef; readonly collation: Collation; readonly check: Expr } => ({
	base: types.text,
	collation: cUtf8Collation,
	check: membership(check, domainValue)
})
