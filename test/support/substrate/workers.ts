import { availableParallelism } from "node:os"

/**
 * The test files `pnpm test:network` runs at once, and so the shared worker databases `gz_shared_1` to
 * `gz_shared_<networkWorkers>`: vitest.network.config.ts runs this many files at once, Vitest numbers their workers 1
 * to this in VITEST_POOL_ID, the global setup clones one database per worker (pg-global-setup.ts), and a claim tries
 * the indices above it when its worker's database is taken (shared.ts claimSharedDatabase). One constant states it for
 * all three, so they never disagree.
 *
 * One file per core of the machine, the owner's all-cores default, read from the machine itself as a test's pool is
 * (limits.ts testPoolMax). scripts/pg/init.sh sizes the cluster to a lease for each of them (shared.ts
 * clusterConnections), so a run alone never waits for a lease; a second run or a bench beside it waits for the slots
 * the first holds.
 */
export const networkWorkers: number = availableParallelism()
