import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { shareKey } from "#compiler/lower/shapes/share/index.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { Q, T, Task } from "#test/unit/lower/conservative/fixtures.ts"

/**
 * R25 sharing (shapes/share/index.ts): the share key is the sub-query's semantic digest.
 *
 * - A sub-query's key is equal for two copies built at any allocation exactly when they read the same parameter, over a
 *   planted pair of twin projections whose parameter and the ids burned between them are exhausted.
 */

type Param = "account" | "other"

/** The tasks of the account a parameter names, projected to their ids: a projection over one compared parameter. */
const tasksOf = (q: Q, param: Param) => {
	const m = q.region([
		{
			source: q.base(Task, conservativeMeta),
			bind: { id: "id", account: "account" },
			constants: { account: q.param(param, T.uuid, "compare") }
		}
	])
	return q.project(m, [["id", "id"]], conservativeMeta)
}

describe("the share key", () => {
	it.effect(
		"is equal for two copies at any allocation exactly when they read the same parameter",
		(ctx) => {
			const params = element<Param>(["account", "other"])
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/shapes/share/key",
						literal: Formatter.format,
						generator: (source) =>
							[source.draw(params), source.draw(params), source.draw(int(0, 3))] as const,
						limit: 16,
						coverage: requiredInSpace<"shared" | "apart">(["shared", "apart"]),
						caseHang: Duration.minutes(2)
					},
					([first, second, burned], c) =>
						Effect.sync(() => {
							const q = new Q()
							const a = tasksOf(q, first)
							for (let i = 0; i < burned; i++) {
								q.base(Task, conservativeMeta)
							}
							const b = tasksOf(q, second)
							const built = q.build(q.union([a, b], []))
							const same = succeeded(shareKey(built.dag, a)) === succeeded(shareKey(built.dag, b))
							assert.equal(same, first === second)
							c.note(same ? "shared" : "apart")
						})
				)
			)
		}
	)
})
