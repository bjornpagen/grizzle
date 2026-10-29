/**
 * The test files `pnpm test:network` runs at once, and so the shared worker databases `gz_shared_1` to
 * `gz_shared_<networkWorkers>`: vitest.network.config.ts runs this many files at once, Vitest numbers their workers 1
 * to this in VITEST_POOL_ID, the global setup clones one database per worker (pg-global-setup.ts), and a claim tries
 * the indices above it when its worker's database is taken (shared.ts claimSharedDatabase). One constant states it for
 * all three, so they never disagree.
 *
 * It stays below the cluster-wide connection lease's slots on a cluster of PostgreSQL's default max_connections (seven:
 * shared.ts leaseConnections), so a run alone never waits for a lease; the slot left over is a bench's or another
 * tree's.
 */
export const networkWorkers = 6
