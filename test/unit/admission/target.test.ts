import { describe, it } from "@effect/vitest"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { snapshotMismatch } from "#compiler/deploy/admission/target.ts"
import { assert, defined } from "#test/support/assert.ts"
import { firstCodes } from "#test/support/compile.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftChain, fromEmpty, noDeclarations, unowned } from "#test/support/migrate/kit.ts"
import { withB } from "#test/unit/deploy/schemas.ts"

describe("the registered snapshot", () => {
	it("is the application's only when installed under its PostgreSQL schema and of its fingerprint", () => {
		const appOne = identifierOf(identity.schema(parsedSchemaName("app_one")))
		const at = (schema: string) =>
			defined(
				draftChain(
					[
						{
							desc: withB,
							options: {
								schema: atName(schema),
								owner: unowned,
								extensions: [],
								codes: firstCodes
							},
							declared: noDeclarations
						}
					],
					fromEmpty
				)[0]
			).snapshot
		const own = at("app_one")
		const elsewhere = at("app_two")
		const fingerprint = own.theory.schema
		assert.equal(elsewhere.theory.schema, fingerprint)
		assert.equal(snapshotMismatch(own, { fingerprint, schema: appOne }), undefined)
		assert.notEqual(snapshotMismatch(elsewhere, { fingerprint, schema: appOne }), undefined)
		const other = defined(
			draftChain(
				[
					{
						desc: { ...withB, name: "Other" },
						options: {
							schema: atName("app_one"),
							owner: unowned,
							extensions: [],
							codes: firstCodes
						},
						declared: noDeclarations
					}
				],
				fromEmpty
			)[0]
		).snapshot
		assert.notEqual(snapshotMismatch(other, { fingerprint, schema: appOne }), undefined)
	})
})
