import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { recordsetMaxRows } from "#compiler/core/policy.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	shopCompiled,
	shopChangeSet,
	Item,
	shopCompile,
	stockFromParam
} from "#test/unit/write/put/support.ts"

/** A parameter takes any name its declaration gives it: no name is a slot source the runtime reads otherwise. A
 * relation parameter named like a source the runtime might read ("relation", "cursor", "parentKeys") or like a
 * page's reserved placeholder identity binds exactly as one named "items" does: every statement's placeholder texts. */
const membersOf = (program: CompiledWrite, value: unknown) =>
	collectInputs(program.frontend, parsedOf(value).inputs, recordsetMaxRows)

const fact = (n: number) => ({ id: uuidOf(n), label: "a", qty: 1n })

/** The placeholder texts every statement of the optimized artifact binds. */
const bound = Effect.fn("bound")(function* (name: string) {
	const value = shopChangeSet().put(Item, stockFromParam(Item, name))
	const program = shopCompiled(value, shopCompile)
	assert.ok(
		Arr.some(program.params, (p) => p.name === name),
		name
	)
	const b = succeeded(
		bindWrite(program, {
			members: yield* membersOf(program, value),
			params: { [name]: [fact(1), fact(2)] }
		})
	)
	if (b.kind !== "bound") {
		return assert.fail(`${name}: ${b.kind}`)
	}
	const artifact = program.artifacts.optimized
	return Arr.map(artifact.statements, (statement) => succeeded(b.values(statement)))
})

describe("parameter names", () => {
	it.effect("bind a relation parameter named like a reserved source as one named items", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const items = yield* bound("items")
				return yield* exhaust(
					{
						suite: "unit/write/program-names",
						generator: element([
							"relation",
							"cursor",
							"parentKeys",
							"page:limit",
							"page:boundary:0"
						]),
						literal: Formatter.format,
						limit: 5,
						coverage: noCoverage,
						caseHang: Duration.minutes(2)
					},
					(name) =>
						Effect.map(bound(name), (got) => {
							assert.deepEqual(got, items, name)
						})
				)
			})
		)
	)
})
