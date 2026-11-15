import { availableParallelism } from "node:os"
import { testWorkers } from "@bjornpagen/testing/workers"

/**
 * The test files `pnpm test:network` runs at once, and so the shared worker databases `gz_shared_1` to
 * `gz_shared_<networkWorkers>`: the testing library runs this many files at once (its workers.ts testWorkers,
 * Vitest's maxWorkers), Vitest numbers their workers 1 to this in VITEST_POOL_ID, the global setup clones one database
 * per worker (pg-global-setup.ts), and a claim tries the indices above it when its worker's database is taken
 * (shared.ts claimSharedDatabase). The library's one constant states it for all three, so they never disagree.
 *
 * It is one run's width, which the environment the run starts in may cap; the cluster is sized for the widest run the
 * machine allows (machineWorkers), never for this.
 */
export const networkWorkers: number = testWorkers

/**
 * The widest network run this machine allows: one file per core, the owner's all-cores default and the testing
 * library's width when nothing caps it, read from the machine itself as a test's pool is (lease.ts testPoolMax). The
 * cluster family is the machine's, made once by scripts/pg/init.sh and shared by every run, while a run's width
 * (networkWorkers) follows the environment it starts in: a machine owner's TOOLCHAIN_TEST_WORKERS caps it, a shell
 * without one leaves it at a file per core. So the family is sized for this (family.ts familyMembers, memberShare;
 * size.ts clusterConnections), every run, capped or not, fits it, and a run alone never waits for a lease; a second run
 * or a bench beside it waits for the slots the first holds.
 */
export const machineWorkers: number = availableParallelism()
