/**
 * A signed-in learner's list reads that learner's sittings alone however many learners the store holds beside it: the
 * claims' context drives the read (cte-policy semiJoinDriven, lower/shapes/semi-join drivenSemiJoin), each read of it
 * keyed through the dependencies containments give (cte-policy boundPrefix closedUnder: a sitting's events read at its
 * number, which its assignment's key names, hold its learner); its Clerk user read by its key, its person's assignments
 * by their learner, each sitting's status, a union derived from its events, read at the sitting's number as a row site
 * of the chain (share/sites.ts chainSites, lower/shapes/region keyedChain), and each existence test under them, the
 * valid sittings' and each status arm's, reading its right side at each left row's values (cte-policy rightPerLeftRow,
 * conservative/semi-join/exists.ts existenceTest), never derived whole. metis's student_app
 * myAssignments, before: the claims were an existence test over the whole list, and the status union and the valid
 * sittings were each derived whole for every learner, 269k pages a call at 41,249 sittings for a learner holding one.
 * And a guard of an ops call, the signed-in operator's permission to run its program beside the call's own relations,
 * reads the programs that Clerk user may run at its key: the existence test's right side keyed at the claims' Clerk user,
 * which the claims' chain reaches (share/keys.ts KeyAnalysis rowReading), where metis's ops calls derived every Clerk
 * user's permitted programs whole, 590 pages a call. And the open sittings of the
 * test a call names, the lowest two first (metis's myOpenSittingsOf), derive each sitting's status at the key set the
 * claims' chain reaches, its Clerk user, its person and the person's assignments of the test (share/keys.ts KeyAnalysis
 * #crossing): the test, a constant no key of the assignments leads with, seeds no key set where the claims reach the
 * sittings, where it derived the status at every learner's assignments of the test; and the take sorts the chain's rows,
 * asking no take seek of the assignments, which the chain does not lead with (physical/access/extract.ts Resolution
 * `leads`), where every learner's assignments of the test in number order were an index no plan read.
 *
 * On PostgreSQL 19, a ledger in small (ready-keys.fixtures.ts): learners signed in as Clerk users, each learner's
 * assignments, their events, invalidations, reinstatements and grants, a few learners and then a few hundred more, under
 * the statistics a VACUUM counts or under misleading ones stating every row one learner's, one sitting's and one Clerk
 * user's (pg_restore_attribute_stats); under claims naming learner 1's Clerk user, the read of its list, or of a coach's
 * review of its first sitting behind the guard.
 *
 * The ledger in two forms: its views stored at the learner's unit, as metis's installation holds them, where a read of
 * the status at a sitting's number is keyed through the dependency its definition proves (analysis/derived/drawn.ts
 * viewDependencies: every rule draws a sitting's (child, number) from its assignment's or its events', which its
 * assignment's contain, and its number keys an assignment); and its views live, read through their definitions, where
 * the status union is a row site of the chain and the valid sittings an existence test read per left row.
 *
 * Oracle: a bound, the read's scans read at most a fixed number of rows for each sitting it reads and a few more,
 * however many learners stand beside it, and whatever the statistics say: stored relations' rows and CTE scans' with
 * what their filters removed.
 *
 * And the workload's indexes are the paths its reads' chains seek by, no more and no fewer (physical/access/extract.ts,
 * read off the query each read's lowering lowers, program/workload/compile.ts loweredIr): every chain step reads
 * through an index, within each read's bound, every index the installation builds for the workload's access is read by
 * some read's plan, where extraction anticipating every join order asked a take seek and an equality lookup no chain
 * runs, which misleading statistics led PostgreSQL to read every learner's assignments of a test by, and those over the
 * stored relations are exactly the specification's (ready-keys.fixtures.ts accessIndexes).
 *
 * And den's scope reads (UNITKEY's class b2), a step at its scope joined to a value family on the step alone, the
 * family keyed by the root, the step and its own fields and contained at the root and the step in the step's: a
 * round's attempts, each keyed by itself and carrying its learner, read at the call's round, and their responses,
 * keyed by the learner, the attempt and the item. The attempts drive the responses (cte-policy semiJoinDriven), read
 * once at their sitting through the index the access asks of it, never probed per response (physical/access/extract.ts
 * visit), and each attempt's row binds the learner the containment and the attempt's key make equal to its responses'
 * (lower/optimize/eliminate R03.containedEquality), so the responses are read at their key's prefix and the workload
 * builds no index over them, where the attempt alone asked one, a B-tree insert on every response.
 *
 * Features: the list, one sitting, the open sittings of a test, the guarded review and a sitting's responses, counted
 * and misleading statistics, beside a few learners and beside many; for the workload, beside a few learners and beside
 * many.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	liveLawsTemplate,
	liveTemplate,
	type ReadyFeature,
	readyGen,
	runReady,
	runWorkload,
	type Storage,
	storedLawsTemplate,
	storedTemplate,
	type WorkloadFeature,
	workloadGen
} from "#test/pg/lower-shapes/ready-keys.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Every read under counted and misleading statistics, beside a few learners and beside many. */
const situations = [
	"list, counted, beside a few learners",
	"list, counted, beside many learners",
	"list, misleading, beside a few learners",
	"list, misleading, beside many learners",
	"guard, counted, beside a few learners",
	"guard, counted, beside many learners",
	"guard, misleading, beside a few learners",
	"guard, misleading, beside many learners",
	"one, counted, beside a few learners",
	"one, counted, beside many learners",
	"one, misleading, beside a few learners",
	"one, misleading, beside many learners",
	"open, counted, beside a few learners",
	"open, counted, beside many learners",
	"open, misleading, beside a few learners",
	"open, misleading, beside many learners",
	"responses, counted, beside a few learners",
	"responses, counted, beside many learners",
	"responses, misleading, beside a few learners",
	"responses, misleading, beside many learners"
] as const satisfies ReadonlyArray<Reached<ReadyFeature>>

const oracle = {
	kind: "universal",
	name: "bound: the read's scans read at most a fixed number of rows for each sitting it reads and a few more, stored relations' and CTE scans' with what their filters removed, beside a few learners and beside a few hundred, under counted and misleading statistics"
} as const

/**
 * The kill that reads a driven semi-join's driver as an existence test's right side, probed at the pairs per left row
 * (physical/access/extract.ts visit).
 */
const drivenProbed = {
	file: "packages/engine/src/physical/access/extract.ts",
	original:
		"\t\t\t\t\t\tsemiJoinDriven(n) === undefined\n\t\t\t\t\t\t\t? fixedOn(n.on.map((p) => p.right))\n\t\t\t\t\t\t\t: mapPushed(pushed, (c) => n.on.find((p) => p.left === c)?.right)\n",
	replacement: "\t\t\t\t\t\tfixedOn(n.on.map((p) => p.right))\n",
	why: "A driven semi-join's driver is read as if each left row probed it at the pairs: a round's attempts, which drive its responses at the call's round, ask a key lookup at their own number and no index at the round, and each read of them reads every learner's attempts."
} as const

/** The kill that states no equality a containment and a key make true (lower/optimize/eliminate R03.containedEquality). */
const noContainedEquality = {
	file: "packages/engine/src/lower/optimize/eliminate/index.ts",
	original: "\trules: [containedEquality, keyJoinFold, eliminateRule],\n",
	replacement: "\trules: [keyJoinFold, eliminateRule],\n",
	why: "No region states the equality a containment and a key make true: each of a sitting's attempts drives its responses at the attempt alone, and the access asks an index over the responses' attempt, a B-tree insert on every response for a read their key's prefix serves once the attempt's row binds the learner."
} as const

/** The kill that leaves a containment no dependency, a stored relation's or a view's. */
const noDependencies = {
	file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
	original: "\tconst determined = base.determined\n",
	replacement: "\tconst determined: typeof base.determined = []\n",
	why: "No dependency closes a seek's fields: the status read at a sitting's number is on no declared-key prefix, the claims drive nothing, and every learner's sittings are read."
} as const

/**
 * A signed-in learner's reads, its views stored at the learner's unit as metis's installation holds them, read its own
 * rows alone however many learners the store holds beside it, under counted statistics and misleading ones.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aSignedInLearnersReadsOverStoredViewsReadItsOwnRowsAlone = property.explore(readyGen, {
	needs: { stored: Substrate.rolledBack(storedTemplate) },
	situations,
	check:
		({ stored }, c) =>
		(drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* stored
				yield* runReady("stored", value.installed, connection, drawn, c)
			}),
	oracle,
	kept: [
		{
			token: ReplayToken(
				"test/pg/lower-shapes/ready-keys.test.ts#aSignedInLearnersReadsOverStoredViewsReadItsOwnRowsAlone:-:0.0.0.0.0.0"
			),
			reason:
				"metis's myAssignments at its stored status: the status read at a sitting's number alone, keyed by no dependency of the view, so the claims drove nothing and the list was a join over every learner's sittings",
			since: "2026-11-25"
		},
		{
			token: ReplayToken(
				"test/pg/lower-shapes/ready-keys.test.ts#aSignedInLearnersReadsOverStoredViewsReadItsOwnRowsAlone:-:1.0.0.0.0.0"
			),
			reason:
				"metis's ops guard (coachReading's sitting behind match(may, { program })): the programs each Clerk user may run derived whole, every account and its grants, and tested against the claims' Clerk user, 590 pages an ops call",
			since: "2026-11-25"
		},
		{
			token: ReplayToken(
				"test/pg/lower-shapes/ready-keys.test.ts#aSignedInLearnersReadsOverStoredViewsReadItsOwnRowsAlone:-:2.0.0.0.0.0"
			),
			reason:
				"metis's myAssignment, one sitting by its number under claims: 8.44M pages a call against a bound of 35",
			since: "2026-11-25"
		},
		{
			token: ReplayToken(
				"test/pg/lower-shapes/ready-keys.test.ts#aSignedInLearnersReadsOverStoredViewsReadItsOwnRowsAlone:-:3.0.0.0.0.0"
			),
			reason:
				"metis's myOpenSittingsOf, the learner's open sittings of a test under claims: 497k pages a call against a bound of 20, and a chain led by the test, every learner's assignments of it, where the claims' Clerk user's account leads, one row",
			since: "2026-11-25"
		},
		{
			token: ReplayToken(
				"test/pg/lower-shapes/ready-keys.test.ts#aSignedInLearnersReadsOverStoredViewsReadItsOwnRowsAlone:-:3.0.0.0.0.1"
			),
			reason:
				"metis's myOpenSittingsOf under misleading statistics: the access asked a take seek of every learner's assignments of the test in number order, which no chain of the read seeks by, and PostgreSQL read the claims' person's assignments of the test through it, every learner's, 108 rows beside 105 learners against a bound of 58",
			since: "2026-11-26"
		},
		{
			token: ReplayToken(
				"test/pg/lower-shapes/ready-keys.test.ts#aSignedInLearnersReadsOverStoredViewsReadItsOwnRowsAlone:-:4.0.0.0.0.0"
			),
			reason:
				"den's scope reads, a sitting's responses driven by its attempts at the call's sitting: the access probed the driver per left row at the attempt, asked no index at the sitting, and every learner's attempts were read",
			since: "2026-11-25"
		}
	],
	kills: []
})

/**
 * A signed-in learner's reads, its views live, read through their definitions, read its own rows alone however many
 * learners the store holds beside it: the status union read at each sitting's number as a row site of the chain, the
 * valid sittings an existence test read at each sitting's values.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aSignedInLearnersReadsOverLiveViewsReadItsOwnRowsAlone = property.explore(readyGen, {
	needs: { live: Substrate.rolledBack(liveTemplate) },
	situations,
	check:
		({ live }, c) =>
		(drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* live
				yield* runReady("live", value.installed, connection, drawn, c)
			}),
	oracle,
	kept: [
		{
			token: ReplayToken(
				"test/pg/lower-shapes/ready-keys.test.ts#aSignedInLearnersReadsOverLiveViewsReadItsOwnRowsAlone:-:0.0.0.0.0.0"
			),
			reason:
				"READYKEY's reproduction of metis's myAssignments: learner 1's 2 sittings beside 105 learners read 1,161 rows, bound 40, the claims an existence test over the whole list and the status union and the valid sittings each derived whole",
			since: "2026-11-25"
		},
		{
			token: ReplayToken(
				"test/pg/lower-shapes/ready-keys.test.ts#aSignedInLearnersReadsOverLiveViewsReadItsOwnRowsAlone:-:3.0.0.0.0.0"
			),
			reason:
				"metis's myOpenSittingsOf over live views: each sitting's status derived at the key set of every learner's assignments of the test the call names, 633 rows beside 105 learners against a bound of 58, where the claims' Clerk user, its person and the person's assignments of the test reach one",
			since: "2026-11-26"
		},
		{
			token: ReplayToken(
				"test/pg/lower-shapes/ready-keys.test.ts#aSignedInLearnersReadsOverLiveViewsReadItsOwnRowsAlone:-:4.0.0.0.0.0"
			),
			reason:
				"den's scope reads, a sitting's responses driven by its attempts at the call's sitting: the access probed the driver per left row at the attempt, asked no index at the sitting, and every learner's attempts were read",
			since: "2026-11-25"
		}
	],
	kills: [
		noDependencies,
		{
			file: "packages/engine/src/lower/shapes/share/sites.ts",
			original: '\t\t\ti > 0 &&\n\t\t\to.source.kind !== "Base" &&\n',
			replacement: '\t\t\ti < 0 &&\n\t\t\to.source.kind !== "Base" &&\n',
			why: "A chain reads no row site: each sitting's status, a union of five rules, is read from the statement's CTE of it, derived whole for every learner."
		},
		{
			file: "packages/engine/src/lower/shapes/share/keys.ts",
			original:
				"\t\t\t\t\tif (restrictedByValues(q.source) || (held && unitAtValues(region, q))) {\n",
			replacement: "\t\t\t\t\tif (restrictedByValues(q.source) || held) {\n",
			why: "A constant on a column no key leads with seeds a key set as the claims do: the open sittings' status is derived at every learner's assignments of the test, the key set of the test's assignments alone, where the claims' Clerk user's own reach one."
		}
	]
})

/** The workload's every read, beside a few learners and beside many. */
const workloadSituations = [
	"beside a few learners",
	"beside many learners"
] as const satisfies ReadonlyArray<Reached<WorkloadFeature>>

const workloadOracle = {
	kind: "universal",
	name: "every read of the workload within its bound, every chain step through an index, every index the workload's access builds read by some read's plan, and those over the stored relations exactly the specification's"
} as const

/**
 * The kills of the workload's indexes: a path asked that no chain seeks by, a chain step's path dropped, a take seek
 * asked of an occurrence its region's chain does not lead with, a driven semi-join's driver probed per left row, and no
 * containment's equality stated.
 */
const accessKills = [
	{
		file: "packages/engine/src/physical/access/extract.ts",
		original:
			"\t\tif (path !== undefined) {\n\t\t\tthis.lookups.push({ path, binds: [sorted(seeks)] })\n",
		replacement:
			'\t\tif (path !== undefined) {\n\t\t\tfor (const c of base.heading.slice(-1)) {\n\t\t\t\tthis.lookups.push({ path: { ...path, keys: [asc(c.name)], fixed: 1, use: "equality lookup", method: "btree" }, binds: [[c.name]] })\n\t\t\t}\n\t\t\tthis.lookups.push({ path, binds: [sorted(seeks)] })\n',
		why: "Each chain step also asks an index led by its relation's last column, which no read seeks by: the installation builds indexes no plan of the workload reads, each a write's upkeep for nothing."
	},
	{
		file: "packages/engine/src/physical/access/extract.ts",
		original: "\t\t\t\t: seeks.some((c) => !isFewValued(heading, c))\n",
		replacement: "\t\t\t\t: false && seeks.some((c) => !isFewValued(heading, c))\n",
		why: "A chain step whose seek holds no declared key asks no index: the status read at a sitting's number, and the events at it, are read through no index of theirs, their relation's every row."
	},
	{
		file: "packages/engine/src/physical/access/extract.ts",
		original: "\t\t\t\t\t\t\t\t\t\t: lead.occurrence === n.occurrences[at],\n",
		replacement:
			"\t\t\t\t\t\t\t\t\t\t: region.occurrences.every((o) => o === facts || !restricted(o)),\n",
		why: "A take seek is asked of an occurrence its region's chain does not lead with: the open sittings' take asks every learner's assignments of the test in number order, an index no plan of the chain reads, built for nothing."
	},
	drivenProbed,
	noContainedEquality
] as const

/** The workload property of one storage's ledger, exported as `name`. */
const workloadOver = (
	name: string,
	storage: Storage,
	template: typeof storedTemplate,
	lawsOnly: typeof storedLawsTemplate
) =>
	property.explore(workloadGen, {
		needs: {
			ledger: Substrate.rolledBack(template),
			laws: Substrate.rolledBack(lawsOnly)
		},
		situations: workloadSituations,
		check:
			({ ledger, laws }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* ledger
					const lawsOwn = yield* laws
					yield* runWorkload(
						storage,
						value.installed,
						connection,
						{ installed: lawsOwn.value, connection: lawsOwn.connection },
						drawn,
						c
					)
				}),
		oracle: workloadOracle,
		kept: [
			{
				token: ReplayToken(`test/pg/lower-shapes/ready-keys.test.ts#${name}:-:0.0.0.0`),
				reason:
					"den's scope reads (UNITKEY's class b2), a step at its scope joined to a value family on the step alone: a sitting's responses read at their attempt alone asked an index over it, a B-tree insert on every response, where the attempt's row holds the learner and the responses' key prefix serves the read",
				since: "2026-11-25"
			}
		],
		kills: accessKills
	})

/**
 * The indexes the workload over stored views builds are the paths its reads' chains seek by: every one read, and every
 * chain step through one.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const theWorkloadsIndexesOverStoredViewsAreThePathsItsChainsSeekBy = workloadOver(
	"theWorkloadsIndexesOverStoredViewsAreThePathsItsChainsSeekBy",
	"stored",
	storedTemplate,
	storedLawsTemplate
)

/**
 * The indexes the workload over live views builds are the paths its reads' chains seek by: every one read, and every
 * chain step through one.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const theWorkloadsIndexesOverLiveViewsAreThePathsItsChainsSeekBy = workloadOver(
	"theWorkloadsIndexesOverLiveViewsAreThePathsItsChainsSeekBy",
	"live",
	liveTemplate,
	liveLawsTemplate
)
