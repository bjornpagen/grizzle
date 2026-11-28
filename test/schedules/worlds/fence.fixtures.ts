/** What the properties of fence.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Fiber, Formatter, Option } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import type { LockWait } from "#test/support/substrate/barrier.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { checkStart, judged, runStep } from "#test/support/worlds/drive/index.ts"
import { drawAction, unnoted } from "#test/support/worlds/drive/suite.ts"
import { realize } from "#test/support/worlds/execute/index.ts"
import { withOpener } from "#test/support/worlds/generate/action.ts"
import { applicable } from "#test/support/worlds/generate/offered.ts"
import { realityGen } from "#test/support/worlds/generate/reality.ts"
import {
	noAims,
	type Weights,
	weightsGen,
	zeroWeights
} from "#test/support/worlds/generate/weights.ts"
import { docsBase, docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { initialState } from "#test/support/worlds/model/step.ts"
import type {
	Action,
	ActionKind,
	ComparisonOp,
	InstalledNames,
	InstallSpec,
	ModelState
} from "#test/support/worlds/model/types.ts"

/**
 * The fence (docs/operations.md "Deploying"): a Db never waits on a migration, and a migration waits only for the
 * transactions in flight. While a migration runs, every transaction a Db sends is refused at once with StaleSnapshot
 * `migrating`, and a Db.open, which contacts nothing, opens a Db whose calls meet the fence in turn; once the
 * transaction it waits behind ends, the migration completes or is refused as its data decides, and the calls after it
 * meet the version it left.
 *
 * A case draws a reality of the documents installation, a Db opened on it, a row check on an integer field of one of
 * its relations, which the migration adds, and what the transaction in flight the migration waits behind holds: a psql
 * transaction of a login, outside the worlds model since it writes nothing, holding
 * - the ledger's ACCESS SHARE lock, as every Db transaction in flight holds it, so the migration's first file awaits the
 *   ledger's exclusive lock; or
 * - the checked relation's ROW EXCLUSIVE lock as the admin role, as a direct writer's insert holds it, so the file holds
 *   the ledger's exclusive lock and awaits the relation's, which its new check's ALTER TABLE takes.
 * Once the observer sees the migration's backend wait on that transaction, a call of each kind the state offers is drawn
 * and judged by the worlds model in the state a running migration leaves (`running`): a read and a write through a Db the model holds stale, as a running migration holds every Db, the one opened before it among them
 * (`duringOf`), and an open. Each must answer while the holder still holds its lock, and each call through a Db races
 * the barrier that sees that Db's backend blocked by the migration's, so a call that waits fails the case at once with
 * its lock wait (DbWaitedOnMigration), never by the case's hang guard. A feature is the kind of the call that
 * answered, as drawn. The migration, and the calls drawn after the holder commits, are judged by the model with the
 * real system's state checked after each.
 */

/** What the transaction in flight the migration waits behind holds. */
type Holder = "awaiting the ledger's lock" | "holding the checked relation's lock"

const holders: Arr.NonEmptyReadonlyArray<Holder> = [
	"awaiting the ledger's lock",
	"holding the checked relation's lock"
]

/** A call made while the migration runs: through the Db opened before it, or an open. */
type Call = Extract<ActionKind, "read" | "apply" | "open-db">

const calls: Arr.NonEmptyReadonlyArray<Call> = ["read", "apply", "open-db"]

/** What a case reached: a call answered while the holder held its lock, and the migration's outcome once it let go. */
export type FenceFeature =
	| `${Holder}: ${Call} answered`
	| `${Holder}: the migration ${"ok" | "migration-refused"}`

export const situations: Arr.NonEmptyReadonlyArray<FenceFeature> = [
	"awaiting the ledger's lock: read answered",
	"awaiting the ledger's lock: apply answered",
	"awaiting the ledger's lock: open-db answered",
	"awaiting the ledger's lock: the migration ok",
	"holding the checked relation's lock: read answered",
	"holding the checked relation's lock: apply answered",
	"holding the checked relation's lock: open-db answered",
	"holding the checked relation's lock: the migration ok"
]

/** The relations of the documents base with an integer field a row check compares, by that field. */
const checkable: Arr.NonEmptyReadonlyArray<{ readonly relation: string; readonly field: string }> =
	[
		{ relation: "Org", field: "plan" },
		{ relation: "Doc", field: "words" }
	]

const comparisonOps: Arr.NonEmptyReadonlyArray<ComparisonOp> = ["<", "<=", "=", "<>", ">=", ">"]

/** A case: what the holder holds, the check the migration adds, and the weights of the calls drawn. */
interface FenceCase {
	readonly holder: Holder
	readonly check: {
		readonly relation: string
		readonly field: string
		readonly op: ComparisonOp
		readonly value: number
	}
	readonly weights: Weights
}

export const caseGen: Gen<FenceCase> = (source) => ({
	holder: source.draw(element(holders)),
	check: {
		...source.draw(element(checkable)),
		op: source.draw(element(comparisonOps)),
		value: source.draw(int(0, 7))
	},
	weights: { ...source.draw(weightsGen), aims: noAims }
})

/** The documents installation with the case's check, which its migration adds and so alters the checked relation. */
const checkedOf = (check: FenceCase["check"]): InstallSpec => ({
	...docsInstall,
	base: {
		...docsBase,
		laws: [
			...docsBase.laws,
			{
				kind: "check",
				name: "Fenced",
				relation: check.relation,
				predicate: { kind: "compare", field: check.field, op: check.op, value: check.value }
			}
		]
	}
})

/** A live draw of one action kind under the case's weights, or an open where no session offers it one. */
const liveOf = (weights: Weights, kind: ActionKind): Weights => ({
	...weights,
	kinds: withOpener(kind),
	actions: { ...zeroWeights.actions, [kind]: 1 },
	validity: { live: 1, stale: 0, wild: 0 }
})

/**
 * A draw of one call while the migration runs: an open, live, as a program opens a Db; a read or an apply
 * through a Db the model holds stale (invalid/handles.ts namingKind, handle:stale-db), as a running migration holds every
 * Db, the one opened before it among them. A live draw of one finds no Db to call through and opens one instead, which
 * contacts nothing and so never meets the fence.
 */
const duringOf = (weights: Weights, call: Call): Weights =>
	call === "open-db"
		? liveOf(weights, call)
		: {
				...weights,
				kinds: [call],
				actions: { ...zeroWeights.actions, [call]: 1 },
				validity: { live: 0, stale: 1, wild: 0 }
			}

/** A call through a Db that waited on the running migration: its backend, blocked by the migration's, and its lock wait. */
class DbWaitedOnMigration extends Data.TaggedError("DbWaitedOnMigration")<{
	readonly call: string
	readonly wait: LockWait
}> {}

/** The login of the Db a call goes through, or none for an action that calls through no Db, an open among them. */
const callLogin = (state: ModelState, action: Action): Option.Option<string> =>
	action.kind === "read" || action.kind === "apply"
		? Option.flatMap(Option.fromUndefinedOr(state.sessions[action.session]), (session) =>
				session.kind === "db" ? Option.some(session.login) : Option.none()
			)
		: Option.none()

/** The calls a program goes on with after the migration, each drawn live under the case's weights. */
const after: ReadonlyArray<Call> = ["read", "open-db", "read"]

/**
 * The state a Db and Db.open meet while a migration to `to` runs, from its first file until its last commits: the
 * state a run stopped part-way leaves, its folder unfinished (docs/operations.md "Deploying").
 */
const running = (state: ModelState, to: InstallSpec): ModelState => ({
	...state,
	migrations: { kind: "pending", folders: [to], ledger: "unfinished" }
})

/** The login a holder's transaction is of, and its statements after BEGIN. */
const holding = (
	holder: Holder,
	names: InstalledNames,
	relation: string
): { readonly login: string; readonly takes: Arr.NonEmptyReadonlyArray<string> } => {
	switch (holder) {
		case "awaiting the ledger's lock":
			return {
				login: "web",
				takes: [
					`LOCK TABLE ${quoteIdent(names.schema)}.${quoteIdent(ledgerTableName)} IN ACCESS SHARE MODE`
				]
			}
		case "holding the checked relation's lock":
			return {
				login: "ops",
				takes: [
					`SET LOCAL ROLE ${quoteIdent(defined(names.roles["admin"], "the admin role's name"))}`,
					`LOCK TABLE ${printObjectName(defined(names.tables[relation], `${relation}'s table`))} IN ROW EXCLUSIVE MODE`
				]
			}
	}
}

/**
 * A migration that ended before it waited behind the transaction in flight, a failure of the schedule rather than a
 * barrier awaited until the case's hang guard: its exit, whatever it was.
 */
const endedUnblocked = <A, E>(migration: Fiber.Fiber<A, E>): Effect.Effect<never> =>
	Effect.flatMap(Fiber.await(migration), (exit) =>
		Effect.die(
			new Error(
				`the migration ended before it waited behind the transaction in flight: ${Formatter.format(exit)}`
			)
		)
	)

export const fenced = (fc: FenceCase, c: Case<FenceFeature>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const world = yield* realize(docsInstall, ordinarySession)
		const reality = c.draw(realityGen(docsBase, hostSchemaOf(docsBase, world.names)))
		yield* world.reset(reality)
		const start = yield* checkStart(world, initialState(docsInstall, world.names, reality))
		const opened = yield* runStep(
			world,
			start,
			drawAction(c.draw, start, liveOf(fc.weights, "open-db")),
			0,
			unnoted
		)
		const before = opened.next
		const to = checkedOf(fc.check)
		const holder = holding(fc.holder, world.names, fc.check.relation)
		const held = yield* world.psql(holder.login)
		yield* Effect.orDie(held.begin)
		yield* Effect.forEach(holder.takes, (sql) => Effect.orDie(held.run(sql)), { discard: true })
		const migration = yield* Effect.forkChild(
			runStep(world, before, { kind: "migrate", to, how: "complete" }, 1, unnoted),
			{ startImmediately: true }
		)
		const pid = held.backend.pid
		const migrator = yield* Effect.raceFirst(
			s.awaitBlockedBy(pid, world.migrator),
			endedUnblocked(migration)
		)
		const during = running(before, to)
		/**
		 * Each call judged in the state the calls before it left (an open adds its Db while the migration runs), raced
		 * against the barrier that sees the backend of the Db it calls through blocked by the migration's: a call that
		 * waits fails the case at once with that wait, never by the case's hang guard. An open contacts nothing.
		 */
		const answered = yield* Effect.reduce(
			Arr.filter(calls, (call) => applicable(during, call)),
			(): ModelState => during,
			(state, call, i) => {
				const action = drawAction(c.draw, state, duringOf(fc.weights, call))
				const judging = Effect.map(judged(world, state, action, 2 + i), (stepped) => {
					if (action.kind === call) {
						c.note(`${fc.holder}: ${call} answered`)
					}
					return stepped.next
				})
				return Option.match(callLogin(state, action), {
					onNone: () => judging,
					onSome: (login) =>
						Effect.raceFirst(
							judging,
							Effect.flatMap(
								s.awaitBlockedBy(
									migrator.pid,
									defined(world.names.logins[login], `the login ${login}'s role`)
								),
								(wait) =>
									Effect.fail(new DbWaitedOnMigration({ call: Formatter.format(action), wait }))
							)
						)
				})
			}
		)
		yield* Effect.orDie(held.commit)
		const migrated = yield* Fiber.join(migration)
		const outcome = migrated.observation.kind
		if (outcome === "ok" || outcome === "migration-refused") {
			c.note(`${fc.holder}: the migration ${outcome}`)
		}
		/** The migration's state with the Dbs opened while it ran, which it leaves as it leaves every session. */
		const landed: ModelState = {
			...migrated.next,
			sessions: answered.sessions,
			connections: answered.connections
		}
		yield* Effect.reduce(
			after,
			(): ModelState => landed,
			(state, call, i) =>
				Effect.map(
					runStep(
						world,
						state,
						drawAction(c.draw, state, liveOf(fc.weights, call)),
						6 + i,
						unnoted
					),
					(stepped) => stepped.next
				)
		)
	})

/** Cases: each realizes the installation and races one migration. */
export const cases = 8
