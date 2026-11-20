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
 * @evidence ~/.cache/grizzle-release/TEXTSPEC-evidence/dfa/ on cassowary: dfa-2026-11-20T084526.json, the uncommitted
 *   record of `pnpm bench dfa` (bench/dfa/main.ts), and run-counters.log, its console output with the machine's uptime
 *   before and after it, on the counting automaton (nfa.ts, one copy of a repetition's body and a counter); beside them
 *   dfa-2026-11-20T075059.json and run-copies.log, the same bench on the chain of copies it replaced, an hour before:
 *   regex/dfa.ts minimalDfa under both limits, seven runs a pattern in one process, the first cold, then one run under
 *   16 times each limit, on the 29 patterns of LIMITS's record of 2026-11-16 (dfa-2026-11-16T075038.json in
 *   ~/.cache/grizzle-release/LIMITS/out/evidence/dfa/): `^(?:a|b)*a(?:a|b){k}$` for k from 6 to 12, 14 and 16, wide
 *   classes over chains of up to 255 copies, chains of 255 copies, and chains of up to 1,024 distinct code points and
 *   512 scattered classes
 * @observed 2026-11-20 08:45:25 to 08:46:24 UTC, one run
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (Neoverse-V1, arm64) instance with
 *   64 logical CPUs and 247 GiB, Node 26.13.1, one single-threaded process; load average 478 over the 64 CPUs from
 *   other sessions as it started, so the times are a loaded machine's; grizzle ecbb2ab91 (lane TEXTSPEC)
 * @workload one pattern's construction at a time, the process's only work, over automata of 3 to 1,025 states, whose
 *   configurations are the 15 to 4,117 states of the chains of copies LIMITS measured, parsing and the automaton's
 *   build untimed
 * @result every construction's states and work are the copies' run's to the visit, for its configurations are the
 *   copies' states, but those of a repetition whose body matches the empty string, whose counter counts consuming
 *   iterations alone and keeps the fewest (subset.ts Configurations pruned): `^(?:[a-z]{0,255}){8}$` and
 *   `^(?:.{0,255}){8}$` now complete, 2,041 minimal states in 1,395,368 visits, 446.2 and 503.3 ms median, where they
 *   were cut at regexDfaMaxWork; at k = 9 the construction completes, 1,024 minimal states of 1,026 created, in 14.6 ms
 *   median, 25.3 ms at worst; for k = 10, 11, 12, 14 and 16 it stops at this bound in 6.7
 *   to 13.1 ms median, 25.9 ms at worst, where the whole constructions take 60.1 to 348.5 ms for k = 10 to 12 and reach
 *   16 times the bound in 205.0 and 171.2 ms for k = 14 and 16; `(?:[a-z]{0,255}x){2}` and `(?:[a-z]{0,255}x){8}`, which
 *   it cuts in 626.9 and 38.6 ms median, 1,091.1 ms at worst, reach 16 times it in 7,223.3 and 1,689.3 ms; the copies'
 *   run an hour before, its load not recorded, took 4.7 to 29.8 ms median for k = 10 to 16 and 35.7 and 20.2 ms for the
 *   two cut chains; memory not measured
 * @decision kept at 2,048: the counting automaton changes no construction's states or work but a consuming
 *   repetition's, which it makes smaller, and every construction it cuts stops within 1.1 s here on a machine loaded
 *   past seven times its CPUs, while past it the run shows constructions of 32,768 states taking up to 7.2 s; a change
 *   would change the key, and so the domain digest, of every pattern whose construction lands between the two values;
 *   no headroom beyond the run is claimed
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
 * @evidence ~/.cache/grizzle-release/TEXTSPEC-evidence/dfa/ on cassowary: dfa-2026-11-20T084526.json and
 *   run-counters.log, `pnpm bench dfa` on the counting automaton, and dfa-2026-11-20T075059.json and run-copies.log, on
 *   the chain of copies it replaced, as regexDfaMaxStates cites them, on the 29 patterns of LIMITS's record of
 *   2026-11-16
 * @observed 2026-11-20 08:45:25 to 08:46:24 UTC, one run
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (Neoverse-V1, arm64) instance with
 *   64 logical CPUs and 247 GiB, Node 26.13.1, one single-threaded process; load average 478 over the 64 CPUs from
 *   other sessions as it started; grizzle ecbb2ab91 (lane TEXTSPEC)
 * @workload one pattern's construction at a time, the process's only work, over automata of 3 to 1,025 states, parsing
 *   and the automaton's build untimed
 * @result the work of every construction is the copies' run's to the visit but a consuming repetition's (as
 *   regexDfaMaxStates states): `^(?:[a-z]{0,255}){8}$` and `^(?:.{0,255}){8}$`, which this bound cut at 538 states in
 *   the copies' run, complete in 1,395,368 visits, 446.2 and 503.3 ms median; `^(?:[a-z]{1,255}){16}$` stops at it at
 *   318 states in 351.9 ms median, 598.0 ms at worst, where its whole construction takes 5,984.7 ms (23.6 million
 *   visits); `<1024 distinct code points>` stops at it at 683 states in 383.1 ms median; the slowest construction it
 *   admits, `<512 classes of 8 scattered code points>` (513 minimal states, 789,506 visits), completes in 700.2 ms
 *   median, 3,452.0 ms at worst; memory not measured
 * @decision kept at 2,097,152: the counting automaton charges every construction the visits the copies did but a
 *   consuming repetition's, fewer, and at the bound every construction of the run, cut or completed, ends within 1.3 s
 *   median on a machine loaded past seven times its CPUs, while the constructions it cuts take up to 6.0 s whole; a
 *   change would change the key, and so the domain digest, of every pattern whose construction lands between the two
 *   values; no headroom beyond the run is claimed
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
