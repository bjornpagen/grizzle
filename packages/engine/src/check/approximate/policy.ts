import { vectorCosineOpclass } from "#compiler/ir/products.ts"
/**
 * The fixed HNSW build and search policy of approximate retrieval.
 *
 * Build parameters, iterative-scan behavior, search work and memory bounds, and internal candidate expansion follow one library policy; there are no public HNSW or IVFFlat selectors, ef_search controls, recall sliders, partition hints or quantization switches. This value is that policy: one value for the whole library, never a
 * caller option.
 *
 * - The index: HNSW over the cosine operator class `vector_cosine_ops`, the opclass whose ordering operator is `<=>`,
 *   on the one vector field a workload program ranks by. HNSW indexes vectors of 1-2000
 *   dimensions; storage admits 16000, and a larger indexed space is refused rather than truncated, cast to halfvec or
 *   quantized.
 * - Build: m = 16 and ef_construction = 64, which are pgvector 0.8.7's own defaults, so the generated
 *   `CREATE INDEX ... USING hnsw (<column> <ext>.vector_cosine_ops)` realizes the policy with no WITH clause, and
 *   admission pins 0.8.7. A policy that departs from the defaults needs storage parameters on the SQL
 *   AST's CreateIndex first.
 * - Search: iterative index scans in strict order, so a filtered search keeps exploring the graph until the LIMIT is
 *   filled or the work bound is reached, and the scan still returns rows in exact distance order (strict iterative
 *   scanning can fill the request at higher cost); ef_search 40, the dynamic candidate list of one scan step;
 *   max_scan_tuples 20000 and scan_mem_multiplier 1, the work and memory bounds after which an iterative scan stops and
 *   the request underfills. Underfill is allowed and is never evidence that the eligible universe is exhausted.
 *
 * The search settings are session parameters of the extension (`hnsw.*`). They are login defaults beside `jit = off`,
 * stored by the migration's Publish file as ALTER ROLE ... SET and verified by admission, never set by a request and
 * never exposed. An `hnsw.*` parameter is a placeholder until the vector library is loaded, and the migration identity,
 * which is not a superuser, may store one only once the library is loaded in its session (SQLSTATE 42501 before any vector function runs, accepted after). `hnswSearchSettings` is the list the SQL AST's configuration
 * parameters name (sql/ast.ts), the installer emits for every login one of whose roles can name the vector type, after
 * a statement that loads the library (physical/ddl/roles.ts), and admission compares with the snapshot's
 * (adapter/admission).
 */
export const hnswPolicy = {
	method: "hnsw",
	opclass: vectorCosineOpclass,
	operator: "<=>",
	maxDimensions: 2000,
	build: { m: 16, efConstruction: 64 },
	search: {
		efSearch: 40,
		iterativeScan: "strict_order",
		maxScanTuples: 20000,
		scanMemMultiplier: 1
	}
} as const

interface SessionSetting {
	readonly parameter: string
	readonly value: string
}

/** The search policy as the session parameters every login stores as its role defaults. */
export const hnswSearchSettings = (): ReadonlyArray<SessionSetting> => [
	{ parameter: "hnsw.ef_search", value: String(hnswPolicy.search.efSearch) },
	{ parameter: "hnsw.iterative_scan", value: hnswPolicy.search.iterativeScan },
	{ parameter: "hnsw.max_scan_tuples", value: String(hnswPolicy.search.maxScanTuples) },
	{ parameter: "hnsw.scan_mem_multiplier", value: String(hnswPolicy.search.scanMemMultiplier) }
]
