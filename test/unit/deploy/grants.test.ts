/**
 * Two versions of a schema's role worlds, one knob apart, drafted with no database: a relation dropped or added, a
 * column a stored derived relation and roles read converted to a wider or a narrower type, a role that reads more or less, a role whose writes change, and a
 * second login added or dropped, every such pair of versions exhausted.
 *
 * The oracle is a model of the privileges PostgreSQL holds (aclchk.c's units: one privilege of one grantee on one
 * object, a column's among them, which a DROP takes with its object or its role and a DROP ROLE refuses to leave):
 * from the first version's privileges installed from nothing, the migration's GRANTs, REVOKEs and DROPs end at exactly
 * the privileges the second version holds installed from nothing, and none of them is idle: no GRANT of a privilege a
 * role holds, no REVOKE of one no one holds, none on an object the migration drops from a role it keeps, no GRANT back
 * of what it revoked, and no PUBLIC REVOKE on an object it did not create.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { featureOf, judge, type TurnFeature, turns } from "#test/unit/deploy/grants.fixtures.ts"

/** A migration of role worlds grants and revokes exactly the privileges the two versions hold apart, each once, so an object it keeps keeps its grants and an object it drops revokes nothing. */
export const aMigrationOfRoleWorldsGrantsAndRevokesExactlyThePrivilegesTheTwoVersionsHoldApartEachOnce =
	property.exhaust(turns, {
		box: "every pair of versions one knob apart: C held or not, A's note an integer or a bigint (read by the stored Listing), the reader reading A, A and B or every relation, the writer writing nothing, A or every relation, each role holding A reading the stored Listing in full, and the counter login or not",
		needs: {},
		situations: [
			"a relation dropped",
			"a relation added",
			"a column widened",
			"a column narrowed",
			"a role reads more",
			"a role reads less",
			"a role's writes change",
			"a login added",
			"a login dropped"
		] satisfies ReadonlyArray<Reached<TurnFeature>>,
		check: (_, c: Case<TurnFeature>) => (t) =>
			Effect.sync(() => {
				c.note(featureOf(t))
				judge(t)
			}),
		oracle: {
			kind: "specification",
			name: "a model of PostgreSQL's privileges (aclchk.c): each unit a GRANT adds, a REVOKE and a DROP take away, against the second version installed from nothing"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\t\t!(dropped.has(objectKey(h.object)) && kept(h.grantee))",
				replacement:
					"\t\t\t!(dropped.has(objectKey(h.object)) && kept(h.grantee) && dropped.size < 0)",
				why: "A dropped object's privileges revoked from roles the migration keeps (diff.ts grants revoked): dropping C revokes the writer's privileges on it before the DROP takes them; the property fails."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original:
					"\t\t\t(!wasHeld.has(h.key) || reset.has(objectKey(h.object)) || columnRevoked.has(h.key))",
				replacement:
					"\t\t\t(wasHeld.size >= 0 || reset.has(objectKey(h.object)) || columnRevoked.has(h.key))",
				why: "Every privilege the target states granted again (the old per-role replacement, diff.ts grants): a login added grants the desk login's roles what they hold; the property fails."
			},
			{
				file: "packages/engine/src/deploy/diff/diff.ts",
				original: "\t\tconst again = (h: HeldPrivilege): boolean => !wasRevoked.has(h.key)",
				replacement: "\t\tconst again = (h: HeldPrivilege): boolean => wasRevoked.size >= 0",
				why: "The PUBLIC revokes run again whole whenever one changes (diff.ts defaults): a login added revokes from PUBLIC every table and schema again; the property fails."
			}
		]
	})
