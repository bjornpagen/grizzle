/** What the properties of evidence.test.ts read: its spaces, models and helpers. */

import { Array as Arr } from "effect"
import { checkedSchema } from "#compiler/analysis/schema.ts"
import { buildTheory, theoryEvidence } from "#compiler/analysis/theory/theory.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import { succeeded } from "#test/support/assert.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import { contained, f, key, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"

export const executions: Arr.NonEmptyReadonlyArray<TemplateContext> = ["snapshot", "transaction"]

const Person = relation(
	"Person",
	{ id: f.uuid, email: f.regex("^[a-z]{1,20}$", "u"), city: f.wildcard },
	["id"]
)

const Purchase = relation("Purchase", { id: f.uuid, person: f.uuid }, ["id"])

const Crm: SchemaDesc = {
	name: "Crm",
	relations: [Person, Purchase],
	statements: [
		key(on("Person", ["email"])),
		contained(on("Purchase", ["person"]), on("Person", ["id"]))
	],
	bases: []
}

export const crm = ownedFixture(Crm)

export const theory = succeeded(buildTheory(succeeded(checkedSchema(crm.owned))))

export const evidence = theoryEvidence(theory.laws, new Set())

export const personKeys = Object.freeze(Arr.filter(evidence.keys, (k) => k.relation === "Person"))

export type CatalogFeature = "no key proves the scan" | "a key proves the scan" | "a key not read"
