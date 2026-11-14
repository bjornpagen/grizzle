/**
 * The IR's canonical text and order (scalar/regex/ir.ts canonicalText, compareCanonical). The canonical text is
 * JSON.stringify's text of the node's shape, its profiles left out, which a pattern's "ir:" key is and a snapshot's
 * domain digest is taken over, so it is written byte for byte as JSON.stringify writes the shape; the builder orders an
 * alternation's arms by that text while comparing it piece by piece, never writing it.
 *
 * - Text: each parsed pattern's canonical text is JSON.stringify's text of its shape.
 * - Order: every alternation's arms are in strictly ascending order of their canonical texts, none repeated.
 *
 * Oracle: a second implementation, JSON.stringify of the shape, and its texts sorted and deduplicated.
 *
 * Features: an alternation, and nested alternations.
 *
 * Plants: text-canonical-order-reversed (the arms compared in descending order).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { canonicalText, type RegexNode } from "#compiler/scalar/regex/ir.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { families, flagsGen, nestedPattern, patternOver } from "#test/unit/text/generators.ts"

type Alt = Extract<RegexNode, { readonly kind: "alt" }>

/** A node's shape: every field of it and of its children but the profiles, which no key reads. */
const shapeOf = (node: RegexNode): Json => {
	switch (node.kind) {
		case "seq":
			return { kind: node.kind, items: Arr.map(node.items, shapeOf) }
		case "alt":
			return { kind: node.kind, arms: Arr.map(node.arms, shapeOf) }
		case "repeat":
			return { kind: node.kind, body: shapeOf(node.body), min: node.min, max: node.max }
		case "set":
			return { kind: node.kind, set: node.set }
		case "empty":
		case "end":
		case "never":
		case "start":
			return { kind: node.kind }
	}
}

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
		"writes each parsed pattern's IR as JSON.stringify writes its shape, and orders every alternation's arms strictly by that text",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "JSON.stringify of the node's shape, its arms' texts sorted"
						},
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
						caseHang
					},
					([source, flags], c) =>
						Effect.sync(() => {
							const parsed = parsePattern(source, flags)
							if (!parsed.ok) {
								return
							}
							assert.equal(
								canonicalText(parsed.value),
								jsonText(shapeOf(parsed.value)),
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
