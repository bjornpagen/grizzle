/** What the properties of ids.test.ts read: its spaces, models and helpers. */

import { array, codePoint, constant, type Gen, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, pipe, String as Str } from "effect"

/** A token of a component: a printable character the escape leaves alone, or one the escape is about. */
type Token =
	| Readonly<{ kind: "plain"; text: string }>
	| Readonly<{ kind: "dot" }>
	| Readonly<{ kind: "percent" }>
	| Readonly<{ kind: "escape spelling"; text: "%2E" | "%25" }>

/** How the two pairs of a case relate: drawn apart, one pair twice, or one text split at two dots. */
type Relation = "pairs drawn apart" | "one pair twice" | "the boundary moved"

export type Feature =
	| Relation
	| "a dot in a component"
	| "a percent sign in a component"
	| "an escape's spelling written literally"
	| "an empty component"

const plainCharacter: Gen<string> = weighted([
	[1, codePoint(0x20, 0x24)],
	[1, codePoint(0x26, 0x2d)],
	[1, codePoint(0x2f, 0x7e)]
])

const token: Gen<Token> = weighted<Token>([
	[4, (s) => ({ kind: "plain", text: s.draw(plainCharacter) })],
	[1, constant({ kind: "dot" })],
	[1, constant({ kind: "percent" })],
	[1, constant({ kind: "escape spelling", text: "%2E" })],
	[1, constant({ kind: "escape spelling", text: "%25" })]
])

const component: Gen<ReadonlyArray<Token>> = array(token, { min: 0, max: 5 })

export const textOf = (tokens: ReadonlyArray<Token>): string =>
	Arr.join(
		Arr.map(tokens, (t) => {
			switch (t.kind) {
				case "plain":
				case "escape spelling":
					return t.text
				case "dot":
					return "."
				case "percent":
					return "%"
			}
		}),
		""
	)

type Pair = readonly [relation: ReadonlyArray<Token>, field: ReadonlyArray<Token>]

type Sketch = Readonly<{ relation: Relation; first: Pair; second: Pair }>

const dot: ReadonlyArray<Token> = [{ kind: "dot" }]

export const sketch: Gen<Sketch> = weighted<Sketch>([
	[
		1,
		(s) => ({
			relation: "pairs drawn apart",
			first: [s.draw(component), s.draw(component)],
			second: [s.draw(component), s.draw(component)]
		})
	],
	[
		1,
		(s) => {
			const pair: Pair = [s.draw(component), s.draw(component)]
			return { relation: "one pair twice", first: pair, second: pair }
		}
	],
	[
		1,
		(s) => {
			const r = s.draw(component)
			const f = s.draw(component)
			return {
				relation: "the boundary moved",
				first: [[...r, ...dot], f],
				second: [r, [...dot, ...f]]
			}
		}
	]
])

/** A spelling's parts at each dot, each read back by the escape's decoding: "%2E" a dot, "%25" a percent sign. */
export const spelledParts = (spelling: string): ReadonlyArray<string> =>
	Arr.map(Str.split(spelling, "."), (part) =>
		pipe(part, Str.replaceAll("%2E", "."), Str.replaceAll("%25", "%"))
	)

export const noteTokens = (tokens: ReadonlyArray<Token>, c: Case<Feature>): void => {
	if (tokens.length === 0) {
		c.note("an empty component")
	}
	for (const t of tokens) {
		switch (t.kind) {
			case "plain":
				break
			case "dot":
				c.note("a dot in a component")
				break
			case "percent":
				c.note("a percent sign in a component")
				break
			case "escape spelling":
				c.note("an escape's spelling written literally")
				break
		}
	}
}
