import { Effect } from "effect"
import { compileServed } from "#adapter/public/compile.ts"
import { builtLogin } from "#adapter/served/login.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import {
	derivedOf,
	finishSnapshot,
	noWorkload,
	targetState,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { type Codebook, firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { installationsOf, type Owned, ownBuilt, rostersOf } from "#compiler/schema/own.ts"
import type { AnyLogin } from "#compiler/types/schema/world.ts"
import { defined, succeeded } from "#test/support/assert.ts"

/**
 * The JSON value of the snapshot.json `grizzle generate` writes for an installation of `owned` under the codes `codes`,
 * as an import of the file yields it, compiled with no database: the installation compiled in process, with no
 * workload planned. Codes are history: a fresh installation's are its rosters' first codes, and a roster that lost a
 * handle holds a hole there.
 */
export const compiledSnapshot = (owned: Owned, codes: Codebook): unknown => {
	const installation = succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [], [], codes)
		),
		"the base's installation"
	)
	const snapshot = succeeded(
		finishSnapshot(
			succeeded(
				targetState({ installation, workload: noWorkload, checks: lawChecks(installation) }),
				"the base's target state"
			)
		),
		"the base's snapshot"
	)
	return trustedJson<unknown>(
		succeeded(writeSnapshot(snapshot, derivedOf(installation)), "the base's snapshot files")
			.snapshot
	)
}

/**
 * The served file of `login` with its own workloads, as an import of the committed `served/<login>.json` yields it,
 * compiled with no database: its base's installation compiled in process, the snapshot.json generate writes for it
 * (compiledSnapshot), and the login's file compiled over that snapshot by the one compile generate commits
 * (adapter/public/compile.ts compileServed). What a test gives served(file, name) when it needs a login's real file and
 * no installation.
 */
export const compiledServedFile = (login: AnyLogin): unknown => {
	const built = defined(builtLogin(login), "a login built by login(...)")
	const owned = succeeded(ownBuilt(built.base), "the login's base")
	return Effect.runSync(
		compileServed(login, compiledSnapshot(owned, firstCodebook(rostersOf(owned))), [
			...built.workload
		])
	)
}
