import { defect } from "#compiler/core/invariant.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import type { ExprTable } from "#compiler/ir/expr.ts"
import {
	contractOf,
	octetsOf,
	type PatternSource,
	type RegexRef,
	type ScalarType,
	textOf
} from "#compiler/ir/scalar.ts"
import { matchFlags } from "#compiler/scalar/regex/admit.ts"
import type { LiveNode } from "#compiler/scalar/regex/ir.ts"
import { buildNfa, matches, type Nfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern, type RegexFlags } from "#compiler/scalar/regex/parse.ts"

/** An admitted pattern parsed: its live node, which a translation's image reads, and its automaton. */
export interface ParsedPattern {
	readonly node: LiveNode
	readonly nfa: Nfa
}

/**
 * The parse of a pattern its admission parsed already, the one site of the fact that such a pattern parses to a live
 * node: a RegexRef is minted only from a pattern its text analysis admitted with a member (text/refinement.ts
 * analyzeText), a lexical form is grizzle's own (scalar/lexical.ts formSource), and a Compute.matches pattern is
 * admitted where its node is typed (admit.ts matchPattern). It runs where a program compiles or a pattern is admitted,
 * into a table (CompilePatterns, ProgramPatterns), and never per membership: membership reads the table.
 */
const admittedParse = (pattern: PatternSource): ParsedPattern => {
	const parsed = parsePattern(pattern.source, pattern.flags)
	if (!parsed.ok || parsed.value.kind === "never") {
		throw defect(
			`a pattern its admission parsed, with a member: /${pattern.source}/${pattern.flags}`
		)
	}
	return { node: parsed.value, nfa: buildNfa(parsed.value) }
}

/**
 * What the evaluator reads of admitted patterns, from the table its compile or its compiled program holds, never
 * parsing one per evaluation: a text's membership in a regex refinement and its match of a Compute.matches pattern, each
 * by the pattern's automaton, never RegExp.
 */
export interface PatternReads {
	readonly member: (regex: RegexRef, text: string) => boolean
	readonly matches: (source: string, text: string) => boolean
}

/**
 * What membership, inclusion and translation read of admitted patterns: each one's parse, from a table a compile or a
 * compiled program holds, so none is parsed per membership.
 */
export interface PatternAutomata extends PatternReads {
	/** The parse of an admitted pattern: a refinement's member, a lexical form's, or a Compute.matches pattern's. */
	readonly parse: (pattern: PatternSource) => ParsedPattern
}

/**
 * Whether a text is a member of a regex refinement, each of its patterns parsed by `parse`: within its byte bound where
 * str.bytes cuts it (ir/scalar.ts octetsOf), and a match of every member's automaton.
 */
const memberOf = (
	regex: RegexRef,
	parse: (pattern: PatternSource) => ParsedPattern,
	text: string
): boolean => {
	const octets = octetsOf(regex.check)
	return (
		(octets === undefined || utf8Length(text) <= octets) &&
		regex.patterns.every((pattern) => matches(parse(pattern).nfa, text))
	)
}

/** Parses, by flags and then source. */
type ParseTable = Map<RegexFlags, Map<string, ParsedPattern>>

const tabled = (table: ParseTable, pattern: PatternSource): ParsedPattern | undefined =>
	table.get(pattern.flags)?.get(pattern.source)

/** `pattern`'s parse, entered into `table`. */
const entered = (table: ParseTable, pattern: PatternSource): ParsedPattern => {
	const made = admittedParse(pattern)
	const bySource = table.get(pattern.flags) ?? new Map<string, ParsedPattern>()
	table.set(pattern.flags, bySource)
	bySource.set(pattern.source, made)
	return made
}

/**
 * The patterns one compile meets, each parsed the first time it is met and read from the table after: a compile's own
 * explicit state, created where the compile begins and passed to what it compiles, so a compile parses each distinct
 * pattern once.
 */
export class CompilePatterns implements PatternAutomata {
	readonly #table: ParseTable = new Map()

	readonly parse = (pattern: PatternSource): ParsedPattern =>
		tabled(this.#table, pattern) ?? entered(this.#table, pattern)

	readonly member = (regex: RegexRef, text: string): boolean => memberOf(regex, this.parse, text)

	readonly matches = (source: string, text: string): boolean =>
		matches(this.parse({ source, flags: matchFlags }).nfa, text)
}

/**
 * The patterns a compiled program checks, every one parsed when the program compiles and none after: the host's fill
 * and check paths read them per row. A pattern outside the table is a defect of the collection that built it
 * (typePatterns, tablePatterns), which reads every pattern the program's types and expressions hold.
 */
export class ProgramPatterns implements PatternAutomata {
	readonly #table: ParseTable

	private constructor(table: ParseTable) {
		this.#table = table
	}

	/** The table of `patterns`, each distinct one parsed once. */
	static of(patterns: Iterable<PatternSource>): ProgramPatterns {
		const table: ParseTable = new Map()
		for (const pattern of patterns) {
			if (tabled(table, pattern) === undefined) {
				entered(table, pattern)
			}
		}
		return new ProgramPatterns(table)
	}

	readonly parse = (pattern: PatternSource): ParsedPattern => {
		const known = tabled(this.#table, pattern)
		if (known === undefined) {
			throw defect(`a pattern its program's types hold: /${pattern.source}/${pattern.flags}`)
		}
		return known
	}

	readonly member = (regex: RegexRef, text: string): boolean => memberOf(regex, this.parse, text)

	readonly matches = (source: string, text: string): boolean =>
		matches(this.parse({ source, flags: matchFlags }).nfa, text)
}

/**
 * Every admitted pattern a value of `t` is checked against: each contract level's base refinement's members and the
 * patterns its predicate reads, every level down to the base.
 */
export const typePatterns = (t: ScalarType): ReadonlyArray<PatternSource> => {
	const regex = textOf(t)?.regex
	const own = regex === undefined || regex === "wildcard" ? [] : regex.patterns
	const contract = contractOf(t)
	return contract === undefined
		? own
		: [
				...own,
				...(contract.predicate === undefined ? [] : tablePatterns(contract.predicate)),
				...typePatterns(contract.base)
			]
}

/** Every admitted pattern an expression table's evaluation reads: its expressions' types', and its matches' values. */
export const tablePatterns = (table: ExprTable): ReadonlyArray<PatternSource> =>
	Object.values(table.exprs).flatMap((e) => [
		...typePatterns(e.type),
		...(e.kind === "op" && "patterns" in e
			? e.patterns.map((entry) => ({ source: entry.source, flags: matchFlags }))
			: [])
	])
