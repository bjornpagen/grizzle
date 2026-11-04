/**
 * A direct SQL writer over generated schemas: alternatives over a composite key.
 *
 * An UPDATE that moves a run into a handle, or moves an armed run or its arm, commits only when the rest of its
 * transaction leaves every arm with its run and every armed run with its arm, which a drawn set of fields rarely does
 * and the selected and carried modes of an UPDATE do (direct.ts). Both are planted for the mutable schema too: a draft
 * run moved into the paid handle with its payment inserted after it, and a paid run moved to the other tenant with its
 * payment moved after it.
 */

import { plantedUpdate } from "#test/pg/laws/families/direct.ts"
import { compositeAlternatives, variantsOf } from "#test/pg/laws/families/families.ts"
import { directSuite, type Planted } from "#test/pg/laws/families/suites/direct.ts"
import { casesPerTest } from "#test/pg/laws/families/suites/family.ts"
import { plantedInsert } from "#test/pg/laws/families/support.ts"
import { defined } from "#test/support/assert.ts"

const host = compositeAlternatives.host(
	defined(variantsOf(compositeAlternatives, "mutable")[0], "the mutable composite-key schema")
)
const domains = compositeAlternatives.domains
const payment = plantedInsert(host, domains, "TenantPayment", { tenant: 1, run: 1, amount: 1 })

const planted: Planted = {
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
			draws: "",
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
			draws: "",
			reaches: [
				"statement rekey of a referred fact",
				"statement move of a referring fact",
				"committed"
			]
		}
	]
}

directSuite(compositeAlternatives, casesPerTest, planted)
