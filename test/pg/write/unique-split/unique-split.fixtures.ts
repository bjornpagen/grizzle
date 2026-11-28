/** What the property of unique-split.test.ts reads: its schema, its box, and each case's run. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option } from "effect"
import { type PlanNode, planNodes } from "#bench/harness/explain.ts"
import {
	attemptLabel,
	explainedChange,
	installWrites,
	observedChange,
	openFull,
	type OpenedDb
} from "#bench/write/support/writes.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { key, mutable, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A test by its id, its name unique across the tests beside its key (key(on(Test, "name"))), and a note, metis's Test
 * in small: a put of it may move a name from one test to another, which an UPDATE checks at each row.
 */
const Test = relation("Test", { test: pg.bigint, name: pg.bigint, note: pg.bigint }, ["test"])

/** Test, mutable, in the unit of its id, its name a candidate key. */
const build = (name: string) =>
	schema(
		name,
		[Test],
		[unit("TestUnit", { test: pg.bigint }), mutable(Test), key(on(Test, "name"))]
	)

type Schema = ReturnType<typeof build>

/** A fact of Test as the ChangeSet states it. */
interface Fact {
	readonly test: bigint
	readonly name: bigint
	readonly note: bigint
}

/**
 * A case: the tests stored, `n`, test i named 100 + i with note 0; and how many of them the put moves a name of,
 * `moved`, pairwise: tests 1 and 2 swap their names, 3 and 4, and so on. The put states every stored test, each moved
 * one with the name of its pair and each other with note 1, so every row of it differs from the row at its key.
 */
export interface SplitCase {
	readonly n: 8 | 32
	readonly moved: 0 | 2 | 4
}

export const splitGen: Gen<SplitCase> = (s) => ({
	n: s.draw(element([8, 32] as const)),
	moved: s.draw(element([0, 2, 4] as const))
})

export type SplitFeature = "no name moved" | "names swapped"

/** The stored facts: test i named 100 + i, its note 0. */
const storedFacts = (n: number): ReadonlyArray<Fact> =>
	Arr.map(indices(n), (i): Fact => ({ test: BigInt(i + 1), name: BigInt(101 + i), note: 0n }))

/** The facts put: each moved test (the first `moved`) with its pair's name, each other with note 1. */
const putFacts = (c: SplitCase): ReadonlyArray<Fact> =>
	Arr.map(indices(c.n), (i): Fact => {
		if (i >= c.moved) {
			return { test: BigInt(i + 1), name: BigInt(101 + i), note: 1n }
		}
		const pair = i % 2 === 0 ? i + 1 : i - 1
		return { test: BigInt(i + 1), name: BigInt(101 + pair), note: 0n }
	})

/** A ChangeSet applied, accepted. */
const applied = (db: OpenedDb, changes: unknown, what: string) =>
	Effect.gen(function* () {
		const observed = yield* observedChange(db, changes, attemptLabel, { kind: "none" })
		const outcome = yield* observed.apply({})
		assert.equal(outcome.value.kind, "accepted", `${what} is accepted`)
	})

/** The rows the plans' ModifyTable nodes of `operation` wrote, over every loop. */
const written = (plans: ReadonlyArray<PlanNode>, operation: string): number =>
	Arr.reduce(plans, 0, (sum, plan) =>
		Arr.reduce(
			[...planNodes(plan)],
			sum,
			(s, node) =>
				s +
				(node.nodeType === "ModifyTable" && Option.contains(node.operation, operation)
					? node.actualRows * node.actualLoops
					: 0)
		)
	)

/**
 * One case on a fresh installation: the tests stored; the put's statements explained with ANALYZE in their places and
 * rolled back, counting the rows each deletes, inserts and updates: the moved rows deleted and inserted again, the pair
 * theirs alone, and every other row updated in place, never deleted or inserted. Then the put applied, the swap among
 * the moved rows lawful at every statement, and Test holding exactly the facts put.
 */
export const runSplit = (c: SplitCase, noteReached: (f: SplitFeature) => void) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fx = yield* installWrites(build("UniqueSplit"), "uniquesplit", {
				programs: {},
				logins: () => []
			})
			const S: Schema = build(fx.installed.declared)
			const db = yield* openFull(fx, S)
			yield* applied(db, ChangeSet.empty(S).insert(Test, storedFacts(c.n)), "the stored tests")
			const put = ChangeSet.empty(S).put(Test, putFacts(c))
			const explained = yield* explainedChange(db, put)
			const plans = Arr.map(explained, (p) => p.plan)
			const counts = {
				deleted: written(plans, "Delete"),
				inserted: written(plans, "Insert"),
				updated: written(plans, "Update")
			}
			assert.deepEqual(
				counts,
				{ deleted: c.moved, inserted: c.moved, updated: c.n - c.moved },
				`a put of ${c.n} tests moving ${c.moved} names deletes and inserts the moved rows alone and updates every other in place`
			)
			yield* applied(db, put, "the put")
			const substrate = yield* Substrate
			const rows = yield* substrate.admin.queryValues(
				`SELECT test::text AS t, name::text AS n, note::text AS o FROM ${fx.table("Test")} ORDER BY test`,
				[]
			)
			assert.deepEqual(
				rows,
				Arr.map(putFacts(c), (f) => [String(f.test), String(f.name), String(f.note)]),
				"Test holds exactly the facts put"
			)
			noteReached(c.moved === 0 ? "no name moved" : "names swapped")
		})
	)
