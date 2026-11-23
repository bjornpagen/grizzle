/**
 * An insert's computed fields (ChangeSet.insertAllComputed) are evaluated once per call: the record is checked as
 * the head of an insert member that matches nothing (write/frontend/compile.ts strataComputed), so den's lease, the
 * millis reading plus a Span, a contract its predicate bounds, casts into bigint with no guard (core/clock.ts
 * clockReadingRange), and the one statement that writes its rows evaluates it by one MATERIALIZED CTE of a row
 * (write/insert/stamp.ts callValuesCte), which every row carrying one of its fields joins: a plain insert's own
 * statement (stampedInput), and a nested insert's family statement, which writes the owner and every member
 * carrying a computed field of the owner's key, at any depth (write/family/additions.ts stampedSources).
 *
 * The box, exhausted: an owner of no family, of one sequence of members, or of members nesting members of their own,
 * each member carrying its owner's key (q, due); its insert computing its payload field `until`, or `due` with it.
 *
 * Property, per case: the write compiles, served clocked in millis; a nested one's owner is written by one family
 * statement with every member carrying a computed field; and each build of the statements that write the rows builds
 * the record's CTE once, a plain insert's each insert statement it builds and a nested one's each family program (a
 * work count, test/support/kernel/calls.ts callCounts). Oracle: README's Writes, the record evaluated once per call by
 * the one statement that writes every row carrying it. Kills: the members' additions a statement of their own, which
 * evaluates the record again; and a record's CTE built for each source of the statement's rows.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	type ComputingFeature,
	computingFeatures,
	computingGen,
	computingOf
} from "#test/unit/write/computed.fixtures.ts"

/** An insert's computed record is evaluated once, by one CTE of the statement that writes every row carrying it. */
export const anInsertsComputedRecordIsEvaluatedOnceByOneCteOfTheStatementWritingEveryRowCarryingIt =
	property.exhaust(finite(computingGen), {
		needs: {},
		situations: [
			"depth 0",
			"depth 1",
			"depth 2",
			"a payload field computed",
			"a key field computed, members carrying it"
		] satisfies ReadonlyArray<Reached<ComputingFeature>>,
		check: (_, k: Case<ComputingFeature>) => (c) =>
			Effect.gen(function* () {
				k.noteAll(computingFeatures(c))
				const computing = computingOf(c)
				const artifacts = succeeded(
					testArtifacts(computing.schema, testCompile),
					"the case's artifacts"
				)
				const [compiled, counts] = yield* callCounts(
					Effect.sync(() =>
						compileWrite(checking(computing.schema), descOf(computing.changeSet()), {
							...realityWrite(artifacts),
							clock: { now: "millis" }
						})
					),
					{
						records: { file: "packages/engine/src/write/insert/stamp.ts", name: "callValuesCte" },
						inserts: { file: "packages/engine/src/write/insert/protocol.ts", name: "buildInsert" },
						programs: {
							file: "packages/engine/src/write/program/compile.ts",
							name: "familyProgram"
						}
					}
				)
				const written = succeeded(compiled, "the computed insert compiles with no guard")
				if (c.depth > 0) {
					assert.deepEqual(
						Arr.findFirst(
							Arr.flatMap(written.artifact.steps, (step) =>
								step.kind === "familyWrite"
									? [
											Arr.dedupe(
												Arr.sort(
													Arr.flatMap(step.parts, (p) =>
														p.rows === "facts" ? [String(p.relation)] : []
													),
													Order.String
												)
											)
										]
									: []
							),
							(relations) => relations.includes("Owner")
						),
						Option.some(Arr.sort(computing.carrying, Order.String)),
						"one family statement inserts the owner and every member carrying a computed field"
					)
				}
				assert.equal(
					counts.records,
					c.depth === 0 ? counts.inserts : counts.programs,
					"each build of the statement that writes the rows builds the record's CTE once, which every row carrying it joins"
				)
			}),
		oracle: {
			kind: "specification",
			name: "README's Writes: an insert's computed record is evaluated once per call, by the one statement that writes every row carrying one of its fields"
		},
		box: "an owner of no family, of one sequence, or of members two deep, each member carrying its owner's key; its insert computing a payload field, or a key field beside it",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					"\t\t\t\tconst joined = sets.filter((x) => [...heads].some((h) => x.heads.has(h)))\n",
				replacement: "\t\t\t\tconst joined = sets.filter(() => false)\n",
				why: "The members' additions are statements of their own, after the owner's: each evaluates the record again, so a call computes a member's carried field apart from its owner's, and the program holds two writing statements and two of the record's CTEs."
			},
			{
				file: "packages/engine/src/write/family/additions.ts",
				original: '\t\t\tif (stamp.kind !== "call" || calls.has(stamp.computed)) {\n',
				replacement: '\t\t\tif (stamp.kind !== "call") {\n',
				why: "Each source of the statement's rows, the owner's slot and each member's nested rows, evaluates the record by a CTE of its own, so the owner's row and its members' are filled by separate evaluations, and each family program builds the record's CTE more than once."
			}
		]
	})
