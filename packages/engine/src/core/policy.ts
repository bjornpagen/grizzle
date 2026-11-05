/**
 * An enumerated relation parameter at or below this many facts travels as a VALUES list of typed literals.
 *
 * Every constant of this module is one of grizzle's fixed thresholds, read where it decides. None is configurable,
 * none is measured, and none is digested: no fingerprint or snapshot depends on them, since a change of a
 * constant is a change of grizzle. A function that decides a threshold takes it as its own parameter where a test
 * drives that decision with a smaller value; production passes the constant.
 */
export const valuesMaxRows = 16

/**
 * Above valuesMaxRows, one jsonb_to_recordset parameter up to this many facts, a Stream member's collected facts
 * included. A larger input is refused before any SQL is sent.
 */
export const recordsetMaxRows = 100_000

/** A bound parent set at or below this size takes the correlated LATERAL form. */
export const lateralParentMax = 256

/** An attachment with at most this many fields may be fused into its parent statement. */
export const attachFuseMaxFields = 4

/** A sub-query referenced at least this many times in one snapshot is shared. */
export const cteShareMinRefs = 2

/** Recursion: the bounded unrolling depth, and the admitted termination-certificate state estimate. */
export const recursionUnrollMax = 4
export const recursionMaxStates = 1_000_000

/**
 * PostgreSQL's explicit repetition limit: a pattern whose `{m}`, `{m,}` or `{m,n}` states a bound above it is refused
 * (scalar/regex/parse.ts), as PostgreSQL's regex compiler refuses it (regcomp.c scannum, against DUPMAX, which is
 * _POSIX2_RE_DUP_MAX).
 *
 * @limitKind published
 * @owner PostgreSQL 19's regex compiler
 * @unit repetitions
 * @scope each bound of a counted repetition in one str.regex pattern
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_RC1/src/include/regex/regguts.h#L95 "#define _POSIX2_RE_DUP_MAX	255"
 * @verified 2026-11-04
 */
export const regexMaxRepeat = 255

/**
 * The first of the four compile-space measures, which stand for PostgreSQL's REG_MAX_COMPILE_SPACE
 * (https://github.com/postgres/postgres/blob/REL_19_RC1/src/include/regex/regguts.h#L463-L466, "#define
 * REG_MAX_COMPILE_SPACE (500000 * (sizeof(struct state) + 4 * sizeof(struct arc)))"): the space of the NFA states and
 * arcs PostgreSQL's regex compiler builds, charged as it allocates them (regc_nfa.c newstate, allocarc), past which it
 * refuses the pattern as "regular expression is too complex". That space follows not the pattern's length but what
 * the compiler's NFA optimizer makes of it: empty-arc removal is quadratic in chains of nullable copies, and
 * constraint elimination clones the states an anchor crosses. text/refinement.ts analyzeText reads the four measures
 * off the normalized IR, the IR the ARE is printed from, and refuses a pattern past any of them as ResourceBound
 * (core/errors.ts regexCompileSpace) before its domain is built. They are measured, not derived from
 * REG_MAX_COMPILE_SPACE: no arithmetic on its 500,000 states gives them, since its cost per position depends on the
 * optimizer. Each is a bound inside it, not its edge: what they admit compiles, and quickly on a cold backend, and a
 * pattern past one may still compile.
 *
 * This one: NFA positions once counted repetitions are written out (scalar/regex/ir.ts expandedSize).
 *
 * @limitKind measured
 * @owner grizzle's text refinement (text/refinement.ts analyzeText)
 * @unit NFA positions
 * @scope one str.regex pattern's normalized IR, written out
 * @evidence test/pg/text/differential.test.ts: its test "compiles admitted patterns at each budget inside PostgreSQL's
 * regex compile space" compiles a pattern planted at this bound, `^(?:[a-z]{1,255}){16}$` (4,082 positions), and "compiles
 * generated admitted nested-quantifier patterns near the budgets" 4,800 drawn near it; the run output of the
 * measurement that first set the value is not preserved
 * @observed each pnpm test:network run; the first measurement's interval is not recorded
 * @environment PostgreSQL 19rc1 as scripts/pg/pin.env builds it, on the local cluster CONTRIBUTING.md sets up
 * @workload one compile of each planted and drawn pattern's ARE, `'x' ~ <ARE>`, on one owner session under a 60 s
 * statement_timeout
 * @result every planted and drawn pattern compiles, which the suite asserts; compile times are not recorded
 * @decision kept where the first measurement set it, at which the slowest planted chain of optional copies,
 * `(?:a?){255}(?:b?){100}c`, compiled in tens of milliseconds on a cold backend
 * @revalidate a PostgreSQL repin; a change to the ARE printer (text/are.ts) or to the IR's normalization
 * (scalar/regex/ir.ts); a planted or drawn pattern refused as too complex
 */
export const regexMaxPositions = 4_096

/**
 * A compile-space measure (see regexMaxPositions): pairs of NFA states joined by a path of empty and anchor edges
 * (scalar/regex/nfa.ts closurePairs), whose arcs PostgreSQL's empty-arc removal (regc_nfa.c fixempties) copies.
 *
 * @limitKind measured
 * @owner grizzle's text refinement (text/refinement.ts analyzeText)
 * @unit pairs of NFA states
 * @scope one str.regex pattern's NFA
 * @evidence test/pg/text/differential.test.ts: its test "compiles admitted patterns at each budget inside PostgreSQL's
 * regex compile space" compiles a pattern planted at this bound, `(?:a?){255}(?:b?){100}c` (64,981 pairs), and
 * "compiles generated admitted nested-quantifier patterns near the budgets" 4,800 drawn near it; the run output of the
 * measurement that first set the value is not preserved
 * @observed each pnpm test:network run; the first measurement's interval is not recorded
 * @environment PostgreSQL 19rc1 as scripts/pg/pin.env builds it, on the local cluster CONTRIBUTING.md sets up
 * @workload one compile of each planted and drawn pattern's ARE, `'x' ~ <ARE>`, on one owner session under a 60 s
 * statement_timeout
 * @result every planted and drawn pattern compiles, which the suite asserts; compile times are not recorded
 * @decision kept where the first measurement set it; far past it, `(?:(?:a?){255}){8}b` (2,041 positions, 2,120,771
 * pairs) is too complex for PostgreSQL
 * @revalidate a PostgreSQL repin; a change to the NFA builder (scalar/regex/nfa.ts) or to the IR's normalization; a
 * planted or drawn pattern refused as too complex
 */
export const regexMaxClosurePairs = 65_536

/**
 * A compile-space measure (see regexMaxPositions): anchor positions, `^` and `$`, once counted repetitions are written
 * out (scalar/regex/ir.ts expandedAssertions), each of which PostgreSQL's constraint elimination (regc_nfa.c pullback,
 * pushfwd) moves by cloning the states it crosses.
 *
 * @limitKind measured
 * @owner grizzle's text refinement (text/refinement.ts analyzeText)
 * @unit anchor positions
 * @scope one str.regex pattern's normalized IR, written out
 * @evidence test/pg/text/differential.test.ts: its test "compiles admitted patterns at each budget inside PostgreSQL's
 * regex compile space" compiles patterns planted at this bound, `(?:$|a|){4}(?:^|a|){4}b` and
 * `(?:^|.{1,127}|$){2,4}b` (8 anchors each), and "compiles generated admitted nested-quantifier patterns near the
 * budgets" 4,800 drawn near it; the run output of the measurement that first set the value is not preserved
 * @observed each pnpm test:network run; the first measurement's interval is not recorded
 * @environment PostgreSQL 19rc1 as scripts/pg/pin.env builds it, on the local cluster CONTRIBUTING.md sets up
 * @workload one compile of each planted and drawn pattern's ARE, `'x' ~ <ARE>`, on one owner session under a 60 s
 * statement_timeout
 * @result every planted and drawn pattern compiles, which the suite asserts; compile times are not recorded
 * @decision kept where the first measurement set it; past it, `(?:(?:a|$){1,3}){12}(?:^)?b` (37 anchors) is too
 * complex for PostgreSQL, and `(?:\Z|a|){8}(?:\A|a|){8}b` (16) takes seconds to compile
 * @revalidate a PostgreSQL repin; a change to the ARE printer or to the IR's normalization; a planted or drawn pattern
 * refused as too complex
 */
export const regexMaxAnchors = 8

/**
 * A compile-space measure (see regexMaxPositions): anchor positions times NFA positions, both written out, the states
 * constraint elimination may clone.
 *
 * @limitKind measured
 * @owner grizzle's text refinement (text/refinement.ts analyzeText)
 * @unit anchor positions times NFA positions
 * @scope one str.regex pattern's normalized IR, written out
 * @evidence test/pg/text/differential.test.ts: its test "compiles admitted patterns at each budget inside PostgreSQL's
 * regex compile space" compiles a pattern planted at this bound, `^(?:[a-z]{1,255}){16}$` (2 anchors over 4,082
 * positions, 8,164), and "compiles generated admitted nested-quantifier patterns near the budgets" 4,800 drawn near it;
 * the run output of the measurement that first set the value is not preserved
 * @observed each pnpm test:network run; the first measurement's interval is not recorded
 * @environment PostgreSQL 19rc1 as scripts/pg/pin.env builds it, on the local cluster CONTRIBUTING.md sets up
 * @workload one compile of each planted and drawn pattern's ARE, `'x' ~ <ARE>`, on one owner session under a 60 s
 * statement_timeout
 * @result every planted and drawn pattern compiles, which the suite asserts; compile times are not recorded
 * @decision kept where the first measurement set it
 * @revalidate a PostgreSQL repin; a change to the ARE printer or to the IR's normalization; a planted or drawn pattern
 * refused as too complex
 */
export const regexMaxAnchorWeight = 8_192

/**
 * The DFA states a pattern's subset construction may create (text/dfa.ts minimalDfa), a bound on the compiling
 * process's own work. Past it, or past regexDfaMaxWork, the analysis knows the language by its IR alone: the pattern
 * is enforced by its ARE with structural bounds and keyed by its IR ("ir:", text/refinement.ts keyOf). It refuses
 * nothing, but a change of either bound changes the key, and so the domain digest a snapshot records, of every pattern
 * whose construction lands between the two values.
 *
 * @limitKind measured
 * @owner grizzle's text analysis (text/dfa.ts minimalDfa)
 * @unit DFA states
 * @scope the subset construction of one pattern's automaton, in the compiling process
 * @evidence bench/results/regex-dfa-bounds-2026-11-05T044337.json in the checkout that measured it: minimalDfa under
 * both bounds, seven runs a pattern in one process, the first cold, on 17 patterns: `^(?:a|b)*a(?:a|b){k}$` for k
 * from 6 to 12 (minimal DFAs of 2^(k+1) states), wide classes over chains, and chains of 255 copies
 * @observed 2026-11-04 22:43 to 22:44 CST
 * @environment macOS (Darwin 27.0.0) on 10 cores (Apple M2 Max, virtual), Node 26.13.0 (V8 14.6.202.34); load average
 * 20 to 26 from other sessions throughout
 * @workload one pattern's construction at a time, the process's only work, over NFAs of 15 to 4,117 states
 * @result the construction reaches 1,024 states at k = 9 in 11 ms median and gives up at this bound for k = 10 to 12 in
 * 3 to 6 ms median; the slowest of the 17, `^(?:.{0,255}){16}$`, which either bound cuts, gave up in 154 ms at worst;
 * memory not measured
 * @decision kept at the value it had as four times the construct budget it was derived from, deleted with it, which
 * holds the construction under 154 ms here and changes no recorded digest
 * @revalidate a change to the subset construction or the NFA builder; a Node or V8 upgrade; a construction seen past a
 * second
 */
export const regexDfaMaxStates = 2_048

/**
 * The NFA-state visits a pattern's subset construction may spend, summed over every transition it computes
 * (text/dfa.ts minimalDfa): the other bound on the compiling process's own work, with regexDfaMaxStates.
 *
 * @limitKind measured
 * @owner grizzle's text analysis (text/dfa.ts minimalDfa)
 * @unit NFA-state visits
 * @scope the subset construction of one pattern's automaton, in the compiling process
 * @evidence bench/results/regex-dfa-bounds-2026-11-05T044337.json in the checkout that measured it (see
 * regexDfaMaxStates)
 * @observed 2026-11-04 22:43 to 22:44 CST
 * @environment macOS (Darwin 27.0.0) on 10 cores (Apple M2 Max, virtual), Node 26.13.0 (V8 14.6.202.34); load average
 * 20 to 26 from other sessions throughout
 * @workload one pattern's construction at a time, the process's only work, over NFAs of 15 to 4,117 states
 * @result the constructions it cuts, `^(?:[a-z]{0,255}){8}$` (this bound alone) and `^(?:.{0,255}){16}$` and
 * `(?:[a-z]{0,255}x){2}` (either bound), gave up in 99, 118 and 19 ms median and 154 ms at worst; memory not measured
 * @decision kept at the value it had as 4,096 times the construct budget it was derived from, deleted with it, which
 * holds the construction under 154 ms here and changes no recorded digest
 * @revalidate a change to the subset construction or the NFA builder; a Node or V8 upgrade; a construction seen past a
 * second
 */
export const regexDfaMaxWork = 2_097_152

/** The compiler's budgets, in the order a meter reports them. */
export const budgetKinds = ["nodes", "fields", "sqlBytes", "params", "variants"] as const
export type BudgetKind = (typeof budgetKinds)[number]

/**
 * The compiler's resource bounds per compilation; exceeding one is a source-located ResourceBound (budget.ts). The
 * parameter bound is PostgreSQL's protocol limit: a Bind message counts its parameters in 16 bits.
 */
export type Budgets = Readonly<Record<BudgetKind, number>>
export const compileBudgets: Budgets = Object.freeze({
	nodes: 10_000,
	fields: 10_000,
	sqlBytes: 1024 * 1024,
	params: 65_535,
	variants: 64
})

/** The session pool: a short idle timeout, a floor of one session, a maximum above one. */
export const poolBounds = Object.freeze({ idleTimeoutMs: 5_000, min: 1, max: 10 })

/** Page sizes above this are refused. */
export const pageMaxSize = 1_000

/** A cursor token above this many bytes is a CursorError. */
export const cursorMaxBytes = 1_024

/**
 * The longest text grizzle builds as one string, in UTF-16 code units: V8's longest string (String::kMaxLength,
 * 2^29 - 24 on Node 26, node:buffer's constants.MAX_STRING_LENGTH). A statement, drafted file, snapshot.json, meta.json
 * or canonical text that would be longer is refused as ResourceBound before it is built.
 */
export const textMaxLength = 2 ** 29 - 24
