/** What the properties of direct-alternatives.test.ts read: the cases it plants for its direct suite. */
import { defined } from "@bjornpagen/testing/assert"
import { compositeAlternatives, variantsOf } from "#test/support/laws/boxes.ts"
import { plantedUpdate } from "#test/support/laws/direct.ts"
import type { Planted } from "#test/support/laws/suites/direct.ts"
import { plantedInsert } from "#test/support/laws/support.ts"

const host = compositeAlternatives.host(
	defined(variantsOf(compositeAlternatives, "mutable")[0], "the mutable composite-key schema")
)
const domains = compositeAlternatives.domains
const payment = plantedInsert(host, domains, "TenantPayment", { tenant: 1, run: 1, amount: 1 })

export const planted: Planted = {
	immutable: [],
	mutable: [
		{
			note: "a draft run moved into the paid handle, its payment inserted after it",
			sketch: {
				variant: 0,
				initial: [
					[
						plantedInsert(host, domains, "TenantRun", {
							tenant: 1,
							id: 1,
							stage: "draft",
							note: "a"
						})
					]
				],
				transactions: [
					{
						members: [payment],
						updates: [plantedUpdate(host, domains, "TenantRun", { stage: "paid" })]
					}
				]
			},
			reaches: ["statement selection of a referring fact", "committed"]
		},
		{
			note: "a paid run moved to the other tenant, its payment moved after it",
			sketch: {
				variant: 0,
				initial: [
					[
						plantedInsert(host, domains, "TenantRun", {
							tenant: 1,
							id: 1,
							stage: "paid",
							note: "a"
						}),
						payment
					]
				],
				transactions: [
					{
						members: [],
						updates: [
							plantedUpdate(host, domains, "TenantRun", { tenant: 2 }),
							plantedUpdate(host, domains, "TenantPayment", { tenant: 2 })
						]
					}
				]
			},
			reaches: [
				"statement rekey of a referred fact",
				"statement move of a referring fact",
				"committed"
			]
		}
	]
}
