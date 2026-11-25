/**
 * A bounded heterogeneous union on PostgreSQL 19: the optimized artifact against the conservative one, over generated
 * tasks.
 *
 * The schema is bench/query/union.bench.ts's fixed union, delivered per heading group: open tasks with their title and
 * done tasks with their memo, a task having at most one memo, discriminated by kind, so (id, kind) is a key of every
 * arm and the take over the union completes on it (a union over notes, of which a task may have several, is refused at
 * check time, test/unit/check/unions.test.ts). A case draws the tasks, each of a kind of the roster, a done task with
 * a memo or not, the order they are stored in (their id order, its reverse or any), and the take's bound: a statement
 * whose rows follow the storage rather than its ORDER BY then delivers other rows wherever the take cuts a heading group
 * stored out of its order. For each query, every relation the optimized artifact's statement delivers
 * holds the raw text set of the same relation of the conservative artifact's, with no repeated row, and both are the
 * bounded subset the model computes by definition, each closed id the code the installation stores for its handle:
 *
 * - the take delivered to the host: one part per heading group, each that group's first k in the common order
 *   (id, then kind in roster order), whose merge is the union's first k;
 * - the take consumed inside a statement, its ids: one relation, the UNION ALL of the common fields under ORDER BY and
 *   LIMIT;
 * - a match of the bounded union that binds kind to Done and so may bind the memo text: the done group's rows joined
 *   back to the bounded union on every common field.
 *
 * Oracle: a model of the bounded union computed by definition, and the conservative artifact beside the optimized one.
 *
 * Features: each delivery of the take, each kind of the roster with and without a memo, and a heading group the take
 * cuts stored out of its order, which the generator builds on a turn aimed at it (cutOutOfOrderGen).
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	agreed,
	aims,
	caseGen,
	compiled,
	cutOutOfOrder,
	type Feature,
	firstOf,
	idsOf,
	Kind,
	type KindHandle,
	kinds,
	memosOf,
	modelOf,
	sorted,
	unionsTemplate
} from "#test/pg/oracle/union-take.fixtures.ts"

import { assert } from "@bjornpagen/testing/assert"
import { replaceMigrated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A bounded heterogeneous union delivered per heading group agrees with the conservative lowering, delivered, consumed
 * and narrowed by kind.
 */
export const boundedUnion = property.explore(aimed(caseGen, aims), {
	needs: { unions: Substrate.fresh(unionsTemplate) },
	/**
	 * Its search budget: the fewest runs at which each kill it declares still fails a witness, the cull rule's measure
	 * (grizzle main, 2026-11-23).
	 *
	 * @limitKind measured
	 * @owner test/pg/oracle/union-take.test.ts boundedUnion
	 * @unit cases
	 * @scope one search of this property: `runs` cases of its rotating stream and a quarter of them, rounded up, of its
	 *   floor stream; `steered` the most its steered phase runs while a required situation is unreached
	 * @evidence `toolchain-test kills` and `toolchain-test run` of test/pg/oracle's test files at TEST_SEED=2219874524 (a
	 *   property's witnesses, its kept cases, floor and steered phase, are fixed by its identity, the same on every
	 *   seed), each killed kill's failing witness printed by an uncommitted line in vendor/toolchain's
	 *   mutate/commands.ts; the logs kills0.log (the pre-conversion budgets), run1.log, kills2.log, run3.log, kills4.log,
	 *   v1at5.log, fs5.log, fs9.log, fs13.log and run5.log in ~/.cache/grizzle/CULL-ORACLE-out on cassowary, uncommitted;
	 *   its revalidation once the kept case and the annotate.ts kill were added, utake-red.log (the property red at
	 *   58fc1a9a2), utake-run.log and utake-kills.log, `toolchain-test run` and `toolchain-test kills` of this module, in
	 *   ~/.cache/grizzle/PAGEORDER-notes, uncommitted
	 * @observed 2026-11-23 03:12 to 04:36 UTC; revalidated 2026-11-25 00:47 to 02:30 UTC
	 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load average 130 to 410 from other
	 *   lanes; vendor/toolchain 2cc48172; the budgets measured on grizzle f87b2aaab with 47748474c's change and verified
	 *   on dff9200ef (run5.log, every property green and every kill killed); lane CULL-ORACLE's in-memory family of two
	 *   PostgreSQL 19 members; revalidated on 46dd3d8a0 with lane PAGEORDER's two changes, vendor/toolchain 0f61f2e, load
	 *   average 380 to 640, lane PAGEORDER's family
	 * @workload its witnesses with its kill applied, on workers of its own, and its full run, at runs 24, 13, 9 and 1,
	 *   steered 16
	 * @result runs 24 (pre-conversion): the lower/shapes/index.ts kill fails floor case 3; runs 13: killed; runs 9:
	 *   steered case 2; runs 1: killed, its situations reached within one steering window of 16 cases, 18 cases in all
	 *   where f1bf91a2f's gate ran 30. Revalidated at runs 1, steered 16: green in 19 cases, the kept case among them, and
	 *   2 of 2 kills killed, the annotate.ts kill on the kept case
	 * @decision runs 1, the fewest that keeps a floor case and a fresh one each run. steered stays its pre-conversion 16,
	 *   one steering window, which a green run spends whole
	 * @revalidate a change of its generator, its check or a kill's file, a kill added, or a change of how the testing
	 *   library draws a floor or steered case; the kill gate (toolchain-test kills, affected) reports a kill that
	 *   survives
	 */
	budget: { runs: 1, steered: 16 },
	situations: [
		"a take below the union's size",
		"a take past the union's size",
		"a heading group the take cuts",
		"a cut group stored out of its order",
		"a done task without a memo"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check:
		({ unions }, c: Case<Feature>) =>
		(unionCase) =>
			Effect.gen(function* () {
				const { substrate, value: installed } = yield* unions
				return yield* Effect.provideService(
					Effect.gen(function* () {
						const names = namesOf(installed)
						const code = (kind: KindHandle): number => names.code(Kind, kind)

						const { facts, union } = modelOf(unionCase, code)
						yield* replaceMigrated(installed, facts)
						const k = unionCase.k
						const first = union.slice(0, k)
						c.note(
							k < union.length ? "a take below the union's size" : "a take past the union's size"
						)
						if (Arr.some(unionCase.tasks, (t) => t.kind === "Done" && !t.memo)) {
							c.note("a done task without a memo")
						}
						/** Delivered: each heading group's first k, whose merge is the union's first k. */
						const [open, done, ...rest] = yield* agreed(compiled(firstOf(k), installed.declared))
						assert.deepEqual(rest, [])
						const group = (kind: KindHandle) => Arr.filter(union, (u) => u.kind === kind)
						if (group("Open").length > k || group("Done").length > k) {
							c.note("a heading group the take cuts")
						}
						if (Arr.some(kinds, (kind) => cutOutOfOrder(unionCase, group(kind), k))) {
							c.note("a cut group stored out of its order")
						}
						assert.deepEqual(
							open,
							sorted(
								Arr.map(group("Open").slice(0, k), (u) => `(${u.id},${code(u.kind)},${u.own})`)
							)
						)
						assert.deepEqual(
							done,
							sorted(
								Arr.map(group("Done").slice(0, k), (u) => `(${u.id},${code(u.kind)},${u.own})`)
							)
						)
						/** Consumed: the ids of the first k. */
						const [ids] = yield* agreed(compiled(idsOf(k), installed.declared))
						assert.deepEqual(ids, sorted(Arr.map(first, (u) => `(${u.id})`)))
						/** Narrowed by kind: the done group's own field for exactly its rows among the first k. */
						const [texts] = yield* agreed(compiled(memosOf(k), installed.declared))
						assert.deepEqual(
							texts,
							sorted(
								Arr.map(
									Arr.filter(first, (u) => u.kind === "Done"),
									(u) => `(${u.id},${u.own})`
								)
							)
						)
					}).pipe(Effect.scoped),
					Substrate,
					substrate
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "the bounded union computed by definition, and the conservative artifact"
	},
	kept: [
		{
			token: ReplayToken("test/pg/oracle/union-take.test.ts#boundedUnion:-:0.0.0"),
			reason:
				"no task, a take of one: the match that narrows the bounded union to its done arm read the arm a closed import holds, which the importer's completion restated as a second node of its label (logical/annotate.ts withLogicalMeta), and the optimized lowering's copy plan read a column its first node lost",
			since: "2026-11-25"
		}
	],
	kills: [
		{
			file: "packages/engine/src/lower/shapes/index.ts",
			original: "\t\t\t\t\torderBy,\n",
			replacement: "",
			why: "A heading group's statement of a union take drops its ORDER BY (lower/shapes/index.ts groupSpec), so the group's LIMIT takes rows as stored."
		},
		{
			file: "packages/engine/src/logical/annotate.ts",
			original: "\tconst settled = new Set(postorder(imports, inputsOf))\n",
			replacement: "\tconst settled = kept\n",
			why: "A completion keeps a closed import's root alone and restates the nodes under it (logical/annotate.ts withLogicalMeta): the narrowing match reads the done arm the import holds, which it restates beside the one the take reads, two nodes of one label, and the optimized lowering's copy plan reads a column the take's arm no longer holds; the memo texts fail to compile."
		}
	]
})
