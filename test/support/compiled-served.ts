import { Effect } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import { compileServed } from "#adapter/public/compile.ts"
import { atRole, type ServedRefusal } from "#adapter/served/compile.ts"
import { artifactsOver, type BuiltLogin, builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import {
	derivedOf,
	finishSnapshot,
	targetState,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { type Codebook, firstCodebook } from "#compiler/ir/codes.ts"
import { servedWorkloadExtension } from "#compiler/physical/access/extension.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { namedLogin } from "#compiler/physical/ddl/names.ts"
import { installationOver } from "#compiler/physical/install/compile.ts"
import { installBasis } from "#compiler/physical/install/plan.ts"
import { servedWorkload } from "#compiler/program/workload/compile.ts"
import { installationsOf, type Owned, ownBuilt, rostersOf } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import type { AnyLogin } from "#compiler/types/schema/world.ts"
import { defined, succeeded } from "#test/support/assert.ts"

/**
 * The JSON value of the snapshot.json `grizzle generate` writes for an installation of `owned`, `login`'s base, serving
 * `login`, under the codes `codes`, as an import of the file yields it, compiled with no database as generate drafts it
 * (cli/generate.ts draftInput, plannedLogins): one basis (physical/install/plan.ts installBasis), the login's workloads
 * planned over its artifacts (program/workload/compile.ts servedWorkload), the installation compiled over that basis
 * with the plan's extension (physical/access/extension.ts servedWorkloadExtension), and the snapshot written with the
 * plan's access, access paths and live plan. So a file compiled over it is the one generate writes, its live source
 * included, and a workload generate refuses is its ServedRefusal, a ChangeSet's at its role: one whose access paths
 * the installation cannot index among them (an access index's UnrepresentableKey), as generate's draft refuses it. Codes are history: a fresh installation's are its rosters' first codes, and a roster that lost a handle
 * holds a hole there.
 */
export const compiledSnapshot = (
	login: BuiltLogin,
	owned: Owned,
	codes: Codebook
): Effect.Effect<unknown, ServedRefusal> =>
	Effect.gen(function* () {
		const basis = succeeded(installBasis(owned, codes, everySlice(owned)), "the base's basis")
		const artifacts = succeeded(artifactsOver(basis), "the base's artifacts")
		const ownedLogin = succeeded(ownLoginOver(login, owned), "the login over its base")
		const named = yield* Effect.mapError(
			fromEngine(namedLogin(ownedLogin, artifacts.names.levels)),
			atLogin
		)
		const plan = yield* Effect.mapError(
			fromEngine(
				servedWorkload(
					[
						{
							name: ownedLogin.name,
							roles: login.roles,
							workload: login.workload,
							named,
							artifacts
						}
					],
					login.base,
					{ artifacts, roles: ownedLogin.roles }
				)
			),
			(refused) => (refused.kind === "workload" ? atLogin(refused.error) : atRole(refused.refused))
		)
		const installation = yield* Effect.mapError(
			fromEngine(
				installationOver(
					basis,
					completeInstallOptions(
						owned,
						installationsOf(owned),
						[ownedLogin],
						[servedWorkloadExtension(plan)],
						codes
					)
				)
			),
			atLogin
		)
		const snapshot = succeeded(
			finishSnapshot(
				succeeded(
					targetState({
						installation,
						workload: { access: plan.access, accessPaths: plan.requests, live: plan.live },
						checks: lawChecks(installation)
					}),
					"the base's target state"
				)
			),
			"the base's snapshot"
		)
		return trustedJson<unknown>(
			succeeded(writeSnapshot(snapshot, derivedOf(installation)), "the base's snapshot files")
				.snapshot
		)
	})

/** A refusal of the login's compile itself, at the login (adapter/served/compile.ts ServedRefusal). */
const atLogin = (error: CompileError): ServedRefusal => ({ place: { kind: "login" }, error })

/**
 * The served file of `login` with its own workloads, as an import of the committed `served/<login>.json` yields it,
 * compiled with no database: the snapshot.json generate writes for its base serving it (compiledSnapshot), and the
 * login's file compiled over that snapshot by the one compile generate commits
 * (adapter/public/compile.ts compileServed). What a test gives served(file, name) when it needs a login's real file and
 * no installation.
 */
export const compiledServedFile = (login: AnyLogin): unknown => {
	const built = defined(builtLogin(login), "a login built by login(...)")
	const owned = succeeded(ownBuilt(built.base), "the login's base")
	return Effect.runSync(
		Effect.flatMap(compiledSnapshot(built, owned, firstCodebook(rostersOf(owned))), (snapshot) =>
			compileServed(login, snapshot, [...built.workload])
		)
	)
}
