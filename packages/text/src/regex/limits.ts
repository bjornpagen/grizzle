import type { DfaLimits } from "#text/regex/dfa.ts"

/**
 * The bounds on the subset construction of one pattern's automaton (dfa.ts minimalDfa), measured on the construction
 * itself: grizzle's text analysis holds every pattern within them, and an application that composes or matches its own
 * patterns over grizzle-text holds them by the same numbers, so no second bound stands beside them.
 */

/**
 * The DFA states a pattern's subset construction may create (dfa.ts minimalDfa), a bound on the compiling
 * process's own work. Past it, or past regexDfaMaxWork, the analysis knows the language by its IR alone: the pattern
 * is enforced by its ARE with structural bounds and keyed by its IR ("ir:", text/refinement.ts keyOf). It refuses
 * nothing, but a change of either bound changes the key, and so the domain digest a snapshot records, of every pattern
 * whose construction lands between the two values.
 *
 * @limitKind measured
 * @owner grizzle's text analysis (dfa.ts minimalDfa)
 * @unit DFA states
 * @scope the subset construction of one pattern's automaton, in the compiling process
 * @evidence ~/.cache/grizzle-release/LIMITS/out/evidence/dfa/ on cassowary: dfa-2026-11-16T075038.json, the
 *   uncommitted record of `pnpm bench dfa` (bench/dfa/main.ts), and run.log, its console output with the machine's
 *   uptime before it: scalar/regex/dfa.ts minimalDfa under both limits, seven runs a pattern in one process, the first
 *   cold, then one run under 16 times each limit, on 29 patterns analyzeText admits: `^(?:a|b)*a(?:a|b){k}$` for k
 *   from 6 to 12, 14 and 16 (minimal DFAs of 2^(k+1) states), wide classes over chains of up to 255 copies, chains of
 *   255 copies, and chains of up to 1,024 distinct code points and 512 scattered classes
 * @observed 2026-11-16 07:50:32 to 07:51:05 UTC, one run
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (Neoverse-V1, arm64) instance with
 *   64 logical CPUs and 247 GiB, Node 26.13.1, one single-threaded process; load average 155 over the 64 CPUs from
 *   other sessions as it started, so the times are a loaded machine's; grizzle ac71cfbb with lane LIMITS's move of the
 *   limits into @grizzle/limits, which changes no construction
 * @workload one pattern's construction at a time, the process's only work, over NFAs of 15 to 4,117 states, parsing
 *   and the NFA build untimed
 * @result at k = 9 the construction completes, 1,024 minimal states of 1,026 created, in 20.1 ms median; for k = 10,
 *   11, 12, 14 and 16 it stops at this bound in 5.0 to 15.7 ms median, 25.5 ms at worst, where the whole constructions
 *   take 42.5, 62.7 and 149.1 ms for k = 10 to 12 (2,050 to 8,194 states) and reach 16 times the bound (32,768 states)
 *   in 118.6 and 129.0 ms for k = 14 and 16; `(?:[a-z]{0,255}x){2}` and `(?:[a-z]{0,255}x){8}`, which it cuts in 71.2
 *   and 38.4 ms median, 106.1 ms at worst, reach 16 times it in 3,937.8 and 877.8 ms; memory not measured
 * @decision kept at 2,048: every construction it cuts stops within 110 ms here on a machine loaded past twice its
 *   CPUs, well inside what regexDfaMaxWork allows, while past it the run shows constructions of 32,768 states taking
 *   up to 3.9 s; a change would change the key, and so the domain digest, of every pattern whose construction lands
 *   between the two values; no headroom beyond the run is claimed. The record of 2026-11-05 on a retired macOS VM
 *   (bench/results/dfa/dfa-2026-11-05T080355.json there) found the same order: cuts within 40 ms, 925 ms at 16 times
 * @revalidate a change to the subset construction, its alphabet, the minimization or the canonical form
 *   (scalar/regex/dfa.ts), or to the NFA builder (scalar/regex/nfa.ts); a Node or V8 upgrade; another machine; a
 *   pattern whose construction under the limits takes longer than the slowest here
 */
export const regexDfaMaxStates = 2_048

/**
 * The NFA-state visits a pattern's subset construction is charged (dfa.ts minimalDfa): the initial closure's
 * states, then for every transition the states of its source subset and of its target, whether the target is computed
 * or is the restart closure computed once; the other bound on the compiling process's own work, with
 * regexDfaMaxStates. It leaves out the alphabet's partition, which grows with the segments the pattern's sets hold, and
 * the canonical form's walk over every segment for every class, at most regexDfaMaxStates times the segments.
 *
 * @limitKind measured
 * @owner grizzle's text analysis (dfa.ts minimalDfa)
 * @unit NFA-state visits
 * @scope the subset construction of one pattern's automaton, in the compiling process
 * @evidence ~/.cache/grizzle-release/LIMITS/out/evidence/dfa/ on cassowary: dfa-2026-11-16T075038.json, the
 *   uncommitted record of `pnpm bench dfa` (bench/dfa/main.ts), and run.log, its console output with the machine's
 *   uptime before it: scalar/regex/dfa.ts minimalDfa under both limits, seven runs a pattern in one process, the first
 *   cold, then one run under 16 times each limit, on 29 patterns analyzeText admits: `^(?:a|b)*a(?:a|b){k}$` for k
 *   from 6 to 12, 14 and 16 (minimal DFAs of 2^(k+1) states), wide classes over chains of up to 255 copies, chains of
 *   255 copies, and chains of up to 1,024 distinct code points and 512 scattered classes
 * @observed 2026-11-16 07:50:32 to 07:51:05 UTC, one run
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (Neoverse-V1, arm64) instance with
 *   64 logical CPUs and 247 GiB, Node 26.13.1, one single-threaded process; load average 155 over the 64 CPUs from
 *   other sessions as it started, so the times are a loaded machine's; grizzle ac71cfbb with lane LIMITS's move of the
 *   limits into @grizzle/limits, which changes no construction
 * @workload one pattern's construction at a time, the process's only work, over NFAs of 15 to 4,117 states, parsing
 *   and the NFA build untimed
 * @result the constructions it cuts stop in 17.1 to 370.5 ms median, 666.1 ms at worst (`^(?:.{0,255}){8}$`, at 538
 *   states); among them `^(?:[a-z]{0,255}){8}$`, `^(?:[a-z]{1,255}){16}$` and `^(?:.{0,255}){8}$` stop in 188.9, 260.4
 *   and 370.5 ms median, where their whole constructions take 579, 3,098 and 800 ms (5.5, 23.6 and 5.5 million
 *   visits); the slowest construction it admits, `<512 classes of 8 scattered code points>` (513 minimal states,
 *   789,506 visits), completes in 399.6 ms median, 740.2 ms at worst; memory not measured
 * @decision kept at 2,097,152: at it every construction of the run, cut or completed, ends within 750 ms on a machine
 *   loaded past twice its CPUs, while the constructions it cuts take up to 3.1 s whole; a change would change the key,
 *   and so the domain digest, of every pattern whose construction lands between the two values; no headroom beyond the
 *   run is claimed. The record of 2026-11-05 on a retired macOS VM found the same order: within 230 ms, 1.8 s whole
 * @revalidate a change to the subset construction, its alphabet, the minimization or the canonical form
 *   (scalar/regex/dfa.ts), or to the NFA builder (scalar/regex/nfa.ts); a Node or V8 upgrade; another machine; a
 *   pattern whose construction under the limits takes longer than the slowest here
 */
export const regexDfaMaxWork = 2_097_152

/** The text analysis's bounds on one construction, the subset construction's own, which every inclusion and
 * intersection the analysis decides is held within, and an application's own facet composition (pantry's) and host
 * matcher of an author's pattern (plate's) are too. */
export const regexDfaLimits: DfaLimits = Object.freeze({
	maxStates: regexDfaMaxStates,
	maxWork: regexDfaMaxWork
})
