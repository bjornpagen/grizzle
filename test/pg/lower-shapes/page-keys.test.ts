/**
 * A page's window is a keyset take of its driver alone, a part for each row of the values the call reads of its prefix,
 * merged, the rest of its rows read once per window row at the driver's key (lower/shapes/page/driver.ts): where every
 * other occurrence of the rows' region is exactly one per driver row, by a key and a containment, a guard, or read
 * before the driver by a chain from the call's values sharing no class with the others (a value set: the email's
 * users), every filter fixes a driver column or a class of that chain, compares the order's first free column (an
 * interval) or reads statement values alone, the completed order reads the driver's columns and the rows hold its key,
 * the first `size` rows past an anchor are the rows of the driver's first `size` past it, merged over the parts
 * (W = D ⋉_K merge_k^O { take_k^O(σ_{prefix = s ∧ c ∈ I ∧ seek}(R)) : s ∈ S }), which an index of the prefix's columns
 * then the order reads in order (physical/access/extract.ts drivenSeek), a mixed-direction seek at its leading key's
 * bound (page/seek.ts seekPredicate). Before, metis's coach dashboard window (coachAssignments, answered(paged(...))) was a
 * join of every sitting's status, assignment and test under ORDER BY number DESC LIMIT $size, which a generic plan's
 * estimate answered with a hash join and a sort of every sitting, 256k pages a window of 50 rows; a status tab had no
 * index of its status, so a rare status read every newer sitting first.
 *
 * On PostgreSQL 19, a ledger in small (page-keys.fixtures.ts): learners' sittings with their events, their statuses
 * stored under the learner's unit, gradings and waiting positions, marks and emails; an operator granted teaching,
 * signed in by the claims; a few learners and then a hundred or so more, each newer than any before, every table stood
 * in a pg_class state (test/support/advice.ts PgClassState: never vacuumed, counted empty, analyzed, skewed, large).
 * The window is paged as a served Db of the ledger's full world pages it, its role's compile for a page under the
 * advice its served record ships (advice.ts servedPageRead).
 *
 * Oracle: a second implementation, the page oracle's baseline (test/support/conservative.ts conservativePage), read
 * under the store's own statistics, analyzed, and cost-chosen: the oracle of the rows alone, each part's the same, the
 * windows of every start at an anchor drawn from the unpaged read; the rule's verdict, the coach dashboard's windows
 * driven and the grade's, the email's and the marked windows not; the plan laws over the page's five variants
 * (advice.ts lawsHold: Laws 1 to 3, the advice its record ships the advice its plans carry); its budget, each scan of
 * the window's plan within the pages that plan gives (advice.ts budgetOfPlan); and a bound on a driven window's plan
 * under its advice, the generic plan every session grizzle opens runs at any values: its scans read at most 60 rows for
 * each row it holds, 200 more and an offset's skipped entries, and the operator's account once, beside a few learners
 * and beside many, in every pg_class state, which stands for the optimized window's read alone
 * (page-keys.fixtures.ts apart).
 *
 * And a window of one tab of the coach dashboard as metis's coachDashboard (packages/ops/src/coach.ts) in the form its
 * driver reads, over a stored DashboardEntry, in AlphaTest's order: scored, graded and assigned descending, a seek of
 * mixed directions whose leading keys bound the index range together (page/seek.ts), about ten facts a row; its
 * sitting's status read as an attachment, or joined in its body where the status's key and each assignment's
 * containment in the statuses state one status a sitting (METIS-STAFF's ruling), each driven; and one student's tab by
 * an email, as metis's coachDashboardOf restated (the entry carrying its user, the email's users read by the email),
 * driven by a part for each of the email's users, merged, and at the user's own grade, which the test binds as well,
 * not driven. And den's queue (law L4): one kind's steps available now, the earliest first, its driver's interval the
 * order's first column at most now, driven, and past a step, a comparison of the order's second column, not driven; and
 * the steps available now of every kind one worker serves, a part for each kind, merged, driven: beside many learners
 * each kind holds hundreds of available steps, so a part read past the window's size, or parts cut unmerged, shows. And
 * a window joining each sitting's marks, several a sitting, each with its tag's definition, not driven.
 *
 * Features: each driven window from each start, each refused window, each driven window over rows it holds, each
 * stored view holding rows, beside a few learners and many, with every table in each pg_class state.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	drivenWindows,
	type PageFeature,
	pageSpace,
	pageTemplate,
	refusedWindows,
	runPage,
	starts,
	storedViews
} from "#test/pg/lower-shapes/page-keys.fixtures.ts"
import { pgClassStates } from "#test/support/advice.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Every driven window from every start, every refused window, each driven window over rows it holds and each stored
 * view holding rows (no run of empty reads alone passes), beside a few learners and many, in each pg_class state.
 */
const situations = [
	...Arr.flatMap(drivenWindows, (w) => Arr.map(starts, (s) => `${w} from ${s}` as const)),
	...refusedWindows,
	...Arr.map(drivenWindows, (w) => `${w} over rows` as const),
	...Arr.map(storedViews, (v) => `${v.name} holds rows` as const),
	"beside a few learners",
	"beside many learners",
	...Arr.map(pgClassStates, (s) => `with every table ${s}` as const)
] as const satisfies ReadonlyArray<Reached<PageFeature>>

/**
 * A window of the coach dashboard reads its own rows alone however many sittings the store holds beside them, equal to
 * the unpaged read's rows from its start, in any pg_class state, planned as the advice it carries: its driver's take by
 * its index, then each row's assignment, test, guard, email, percent and waiting positions at the row's keys.
 *
 * Its budget is the runner's: its 63 situations, 45 of them drawn alike (a driven window from one start, or a refused
 * window from any), and each still pending when the steered phase begins aimed at by a case built at it (pageSpace).
 */
export const aWindowReadsItsDriversTakeAndEachRowAtItsKey = property.explore(pageSpace, {
	needs: { stored: Substrate.rolledBack(pageTemplate) },
	situations,
	check:
		({ stored }, c) =>
		(drawn) =>
			Effect.gen(function* () {
				const clone = yield* stored
				yield* runPage(clone, drawn, c)
			}),
	oracle: {
		kind: "second-implementation",
		name: "the page oracle's baseline (conservativePage), analyzed and cost-chosen, the oracle of the rows alone, each part's the same, at an anchor drawn from the unpaged read; the rule's verdict, the coach dashboard's windows, the tab by an email and den's queue driven and the others not; the plan laws over the page's five variants under the advice its served record ships; the window's budget; and the bound on a driven window's generic plan under its advice: its scans read at most 60 rows for each row it holds, 200 more and an offset's skipped entries, and the operator's account once, beside a few learners and beside a hundred or so more, in every pg_class state"
	},
	kept: [
		{
			token: ReplayToken(
				"test/pg/lower-shapes/page-keys.test.ts#aWindowReadsItsDriversTakeAndEachRowAtItsKey:1e1fffffff0000.16:1.5.a.4.1.1.1.1.2c.1"
			),
			reason:
				"the coach dashboard's joined window of the tab of every sitting from its last rows, beside 1,040 learners and then 1,184, every table counted empty: the page oracle's baseline, read under the statistics the case stated (each value its own, when the case was kept), priced the tab's 7,280 entries at one row and rescanned a hash join of every assignment for each, in the window's body and in each of its six attachments (53 million rows a copy, 155 s), and the case hung past the runner's 60 s, where the optimized window read 593 buffers in 9 ms; the baseline reads its learners analyzed, apart from the optimized window's state (page-keys.fixtures.ts apart), its unpaged read 1.8 s and each window 0.6 s under the store's own counts",
			since: "2026-11-27"
		},
		{
			token: ReplayToken(
				"test/pg/lower-shapes/page-keys.test.ts#aWindowReadsItsDriversTakeAndEachRowAtItsKey:-:4.0.0.0.0.0.0.2f.0.0.0"
			),
			reason:
				"every sitting's window at the position 87% of its rows in, of one row, beside 1,030 learners and then 1,090, every table never vacuumed: judged by the plan PostgreSQL made at the call's position (when the case was kept, under counted statistics and no advice), the driver's take of the position's 2,688 entries read the status table whole, a sequential scan where its index in order serves; the plan its advice carries reads the status index in order, 2,688 entries for any position, then D at the one kept key, a positioned window's bound twice its position past a keyset window's",
			since: "2026-11-27"
		}
	],
	kills: [
		{
			file: "packages/engine/src/lower/optimize/pipeline.ts",
			original: '\tif (subject.kind !== "page" || root.kind !== "OrderedResult") {\n',
			replacement: "\tif (true) {\n",
			why: "No window is driven: the window is a join of every sitting under ORDER BY and LIMIT, and a status tab's rare status reads every newer sitting first, past the bound beside many learners."
		},
		{
			file: "packages/engine/src/physical/access/extract.ts",
			original: '\t\t\t\tif (window?.kind === "driven") {\n',
			replacement: "\t\t\t\tif (false) {\n",
			why: "A page seek resolves to the first occurrence holding the order's columns, the assignment, whose status is restricted beside it: no index of the status then the number is asked, and the driver's take of a rare status reads every newer sitting's status first."
		},
		{
			file: "packages/engine/src/lower/shapes/page/seek.ts",
			original: "\treturn and([\n\t\treached,\n",
			replacement: "\treturn and([\n\t\tlit.bool(true),\n",
			why: "A mixed-direction seek is its expansion alone: the window past an anchor reads every entry of the index before the anchor, past the bound once the newer learners stand before it."
		},
		{
			file: "packages/engine/src/lower/shapes/page/driver.ts",
			original:
				"\tif (![...filterFixed.keys()].every((k) => columnOf.has(k) || chained.has(k))) {\n",
			replacement: "\tif (false) {\n",
			why: "A filter of a column neither the driver nor its value set's chain binds, the test's grade, the test exactly one a sitting, is left out of the driver's take: the take holds sittings of every grade, D at their keys drops the others after the limit, and the window holds fewer rows than the baseline's."
		},
		{
			file: "packages/engine/src/lower/shapes/page/driver.ts",
			original: "\t\t\treturn columnOf.has(k) || fixedValue.has(k) || !afterClasses.has(k)\n",
			replacement: "\t\t\treturn true\n",
			why: "A value set's chain sharing a class with a step of exactly one row is taken for a filter of the driver alone: the student's tab at the user's own grade is driven by the email's users, each part holding entries of every grade, which D at their keys drops after the limit, and the window holds fewer rows than the baseline's."
		},
		{
			file: "packages/engine/src/lower/shapes/page/driver.ts",
			original: "\t\t[...restriction.values()].map((r) => r.column)\n",
			replacement: "\t\tregion.vars.map((v) => v.name)\n",
			why: "A value set is read by a chain no value of the call starts, every variable taken for bound: the email window is driven by every person holding an email, read whole, and the marked window by every marked sitting, past the bound beside many learners."
		},
		{
			file: "packages/engine/src/lower/shapes/page/driver.ts",
			original:
				"\tif (first === undefined || !ranges.every((r) => columnOf.get(r.class) === first.column)) {\n",
			replacement: "\tif (first === undefined) {\n",
			why: "A comparison of the order's second column is taken for an end of the first's interval: the queue past a step is driven, its step's comparison read at the available time, and the window's rows are not the baseline's."
		},
		{
			file: "packages/engine/src/lower/shapes/page/compile.ts",
			original: "\t\t...ends\n\t])\n",
			replacement: "\t])\n",
			why: "A part's take reads past its interval: the queue's steps available later than now are taken first from its last row, which D at their keys drops after the limit, and the window holds fewer rows than the baseline's."
		},
		{
			file: "packages/engine/src/lower/shapes/page/rows.ts",
			original: '\t\torderBy: spec.direction === "backward" ? reversedOrder(parts) : parts,\n',
			replacement: "",
			why: "The parts' rows are cut at the window's size unmerged: the worker's queue keeps its first kind's steps, not the earliest available of every kind it serves, and the window's rows are not the baseline's."
		},
		{
			file: "packages/engine/src/lower/shapes/page/rows.ts",
			original: '\t\tlimit: skipped === undefined ? limit : binary("+", skipped, limit)\n',
			replacement: "\t\tlimit: lit.int(1000000000, types.bigint)\n",
			why: "A part is read whole before the merge cuts it: the worker's queue sorts every step available now of each kind it serves, past the bound beside many learners, where one kind's queue, a part the merge's limit reads in order, reads its size alone either way."
		},
		{
			file: "packages/engine/src/lower/shapes/page/driver.ts",
			original: "\t\t\t\t\t\t: facts.containments.flatMap((c) => {\n",
			replacement:
				"\t\t\t\t\t\t: [...facts.containments, ...facts.containments.map((x) => ({ ...x, from: x.to, to: x.from }))].flatMap((c) => {\n",
			why: "A containment is read either way, a person's email in the people taken for every person's email: the email window is driven, its take holds sittings of people with no email, which D at their keys drops after the limit, and it holds fewer rows than the baseline's."
		},
		{
			file: "packages/engine/src/lower/shapes/page/driver.ts",
			original:
				"\t\t\t\t\t\t\t\tconst one = exactlyOne(c, facts.keyAmong(source, c.to.fields), facts.context)\n",
			replacement:
				"\t\t\t\t\t\t\t\tconst one = exactlyOne(c, facts.keyAmong(source, source.heading.map((h) => h.name)), facts.context)\n",
			why: "A join of several rows per driver row, each sitting's marks with their tags' definitions, is taken for one: the marked window is driven, and each window row reads every mark of its sitting."
		},
		{
			file: "packages/engine/src/analysis/schema.ts",
			original: "\t\t\t\t\t\t\t\t\t? storedRead(owned, r.name, relation.definition.read)\n",
			replacement: "\t\t\t\t\t\t\t\t\t? relation.definition.read\n",
			why: "A stored view's declared key is no key of its view: the one status a sitting the joined dashboard reads is keyed by the status as well, the page's order is completed by it, no driver's column, and the joined window stands as it is."
		},
		{
			file: "packages/engine/src/analysis/theory/theory.ts",
			original: "\t\t\tconst key = storedViewKey(d.side)\n",
			replacement: "\t\t\tconst key = undefined\n",
			why: "A stored view's declared key is no evidence the catalog resolves: the joined dashboard's status read at the sitting has no key the physical analysis proves, so it is no step of exactly one row and the joined window stands as it is."
		},
		{
			file: "packages/engine/src/analysis/theory/theory.ts",
			original:
				'\t\t\tconst contained = stated.kind === "contained" ? viewContainment(stated) : undefined\n',
			replacement: "\t\t\tconst contained = undefined\n",
			why: "A containment into a stored view, held by the rule judge, is no existence evidence: no assignment is proven to hold a status, the joined dashboard's status is no step, and the joined window stands as it is."
		},
		{
			file: "test/pg/lower-shapes/page-keys.fixtures.ts",
			original:
				'\t\t\t\tyield* standIn(session, learnersLoad(installed, connection, c, c.learners), "analyzed")\n',
			replacement:
				"\t\t\t\tyield* standIn(session, learnersLoad(installed, connection, c, c.learners), c.state)\n",
			why: "The page oracle's baseline reads its learners in the case's pg_class state, not its own analyzed statistics: counted empty prices every table at about a row, the baseline is planned by that tie, a tab's every entry rescanning a hash join of every assignment in the window's body and in each attachment's, and the kept case hangs past the runner's 60 s."
		},
		{
			file: "packages/engine/src/program/served.ts",
			original:
				"\t\t[requests.first, requests.after, requests.last, requests.before, requests.at].map(\n",
			replacement: "\t\t[requests.first, requests.after, requests.last, requests.before].map(\n",
			why: "A page's served record ships no advice for its positioned window: the transaction it opens holds no item of the `at` variant's statement, which PostgreSQL then plans by its own costs, and the advice in force is not the advice the page's plans carry (Law 1)."
		}
	]
})
