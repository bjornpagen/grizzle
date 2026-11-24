import type { Reached } from "@bjornpagen/testing/features"
/**
 * A rule's probe reads the rows its write's keys reach, whatever the population, on PostgreSQL 19, where a definition
 * its rules read more than once is a union over content alone. Limited, each seat's scopes beside its budget, reads the
 * union of every document's timed and paced scopes in each of its two rules, at the document its seat's test delivers,
 * a field a step of the probe's chain binds (probe-share.fixtures.ts), as metis's FirstBudget reads timeLimits and its
 * TimingScope: a probe of a written seat that computed the union whole read every document's scopes at every COMMIT
 * (metis's assign, ~1.3 assigns a second, its COMMIT 279 ms in two such judges).
 *
 * Each case writes one share of the population, a seat at the case's document, explains the judge's every statement
 * over it, runs the judge, grows the population to the case's shares, writes a second seat at the same document and
 * explains the statements again, in one transaction rolled back after.
 *
 * Oracle: each table's rows read over the second seat equal those over the first, the rows each scan returned and its
 * filter removed over all of its loops, by the table it names (bench/harness/explain.ts scannedRows).
 *
 * Features: a union read by two rules; the population grown sixteen times.
 */
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
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
			name: "the rows each table's scans read over a seat written at sixteen shares of the population equal those over one written at one"
		},
		box: "Limited over a union of two content relations read by two rules at the document a seat's test delivers; 64 documents a share, grown to 2, 4, 8 and 16 shares, a seat written at documents 0, 1, 31 and 63",
		kept: [],
		kills: []
	})
