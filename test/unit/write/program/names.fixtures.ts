/** What the properties of names.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import { Array as Arr, Cause, Effect } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { parsedOf, uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"
import {
	shopChangeSet,
	shopCompile,
	shopCompiled,
	Stock,
	stockFromParam
} from "#test/support/unit/write/put/support.ts"

/** The members a compiled write collects from a ChangeSet value's inputs. */
const membersOf = (program: CompiledWrite, value: unknown) =>
	collectInputs(program.binding.groups, parsedOf(value).inputs)

/** A fact of the parameter's rows, keyed by `n`. */
const fact = (n: number) => ({ id: uuidOf(n), label: "a", qty: 1n })

/** The placeholder texts every statement of the optimized artifact binds. */
export const bound = Effect.fn("bound")(function* (name: string) {
	const value = shopChangeSet().put(Stock, stockFromParam(Stock, name))
	const program = shopCompiled(value, shopCompile)
	assert.ok(
		Arr.some(program.params, (p) => p.name === name),
		name
	)
	const members = yield* membersOf(program, value)
	const flight = flightOf(servableWrite(program), program.frontend.codes, noAdvice)
	const b = succeeded(
		bindWrite(flight, {
			members,
			params: { [name]: [fact(1), fact(2)] },
			transport: inForce(bindFrame)
		})
	)
	if (b.kind !== "bound") {
		return assert.fail(`${name}: ${b.kind}`)
	}
	return Arr.map(flight.statements, (statement) => succeeded(b.values(statement)))
})

/** What the search built once before its cases (items), now once per worker: every case on it reads them. */
export const itemsNeed = {
	key: "test/unit/write/program/names.fixtures.ts itemsNeed",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.gen(function* () {
		const items = yield* bound("items")
		return items
	}).pipe(
		Effect.mapBoth({
			onFailure: (error) =>
				NeedFailed.make({
					need: "test/unit/write/program/names.fixtures.ts itemsNeed",
					message: Cause.pretty(Cause.fail(error))
				}),
			onSuccess: (made) => Effect.succeed(made)
		})
	)
} as const satisfies Need<unknown>
