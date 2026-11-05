import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Order } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { canonicalText, type RegexNode } from "#compiler/scalar/regex/ir.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { assert } from "#test/support/assert.ts"
import { families, flagsGen, nestedPattern, patternOver } from "#test/unit/text/generators.ts"

/**
 * The IR's canonical text and order (scalar/regex/ir.ts canonicalText, compareCanonical). The canonical text is
 * JSON.stringify's text of the node, which a pattern's "ir:" key is and a snapshot's domain digest is taken over, so
 * it is written byte for byte as JSON.stringify writes it; the builder orders an alternation's arms by that text while
 * comparing it piece by piece, never writing it.
 */
type Alt = Extract<RegexNode, { readonly kind: "alt" }>

/** Every alternation in a node, the node's own included, found on a stack so that a node of any depth is walked. */
const alternations = (root: RegexNode): ReadonlyArray<Alt> => {
	const found: Array<Alt> = []
	const pending: Array<RegexNode> = [root]
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		switch (node.kind) {
			case "alt":
				found.push(node)
				appendAll(pending, node.arms)
				break
			case "seq":
				appendAll(pending, node.items)
				break
			case "repeat":
				pending.push(node.body)
				break
			case "empty":
			case "end":
			case "never":
			case "set":
			case "start":
				break
		}
	}
	return found
}

/** A pattern over any family's alphabet, or nested quantifiers. */
const anyPattern: Gen<string> = oneOf([
	(source) => source.draw(patternOver(source.draw(element(families)).alphabet)),
	nestedPattern
])

type Ordered = "an alternation" | "nested alternations"

describe("the canonical text and order", () => {
	it.effect(
		"writes each parsed pattern's IR as JSON.stringify does, and orders every alternation's arms strictly by that text",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/text/canonical",
						draw: drawn((source) => [source.draw(anyPattern), source.draw(flagsGen)] as const),
						literal: Formatter.format,
						coverage: required<Ordered>(["an alternation", "nested alternations"], {
							cases: 1000,
							sense: notesOnly
						}),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					([source, flags], c) =>
						Effect.sync(() => {
							const parsed = parsePattern(source, flags)
							if (!parsed.ok) {
								return
							}
							assert.equal(
								canonicalText(parsed.value),
								jsonText(parsed.value),
								`/${source}/${flags}`
							)
							const alts = alternations(parsed.value)
							if (alts.length > 0) {
								c.note("an alternation")
							}
							if (alts.length > 1) {
								c.note("nested alternations")
							}
							for (const alt of alts) {
								const texts = Arr.map(alt.arms, canonicalText)
								assert.deepEqual(
									texts,
									Arr.dedupe(Arr.sort(texts, Order.String)),
									`/${source}/${flags}`
								)
							}
						})
				)
			)
	)
})
