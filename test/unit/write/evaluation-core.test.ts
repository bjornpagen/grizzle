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
 * And a join the statement's own values restrict is computed once as a fold is (lower/shapes/share/statements.ts
 * sharedOnce, lower/optimize/cte-policy restrictedByValues, rule 5d), where a join no value of the statement restricts
 * stays inline at each read (rules 4 and 6): computed once it would be derived whole, every session's items, where each
 * inline read is restricted where it stands. And a closed relation the arguments and a member read is printed once,
 * one part of the statement every read reads (lower/shapes/share/statements.ts planStatementShares, ShareIndex cteKey),
 * and a projection of it an argument reads through that part is a scan of the part, never a CTE of its own
 * (statementCtes).
 *
 * The box, exhausted: a call of four rows arguments, one, two or all four reading a core, a fold over an anti-join or
 * the anti-join alone at the call's sessions (each argument's import of it bound to its own relation parameter, so each
 * reads a copy of its own), the anti-join over every session, which no value of the call restricts, or a closed
 * relation, each argument's match a copy of it; the call read by one member, or by one of two members of one statement,
 * or by both, and the core by a member or none.
 *
 * And an evaluation the statement holds is one statement of its share planning (lower/shapes/share/statements.ts
 * planStatementShares, HeldEvaluation): its call's arguments are read by it alone, so none is carried as a part of its
 * own, where every member that reads a field of the call counted as reading them and each argument was a MATERIALIZED
 * CTE of the statement, each CTE a cost PostgreSQL's planner pays per entry.
 *
 * Oracle: specification, a core at the call's sessions computed once, the statement scanning Done, the core's
 * anti-join's right side, once; the core over every session scanned at each argument that reads it; the closed
 * relation's VALUES printed once; and the statement's MATERIALIZED CTEs at two or four arguments as many as at one, but
 * the core's own where the statement first shares it.
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
	materializedCtes,
	type Members,
	statementsOf,
	valuesLists
} from "#test/unit/write/evaluation-core.fixtures.ts"

/**
 * A sub-query the arguments of a call's evaluation read is computed once in its statement, however many read it, where
 * the statement's values restrict it, and read where it stands where none does.
 */
export const aSubQueryTheArgumentsOfACallsEvaluationReadIsComputedOnceInItsStatementHoweverManyReadIt =
	property.exhaust(finite(boxGen), {
		needs: {},
		situations: [
			"one reads the call",
			"two, one reads the call",
			"two, both read the call",
			"two, one reads the call, one the core",
			"two, both read the call, one the core too"
		],
		check: (_, k: Case<Members>) => (box) =>
			Effect.sync(() => {
				k.note(box.members)
				const statements = statementsOf(box)
				const expected =
					box.core === "a closed relation"
						? 0
						: box.core !== "a join of every session"
							? 1
							: box.reading +
								(box.members === "two, one reads the call, one the core" ||
								box.members === "two, both read the call, one the core too"
									? 1
									: 0)
				assert.equal(
					Arr.reduce(statements, 0, (n, sql) => n + doneScans(sql)),
					expected,
					`${box.reading} of four arguments reading ${box.core}, ${box.members}: Done scanned ${expected} times\n${Arr.join(statements, "\n")}`
				)
				assert.equal(
					Arr.reduce(statements, 0, (n, sql) => n + valuesLists(sql)),
					box.core === "a closed relation" ? 1 : 0,
					`${box.reading} of four arguments reading ${box.core}, ${box.members}: the closed relation's VALUES lists\n${Arr.join(statements, "\n")}`
				)
				const ctes = (b: typeof box) =>
					Arr.reduce(statementsOf(b), 0, (n, sql) => n + materializedCtes(sql))
				/** A core at the call's sessions no member reads itself is one CTE more once two arguments read it. */
				const grown =
					box.core !== "a join of every session" &&
					box.reading > 1 &&
					box.members !== "two, one reads the call, one the core" &&
					box.members !== "two, both read the call, one the core too"
						? 1
						: 0
				assert.equal(
					ctes(box) - ctes({ ...box, reading: 1 }),
					grown,
					`${box.reading} arguments reading ${box.core}, ${box.members}: no argument a part of its own, nor a read of a carried core a CTE of its own (${ctes(box)} against ${ctes({ ...box, reading: 1 })} at one argument)`
				)
			}),
		oracle: {
			kind: "specification",
			name: "a core at the call's sessions computed once, its anti-join's right side scanned once; one over every session at each read"
		},
		box: "one, two or four of a call's four arguments reading a fold or a join at the call's sessions, or a join of every session, the call read by one member, by one of two or by both",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original:
					"\t\treturn this.#statement(read, cx, undefined, wholeKeys, (root) =>\n\t\t\tevaluationQuery(read, root, emptyEnv)\n\t\t)\n",
				replacement: "\t\treturn evaluationQuery(read, cx, emptyEnv)\n",
				why: "Each argument of the evaluation is a statement of its own, as before: the arguments reading the core each compute their copy, and where only one member reads the call, Done is scanned once per argument."
			},
			{
				file: "packages/engine/src/write/program/compile.ts",
				original:
					"\t].toSorted((a, b) => a.height - b.height || Number(b.first) - Number(a.first))\n",
				replacement:
					'\t].toSorted((a, b) => (a.kind === "evaluation" ? 0 : 1) - (b.kind === "evaluation" ? 0 : 1))\n',
				why: "The evaluations are built before every carried sub-query, as before: where one member reads the call and the other the core, the core is a carried part the evaluation never reads, so it computes the core again."
			},
			{
				file: "packages/engine/src/write/program/compile.ts",
				original:
					"\t\t\t\t\tsingle ? (node) => heldEvaluationKey(lowering.w.cx, node) : noneHeld,\n",
				replacement: "\t\t\t\t\tnoneHeld,\n",
				why: "Every member that reads a field of the call counts as reading its arguments, as before: where both members read the call, each argument is carried as a part of its own, four arguments four more MATERIALIZED CTEs than one."
			},
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original:
					"\t\t\t\t(costly.get(node) === true || (index.readWhole(node) && !closedDerivation(node)))\n",
				replacement: "\t\t\t\ttrue\n",
				why: "A sub-query whose only stage that is no scan is a carried part is shared as well: where both members read the call and one the core, the arguments' read of the carried core is a CTE of its own beside the core's part."
			},
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original:
					"\t\t\t\t(costly.get(node) === true || (index.readWhole(node) && !closedDerivation(node)))\n",
				replacement: "\t\t\t\t(costly.get(node) === true || index.readWhole(node))\n",
				why: "A closed derivation is computed once wherever it is read twice, though the statement reads its closed relation in a carried part: where one member reads the ranks and the call's arguments read them too, the arguments' projection of the carried part is a MATERIALIZED CTE of its own."
			},
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original: "\t\t\treturn restrictedByValues(node)\n",
				replacement: "\t\t\treturn false\n",
				why: "A join is never computed once, as before rule 5d: the join at the call's sessions is restated in each argument that reads it, and Done is scanned once per argument."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original:
					'\t\t\t\t(isNonEmpty(held) && (o.source.kind === "Base" || restrictedByKeys(o.source, held))) ||\n',
				replacement: "\t\t\t\ttrue ||\n",
				why: "Every stored relation a region reads counts as restricted by the statement's values: the join over every session is computed once, derived whole, where each argument read it restricted."
			}
		]
	})
