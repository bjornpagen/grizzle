/** What the properties of canonical.test.ts read: its spaces, models and helpers. */

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import type { RegexNode } from "@bjornpagen/grizzle-text/regex/ir"
import { element, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { Json } from "#compiler/core/canonical.ts"
import { families, nestedPattern, patternOver } from "#test/support/unit/text/generators.ts"

type Alt = Extract<RegexNode, { readonly kind: "alt" }>

/** A node's shape: every field of it and of its children but the profiles, which no key reads. */
export const shapeOf = (node: RegexNode): Json => {
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
export const alternations = (root: RegexNode): ReadonlyArray<Alt> => {
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
export const anyPattern: Gen<string> = oneOf([
	(source) => source.draw(patternOver(source.draw(element(families)).alphabet)),
	nestedPattern
])

export type Ordered = "an alternation" | "nested alternations"
