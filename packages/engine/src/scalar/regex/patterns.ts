import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { CharSet } from "@bjornpagen/grizzle-text/regex/charset"
import { type DfaOutcome, minimalDfa } from "@bjornpagen/grizzle-text/regex/dfa"
import type { LiveNode, RegexNode } from "@bjornpagen/grizzle-text/regex/ir"
import { regexDfaLimits } from "@bjornpagen/grizzle-text/regex/limits"
import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa, type CountOp, type Nfa, type NfaEdge } from "@bjornpagen/grizzle-text/regex/nfa"
import {
	parsePattern,
	type PatternSource,
	type RegexDiagnostic,
	type RegexFlags
} from "@bjornpagen/grizzle-text/regex/parse"
import { entry } from "@bjornpagen/grizzle-text/regex/table"
import type { ExprTable } from "#compiler/ir/expr.ts"
import {
	admitParsed,
	matchFlags,
	type PatternRefusal,
	type PatternValue,
	patternValueOf
} from "#compiler/ir/pattern.ts"
import { type RegexRef, regexRefOf, type ScalarType } from "#compiler/ir/scalar.ts"
import {
	countCode,
	edgeCode,
	memberOf,
	type ServedMatcher,
	type ServedMatchers
} from "#compiler/scalar/regex/matcher.ts"
import type { TextLookup } from "#compiler/scalar/registry.ts"

/**
 * An admitted pattern parsed: its node, which a translation's image reads, and the matcher of its automaton (match.ts
 * Matcher), whose NFA the language proofs read and whose search language membership runs. The node is a refinement
 * member's language, which has a member (text/refinement.ts analyzeText), or a Text.matches pattern's, which may be the
 * empty language (admit.ts admitMatch), whose matcher matches no text.
 */
export interface ParsedPattern {
	readonly node: RegexNode
	readonly matcher: Matcher
}

/**
 * One pattern as a table holds it (CompilePatterns), each part made the first time a reader reads it and read from the
 * entry after: its parse (parse.ts parsePattern), made where the table first meets the pattern; its admission over that
 * parse (ir/pattern.ts admitParsed); its NFA; its parse with its matcher (ParsedPattern); its canonical DFA within the
 * text analysis's bounds (dfa.ts minimalDfa at regexDfaLimits); and, of a Text.matches pattern, its pattern value
 * (ir/pattern.ts patternValueOf). So a table parses, builds the automaton of, determinizes and minimizes each pattern
 * once, whatever reads it: its admission, the text analysis, a proof or a membership.
 */
class PatternEntry {
	readonly #pattern: PatternSource
	readonly #parse: Result.Result<RegexNode, RegexDiagnostic>
	#admission: Result.Result<RegexNode, PatternRefusal> | undefined
	#nfa: Nfa | undefined
	#parsed: ParsedPattern | undefined
	#outcome: DfaOutcome | undefined
	#value: Result.Result<PatternValue, PatternRefusal> | undefined

	constructor(pattern: PatternSource) {
		this.#pattern = pattern
		this.#parse = parsePattern(pattern.source, pattern.flags)
	}

	/** The pattern's admission: its IR, or why PostgreSQL's regex compiler or the grammar refuses it. */
	admission(): Result.Result<RegexNode, PatternRefusal> {
		this.#admission ??= admitParsed(this.#parse)
		return this.#admission
	}

	/**
	 * The IR of a pattern its admission parsed, the one site of the fact that such a pattern parses: a RegexRef is minted
	 * only from a pattern its text analysis admitted (text/refinement.ts analyzeText), a lexical form is grizzle's own
	 * (scalar/lexical.ts formSource), and a Text.matches pattern is admitted where its node is typed (admit.ts
	 * matchPattern).
	 */
	#ir(): RegexNode {
		if (!this.#parse.ok) {
			const { source, flags } = this.#pattern
			defect(`a pattern its admission parsed: /${source}/${flags}`)
		}
		return this.#parse.value
	}

	#automaton(): Nfa {
		this.#nfa ??= buildNfa(this.#ir())
		return this.#nfa
	}

	parsed(): ParsedPattern {
		this.#parsed ??= { node: this.#ir(), matcher: Matcher.of(this.#automaton()) }
		return this.#parsed
	}

	outcome(): DfaOutcome {
		this.#outcome ??= minimalDfa(this.#automaton(), regexDfaLimits)
		return this.#outcome
	}

	/** The pattern value of a Text.matches pattern, its spelling the source, or why its admission refuses it. */
	value(): Result.Result<PatternValue, PatternRefusal> {
		this.#value ??= Result.map(this.admission(), (ir) =>
			patternValueOf(this.#pattern.source, ir, this.outcome())
		)
		return this.#value
	}
}

/**
 * The parse of a member of a text type's conjunction (ir/scalar.ts textPatterns), read from `patterns`: a language with
 * a member, since the text analysis admits a refinement's member only with one (text/refinement.ts analyzeText), where a
 * Text.matches pattern, which no image or alphabet of a refinement reads, may be the empty language.
 */
export const memberNode = (pattern: PatternSource, patterns: PatternAutomata): LiveNode => {
	const { node } = patterns.parse(pattern)
	if (node.kind === "never") {
		defect(`a refinement's member with a member: /${pattern.source}/${pattern.flags}`)
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
 * What typing, membership, inclusion and translation read of admitted patterns, from the table of the compile they
 * serve (text/refinement.ts AnalyzedPatterns), so none is parsed, minimized or analyzed per reader.
 */
export interface PatternAutomata extends PatternReads {
	/** The parse of an admitted pattern: a refinement's member, a lexical form's, or a Text.matches pattern's. */
	readonly parse: (pattern: PatternSource) => ParsedPattern
	/**
	 * The canonical DFA of an admitted pattern's search language within the text analysis's bounds (dfa.ts minimalDfa
	 * of its matcher's automaton at regexDfaLimits), or its bound: what the inclusion and length proofs compare
	 * (scalar/regex/inclusion.ts) and the text analysis knows a pattern's language by.
	 */
	readonly minimal: (pattern: PatternSource) => DfaOutcome
	/**
	 * The language of a conjunction of patterns as the text analysis proves it (text/refinement.ts analyzeText,
	 * textLanguage), a refusal located at the patterns: what a typing types a text a computation makes by.
	 */
	readonly language: TextLookup
}

/**
 * The patterns one compile meets, by flags and then source, each entered the first time it is met (PatternEntry) and
 * read from the table after: a compile's own explicit state, created where the compile begins and passed to what it
 * compiles, never shared by two compiles, so it holds only what its compile meets. A compile parses, admits, builds the
 * automaton of and minimizes each distinct pattern once, whatever reads it: O(p) constructions for its p distinct
 * patterns and a lookup for each of its r reads, where a reader of a table of its own, or of none, built again what
 * another had, O(r) constructions. Over edullm's QTI schema's laws (qti-pie 1bf7dcc's lawsOf), whose 440 distinct
 * patterns were parsed 512 times beside their admissions' own parses and minimized 82 times over 5 by the proofs, each
 * is now parsed, built and minimized once.
 */
export class CompilePatterns implements PatternReads {
	readonly #entries = new Map<RegexFlags, Map<string, PatternEntry>>()

	#entry(pattern: PatternSource): PatternEntry {
		const bySource = this.#entries.getOrInsertComputed(
			pattern.flags,
			() => new Map<string, PatternEntry>()
		)
		return bySource.getOrInsertComputed(pattern.source, () => new PatternEntry(pattern))
	}

	/** A pattern's admission (ir/pattern.ts admitParsed): its IR, or why it is refused, which its reader places. */
	readonly admitted = (pattern: PatternSource): Result.Result<RegexNode, PatternRefusal> =>
		this.#entry(pattern).admission()

	/** A Text.matches pattern's value (ir/pattern.ts patternValueOf), or why its admission refuses it. */
	readonly spelling = (source: string): Result.Result<PatternValue, PatternRefusal> =>
		this.#entry({ source, flags: matchFlags }).value()

	readonly parse = (pattern: PatternSource): ParsedPattern => this.#entry(pattern).parsed()

	readonly minimal = (pattern: PatternSource): DfaOutcome => this.#entry(pattern).outcome()

	readonly member = (regex: RegexRef, text: string): boolean =>
		memberOf(regex, (pattern) => this.parse(pattern).matcher, text)

	readonly matches = (source: string, text: string): boolean =>
		this.parse({ source, flags: matchFlags }).matcher.matches(text)
}

/** Parses, by flags and then source. */
type ParseTable = Map<RegexFlags, Map<string, ParsedPattern>>

const tabled = (table: ParseTable, pattern: PatternSource): ParsedPattern | undefined =>
	table.get(pattern.flags)?.get(pattern.source)

/**
 * The patterns a compiled program checks, every one parsed when the program compiles and none after: the host's fill
 * and check paths read them per row. A pattern outside the table is a defect of the collection that built it
 * (typePatterns, tablePatterns), which reads every pattern the program's types and expressions hold.
 */
export class ProgramPatterns implements PatternReads {
	readonly #table: ParseTable

	private constructor(table: ParseTable) {
		this.#table = table
	}

	/** The table of `patterns`, each distinct one parsed once, in a table of their own. */
	static of(patterns: Iterable<PatternSource>): ProgramPatterns {
		return ProgramPatterns.ofCompile(patterns, new CompilePatterns())
	}

	/** The table of `patterns`, each distinct one's parse read from `compile`, the table of the compile it serves. */
	static ofCompile(patterns: Iterable<PatternSource>, compile: CompilePatterns): ProgramPatterns {
		const table: ParseTable = new Map()
		for (const pattern of patterns) {
			table
				.getOrInsertComputed(pattern.flags, () => new Map<string, ParsedPattern>())
				.getOrInsertComputed(pattern.source, () => compile.parse(pattern))
		}
		return new ProgramPatterns(table)
	}

	readonly #parse = (pattern: PatternSource): ParsedPattern => {
		const known = tabled(this.#table, pattern)
		if (known === undefined) {
			defect(`a pattern its program's types hold: /${pattern.source}/${pattern.flags}`)
		}
		return known
	}

	readonly member = (regex: RegexRef, text: string): boolean =>
		memberOf(regex, (pattern) => this.#parse(pattern).matcher, text)

	readonly matches = (source: string, text: string): boolean =>
		this.#parse({ source, flags: matchFlags }).matcher.matches(text)

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
 * patterns its predicate reads, every level down to the base; and a variant's, every pattern each of its arms' fields is
 * checked against and each arm's check reads, as its domain's CHECK judges a value (scalar/compute/evaluate.ts
 * variantMembership).
 */
export const typePatterns = (t: ScalarType): ReadonlyArray<PatternSource> => {
	if (t.carrier === "variant") {
		return t.variant.arms.flatMap((arm) => [
			...arm.fields.flatMap((f) => typePatterns(f.type)),
			...(arm.check === undefined ? [] : tablePatterns(arm.check))
		])
	}
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
