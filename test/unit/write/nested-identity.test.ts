import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { appendAll } from "#compiler/core/array.ts"
import { drawn as drawnField, natural, uuid } from "#compiler/public/fields.ts"
import { fin, mutable, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { DigestBook } from "#compiler/scalar/values/bytes.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { type NestedSet, nestedRows, nestedSet } from "#compiler/write/family/nesting.ts"
import { inForce } from "#compiler/write/family/order.ts"
import {
	type InputData,
	inputSlotsOf,
	type MemberFacts
} from "#compiler/write/normalize/normalize.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf } from "#compiler/write/program/served.ts"
import { assert, assertVariant, defined, succeeded } from "#test/support/assert.ts"
import {
	nestedRowsColumn,
	realityWrite,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A nested write's identities are structural (write/family/nesting.ts NestedSet): a row's identity is its filled
 * columns' texts themselves, and a fact's signature its own texts and the rows it nests, each row the set's one token,
 * never one text joined from their contents. A lawful write whose texts sum past the longest string V8 holds binds
 * (test/pg/write/nested-identity.test.ts keeps that case on PostgreSQL); here the search holds the representation to
 * that at every content length.
 *
 * The schema is the downstream case's shape: an owner with a caller's title and an ordered family of members, each a
 * body of letters. A case draws one to three owner facts of two ids and two titles, each nesting up to two bodies of
 * two letters, every body one letter repeated to the case's content length.
 *
 * Two oracles:
 * - The specification as a second implementation of the dedupe: the facts are a set by their whole content, own
 *   fields and nested members alike, so a fact stated twice is one, and two distinct facts at one owner id are refused
 *   by the owner's key law before any SQL; an accepted write inserts every distinct fact's members once.
 * - The identity gate: every text the nested set keys a row or a fact by is one column's text, none longer than the
 *   longest text the write states, and the set keys by exactly as many texts at the case's content length as at
 *   length 1. A key joined from texts is longer than each of them, and one spelled per character grows with the
 *   content; neither holds the gate.
 */
const Owner = relation(
	"Owner",
	{ id: uuid, title: str.regex("^[xy]$"), members: drawnField(natural) },
	["id"]
)
const Member = relation(
	"Member",
	{ owner: uuid, at: drawnField(natural), body: str.regex("^[ab]*$") },
	["owner", "at"]
)
const Bodies = schema("Bodies", { Owner, Member }, [
	ordered(on(Member, "owner", "at"), fin(Owner, "members")),
	mutable(Owner),
	mutable(Member)
])

const reality = realityWrite(succeeded(testArtifacts(Bodies, testCompile)))
const lawNames = lawNamesOf(Bodies)

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

const caseGen: Gen<IdentityCase> = (source) => ({
	facts: [source.draw(factGen), ...source.draw(array(factGen, { min: 0, max: 2 }))],
	length: source.draw(element([2 ** 10, 2 ** 20] as const))
})

const titles = ["x", "y"] as const
const letters = ["a", "b"] as const

/** A body: its letter repeated to `length`, a fresh string each time, so equal bodies are never one object. */
const bodyOf = (letter: number, length: number): string =>
	Str.repeat(length)(defined(letters[letter], "a body's letter"))

/** The owner facts as a JavaScript caller states them, every body at `length`. */
const factsOf = (facts: ReadonlyArray<StatedFact>, length: number) =>
	Arr.map(facts, (f) => ({
		id: uuidOf(100 + f.owner),
		title: defined(titles[f.title], "a title"),
		members: Arr.map(f.bodies, (b) => ({ body: bodyOf(b, length) }))
	}))

/** Every text the write states: its owners' ids and titles and its bodies, at `length`. */
const statedTexts = (facts: ReadonlyArray<StatedFact>, length: number): ReadonlyArray<string> =>
	Arr.flatMap(factsOf(facts, length), (f) => [f.id, f.title, ...Arr.map(f.members, (m) => m.body)])

/** A fact's whole content in the specification's model: its id, its title and its bodies in order. */
const sameFact = (a: StatedFact, b: StatedFact): boolean =>
	a.owner === b.owner &&
	a.title === b.title &&
	a.bodies.length === b.bodies.length &&
	Arr.every(a.bodies, (x, i) => x === b.bodies[i])

/** The program of the case's one ChangeSet shape, an insert of owners: its Description names its member slot, never
 * its facts, so it is compiled once and every case binds its own facts. */
let shaped: CompiledWrite | undefined
const programOf = (value: unknown): CompiledWrite => {
	shaped ??= succeeded(compileWrite(checking(Bodies), descOf(value), reality))
	return shaped
}

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
const keyedAt = (program: CompiledWrite, facts: ReadonlyArray<StatedFact>, length: number) => {
	const { nesting, member } = nestedInput(program)
	const set = nestedSet()
	succeeded(
		nestedRows(
			nesting,
			{ fill: program.prepared.fill, codes: program.frontend.codes },
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

type IdentityFeature =
	| "a fact stated twice"
	| "two facts at one id differing in their title alone"
	| "two facts at one id differing in their members"
	| "two bodies of one length that differ"
	| "an owner with no members"
	| "accepted with members"

describe("a nested write's identities", () => {
	it.effect(
		"dedupe its facts and rows by their whole content, refuse two at one key, and key each by its texts themselves at any content length",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/nested-identity",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a nested write's facts are a set by their whole content, keyed by its texts themselves"
						},
						coverage: required<IdentityFeature>(
							[
								"a fact stated twice",
								"two facts at one id differing in their title alone",
								"two facts at one id differing in their members",
								"two bodies of one length that differ",
								"an owner with no members",
								"accepted with members"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(box, c) =>
						Effect.gen(function* () {
							const value = ChangeSet.empty(Bodies).insert(Owner, factsOf(box.facts, box.length))
							const program = programOf(value)
							const members: MemberFacts = yield* collectInputs(
								program.binding.groups,
								parsedOf(value).inputs
							)
							const bound = succeeded(
								bindWrite(program, flightOf(program, program.frontend.codes), {
									members,
									params: {},
									transport: inForce(bindFrame)
								})
							)
							const keyed = keyedAt(program, box.facts, box.length)
							const longest = Arr.reduce(statedTexts(box.facts, box.length), 0, (n, t) =>
								Math.max(n, t.length)
							)
							for (const t of keyed) {
								assert.ok(
									t.length <= longest,
									`a text the nested set keys by is one column's: ${t.length} units, past the longest stated text's ${longest}`
								)
							}
							assert.equal(
								keyed.length,
								keyedAt(program, box.facts, 1).length,
								"the nested set keys by as many texts at any content length as at length 1"
							)
							const distinct = Arr.dedupeWith(box.facts, sameFact)
							if (distinct.length < box.facts.length) {
								c.note("a fact stated twice")
							}
							if (
								Arr.some(distinct, (f) =>
									Arr.some(
										distinct,
										(g) =>
											f.owner === g.owner &&
											f.title !== g.title &&
											sameFact(f, { ...g, title: f.title })
									)
								)
							) {
								c.note("two facts at one id differing in their title alone")
							}
							if (
								Arr.some(distinct, (f) =>
									Arr.some(
										distinct,
										(g) => f.owner === g.owner && !sameFact(f, { ...g, title: f.title })
									)
								)
							) {
								c.note("two facts at one id differing in their members")
							}
							const bodies = Arr.flatMap(distinct, (f) => f.bodies)
							if (Arr.contains(bodies, 0) && Arr.contains(bodies, 1)) {
								c.note("two bodies of one length that differ")
							}
							if (Arr.some(distinct, (f) => f.bodies.length === 0)) {
								c.note("an owner with no members")
							}
							const ids = Arr.map(distinct, (f) => f.owner)
							if (Arr.dedupe(ids).length < ids.length) {
								assertVariant(bound, "kind", "invariant-rejected", "two Owners at one id")
								assert.equal(
									bound.law,
									lawNames.primaryKeyLaw(Owner),
									"refused by Owner's key law before any SQL"
								)
								return
							}
							assertVariant(bound, "kind", "bound", "a set with one fact at each id binds")
							assertVariant(
								bound.flights,
								"kind",
								"write",
								"a nested write reads nothing first: every group it writes is its own new owner's"
							)
							const group = defined(program.binding.groups[0], "the owners' slot group")
							const [input] = group.inputs
							const [slot] = inputSlotsOf(input)
							assert.equal(
								bound.flights.stated.slot(group, input, slot).length,
								distinct.length,
								"each distinct Owner is written once"
							)
							const written = nestedRowsColumn(program, bound.flights.chunks, "Member", 0)
							assert.deepEqual(
								Arr.sort(written, Str.Order),
								Arr.sort(
									Arr.flatMap(distinct, (f) => Arr.map(f.bodies, () => uuidOf(100 + f.owner))),
									Str.Order
								),
								"each member of a distinct fact is written once"
							)
							if (bodies.length > 0) {
								c.note("accepted with members")
							}
						})
				)
			)
	)
})
