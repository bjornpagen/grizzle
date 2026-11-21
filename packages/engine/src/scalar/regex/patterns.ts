import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import type { CharSet } from "@bjornpagen/grizzle-text/regex/charset"
import { type DfaOutcome, minimalDfa } from "@bjornpagen/grizzle-text/regex/dfa"
import type { LiveNode, RegexNode } from "@bjornpagen/grizzle-text/regex/ir"
import { regexDfaLimits } from "@bjornpagen/grizzle-text/regex/limits"
import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa, type CountOp, type NfaEdge } from "@bjornpagen/grizzle-text/regex/nfa"
import {
	parsePattern,
	type PatternSource,
	type RegexFlags
} from "@bjornpagen/grizzle-text/regex/parse"
import { entry } from "@bjornpagen/grizzle-text/regex/table"
import type { ExprTable } from "#compiler/ir/expr.ts"
import { matchFlags } from "#compiler/ir/pattern.ts"
import { type RegexRef, regexRefOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	countCode,
	edgeCode,
	memberOf,
	type ServedMatcher,
	type ServedMatchers
} from "#compiler/scalar/regex/matcher.ts"

/**
 * An admitted pattern parsed: its node, which a translation's image reads, and the matcher of its automaton (match.ts
 * Matcher), whose NFA the language proofs read and whose search language membership runs, built once here. The node is
 * a refinement member's language, which has a member (text/refinement.ts analyzeText), or a Text.matches pattern's,
 * which may be the empty language (admit.ts admitMatch), whose matcher matches no text.
 */
export interface ParsedPattern {
	readonly node: RegexNode
	readonly matcher: Matcher
}

/**
 * The parse of a pattern its admission parsed already, the one site of the fact that such a pattern parses: a RegexRef
 * is minted only from a pattern its text analysis admitted (text/refinement.ts analyzeText), a lexical form is
 * grizzle's own (scalar/lexical.ts formSource), and a Text.matches pattern is admitted where its node is typed
 * (admit.ts matchPattern). It runs where a program compiles or a pattern is admitted, into a table (CompilePatterns,
 * ProgramPatterns), and never per membership: membership reads the table.
 */
const admittedParse = (pattern: PatternSource): ParsedPattern => {
	const parsed = parsePattern(pattern.source, pattern.flags)
	if (!parsed.ok) {
		throw defect(`a pattern its admission parsed: /${pattern.source}/${pattern.flags}`)
	}
	return { node: parsed.value, matcher: Matcher.of(buildNfa(parsed.value)) }
}

/**
 * The parse of a member of a text type's conjunction (ir/scalar.ts textPatterns), read from `patterns`: a language with
 * a member, since the text analysis admits a refinement's member only with one (text/refinement.ts analyzeText), where a
 * Text.matches pattern, which no image or alphabet of a refinement reads, may be the empty language.
 */
export const memberNode = (pattern: PatternSource, patterns: PatternAutomata): LiveNode => {
	const { node } = patterns.parse(pattern)
	if (node.kind === "never") {
		throw defect(`a refinement's member with a member: /${pattern.source}/${pattern.flags}`)
	}
	return node
}

/**
 * What the evaluator reads of admitted patterns, from the table its compile or its compiled program holds, never
 * parsing one per evaluation: a text's membership in a regex refinement and its match of a Text.matches pattern, each
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
	/** The parse of an admitted pattern: a refinement's member, a lexical form's, or a Text.matches pattern's. */
	readonly parse: (pattern: PatternSource) => ParsedPattern
	/**
	 * The canonical DFA of an admitted pattern's search language within the text analysis's bounds (dfa.ts minimalDfa
	 * of its matcher's automaton at regexDfaLimits), or its bound: what the inclusion and length proofs compare
	 * (scalar/regex/inclusion.ts), made the first time a proof reads it and read from the table after.
	 */
	readonly minimal: (pattern: PatternSource) => DfaOutcome
}

/** Parses, by flags and then source. */
type ParseTable = Map<RegexFlags, Map<string, ParsedPattern>>

const tabled = (table: ParseTable, pattern: PatternSource): ParsedPattern | undefined =>
	table.get(pattern.flags)?.get(pattern.source)

/** `pattern`'s parse, entered into `table`. */
const entered = (table: ParseTable, pattern: PatternSource): ParsedPattern => {
	const made = admittedParse(pattern)
	const bySource = table.getOrInsertComputed(pattern.flags, () => new Map<string, ParsedPattern>())
	bySource.set(pattern.source, made)
	return made
}

/**
 * Each parsed pattern's canonical DFA, made the first time a proof reads it: a table's own, beside its parses, so a
 * pattern compared many times is minimized once, where each comparison minimized it again.
 */
class Minimized {
	readonly #outcomes = new Map<ParsedPattern, DfaOutcome>()
	#made = 0

	/** How many patterns the table has minimized: the proofs' determinizations and minimizations. */
	get made(): number {
		return this.#made
	}

	of(parsed: ParsedPattern): DfaOutcome {
		const known = this.#outcomes.get(parsed)
		if (known !== undefined) {
			return known
		}
		const outcome = minimalDfa(parsed.matcher.nfa, regexDfaLimits)
		this.#made += 1
		this.#outcomes.set(parsed, outcome)
		return outcome
	}
}

/**
 * The patterns one compile meets, each parsed the first time it is met and minimized the first time a proof compares
 * it, and read from the table after: a compile's own explicit state, created where the compile begins and passed to
 * what it compiles, so a compile parses and minimizes each distinct pattern once.
 */
export class CompilePatterns implements PatternAutomata {
	readonly #table: ParseTable = new Map()
	readonly #minimized = new Minimized()

	readonly parse = (pattern: PatternSource): ParsedPattern =>
		tabled(this.#table, pattern) ?? entered(this.#table, pattern)

	readonly minimal = (pattern: PatternSource): DfaOutcome => this.#minimized.of(this.parse(pattern))

	/** How many patterns the compile has minimized (Minimized): one for each distinct pattern a proof compared. */
	get minimized(): number {
		return this.#minimized.made
	}

	readonly member = (regex: RegexRef, text: string): boolean =>
		memberOf(regex, (pattern) => this.parse(pattern).matcher, text)

	readonly matches = (source: string, text: string): boolean =>
		this.parse({ source, flags: matchFlags }).matcher.matches(text)
}

/**
 * The patterns a compiled program checks, every one parsed when the program compiles and none after: the host's fill
 * and check paths read them per row. A pattern outside the table is a defect of the collection that built it
 * (typePatterns, tablePatterns), which reads every pattern the program's types and expressions hold.
 */
export class ProgramPatterns implements PatternAutomata {
	readonly #table: ParseTable
	readonly #minimized = new Minimized()

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

	readonly minimal = (pattern: PatternSource): DfaOutcome => this.#minimized.of(this.parse(pattern))

	readonly member = (regex: RegexRef, text: string): boolean =>
		memberOf(regex, (pattern) => this.parse(pattern).matcher, text)

	readonly matches = (source: string, text: string): boolean =>
		this.parse({ source, flags: matchFlags }).matcher.matches(text)

	/**
	 * Each pattern of the table with its automaton, in the order the table first met them, over one table of the char
	 * sets their edges step on: what a served file carries of the patterns its types read, so its load builds every
	 * matcher without the parser (matcher.ts ServedPatterns).
	 */
	served(): ServedMatchers {
		const sets = new SetTable()
		const matchers = [...this.#table].flatMap(([flags, bySource]) =>
			[...bySource].map(([source, { matcher }]): ServedMatcher => ({
				pattern: { source, flags },
				start: matcher.nfa.start,
				accept: matcher.nfa.accept,
				edges: matcher.nfa.edges.map((out) =>
					out.flatMap((e) => [...e.counts.flatMap(countCodes), sets.codeOf(e), e.to])
				),
				repeats: matcher.nfa.repeats.map(
					(r) => [r.least, r.copies, r.loops ? 1 : 0, r.consuming ? 1 : 0] as const
				)
			}))
		)
		return { sets: sets.sets, matchers }
	}
}

/** A counter operation as a served automaton writes it, its code and its repetition (matcher.ts countCode). */
const countCodes = (op: CountOp): readonly [number, number] => {
	switch (op.kind) {
		case "consumed":
			return [countCode.consumed - op.below, op.repeat]
		case "enter":
		case "again":
		case "counted":
		case "loop":
		case "leave":
			return [countCode[op.kind], op.repeat]
	}
}

/** Whether two char sets are one: a set's interval list is its canonical form (charset.ts CharSet). */
const sameSet = (a: CharSet, b: CharSet): boolean =>
	a.length === b.length &&
	a.every(([lo, hi], i) => {
		const [otherLo, otherHi] = entry(b, i)
		return otherLo === lo && otherHi === hi
	})

/**
 * The char sets a served file's automata step on, each once, in the order their edges first met them, and the code of
 * an edge over them (matcher.ts edgeCode): sets are found among those of their interval count, then compared whole.
 */
class SetTable {
	readonly sets: Array<CharSet> = []
	readonly #byLength = new Map<number, Array<number>>()

	codeOf(e: NfaEdge): number {
		switch (e.kind) {
			case "start":
				return edgeCode.start
			case "end":
				return edgeCode.end
			case "eps":
				return edgeCode.eps
			case "set":
				return edgeCode.set + this.#indexOf(e.set)
		}
	}

	#indexOf(set: CharSet): number {
		const candidates = this.#byLength.getOrInsertComputed(set.length, () => [])
		for (const at of candidates) {
			if (sameSet(entry(this.sets, at), set)) {
				return at
			}
		}
		const at = this.sets.length
		this.sets.push(set)
		candidates.push(at)
		return at
	}
}

/**
 * Every admitted pattern a value of `t` is checked against: each contract level's base refinement's members and the
 * patterns its predicate reads, every level down to the base.
 */
export const typePatterns = (t: ScalarType): ReadonlyArray<PatternSource> => {
	const own = regexRefOf(t)?.patterns ?? []
	const { contract } = t
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
			? e.patterns.map((p) => ({ source: p.spelling, flags: matchFlags }))
			: [])
	])
