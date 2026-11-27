/**
 * A read-back of a write's own delta reads it in the state the whole write leaves, on PostgreSQL 19: where the state it
 * reads, a relation or a relation derived from the delta's own, is written at or after the statement that makes the
 * delta, the read-back runs after the last stratum over the delta carried there out of that statement, never the delta
 * searched for again in the state (write/schedule/plan.ts placeReadBacks). This is edullm's answerTestItem reduced: an
 * attempt recorded, its grade written by grading in a stratum after it, and the attempt read back with its grade and its
 * derived status.
 *
 * Schema: Attempt(child, n), keyed by both, under the unit of its child; Graded(child, n, score), the grade, contained in
 * Attempt at its key; and Status(child, n, status), derived from both, 0 for an attempt with no grade and 1 for one with
 * one. Stored: child 1's attempts 1, graded, and 2, and child 2's attempt 1, by the owner's direct writes, its session
 * standing up the judge's tables first: Status, unit-local at (child, n), is stored, so Attempt and Graded are tables
 * its upkeep reads, whose captures refuse a write of a session that stood none up (physical/ddl/rules.ts addCapture).
 *
 * The box, exhausted: where the call grades, in a stratum after the attempts' (edullm's), in their own stratum, where
 * the containment orders the grades after the attempts, or in a stratum before them; what it records, child 1's third
 * attempt, that and child 2's second, or that and child 1's second again, which it meets stored; what it grades, child
 * 2's stored first attempt, or that and every attempt it records afresh (not where it grades first); and its read-back
 * `written` of delta.added(Attempt), with its grade, its status, or both, edullm's. Each case installs the schema,
 * stores its facts, and applies its ChangeSet once through a full role's Db.
 *
 * Property, per case: the call commits; the read-back runs after the writes over its delta carried out of the
 * attempts' statement exactly where it reads state that statement or a later one writes (a statement of the flight
 * fills a carrier): a grade written at or after it, or a status, derived from Attempt itself; and it rides that
 * statement otherwise; and `written` is the model's (carried-reads.fixtures.ts modelOf): each
 * attempt the call recorded afresh, never one it met stored, with its grade and its status as the whole call leaves
 * them. Oracle: specification, the model of the state after the call. Kills: the read-back placed at the delta's own
 * statement whatever it reads, which reads the grades and statuses as they stood before; and the carrier no statement
 * fills, which reads the delta empty.
 *
 * Features: each grading, recording, grading set and read-back; carried and riding.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import {
	attemptLabel,
	installWrites,
	observedChange,
	openFull,
	owner
} from "#bench/write/support/writes.ts"
import { hasProperties } from "#compiler/core/record.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	Attempt,
	build,
	carried,
	carriedGen,
	changeOf,
	Graded,
	modelOf,
	type Situation,
	situations,
	storedAttempts,
	storedGrades
} from "#test/pg/write/carried-reads/carried-reads.fixtures.ts"
import { carrierFills } from "#test/support/carrier-reads.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A delivered row of `written` as the property compares it, its fields in heading order joined, or a failure naming
 * what it is. */
const rowText = (row: unknown): string => {
	if (!hasProperties(row)) {
		return assert.fail(`a row of written, not ${Formatter.format(row)}`)
	}
	const fields = Arr.filter(["child", "n", "score", "status"], (f) => f in row)
	return Arr.join(
		Arr.map(fields, (f) => {
			const value = row[f]
			return typeof value === "number"
				? String(value)
				: assert.fail(`a number at ${f}, not ${Formatter.format(value)}`)
		}),
		" | "
	)
}

/** A write's read-back of its own delta reads it as the whole write leaves the state, carried out of the statement making it past the writes after it. */
export const aWritesReadBackOfItsOwnDeltaReadsItAsTheWholeWriteLeavesTheStateCarriedPastTheWritesAfterIt =
	property.exhaust(finite(carriedGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, k: Case<Situation>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							k.note(c.grading)
							k.note(c.recorded)
							k.note(c.grades)
							k.note(c.read)
							const fx = yield* installWrites(build("CarriedReads").schema, "carriedreads", {
								programs: {},
								logins: () => []
							})
							const b = build(fx.installed.declared)
							const names = namesOf(fx.installed)
							const column = (relation: typeof Attempt | typeof Graded, field: string) =>
								quoteIdent(names.columnIdent(relation, field))
							yield* standUpJudge((yield* Substrate).admin, fx.installed.installation)
							yield* owner(
								`INSERT INTO ${names.table(Attempt)} (${column(Attempt, "child")}, ${column(Attempt, "n")}) VALUES ${Arr.join(
									Arr.map(storedAttempts, (a) => `(${a.child}, ${a.n})`),
									", "
								)}`,
								`INSERT INTO ${names.table(Graded)} (${column(Graded, "child")}, ${column(Graded, "n")}, ${column(Graded, "score")}) VALUES ${Arr.join(
									Arr.map(storedGrades, (g) => `(${g.child}, ${g.n}, ${g.score})`),
									", "
								)}`
							)
							const db = yield* openFull(fx, b.schema)
							const observed = yield* observedChange(db, changeOf(b, c), attemptLabel, {
								kind: "none"
							})
							const fills = Arr.some(observed.statements, (s) => carrierFills(s.ast).size > 0)
							assert.equal(
								fills,
								carried(c),
								"the read-back is carried exactly where it reads state the attempts' statement or a later one writes"
							)
							k.note(fills ? "carried to the end of the write" : "riding the attempts' statement")
							const applied = yield* observed.apply({})
							const outcome = applied.value
							const reads =
								outcome.kind === "accepted" || outcome.kind === "no-change"
									? outcome.reads
									: assert.fail(`the call commits, not ${outcome.kind}`)
							const written = reads["written"]
							assert.deepEqual<ReadonlyArray<string>>(
								Arr.sort(Arr.map(Arr.isArray(written) ? written : [], rowText), Order.String),
								modelOf(c),
								"written reads each attempt the call recorded afresh with its grade and status as the whole call leaves them"
							)
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the state after the whole call: each attempt recorded afresh with its grade and status then (carried-reads.fixtures.ts modelOf)"
		},
		box: "grading after, beside or before the attempts; one fresh attempt, two, or one and a stored one again; a stored attempt graded, or the recorded attempts too; the delta read with its grade, its status or both",
		show: Formatter.format,
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/carried-reads/carried-reads.test.ts#aWritesReadBackOfItsOwnDeltaReadsItAsTheWholeWriteLeavesTheStateCarriedPastTheWritesAfterIt:-:0.0.1.2"
				),
				reason:
					"edullm's answerTestItem (qti-database values.ts writtenAttemptOf): an attempt recorded, graded in the stratum after it, and read back from its own delta with its grade and its derived status, which ReadBackCrossesStatements refused as state after",
				since: "2026-11-24"
			}
		],
		kills: [
			{
				file: "packages/engine/src/write/schedule/plan.ts",
				original: "\t\t\tsettledAt(read, first.position)\n",
				replacement: "\t\t\ttrue\n",
				why: "A read-back placed at the delta's own statement whatever it reads: it reads the grades and statuses as they stood before the grading the call writes after it."
			},
			{
				file: "packages/engine/src/write/program/compile.ts",
				original:
					"\t\t\t\tquery: carriedStash(returned.has(cte.cte) ? cte : undefined, c.carrier, stashed),\n",
				replacement: "\t\t\t\tquery: carriedStash(undefined, c.carrier, stashed),\n",
				why: "A carried side's carrier its statement fills with no row: the read-back after the writes reads the delta empty."
			}
		]
	})
