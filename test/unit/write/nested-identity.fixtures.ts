/** What the properties of nested-identity.test.ts read: its spaces, models and helpers. */

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	array,
	constant,
	element,
	type Gen,
	int,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Order, String as Str } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { closedTableOf } from "#compiler/analysis/schema.ts"
import { drawn as drawnField, natural } from "#compiler/public/fields.ts"
import { fin, mutable, on, ordered, relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { bindWrite, type InsertedStratum } from "#compiler/runtime/write/bind.ts"
import { prepareBinding } from "#compiler/runtime/write/binding.ts"
import { nestedRows, type NestedSet, nestedSet } from "#compiler/runtime/write/nesting.ts"
import type { InputData } from "#compiler/runtime/write/normalize.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { DigestBook } from "#compiler/scalar/values/bytes.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { lawNamesOf } from "#test/support/kernel/naming.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf, uuidOf } from "#test/support/unit/write/changeset/fixtures.ts"

/** Owner(id, title, members drawn): the owner of the ordered family of Member. */
export const Owner = relation(
	"Owner",
	{ id: Id, title: str.regex("^[xy]$"), members: drawnField(natural) },
	["id"]
)

const Member = relation(
	"Member",
	{ owner: Id, at: drawnField(natural), body: str.regex("^[ab]*$") },
	["owner", "at"]
)

export const Bodies = schema(
	"Bodies",
	[Owner, Member],
	[
		ordered(on(Member, "owner", "at"), fin(Owner, "members")),
		unit("Owner", { id: Id }),
		unit("Members", { owner: Id }),
		mutable(Owner),
		mutable(Member)
	]
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

/**
 * What `set` keys and keeps: each key it holds a fact or a row at, its key's texts (core/text.ts TextsId texts); and
 * every text it keeps of what it holds at a key, each fact's signature's texts (its own texts and its relations' names;
 * its rows are kept under their relations) and each row's identity's texts.
 */
const keyedTexts = (
	set: NestedSet
): {
	readonly keys: ReadonlyArray<ReadonlyArray<string>>
	readonly texts: ReadonlyArray<string>
} => {
	const keys: Array<ReadonlyArray<string>> = []
	const texts: Array<string> = []
	for (const byKey of set.tops.values()) {
		for (const [key, at] of byKey) {
			keys.push(key.texts)
			for (const element of at.identity) {
				if (typeof element === "string") {
					texts.push(element)
				}
			}
		}
	}
	for (const byKey of set.rows.values()) {
		for (const [key, at] of byKey) {
			keys.push(key.texts)
			appendAll(texts, at.identity)
		}
	}
	return { keys, texts }
}

/** The keys and texts the nested set of `facts` at `length` holds (`keyedTexts`), through the program's nesting. */
export const keyedAt = (
	program: CompiledWrite,
	facts: ReadonlyArray<StatedFact>,
	length: number
) => {
	const { nesting, member } = nestedInput(program)
	const set = nestedSet()
	const prepared = prepareBinding(
		program.binding,
		program.frontend.codes,
		closedTableOf(program.frontend.schema),
		new CompilePatterns()
	)
	succeeded(
		nestedRows(
			nesting,
			{ fill: prepared.fill, codes: program.frontend.codes, columns: prepared.columns },
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

/** One program for every case of the set's properties: an insert of owners, which depends on its shape alone. */
export const insertOwners = programOf(ChangeSet.empty(Bodies).insert(Owner, []))

/** The length every body of the set's properties repeats its letter to: short, since the set never reads a body's
 * length. */
export const setLength = 3

/**
 * A case of the set's properties: up to four owner facts of two ids, each of the first title three times in four, so
 * two facts at one id often differ in their bodies alone, a conflict the nested set names, and up to two bodies each.
 */
export const setGen: Gen<ReadonlyArray<StatedFact>> = (source) =>
	source.draw(array((s: typeof source) => s.draw(factOf(s.draw(int(0, 1)))), { min: 1, max: 4 }))

/** An owner fact at `owner`: of the first title three times in four, and up to two bodies. */
const factOf =
	(owner: number): Gen<StatedFact> =>
	(source) => ({
		owner,
		title: source.draw(
			weighted([
				[3, constant(0)],
				[1, constant(1)]
			])
		),
		bodies: source.draw(array(int(0, 1), { min: 0, max: 2 }))
	})

/**
 * The owners at which `facts` hold two facts the nested set alone holds in conflict: of one title and one count of
 * bodies, so their own rows are one fact, nesting other bodies. Two facts at an owner of two titles or two counts are
 * two facts at its key, which the same-key check refuses first (runtime/write/normalize.ts sameKey).
 */
export const ownersInConflict = (facts: ReadonlyArray<StatedFact>): ReadonlyArray<number> =>
	Arr.filter(Arr.dedupe(Arr.map(facts, (f) => f.owner)), (owner) =>
		Arr.some(facts, (f) =>
			Arr.some(
				facts,
				(g) =>
					f.owner === owner &&
					g.owner === owner &&
					f.title === g.title &&
					f.bodies.length === g.bodies.length &&
					!sameFact(f, g)
			)
		)
	)

/** Two facts at `owner` the nested set alone holds in conflict (`ownersInConflict`): one title, one or two bodies,
 * the first body's letter apart. */
const conflictAt =
	(owner: number): Gen<ReadonlyArray<StatedFact>> =>
	(source) => {
		const title = source.draw(int(0, 1))
		const bodies = source.draw(array(int(0, 1), { min: 1, max: 2 }))
		const [first = 0, ...rest] = bodies
		return [
			{ owner, title, bodies },
			{ owner, title, bodies: [1 - first, ...rest] }
		]
	}

/**
 * The set's properties' space (`setGen`), aimed: at one key the nested set alone holds in conflict, beside another
 * owner's fact, and at two such keys, each owner's facts together, the first owner drawn.
 */
export const setSpace: Aimed<ReadonlyArray<StatedFact>, SetFeature> = aimed(setGen, [
	[
		"refused at one key the nested set holds in conflict",
		(source) => [
			...source.draw(conflictAt(0)),
			...source.draw(array(factOf(1), { min: 0, max: 1 }))
		]
	],
	[
		"refused where the nested set holds two keys in conflict",
		(source) => {
			const first = source.draw(int(0, 1))
			return [...source.draw(conflictAt(first)), ...source.draw(conflictAt(1 - first))]
		}
	]
])

/** What a case of the set's differential reaches. */
export type SetFeature =
	| "accepted"
	| "a fact stated twice"
	| "refused at one key the nested set holds in conflict"
	| "refused where the nested set holds two keys in conflict"

/** The facts ordered by their owners, ascending or descending, each owner's in the order they came. */
export const byOwner = (
	facts: ReadonlyArray<StatedFact>,
	order: "ascending" | "descending"
): ReadonlyArray<StatedFact> =>
	Arr.sort(
		facts,
		Order.mapInput(Order.Number, (f: StatedFact) => (order === "ascending" ? f.owner : -f.owner))
	)

/** The transport every set's write binds under: the wire's. */
const setTransport = inForce(bindFrame)

/**
 * What binding the insert of `facts` gives before any SQL (runtime/write/bind.ts bindWrite) through `insertOwners`: every
 * statement's executions and the rows it inserts, or its refusal, its law and its witness.
 */
export const boundSet = (facts: ReadonlyArray<StatedFact>) =>
	Effect.sync(() => {
		const members = collectInputs(
			insertOwners.binding.groups,
			parsedOf(ChangeSet.empty(Bodies).insert(Owner, factsOf(facts, setLength))).inputs
		)
		const flight = flightOf(servableWrite(insertOwners), insertOwners.frontend.codes, noAdvice)
		const write = succeeded(bindWrite(flight, { members, params: {}, transport: setTransport }))
		switch (write.kind) {
			case "bound":
				return {
					kind: "bound",
					statements: Arr.map(flight.statements, (statement) =>
						write.skip.has(statement.index) ? undefined : write.chunks(statement, setTransport)
					),
					inserted: write.inserted
				} as const
			case "invariant-rejected":
				return { kind: "refused", law: write.law, witness: write.witness } as const
			case "generated-rejected":
				return assert.fail("an owner's insert fills no generated field")
		}
	})

/** The rows an insert inserts, each relation's in a canonical order of its rows' values, so two inserts of one set of
 * rows give one list whatever order they came in. */
export const rowsAsASet = (inserted: ReadonlyArray<InsertedStratum>) =>
	Arr.map(inserted, (stratum) =>
		Arr.map(Arr.sort([...stratum.rows.keys()], Str.Order), (relation) => ({
			relation,
			rows: Arr.sort(
				Arr.map(stratum.rows.get(relation) ?? [], (row) => Formatter.format(row.values)),
				Str.Order
			)
		}))
	)
