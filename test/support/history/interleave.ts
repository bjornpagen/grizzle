import { Array as Arr, Effect, type Scope, String as Str } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import {
	type HostSchema,
	type HostState,
	isResidual,
	lawRelations,
	type HostOp
} from "#test/pg/laws/families/model.ts"
import { checkHistory, type History, type Recorded } from "#test/support/history/check.ts"
import type { GrizzleWriter } from "#test/support/history/families.ts"
import type { Immediacy } from "#test/support/history/model.ts"
import { type Below, belowDeparture, readSql, writeSql } from "#test/support/history/refused.ts"
import {
	belowSpelling,
	classifyDirect,
	directClassifier,
	type GrizzleRun,
	type HistoryEnv,
	load,
	read,
	runGrizzle,
	writeSteps
} from "#test/support/history/run.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type Actors, openActors } from "#test/support/schedules/actors.ts"
import {
	type ActionStep,
	allowed,
	type Exploration,
	type Footprint,
	type Interleaving,
	opStep,
	refusedJudgment,
	relationsFootprint,
	runawayInterleavings,
	interleaveStep,
	type Txn,
	type TxnResult
} from "#test/support/schedules/interleave.ts"
import type { PsqlProcessError, TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The writers of a law exploration, by kind: the grizzle writers `g` and `h`, and the psql writers `a`,
 * `b` and `c`.
 */
export type { GrizzleWriter }
export type DirectWriter = "a" | "b" | "c"

/**
 * One transaction of an exploration: a grizzle writer's apply, a direct writer's SERIALIZABLE transaction, or a
 * planted writer's below SERIALIZABLE. `writer` names the writer whose transactions run in order on one connection,
 * its session's actor; `after` is the session of that writer's previous transaction, which must finish first.
 */
export type LawTxn = (
	| {
			readonly kind: "grizzle"
			readonly writer: GrizzleWriter
			readonly ops: ReadonlyArray<HostOp>
	  }
	| {
			readonly kind: "direct"
			readonly writer: DirectWriter
			/** What the transaction makes immediate after its last statement (see the header). */
			readonly immediate: Immediacy
			readonly ops: ReadonlyArray<HostOp>
	  }
	| { readonly kind: "below"; readonly writer: DirectWriter; readonly below: Below }
) & {
	readonly session: string
	readonly after: string | undefined
}

/**
 * The actors of a law exploration: psql children `a`, `b` and `c` that have taken on the role `direct`, and the
 * grizzle writers `g` and `h`, whose backend is the one session each Db's pool holds (one operation runs at a time on
 * each), resolved when the environment opened them.
 */
export const lawActors = (
	env: HistoryEnv
): Effect.Effect<
	Actors<DirectWriter, GrizzleWriter>,
	SqlError | PsqlProcessError,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const direct = env.rig.direct
		return {
			direct: yield* openActors(s, {
				a: { kind: "psql", as: direct },
				b: { kind: "psql", as: direct },
				c: { kind: "psql", as: direct }
			}),
			grizzle: env.rig.actors
		}
	})

/** The relations `relations` reach through the laws: closed under every law whose participants they meet. */
const reach = (host: HostSchema, relations: ReadonlyArray<string>): Footprint => {
	const out = new Set(relations)
	for (let grew = true; grew;) {
		const joining = Arr.filter(
			Arr.map(host.laws, lawRelations),
			(participants) =>
				Arr.some(participants, (p) => out.has(p)) && Arr.some(participants, (p) => !out.has(p))
		)
		for (const p of joining.flat()) {
			out.add(p)
		}
		grew = joining.length > 0
	}
	return relationsFootprint(out)
}

/**
 * The statement that makes a direct transaction's constraints immediate, if it makes any: every constraint, or each
 * trigger of each residual law the host model states, schema-qualified.
 */
const immediateSql = (env: HistoryEnv, immediate: Immediacy): ReadonlyArray<string> => {
	if (immediate === "deferred") {
		return []
	}
	if (immediate === "every constraint") {
		return ["SET CONSTRAINTS ALL IMMEDIATE"]
	}
	const residuals = new Set<LawId>(Arr.map(Arr.filter(env.host.laws, isResidual), (l) => l.law))
	const triggers = Arr.flatMap([...residuals], (law) => env.names.triggers(law))
	return triggers.length === 0 ? [] : [`SET CONSTRAINTS ${Arr.join(triggers, ", ")} IMMEDIATE`]
}

/** A planted writer's actions as written: its BEGIN below SERIALIZABLE, its read, its write, and its COMMIT. */
const belowSteps = (env: HistoryEnv, b: Below): ReadonlyArray<ActionStep> => {
	const footprint = reach(env.host, [b.relation])
	const spelling = belowSpelling(env)
	const action = (label: string, a: ActionStep["action"]): ActionStep => ({
		label,
		action: a,
		footprint
	})
	const begin = action(`BEGIN ISOLATION LEVEL ${Str.toUpperCase(b.level)}`, {
		_tag: "BeginBelow",
		level: b.level
	})
	const readStep = (sql: string) => action(sql, { _tag: "Sql", sql })
	const commit = action("COMMIT", { _tag: "Commit" })
	switch (b.kind) {
		case "read only":
			return [begin, readStep(readSql(spelling, b.relation)), commit]
		case "write": {
			const write = writeSql(spelling, env.host, b)
			return [
				begin,
				...(b.read ? [readStep(readSql(spelling, b.relation))] : []),
				action(write, { _tag: "Sql", sql: write }),
				commit
			]
		}
	}
}

/** The explorer's transactions of `txns`, and the grizzle runs they record. */
const txnsOf = (
	env: HistoryEnv,
	txns: ReadonlyArray<LawTxn>,
	seen: Map<string, GrizzleRun>
): ReadonlyArray<Txn> =>
	Arr.map(txns, (t): Txn => {
		const after = t.after
		switch (t.kind) {
			case "grizzle":
				return {
					session: t.session,
					kind: "grizzle",
					steps: [
						opStep(
							"grizzle db.apply",
							Effect.tap(runGrizzle(env, t.writer, t.ops), (o) =>
								Effect.sync(() => {
									seen.set(t.session, o)
								})
							),
							reach(
								env.host,
								Arr.map(t.ops, (o) => o.relation)
							)
						)
					],
					after
				}
			case "direct":
				return {
					session: t.session,
					kind: "direct",
					steps: [
						...Arr.map(writeSteps(env, t.ops), (w) =>
							interleaveStep(w.sql, reach(env.host, [w.relation]))
						),
						...Arr.map(immediateSql(env, t.immediate), (sql) =>
							interleaveStep(
								sql,
								reach(
									env.host,
									Arr.map(t.ops, (o) => o.relation)
								)
							)
						)
					],
					end: "commit",
					after
				}
			case "below":
				return { session: t.session, kind: "scripted", steps: belowSteps(env, t.below), after }
		}
	})

/**
 * What one transaction of an interleaving adds to its history: its record, nothing (a planted writer that met its case's
 * refusal and committed nothing), or why it departs from what its writer can do.
 */
type Entry =
	| { readonly kind: "recorded"; readonly recorded: Recorded }
	| { readonly kind: "planted" }
	| { readonly kind: "departs"; readonly why: string }

interface Head {
	readonly id: number
	readonly writer: string
	readonly start: number
	readonly end: number
}

const entryOf = (
	env: HistoryEnv,
	t: LawTxn,
	result: TxnResult,
	head: Head,
	seen: ReadonlyMap<string, GrizzleRun>
): Effect.Effect<Entry> => {
	switch (t.kind) {
		case "below": {
			const why = belowDeparture(env.host, env.rig.installed.schema, t.below, result.outcomes)
			return Effect.succeed(
				why === undefined
					? { kind: "planted" }
					: { kind: "departs", why: `${t.session}, planted: ${why}` }
			)
		}
		case "grizzle": {
			const run = seen.get(t.session)
			return Effect.succeed(
				run === undefined
					? { kind: "departs", why: `${t.session}'s operation recorded no outcome` }
					: {
							kind: "recorded",
							recorded: {
								...head,
								kind: "grizzle",
								ops: t.ops,
								outcome: run.outcome,
								transients: run.transients
							}
						}
			)
		}
		case "direct":
			return directEntry(env, t.session, t.ops, result, head)
	}
}

/** A direct transaction's entry: committed, or failed with a PostgreSQL error its classifier reads as an outcome. */
const directEntry = (
	env: HistoryEnv,
	session: string,
	ops: ReadonlyArray<HostOp>,
	result: TxnResult,
	head: Head
): Effect.Effect<Entry> => {
	switch (result._tag) {
		case "Committed":
			return Effect.succeed({
				kind: "recorded",
				recorded: { ...head, kind: "direct", ops, outcome: { kind: "accepted" } }
			})
		case "RolledBack":
			return Effect.succeed({
				kind: "departs",
				why: `${session} rolled back, though its transaction ends with COMMIT`
			})
		case "Failed":
			return result.failure._tag === "PgError"
				? Effect.map(
						classifyDirect(directClassifier(env), result.failure.fields),
						(outcome): Entry => ({
							kind: "recorded",
							recorded: { ...head, kind: "direct", ops, outcome }
						})
					)
				: Effect.succeed({ kind: "departs", why: `${session} failed without a PostgreSQL error` })
	}
}

/**
 * The history an interleaving of `txns` from `initial` made, read back as the owner, or why a planted writer's run
 * departs from its case.
 */
const historyOf = (
	env: HistoryEnv,
	initial: HostState,
	txns: ReadonlyArray<LawTxn>,
	seen: ReadonlyMap<string, GrizzleRun>,
	i: Interleaving
): Effect.Effect<History | string, SqlError, Substrate> =>
	Effect.gen(function* () {
		const committed = yield* read(env)
		const recorded: Array<Recorded> = []
		for (const t of txns) {
			const result = i.results[t.session]
			const span = i.spans[t.session]
			if (result === undefined || span === undefined) {
				return `${t.session} never ran`
			}
			const head = { id: recorded.length, writer: t.writer, start: span.start, end: span.end }
			const entry = yield* entryOf(env, t, result, head, seen)
			if (entry.kind === "departs") {
				return entry.why
			}
			if (entry.kind === "recorded") {
				recorded.push(entry.recorded)
			}
		}
		return { host: env.host, initial, recorded, committed }
	})

/**
 * Interleavings of law-family transactions, judged by the history oracle.
 *
 * A test names transactions as host operations, each on a writer: a psql direct writer, whose steps are its statements
 * (writeSteps) and its COMMIT in one SERIALIZABLE transaction; a grizzle writer, whose one step is the db.apply of
 * their ChangeSet; or a planted psql writer below SERIALIZABLE, whose steps are its BEGIN at its level, its read, its
 * write and its COMMIT, as written. One writer's transactions run in order on one connection, each starting once the
 * one before it finished. The explorer runs them in the orders its strategy chooses, from the initial state each time,
 * and each interleaving is a history: its committed state is read back and checked as a generated history's is, so the
 * model of allowed outcomes is the host's, not a table written per test. An interleaving passes when every planted
 * writer met its case's refusal and committed nothing, no law is violated, every abort has a concurrent cause, and
 * serial orders respecting the interleaving's real-time order explain every outcome, refusals and their laws and
 * witnesses included.
 *
 * A direct transaction marked immediate sets every constraint IMMEDIATE after its last statement, or the triggers of
 * its schema's residual laws, as the host model names them, by their schema-qualified names (a world role's
 * search_path does not hold the grizzle schema), as a step of its own: its deferred laws check there, on its final
 * state, so their reads fall between other moves. The step reads every relation the transaction's laws reach.
 *
 * Each step's footprint is the relations its operations write, closed under the laws that join them: a law's trigger
 * or foreign key reads its other participants, so two steps commute only when no law joins what they touch.
 *
 * The exploration of `txns` from `initial`, each interleaving checked as a history; `observe` sees every history that
 * passed, for its features. The history model reads the committed state itself (read), so the explorer reads no
 * state on the observer.
 */
export const lawExploration = (
	env: HistoryEnv,
	name: string,
	initial: HostState,
	txns: ReadonlyArray<LawTxn>,
	observe: (h: History, i: Interleaving) => void
): Effect.Effect<Exploration<SqlError | TransactionRolledBack>, never, Substrate> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const provide = <A, E>(effect: Effect.Effect<A, E, Substrate>) =>
			Effect.provideService(effect, Substrate, s)
		/** Each grizzle transaction's outcome in the current interleaving. */
		const seen = new Map<string, GrizzleRun>()
		return {
			name,
			txns: txnsOf(env, txns, seen),
			reset: Effect.andThen(
				Effect.sync(() => {
					seen.clear()
				}),
				provide(load(env, initial))
			),
			state: { _tag: "Unread" },
			model: (i) =>
				Effect.gen(function* () {
					const h = yield* provide(historyOf(env, initial, txns, seen, i))
					if (typeof h === "string") {
						return refusedJudgment(h)
					}
					const verdict = checkHistory(h)
					if (!verdict.ok) {
						return refusedJudgment(verdict.problem)
					}
					observe(h, i)
					return allowed
				}),
			maxInterleavings: runawayInterleavings
		}
	})
