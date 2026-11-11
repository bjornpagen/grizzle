import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Exit, Formatter, Option, Ref, Scope } from "effect"
import { ordinarySession } from "#test/support/ambient.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { checkStart, runStep } from "#test/support/worlds/drive/index.ts"
import { type Taken, unnoted } from "#test/support/worlds/drive/suite.ts"
import { type RealWorld, realize } from "#test/support/worlds/execute/index.ts"
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
	ModelState,
	SmallScope
} from "#test/support/worlds/model/types.ts"

const uuid: FieldDomain = { kind: "uuid" }
const subject: FieldDomain = textDomain("^u_[a-z]{1,8}$", "u")

/**
 * The small box's base: teams, and the members of a team by user, each member's team a team (a containment), and one
 * context, Session { sub }, read from the token's top level. Two relations, one law, one context: the least base on
 * which a query entry can filter by a claim and write through it, and a law can refuse a write from inside a world.
 *
 * Plants (main's test phase): worlds-laws-foreign-keys-dropped.patch.
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

/** The most transitions the box may hold: past it the box is refused before any runs, never sampled. */
const limit = 20_000

/** An installation of the box, at its position among the box's (the identity its shared world is held by). */
interface Slot {
	readonly index: number
	readonly install: InstallSpec
}

/**
 * One transition of the box: an installation, a reality, the shortest trail of actions and the branches nature took
 * that first reached a state, and one action a program may go on with there.
 */
interface Transition {
	readonly slot: Slot
	readonly reality: HostState
	readonly prefix: ReadonlyArray<Taken>
	readonly action: Action
}

/** Whether a transition changes the catalog (a migration or a tamper), which a reset cannot undo. */
const changesCatalog = (t: Transition): boolean =>
	Arr.some(
		[...Arr.map(t.prefix, (p) => p.action), t.action],
		(a) => a.kind === "migrate" || a.kind === "tamper"
	)

/** The world one installation of the box shares between its transitions, and the scope it lives in. */
interface Shared {
	readonly slot: number
	readonly world: RealWorld
	readonly lifetime: Scope.Closeable
}

layer(Substrate.isolatedLayer, { excludeTestServices: true })(
	"the worlds model: the small box",
	(it) => {
		it.effect("every program in the small box agrees with the model", (ctx) => {
			const note = (line: string) => Effect.promise(() => ctx.annotate(line))
			return searched(
				ctx,
				Effect.gen(function* () {
					const installs: ReadonlyArray<InstallSpec> = enumerateInstalls(teamsBase, scope)
					const realities = yield* Effect.forEach(installs, (install, index) =>
						Effect.scoped(
							Effect.map(realize(install, ordinarySession), (world) => ({
								slot: { index, install },
								names: world.names,
								realities: enumerateRealities(
									teamsBase,
									hostSchemaOf(teamsBase, world.names),
									scope
								)
							}))
						)
					)
					const realityCount = Arr.reduce(realities, 0, (n, r) => n + r.realities.length)
					const starts = Arr.flatMap(realities, (installed) =>
						Arr.map(installed.realities, (reality) => ({
							slot: installed.slot,
							reality,
							state: initialState(installed.slot.install, installed.names, reality)
						}))
					)
					const explored = exploreBox(
						Arr.map(starts, (s) => s.state),
						scope,
						limit,
						featuresOf
					)
					if (explored.kind === "past") {
						const size = `${installs.length} installations, ${realityCount} realities, more than ${limit} transitions`
						return yield* Effect.die(
							new Error(`the small box holds ${size}, past its limit: tighten the scope`)
						)
					}
					const box: ReadonlyArray<Transition> = Arr.flatMap(explored.transitions, (found) => {
						const from = starts[found.start]
						return from === undefined
							? []
							: [
									{
										slot: from.slot,
										reality: from.reality,
										prefix: found.trail,
										action: found.action
									}
								]
					})
					const size = `${installs.length} installations, ${realityCount} realities, ${box.length} transitions`
					yield* note(`small box: ${size}`)
					const moot = yield* Ref.make(0)
					const held = yield* Ref.make<Option.Option<Shared>>(Option.none())
					yield* Effect.addFinalizer(() =>
						Effect.flatMap(Ref.get(held), (h) =>
							Option.isSome(h) ? Scope.close(h.value.lifetime, Exit.void) : Effect.void
						)
					)
					const shared = (slot: Slot) =>
						Effect.gen(function* () {
							const current = yield* Ref.get(held)
							if (Option.isSome(current) && current.value.slot === slot.index) {
								return current.value.world
							}
							if (Option.isSome(current)) {
								yield* Scope.close(current.value.lifetime, Exit.void)
							}
							const lifetime = yield* Scope.make()
							const world = yield* Scope.provide(lifetime)(realize(slot.install, ordinarySession))
							yield* Ref.set(held, Option.some({ slot: slot.index, world, lifetime }))
							return world
						})
					const exhausted = yield* exhaust(
						{
							box: "every transition of the teams base's small scope (two relations, two rules, one context, two subjects, three facts, three actions deep), one per class of what the model tells apart of its outcomes",
							oracle: {
								kind: "second-implementation",
								name: "the worlds model (test/support/worlds/model): each transition's allowed observations, its stored relations and every open session's probe"
							},
							suite: "pg/world-model/exhaustive",
							generator: element(knownNonEmpty(box, "the small box's transitions")),
							literal: Formatter.format,
							limit,
							coverage: noCoverage,
							caseHang
						},
						(transition, c) =>
							Effect.gen(function* () {
								const install = transition.slot.install
								const world = changesCatalog(transition)
									? yield* realize(install, ordinarySession)
									: yield* shared(transition.slot)
								yield* world.reset(transition.reality)
								const start = yield* checkStart(
									world,
									initialState(install, world.names, transition.reality)
								)
								const reached = yield* Effect.reduce(
									transition.prefix,
									(): Option.Option<ModelState> => Option.some(start),
									(at, planned, index) =>
										Option.match(at, {
											onNone: () => Effect.succeedNone,
											onSome: (state) =>
												Effect.map(
													runStep(world, state, planned.action, index, unnoted),
													(stepped) =>
														stepped.branch === planned.branch
															? Option.some(stepped.next)
															: Option.none()
												)
										})
								)
								if (Option.isNone(reached)) {
									yield* Ref.update(moot, (n) => n + 1)
									return
								}
								yield* runStep(world, reached.value, transition.action, transition.prefix.length, c)
							})
					)
					yield* note(
						`small box: ${exhausted.cases} transitions checked (${yield* Ref.get(moot)} moot)`
					)
					return exhausted
				})
			)
		})
	}
)
