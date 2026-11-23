import { vectorCosineOpclass } from "#compiler/ir/products.ts"

/**
 * The most dimensions pgvector's HNSW index indexes: an indexed vector space of more is refused at compile time
 * (trace.ts), since CREATE INDEX would refuse it.
 *
 * @limitKind published
 * @owner pgvector 0.8.7
 * @unit dimensions
 * @scope the vector column of one HNSW index
 * @constraint compile-time constant
 * @source https://github.com/pgvector/pgvector/blob/v0.8.7/src/hnsw.h#L33
 * @quote #define HNSW_MAX_DIM 2000
 * @verified 2026-11-05
 */
const hnswMaxDimensions = 2000

/**
 * How many tuples one HNSW scan returns at most, pgvector's own bound on an iterative scan, which grizzle pins as a login
 * default (physical/ddl/roles.ts searchPolicySettings) at the library's own default, and which bounds an approximate
 * read's ordered stream where the statement runs (lower/shapes/vector streamBound): the scan and the stream stop at one
 * number, the library's.
 *
 * @limitKind published
 * @owner pgvector 0.8.7
 * @unit index tuples
 * @scope one HNSW index scan, in each session of a login one of whose roles can name the vector type
 * @constraint configurable default
 * @source https://github.com/pgvector/pgvector/blob/v0.8.7/src/hnsw.c#L101-L103
 * @quote DefineCustomIntVariable("hnsw.max_scan_tuples", ... &hnsw_max_scan_tuples, 20000, 1, INT_MAX, PGC_USERSET
 * @verified 2026-11-23
 */
const hnswMaxScanTuples = 20000

/**
 * The fixed HNSW index of approximate retrieval, and the two search settings grizzle pins.
 *
 * There are no public HNSW or IVFFlat selectors, recall sliders, partition hints or quantization switches. This value
 * is the whole of what grizzle decides: one value for the whole library, never a caller option.
 *
 * - The index: HNSW over the cosine operator class `vector_cosine_ops`, the opclass whose ordering operator is `<=>`,
 *   on the one vector field a workload program ranks by. HNSW indexes vectors of at most `maxDimensions`; storage
 *   admits 16000, and a larger indexed space is refused rather than truncated, cast to halfvec or quantized. The
 *   generated `CREATE INDEX ... USING hnsw (<column> <ext>.vector_cosine_ops)` has no WITH clause: the index is built
 *   with pgvector's own build parameters.
 * - The search: iterative index scans in strict order (`hnsw.iterative_scan = strict_order`), so a filtered search
 *   keeps exploring the graph until the LIMIT is filled or the scan stops, and the scan still returns rows in exact
 *   distance order; and the scan's bound, `hnsw.max_scan_tuples`, at the library's own default (`hnswMaxScanTuples`),
 *   which an approximate read's ordered stream reads where it runs, so the stream its filters see ends where the scan
 *   does. A nearest read is approximate by its index: its filters are applied to the index's ordered stream until its
 *   bound's rows pass or the stream ends (lower/shapes/vector). An approximate read's order and its pages' cursors rest
 *   on the first, and its stream on the second, so both are login defaults, stored by the migration's Publish file as
 *   ALTER ROLE ... SET and verified by admission, never set by a request and never exposed.
 *
 * Nothing else of the search is grizzle's: `hnsw.ef_search` and `hnsw.scan_mem_multiplier` are the database owner's,
 * and with them which rows an approximate read returns and how many. A scan that reaches their work or memory bound
 * stops, and the request underfills; underfill is allowed and is never evidence that the eligible universe is
 * exhausted.
 *
 * An `hnsw.*` parameter is a placeholder until the vector library is loaded, and the migration identity, which is not a
 * superuser, may store one only once the library is loaded in its session (SQLSTATE 42501 before any vector function
 * runs, accepted after), so the installer stores the search setting after a statement that loads the library, for
 * every login one of whose roles can name the vector type (physical/ddl/roles.ts searchPolicySettings).
 */
export const hnswPolicy = {
	method: "hnsw",
	opclass: vectorCosineOpclass,
	operator: "<=>",
	maxDimensions: hnswMaxDimensions,
	iterativeScan: "strict_order",
	maxScanTuples: { setting: "hnsw.max_scan_tuples", value: hnswMaxScanTuples }
} as const
