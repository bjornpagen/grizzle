import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { query, v } from "#compiler/public/query.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/groups.ts"
import { largestQuerySize, refusalCount } from "#test/types/query/budget/generate.ts"
import * as facade from "#test/types/query/fixtures/facade.ts"
import * as work from "#test/types/query/fixtures/work.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the 200-relation program", (it) => {
	it.effect("keeps every refusal of the 200-relation program, with the diagnostic it names", () =>
		Effect.gen(function* () {
			const { expected, actual } = yield* checked("query/budget")
			assert.equal(expected.length, refusalCount(largestQuerySize))
			assert.deepEqual(actual, expected)
		})
	)
})

layer(NodeServices.layer, { excludeTestServices: true })("typed query facade", (it) => {
	it.effect("typechecks every fixture under tsgo with Effect diagnostics", () =>
		Effect.gen(function* () {
			assert.equal((yield* checked("query/fixtures")).output, "")
		})
	)

	it.effect("fails each refusal with the diagnostic it names, and nothing else", () =>
		Effect.gen(function* () {
			const { expected, actual } = yield* checked("query/disarmed")
			assert.deepEqual(actual, expected)
		})
	)

	it("exposes at runtime every method the types promise", () => {
		const q = work.automaticTasksFor
		assert.deepEqual(
			Arr.filter(facade.queryMethods, (m) => typeof q[m] !== "function"),
			[]
		)
		const ordered = q.orderBy(["id", "asc"])
		assert.deepEqual(
			Arr.filter(facade.orderedMethods, (m) => typeof ordered[m] !== "function"),
			[]
		)
		const builder = query(work.Work)
		assert.deepEqual(
			Arr.filter(facade.builderMethods, (m) => typeof builder[m] !== "function"),
			[]
		)
		let ruleKeys: ReadonlyArray<string> = []
		let finishedKeys: ReadonlyArray<string> = []
		builder.rule((r) => {
			ruleKeys = Arr.filter(facade.ruleMethods, (m) => typeof r[m] !== "function")
			const { id } = v(work.Task, "task")
			const finished = r.match(work.Task, { id }).find({ id })
			finishedKeys = Arr.filter(facade.finishedMethods, (m) => typeof finished[m] !== "function")
			return finished
		})
		assert.deepEqual(ruleKeys, [])
		assert.deepEqual(finishedKeys, [])
	})
})
