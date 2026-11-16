/** What the properties of names.test.ts read: its spaces, models and helpers. */

import { Array as Arr, Effect } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { runnableWrite } from "#compiler/write/program/bind.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	Item,
	shopChangeSet,
	shopCompile,
	shopCompiled,
	stockFromParam
} from "#test/unit/write/put/support.ts"

/** The members a compiled write collects from a ChangeSet value's inputs. */
const membersOf = (program: CompiledWrite, value: unknown) =>
	collectInputs(program.binding.groups, parsedOf(value).inputs)

/** A fact of the parameter's rows, keyed by `n`. */
const fact = (n: number) => ({ id: uuidOf(n), label: "a", qty: 1n })

/** The placeholder texts every statement of the optimized artifact binds. */
export const bound = Effect.fn("bound")(function* (name: string) {
	const value = shopChangeSet().put(Item, stockFromParam(Item, name))
	const program = shopCompiled(value, shopCompile)
	assert.ok(
		Arr.some(program.params, (p) => p.name === name),
		name
	)
	const members = yield* membersOf(program, value)
	const write = runnableWrite(program, program.frontend.codes)
	const flight = write.flight
	const b = succeeded(
		bindWrite(write, {
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
