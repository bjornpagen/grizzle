import type { Reached } from "@bjornpagen/testing/features"
/**
 * A rule's probe reads the rows its write's keys reach, whatever the population, on PostgreSQL 19, where a definition
 * its rules read more than once is a union over content alone. Limited, each seat's scopes beside its budget, reads the
 * union of every document's timed and paced scopes in each of its two rules, at the document its seat's test delivers,
 * a field a step of the probe's chain binds (probe-share.fixtures.ts), as metis's FirstBudget reads timeLimits and its
 * TimingScope: a probe of a written seat that computed the union whole read every document's scopes at every COMMIT
 * (metis's assign, ~1.3 assigns a second, its COMMIT 279 ms in two such judges).
 *
 * Each case writes one share of the population, explains the judge's every statement over it and runs the judge;
 * writes a seat at the case's document, explains the statements over it and runs the judge; grows the population to
 * the case's shares, explains the statements over the growth and runs the judge; writes a second seat at the same
 * document and explains the statements again, in one transaction rolled back after.
 *
 * Oracle: no statement reads a table larger than one probe whole (test/support/judge.ts wideScans), and each table's
 * rows read over the second seat equal those over the first, the rows each scan returned and its filter removed over all
 * of its loops, by the table it names, but a table PostgreSQL reads whole for what a probe of it costs (judge.ts
 * keyedWork), with no planner setting. And over the population written at once, the statements' work over the growth,
 * every row their scans and their CTEs' scans read over all of their loops (judge.ts keyedReadWork), is at most its
 * shares' count times their work over the first share: each written row's probe reads the rows its keys reach, whatever
 * else the transaction wrote, so a load's judge is linear in the load.
 *
 * Features: a union read by two rules; the population grown sixteen times.
 */
import { finite } from "@bjornpagen/testing/gen"
import { property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type ProbeShareFeature,
	probeShareFeatures,
	probeShareGen,
	probeShareTemplate,
	runProbeShare
} from "#test/pg/laws/probe-share.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A rule's probe reads the same rows of each table at one share of the population as at sixteen. */
export const aRulesProbeReadsTheSameRowsOfEachTableAtOneShareOfThePopulationAsAtSixteen =
	property.exhaust(finite(probeShareGen), {
		needs: { db: Substrate.rolledBack(probeShareTemplate) },
		situations: probeShareFeatures satisfies ReadonlyArray<Reached<ProbeShareFeature>>,
		check:
			({ db }, c) =>
			(drawn) =>
				Effect.flatMap(db, ({ connection, value }) => runProbeShare(value, connection, drawn, c)),
		oracle: {
			kind: "specification",
			name: "the rows each table's scans read over a seat written at sixteen shares of the population equal those over one written at one, and the judge's work over shares written at once is linear in them"
		},
		box: "Limited over a union of two content relations read by two rules at the document a seat's test delivers; 483 documents a share, grown to 2, 4, 8 and 16 shares, a seat written at documents 0, 1, 31 and 63",
		kept: [
			{
				token: ReplayToken(
					"test/pg/laws/probe-share.test.ts#aRulesProbeReadsTheSameRowsOfEachTableAtOneShareOfThePopulationAsAtSixteen:-:3.0"
				),
				reason:
					"the population grown sixteen times, a seat at document 0 (the merged tree 530a8dd9, RED3's run: hung on case 12, 60 s of CPU): the judge of the 7,245 documents written at once probed each Budget row's seat and its content per row, then joined the union of scopes computed once at the key set of every document the load's seats deliver, which PostgreSQL, a qual pushed down at each row's remaining budget, computed again for each row, 2,099,601 index searches of each of Timed and Paced at four shares and 40 s at eight; the union is a row site of a region evaluated per written row, read at each row's document (share/sites.ts sitesAtRows)",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/sites.ts",
				original: "\twalked || evaluatedPerRow(region)\n",
				replacement: "\twalked\n",
				why: "A region evaluated per written row that nothing walked into reads its row sites from the key set its statement computes them at, and the key analysis computes it at every written row's keys: each Budget row's probe joins the scopes of every document the load's seats deliver, the judge's work over a load the square of the load."
			}
		]
	})
