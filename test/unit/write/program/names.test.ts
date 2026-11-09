import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { inForce } from "#compiler/write/family/order.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { parameterNames } from "#test/support/kernel/dict.ts"
import { caseHang } from "#test/support/limits.ts"
import { parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	shopCompiled,
	shopChangeSet,
	Item,
	shopCompile,
	stockFromParam
} from "#test/unit/write/put/support.ts"

/** A parameter takes any name its declaration gives it: no name is a slot source the runtime reads otherwise. A
 * relation parameter under a name drawn from the parameter-name dictionary (kernel/dict.ts parameterNames: a page's own
 * input names, spellings like a source the runtime might read or a page's reserved placeholder identity, then the
 * identifier dictionary's names) binds exactly as one named "items" does: every statement's placeholder texts, the
 * oracle being the program's invariance under renaming its parameter. */
const membersOf = (program: CompiledWrite, value: unknown) =>
	collectInputs(program.frontend, parsedOf(value).inputs)

const fact = (n: number) => ({ id: uuidOf(n), label: "a", qty: 1n })

/** The placeholder texts every statement of the optimized artifact binds. */
const bound = Effect.fn("bound")(function* (name: string) {
	const value = shopChangeSet().put(Item, stockFromParam(Item, name))
	const program = shopCompiled(value, shopCompile)
	assert.ok(
		Arr.some(program.params, (p) => p.name === name),
		name
	)
	const members = yield* membersOf(program, value)
	const b = succeeded(
		bindWrite(program, {
			members,
			params: { [name]: [fact(1), fact(2)] },
			transport: inForce(bindFrame)
		})
	)
	if (b.kind !== "bound") {
		return assert.fail(`${name}: ${b.kind}`)
	}
	const artifact = program.artifact
	return Arr.map(artifact.statements, (statement) => succeeded(b.values(statement)))
})

describe("parameter names", () => {
	it.effect("bind a relation parameter under any dictionary name as one named items", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const items = yield* bound("items")
				return yield* explore(
					{
						suite: "unit/write/program-names",
						draw: drawn(element(nonEmpty(parameterNames, "the parameter names"))),
						literal: Formatter.format,
						coverage: noCoverage,
						oracle: {
							kind: "universal",
							name: "renaming a relation parameter changes no placeholder text a statement binds"
						},
						kept: [],
						runs: 192,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
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
