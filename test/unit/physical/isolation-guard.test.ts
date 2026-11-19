/**
 * The guard trigger per relation (physical/ddl/isolation.ts readCommittedRelations), searched as a pure function over
 * drawn certifications: roles, each READ COMMITTED or SERIALIZABLE, each holding a drawn set of table privileges on each
 * of four relations. The relations whose tables take no guard are exactly those some role writes, holding INSERT,
 * UPDATE or DELETE there, every such role READ COMMITTED and holding only INSERT and SELECT there. A relation no role
 * writes keeps its guard, and so does one a SERIALIZABLE writer, or a READ COMMITTED writer that may update or delete,
 * writes.
 *
 * Oracle: the rule restated over the case. An installation's guard objects follow this set over its own certification
 * (test/unit/physical/insert-grants.test.ts).
 *
 * Features: a relation no role holds, one a role only reads, one every writer of which inserts at READ COMMITTED, one
 * two such inserters write, one a SERIALIZABLE role writes, and one a READ COMMITTED role updates or deletes.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { readCommittedRelations } from "#compiler/physical/ddl/isolation.ts"
import {
	type Feature,
	noteRelation,
	relations,
	rolesGen,
	unguarded
} from "#test/unit/physical/isolation-guard.fixtures.ts"

/** The guard trigger per relation no guard exactly on a relation some role writes, every writer READ COMMITTED and inserting. Its budget is its suite's before it was a property (test/unit/physical/isolation-guard.test.ts at 4ca3036a): 400 runs and 200 steered cases. */
export const theGuardTriggerPerRelationNoGuardExactlyOnARelationSomeRoleWritesEveryWriterREADCOMMITTEDAndInserting =
	property.explore(rolesGen, {
		needs: {},
		budget: { runs: 400, steered: 200 },
		situations: [
			"a relation no role holds",
			"a relation a role only reads",
			"a relation every writer of which inserts at READ COMMITTED",
			"a relation two READ COMMITTED inserters write",
			"a relation a SERIALIZABLE role writes",
			"a relation a READ COMMITTED role updates or deletes"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (roles) =>
			Effect.sync(() => {
				const set = readCommittedRelations(
					Arr.map(roles, (role) => ({
						level: role.level,
						privileges: new Map(Arr.map(role.held, ([r, held]) => [r, new Set(held)] as const))
					}))
				)
				for (const r of relations) {
					noteRelation(roles, r, c)
					assert.equal(set.has(r), unguarded(roles, r), `${r}: ${Formatter.format(roles)}`)
				}
				assert.ok(
					Arr.every([...set], (r) => Arr.some(relations, (x) => x === r)),
					"no relation outside the roles' privileges"
				)
			}),
		oracle: {
			kind: "specification",
			name: "no guard exactly where every writer inserts at READ COMMITTED, restated over the roles"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/isolation.ts",
				original:
					'\t\t\t\tconst inserts = role.level === "readCommitted" && !held.has("UPDATE") && !held.has("DELETE")',
				replacement:
					'\t\t\t\tconst inserts = role.level === "readCommitted" && !held.has("DELETE")',
				why: "A READ COMMITTED writer that may update leaves its relation unguarded."
			}
		]
	})
