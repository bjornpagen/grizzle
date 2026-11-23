/**
 * The curriculum level a downstream application installs over its content (pantry's QtiCurriculum, live in production
 * QTI since its M1 and M2 migrations), on PostgreSQL 19: the law shapes production relies on, each a generated case
 * of the two properties below (curriculum.fixtures.ts states the level).
 *
 * - **curriculumHistories**: a case registers some homes, then makes one to four calls through a served Db, each its own
 *   transaction: a package published with up to two LOM relations (a ChangeSet of two strata: its content replaced,
 *   then its memberships written from the Claim the first stratum's rows give it, the second stratum writing the
 *   Registry level's rows), a home removed from the registry, or a membership written directly. The host model judges
 *   each call over the state before it: a call that breaks a primary key of its own write, or leaves a state breaking a
 *   law, is refused naming laws the state breaks, and leaves the state as it was; any other is accepted, or unchanged
 *   when the stored rows stay as they are. After the calls the stored memberships and homes are the host's. The shapes
 *   it reaches, each a required situation a constructed case aims at (curriculumAims): a key over a derived union (Home
 *   by package) refused; a derived relation (Claim) and the stored memberships each contained in the other, with a key
 *   over the derived one, refused both ways; a foreign key from a membership into another level's registry, which a
 *   registry delete breaks and which refuses it at COMMIT; a rule reading an element's single descendant text node,
 *   whose claim a comment splitting the text withholds; and a publish whose second stratum writes a second level's rows.
 * - **homesThroughALaterMigration**: every pair of package standings (absent, without a home, with one) stored under a
 *   first version without One home's containment, then a second version adding every Package's containment in Home, a
 *   stored relation's in a derived one: the migration fails, its violation check raising 23000, exactly when a stored
 *   package has no home, and once it applies, a package written without a home is refused at COMMIT and one with its
 *   course commits.
 *
 * The oracle is the curriculum's laws restated over the rows (curriculum.fixtures.ts brokenIn, applyOp).
 */
import { finite } from "@bjornpagen/testing/gen"
import { aimed } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	curriculumAims,
	curriculumCaseGen,
	curriculumDeadline,
	curriculumTemplate,
	migrationCase,
	runCurriculum,
	standingsSpace
} from "#test/pg/laws/curriculum.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The curriculum level accepts exactly the calls whose state keeps every law, refusing the rest naming laws they break.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const curriculumHistories = property.batched(aimed(curriculumCaseGen, curriculumAims), {
	window: 16,
	batches: 1,
	needs: { fresh: Substrate.freshOf(curriculumTemplate) },
	situations: [
		"a publish's second stratum writes a membership",
		"a state breaking the key over the derived union refused",
		"a claim and the memberships disagreeing refused",
		"a second claim of a package refused",
		"a package without a home refused",
		"a registry delete of a home with members refused at COMMIT",
		"a registry delete of an empty home accepted",
		"a catalog split by a comment claims nothing",
		"a membership in an unregistered home refused"
	],
	oracle: {
		kind: "specification",
		name: "the curriculum's laws restated over the rows (curriculum.fixtures.ts brokenIn): a call is accepted exactly when the state it leaves keeps every law, and refused naming laws it breaks"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/conservative/expr/ops.ts",
			original: '\treturn call("btrim", [replaced(marked, "\\t", "")])',
			replacement: '\treturn replaced(marked, "\\t", "")',
			why: "A collapse leaves its text's leading and trailing space untrimmed, so a relation whose kind is written with white space around `ispartof` claims no home; the publish of a package whose one claim is so written is refused where the curriculum accepts it."
		}
	],
	show: Formatter.format,
	caseDeadline: curriculumDeadline,
	checkAll: runCurriculum
})

/** A later migration adding a stored relation's containment in a derived one fails exactly where a stored package has no home. */
export const homesThroughALaterMigration = property.exhaust(finite(standingsSpace), {
	needs: { substrate: Substrate.fresh },
	situations: [
		"a later containment the stored rows break refused",
		"a later containment the stored rows keep applied",
		"a package without a home refused at COMMIT after the migration"
	],
	oracle: {
		kind: "specification",
		name: "One home restated over the stored rows: the second migration applies exactly when every stored package has a home, and a write after it commits exactly when it does"
	},
	box: "two packages, each absent, stored without a home or stored with its course, under a first version without every Package's containment in Home",
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original: '\t\t\tthis.push("validate", { kind: "violation", law: c.law, query: c.query })',
			replacement: "\t\t\t{}",
			why: "A migration checks no rule over a query it adds against the rows it stores, so every Package's containment in Home applies over a stored package with no home, which it must refuse."
		}
	],
	show: Formatter.format,
	check:
		({ substrate }, c) =>
		(stood) =>
			Effect.provideServiceEffect(migrationCase(stood, c), Substrate, substrate)
})
