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
import { type Case, property } from "@bjornpagen/testing/property"
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
	needs: { unions: Substrate.freshOf(unionsTemplate) },
	/** Its pre-conversion budget: runs 24, coverage cases 16 (union-take.test.ts:319-322 at 41df7b58^). */
	budget: { runs: 24, steered: 16 },
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
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/shapes/index.ts",
			original: "\t\t\t\t\torderBy,\n",
			replacement: "",
			why: "A heading group's statement of a union take drops its ORDER BY (lower/shapes/index.ts groupSpec), so the group's LIMIT takes rows as stored."
		}
	]
})
