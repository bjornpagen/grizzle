/**
 * Teachers and school administrators reach only their own sections and school. Programs over the education
 * installation draw every action kind but migrations and catalog changes, with live, stale and wild inputs: tokens of
 * departed teachers, another school's ids in a token's `school` claim, claims hand-set by direct writers, writes below
 * SERIALIZABLE. Every row a teacher's world shows is of a section their assignments name, and every grade, mark and
 * note they write is in such a section and recorded under their own account; every row a school administrator's world
 * shows, and every enrollment they write, is of the school their claims name and their account administers.
 */
import {
	educationTests,
	roleChangesItsWorld,
	roleSeesItsWorld,
	worldsFocus
} from "#test/pg/education/support.ts"
import { leadsOf } from "#test/support/worlds/drive/suite.ts"

/**
 * Education: teachers and school administrators, a property for each suite:
 * - teacher: a teacher reads and writes only their own sections.
 * - school-admin: a school administrator never reaches another school.
 */
export const staffSuites = educationTests([
	{
		key: "teacher",
		roles: { kind: "only", roles: ["teacher"] },
		lead: leadsOf(roleSeesItsWorld("teacher"), roleChangesItsWorld("teacher")),
		focus: worldsFocus,
		steps: 20,
		cases: 40,
		realization: "once",
		required: [
			"teacher open-db opened",
			"teacher read rows",
			"teacher saw rows of its world",
			"teacher write accepted",
			"teacher apply outside-world",
			"teacher apply invariant-rejected"
		],
		properties: [{ kind: "world", role: "teacher" }, { kind: "witnesses" }, { kind: "reach" }]
	},
	{
		key: "school-admin",
		roles: { kind: "only", roles: ["school_admin"] },
		lead: leadsOf(roleSeesItsWorld("school_admin"), roleChangesItsWorld("school_admin")),
		focus: worldsFocus,
		steps: 20,
		cases: 40,
		realization: "once",
		required: [
			"school_admin open-db opened",
			"school_admin read rows",
			"school_admin saw rows of its world",
			"school_admin write accepted",
			"school_admin apply outside-world",
			"school_admin apply invariant-rejected"
		],
		properties: [{ kind: "world", role: "school_admin" }, { kind: "witnesses" }, { kind: "reach" }]
	}
])
