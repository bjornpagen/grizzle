/**
 * A role's change members hold no more of each compile than what reads them after it (write/program/served.ts
 * ServableWrite, program/workload/change.ts CertifiableEntry, certifiedRole): its write's level and exclusion, its
 * statements as its application runs them (texts, parts, slots and steps, projected at its level), its read-backs as
 * its served file holds them, its carriers' columns (`carried`: since 28b731aa29 a carrier travels in its transaction's
 * settings, so no write creates one), what its statements seek (`seeks`, ACCESS2-P3's), its parameters and binding, and
 * of its front end the schema, written relations and codes; as certification reads it, beside those its isolation facts, extracted as it compiled
 * (program/isolation/member-facts.ts compiledFacts), and the contexts it was prepared for, which a SERIALIZABLE compile
 * of it prepares it for again from its value: no prepared write, so no front end, outlives its compile.
 * Every role held its compiled writes whole from its compile through certification and the served files, each artifact
 * with every statement's SQL AST, each front end's analyzed DAG, schedule, placements and put choices: edullm's qti 931
 * MB at certification's start (32 compiled writes, their artifacts 604 MB), its whole App 710 MB as the served round
 * started (428 MB the statements, mostly their ASTs), and metis's full installation died of them in its change phase.
 *
 * The box, drawn (prepared-levels.fixtures.ts): a login of one to three roles, each writing a span primary key (Room),
 * its mutable twin (Hold) and a scalar key (Plain), its workload one to all four of Room's insert, Hold's put, Plain's
 * insert and Plain's put, compiled at READ COMMITTED, and SERIALIZABLE where a member has no READ COMMITTED form.
 *
 * Property, per case: every member's entry as certification reads it holds its servable write, its facts and its
 * claims and no prepared write, its compiled write's own fields the servable write's; every member's servable entry, once certified,
 * holds its servable write and nothing more, its front end's fields the schema, written relations and codes alone; and
 * with only the servable roles held, the prepared writes alive are those alive before the login compiled, counted by V8
 * after a full collection (node:v8 queryObjects over write/program/compile.ts PreparedWrite). Oracle: specification, a
 * servable entry is what reads it after its compile. Kills: the entry certification reads holds its compiled write
 * whole; it keeps its prepared write; the servable entry holds the compiled write whole; the certified entry keeps
 * the facts and claims.
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
	type CertifiableEntry,
	certifiedRole,
	readCommittedChanges,
	type ServableEntry,
	type ServableRole
} from "#compiler/program/workload/change.ts"
import { PreparedWrite } from "#compiler/write/program/compile.ts"
import type { ServableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	changeLoginOf,
	entriesOf,
	type Program,
	rolesGen
} from "#test/unit/program/prepared-levels.fixtures.ts"

type Situation = "a role with a member lacking a form" | "a formed role"

/** An object's own fields, by name in code point order. */
const fieldsOf = (o: object): ReadonlyArray<string> => Arr.sort(Rec.keys(o), Order.String)

/** The prepared writes alive, counted by V8 after a full collection. */
const preparedAlive = (): number => queryObjects(PreparedWrite, { format: "count" })

/**
 * The fields of a servable write (write/program/served.ts ServableWrite), named off a record of them as every slice's
 * below is: each record `satisfies Record<keyof T, true>` of its type T, so it holds T's keys exactly, and a field T
 * gains, loses or renames is a compile error here, where ServableWrite's `seeks` and `carried` each turned this property
 * red at run time.
 */
const servableFields = fieldsOf({
	binding: true,
	carried: true,
	clocked: true,
	exclusion: true,
	frontend: true,
	level: true,
	params: true,
	reach: true,
	plan: true,
	readBacks: true,
	statements: true
} satisfies Record<keyof ServableWrite, true>)

/** The fields of an entry as certification reads it (program/workload/change.ts CertifiableEntry). */
const certifiableFields = fieldsOf({
	change: true,
	claims: true,
	clock: true,
	compiled: true,
	facts: true,
	names: true,
	params: true,
	schema: true,
	source: true
} satisfies Record<keyof CertifiableEntry, true>)

/** The fields of a servable entry (program/workload/change.ts ServableEntry). */
const servableEntryFields = fieldsOf({
	change: true,
	clock: true,
	compiled: true,
	names: true,
	params: true,
	schema: true,
	source: true
} satisfies Record<keyof ServableEntry, true>)

/** The fields of a servable write's front end (ServableWrite `frontend`). */
const frontendFields = fieldsOf({
	codes: true,
	schema: true,
	written: true
} satisfies Record<keyof ServableWrite["frontend"], true>)

/**
 * The servable roles of `drawn`'s login, compiled for READ COMMITTED, each whole role and the login itself unreachable
 * once this returns, by its name in the login, with whether its compile lacked a READ COMMITTED form; each role's
 * entries as certification read them held to their slice first.
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
		(compiled) => {
			for (const variants of compiled.changes.members.values()) {
				for (const entry of entriesOf(variants)) {
					assert.deepEqual(
						fieldsOf(entry),
						certifiableFields,
						"the entry certification reads: its servable fields, its facts and its claims, no prepared write"
					)
					assert.deepEqual(
						fieldsOf(entry.compiled),
						servableFields,
						"the compiled write certification reads: its servable fields alone"
					)
				}
			}
			return {
				unformed: compiled.kind === "unformed",
				role: certifiedRole(compiled.changes)
			}
		}
	)

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
						for (const entry of entriesOf(variants)) {
							assert.deepEqual(
								fieldsOf(entry),
								servableEntryFields,
								"the entry's fields, no prepared write"
							)
							assert.deepEqual(
								fieldsOf(entry.compiled),
								servableFields,
								"the compiled write's servable fields alone"
							)
							assert.deepEqual(
								fieldsOf(entry.compiled.frontend),
								frontendFields,
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
				original:
					"\t\t...servableEntry(entry),\n\t\tfacts: compiledFacts(name, entry.compiled, names),\n",
				replacement: "\t\t...entry,\n\t\tfacts: compiledFacts(name, entry.compiled, names),\n",
				why: "The entry certification reads holds its compiled write whole, its artifact with every statement's SQL AST, its front end, put choices, schedule, placements and admission beside its slice, as every role held them through certification: its compiled write's fields are the whole write's, and the search fails."
			},
			{
				file: "packages/engine/src/program/workload/change.ts",
				original: "\t\tclaims: entry.claims\n\t})\n",
				replacement: "\t\tclaims: entry.claims,\n\t\tprepared: entry.prepared\n\t})\n",
				why: "The entry certification reads keeps its prepared write, as every entry did, so every front end lives until certification ends (metis's full installation: 213, 1,198 MB): the entry has a prepared write, and the search fails."
			},
			{
				file: "packages/engine/src/program/workload/change.ts",
				original: "\t\tcompiled: servableWrite(entry.compiled)\n",
				replacement: "\t\tcompiled: entry.compiled\n",
				why: "The servable entry holds its compiled write whole, its front end with its analyzed DAG and its schedule, placements and put choices beside it, as the served round's roles held it: its fields are the compiled write's, and the search fails."
			},
			{
				file: "packages/engine/src/program/workload/change.ts",
				original:
					"const certifiedEntry = <S extends ParamSource>(entry: CertifiableEntry<S>): ServableEntry<S> =>\n\tObject.freeze({\n",
				replacement:
					"const certifiedEntry = <S extends ParamSource>(entry: CertifiableEntry<S>): ServableEntry<S> =>\n\tObject.freeze({\n\t\t...entry,\n",
				why: "The servable entry keeps every field of the entry certification read, its facts and its claims among them: its fields are more than its slice, and the search fails."
			}
		]
	})
