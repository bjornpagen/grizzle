/** What the properties of codes.test.ts read: its spaces, models and helpers. */

import { sameOrder } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import { type DeclaredName, parseDeclaredName } from "#compiler/core/identity.ts"
import type { CodeSlot } from "#compiler/ir/cells.ts"
import {
	type Codebook,
	codecOf,
	codeNames,
	codeOf,
	draftCodebook,
	emptyCodebook,
	firstCodebook,
	handleAt,
	keptRosters,
	noRenames,
	reorderRefusal,
	type RosterRenames
} from "#compiler/ir/codes.ts"
import { noSpellings } from "#compiler/ir/pattern.ts"
import { Roster, type RosterOrder } from "#compiler/ir/scalar.ts"
import { failed, succeeded, throwsDefect } from "#test/support/assert.ts"

/**
 * The first of `rosters` whose codes `book` does not hold exactly as its live handles, an ordered roster's in declared
 * order and an unordered one's in any, none when the book serves them all.
 */
const unservedRoster = (book: Codebook, rosters: ReadonlyArray<Roster>): Option.Option<Roster> =>
	Arr.findFirst(rosters, (roster) => {
		const codec = book.rosters.get(roster.closed)
		if (codec === undefined) {
			return true
		}
		const held = Arr.filter(codec.names, (name) => name !== "")
		return !sameOrder(
			roster.order === "ordered" ? held : Arr.sort(held, Order.String),
			roster.order === "ordered" ? roster.handles : Arr.sort(roster.handles, Order.String)
		)
	})

/** The names a roster's handles are drawn from: at most four handles are ever minted. */
const pool = ["a", "b", "c", "d"] as const

/**
 * The two rosters of the box, which share the names of the pool, so a rename reaching the wrong one is seen: Kind,
 * ordered, and Mark, unordered, whose declaration lists its handles in an order no code follows.
 */
const rosterNames: readonly [DeclaredName, DeclaredName] = [
	succeeded(parseDeclaredName("Kind")),
	succeeded(parseDeclaredName("Mark"))
]

/** Each roster's order, by its index in the box. */
const rosterOrdersOf: readonly [RosterOrder, RosterOrder] = ["ordered", "unordered"]

/** One roster in the model: each code's holder in code order, a hole undefined, and every name it ever held. */
interface Model {
	readonly slots: ReadonlyArray<string | undefined>
	readonly used: ReadonlySet<string>
}

/** A command of a history, on roster `roster` of the box. */
export type Command =
	| { readonly kind: "grow"; readonly roster: 0 | 1 }
	| { readonly kind: "remove"; readonly roster: 0 | 1; readonly handle: string }
	| { readonly kind: "readd"; readonly roster: 0 | 1; readonly handle: string }
	| { readonly kind: "rename"; readonly roster: 0 | 1; readonly handle: string }
	| { readonly kind: "reorder"; readonly roster: 0 | 1; readonly at: number }

/**
 * What a history reached: each command, an unordered roster's reorder and an unordered roster whose codes run out of
 * its handles' order, a hole between live codes, and both rosters changed.
 */
export type Situation =
	| "a growth"
	| "a removal"
	| "a re-add"
	| "a rename"
	| "a reorder"
	| "an unordered roster reordered"
	| "an unordered roster's codes out of its handles' order"
	| "a hole between live codes"
	| "both rosters changed"

/** The roster's live handles, in code order. */
const live = (model: Model): ReadonlyArray<string> =>
	Arr.filter(model.slots, (slot): slot is string => slot !== undefined)

/** The name the pool has not yet given the roster, if any: a growth's and a rename's new handle. */
const freshName = (model: Model): string | undefined =>
	Option.getOrUndefined(Arr.findFirst(pool, (name) => !model.used.has(name)))

/** Every command the roster's model admits, in a fixed order, so the box is enumerated exactly. */
const commandsOf = (model: Model, roster: 0 | 1): ReadonlyArray<Command> => {
	const holders = live(model)
	const fresh = freshName(model)
	return [
		...(fresh === undefined ? [] : [{ kind: "grow", roster } as const]),
		...(holders.length > 1
			? Arr.map(holders, (handle) => ({ kind: "remove", roster, handle }) as const)
			: []),
		...Arr.map(
			Arr.filter(Arr.sort([...model.used], Order.String), (name) => !holders.includes(name)),
			(handle) => ({ kind: "readd", roster, handle }) as const
		),
		...(fresh === undefined
			? []
			: Arr.map(holders, (handle) => ({ kind: "rename", roster, handle }) as const)),
		...Array.from(
			{ length: holders.length - 1 },
			(_, at) => ({ kind: "reorder", roster, at }) as const
		)
	]
}

/** The model of a roster declared with its first handle. */
const start: Model = { slots: ["a"], used: new Set(["a"]) }

/**
 * Every history of up to five commands over the box's two rosters: before each command, the history stops or goes on,
 * then names its roster and one of the commands that roster's state admits. An ordered roster's reorder is refused, so
 * a history ends with it; an unordered roster's holds its codes, and the history goes on.
 */
export const histories: Gen<ReadonlyArray<Command>> = (s) => {
	const models: [Model, Model] = [start, start]
	const history: Array<Command> = []
	for (let step = 0; step < 5; step += 1) {
		if (s.draw(int(0, 1)) === 0) {
			break
		}
		const roster = s.draw(int(0, 1)) === 0 ? 0 : 1
		const commands = commandsOf(models[roster], roster)
		const command = defined(commands[s.draw(int(0, commands.length - 1))])
		history.push(command)
		if (command.kind === "reorder") {
			if (rosterOrdersOf[roster] === "ordered") {
				break
			}
			continue
		}
		models[roster] = applied(models[roster], command)
	}
	return history
}

/** The model after `command`, which is no reorder. */
const applied = (model: Model, command: Exclude<Command, { readonly kind: "reorder" }>): Model => {
	switch (command.kind) {
		case "grow": {
			const name = defined(freshName(model))
			return { slots: [...model.slots, name], used: new Set([...model.used, name]) }
		}
		case "remove":
			return {
				slots: Arr.map(model.slots, (slot) => (slot === command.handle ? undefined : slot)),
				used: model.used
			}
		case "readd":
			return { slots: [...model.slots, command.handle], used: model.used }
		case "rename": {
			const name = defined(freshName(model))
			return {
				slots: Arr.map(model.slots, (slot) => (slot === command.handle ? name : slot)),
				used: new Set([...model.used, name])
			}
		}
	}
}

/**
 * The roster at `index` of the box declaring `handles`: an ordered one's in code order, which is declared order, and
 * an unordered one's in any.
 */
const rosterOf = (index: 0 | 1, handles: ReadonlyArray<string>): Roster =>
	Roster.of(rosterNames[index], rosterOrdersOf[index], nonEmpty(handles))

/** The code slots a model's roster holds: each live handle, and a hole where a handle was removed. */
const slotsOf = (model: Model): ReadonlyArray<CodeSlot> =>
	Arr.map(model.slots, (slot): CodeSlot =>
		slot === undefined ? { kind: "hole" } : { kind: "live", handle: slot }
	)

/** Every codec of `book` against the models: codes, size, names, both round trips, and the names a decoder reads. */
const agrees = (book: Codebook, models: readonly [Model, Model]): void => {
	const names = codeNames(book)
	for (const [index, model] of models.entries()) {
		const closed = defined(rosterNames[index])
		const codec = codecOf(book, rosterOf(index === 0 ? 0 : 1, live(model)))
		assert.deepEqual(codec.codes, slotsOf(model), `${closed}'s codes`)
		assert.equal(codec.size, model.slots.length, `${closed}'s size counts every code minted`)
		assert.deepEqual(
			codec.names,
			Arr.map(model.slots, (slot) => slot ?? ""),
			`${closed}'s names, a hole the empty name`
		)
		assert.deepEqual(names(closed), codec.names, `${closed}'s names as a decoder binds them`)
		for (const handle of live(model)) {
			assert.equal(handleAt(codec, codeOf(codec, handle)), handle, `${handle} round-trips`)
		}
		for (const [code, slot] of model.slots.entries()) {
			if (slot === undefined) {
				throwsDefect(() => handleAt(codec, code), `code ${code} is a hole`)
			} else {
				assert.equal(codeOf(codec, handleAt(codec, code)), code, `code ${code} round-trips`)
			}
		}
		throwsDefect(() => handleAt(codec, model.slots.length), "a code past the roster")
		for (const name of pool) {
			if (!live(model).includes(name)) {
				throwsDefect(() => codeOf(codec, name), `${name} is no live handle`)
			}
		}
	}
}

/**
 * Each draft of a history holds exactly the model's codes for both rosters, its renames reaching only the roster they
 * are declared for; each codec round-trips; drafting again with no rename changes nothing; and a reorder is refused
 * with the swapped pair, at its roster.
 */
export const replay = (history: ReadonlyArray<Command>, c: Case<Situation>) =>
	Effect.sync(() => {
		const models: [Model, Model] = [start, start]
		const rosters = (): ReadonlyArray<Roster> => [
			rosterOf(0, live(models[0])),
			rosterOf(1, live(models[1]))
		]
		let book = firstCodebook(rosters())
		agrees(book, models)
		const changed = new Set<0 | 1>()
		for (const command of history) {
			const model = models[command.roster]
			const closed = rosterNames[command.roster]
			if (command.kind === "reorder") {
				const holders = live(model)
				const earlier = defined(holders[command.at + 1])
				const later = defined(holders[command.at])
				const declared = Arr.map(holders, (handle, at) =>
					at === command.at ? earlier : at === command.at + 1 ? later : handle
				)
				const others = Arr.map(rosters(), (r) =>
					r.closed === closed ? rosterOf(command.roster, declared) : r
				)
				if (rosterOrdersOf[command.roster] === "unordered") {
					const held = succeeded(draftCodebook(keptRosters(book), noRenames, others, noSpellings))
					agrees(held, models)
					c.note("an unordered roster reordered")
					continue
				}
				const refused = failed(draftCodebook(keptRosters(book), noRenames, others, noSpellings))
				assert.deepEqual(refused, { roster: closed, earlier, later })
				const error = reorderRefusal(refused)
				assert.equal(error.reason._tag, "UnsupportedOperation")
				assert.equal(
					Option.getOrUndefined(Option.map(unservedRoster(book, others), (r) => r.closed)),
					closed,
					"a reordered roster is unserved"
				)
				c.note("a reorder")
				return
			}
			const renames: RosterRenames =
				command.kind === "rename"
					? new Map([[closed, new Map([[command.handle, defined(freshName(model))]])]])
					: noRenames
			models[command.roster] = applied(model, command)
			changed.add(command.roster)
			book = succeeded(draftCodebook(keptRosters(book), renames, rosters(), noSpellings))
			agrees(book, models)
			const again = succeeded(draftCodebook(keptRosters(book), noRenames, rosters(), noSpellings))
			for (const roster of rosters()) {
				assert.deepEqual(codecOf(again, roster).codes, codecOf(book, roster).codes, "idempotent")
			}
			assert.ok(Option.isNone(unservedRoster(book, rosters())), "the draft serves its rosters")
			c.note(
				command.kind === "grow"
					? "a growth"
					: command.kind === "remove"
						? "a removal"
						: command.kind === "readd"
							? "a re-add"
							: "a rename"
			)
			if (!sameOrder(live(models[1]), Arr.sort(live(models[1]), Order.String))) {
				c.note("an unordered roster's codes out of its handles' order")
			}
			if (
				Arr.some(models, (m) =>
					Arr.some(
						m.slots,
						(slot, code) =>
							slot === undefined &&
							code > 0 &&
							Arr.some(Arr.drop(m.slots, code), (s) => s !== undefined)
					)
				)
			) {
				c.note("a hole between live codes")
			}
		}
		if (changed.size === 2) {
			c.note("both rosters changed")
		}
		const [kept, dropped] = rosters()
		const without = succeeded(
			draftCodebook(keptRosters(book), noRenames, [defined(kept)], noSpellings)
		)
		throwsDefect(() => codecOf(without, defined(dropped)), "a roster the draft lacks leaves")
		throwsDefect(() => codeNames(emptyCodebook)(defined(kept).closed), "no roster in no codebook")
	})
