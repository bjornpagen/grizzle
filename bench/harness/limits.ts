/**
 * The benchmarks' limits: every time a benchmark's own connection or wait is bounded by, as a Limit with its evidence
 * (packages/engine/src/core/limits.ts). A benchmark bounds no wait by a time of its own: a sample that hangs is its
 * operator's to interrupt, which kills the sample with its process group.
 */
import { derived, type Limit, postgresSource, published } from "#compiler/core/limits.ts"
import { nodeTimerMax } from "#test/support/limits.ts"

/**
 * The connect timeout of a benchmark's connection to the local cluster (DbConnection.connectTimeoutMs): no deadline of
 * the connection's own.
 */
export const benchConnectTimeout: Limit = derived({
	owner: "grizzle's benchmarks",
	unit: "milliseconds",
	scope:
		"one connection attempt of a benchmark's sample to the local cluster, and the CancelRequest an interrupted call of it sends",
	from: [nodeTimerMax],
	derivation:
		"grizzle requires a connect timeout and a benchmark sets no deadline of its own, so it is the longest delay a Node timer keeps: a connect that never ends is the operator's to interrupt",
	compute: ([max]) => max.value
})

/**
 * The idle timeout of a benchmark's session pool (PoolBounds.idleTimeoutMs): no session closes for idleness while its
 * sample runs.
 */
export const benchIdleTimeout: Limit = derived({
	owner: "grizzle's benchmarks",
	unit: "milliseconds",
	scope: "one idle session of a benchmark sample's pool on the local cluster",
	from: [nodeTimerMax],
	derivation:
		"grizzle requires an idle timeout and a sample holds its sessions until it ends, so it is the longest delay a Node timer keeps: closing the sample's scope closes every session",
	compute: ([max]) => max.value
})

/**
 * How long a benchmark waits for a backend its client has closed to exit (pg_terminate_backend's timeout, past which
 * the function gives up waiting): no deadline of the benchmark's own.
 */
export const benchExitWait: Limit = derived({
	owner: "grizzle's benchmarks",
	unit: "milliseconds",
	scope:
		"one pg_terminate_backend a benchmark's sample calls to wait for a closed session's backend to exit, on the local cluster",
	from: [nodeTimerMax],
	derivation:
		'PostgreSQL waits only for a positive timeout and a benchmark sets no deadline of its own, so it is the longest wait a benchmark states, the longest delay a Node timer keeps, which pg_terminate_backend keeps too, reading its timeout into a C int (REL_19_RC1 src/backend/storage/ipc/signalfuncs.c: "int timeout; /* milliseconds */"): a backend that never exits is the operator\'s to interrupt',
	compute: ([max]) => max.value
})

/**
 * The most compiled regular expressions one PostgreSQL backend keeps: its cache is a move-to-front list, so a pattern is
 * compiled again once this many others were used since its last use.
 */
const regexCacheEntries: Limit = published({
	value: 32,
	owner: "PostgreSQL 19rc1's regular expression functions",
	unit: "compiled regular expressions",
	scope: "one backend's cache of the regular expressions `~` compiles",
	constraint: "compile-time constant",
	source: `${postgresSource}/src/backend/utils/adt/regexp.c#L95`,
	quote: "#define MAX_CACHED_RES\t32",
	verified: "2026-11-06"
})

/**
 * The patterns a family-patterns case's members cycle through: past the cache, so in the order written every row
 * would compile its pattern again.
 */
export const patternDictionary: Limit = derived({
	owner: "grizzle's benchmarks",
	unit: "patterns",
	scope: "the closed dictionary of patterns one family-patterns case's members cycle through",
	from: [regexCacheEntries],
	derivation:
		"twice the cache: rows cycling through more patterns than the move-to-front cache holds evict each pattern before its next use, and twice is past it by the cache's whole size",
	compute: ([cache]) => 2 * cache.value
})
