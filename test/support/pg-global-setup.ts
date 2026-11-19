import { doctor } from "@bjornpagen/testing/pg"
import { testWorkers } from "@bjornpagen/testing/workers"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Duration, Effect } from "effect"
import { indices } from "#compiler/core/array.ts"
import { clusterMembers, InitializedCluster } from "#test/support/cluster.ts"
import { pgCluster, pgPin } from "#test/support/env.ts"
import { hangLimit } from "#test/support/limits.ts"
import { ensureSharedDatabase, sweep } from "#test/support/substrate/shared.ts"
import { dropRole } from "#test/support/substrate/substrate.ts"

/**
 * How long the doctor's quick checks may run: the hang limit, one wait of the global setup. They run a dozen psql
 * sessions on each member that each read a setting or a catalog row, so a doctor still running past it hangs; nothing
 * else bounds the global setup.
 */
const doctorTimeout = Duration.millis(hangLimit)

/**
 * The workers whose files run on member `index` of `members` members, among a run's workers numbered 1 to testWorkers:
 * worker w on member (w − 1) mod `members` (cluster.ts workerMember), the shared databases the global setup clones on
 * that member.
 */
const workersOf = (members: number, index: number): ReadonlyArray<number> =>
	Arr.filter(
		Arr.map(indices(testWorkers), (i) => i + 1),
		(w) => (w - 1) % members === index
	)

/**
 * Runs `each` on every member of grizzle's local cluster, brought up (cluster.ts clusterMembers), one after another,
 * each with that member as the InitializedCluster and the workers whose files run on it (workersOf).
 */
const eachMember = <E>(
	each: (workers: ReadonlyArray<number>) => Effect.Effect<void, E, InitializedCluster>
) =>
	Effect.gen(function* () {
		const members = yield* clusterMembers
		yield* Effect.forEach(
			members,
			(member, index) =>
				Effect.provide(each(workersOf(members.length, index)), InitializedCluster.member(member)),
			{ discard: true }
		)
	})

/**
 * The global setup and teardown of `pnpm test:network` (vitest.network.config.ts), which Vitest runs once per run in
 * its own process: the setup before any test file starts, the teardown once every file has ended. The setup brings
 * grizzle's local cluster up (made when missing, started when stopped: cluster.ts clusterMembers) and refuses to run
 * database tests unless every member passes the doctor's quick checks (@bjornpagen/testing/pg doctor: its server,
 * sizes, settings, owner and TLS), then on each member sweeps away what ended test processes left there and clones the
 * shared database of each worker whose files run on it from the template, once, when it is missing
 * (substrate/shared.ts): worker w's on member (w − 1) mod K, where its files reach (test/support/cluster.ts). The
 * teardown sweeps every member again, dropping the databases the run's own files made (a database is dropped only when
 * no file runs, test/support/pg.ts freshDatabase).
 */
const setupCluster = Effect.gen(function* () {
	const checked = yield* doctor(pgCluster, true).pipe(Effect.timeout(doctorTimeout), Effect.orDie)
	const failures = Arr.flatMap(checked, ({ port, verdicts }) =>
		Arr.flatMap(verdicts, (verdict) =>
			verdict.kind === "failed" ? [`  member ${port}: ${verdict.name}: ${verdict.detail}`] : []
		)
	)
	if (Arr.isReadonlyArrayNonEmpty(failures)) {
		return yield* Effect.die(
			new Error(
				`The local PostgreSQL ${pgPin.version} cluster fails the doctor's quick checks (pnpm pg doctor):\n${Arr.join(failures, "\n")}`
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
	Effect.runPromise(Effect.provide(Effect.orDie(setupCluster), NodeServices.layer))

/** Vitest's global teardown: each member's sweep, once every test file has ended. */
export const teardown = (): Promise<void> =>
	Effect.runPromise(
		Effect.provide(Effect.orDie(eachMember(() => sweep(dropRole))), NodeServices.layer)
	)
