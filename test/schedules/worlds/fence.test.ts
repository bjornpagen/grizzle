import { layer } from "@effect/vitest"
import { type Array as Arr, Effect, Fiber } from "effect"
import { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	doc1,
	doc2,
	docOf,
	memberToken,
	openDb,
	orgA,
	orgB,
	tenantOf
} from "#test/schedules/worlds/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { checkStart, judged, runStep } from "#test/support/worlds/drive/index.ts"
import { unnoted } from "#test/support/worlds/drive/suite.ts"
import { realize } from "#test/support/worlds/execute/index.ts"
import { docsBase, docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { initialState } from "#test/support/worlds/model/step.ts"
import type {
	Action,
	HostState,
	InstalledNames,
	InstallSpec,
	ModelState
} from "#test/support/worlds/model/types.ts"

/**
 * The fence (README "Deploying"): a Db never waits on a migration, and a migration waits only for the
 * transactions in flight. While a migration runs, every transaction a Db sends is refused at once with StaleSnapshot
 * `migrating`, and every Db.open at stage `ledger`; once the transaction it waits behind ends, the migration completes,
 * the Db opened before it is refused `migrated` and a Db opened after it reads.
 *
 * A psql transaction of a login holds what the migration's first file waits behind, outside the worlds model since it
 * writes nothing:
 * - the ledger's ACCESS SHARE lock, as every Db transaction in flight holds it, so the file awaits the ledger's
 *   exclusive lock;
 * - Doc's ROW EXCLUSIVE lock as the admin role, as a direct writer's insert holds it, so the file holds the ledger's
 *   exclusive lock and awaits Doc's, which its new check's ALTER TABLE takes.
 *
 * Once the observer sees the migration's backend wait on that transaction, each kind of Db call (a read, a write, a
 * refresh) on a Db opened before, and an open of a role of each login, are judged by the worlds model in the state a
 * running migration leaves (`running`), and each must answer while the holder still holds its lock: a call that waited
 * would hold the schedule until the runner's timeout reports it hung. The migration, and every action after the
 * holder commits, are judged by the model with the real system's state checked after each.
 */

/** The documents installation with a check on Doc's words, so its migration alters Doc. */
const checked: InstallSpec = {
	...docsInstall,
	base: {
		...docsBase,
		laws: [
			...docsBase.laws,
			{
				kind: "check",
				name: "WordsNotNegative",
				relation: "Doc",
				predicate: { kind: "compare", field: "words", op: ">=", value: 0 }
			}
		]
	}
}

const reality: HostState = new Map([
	[
		"Org",
		[
			{ id: orgA, plan: 1 },
			{ id: orgB, plan: 2 }
		]
	],
	["Doc", [docOf(doc1, orgA, "u_ann", 3)]],
	["Share", []],
	["Note", []]
])

const annDb = openDb("member", memberToken("u_ann", tenantOf(orgA)))

const jobDb: Action = {
	kind: "open-db",
	role: { kind: "own", role: "job" },
	token: { kind: "none" },
	snapshot: "current"
}

const readDocs = (session: number): Action => ({
	kind: "read",
	session,
	relation: "Doc",
	via: { kind: "execute" }
})

/** Each kind of call a Db's transaction makes: a read, a write and a refresh. */
const calls = (session: number): Arr.NonEmptyReadonlyArray<Action> => [
	readDocs(session),
	{
		kind: "apply",
		session,
		strata: [
			[{ relation: "Doc", kind: "insert", facts: [{ id: doc2, owner: "u_ann", words: 4 }] }]
		],
		reads: []
	},
	{ kind: "refresh", session, relation: "OrgDocs" }
]

/**
 * The state a Db and Db.open meet while a migration to `to` runs, from its first file until its last commits: the
 * state a run stopped part-way leaves, its folder unfinished (README "Deploying").
 */
const running = (state: ModelState, to: InstallSpec): ModelState => ({
	...state,
	migrations: { kind: "pending", folders: [to], ledger: "unfinished" }
})

/** A transaction in flight the migration waits behind: the login it is of, and its statements after BEGIN. */
interface Holder {
	readonly migration: string
	readonly login: string
	readonly takes: (names: InstalledNames) => Arr.NonEmptyReadonlyArray<string>
}

const holders: Arr.NonEmptyReadonlyArray<Holder> = [
	{
		migration: "awaiting the ledger's lock",
		login: "web",
		takes: (names) => [
			`LOCK TABLE ${quoteIdent(names.schema)}.${quoteIdent(ledgerTableName)} IN ACCESS SHARE MODE`
		]
	},
	{
		migration: "holding the ledger's lock",
		login: "ops",
		takes: (names) => [
			`SET LOCAL ROLE ${quoteIdent(defined(names.roles["admin"], "the admin role's name"))}`,
			`LOCK TABLE ${quoteIdent(names.schema)}.${quoteIdent(defined(names.tables["Doc"], "Doc's table"))} IN ROW EXCLUSIVE MODE`
		]
	}
]

const fenceSchedule = (holder: Holder) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const world = yield* realize(docsInstall, ordinarySession)
		yield* world.reset(reality)
		const start = yield* checkStart(world, initialState(docsInstall, world.names, reality))
		const opened = yield* runStep(world, start, annDb, 0, unnoted)
		const before = opened.next
		const held = yield* world.psql(holder.login)
		yield* Effect.orDie(held.begin)
		yield* Effect.forEach(holder.takes(world.names), (sql) => Effect.orDie(held.run(sql)), {
			discard: true
		})
		const migration = yield* Effect.forkChild(
			runStep(world, before, { kind: "migrate", to: checked, how: "complete" }, 1, unnoted),
			{ startImmediately: true }
		)
		yield* s.awaitBlockedBy(yield* Effect.orDie(held.pid), s.owner.role)
		const during = running(before, checked)
		yield* Effect.forEach(
			[...calls(0), annDb, jobDb],
			(action, i) => judged(world, during, action, 2 + i),
			{
				discard: true
			}
		)
		yield* Effect.orDie(held.commit)
		const migrated = yield* Fiber.join(migration)
		assert.equal(
			migrated.observation.kind,
			"ok",
			"the migration completes once the transaction it waited behind ends"
		)
		const stale = yield* runStep(world, migrated.next, readDocs(0), 7, unnoted)
		const fresh = yield* runStep(world, stale.next, annDb, 8, unnoted)
		yield* runStep(world, fresh.next, readDocs(1), 9, unnoted)
	})

layer(Substrate.layer, { excludeTestServices: true })(
	"worlds schedule: the ledger's fence",
	(it) => {
		for (const holder of holders) {
			it.effect(
				`a Db never waits on a migration ${holder.migration}, which waits only for the transaction in flight`,
				() => fenceSchedule(holder),
				600_000
			)
		}
	}
)
