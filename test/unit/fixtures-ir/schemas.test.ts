import { describe, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import * as P from "#test/support/fixtures/ir/payroll.ts"
import { installationOf } from "#test/support/kernel/naming.ts"
import { ownedInput } from "#test/support/policy.ts"

describe("payroll declarations the compiler refuses", () => {
	for (const r of P.refusals) {
		it(`${r.name}: ${r.reason} by ${r.refusedBy}`, () => {
			const owned = ownedInput(r.schema)
			if (r.refusedBy === "ownership") {
				refused(owned, r.reason)
			} else {
				succeeded(owned, "both declarations typecheck and own")
			}
		})
	}
})

describe("fixture queries", () => {
	it("delivers runStages as four heading groups, never a padded union", () => {
		const lowered = lowerConservative(P.payrollQueries.runStages(), {
			names: installationOf(P.PayrollDesc, { kind: "declared" }).names,
			params: [],
			subject: { kind: "query" }
		})
		assert.equal(lowered.ok, true)
		if (!lowered.ok) {
			return
		}
		assert.deepEqual(
			Arr.map(flight(lowered.value.roots), (s) => s.role.kind),
			["headingGroup", "headingGroup", "headingGroup", "headingGroup"]
		)
		assert.deepEqual(
			Arr.map(flight(lowered.value.roots), (s) => Arr.map(s.heading, (c) => c.name)),
			[
				["id", "stage"],
				["id", "stage", "approver", "at"],
				["id", "stage", "settled"],
				["id", "stage", "reason"]
			]
		)
		assert.deepEqual(
			lowered.value.delivery.kind === "headingGroups"
				? lowered.value.delivery.discriminant
				: undefined,
			["stage"]
		)
	})
})
