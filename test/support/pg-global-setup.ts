import { NodeServices } from "@effect/platform-node"
import { Array as Arr, Console, Duration, Effect } from "effect"
import { plpgsqlCoverageReport, readPlpgsqlCoverage } from "#scripts/dev/plpgsql-coverage.ts"
import { InitializedCluster } from "#test/support/cluster.ts"
import { coverageAdminUrl, pgPin } from "#test/support/env.ts"
import { repoRoot } from "#test/support/files.ts"
import { testTimeout } from "#test/support/limits.ts"
import { run, runOptions } from "#test/support/process.ts"
import { ensureSharedDatabase, sharedDatabase, sweep } from "#test/support/substrate/shared.ts"
import { dropRole } from "#test/support/substrate/substrate.ts"
import { networkWorkers } from "#test/support/substrate/workers.ts"

/**
 * How long the doctor's quick checks may run: as long as one test may (testTimeout). They open a dozen psql sessions
 * that each read a setting or a catalog row, less than a test does, so a doctor still running past a test's own timeout
 * hangs; nothing else bounds the global setup.
 */
const doctorTimeout = Duration.millis(testTimeout.value)

/** The index of every worker's shared database: 1 to the run's worker count. */
const workers: ReadonlyArray<number> = Arr.makeBy(networkWorkers, (index) => index + 1)

/**
 * The global setup and teardown of `pnpm test:network` (vitest.network.config.ts), which Vitest runs once per run in
 * its own process: the setup before any test file starts, the teardown once every file has ended. The setup refuses
 * to run database tests unless the local cluster passes the doctor's quick checks, sweeps away what ended test
 * processes left on the cluster, and clones the shared database of each of the run's workers from the template, once,
 * when it is missing (substrate/shared.ts). The setup and the teardown each read the initialised cluster once
 * (InitializedCluster.layer). The teardown sweeps again, dropping the databases the run's own files made (a database
 * is dropped only when no file runs, test/support/pg.ts freshDatabase).
 */
const setupCluster = Effect.gen(function* () {
	const doctor = yield* run(`${repoRoot}scripts/pg/doctor.sh`, ["--quick"], runOptions).pipe(
		Effect.timeout(doctorTimeout),
		Effect.orDie
	)
	if (doctor.status !== 0) {
		return yield* Effect.die(
			new Error(
				`The local PostgreSQL ${pgPin.version} environment is not ready:\n${doctor.stdout}${doctor.stderr}`
			)
		)
	}
	yield* sweep(dropRole)
	yield* Effect.forEach(workers, ensureSharedDatabase, { discard: true })
})

/** Vitest's global setup: the doctor, the sweep and the worker databases, before any test file starts. */
export const setup = (): Promise<void> =>
	Effect.runPromise(Effect.provide(setupCluster, [InitializedCluster.layer, NodeServices.layer]))

/**
 * On the coverage cluster, the PL/pgSQL coverage every worker database recorded, read before the sweep drops what the
 * run made, and printed once; on the main cluster, nothing.
 */
const reportCoverage = Effect.gen(function* () {
	if (pgPin.cluster !== "coverage") {
		return
	}
	const coverage = yield* Effect.forEach(workers, (index) =>
		readPlpgsqlCoverage(coverageAdminUrl(sharedDatabase(index)))
	)
	yield* Console.log(Arr.join(plpgsqlCoverageReport(Arr.flatten(coverage)), "\n"))
})

/** Vitest's global teardown: the coverage report, then the sweep, once every test file has ended. */
export const teardown = (): Promise<void> =>
	Effect.runPromise(
		Effect.provide(Effect.andThen(reportCoverage, sweep(dropRole)), InitializedCluster.layer)
	)
