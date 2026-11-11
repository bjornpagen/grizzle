/**
 * A FieldId (core/ids.ts FieldId) is the injective spelling of a (relation, field) pair: each component's '%' and '.'
 * percent-escaped, the components joined at the one unescaped dot.
 *
 * - Injective: two pairs spell one FieldId exactly when they are one pair.
 * - Decodes back: the spelling split at its dots, each part's escapes read back, is the pair it spells.
 *
 * Oracle: the specification of the escape, as a decoder: a spelling's parts at each dot, "%2E" read as a dot and "%25"
 * as a percent sign, so a correct spelling has exactly two parts and they are the pair.
 *
 * Inputs: a component is built of tokens, each a printable character, a dot, a percent sign, or one of the escape's own
 * spellings, "%2E" and "%25", written literally; the pairs compared are two drawn apart, one drawn twice, or the
 * boundary attack, (r + ".", f) against (r, "." + f), which a spelling that escaped nothing would join as one.
 *
 * Features: which pair relation a case draws, and which tokens its components hold.
 *
 * Plants (~/.cache/grizzle-release/BR06/plants): ids-unescaped-percent (the percent sign left unescaped, so a literal
 * "%2E" and a dot spell one component) and ids-escape-order (the dot escaped before the percent sign, so a dot reads
 * back as "%2E").
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, codePoint, constant, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, pipe, String as Str } from "effect"
import { FieldId } from "#compiler/core/ids.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** A token of a component: a printable character the escape leaves alone, or one the escape is about. */
type Token =
	| Readonly<{ kind: "plain"; text: string }>
	| Readonly<{ kind: "dot" }>
	| Readonly<{ kind: "percent" }>
	| Readonly<{ kind: "escape spelling"; text: "%2E" | "%25" }>

/** How the two pairs of a case relate: drawn apart, one pair twice, or one text split at two dots. */
type Relation = "pairs drawn apart" | "one pair twice" | "the boundary moved"

type Feature =
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

const textOf = (tokens: ReadonlyArray<Token>): string =>
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

const sketch: Gen<Sketch> = weighted<Sketch>([
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
const spelledParts = (spelling: string): ReadonlyArray<string> =>
	Arr.map(Str.split(spelling, "."), (part) =>
		pipe(part, Str.replaceAll("%2E", "."), Str.replaceAll("%25", "%"))
	)

const noteTokens = (tokens: ReadonlyArray<Token>, c: Case<Feature>): void => {
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

describe("FieldId", () => {
	it.effect("is injective in (relation, field) and decodes back", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "specification", name: "the escape's decoding at each unescaped dot" },
					suite: "unit/core/ids-1",
					draw: drawn(sketch),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"pairs drawn apart",
							"one pair twice",
							"the boundary moved",
							"a dot in a component",
							"a percent sign in a component",
							"an escape's spelling written literally",
							"an empty component"
						],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					runs: 1000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ relation, first, second }, c) =>
					Effect.sync(() => {
						const [r1, f1] = [textOf(first[0]), textOf(first[1])]
						const [r2, f2] = [textOf(second[0]), textOf(second[1])]
						const a = FieldId(r1, f1)
						const b = FieldId(r2, f2)
						assert.equal(a === b, r1 === r2 && f1 === f2, "one spelling exactly for one pair")
						assert.deepEqual(spelledParts(a), [r1, f1])
						assert.deepEqual(spelledParts(b), [r2, f2])
						c.note(relation)
						for (const tokens of [...first, ...second]) {
							noteTokens(tokens, c)
						}
					})
			)
		)
	)
})
