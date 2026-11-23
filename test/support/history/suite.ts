import type { Reached } from "@bjornpagen/testing/features"
import { aimed, constant, type Gen } from "@bjornpagen/testing/gen"
import { type PctSchedule, pctSchedule } from "@bjornpagen/testing/interleave"
import {
	type Case,
	family as propertyFamily,
	type Family as PropertyFamily,
	property
} from "@bjornpagen/testing/property"
import { Array as Arr, Cause, Effect, Option, Record as Rec, type Scope } from "effect"
import type { TransientTag } from "#compiler/core/errors.ts"
import {
	type DirectAbort,
	describeHistory,
	type GrizzleSettled,
	type History,
	type Outcome
} from "#test/support/history/check.ts"
import { populationsOf } from "#test/support/laws/boxes.ts"
import { expect, rowsDifference, stateRows } from "#test/support/laws/model.ts"

import { enforcementProblem, type HistoryFamily } from "#test/support/history/families.ts"

import {
	type DirectWriter,
	type GrizzleWriter,
	type LawTxn,
	lawActors,
	lawExploration
} from "#test/support/history/interleave.ts"
import type { WriterKind } from "#test/support/history/model.ts"
import { type BelowFeature, belowFeaturesOf } from "#test/support/history/refused.ts"

import { defined } from "@bjornpagen/testing/assert"
import {
	type HistoryCase,
	type HistoryEnv,
	historyCaseGen,
	plantedHistories,
	type Resolved,
	read,
	resolveHistory,
	runGrizzle,
	scheduleOf,
	sessionOf
} from "#test/support/history/run.ts"
import { messageOf } from "#test/support/message.ts"
import { elementAt, nonEmptyList } from "#test/support/oracle/pick.ts"
import { CaseFailed } from "#test/support/oracle/write/harness.ts"
import { type Actors, type DirectActor, type GrizzleActor } from "#test/support/schedules/actors.ts"
import {
	exploreEnv,
	exploreInterleavings,
	type Interleaving,
	movesOf
} from "#test/support/schedules/interleave.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Histories per test, the rotating stream's; the floor stream runs a quarter as many. */
const runs = 24

/**
 * What a history notes: a step observed blocked, a deadlock PostgreSQL broke, operations that overlapped, exact
 * repeats run, each operation's outcome by writer kind, every abort by its cause and every retry by its reason, each
 * planted writer's case, and the schema the case ran on.
 */
type HistoryFeature =
	| "blocked"
	| "deadlock"
	| "overlapping"
	| "exact repeats"
	| `${WriterKind} ${(Outcome | GrizzleSettled)["kind"]}`
	| `aborted: ${DirectAbort["kind"]}`
	| `retried after ${TransientTag}`
	| BelowFeature
	| `schema ${string}`
	| `trait ${string}`

/**
 * What every history suite's population must reach: operations that overlapped, and operations accepted and refused.
 */
const situations: Arr.NonEmptyReadonlyArray<HistoryFeature> = [
	"overlapping",
	"grizzle accepted",
	"direct accepted",
	"grizzle invariant-rejected"
]

/**
 * The exploration's transactions of a resolved history: each writer's operations in order on its actor, and each
 * planted writer's one transaction.
 */
const historyTxns = (resolved: Resolved): ReadonlyArray<LawTxn> =>
	Arr.flatMap(resolved.writers, (w): ReadonlyArray<LawTxn> => {
		switch (w.kind) {
			case "below":
				return [
					{
						kind: "below",
						writer: w.actor,
						below: w.below,
						session: sessionOf(w.actor, 0),
						after: undefined
					}
				]
			case "grizzle":
			case "direct":
				return Arr.map(w.ops, (ops, j): LawTxn => {
					const session = sessionOf(w.actor, j)
					const after = j === 0 ? undefined : sessionOf(w.actor, j - 1)
					return w.kind === "grizzle"
						? { kind: "grizzle", session, writer: w.actor, ops, after }
						: { kind: "direct", immediate: w.immediate, session, writer: w.actor, ops, after }
				})
		}
	})

/**
 * The features of a history: its operations' outcomes by writer kind, overlapping operations, abort causes and retries,
 * and whether a step was observed blocked or a deadlock broken. An operation that ran while another writer's did: what
 * makes the serial-order check bite.
 */
const noteHistory = (h: History, i: Interleaving, note: Case<HistoryFeature>["note"]): void => {
	if (i.waits.length > 0) {
		note("blocked")
	}
	if (i.deadlocks.length > 0) {
		note("deadlock")
	}
	for (const r of h.recorded) {
		note(`${r.kind} ${r.outcome.kind}`)
		if (r.outcome.kind === "aborted") {
			note(`aborted: ${r.outcome.cause.kind}`)
		}
		for (const reason of r.kind === "grizzle" ? r.transients : []) {
			note(`retried after ${reason}`)
		}
		if (Arr.some(h.recorded, (q) => q.writer !== r.writer && q.start < r.end && r.start < q.end)) {
			note("overlapping")
		}
	}
}

/**
 * Runs one history case on `env` in its order, checks it, then its exact repeats; a departure fails with the report. A
 * case in drawn order draws its PCT schedule here, on its own tape, once its transactions' sessions and moves are known:
 * three levels of priority, so up to two change points among its moves.
 */
const runHistory = (
	env: HistoryEnv,
	hc: HistoryCase,
	actors: Actors<DirectWriter, GrizzleWriter>,
	c: Case<HistoryFeature>
): Effect.Effect<void, CaseFailed, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const resolved = resolveHistory(env.host, env.domains, hc.history)
		for (const w of resolved.writers) {
			if (w.kind === "below") {
				c.noteAll(belowFeaturesOf(env.host, w.below))
			}
		}
		const txns = historyTxns(resolved)
		const recorded: { history: History | undefined } = { history: undefined }
		const spec = yield* lawExploration(
			env,
			"a generated history",
			resolved.initial,
			txns,
			(h, i) => {
				recorded.history = h
				noteHistory(h, i, c.note)
			}
		)
		const observer = yield* exploreEnv(s)
		/** Each session plays its writer's actor, by its kind. */
		const direct: Record<string, DirectActor> = {}
		const grizzle: Record<string, GrizzleActor> = {}
		for (const t of txns) {
			if (t.kind === "grizzle") {
				grizzle[t.session] = actors.grizzle[t.writer]
			} else {
				direct[t.session] = actors.direct[t.writer]
			}
		}
		const sessions = nonEmptyList(
			Arr.map(txns, (t) => t.session),
			"a history's transactions"
		)
		const base: PctSchedule<string> =
			hc.order === "listed"
				? { priorities: sessions, changes: [] }
				: c.draw(pctSchedule(sessions, 3, movesOf(spec.txns)))
		yield* exploreInterleavings(observer, { direct, grizzle }, spec, {
			kind: "pct",
			schedule: scheduleOf(resolved, base),
			nature: c
		})
		const history = recorded.history
		if (history === undefined) {
			return yield* Effect.die(new Error("the history recorded nothing"))
		}
		const committed = history.committed
		/**
		 * Exact repeats: each accepted grizzle ChangeSet the committed state already reflects, by both grizzle writers
		 * at once.
		 */
		const repeats = Arr.filter(
			Arr.filter(history.recorded, (r) => r.kind === "grizzle" && r.outcome.kind === "accepted"),
			(r) => expect(env.host, committed, r.ops).kind === "no-change"
		).slice(0, 3)
		const again = yield* Effect.forEach(
			Arr.flatMap(repeats, (r) => [
				{ r, writer: "g" as const },
				{ r, writer: "h" as const }
			]),
			({ r, writer }) =>
				Effect.map(runGrizzle(env, writer, r.ops), ({ outcome }) => ({ r, writer, outcome })),
			{ concurrency: "unbounded" }
		)
		for (const { r, writer, outcome } of again) {
			if (outcome.kind !== "no-change") {
				return yield* new CaseFailed({
					report: `the exact repeat of #${r.id} by ${writer} was ${outcome.kind}, not no-change\n${describeHistory(history)}`
				})
			}
		}
		if (repeats.length > 0) {
			c.note("exact repeats")
		}
		const after = yield* read(env)
		const difference = rowsDifference(stateRows(env.host, after), stateRows(env.host, committed))
		if (Option.isSome(difference)) {
			return yield* new CaseFailed({
				report: `exact repeats changed the state: ${difference.value}\n${describeHistory(history)}`
			})
		}
	}).pipe(
		Effect.catchCause((cause) => {
			const error = Cause.squash(cause)
			return Effect.fail(
				error instanceof CaseFailed ? error : new CaseFailed({ report: messageOf(error) })
			)
		})
	)

/**
 * The planted histories (plantedHistories) on the first of the family's schemas that has them, each the aim of the
 * situations it reaches: what every history suite's population must reach, which the drawn histories reach a few times
 * a run, so a witness whose turn aims at one of them runs its planted history. A family none of whose schemas has them
 * fails here, where its suite is declared.
 */
const plantedOn = <P>(
	h: HistoryFamily<P>,
	variants: Arr.NonEmptyReadonlyArray<P>
): ReadonlyArray<readonly [Reached<HistoryFeature>, Gen<HistoryCase>]> => {
	for (const [i, p] of variants.entries()) {
		const planted = plantedHistories(h.family.host(p), h.family.domains)
		if (planted === undefined) {
			continue
		}
		const serial: HistoryCase = { variant: i, history: planted.serial, order: "listed" }
		const overlapping: HistoryCase = { variant: i, history: planted.overlapping, order: "listed" }
		return [
			["direct accepted", constant(serial)],
			["grizzle accepted", constant(serial)],
			["overlapping", constant(overlapping)]
		]
	}
	throw new Error(`no schema of ${h.family.label} has a planted history`)
}

/**
 * The cases a history suite aims at its traits: for each trait of the population's schemas, the planted serial history
 * (plantedHistories) on the first schema bearing that trait that has one, its direct writer's step accepted there. A
 * witness whose turn aims at a trait's direct acceptance draws that case (aimed), the case it runs, prints and keeps;
 * the cases of one window aim at distinct pending traits, so none waits behind another.
 */
const traitAims = <P>(
	h: HistoryFamily<P>,
	variants: Arr.NonEmptyReadonlyArray<P>
): ReadonlyArray<readonly [Reached<HistoryFeature>, Gen<HistoryCase>]> =>
	Arr.flatMap(
		[...new Set(Arr.flatMap(variants, (p) => h.family.traits(p)))],
		(t): ReadonlyArray<readonly [Reached<HistoryFeature>, Gen<HistoryCase>]> =>
			Option.toArray(
				Option.map(
					Arr.findFirst(variants, (p, i) =>
						Arr.contains(h.family.traits(p), t)
							? Option.map(
									Option.fromUndefinedOr(plantedHistories(h.family.host(p), h.family.domains)),
									(planted): HistoryCase => ({
										variant: i,
										history: planted.serial,
										order: "listed"
									})
								)
							: Option.none()
					),
					(planted) => [[`trait ${t}`, "direct accepted"], constant(planted)] as const
				)
			)
	)

/**
 * One family's generated-history suite: a property for each population of its box (laws/boxes.ts populationsOf), keyed by
 * its mode, histories over the population's schemas, each run in its order. A planted writer below SERIALIZABLE runs
 * inside a history beside the others (history/refused.ts).
 *
 * A case draws which of the family's schemas it runs on, and runs on the worker's clone of that schema's template
 * (history/families.ts HistoryFamily templates), whose installation is checked to enforce the host's laws as the host
 * states them (history/families.ts enforcementProblem). The installation holds no connection: each case opens its writers, two grizzle Dbs and three
 * psql children, and closes them when it ends, so a test holds one case's connections whatever the number of schemas
 * it draws. Each history is a deterministic function of its case, so a failing one shrinks, and its report is the case
 * to replay.
 *
 * The suite's required features keep the histories from going vacuous: operations overlapped, and some were accepted
 * and some refused, each planted (plantedOn); and on a schema bearing each trait of the population's schemas (laws/boxes.ts traits), a direct
 * writer's operation accepted, so the direct writer's model meets every coordinate the family steers by, an arm whose
 * mutability is not its parent's among them. Lock waits, aborts by cause, retries and the planted writers' cases are
 * noted for the residual-risk line. Every note goes through the case's own Case (HistoryFeature), each also paired
 * with every trait of the case's schema.
 *
 * The oracle is the history check (history/check.ts): a serial order of the committed operations that respects real
 * time explains every outcome and every refusal by its law, every abort is explained by a concurrent operation, and the
 * state left is that order's, every law holding over it.
 */
export const historySuite = <P>(declaredIn: ImportMeta, h: HistoryFamily<P>): PropertyFamily =>
	propertyFamily(
		Rec.fromEntries(
			Arr.map(populationsOf(h.family), ({ mode, variants }) => [
				mode,
				populationHistories(declaredIn, h, variants)
			])
		)
	)

/**
 * One population's property of a history suite (historySuite): `mode: small histories are lawful, serial and every
 * abort explained`.
 *
 * Its pre-conversion budget: runs 24, coverage cases 96 (test/support/history/suite.ts at c568eb123).
 */
const populationHistories = <P>(
	declaredIn: ImportMeta,
	h: HistoryFamily<P>,
	variants: Arr.NonEmptyReadonlyArray<P>
) => {
	const reach: Arr.NonEmptyReadonlyArray<Reached<HistoryFeature>> = Arr.appendAll(
		situations,
		Arr.map(
			[...new Set(Arr.flatMap(variants, (p) => h.family.traits(p)))],
			(t) => [`trait ${t}`, "direct accepted"] as const
		)
	)
	return property.explore(
		aimed(historyCaseGen(variants.length), [...plantedOn(h, variants), ...traitAims(h, variants)]),
		{
			needs: Substrate.oneOf(h.templates(declaredIn), Substrate.seat),
			situations: reach,
			check: (seats, c: Case<HistoryFeature>) => (hc) =>
				Effect.scoped(
					Effect.gen(function* () {
						const p = elementAt(variants, hc.variant, "the family's schemas")
						c.note(`schema ${h.family.describe(p)}`)
						const traits = Arr.map(h.family.traits(p), (t): HistoryFeature => `trait ${t}`)
						c.noteAll(traits)
						/** The case as its history sees it: every feature it notes is paired with each trait. */
						const traited: Case<HistoryFeature> = {
							...c,
							note: (feature) => {
								c.note(feature)
								for (const t of traits) {
									c.pair(t, feature)
								}
							},
							noteAll: (noted) => {
								const features = [...noted]
								c.noteAll(features)
								for (const feature of features) {
									for (const t of traits) {
										c.pair(t, feature)
									}
								}
							}
						}
						const seat = yield* defined(
							seats[String(h.family.variants.indexOf(p))],
							"the family's seats"
						)
						const install = seat.value
						const problem = enforcementProblem(install.host, install.names)
						if (problem !== undefined) {
							return yield* new CaseFailed({ report: `${h.family.describe(p)}: ${problem}` })
						}
						const didNotConnect = (e: unknown) =>
							new CaseFailed({
								report: `${h.family.describe(p)} did not connect: ${messageOf(e)}`
							})
						yield* Effect.provideService(
							Effect.gen(function* () {
								const env = yield* Effect.mapError(h.connect(install), didNotConnect)
								const actors = yield* Effect.mapError(lawActors(env), didNotConnect)
								yield* runHistory(env, hc, actors, traited)
							}),
							Substrate,
							seat.substrate
						)
					})
				),
			oracle: {
				kind: "second-implementation",
				name: "the history check (history/check.ts): a real-time serial order of the committed operations explains every outcome, refusal and abort, and the state left"
			},
			budget: { runs, steered: 4 * runs },
			kept: [],
			kills: []
		}
	)
}
