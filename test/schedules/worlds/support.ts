import { assert } from "@bjornpagen/testing/assert"
import type { Situations } from "@bjornpagen/testing/features"
import { type Aimed, constant, type Gen, weighted } from "@bjornpagen/testing/gen"
import type { Nature, PctSchedule } from "@bjornpagen/testing/interleave"
import { type Case, type Kept, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { every, type Strategy } from "#test/support/schedules/interleave.ts"
import {
	type RaceOp,
	runWorldRace,
	type WorldRace,
	type WorldRaceFeature
} from "#test/support/schedules/worlds.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import type {
	Action,
	ContextFacts,
	DirectStatement,
	HostFact,
	Token
} from "#test/support/worlds/model/types.ts"

/** The documents base's organizations and documents a race names. */
export const orgA = "00000000-0000-4000-8000-00000000000a"
export const orgB = "00000000-0000-4000-8000-00000000000b"
export const doc1 = "00000000-0000-4000-8000-000000000d01"
export const doc7 = "00000000-0000-4000-8000-000000000d07"

/**
 * A member's tenant: none, so its token carries no `t` claim object and it has no Tenant fact, or an organization with
 * its seats, every field Tenant reads from the claim object (a field missing from it refuses the token).
 */
export type Tenant =
	| { readonly kind: "none" }
	| { readonly kind: "of"; readonly org: string; readonly seats: number }

export const noTenant: Tenant = { kind: "none" }

/** An organization's tenancy, with the seats no race reads. */
export const tenantOf = (org: string): Tenant => ({ kind: "of", org, seats: 5 })

/** A member's verified token: its subject at the top level, and its tenant in the `t` claim object when it has one. */
export const memberToken = (sub: string, tenant: Tenant): Token => ({
	kind: "live",
	payload: tenant.kind === "none" ? { sub } : { sub, t: { org: tenant.org, seats: tenant.seats } }
})

/** Opens a role's Db with a token, as the setup of a race does, on the current snapshot. */
export const openDb = (role: string, token: Token): Action => ({
	kind: "open-db",
	role: { kind: "own", role },
	token,
	snapshot: "current"
})

/** An action of a Db session that waits out any lock it meets. */
export const act = (action: Action): RaceOp => ({ kind: "act", action, blocked: "wait" })

/** A direct writer's hand-set claims, for the transaction only. */
export const claimsOf = (facts: ContextFacts): DirectStatement => ({
	kind: "set-claims",
	setting: { kind: "facts", facts, scope: "transaction" }
})

export const setRole = (role: string): DirectStatement => ({
	kind: "set-role",
	role: { kind: "own", role }
})

/** A member's claims: its subject, and its tenant when it has one. */
export const memberClaims = (sub: string, tenant: Tenant): ContextFacts =>
	tenant.kind === "none"
		? { Session: { sub } }
		: { Session: { sub }, Tenant: { org: tenant.org, seats: tenant.seats } }

/** A document of an organization, owned by a subject. */
export const docOf = (id: string, org: string, owner: string, words: number): HostFact => ({
	id,
	org,
	owner,
	words
})

/**
 * The pool size each login's DbLayer gets, a named environment choice drawn per run: one connection, which every Db of
 * the login shares, twice as often as two, where which connection serves which Db is nature's choice.
 */
export const poolSizeGen: Gen<1 | 2> = weighted<1 | 2>([
	[2, constant(1)],
	[1, constant(2)]
])

/** Where a caller interrupts a call, a named environment choice: never, or mid-flight where it waits on a lock. */
export const interruptionGen: Gen<"wait" | "interrupt"> = weighted<"wait" | "interrupt">([
	[2, constant("wait")],
	[1, constant("interrupt")]
])

/** How a direct transaction ends, a named environment choice: its COMMIT, or a ROLLBACK a third as often. */
export const endGen: Gen<"commit" | "rollback"> = weighted<"commit" | "rollback">([
	[2, constant("commit")],
	[1, constant("rollback")]
])

/** The depth of every race's PCT schedule: up to two change points. */
export const pctDepth = 3

/** The strategy of a small race: every order, with reduction. */
export const exhaustive = (): Strategy => every

/**
 * The strategy of a race ordered by the case's PCT schedule, drawn among `moves` moves, nature being the case itself;
 * the race must make the moves the schedule's change points were drawn among.
 */
export const pctOf =
	(schedule: PctSchedule<string>, moves: number, nature: Nature) =>
	(made: number): Strategy => {
		assert.equal(made, moves, "the race's moves, which its PCT change points are drawn among")
		return { kind: "pct", schedule, nature }
	}

/** Cases per race property: each explores its interleavings, so a few drawn cases cover each environment choice. */
const raceRuns = 6

/**
 * A worlds race property: cases drawn from `space`, each resolved to a race (its installation realized, its Dbs opened,
 * its interleavings explored under its strategy, nature the case itself, and each run judged by the worlds model), each
 * case on its own clone of the base template (Substrate.fresh), and the features every run must reach; `kept`, the
 * cases a run once failed on, replayed by token.
 *
 * Its pre-conversion budget: runs 6, coverage cases 6 (test/schedules/worlds/support.ts at 27203b46b).
 */
export const worldRaceSuite = <C>(spec: {
	readonly space: Gen<C> | Aimed<C, WorldRaceFeature>
	readonly race: (c: C, nature: Nature) => WorldRace
	readonly required: Situations<WorldRaceFeature>
	readonly kept: ReadonlyArray<Kept>
}) =>
	property.explore(spec.space, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: spec.required,
		check:
			({ substrate }, k: Case<WorldRaceFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.scoped(runWorldRace({ race: spec.race(c, k), note: k.note })),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "the worlds model, stepped through every serial order of the race's actions: each run's observations and what it committed, read back as the owner"
		},
		budget: { runs: raceRuns, steered: raceRuns },
		kept: spec.kept,
		kills: []
	})
