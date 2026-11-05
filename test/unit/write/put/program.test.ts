import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { inForce } from "#compiler/write/family/order.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import type { CompiledWrite } from "#compiler/write/program/compile.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"
import { parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	shopCompiled,
	shopChangeSet,
	Item,
	Shop,
	shopCompile,
	stockFromParam
} from "#test/unit/write/put/support.ts"

/** The WriteProgram's refusals before any SQL: two enumerated facts at one key, and a described member's relation
 * parameter the caller leaves out. */
const fact = (n: number, label: string, qty: bigint) => ({ id: uuidOf(n), label, qty })

/** The program bound to the value's members, as the runtime collects them, and `params`. */
const bind = (program: CompiledWrite, value: unknown, params: Readonly<Record<string, unknown>>) =>
	Effect.map(collectInputs(program.frontend, parsedOf(value).inputs), (members) =>
		bindWrite(program, { members, params, transport: inForce(bindFrame) })
	)

describe("the write program's refusals before any SQL", () => {
	it.effect("refuses two enumerated facts at one key on the host, with the key law", () =>
		Effect.gen(function* () {
			const value = shopChangeSet().insert(Item, [fact(1, "a", 1n), fact(1, "b", 1n)])
			const program = shopCompiled(value, shopCompile)
			const bound = yield* bind(program, value, {})
			const r = succeeded(bound)
			assert.equal(r.kind, "invariant-rejected")
			assert.equal(r.kind === "invariant-rejected" && r.law, lawNamesOf(Shop).primaryKeyLaw(Item))
		})
	)

	it.effect(
		"binds a described member's relation parameter from the caller's values, and refuses it missing with an EncodingFailure",
		() =>
			Effect.gen(function* () {
				const value = shopChangeSet().put(Item, stockFromParam(Item, "items"))
				const program = shopCompiled(value, shopCompile)
				const bound = yield* bind(program, value, { items: [fact(3, "a", 1n)] })
				const r = succeeded(bound)
				assert.equal(r.kind, "bound")
				const missing = yield* bind(program, value, {})
				assert.equal(
					!missing.ok && typeof missing.error === "object" && missing.error._tag,
					"EncodingFailure"
				)
			})
	)
})
