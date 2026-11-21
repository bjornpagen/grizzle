import { localCluster, type PgMember, settled, unitOf } from "@bjornpagen/testing/pg"
import { type Need, NeedFailed, WorkerIndex } from "@bjornpagen/testing/property"
import type { NodeServices } from "@effect/platform-node/NodeServices"
import { Array as Arr, Config, Effect, FileSystem, type Scope } from "effect"
import { ChildProcess } from "effect/process"
import { busyBackendBytes } from "#pg.config.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { pgCluster } from "#test/support/env.ts"

/**
 * A cluster of grizzle's spec (pg.config.ts: its owner, template, extensions and the parameters the owner sets) that is
 * one case's own, for a case that changes a cluster's own state or needs its settings fresh from their declaration,
 * which the shared cluster's members hold from their last settle: the workbench's unit postgres@grizzle-private-<w>-0
 * of the case's worker w, reached over its socket alone (the bootstrap superuser's, which trusts the account), one
 * member admitting as many connections as the machine holds of busy backends (pg.config.ts busyBackendBytes), a
 * replication slot and a WAL sender for each, and PostgreSQL's defaults otherwise. A worker runs one case at a time, so
 * no two cases ever share one; a name of the worker's, not a random one, so what a killed run left is the next case's
 * to remove (removed).
 */
const privateSpec = (worker: number) =>
	localCluster({
		unit: `grizzle-private-${worker}`,
		network: { kind: "socket" },
		owner: pgCluster.owner,
		template: pgCluster.template,
		extensions: pgCluster.extensions,
		ownerParameters: pgCluster.ownerParameters,
		durability: "throwaway",
		sizing: {
			kind: "workers",
			family: { kind: "one" },
			connections: { kind: "capacity", backendBytes: busyBackendBytes },
			replication: { kind: "capacity" },
			sharedBuffers: { kind: "default" },
			locks: { kind: "default" }
		}
	})

/** A cluster's failure as the private cluster's need reports it. */
const privateFailed = (doing: string) => (error: { readonly message: string }) =>
	NeedFailed.make({ need: "grizzle private cluster", message: `${doing}: ${error.message}` })

/**
 * Everything of `spec`'s one member gone: its unit stopped (`systemctl --user stop`, by its name), then its data
 * (~/.local/var/postgres/<member>, the workbench's postgres@ unit's) and its state (the testing library's, the owner's
 * password and hba file, ~/.local/state/toolchain-pg/<unit>), so the next settle makes it from the declaration, as
 * PostgreSQL's initdb and the spec give it. Nothing of a member that never ran is an error.
 */
const removed = (spec: ReturnType<typeof privateSpec>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const home = yield* Config.String("HOME")
		const state = yield* Config.withDefault(Config.String("XDG_STATE_HOME"), `${home}/.local/state`)
		const member = `${spec.unit}-0`
		const handle = yield* ChildProcess.make("systemctl", ["--user", "stop", unitOf(member)])
		yield* handle.exitCode
		yield* fs.remove(`${home}/.local/var/postgres/${member}`, { recursive: true, force: true })
		yield* fs.remove(`${state}/toolchain-pg/${spec.unit}`, { recursive: true, force: true })
	}).pipe(Effect.scoped, Effect.mapError(privateFailed(`removing ${spec.unit}`)))

/**
 * The case's own cluster (privateSpec, of the case's worker), as a need: each case's take removes what an earlier one
 * left (removed), settles the cluster from its declaration (@bjornpagen/testing/pg settled: the unit started, made by
 * its first start, and given the spec) and answers its one member, which the case's scope removes when it closes.
 */
export const privateCluster: Need<PgMember> = {
	key: "grizzle private cluster",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.map(
		Effect.all([Effect.service(WorkerIndex), Effect.context<NodeServices>()]),
		([worker, platform]): Effect.Effect<PgMember, NeedFailed, Scope.Scope> => {
			const spec = privateSpec(worker.index)
			return Effect.provide(
				Effect.gen(function* () {
					yield* removed(spec)
					yield* Effect.addFinalizer(() => Effect.ignore(removed(spec)))
					const members = yield* Effect.mapError(
						settled(spec),
						privateFailed(`settling ${spec.unit}`)
					)
					return Arr.headNonEmpty(members)
				}),
				platform
			)
		}
	)
}
