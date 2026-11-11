import { Effect } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { type ServedRefusal, snapshotServedEntry } from "#adapter/served/compile.ts"
import { builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import {
	type AnyLogin,
	type AnyWorkload,
	malformedDescription,
	ownBuilt,
	SourceLoc,
	trustedJson
} from "#compiler/plan/common.ts"

export type { ServedRefusal, WorkloadPlace } from "#adapter/served/compile.ts"

/** The refusal of the login's compile itself, at the login. */
const atLogin = (error: ServedRefusal["error"]): ServedRefusal => ({
	place: { kind: "login" },
	error
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
 * file. A value login(...) did not build, a base that does not compile, and a program that does not compile for a role it
 * runs on are each its ServedRefusal, naming where the compile refused.
 */
export const compileServed = (
	login: AnyLogin,
	snapshot: unknown,
	workloads: ReadonlyArray<AnyWorkload>
): Effect.Effect<unknown, ServedRefusal> =>
	Effect.gen(function* () {
		const built = builtLogin(login)
		if (built === undefined) {
			return yield* Effect.fail(
				atLogin(malformedDescription(SourceLoc("compileServed", []), "a login built by login(...)"))
			)
		}
		const base = yield* Effect.mapError(fromEngine(ownBuilt(built.base)), atLogin)
		const owned = yield* Effect.mapError(fromEngine(ownLoginOver(built, base)), atLogin)
		const entry = yield* snapshotServedEntry(
			{ login: { ...built, workload: workloads }, owned },
			snapshot
		)
		return trustedJson<unknown>(entry.text)
	})
