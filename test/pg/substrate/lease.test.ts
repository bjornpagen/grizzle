import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Exit, Fiber, Formatter, Option, Ref, Scope } from "effect"
import { trusted } from "#compiler/core/trusted.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { leaseTables, type LeaseTables } from "#pg/lease.ts"
import { assert, defined } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { devSession, type PgConnection, type SqlError } from "#test/support/pg.ts"
import type { BudgetedCluster } from "#test/support/substrate/budget.ts"
import { randomHex } from "#test/support/substrate/names.ts"
import { takeLease } from "#test/support/substrate/shared.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * The substrate's connection lease (test/support/substrate/shared.ts takeLease) admits a waiting file the moment any
 * slot frees, files in the order they queued, and holds no transaction id while it leases or waits.
 *
 * A case draws a number of slots and of files that wait for one, and which holder gives its slot up at each step. It
 * leases tables of its own (leaseTables), which it creates first as scripts/pg/init.sh creates the cluster's, never the
 * cluster's slots. Holders take every slot; the files then queue one
 * after another, each left to settle (every backend it opened waits on a lock, but for the one that holds the gate).
 * At each step a holder ends its lease's transaction, and in that same release its slot must be granted to a backend
 * of the file that queued first. Nothing is judged by time: the slot's holder is read from pg_locks once the release
 * has returned. That file's lease then completes on that slot and it holds it, so a later step may free it again. At
 * every settled point no holder's or waiting file's backend holds a transaction id, no idle one holds a snapshot, and
 * neither does the file's own substrate's lease or claim (Substrate's `held`). A backend waiting in a lease's LOCK TABLE
 * may hold one, and only that one, as takeLease states. LOCK takes no snapshot (REL_19_RC2 pquery.c
 * PlannedStmtRequiresSnapshot), but its name lookup runs before its wait. When the backend's catalog caches were reset
 * since its NOWAIT try, the lookup reads the catalogs under a catalog snapshot, and nothing releases that snapshot while
 * the backend sleeps on the lock: postgres.c releases it only when the backend goes idle. A reset is any backend's commit
 * of more invalidations than the shared queue holds (sinval.c), such as a DROP SCHEMA of a few hundred tables in any
 * database of the cluster. Reproduced on a private cluster on 2026-11-14 under a loop of such drops: a file queued at
 * the gate, waiting in LOCK TABLE, held xmin 1074 and no transaction id. PostgreSQL offers no wait that takes neither a
 * snapshot nor a name lookup: a fast-path call pushes one (fastpath.c HandleFunctionRequest), and so does any SELECT
 * of pg_advisory_lock.
 *
 * The oracle is the lease's specification: the first file still queued is admitted by each release, on the slot
 * released. A file that waited on one slot of its own would leave another freed slot free while it waits.
 *
 * Features: several slots, files queued behind the first, a released slot other than the first, and a slot released
 * by a file the lease admitted. Plants (~/.cache/grizzle-release/CLUSTER/plants): lease-fixed-slot.patch (the waiting
 * file waits on the slot its process id names, as before 2026-11-14), claim-on-lease.patch (the shared database's claim
 * taken on the lease's connection, inside the transaction that holds its slot, as 5ba895fe did).
 */
interface LeaseCase {
	readonly slots: number
	readonly files: number
	/** At each step, the holder that gives its slot up, by its index among the holders then, modulo their count. */
	readonly releases: ReadonlyArray<number>
}

const caseGen: Gen<LeaseCase> = (source) => {
	const slots = source.draw(int(1, 4))
	const files = source.draw(int(1, 3))
	return { slots, files, releases: source.draw(array(int(0, 3), { min: files, max: files })) }
}

type LeaseFeature =
	| "several slots"
	| "files queued behind the first"
	| "a released slot other than the first"
	| "a slot released by a file the lease admitted"

const leaseFeatures: Arr.NonEmptyReadonlyArray<LeaseFeature> = [
	"several slots",
	"files queued behind the first",
	"a released slot other than the first",
	"a slot released by a file the lease admitted"
]

/** One file of a case: the backends its lease has open, and its lease's scope. */
interface File {
	readonly index: number
	readonly pids: Ref.Ref<ReadonlyArray<number>>
	readonly opening: Ref.Ref<number>
	readonly scope: Scope.Closeable
}

/** A file that holds a slot: its lease's connection, the slot, and whether the lease admitted it after it waited. */
interface Holder {
	readonly file: File
	readonly lease: PgConnection
	readonly slot: number
	readonly admitted: boolean
}

/** A file waiting for a slot: its lease, still running. */
interface Waiting {
	readonly file: File
	readonly fiber: Fiber.Fiber<PgConnection, SqlError>
}

/**
 * Opens a connection to the owner's own database in the scope it runs in, as the lease's `open`, and keeps its
 * backend's pid among `file`'s while it is open; `opening` counts the connections being opened.
 */
const openFor = (cluster: BudgetedCluster, file: File) =>
	Effect.acquireRelease(
		Effect.ensuring(
			Effect.andThen(
				Ref.update(file.opening, (n) => n + 1),
				Effect.tap(devSession(cluster, Option.some("grizzle-substrate lease probe")), (lock) =>
					Ref.update(file.pids, (pids) => Arr.append(pids, lock.processId))
				)
			),
			Ref.update(file.opening, (n) => n - 1)
		),
		(lock) => Ref.update(file.pids, (pids) => Arr.filter(pids, (pid) => pid !== lock.processId))
	)

/** Each backend's pid, whether it waits on a lock, and whether it holds the gate. */
const statesQuery = `SELECT p.pid, pg_catalog.cardinality(pg_catalog.pg_blocking_pids(p.pid)) > 0,
	EXISTS (SELECT FROM pg_catalog.pg_locks AS l
		WHERE l.pid = p.pid AND l.granted AND l.relation = pg_catalog.to_regclass(pg_catalog.format('public.%I', $2::text)))
FROM unnest($1::int4[]) AS p(pid)`

/**
 * Whether `file` has settled: it has a backend open and opens none, each of its backends waits on a lock but the one
 * that holds the gate, and a file that holds the gate has a backend waiting on every slot, its race (takeLease).
 */
const settled = (observer: PgConnection, tables: LeaseTables, slots: number, file: File) =>
	Effect.gen(function* () {
		const pids = yield* Ref.get(file.pids)
		if ((yield* Ref.get(file.opening)) > 0 || !Arr.isReadonlyArrayNonEmpty(pids)) {
			return false
		}
		const states = yield* observer.queryValues(statesQuery, [pids, tables.gate])
		const rows = Arr.map(states, (row) =>
			trusted<readonly [pid: number, waits: boolean, gate: boolean]>(row)
		)
		const gated = Arr.some(rows, ([, , gate]) => gate)
		return (
			rows.length === pids.length &&
			Arr.every(rows, ([, waits, gate]) => waits || gate) &&
			(!gated || rows.length === slots + 1)
		)
	})

/** Returns once every waiting file has settled. */
const awaitSettled = (
	observer: PgConnection,
	tables: LeaseTables,
	slots: number,
	waiting: ReadonlyArray<Waiting>
): Effect.Effect<void, SqlError> =>
	Effect.gen(function* () {
		for (const w of waiting) {
			while (!(yield* settled(observer, tables, slots, w.file))) {
				yield* Effect.yieldNow
			}
		}
	})

/**
 * The backends of `pids` that hold a transaction id, or a snapshot anywhere but in a wait on a lock in a LOCK TABLE
 * (the name lookup's catalog snapshot, which a cache reset leaves held through the wait). Each row carries what a report
 * needs to tell why: its pid, state, wait event, transaction id, xmin and statement.
 */
const heldQuery = `SELECT a.pid, a.state, a.wait_event_type, a.wait_event, a.backend_xid::text, a.backend_xmin::text, a.query
FROM pg_catalog.pg_stat_activity AS a
WHERE a.pid = ANY ($1::int4[]) AND (a.backend_xid IS NOT NULL OR (a.backend_xmin IS NOT NULL
	AND NOT (a.state = 'active' AND a.wait_event_type = 'Lock' AND pg_catalog.starts_with(a.query, 'LOCK TABLE public.'))))`

/** The backend holding `table`'s lock, if any. */
const holderQuery = `SELECT l.pid FROM pg_catalog.pg_locks AS l
WHERE l.relation = pg_catalog.to_regclass(pg_catalog.format('public.%I', $1::text)) AND l.granted`

const runCase = (cluster: BudgetedCluster, x: LeaseCase, note: (f: LeaseFeature) => void) =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const tables = leaseTables(`lease_probe_${process.pid}_${randomHex(4)}`)
		const observer = yield* devSession(cluster, Option.some("grizzle-substrate lease observer"))
		const named = Arr.map(
			[tables.gate, ...upTo(x.slots, tables.slot)],
			(name) => `public.${quoteIdent(name)}`
		)
		yield* Effect.forEach(named, (table) => observer.query(`CREATE TABLE ${table} ()`, []), {
			discard: true
		})
		yield* Effect.addFinalizer(() =>
			Effect.orDie(
				Effect.scoped(
					Effect.flatMap(devSession(cluster, Option.none()), (admin) =>
						admin.query(`DROP TABLE ${Arr.join(named, ", ")}`, [])
					)
				)
			)
		)
		const fileOf = (index: number) =>
			Effect.gen(function* () {
				return {
					index,
					pids: yield* Ref.make<ReadonlyArray<number>>([]),
					opening: yield* Ref.make(0),
					scope: yield* Scope.fork(scope)
				}
			})
		let holders: ReadonlyArray<Holder> = []
		for (let slot = 0; slot < x.slots; slot++) {
			const file = yield* fileOf(slot)
			const lease = yield* Scope.provide(
				takeLease(openFor(cluster, file), tables, x.slots),
				file.scope
			)
			holders = Arr.append(holders, { file, lease, slot, admitted: false })
		}
		let waiting: ReadonlyArray<Waiting> = []
		for (let index = 0; index < x.files; index++) {
			const file = yield* fileOf(x.slots + index)
			const fiber = yield* Effect.forkScoped(
				Scope.provide(takeLease(openFor(cluster, file), tables, x.slots), file.scope)
			)
			waiting = Arr.append(waiting, { file, fiber })
			yield* awaitSettled(observer, tables, x.slots, waiting)
		}
		const checkHeld = Effect.gen(function* () {
			const files = yield* Effect.forEach([...holders, ...waiting], (f) => Ref.get(f.file.pids))
			const held = yield* observer.queryValues(heldQuery, [Arr.flatten(files)])
			assert.deepEqual(
				held,
				[],
				"a lease or a wait for one holds a transaction id, or a snapshot outside its wait in LOCK TABLE"
			)
		})
		yield* checkHeld
		if (x.slots > 1) {
			note("several slots")
		}
		if (x.files > 1) {
			note("files queued behind the first")
		}
		for (const pick of x.releases) {
			const releasing = defined(holders[pick % holders.length], "a holder to release")
			const [first, ...rest] = waiting
			const head = defined(first, "a file still waiting")
			yield* releasing.lease.query("ROLLBACK", [])
			const [granted] = yield* observer.queryValues(holderQuery, [tables.slot(releasing.slot)])
			const headPids = yield* Ref.get(head.file.pids)
			assert.ok(
				granted !== undefined && headPids.includes(Number(granted[0])),
				`slot ${releasing.slot}, freed while ${waiting.length} file(s) waited, went to the first file queued`
			)
			yield* Scope.close(releasing.file.scope, Exit.void)
			if (releasing.slot > 0) {
				note("a released slot other than the first")
			}
			if (releasing.admitted) {
				note("a slot released by a file the lease admitted")
			}
			const lease = yield* Fiber.join(head.fiber)
			holders = Arr.append(
				Arr.filter(holders, (h) => h !== releasing),
				{ file: head.file, lease, slot: releasing.slot, admitted: true }
			)
			waiting = rest
			yield* awaitSettled(observer, tables, x.slots, waiting)
			yield* checkHeld
		}
	})

layer(Substrate.layer)("the substrate's connection lease", (it) => {
	it.effect(
		"admits the first file queued the moment any slot frees, and holds no transaction id while it leases or waits, nor a snapshot but its wait's name lookup's",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const held = yield* substrate.admin.queryValues(heldQuery, [substrate.held])
					assert.deepEqual(
						held,
						[],
						"the file's own lease or claim holds a transaction id or a snapshot"
					)
					return yield* explore(
						{
							suite: "substrate/lease",
							draw: drawn(caseGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "each release admits the first file still queued, on the slot it freed"
							},
							coverage: required<LeaseFeature>(leaseFeatures, { cases: 24, sense: notesOnly }),
							kept: [],
							runs: 12,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 6,
							caseHang
						},
						(x, c) => Effect.scoped(runCase(substrate.cluster, x, (f) => c.note(f)))
					)
				})
			)
	)
})
