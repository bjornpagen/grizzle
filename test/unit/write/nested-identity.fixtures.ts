/** What the properties of nested-identity.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { bindFrame } from "#adapter/wire/batch.ts"
import { appendAll } from "#compiler/core/array.ts"
import { drawn as drawnField, natural, uuid } from "#compiler/public/fields.ts"
import { fin, mutable, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { prepareBinding } from "#compiler/runtime/write/binding.ts"
import { nestedRows, type NestedSet, nestedSet } from "#compiler/runtime/write/nesting.ts"
import { type InputData } from "#compiler/runtime/write/normalize.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { DigestBook } from "#compiler/scalar/values/bytes.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { closedTableOf } from "#compiler/write/program/decide.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/** Owner(id, title, members drawn): the owner of the ordered family of Member. */
export const Owner = relation(
	"Owner",
	{ id: uuid, title: str.regex("^[xy]$"), members: drawnField(natural) },
	["id"]
)

const Member = relation(
	"Member",
	{ owner: uuid, at: drawnField(natural), body: str.regex("^[ab]*$") },
	["owner", "at"]
)

export const Bodies = schema(
	"Bodies",
	[Owner, Member],
	[ordered(on(Member, "owner", "at"), fin(Owner, "members")), mutable(Owner), mutable(Member)]
)

const reality = realityWrite(succeeded(testArtifacts(Bodies, testCompile)))

export const lawNames = lawNamesOf(Bodies)

/** One owner fact as the case states it: its id's and its title's indices, and each member's body letter. */
interface StatedFact {
	readonly owner: number
	readonly title: number
	readonly bodies: ReadonlyArray<number>
}

/** A case: its owner facts, and the length every body repeats its letter to. */
interface IdentityCase {
	readonly facts: Arr.NonEmptyReadonlyArray<StatedFact>
	readonly length: number
}

const factGen: Gen<StatedFact> = (source) => ({
	owner: source.draw(int(0, 1)),
	title: source.draw(int(0, 1)),
	bodies: source.draw(array(int(0, 1), { min: 0, max: 2 }))
})

export const caseGen: Gen<IdentityCase> = (source) => ({
	facts: [source.draw(factGen), ...source.draw(array(factGen, { min: 0, max: 2 }))],
	length: source.draw(element([2 ** 10, 2 ** 20] as const))
})

const titles = ["x", "y"] as const

const letters = ["a", "b"] as const

/** A body: its letter repeated to `length`, a fresh string each time, so equal bodies are never one object. */
const bodyOf = (letter: number, length: number): string =>
	Str.repeat(length)(defined(letters[letter], "a body's letter"))

/** The owner facts as a JavaScript caller states them, every body at `length`. */
export const factsOf = (facts: ReadonlyArray<StatedFact>, length: number) =>
	Arr.map(facts, (f) => ({
		id: uuidOf(100 + f.owner),
		title: defined(titles[f.title], "a title"),
		members: Arr.map(f.bodies, (b) => ({ body: bodyOf(b, length) }))
	}))

/** Every text the write states: its owners' ids and titles and its bodies, at `length`. */
export const statedTexts = (
	facts: ReadonlyArray<StatedFact>,
	length: number
): ReadonlyArray<string> =>
	Arr.flatMap(factsOf(facts, length), (f) => [f.id, f.title, ...Arr.map(f.members, (m) => m.body)])

/** A fact's whole content in the specification's model: its id, its title and its bodies in order. */
export const sameFact = (a: StatedFact, b: StatedFact): boolean =>
	a.owner === b.owner &&
	a.title === b.title &&
	a.bodies.length === b.bodies.length &&
	Arr.every(a.bodies, (x, i) => x === b.bodies[i])

/** The program of a case's ChangeSet, an insert of owners. */
export const programOf = (value: unknown): CompiledWrite =>
	succeeded(compileWrite(checking(Bodies), descOf(value), reality))

/** The program's nested input: its nesting and its one member slot. */
const nestedInput = (program: CompiledWrite) => {
	const inputs = Arr.flatMap(program.binding.groups, (g): ReadonlyArray<InputData> => g.inputs)
	const [input] = Arr.flatMap(
		inputs,
		(i): ReadonlyArray<Extract<InputData, { readonly kind: "nested" }>> =>
			i.kind === "nested" ? [i] : []
	)
	const nested = defined(input, "the owners' nested insert")
	return { nesting: nested.nesting, member: Arr.headNonEmpty(nested.members) }
}

/** Every text `set` keys a fact or a row by, its relations' names apart: each key's texts, each signature's own texts
 * (its rows are keyed under their relations), and each identity's texts. */
const keyedTexts = (set: NestedSet): ReadonlyArray<string> => {
	const out: Array<string> = []
	for (const byKey of set.tops.values()) {
		for (const [key, signatures] of byKey) {
			appendAll(out, key)
			for (const signature of signatures.keys()) {
				for (const element of signature) {
					if (typeof element === "string") {
						out.push(element)
					}
				}
			}
		}
	}
	for (const byKey of set.rows.values()) {
		for (const [key, identities] of byKey) {
			appendAll(out, key)
			for (const identity of identities.keys()) {
				appendAll(out, identity)
			}
		}
	}
	return out
}

/** The texts the nested set of `facts` at `length` keys by, through the program's nesting. */
export const keyedAt = (
	program: CompiledWrite,
	facts: ReadonlyArray<StatedFact>,
	length: number
) => {
	const { nesting, member } = nestedInput(program)
	const set = nestedSet()
	succeeded(
		nestedRows(
			nesting,
			{
				fill: prepareBinding(
					program.binding,
					program.frontend.codes,
					closedTableOf(program.frontend),
					new CompilePatterns()
				).fill,
				codes: program.frontend.codes
			},
			member,
			factsOf(facts, length),
			set,
			new DigestBook(),
			inForce(bindFrame)
		)
	)
	return keyedTexts(set)
}

/** An array literal's elements, `{"a","b"}` or `{a,b}`: uuids, which hold no quote or comma, unquoted. */

export type IdentityFeature =
	| "a fact stated twice"
	| "two facts at one id differing in their title alone"
	| "two facts at one id differing in their members"
	| "facts at one id that differ in their members' bodies alone"
	| "two bodies of one length that differ"
	| "an owner with no members"
	| "accepted with members"
