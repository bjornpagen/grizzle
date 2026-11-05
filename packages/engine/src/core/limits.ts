import { nominal } from "#compiler/core/brand.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"

/**
 * Limits: every number grizzle bounds something by, as a value that carries its evidence (the indefensible-numbers
 * skill). A limit is one of three kinds, and nothing else:
 *
 * - published: a number a source states, PostgreSQL's, V8's, a protocol's or a file system's, with the exact source,
 *   a quote of it, what kind of constraint it is, and the day it was opened and checked;
 * - measured: an operating value a measurement supports, with the record of that measurement, what it observed and
 *   under which environment and workload, how the value follows from it, and what invalidates it;
 * - derived: a value computed from other limits by the arithmetic its `compute` states, never a second spelling of
 *   their numbers.
 *
 * A limit is minted only here, by `published`, `measured` and `derived`, so every bound a comparison, a loop, a size,
 * a timeout or a pool option reads is a Limit or a caller's input, never a bare number (the limit-evidence gate).
 * grizzle chooses no number on its caller's behalf: what is a choice is the caller's input, and what is not is one of
 * these.
 */
declare const limitBrand: unique symbol

/** The day a published source was opened and its number checked, as YYYY-MM-DD. */
export type VerifiedDate = `${number}-${number}-${number}`

/**
 * What a published number really is. A vendor default is not a maximum, and an example or an advisory in a vendor's
 * guide is an advisory threshold, not a quota.
 */
export type Constraint =
	| "hard quota"
	| "protocol constant"
	| "compile-time constant"
	| "configurable default"
	| "advisory threshold"

/** What every limit states: its number, who sets it, its unit, and exactly what it bounds. */
interface Stated<N extends number | bigint> {
	readonly value: N
	readonly owner: string
	readonly unit: string
	readonly scope: string
}

/** A published limit's evidence: the exact source stating the number, quoted, and when it was verified. */
export interface PublishedEvidence {
	readonly kind: "published"
	readonly constraint: Constraint
	readonly source: `https://${string}`
	readonly quote: string
	readonly verified: VerifiedDate
}

/**
 * A measured limit's evidence: a resolvable record of the measurement (its run output or the suite that re-verifies
 * it), the interval observed, the environment and the workload, the result, how the value follows from it, and what
 * invalidates it.
 */
export interface MeasuredEvidence {
	readonly kind: "measured"
	readonly evidence: string
	readonly observed: string
	readonly environment: string
	readonly workload: string
	readonly result: string
	readonly decision: string
	readonly revalidate: string
}

/** A derived limit's evidence: the limits it is computed from, and why the arithmetic bounds what it bounds. */
export interface DerivedEvidence {
	readonly kind: "derived"
	readonly from: NonEmptyReadonlyArray<AnyLimit>
	readonly derivation: string
}

/** A limit with its evidence: published, measured or derived. */
export type Limit<N extends number | bigint = number> = Stated<N> &
	(PublishedEvidence | MeasuredEvidence | DerivedEvidence) & { readonly [limitBrand]: N }

/** A limit of either carrier, as a derived limit's inputs are. */
export type AnyLimit = Limit | Limit<bigint>

const mint = <N extends number | bigint>(
	limit: Stated<N> & (PublishedEvidence | MeasuredEvidence | DerivedEvidence)
): Limit<N> => Object.freeze(nominal<typeof limit, Limit<N>>()(limit))

/** A limit a source states. */
export const published = <N extends number | bigint>(
	limit: Stated<N> & Omit<PublishedEvidence, "kind">
): Limit<N> => mint({ ...limit, kind: "published" })

/** An operating limit a measurement supports. */
export const measured = <N extends number | bigint>(
	limit: Stated<N> & Omit<MeasuredEvidence, "kind">
): Limit<N> => mint({ ...limit, kind: "measured" })

/**
 * A limit computed from other limits: `compute` reads their values, so the derived number is never a second spelling
 * of theirs, and `derivation` says why the arithmetic bounds the resource. A data length the computation reads (the
 * width of a format grizzle prints, a list's length) needs no limit of its own.
 */
export const derived = <
	const From extends NonEmptyReadonlyArray<AnyLimit>,
	N extends number | bigint
>(limit: {
	readonly owner: string
	readonly unit: string
	readonly scope: string
	readonly from: From
	readonly derivation: string
	readonly compute: (from: From) => N
}): Limit<N> =>
	mint({
		value: limit.compute(limit.from),
		owner: limit.owner,
		unit: limit.unit,
		scope: limit.scope,
		kind: "derived",
		from: limit.from,
		derivation: limit.derivation
	})

/**
 * A bound parent set at or below this size takes the correlated LATERAL form. A LATERAL probe of LIMIT k per parent and
 * a DISTINCT ON or row_number pass over every group are genuinely different shapes, so the threshold between them is an
 * operating point, measured by bench/query/take.bench.ts (its R20 gate) across parent counts and group sizes.
 *
 * A function that decides a threshold takes it as its own parameter where a test drives that decision with a smaller
 * value; production passes this constant.
 */
export const lateralParentMax = measured({
	value: 256,
	owner: "grizzle's take(k) lowering (lower/shapes/take, lower/shapes/index.ts runsLargeForm)",
	unit: "bound parents",
	scope:
		"the distinct parents of one execution's bound parent set, at or below which take(k) per parent is the LATERAL probe",
	evidence:
		"bench/results/gates/query-take.full.json, the uncommitted record of `pnpm bench gates --only R20,R07` (bench/query/take.bench.ts, gate R20)",
	observed: "2026-11-05 10:01:00 to 10:07:00 UTC, one full-scale run",
	environment:
		"macOS (Darwin 27.0.0, an arm64 virtual machine) on 10 cores, Node 26.13.0, the local PostgreSQL 19rc1 cluster (scripts/pg/pin.env), grizzle 48256f8d6148 with the mechanism-only cutover uncommitted; load average 9 to 10 from other sessions on the machine",
	workload:
		"the Lab fixture's take bench: take(1) as DISTINCT ON and take(3) as row_number over every group, against the LATERAL probe of LIMIT k per parent, for group sizes 2, 8, 32 and 128 and bound parent sets of 1, 4, 16, 64, 256, 1024, 4096 and 16384, 15 timed samples each after a warm run",
	result:
		"execute p50 in ms, LATERAL / whole-relation: at 256 parents, groups of 2: 0.573/919.829 (k 1) and 0.614/0.737 (k 3); groups of 8: 0.591/948.179 and 1.992/14.858; groups of 32: 0.870/981.629 and 1.159/67.779; groups of 128: 1.222/921.952 and 1.735/209.854. At 1024 parents, groups of 2: 2.056/1.303 (k 1) and 1.753/1.755 (k 3), the first measured count at which the whole-relation form is the faster; groups of 8 or more keep the LATERAL probe the faster through 16384 parents. No throttling or errors; the machine's load is not separated per sample",
	decision:
		"256 is the largest measured parent count at which the LATERAL probe is no slower than the whole-relation pass at every group size and k; at the next measured count, 1024, the whole-relation pass is faster for groups of two. No headroom added: a parent count between 256 and 1024 is unmeasured",
	revalidate:
		"a PostgreSQL repin or a planner setting change; a change to either form's SQL (lower/shapes/take); a different machine or cluster configuration; a run at a parent count between 256 and 1024; a workload whose groups differ from the Lab fixture's"
})

/**
 * A tuple membership of declared closed facts whose disjunction holds at most this many equalities (its distinct tested
 * tuples times its tested columns) is rewritten into the disjunction (lower/optimize/finite); a larger one keeps its
 * VALUES join. A one-column membership is rewritten at any size: only a disjunction costs a row more than the join's
 * hash probe, so the two forms are genuinely different and the threshold between them is an operating point, measured
 * by bench/query/finite.bench.ts (its R07 gate) across fact counts.
 */
export const finiteMembershipMaxTerms = measured({
	value: 16,
	owner: "grizzle's finite membership rewrite (lower/optimize/finite)",
	unit: "equalities",
	scope:
		"the equalities of one tuple membership's disjunction (distinct tested tuples times tested columns), at or below which it is rewritten from its VALUES join",
	evidence:
		"bench/results/gates/query-finite.full.json, the uncommitted record of `pnpm bench gates --only R20,R07` (bench/query/finite.bench.ts, gate R07)",
	observed: "2026-11-05 10:01:00 to 10:01:17 UTC, one full-scale run",
	environment:
		"macOS (Darwin 27.0.0, an arm64 virtual machine) on 10 cores, Node 26.13.0, the local PostgreSQL 19rc1 cluster (scripts/pg/pin.env), grizzle 48256f8d6148 with the mechanism-only cutover uncommitted; load average 9 to 10 from other sessions on the machine",
	workload:
		"the Finite fixture's 200000 orders over twelve tiers: a two-column tuple membership of 2, 4, 8, 16, 32, 64, 128 and 256 facts, as the disjunction of each fact's equalities against the VALUES join, timed samples after a warm run",
	result:
		"execute p50 in ms, disjunction / VALUES join: 2 facts (4 equalities) 6.993/9.009; 4 (8) 7.105/8.665; 8 (16) 6.037/7.842; 16 (32) 16.168/8.370; 32 (64) 28.197/9.108; 64 (128) 48.511/8.315; 128 (256) 95.332/11.898; 256 (512) 337.983/15.370. No throttling or errors",
	decision:
		"16 is the largest measured equality count at which the disjunction is the faster form; at 32 the VALUES join is already twice as fast. The 64 this threshold held before the measurement was three times slower at that size. No headroom added: a count between 16 and 32 is unmeasured",
	revalidate:
		"a PostgreSQL repin or a planner setting change; a change to either form's SQL (lower/optimize/finite); a different machine; a run at an equality count between 16 and 32; a membership over more columns or another distribution"
})

const postgresSource = "https://github.com/postgres/postgres/blob/REL_19_RC1"

/**
 * PostgreSQL's explicit repetition limit: a pattern whose `{m}`, `{m,}` or `{m,n}` states a bound above it is refused
 * (scalar/regex/parse.ts), as PostgreSQL's regex compiler refuses it (regcomp.c scannum, against DUPMAX, which is
 * _POSIX2_RE_DUP_MAX). regguts.h defines it only where <limits.h> does not, and POSIX fixes it at the same value
 * (https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/limits.h.html, "{_POSIX2_RE_DUP_MAX} Maximum number of
 * repeated occurrences of a BRE or ERE interval expression; [...] Value: 255"), so every platform's build has it.
 */
export const regexMaxRepeat = published({
	value: 255,
	owner: "PostgreSQL 19rc1's regex compiler",
	unit: "repetitions",
	scope: "each bound of a counted repetition in one str.regex pattern",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/regex/regguts.h#L95`,
	quote: "#define _POSIX2_RE_DUP_MAX\t255",
	verified: "2026-11-05"
})

/**
 * What the four compile-space measures share of their evidence: the suite that compiles patterns planted at each and
 * drawn near them on the pinned PostgreSQL, test/pg/text/differential.test.ts, run by pnpm test:network.
 */
const compileSpaceRun = {
	observed:
		"the suite's last run in Vitest's record, from 2026-11-04 20:09:29 to 20:09:53 UTC, at a revision before this checkout's; the first measurement's interval is not recorded",
	environment:
		"PostgreSQL 19rc1 as scripts/pg/pin.env builds it, on the local cluster CONTRIBUTING.md sets up",
	workload:
		"one compile of each planted and drawn pattern's ARE, `SELECT 'x' COLLATE pg_catalog.pg_c_utf8 ~ $1::text` with the ARE as its parameter, on one owner session under a 60 s statement_timeout",
	result:
		"the suite passed in 24 s, as Vitest's record of each file's last run holds (node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json, SHA-256 4e9f397495c81884f158742f129f85e8c05f17b6ab00c1a3c384ddb37f7d0a6b when read on 2026-11-05, overwritten by the next run), so every planted and drawn pattern compiled, which it asserts; no compile time is recorded"
} as const

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
 */
export const regexMaxPositions = measured({
	value: 4_096,
	owner: "grizzle's text refinement (text/refinement.ts analyzeText)",
	unit: "NFA positions",
	scope: "one str.regex pattern's normalized IR, written out",
	evidence:
		'test/pg/text/differential.test.ts: its test "compiles admitted patterns at each budget inside PostgreSQL\'s regex compile space" compiles a pattern planted at this bound, `^(?:[a-z]{1,255}){16}$` (4,082 positions), and "compiles generated admitted nested-quantifier patterns near the budgets" each of 4,800 drawn nested-quantifier patterns the measures admit at 64 positions or more; the run output of the measurement that first set the value is not preserved',
	...compileSpaceRun,
	decision:
		"kept where the first measurement set it, at which the slowest planted chain of optional copies, `(?:a?){255}(?:b?){100}c`, compiled in tens of milliseconds on a cold backend",
	revalidate:
		"a PostgreSQL repin; a change to the ARE printer (text/are.ts) or to the IR's normalization (scalar/regex/ir.ts); a planted or drawn pattern refused as too complex"
})

/**
 * A compile-space measure (see regexMaxPositions): pairs of NFA states joined by a path of empty and anchor edges
 * (scalar/regex/nfa.ts closurePairs), whose arcs PostgreSQL's empty-arc removal (regc_nfa.c fixempties) copies.
 */
export const regexMaxClosurePairs = measured({
	value: 65_536,
	owner: "grizzle's text refinement (text/refinement.ts analyzeText)",
	unit: "pairs of NFA states",
	scope: "one str.regex pattern's NFA",
	evidence:
		'test/pg/text/differential.test.ts: its test "compiles admitted patterns at each budget inside PostgreSQL\'s regex compile space" compiles a pattern planted at this bound, `(?:a?){255}(?:b?){100}c` (64,981 pairs), and "compiles generated admitted nested-quantifier patterns near the budgets" each of 4,800 drawn nested-quantifier patterns the measures admit at 64 positions or more; the run output of the measurement that first set the value is not preserved',
	...compileSpaceRun,
	decision:
		"kept where the first measurement set it; far past it, `(?:(?:a?){255}){8}b` (2,041 positions, 2,120,771 pairs) is too complex for PostgreSQL",
	revalidate:
		"a PostgreSQL repin; a change to the NFA builder (scalar/regex/nfa.ts) or to the IR's normalization; a planted or drawn pattern refused as too complex"
})

/**
 * A compile-space measure (see regexMaxPositions): anchor positions, `^` and `$`, once counted repetitions are written
 * out (scalar/regex/ir.ts expandedAssertions), each of which PostgreSQL's constraint elimination (regc_nfa.c pullback,
 * pushfwd) moves by cloning the states it crosses.
 */
export const regexMaxAnchors = measured({
	value: 8,
	owner: "grizzle's text refinement (text/refinement.ts analyzeText)",
	unit: "anchor positions",
	scope: "one str.regex pattern's normalized IR, written out",
	evidence:
		'test/pg/text/differential.test.ts: its test "compiles admitted patterns at each budget inside PostgreSQL\'s regex compile space" compiles patterns planted at this bound, `(?:$|a|){4}(?:^|a|){4}b` and `(?:^|.{1,127}|$){2,4}b` (8 anchors each), and "compiles generated admitted nested-quantifier patterns near the budgets" each of 4,800 drawn nested-quantifier patterns the measures admit at 64 positions or more; the run output of the measurement that first set the value is not preserved',
	...compileSpaceRun,
	decision:
		"kept where the first measurement set it; past it, `(?:(?:a|$){1,3}){12}(?:^)?b` (37 anchors) is too complex for PostgreSQL, and `(?:\\Z|a|){8}(?:\\A|a|){8}b` (16) takes seconds to compile",
	revalidate:
		"a PostgreSQL repin; a change to the ARE printer or to the IR's normalization; a planted or drawn pattern refused as too complex"
})

/**
 * A compile-space measure (see regexMaxPositions): anchor positions times NFA positions, both written out, the states
 * constraint elimination may clone.
 */
export const regexMaxAnchorWeight = measured({
	value: 8_192,
	owner: "grizzle's text refinement (text/refinement.ts analyzeText)",
	unit: "anchor positions times NFA positions",
	scope: "one str.regex pattern's normalized IR, written out",
	evidence:
		'test/pg/text/differential.test.ts: its test "compiles admitted patterns at each budget inside PostgreSQL\'s regex compile space" compiles a pattern planted at this bound, `^(?:[a-z]{1,255}){16}$` (2 anchors over 4,082 positions, 8,164), and "compiles generated admitted nested-quantifier patterns near the budgets" each of 4,800 drawn nested-quantifier patterns the measures admit at 64 positions or more; the run output of the measurement that first set the value is not preserved',
	...compileSpaceRun,
	decision: "kept where the first measurement set it",
	revalidate:
		"a PostgreSQL repin; a change to the ARE printer or to the IR's normalization; a planted or drawn pattern refused as too complex"
})

/**
 * What the two subset-construction bounds share of their evidence: one run of `pnpm bench dfa` (bench/dfa/main.ts),
 * whose output is not committed.
 */
const subsetConstructionRun = {
	evidence:
		"bench/results/dfa/dfa-2026-11-05T080355.json, the uncommitted record of `pnpm bench dfa` (bench/dfa/main.ts) at grizzle 48256f8d6148 with a dirty tree: text/dfa.ts minimalDfa under both limits, seven runs a pattern in one process, the first cold, then one run under 16 times each limit, on 29 patterns analyzeText admits: `^(?:a|b)*a(?:a|b){k}$` for k from 6 to 12, 14 and 16 (minimal DFAs of 2^(k+1) states), wide classes over chains of up to 255 copies, chains of 255 copies, and chains of up to 4,096 distinct sets",
	observed: "2026-11-05 02:03:54 to 02:04:11 CST (UTC-6)",
	environment:
		"macOS 27.0.1 (Darwin 27.0.0) on a VirtualMac2,1, Apple M2 Max (Virtual) with 10 cores (sysctl hw.ncpu) and 64 GiB; Node 26.13.0 (V8 14.6.202.34-node.40), one single-threaded process; load average 9.9 to 11.3 over the 10 cores from other sessions throughout, so the times are a loaded machine's",
	workload:
		"one pattern's construction at a time, the process's only work, over NFAs of 15 to 4,117 states, parsing and the NFA build untimed; `^(?:.{0,255}){16}$`, the slowest pattern of the unverifiable run this one replaces, is refused by regexMaxClosurePairs and never reaches the construction",
	revalidate:
		"a change to the subset construction, its alphabet, the minimization or the canonical form (text/dfa.ts), or to the NFA builder (scalar/regex/nfa.ts); a Node or V8 upgrade; a pattern whose construction under the limits takes longer than the slowest here"
} as const

/**
 * The DFA states a pattern's subset construction may create (text/dfa.ts minimalDfa), a bound on the compiling
 * process's own work. Past it, or past regexDfaMaxWork, the analysis knows the language by its IR alone: the pattern
 * is enforced by its ARE with structural bounds and keyed by its IR ("ir:", text/refinement.ts keyOf). It refuses
 * nothing, but a change of either bound changes the key, and so the domain digest a snapshot records, of every pattern
 * whose construction lands between the two values.
 */
export const regexDfaMaxStates = measured({
	value: 2_048,
	owner: "grizzle's text analysis (text/dfa.ts minimalDfa)",
	unit: "DFA states",
	scope: "the subset construction of one pattern's automaton, in the compiling process",
	...subsetConstructionRun,
	result:
		"at k = 9 the construction completes, 1,024 minimal states of 1,026 created, in 6.6 ms median; for k = 10, 11, 12, 14 and 16 it stops at this bound in 2.5 to 3.9 ms median, 7.1 ms at worst, where the whole constructions take 15.3, 33.5 and 66.4 ms for k = 10 to 12 (2,050 to 8,194 states) and reach 16 times the bound (32,768 states) in 63 and 123 ms for k = 14 and 16; `(?:[a-z]{0,255}x){2}` and `(?:[a-z]{0,255}x){8}`, which it cuts in 22.6 and 12.0 ms median, 39.3 ms at worst, reach 16 times it in 925 and 300 ms; memory not measured",
	decision:
		"kept at 2,048: every construction it cuts stops within 40 ms here, well inside what regexDfaMaxWork allows, while past it the run shows constructions of 32,768 states taking up to 925 ms; a change would change the key, and so the domain digest, of every pattern whose construction lands between the two values; no headroom beyond the run is claimed"
})

/**
 * The NFA-state visits a pattern's subset construction is charged (text/dfa.ts minimalDfa): the initial closure's
 * states, then for every transition the states of its source subset and of its target, whether the target is computed
 * or is the restart closure computed once; the other bound on the compiling process's own work, with
 * regexDfaMaxStates. It leaves out the alphabet's partition, which grows with the segments the pattern's sets hold, and
 * the canonical form's walk over every segment for every class, at most regexDfaMaxStates times the segments.
 */
export const regexDfaMaxWork = measured({
	value: 2_097_152,
	owner: "grizzle's text analysis (text/dfa.ts minimalDfa)",
	unit: "NFA-state visits",
	scope: "the subset construction of one pattern's automaton, in the compiling process",
	...subsetConstructionRun,
	result:
		"the constructions it cuts stop in 10.8 to 173.1 ms median, 229.0 ms at worst (`^(?:<2,040 distinct code points>|(?:.{255}){8})$`, at 231 states); among them `^(?:[a-z]{0,255}){8}$`, `^(?:[a-z]{1,255}){16}$` and `^(?:.{0,255}){8}$` stop in 104.4, 138.8 and 104.7 ms median, where their whole constructions take 336, 1,754 and 311 ms (5.5, 23.6 and 5.5 million visits), and the slowest of them reaches 16 times the bound in 3,285 ms; the slowest construction it admits, `<512 classes of 8 scattered code points>` (513 minimal states, 789,506 visits), completes in 157.1 ms median, 171.7 ms at worst; memory not measured",
	decision:
		"kept at 2,097,152: at it every construction of the run, cut or completed, ends within 230 ms on a machine loaded to its core count, while the constructions it cuts take up to 1.8 s whole and one stopped at 16 times the bound took 3.3 s; a change would change the key, and so the domain digest, of every pattern whose construction lands between the two values; no headroom beyond the run is claimed"
})

/**
 * The longest string V8 builds, in UTF-16 code units: a statement, drafted file, snapshot.json, meta.json or canonical
 * text that would be longer is refused as ResourceBound (stringLength) before it is built, where building it would
 * throw RangeError "Invalid string length". It is String::kMaxLength on a 64-bit platform, which node:buffer's
 * constants.MAX_STRING_LENGTH reports (test/unit/core/lines.test.ts reads it).
 */
export const maxStringLength = published({
	value: 2 ** 29 - 24,
	owner: "V8 14.6, Node 26.13.0's JavaScript engine",
	unit: "UTF-16 code units",
	scope: "one JavaScript string",
	constraint: "compile-time constant",
	source: "https://github.com/nodejs/node/blob/v26.13.0/deps/v8/include/v8-primitive.h#L127",
	quote: "kApiSystemPointerSize == 4 ? (1 << 28) - 16 : (1 << 29) - 24;",
	verified: "2026-11-05"
})

/**
 * The most columns one table of PostgreSQL holds: a stored relation's table with the tag columns added to it, a view, a
 * materialized view and a write program's carrier, each refused as ResourceBound (tableColumns) where it is emitted,
 * since PostgreSQL refuses the statement with 54011, "tables can have at most 1600 columns". A column the table once
 * held and dropped counts too, which a migration cannot see: PostgreSQL refuses such an ADD COLUMN itself.
 */
export const tableMaxColumns = published({
	value: 1_600,
	owner: "PostgreSQL 19rc1",
	unit: "columns",
	scope: "one table, view or materialized view, its dropped columns included",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/access/htup_details.h#L48`,
	quote: "#define MaxHeapAttributeNumber\t1600",
	verified: "2026-11-05"
})

/**
 * The most entries one select list holds, a SELECT's target list or a RETURNING list, each refused as ResourceBound
 * (selectList) where it is printed, since PostgreSQL refuses a longer one with 54011, "target lists can have at most
 * 1664 entries" (src/backend/parser/parse_node.c free_parsestate).
 */
export const selectMaxEntries = published({
	value: 1_664,
	owner: "PostgreSQL 19rc1",
	unit: "entries",
	scope: "one target list of one query level",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/access/htup_details.h#L34`,
	quote: "#define MaxTupleAttributeNumber 1664",
	verified: "2026-11-05"
})

/** PostgreSQL's MaxAllocSize, the largest chunk its allocator hands out, which bounds the messages a backend reads. */
export const maxAllocSize = published({
	value: 0x3fff_ffff,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "one allocation of a backend",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/utils/memutils.h#L40`,
	quote: "#define MaxAllocSize\t((Size) 0x3fffffff)",
	verified: "2026-11-05"
})

/**
 * The longest message a PostgreSQL backend reads from a client, as the message's Int32 length counts it, itself
 * included: a Query or Parse message holding a statement, or a Bind message carrying one execution's parameters, each
 * read under it by SocketBackend (src/backend/tcop/postgres.c). A longer one is "invalid message length"
 * (src/backend/libpq/pqcomm.c pq_getmessage), after which the backend ends the connection without an ErrorResponse,
 * so a statement whose text is longer, in UTF-8 bytes, is refused as ResourceBound (statementBytes) when it is printed,
 * and a statement whose Bind message would be longer is refused on the host as InputTooLarge before its flight is sent
 * (the shell's wire/batch.ts).
 */
export const messageMaxBytes = derived({
	owner: "PostgreSQL 19rc1's frontend/backend protocol",
	unit: "bytes",
	scope: "one message from client to server, as its Int32 length counts it, itself included",
	from: [maxAllocSize],
	derivation: `a protocol constant, PQ_LARGE_MESSAGE_LIMIT, which libpq.h defines as one less than MaxAllocSize: "#define PQ_LARGE_MESSAGE_LIMIT\t(MaxAllocSize - 1)" (${postgresSource}/src/include/libpq/libpq.h#L34, verified 2026-11-05)`,
	compute: ([alloc]) => alloc.value - 1
})

/**
 * The most placeholders one statement binds: a Bind message counts its parameter values in an unsigned 16-bit field,
 * `numParams = pq_getmsgint(input_message, 2);`
 * (https://github.com/postgres/postgres/blob/REL_19_RC1/src/backend/tcop/postgres.c#L1734), and the count must be the
 * statement's highest `$n` ("bind message supplies %d parameters, but prepared statement \"%s\" requires %d"), so a
 * statement of more is refused as ResourceBound (statementParams) when it is printed.
 */
export const statementMaxParams = published({
	value: 2 ** 16 - 1,
	owner: "PostgreSQL 19rc1's frontend/backend protocol",
	unit: "placeholders",
	scope: "one statement",
	constraint: "protocol constant",
	source: `${postgresSource}/doc/src/sgml/limits.sgml#L115-L116`,
	quote: "<entry>query parameters</entry> <entry>65,535</entry>",
	verified: "2026-11-05"
})
