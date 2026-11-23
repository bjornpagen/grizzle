/**
 * The analytics and import logins are trust domains of their own. Programs over the education installation draw every
 * action kind but migrations and catalog changes, with live, stale and wild inputs. The district analyst's world
 * shows the de-identified rollup and its district's section ids, never a student, enrollment, account or name, and
 * every row it reads of the rollup is a grade of reality, so a deleted student's grade is gone after its delete: each
 * analyst program first has the import add a grade, the analyst read the rollup, the import delete it and the analyst
 * read the rollup again (support.ts gradeDeletedThenGone). The import's world shows only ids of enrollments and
 * what it recorded, never a name, and no direct writer reaches a role or view of another login, whatever claims it
 * sets: each import program first writes as a direct writer under hand-set claims and under malformed ones
 * (importerUnderClaims), after a write through its Db that changes its world (roleChangesItsWorld).
 */
import {
	educationTests,
	gradeDeletedThenGone,
	importerUnderClaims,
	roleChangesItsWorld,
	roleSeesItsWorld,
	worldsFocus
} from "#test/pg/education/support.ts"
import { leadsOf } from "#test/support/worlds/drive/suite.ts"

/**
 * Education: the analytics and import logins, a property for each suite:
 * - analyst: the analyst never reads a student identifier, and a deleted student's grade is gone from its rollup.
 * - importer: the import login never reads a name and never reaches the web login's relations, whatever claims it sets.
 */
export const servicesSuites = educationTests([
	{
		key: "analyst",
		roles: { kind: "only", roles: ["district_analyst"] },
		lead: leadsOf(roleSeesItsWorld("district_analyst"), gradeDeletedThenGone),
		focus: worldsFocus,
		steps: 20,
		cases: 40,
		realization: "once",
		required: [
			"district_analyst open-db opened",
			"district_analyst read rows",
			"district_analyst saw rows of its world",
			"the rollup lacked a deleted grade"
		],
		properties: [
			{ kind: "world", role: "district_analyst" },
			{ kind: "rollup" },
			{ kind: "witnesses" },
			{ kind: "reach" }
		]
	},
	{
		key: "importer",
		roles: { kind: "only", roles: ["importer"] },
		lead: leadsOf(
			roleSeesItsWorld("importer"),
			roleChangesItsWorld("importer"),
			importerUnderClaims
		),
		focus: worldsFocus,
		steps: 20,
		/** The runner's budget: d5bd99bdd's kill survives its stated 40 cases and dies at the runner's. */
		cases: "runner's",
		realization: "once",
		required: [
			"importer open-db opened",
			"importer read rows",
			"importer saw rows of its world",
			"importer write accepted",
			"importer apply invariant-rejected",
			"the importer wrote under hand-set claims",
			"the importer wrote under malformed claims"
		],
		properties: [
			{ kind: "world", role: "importer" },
			{ kind: "no-name" },
			{ kind: "reach" },
			{ kind: "witnesses" }
		]
	}
])
