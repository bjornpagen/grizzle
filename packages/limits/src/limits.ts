import { derived, type Limit, measured, published } from "@bjornpagen/limit"

/**
 * grizzle's limits: every number grizzle bounds something by, each a Limit of @bjornpagen/limit with its evidence,
 * minted here and nowhere else (the limits skill, vendor/toolchain/packages/devtools/skills/limits; this package's
 * README). Code reads a limit's `.value`; the dev tools' no-bare-limit and limits-sole-mint rules refuse a bound written
 * or minted anywhere else, test files aside.
 *
 * Every number here was asked first whether it should exist at all. What stays is of three kinds: a fact of a system
 * grizzle compiles against or runs on (PostgreSQL 19rc2, pgvector, IEEE 754, V8, TypeScript's checker, TLS, OpenSSL,
 * the kernels, Node's timers), published, or derived by arithmetic over such facts; an edge of PostgreSQL's own
 * refusals that it publishes no number for (the regex compiler's stack and memory), measured against the pinned build;
 * and a genuine operating point grizzle chooses between two shapes at (the take(k) lowering's LATERAL threshold, the
 * bytes delivery's chunk, the regex analysis's subset construction, the local cluster's sizing), measured. None is a
 * cap on grizzle's own data or a caller's trusted input.
 */

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
		"~/.cache/grizzle-release/LIMITS/out/evidence/take/ on cassowary: query-take.full.json, the uncommitted record of `pnpm bench gates --only R20` (bench/query/take.bench.ts, gate R20), and run.log, its console output with the machine's uptime before and after it. The first record, of 2026-11-14 07:53:25 to 08:03:31 UTC at grizzle 01cc8dda (bench/results/gates/query-take.full.json in RC2CITE's clone), went with that clone",
	observed: "2026-11-16 07:56:04 to 08:06:02 UTC, one full-scale run",
	environment:
		"cassowary, Ubuntu 26.04 on an AWS Graviton3 (Neoverse-V1, arm64) instance with 64 logical CPUs and 247 GiB, Node 26.13.1, the local PostgreSQL 19rc2 cluster family with scripts/pg/pin.env's three patches (gcc 15.2.0, jit off), grizzle ac71cfbb with lane LIMITS's move of the limits, which changes no lowering; load average 253 falling to 104 over the run from other sessions, other lanes' files on the cluster",
	workload:
		"the Lab fixture's take bench: take(1) as DISTINCT ON and take(3) as row_number over every group, against the LATERAL probe of LIMIT k per parent, for group sizes 2, 8, 32 and 128 and bound parent sets of 1, 4, 16, 64, 256, 1024, 4096 and 16384, 15 timed samples each after a warm run",
	result:
		"execute p50 in ms, LATERAL / whole-relation: at 256 parents, groups of 2: 1.422/1389.107 (k 1) and 1.664/1.776 (k 3); groups of 8: 1.051/1387.636 and 1.348/22.505; groups of 32: 1.238/1379.878 and 1.533/102.627; groups of 128: 2.314/1383.346 and 2.718/350.148. At 1024 parents, groups of 2: 2.571/2.198 (k 1) and 3.423/3.526 (k 3), the first measured count at which a whole-relation form is the faster; groups of 8 or more keep the LATERAL probe the faster. R20, R27 and R42 pass; no errors; the machine's load is not separated per sample. The run of 2026-11-14 at load 2.8 to 8.5 found the same edge: at 1024 parents, groups of 2, k 1, 2.406/2.057",
	decision:
		"256 is the largest measured parent count at which the LATERAL probe is no slower than the whole-relation pass at every group size and k; at the next measured count, 1024, the whole-relation pass is faster for groups of two at k 1. No headroom added: a parent count between 256 and 1024 is unmeasured",
	revalidate:
		"a PostgreSQL repin or a planner setting change; a change to either form's SQL (lower/shapes/take); a different machine or cluster configuration; a run at a parent count between 256 and 1024; a workload whose groups differ from the Lab fixture's"
})

/** The PostgreSQL release every published PostgreSQL limit is read from, REL_19_RC2's tree. */
const postgresSource = "https://github.com/postgres/postgres/blob/REL_19_RC2"

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

/**
 * PostgreSQL's explicit repetition limit: a pattern whose `{m}`, `{m,}` or `{m,n}` states a bound above it is refused
 * (scalar/regex/parse.ts), as PostgreSQL's regex compiler refuses it (regcomp.c scannum, against DUPMAX, which is
 * _POSIX2_RE_DUP_MAX). regguts.h defines it only where <limits.h> does not, and POSIX fixes it at the same value
 * (https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/limits.h.html, "{_POSIX2_RE_DUP_MAX} Maximum number of
 * repeated occurrences of a BRE or ERE interval expression; [...] Value: 255"), so every platform's build has it.
 */
export const regexMaxRepeat = published({
	value: 255,
	owner: "PostgreSQL 19rc2's regex compiler",
	unit: "repetitions",
	scope: "each bound of a counted repetition in one str.regex pattern",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/regex/regguts.h#L95`,
	quote: "#define _POSIX2_RE_DUP_MAX\t255",
	verified: "2026-11-14"
})

const regguts = `${postgresSource}/src/include/regex/regguts.h`

/**
 * MAX_COLOR, the greatest color number of a regex's color map: a color is a short, and newcolor refuses a color past
 * it as REG_ECOLORS, "too many colors" (regc_color.c).
 */
const regexMaxColor = published({
	value: 32_767,
	owner: "PostgreSQL 19rc2's regex compiler",
	unit: "colors",
	scope: "the greatest color number of one regex's color map",
	constraint: "compile-time constant",
	source: `${regguts}#L165`,
	quote: "#define MAX_COLOR\t32767\t\t/* max color (must fit in 'color' datatype) */",
	verified: "2026-11-14"
})

/**
 * The most colors a pattern's sets may cut the characters into, the classes of characters every set holds alike
 * (scalar/regex/space.ts colorsOf). A pattern of more is refused as ResourceBound (regexCompileSpace, colors) when its
 * domain or match is compiled, since PostgreSQL refuses it as "too many colors" at the first value it checks.
 */
export const regexMaxColors = derived({
	owner: "PostgreSQL 19rc2's regex compiler",
	unit: "colors",
	scope: "one str.regex or Compute.matches pattern's colors",
	from: [regexMaxColor],
	derivation: `colors are numbered from 0 to MAX_COLOR, and newcolor refuses another: "if (cm->max == MAX_COLOR)" (${postgresSource}/src/backend/regex/regc_color.c#L212, verified 2026-11-14). While one set is parsed, newsub opens a subcolor for each color the set splits, "sco = newcolor(cm);\t\t/* must create subcolor */" (regc_color.c#L401), and okcolors frees the parents the set emptied only once the set is done, so the colors live at once are at most twice the pattern's; the four pseudocolors specialcolors allocates after the last set, "nfa->bos[0] = pseudocolor(nfa->cm);" (regc_nfa.c#L1560), come when no subcolor is open, so twice the colors binds first`,
	compute: ([max]) => (max.value + 1) / 2
})

/**
 * REG_MAX_COMPILE_SPACE's share of states: the compile space is the bytes of 500,000 states and four arcs for each,
 * which PostgreSQL charges as it allocates its NFAs' states and arcs in batches, refusing a pattern as "regular
 * expression is too complex" when a new batch is needed and the space is spent (regc_nfa.c newstate, allocarc).
 */
const regexSpaceStates = published({
	value: 500_000,
	owner: "PostgreSQL 19rc2's regex compiler",
	unit: "NFA states",
	scope: "the states REG_MAX_COMPILE_SPACE is the space of, for one regex's compilation",
	constraint: "compile-time constant",
	source: `${regguts}#L463-L466`,
	quote: "(500000 * (sizeof(struct state) + 4 * sizeof(struct arc)))",
	verified: "2026-11-14"
})

/** REG_MAX_COMPILE_SPACE's arcs for each of its states. */
const regexSpaceArcsPerState = published({
	value: 4,
	owner: "PostgreSQL 19rc2's regex compiler",
	unit: "NFA arcs per state",
	scope: "the arcs REG_MAX_COMPILE_SPACE is the space of, for each of its states",
	constraint: "compile-time constant",
	source: `${regguts}#L463-L466`,
	quote: "(500000 * (sizeof(struct state) + 4 * sizeof(struct arc)))",
	verified: "2026-11-14"
})

/** The states of an NFA's first state batch, FIRSTSBSIZE, the fewest any of its batches holds. */
const regexFirstStateBatch = published({
	value: 32,
	owner: "PostgreSQL 19rc2's regex compiler",
	unit: "NFA states",
	scope: "the first state batch of one NFA, each later batch doubling it",
	constraint: "compile-time constant",
	source: `${regguts}#L353`,
	quote: "#define  FIRSTSBSIZE\t32",
	verified: "2026-11-14"
})

/** The states of an NFA's largest state batch, MAXSBSIZE. */
const regexMaxStateBatch = published({
	value: 1_024,
	owner: "PostgreSQL 19rc2's regex compiler",
	unit: "NFA states",
	scope: "one state batch of one NFA",
	constraint: "compile-time constant",
	source: `${regguts}#L354`,
	quote: "#define  MAXSBSIZE\t\t1024",
	verified: "2026-11-14"
})

/** The arcs of an NFA's first arc batch, FIRSTABSIZE, the fewest any of its batches holds. */
const regexFirstArcBatch = published({
	value: 64,
	owner: "PostgreSQL 19rc2's regex compiler",
	unit: "NFA arcs",
	scope: "the first arc batch of one NFA, each later batch doubling it",
	constraint: "compile-time constant",
	source: `${regguts}#L327`,
	quote: "#define  FIRSTABSIZE\t64",
	verified: "2026-11-14"
})

/** The arcs of an NFA's largest arc batch, MAXABSIZE. */
const regexMaxArcBatch = published({
	value: 1_024,
	owner: "PostgreSQL 19rc2's regex compiler",
	unit: "NFA arcs",
	scope: "one arc batch of one NFA",
	constraint: "compile-time constant",
	source: `${regguts}#L328`,
	quote: "#define  MAXABSIZE\t\t1024",
	verified: "2026-11-14"
})

/** Why a share of the compile space stays inside it, whichever of the two kinds of batch it counts. */
const batchShare = `a batch is allocated only when every slot of the NFA's batches is live, so the two NFAs PostgreSQL holds at once (regcomp.c nfanode copies the whole raw NFA, "nfa = newnfa(v, v->cm, v->nfa);" at #L2371, while the raw one lives) hold at most their live entries and one batch each beyond them; a batch's header, its chain link and its count, is no larger than one entry, and a batch holds at least its first batch's entries, so the headers cost at most one entry for each of those; newstate and allocarc refuse a new batch only once "nfa->v->spaceused >= REG_MAX_COMPILE_SPACE" (${postgresSource}/src/backend/regex/regc_nfa.c#L165, #L389), so the states within their share and the arcs within theirs keep the space below it, verified 2026-11-14`

/**
 * The most states a pattern's NFAs may hold at once (scalar/regex/space.ts pastCompileSpace): twice the raw NFA
 * PostgreSQL's parser builds from its ARE. A pattern of more is refused as ResourceBound (regexCompileSpace, states).
 */
export const regexMaxHeldStates = derived({
	owner: "PostgreSQL 19rc2's regex compiler",
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
	owner: "PostgreSQL 19rc2's regex compiler",
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
	owner: "PostgreSQL 19rc2",
	unit: "kilobytes",
	scope:
		"max_stack_depth, as pg_settings reports it, of the server grizzle's patterns are compiled on",
	constraint: "configurable default",
	source: `${postgresSource}/doc/src/sgml/config.sgml#L2328`,
	quote: "The default setting is two megabytes (<literal>2MB</literal>)",
	verified: "2026-11-14"
})
/**
 * What the depth and anchor measures share of their evidence: one bisection per shape against the pinned PostgreSQL,
 * re-verified by the suite that compiles the largest pattern the limits admit along drawn shapes,
 * test/pg/text/differential.test.ts, run by pnpm test:network.
 */
const compileLimitsRun = {
	evidence:
		"a one-off bisection over each shape's count against PostgreSQL, a fresh backend per probe, recorded in ~/.cache/grizzle-release/RC2CITE/out/idle/regex/regex-edges-2026-11-14T080636.949Z.json by the uncommitted probe .scratch/regex-edges.ts in RC2CITE's clone; test/pg/text/differential.test.ts \"compiles the largest pattern the limits admit along a drawn shape, at each limit's edge\" re-verifies that what the limits admit compiles",
	observed:
		"2026-11-14 08:06:36 to 08:10:19 UTC, one bisection per shape and every count of the anchors' shapes at once",
	environment:
		"PostgreSQL 19rc2 as scripts/pg/pin.env builds it, its three patches applied (gcc 15.2.0), on the local cluster CONTRIBUTING.md sets up, max_stack_depth 2048 kB, its default; cassowary, Ubuntu 26.04 on an AWS Graviton3 (Neoverse-V1, arm64) instance with every logical CPU nproc reports and 247 GiB, Node 26.13.1; grizzle 01cc8dda; load average 5.0 to 10.3, no other session active on the cluster",
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
		'the longest path compiled and the shortest refused, in arcs: the chain 43,523 and 43,524, two PL/pgSQL calls deep 43,407 and 43,408, and 21,677 and 21,678 at 1MB, so the edge follows the setting; nested optional groups 38,406 and 38,411, two PL/pgSQL calls deep 38,301 and 38,306; nested + groups 43,520 and 43,527, two calls deep 43,401 and 43,408; every refusal "regular expression is too complex" at under 90,000 states held, far inside the compile space; every compile near an edge within 6 s',
	decision:
		"16,000: below half the shallowest edge measured, 38,301 arcs two PL/pgSQL calls deep, leaving more than 1MB of the 2MB stack for a call path deeper than the measured one when a pattern is first compiled; the two calls cost the shallowest shape 105 arcs"
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
		"the union matched at 21,843 words, 65,535 states as the model counts them, and failed at 21,844 words, 65,538 states, with \"invalid memory alloc request size 1073750016\", the state sets' bit vectors, (2S + 1) words of ⌈S/32⌉ four-byte words for PostgreSQL's S = 65,536 states, the first count past MaxAllocSize; the repeated union matched at 21,843 words and failed at 21,844 alike",
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
		'the union matched at 5,787 words, 33,535,677 states times colors as the model counts them, and failed at 5,788, 33,547,260, with "invalid memory alloc request size 1073883136", the entries of 16 bytes, which first pass MaxAllocSize at 33,554,432 states times colors: PostgreSQL\'s map held two colors more than the model counts, 5,792 against 5,790 at 5,794 states; the repeated union matched at 5,786 words and failed at 5,787 alike',
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
		'the first shape compiled at every k, 64 anchors to move over a raw NFA of 261,848 arcs in 1.4 s; the second, two anchors to move for each k past the first, compiled 15 in 22 s, 19 in 162 s and 21 in 220 s, inside the probe\'s 300 s statement_timeout, and refused 23 after 42 s, 31 after 22 s and 63 after 148 s as "regular expression is too complex"',
	decision:
		"8: below half the most anchors the binding shape compiled, 21, whose compile already took minutes; the arcs an anchor crosses bind nothing measured, so no measure weighs them"
})

/**
 * What the two subset-construction bounds share of their evidence: one run of `pnpm bench dfa` (bench/dfa/main.ts),
 * whose output is not committed.
 */
const subsetConstructionRun = {
	evidence:
		"~/.cache/grizzle-release/LIMITS/out/evidence/dfa/ on cassowary: dfa-2026-11-16T075038.json, the uncommitted record of `pnpm bench dfa` (bench/dfa/main.ts), and run.log, its console output with the machine's uptime before it: scalar/regex/dfa.ts minimalDfa under both limits, seven runs a pattern in one process, the first cold, then one run under 16 times each limit, on 29 patterns analyzeText admits: `^(?:a|b)*a(?:a|b){k}$` for k from 6 to 12, 14 and 16 (minimal DFAs of 2^(k+1) states), wide classes over chains of up to 255 copies, chains of 255 copies, and chains of up to 1,024 distinct code points and 512 scattered classes",
	observed: "2026-11-16 07:50:32 to 07:51:05 UTC, one run",
	environment:
		"cassowary, Ubuntu 26.04 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (Neoverse-V1, arm64) instance with 64 logical CPUs and 247 GiB, Node 26.13.1, one single-threaded process; load average 155 over the 64 CPUs from other sessions as it started, so the times are a loaded machine's; grizzle ac71cfbb with lane LIMITS's move of the limits into @grizzle/limits, which changes no construction",
	workload:
		"one pattern's construction at a time, the process's only work, over NFAs of 15 to 4,117 states, parsing and the NFA build untimed",
	revalidate:
		"a change to the subset construction, its alphabet, the minimization or the canonical form (scalar/regex/dfa.ts), or to the NFA builder (scalar/regex/nfa.ts); a Node or V8 upgrade; another machine; a pattern whose construction under the limits takes longer than the slowest here"
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
		"at k = 9 the construction completes, 1,024 minimal states of 1,026 created, in 20.1 ms median; for k = 10, 11, 12, 14 and 16 it stops at this bound in 5.0 to 15.7 ms median, 25.5 ms at worst, where the whole constructions take 42.5, 62.7 and 149.1 ms for k = 10 to 12 (2,050 to 8,194 states) and reach 16 times the bound (32,768 states) in 118.6 and 129.0 ms for k = 14 and 16; `(?:[a-z]{0,255}x){2}` and `(?:[a-z]{0,255}x){8}`, which it cuts in 71.2 and 38.4 ms median, 106.1 ms at worst, reach 16 times it in 3,937.8 and 877.8 ms; memory not measured",
	decision:
		"kept at 2,048: every construction it cuts stops within 110 ms here on a machine loaded past twice its CPUs, well inside what regexDfaMaxWork allows, while past it the run shows constructions of 32,768 states taking up to 3.9 s; a change would change the key, and so the domain digest, of every pattern whose construction lands between the two values; no headroom beyond the run is claimed. The record of 2026-11-05 on a retired macOS VM (bench/results/dfa/dfa-2026-11-05T080355.json there) found the same order: cuts within 40 ms, 925 ms at 16 times"
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
		"the constructions it cuts stop in 17.1 to 370.5 ms median, 666.1 ms at worst (`^(?:.{0,255}){8}$`, at 538 states); among them `^(?:[a-z]{0,255}){8}$`, `^(?:[a-z]{1,255}){16}$` and `^(?:.{0,255}){8}$` stop in 188.9, 260.4 and 370.5 ms median, where their whole constructions take 579, 3,098 and 800 ms (5.5, 23.6 and 5.5 million visits); the slowest construction it admits, `<512 classes of 8 scattered code points>` (513 minimal states, 789,506 visits), completes in 399.6 ms median, 740.2 ms at worst; memory not measured",
	decision:
		"kept at 2,097,152: at it every construction of the run, cut or completed, ends within 750 ms on a machine loaded past twice its CPUs, while the constructions it cuts take up to 3.1 s whole; a change would change the key, and so the domain digest, of every pattern whose construction lands between the two values; no headroom beyond the run is claimed. The record of 2026-11-05 on a retired macOS VM found the same order: within 230 ms, 1.8 s whole"
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
	owner: "PostgreSQL 19rc2",
	unit: "columns",
	scope: "one table, view or materialized view, its dropped columns included",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/access/htup_details.h#L48`,
	quote: "#define MaxHeapAttributeNumber\t1600",
	verified: "2026-11-14"
})

/**
 * The most entries one select list holds, a SELECT's target list or a RETURNING list, each refused as ResourceBound
 * (selectList) where it is printed, since PostgreSQL refuses a longer one with 54011, "target lists can have at most
 * 1664 entries" (src/backend/parser/parse_node.c free_parsestate).
 */
export const selectMaxEntries = published({
	value: 1_664,
	owner: "PostgreSQL 19rc2",
	unit: "entries",
	scope: "one target list of one query level",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/access/htup_details.h#L34`,
	quote: "#define MaxTupleAttributeNumber 1664",
	verified: "2026-11-14"
})

/** PostgreSQL's MaxAllocSize, the largest chunk its allocator hands out, which bounds the messages a backend reads. */
export const maxAllocSize = published({
	value: 0x3fff_ffff,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "one allocation of a backend",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/utils/memutils.h#L40`,
	quote: "#define MaxAllocSize\t((Size) 0x3fffffff)",
	verified: "2026-11-14"
})

/**
 * The most bytes a character of a UTF-8 database takes, pg_database_encoding_max_length() there: the widest UTF-8
 * sequence PostgreSQL reads, which translate allocates for each byte of its operand.
 */
export const utf8EncodingMaxBytes = published({
	value: 4,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "one character of a UTF-8 database, the maxmblen pg_wchar_table holds for PG_UTF8",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/common/wchar.c#L1872`,
	quote:
		"[PG_UTF8] = {pg_utf2wchar_with_len, pg_wchar2utf_with_len, pg_utf_mblen, pg_utf_dsplen, pg_utf8_verifychar, pg_utf8_verifystr, 4},",
	verified: "2026-11-14"
})

/** A varlena's header, VARHDRSZ, which translate's result allocation counts beside its characters. */
export const varlenaHeaderBytes = published({
	value: 4,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope:
		"the header of one variable-length datum, uncompressed and in line: a numeric, a text, a range, a vector",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/c.h#L787`,
	quote: "#define VARHDRSZ\t\t((int32) sizeof(int32))",
	verified: "2026-11-14"
})

/**
 * The most bytes one bytes value holds, the most one bytea holds: a value arrives in binary, which bytearecv copies into
 * an allocation of its bytes and its header, and palloc refuses an allocation past MaxAllocSize, which also bounds a
 * varlena's length word, so no bytea of any writer is longer. A longer value is refused at its boundary (bytesLength),
 * before any SQL.
 */
export const bytesMaxLength: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "one bytes value, one bytea, as bytearecv reads it from a binary parameter",
	from: [maxAllocSize, varlenaHeaderBytes],
	derivation: `bytearecv allocates "result = (bytea *) palloc(nbytes + VARHDRSZ);" for a value of nbytes bytes (${postgresSource}/src/backend/utils/adt/bytea.c#L365, verified 2026-11-14), and "#define AllocSizeIsValid(size) ((Size) (size) <= MaxAllocSize)" (${postgresSource}/src/include/utils/memutils.h#L42), so nbytes is at most MaxAllocSize - VARHDRSZ`,
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
		"~/.cache/grizzle-release/LIMITS/out/evidence/bytes/ on cassowary: bytes-2026-11-16T075151.json, the uncommitted record of `pnpm bench bytes` (bench/bytes/main.ts), and run.log, its console output with the machine's uptime before and after it. The first record, of 2026-11-14 08:03:32 to 08:06:35 UTC at grizzle 01cc8dda (bench/results/bytes/bytes-2026-11-14T080336.json in RC2CITE's clone), went with that clone",
	observed: "2026-11-16 07:51:46 to 07:56:04 UTC, one run",
	environment:
		"cassowary, Ubuntu 26.04 on an AWS Graviton3 (Neoverse-V1, arm64) instance with 64 logical CPUs and 247 GiB, Node 26.13.1, pg 8.23.1, the local PostgreSQL 19rc2 cluster family with scripts/pg/pin.env's three patches, default_toast_compression lz4, grizzle ac71cfbb with lane LIMITS's move of the limits, which changes no delivery; load average 182 to 253 over the 64 CPUs from other sessions",
	workload:
		"one row of one 256 MiB bytes value, once xorshift bytes, which PostgreSQL stores uncompressed, and once a repeating sentence, which it compresses, read back through its delivered SQL on one session and assembled, three runs a chunk length: 64 KiB to 64 MiB by factors of four for the random value, 1 MiB to 64 MiB for the repeating one",
	result:
		"p50 of read and assembly in ms, random: 2,308 at 64 KiB, 1,588 at 256 KiB, 1,638 at 1 MiB, 1,538 at 4 MiB, 1,637 at 16 MiB, 1,548 at 64 MiB; repeating: 15,845 at 1 MiB, 4,778 at 4 MiB, 2,487 at 16 MiB, 1,972 at 64 MiB, the square of the chunks since every chunk's substring decompresses the value from its start. Process rss after a case 2,067 to 3,984 MiB: 3,277 and 3,298 MiB at 16 MiB, 3,645 and 3,984 MiB at 64 MiB. Every value read back whole; no errors. The run of 2026-11-14 at load 5 to 8.5 found the same shape: random flat from 1 MiB, repeating 1,544 ms at 16 MiB and 959 ms at 64 MiB",
	decision:
		"16 MiB: the random value's time is flat from 256 KiB on and no faster at 64 MiB, and the compressed value's falls with the square of the chunks to 2.5 s of 256 MiB at 16 MiB; 64 MiB saves the compressed value about 0.5 s of 256 MiB for 350 to 700 MiB more rss, and a result row holds a base64url chunk of 4/3 of this for each bytes column its statement delivers within MaxAllocSize, which admits 47 such columns at 16 MiB and 11 at 64 MiB",
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
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the operand of one translate(text, text, text) call",
	from: [maxAllocSize, utf8EncodingMaxBytes, varlenaHeaderBytes],
	derivation: `translate refuses "if (unlikely(pg_mul_s32_overflow(pg_database_encoding_max_length(), m, &bytelen)) || unlikely(pg_add_s32_overflow(bytelen, VARHDRSZ, &bytelen)) || unlikely(!AllocSizeIsValid(bytelen)))" over its operand's m bytes (${postgresSource}/src/backend/utils/adt/oracle_compat.c#L854-L864, verified 2026-11-14), and "#define AllocSizeIsValid(size) ((Size) (size) <= MaxAllocSize)" (${postgresSource}/src/include/utils/memutils.h#L42), so m is at most (MaxAllocSize - VARHDRSZ) / maxmblen, rounded down`,
	compute: ([alloc, width, header]) => Math.floor((alloc.value - header.value) / width.value)
})

/**
 * The bytes of one pg_wchar, the wide character PostgreSQL's regex engine reads a text as: an unsigned int, 32 bits on
 * every platform PostgreSQL 19 builds on.
 */
const pgWcharBytes = published({
	value: 4,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope:
		"one pg_wchar, an unsigned int of the platform's C ABI, 32 bits on every platform PostgreSQL builds on",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/mb/pg_wchar.h#L28`,
	quote: "typedef unsigned int pg_wchar;",
	verified: "2026-11-14"
})

/**
 * The longest text, in UTF-8 bytes, PostgreSQL's regex engine reads: before it matches, it widens the text into one
 * pg_wchar per byte and one more, and refuses an allocation past MaxAllocSize ("invalid memory alloc request size"). So
 * a query matches by ~, which Compute.matches is, only an operand whose pattern bounds its bytes within this, and a
 * check or generated column that matches a longer text fails its write.
 */
export const regexTextMaxBytes = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the subject text of one match by ~",
	from: [maxAllocSize, pgWcharBytes],
	derivation: `RE_execute allocates "data = palloc_array(pg_wchar, dat_len + 1);" over its subject's dat_len bytes for ~ (${postgresSource}/src/backend/utils/adt/regexp.c#L332, verified 2026-11-14), and palloc refuses a size past MaxAllocSize, so the length plus one is at most MaxAllocSize / sizeof(pg_wchar), rounded down`,
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
	owner: "PostgreSQL 19rc2's frontend/backend protocol",
	unit: "bytes",
	scope: "one message from client to server, as its Int32 length counts it, itself included",
	from: [maxAllocSize],
	derivation: `a protocol constant, PQ_LARGE_MESSAGE_LIMIT, which libpq.h defines as one less than MaxAllocSize: "#define PQ_LARGE_MESSAGE_LIMIT\t(MaxAllocSize - 1)" (${postgresSource}/src/include/libpq/libpq.h#L34, verified 2026-11-14)`,
	compute: ([alloc]) => alloc.value - 1
})

/**
 * The most placeholders one statement binds: a Bind message counts its parameter values in an unsigned 16-bit field,
 * `numParams = pq_getmsgint(input_message, 2);`
 * (https://github.com/postgres/postgres/blob/REL_19_RC2/src/backend/tcop/postgres.c#L1734), and the count must be the
 * statement's highest `$n` ("bind message supplies %d parameters, but prepared statement \"%s\" requires %d"), so a
 * statement of more is refused as ResourceBound (statementParams) when it is printed.
 */
export const statementMaxParams = published({
	value: 2 ** 16 - 1,
	owner: "PostgreSQL 19rc2's frontend/backend protocol",
	unit: "placeholders",
	scope: "one statement",
	constraint: "protocol constant",
	source: `${postgresSource}/doc/src/sgml/limits.sgml#L115-L116`,
	quote: "<entry>query parameters</entry> <entry>65,535</entry>",
	verified: "2026-11-14"
})

const datatypeSgml = `${postgresSource}/doc/src/sgml/datatype.sgml`

/** The least smallint. */
export const int2Min = published({
	value: -32768,
	owner: "PostgreSQL 19rc2",
	unit: "a smallint value",
	scope: "every smallint value: a column, a parameter, a literal, an endpoint",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L374`,
	quote: "<entry>-32768 to +32767</entry>",
	verified: "2026-11-14"
})

/** The greatest smallint. */
export const int2Max = published({
	value: 32767,
	owner: "PostgreSQL 19rc2",
	unit: "a smallint value",
	scope: "every smallint value: a column, a parameter, a literal, an endpoint",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L374`,
	quote: "<entry>-32768 to +32767</entry>",
	verified: "2026-11-14"
})

/** The least integer. */
export const int4Min = published({
	value: -2147483648,
	owner: "PostgreSQL 19rc2",
	unit: "an integer value",
	scope: "every integer value: a column, a parameter, a literal, an endpoint, a span width",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L380`,
	quote: "<entry>-2147483648 to +2147483647</entry>",
	verified: "2026-11-14"
})

/**
 * The greatest integer, which is also INT_MAX, a C int's greatest value: PostgreSQL's integer is its int32, and a C
 * int is 32 bits on every platform it builds on.
 */
export const int4Max = published({
	value: 2147483647,
	owner: "PostgreSQL 19rc2",
	unit: "an integer value",
	scope: "every integer value: a column, a parameter, a literal, an endpoint, a span width",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L380`,
	quote: "<entry>-2147483648 to +2147483647</entry>",
	verified: "2026-11-14"
})

/** The least bigint, and money's least count of minor units. */
export const int8Min = published({
	value: -9223372036854775808n,
	owner: "PostgreSQL 19rc2",
	unit: "a bigint value",
	scope: "every bigint value and every money count of minor units, a row count included",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L386`,
	quote: "<entry>-9223372036854775808 to +9223372036854775807</entry>",
	verified: "2026-11-14"
})

/** The greatest bigint, and money's greatest count of minor units. */
export const int8Max = published({
	value: 9223372036854775807n,
	owner: "PostgreSQL 19rc2",
	unit: "a bigint value",
	scope: "every bigint value and every money count of minor units, a row count included",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L386`,
	quote: "<entry>-9223372036854775808 to +9223372036854775807</entry>",
	verified: "2026-11-14"
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
	owner: "PostgreSQL 19rc2",
	unit: "bits",
	scope: "one byte of a datum, as a bit string's length and a type's width count it",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/pg_config_manual.h#L111`,
	quote: "#define BITS_PER_BYTE\t\t8",
	verified: "2026-11-14"
})

/**
 * The most codes one roster numbers, its holes included. A closed-id field stores its handle's code as a smallint, and
 * a roster numbers its handles from 0 in the order they were declared, a removed handle leaving its code a hole, so a
 * code is one of smallint's non-negative values. A code is never negative because it is a digit of the mixed-radix
 * index a closed relation's constant is read at, where a negative one would borrow from the digit above it.
 */
export const rosterMaxCodes = derived({
	owner: "PostgreSQL 19rc2",
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
		owner: "PostgreSQL 19rc2",
		unit: "bytes",
		scope: `one ${type} datum, in a heap tuple and in an index entry`,
		constraint: "compile-time constant",
		source: `${pgTypeDat}#L${line}`,
		quote,
		verified: "2026-11-14"
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
	owner: "PostgreSQL 19rc2",
	unit: "bits",
	scope: "one bit varying value: a closed side's constant, as its function returns it",
	from: [int4Max, bitsPerByte],
	derivation: `varbit.h's VARBITMAXLEN, "#define VARBITMAXLEN\t\t(INT_MAX - BITS_PER_BYTE + 1)" (${postgresSource}/src/include/utils/varbit.h#L83, verified 2026-11-14), INT_MAX being the greatest integer`,
	compute: ([intMax, bits]) => intMax.value - bits.value + 1
})

/**
 * The most payload codes one cell of a closed relation's constant holds, its cells read as integers: a cell holds 0 for
 * absent and 1 + c for payload code c, and a read casts its bits to integer, which reads them as an unsigned 32-bit
 * number returned as a signed int4, so a value past the greatest integer reads negative and a cell of more than 32 bits
 * is "integer out of range". A payload space of more codes is refused when its constant is planned.
 */
export const cellMaxCodes = derived({
	owner: "PostgreSQL 19rc2",
	unit: "codes",
	scope:
		"the payload space of one closed relation or side: the codes 1 + c its cells hold, each read as an integer",
	from: [int4Max],
	derivation: `bittoint4 reads a cell's bits as uint32 and returns it as int32, refusing more than 32 bits: "if (VARBITLEN(arg) > sizeof(result) * BITS_PER_BYTE)" and "PG_RETURN_INT32(result)" (${postgresSource}/src/backend/utils/adt/varbit.c#L1593, verified 2026-11-14); the greatest cell, 1 + (codes - 1), is at most the greatest integer`,
	compute: ([max]) => max.value
})

/**
 * The size of PostgreSQL's name type, NAMEDATALEN, its terminating zero byte included: what an identifier and a
 * roster's handle in its names constant are held in.
 */
const namedatalen = published({
	value: 64,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "a name value, its terminating zero included: an identifier, a roster's handle",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/pg_config_manual.h#L39`,
	quote: "#define NAMEDATALEN 64",
	verified: "2026-11-14"
})

/**
 * The most UTF-8 bytes of one roster handle. A roster's names constant holds its handles as one name[], and a name
 * keeps at most NAMEDATALEN - 1 bytes of its text, clipping a longer one at a character boundary: a longer handle would
 * decode clipped, and two that share their first NAMEDATALEN - 1 bytes would decode alike.
 */
export const handleMaxBytes = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "one roster handle in UTF-8, as its roster's names constant holds it in a name",
	from: [namedatalen],
	derivation: `NAMEDATALEN less its terminating zero, as namein clips a name: "len = pg_mbcliplen(s, len, NAMEDATALEN - 1);" (${postgresSource}/src/backend/utils/adt/name.c, verified 2026-11-14)`,
	compute: ([n]) => n.value - 1
})

/** The pinned build's block size, BLCKSZ: the page a heap tuple must fit, and every index entry a share of. */
export const blockSize = published({
	value: 8192,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope:
		"one page of a table or of a B-tree or GiST index of the pinned build, which scripts/pg/source.sh configures by default",
	constraint: "configurable default",
	source: `${postgresSource}/meson_options.txt#L5-L8`,
	quote:
		"option('blocksize', type: 'combo', choices: ['1', '2', '4', '8', '16', '32'], value: '8', description: 'Relation block size, in kilobytes')",
	verified: "2026-11-14"
})

const asyncC = `${postgresSource}/src/backend/commands/async.c`

/**
 * The margin NOTIFY_PAYLOAD_MAX_LENGTH leaves of a page beside a channel's name, which keeps one notification on one
 * SLRU page of the notification queue.
 */
const notifyPayloadMargin = published({
	value: 128,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the part of one notification queue page no channel name and no payload may take",
	constraint: "compile-time constant",
	source: `${asyncC}#L194-L202`,
	quote: "#define NOTIFY_PAYLOAD_MAX_LENGTH	(BLCKSZ - NAMEDATALEN - 128)",
	verified: "2026-11-14"
})

/**
 * NOTIFY_PAYLOAD_MAX_LENGTH, the bytes a notification's payload must stay under: Async_Notify refuses a payload of
 * this many bytes or more with 22023, which fails the statement that sent it, and with it the write.
 */
export const notifyPayloadMaxBytes = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope:
		"one NOTIFY payload in the server encoding, its terminating zero excluded: sent only while shorter",
	from: [blockSize, namedatalen, notifyPayloadMargin],
	derivation: `async.c's "#define NOTIFY_PAYLOAD_MAX_LENGTH (BLCKSZ - NAMEDATALEN - 128)" (${asyncC}#L202) and Async_Notify's "if (payload_len >= NOTIFY_PAYLOAD_MAX_LENGTH) ereport(ERROR, (errcode(ERRCODE_INVALID_PARAMETER_VALUE), errmsg("payload string too long")))" (${asyncC}#L924-L927, verified 2026-11-14)`,
	compute: ([block, name, margin]) => block.value - name.value - margin.value
})

/**
 * The greatest alignment PostgreSQL rounds a tuple and its parts to, MAXIMUM_ALIGNOF: 8 on every platform it builds
 * on, the alignment of int64 and double. An entry measured at the greatest alignment is at least its size at any.
 */
export const maxAlign = published({
	value: 8,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope:
		"the alignment of a heap or index tuple, its header, its attributes and its line pointer's share of a page",
	constraint: "compile-time constant",
	source: `${postgresSource}/meson.build#L1877-L1878`,
	quote:
		"we intentionally do not consider any types wider than 64 bits, as allowing MAXIMUM_ALIGNOF to exceed 8 would be too much of a penalty for disk and memory space",
	verified: "2026-11-14"
})

const storageSgml = `${postgresSource}/doc/src/sgml/storage.sgml`

/** A page's header, PageHeaderData: the bytes every page of a table or an index begins with. */
export const pageHeaderBytes = published({
	value: 24,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the header of every page",
	constraint: "compile-time constant",
	source: `${storageSgml}#L763`,
	quote: "24 bytes long. Contains general information about the page",
	verified: "2026-11-14"
})

/** One line pointer, ItemIdData: the bytes every item a page holds, a heap tuple or an index entry, takes beside it. */
export const itemIdBytes = published({
	value: 4,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the line pointer of every item on a page",
	constraint: "compile-time constant",
	source: `${storageSgml}#L769-L770`,
	quote:
		"Array of item identifiers pointing to the actual items. Each entry is an (offset,length) pair. 4 bytes per item.",
	verified: "2026-11-14"
})

/**
 * A heap tuple's fixed header, SizeofHeapTupleHeader: the bytes every row begins with, before its null bitmap and its
 * columns, which the header's t_hoff rounds up to the greatest alignment.
 */
export const heapTupleHeaderBytes = published({
	value: 23,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope:
		"the fixed header of every heap tuple, before its null bitmap: one row of a stored relation's table",
	constraint: "compile-time constant",
	source: `${storageSgml}#L955-L956`,
	quote: "There is a fixed-size header (occupying 23 bytes on most machines)",
	verified: "2026-11-14"
})

/**
 * A TOAST pointer, TOAST_POINTER_SIZE: the in-line bytes a variable-length column's value moved out of line keeps in
 * its row, whatever the value's size, so the least a varlena column can cost a row.
 */
export const toastPointerBytes = published({
	value: 18,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the in-line pointer of one variable-length value stored out of line",
	constraint: "compile-time constant",
	source: `${storageSgml}#L436-L437`,
	quote:
		"the total size of an on-disk TOAST pointer datum is therefore 18 bytes regardless of the actual size of the represented value",
	verified: "2026-11-14"
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
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope:
		"one heap tuple, its header and alignment padding included: one row of a stored relation's table",
	from: [blockSize, maxAlign, pageHeaderBytes, itemIdBytes],
	derivation: `htup_details.h's MaxHeapTupleSize, "#define MaxHeapTupleSize  (BLCKSZ - MAXALIGN(SizeOfPageHeaderData + sizeof(ItemIdData)))" (${postgresSource}/src/include/access/htup_details.h#L755, verified 2026-11-14): a page less its header and the one line pointer that points at the tuple, rounded up to the greatest alignment, since a heap page has no special space`,
	compute: ([block, align, header, itemId]) =>
		block.value - alignUp(header.value + itemId.value, align.value)
})

/** The decimal digits of the greatest magnitude in [min, max]: the least d with |x| < 10^d for every x of the range. */
/* @__NO_SIDE_EFFECTS__ */
const rangeDigits = (min: bigint, max: bigint): number =>
	Math.max((-min).toString().length, String(max).length)

/**
 * The decimal digits of the greatest magnitude in [min, max] every integer of that many digits reaches: the greatest d
 * with 10^d - 1 within the range on both sides.
 */
/* @__NO_SIDE_EFFECTS__ */
const rangeExactDigits = (min: bigint, max: bigint): number =>
	Math.min(exactDigits(-min), exactDigits(max))

/** The greatest d with 10^d - 1 at most `bound`, a magnitude. */
/* @__NO_SIDE_EFFECTS__ */
const exactDigits = (bound: bigint): number => {
	const digits = String(bound).length
	return 10n ** BigInt(digits) - 1n <= bound ? digits : digits - 1
}

/** The integer digits of a smallint, |x| < 10^int2Digits. */
export const int2Digits: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the integer digits of every smallint value",
	from: [int2Min, int2Max],
	derivation: "the decimal length of smallint's greatest magnitude, -int2Min",
	compute: ([min, max]) => rangeDigits(BigInt(min.value), BigInt(max.value))
})

/** The integer digits of an integer, |x| < 10^int4Digits. */
export const int4Digits: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the integer digits of every integer value",
	from: [int4Min, int4Max],
	derivation: "the decimal length of integer's greatest magnitude, -int4Min",
	compute: ([min, max]) => rangeDigits(BigInt(min.value), BigInt(max.value))
})

/**
 * The integer digits of a bigint, |x| < 10^int8Digits: of a bigint value, of money's count of minor units, and of a
 * count of rows, which PostgreSQL counts in a bigint.
 */
export const int8Digits: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the integer digits of every bigint value, money count and row count",
	from: [int8Min, int8Max],
	derivation: "the decimal length of bigint's greatest magnitude, -int8Min",
	compute: ([min, max]) => rangeDigits(min.value, max.value)
})

/** The most decimal digits every integer of which is a bigint: an exact integer that many digits long travels as one. */
export const int8ExactDigits: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the exact integers SQL computes in bigint rather than numeric",
	from: [int8Min, int8Max],
	derivation: "the greatest d with 10^d - 1 within bigint's range on both sides",
	compute: ([min, max]) => rangeExactDigits(min.value, max.value)
})

/**
 * The fraction digits of money: a money value is a bigint count of minor units, 10^moneyFractionDigits to the unit. It
 * is lc_monetary's frac_digits, and every login pins lc_monetary to C.UTF-8, whose frac_digits is CHAR_MAX, which
 * cash.c replaces with 2 (physical/ddl/roles.ts, admission verifying it).
 */
export const moneyFractionDigits: Limit = published({
	value: 2,
	owner: "PostgreSQL 19rc2 cash.c, lc_monetary C.UTF-8",
	unit: "decimal digits",
	scope:
		"the fraction digits of every money value, its input, its output and its casts to and from numeric",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/backend/utils/adt/cash.c#L210-L221`,
	quote:
		"frac_digits will be CHAR_MAX in some locales, notably C. [...] fpoint = lconvert->frac_digits; if (fpoint < 0 || fpoint > 10) fpoint = 2;",
	verified: "2026-11-14"
})

/** The integer digits of a money amount, |amount| < 10^moneyDigits: a bigint count of minor units, less its fraction. */
export const moneyDigits: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the integer digits of every money amount",
	from: [int8Digits, moneyFractionDigits],
	derivation: "a count below 10^int8Digits minor units, 10^moneyFractionDigits to the unit",
	compute: ([digits, fraction]) => digits.value - fraction.value
})

const numericH = `${postgresSource}/src/include/utils/numeric.h`

/** The greatest precision a numeric typmod declares. */
export const numericMaxPrecision: Limit = published({
	value: 1000,
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope:
		"the precision p of numeric(p, s): a field's, a cast's, a parameter's or a typed literal's",
	constraint: "compile-time constant",
	source: `${numericH}#L35`,
	quote: "#define NUMERIC_MAX_PRECISION\t\t1000",
	verified: "2026-11-14"
})

/** The least scale a numeric typmod declares: a negative scale rounds to a power of ten. */
export const numericMinScale: Limit = published({
	value: -1000,
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the scale s of numeric(p, s)",
	constraint: "compile-time constant",
	source: `${numericH}#L37`,
	quote: "#define NUMERIC_MIN_SCALE\t\t\t(-1000)",
	verified: "2026-11-14"
})

/** The greatest scale a numeric typmod declares. */
export const numericMaxScale: Limit = published({
	value: 1000,
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the scale s of numeric(p, s)",
	constraint: "compile-time constant",
	source: `${numericH}#L38`,
	quote: "#define NUMERIC_MAX_SCALE\t\t\t1000",
	verified: "2026-11-14"
})

/**
 * The most integer digits a numeric value has, |x| < 10^numericMaxIntegerDigits: past it PostgreSQL's arithmetic raises
 * 22003 "value overflows numeric format", so a numeric expression whose bound passes it is ResourceBound.
 */
export const numericMaxIntegerDigits: Limit = published({
	value: 131072,
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the integer digits of every numeric value, a computed one's bound included",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L399`,
	quote: "up to 131072 digits before the decimal point; up to 16383 digits after the decimal point",
	verified: "2026-11-14"
})

/**
 * The most fraction digits a numeric value has: NUMERIC_DSCALE_MAX, past which numeric multiplication rounds
 * (numeric.c mul_var's caller) and a value's text is refused.
 */
export const numericMaxFractionDigits: Limit = published({
	value: 16383,
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the fraction digits of every numeric value, a computed one's bound included",
	constraint: "compile-time constant",
	source: `${datatypeSgml}#L399`,
	quote: "up to 131072 digits before the decimal point; up to 16383 digits after the decimal point",
	verified: "2026-11-14"
})

/**
 * The most fraction digits PostgreSQL gives a division's, a mean's, a square root's or a power's result,
 * NUMERIC_MAX_DISPLAY_SCALE: select_div_scale and its kin take a result scale no larger.
 */
export const numericMaxDisplayScale: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the result scale of numeric division, avg, sqrt and power",
	from: [numericMaxPrecision],
	derivation: `numeric.h defines it as the greatest precision: "#define NUMERIC_MAX_DISPLAY_SCALE\tNUMERIC_MAX_PRECISION" (${numericH}#L43)`,
	compute: ([p]) => p.value
})

/**
 * The significant digits PostgreSQL gives an inexact numeric result at least, NUMERIC_MIN_SIG_DIGITS: a division's,
 * a square root's and a power's result scale is chosen to give that many.
 */
export const numericMinSigDigits: Limit = published({
	value: 16,
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the significant digits select_div_scale and its kin choose a result scale for",
	constraint: "compile-time constant",
	source: `${numericH}#L53`,
	quote: "#define NUMERIC_MIN_SIG_DIGITS\t\t16",
	verified: "2026-11-14"
})

/** The internal limit on a calculation's result scale, NUMERIC_MAX_RESULT_SCALE. */
const numericMaxResultScale: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "the scale of an intermediate numeric result, which exp_var's input bound is three times",
	from: [numericMaxPrecision],
	derivation: `numeric.h: "#define NUMERIC_MAX_RESULT_SCALE\t(NUMERIC_MAX_PRECISION * 2)" (${numericH}#L46)`,
	compute: ([p]) => p.value * 2
})

/** pgvector's most dimensions a vector holds: its storage limit, not the HNSW index's 2,000. */
export const vectorMaxDimensions: Limit = published({
	value: 16000,
	owner: "pgvector 0.8.7",
	unit: "dimensions",
	scope: "one vector value: a column's typmod, a literal, a parameter",
	constraint: "compile-time constant",
	source: "https://github.com/pgvector/pgvector/blob/v0.8.7/src/vector.h#L11",
	quote: "#define VECTOR_MAX_DIM 16000",
	verified: "2026-11-05"
})

/**
 * IEEE 754-2019's binary32 and binary64 parameters as Java SE 21's language specification tabulates them, §4.2.3: "float,
 * whose values exactly correspond to the 32-bit IEEE 754 binary32 floating-point numbers, and double, whose values
 * exactly correspond to the 64-bit IEEE 754 binary64 floating-point numbers" (§4.2), the standard itself not being
 * openly published.
 */
const floatParameters = "https://docs.oracle.com/javase/specs/jls/se21/html/jls-4.html#jls-4.2.3"

/**
 * IEEE 754-2019's binary32 format, the real, a vector component and pgvector's accumulators: its precision p, the bits
 * of its significand.
 */
export const binary32Precision: Limit = published({
	value: 24,
	owner: "IEEE 754-2019 binary32",
	unit: "bits",
	scope: "the significand of every real value and vector component",
	constraint: "protocol constant",
	source: floatParameters,
	quote: "Table 4.2.3-A. Floating-point parameters. N: float 24, double 53",
	verified: "2026-11-05"
})

/** binary32's greatest exponent, emax. */
export const binary32MaxExponent: Limit = published({
	value: 127,
	owner: "IEEE 754-2019 binary32",
	unit: "a binary exponent",
	scope: "the exponent of every finite real value and vector component",
	constraint: "protocol constant",
	source: floatParameters,
	quote: "Table 4.2.3-A. Floating-point parameters. Emax: float +127, double +1023",
	verified: "2026-11-05"
})

/** binary32's least normal exponent, emin. */
export const binary32MinExponent: Limit = published({
	value: -126,
	owner: "IEEE 754-2019 binary32",
	unit: "a binary exponent",
	scope: "the exponent of every normal real value and vector component",
	constraint: "protocol constant",
	source: floatParameters,
	quote: "Table 4.2.3-A. Floating-point parameters. Emin: float -126, double -1022",
	verified: "2026-11-05"
})

/** IEEE 754-2019's binary64 format, double precision and JavaScript's number: its precision p. */
export const binary64Precision: Limit = published({
	value: 53,
	owner: "IEEE 754-2019 binary64",
	unit: "bits",
	scope: "the significand of every double precision value",
	constraint: "protocol constant",
	source: floatParameters,
	quote: "Table 4.2.3-A. Floating-point parameters. N: float 24, double 53",
	verified: "2026-11-05"
})

/** binary64's greatest exponent, emax. */
export const binary64MaxExponent: Limit = published({
	value: 1023,
	owner: "IEEE 754-2019 binary64",
	unit: "a binary exponent",
	scope: "the exponent of every finite double precision value",
	constraint: "protocol constant",
	source: floatParameters,
	quote: "Table 4.2.3-A. Floating-point parameters. Emax: float +127, double +1023",
	verified: "2026-11-05"
})

/** binary64's least normal exponent, emin. */
export const binary64MinExponent: Limit = published({
	value: -1022,
	owner: "IEEE 754-2019 binary64",
	unit: "a binary exponent",
	scope: "the exponent of every normal double precision value",
	constraint: "protocol constant",
	source: floatParameters,
	quote: "Table 4.2.3-A. Floating-point parameters. Emin: float -126, double -1022",
	verified: "2026-11-05"
})

/**
 * C's FLT_DIG and DBL_DIG for a binary format of precision p, floor((p - 1) * log10(2)): the decimal digits every
 * decimal of that many digits round-trips through the format with (C17 5.2.4.2.2), which float4_numeric and
 * float8_numeric write a float to numeric with, "%.*g" (numeric.c).
 */
/* @__NO_SIDE_EFFECTS__ */
const decimalDigitsOf = (p: number): number => Math.floor((p - 1) * Math.log10(2))

const numericC = `${postgresSource}/src/backend/utils/adt/numeric.c`

/** FLT_DIG: the significant digits a real keeps cast to numeric. */
export const binary32DecimalDigits: Limit = derived({
	owner: "PostgreSQL 19rc2 float4_numeric over C's FLT_DIG",
	unit: "decimal digits",
	scope: "the significant digits of a real cast to numeric",
	from: [binary32Precision],
	derivation: `floor((p - 1) * log10(2)), C's FLT_DIG for binary32, the precision float4_numeric prints with: "snprintf(buf, sizeof(buf), "%.*g", FLT_DIG, val);" (${numericC}#L4662)`,
	compute: ([p]) => decimalDigitsOf(p.value)
})

/** DBL_DIG: the significant digits a double precision keeps cast to numeric. */
export const binary64DecimalDigits: Limit = derived({
	owner: "PostgreSQL 19rc2 float8_numeric over C's DBL_DIG",
	unit: "decimal digits",
	scope: "the significant digits of a double precision cast to numeric",
	from: [binary64Precision],
	derivation: `floor((p - 1) * log10(2)), C's DBL_DIG for binary64, the precision float8_numeric prints with: "snprintf(buf, sizeof(buf), "%.*g", DBL_DIG, val);" (${numericC}#L4563)`,
	compute: ([p]) => decimalDigitsOf(p.value)
})

/** The greatest finite value of a format of precision p and greatest exponent emax: (2 - 2^(1-p)) * 2^emax, exactly. */
/* @__NO_SIDE_EFFECTS__ */
const greatestFinite = (p: number, emax: number): bigint =>
	2n ** BigInt(emax + 1) - 2n ** BigInt(emax + 1 - p)

/** The greatest finite binary32 value, (2 - 2^-23) * 2^127. */
export const binary32Max: Limit = derived({
	owner: "IEEE 754-2019 binary32",
	unit: "a real value",
	scope: "every finite real value and vector component",
	from: [binary32Precision, binary32MaxExponent],
	derivation: "(2 - 2^(1-p)) * 2^emax, the all-ones significand at the greatest exponent",
	compute: ([p, emax]) => Number(greatestFinite(p.value, emax.value))
})

/** The binary exponent of binary32's least subnormal's one bit, emin - p + 1: 2^-149. */
export const binary32LeastExponent: Limit = derived({
	owner: "IEEE 754-2019 binary32",
	unit: "a binary exponent",
	scope: "the least nonzero magnitude of a real value and vector component",
	from: [binary32Precision, binary32MinExponent],
	derivation: "emin - p + 1: the least significant bit of a subnormal at the least exponent",
	compute: ([p, emin]) => emin.value - p.value + 1
})

/** The integer digits of every finite binary32 value, |x| < 10^binary32Digits. */
export const binary32Digits: Limit = derived({
	owner: "IEEE 754-2019 binary32",
	unit: "decimal digits",
	scope: "the integer digits of every finite real value",
	from: [binary32Precision, binary32MaxExponent],
	derivation: "the decimal length of the greatest finite value, an integer",
	compute: ([p, emax]) => String(greatestFinite(p.value, emax.value)).length
})

/**
 * The fraction digits of every binary32 value: the least subnormal 2^-k = 5^k / 10^k has exactly k of them, and every
 * other value is an integer multiple of it.
 */
export const binary32FractionDigits: Limit = derived({
	owner: "IEEE 754-2019 binary32",
	unit: "decimal digits",
	scope: "the fraction digits of every finite real value",
	from: [binary32LeastExponent],
	derivation: "-(emin - p + 1): 2^-k is 5^k / 10^k, of k fraction digits",
	compute: ([least]) => -least.value
})

/** The integer digits of every finite binary64 value, |x| < 10^binary64Digits. */
export const binary64Digits: Limit = derived({
	owner: "IEEE 754-2019 binary64",
	unit: "decimal digits",
	scope: "the integer digits of every finite double precision value",
	from: [binary64Precision, binary64MaxExponent],
	derivation: "the decimal length of the greatest finite value, an integer",
	compute: ([p, emax]) => String(greatestFinite(p.value, emax.value)).length
})

/** The fraction digits of every binary64 value: those of its least subnormal, 2^-(p - 1 - emin). */
export const binary64FractionDigits: Limit = derived({
	owner: "IEEE 754-2019 binary64",
	unit: "decimal digits",
	scope: "the fraction digits of every finite double precision value",
	from: [binary64Precision, binary64MinExponent],
	derivation: "-(emin - p + 1): 2^-k is 5^k / 10^k, of k fraction digits",
	compute: ([p, emin]) => p.value - 1 - emin.value
})

/**
 * The cosine domain, the norms between cosineNormMin and cosineNormMax inclusive, as vector_norm computes them: the
 * norms of the vectors pgvector's cosine_distance is a number in [0, 2] for. pgvector 0.8.7's VectorCosineSimilarity
 * (src/vector.c) accumulates the dot product and both squared norms in binary32 floats, in any order and with fused
 * multiply-adds (the Makefile's -fassociative-math -ffp-contract=fast), and returns similarity / sqrt(norma * normb),
 * clamped to [-1, 1] unless it is NaN. A zero norma or normb makes it 0 / 0, NaN, and an infinite one Infinity /
 * Infinity or 0, so the distance is NaN or not the vectors'; and HNSW's vector_cosine_ops never indexes a vector whose
 * vector_norm is not positive (src/hnswutils.c HnswCheckNorm), so an approximate search would miss it. Within the
 * domain every accumulator is positive and finite, the quotient finite, and the clamp yields [0, 2].
 *
 * The least norm keeps norma positive. Its largest square rounds to a positive binary32 value only when it exceeds
 * 2^(emin - p), half the least subnormal, which rounds to zero; a vector of n components has a square of at least
 * norm^2 / n, and with n below 2^ceil(log2(n + 1)) the norm 2^ceil((emin - p + ceil(log2(n + 1))) / 2) makes every
 * vector of at most vectorMaxDimensions components have one, strictly, its 2.4% margin (2^14 / 16000) far above
 * vector_norm's own double rounding. A sum of nonnegative roundings is at least its largest term.
 */
export const cosineNormMin: Limit = derived({
	owner: "pgvector 0.8.7 cosine_distance over IEEE 754-2019 binary32",
	unit: "a vector norm",
	scope: "the norm of every vector a column stores, a parameter binds and a literal states",
	from: [binary32Precision, binary32MinExponent, vectorMaxDimensions],
	derivation:
		"2^ceil((emin - p + ceil(log2(n + 1))) / 2), n = vectorMaxDimensions: the largest of n squares of a vector of this norm exceeds 2^(emin - p), so it rounds to a positive binary32 value",
	compute: ([p, emin, n]) =>
		2 ** Math.ceil((emin.value - p.value + Math.ceil(Math.log2(n.value + 1))) / 2)
})

/**
 * The greatest norm keeps every accumulator finite. A binary32 sum rounds to Infinity once it reaches 2^(emax + 1) -
 * 2^(emax - p), the midpoint past the greatest finite value; n rounded products and n roundings of nonnegative partial
 * sums, in any order, are at most (1 + 2^-p)^n times the exact norm^2, and the dot product's partial sums at most that
 * times |a| |b| (Cauchy-Schwarz). So the greatest power of two whose square times (1 + 2^-p)^n stays below the midpoint
 * bounds both, with every partial sum at most the total; binary64's range holds norma * normb, between 2^-298 and
 * 2^254, exactly.
 */
export const cosineNormMax: Limit = derived({
	owner: "pgvector 0.8.7 cosine_distance over IEEE 754-2019 binary32",
	unit: "a vector norm",
	scope: "the norm of every vector a column stores, a parameter binds and a literal states",
	from: [binary32Precision, binary32MaxExponent, vectorMaxDimensions],
	derivation:
		"2^floor(log2((2^(emax + 1) - 2^(emax - p)) / (1 + 2^-p)^n) / 2), n = vectorMaxDimensions: a squared norm or dot product of vectors of this norm, summed in binary32, stays below the midpoint that rounds to Infinity",
	compute: ([p, emax, n]) =>
		2 **
		Math.floor(
			Math.log2(
				(2 ** (emax.value + 1) - 2 ** (emax.value - p.value)) / (1 + 2 ** -p.value) ** n.value
			) / 2
		)
})

/** A tuple identifier, ItemPointerData. */
const itemPointerBytes: Limit = published({
	value: 6,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the heap tuple identifier an index tuple and a B-tree pivot carry",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/storage/itemptr.h#L30-L31`,
	quote: "The struct is designed to be six bytes long (it contains three int16 fields)",
	verified: "2026-11-14"
})

/** An index tuple's header, IndexTupleData: its heap tuple identifier and its two-byte t_info. */
export const indexTupleHeader: Limit = published({
	value: 8,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the header of every B-tree and GiST index tuple",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/access/itup.h#L35-L51`,
	quote:
		"typedef struct IndexTupleData { ItemPointerData t_tid; unsigned short t_info; } IndexTupleData;",
	verified: "2026-11-14"
})

/** A B-tree page's special space, BTPageOpaqueData: two block numbers, a level, flags and a cycle id. */
const btreeOpaqueBytes: Limit = published({
	value: 16,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the special space of every B-tree page",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/access/nbtree.h#L63-L70`,
	quote:
		"typedef struct BTPageOpaqueData { BlockNumber btpo_prev; BlockNumber btpo_next; uint32 btpo_level; uint16 btpo_flags; BTCycleId btpo_cycleid; } BTPageOpaqueData;",
	verified: "2026-11-14"
})

/** A GiST page's special space, GISTPageOpaqueData: an LSN, a block number, flags and the page id. */
const gistOpaqueBytes: Limit = published({
	value: 16,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the special space of every GiST page",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/access/gist.h#L80-L86`,
	quote:
		"typedef struct GISTPageOpaqueData { PageGistNSN nsn; BlockNumber rightlink; uint16 flags; uint16 gist_page_id; } GISTPageOpaqueData;",
	verified: "2026-11-14"
})

/**
 * The most bytes one set over a roster takes, uncompressed and in line: a bit(n) varlena of its header, its bit count
 * and a byte per eight bits, n its roster's codes. A roster's codes are installation data, which ownership does not
 * hold, so the bound is the one every installation's roster keeps within: its most codes.
 */
export const bitsBytes: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "one set over a roster, its bit(n) datum",
	from: [varlenaHeaderBytes, typlens.int4, rosterMaxCodes, bitsPerByte],
	derivation: `VARBITTOTALLEN(n), "#define VARBITTOTALLEN(BITLEN) (((BITLEN) + BITS_PER_BYTE-1)/BITS_PER_BYTE + VARHDRSZ + VARBITHDRSZ)" with VARBITHDRSZ sizeof(int32) (${postgresSource}/src/include/utils/varbit.h), at n the most codes a roster numbers`,
	compute: ([header, bitLength, codes, bits]) =>
		header.value + bitLength.value + Math.ceil(codes.value / bits.value)
})

/** A range's header, sizeof(RangeType): its varlena header and its range type's OID, which its bounds follow. */
export const rangeHeaderBytes: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the header of one range datum",
	from: [varlenaHeaderBytes, typlens.oid],
	derivation: `sizeof(RangeType), "typedef struct { int32 vl_len_; Oid rangetypid; /* Following the OID are zero to two bound values, then a flags byte */ } RangeType;" (${postgresSource}/src/include/utils/rangetypes.h#L25-L30), which range_serialize counts first: VARHDRSZ and an oid`,
	compute: ([header, oid]) => header.value + oid.value
})

/** A range's flags byte, after its bounds. */
export const rangeFlagBytes: Limit = published({
	value: 1,
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the flags of one range datum",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/backend/utils/adt/rangetypes.c#L2072-L2073`,
	quote: "/* Add space for flag byte */ msize += sizeof(char);",
	verified: "2026-11-14"
})

/** A numeric's header, NUMERIC_HDRSZ: its varlena header, its sign and display scale, and its weight. */
export const numericHeaderBytes: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the long header of one numeric datum, the longest it takes",
	from: [varlenaHeaderBytes, typlens.int2],
	derivation: `"#define NUMERIC_HDRSZ\t(VARHDRSZ + sizeof(uint16) + sizeof(int16))" (${postgresSource}/src/backend/utils/adt/numeric.c#L178): VARHDRSZ and two 16-bit fields, each a smallint's width`,
	compute: ([header, int16]) => header.value + int16.value * 2
})

/** A numeric's NBASE digit, NumericDigit, an int16. */
export const numericDigitBytes: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "one NBASE digit of a numeric datum",
	from: [typlens.int2],
	derivation: `"typedef int16 NumericDigit;" (${postgresSource}/src/backend/utils/adt/numeric.c#L103), a smallint's width`,
	compute: ([int16]) => int16.value
})

const pgvectorSource = "https://github.com/pgvector/pgvector/blob/v0.8.7/src/vector.h"

/** A vector's header, offsetof(Vector, x): its varlena header, its dimension count and a reserved field. */
export const vectorHeaderBytes: Limit = derived({
	owner: "pgvector 0.8.7",
	unit: "bytes",
	scope: "the header of one vector datum, which its components follow",
	from: [varlenaHeaderBytes, typlens.int2],
	derivation: `offsetof(Vector, x) in VECTOR_SIZE, "#define VECTOR_SIZE(_dim)\t\tadd_size(offsetof(Vector, x), mul_size(sizeof(float), _dim))" (${pgvectorSource}#L13), of "typedef struct Vector { int32 vl_len_; int16 dim; int16 unused; float x[FLEXIBLE_ARRAY_MEMBER]; } Vector;" (${pgvectorSource}#L18-L24): VARHDRSZ and two int16 fields, each a smallint's width; each component a C float, a real ("typedef float float4;", c.h)`,
	compute: ([header, int16]) => header.value + int16.value * 2
})

/* @__NO_SIDE_EFFECTS__ */
export const alignDown = (n: number, a: number): number => Math.floor(n / a) * a

/** The most bytes one B-tree entry takes: BTMaxItemSize, a third of a page, its pivot's heap tuple identifier left. */
export const btreeMaxItemSize: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "one B-tree index entry, a key's index's among them",
	from: [blockSize, maxAlign, pageHeaderBytes, itemIdBytes, btreeOpaqueBytes, itemPointerBytes],
	derivation: `nbtree.h's BTMaxItemSize: MAXALIGN_DOWN((BLCKSZ - MAXALIGN(SizeOfPageHeaderData + 3*sizeof(ItemIdData)) - MAXALIGN(sizeof(BTPageOpaqueData))) / 3) - MAXALIGN(sizeof(ItemPointerData)) (${postgresSource}/src/include/access/nbtree.h#L165-L169), three entries to a page`,
	compute: ([block, align, header, itemId, opaque, pointer]) =>
		alignDown(
			(block.value -
				alignUp(header.value + 3 * itemId.value, align.value) -
				alignUp(opaque.value, align.value)) /
				3,
			align.value
		) - alignUp(pointer.value, align.value)
})

/** The most bytes one GiST entry takes: an empty page, GiSTPageSize, less its one line pointer. */
export const gistMaxItemSize: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "one GiST index entry, a span key's among them",
	from: [blockSize, maxAlign, pageHeaderBytes, gistOpaqueBytes, itemIdBytes],
	derivation: `gist_private.h's GiSTPageSize, BLCKSZ - SizeOfPageHeaderData - MAXALIGN(sizeof(GISTPageOpaqueData)) (${postgresSource}/src/include/access/gist_private.h#L474-L475), less the entry's one ItemIdData, as gistfitpage counts it`,
	compute: ([block, align, header, opaque, itemId]) =>
		block.value - header.value - alignUp(opaque.value, align.value) - itemId.value
})

/** The most columns one index holds, INDEX_MAX_KEYS: a key's index has one per field. */
export const indexMaxKeys: Limit = published({
	value: 32,
	owner: "PostgreSQL 19rc2",
	unit: "columns",
	scope: "one index: a key's, a span key's GiST constraint, an access path's",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/pg_config_manual.h#L79`,
	quote: "#define INDEX_MAX_KEYS\t\t32",
	verified: "2026-11-14"
})

/**
 * An index tuple's null bitmap, IndexAttributeBitMapData: a bit for each of INDEX_MAX_KEYS columns, whatever the index's
 * own count, which follows the header exactly when the tuple holds a null.
 */
export const indexNullBitmapBytes: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "the null bitmap of one index tuple that holds a null",
	from: [indexMaxKeys, bitsPerByte],
	derivation: `"typedef struct IndexAttributeBitMapData { uint8 bits[(INDEX_MAX_KEYS + 8 - 1) / 8]; }" (${postgresSource}/src/include/access/itup.h#L55-L58, verified 2026-11-14): a byte per eight of INDEX_MAX_KEYS bits, C's integer division`,
	compute: ([keys, bits]) => Math.floor((keys.value + bits.value - 1) / bits.value)
})

/** The largest block number of a relation: its pages are numbered from 0 to it. */
const maxBlockNumber = published({
	value: 0xffff_fffe,
	owner: "PostgreSQL 19rc2's storage manager",
	unit: "pages, as their block numbers count them from 0",
	scope: "one relation's main fork",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/storage/block.h#L35`,
	quote: "#define MaxBlockNumber\t\t\t((BlockNumber) 0xFFFFFFFE)",
	verified: "2026-11-14"
})

/** The largest page PostgreSQL can be built with, so a bound on rows per page at it bounds every build's. */
const largestBlockSize = published({
	value: 32_768,
	owner: "PostgreSQL 19rc2's build",
	unit: "bytes",
	scope: "one heap page, under the largest block size configure admits",
	constraint: "compile-time constant",
	source: `${postgresSource}/configure.ac#L257`,
	quote: " 32) BLCKSZ=32768;;",
	verified: "2026-11-14"
})

/**
 * More rows than one stored relation can hold under any build: every page of a relation, each holding fewer tuples
 * than its space after the header over the least a tuple takes, its fixed header and its line pointer (the bound
 * MaxHeapTuplesPerPage computes with the header aligned, src/include/access/htup_details.h).
 */
const storedMaxRows = derived({
	owner: "PostgreSQL 19rc2's heap storage",
	unit: "rows",
	scope: "one stored relation, at any block size",
	from: [maxBlockNumber, largestBlockSize, pageHeaderBytes, heapTupleHeaderBytes, itemIdBytes],
	derivation:
		"(maxBlockNumber + 1) pages times floor((largestBlockSize - pageHeaderBytes) / (heapTupleHeaderBytes + itemIdBytes)) tuples a page: 4,294,967,295 × 1,212 = 5,205,500,361,540, thirteen digits",
	compute: ([blocks, page, header, tuple, pointer]) =>
		BigInt(blocks.value + 1) *
		BigInt(Math.floor((page.value - header.value) / (tuple.value + pointer.value)))
})

/**
 * The largest j of a dyadic fraction m / 2^j the discrete rewrite admits (see tryPercentile), the least of the two
 * exponents its proof needs: the product x = p · n of such a fraction and a row count n of a stored relation is exact
 * in double precision while m · n stays within its significand, every integer up to 2^binary64Precision (ECMAScript's
 * double precision is the IEEE 754 binary64 PostgreSQL's is); and numeric's cast keeps x's fractional part of at least
 * 2^-j from rounding to zero while 2^-j is more than half a unit in the last decimal place the cast keeps of x,
 * binary64DecimalDigits less the digits of storedMaxRows.
 */
export const maxDyadicExponent = derived({
	owner: "grizzle's percentile rewrite (lower/shapes/catalog/percentile.ts)",
	unit: "binary exponent of a fraction's denominator",
	scope: "one discrete percentile's fraction",
	from: [binary64DecimalDigits, binary64Precision, storedMaxRows],
	derivation:
		"min(the largest j with 2^j × storedMaxRows ≤ 2^binary64Precision (2^53), which is 10; the largest j with 2^-j > 0.5 × 10^-(binary64DecimalDigits - 13), that is 2^j < 2 × 10^(15 - 13), which is 7) = 7",
	compute: ([digits, precision, rows]) => {
		const kept = digits.value - String(rows.value).length
		let rounding = 0
		while (2n ** BigInt(rounding + 1) < 2n * 10n ** BigInt(kept)) {
			rounding++
		}
		let exact = 0
		while (2n ** BigInt(exact + 1) * rows.value <= 2n ** BigInt(precision.value)) {
			exact++
		}
		return Math.min(rounding, exact)
	}
})

const parseDoubleOwner =
	"grizzle's parse of a double's decimal text (lower/conservative/expr/parse-double.ts)"

/**
 * The most significant decimal digits a point at which binary64's rounding changes has: every such point, a midpoint
 * between two neighbouring doubles, the overflow threshold and half the least subnormal, is an odd multiple of
 * 2^(e - p) for some e at least emin, below 2^(e + 1); its digits are the odd multiplier's times 5^(p - e) where e < p,
 * most at e = emin, and at most binary64's integer digits elsewhere. So a decimal cut to this many significant digits,
 * with one nonzero digit after them where it had more, lies on the same side of every such point as the decimal itself,
 * and rounds and compares with the thresholds alike.
 */
export const boundaryDigits: Limit = derived({
	owner: parseDoubleOwner,
	unit: "decimal digits",
	scope: "the significant digits of a double's text read into the numeric it rounds from",
	from: [binary64Precision, binary64MinExponent],
	derivation:
		"the digits of (2^(p + 1) - 1) * 5^(p - emin), the greatest odd multiplier below 2^(p + 1) times the least weight 2^(emin - p) of a rounding point, written in decimal",
	compute: ([p, emin]) =>
		(((1n << BigInt(p.value + 1)) - 1n) * 5n ** BigInt(p.value - emin.value)).toString().length
})

/**
 * The magnitude a double's text's decimal exponent is clamped to: a decimal 0.d... * 10^e with e above the digits of
 * 2^(emax + 1) is past the overflow threshold, and one with e at most -(p - emin - digits(5^(p - emin)) + 1) is below
 * half the least subnormal, 2^(emin - p) = 5^(p - emin) * 10^(emin - p), so clamping e into [-reach, reach] keeps every
 * decimal on the side of both thresholds it was on, and the numeric read from it within numeric's digits.
 */
export const exponentReach: Limit = derived({
	owner: parseDoubleOwner,
	unit: "a decimal exponent",
	scope: "the decimal exponent of the numeric a double's text is read into",
	from: [binary64Precision, binary64MinExponent, binary64MaxExponent],
	derivation:
		"max(digits(2^(emax + 1)) + 1, (p - emin) - digits(5^(p - emin)) + 1): past the first every value overflows, at or below the second's negation every value is below half the least subnormal",
	compute: ([p, emin, emax]) =>
		Math.max(
			(1n << BigInt(emax.value + 1)).toString().length + 1,
			p.value - emin.value - (5n ** BigInt(p.value - emin.value)).toString().length + 1
		)
})

/**
 * The most dimensions pgvector's HNSW index indexes: an indexed vector space of more is refused at compile time
 * (trace.ts), since CREATE INDEX would refuse it.
 */
export const hnswMaxDimensions = published({
	value: 2000,
	owner: "pgvector 0.8.7",
	unit: "dimensions",
	scope: "the vector column of one HNSW index",
	constraint: "compile-time constant",
	source: "https://github.com/pgvector/pgvector/blob/v0.8.7/src/hnsw.h#L33",
	quote: "#define HNSW_MAX_DIM 2000",
	verified: "2026-11-05"
})

/** The most columns one extended statistics object covers, STATS_MAX_DIMENSIONS. */
export const statisticsMaxColumns: Limit = published({
	value: 8,
	owner: "PostgreSQL 19rc2",
	unit: "columns",
	scope: "one extended statistics object: a request's and an access path's",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/include/statistics/statistics.h#L19`,
	quote: "#define STATS_MAX_DIMENSIONS\t8\t/* max number of attributes */",
	verified: "2026-11-14"
})

/**
 * PostgreSQL's default join_collapse_limit, which is from_collapse_limit's too: the most FROM items the planner flattens
 * one join problem into, and plans exhaustively, before it plans the rest as separate subproblems in the order written.
 * No grizzle session sets either, so the default is the value every statement is planned under. The docs state it
 * through from_collapse_limit, "By default, this variable is set the same as from_collapse_limit", whose "default is
 * eight" (https://www.postgresql.org/docs/19/runtime-config-query.html).
 */
export const collapseLimit = published({
	value: 8,
	owner: "PostgreSQL 19rc2's planner",
	unit: "FROM items",
	scope:
		"one join problem the planner flattens, under the session default no grizzle session changes",
	constraint: "configurable default",
	source: `${postgresSource}/src/backend/utils/misc/guc_parameters.dat#L1538-L1546`,
	quote:
		"{ name => 'join_collapse_limit', type => 'int', context => 'PGC_USERSET', [...] boot_val => '8',",
	verified: "2026-11-14"
})

/**
 * The bound PostgreSQL's power_var puts on exp(y · ln x) for an exponent that is no integer (numeric.c power_var, its
 * test before exp_var, and exp_var's own): y · ln x below NUMERIC_MAX_RESULT_SCALE · 3, at which it raises 22003
 * "value overflows numeric format".
 */
export const powerExpLimit: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "a natural logarithm",
	scope: "y · ln x of a power with an exponent that is no integer",
	from: [numericMaxResultScale],
	derivation:
		'exp_var\'s overflow test, three times the result scale: "if (fabs(val) >= NUMERIC_MAX_RESULT_SCALE * 3)" (https://github.com/postgres/postgres/blob/REL_19_RC2/src/backend/utils/adt/numeric.c#L10503)',
	compute: ([scale]) => scale.value * 3
})

/**
 * The decimal digits of one of numeric's NBASE digits, DEC_DIGITS: a weight counts NBASE digits, which
 * select_div_scale reads a quotient's weight in. A format constant of PostgreSQL's numeric, which grizzle's division
 * reproduces.
 */
export const decDigits: Limit = published({
	value: 4,
	owner: "PostgreSQL 19rc2",
	unit: "decimal digits",
	scope: "one NBASE digit of a numeric value, the unit of its weight",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/backend/utils/adt/numeric.c#L99`,
	quote: "#define DEC_DIGITS\t4\t\t\t/* decimal digits per NBASE digit */",
	verified: "2026-11-14"
})

/**
 * The greatest exponent magnitude a numeric's text may write: set_var_from_str refuses a greater one before anything
 * else.
 */
export const maxExponent: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "a decimal exponent",
	scope: "the exponent of a numeric text a caller writes, `1e5` and `1E-5`",
	from: [int4Max],
	derivation:
		'PG_INT32_MAX / 2 in C integer division, numeric.c set_var_from_str (https://github.com/postgres/postgres/blob/REL_19_RC2/src/backend/utils/adt/numeric.c#L6927, "if (exponent > PG_INT32_MAX / 2)")',
	compute: ([max]) => Math.trunc(max.value / 2)
})

/**
 * The most UTF-8 bytes of a member of decimalText's form: every decimal text of at most this many bytes names a value
 * plain numeric holds, its point taking a byte, so it has at most numericMaxFractionDigits digits past the point and no
 * more before it than numericMaxIntegerDigits; one byte more admits `.` and numericMaxFractionDigits + 1 digits, which
 * numeric_in refuses as "value overflows numeric format".
 */
export const decimalTextMaxBytes: Limit = derived({
	owner: "grizzle's lexical forms",
	unit: "UTF-8 bytes",
	scope: "a decimal text Compute.parseDecimal reads, the bytes of its form's every member",
	from: [numericMaxFractionDigits, numericMaxIntegerDigits],
	derivation:
		"numericMaxFractionDigits + 1, the point and the most fraction digits numeric holds, at most numericMaxIntegerDigits so its integer digits fit as well",
	compute: ([fraction, integer]) => Math.min(fraction.value + 1, integer.value)
})

/**
 * The significant digits of a double precision mantissa on either side of its point: DBL_DIG, the digits every
 * decimal of which survives binary64 unchanged, so no admitted mantissa is longer than a double resolves.
 */
export const doubleMantissaDigits: Limit = derived({
	owner: "grizzle's lexical forms",
	unit: "decimal digits",
	scope:
		"the significant digits of a double precision lexical form's mantissa, before its point and after it",
	from: [binary64DecimalDigits],
	derivation:
		"DBL_DIG: every decimal of that many significant digits rounds to a binary64 value and back unchanged",
	compute: ([digits]) => digits.value
})

/**
 * The greatest decimal exponent of a double precision lexical form: the mantissa is below 10^DBL_DIG and, when
 * nonzero, at least 10^-DBL_DIG, so with |exponent| at most binary64Digits - 1 - DBL_DIG every value but zero lies in
 * [10^-(binary64Digits - 1), 10^(binary64Digits - 1)): below the greatest finite binary64, so float8in never
 * overflows to infinity, and above the least subnormal, 2^-1074, so it never underflows to zero, the two results
 * float8in refuses.
 */
export const doubleExponentMax: Limit = derived({
	owner: "grizzle's lexical forms",
	unit: "a decimal exponent",
	scope: "the magnitude of a double precision lexical form's exponent",
	from: [binary64Digits, doubleMantissaDigits],
	derivation:
		"binary64Digits - 1 - DBL_DIG: the mantissa's own magnitude, up to DBL_DIG digits either side of its point, plus the exponent stays inside binary64's finite nonzero range",
	compute: ([digits, mantissa]) => digits.value - 1 - mantissa.value
})

const floatP = `${postgresSource}/doc/src/sgml/datatype.sgml#L905-L910`

/** The greatest binary precision float(p) maps to real: real's own, binary32's. */
export const floatRealPrecision: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bits",
	scope: "the binary precision p of float(p) that selects real",
	from: [binary32Precision],
	derivation: `p names the least binary precision, and real is binary32, so float(1) through float(binary32's precision) select real: "accepts float(1) to float(24) as selecting the real type" (${floatP})`,
	compute: ([p]) => p.value
})

/** The greatest binary precision float(p) admits: double precision's own, binary64's. */
export const floatDoublePrecision: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bits",
	scope: "the binary precision p of float(p) that selects double precision",
	from: [binary64Precision],
	derivation: `double precision is binary64, so float(p) past real's precision through binary64's selects it and a greater p draws an error: "float(25) to float(53) select double precision. Values of p outside the allowed range draw an error." (${floatP})`,
	compute: ([p]) => p.value
})

/**
 * The longest identifier PostgreSQL keeps, in bytes: a longer one is truncated, so two names that differ past it are
 * one name.
 */
export const maxIdentifierBytes: Limit = derived({
	owner: "PostgreSQL 19rc2",
	unit: "bytes",
	scope: "one identifier: an object's, a column's, a role's or a temporary table's name",
	from: [namedatalen],
	derivation:
		'NAMEDATALEN less its terminating zero: "The system uses no more than NAMEDATALEN-1 bytes of an identifier; longer names can be written in commands, but they will be truncated." (https://github.com/postgres/postgres/blob/REL_19_RC2/doc/src/sgml/syntax.sgml#L133-L135)',
	compute: ([n]) => n.value - 1
})

/**
 * The longest file name the operating system states, NAME_MAX: a migration folder is one directory entry, created where
 * it is drafted and wherever its repository is checked out. Darwin's NAME_MAX, whose comment reads "max bytes in a file
 * name", is Linux's too (https://github.com/torvalds/linux/blob/v7.3/include/uapi/linux/limits.h#L12, "#define
 * NAME_MAX         255"). A file system may admit a longer name (pathconf's _PC_NAME_MAX); grizzle writes none longer.
 */
export const fileNameMaxBytes = published({
	value: 255,
	owner: "Darwin (xnu 12377.121.6), and Linux alike",
	unit: "bytes",
	scope: "one file name, a single path component such as a migration folder's name",
	constraint: "compile-time constant",
	source:
		"https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.121.6/bsd/sys/syslimits.h#L103",
	quote: "#define NAME_MAX                  255",
	verified: "2026-11-05"
})

/** The source and the quote that state a Node timer's delay range, the least and the longest it keeps. */
const nodeTimers = {
	constraint: "protocol constant",
	source: "https://nodejs.org/docs/v26.13.0/api/timers.html#settimeoutcallback-delay-args",
	quote:
		"When `delay` is larger than `2147483647` or less than `1` or `NaN`, the `delay` will be set to `1`.",
	verified: "2026-11-05"
} as const

/**
 * The least delay a Node timer waits: pg's connect timeout and pg-pool's idle timeout are Node timers, and grizzle
 * admits a connectTimeoutMs, an idleTimeoutMs or a heartbeatMs from it.
 */
export const timerMinMs: Limit = published({
	value: 1,
	owner: "Node.js 26.13.0 timers",
	unit: "milliseconds",
	scope:
		"a connection's connectTimeoutMs, a DbConfig's pool.idleTimeoutMs and an HttpConfig's heartbeatMs, each the delay of a Node timer",
	...nodeTimers
})

/**
 * The longest delay a Node timer keeps: pg's connect timeout and pg-pool's idle timeout are Node timers, and one longer
 * is set to 1, so it fires at once.
 */
export const timerMaxMs: Limit = published({
	value: 2_147_483_647,
	owner: "Node.js 26.13.0 timers",
	unit: "milliseconds",
	scope:
		"a connection's connectTimeoutMs, a DbConfig's pool.idleTimeoutMs and an HttpConfig's heartbeatMs, each the delay of a Node timer",
	...nodeTimers
})

/**
 * The largest port number: TCP's, the transport a connection's socket runs over, whose port numbers are 16 bits, the
 * Dynamic Ports ending the range.
 */
export const portMax = published({
	value: 65_535,
	owner: "the IETF's transport port number registries (RFC 6335)",
	unit: "port numbers",
	scope: "the port of one connection's host",
	constraint: "protocol constant",
	source: "https://www.rfc-editor.org/rfc/rfc6335.html#section-6",
	quote:
		"the Dynamic Ports, also known as the Private or Ephemeral Ports, from 49152-65535 (never assigned)",
	verified: "2026-11-05"
})

/**
 * c*, the network test files one member of the family runs at once. Every cost it divides is the member's own, a
 * cluster's, and grows with the files that share it: the SSI LWLocks (SerializableFinishedList, SerializableXactHash,
 * SerializablePredicateList) and SxactGlobalXmin, which every SERIALIZABLE transaction of the cluster shares; the safe
 * snapshot a DEFERRABLE read waits for, until every SERIALIZABLE writer of the cluster that began before it has ended;
 * and the one checkpointer, which syncs every file the cluster wrote since its last checkpoint. So it bounds the files
 * per member, and the members' count follows from it (familyMembers), each member's memory from its share (size.ts
 * clusterSize), so a family's total stays what one cluster sized for every worker would hold.
 */
export const filesPerCluster: Limit = measured({
	value: 16,
	owner: "grizzle's network test tier (packages/pg/src/family.ts)",
	unit: "test files",
	scope:
		"the network test files one member of the local cluster family runs at once, each in a Vitest worker of its own, at a run's width (the testing library's testWorkers, one file per core), on a member sized for its share",
	evidence:
		"packages/experiments/cluster-share at 14b2e2b9 (deleted in the commit after it): two checkouts of grizzle 0b7b5f31 that differ only in this value, each tagged by tag.sh and on a private family pnpm pg:init made from it (2 members at 32, 4 at 16), run at once by `TEST_SEED=1234567 pair.sh <out> c32 <tree> 5771 c16 <tree> 5781`, every member's pg_stat_activity sampled each second and its SERIALIZABLE transactions every ten as the bootstrap superuser, then `compare.sh <out> c32 c16` with the seven files failing for causes outside this value left out; each member's checkpoint lines from its server log; uncommitted run files in ~/.cache/grizzle-release/IDLEXACT/measure (c32.out, c16.out, c32.wall, c16.wall, c32.<port>.samples, c16.<port>.samples, checkpoints.<port>.log, verdict.txt)",
	observed:
		"2026-11-14 23:08:31 to 2026-11-15 02:06:52 UTC, the two runs at once (16's ended at 01:49:31)",
	environment:
		"cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GB of memory, shared with other lanes' runs (1-minute load 300 to 455 during the runs); the local PostgreSQL 19rc2 (scripts/pg/pin.env), each member sized by pnpm pg:init for its share (size.ts clusterSize: at 32, shared_buffers 1216256 kB and max_connections 2215 a member; at 16, 608128 kB and 1111); grizzle 0b7b5f31 with vendor/toolchain at its pin, whose testWorkers is availableParallelism(), 64; Node 26.13.1, Vitest 5.1.0",
	workload:
		"the whole network tier, 342 files and 594 tests, at 64 workers, TEST_SEED=1234567: at 32, 2 members of 32 files each; at 16, 4 members of 16; the two runs at once, one run at each value",
	result:
		"Wall time 10701 s at 32 and 9660 s at 16, both set by test/pg/substrate/tree.test.ts, the last file of both, cut by its hour (10515 s and 9230 s). Over the 311 files both runs passed, leaving out pg/fin/plans, schedules/install/database-default, pg/serverless/pool, pg/sql/print, pg/migrate/redraft, pg/live/routing and pg/world-model/inductive: 236111 s summed at 32 and 169681 s at 16, a ratio of 0.72, the per-file ratio's median 0.70 and geometric mean 0.69. Files cut by their hour: 23 at 32, 13 at 16, each of 16's also cut at 32 but pg/live/exactness; no other failure. SSI LWLock waiters, as a share of the active backends: 8% and 10% of the members at 32; 1%, 2%, 5% and 1% at 16 (92% on one cluster at be5f3ec4). The oldest SERIALIZABLE transaction: 571 s at 32, 439 s at 16 beside serverless/pool's hung lease (3591 s). Freeze windows (10 s and more with at most two backends on the CPU and half the active ones waiting on SSI's LWLocks): none at 32; one of 12 s at 16, as the hung lease's transaction ended. Checkpoints back to back on every member: 1.07 and 1.11 million files synced a member at 32, 0.59 to 0.92 million at 16, the longest 2267 s and 2296 s. Safe-snapshot waits past 10 s: 5482 samples at 32, 3236 at 16 (2326 of them behind the hung lease). A family's shared memory: 2 x 1454 MB at 32, 4 x 738 MB at 16. No cluster errors",
	decision:
		"16: at this load every measure favors it over 32: 28% less time over the files both runs passed, the ratio steady across them (median 0.70), 9.7% less wall time, ten fewer hour cuts, a tenth to a half of 32's SSI waiting share and less checkpoint sync work a member, for 44 MB more shared memory a family, since each member's memory follows its share (size.ts clusterSize, and init.sh --adopt sizes the members a growing family keeps). Every coupling it divides is a cluster's own, so the quantity is the files one member runs at once. One run at each value, at one seed, on a loaded machine; below 16 is unmeasured. No headroom added",
	revalidate:
		"a run at 8, and at 16 again, at a quiet window; a network tier whose files hold more SERIALIZABLE transactions or hold them longer, or create more databases (the checkpoints' sync work); a change of SSI's settings (max_pred_locks_*), of the checkpoint settings or of the lease's grant (leaseGrant); a PostgreSQL repin; another machine or core count"
})

/**
 * How long a backend runs a statement between two polls of its client's socket, PostgreSQL's
 * client_connection_check_interval, which every member holds (clusterSettings). A backend polls only while it runs a
 * statement (the timer start_xact_command arms, REL_19_RC2 src/backend/tcop/postgres.c#L2818), so an idle
 * session is never woken; a poll that finds the socket closed (pq_check_connection, src/backend/libpq/pqcomm.c#L2057)
 * ends the backend with FATAL "connection to client lost" (postgres.c#L3465), and with it the transaction id it holds.
 * Without it PostgreSQL notices a dead client only when it next reads from or writes to the socket, which a statement
 * that never ends never does: a test process ended mid-statement (its hang guard, a SIGKILL, a defect whose SQL never
 * ends) leaves its backend running and holding its transaction id, and every logical slot's creation on the member
 * (CREATE_REPLICATION_SLOT, a live source's) waits for every transaction id running when it starts.
 */
export const clientCheckInterval: Limit = measured({
	value: 1000,
	owner: "grizzle's local cluster (scripts/pg/init.sh)",
	unit: "milliseconds",
	scope:
		"one backend of a family member while it runs a statement: the time between two polls of its client's socket, and so the longest it outlives its client's death before its next poll",
	evidence:
		"one psql session's \\timing (psql -X -At -f) on the postmaster below: `SET client_connection_check_interval = 0` and `= 1000` in turn, each followed by `WITH RECURSIVE r(i) AS (SELECT 1::int8 UNION ALL SELECT i + 1 FROM r WHERE i < 20000000) SELECT count(*) FROM r`, eight times each after one warm run; its output kept at ~/.cache/grizzle-release/ORPHAN/out/cost.txt on cassowary",
	observed: "2026-11-15 14:14:02 to 14:15:40 UTC, one run",
	environment:
		"cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores, load average 16 to 22 from other sessions; a throwaway postmaster of the pinned PostgreSQL 19rc2 build (scripts/pg/pin.env, its three patches, none touching postgres.c or pqcomm.c) at initdb's defaults, no other session on it; grizzle 17b28413",
	workload:
		"one backend running a CPU-bound statement of 20,000,000 recursive steps, about 5.7 s, which polls five times a run at 1,000 ms and never at 0, the two in alternation",
	result:
		"at 0: median 5,762.8 ms, 5,751.8 to 6,018.1; at 1,000: median 5,754.7 ms, 5,727.0 to 5,811.3. The polls' cost is below the runs' own spread. Beside it, backends of SIGKILLed psql clients, each holding a transaction id and computing, in pg_sleep or waiting on an advisory lock, left pg_stat_activity 1,000 to 1,017 ms after the kill at 1,000, each with FATAL connection to client lost; the incident's orphans at 0 ran 44 minutes to 5.7 hours",
	decision:
		"1,000 ms: its polls cost nothing measurable on a statement of seconds, and an orphan then holds its transaction id at most about a second past its client's death, against hours without. No shorter value is measured: the polls' cost grows as one over the interval, and a slot creation waiting a second behind an orphan waits far less than any test's own hang limit",
	revalidate:
		"a PostgreSQL repin; a poll's cost measured above the runs' spread; a test that waits behind an orphan for less than the interval; another machine"
})

/** PostgreSQL's source of its settings' defaults. */
const settingDefaults = `${postgresSource}/src/backend/utils/misc/guc_parameters.dat`

/** The connections PostgreSQL keeps for superusers alone, at its default, which scripts/pg/init.sh leaves as it is. */
export const superuserReservedConnections = published({
	value: 3,
	owner: "PostgreSQL 19rc2",
	unit: "connections",
	scope: "the local cluster's superuser_reserved_connections, out of its max_connections",
	constraint: "configurable default",
	source: `${settingDefaults}#L2941`,
	quote: "boot_val => '3',",
	verified: "2026-11-14"
})

/** The connections PostgreSQL keeps for pg_use_reserved_connections, at its default, which init.sh leaves as it is. */
export const reservedConnections = published({
	value: 0,
	owner: "PostgreSQL 19rc2",
	unit: "connections",
	scope: "the local cluster's reserved_connections, out of its max_connections",
	constraint: "configurable default",
	source: `${settingDefaults}#L2552`,
	quote: "boot_val => '0',",
	verified: "2026-11-14"
})

/**
 * The largest database a network worker's files work in, measured: each worker's shared database, which file after
 * file reuses, as autovacuum leaves its catalogs between their schemas.
 */
const workerDatabaseBytes: Limit = measured({
	value: 38_916_935,
	owner: "grizzle's network test tier",
	unit: "bytes",
	scope:
		"one network worker's database: its shared database (gz_shared_<n>), or a file's own clone of the template, as pg_database_size reports it",
	evidence:
		"pg_database_size of every gz_ database on the local cluster: `SELECT datname, pg_database_size(oid) FROM pg_catalog.pg_database WHERE datname LIKE 'gz\\_%'`, as the bootstrap superuser (scripts/pg/ctl.sh admin)",
	observed: "one reading on 2026-11-14 at 00:44 UTC",
	environment:
		"cassowary, Ubuntu 26.04 on arm64 in AWS, the local PostgreSQL 19rc2 cluster (scripts/pg/pin.env), grizzle 1623175d",
	workload:
		"every network run on the cluster since its 19rc2 init on 2026-11-13, each worker's files reusing its shared database, six workers then",
	result:
		"gz_shared_1 to gz_shared_6: 32,981,519, 21,525,319, 22,524,743, 28,169,031, 35,558,215 and 38,916,935 bytes; the template is 7.7 MB, so a file's own clone starts smaller than any",
	decision:
		"the largest, gz_shared_6: a worker runs one file at a time, and a file works in one database, so this bounds the pages one worker's file reads. No headroom added: a database past it is unmeasured",
	revalidate:
		"a shared database that grows past it; a PostgreSQL repin; a test tier whose files install larger schemas or keep more rows; another machine"
})

/**
 * The pages one network worker's database holds, in PostgreSQL's blocks: its largest database, rounded up to whole
 * blocks.
 */
export const workerBufferBlocks: Limit = derived({
	owner: "grizzle's network test tier (scripts/pg/init.sh)",
	unit: "blocks",
	scope:
		"the shared buffers one network worker's database fills, out of the local cluster's shared_buffers",
	from: [workerDatabaseBytes, blockSize],
	derivation:
		"a worker runs one file at a time, and a file works in one database, so the largest such database, in blocks rounded up, holds every page one worker's file reads",
	compute: ([database, block]) => Math.ceil(database.value / block.value)
})

/**
 * The predicate locks one network worker's file holds at once, measured: the most any one test database held while
 * every worker ran a file.
 */
export const workerPredicateLocks: Limit = measured({
	value: 2038,
	owner: "grizzle's network test tier",
	unit: "predicate locks",
	scope:
		"the SIRead locks one network worker's file holds at once, every transaction of its database's together, as pg_locks lists them",
	evidence:
		"`SELECT max(n), sum(n), count(*) FROM (SELECT database, count(*) AS n FROM pg_catalog.pg_locks WHERE mode = 'SIReadLock' GROUP BY 1) AS x` as the bootstrap superuser, every 3 s, during a full `pnpm -s test:network`",
	observed: "ten readings on 2026-11-14 between 01:28 and 01:29 UTC",
	environment:
		"cassowary, Ubuntu 26.04 on arm64 in AWS, the local PostgreSQL 19rc2 cluster sized by clusterSize with max_pred_locks_per_transaction 2048, grizzle 993326b3; a second full network run and other lanes' files on the cluster at once",
	workload:
		"a full network run at one file per core, every worker's file in its own database, beside another run's files",
	result:
		"at most 2,038 locks in one database, 7,812 in all over 57 databases at once; no 53200 (out of shared memory)",
	decision:
		"the largest one database held. No headroom added: the table holds this many for every worker at once (clusterPredicateLocks), and the measured total over every database is a seventeenth of that",
	revalidate:
		"a 53200 in a network run; a test tier whose transactions read more rows SERIALIZABLE; a change of max_pred_locks_per_relation or max_pred_locks_per_page; a PostgreSQL repin"
})
