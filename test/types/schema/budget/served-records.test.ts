/**
 * What a login serving records costs (schema/budget/served-records.ts): flat records, and records of an array of
 * options two levels deep, each written 10 and 20 times over one schema, each unit its records, their level, their read,
 * a reader role and a login serving the read, each program checked alone by one checker. A login judges its roles and
 * workloads by one verdict each, so the records' types, whose relations carry their parent's and their attachments',
 * are never instantiated again through a mapped copy of the login's lists.
 *
 * Properties: every program typechecks with no diagnostic, and each unit the larger program adds costs at most its
 * shape's measured instantiations. Oracle: the compiler's own counts (test/support/types/batch/measured.ts), against the bound
 * measured when the login's checks became verdicts (served-records.ts addedAtMost).
 */
import { costGate } from "#test/support/types/batch/measured.ts"
import { servedRecords } from "#test/types/schema/budget/served-records.dictionary.ts"
import { servedCost, servedShapeName } from "#test/types/schema/budget/served-records.ts"

/** Each shape's added unit costs at most its measured instantiations. */
export const cost = costGate(servedRecords, {
	box: "every shape of records a login serves",
	name: servedShapeName,
	measure: servedCost,
	oracle: {
		kind: "universal",
		name: "the compiler's own counts, against each shape's measured bound"
	},
	kills: [
		{
			file: "packages/engine/src/program/workload/login.ts",
			original: "\t\tRolesOver<Base, Roles[number]> &",
			replacement: "\t\t{ readonly [K in keyof Roles]: RolesOver<Base, Roles[K]> } &",
			why: "A login judges its roles by a mapped copy of their list, each member's verdict at its place, as before the verdict: the roles' array is related to that copy, its methods' generic signatures instantiated through every level of records whose attachments nest, past the checker's depth (TS2589) for records of an array of options."
		},
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original:
				"\t: [Need] extends [never]\n\t\t? never\n\t\t: HeldFields<Need, EntriesIn<HeadEntries<H>, Need>>",
			replacement: "\t: HeldFields<Need, EntriesIn<HeadEntries<H>, Need>>",
			why: "A key whose fields are inputs or fixed, which needs nothing, reads the head's entries anyway: each query's rule over P at a parameter reads its head's terms for a key it holds by the parameter, so a unit of flat records costs 10,584 instantiations against its bound of 10,483."
		},
		{
			file: "packages/engine/src/types/schema/schema.ts",
			original: "\t: true extends LevelMatch<LevelsOf<S>, IX>\n\t\t? true\n\t\t: false\n",
			replacement:
				"\t: true extends LevelMatch<LevelsOf<S>, IX>\n\t\t? true\n\t\t: [IX] extends [Invariant<EmptyLevel>]\n\t\t\t? true\n\t\t\t: false\n",
			why: "The empty level is admitted in IsLevelOf's refusal branch, a level of every level, so every test of a level that is not one, a login's of each workload over a role, a role's of each records level it does not hold, tests the empty level too: a unit of flat records costs 10,190 instantiations against its exact bound of 10,136, under the 10,483 the bound held before it was exact (REPLAYFIX)."
		}
	]
})
