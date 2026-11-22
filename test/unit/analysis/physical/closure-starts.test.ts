/**
 * A question of a dependency table starts its closures from the counts of each stage read once (analysis/physical/fds.ts
 * Questioning `#counts`): how many facts each implication and point rule waits on, -1 for one the stage admits not, read
 * off the table the first time one of the question's closures closes through that stage and copied by every closure of
 * the question after it, where each closure asked every dependency's justification whether its stage admits it. A key
 * reduction (keyAmong) runs a closure for each stage of each column it tries to drop (key-reduction.test.ts), so it
 * asked each dependency as often again; on the ledger's installation (edullm qti-pie's result composition, its judge
 * compiled without its login) those starts took 3.2 s of the first 1,080 s of the judge's compile at d422b835a, and the
 * closures they began 6.9 s more. The work is counted, never timed (test/support/kernel/calls.ts): the calls of a
 * stage's admission, `admitted`.
 *
 * Oracle: a bound, read off the table: every question asked of a table, each start's key and each start's
 * identification, asks each dependency at most once for each stage, however many closures the question runs.
 *
 * Features: a table of one stage and of two; a question running more closures than the table has stages.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { evidenceContexts } from "#compiler/ir/evidence.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { specGen, subsetsOf, tableOf } from "#test/unit/analysis/physical/dependencies.fixtures.ts"

type Situation =
	| "a table of one stage"
	| "a table of two stages"
	| "a question running more closures than the table has stages"

/** Every question asked of a table asks each of its dependencies at most once for each stage it closes through. */
export const everyQuestionOfATableAsksEachDependencyAtMostOnceAStage = property.explore(specGen, {
	needs: {},
	situations: [
		"a table of one stage",
		"a table of two stages",
		"a question running more closures than the table has stages"
	] satisfies ReadonlyArray<Reached<Situation>>,
	check: (_, c: Case<Situation>) => (s) =>
		Effect.gen(function* () {
			const table = tableOf(s)
			const used = new Set([
				...Arr.map(table.implications, (i) => i.just.context),
				...Arr.map(table.points, (p) => p.just.context)
			])
			const stages = Arr.filter(evidenceContexts, (x) => used.has(x)).length
			const dependencies = table.implications.length + table.points.length
			for (const start of subsetsOf(s.heading)) {
				const questions: ReadonlyArray<() => unknown> = [
					() => table.keyAmong(start),
					() => table.identification(start)
				]
				for (const question of questions) {
					const closures = table.closures
					const [, counts] = yield* callCounts(Effect.sync(question), {
						asked: { file: "packages/engine/src/analysis/physical/fds.ts", name: "admitted" }
					})
					assert.ok(
						counts.asked <= stages * dependencies,
						`a question of a table of ${stages} stages and ${dependencies} dependencies asks ${counts.asked} times, at most ${stages * dependencies}`
					)
					if (dependencies > 0 && table.closures - closures > stages) {
						c.note("a question running more closures than the table has stages")
					}
				}
			}
			if (stages === 1) {
				c.note("a table of one stage")
			}
			if (stages === 2) {
				c.note("a table of two stages")
			}
		}),
	oracle: {
		kind: "universal",
		name: "a bound: the admissions each question of a table asks are at most its stages times its dependencies"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/analysis/physical/fds.ts",
			original: "\t\treturn this.#starts.getOrInsertComputed(admission, () => {\n",
			replacement: "\t\treturn ((count: () => Counts) => count())(() => {\n",
			why: "Each closure asks every dependency whether its stage admits it, as the closures did at d422b835a: a key reduction's closures ask each dependency once each, past the bound, and the property fails."
		}
	]
})
