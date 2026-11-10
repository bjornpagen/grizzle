#!/usr/bin/env -S node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Array as Arr, Console, Data, DateTime, Effect, pipe, String as Str } from "effect"
import {
	type RunIdentity,
	runIdentity,
	sourceIdentity,
	writeRunRecord
} from "#bench/cold/identity.ts"
import { elapsed, type Summary, summarize } from "#bench/cold/stats.ts"
import { regexDfaMaxStates, regexDfaMaxWork } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type DfaLimits, type DfaOutcome, minimalDfa } from "#compiler/scalar/regex/dfa.ts"
import type { Nfa } from "#compiler/scalar/regex/match.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern, type RegexFlags } from "#compiler/scalar/regex/parse.ts"
import { analyzeText } from "#compiler/text/refinement.ts"

/**
 * The subset-construction benchmark, `pnpm bench dfa`: scalar/regex/dfa.ts minimalDfa under the two limits that bound it
 * (core/limits.ts regexDfaMaxStates and regexDfaMaxWork), on patterns text/refinement.ts analyzeText admits, the
 * evidence those limits cite. It needs no database.
 *
 * Every pattern is parsed and its NFA built once, untimed; then minimalDfa runs `runs` times under the limits, one
 * after another in this one process, the first of them cold for that pattern; then once more under `ceiling` times
 * each limit, timed once, which reaches the whole construction of every pattern not far past the limits, so the record
 * says which limit cuts it, by how much and what the cut saves; then analyzeText, which must admit the pattern. The
 * record, with its full identity, goes to bench/results/dfa/dfa-<time>.json, one file a run, and a table is printed.
 * The machine is a virtual one, its timings noisy: the record is information, and the exit status reports only whether
 * the run completed with every pattern admitted.
 */
const runs = 7
const ceiling = 16

const limits: DfaLimits = { maxStates: regexDfaMaxStates.value, maxWork: regexDfaMaxWork.value }
const ceilingLimits: DfaLimits = {
	maxStates: ceiling * regexDfaMaxStates.value,
	maxWork: ceiling * regexDfaMaxWork.value
}

/** A pattern the benchmark constructs, the family it stands for, and how the table names it. */
interface Pattern {
	readonly family: string
	readonly label: string
	readonly source: string
	readonly flags: RegexFlags
}

const plain = (family: string, source: string): Pattern => ({
	family,
	label: `/${source}/u`,
	source,
	flags: "u"
})

/** `^(?:a|b)*a(?:a|b){k}$`: the values whose k + 1st code point from the end is `a`, of 2^(k+1) minimal DFA states. */
const kthFromEnd = (k: number): Pattern => plain("kth-from-end", `^(?:a|b)*a(?:a|b){${k}}$`)

/** The `n` code points from U+4E00 on, one each, as a literal chain of `n` distinct sets. */
const distinctChain = (n: number): Pattern => ({
	family: "distinct-sets",
	label: `/<${n} distinct code points>/u`,
	source: Arr.join(
		Arr.makeBy(n, (i) => String.fromCodePoint(0x4e00 + i)),
		""
	),
	flags: "u"
})

/**
 * A chain of `n` classes of `width` code points each from U+20000 on, every code point apart from the next, so each
 * class is `width` intervals and no two classes share one.
 */
const scatteredChain = (n: number, width: number): Pattern => {
	const classOf = (i: number): string =>
		`[${Arr.join(
			Arr.makeBy(width, (j) => String.fromCodePoint(0x20000 + 2 * (i * width + j))),
			""
		)}]`
	return {
		family: "scattered-sets",
		label: `/<${n} classes of ${width} scattered code points>/u`,
		source: Arr.join(Arr.makeBy(n, classOf), ""),
		flags: "u"
	}
}

const patterns: ReadonlyArray<Pattern> = [
	...Arr.map([6, 7, 8, 9, 10, 11, 12, 14, 16], kthFromEnd),
	plain("wide-chain", "^[a-z]{0,255}$"),
	plain("wide-chain", "^(?:[a-z]{0,255}){2}$"),
	plain("wide-chain", "^(?:[a-z]{0,255}){4}$"),
	plain("wide-chain", "^(?:[a-z]{0,255}){8}$"),
	plain("wide-chain", "^(?:[a-z]{1,255}){16}$"),
	plain("wide-chain", "^(?:.{0,255}){8}$"),
	plain("wide-chain", "(?:[a-z]{0,255}x){2}"),
	plain("wide-chain", "(?:[a-z]{0,255}x){8}"),
	plain("copies-255", "^a{255}$"),
	plain("copies-255", "^(?:a|b){255}$"),
	plain("copies-255", "^(?:a?){255}$"),
	plain("copies-255", "(?:a?){255}"),
	plain("copies-255", "(?:ab){255}"),
	plain("copies-255", "(?:a?){255}(?:b?){100}c"),
	distinctChain(1_024),
	scatteredChain(512, 8)
]

/** What one construction spent, and what it came to: the minimal DFA's size, or the limit it stopped at. */
type Spend =
	| {
			readonly kind: "minimal"
			readonly minimalStates: number
			readonly states: number
			readonly work: number
	  }
	| {
			readonly kind: "bounded"
			readonly limit: keyof DfaLimits
			readonly states: number
			readonly work: number
	  }

const spendOf = (outcome: DfaOutcome): Spend => {
	switch (outcome.kind) {
		case "minimal":
			return {
				kind: "minimal",
				minimalStates: outcome.dfa.states.length,
				states: outcome.spent.states,
				work: outcome.spent.work
			}
		case "bounded":
			return { kind: "bounded", limit: outcome.limit, ...outcome.spent }
	}
}

interface DfaCase {
	readonly family: string
	readonly label: string
	readonly pattern: string
	readonly nfaStates: number
	readonly setEdges: number
	/** The construction under the limits, the same in every run. */
	readonly limited: Spend
	/** The construction under `ceiling` times each limit, and its milliseconds, run once after the others. */
	readonly whole: Spend
	readonly wholeMs: number
	/** The kind of the canonical key analyzeText gives the pattern: its minimal DFA's, or its IR's. */
	readonly key: "dfa" | "ir"
	/** Each run's milliseconds under the limits, in run order, the first cold. */
	readonly samplesMs: Arr.NonEmptyReadonlyArray<number>
	readonly summary: Summary
}

interface DfaRecord {
	readonly identity: RunIdentity
	readonly limits: DfaLimits
	readonly ceilingLimits: DfaLimits
	readonly cases: ReadonlyArray<DfaCase>
}

/** A pattern the benchmark cannot construct: one that does not parse, or that analyzeText refuses. */
class PatternRefused extends Data.TaggedError("PatternRefused")<{
	readonly pattern: string
	readonly reason: string
}> {}

/** A command line the benchmark cannot read. */
class DfaUsage extends Data.TaggedError("DfaUsage")<{ readonly reason: string }> {}

const setEdgesOf = (nfa: Nfa): number =>
	Arr.reduce(nfa.edges, 0, (n, edges) => n + Arr.filter(edges, (e) => e.kind === "set").length)

const sameSpend = (a: Spend, b: Spend): boolean =>
	a.kind === b.kind && a.states === b.states && a.work === b.work

const runCase = Effect.fn("runCase")(function* (pattern: Pattern) {
	const named = `/${pattern.source}/${pattern.flags}`
	const parsed = parsePattern(pattern.source, pattern.flags)
	if (!parsed.ok) {
		return yield* new PatternRefused({ pattern: pattern.label, reason: parsed.error.message })
	}
	const nfa = buildNfa(parsed.value)
	const timed = yield* Effect.sync(() =>
		Arr.makeBy(runs, () => {
			const start = performance.now()
			const outcome = minimalDfa(nfa, limits)
			return { ms: elapsed(start), spend: spendOf(outcome) }
		})
	)
	const [first, ...rest] = timed
	if (!Arr.every(rest, (r) => sameSpend(r.spend, first.spend))) {
		return yield* Effect.die(new Error(`runCase: ${pattern.label} spent differently between runs`))
	}
	const whole = yield* Effect.sync(() => {
		const start = performance.now()
		const outcome = minimalDfa(nfa, ceilingLimits)
		return { ms: elapsed(start), spend: spendOf(outcome) }
	})
	const analyzed = analyzeText(
		[{ source: pattern.source, flags: pattern.flags }],
		SourceLoc(named, [])
	)
	if (!analyzed.ok) {
		return yield* new PatternRefused({ pattern: pattern.label, reason: analyzed.error.message })
	}
	const samplesMs = Arr.map(timed, (r) => r.ms)
	const dfaCase: DfaCase = {
		family: pattern.family,
		label: pattern.label,
		pattern: named,
		nfaStates: nfa.edges.length,
		setEdges: setEdgesOf(nfa),
		limited: first.spend,
		whole: whole.spend,
		wholeMs: whole.ms,
		key: Str.startsWith("dfa:")(analyzed.value.key) ? "dfa" : "ir",
		samplesMs,
		summary: summarize(samplesMs)
	}
	return dfaCase
})

const scope =
	"scalar/regex/dfa.ts minimalDfa alone: the subset construction (atom partition, determinization), Hopcroft minimization and canonical numbering of one pattern's NFA, timed by performance.now around one call; parsing, the NFA build, the compile-space measures and the key's digest are outside it, and memory is not measured"

const spendText = (spend: Spend): string => {
	switch (spend.kind) {
		case "minimal":
			return `minimal ${spend.minimalStates} of ${spend.states} states, work ${spend.work}`
		case "bounded":
			return `${spend.limit} at ${spend.states} states, work ${spend.work}`
	}
}

const row = (c: DfaCase): string =>
	Arr.join(
		[
			`  ${pipe(c.label, Str.padEnd(52))}`,
			`nfa ${pipe(String(c.nfaStates), Str.padStart(5))}`,
			`first ${pipe(c.samplesMs[0].toFixed(1), Str.padStart(8))} ms`,
			`p50 ${pipe(c.summary.p50.toFixed(1), Str.padStart(8))} ms`,
			`max ${pipe(c.summary.max.toFixed(1), Str.padStart(8))} ms`,
			`${c.key}  ${spendText(c.limited)}; whole ${c.wholeMs.toFixed(1)} ms: ${spendText(c.whole)}`
		],
		"  "
	)

const main = Effect.gen(function* () {
	const args = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	if (Arr.isReadonlyArrayNonEmpty(args)) {
		return yield* new DfaUsage({ reason: `unknown argument ${args[0]}` })
	}
	const source = yield* sourceIdentity
	const startedAt = yield* DateTime.now
	const cases = yield* Effect.forEach(patterns, (p) =>
		Effect.tap(runCase(p), (c) => Console.info(row(c)))
	)
	const identity = yield* runIdentity({
		benchmark: "dfa",
		phases: ["minimalDfa"],
		scope,
		options: { runs, ceiling, startedAt: DateTime.formatIso(startedAt) },
		source
	})
	const record: DfaRecord = { identity, limits, ceilingLimits, cases }
	yield* writeRunRecord(startedAt, record)
})

const setStatus = (status: number): Effect.Effect<void> =>
	Effect.sync(() => {
		process.exitCode = status
	})

NodeRuntime.runMain(
	main.pipe(
		Effect.catchTags({
			DfaUsage: (e) => Effect.andThen(Console.error(e.reason), setStatus(2)),
			PatternRefused: (e) =>
				Effect.andThen(Console.error(`${e.pattern}: ${e.reason}`), setStatus(1))
		}),
		Effect.provide(NodeServices.layer)
	)
)
