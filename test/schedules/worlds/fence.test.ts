import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Fiber, Formatter } from "effect"
import { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
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
	ActionKind,
	ComparisonOp,
	InstalledNames,
	InstallSpec,
	ModelState
} from "#test/support/worlds/model/types.ts"

/**
 * The fence (README "Deploying"): a Db never waits on a migration, and a migration waits only for the
 * transactions in flight. While a migration runs, every transaction a Db sends is refused at once with StaleSnapshot
 * `migrating`, and every Db.open at stage `ledger`; once the transaction it waits behind ends, the migration completes
 * or is refused as its data decides, and the calls after it meet the version it left.
 *
 * A case draws a reality of the documents installation, a Db opened on it, a row check on an integer field of one of
 * its relations, which the migration adds, and what the transaction in flight the migration waits behind holds: a psql
 * transaction of a login, outside the worlds model since it writes nothing, holding
 * - the ledger's ACCESS SHARE lock, as every Db transaction in flight holds it, so the migration's first file awaits the
 *   ledger's exclusive lock; or
 * - the checked relation's ROW EXCLUSIVE lock as the admin role, as a direct writer's insert holds it, so the file holds
 *   the ledger's exclusive lock and awaits the relation's, which its new check's ALTER TABLE takes.
 * Once the observer sees the migration's backend wait on that transaction, a call of each kind the state offers (a read,
 * a write and a refresh through the Db opened before, and an open) is drawn and judged by the worlds model in the state a
 * running migration leaves (`running`), and each must answer while the holder still holds its lock: a call that waited
 * would hold the case until its hang guard reports it. The migration, and the calls drawn after the holder commits, are
 * judged by the model with the real system's state checked after each.
 */

/** What the transaction in flight the migration waits behind holds. */
type Holder = "awaiting the ledger's lock" | "holding the checked relation's lock"

const holders: Arr.NonEmptyReadonlyArray<Holder> = [
	"awaiting the ledger's lock",
	"holding the checked relation's lock"
]

/** A call made while the migration runs: through the Db opened before it, or an open. */
type Call = Extract<ActionKind, "read" | "apply" | "refresh" | "open-db">

const calls: Arr.NonEmptyReadonlyArray<Call> = ["read", "apply", "refresh", "open-db"]

/** What a case reached: a call answered while the holder held its lock, and the migration's outcome once it let go. */
type FenceFeature =
	| `${Holder}: ${Call} answered`
	| `${Holder}: the migration ${"ok" | "migration-refused"}`

const situations: Arr.NonEmptyReadonlyArray<FenceFeature> = [
	"awaiting the ledger's lock: read answered",
	"awaiting the ledger's lock: apply answered",
	"awaiting the ledger's lock: refresh answered",
	"awaiting the ledger's lock: open-db answered",
	"awaiting the ledger's lock: the migration ok",
	"holding the checked relation's lock: read answered",
	"holding the checked relation's lock: apply answered",
	"holding the checked relation's lock: refresh answered",
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

const caseGen: Gen<FenceCase> = (source) => ({
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

/** The calls a program goes on with after the migration, each drawn live under the case's weights. */
const after: ReadonlyArray<Call> = ["read", "open-db", "read"]

/**
 * The state a Db and Db.open meet while a migration to `to` runs, from its first file until its last commits: the
 * state a run stopped part-way leaves, its folder unfinished (README "Deploying").
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
					`LOCK TABLE ${quoteIdent(names.schema)}.${quoteIdent(defined(names.tables[relation], `${relation}'s table`))} IN ROW EXCLUSIVE MODE`
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

const fenced = (fc: FenceCase, c: Case<FenceFeature>) =>
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
		const pid = yield* Effect.orDie(held.pid)
		yield* Effect.raceFirst(s.awaitBlockedBy(pid, world.migrator), endedUnblocked(migration))
		const during = running(before, to)
		yield* Effect.forEach(
			Arr.filter(calls, (call) => applicable(during, call)),
			(call, i) =>
				Effect.map(
					judged(world, during, drawAction(c.draw, during, liveOf(fc.weights, call)), 2 + i),
					() => c.note(`${fc.holder}: ${call} answered`)
				),
			{ discard: true }
		)
		yield* Effect.orDie(held.commit)
		const migrated = yield* Fiber.join(migration)
		const outcome = migrated.observation.kind
		if (outcome === "ok" || outcome === "migration-refused") {
			c.note(`${fc.holder}: the migration ${outcome}`)
		}
		yield* Effect.reduce(
			after,
			(): ModelState => migrated.next,
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
const cases = 8

layer(Substrate.layer, { excludeTestServices: true })(
	"worlds schedule: the ledger's fence",
	(it) => {
		it.effect(
			"a Db never waits on a migration, which waits only for the transaction in flight",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "worlds/fence",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<FenceFeature>(situations, { cases: 4 * cases, sense: notesOnly }),
							kept: [],
							runs: cases,
							shrink: { kind: "bounded", candidates: 30 },
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(fc, c) => Effect.scoped(fenced(fc, c))
					)
				)
		)
	}
)
