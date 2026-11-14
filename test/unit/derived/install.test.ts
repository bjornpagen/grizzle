/**
 * A derived relation's head names are its view's declared column names: two whose conversions agree
 * (core/identity.ts conversionOf, a name's segments lowercased and joined by single underscores) are one column
 * identifier, refused as IdentifierCollision naming that identifier, and two whose conversions differ install as two
 * columns.
 *
 * Property: over drawn pairs of head names, each a spelling (snake_case, camelCase or PascalCase) of a drawn
 * sequence of words, a derived relation whose head binds one field under both names is refused with
 * IdentifierCollision, naming its words joined by underscores, exactly when the two names spell one sequence of
 * words; otherwise it installs two view columns whose identifiers differ.
 *
 * Oracle: the conversion's specification restated over the words a name is spelled from: a name's segments are its
 * words, so two names convert alike exactly when they spell one sequence. A word is two or three of the letters a
 * and b, so every capital a spelling writes is followed by a lower-case letter and starts a segment of its own (a
 * capital beside a capital would read as one acronym segment, which the model does not state).
 *
 * Inputs, constructed: a collision is one sequence of words under two of its spellings that differ as text (a head
 * is a record, so two equal names would be one field); names apart are a sequence and that sequence with one word
 * changed to another or one word appended, each spelled any way. The three are drawn equally often.
 *
 * Plant: derived-heading-namespace (analysis/derived/analyze.ts declaredHeading declares each head column in a
 * namespace of its own, so no two ever collide).
 *
 * Features: a collision of one word's spellings, a collision of several words' spellings, names apart by a changed
 * word, names apart by an appended word, names apart in one spelling.
 *
 * What a derived relation installs, each view column's type, typmod and collation, and every refreshed view against
 * its definition, is PostgreSQL's to judge, in the database suites.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, int, shuffled, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import * as Result from "#compiler/core/result.ts"
import { withDerivedRelations } from "#compiler/physical/derived/objects.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { own } from "#compiler/schema/own.ts"
import { assert, defined, nonEmpty, refused, succeeded } from "#test/support/assert.ts"
import {
	decodedQuery,
	decodedSchema,
	f,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"

const Org = relation("Org", { id: f.uuid }, ["id"])
const Base: SchemaDesc = { name: "Base", relations: [Org], statements: [], extends: undefined }

/** A level over Base holding a derived relation over Org whose head binds Org's id under two names. */
const pairs = (a: string, b: string): SchemaDesc => ({
	name: "Upper",
	extends: Base,
	relations: [
		{
			kind: "derived",
			name: "Pairs",
			level: 1,
			storage: "materialized",
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

const spell = (ws: Words, s: Spelling): string => {
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

const pairGen: Gen<NamePair> = weighted([
	[1, collisionGen],
	[1, changedGen],
	[1, appendedGen]
])

type Feature =
	| "a collision of one word's spellings"
	| "a collision of several words' spellings"
	| "names apart by a changed word"
	| "names apart by an appended word"
	| "names apart in one spelling"

describe("derived relation view columns", () => {
	it.effect(
		"refuse two head names converting to one column identifier, and install names converting apart",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/derived/head-identifiers",
						draw: drawn(pairGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "two names convert alike exactly when they spell one sequence of words, to the words joined by underscores"
						},
						coverage: required<Feature>(
							[
								"a collision of one word's spellings",
								"a collision of several words' spellings",
								"names apart by a changed word",
								"names apart by an appended word",
								"names apart in one spelling"
							],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(p, c) =>
						Effect.sync(() => {
							const a = spell(p.left, p.spelled[0])
							const b = spell(p.right, p.spelled[1])
							const installed = Result.flatMap(own(decodedSchema(pairs(a, b))), (owned) =>
								compileInstallation(owned, withDerivedRelations(installOptions(owned, "owner")))
							)
							if (Arr.makeEquivalence(Str.Equivalence)(p.left, p.right)) {
								c.note(
									p.left.length === 1
										? "a collision of one word's spellings"
										: "a collision of several words' spellings"
								)
								const reason = refused(installed, "IdentifierCollision").reason
								if (reason._tag !== "IdentifierCollision") {
									return assert.fail(`an IdentifierCollision, not ${reason._tag}`)
								}
								assert.equal(
									reason.identifier,
									Arr.join(p.left, "_"),
									"the identifier both head names convert to"
								)
								return
							}
							c.note(
								p.kind === "an appended word"
									? "names apart by an appended word"
									: "names apart by a changed word"
							)
							if (p.spelled[0] === p.spelled[1]) {
								c.note("names apart in one spelling")
							}
							const N = installationNamesOf(succeeded(installed))
							assert.notEqual(
								N.columnIdent({ name: "Pairs" }, a),
								N.columnIdent({ name: "Pairs" }, b),
								"two names converting apart are two view columns"
							)
						})
				)
			)
	)
})
