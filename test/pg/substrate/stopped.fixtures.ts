/** What the property of stopped.test.ts reads: its space, the allocations it stops, and how each ended. */
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	type Space,
	subarray
} from "@bjornpagen/testing/gen"
import { Array as Arr, Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { roleName } from "#test/support/substrate/names.ts"
import { freshSchema, roleSession, type SubstrateShape } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * Where the stop lands among the allocations in flight, each the interruption of its fiber, as the runner stops a case
 * past its deadline:
 * - immediate: as each first waits, which is mid-allocation, at its first statement, unless its allocation is shielded;
 * - blocked: once the blocking allocation's plan stands, wherever the others are then: allocating, holding or released.
 */
const stops = ["immediate", "blocked"] as const

type Stop = (typeof stops)[number]

/** The words of the roles an allocation may create in a schema, each `<schema>__<word>`. */
const roleWords = ["reader", "writer"] as const

/** A role an allocation creates in a schema, and whether it opens a session as it, a backend its release must end. */
interface Held {
	readonly word: (typeof roleWords)[number]
	readonly session: boolean
}

/** What one allocation in flight allocates: its schemas, each the roles it creates in it. */
type Plan = ReadonlyArray<ReadonlyArray<Held>>

const heldGen: Gen<ReadonlyArray<Held>> = (source) =>
	Arr.map(source.draw(subarray(roleWords)), (word) => ({ word, session: source.draw(boolean) }))

const planGen: Gen<Plan> = (source) => upTo(source.draw(int(1, 2)), () => source.draw(heldGen))

/**
 * A case: where the stop lands, the plan of the allocation that blocks once it stands, the plans of the allocations in
 * flight beside it, which end on their own once theirs stand, and whether each allocation is shielded from
 * interruption, so a stop waits until its plan stands.
 */
export interface Stopping {
	readonly stop: Stop
	readonly blocking: Plan
	readonly beside: ReadonlyArray<Plan>
	readonly shielded: boolean
}

/** Every stop, plan and shield, beside up to two allocations more. */
export const stoppingSpace: Space<Stopping> = (source) => ({
	stop: source.draw(element(stops)),
	blocking: source.draw(planGen),
	beside: source.draw(array(planGen, { min: 0, max: 2 })),
	shielded: source.draw(boolean)
})

export type StoppedFeature =
	| `${Stop} stop once its schemas stood`
	| "stopped while it allocated"
	| "a session open as a role"
	| "allocations stopped together"
	| "allocations released before the stop"

/** The situation of an allocation stopped `stop`'s way once its schemas stood: what the stop must release whole. */
export const stoodUnder = (stop: Stop): StoppedFeature => `${stop} stop once its schemas stood`

export const stoppedFeatures: ReadonlyArray<StoppedFeature> = [
	...Arr.map(stops, stoodUnder),
	"stopped while it allocated",
	"a session open as a role",
	"allocations stopped together",
	"allocations released before the stop"
]

/**
 * What the allocations of one case did: how many began, how many had allocated their plan, how many ended on their
 * own, the sessions open in allocations that have not, and the name of every role they set out to create, recorded
 * before its creation, so one stopped mid-creation counts.
 */
export interface Seen {
	began: number
	stood: number
	ended: number
	open: number
	readonly roles: Array<string>
}

/**
 * Allocates `schemas` from `s`: each schema, then each of its roles, and a session as the role when it says so;
 * answers how many sessions it opened.
 */
const allocate = (s: SubstrateShape, schemas: ReadonlyArray<ReadonlyArray<Held>>, seen: Seen) =>
	Effect.map(
		Effect.forEach(schemas, (held) =>
			Effect.gen(function* () {
				const schema = yield* s.schema(freshSchema)
				const opened = yield* Effect.forEach(held, (role) =>
					Effect.gen(function* () {
						seen.roles.push(roleName(schema, role.word))
						const login = yield* s.role(schema, role.word)
						if (!role.session) {
							return 0
						}
						yield* s.session({ ...roleSession(login), label: role.word })
						seen.open += 1
						return 1
					})
				)
				return Arr.reduce(opened, 0, (sum, n) => sum + n)
			})
		),
		Arr.reduce(0, (sum, n) => sum + n)
	)

/**
 * One allocation in flight, in a scope of its own: it begins, allocates `plan` (shielded from interruption when
 * `shielded` says so), and then runs `then` with the sessions it opened, before its scope releases what it allocated.
 */
const inFlight = (
	s: SubstrateShape,
	plan: Plan,
	seen: Seen,
	shielded: boolean,
	then: (opened: number) => Effect.Effect<void>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			seen.began += 1
			const allocation = Effect.tap(allocate(s, plan, seen), () =>
				Effect.sync(() => {
					seen.stood += 1
				})
			)
			const opened = yield* shielded ? Effect.uninterruptible(allocation) : allocation
			yield* then(opened)
		})
	)

/** How an allocation in flight ended: passed, interrupted, or its failure as printed. */
const endOf = (exit: Exit.Exit<unknown, unknown>): string => {
	if (Exit.isSuccess(exit)) {
		return "passed"
	}
	return Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : Cause.pretty(exit.cause)
}

/**
 * Starts `p`'s allocations on `s` at once, each running until its first wait as it starts: the blocking one, which
 * waits forever once its plan stands, and each beside it, which ends once its plan stands. Then stops them `p.stop`'s
 * way, every one interrupted at once and awaited, its release with it: at once, or once the blocking one's plan stands
 * or it ended. Answers how each ended, the blocking one's first.
 */
export const stopped = (
	s: SubstrateShape,
	p: Stopping,
	seen: Seen
): Effect.Effect<Arr.NonEmptyReadonlyArray<string>> =>
	Effect.gen(function* () {
		const stood = yield* Deferred.make<void>()
		const blocking = yield* Effect.forkChild(
			inFlight(s, p.blocking, seen, p.shielded, () =>
				Effect.andThen(Deferred.succeed(stood, undefined), Effect.never)
			),
			{ startImmediately: true }
		)
		const beside = yield* Effect.forEach(p.beside, (plan) =>
			Effect.forkChild(
				inFlight(s, plan, seen, p.shielded, (opened) =>
					Effect.sync(() => {
						seen.ended += 1
						seen.open -= opened
					})
				),
				{ startImmediately: true }
			)
		)
		if (p.stop === "blocked") {
			yield* Effect.raceFirst(Deferred.await(stood), Effect.asVoid(Fiber.await(blocking)))
		}
		yield* Fiber.interruptAll([blocking, ...beside])
		const blocked = yield* Effect.map(Fiber.await(blocking), endOf)
		const ends = yield* Effect.forEach(beside, (fiber) => Effect.map(Fiber.await(fiber), endOf))
		return Arr.prepend(ends, blocked)
	})
