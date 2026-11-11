/**
 * The analytics and import logins are trust domains of their own. Programs over the education installation draw every
 * action kind but migrations and catalog changes, with live, stale and wild inputs. The district analyst's world
 * shows the de-identified rollup and its district's section ids, never a student, enrollment, account or name, and a
 * refresh leaves no fact in the rollup that a grade of reality does not support, so a deleted student's grade is gone
 * after it: each analyst program first has the import add a grade, the analyst refresh, the import delete it and the
 * analyst refresh again (support.ts gradeDeletedThenRefreshed). The import's world shows only ids of enrollments and
 * what it recorded, never a name, and no direct writer reaches a role or view of another login, whatever claims it
 * sets: each import program first writes as a direct writer under hand-set claims and under malformed ones
 * (importerUnderClaims), after a write through its Db that changes its world (roleChangesItsWorld).
 *
 * Plants (main's test phase): worlds-deletion-keeps-facts.patch, worlds-isolation-view-barrier-off.patch.
 */
import { layer } from "@effect/vitest"
import {
	educationTests,
	gradeDeletedThenRefreshed,
	importerUnderClaims,
	roleChangesItsWorld,
	roleSeesItsWorld,
	worldsFocus
} from "#test/pg/education/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { leadsOf } from "#test/support/worlds/drive/suite.ts"

layer(Substrate.layer)(
	"education: the analytics and import logins",
	educationTests([
		{
			suite: "pg/education/analyst",
			roles: { kind: "only", roles: ["district_analyst"] },
			lead: leadsOf(roleSeesItsWorld("district_analyst"), gradeDeletedThenRefreshed),
			name: "the analyst never reads a student identifier, and a refresh drops a deleted student's grade",
			focus: worldsFocus,
			steps: 20,
			cases: 40,
			realization: "once",
			required: [
				"district_analyst open-db opened",
				"district_analyst read rows",
				"district_analyst saw rows of its world",
				"district_analyst refresh ok",
				"a refresh dropped a grade",
				"a refresh dropped a deleted grade"
			],
			properties: [
				{ kind: "world", role: "district_analyst" },
				{ kind: "rollup" },
				{ kind: "witnesses" },
				{ kind: "reach" }
			]
		},
		{
			suite: "pg/education/importer",
			roles: { kind: "only", roles: ["importer"] },
			lead: leadsOf(
				roleSeesItsWorld("importer"),
				roleChangesItsWorld("importer"),
				importerUnderClaims
			),
			name: "the import login never reads a name and never reaches the web login's relations, whatever claims it sets",
			focus: worldsFocus,
			steps: 20,
			cases: 40,
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
)
