import { describe, it } from "@effect/vitest"
import { Array as Arr, Record as Rec } from "effect"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import type { BuiltQuery } from "#test/support/fixtures/ir/build.ts"
import * as P from "#test/support/fixtures/ir/payroll.ts"
import * as Q from "#test/support/fixtures/ir/queue.ts"
import * as W from "#test/support/fixtures/ir/work.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
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

/** The queries of every IR fixture, each by the name of the program it states. */
const queries: ReadonlyArray<{ readonly name: string; readonly make: () => BuiltQuery }> =
	Arr.flatMap(
		[W.workQueries, Q.queueQueries, P.payrollQueries],
		(record: Readonly<Record<string, () => BuiltQuery>>) =>
			Arr.map(Rec.toEntries(record), ([name, make]) => ({ name, make }))
	)

describe("fixture queries", () => {
	for (const { name, make } of queries) {
		it(`${name} builds, validates and lowers conservatively`, () => {
			const built = make()
			const lowered = lowerConservative(built, {
				names: productionNames("fixture", { kind: "declared" }, localVectorSchema),
				params: [],
				subject: { kind: "query" },
				meter: new BudgetMeter(compileBudgets)
			})
			assert.equal(lowered.ok ? undefined : lowered.error, undefined)
		})
	}

	it("delivers runStages as four heading groups, never a padded union", () => {
		const lowered = lowerConservative(P.payrollQueries.runStages(), {
			names: productionNames("fixture", { kind: "declared" }, localVectorSchema),
			params: [],
			subject: { kind: "query" },
			meter: new BudgetMeter(compileBudgets)
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
