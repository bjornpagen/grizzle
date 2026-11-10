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
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { installationsOf, ownBuilt, rostersOf } from "#compiler/schema/own.ts"
import type { AnyLogin } from "#compiler/types/schema/world.ts"
import { defined, succeeded } from "#test/support/assert.ts"

/**
 * The served file of `login` with its own workloads, as an import of the committed `served/<login>.json` yields it,
 * compiled with no database: its base's installation compiled in process, the snapshot.json generate writes for it, and
 * the login's file compiled over that snapshot by the one compile generate commits (adapter/public/compile.ts
 * compileServed). What a test gives served(file, name) when it needs a login's real file and no installation.
 */
export const compiledServedFile = (login: AnyLogin): unknown => {
	const built = defined(builtLogin(login), "a login built by login(...)")
	const owned = succeeded(ownBuilt(built.base), "the login's base")
	const installation = succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [], [], firstCodebook(rostersOf(owned)))
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
	const files = succeeded(
		writeSnapshot(snapshot, derivedOf(installation)),
		"the base's snapshot files"
	)
	return Effect.runSync(
		compileServed(login, trustedJson<unknown>(files.snapshot), [...built.workload])
	)
}
