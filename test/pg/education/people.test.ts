/**
 * Students and guardians reach only their own. Programs over the education installation draw every action kind but
 * migrations and catalog changes, with live, stale and wild inputs: tokens of withdrawn students and of other
 * schools' accounts, claims hand-set by direct writers, writes below SERIALIZABLE. Every row a student's world shows,
 * through a Db or a direct read of its views, is one of their own records, and every fact a student writes is their
 * own profile; every row a guardian's world shows is a record of a child they hold an unrestricted guardianship of.
 */
import {
	educationTests,
	roleChangesItsWorld,
	roleSeesItsWorld,
	worldsFocus
} from "#test/pg/education/support.ts"
import { leadsOf } from "#test/support/worlds/drive/suite.ts"

/**
 * Education: students and guardians, a property for each suite:
 * - student: a student never reads another student's record.
 * - guardian: a guardian reads only their unrestricted children's records.
 */
export const peopleSuites = educationTests([
	{
		key: "student",
		roles: { kind: "only", roles: ["student"] },
		lead: leadsOf(roleSeesItsWorld("student"), roleChangesItsWorld("student")),
		focus: worldsFocus,
		steps: 20,
		cases: 40,
		realization: "once",
		required: [
			"student open-db opened",
			"student read rows",
			"student saw rows of its world",
			"student write accepted",
			"student apply outside-world"
		],
		properties: [{ kind: "world", role: "student" }, { kind: "witnesses" }, { kind: "reach" }]
	},
	{
		key: "guardian",
		roles: { kind: "only", roles: ["guardian"] },
		lead: roleSeesItsWorld("guardian"),
		focus: worldsFocus,
		steps: 20,
		cases: 40,
		realization: "once",
		required: [
			"guardian open-db opened",
			"guardian read rows",
			"guardian saw rows of its world",
			"a guardian read with a restricted child"
		],
		properties: [{ kind: "world", role: "guardian" }, { kind: "witnesses" }, { kind: "reach" }]
	}
])
