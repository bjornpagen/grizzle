import { describe, it } from "@effect/vitest"
import { explore, sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { inForce } from "#compiler/write/family/order.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { readArrayLiteral } from "#test/support/arrays.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A ChangeSet's enumerated members travel as arrays, one placeholder per column, whatever their count
 * (lower/shapes/relparam): an input drawn up to a quarter of a million facts binds every statement with no refusal,
 * each member array carrying every fact. No bound smaller than PostgreSQL's longest message and V8's longest string
 * (core/limits.ts) refuses an input, and those two are met by inputs far past what a unit test builds.
 */

const Item = relation(
	"Item",
	{ id: pg.bigint, label: str.regex("^.*$", "su"), price: pg.numeric(10, 2), live: pg.boolean },
	["id"]
)
const Shop = schema("Shop", { Item }, [])

/** The i-th fact: a label holding a quote, a backslash and braces, which an array literal escapes. */
const fact = (i: number) => ({
	id: BigInt(i),
	label: `item "${i}", {a\\b}`,
	price: Decimal.of(`${i % 1000}.25`),
	live: i % 2 === 0
})

/** A count of facts: a few, or a hundred thousand and more, where only a bound below the evidence would refuse it. */
const factCount = weighted([
	[2, int(1, 1_000)],
	[1, int(100_000, 250_000)]
])

type CountFeature = "a few facts" | "a hundred thousand facts or more"

describe("a write's enumerated members", () => {
	const artifacts = succeeded(testArtifacts(Shop, testCompile))
	const program = (changes: unknown) =>
		succeeded(compileWrite(checking(Shop), descOf(changes), realityWrite(artifacts)))

	it.effect(
		"lower to arrays, and an input of any count binds every statement with no refusal, each array carrying every fact",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/lower/relparam-members",
						draw: sketched(factCount, (count) => Arr.makeBy(count, fact)),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "an input is bounded by messageMaxBytes and maxStringLength alone, and its arrays carry every fact"
						},
						coverage: required<CountFeature>(["a few facts", "a hundred thousand facts or more"], {
							cases: 6,
							sense: notesOnly
						}),
						kept: [],
						runs: 2,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(rows, c) =>
						Effect.gen(function* () {
							c.note(rows.length >= 100_000 ? "a hundred thousand facts or more" : "a few facts")
							const changes = ChangeSet.empty(Shop).insert(Item, rows)
							const compiled = program(changes)
							const members = yield* collectInputs(compiled.frontend, parsedOf(changes).inputs)
							const bound = succeeded(
								bindWrite(compiled, { members, params: {}, transport: inForce(bindFrame) })
							)
							if (bound.kind !== "bound") {
								return assert.fail(`the input binds, not ${bound.kind}`)
							}
							const artifact = compiled.artifacts.optimized
							const skip = bound.skip(artifact)
							let arraysSent = 0
							for (const s of artifact.statements) {
								if (s.step.kind === "readBack" || skip.has(s.index)) {
									continue
								}
								const form = bound.form(s)
								const texts = succeeded(bound.values(s))
								assert.equal(texts.length, form.paramSlots.length)
								for (const [i, slot] of form.paramSlots.entries()) {
									if (slot.kind !== "member") {
										continue
									}
									arraysSent += 1
									const elements = readArrayLiteral(Option.getOrThrow(Arr.get(texts, i)))
									assert.equal(
										elements.length,
										rows.length,
										`placeholder ${i + 1} carries every fact`
									)
								}
							}
							assert.ok(arraysSent >= 4, `${arraysSent} member arrays sent, one per column`)
						})
				)
			)
	)
})
