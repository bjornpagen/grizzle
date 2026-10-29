import { describe, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import { identity, maxIdentifierBytes, parseDeclaredName } from "#compiler/core/identity.ts"
import { assert } from "#test/support/assert.ts"
import { admittedNames, refusedNames } from "#test/support/kernel/dict.ts"
import { parsedName } from "#test/support/kernel/naming.ts"

describe("the identifier dictionary", () => {
	it("names each admitted name by its conversion, whole at 63 bytes, and refuses each name past the limit", () => {
		const atLimit = Arr.filter(admittedNames, (name) => name.feature === "long, at the limit")
		assert.ok(atLimit.length >= 2, "names at the limit")
		for (const name of admittedNames) {
			const named = identity.table(parsedName(name.declared))
			assert.equal(named.form, "readable", name.declared)
			assert.equal<string>(named.identifier, name.converted, name.declared)
			assert.ok(Buffer.byteLength(named.identifier) <= maxIdentifierBytes, name.declared)
		}
		const identifiers = Arr.map(
			atLimit,
			(name) => identity.table(parsedName(name.declared)).identifier
		)
		assert.equal(new Set(identifiers).size, identifiers.length, "names at the limit stay apart")
		for (const identifier of identifiers) {
			assert.equal(Buffer.byteLength(identifier), maxIdentifierBytes, identifier)
		}
		const past = Arr.filter(refusedNames, (name) => name.feature === "long, past the limit")
		assert.ok(past.length > 0, "names past the limit")
		for (const name of past) {
			assert.ok(!parseDeclaredName(name.declared).ok, name.declared)
		}
	})
})
