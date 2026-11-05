/**
 * Rosters with holes and growth, built by construction, and the named invalid codes, handles and declarations that a
 * roster's codec, domain and draft must refuse.
 *
 * A roster's codes are history. A handle keeps its code across every migration; a removed handle leaves a hole that no
 * handle takes again; a new handle, or a removed name declared again, takes the next code past every code minted. This
 * module keeps that history naively, as a list of slots replayed command by command, and shares no code with the
 * engine's `rosterCodes` or `draftCodebook`, so a suite judges them by it: a second implementation (testing doctrine,
 * rule 3).
 *
 * - **Valid by construction (rule 4).** A history is an installation followed by a program of migrations that the
 *   model accepts: growth, a removal (which leaves a hole) and the re-addition of a removed name. Every step's command
 *   applies only where the harness can write it, and none is filtered.
 * - **Holes weighted up.** A removal weighs three times a growth, because a lowering that writes a handle's declared
 *   position instead of its code agrees with the codes on every roster without a hole. The swarm is drawn per case
 *   (rule 7), with the library's forced feature guarding the all-off draw.
 * - **The named invalid variants (rule 6):** a code below 0, the code one past the greatest minted, a removed handle's
 *   code, the mixed-radix alias 400, a removed handle by name, a handle the roster never held, and a reorder, which a
 *   draft refuses naming the pair it puts out of order (D1).
 * - **Features (rule 8):** a literal's (hole count, literal) pair, where a literal is aligned when its code is its
 *   declared position and shifted when a hole before it moves its code past its position.
 *
 * Handles are drawn from a pool of names in a drawn order, so a handle's spelling says nothing of its code. The awkward
 * spellings are what an array literal, an identifier or a name's byte bound must quote or keep: `NULL`, a comma, a
 * quote, a backslash, braces, spaces, a multibyte name of exactly `handleMaxBytes` bytes.
 */
import {
	accepted,
	type Machine,
	type Program,
	program,
	refused,
	type Step,
	type Verdict
} from "@grizzle/testing/commands"
import type { Reached } from "@grizzle/testing/features"
import { element, type Gen, int, type Size, subset } from "@grizzle/testing/gen"
import { type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { Array as Arr, Option, String as Str } from "effect"
import { type DeclaredName, parseDeclaredName } from "#compiler/core/identity.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { CodeSlot, RosterCodes } from "#compiler/ir/cells.ts"
import { type Codebook, rosterCodec, type RosterCodec } from "#compiler/ir/codes.ts"
import type { Roster } from "#compiler/ir/scalar.ts"

/** How a handle is spelled: a plain word, or a spelling an array literal, an identifier or a byte bound must keep. */
const SPELLINGS = ["plain", "awkward"] as const

export type RosterSpelling = (typeof SPELLINGS)[number]

/** Plain handles, none a prefix of another's code or position. */
const PLAIN = [
	"Open",
	"Done",
	"Held",
	"Gone",
	"Late",
	"Kept",
	"Lost",
	"Next",
	"Rare",
	"Wild",
	"Calm",
	"Bold"
] as const

/**
 * Handles every layer that spells a name must keep: an array literal reads `NULL` unquoted as no value and splits at a
 * comma or brace; a quote, a backslash and spaces at either end must survive quoting; the last is exactly
 * `handleMaxBytes` (63) UTF-8 bytes, a multibyte name a name type would clip one byte later.
 */
const AWKWARD = [
	"NULL",
	"a,b",
	'say "hi"',
	"back\\slash",
	"{brace}",
	" lead",
	"trail ",
	"it's",
	"ünïcödé",
	`${Str.repeat(31)("é")}x`
] as const

const POOLS: Readonly<Record<RosterSpelling, ReadonlyArray<string>>> = { plain: PLAIN, awkward: AWKWARD }

/** Roster names, each a declared name the naming door admits. */
const ROSTER_NAMES = ["Kind", "Tier", "Tone", "Phase", "Stage", "Mood"] as const

/** A roster name of the pool, parsed by the naming door's rule; one it refuses is a defect of the pool. */
const declared = (name: string): DeclaredName => {
	const parsed = parseDeclaredName(name)
	if (!parsed.ok) {
		throw new Error(
			`the roster pool holds the name "${name}", which the naming door refuses: ${parsed.error}`
		)
	}
	return parsed.value
}

/**
 * One code of the model: the live handle it names, or the hole a removed handle left, with the name it last held, which
 * the hole never names again.
 */
export type ModelSlot =
	| { readonly kind: "live"; readonly handle: string }
	| { readonly kind: "hole"; readonly was: string }

/**
 * A roster as the model holds it: code c at position c, so the length is the next code. `spellings` are the spellings
 * its new names are drawn from.
 */
export interface RosterState {
	readonly closed: DeclaredName
	readonly slots: NonEmptyReadonlyArray<ModelSlot>
	readonly spellings: Swarm<RosterSpelling>
}

/** A roster's declaration: its handles in declared order, which a valid one keeps in their codes' order (D1). */
export type Declaration = NonEmptyReadonlyArray<string>

/** The migrations a valid history draws: each one a roster declaration the model accepts. */
const MIGRATIONS = ["grow", "remove", "readd"] as const

type Migration = (typeof MIGRATIONS)[number]

/** A roster's history: its installation's declaration, then each migration with the declaration it leads to. */
export interface RosterHistory {
	readonly installed: RosterState
	readonly program: Program<RosterParameters>
	readonly declarations: NonEmptyReadonlyArray<Declaration>
	readonly state: RosterState
}

/** How large a drawn roster is: the handles its installation declares, and the migrations after it. */
export interface RosterSpace {
	readonly handles: Size
	readonly migrations: Size
}

/** The live handles in code order, which a valid declaration declares them in. */
export const liveOf = (state: RosterState): Declaration => {
	const live = Arr.flatMap(state.slots, (slot) => (slot.kind === "live" ? [slot.handle] : []))
	if (!Arr.isReadonlyArrayNonEmpty(live)) {
		throw new Error(`the model keeps one live handle of roster ${state.closed} at least`)
	}
	return live
}

/** The codes of the holes, ascending. */
export const holesOf = (state: RosterState): ReadonlyArray<number> =>
	Arr.flatMap(state.slots, (slot, code) => (slot.kind === "hole" ? [code] : []))

/** Every code minted, holes included: n of a set's bit(n), and one past the greatest code the domain admits. */
export const sizeOf = (state: RosterState): number => state.slots.length

/** The code a live handle holds, or undefined when the roster holds it live nowhere. */
export const codeAt = (state: RosterState, handle: string): number | undefined =>
	Option.getOrUndefined(
		Arr.findFirstIndex(state.slots, (slot) => slot.kind === "live" && slot.handle === handle)
	)

/** The codes as an installation records them (ir/cells.ts RosterCodes): the shape a codebook is built from. */
export const codesOf = (state: RosterState): RosterCodes =>
	Arr.map(state.slots, (slot): CodeSlot =>
		slot.kind === "live" ? { kind: "live", handle: slot.handle } : { kind: "hole" }
	)

/** The roster as a closed id's type holds it: its name and its live handles in code order. */
export const rosterOf = (state: RosterState): Roster => ({
	closed: state.closed,
	handles: liveOf(state)
})

/** The codec of the model's codes, built by the engine's constructor, which only packages them. */
export const codecFor = (state: RosterState): RosterCodec =>
	rosterCodec(state.closed, codesOf(state))

/** The codebook of several rosters' codes, by roster name. */
export const codebookOfStates = (states: ReadonlyArray<RosterState>): Codebook => ({
	rosters: new Map(Arr.map(states, (state) => [state.closed, codecFor(state)] as const))
})

/** Every name the slots have held, live or removed: a new name is none of them. */
const heldNames = (slots: ReadonlyArray<ModelSlot>): ReadonlySet<string> =>
	new Set(Arr.map(slots, (slot) => (slot.kind === "live" ? slot.handle : slot.was)))

/** The names a removed handle held that no live handle holds now: what a re-addition may declare again. */
const removedOf = (state: RosterState): ReadonlyArray<string> => {
	const live = new Set(liveOf(state))
	return Arr.dedupe(
		Arr.flatMap(state.slots, (slot) =>
			slot.kind === "hole" && !live.has(slot.was) ? [slot.was] : []
		)
	)
}

/** The names of `spelling` that the slots have never held. */
const unheldOf = (slots: ReadonlyArray<ModelSlot>, spelling: RosterSpelling): ReadonlyArray<string> => {
	const held = heldNames(slots)
	return Arr.filter(POOLS[spelling], (name) => !held.has(name))
}

/** One of `names`, the first being where it shrinks. */
const oneOf = (names: ReadonlyArray<string>, what: string): Gen<string> => {
	if (!Arr.isReadonlyArrayNonEmpty(names)) {
		throw new Error(`the harness draws ${what} only where one exists`)
	}
	return element(names)
}

/**
 * A name the slots have never held, in a spelling the case's swarm turns on, or in the other when that one is spent.
 */
const freshName =
	(slots: ReadonlyArray<ModelSlot>, spellings: Swarm<RosterSpelling>): Gen<string> =>
	(source) => {
		const spelling = source.draw(swarmChoice(spellings, SPELLINGS))
		const preferred = unheldOf(slots, spelling)
		return source.draw(
			oneOf(
				preferred.length > 0
					? preferred
					: unheldOf(slots, spelling === "plain" ? "awkward" : "plain"),
				"a fresh name"
			)
		)
	}

/** Whether a name the roster has never held is left. */
const hasFresh = (state: RosterState): boolean =>
	unheldOf(state.slots, "plain").length + unheldOf(state.slots, "awkward").length > 0

/** The state after `handle` is appended: it takes the next code. */
const appended = (state: RosterState, handle: string): RosterState => ({
	...state,
	slots: [...state.slots, { kind: "live", handle }]
})

/** The state after `handle` is removed: its code becomes a hole that remembers it. */
const removed = (state: RosterState, handle: string): RosterState => ({
	...state,
	slots: Arr.map(state.slots, (slot): ModelSlot =>
		slot.kind === "live" && slot.handle === handle ? { kind: "hole", was: handle } : slot
	)
})

/** The parameters of each command of the roster machine. */
export interface RosterParameters {
	/** A name the roster never held, appended. */
	readonly grow: { readonly handle: string }
	/** A live handle, left out of the declaration, so its code becomes a hole. */
	readonly remove: { readonly handle: string }
	/** A removed name declared again, at the end: it takes a new code, never its old one. */
	readonly readd: { readonly handle: string }
	/** Two live handles' declared positions, `first` before `second`, swapped: refused (D1). */
	readonly reorder: { readonly first: number; readonly second: number }
}

/** The one refusal a roster declaration meets: handles out of their codes' order. */
const ROSTER_REFUSALS = ["reordered"] as const

export type RosterRefusal = (typeof ROSTER_REFUSALS)[number]

/**
 * The declaration a step leads to from `state`: the live handles in code order, less a removed one, with a new or
 * re-added name at the end, or with two of them swapped.
 */
export const declarationOf = (state: RosterState, step: Step<RosterParameters>): Declaration => {
	const live = liveOf(state)
	switch (step.command) {
		case "grow":
		case "readd":
			return [...live, step.parameters.handle]
		case "remove": {
			const kept = Arr.filter(live, (handle) => handle !== step.parameters.handle)
			if (!Arr.isReadonlyArrayNonEmpty(kept)) {
				throw new Error("the harness removes a handle only while another stays live")
			}
			return kept
		}
		case "reorder": {
			const { first, second } = step.parameters
			return Arr.map(live, (handle, at) =>
				at === first
					? Arr.getUnsafe(live, second)
					: at === second
						? Arr.getUnsafe(live, first)
						: handle
			)
		}
	}
}

/**
 * The pair a declaration puts out of its codes' order, as the model reads it: each declared handle claims its live code
 * or, held live nowhere, the next code minted; the first claim lower than the claim declared just before it is refused,
 * with the handle declared before it as `earlier` (D1's sentence names both). Undefined when the declaration keeps the
 * order.
 */
export const reorderedPair = (
	state: RosterState,
	declaration: Declaration
): { readonly earlier: string; readonly later: string } | undefined => {
	let minted = sizeOf(state)
	let before: { readonly handle: string; readonly code: number } | undefined
	for (const handle of declaration) {
		const live = codeAt(state, handle)
		const code = live ?? minted
		if (live === undefined) {
			minted += 1
		}
		if (before !== undefined && code < before.code) {
			return { earlier: before.handle, later: handle }
		}
		before = { handle, code }
	}
	return undefined
}

/** Two distinct positions of `n`, the first before the second, drawn so every pair is one draw. */
const positionPair =
	(n: number): Gen<RosterParameters["reorder"]> =>
	(source) => {
		const first = source.draw(int(0, n - 2))
		const second = source.draw(int(first + 1, n - 1))
		return { first, second }
	}

/**
 * The roster machine: a roster installed as `installed`, then declarations the model judges.
 * - `grow` appends a name the roster never held; it applies while one is left in the pools.
 * - `remove` leaves a live handle out; it applies while two are live, since a roster holds one at least. It weighs three
 *   times a growth, so most programs leave holes.
 * - `readd` declares a removed name again at the end, where it takes a new code; it applies while a removed name is
 *   not live.
 * - `reorder` swaps two live handles, and the model refuses it with `reordered`: no state changes.
 */
export const rosterMachine = (
	installed: RosterState
): Machine<RosterState, RosterParameters, RosterRefusal> => ({
	initial: installed,
	commands: {
		grow: {
			weight: 1,
			applies: hasFresh,
			parameters: (state) => (source) => ({
				handle: source.draw(freshName(state.slots, state.spellings))
			}),
			judge: (state, { handle }): Verdict<RosterState, RosterRefusal> =>
				accepted(appended(state, handle))
		},
		remove: {
			weight: 3,
			applies: (state) => liveOf(state).length > 1,
			parameters: (state) => (source) => ({
				handle: source.draw(oneOf(liveOf(state), "a live handle"))
			}),
			judge: (state, { handle }) => accepted(removed(state, handle))
		},
		readd: {
			weight: 1,
			applies: (state) => removedOf(state).length > 0,
			parameters: (state) => (source) => ({
				handle: source.draw(oneOf(removedOf(state), "a removed name"))
			}),
			judge: (state, { handle }) => accepted(appended(state, handle))
		},
		reorder: {
			weight: 1,
			applies: (state) => liveOf(state).length > 1,
			parameters: (state) => positionPair(liveOf(state).length),
			judge: () => refused("reordered")
		}
	}
})

/** The roster machine's commands that a valid history draws: every one but the reorder. */
const validCommands: NonEmptyReadonlyArray<Migration> = MIGRATIONS

/** A roster named `closed`, installed with drawn handles in spellings the case's swarm turns on. */
export const installedGen =
	(closed: DeclaredName, handles: Size): Gen<RosterState> =>
	(source) => {
		const spellings = source.draw(swarm(SPELLINGS))
		const count = source.draw(int(Math.max(1, handles.min), handles.max))
		const slots: Array<ModelSlot> = []
		for (let at = 0; at < count; at += 1) {
			slots.push({ kind: "live", handle: source.draw(freshName(slots, spellings)) })
		}
		if (!Arr.isReadonlyArrayNonEmpty(slots)) {
			throw new Error("an installation declares one handle at least")
		}
		return { closed, slots, spellings }
	}

/**
 * The state each step of `steps` leads to, from `installed`: the model's own replay, a refused step leaving the state as
 * it was.
 */
const replay = (
	installed: RosterState,
	steps: Program<RosterParameters>
): NonEmptyReadonlyArray<RosterState> => {
	const machine = rosterMachine(installed)
	let state = installed
	const after = Arr.map(steps, (step) => {
		const verdict = judged(machine, state, step)
		if (verdict.kind === "accepted") {
			state = verdict.next
		}
		return state
	})
	return [installed, ...after]
}

/** The machine's verdict on one step. */
const judged = (
	machine: Machine<RosterState, RosterParameters, RosterRefusal>,
	state: RosterState,
	step: Step<RosterParameters>
): Verdict<RosterState, RosterRefusal> => {
	switch (step.command) {
		case "grow":
			return machine.commands.grow.judge(state, step.parameters)
		case "remove":
			return machine.commands.remove.judge(state, step.parameters)
		case "readd":
			return machine.commands.readd.judge(state, step.parameters)
		case "reorder":
			return machine.commands.reorder.judge(state, step.parameters)
	}
}

/**
 * Each declaration a history makes: the installation's, then each step's, written from the step and the state before
 * it (declarationOf), never read back off the state the model reaches, so a system that declares what a step says
 * meets the model's codes only if the model judged the step as the declaration means it.
 */
const declarationsOf = (
	installed: RosterState,
	steps: Program<RosterParameters>,
	states: NonEmptyReadonlyArray<RosterState>
): NonEmptyReadonlyArray<Declaration> => [
	liveOf(installed),
	...Arr.map(steps, (step, at) => declarationOf(Arr.getUnsafe(states, at), step))
]

/**
 * A roster's valid history: installed with `space.handles` handles, then `space.migrations` migrations the model
 * accepts, over the migrations a swarm drawn per case turns on, removals weighted up. Every state it passes through
 * keeps one live handle at least, and every declaration keeps its codes' order.
 */
export const historyGen =
	(closed: DeclaredName, space: RosterSpace): Gen<RosterHistory> =>
	(source) => {
		const installed = source.draw(installedGen(closed, space.handles))
		const drawn = source.draw(swarm(validCommands))
		const steps = source.draw(program(rosterMachine(installed), space.migrations, drawn))
		const states = replay(installed, steps)
		return {
			installed,
			program: steps,
			declarations: declarationsOf(installed, steps, states),
			state: Arr.lastNonEmpty(states)
		}
	}

/** Up to `count` rosters, each with its own valid history and a distinct name. */
export const historiesGen =
	(count: Size, space: RosterSpace): Gen<ReadonlyArray<RosterHistory>> =>
	(source) => {
		const names = source.draw(
			subset(ROSTER_NAMES, { min: count.min, max: Math.min(count.max, ROSTER_NAMES.length) })
		)
		return Arr.map(names, (name) => source.draw(historyGen(declared(name), space)))
	}

/**
 * Every hole pattern of a roster of `size` codes, as one draw: a mask in 1 … 2^size − 1, bit c set where code c is live,
 * so the patterns biject with the draws and an enumeration meets each exactly once (2^size − 1 cases), a roster always
 * holding one live code. Code c takes the c-th plain name, live or remembered by its hole, so the mask is the only
 * decision; a suite that must not let a name stand for its code draws histories instead. It shrinks toward the mask 1,
 * code 0 alone live. The pattern is reachable by a valid history: install every code, then remove the holes.
 */
export const patternGen =
	(closed: DeclaredName, size: number): Gen<RosterState> =>
	(source) => {
		if (size < 1 || size > PLAIN.length) {
			throw new Error(`a hole pattern spans 1 … ${PLAIN.length} codes, not ${size}`)
		}
		const mask = source.draw(int(1, 2 ** size - 1))
		const slots = Arr.map(Arr.take(PLAIN, size), (name, code): ModelSlot =>
			((mask >> code) & 1) === 1 ? { kind: "live", handle: name } : { kind: "hole", was: name }
		)
		if (!Arr.isReadonlyArrayNonEmpty(slots)) {
			throw new Error("a hole pattern has one code at least")
		}
		return { closed, slots, spellings: { plain: 3 } }
	}

/** The pattern's history: install every code's name in code order, then remove each hole's, in code order. */
export const patternHistory = (state: RosterState): RosterHistory => {
	const named = Arr.map(state.slots, (slot) => (slot.kind === "live" ? slot.handle : slot.was))
	if (!Arr.isReadonlyArrayNonEmpty(named)) {
		throw new Error("a hole pattern has one code at least")
	}
	const installed: RosterState = {
		...state,
		slots: Arr.map(named, (handle): ModelSlot => ({ kind: "live", handle }))
	}
	const steps: Program<RosterParameters> = Arr.flatMap(state.slots, (slot) =>
		slot.kind === "hole" ? [{ command: "remove", parameters: { handle: slot.was } } as const] : []
	)
	const states = replay(installed, steps)
	return {
		installed,
		program: steps,
		declarations: declarationsOf(installed, steps, states),
		state: Arr.lastNonEmpty(states)
	}
}

/** The alias the bar names: 400, as a mixed-radix digit read past its radix. */
export const ALIAS_CODE = 400

/**
 * What the roster's domain answers each code from −1 to `size`, then 400: the model "accepted exactly when live", the
 * handle it names when live. The small scope a direct writer's suite exhausts.
 */
export const everyCode = (
	state: RosterState
): ReadonlyArray<{ readonly code: number; readonly live: string | undefined }> => [
	...Arr.map(Arr.range(-1, sizeOf(state)), (code) => {
		const slot = state.slots[code]
		return { code, live: slot?.kind === "live" ? slot.handle : undefined }
	}),
	...(sizeOf(state) <= ALIAS_CODE ? [{ code: ALIAS_CODE, live: undefined }] : [])
]

/** Some of the roster's live handles, in code order: a bits value, the empty set included. */
export const liveSubsetGen = (state: RosterState): Gen<ReadonlyArray<string>> => {
	const live = liveOf(state)
	return subset(live, { min: 0, max: live.length })
}

/** A live handle of the roster: a handle literal. */
export const liveHandleGen = (state: RosterState): Gen<string> => element(liveOf(state))

/** The features of the roster rows a suite notes: how many holes, and whether a literal's code is its position. */
export type RosterFeature =
	| "holes 0"
	| "holes 1"
	| "holes 2+"
	| "literal aligned"
	| "literal shifted"

/** How many holes `state` has, in three buckets. */
export const holeFeature = (state: RosterState): RosterFeature => {
	const holes = holesOf(state).length
	return holes === 0 ? "holes 0" : holes === 1 ? "holes 1" : "holes 2+"
}

/**
 * A handle literal's feature, (hole count, literal): aligned when its code is its declared position, shifted when a
 * hole before it moved its code past it. A lowering that writes the declared position passes every aligned literal.
 */
export const literalFeature = (state: RosterState, handle: string): Reached<RosterFeature> => {
	const position = liveOf(state).indexOf(handle)
	const code = codeAt(state, handle)
	if (position < 0 || code === undefined) {
		throw new Error(`the harness names only live handles of roster ${state.closed}`)
	}
	return [holeFeature(state), code === position ? "literal aligned" : "literal shifted"]
}
