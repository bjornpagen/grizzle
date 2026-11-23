/**
 * The seeding of a rule over a query's probes on PostgreSQL 19: each probe of the set judge (physical/ddl/rules.ts
 * addRules) is the rule's violation restricted to the rows the transaction wrote, its region, and those its chain
 * reaches from them, so it judges exactly what the rule's whole check judges, and reads only the rows of the touched
 * row's key.
 *
 * The shapes are five schemas of link tables L1, L2 and L3, each row linked up to the one before it and L1's to its
 * key, a mark M on a link and a block N of one, each a downstream shape in miniature:
 *
 * - **titles**, edullm's LomObjectTitle: the keys whose L2 a mark names, through an imported path L1 ⋈ L2, are
 *   contained in the keys of a path an L3 of value 1 extends or no N blocks, a target of two arms, one negated;
 * - **viewed**: titles over a derived relation Path = L1 ⋈ L2 at a level of its own, which both sides' definitions
 *   read: the whole check reads each side as its definition, live, each definition a query of its own
 *   (analysis/theory/query.ts violationQuery), and the triggers as its arms, every definition inlined, so the
 *   equivalence holds the one against the other;
 * - **deep**: a source of two arms, a mark on L1 or on an L2 of value 1, contained in a target of three, the first
 *   declared from its deepest link up, the second an L1 of value 1 no N blocks, the third a chain of three whose L3 no N
 *   blocks;
 * - **key**: a key over a side of three arms, each a key's value read off an L1, an L2 under an unblocked L1, or an L3
 *   at the end of the path;
 * - **tagged**: key's side, its arms tagging their facts by literals, the first two by 1 and the third by 2, a union a
 *   literal tells apart, under a key over the key and its tag: a probe of the first arm meets the second's tag by the
 *   same literal, bound, and the third's by a different one, compared in the third's own query
 *   (analysis/theory/query.ts Meeting), so the third arm meets no fact of the first's;
 * - **standing**: a key over the L1s no standing block holds out, a block standing where no mark lifts it: a side that
 *   negates a query that negates in turn, an Active of the sittings no standing invalidation names in miniature, so a
 *   probe reads M under two negations (analysis/theory/query.ts Polarity): a mark inserted brings back the facts its
 *   block held out, as a block deleted does, and a mark deleted withdraws them;
 * - **lifted**: a containment of the keys of a path in standing's side, a target that negates a query that negates in
 *   turn: a block inserted withdraws the target facts it holds out, and a mark deleted does too, the target's
 *   occurrence under two negations losing a row;
 * - **budget**: edullm's First_budget in miniature, a check over the L1s that are not rate-paced, an L1 rate-paced
 *   where none of its L2s is paceless and an L2 paceless where no block marks it: three negations deep, so a block
 *   deleted, under three, brings back the facts the check reads.
 *
 * - **Equivalence:** one search per shape whose rule reads a relation under negations of negations, standing, lifted
 *   and budget (rule-seeding.fixtures.ts judgedShapes), each with the budget of its own; each case draws a history of direct SQL transactions at SERIALIZABLE over keys 1 and 2
 *   and ids 1 to 3: chains of three links, marks, blocks, deletes of one row or of a link and its children at once,
 *   and replacements of a link's parent or value, its row deleted and inserted again in one statement, since a link is
 *   immutable and its table refuses an UPDATE that changes a row. Each transaction, before its triggers run, runs the rule's whole violation
 *   query lowered by the oracle baseline (deploy/snapshot/violation.ts baselineRuleChecks), read whole and never
 *   seeded: that oracle judges the state the transaction leaves, and the rule's check over every row, the judge's
 *   statements over the transaction that writes every row, which the migration that adds the rule runs (lawChecks),
 *   finds a row exactly where it does. Then SET CONSTRAINTS ALL IMMEDIATE runs
 *   the judge, and the transaction commits exactly when the oracle finds no violation, refused otherwise at that moment
 *   by SQLSTATE 23503 for a containment and 23505 for a key, naming a rule the installation's constraint map maps to
 *   the rule.
 * - **Locality:** one search per shape, as for equivalence, each with the rotating budget the one search over every
 *   shape had and no steered phase, since every case of a shape's search measures that shape; each case draws a count
 *   of keys from 250 to 400 and one of them, and 600 to 900 keys more.
 *   The shape holds the first keys' rows, each key a chain of value 1, two marks and a block of no link, then every
 *   key's: the block holds out no link, and keeps N's key index from standing empty, which PostgreSQL locks whole
 *   (nbtsearch.c _bt_first), so a probe of a block bounded by its key locks a leaf page of it. Each of the drawn key's
 *   rows on a table the rule reads, and a block of each of its links, is touched: in a transaction of its
 *   own the row stands in the judge's region: a stored row's image copied into each delta of its table as it is stored,
 *   counted once put on the side of news, the table unwritten, a block inserted and deleted again, which the captures
 *   take. SET CONSTRAINTS ALL IMMEDIATE
 *   runs the judge, the SIRead locks the transaction holds are counted by lock type and relation, and every probe of
 *   the judge over the table's deltas is explained while they hold the row's images, the transaction rolled back. The rows each probe reads, as EXPLAIN ANALYZE counts them, and
 *   the SIRead locks are the same beside every
 *   key as beside the first, and no SIRead lock is on a whole relation: an invariance, no time. The first keys' rows
 *   fill more than one heap page of every table and the rest three more, so a probe that read every key would read
 *   more rows and lock more pages, or a relation, where a probe of the key reads its own. Both measurements plan as
 *   PostgreSQL plans once every table is large beside one key's rows: no sequential, bitmap or index-only scan, no hash
 *   or merge join, the plans a table of a few rows makes cheapest and an index-only scan's locks follow the visibility
 *   map; a probe that can read a key's rows by index then does, and one that cannot reads every row all the same.
 *
 * The refusals required of each equivalence search are those its withdrawals reach, which a drawn history reaches
 * rarely, so each has a case constructed to reach it, which a witness whose turn aims at the refusal draws (aimsOf): a
 * lawful build, then the withdrawal (withdrawalsOf). standing's key is refused by a block deleted alone and by a mark
 * inserted alone, the occurrence under two negations, and requires both; lifted's containment by a block inserted and
 * by a mark deleted alone; budget's check by a block deleted alone, under three negations.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { family, type Kill, property, type Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Record as Rec, String as Str } from "effect"
import {
	aimsOf,
	caseGen,
	type EquivalenceFeature,
	footprints,
	installedIn,
	judgeHistory,
	judgedShapes,
	type JudgedShape,
	type LocalityFeature,
	localityGen,
	requiredOf,
	seedTemplates,
	shapes,
	touchedOf
} from "#test/pg/laws/rule-seeding.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The kills of each judged shape's equivalence search: a relation under negations probed by no write that turns its
 * polarity at each negation, so a write that brings back or withdraws facts through them is judged by no probe.
 */
const equivalenceKills: { readonly [S in JudgedShape]: ReadonlyArray<Kill> } = {
	budget: [
		{
			file: "packages/engine/src/analysis/theory/query.ts",
			original: "\t...movedCandidates(arms, direction, relation, side, depth, memo, loc)\n",
			replacement: "",
			why: "A relation under three negations probed by no deletion: a fact a negation now blocks is withdrawn by no candidate, so a block deleted, which makes its member paceless and its root no longer rate-paced, brings back a fact the check refuses, and it commits."
		}
	],
	lifted: [
		{
			file: "packages/engine/src/analysis/theory/query.ts",
			original: "\t\t\t\tturned(direction),\n",
			replacement: "\t\t\t\tdirection,\n",
			why: "A target's relation under two negations probed by no deletion: a mark deleted, which lets a block stand again and withdraws the target facts it holds out, is judged by no probe, so the containment it breaks commits."
		}
	],
	standing: [
		{
			file: "packages/engine/src/analysis/theory/query.ts",
			original: "\t\t\t\tturned(direction),\n",
			replacement: "\t\t\t\tdirection,\n",
			why: "A relation read under two negations probed by no write: a mark inserted, which lifts a standing block and brings back the facts it held out, is judged by no probe, so the key it breaks commits."
		},
		{
			file: "packages/engine/src/analysis/theory/query.ts",
			original:
				'const flipped = (p: Polarity): Polarity => (p === "positive" ? "negative" : "positive")',
			replacement: "const flipped = (p: Polarity): Polarity => p",
			why: "A negation that does not flip its arm's polarity: the deltas a probe of a negated relation reads are never captured, so a block deleted commits the key it breaks."
		}
	]
}

/**
 * Commit exactly the transactions whose state the rule's whole check finds lawful, refusing the rest by the rule, one
 * property for each judged shape, each case on its own clone of its shape's schema.
 *
 * Its pre-conversion budget: runs 80, coverage cases 200 each (test/pg/laws/rule-seeding.test.ts at eccd3c305).
 */
export const commitExactlyTheTransactionsWhoseStateTheRulesWholeCheckFindsLawful = family(
	Rec.fromEntries(
		Arr.map(judgedShapes, (shape) => [
			shape,
			property.explore(aimed(caseGen(shape), aimsOf(shape)), {
				needs: { fresh: Substrate.fresh(seedTemplates[shape]) },
				situations: requiredOf(shape) satisfies ReadonlyArray<Reached<EquivalenceFeature>>,
				check:
					({ fresh }, k: Case<EquivalenceFeature>) =>
					(c) =>
						Effect.scoped(
							Effect.flatMap(fresh, (taken) =>
								Effect.provideService(
									Effect.flatMap(installedIn(taken, shape), (installed) =>
										judgeHistory(installed, c, k.note)
									),
									Substrate,
									taken.substrate
								)
							)
						),
				oracle: {
					kind: "postgresql",
					name: "the rule's whole violation query, the migration's check over every row, unseeded: a transaction commits exactly when it finds nothing in the state the transaction leaves"
				},
				show: Formatter.format,
				budget: { runs: 80, steered: 200 },
				kept: [],
				kills: equivalenceKills[shape]
			})
		])
	)
)

/**
 * A kill of the shapes whose probes meet a negation keyed by each row's terms (`negating`): a containment's target, or
 * a key's side, that negates.
 */
const decorrelated = Object.freeze({
	file: "packages/engine/src/analysis/theory/navigate.ts",
	original:
		'\t\t\t\t\treturn this.rule({ ...arm, where: [...arm.where, ...at] }, depth + 1, keptOf(arm))\n\t\t\t\t})\n\t\t\t\treturn {\n\t\t\t\t\tkind: a.kind,\n\t\t\t\t\tsource: {\n\t\t\t\t\t\tkind: "query",\n\t\t\t\t\t\tquery: { stage: { kind: "rules", arms: navigated, loc: stage.loc } },\n\t\t\t\t\t\tbind: Object.fromEntries(passing.bind)\n\t\t\t\t\t},\n\t\t\t\t\tbindings: {}\n\t\t\t\t}',
	replacement:
		'\t\t\t\t\treturn this.rule(at.length < 0 ? arm : arm, depth + 1, keptOf(arm))\n\t\t\t\t})\n\t\t\t\treturn {\n\t\t\t\t\tkind: a.kind,\n\t\t\t\t\tsource: {\n\t\t\t\t\t\tkind: "query",\n\t\t\t\t\t\tquery: { stage: { kind: "rules", arms: navigated, loc: stage.loc } },\n\t\t\t\t\t\tbind: Object.fromEntries(passing.bind)\n\t\t\t\t\t},\n\t\t\t\t\tbindings: Object.fromEntries(Object.entries(a.bindings).map(([field, outer]) => [field, passing.expr(atColumn(pinned(outer), field, columns))]))\n\t\t\t\t}',
	why: "A negation's arms are read whole, the target's facts at every key, and anti-joined with the row's terms after, where each arm is restricted by them inside: a probe's negation of the target reads every key's rows for one key's write, and takes their SIRead locks; the property fails."
})

/**
 * A kill of every shape's probes, each of which holds a touched row, or what a write moves of a definition its rule
 * negates (analysis/theory/query.ts movedOf), at a variable another match binds: held to its region by no pin, it reads
 * every candidate.
 */
const unpinned = Object.freeze({
	file: "packages/engine/src/analysis/theory/query.ts",
	original: "\t\t\tpinned.push(equal(e, value))",
	replacement: "\t\t\tvoid equal(e, value)",
	why: "A probe whose touched row binds a variable another match binds, held to its region by no pin: it reads every candidate the rule's whole check reads, so it judges the same and reads every key's rows."
})

/**
 * The shapes whose probes meet a negation the navigation keys by each row's terms: every shape but key's and tagged's,
 * which negate nothing, and budget's, a check, which meets nothing, whose rows read each of its negations, of one arm
 * and no union, among their own conditions, so PostgreSQL reads it at the row's key however navigation correlates it.
 */
const negating: ReadonlySet<string> = new Set(["titles", "viewed", "deep", "standing", "lifted"])

/**
 * Read the same rows and take the same SIRead locks beside hundreds more keys, none on a whole relation, one property
 * for each shape, each case on its own clone of its shape's schema.
 *
 * Its pre-conversion budget: runs 6, coverage cases 0 each (test/pg/laws/rule-seeding.test.ts at eccd3c305).
 */
export const readTheSameRowsAndTakeTheSameSireadLocksBesideHundredsMoreKeys = family(
	Rec.fromEntries(
		Arr.map(shapes, (shape) => [
			shape,
			property.explore(localityGen(shape), {
				needs: { fresh: Substrate.fresh(seedTemplates[shape]) },
				situations: [`${shape} measured`] satisfies ReadonlyArray<Reached<LocalityFeature>>,
				check:
					({ fresh }, search: Case<LocalityFeature>) =>
					(l) =>
						Effect.scoped(
							Effect.flatMap(fresh, (taken) =>
								Effect.provideService(
									Effect.gen(function* () {
										const { seat } = yield* installedIn(taken, shape)
										const few = yield* footprints(seat, l.key, 1, l.before)
										const many = yield* footprints(seat, l.key, l.before + 1, l.after)
										for (const [i, touched] of touchedOf(seat, l.key).entries()) {
											const where = `${Formatter.format(l)}, ${touched.table} ${touched.id}`
											const before = defined(few[i], "a footprint beside the first keys")
											const after = defined(many[i], "a footprint beside every key")
											assert.ok(before.rows.length > 0, `${where}: a probe reads the touched table`)
											assert.deepEqual(
												after.rows,
												before.rows,
												`${where}: each probe reads the same rows`
											)
											assert.deepEqual(after.locks, before.locks, `${where}: the same SIRead locks`)
											assert.deepEqual(
												Arr.filter(after.locks, Str.startsWith("relation ")),
												[],
												`${where}: no SIRead lock on a whole relation`
											)
										}
										search.note(`${l.shape} measured`)
									}),
									Substrate,
									taken.substrate
								)
							)
						),
				oracle: {
					kind: "universal",
					name: "invariance: a probe of a key reads the same rows and its triggers take the same SIRead locks whatever other keys hold"
				},
				show: Formatter.format,
				budget: { runs: 6, steered: 0 },
				kept: [],
				kills: [unpinned, ...(negating.has(shape) ? [decorrelated] : [])]
			})
		])
	)
)
