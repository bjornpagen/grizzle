/**
 * The codebook (ir/codes.ts): every roster's codes as an installation holds them, drafted from the previous
 * installation's, against a naive history model that shares no code with ir/cells.ts rosterCodes.
 *
 * - The model: each roster is the list of its codes' holders, code c at position c, a hole none, replayed command by
 *   command: a growth appends a new handle, a removal leaves its code a hole, a re-add of a removed name appends it as
 *   a new handle, a rename gives a live code a new holder, and a reorder declares two neighbours swapped, which the draft
 *   refuses with that pair. A command touches one roster alone, and the other roster's codes stay as they were, so a
 *   rename reaches only the roster it is declared for.
 * - Universal oracles: each codec round-trips (handleAt ∘ codeOf is the identity on live handles, codeOf ∘ handleAt on
 *   live codes), names a hole exactly where the model holds none, counts every code minted, and drafting a codebook again
 *   from itself with no rename is the identity.
 *
 * The box, exhausted: two rosters over the names a to d, each first declared as `a`, then every history of up to five
 * commands.
 *
 * Features: a growth, a removal, a re-add, a rename, a reorder, a hole between live codes, both rosters changed.
 *
 * Plants: ir-codes-size-live-only (a codec counts its live codes alone, not every code minted).
 */
import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { sameOrder } from "#compiler/core/array.ts"
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
import { Roster } from "#compiler/ir/scalar.ts"
import { assert, defined, failed, nonEmpty, succeeded, throwsDefect } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * The first of `rosters` whose codes `book` does not hold exactly as its live handles in declared order, none when the
 * book serves them all.
 */
const unservedRoster = (book: Codebook, rosters: ReadonlyArray<Roster>): Option.Option<Roster> =>
	Arr.findFirst(rosters, (roster) => {
		const codec = book.rosters.get(roster.closed)
		return (
			codec === undefined ||
			!sameOrder(
				Arr.filter(codec.names, (name) => name !== ""),
				roster.handles
			)
		)
	})

/** The names a roster's handles are drawn from: at most four handles are ever minted. */
const pool = ["a", "b", "c", "d"] as const

/** The two rosters of the box, which share the names of the pool, so a rename reaching the wrong one is seen. */
const rosterNames: readonly [DeclaredName, DeclaredName] = [
	succeeded(parseDeclaredName("Kind")),
	succeeded(parseDeclaredName("Mark"))
]

/** One roster in the model: each code's holder in code order, a hole undefined, and every name it ever held. */
interface Model {
	readonly slots: ReadonlyArray<string | undefined>
	readonly used: ReadonlySet<string>
}

/** A command of a history, on roster `roster` of the box. */
type Command =
	| { readonly kind: "grow"; readonly roster: 0 | 1 }
	| { readonly kind: "remove"; readonly roster: 0 | 1; readonly handle: string }
	| { readonly kind: "readd"; readonly roster: 0 | 1; readonly handle: string }
	| { readonly kind: "rename"; readonly roster: 0 | 1; readonly handle: string }
	| { readonly kind: "reorder"; readonly roster: 0 | 1; readonly at: number }

type Situation =
	| "a growth"
	| "a removal"
	| "a re-add"
	| "a rename"
	| "a reorder"
	| "a hole between live codes"
	| "both rosters changed"

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

const start: Model = { slots: ["a"], used: new Set(["a"]) }

/**
 * Every history of up to five commands over the box's two rosters: before each command, the history stops or goes on,
 * then names its roster and one of the commands that roster's state admits. A reorder is refused, so a history ends
 * with it.
 */
const histories: Gen<ReadonlyArray<Command>> = (s) => {
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
			break
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

/** The roster a model declares: its live handles in code order, which is declared order. */
const rosterOf = (closed: DeclaredName, handles: ReadonlyArray<string>): Roster =>
	Roster.of(closed, nonEmpty(handles))

const slotsOf = (model: Model): ReadonlyArray<CodeSlot> =>
	Arr.map(model.slots, (slot): CodeSlot =>
		slot === undefined ? { kind: "hole" } : { kind: "live", handle: slot }
	)

/** Every codec of `book` against the models: codes, size, names, both round trips, and the names a decoder reads. */
const agrees = (book: Codebook, models: readonly [Model, Model]): void => {
	const names = codeNames(book)
	for (const [index, model] of models.entries()) {
		const closed = defined(rosterNames[index])
		const codec = codecOf(book, rosterOf(closed, live(model)))
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
const replay = (history: ReadonlyArray<Command>, c: Case<Situation>) =>
	Effect.sync(() => {
		const models: [Model, Model] = [start, start]
		const rosters = (): ReadonlyArray<Roster> =>
			Arr.map(rosterNames, (closed, index) => rosterOf(closed, live(defined(models[index]))))
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
					r.closed === closed ? rosterOf(closed, declared) : r
				)
				const refused = failed(draftCodebook(keptRosters(book), noRenames, others))
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
			book = succeeded(draftCodebook(keptRosters(book), renames, rosters()))
			agrees(book, models)
			const again = succeeded(draftCodebook(keptRosters(book), noRenames, rosters()))
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
		const without = succeeded(draftCodebook(keptRosters(book), noRenames, [defined(kept)]))
		throwsDefect(() => codecOf(without, defined(dropped)), "a roster the draft lacks leaves")
		throwsDefect(() => codeNames(emptyCodebook)(defined(kept).closed), "no roster in no codebook")
	})

describe("the codebook", () => {
	it.effect(
		"drafts each roster's codes from its own history alone, round-trips every live code, and refuses a reorder",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/ir/codes-histories",
						generator: histories,
						literal: Formatter.format,
						coverage: requiredInSpace<Situation>([
							"a growth",
							"a removal",
							"a re-add",
							"a rename",
							"a reorder",
							"a hole between live codes",
							"both rosters changed"
						]),
						caseHang,
						box: "two rosters over four names, every history of up to five commands",
						oracle: { kind: "second-implementation", name: "a naive history model of each roster" },
						concurrency: 1
					},
					replay
				)
			)
	)
})
