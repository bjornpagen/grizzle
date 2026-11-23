/**
 * A write's single statement computes a sub-query the arguments of a call's evaluation read once, however many of its
 * arguments read it (write/program/compile.ts heldParts, lower/shapes/share/statements.ts StatementSharing
 * evaluation): the evaluation is one statement over every argument, so a copy two arguments read is one MATERIALIZED
 * CTE of its WITH, and the statement's parts are built lowest first, so an evaluation whose arguments hold a sub-query
 * the statement carries as a part of its own reads that part. Each argument was a statement of its own and the
 * evaluation was built before the carried parts, so each argument computed its own copy and the carried part computed
 * one more: edullm's ledger grade (qti-pie grade.ts gradeAttemptOf), 29 of whose 32 arguments each restated the graded
 * attempts, 348 of the statement's 542 anti-joins copies, its plan 32 s and 12 GB at f87b2aaab.
 *
 * The box, exhausted: a call of four rows arguments, one, two or all four reading a copy of one core (a fold over an
 * anti-join, each argument's import of it bound to its own relation parameter, so each reads a copy of its own), read by
 * one member, or by one of two members of one statement, or by both.
 *
 * Oracle: specification, the core computed once: the statement scans Done, the core's anti-join's right side, once.
 *
 * Features: one member; two members, one reading the call; two members, both reading it.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	boxGen,
	doneScans,
	type Members,
	statementsOf
} from "#test/unit/write/evaluation-core.fixtures.ts"

/** A sub-query the arguments of a call's evaluation read is computed once in its statement, however many read it. */
export const aSubQueryTheArgumentsOfACallsEvaluationReadIsComputedOnceInItsStatementHoweverManyReadIt =
	property.exhaust(finite(boxGen), {
		needs: {},
		situations: ["one reads the call", "two, one reads the call", "two, both read the call"],
		check: (_, k: Case<Members>) => (box) =>
			Effect.sync(() => {
				k.note(box.members)
				const statements = statementsOf(box)
				assert.equal(
					Arr.reduce(statements, 0, (n, sql) => n + doneScans(sql)),
					1,
					`${box.reading} of four arguments reading the core, ${box.members}: Done scanned once\n${Arr.join(statements, "\n")}`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the core the arguments read computed once: its anti-join's right side scanned once"
		},
		box: "one, two or four of a call's four arguments reading a copy of one core, the call read by one member, by one of two or by both",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original:
					"\t\treturn this.#statement(read, cx, undefined, (root) => evaluationQuery(read, root, emptyEnv))\n",
				replacement: "\t\treturn evaluationQuery(read, cx, emptyEnv)\n",
				why: "Each argument of the evaluation is a statement of its own, as before: the arguments reading the core each compute their copy, and where only one member reads the call, Done is scanned once per argument."
			},
			{
				file: "packages/engine/src/write/program/compile.ts",
				original: "\t].toSorted((a, b) => a.height - b.height)\n",
				replacement:
					'\t].toSorted((a, b) => (a.kind === "evaluation" ? 0 : 1) - (b.kind === "evaluation" ? 0 : 1))\n',
				why: "The evaluations are built before every carried sub-query, as before: where both members read the call, the core is a carried part the evaluation never reads, so it computes the core again."
			}
		]
	})
