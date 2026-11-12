import { Effect, type Result } from "effect"
import { fromEngine, readHost, toResult } from "#adapter/engine.ts"
import {
	type ServedEntry,
	type ServedInput,
	type ServedRefusal,
	snapshotOnceEntry,
	snapshotServedEntry
} from "#adapter/served/compile.ts"
import { builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import {
	type AnyLogin,
	type AnyWorkload,
	type CompileError,
	malformedArtifact,
	malformedDescription,
	ownBuilt,
	SourceLoc,
	trustedJson
} from "#compiler/plan/common.ts"
import { type InstalledIndexes, snapshotIndexes } from "#compiler/plan/serve.ts"

export type { ServedRefusal, WorkloadPlace } from "#adapter/served/compile.ts"
export type { PhysicalReason as IndexReason } from "#compiler/plan/common.ts"
export type {
	IndexKeyColumn,
	InstalledIndexes,
	LawColumnHolds,
	SnapshotIndex
} from "#compiler/plan/serve.ts"

/** The refusal of the login's compile itself, at the login. */
const atLogin = (error: ServedRefusal["error"]): ServedRefusal => ({
	place: { kind: "login" },
	error
})

/**
 * The served file's JSON value of `login` with `workloads` in place of its own, under `snapshot`, by `entry`, the
 * compile of a login under a snapshot alone, called `caller` in a refusal of a value login(...) did not build.
 */
const compiledJson = (
	caller: string,
	login: AnyLogin,
	snapshot: unknown,
	workloads: ReadonlyArray<AnyWorkload>,
	entry: (login: ServedInput, snapshot: unknown) => Effect.Effect<ServedEntry, ServedRefusal>
): Effect.Effect<unknown, ServedRefusal> =>
	Effect.gen(function* () {
		const built = builtLogin(login)
		if (built === undefined) {
			return yield* Effect.fail(
				atLogin(malformedDescription(SourceLoc(caller, []), "a login built by login(...)"))
			)
		}
		const base = yield* Effect.mapError(fromEngine(ownBuilt(built.base)), atLogin)
		const owned = yield* Effect.mapError(fromEngine(ownLoginOver(built, base)), atLogin)
		const compiled = yield* entry({ login: { ...built, workload: workloads }, owned }, snapshot)
		return trustedJson<unknown>(compiled.text)
	})

/**
 * compileServed(login, snapshot, workloads): the served file of `login` with `workloads` in place of its own, compiled in
 * process by the one compile `grizzle generate` commits and `grizzle check` holds the committed file to
 * (adapter/served/compile.ts snapshotServedEntry), under `snapshot`, the JSON value of the snapshot.json the file is
 * committed beside, as an import of it yields it. The result is the file's JSON value, as an import of the committed
 * `served/<login>.json` yields it: what served(file, name) and DbLayer.make take.
 *
 * It is an application's test's way to a program the login's committed workload does not hold: compile it into a served
 * file of its own over the database's snapshot, then serve that file. `workloads` is `login.workload` for the login's own
 * file. A value login(...) did not build, a base that does not compile, a program that does not compile for a role it
 * runs on, and a read whose footprint the snapshot's live source does not decode, so that a watch of it would miss its
 * changes (UncoveredRead, a snapshot of an installation migrated without the program's workload), are each its
 * ServedRefusal, naming where the compile refused.
 */
export const compileServed = (
	login: AnyLogin,
	snapshot: unknown,
	workloads: ReadonlyArray<AnyWorkload>
): Effect.Effect<unknown, ServedRefusal> =>
	compiledJson("compileServed", login, snapshot, workloads, snapshotServedEntry)

/**
 * compileServedOnce(login, snapshot, workloads): compileServed's file of `login` with `workloads`, its reads called once
 * alone (adapter/served/compile.ts snapshotOnceEntry): no change wakes them, so no read needs the snapshot's live source
 * and the file holds none. Its members are served by adapter/db/handles.ts onceCalls, whose calls have no watch, never
 * by a DbLayer.
 */
export const compileServedOnce = (
	login: AnyLogin,
	snapshot: unknown,
	workloads: ReadonlyArray<AnyWorkload>
): Effect.Effect<unknown, ServedRefusal> =>
	compiledJson("compileServedOnce", login, snapshot, workloads, snapshotOnceEntry)

/**
 * indexesOf(snapshot): every index the installation holds, by the declared name of the relation whose table or
 * materialized view holds it, then by the index's name (a plan node's `on.relation` and `on.index.name`), read from
 * `snapshot`, the JSON value an import of the snapshot.json the login's served file was generated beside yields. Each
 * index is its key columns in key order and the reasons the snapshot's manifest records for it (SnapshotIndex): a
 * column is a field of the relation, by its declared name, or a law column, by what it holds (LawColumnHolds) and the
 * laws it is added for, each with its direction, a B-tree's ascending or descending, or none; a reason is a law the
 * index serves by its identity, a RefusedLaw's `id`, the workload's access, a derived relation's key by the laws its
 * proof rests on, or the enforcement of a declaration, in words (IndexReason). A served file names an index alone, so
 * a plan carries none of this and a running application pays nothing for it at startup; a caller that wants it passes
 * the snapshot it holds, and nothing is read from a file or kept. A value whose reading throws, or a snapshot.json
 * `grizzle generate` has not written since its indexes joined it, is refused.
 */
export const indexesOf = (snapshot: unknown): Result.Result<InstalledIndexes, CompileError> =>
	readHost(
		malformedArtifact(
			"snapshot",
			[],
			"a snapshot read as data, as an import of snapshot.json yields it"
		),
		() => toResult(snapshotIndexes(snapshot))
	)
