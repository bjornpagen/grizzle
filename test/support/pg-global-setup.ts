import { testWorkers } from "@bjornpagen/testing/workers"
import { NodeFileSystem, NodeServices } from "@effect/platform-node"
import { Duration, Effect } from "effect"
import { readFamily, workersOf } from "#pg/family.ts"
import { localCluster } from "#pg/local-cluster.ts"
import { InitializedCluster } from "#test/support/cluster.ts"
import { pgPin } from "#test/support/env.ts"
import { repoRoot } from "#test/support/files.ts"
import { hangLimit } from "#test/support/limits.ts"
import { run, runOptions } from "#test/support/process.ts"
import { ensureSharedDatabase, sweep } from "#test/support/substrate/shared.ts"
import { dropRole } from "#test/support/substrate/substrate.ts"

/**
 * How long the doctor's quick checks may run: the hang limit, one wait of the global setup. They open a dozen psql
 * sessions on each member that each read a setting or a catalog row, so a doctor still running past it hangs; nothing
 * else bounds the global setup.
 */
const doctorTimeout = Duration.millis(hangLimit.value)

/**
 * Runs `each` on every member of the family GRIZZLE_PG_CLUSTER names, as its family file records it
 * (packages/pg/src/family.ts readFamily), one after another, each with that member as the InitializedCluster and the
 * workers whose files run on it (workersOf).
 */
const eachMember = <E>(
	each: (workers: ReadonlyArray<number>) => Effect.Effect<void, E, InitializedCluster>
) =>
	Effect.gen(function* () {
		const family = yield* readFamily(localCluster)
		yield* Effect.forEach(
			family.members,
			(member, index) =>
				Effect.provide(
					each(workersOf(family.members.length, index, testWorkers)),
					InitializedCluster.member(member)
				),
			{ discard: true }
		)
	}).pipe(Effect.provide(NodeFileSystem.layer))

/**
 * The global setup and teardown of `pnpm test:network` (vitest.network.config.ts), which Vitest runs once per run in
 * its own process: the setup before any test file starts, the teardown once every file has ended. The setup refuses
 * to run database tests unless the local cluster family passes the doctor's quick checks, every member of it recorded,
 * running and sized (scripts/pg/doctor.sh), then on each member sweeps away what ended test processes left there and
 * clones the shared database of each worker whose files run on it from the template, once, when it is missing
 * (substrate/shared.ts): worker w's on member (w − 1) mod K, where its files reach (test/support/cluster.ts). The
 * teardown sweeps every member again, dropping the databases the run's own files made (a database is dropped only when
 * no file runs, test/support/pg.ts freshDatabase).
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
	yield* eachMember((workers) =>
		Effect.andThen(
			sweep(dropRole),
			Effect.forEach(workers, ensureSharedDatabase, { discard: true })
		)
	)
})

/** Vitest's global setup: the doctor, then each member's sweep and worker databases, before any test file starts. */
export const setup = (): Promise<void> =>
	Effect.runPromise(Effect.provide(setupCluster, NodeServices.layer))

/** Vitest's global teardown: each member's sweep, once every test file has ended. */
export const teardown = (): Promise<void> => Effect.runPromise(eachMember(() => sweep(dropRole)))
