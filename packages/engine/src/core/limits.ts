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

/** The PostgreSQL release every published PostgreSQL limit is read from, REL_19_RC1's tree. */
export const postgresSource = "https://github.com/postgres/postgres/blob/REL_19_RC1"

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
		"a PostgreSQL repin; a change to the ARE printer (scalar/regex/are.ts) or to the IR's normalization (scalar/regex/ir.ts); a planted or drawn pattern refused as too complex"
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
		"bench/results/dfa/dfa-2026-11-05T080355.json, the uncommitted record of `pnpm bench dfa` (bench/dfa/main.ts) at grizzle 48256f8d6148 with a dirty tree: scalar/regex/dfa.ts minimalDfa under both limits, seven runs a pattern in one process, the first cold, then one run under 16 times each limit, on 29 patterns analyzeText admits: `^(?:a|b)*a(?:a|b){k}$` for k from 6 to 12, 14 and 16 (minimal DFAs of 2^(k+1) states), wide classes over chains of up to 255 copies, chains of 255 copies, and chains of up to 4,096 distinct sets",
	observed: "2026-11-05 02:03:54 to 02:04:11 CST (UTC-6)",
	environment:
		"macOS 27.0.1 (Darwin 27.0.0) on a VirtualMac2,1, Apple M2 Max (Virtual) with 10 cores (sysctl hw.ncpu) and 64 GiB; Node 26.13.0 (V8 14.6.202.34-node.40), one single-threaded process; load average 9.9 to 11.3 over the 10 cores from other sessions throughout, so the times are a loaded machine's",
	workload:
		"one pattern's construction at a time, the process's only work, over NFAs of 15 to 4,117 states, parsing and the NFA build untimed; `^(?:.{0,255}){16}$`, the slowest pattern of the unverifiable run this one replaces, is refused by regexMaxClosurePairs and never reaches the construction",
	revalidate:
		"a change to the subset construction, its alphabet, the minimization or the canonical form (scalar/regex/dfa.ts), or to the NFA builder (scalar/regex/nfa.ts); a Node or V8 upgrade; a pattern whose construction under the limits takes longer than the slowest here"
} as const

/**
 * The DFA states a pattern's subset construction may create (scalar/regex/dfa.ts minimalDfa), a bound on the compiling
 * process's own work. Past it, or past regexDfaMaxWork, the analysis knows the language by its IR alone: the pattern
 * is enforced by its ARE with structural bounds and keyed by its IR ("ir:", text/refinement.ts keyOf). It refuses
 * nothing, but a change of either bound changes the key, and so the domain digest a snapshot records, of every pattern
 * whose construction lands between the two values.
 */
export const regexDfaMaxStates = measured({
	value: 2_048,
	owner: "grizzle's text analysis (scalar/regex/dfa.ts minimalDfa)",
	unit: "DFA states",
	scope: "the subset construction of one pattern's automaton, in the compiling process",
	...subsetConstructionRun,
	result:
		"at k = 9 the construction completes, 1,024 minimal states of 1,026 created, in 6.6 ms median; for k = 10, 11, 12, 14 and 16 it stops at this bound in 2.5 to 3.9 ms median, 7.1 ms at worst, where the whole constructions take 15.3, 33.5 and 66.4 ms for k = 10 to 12 (2,050 to 8,194 states) and reach 16 times the bound (32,768 states) in 63 and 123 ms for k = 14 and 16; `(?:[a-z]{0,255}x){2}` and `(?:[a-z]{0,255}x){8}`, which it cuts in 22.6 and 12.0 ms median, 39.3 ms at worst, reach 16 times it in 925 and 300 ms; memory not measured",
	decision:
		"kept at 2,048: every construction it cuts stops within 40 ms here, well inside what regexDfaMaxWork allows, while past it the run shows constructions of 32,768 states taking up to 925 ms; a change would change the key, and so the domain digest, of every pattern whose construction lands between the two values; no headroom beyond the run is claimed"
})

/**
 * The NFA-state visits a pattern's subset construction is charged (scalar/regex/dfa.ts minimalDfa): the initial closure's
 * states, then for every transition the states of its source subset and of its target, whether the target is computed
 * or is the restart closure computed once; the other bound on the compiling process's own work, with
 * regexDfaMaxStates. It leaves out the alphabet's partition, which grows with the segments the pattern's sets hold, and
 * the canonical form's walk over every segment for every class, at most regexDfaMaxStates times the segments.
 */
export const regexDfaMaxWork = measured({
	value: 2_097_152,
	owner: "grizzle's text analysis (scalar/regex/dfa.ts minimalDfa)",
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
 * The most bytes a character of a UTF-8 database takes, pg_database_encoding_max_length() there: the widest UTF-8
 * sequence PostgreSQL reads, which translate allocates for each byte of its operand.
 */
export const utf8EncodingMaxBytes = published({
	value: 4,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "one character of a UTF-8 database, the maxmblen pg_wchar_table holds for PG_UTF8",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/common/wchar.c#L1872`,
	quote:
		"[PG_UTF8] = {pg_utf2wchar_with_len, pg_wchar2utf_with_len, pg_utf_mblen, pg_utf_dsplen, pg_utf8_verifychar, pg_utf8_verifystr, 4},",
	verified: "2026-11-06"
})

/** A varlena's header, VARHDRSZ, which translate's result allocation counts beside its characters. */
export const varlenaHeaderBytes = published({
	value: 4,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the header of one variable-length datum, uncompressed and in line: a text among them",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/c.h#L787`,
	quote: "#define VARHDRSZ\t\t((int32) sizeof(int32))",
	verified: "2026-11-06"
})

/**
 * The longest text, in UTF-8 bytes, PostgreSQL's translate reads: it allocates its result for the worst case, a widest
 * character for every byte of its operand, with its header, and refuses an allocation past MaxAllocSize with 54000,
 * "requested length too large". So a query translates only an operand whose pattern bounds its bytes within this, and a
 * check or generated column that translates a longer text fails its write.
 */
export const translateMaxBytes = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the operand of one translate(text, text, text) call",
	from: [maxAllocSize, utf8EncodingMaxBytes, varlenaHeaderBytes],
	derivation: `translate refuses "if (unlikely(pg_mul_s32_overflow(pg_database_encoding_max_length(), m, &bytelen)) || unlikely(pg_add_s32_overflow(bytelen, VARHDRSZ, &bytelen)) || unlikely(!AllocSizeIsValid(bytelen)))" over its operand's m bytes (${postgresSource}/src/backend/utils/adt/oracle_compat.c#L854-L864, verified 2026-11-06), and "#define AllocSizeIsValid(size) ((Size) (size) <= MaxAllocSize)" (${postgresSource}/src/include/utils/memutils.h#L42), so m is at most (MaxAllocSize - VARHDRSZ) / maxmblen, rounded down`,
	compute: ([alloc, width, header]) => Math.floor((alloc.value - header.value) / width.value)
})

/**
 * The most bytes one StringInfo, PostgreSQL's growable string buffer, holds: enlargeStringInfo refuses to grow a buffer
 * past one byte short of MaxAllocSize, keeping a byte for its terminator. Every text PostgreSQL builds piecewise lives
 * in one, string_agg's result and format's among them, so a closed relation's pack of rows, whose DO block builds its
 * constant as text, one character per bit, and EXECUTEs the CREATE FUNCTION format builds around it, packs a constant
 * only while that statement fits one buffer; past it the pack is stated as its literal (physical/ddl/constants.ts).
 */
export const stringBufferMaxBytes = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope:
		"one StringInfo's data: a text PostgreSQL builds piecewise, the statement a pack's DO block EXECUTEs among them",
	from: [maxAllocSize],
	derivation: `enlargeStringInfo refuses "if (((Size) needed) >= (MaxAllocSize - (Size) str->len))" (${postgresSource}/src/common/stringinfo.c#L357, verified 2026-11-05), so a buffer's length and the bytes it grows by are at most MaxAllocSize - 1`,
	compute: ([alloc]) => alloc.value - 1
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
 * The longest statement that packs a closed relation's constant from its rows, a line per row (physical/ddl/constants.ts
 * packFormOf): it is sent whole as one Query message's text, and drafted whole into one string of its migration file,
 * which migrate reads back as one string, so it fits both. Past it, or past the statement its DO block EXECUTEs fitting
 * one string buffer (stringBufferMaxBytes), the pack is stated as one bit-string literal, which `grizzle check` decodes
 * back to the rows.
 */
export const rowsPackMaxBytes = derived({
	owner: "PostgreSQL 19rc1's frontend/backend protocol and V8 14.6",
	unit: "bytes",
	scope: "one statement packing a closed relation's constant from its rows, in UTF-8 bytes",
	from: [messageMaxBytes, maxStringLength],
	derivation:
		"the lesser of the two: a Query message carries at most messageMaxBytes, and one string holds at most maxStringLength UTF-16 code units, which a text's UTF-8 bytes never undercount (a code point of one unit is 1 to 3 bytes, a pair of units 4)",
	compute: ([message, string]) => Math.min(message.value, string.value)
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

const datatypeSgml = `${postgresSource}/doc/src/sgml/datatype.sgml`

/** The least smallint. */
export const int2Min = published({
	value: -32768,
	owner: "PostgreSQL 19rc1",
	unit: "a smallint value",
	scope: "every smallint value: a column, a parameter, a literal, an endpoint",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L374`,
	quote: "<entry>-32768 to +32767</entry>",
	verified: "2026-11-05"
})

/** The greatest smallint. */
export const int2Max = published({
	value: 32767,
	owner: "PostgreSQL 19rc1",
	unit: "a smallint value",
	scope: "every smallint value: a column, a parameter, a literal, an endpoint",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L374`,
	quote: "<entry>-32768 to +32767</entry>",
	verified: "2026-11-05"
})

/** The least integer. */
export const int4Min = published({
	value: -2147483648,
	owner: "PostgreSQL 19rc1",
	unit: "an integer value",
	scope: "every integer value: a column, a parameter, a literal, an endpoint, a span width",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L380`,
	quote: "<entry>-2147483648 to +2147483647</entry>",
	verified: "2026-11-05"
})

/**
 * The greatest integer, which is also INT_MAX, a C int's greatest value: PostgreSQL's integer is its int32, and a C
 * int is 32 bits on every platform it builds on.
 */
export const int4Max = published({
	value: 2147483647,
	owner: "PostgreSQL 19rc1",
	unit: "an integer value",
	scope: "every integer value: a column, a parameter, a literal, an endpoint, a span width",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L380`,
	quote: "<entry>-2147483648 to +2147483647</entry>",
	verified: "2026-11-05"
})

/** The least bigint, and money's least count of minor units. */
export const int8Min = published({
	value: -9223372036854775808n,
	owner: "PostgreSQL 19rc1",
	unit: "a bigint value",
	scope: "every bigint value and every money count of minor units, a row count included",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L386`,
	quote: "<entry>-9223372036854775808 to +9223372036854775807</entry>",
	verified: "2026-11-05"
})

/** The greatest bigint, and money's greatest count of minor units. */
export const int8Max = published({
	value: 9223372036854775807n,
	owner: "PostgreSQL 19rc1",
	unit: "a bigint value",
	scope: "every bigint value and every money count of minor units, a row count included",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L386`,
	quote: "<entry>-9223372036854775808 to +9223372036854775807</entry>",
	verified: "2026-11-05"
})

/** BITS_PER_BYTE, the bits PostgreSQL counts in one byte of a datum. */
export const bitsPerByte = published({
	value: 8,
	owner: "PostgreSQL 19rc1",
	unit: "bits",
	scope: "one byte of a datum, as a bit string's length and a type's width count it",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/pg_config_manual.h#L111`,
	quote: "#define BITS_PER_BYTE\t\t8",
	verified: "2026-11-05"
})

/**
 * The most codes one roster numbers, its holes included. A closed-id field stores its handle's code as a smallint, and
 * a roster numbers its handles from 0 in the order they were declared, a removed handle leaving its code a hole, so a
 * code is one of smallint's non-negative values. A code is never negative because it is a digit of the mixed-radix
 * index a closed relation's constant is read at, where a negative one would borrow from the digit above it.
 */
export const rosterMaxCodes = derived({
	owner: "PostgreSQL 19rc1",
	unit: "codes",
	scope:
		"the codes of one roster, its live handles' and its holes, each the smallint a closed-id column stores",
	from: [int2Max],
	derivation: "smallint's non-negative values, 0 to its greatest: one code each",
	compute: ([max]) => max.value + 1
})

const pgTypeDat = `${postgresSource}/src/include/catalog/pg_type.dat`

/** A fixed-size type's typlen, as pg_type.dat's entry for it at `line` states it: the bytes one datum occupies. */
const typlen = (type: string, value: number, line: number, quote: string): Limit =>
	published({
		value,
		owner: "PostgreSQL 19rc1",
		unit: "bytes",
		scope: `one ${type} datum, in a heap tuple and in an index entry`,
		constraint: "compile-time constant",
		source: `${pgTypeDat}#L${line}`,
		quote,
		verified: "2026-11-05"
	})

/**
 * The typlen of each fixed-size type a field, a range's endpoint or a varlena's part is: a smallint's is the bytes one
 * code takes in its closed-id column.
 */
export const typlens = {
	int2: typlen("smallint", 2, 62, "typname => 'int2', typlen => '2', typbyval => 't'"),
	int4: typlen("integer", 4, 74, "typname => 'int4', typlen => '4', typbyval => 't'"),
	int8: typlen("bigint", 8, 57, "typname => 'int8', typlen => '8', typbyval => 't'"),
	float4: typlen("real", 4, 220, "typname => 'float4', typlen => '4', typbyval => 't'"),
	float8: typlen("double precision", 8, 225, "typname => 'float8', typlen => '8', typbyval => 't'"),
	money: typlen("money", 8, 239, "typname => 'money', typlen => '8', typbyval => 't'"),
	bool: typlen("boolean", 1, 36, "typname => 'bool', typlen => '1', typbyval => 't'"),
	oid: typlen("oid", 4, 89, "typname => 'oid', typlen => '4', typbyval => 't'"),
	uuid: typlen("uuid", 16, 409, "typname => 'uuid', typlen => '16', typbyval => 'f'"),
	date: typlen("date", 4, 288, "typname => 'date', typlen => '4', typbyval => 't'")
} as const

/**
 * The longest bit string PostgreSQL holds, VARBITMAXLEN, and so the most bits of one constant: the bit varying a
 * closed side compiles to, which its IMMUTABLE function returns. A longer string is refused as it is built, "bit string
 * length exceeds the maximum allowed (%d)" (src/backend/utils/adt/varbit.c). The int32 length every bit string
 * carries (VarBit's bit_len) holds INT_MAX at most, and the length stops BITS_PER_BYTE - 1 bits short of it so that
 * rounding it up to whole bytes, the largest addition PostgreSQL makes to a length (VARBITTOTALLEN), cannot overflow.
 */
export const constantMaxBits = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bits",
	scope: "one bit varying value: a closed side's constant, as its function returns it",
	from: [int4Max, bitsPerByte],
	derivation: `varbit.h's VARBITMAXLEN, "#define VARBITMAXLEN\t\t(INT_MAX - BITS_PER_BYTE + 1)" (${postgresSource}/src/include/utils/varbit.h#L83, verified 2026-11-05), INT_MAX being the greatest integer`,
	compute: ([intMax, bits]) => intMax.value - bits.value + 1
})

/**
 * The most payload codes one cell of a closed relation's constant holds, its cells read as integers: a cell holds 0 for
 * absent and 1 + c for payload code c, and a read casts its bits to integer, which reads them as an unsigned 32-bit
 * number returned as a signed int4, so a value past the greatest integer reads negative and a cell of more than 32 bits
 * is "integer out of range". A payload space of more codes is refused when its constant is planned.
 */
export const cellMaxCodes = derived({
	owner: "PostgreSQL 19rc1",
	unit: "codes",
	scope:
		"the payload space of one closed relation or side: the codes 1 + c its cells hold, each read as an integer",
	from: [int4Max],
	derivation: `bittoint4 reads a cell's bits as uint32 and returns it as int32, refusing more than 32 bits: "if (VARBITLEN(arg) > sizeof(result) * BITS_PER_BYTE)" and "PG_RETURN_INT32(result)" (${postgresSource}/src/backend/utils/adt/varbit.c#L1593, verified 2026-11-05); the greatest cell, 1 + (codes - 1), is at most the greatest integer`,
	compute: ([max]) => max.value
})

/**
 * MaxAttrSize, the longest declared size of a data field of char(n) and similar types: for bit(n) and bit varying(n),
 * the bytes their declared length comes to at most.
 */
const maxAttrSize = published({
	value: 10 * 1024 * 1024,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope:
		"the declared size of one data field of char(n) and similar types, bit(n) and bit varying(n) among them",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/access/htup_details.h#L626`,
	quote: "#define MaxAttrSize\t\t(10 * 1024 * 1024)",
	verified: "2026-11-05"
})

/**
 * The longest length a bit(n) or bit varying(n) type may declare, and so the most bits of one set column, which holds a
 * bit for each code of its roster: PostgreSQL refuses a longer type modifier, "length for type %s cannot exceed %d". A
 * constant is a bit varying with no declared length, so constantMaxBits bounds it instead.
 */
export const bitColumnMaxBits = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bits",
	scope:
		"the declared length n of one bit(n) or bit varying(n) type: a set column's, a cell's cast",
	from: [maxAttrSize, bitsPerByte],
	derivation: `MaxAttrSize in bits, the longest length the type modifier of bit and bit varying admits: "if (*tl > (MaxAttrSize * BITS_PER_BYTE))" (${postgresSource}/src/backend/utils/adt/varbit.c#L112, verified 2026-11-05)`,
	compute: ([attr, bits]) => attr.value * bits.value
})

/**
 * The size of PostgreSQL's name type, NAMEDATALEN, its terminating zero byte included: what an identifier and a
 * roster's handle in its names constant are held in.
 */
export const namedatalen = published({
	value: 64,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "a name value, its terminating zero included: an identifier, a roster's handle",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/pg_config_manual.h#L39`,
	quote: "#define NAMEDATALEN 64",
	verified: "2026-11-05"
})

/**
 * The most UTF-8 bytes of one roster handle. A roster's names constant holds its handles as one name[], and a name
 * keeps at most NAMEDATALEN - 1 bytes of its text, clipping a longer one at a character boundary: a longer handle would
 * decode clipped, and two that share their first NAMEDATALEN - 1 bytes would decode alike.
 */
export const handleMaxBytes = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "one roster handle in UTF-8, as its roster's names constant holds it in a name",
	from: [namedatalen],
	derivation: `NAMEDATALEN less its terminating zero, as namein clips a name: "len = pg_mbcliplen(s, len, NAMEDATALEN - 1);" (${postgresSource}/src/backend/utils/adt/name.c, verified 2026-11-05)`,
	compute: ([n]) => n.value - 1
})

/** The pinned build's block size, BLCKSZ: the page a heap tuple must fit, and every index entry a share of. */
export const blockSize = published({
	value: 8192,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope:
		"one page of a table or of a B-tree or GiST index of the pinned build, which scripts/pg/build.sh configures by default",
	constraint: "configurable default",
	source: `${postgresSource}/meson_options.txt#L5-L8`,
	quote:
		"option('blocksize', type: 'combo', choices: ['1', '2', '4', '8', '16', '32'], value: '8', description: 'Relation block size, in kilobytes')",
	verified: "2026-11-05"
})

/**
 * The greatest alignment PostgreSQL rounds a tuple and its parts to, MAXIMUM_ALIGNOF: 8 on every platform it builds
 * on, the alignment of int64 and double. An entry measured at the greatest alignment is at least its size at any.
 */
export const maxAlign = published({
	value: 8,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope:
		"the alignment of a heap or index tuple, its header, its attributes and its line pointer's share of a page",
	constraint: "compile-time constant",
	source: `${postgresSource}/meson.build#L1877-L1878`,
	quote:
		"we intentionally do not consider any types wider than 64 bits, as allowing MAXIMUM_ALIGNOF to exceed 8 would be too much of a penalty for disk and memory space",
	verified: "2026-11-05"
})

const storageSgml = `${postgresSource}/doc/src/sgml/storage.sgml`

/** A page's header, PageHeaderData: the bytes every page of a table or an index begins with. */
export const pageHeaderBytes = published({
	value: 24,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the header of every page",
	constraint: "compile-time constant",
	source: `${storageSgml}#L763`,
	quote: "24 bytes long. Contains general information about the page",
	verified: "2026-11-05"
})

/** One line pointer, ItemIdData: the bytes every item a page holds, a heap tuple or an index entry, takes beside it. */
export const itemIdBytes = published({
	value: 4,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the line pointer of every item on a page",
	constraint: "compile-time constant",
	source: `${storageSgml}#L769-L770`,
	quote:
		"Array of item identifiers pointing to the actual items. Each entry is an (offset,length) pair. 4 bytes per item.",
	verified: "2026-11-05"
})

/**
 * A heap tuple's fixed header, SizeofHeapTupleHeader: the bytes every row begins with, before its null bitmap and its
 * columns, which the header's t_hoff rounds up to the greatest alignment.
 */
export const heapTupleHeaderBytes = published({
	value: 23,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope:
		"the fixed header of every heap tuple, before its null bitmap: one row of a stored relation's table",
	constraint: "compile-time constant",
	source: `${storageSgml}#L955-L956`,
	quote: "There is a fixed-size header (occupying 23 bytes on most machines)",
	verified: "2026-11-05"
})

/**
 * A TOAST pointer, TOAST_POINTER_SIZE: the in-line bytes a variable-length column's value moved out of line keeps in
 * its row, whatever the value's size, so the least a varlena column can cost a row.
 */
export const toastPointerBytes = published({
	value: 18,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the in-line pointer of one variable-length value stored out of line",
	constraint: "compile-time constant",
	source: `${storageSgml}#L436-L437`,
	quote:
		"the total size of an on-disk TOAST pointer datum is therefore 18 bytes regardless of the actual size of the represented value",
	verified: "2026-11-05"
})

/** `n` rounded up to a multiple of the alignment `a`, as PostgreSQL's TYPEALIGN rounds a size. */
export const alignUp = (n: number, a: number): number => Math.ceil(n / a) * a

/**
 * The largest heap tuple, MaxHeapTupleSize, its header and alignment padding included: a row of a stored relation's
 * table must fit one otherwise empty page beside its line pointer, and a fixed-width column is never moved out of line,
 * so a row whose fixed-width columns, its generated cells and selected terms among them, can pass it cannot be stored.
 */
export const heapTupleMaxBytes = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope:
		"one heap tuple, its header and alignment padding included: one row of a stored relation's table",
	from: [blockSize, maxAlign, pageHeaderBytes, itemIdBytes],
	derivation: `htup_details.h's MaxHeapTupleSize, "#define MaxHeapTupleSize  (BLCKSZ - MAXALIGN(SizeOfPageHeaderData + sizeof(ItemIdData)))" (${postgresSource}/src/include/access/htup_details.h#L601, verified 2026-11-05): a page less its header and the one line pointer that points at the tuple, rounded up to the greatest alignment, since a heap page has no special space`,
	compute: ([block, align, header, itemId]) =>
		block.value - alignUp(header.value + itemId.value, align.value)
})
