/**
 * The roles an installation creates in the cluster are exactly the ones the one reading of an installation's roles
 * classifies as its own (core/identity.ts installationRoleOf), so what collects an installation's roles, `grizzle
 * uninstall` and a test template's sweep, leaves none of them behind: a role left behind is met by the next install of
 * the same installation as 42710, as a template rebuilt over a former build's function owner was.
 *
 * The box: an installation of a schema of one relation under each of two schema names, at its stems and under each of
 * two role prefixes, with and without a declared function, its login over one role and two. Each case compiles the
 * installation (physical/install/compile.ts) and fills its script as `grizzle migrate` sends it under the case's role
 * space (deploy/render/variables.ts resolveVariables). Oracle (specification): every role a CREATE ROLE of the script
 * names is the installation's by the classifier, a stem for the login and each role and the function owner exactly
 * when the schema declares a function; and none of them is the installation's under the other spaces of the box, whose
 * roles are disjoint from its own.
 *
 * Features: at its stems and under a prefix, a function owner and no function, two roles.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { installationRoleOf } from "#compiler/core/identity.ts"
import {
	createdRoles,
	rolesInstallationOf,
	levelsOf,
	type RolesCase,
	rolesCaseGen,
	type RolesFeature,
	rolePrefixes,
	spaceOf
} from "#test/unit/core/installation-roles.fixtures.ts"

/** Every role an installation creates is its own by the one reading of an installation's roles, and no other space's. */
export const everyRoleAnInstallationCreatesIsItsOwnByTheOneReadingOfAnInstallationsRolesAndNoOtherSpaces =
	property.exhaust(finite(rolesCaseGen), {
		box: "a schema of one relation under two schema names, at its stems and under two role prefixes, with and without a declared function, over one role and two",
		needs: {},
		situations: [
			"at its stems",
			"under a prefix",
			"a function owner",
			"no function",
			"two roles"
		] satisfies ReadonlyArray<Reached<RolesFeature>>,
		check: (_, c: Case<RolesFeature>) => (rolesCase: RolesCase) =>
			Effect.sync(() => {
				c.note(rolesCase.prefix === undefined ? "at its stems" : "under a prefix")
				c.note(rolesCase.functions ? "a function owner" : "no function")
				if (rolesCase.roles === 2) {
					c.note("two roles")
				}
				const installation = rolesInstallationOf(rolesCase)
				const space = spaceOf(rolesCase)
				const levels = levelsOf(installation)
				const created = createdRoles(installation, space)
				const roleOf = installationRoleOf(space, levels)
				const kinds = Arr.map(created, (role) => {
					const is = roleOf(role)
					if (is === undefined) {
						return assert.fail(`${role}, which the installation creates, is its own`)
					}
					return is.kind
				})
				assert.equal(
					Arr.filter(kinds, (k) => k === "stem").length,
					1 + rolesCase.roles,
					"a stem for the login and each role"
				)
				assert.equal(
					Arr.some(kinds, (k) => k === "functionOwner"),
					rolesCase.functions,
					"the function owner exactly when the schema declares a function"
				)
				for (const prefix of rolePrefixes) {
					if (prefix !== rolesCase.prefix) {
						const otherOf = installationRoleOf(spaceOf({ ...rolesCase, prefix }), levels)
						assert.ok(
							Arr.every(created, (role) => otherOf(role) === undefined),
							`no role of the installation under ${String(rolesCase.prefix)} is its own under ${String(prefix)}`
						)
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the roles a migration creates: a stem per login and role, and the function owner where the schema declares a function, under the installation's space alone"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original: '\t\t\t["functionOwner", identity.functionOwner(level)]\n',
				replacement: "",
				why: "The one reading of an installation's roles reads no function owner, so uninstall and a template's sweep leave it behind and the next install meets it (42710); the property fails at an installation that declares a function."
			}
		]
	})
