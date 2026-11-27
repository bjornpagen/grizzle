/**
 * Every function of the installation's own that a role's served file calls is one the installation grants the role
 * EXECUTE on (physical/ddl/roles.ts addRole): PostgreSQL checks EXECUTE against the role a transaction's SET ROLE
 * takes on, for every function of a plan as the plan starts, so a served program that calls a function its role is not
 * granted compiles, passes `grizzle check`, and fails at its first call. Learning Commons' reader did (2026-11-17): a
 * role that writes nothing served read-backs whose delivered options are checked through the refusal function, which
 * the installation granted only to roles that write or read a context.
 *
 * The box: a roster Kind, R(k, v, kind) keyed by k and mutable, and Tag(r, label) keyed by r; the login `app` of one
 * or two roles, each holding every relation whole and writing R and Tag or none, and serving a drawn set of members: a
 * read-back of a ChangeSet that writes nothing, delivering each R's tag as an option; a query over R at one of Kind's
 * handles; and for a writer, an insert of R and a put of R from a query over a relation parameter.
 *
 * Oracle: the printed SQL of each role's served file, as `grizzle generate` writes it (draftSchema, then eachServedFile):
 * every schema-qualified call in its texts, whatever member, step, form or variant holds it, of a function or constant
 * the installation's manifest creates must be one the manifest grants that role EXECUTE on.
 *
 * Features: a role that writes nothing whose served file calls the refusal function, a writer whose served file calls
 * it, one calling none of the installation's functions, two roles. The box's served files call no function of the
 * installation's but the refusal function.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { caseGen, type Feature, servedRoles } from "#test/unit/cli/served-executes.fixtures.ts"

/** Every function of the installation's own a role's served file calls is granted to the role. */
export const everyFunctionOfTheInstallationsOwnARolesServedFileCallsIsGrantedToTheRole =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"a role that writes nothing whose served file calls the refusal function",
			"a writer whose served file calls the refusal function",
			"a served file calling none of the installation's functions",
			"two roles"
		] satisfies ReadonlyArray<Reached<Feature>>,
		budget: { runs: 16, steered: 64 },
		check: (_, notes: CaseOf<Feature>) => (c) =>
			Effect.gen(function* () {
				if (c.roles.length === 2) {
					notes.note("two roles")
				}
				for (const r of yield* servedRoles(c)) {
					if (Arr.contains(r.calls, r.refusal)) {
						notes.note(
							r.writes
								? "a writer whose served file calls the refusal function"
								: "a role that writes nothing whose served file calls the refusal function"
						)
					}
					if (r.calls.length === 0) {
						notes.note("a served file calling none of the installation's functions")
					}
					assert.deepEqual(
						Arr.filter(r.calls, (fn) => !r.granted.has(fn)),
						[],
						`role ${r.name}: every function of the installation's own its served file calls is one it is granted EXECUTE on`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the schema-qualified calls the printed SQL of each role's served file holds"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original:
					'\tprivileges.push(grant(["EXECUTE"], { kind: "FUNCTION", names: [refusalFunction(b.schema)] }))\n',
				replacement:
					'\tif (role.writes.size > 0 || Object.keys(role.contexts).length > 0) {\n\t\tprivileges.push(grant(["EXECUTE"], { kind: "FUNCTION", names: [refusalFunction(b.schema)] }))\n\t}\n',
				why: "The old grant: EXECUTE on the refusal function to a role that writes or reads a context alone, so a reader's read-back calls a function it is not granted (Learning Commons' reader, 2026-11-17)."
			},
			{
				file: "packages/engine/src/physical/ddl/roles.ts",
				original:
					'\tprivileges.push(grant(["EXECUTE"], { kind: "FUNCTION", names: [refusalFunction(b.schema)] }))\n',
				replacement: "",
				why: "No role is granted EXECUTE on the refusal function, which every writer's and reader's read-back calls."
			}
		]
	})
