/** What the properties of install.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, shuffled, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { decodedQuery, f, relation, type SchemaDesc, unit } from "#test/support/fixtures/ir/desc.ts"

const Org = relation("Org", { id: f.uuid }, ["id"])

/** Org, in a unit of its id, so a stored relation over it sits in that unit too. */
const Base: SchemaDesc = {
	name: "Base",
	relations: [Org],
	statements: [unit("Organization", { id: f.uuid })],
	bases: []
}

/** A level over Base holding a stored derived relation over Org whose head binds Org's id under two names. */
export const pairs = (a: string, b: string): SchemaDesc => ({
	name: "Upper",
	bases: [Base],
	relations: [
		{
			kind: "derived",
			name: "Pairs",
			level: 1,
			storage: "stored",
			query: decodedQuery({
				kind: "rules",
				arms: [
					{
						vars: [{ id: "id", origin: { relation: "Org", field: "id" } }],
						matches: [
							{
								source: { kind: "relation", name: "Org" },
								bindings: { id: { kind: "var", var: "id" } }
							}
						],
						where: [],
						head: { [a]: { kind: "var", var: "id" }, [b]: { kind: "var", var: "id" } },
						interiors: [],
						attach: []
					}
				]
			})
		}
	],
	statements: []
})

/** Every word of `length` letters of a and b. */
const wordsOfLength = (length: number): ReadonlyArray<string> =>
	length === 0 ? [""] : Arr.flatMap(wordsOfLength(length - 1), (w) => [`${w}a`, `${w}b`])

/** Every word a name is spelled from: two or three letters of a and b. */
const words: Arr.NonEmptyReadonlyArray<string> = nonEmpty(
	[...wordsOfLength(2), ...wordsOfLength(3)],
	"the words"
)

type Words = Arr.NonEmptyReadonlyArray<string>

/** One or two words. */
const wordsGen: Gen<Words> = (source) => [
	source.draw(element(words)),
	...source.draw(array(element(words), { min: 0, max: 1 }))
]

/** A word other than `word`, one of the words: the next ones after it, wrapping around. */
const otherWord =
	(word: string): Gen<string> =>
	(source) =>
		defined(
			words[(words.indexOf(word) + 1 + source.draw(int(0, words.length - 2))) % words.length],
			"another word"
		)

type Spelling = "snake" | "camel" | "pascal"

const spellings: Arr.NonEmptyReadonlyArray<Spelling> = ["snake", "camel", "pascal"]

export const spell = (ws: Words, s: Spelling): string => {
	switch (s) {
		case "snake":
			return Arr.join(ws, "_")
		case "camel":
			return Arr.join(
				Arr.map(ws, (w, i) => (i === 0 ? w : Str.capitalize(w))),
				""
			)
		case "pascal":
			return Arr.join(Arr.map(ws, Str.capitalize), "")
	}
}

/** Two head names: the words each spells and how, and how the pair was constructed. */
interface NamePair {
	readonly kind: "collision" | "a changed word" | "an appended word"
	readonly left: Words
	readonly right: Words
	readonly spelled: readonly [Spelling, Spelling]
}

/** One sequence of words under two spellings that differ as text: a single word's snake and camel spellings agree. */
const collisionGen: Gen<NamePair> = (source) => {
	const ws = source.draw(wordsGen)
	const apart = Arr.dedupeWith(spellings, (s, t) => spell(ws, s) === spell(ws, t))
	const [s, t] = source.draw(shuffled(apart, { min: 2, max: 2 }))
	return {
		kind: "collision",
		left: ws,
		right: ws,
		spelled: [defined(s, "a spelling"), defined(t, "another spelling")]
	}
}

const spelledGen: Gen<readonly [Spelling, Spelling]> = (source) => [
	source.draw(element(spellings)),
	source.draw(element(spellings))
]

/** A sequence of words and the same with one of them changed to another word. */
const changedGen: Gen<NamePair> = (source) => {
	const ws = source.draw(wordsGen)
	const at = source.draw(int(0, ws.length - 1))
	const changed = Arr.map(ws, (w, i) => (i === at ? source.draw(otherWord(w)) : w))
	return { kind: "a changed word", left: ws, right: changed, spelled: source.draw(spelledGen) }
}

/** A sequence of words and the same with one more word after them. */
const appendedGen: Gen<NamePair> = (source) => {
	const ws = source.draw(wordsGen)
	const appended = Arr.append(ws, source.draw(element(words)))
	return { kind: "an appended word", left: ws, right: appended, spelled: source.draw(spelledGen) }
}

export const pairGen: Gen<NamePair> = weighted([
	[1, collisionGen],
	[1, changedGen],
	[1, appendedGen]
])

export type Feature =
	| "a collision of one word's spellings"
	| "a collision of several words' spellings"
	| "names apart by a changed word"
	| "names apart by an appended word"
	| "names apart in one spelling"
