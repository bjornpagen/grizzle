import { layer } from "@effect/vitest"
import {
	type Deadline,
	drawn,
	type Explored,
	explore,
	PRINT_MARGIN_MILLIS,
	Run,
	type SearchFailure
} from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { boolean, element, type Gen, int, subarray } from "@grizzle/testing/gen"
import { liveMillis } from "@grizzle/testing/live"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Cause,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	Formatter,
	Option
} from "effect"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { roleName } from "#test/support/substrate/names.ts"
import { leftovers } from "#test/support/substrate/shared.ts"
import {
	freshSchema,
	roleSession,
	Substrate,
	type SubstrateShape
} from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * How a search stops a case in flight: its deadline's cut, its hang guard, or the interruption of the search itself.
 *
 * The property runs a search whose cases each allocate a drawn plan of schemas, roles and sessions from the file's
 * substrate and release it, until one case blocks once its plan stands, and stops the search each way, wherever its
 * cases are: allocating, holding or releasing. Once the stopped search has returned, the shared database holds
 * nothing a clean one does not (shared.ts leftovers) and no role a case set out to create exists: every case's cleanup
 * ends before the search that stopped it returns, so no schema outlives it into the next test, or into the file's
 * release, which fails on any.
 *
 * Plants (main's test phase): substrate-stopped-release-keeps-roles.patch.
 */
type Stop = "cut" | "hung" | "interrupted"

const stops = ["cut", "hung", "interrupted"] as const

/** The words of the roles a case may create in a schema, each `<schema>__<word>`. */
const roleWords = ["reader", "writer"] as const

/** A role a case creates in a schema, and whether it opens a session as it, a backend its release must end. */
interface Held {
	readonly word: (typeof roleWords)[number]
	readonly session: boolean
}

/** What one case of the stopped search allocates: its schemas, each the roles it creates in it. */
type Plan = ReadonlyArray<ReadonlyArray<Held>>

const heldGen: Gen<ReadonlyArray<Held>> = (source) =>
	Arr.map(source.draw(subarray(roleWords)), (word) => ({ word, session: source.draw(boolean) }))

const planGen: Gen<Plan> = (source) => upTo(source.draw(int(1, 2)), () => source.draw(heldGen))

/**
 * A case of the property: how the search is stopped, how many of its cases run at once, which case, in the order they
 * begin, blocks once its plan stands, and whether each case's allocation is shielded from interruption, so a stop waits
 * until its plan stands.
 */
interface Stopping {
	readonly stop: Stop
	readonly inFlight: number
	readonly blockAt: number
	readonly shielded: boolean
}

const stoppingGen: Gen<Stopping> = (source) => ({
	stop: source.draw(element(stops)),
	inFlight: source.draw(int(1, 3)),
	blockAt: source.draw(int(1, 6)),
	shielded: source.draw(boolean)
})

type StoppedFeature =
	| `${Stop} once its schemas stood`
	| "stopped while it allocated"
	| "a session open as a role"
	| "cases stopped together"
	| "cases released before the stop"

/** The situation of a search stopped `stop`'s way once a case's schemas stood: what the stop must clean up whole. */
const stoodUnder = (stop: Stop): StoppedFeature => `${stop} once its schemas stood`

/** How each stop ends the stopped search: a cut and a hang with their typed failures, an interruption as itself. */
const endedBy: Readonly<Record<Stop, string>> = {
	cut: "DeadlineReached",
	hung: "CaseHung",
	interrupted: "interrupted"
}

/**
 * The deadline of a search its cut stops, begun at `began`: one print margin of cases, then the print margin the cut
 * leaves before the deadline. The cut stops whichever cases are in flight, the blocked one or one still running, so the
 * margin decides only where the cut lands, never the verdict.
 */
const cutDeadline = (began: number): Deadline => ({
	kind: "at",
	millis: began + PRINT_MARGIN_MILLIS + PRINT_MARGIN_MILLIS
})

/**
 * What the cases of one stopped search did: how many began, how many had allocated their plan, how many ended on their
 * own, the sessions open in cases that have not, and the name of every role they set out to create, recorded before
 * its creation, so one stopped mid-creation counts.
 */
interface Seen {
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

/** How the stopped search ended: passed, interrupted, its typed failure's tag, or its defect as printed. */
const endOf = (exit: Exit.Exit<unknown, SearchFailure>): string => {
	if (Exit.isSuccess(exit)) {
		return "passed"
	}
	if (Cause.hasInterruptsOnly(exit.cause)) {
		return "interrupted"
	}
	return Option.match(Exit.findErrorOption(exit), {
		onNone: () => Cause.pretty(exit.cause),
		onSome: (failure) => failure._tag
	})
}

/**
 * Runs `search` and stops it `stop`'s way, then answers how it ended: cut by a deadline of its own (cutDeadline); hung
 * under the test's `deadline` by a hang limit of zero, which stops every case in flight as it first waits, mid-plan or,
 * shielded, once its plan stands; or interrupted once its blocking case's plan stands, or once it ended.
 */
const stoppedEnd = (
	stop: Stop,
	search: (deadline: Deadline, hang: Duration.Duration) => Effect.Effect<Explored, SearchFailure>,
	deadline: Deadline,
	blocked: Deferred.Deferred<void>
): Effect.Effect<string> => {
	switch (stop) {
		case "cut":
			return Effect.flatMap(liveMillis, (began) =>
				Effect.map(Effect.exit(search(cutDeadline(began), caseHang)), endOf)
			)
		case "hung":
			return Effect.map(Effect.exit(search(deadline, Duration.zero)), endOf)
		case "interrupted":
			return Effect.gen(function* () {
				const searching = yield* Effect.forkChild(search(deadline, caseHang))
				yield* Effect.raceFirst(Deferred.await(blocked), Effect.asVoid(Fiber.await(searching)))
				yield* Fiber.interrupt(searching)
				const exit = yield* Fiber.await(searching)
				return endOf(exit)
			})
	}
}

layer(Substrate.layer)("a stopped case's cleanup", (it) => {
	it.effect(
		"leaves no schema or role behind once the search that cut, hung or interrupted it returns",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "substrate/stopped cases",
						draw: drawn(stoppingGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a clean shared database (shared.ts leftovers) and none of the cases' roles, once the search returns"
						},
						coverage: required<StoppedFeature>(
							[
								...Arr.map(stops, stoodUnder),
								"stopped while it allocated",
								"a session open as a role",
								"cases stopped together",
								"cases released before the stop"
							],
							{ cases: 40, sense: notesOnly }
						),
						kept: [],
						runs: 12,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(p, c) =>
						Effect.gen(function* () {
							const s = yield* Substrate
							const run = yield* Run
							const seen: Seen = { began: 0, stood: 0, ended: 0, open: 0, roles: [] }
							const blocked = yield* Deferred.make<void>()
							const search = (deadline: Deadline, hang: Duration.Duration) =>
								Effect.provideService(
									explore(
										{
											suite: "substrate/a search stopped in flight",
											draw: drawn(planGen),
											literal: Formatter.format,
											oracle: { kind: "unstated" },
											coverage: noCoverage,
											kept: [],
											runs: 16,
											shrink: completeShrink,
											concurrency: p.inFlight,
											steerEvery: 16,
											caseHang: hang
										},
										(plan) =>
											Effect.gen(function* () {
												seen.began += 1
												const index = seen.began
												const allocation = Effect.tap(allocate(s, plan, seen), () =>
													Effect.sync(() => {
														seen.stood += 1
													})
												)
												const opened = yield* p.shielded
													? Effect.uninterruptible(allocation)
													: allocation
												if (index === p.blockAt) {
													yield* Deferred.succeed(blocked, undefined)
													return yield* Effect.never
												}
												seen.ended += 1
												seen.open -= opened
											})
									),
									Run,
									Run.of({ ...run, deadline })
								)
							const ended = yield* stoppedEnd(p.stop, search, run.deadline, blocked)
							const left = yield* leftovers(s.admin)
							const rolesLeft = yield* Effect.filter(seen.roles, s.roleExists)
							assert.deepEqual(
								{ ended, left, rolesLeft },
								{ ended: endedBy[p.stop], left: [], rolesLeft: [] }
							)
							if (seen.stood > seen.ended) {
								c.note(stoodUnder(p.stop))
							}
							if (seen.began > seen.stood) {
								c.note("stopped while it allocated")
							}
							if (seen.open > 0) {
								c.note("a session open as a role")
							}
							if (seen.began - seen.ended > 1) {
								c.note("cases stopped together")
							}
							if (seen.ended > 0) {
								c.note("cases released before the stop")
							}
						})
				)
			)
	)
})
