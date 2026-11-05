import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { queryValueDesc, queryOver as runtimeQuery } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import { assert } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { caseHang } from "#test/support/limits.ts"

/** What a definition reads and what inputs it needs (`queryUses`): a bound import's parameters are the
 * binding's, so a definition that binds every parameter of what it imports is parameterless, while one that leaves a
 * parameter open, or binds it to a parameter of its own, needs that parameter; the relations are the import's own.
 * Each binding is planted (the derived oracle's generated definitions import nothing), over every way an import is
 * bound. */
const descOf = (q: unknown) => {
	const d = queryValueDesc(q)
	if (d === undefined) {
		throw new Error("a query value the builder made")
	}
	return d
}

/** An import bound to a variable, to a parameter of the importer, or, as only a JavaScript caller can describe it,
 * unbound. */
type Binding = "a variable" | "an importer's parameter" | "nothing"

/** The builder runtime, which takes a JavaScript caller's arguments as they come. */
const importing = (binding: Binding): unknown => {
	switch (binding) {
		case "a variable":
			return W.largestPerAccount
		case "an importer's parameter":
			return query(W.Work).rule((r) => {
				const top = W.largestBudgets.bind({ account: r.param("who", uuid) })
				const { id } = v(top, "top")
				return r.match(top, { id }).find({ id })
			})
		case "nothing":
			return runtimeQuery(W.Work).rule((r: RuleValue) => {
				const { id } = v(W.automaticTasksFor, "automaticTasksFor")
				return r.match(W.automaticTasksFor, { id }).find({ id })
			})
	}
}

describe("queryUses over imports", () => {
	it.effect(
		"needs exactly the parameters an import's binding leaves open, and reads the import's relations",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/derived/import-uses",
						generator: element<Binding>(["a variable", "an importer's parameter", "nothing"]),
						literal: Formatter.format,
						limit: 3,
						coverage: requiredInSpace<Binding>([
							"a variable",
							"an importer's parameter",
							"nothing"
						]),
						caseHang
					},
					(binding, c) =>
						Effect.sync(() => {
							c.note(binding)
							const uses = queryUses(descOf(importing(binding)))
							const expected: Readonly<Record<Binding, ReadonlyArray<string>>> = {
								"a variable": [],
								"an importer's parameter": ["parameter who"],
								nothing: ["parameter account"]
							}
							assert.deepEqual<ReadonlyArray<string>>([...uses.inputs], expected[binding])
							if (binding === "a variable") {
								assert.deepEqual(Arr.sort([...uses.relations], Order.String), [
									"Account",
									"AutomaticTask",
									"Task"
								])
							}
						})
				)
			)
	)
})
