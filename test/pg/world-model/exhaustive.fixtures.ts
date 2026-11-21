/** What the property of exhaustive.test.ts reads: the small box, its installations' templates and a case's world. */

import { finite } from "@bjornpagen/testing/gen"
import type { NeedFailed, Resources } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, type Scope } from "effect"
import { ordinarySession } from "#test/support/ambient.ts"
import { templateNeedBudget } from "#test/support/budgets.ts"
import type { SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import type { Taken } from "#test/support/worlds/drive/suite.ts"
import { type RealWorld, realize } from "#test/support/worlds/execute/index.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import type { RealizeRefused } from "#test/support/worlds/execute/refused.ts"
import { templateWorld, worldTemplate } from "#test/support/worlds/execute/template.ts"
import { featuresOf } from "#test/support/worlds/features.ts"
import { knownNonEmpty } from "#test/support/worlds/generate/domain.ts"
import {
	defaultScope,
	enumerateInstalls,
	enumerateRealities,
	exploreBox
} from "#test/support/worlds/generate/enumerate.ts"
import { hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { initialState } from "#test/support/worlds/model/step.ts"
import { textDomain } from "#test/support/worlds/model/text.ts"
import type {
	Action,
	BaseSpec,
	FieldDomain,
	HostState,
	InstallSpec,
	SmallScope
} from "#test/support/worlds/model/types.ts"

const uuid: FieldDomain = { kind: "uuid" }
const subject: FieldDomain = textDomain("^u_[a-z]{1,8}$", "u")

/**
 * The small box's base: teams, and the members of a team by user, each member's team a team (a containment), and one
 * context, Session { sub }, read from the token's top level. Two relations, one law, one context: the least base on
 * which a query entry can filter by a claim and write through it, and a law can refuse a write from inside a world.
 */
const teamsBase: BaseSpec = {
	name: "Teams",
	closed: [],
	relations: [
		{ name: "Team", fields: [{ name: "id", domain: uuid }], key: ["id"], mutability: "immutable" },
		{
			name: "Member",
			fields: [
				{ name: "team", domain: uuid },
				{ name: "user", domain: subject }
			],
			key: ["team", "user"],
			mutability: "immutable"
		}
	],
	laws: [
		{
			kind: "contained",
			source: { relation: "Member", fields: ["team"], where: {} },
			target: { relation: "Team", fields: ["id"], where: {} }
		}
	],
	contexts: [
		{ name: "Session", claim: { kind: "top-level" }, fields: [{ name: "sub", domain: subject }] }
	],
	derived: []
}

/** The default small scope: two relations, two rules, one context, two subjects, three facts, three actions deep. */
const scope: SmallScope = defaultScope

/** The most transitions the box may hold: past it the box is refused before any case runs, never sampled. */
const limit = 20_000

/** An installation of the box, at its position among the box's: the template its cases seat on. */
interface Slot {
	readonly index: number
	readonly install: InstallSpec
}

/**
 * One transition of the box: an installation, a reality, the shortest trail of actions and the branches nature took
 * that first reached a state, and one action a program may go on with there.
 */
export interface Transition {
	readonly slot: Slot
	readonly reality: HostState
	readonly prefix: ReadonlyArray<Taken>
	readonly action: Action
}

/**
 * Whether a transition runs the migration runner (a migration, a tamper, or a drift check, which runs the applied
 * folders again), which leaves its database unlike the slot's template where no reset of a seat puts it back: a drift
 * check on a seat left its clone unlike its template (REDFIX's replay of slot 0, `-:18`, a drift alone), so such a
 * transition takes a database of its own.
 */
const runsTheMigrator = (t: Transition): boolean =>
	Arr.some(
		[...Arr.map(t.prefix, (p) => p.action), t.action],
		(a) => a.kind === "migrate" || a.kind === "tamper" || a.kind === "drift"
	)

const slots: ReadonlyArray<Slot> = Arr.map(
	enumerateInstalls(teamsBase, scope),
	(install, index) => ({
		index,
		install
	})
)

/**
 * Every reality of each installation, with the model's state over it, each installation's names its declared ones
 * from its compilation alone (execute/names.ts installedNames), where the search realized every installation first to
 * read them: an action and a reality name relations, logins and roles by the base's names, never an installation's, so
 * the box any names of an installation explore is one box (372 transitions under the declared names, and under two
 * sets of names of the test's own, transition for transition).
 */
const starts = Arr.flatMap(slots, (slot) => {
	const names = installedNames(slot.install)
	return Arr.map(
		enumerateRealities(teamsBase, hostSchemaOf(teamsBase, names), scope),
		(reality) => ({
			slot,
			reality,
			state: initialState(slot.install, names, reality)
		})
	)
})

const explored = exploreBox(
	Arr.map(starts, (s) => s.state),
	scope,
	limit,
	featuresOf
)

/** The box's transitions: one per class of what the model tells apart of its outcomes, from every start. */
const box: Arr.NonEmptyReadonlyArray<Transition> = knownNonEmpty(
	explored.kind === "within"
		? Arr.flatMap(explored.transitions, (found) =>
				Option.match(Arr.get(starts, found.start), {
					onNone: () => [],
					onSome: (from) => [
						{ slot: from.slot, reality: from.reality, prefix: found.trail, action: found.action }
					]
				})
			)
		: [],
	`the small box's transitions (${slots.length} installations, ${starts.length} realities, within ${limit} transitions: past it, tighten the scope)`
)

/** The slots holding a transition of the box, each with its transitions, in the box's order. */
const slotBoxes = Arr.flatMap(slots, (slot) => {
	const held = Arr.filter(box, (t) => t.slot.index === slot.index)
	return Arr.isReadonlyArrayNonEmpty(held) ? [{ slot, held }] : []
})

/**
 * A case's seat of its installation's world as a template (execute/template.ts worldTemplate), under the cluster's own
 * ambient, where the search held one world per installation across the cases of its slot; or, for a transition that
 * runs the migrator (runsTheMigrator), a substrate of its own that it installs into, as the search realized such a transition afresh.
 */
const slotNeeds = (slot: Slot) =>
	({
		seat: Substrate.seat(
			worldTemplate({
				budget: templateNeedBudget,
				declaredIn: import.meta,
				name: `exhaustive slot ${slot.index}`,
				install: slot.install,
				ambient: ordinarySession
			})
		),
		own: Substrate.fresh
	}) as const

export type SlotNeeds = ReturnType<typeof slotNeeds>

/**
 * The box by installation: the slots holding a transition (four of its twelve installations, 287, 4, 80 and 1 of its
 * 372 transitions), each the space of its transitions, once each, and the needs its cases take.
 */
export const slotSpaces = Arr.map(slotBoxes, ({ slot, held }) => ({
	key: `slot ${slot.index}`,
	space: finite<Transition>((source) => Arr.getUnsafe(held, source.pick(0, held.length - 1))),
	needs: slotNeeds(slot)
}))

/**
 * The world a transition runs in: its slot's seated world over the cluster pool, reset by the case to its reality,
 * or its own installation where it runs the migrator.
 */
export const transitionWorld = (
	resources: Resources<SlotNeeds>,
	transition: Transition
): Effect.Effect<RealWorld, RealizeRefused | SqlError | NeedFailed, Scope.Scope> =>
	runsTheMigrator(transition)
		? Effect.provideServiceEffect(
				realize(transition.slot.install, ordinarySession),
				Substrate,
				resources.own
			)
		: Effect.flatMap(resources.seat, (taken) => templateWorld(taken, Option.none()))
