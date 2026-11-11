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

/** The one mint of a Limit: a limit with its evidence, frozen by the constructor that built it, branded. */
/* @__NO_SIDE_EFFECTS__ */
const mint = <N extends number | bigint>(
	limit: Readonly<Stated<N> & (PublishedEvidence | MeasuredEvidence | DerivedEvidence)>
): Limit<N> => nominal<typeof limit, Limit<N>>()(limit)

/** A limit a source states. */
/* @__NO_SIDE_EFFECTS__ */
export const published = <N extends number | bigint>(
	limit: Stated<N> & Omit<PublishedEvidence, "kind">
): Limit<N> => mint(Object.freeze({ ...limit, kind: "published" }))

/** An operating limit a measurement supports. */
/* @__NO_SIDE_EFFECTS__ */
export const measured = <N extends number | bigint>(
	limit: Stated<N> & Omit<MeasuredEvidence, "kind">
): Limit<N> => mint(Object.freeze({ ...limit, kind: "measured" }))

/**
 * A limit computed from other limits: `compute` reads their values, so the derived number is never a second spelling
 * of theirs, and `derivation` says why the arithmetic bounds the resource. A data length the computation reads (the
 * width of a format grizzle prints, a list's length) needs no limit of its own.
 */
/* @__NO_SIDE_EFFECTS__ */
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
	mint(
		Object.freeze({
			value: limit.compute(limit.from),
			owner: limit.owner,
			unit: limit.unit,
			scope: limit.scope,
			kind: "derived",
			from: limit.from,
			derivation: limit.derivation
		})
	)

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
/**
 * The members of one union TypeScript represents: a union or template literal whose cross product reaches this many is
 * TS2590, "Expression produces a union type that is too complex to represent". A pattern's inferred host type is its
 * exact member union below it and string at it (types/fields/source.ts LanguageCount), decided before anything is
 * expanded.
 */
export const typeUnionLimit = measured({
	value: 100_000,
	owner: "TypeScript's checker (tsgo 7.1.0-beta), its cross-product union refusal",
	unit: "union members",
	scope: "one union or template literal type, a str.regex pattern's inferred host type among them",
	evidence:
		"test/types/regex/agreement.ts: its program states a template literal of 9 × 41 × 271 = 99,999 members, which typechecks, and one of 10^5 members under a TS2590 directive, which the type-test batch requires on every run",
	observed: "2026-11-06, a standalone probe of the two templates, the same the program states",
	environment: "tsgo 7.1.0-beta as package.json pins it, on macOS",
	workload: "the two template literal types alone, checked once",
	result: "the 99,999-member template typechecked; the 100,000-member one was TS2590",
	decision:
		"the checker's own threshold, which grizzle's inference never reaches: a count at it widens the host type to string",
	revalidate: "a TypeScript upgrade; the regex agreement program's TS2590 directive left unmet"
})

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

const regguts = `${postgresSource}/src/include/regex/regguts.h`

/**
 * MAX_COLOR, the greatest color number of a regex's color map: a color is a short, and newcolor refuses a color past
 * it as REG_ECOLORS, "too many colors" (regc_color.c).
 */
const regexMaxColor = published({
	value: 32_767,
	owner: "PostgreSQL 19rc1's regex compiler",
	unit: "colors",
	scope: "the greatest color number of one regex's color map",
	constraint: "compile-time constant",
	source: `${regguts}#L165`,
	quote: "#define MAX_COLOR\t32767\t\t/* max color (must fit in 'color' datatype) */",
	verified: "2026-11-07"
})

/**
 * The most colors a pattern's sets may cut the characters into, the classes of characters every set holds alike
 * (scalar/regex/space.ts colorsOf). A pattern of more is refused as ResourceBound (regexCompileSpace, colors) when its
 * domain or match is compiled, since PostgreSQL refuses it as "too many colors" at the first value it checks.
 */
export const regexMaxColors = derived({
	owner: "PostgreSQL 19rc1's regex compiler",
	unit: "colors",
	scope: "one str.regex or Compute.matches pattern's colors",
	from: [regexMaxColor],
	derivation: `colors are numbered from 0 to MAX_COLOR, and newcolor refuses another: "if (cm->max == MAX_COLOR)" (${postgresSource}/src/backend/regex/regc_color.c#L212, verified 2026-11-07). While one set is parsed, newsub opens a subcolor for each color the set splits, "sco = newcolor(cm);\t\t/* must create subcolor */" (regc_color.c#L401), and okcolors frees the parents the set emptied only once the set is done, so the colors live at once are at most twice the pattern's; the four pseudocolors specialcolors allocates after the last set, "nfa->bos[0] = pseudocolor(nfa->cm);" (regc_nfa.c#L1560), come when no subcolor is open, so twice the colors binds first`,
	compute: ([max]) => (max.value + 1) / 2
})

/**
 * REG_MAX_COMPILE_SPACE's share of states: the compile space is the bytes of 500,000 states and four arcs for each,
 * which PostgreSQL charges as it allocates its NFAs' states and arcs in batches, refusing a pattern as "regular
 * expression is too complex" when a new batch is needed and the space is spent (regc_nfa.c newstate, allocarc).
 */
const regexSpaceStates = published({
	value: 500_000,
	owner: "PostgreSQL 19rc1's regex compiler",
	unit: "NFA states",
	scope: "the states REG_MAX_COMPILE_SPACE is the space of, for one regex's compilation",
	constraint: "compile-time constant",
	source: `${regguts}#L463-L466`,
	quote: "(500000 * (sizeof(struct state) + 4 * sizeof(struct arc)))",
	verified: "2026-11-07"
})

/** REG_MAX_COMPILE_SPACE's arcs for each of its states. */
const regexSpaceArcsPerState = published({
	value: 4,
	owner: "PostgreSQL 19rc1's regex compiler",
	unit: "NFA arcs per state",
	scope: "the arcs REG_MAX_COMPILE_SPACE is the space of, for each of its states",
	constraint: "compile-time constant",
	source: `${regguts}#L463-L466`,
	quote: "(500000 * (sizeof(struct state) + 4 * sizeof(struct arc)))",
	verified: "2026-11-07"
})

/** The states of an NFA's first state batch, FIRSTSBSIZE, the fewest any of its batches holds. */
const regexFirstStateBatch = published({
	value: 32,
	owner: "PostgreSQL 19rc1's regex compiler",
	unit: "NFA states",
	scope: "the first state batch of one NFA, each later batch doubling it",
	constraint: "compile-time constant",
	source: `${regguts}#L353`,
	quote: "#define  FIRSTSBSIZE\t32",
	verified: "2026-11-07"
})

/** The states of an NFA's largest state batch, MAXSBSIZE. */
const regexMaxStateBatch = published({
	value: 1_024,
	owner: "PostgreSQL 19rc1's regex compiler",
	unit: "NFA states",
	scope: "one state batch of one NFA",
	constraint: "compile-time constant",
	source: `${regguts}#L354`,
	quote: "#define  MAXSBSIZE\t\t1024",
	verified: "2026-11-07"
})

/** The arcs of an NFA's first arc batch, FIRSTABSIZE, the fewest any of its batches holds. */
const regexFirstArcBatch = published({
	value: 64,
	owner: "PostgreSQL 19rc1's regex compiler",
	unit: "NFA arcs",
	scope: "the first arc batch of one NFA, each later batch doubling it",
	constraint: "compile-time constant",
	source: `${regguts}#L327`,
	quote: "#define  FIRSTABSIZE\t64",
	verified: "2026-11-07"
})

/** The arcs of an NFA's largest arc batch, MAXABSIZE. */
const regexMaxArcBatch = published({
	value: 1_024,
	owner: "PostgreSQL 19rc1's regex compiler",
	unit: "NFA arcs",
	scope: "one arc batch of one NFA",
	constraint: "compile-time constant",
	source: `${regguts}#L328`,
	quote: "#define  MAXABSIZE\t\t1024",
	verified: "2026-11-07"
})

/** Why a share of the compile space stays inside it, whichever of the two kinds of batch it counts. */
const batchShare = `a batch is allocated only when every slot of the NFA's batches is live, so the two NFAs PostgreSQL holds at once (regcomp.c nfanode copies the whole raw NFA, "nfa = newnfa(v, v->cm, v->nfa);" at #L2371, while the raw one lives) hold at most their live entries and one batch each beyond them; a batch's header, its chain link and its count, is no larger than one entry, and a batch holds at least its first batch's entries, so the headers cost at most one entry for each of those; newstate and allocarc refuse a new batch only once "nfa->v->spaceused >= REG_MAX_COMPILE_SPACE" (${postgresSource}/src/backend/regex/regc_nfa.c#L165, #L389), so the states within their share and the arcs within theirs keep the space below it, verified 2026-11-07`

/**
 * The most states a pattern's NFAs may hold at once (scalar/regex/space.ts pastCompileSpace): twice the raw NFA
 * PostgreSQL's parser builds from its ARE. A pattern of more is refused as ResourceBound (regexCompileSpace, states).
 */
export const regexMaxHeldStates = derived({
	owner: "PostgreSQL 19rc1's regex compiler",
	unit: "NFA states",
	scope: "the states of one pattern's NFAs that PostgreSQL holds at once while compiling it",
	from: [regexSpaceStates, regexFirstStateBatch, regexMaxStateBatch],
	derivation: `the states' share of REG_MAX_COMPILE_SPACE, less what batches cost beyond the states they hold: ${batchShare}`,
	compute: ([space, first, batch]) =>
		Math.floor((space.value * first.value) / (first.value + 1)) - batch.value - batch.value
})

/**
 * The most arcs a pattern's NFAs may hold at once (scalar/regex/space.ts pastCompileSpace), each set's counted once
 * for each color it spans: twice the arcs of the optimized NFA, which empty-arc removal adds to. A pattern of more is
 * refused as ResourceBound (regexCompileSpace, arcs).
 */
export const regexMaxHeldArcs = derived({
	owner: "PostgreSQL 19rc1's regex compiler",
	unit: "NFA arcs",
	scope: "the arcs of one pattern's NFAs that PostgreSQL holds at once while compiling it",
	from: [regexSpaceStates, regexSpaceArcsPerState, regexFirstArcBatch, regexMaxArcBatch],
	derivation: `the arcs' share of REG_MAX_COMPILE_SPACE, four for each of its states, less what batches cost beyond the arcs they hold: ${batchShare}`,
	compute: ([space, perState, first, batch]) =>
		Math.floor((space.value * perState.value * first.value) / (first.value + 1)) -
		batch.value -
		batch.value
})

/**
 * max_stack_depth's default, in kilobytes: how deep a backend's stack may grow before PostgreSQL refuses to recurse
 * further, which its regex compiler checks as it walks its NFAs (regexMaxDepth). It is the superuser's setting, which
 * no role grizzle admits can change, so Db.open and grizzle migrate refuse a server whose setting is below it.
 */
export const maxStackDepth = published({
	value: 2_048,
	owner: "PostgreSQL 19rc1",
	unit: "kilobytes",
	scope:
		"max_stack_depth, as pg_settings reports it, of the server grizzle's patterns are compiled on",
	constraint: "configurable default",
	source: `${postgresSource}/doc/src/sgml/config.sgml#L2328`,
	quote: "The default setting is two megabytes (<literal>2MB</literal>)",
	verified: "2026-11-07"
})
/**
 * What the depth and anchor measures share of their evidence: one bisection per shape against the pinned PostgreSQL,
 * re-verified by the suite that compiles the largest pattern the limits admit along drawn shapes,
 * test/pg/text/differential.test.ts, run by pnpm test:network.
 */
const compileLimitsRun = {
	evidence:
		"a one-off bisection over each shape's count against PostgreSQL, a fresh backend per probe, whose output is not preserved; test/pg/text/differential.test.ts \"compiles the largest pattern the limits admit along a drawn shape, at each limit's edge\" re-verifies that what the limits admit compiles",
	observed: "2026-11-07 22:37 to 23:40 CST (UTC-6), one bisection per shape",
	environment:
		"PostgreSQL 19rc1 as scripts/pg/pin.env builds it, on the local cluster CONTRIBUTING.md sets up, max_stack_depth 2048 kB, its default; macOS (Darwin 27.0.0) on an arm64 virtual machine, Node 26.13.0; grizzle 00209792 with this change uncommitted; other sessions loading the machine",
	revalidate:
		"a PostgreSQL repin; a change of max_stack_depth's default or of the platform's stack frames; a change to the ARE printer (scalar/regex/are.ts) or to the model of PostgreSQL's raw NFA (scalar/regex/space.ts); a pattern the suite finds refused as too complex"
} as const

/**
 * The longest path of the raw NFA PostgreSQL's parser builds from a pattern's ARE, in arcs (scalar/regex/space.ts
 * rawSize). PostgreSQL's parser recurses into nested groups, and its walks of the NFA (regc_nfa.c duptraverse,
 * markreachable, markcanreach) recurse along its paths, each refusing a pattern past max_stack_depth as "regular
 * expression is too complex" (STACK_TOO_DEEP), so a pattern of a longer path is refused as ResourceBound
 * (regexCompileSpace, depth). It holds at max_stack_depth's default (maxStackDepth), which Db.open and grizzle migrate
 * require of the server.
 */
export const regexMaxDepth = measured({
	value: 16_000,
	owner: "grizzle's text refinement (scalar/regex/space.ts pastCompileSpace)",
	unit: "NFA arcs",
	scope:
		"the longest path of one pattern's raw NFA, which PostgreSQL's regex compiler recurses along",
	...compileLimitsRun,
	workload:
		"each pattern's ARE compiled by `SELECT 'x' COLLATE pg_catalog.pg_c_utf8 ~ $1::text`, and again inside an INSERT in a PL/pgSQL function two PL/pgSQL calls deep, over three shapes: a chain of plain code points in counted runs, nested optional groups `(?:a(?:a…)?)?`, and nested + groups `(?:(?:a)+b)+b…`; the chain again at max_stack_depth 1MB",
	result:
		'the longest path compiled and the shortest refused, in arcs: the chain 43,364 and 43,563, and 21,597 and 21,694 at 1MB, so the edge follows the setting; nested optional groups 32,570 and 32,685, two PL/pgSQL calls deep 32,450 and 32,570; nested + groups 43,478 and 43,646, two calls deep 43,317 and 43,478; every refusal "regular expression is too complex" at under 100,000 states held, far inside the compile space; nested + groups near their edge compiled in 18 to 24 s',
	decision:
		"16,000: about half the shallowest edge measured, 32,450 arcs two PL/pgSQL calls deep, leaving about 1MB of the 2MB stack for a call path deeper than the measured one when a pattern is first compiled; the two calls cost the shallowest shape 120 arcs"
})

/**
 * The states the compacted NFA a match reads holds (scalar/regex/space.ts matchStates). At every match regexec's DFA
 * (rege_dfa.c newdfa) allocates a bit vector of these states for each of twice as many state sets, "d->statesarea =
 * MALLOC_ARRAY(unsigned, (nss + WORK) * wordsper);", which palloc refuses past MaxAllocSize, failing the match, and so
 * every write its domain checks, with "invalid memory alloc request size"; a pattern of more is refused as
 * ResourceBound (regexCompileSpace, matchStates).
 */
export const regexMaxMatchStates = measured({
	value: 64_000,
	owner: "grizzle's text refinement (scalar/regex/space.ts pastCompileSpace)",
	unit: "NFA states",
	scope: "the states of the compacted NFA one pattern's match reads, as its model counts them",
	...compileLimitsRun,
	workload:
		"each pattern's ARE matched by `SELECT 'x' COLLATE pg_catalog.pg_c_utf8 ~ $1::text`: an anchored union of k words of four letters, digits and underscores, and the same union repeated by +",
	result:
		'the union matched at 21,649 words, 64,953 states as the model counts them, and failed at 22,039 words, 66,123 states, with "invalid memory alloc request size 1093385124", the state sets\' bit vectors, (2S + 1) words of ⌈S/32⌉ four-byte words for S states, which first pass MaxAllocSize at 65,536 states; the repeated union matched at 21,799 words and failed at 21,857 alike',
	decision:
		"64,000: below the 65,536 states at which the bit vectors pass MaxAllocSize, the measured edge, with 1,535 states, about 2%, of headroom; the model counts each state makesearch may split twice"
})

/**
 * The states of the compacted NFA a match reads times the pattern's colors (scalar/regex/space.ts matchStates,
 * colorsOf). At every match regexec's DFA allocates an entry for each of twice as many state sets as states and each
 * color, "d->incarea = MALLOC_ARRAY(struct arcp, nss * cnfa->ncolors);", which palloc refuses past MaxAllocSize; a
 * pattern of more is refused as ResourceBound (regexCompileSpace, matchCells).
 */
export const regexMaxMatchCells = measured({
	value: 16_000_000,
	owner: "grizzle's text refinement (scalar/regex/space.ts pastCompileSpace)",
	unit: "NFA states times colors",
	scope:
		"the states of the compacted NFA one pattern's match reads times its colors, as its model counts them",
	...compileLimitsRun,
	workload:
		"each pattern's ARE matched by `SELECT 'x' COLLATE pg_catalog.pg_c_utf8 ~ $1::text`: an anchored union of k words of a code point of their own and a common one, and the same union repeated by * before a last code point",
	result:
		'the union matched at 5,778 words, 33,344,850 states times colors as the model counts them, and failed at 5,793, 33,611,006, with "invalid memory alloc request size 1075737696", the entries of 16 bytes, which first pass MaxAllocSize at 33,554,432 states times colors; the repeated union matched at 5,771 words and failed at 5,794 alike',
	decision:
		"16,000,000: about half the measured edge, since freeing the colors a set empties can leave a color map up to twice a pattern's colors (regexMaxColors), and the arrays count the map's colors"
})

/**
 * The anchors PostgreSQL must move (scalar/regex/space.ts movingAnchors): constraint elimination (regc_nfa.c pullback,
 * pushfwd, fixconstraintloops) clones the states around each anchor some consuming path reaches or leaves, and around
 * anchors joined by empty paths it compounds, so a pattern of more is refused as ResourceBound (regexCompileSpace,
 * anchors). An anchor at either end of every path is never moved and never counted.
 */
export const regexMaxAnchors = measured({
	value: 8,
	owner: "grizzle's text refinement (scalar/regex/space.ts pastCompileSpace)",
	unit: "anchors",
	scope: "the anchors of one pattern's raw NFA that constraint elimination moves",
	...compileLimitsRun,
	workload:
		"each pattern's ARE compiled by `SELECT 'x' COLLATE pg_catalog.pg_c_utf8 ~ $1::text`, over two shapes: k optional `$` before 256 code points of their own and four runs of 255 copies of a class of them, and `(?:^|.{1,255}|$){k}b`, an anchor on either side of a wide run, each count k from 1 to 64",
	result:
		'the first shape compiled at every k, 64 anchors to move over an NFA of 316,829 optimized arcs in 0.7 s; the second, two anchors to move for each k past the first, compiled 15 in 5 s and 19 in 143 s, ran 21 past the probe\'s 300 s statement_timeout, and refused 23 after 33 s, 31 after 20 s and 63 after 143 s as "regular expression is too complex"',
	decision:
		"8: about half the most anchors the binding shape compiled, 19, whose compile already took minutes; the arcs an anchor crosses bind nothing measured, so no measure weighs them"
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
		"one pattern's construction at a time, the process's only work, over NFAs of 15 to 4,117 states, parsing and the NFA build untimed; `^(?:.{0,255}){16}$`, the slowest pattern of the unverifiable run this one replaces, was refused by the compile-space measures of the time and never reached the construction",
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
const utf8EncodingMaxBytes = published({
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
const varlenaHeaderBytes = published({
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
 * The most bytes one bytes value holds, the most one bytea holds: a value arrives in binary, which bytearecv copies into
 * an allocation of its bytes and its header, and palloc refuses an allocation past MaxAllocSize, which also bounds a
 * varlena's length word, so no bytea of any writer is longer. A longer value is refused at its boundary (bytesLength),
 * before any SQL.
 */
export const bytesMaxLength: Limit = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "one bytes value, one bytea, as bytearecv reads it from a binary parameter",
	from: [maxAllocSize, varlenaHeaderBytes],
	derivation: `bytearecv allocates "result = (bytea *) palloc(nbytes + VARHDRSZ);" for a value of nbytes bytes (${postgresSource}/src/backend/utils/adt/bytea.c#L365, verified 2026-11-07), and "#define AllocSizeIsValid(size) ((Size) (size) <= MaxAllocSize)" (${postgresSource}/src/include/utils/memutils.h#L42), so nbytes is at most MaxAllocSize - VARHDRSZ`,
	compute: ([alloc, header]) => alloc.value - header.value
})

/**
 * The bytes of a bytes value one row of its delivery carries: a statement that delivers a bytes column sends each row as
 * one result row per chunk of this many bytes of its longest bytes value, each chunk base64url text
 * (codec/delivery.ts, lower/delivery.ts), since the driver reads every result cell as one string. Chunk i of a value is
 * its bytes from i times this on, and the host writes it there.
 */
export const bytesChunkLength = measured({
	value: 16_777_216,
	owner: "grizzle's bytes delivery (codec/delivery.ts, lower/delivery.ts)",
	unit: "bytes",
	scope: "one chunk of one bytes value in one result row",
	evidence:
		"bench/results/bytes/bytes-2026-11-08T045419.json, the uncommitted record of `pnpm bench bytes` (bench/bytes/main.ts)",
	observed: "2026-11-08 04:54:19 to 05:01:03 UTC, one run",
	environment:
		"macOS 27.0.1 (Darwin 27.0.0, an arm64 virtual machine, Apple M2 Max, 10 cores, 64 GiB), Node 26.13.0, pg 8.23.1, the local PostgreSQL 19rc1 cluster (scripts/pg/pin.env), grizzle 36b85dad and the bytes delivery, in a scratch copy whose own commit the record's gitSha names; other sessions' load on the machine is not separated",
	workload:
		"one row of one 256 MiB bytes value, once xorshift bytes, which PostgreSQL stores uncompressed, and once a repeating sentence, which it compresses, read back through its delivered SQL on one session and assembled, three runs a chunk length: 64 KiB to 64 MiB by factors of four for the random value, 1 MiB to 64 MiB for the repeating one",
	result:
		"p50 of read and assembly in ms, random: 2,603 at 64 KiB, 2,114 at 256 KiB, 1,956 at 1 MiB, 2,136 at 4 MiB, 2,409 at 16 MiB, 2,237 at 64 MiB; repeating: 36,586 at 1 MiB, 8,212 at 4 MiB, 1,884 at 16 MiB, 1,288 at 64 MiB, the square of the chunks since every chunk's substring decompresses the value from its start (a 64 KiB read of it ran past six minutes in an earlier run and was stopped). Process rss after a case 1,742 to 2,546 MiB up to 16 MiB, 2,811 to 2,831 MiB at 64 MiB. Every value read back whole; no errors",
	decision:
		"16 MiB: the random value's time is flat across every length measured, and the compressed value's falls with the square of the chunks until 16 MiB, where it is within the random value's; 64 MiB saves the compressed value about 0.6 s of 256 MiB at about 0.7 GiB more rss, and a result row holds a base64url chunk of 4/3 of this for each bytes column its statement delivers within MaxAllocSize, which admits 47 such columns at 16 MiB and 11 at 64 MiB",
	revalidate:
		"a PostgreSQL upgrade that changes TOAST slicing or the default compression; a driver or Node upgrade that changes how a result cell is read; a bytes value bound past 1 GiB"
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
 * The bytes of one pg_wchar, the wide character PostgreSQL's regex engine reads a text as: an unsigned int, 32 bits on
 * every platform PostgreSQL 19 builds on.
 */
const pgWcharBytes = published({
	value: 4,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope:
		"one pg_wchar, an unsigned int of the platform's C ABI, 32 bits on every platform PostgreSQL builds on",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/mb/pg_wchar.h#L28`,
	quote: "typedef unsigned int pg_wchar;",
	verified: "2026-11-06"
})

/**
 * The longest text, in UTF-8 bytes, PostgreSQL's regex engine reads: before it matches, it widens the text into one
 * pg_wchar per byte and one more, and refuses an allocation past MaxAllocSize ("invalid memory alloc request size"). So
 * a query matches by ~, which Compute.matches is, only an operand whose pattern bounds its bytes within this, and a
 * check or generated column that matches a longer text fails its write.
 */
export const regexTextMaxBytes = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the subject text of one match by ~",
	from: [maxAllocSize, pgWcharBytes],
	derivation: `RE_execute allocates "data = palloc_array(pg_wchar, dat_len + 1);" over its subject's dat_len bytes for ~ (${postgresSource}/src/backend/utils/adt/regexp.c#L332, verified 2026-11-06), and palloc refuses a size past MaxAllocSize, so the length plus one is at most MaxAllocSize / sizeof(pg_wchar), rounded down`,
	compute: ([alloc, wide]) => Math.floor(alloc.value / wide.value) - 1
})

/**
 * The longest message a PostgreSQL backend reads from a client, as the message's Int32 length counts it, itself
 * included: a Query or Parse message holding a statement, or a Bind message carrying one execution's parameters, each
 * read under it by SocketBackend (src/backend/tcop/postgres.c). A longer one is "invalid message length"
 * (src/backend/libpq/pqcomm.c pq_getmessage), after which the backend ends the connection without an ErrorResponse,
 * so a statement whose text is longer, in UTF-8 bytes, is refused as ResourceBound (statementBytes) when it is printed,
 * and a statement whose Parse message, its text with its name and fields, or whose Bind message would be longer is
 * refused on the host as InputTooLarge before its flight is sent (the shell's wire/batch.ts).
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

/** The Node release every published Node and OpenSSL limit is read from, v26.13.0's tree. */
const nodeSource = "https://github.com/nodejs/node/blob/v26.13.0"

/**
 * The most bytes one SSL_write takes, a C int's greatest value. Node's TLS socket hands each write it is given to one
 * SSL_write, a corked flight's chunks concatenated, and OpenSSL refuses a length past INT_MAX, which wraps negative, as
 * "bad length".
 */
const sslWriteMaxBytes = derived({
	owner: "OpenSSL 4.1.0, as Node 26.13.0 bundles it",
	unit: "bytes",
	scope:
		"the plaintext of one SSL_write: one write Node's TLS socket is handed, a corked flight's chunks together",
	from: [int4Max],
	derivation: `SSL_write takes its length as a C int and refuses a negative one, "int SSL_write(SSL *s, const void *buf, int num)" and "if (num < 0) {" (${nodeSource}/deps/openssl/openssl/ssl/ssl_lib.c#L2647-L2653, verified 2026-11-07), and Node's TLS socket passes it a write's chunks as one length, "written = SSL_write(ssl_.get(), bs->Data(), length);" (${nodeSource}/src/crypto/crypto_tls.cc#L1181), so a write is at most INT_MAX bytes, the greatest integer`,
	compute: ([intMax]) => intMax.value
})

/**
 * The most bytes one send on a macOS socket carries: a write or a writev past INT_MAX is refused whole with EINVAL.
 * Node's TLS socket writes the ciphertext of one SSL_write to its socket in one call, so a flight's ciphertext is one
 * send.
 */
const socketSendMaxBytes = derived({
	owner: "macOS's kernel, XNU 12377.121.6",
	unit: "bytes",
	scope:
		"one write or writev to a socket on macOS: the ciphertext of one SSL_write, which Node's TLS socket writes in one call",
	from: [int4Max],
	derivation: `sosend refuses "if (resid < 0 || resid > INT_MAX ||" with "error = EINVAL;" (https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.121.6/bsd/kern/uipc_socket.c#L2122-L2124, verified 2026-11-07); Node's TLS socket sizes one buffer for the whole ciphertext of a write, "allocate_hint_ = (size / kThreshold + 1) * (kThreshold + 5 + 32);" (${nodeSource}/src/crypto/crypto_bio.h#L110), and hands what its buffers hold to its socket in one call, "StreamWriteResult res = underlying_stream()->Write(bufs, count);" (${nodeSource}/src/crypto/crypto_tls.cc#L770). Linux refuses no length: "On Linux, write() (and similar system calls) will transfer at most 0x7ffff000 (2,147,479,552) bytes, returning the number of bytes actually transferred." (https://man7.org/linux/man-pages/man2/write.2.html, verified 2026-11-07), and libuv writes the rest`,
	compute: ([intMax]) => intMax.value
})

const tlsSource = "https://www.rfc-editor.org/rfc/rfc5246"

/**
 * The most plaintext one TLS record carries. OpenSSL cuts a write into records of this many bytes but the last, its
 * max_send_fragment's default, which a peer lowers only when the client asks for max_fragment_length, and Node's TLS
 * socket asks for none.
 */
const tlsRecordPlaintextBytes = published({
	value: 2 ** 14,
	owner: "TLS 1.2 (RFC 5246), and TLS 1.3 alike (RFC 8446)",
	unit: "bytes",
	scope: "the plaintext fragment of one TLS record",
	constraint: "protocol constant",
	source: `${tlsSource}#section-6.2.1`,
	quote: "The length MUST NOT exceed 2^14.",
	verified: "2026-11-07"
})

/**
 * The most bytes one TLS 1.2 record's protected fragment holds, its plaintext and all its cipher adds: a MAC, an
 * explicit IV, a nonce or padding. TLS 1.3's is 2^14 + 256 (RFC 8446 section 5.2), so a session of either version stays
 * within it.
 */
const tlsRecordProtectedBytes = published({
	value: 2 ** 14 + 2048,
	owner: "TLS 1.2 (RFC 5246)",
	unit: "bytes",
	scope: "the protected fragment of one TLS record, as TLSCiphertext.length counts it",
	constraint: "protocol constant",
	source: `${tlsSource}#section-6.2.3`,
	quote: "The length MUST NOT exceed 2^14 + 2048.",
	verified: "2026-11-07"
})

/**
 * The header in front of every TLS record's fragment: its ContentType, an enum of one byte, its ProtocolVersion, two
 * uint8, and its uint16 length.
 */
const tlsRecordHeaderBytes = published({
	value: 1 + 2 + 2,
	owner: "TLS 1.2 (RFC 5246), and TLS 1.3 alike (RFC 8446)",
	unit: "bytes",
	scope: "the header of one TLS record, in front of its fragment",
	constraint: "protocol constant",
	source: `${tlsSource}#section-6.2.3`,
	quote: "ContentType type; ProtocolVersion version; uint16 length;",
	verified: "2026-11-07"
})

/**
 * The most bytes one flight writes, every message pg writes for it corked into one write. Node's TLS socket hands that
 * write to one SSL_write and its ciphertext to one send on its socket, so a longer flight fails whole: OpenSSL's "bad
 * length" past INT_MAX, or the socket's EINVAL once TLS's records have grown it past INT_MAX. The connection ends with
 * the flight's end unsent, which a flight carrying COMMIT would report as CommitLost though nothing committed, so a
 * flight past this is refused on the host as InputTooLarge before any byte of it is written (the shell's wire/batch.ts).
 */
export const flightMaxBytes = derived({
	owner:
		"the TLS every session runs over: OpenSSL's SSL_write, TLS 1.2's records and macOS's socket send",
	unit: "bytes",
	scope:
		"one flight: the Closes in front of it, BEGIN, the prologue, each statement's Parse, Bind, Describe, Execute and Sync, and the transaction's end, as pg writes them",
	from: [
		sslWriteMaxBytes,
		socketSendMaxBytes,
		tlsRecordPlaintextBytes,
		tlsRecordProtectedBytes,
		tlsRecordHeaderBytes
	],
	derivation:
		"a flight's plaintext must fit one SSL_write, and its ciphertext one send. TLS cuts the plaintext into records of tlsRecordPlaintextBytes each but the last, and sends each as its header and a protected fragment of at most tlsRecordProtectedBytes, TLS 1.2's bound, the larger of the two versions a session negotiates (Node's and PostgreSQL's least is TLS 1.2). So the flight is at most the whole records whose worst ciphertext fits one send, and at most what one SSL_write takes",
	compute: ([write, send, plaintext, protectedBytes, header]) =>
		Math.min(
			write.value,
			Math.floor(send.value / (header.value + protectedBytes.value)) * plaintext.value
		)
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
 * It is a whole number of bytes, so a constant within it is within it padded to whole hex digits too.
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

const asyncC = `${postgresSource}/src/backend/commands/async.c`

/**
 * The margin NOTIFY_PAYLOAD_MAX_LENGTH leaves of a page beside a channel's name, which keeps one notification on one
 * SLRU page of the notification queue.
 */
const notifyPayloadMargin = published({
	value: 128,
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope: "the part of one notification queue page no channel name and no payload may take",
	constraint: "compile-time constant",
	source: `${asyncC}#L193-L201`,
	quote: "#define NOTIFY_PAYLOAD_MAX_LENGTH	(BLCKSZ - NAMEDATALEN - 128)",
	verified: "2026-11-11"
})

/**
 * NOTIFY_PAYLOAD_MAX_LENGTH, the bytes a notification's payload must stay under: Async_Notify refuses a payload of
 * this many bytes or more with 22023, which fails the statement that sent it, and with it the write.
 */
export const notifyPayloadMaxBytes = derived({
	owner: "PostgreSQL 19rc1",
	unit: "bytes",
	scope:
		"one NOTIFY payload in the server encoding, its terminating zero excluded: sent only while shorter",
	from: [blockSize, namedatalen, notifyPayloadMargin],
	derivation: `async.c's "#define NOTIFY_PAYLOAD_MAX_LENGTH (BLCKSZ - NAMEDATALEN - 128)" (${asyncC}#L201) and Async_Notify's "if (payload_len >= NOTIFY_PAYLOAD_MAX_LENGTH) ereport(ERROR, (errcode(ERRCODE_INVALID_PARAMETER_VALUE), errmsg("payload string too long")))" (${asyncC}#L923-L926, verified 2026-11-11)`,
	compute: ([block, name, margin]) => block.value - name.value - margin.value
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
/* @__NO_SIDE_EFFECTS__ */
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
