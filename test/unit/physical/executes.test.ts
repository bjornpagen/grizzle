/**
 * EXECUTE follows what a role's statements evaluate (physical/ddl/roles.ts roleExecutes, InstallBuilder.evaluated),
 * over generated worlds (test/support/executes.ts): rosters, sets, a contract, laws whose CHECKs and generated columns
 * cast into their domains, and roles writing drawn relations.
 *
 * The property: for every role, the constants it is granted EXECUTE on are exactly those its statements evaluate,
 * restated over the installation's statements (reachableConstants): every statement on a table it writes, its views,
 * its policies' predicates, the domains it holds USAGE on and every closed relation's constants, through each constant's
 * body and each domain's base type and CHECKs, a cast's target among the domains. Nothing more, which is least
 * privilege, and nothing less, which a write needs: PostgreSQL checks EXECUTE against the invoker on every function a
 * CHECK, a generated column or a domain's CHECK calls.
 *
 * The required situation is a constant that only a written table's casts reach: a containment selected by a set adds to
 * its source a generated column of the set's bits domain, its value a literal cast into that domain, and a role that
 * writes the source and holds no relation with a set over the selector's roster holds no USAGE on the domain, so only
 * the cast reaches the live-codes constant its CHECK calls. A check's set value is cast into its own field's domain,
 * which its writer holds, and a closed id selector's column and handle are smallint, so neither reaches one alone.
 *
 * Oracle: a second implementation of the reach (test/support/executes.ts reachableConstants), restated over the
 * installation's statements, sharing no code with the installer's call tracking.
 *
 * Features: a constant only a written table's casts reach, a role that writes nothing, and two roles.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	buildExecutesWorld,
	executesWorldGen,
	grantedConstants,
	installedRole,
	reachableConstants
} from "#test/support/executes.ts"
import { owning } from "#test/support/policy.ts"
import { type Feature, sorted } from "#test/unit/physical/executes.fixtures.ts"

/** The EXECUTE grants of a role are exactly the constants its statements evaluate, through constants' bodies and domains' casts and CHECKs. */
export const theEXECUTEGrantsOfARoleAreExactlyTheConstantsItsStatementsEvaluateThroughConstantsBodiesAndDomainsCastsAndCHECKs =
	property.explore(executesWorldGen, {
		needs: {},
		situations: [
			"a constant only a written table's casts reach",
			"a role that writes nothing",
			"two roles"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (world) =>
			Effect.sync(() => {
				const built = buildExecutesWorld(world, "Grants")
				const owned = owning(built.schema)
				const own = ownLogin(defined(loginDescOf(built.login), "a login built by login(...)"))
				const compiled = compileInstallation(
					owned,
					completeInstallOptions(
						owned,
						installationsOf(owned),
						[own.ok ? own.value : assert.fail(own.error.message)],
						[],
						firstCodebook(rostersOf(owned))
					)
				)
				const i = compiled.ok ? compiled.value : assert.fail(compiled.error.message)
				if (world.roles.length === 2) {
					c.note("two roles")
				}
				for (const r of world.roles) {
					const installed = installedRole(i, r.name)
					const every = reachableConstants(i, installed, "every type")
					assert.deepEqual(
						sorted(grantedConstants(i, installed.role)),
						sorted(every),
						`the constants ${r.name} is granted EXECUTE on`
					)
					if (r.writes.length === 0) {
						c.note("a role that writes nothing")
					}
					const own = reachableConstants(i, installed, "no written table's types")
					if (Arr.some([...every], (name) => !own.has(name))) {
						c.note("a constant only a written table's casts reach")
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the constants a role's statements evaluate, restated over the installation (reachableConstants)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original:
					"\t\tstatements: [...written.flatMap((relation) => b.evaluatedOn(relation)), ...views],",
				replacement: "\t\tstatements: [...views],",
				why: "A role's reach skips the tables it writes, reading its views alone."
			}
		]
	})
