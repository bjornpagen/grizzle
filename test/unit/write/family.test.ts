import { describe, it } from "@effect/vitest"
import {
	accepting,
	type Answer,
	type Machine,
	program,
	type Real,
	type Program as Steps,
	runProgram,
	took
} from "@grizzle/testing/commands"
import { type Case, drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	shuffled,
	type Size,
	string,
	subarray,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { fullSwarm, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import { bindLength } from "#adapter/wire/batch.ts"
import { arrayTexts } from "#compiler/codec/recordset.ts"
import { indices, maxOf } from "#compiler/core/array.ts"
import { compose, type FamilyPlan } from "#compiler/write/family/compose.ts"
import type { Member, Owner } from "#compiler/write/family/draw.ts"
import {
	type BindFrame,
	type CountedRewrite,
	type FamilyStatement,
	type FamilyWrite,
	inForce,
	type Plan,
	plan,
	type Refill,
	type Rewrite,
	textsOf,
	type Transport,
	type Unsendable
} from "#compiler/write/family/order.ts"
import {
	assert,
	defined,
	failed,
	nonEmpty,
	succeeded,
	unorderedEqual
} from "#test/support/assert.ts"
import { familiesGen } from "#test/support/families/generate.ts"
import { applied, type MutationStatement as Statement, run } from "#test/support/families/mutate.ts"
import {
	type Families,
	type FamilyRow,
	SHAPES,
	type Shape,
	type Stored,
	storedOf,
	familyViolations
} from "#test/support/families/theorem.ts"
import { caseHang } from "#test/support/limits.ts"
import { testSql } from "#test/support/sql.ts"

/**
 * The family write planner (write/family): each owner's change of its family, as the statements that make it, in the
 * one order PostgreSQL admits and cut into statements the transport carries.
 *
 * The oracles:
 * - a model of the database, the family lowering's (test/support/families): a plan's statements, read back from the
 *   texts their arrays carry by the layout the planner states, change a family relation and its owners as PostgreSQL
 *   would, the count's cascade into every copy included. What PostgreSQL checks at a statement's end must hold at the
 *   end of each one, the deferred rest at commit, and the theorem must read back exactly the families the changes
 *   state, computed apart by plain list operations. The copy of each owner's count must also hold at every
 *   statement's end, though the model defers its foreign key, so a plan is right whether that key is deferred or not;
 * - the contract of each change, stated apart: the slots it vacates and the members it places, each copying the new
 *   count, an owner's members in ascending slot order, and one count update for an owner whose count changes, none for
 *   another;
 * - the transport's own encoder and Bind measure (codec/recordset.ts arrayTexts, the wire's bindLength): every
 *   statement is carried, no statement could have taken the next one's first row, and a row too large to go alone
 *   refuses the write, naming the first such row's bound.
 *
 * - for owners the same ChangeSet inserts, the same model given each owner's own insert, its count already its
 *   family's (a `create` of that count), before the family's inserts: no delete and no count statement, and a
 *   commit to exactly the families written;
 * - for a ChangeSet's composed plans (write/family/compose.ts), the specification turned into a checker: every delete
 *   deepest first, then every count, then every insert shallowest first, each plan's statements in their own order,
 *   each tagged with its own family.
 *
 * The bounds: every family of up to four members, ordered and counted, beside an owner the change leaves alone, under
 * every single change, with its count known or believed one off, under the transport in force and one that carries
 * one row per statement (5,472 cases); generated programs of writes that change several owners at once, under
 * transports drawn small for each write; writes under transports too small for some of their rows; one to three
 * fresh owners of up to four members each, under both transports, with the named mutant of owners inserted at count 0
 * (620 cases); and every composition of one to three plans at depths 1 to 3, of up to two deletes, one count and one
 * insert each (47,988 cases).
 */

/** A statement sent unnamed, as each family statement is here, so its Bind message holds no statement name. */
const unnamed = testSql("SELECT 1")

/** The Bind message of an unnamed statement carrying `params`, as the wire measures it. */
const bindOf = (params: ReadonlyArray<string>): number => bindLength({ sql: unnamed, params })

/** The wire's frame, read off its own measure: a Bind message of no parameter, and what one empty parameter adds. */
const frame: BindFrame = { statement: bindOf([]), parameter: bindOf([""]) - bindOf([]) }

/** The transport in force over that frame. */
const roomy = inForce(frame)

/** A text's array literal alone, as the encoder writes it. */
const literalAlone = (text: string): string =>
	defined(
		succeeded(arrayTexts("t", ["c"], [[text]], roomy.literalUnits))[0],
		"one column writes one literal"
	)

/** Whether a statement of these rows' texts is carried, or which bound refuses it: its arrays first, then its Bind. */
type Carriage = "carried" | "literal" | "message"

const carriage = (rows: ReadonlyArray<ReadonlyArray<string>>, transport: Transport): Carriage => {
	const columns = Arr.map(defined(rows[0], "a statement has a row"), (_, column) => `c${column}`)
	const arrays = arrayTexts("t", columns, rows, transport.literalUnits)
	if (!arrays.ok) {
		return "literal"
	}
	return bindOf(arrays.value) <= transport.messageBytes ? "carried" : "message"
}

/** An owner's key: its number, then a tag, so a group is two columns. */
const ownerTexts = (owner: number): Owner => [String(owner), `o${owner}`]

/** The pads a case's members carry, one by one in turn by member number. */
type Pads = Arr.NonEmptyReadonlyArray<string>

const padOf = (pads: Pads, member: number): string => Arr.getUnsafe(pads, member % pads.length)

/** A member's own fields: its number, then its pad. */
const memberTexts = (pads: Pads, member: number): Member => [String(member), padOf(pads, member)]

/**
 * What a pad is made of: ASCII, a letter of two UTF-8 bytes, a surrogate pair of four, and the two characters an array
 * literal escapes, so a text's code units, its bytes and its literal's length all differ.
 */
const PAD_CHARACTERS: Arr.NonEmptyReadonlyArray<string> = ["a", "é", "😀", '"', "\\"]

const padsGen =
	(length: Size): Gen<Pads> =>
	(source) =>
		nonEmpty(source.draw(array(string(characterOf(PAD_CHARACTERS), length), { min: 1, max: 4 })))

/** The forms of change, the simplest first. */
const FORMS = ["append", "put", "clear", "insert-at", "remove", "removal"] as const

type Form = (typeof FORMS)[number]

/**
 * The forms a family of `n` members takes: insert-at and remove rewrite an ordered family's tail, a removal refills a
 * counted family by swap-with-last, and both removals need a member.
 */
const formsOf = (shape: Shape, n: number): Arr.NonEmptyReadonlyArray<Form> => {
	switch (shape) {
		case "ordered":
			return n === 0
				? ["append", "put", "clear", "insert-at"]
				: ["append", "put", "clear", "insert-at", "remove"]
		case "counted":
			return n === 0 ? ["append", "put", "clear"] : ["append", "put", "clear", "removal"]
	}
}

/** A kept slot's new member, by number. */
interface Refilled {
	readonly slot: number
	readonly member: number
}

/** One owner's drawn change, in member numbers: the rewrite the planner takes, and the form it was drawn as. */
interface Change {
	readonly owner: number
	readonly form: Form
	readonly kept: number
	readonly dropped: number
	readonly suffix: ReadonlyArray<number>
	readonly refills: ReadonlyArray<Refilled>
}

/** How many new members a drawn change adds: an append or an insert some, a put up to `put` beside the old ones. */
interface Adding {
	readonly appended: Size
	readonly put: number
}

/** A change of `form` to an owner's `members`, its new members numbered from `fresh`. */
const changeGen =
	(
		form: Form,
		owner: number,
		members: ReadonlyArray<number>,
		fresh: number,
		adding: Adding
	): Gen<Change> =>
	(source) => {
		const n = members.length
		const added = (count: number): ReadonlyArray<number> =>
			Arr.map(indices(count), (i) => fresh + i)
		const appended = (): ReadonlyArray<number> =>
			added(source.draw(int(adding.appended.min, adding.appended.max)))
		switch (form) {
			case "append":
				return { owner, form, kept: n, dropped: 0, suffix: appended(), refills: [] }
			case "put": {
				const pool = [...members, ...added(adding.put)]
				const suffix = source.draw(shuffled(pool, { min: 0, max: pool.length }))
				return { owner, form, kept: 0, dropped: n, suffix, refills: [] }
			}
			case "clear":
				return { owner, form, kept: 0, dropped: n, suffix: [], refills: [] }
			case "insert-at": {
				const at = source.draw(int(0, n))
				const suffix = [...appended(), ...members.slice(at)]
				return { owner, form, kept: at, dropped: n - at, suffix, refills: [] }
			}
			case "remove": {
				const at = source.draw(int(0, n - 1))
				return {
					owner,
					form,
					kept: at,
					dropped: n - at,
					suffix: members.slice(at + 1),
					refills: []
				}
			}
			case "removal": {
				const mask = source.draw(int(1, 2 ** n - 1))
				const removed = Arr.filter(indices(n), (slot) => ((mask >> slot) & 1) === 1)
				const left = n - removed.length
				const holes = Arr.filter(removed, (slot) => slot < left)
				const movers = Arr.filter(indices(n), (slot) => slot >= left && !removed.includes(slot))
				assert.equal(holes.length, movers.length, "a removal leaves as many holes as members above")
				const refills = Arr.zipWith(holes, movers, (slot, from) => ({
					slot,
					member: Arr.getUnsafe(members, from)
				}))
				return { owner, form, kept: left, dropped: n - left, suffix: [], refills }
			}
		}
	}

/** The members a change leaves its owner: its kept members, each refilled slot's new member in place, then its suffix. */
const leftBy = (members: ReadonlyArray<number>, change: Change): ReadonlyArray<number> => {
	const refilled = new Map(
		Arr.map(change.refills, (refill) => [refill.slot, refill.member] as const)
	)
	return [
		...Arr.map(members.slice(0, change.kept), (member, slot) => refilled.get(slot) ?? member),
		...change.suffix
	]
}

/** The members an owner of the families has. */
const membersOf = (families: Families, owner: number): ReadonlyArray<number> => {
	const owned = Arr.filter(families, (family) => family.owner === owner)
	return Arr.flatMap(owned, (family) => family.members)
}

/** The families a write leaves: each changed owner's as its change leaves it, every other as it was. */
const targetOf = (families: Families, changes: ReadonlyArray<Change>): Families =>
	Arr.map(families, (family) => {
		const change = Arr.findFirst(changes, (c) => c.owner === family.owner)
		return Option.isNone(change)
			? family
			: { owner: family.owner, members: leftBy(family.members, change.value) }
	})

/** A change as the planner's ordered rewrite: its owner's key and its suffix as texts. */
const rewriteOf = (pads: Pads, change: Change): Rewrite => ({
	owner: ownerTexts(change.owner),
	kept: change.kept,
	dropped: change.dropped,
	suffix: Arr.map(change.suffix, (member) => memberTexts(pads, member)),
	count: { kind: "updated", ends: [] }
})

/** A change as the planner's counted rewrite: a rewrite with its refills as texts. */
const countedOf = (pads: Pads, change: Change): CountedRewrite => ({
	...rewriteOf(pads, change),
	refills: Arr.map(change.refills, (refill): Refill => ({
		slot: refill.slot,
		member: memberTexts(pads, refill.member)
	}))
})

/** A write of changes to a family of a shape: an ordered change refills nothing. */
const writeOf = (shape: Shape, pads: Pads, changes: ReadonlyArray<Change>): FamilyWrite => {
	switch (shape) {
		case "ordered":
			assert.ok(
				Arr.every(changes, (change) => change.refills.length === 0),
				"an ordered change refills nothing"
			)
			return { kind: "ordered", rewrites: Arr.map(changes, (change) => rewriteOf(pads, change)) }
		case "counted":
			return { kind: "counted", rewrites: Arr.map(changes, (change) => countedOf(pads, change)) }
	}
}

/** A deleted run of an owner's slots, as read back. */
interface Run {
	readonly owner: number
	readonly from: number
	readonly to: number
}

/** An owner's count, as read back. */
interface Count {
	readonly owner: number
	readonly count: number
}

/** A statement read back from the texts its arrays carry. */
type Read =
	| { readonly kind: "delete"; readonly rows: ReadonlyArray<Run> }
	| { readonly kind: "count"; readonly rows: ReadonlyArray<Count> }
	| { readonly kind: "insert"; readonly rows: ReadonlyArray<FamilyRow> }

/** A slot, a count or a number, read back from its text: a whole number at least zero. */
const decimal = (text: string | undefined): number => {
	const value = Number(defined(text, "a row has each column of its layout"))
	assert.ok(Number.isSafeInteger(value) && value >= 0, "a slot, a count and a key are naturals")
	return value
}

/** A row's owner, read back from its first two texts: its group is its owner's key. */
const groupOf = (texts: ReadonlyArray<string>): number => {
	const owner = decimal(texts[0])
	assert.deepEqual(texts.slice(0, 2), [...ownerTexts(owner)], "a row's group is its owner's key")
	return owner
}

/**
 * A statement read back by the layout the planner states: the owner's key, then a deleted run's first slot and the
 * slot after its last, a count, or a placed member's index and copy of the count followed by its own fields.
 */
const readOf =
	(pads: Pads) =>
	(statement: FamilyStatement): Read => {
		const texts = textsOf(statement)
		switch (statement.kind) {
			case "delete":
				return {
					kind: "delete",
					rows: Arr.map(texts, (row) => {
						assert.equal(row.length, 4, "a deleted run's texts are its owner's key and two slots")
						return { owner: groupOf(row), from: decimal(row[2]), to: decimal(row[3]) }
					})
				}
			case "count":
				return {
					kind: "count",
					rows: Arr.map(texts, (row) => {
						assert.equal(row.length, 3, "a count's texts are its owner's key and the count")
						return { owner: groupOf(row), count: decimal(row[2]) }
					})
				}
			case "insert":
				return {
					kind: "insert",
					rows: Arr.map(texts, (row) => {
						assert.equal(
							row.length,
							6,
							"a placed member's texts are its group, its index, its copy and its own"
						)
						const member = decimal(row[4])
						assert.equal(row[5], padOf(pads, member), "a member's own fields follow its drawn ones")
						return { group: groupOf(row), at: decimal(row[2]), copy: decimal(row[3]), member }
					})
				}
			case "deleteTree":
				return assert.fail("an ordered or counted family's write deletes no tree")
		}
	}

/**
 * A plan's statements as the model's (test/support/families/mutate.ts), each read against the state the ones before
 * it leave: a deleted run is the members its slots hold then, as its SQL deletes them; a count statement is a count
 * update per owner, which no constraint across owners tells apart from one statement; an insert is itself.
 */
const modelled = (before: Families, statements: ReadonlyArray<Read>): ReadonlyArray<Statement> => {
	let state = storedOf(before)
	const sent: Array<Statement> = []
	for (const statement of statements) {
		const each: ReadonlyArray<Statement> = statementsOf(state, statement)
		for (const one of each) {
			state = applied(state, one)
			sent.push(one)
		}
	}
	return sent
}

/** One statement as the model's, against the state it runs on; none for a delete whose runs hold no member. */
const statementsOf = (state: Stored, statement: Read): ReadonlyArray<Statement> => {
	switch (statement.kind) {
		case "delete": {
			const members = Arr.map(
				Arr.filter(state.rows, (row) =>
					Arr.some(
						statement.rows,
						(run) => run.owner === row.group && run.from <= row.at && row.at < run.to
					)
				),
				(row) => row.member
			)
			return Arr.isReadonlyArrayNonEmpty(members) ? [{ kind: "delete", members }] : []
		}
		case "count":
			return Arr.map(statement.rows, (row) => ({
				kind: "count",
				owner: row.owner,
				count: row.count
			}))
		case "insert":
			return [{ kind: "insert", rows: nonEmpty(statement.rows, "a statement has a row") }]
	}
}

/** Every member copies its owner's count at the end of every statement, whenever the copy's foreign key is checked. */
const judgeCopy = (before: Families, statements: ReadonlyArray<Statement>): void => {
	for (const state of Arr.scan(statements, storedOf(before), applied)) {
		assert.deepEqual(
			Arr.filter(familyViolations(state), (v) => v.constraint === "copy"),
			[],
			"every member copies its owner's count at every statement's end"
		)
	}
}

/** The slots `from` up to `to`, exclusive. */
const slotsOf = (from: number, to: number): ReadonlyArray<number> =>
	Arr.map(indices(to - from), (i) => from + i)

/**
 * The contract of a write's statements, stated apart from the planner: each change vacates exactly its refilled slots
 * and its dropped tail, each once; places its refills and its suffix after the kept members, each copying the count it
 * leaves, in ascending slot order; updates its owner's count once when that count changes and never when it stays;
 * and no statement touches an owner no change names.
 */
const judgeContract = (changes: ReadonlyArray<Change>, statements: ReadonlyArray<Read>): void => {
	const runs = Arr.flatMap(statements, (s) => (s.kind === "delete" ? s.rows : []))
	const counts = Arr.flatMap(statements, (s) => (s.kind === "count" ? s.rows : []))
	const placed = Arr.flatMap(statements, (s) => (s.kind === "insert" ? s.rows : []))
	const owners = Arr.map(changes, (change) => change.owner)
	assert.ok(
		Arr.every(runs, (run) => owners.includes(run.owner)) &&
			Arr.every(counts, (count) => owners.includes(count.owner)) &&
			Arr.every(placed, (row) => owners.includes(row.group)),
		"a write touches only the owners it changes"
	)
	for (const change of changes) {
		const { owner, kept, dropped, suffix, refills } = change
		const after = kept + suffix.length
		const vacated = Arr.filter(runs, (run) => run.owner === owner)
		unorderedEqual(
			Arr.flatMap(vacated, (run) => slotsOf(run.from, run.to)),
			[...Arr.map(refills, (refill) => refill.slot), ...slotsOf(kept, kept + dropped)],
			"a change vacates its refilled slots and its dropped tail, each once"
		)
		assert.deepEqual(
			Arr.map(
				Arr.filter(counts, (count) => count.owner === owner),
				(count) => count.count
			),
			after === kept + dropped ? [] : [after],
			"a change updates its owner's count once when it changes, and never when it stays"
		)
		const mine = Arr.filter(placed, (row) => row.group === owner)
		assert.ok(
			Arr.every(mine, (row, i) => i === 0 || Arr.getUnsafe(mine, i - 1).at < row.at),
			"an owner's members go in ascending slot order"
		)
		unorderedEqual(
			mine,
			[
				...Arr.map(refills, (refill) => ({
					group: owner,
					at: refill.slot,
					copy: after,
					member: refill.member
				})),
				...Arr.map(suffix, (member, i) => ({ group: owner, at: kept + i, copy: after, member }))
			],
			"a change places its refills and its suffix, each copying the count it leaves"
		)
	}
}

/** A statement kind cut into several statements, and the bound that cut it. */
type Cut = Readonly<{ kind: FamilyStatement["kind"]; bound: Exclude<Carriage, "carried"> }>

/**
 * The transport carries every statement of a plan, and each is as long as it can be: the next statement's first row
 * would not fit in it. Each cut is reported, with the bound that made it.
 */
const judgeTransport = (planned: Plan, transport: Transport, cut: (c: Cut) => void): void => {
	for (const phase of planned) {
		const statements: ReadonlyArray<FamilyStatement> = phase
		for (const [i, statement] of statements.entries()) {
			const rows = textsOf(statement)
			assert.equal(carriage(rows, transport), "carried", "the transport carries every statement")
			const next = statements[i + 1]
			if (next === undefined) {
				continue
			}
			const first = defined(textsOf(next)[0], "a statement has a row")
			const bound = carriage([...rows, first], transport)
			assert.ok(bound !== "carried", "no statement could have taken the next one's first row")
			cut({ kind: statement.kind, bound })
		}
	}
}

/** The largest family the box exhausts. */
const BOX_MEMBERS = 4

/** The owner a box's change leaves alone, beside the owner it changes, owner 0, whose members are 0, 1, …. */
const BYSTANDER = { owner: 1, members: [10, 11] } as const

/** The first new member a box's change adds. */
const BOX_FRESH = 20

/** A box's change adds one or two members by an append or an insert, and a put one new member beside the old. */
const BOX_ADDING: Adding = { appended: { min: 1, max: 2 }, put: 1 }

/** A box's members carry no pad. */
const BOX_PADS: Pads = [""]

/** The count a change is planned on: the family's own, or one more or one less than it, which the database refuses. */
const BELIEFS = ["true", "one more", "one less"] as const

type Belief = (typeof BELIEFS)[number]

/** A change as planned on a believed count: its dropped tail one longer or one shorter. */
const believed = (change: Change, belief: Belief): Change => {
	switch (belief) {
		case "true":
			return change
		case "one more":
			return { ...change, dropped: change.dropped + 1 }
		case "one less":
			return { ...change, dropped: change.dropped - 1 }
	}
}

/** The transports a box runs under: the one in force, and one that carries one row per statement. */
const BOX_TRANSPORTS = ["in force", "one row each"] as const

type BoxTransport = (typeof BOX_TRANSPORTS)[number]

/**
 * The transport that carries a row per statement: literals as long as the longest of the box's texts alone, so every
 * row fits alone and no two do, since their owners' numbers alone would make a longer one.
 */
const oneRowEach: Transport = {
	...roomy,
	literalUnits: maxOf(
		Arr.map(
			[
				...ownerTexts(0),
				...ownerTexts(1),
				...Arr.map(indices(BOX_FRESH + BOX_ADDING.appended.max + 1), String),
				...BOX_PADS
			],
			(text) => literalAlone(text).length
		),
		0
	)
}

const transportOf = (transport: BoxTransport): Transport => {
	switch (transport) {
		case "in force":
			return roomy
		case "one row each":
			return oneRowEach
	}
}

/** One case of the box: a family's shape and size, one change to it, the count it is planned on, and the transport. */
interface Box {
	readonly shape: Shape
	readonly members: number
	readonly change: Change
	readonly belief: Belief
	readonly transport: BoxTransport
}

const boxGen: Gen<Box> = (source) => {
	const shape = source.draw(element(SHAPES))
	const members = source.draw(int(0, BOX_MEMBERS))
	const form = source.draw(element(formsOf(shape, members)))
	const change = source.draw(changeGen(form, 0, indices(members), BOX_FRESH, BOX_ADDING))
	const beliefs: Arr.NonEmptyReadonlyArray<Belief> =
		change.dropped > 0 ? BELIEFS : ["true", "one more"]
	const belief = source.draw(element(beliefs))
	const transport = source.draw(element(BOX_TRANSPORTS))
	return { shape, members, change, belief, transport }
}

type BoxFeature =
	| `${Shape} ${Form}`
	| "a stale count refused"
	| "a stale count committed"
	| "a stale count that writes nothing"
	| "an empty plan"
	| "a refilled slot"
	| "a count unchanged"
	| "a statement kind cut"

describe("the family write planner, exhaustively", () => {
	it.effect(
		"makes every change of a family of up to four members, ordered or counted, in statements PostgreSQL admits, and a stale count is refused or harmless",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/family/box",
						generator: boxGen,
						literal: Formatter.format,
						limit: 5_472,
						coverage: requiredInSpace<BoxFeature>([
							"ordered append",
							"ordered put",
							"ordered clear",
							"ordered insert-at",
							"ordered remove",
							"counted append",
							"counted put",
							"counted clear",
							"counted removal",
							"a stale count refused",
							"a stale count committed",
							"a stale count that writes nothing",
							"an empty plan",
							"a refilled slot",
							"a count unchanged",
							"a statement kind cut"
						]),
						caseHang
					},
					(box, c) =>
						Effect.sync(() => {
							c.note(`${box.shape} ${box.change.form}`)
							const before: Families = [{ owner: 0, members: indices(box.members) }, BYSTANDER]
							const change = believed(box.change, box.belief)
							const transport = transportOf(box.transport)
							const planned = succeeded(
								plan(writeOf(box.shape, BOX_PADS, [change]), transport),
								"every row of the box fits alone"
							)
							const statements = Arr.map(Arr.flatten(planned), readOf(BOX_PADS))
							const sent = modelled(before, statements)
							const outcome = run(box.shape, before, sent)
							const after = targetOf(before, [box.change])
							if (box.belief === "true") {
								assert.deepEqual(
									outcome,
									{ kind: "committed", after },
									"a change commits to exactly the family it states"
								)
								judgeCopy(before, sent)
							} else if (statements.length === 0) {
								c.note("a stale count that writes nothing")
								assert.deepEqual(
									outcome,
									{ kind: "committed", after: before },
									"a plan of no statement leaves the families as they were"
								)
							} else if (outcome.kind === "committed") {
								c.note("a stale count committed")
								assert.deepEqual(
									outcome.after,
									after,
									"a change planned on a stale count commits only to the family it states"
								)
							} else {
								c.note("a stale count refused")
							}
							judgeContract([change], statements)
							judgeTransport(planned, transport, () => c.note("a statement kind cut"))
							if (statements.length === 0) {
								c.note("an empty plan")
							}
							if (box.change.refills.length > 0) {
								c.note("a refilled slot")
							}
							if (box.change.kept + box.change.suffix.length === box.members) {
								c.note("a count unchanged")
							}
						})
				)
			)
	)
})

/** What a program starts from and how many writes it takes. */
const PROGRAM_SPACE = {
	families: { owners: { min: 1, max: 3 }, long: { min: 3, max: 6 } },
	steps: { min: 1, max: 6 }
} as const

/** A program's change adds one to three members by an append or an insert, and a put up to two new beside the old. */
const PROGRAM_ADDING: Adding = { appended: { min: 1, max: 3 }, put: 2 }

/** How many member numbers each change of a write reserves for the members it adds. */
const FRESH_PER_CHANGE = Math.max(PROGRAM_ADDING.appended.max, PROGRAM_ADDING.put)

/** How long a program's pads are. */
const PROGRAM_PAD: Size = { min: 0, max: 3 }

/**
 * The smallest literal and Bind message that carry every row a program writes alone: its widest texts, with owners
 * below 10 and every other number below 100, which the program's space keeps them.
 */
const floorOf = (pads: Pads): Readonly<{ units: number; bytes: number }> => {
	const widest = Arr.map(pads, (pad) => ["9", "o9", "99", "99", "99", pad])
	return {
		units: maxOf(
			Arr.map(Arr.flatten(widest), (text) => literalAlone(text).length),
			0
		),
		bytes: maxOf(
			Arr.map(widest, (row) => bindOf(Arr.map(row, literalAlone))),
			0
		)
	}
}

/**
 * A write's transport: mostly one drawn small, between the floor that carries every row alone and a little more, so
 * statements are cut by either bound; sometimes the one in force.
 */
const transportGen = (pads: Pads): Gen<Transport> => {
	const floor = floorOf(pads)
	return weighted([
		[1, constant(roomy)],
		[
			3,
			(source) => ({
				messageBytes: floor.bytes + source.draw(int(0, 160)),
				literalUnits: floor.units + source.draw(int(0, 24)),
				frame
			})
		]
	])
}

/** One write of a program: a change for each of some owners, and the transport it is planned for. */
interface Write {
	readonly changes: Arr.NonEmptyReadonlyArray<Change>
	readonly transport: Transport
}

interface Writes {
	readonly write: Write
}

/** A write to some of the families' owners, each change of a form the swarm turns on, its new members apart. */
const writeGen =
	(shape: Shape, families: Families, pads: Pads, forms: Swarm<Form>): Gen<Write> =>
	(source) => {
		const first = source.draw(int(0, families.length - 1))
		const others = source.draw(subarray(Arr.filter(indices(families.length), (i) => i !== first)))
		const fresh =
			maxOf(
				Arr.flatMap(families, (family) => family.members),
				-1
			) + 1
		const changes: Array<Change> = []
		for (const [j, index] of Arr.sort([first, ...others], Order.Number).entries()) {
			const family = Arr.getUnsafe(families, index)
			const form = source.draw(swarmChoice(forms, formsOf(shape, family.members.length)))
			changes.push(
				source.draw(
					changeGen(
						form,
						family.owner,
						family.members,
						fresh + j * FRESH_PER_CHANGE,
						PROGRAM_ADDING
					)
				)
			)
		}
		return { changes: nonEmpty(changes), transport: source.draw(transportGen(pads)) }
	}

/** The state machine of a program: every write applies, and leaves the families its changes state. */
const machineOf = (
	shape: Shape,
	families: Families,
	pads: Pads,
	forms: Swarm<Form>
): Machine<Families, Writes, never> => ({
	initial: families,
	commands: {
		write: {
			applies: () => true,
			parameters: (model) => writeGen(shape, model, pads, forms),
			weight: 1,
			judge: accepting((model, write) => targetOf(model, write.changes))
		}
	}
})

/** A program: its families' shape, the families it starts from, its members' pads, the forms it draws, its writes. */
interface Scenario {
	readonly shape: Shape
	readonly families: Families
	readonly pads: Pads
	readonly forms: Swarm<Form>
	readonly steps: Steps<Writes>
}

const scenarioGen: Gen<Scenario> = (source) => {
	const shape = source.draw(element(SHAPES))
	const families = source.draw(familiesGen(PROGRAM_SPACE.families))
	const pads = source.draw(padsGen(PROGRAM_PAD))
	const forms = source.draw(swarm(FORMS))
	return {
		shape,
		families,
		pads,
		forms,
		steps: source.draw(
			program(machineOf(shape, families, pads, forms), PROGRAM_SPACE.steps, fullSwarm(["write"]))
		)
	}
}

type Feature =
	| Shape
	| `${Shape} ${Form}`
	| "several owners in one write"
	| `${FamilyStatement["kind"]}s cut`
	| `cut by the ${Cut["bound"]} bound`
	| "an owner's members in several inserts"
	| "a count unchanged"

/** Each write's run: planned, judged by the contract and the transport, and run on the model of the database. */
const judgeWrite =
	(shape: Shape, pads: Pads, c: Case<Feature>) =>
	(write: Write, before: Families, after: Families): Effect.Effect<Answer<never>> =>
		Effect.as(
			Effect.sync(() => {
				for (const change of write.changes) {
					c.note(`${shape} ${change.form}`)
					c.pair(shape, `${shape} ${change.form}`)
					if (change.kept + change.suffix.length === membersOf(before, change.owner).length) {
						c.note("a count unchanged")
					}
				}
				if (write.changes.length > 1) {
					c.note("several owners in one write")
				}
				const planned = succeeded(
					plan(writeOf(shape, pads, write.changes), write.transport),
					"every row a program writes fits alone"
				)
				const statements = Arr.map(Arr.flatten(planned), readOf(pads))
				const sent = modelled(before, statements)
				assert.deepEqual(
					run(shape, before, sent),
					{ kind: "committed", after },
					"a write commits to exactly the families its changes state"
				)
				judgeCopy(before, sent)
				judgeContract(write.changes, statements)
				judgeTransport(planned, write.transport, (cut) => {
					c.note(`${cut.kind}s cut`)
					c.note(`cut by the ${cut.bound} bound`)
				})
				const inserting = Arr.flatMap(statements, (s) =>
					s.kind === "insert" ? [new Set(Arr.map(s.rows, (row) => row.group))] : []
				)
				if (
					Arr.some(
						write.changes,
						(change) => Arr.filter(inserting, (owners) => owners.has(change.owner)).length > 1
					)
				) {
					c.note("an owner's members in several inserts")
					c.pair(shape, "an owner's members in several inserts")
				}
			}),
			took
		)

describe("the family write planner, over programs of writes", () => {
	it.effect(
		"commits every write's changes to several owners in statements PostgreSQL admits, each statement as full as the transport lets it be",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/family/programs",
						draw: drawn(scenarioGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"ordered append",
								"ordered put",
								"ordered clear",
								"ordered insert-at",
								"ordered remove",
								"counted append",
								"counted put",
								"counted clear",
								"counted removal",
								"several owners in one write",
								"deletes cut",
								"counts cut",
								"inserts cut",
								"cut by the literal bound",
								"cut by the message bound",
								"an owner's members in several inserts",
								"a count unchanged",
								["ordered", "an owner's members in several inserts"],
								["counted", "an owner's members in several inserts"]
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(scenario, c) =>
						Effect.gen(function* scenarioRun() {
							c.note(scenario.shape)
							const real: Real<Families, Writes, never, never, never> = {
								write: judgeWrite(scenario.shape, scenario.pads, c)
							}
							yield* runProgram(
								machineOf(scenario.shape, scenario.families, scenario.pads, scenario.forms),
								real,
								scenario.steps
							)
						})
				)
			)
	)
})

/** A put of new members to an owner of `members` members, under a transport too small for some of its rows. */
interface Starved {
	readonly members: number
	readonly suffix: number
	readonly pads: Pads
	readonly transport: Transport
}

const starvedGen: Gen<Starved> = (source) => ({
	members: source.draw(int(0, 3)),
	suffix: source.draw(int(0, 3)),
	pads: source.draw(padsGen({ min: 0, max: 6 })),
	transport: {
		messageBytes: source.draw(int(frame.statement, 140)),
		literalUnits: source.draw(int(3, 14)),
		frame
	}
})

/**
 * The first of a statement kind's rows, in the order they are sent, that no statement carries alone, by the wire's
 * own measure: the first column whose literal alone is too long, or else the row's Bind message.
 */
const refusalOf = (
	statement: FamilyStatement["kind"],
	rows: ReadonlyArray<ReadonlyArray<string>>,
	transport: Transport
): Unsendable | undefined => {
	for (const row of rows) {
		for (const [column, text] of row.entries()) {
			if (literalAlone(text).length > transport.literalUnits) {
				return { kind: "literal", statement, column, limit: transport.literalUnits }
			}
		}
		const bytes = bindOf(Arr.map(row, literalAlone))
		if (bytes > transport.messageBytes) {
			return { kind: "message", statement, bytes, limit: transport.messageBytes }
		}
	}
	return undefined
}

type StarvedFeature =
	| "sent"
	| `refused by the ${Unsendable["kind"]} bound`
	| `refused at the ${FamilyStatement["kind"]}`

describe("the family write planner, under a transport too small", () => {
	it.effect(
		"refuses a write holding a row no statement carries alone, naming the first such row's bound, and plans every other",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/family/unsendable",
						draw: drawn(starvedGen),
						literal: Formatter.format,
						coverage: required<StarvedFeature>(
							[
								"sent",
								"refused by the literal bound",
								"refused by the message bound",
								"refused at the delete",
								"refused at the count",
								"refused at the insert"
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
					(starved, c) =>
						Effect.sync(() => {
							const suffix = Arr.map(indices(starved.suffix), (i) => BOX_FRESH + i)
							const change: Change = {
								owner: 0,
								form: "put",
								kept: 0,
								dropped: starved.members,
								suffix,
								refills: []
							}
							const count = suffix.length
							const owner = [...ownerTexts(0)]
							const expected =
								refusalOf(
									"delete",
									starved.members > 0 ? [[...owner, "0", String(starved.members)]] : [],
									starved.transport
								) ??
								refusalOf(
									"count",
									count === starved.members ? [] : [[...owner, String(count)]],
									starved.transport
								) ??
								refusalOf(
									"insert",
									Arr.map(suffix, (member, at) => [
										...owner,
										String(at),
										String(count),
										...memberTexts(starved.pads, member)
									]),
									starved.transport
								)
							const result = plan(writeOf("ordered", starved.pads, [change]), starved.transport)
							if (expected === undefined) {
								c.note("sent")
								succeeded(result, "a write whose every row goes alone is planned")
							} else {
								c.note(`refused by the ${expected.kind} bound`)
								c.note(`refused at the ${expected.statement}`)
								assert.deepEqual(
									failed(result),
									expected,
									"a write is refused at its first row that no statement carries alone"
								)
							}
						})
				)
			)
	)
})

/** The owners of a fresh write, its members numbered from 0 across them, ids apart. */
const FRESH_OWNERS = { min: 1, max: 3 } as const
const FRESH_MEMBERS = 4

/** One case of the fresh-owner box: each fresh owner's member count, the family's shape, and the transport. */
interface FreshCase {
	readonly shape: Shape
	readonly counts: ReadonlyArray<number>
	readonly transport: BoxTransport
}

const freshGen: Gen<FreshCase> = (source) => ({
	shape: source.draw(element(SHAPES)),
	counts: source.draw(array(int(0, FRESH_MEMBERS), FRESH_OWNERS)),
	transport: source.draw(element(BOX_TRANSPORTS))
})

/** Fresh owners' families, member numbers from 0 across the owners in order. */
const freshFamilies = (counts: ReadonlyArray<number>): Families => {
	let next = 0
	return Arr.map(counts, (n, owner) => {
		const members = Arr.map(indices(n), (i) => next + i)
		next += n
		return { owner, members }
	})
}

type FreshFeature =
	| "an empty family"
	| "several owners"
	| "a statement kind cut"
	| "the count mutant refused"

describe("the family write planner under owners the ChangeSet inserts", () => {
	it.effect(
		"places every fresh owner's family in insert statements alone, every member copying the count its owner's own insert wrote, and commits to exactly that family",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/family/fresh",
						generator: freshGen,
						literal: Formatter.format,
						limit: 2_000,
						coverage: requiredInSpace<FreshFeature>([
							"an empty family",
							"several owners",
							"a statement kind cut",
							"the count mutant refused"
						]),
						caseHang,
						box: "one to three fresh owners of zero to four members each, ordered or counted, under two transports",
						oracle: {
							kind: "second-implementation",
							name: "F7's family model (test/support/families/mutate.ts run), PostgreSQL's verdict as it predicts it"
						}
					},
					(box, c) =>
						Effect.sync(() => {
							const after = freshFamilies(box.counts)
							const write: FamilyWrite = ((): FamilyWrite => {
								const rewrites = Arr.map(after, (f): Rewrite => ({
									owner: ownerTexts(f.owner),
									kept: 0,
									dropped: 0,
									suffix: Arr.map(f.members, (m) => memberTexts(BOX_PADS, m)),
									count: { kind: "inserted" }
								}))
								return box.shape === "ordered"
									? { kind: "ordered", rewrites }
									: {
											kind: "counted",
											rewrites: Arr.map(rewrites, (r): CountedRewrite => ({ ...r, refills: [] }))
										}
							})()
							const transport = transportOf(box.transport)
							const planned = succeeded(plan(write, transport), "every row of the box fits alone")
							const [deletes, counts, inserts] = planned
							assert.equal(
								deletes.length + counts.length,
								0,
								"a fresh family sends no delete and no count"
							)
							const created: ReadonlyArray<Statement> = Arr.map(after, (f) => ({
								kind: "create",
								owner: f.owner,
								count: f.members.length
							}))
							const placed = Arr.map(inserts, (st) => readOf(BOX_PADS)(st))
							const sent = [...created, ...modelled([], placed)]
							assert.deepEqual(
								run(box.shape, [], sent),
								{ kind: "committed", after: Arr.filter(after, () => true) },
								"the owners' inserts and the family's commit to exactly the families written"
							)
							judgeTransport(planned, transport, () => c.note("a statement kind cut"))
							const mutant: ReadonlyArray<Statement> = [
								...Arr.map(after, (f) => ({ kind: "create" as const, owner: f.owner, count: 0 })),
								...modelled([], placed)
							]
							if (Arr.some(after, (f) => f.members.length > 0)) {
								assert.ok(
									run(box.shape, [], mutant).kind === "refused",
									"owners inserted with no count and members copying their final count are refused"
								)
								c.note("the count mutant refused")
							}
							if (Arr.some(after, (f) => f.members.length === 0)) {
								c.note("an empty family")
							}
							if (after.length > 1) {
								c.note("several owners")
							}
						})
				)
			)
	)
})

/** A plan whose statements are tagged by family and slot, as the composer reads them: its kind's rows are markers. */
interface Tagged {
	readonly family: string
	readonly depth: number
	readonly plan: Plan
}

const marker = (family: string, kind: string, i: number): Owner => [`${family}.${kind}.${i}`]

/** A plan of `d` deletes, `n` counts and `k` inserts, each statement one marker row. */
const markedPlan = (family: string, d: number, n: number, k: number): Plan => [
	Arr.map(indices(d), (i) => ({
		kind: "delete" as const,
		rows: [{ owner: marker(family, "delete", i), from: 0, to: 1 }] as const
	})),
	Arr.map(indices(n), (i) => ({
		kind: "count" as const,
		rows: [{ owner: marker(family, "count", i), count: 0, ends: [] }] as const
	})),
	Arr.map(indices(k), (i) => ({
		kind: "insert" as const,
		rows: [{ owner: marker(family, "insert", i), at: 0, copy: 1, member: [] }] as const
	}))
]

const taggedGen: Gen<ReadonlyArray<Tagged>> = (source) =>
	Arr.map(indices(source.draw(int(1, 3))), (f) => ({
		family: `f${f}`,
		depth: source.draw(int(1, 3)),
		plan: markedPlan(
			`f${f}`,
			source.draw(int(0, 2)),
			source.draw(int(0, 1)),
			source.draw(int(0, 1))
		)
	}))

/** A composed statement's family and its own position, read off its marker. */
const markOf = (statement: FamilyStatement): readonly [string, string, number] => {
	const text = defined(textsOf(statement)[0]?.[0], "a marked row")
	const [family, kind, i] = Str.split(text, ".")
	return [defined(family, "family"), defined(kind, "kind"), Number(i)]
}

describe("the composer of a ChangeSet's family plans", () => {
	it.effect(
		"sends every delete deepest first, then every count, then every insert shallowest first, each plan's own order kept",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/family/compose",
						generator: taggedGen,
						literal: Formatter.format,
						limit: 60_000,
						coverage: requiredInSpace<"two depths" | "one depth twice">([
							"two depths",
							"one depth twice"
						]),
						caseHang,
						box: "one to three plans at depths 1 to 3, each of up to two deletes, one count and one insert",
						oracle: {
							kind: "specification",
							name: "compose's order (w4-w7 §3.10, G1's hand-off 6)"
						}
					},
					(plans, c) =>
						Effect.sync(() => {
							const input: ReadonlyArray<FamilyPlan<string>> = plans
							const [deletes, counts, inserts] = compose(input)
							const depthOf = new Map(Arr.map(plans, (p) => [p.family, p.depth] as const))
							const phases = [
								{ sent: deletes, kind: "delete", order: -1 },
								{ sent: counts, kind: "count", order: -1 },
								{ sent: inserts, kind: "insert", order: 1 }
							] as const
							for (const { sent, kind, order } of phases) {
								assert.equal(
									sent.length,
									Arr.reduce(
										plans,
										0,
										(n, p) =>
											n +
											(kind === "delete" ? p.plan[0] : kind === "count" ? p.plan[1] : p.plan[2])
												.length
									),
									`every ${kind} of every plan is sent once`
								)
								const marks = Arr.map(sent, (x) => {
									const [family, k, i] = markOf(x.statement)
									assert.equal(family, x.family, "a statement is tagged with its own family")
									assert.equal(k, kind, `the ${kind} phase holds ${kind} statements alone`)
									return { family, i, depth: defined(depthOf.get(family), "a planned family") }
								})
								for (const [j, mark] of marks.entries()) {
									const prior = marks[j - 1]
									if (prior === undefined) {
										continue
									}
									assert.ok(
										(mark.depth - prior.depth) * order >= 0,
										`${kind}s go ${order < 0 ? "deepest" : "shallowest"} first`
									)
									if (prior.family === mark.family) {
										assert.ok(prior.i < mark.i, "a plan's own statements keep their order")
									}
								}
							}
							if (new Set(Arr.map(plans, (p) => p.depth)).size > 1) {
								c.note("two depths")
							}
							if (new Set(Arr.map(plans, (p) => p.depth)).size < plans.length) {
								c.note("one depth twice")
							}
						})
				)
			)
	)
})
