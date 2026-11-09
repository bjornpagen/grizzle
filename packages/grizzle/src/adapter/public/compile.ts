import { Array as Arr, Effect, Option } from "effect"
import { openServed } from "#adapter/db/served.ts"
import { fromEngine } from "#adapter/engine.ts"
import { type OpenError, type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { servedSessions } from "#adapter/pool/served.ts"
import { servedEntry, type ServedRefusal } from "#adapter/served/compile.ts"
import { explainMember as explainLoaded, type MemberCall } from "#adapter/served/explain.ts"
import { builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import type { OpenOptions, Plan } from "#adapter/types/db.ts"
import type { DbLayerService, ServedRole } from "#adapter/types/layer.ts"
import {
	type AnyLogin,
	type AnyRole,
	type AnyWorkload,
	malformedDescription,
	ownBuilt,
	SourceLoc,
	trustedJson
} from "#compiler/plan/common.ts"

export type { ServedRefusal, WorkloadPlace } from "#adapter/served/compile.ts"
export type { MemberCall } from "#adapter/served/explain.ts"

/** The refusal of the login's compile itself, at the login. */
const atLogin = (error: ServedRefusal["error"]): ServedRefusal => ({
	place: { kind: "login" },
	error
})

/**
 * compileServed(login, snapshot, workloads): the served file of `login` with `workloads` in place of its own, compiled in
 * process by the one compile `grizzle generate` commits and `grizzle check` holds the committed file to
 * (adapter/served/compile.ts servedEntry), under `snapshot`, the JSON value of the snapshot.json the file is committed
 * beside, as an import of it yields it. The result is the file's JSON value, as an import of the committed
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
		const entry = yield* servedEntry({ login: { ...built, workload: workloads }, owned }, snapshot)
		return trustedJson<unknown>(entry.text)
	})

/**
 * explainMember(role, member, call, options): the estimate-only plan of every statement the member `member` of the
 * role's served workload runs for `call`, its parameters, beside each call's facts for a ChangeSet that holds array
 * members, as its handle takes them (served/explain.ts MemberCall), on a Db of the role opened with `options` through its
 * login's layer:
 * EXPLAIN (FORMAT JSON), never ANALYZE, in one transaction of the role that is rolled back (adapter/served/explain.ts).
 * A read, a key and a paged member plan their rows' statements; a ChangeSet plans the variant the Db's claims select, its
 * carriers created and analyzed empty at their places.
 */
export const explainMember = <R extends AnyRole, P>(
	role: ServedRole<R, P>,
	member: keyof P & string,
	call: MemberCall,
	options: OpenOptions<R>
): Effect.Effect<ReadonlyArray<Plan>, ReadError | OpenError, DbLayerService<R>> =>
	Effect.gen(function* () {
		const { ctx } = yield* openServed(role, options)
		const { role: loaded } = yield* servedSessions(role)
		const found = Arr.findFirst(loaded.members, (m) => m.name === member)
		if (Option.isNone(found)) {
			return yield* new ReadFailure({
				reason: malformedDescription(
					SourceLoc("explainMember", [member]),
					`a member of role ${loaded.name}'s served workload`
				)
			})
		}
		return yield* explainLoaded(ctx, found.value, call)
	})
