/**
 * A role's change members as its served file reads them hold none of their compiles' analyses
 * (program/workload/change.ts servableRole, write/program/compile.ts servableWrite): a generate keeps every login's
 * roles from their certification, inside the served round, through the installation's compile to the served files,
 * which read each compiled write's level, exclusion, artifact, parameters, binding and the schema, written relations and
 * codes of its front end. It kept every compiled write whole beside its prepared write, each front end's analyzed DAG,
 * schedule, placements and put choices: edullm's ledger carried ~550 MB of them through its installation's compile, its
 * live heap's larger part there.
 *
 * The box, drawn (prepared-levels.fixtures.ts): a login of one to three roles, each writing a span primary key (Room),
 * its mutable twin (Hold) and a scalar key (Plain), its workload one to all four of Room's insert, Hold's put, Plain's
 * insert and Plain's put, compiled at READ COMMITTED, and SERIALIZABLE where a member has no READ COMMITTED form.
 *
 * Property, per case: every member's servable entry holds its write's slice and nothing more, its compiled write's own
 * fields the servable write's and its front end's the schema, written relations and codes alone; and with only the
 * servable roles held, the prepared writes alive are those alive before the login compiled, counted by V8 after a full
 * collection (node:v8 queryObjects over write/program/compile.ts PreparedWrite). Oracle: specification, a servable
 * entry is its write's slice. Kills: the servable entry holds the compiled write whole; it holds the prepared write.
 *
 * Features: a role with a member lacking a form, a formed role.
 */

import { queryObjects } from "node:v8"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Record as Rec } from "effect"
import { silentPhases } from "#compiler/core/phase.ts"
import {
	readCommittedChanges,
	type ServableRole,
	type ServableVariants,
	servableRole
} from "#compiler/program/workload/change.ts"
import { PreparedWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	changeLoginOf,
	type Program,
	rolesGen
} from "#test/unit/program/prepared-levels.fixtures.ts"

type Situation = "a role with a member lacking a form" | "a formed role"

/** An object's own fields, by name in code point order. */
const fieldsOf = (o: object): ReadonlyArray<string> => Arr.sort(Rec.keys(o), Order.String)

/** The prepared writes alive, counted by V8 after a full collection. */
const preparedAlive = (): number => queryObjects(PreparedWrite, { format: "count" })

/**
 * The servable roles of `drawn`'s login, compiled for READ COMMITTED, each whole role and the login itself unreachable
 * once this returns, by its name in the login, with whether its compile lacked a READ COMMITTED form.
 */
const servableRoles = (
	drawn: NonEmptyReadonlyArray<ReadonlyArray<Program>>
): ReadonlyArray<{ readonly unformed: boolean; readonly role: ServableRole }> =>
	Arr.map(
		[
			...succeeded(
				readCommittedChanges(changeLoginOf(drawn), silentPhases),
				"the login's compile"
			).values()
		],
		(compiled) => ({
			unformed: compiled.kind === "unformed",
			role: servableRole(compiled.changes)
		})
	)

/** The entries of `variants`, every form of its splits. */
const servableEntries = (
	variants: ServableVariants
): ReadonlyArray<ServableVariants & { readonly kind: "form" }> =>
	variants.kind === "form"
		? [variants]
		: [...servableEntries(variants.lacking), ...servableEntries(variants.holding)]

/** A role's servable change members hold their writes' slices alone, and no prepared write. */
export const aRolesServableChangeMembersHoldTheirWritesSlicesAloneAndNoPreparedWrite =
	property.explore(rolesGen, {
		needs: {},
		situations: ["a role with a member lacking a form", "a formed role"] satisfies ReadonlyArray<
			Reached<Situation>
		>,
		check: (_, c: Case<Situation>) => (drawn) =>
			Effect.sync(() => {
				const before = preparedAlive()
				const roles = servableRoles(drawn)
				for (const { unformed, role } of roles) {
					c.note(unformed ? "a role with a member lacking a form" : "a formed role")
					for (const variants of role.members.values()) {
						for (const { entry } of servableEntries(variants)) {
							assert.deepEqual(
								fieldsOf(entry),
								["change", "clock", "compiled", "names", "params", "schema", "source"],
								"the entry's fields, no prepared write"
							)
							assert.deepEqual(
								fieldsOf(entry.compiled),
								["artifact", "binding", "clocked", "exclusion", "frontend", "level", "params"],
								"the compiled write's servable fields alone"
							)
							assert.deepEqual(
								fieldsOf(entry.compiled.frontend),
								["codes", "schema", "written"],
								"the front end's schema, written relations and codes alone"
							)
						}
					}
				}
				assert.equal(
					preparedAlive(),
					before,
					"no prepared write alive with the servable roles held"
				)
				assert.ok(roles.length > 0, "the roles are held while the prepared writes are counted")
			}),
		oracle: { kind: "specification", name: "a servable entry is its write's slice" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/workload/change.ts",
				original: "\t\tcompiled: servableWrite(entry.compiled)\n",
				replacement: "\t\tcompiled: entry.compiled\n",
				why: "The servable entry holds its compiled write whole, its front end with its analyzed DAG and its schedule, placements and put choices beside it, as the served round's roles held it: its fields are the compiled write's, and the search fails."
			},
			{
				file: "packages/engine/src/program/workload/change.ts",
				original:
					"const servableEntry = <S extends ParamSource>(entry: ServableEntry<S>): ServableEntry<S> =>\n\tObject.freeze({\n",
				replacement:
					"const servableEntry = <S extends ParamSource>(entry: ServableEntry<S>): ServableEntry<S> =>\n\tObject.freeze({\n\t\t...entry,\n",
				why: "The servable entry keeps every field of the entry it was made from, its prepared write among them, which holds its front end: the entry has a prepared write and the prepared writes alive outnumber those before the compile, and the search fails."
			}
		]
	})
