import { Effect } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import {
	artifactsUnder,
	type BuiltLogin,
	type LayerRole,
	loginRoles,
	type WorkloadRefused,
	workloadSlice
} from "#adapter/served/login.ts"
import { servedFileOf } from "#adapter/served/project.ts"
import { lawsAbove } from "#adapter/witness/keylaw.ts"
import {
	type CompileError,
	levelChain,
	type LoginDesc,
	type OwnedLogin
} from "#compiler/plan/common.ts"
import { servedText } from "#compiler/plan/migration.ts"
import { type ServedFile, type ServedSnapshot, servedSnapshot } from "#compiler/plan/serve.ts"

/** A login of a configured schema, as generate and check compile it: its value, and the login owned over its base. */
export interface ServedInput {
	readonly login: BuiltLogin
	readonly owned: OwnedLogin
}

/**
 * Where the compile of a login's workload refused: the login itself (the snapshot it compiles under, its slice, or its
 * base's artifacts over it), one of its roles (the role's artifacts, contexts or PostgreSQL role), or one program of a
 * role.
 */
export type WorkloadPlace =
	| { readonly kind: "login" }
	| { readonly kind: "role"; readonly role: string }
	| { readonly kind: "program"; readonly role: string; readonly program: string }

/** The compile of a login's workload refused, at `place`, for `error`. */
export interface ServedRefusal {
	readonly place: WorkloadPlace
	readonly error: CompileError
}

/**
 * A login's workload compiled: the login, the snapshot it compiled under, read over the login's base's level, and every
 * role of it with its programs, in the login's order.
 */
interface CompiledServed {
	readonly login: LoginDesc
	readonly snapshot: ServedSnapshot
	readonly roles: ReadonlyArray<LayerRole>
}

const atLogin = (error: CompileError): ServedRefusal => ({ place: { kind: "login" }, error })

/** A refusal of the login's compile, at the role and the program it names (adapter/served/login.ts). */
const atRole = (refused: WorkloadRefused): ServedRefusal => ({
	place:
		refused.program === undefined
			? { kind: "role", role: refused.role }
			: { kind: "program", role: refused.role, program: refused.program },
	error: refused.error
})

/**
 * The one compile of a login's workload: what `grizzle generate` writes to `migrations/<schema>/served/<login>.json`,
 * what `grizzle check` compiles again and holds the committed file to, byte for byte, and what an application's
 * DbLayer serves. Nothing a login's runtime loads imports it (fallow's adapter-install zone).
 *
 * `login` compiles under `snapshot`, the JSON value of the snapshot.json it is committed beside, as an import of the
 * file yields it, read as DbLayer.make read it (deploy/snapshot/served.ts servedSnapshot) over the login's base's level,
 * the last of its own levels: its recorded codes, its derived facts and the laws of the levels above the login's base.
 * Its workloads' slice (workloadSlice) is planned under them (artifactsUnder) and every role of the login compiled over
 * it (loginRoles), every program of the login's workloads that runs on the role compiled once. generate and check both
 * compile from the snapshot.json text the draft lays out, so the drafted snapshot and the committed one are one input,
 * and a login compiles to one served file.
 */
const compileServed = Effect.fn("compileServed")(function* (
	login: ServedInput,
	snapshot: unknown
): Effect.fn.Return<CompiledServed, ServedRefusal> {
	const served = yield* Effect.mapError(
		fromEngine(servedSnapshot(snapshot, levelChain(login.login.base.desc).length - 1)),
		atLogin
	)
	const slice = yield* Effect.mapError(workloadSlice(login.login, login.owned), atRole)
	const layer = yield* Effect.mapError(
		fromEngine(artifactsUnder(login.owned.base, served.codes, served.derived, slice)),
		atLogin
	)
	const roles = yield* Effect.mapError(
		loginRoles(login.login, login.owned, layer, lawsAbove(served)),
		atRole
	)
	return { login: login.login.desc, snapshot: served, roles }
})

/**
 * A login's served file, as generate writes it to `served/<login>.json`: its login's declared name, the served file its
 * compile is (compileServed, then adapter/served/project.ts servedFileOf), and that value's canonical text
 * (served/json.ts servedText), which check compares byte for byte.
 */
export interface ServedEntry {
	readonly login: string
	readonly file: ServedFile
	readonly text: string
}

/** The served file of `login` under `snapshot`, the JSON value of the snapshot.json beside it (compileServed). */
export const servedEntry = Effect.fn("servedEntry")(function* (
	login: ServedInput,
	snapshot: unknown
): Effect.fn.Return<ServedEntry, ServedRefusal> {
	const compiled = yield* compileServed(login, snapshot)
	const file = yield* Effect.mapError(Effect.fromResult(servedFileOf(compiled)), atLogin)
	const text = yield* Effect.mapError(fromEngine(servedText(file)), atLogin)
	return { login: compiled.login.name, file, text }
})
