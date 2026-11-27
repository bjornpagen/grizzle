import { readJson } from "@bjornpagen/grizzle-text/chunks"
import { Effect, type Result } from "effect"
import { fromEngine, readHost, toResult } from "#adapter/engine.ts"
import {
	type ServedEntry,
	type ServedInput,
	type ServedRefusal,
	snapshotCompiled,
	snapshotMovedEntry,
	snapshotServedEntry
} from "#adapter/served/compile.ts"
import { builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import { type PlannedLogin, plannedLogin } from "#adapter/served/planned.ts"
import {
	type AnyLogin,
	type AnyWorkload,
	type CompileError,
	malformedArtifact,
	malformedDescription,
	defect,
	SourceLoc,
	transactionClock
} from "#compiler/plan/common.ts"
import { type InstalledIndexes, snapshotIndexes } from "#compiler/plan/serve.ts"

export type { ServedRefusal, WorkloadPlace } from "#adapter/served/compile.ts"
export type { PlannedLogin, PlannedQueries } from "#adapter/served/planned.ts"
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
 * `login` with `workloads` in place of its own, owned over its base, as a compile under a snapshot reads it, called
 * `caller` in a refusal of a value login(...) did not build.
 */
const servedInput = (
	caller: string,
	login: AnyLogin,
	workloads: ReadonlyArray<AnyWorkload>
): Effect.Effect<ServedInput, ServedRefusal> =>
	Effect.gen(function* () {
		const built = builtLogin(login)
		if (built === undefined) {
			return yield* Effect.fail(
				atLogin(malformedDescription(SourceLoc(caller, []), "a login built by login(...)"))
			)
		}
		const base = yield* Effect.mapError(fromEngine(built.base.content.owned()), atLogin)
		const owned = yield* Effect.mapError(fromEngine(ownLoginOver(built, base)), atLogin)
		return { login: { ...built, workload: workloads }, owned }
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
		const input = yield* servedInput(caller, login, workloads)
		const compiled = yield* entry(input, snapshot)
		const read = readJson(compiled.text)
		if (!read.ok) {
			defect(`the compile's own served file reads as JSON: ${read.error.expected}`)
		}
		return read.value
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
 * runs on, and a live read whose footprint the snapshot's live source does not decode, so that a watch of it would miss
 * its changes (UncoveredRead, a snapshot of an installation migrated without the program's workload), are each its
 * ServedRefusal, naming where the compile refused; an answered read (workload answered), which no change wakes, needs
 * none of the source.
 */
export const compileServed = (
	login: AnyLogin,
	snapshot: unknown,
	workloads: ReadonlyArray<AnyWorkload>
): Effect.Effect<unknown, ServedRefusal> =>
	compiledJson("compileServed", login, snapshot, workloads, snapshotServedEntry)

/**
 * compileServedMoved(login, snapshot, workloads): compileServed's file of `login` with `workloads`, compiled for a moved
 * clock (adapter/served/compile.ts snapshotMovedEntry): every clocked read and every ChangeSet of it declares the
 * clock's stated instant and reads each instant of the database's clock, its clocked parameters' and its stamps' alike,
 * as it, which a Db over a moved clock states at each call (Db.openMoved). A test's file alone: served by its login's
 * DbLayer as any served file is, its roles opened by Db.openMoved, so a test reads a time-dependent law, and stamps its
 * rows, at exactly the instant it states. Every other program compiles as compileServed compiles it.
 */
export const compileServedMoved = (
	login: AnyLogin,
	snapshot: unknown,
	workloads: ReadonlyArray<AnyWorkload>
): Effect.Effect<unknown, ServedRefusal> =>
	compiledJson("compileServedMoved", login, snapshot, workloads, snapshotMovedEntry)

/**
 * plannedQueriesOf(login, snapshot, workloads): the bound of the pg_stat_statements entries one call of each program of
 * `login` with `workloads` in place of its own makes, under `snapshot`, the JSON value of the snapshot.json the login's
 * served file is committed beside, by each role of the login, by its name, then each member of its workload, by its
 * name (adapter/served/planned.ts PlannedLogin): every statement a call sends as the user it runs as, a session's
 * first call's stand-ups and its frame among them, and every query PostgreSQL plans behind them, each function body,
 * trigger, referential action and row check the call reaches, as the snapshot records the installation's planned
 * queries (engine physical/planned/graph.ts), each a pg_stat_statements entry of its own user, query id and level
 * (engine program/planned.ts). A test that measures a call's statements by pg_stat_statements, resetting it before each
 * call, sizes pg_stat_statements.max by it: no call makes more entries than its member's bound. A member whose call
 * reaches an application's declared function, whose body grizzle never reads, has none (PlannedQueries `declared`).
 * It compiles the login under the snapshot as compileServed does, and is refused where compileServed is.
 */
export const plannedQueriesOf = (
	login: AnyLogin,
	snapshot: unknown,
	workloads: ReadonlyArray<AnyWorkload>
): Effect.Effect<PlannedLogin, ServedRefusal> =>
	Effect.map(
		Effect.flatMap(servedInput("plannedQueriesOf", login, workloads), (input) =>
			snapshotCompiled(input, snapshot, transactionClock)
		),
		plannedLogin
	)

/**
 * indexesOf(snapshot): every index the installation holds, by the declared name of the relation whose table holds
 * it, then by the index's name (a plan node's `on.relation` and `on.index.name`), read from
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
