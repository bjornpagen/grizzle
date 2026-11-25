/**
 * A login value (public/schema.ts login) as its change members compile (program/workload/change.ts ChangeLogin), with
 * no database, over the artifacts its served file compiles over, as `grizzle generate` builds it: its base owned and
 * installed under its first codebook over every slice, its workloads planned over the base's artifacts, and its roles
 * named over the artifacts that plan's parameter types serve.
 */

import { defined } from "@bjornpagen/testing/assert"
import { artifactsOver, builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { transactionClock } from "#compiler/ir/clock.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { namedLogin } from "#compiler/physical/ddl/names.ts"
import { installBasis, unserved } from "#compiler/physical/install/plan.ts"
import type { ChangeLogin } from "#compiler/program/workload/change.ts"
import { planWorkload } from "#compiler/program/workload/compile.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { succeeded } from "#test/support/assert.ts"

/** `value`, a login, as its change members compile (ChangeLogin). */
export const changeLogin = (value: unknown): ChangeLogin => {
	const built = defined(builtLogin(value), "a login built by login(...)")
	const owned = succeeded(built.base.content.owned(), "the login's base")
	const basis = succeeded(
		installBasis(owned, firstCodebook(rostersOf(owned)), everySlice(owned)),
		"the base's basis"
	)
	const checking = succeeded(artifactsOver(basis, unserved), "the base's artifacts")
	const ownedLogin = succeeded(ownLoginOver(built, owned), "the login over its base")
	const planned = succeeded(
		planWorkload(
			[{ login: ownedLogin.name, workloads: built.workload }],
			built.base,
			{ artifacts: checking, roles: ownedLogin.roles },
			silentPhases
		),
		"the login's workload plan"
	)
	const artifacts = succeeded(
		artifactsOver(basis, { kind: "planned", types: planned.plan.params }),
		"the login's artifacts"
	)
	return {
		roles: built.roles,
		workload: built.workload,
		named: succeeded(namedLogin(ownedLogin, artifacts.names.levels), "the login named"),
		artifacts,
		clock: transactionClock,
		planned: planned.frontends
	}
}
