import { layer } from "@effect/vitest"
import { type Case, explore, drawn, type Kept } from "@grizzle/testing/explore"
import { type Reached, required } from "@grizzle/testing/features"
import { type PctSchedule, pctSchedule } from "@grizzle/testing/interleave"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Cause, Effect, Formatter, Option, type Scope, String as Str } from "effect"
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

import {
	enforcementProblem,
	type HistoryFamily,
	type HistoryInstall
} from "#test/support/history/families.ts"

import {
	type DirectWriter,
	type GrizzleWriter,
	type LawTxn,
	lawActors,
	lawExploration
} from "#test/support/history/interleave.ts"
import type { WriterKind } from "#test/support/history/model.ts"
import { type BelowFeature, belowFeaturesOf } from "#test/support/history/refused.ts"

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
import { caseHang } from "#test/support/limits.ts"
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

import { regex } from "arkregex"
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
 * The planted histories (plantedHistories) on the first of the family's schemas that has them: what every
 * history suite's population must reach, which the drawn histories reach a few times a run. A family none of whose
 * schemas has them fails here, where its suite is declared.
 */
const plantedOn = <P>(
	h: HistoryFamily<P>,
	variants: Arr.NonEmptyReadonlyArray<P>
): ReadonlyArray<Kept<HistoryCase, HistoryFeature>> => {
	for (const [i, p] of variants.entries()) {
		const planted = plantedHistories(h.family.host(p), h.family.domains)
		if (planted === undefined) {
			continue
		}
		const schema = h.family.describe(p)
		return [
			{
				note: `a direct writer's step, then a grizzle writer's, each accepted, on ${schema}`,
				sketch: { variant: i, history: planted.serial, order: "listed" },
				draws: "",
				reaches: ["direct accepted", "grizzle accepted"]
			},
			{
				note: `a grizzle writer's step while a direct writer's transaction is open, on ${schema}`,
				sketch: { variant: i, history: planted.overlapping, order: "listed" },
				draws: "",
				reaches: ["overlapping"]
			}
		]
	}
	throw new Error(`no schema of ${h.family.label} has a planted history`)
}

/**
 * The case a history runs: the drawn one, or, where the case's turn aims at a trait's direct acceptance
 * (Case.steering), the planted serial history (plantedHistories) on the first schema bearing that trait that has one,
 * its direct writer's step accepted there. The cases of one window aim at distinct pending traits, so none waits
 * behind another. A steered case reads the steering it was drawn under, so it replays alike.
 */
const aimedCase = <P>(
	h: HistoryFamily<P>,
	variants: Arr.NonEmptyReadonlyArray<P>,
	drawnCase: HistoryCase,
	steering: Case<HistoryFeature>["steering"]
): HistoryCase => {
	if (Option.isNone(steering)) {
		return drawnCase
	}
	const pending = steering.value
	for (const [i, p] of variants.entries()) {
		if (!Arr.some(h.family.traits(p), (t) => pending.aimed([`trait ${t}`, "direct accepted"]))) {
			continue
		}
		const planted = plantedHistories(h.family.host(p), h.family.domains)
		if (planted !== undefined) {
			return { variant: i, history: planted.serial, order: "listed" }
		}
	}
	return drawnCase
}

/** Installs `p` and checks the installation enforces the host's laws as the host states them. */
const installChecked = <P>(
	h: HistoryFamily<P>,
	p: P
): Effect.Effect<HistoryInstall<P>, CaseFailed, Substrate | Scope.Scope> =>
	Effect.flatMap(
		Effect.mapError(
			h.install(p),
			(e) => new CaseFailed({ report: `${h.family.describe(p)} did not install: ${messageOf(e)}` })
		),
		(install) => {
			const problem = enforcementProblem(install.host, install.names)
			return problem === undefined
				? Effect.succeed(install)
				: Effect.fail(new CaseFailed({ report: `${h.family.describe(p)}: ${problem}` }))
		}
	)

/**
 * One family's generated-history suite: for each population of its box (laws/boxes.ts populationsOf), histories over the
 * population's schemas, each run in its order, explored through the library. A planted writer below SERIALIZABLE runs
 * inside a history beside the others (history/refused.ts); the guard's refusal of every statement at every level on
 * every kind of table, alone, is test/pg/direct-writers/isolation.test.ts's box.
 *
 * A case draws which of the family's schemas it runs on; each schema installs once per test, the first time a case
 * draws it, and its installation is checked to enforce the host's laws as the host states them (history/families.ts
 * enforcementProblem). The installation holds no connection: each case opens its writers, two grizzle Dbs and three
 * psql children, and closes them when it ends, so a test holds one case's connections whatever the number of schemas
 * it draws. Each history is a deterministic function of its case, so a failing one shrinks, and its report is the case
 * to replay.
 *
 * The suite's required features keep the histories from going vacuous: operations overlapped, and some were accepted
 * and some refused; and on a schema bearing each trait of the population's schemas (laws/boxes.ts traits), a direct
 * writer's operation accepted, so the direct writer's model meets every coordinate the family steers by, an arm whose
 * mutability is not its parent's among them. Lock waits, aborts by cause, retries and the planted writers' cases are
 * noted for the residual-risk line. Every note goes through the case's own Case (HistoryFeature), each also paired
 * with every trait of the case's schema.
 *
 * The oracle is the history check (history/check.ts): a serial order of the committed operations that respects real
 * time explains every outcome and every refusal by its law, every abort is explained by a concurrent operation, and the
 * state left is that order's, every law holding over it.
 */
export const historySuite = <P>(h: HistoryFamily<P>): void => {
	layer(Substrate.layer, { excludeTestServices: true })(
		`generated histories: ${h.family.label}`,
		(it) => {
			for (const { mode, variants } of populationsOf(h.family)) {
				const kept = plantedOn(h, variants)
				const reach: Arr.NonEmptyReadonlyArray<Reached<HistoryFeature>> = Arr.appendAll(
					situations,
					Arr.map(
						[...new Set(Arr.flatMap(variants, (p) => h.family.traits(p)))],
						(t) => [`trait ${t}`, "direct accepted"] as const
					)
				)
				const label = Str.replaceAll(regex("[^a-z0-9]+", "g"), "-")(h.family.label)
				const histories = Effect.gen(function* () {
					/**
					 * Every variant's installation, made before the first case and checked against the host; it holds no
					 * connection.
					 */
					const installs = yield* Effect.forEach(variants, (p) => installChecked(h, p))
					return yield* explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the history check (history/check.ts): a real-time serial order of the committed operations explains every outcome, refusal and abort, and the state left"
							},
							suite: `history/${label}/${mode}`,
							draw: drawn(historyCaseGen(variants.length)),
							literal: Formatter.format,
							coverage: required<HistoryFeature>(reach, { cases: 4 * runs, sense: notesOnly }),
							kept,
							runs,
							/**
							 * A shrink candidate is a whole history run, so a bound on the candidates keeps a failing
							 * history's report within the test's time.
							 */
							shrink: { kind: "bounded", candidates: 300 },
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(drawnCase, c) =>
							Effect.gen(function* () {
								const hc = aimedCase(h, variants, drawnCase, c.steering)
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
								const install = elementAt(installs, hc.variant, "the family's installations")
								yield* Effect.scoped(
									Effect.gen(function* () {
										const didNotConnect = (e: unknown) =>
											new CaseFailed({
												report: `${h.family.describe(p)} did not connect: ${messageOf(e)}`
											})
										const env = yield* Effect.mapError(h.connect(install), didNotConnect)
										const actors = yield* Effect.mapError(lawActors(env), didNotConnect)
										yield* runHistory(env, hc, actors, traited)
									})
								)
							})
					)
				})
				it.effect(`${mode}: small histories are lawful, serial and every abort explained`, (ctx) =>
					searched(ctx, histories)
				)
			}
		}
	)
}
