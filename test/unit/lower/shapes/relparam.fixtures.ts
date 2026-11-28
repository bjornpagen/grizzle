/** What the properties of relparam.test.ts read: its spaces, models and helpers. */

import { int, weighted } from "@bjornpagen/testing/gen"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/support/unit/write/changeset/fixtures.ts"

export const Item = relation(
	"Item",
	{ id: pg.bigint, label: str.regex("^.*$", "su"), price: pg.numeric(10, 2), live: pg.boolean },
	["id"]
)

export const Shop = schema("Shop", [Item], [])

/** The i-th fact: a label holding a quote, a backslash and braces, which an array literal escapes. */
export const fact = (i: number) => ({
	id: BigInt(i),
	label: `item "${i}", {a\\b}`,
	price: Decimal.of(`${i % 1000}.25`),
	live: i % 2 === 0
})

/** A count of facts: a few, or a hundred thousand and more, where only a bound below the evidence would refuse it. */
export const factCount = weighted([
	[2, int(1, 1_000)],
	[1, int(100_000, 250_000)]
])

export type CountFeature = "a few facts" | "a hundred thousand facts or more"

const artifacts = succeeded(testArtifacts(Shop, testCompile))

export const program = (changes: unknown) =>
	succeeded(compileWrite(checking(Shop), descOf(changes), realityWrite(artifacts)))
