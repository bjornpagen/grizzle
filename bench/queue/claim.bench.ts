import {
	Array as Arr,
	Duration,
	Effect,
	Fiber,
	Formatter,
	Option,
	Record as Rec,
	Result,
	type Scope,
	String as Str
} from "effect"
import type { OpenedDb } from "#adapter/db/open.ts"
import type { ApplyError, OpenError } from "#adapter/errors/execution.ts"
import { summarize, type Summary } from "#bench/cold/stats.ts"
import { type EstimatedNode, parsePlanTree, planNodes } from "#bench/harness/explain.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	type LoadBound,
	type LoadMeasure,
	type LoadOptions,
	type OperationResult,
	backoffOf,
	type RetryPolicy,
	retried,
	runLoad,
	sqlAttempted,
	withRetries
} from "#bench/harness/load.ts"

import {
	failedAt,
	failedAtStatement,
	type FailedOutcome,
	type Outcome
} from "#bench/harness/outcome.ts"
import { type Fixture, fill, GateSetupError, settle } from "#bench/query/support/kit.ts"
import {
	claimLabel,
	claimOf,
	Digest,
	digestOf,
	immutableQueueSchema,
	queueSchema,
	queueBenchWorlds,
	randomDigest,
	SeatNo,
	Slot,
	settleOf,
	settleOfImmutable,
	Wanted,
	QueueWork
} from "#bench/queue/support/queue.ts"

import {
	type BeforeCommit,
	displacedThenInserted,
	installWrites,
	labelText,
	lawObjects,
	loadedByOwner,
	type ObservedApply,
	observedChange,
	type ObservedStatement,
	type ObservedValue,
	oneRow,
	openDb,
	owner,
	ownerTransaction,
	readBackRows,
	type RoleSamples,
	sampleRole,
	updatesInPlace,
	writesOf
} from "#bench/write/support/writes.ts"
import { appendAll, indices } from "#compiler/core/array.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import type { AnyRole } from "#compiler/types/schema/world.ts"
import { Instant } from "#test/support/fixtures/api/contracts.ts"
import type { SqlError } from "#test/support/pg.ts"
import { beginSerializable, type RawSession } from "#test/support/substrate/session.ts"
import { connectionsPerLease } from "#test/support/substrate/shared.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The work-queue gate: claims/s of concurrent holders over more than 1M pending items, the p95, and the transient
 * failure rate by reason are recorded. A handwritten SKIP LOCKED baseline exists in bench only.
 *
 * "Measure it against a reference production load: about 800 claims/s on one lane with 256 holders, over a `Work` relation of more
 * than a million pending items, with a claim p95 of 54 to 109 ms at a width of 16 as the latency reference.
 * Record claim throughput and tail latency; the transient failure rate by reason, item collision against seat
 * collision, with fresh random and fixed start keys; the per-claim cost of the alternatives reverse check; settlement
 * latency; reclaim behavior after worker loss; large enqueues running beside claimers; and `mutable` against immutable
 * `Work`, which differ in write cost only. Compare against a hand-written claim using a locking scan with skipped rows
 * on the same schema".
 *
 * Holders. A holder is one claimer: a serverless instance that runs a claim loop. Each is its own client
 * with its own DbLayer and so its own session pool, on direct connections; a holder runs one operation at a time, so
 * its pool holds one backend, and the server-side width, the "width" the reference p95 is quoted at, is the holder count,
 * which the record reports as observed (the worker role's backends sampled from pg_stat_activity during each load).
 * The holders share the cluster's max_connections with everything else on it, so their number is what the process's
 * connection lease (test/support/substrate/shared.ts connectionsPerLease) leaves after the bench's own connections
 * (holderCount below), at both scales. The reference's 256 holders at a width of 16 are what a record is read
 * against, not a load this machine reproduces.
 *
 * Each holder operation is a claim through the runtime's own application (db.compile's program, observed per
 * statement: bench/write/support/writes.ts observedChange) and, when it leased an item, the settlement of that lease.
 * grizzle makes one attempt per call, and the holder retries a TransientFailure on its own side, as an application does
 * (bench/harness/load.ts retried). A retry's reason is the TransientFailure's (SerializationFailure for 40001, Deadlock
 * for 40P01) and its label the program statement that raised it, by its step: a write of Work or of the item's Wanted
 * fact is an item collision, the write of the lease a seat collision, COMMIT a commit-time serialization failure.
 *
 * Throughput, availability under the Dbs' acquisition budgets and the enqueuer's contention are recorded, never
 * checked: they depend on the machine. The checks are the claim's contract: its put of Work by its steps, its reads
 * and SSI locks by key, no law refusal, the reclaim, and no two accepted claims leasing the same (key, epoch).
 *
 * The hand-written baseline claims with SELECT ... FOR UPDATE SKIP LOCKED on the same installed schema, SERIALIZABLE as
 * every transaction, as the owner (FOR UPDATE needs UPDATE privilege, which the worker identity has on no Seat), and
 * retries a serialization failure or deadlock as the holders do: the first
 * unlocked wanted item at or after the holder's start key (then below it), the first unlocked free seat from the
 * holder's seat, the same three writes, and COMMIT, which fires the same alternatives law. SKIP LOCKED is excluded from
 * the language and exists only here.
 */
interface Options extends Readonly<Record<string, unknown>> {
	/** Pending items of the claimed lane. */
	readonly pending: number
	/** How long each load runs: a wall-clock budget, or operations per holder. */
	readonly bound: LoadBound
	/** Items of the enqueue that runs beside the claimers, per batch. */
	readonly enqueueBatch: number
	/** Leases a dead worker leaves behind for the reclaim case. */
	readonly dead: number
	/** The holders' and the baseline's retry policy, an application's own. */
	readonly retry: RetryPolicy
	/** The retry policy of the enqueue beside the claimers, a patient application's. */
	readonly enqueueRetry: RetryPolicy
	/** How often the role sampler reads the claimers' backends, in milliseconds. */
	readonly roleSampleMs: number
	/** How often the predicate-lock sampler reads the claimers' locks, in milliseconds. */
	readonly lockSampleMs: number
}

/**
 * The connections the bench holds besides its holders, at its peak (the probe beside the first group's holders): the
 * process's lease connection, the substrate's admin, the two observers, the enqueuer's Db and the probing Db, one
 * backend each.
 */
const benchConnections = 6

/**
 * The holders: one backend each, as many as the process's connection lease leaves beside the bench's own. The SKIP
 * LOCKED baseline runs as many owner sessions, after every holder's Db is closed.
 */
const holderCount = connectionsPerLease - benchConnections

const lane = { kind: "render", slot: 0, resource: "gpu" } as const
const now = 1_000_000n
/** A lease that does not expire during a load. */
const forever = 1_000_000_000_000n

/** A claimed row of a claim's read-back. */
interface Claimed {
	readonly key: string
	readonly epoch: bigint
	readonly seat: number
}

/** The leases an observed claim made, by its read-back: none unless it was accepted. */
const leasedRows = (o: ObservedApply): ReadonlyArray<Claimed> =>
	o.value.kind === "accepted"
		? trusted<ReadonlyArray<Claimed>>(readBackRows(o.value.reads, "claimed"))
		: []

type TextRow = readonly [text: string]
type ItemRow = readonly [key: string, epoch: string]
type SettingsRow = readonly [perTransaction: string, perRelation: string, perPage: string]
type JsonRow = readonly [json: unknown]

interface HolderStats {
	claims: Array<number>
	settles: Array<number>
	leased: number
	empty: number
	rejected: number
	/** Claims whose every attempt the holder's retries allow ended in a TransientFailure. */
	transient: number
	/**
	 * Claims and settlements that failed without an outcome, by the ApplyError's tag: a session the Db could not acquire
	 * within its budget, or a lost connection. A load records them and goes on, so a saturated run still reports what it
	 * measured.
	 */
	unavailable: Map<string, number>
	/** Settlements of live leases, by their outcome's kind, and those that failed without one, by the ApplyError's tag. */
	settled: Map<ObservedValue["kind"], number>
	settleUnavailable: Map<string, number>
	/** Every accepted claim's lease, by its read-back. */
	claimed: Array<{ readonly key: string; readonly epoch: bigint }>
}

const newStats = (): HolderStats => ({
	claims: [],
	settles: [],
	leased: 0,
	empty: 0,
	rejected: 0,
	transient: 0,
	unavailable: new Map(),
	settled: new Map(),
	settleUnavailable: new Map(),
	claimed: []
})

const bump = <K>(counts: Map<K, number>, key: K): void => {
	counts.set(key, (counts.get(key) ?? 0) + 1)
}

const tally = <K extends string>(counts: ReadonlyMap<K, number>): string =>
	Formatter.format(Rec.fromEntries(counts))

const round2 = (x: number): number => Math.round(x * 100) / 100

/** A phase timed over `ms`, and a tail-latency measure over it: absent when nothing was timed. */
const phaseOf = (name: string, ms: ReadonlyArray<number>): Readonly<Record<string, Summary>> =>
	ms.length === 0 ? {} : { [name]: summarize(ms) }

const p95Of = (name: string, ms: ReadonlyArray<number>): Readonly<Record<string, number>> =>
	ms.length === 0 ? {} : { [name]: summarize(ms).p95 }

/**
 * The SSI read locks (SIReadLock) of the backends `who` selects, counted by the locked relation and granularity
 * (relation, page, tuple), each with the table it belongs to: the relation itself, or an index's table by
 * pg_index.indrelid. PostgreSQL takes them at the granularity the scan reads: a sequential scan locks the relation, a
 * B-tree scan the leaf pages it visits, a heap fetch the tuple, and it promotes a transaction's tuple locks to their
 * page past max_pred_locks_per_page and its page locks to the relation past max_pred_locks_per_relation.
 */
const predicateLocksSql = (who: string): string =>
	"SELECT t.relname::text, c.relname::text, l.locktype::text, pg_catalog.count(*)::text FROM pg_catalog.pg_locks AS l " +
	"JOIN pg_catalog.pg_class AS c ON c.oid = l.relation " +
	"JOIN pg_catalog.pg_class AS t ON t.oid = COALESCE((SELECT i.indrelid FROM pg_catalog.pg_index AS i WHERE i.indexrelid = l.relation), l.relation) " +
	`WHERE l.mode = 'SIReadLock'::text AND l.database = (SELECT d.oid FROM pg_catalog.pg_database AS d WHERE d.datname = pg_catalog.current_database()) AND ${who} ` +
	"GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"

type LockRow = readonly [table: string, relation: string, locktype: string, count: string]

interface PredicateLocks {
	/** The table the locked relation belongs to: itself, or an index's table. */
	readonly table: string
	readonly relation: string
	readonly locktype: string
	readonly count: number
}

const predicateLocks = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>
): ReadonlyArray<PredicateLocks> =>
	Arr.map(trusted<ReadonlyArray<LockRow>>(rows), ([table, relation, locktype, count]) => ({
		table,
		relation,
		locktype,
		count: Number(count)
	}))

/** The locks as `<relation> <locktype>` -> count, for the record. */
const lockCounts = (locks: ReadonlyArray<PredicateLocks>): Readonly<Record<string, number>> =>
	Rec.fromEntries(Arr.map(locks, (l) => [`${l.relation} ${l.locktype}`, l.count]))

/**
 * One read of a stored relation in a plan: the node, the relation, and whether an index condition bounds it (an Index
 * Cond on an index scan, a Recheck Cond on a bitmap heap scan). A sequential scan, or an index scan with no condition,
 * reads the relation from one end.
 */
interface StoredRead {
	readonly statement: number
	readonly node: EstimatedNode
	readonly relation: string
	readonly bounded: boolean
}

const storedReads = (statement: number, plan: EstimatedNode): ReadonlyArray<StoredRead> =>
	planNodes(plan)
		.flatMap((n) =>
			Option.isSome(n.operation) || n.nodeType === "Bitmap Index Scan"
				? []
				: Arr.map(Option.toArray(n.relation), (relation) => ({
						statement,
						node: n,
						relation,
						bounded:
							((n.nodeType === "Index Scan" || n.nodeType === "Index Only Scan") &&
								Option.isSome(n.indexCond)) ||
							(n.nodeType === "Bitmap Heap Scan" && Option.isSome(n.recheckCond))
					}))
		)
		.toArray()

const showRead = (r: StoredRead): string =>
	`statement ${r.statement}: ${r.node.nodeType} on ${r.relation}${Option.match(r.node.index, { onNone: () => "", onSome: (index) => ` using ${index}` })}${r.bounded ? "" : " (unbounded)"}`

/**
 * The put of Work a claim program makes, by its steps: a displacing DELETE then the put's INSERT, and nothing that
 * updates Work in place.
 */
const putsWorkAsPair = (statements: ReadonlyArray<ObservedStatement>): boolean => {
	const writes = writesOf(statements, QueueWork.name)
	return writes.length === 2 && displacedThenInserted(writes) && !Arr.some(writes, updatesInPlace)
}

/** No two accepted claims of one installation leased the same (key, epoch), and there was at least one. */
const distinctLeases = (
	claimed: ReadonlyArray<{ readonly key: string; readonly epoch: bigint }>
): boolean =>
	claimed.length > 0 &&
	new Set(Arr.map(claimed, (c) => `${c.key}\u0000${c.epoch}`)).size === claimed.length

/** Where a SKIP LOCKED claim's statement failed: at BEGIN, at a labelled statement, or at COMMIT. */
type BaselineStep =
	| { readonly kind: "begin" }
	| { readonly kind: "statement"; readonly label: string }
	| { readonly kind: "commit" }

interface BaselineFailure {
	readonly at: BaselineStep
	readonly error: SqlError
}

const baselineFailed = (f: BaselineFailure): Option.Option<FailedOutcome> => {
	switch (f.at.kind) {
		case "begin":
			return failedAt(f.error, "begin")
		case "commit":
			return failedAt(f.error, "commit")
		case "statement":
			return failedAtStatement(f.error, f.at.label)
	}
}

export default defineGate({
	name: "queue-claim",
	gates: ["queue"],
	title: "The queue claim at a reference load against a hand-written SKIP LOCKED claim",
	scope:
		"Holders on direct connections within the cluster's connection lease, each its own Db, claiming and settling on one lane of more " +
		"than a million pending items: claims/s, claim and settlement p95, retries by reason and label, with fresh and " +
		"fixed start keys, immutable Work, an enqueue beside the claimers, reclaim after worker loss, and the SKIP " +
		"LOCKED baseline.",
	phases: ["operationMs", "claimMs", "settleMs", "enqueueMs", "reclaimMs"],
	options: {
		full: {
			pending: 1_200_000,
			bound: { kind: "deadline", ms: 60_000 },
			enqueueBatch: 5000,
			dead: 64,
			retry: { times: 4, baseMs: 5 },
			enqueueRetry: { times: 10, baseMs: 10 },
			roleSampleMs: 20,
			lockSampleMs: 1000
		},
		quick: {
			pending: 3000,
			bound: { kind: "operations", n: 4 },
			enqueueBatch: 50,
			dead: 3,
			retry: { times: 4, baseMs: 5 },
			enqueueRetry: { times: 10, baseMs: 10 },
			roleSampleMs: 20,
			lockSampleMs: 1000
		}
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const seats = holderCount
			const loadOptions: LoadOptions = { bound: options.bound, sampler: { kind: "none" } }

			/**
			 * The lane: `pending` wanted render items in slot 0, `seats` gpu seats; `dead` transcode items and cpu seats for the
			 * reclaim case. The law's triggers are off while the owner loads the lawful state, in one transaction: the
			 * alternatives' foreign key is native and deferred, which no DISABLE TRIGGER USER turns off, and holds only
			 * once each item's Wanted row is in beside it.
			 */
			const seed = <F>(fx: Fixture<F>) =>
				Effect.gen(function* () {
					const c = (rel: string, f: string) => fx.column(rel, f)
					const kind = (handle: string) => fx.handle("Kind", handle)
					const standing = (handle: string) => fx.handle("Standing", handle)
					const resource = (handle: string) => fx.handle("Resource", handle)
					const work = (from: number, n: number, k: string) =>
						`INSERT INTO ${fx.table("Work")} (${Arr.join(
							Arr.map(["key", "kind", "slot", "standing", "epoch", "enqueued"], (f) =>
								c("Work", f)
							),
							", "
						)}) ` +
						`SELECT ${digestOf("g")}, ${kind(k)}, 0, ${standing("wanted")}, 0, g FROM pg_catalog.generate_series(${from}, ${from + n - 1}) AS g`
					const wanted = (from: number, n: number) =>
						`INSERT INTO ${fx.table("Wanted")} (${Arr.join(
							Arr.map(["key", "due", "attempts"], (f) => c("Wanted", f)),
							", "
						)}) ` +
						`SELECT ${digestOf("g")}, 0, 0 FROM pg_catalog.generate_series(${from}, ${from + n - 1}) AS g`
					const governed = ["Work", "Wanted", "Leased", "Done", "Refused"]
					for (const t of governed) {
						yield* owner(`ALTER TABLE ${fx.table(t)} DISABLE TRIGGER USER`)
					}
					yield* ownerTransaction([
						work(1, options.pending, "render"),
						wanted(1, options.pending),
						work(options.pending + 1, options.dead, "transcode"),
						wanted(options.pending + 1, options.dead)
					])
					for (const t of governed) {
						yield* owner(`ALTER TABLE ${fx.table(t)} ENABLE TRIGGER USER`)
					}
					yield* fill(fx, "Seat", seats, { resource: resource("gpu"), seat: "(g - 1)::int4" })
					yield* fill(fx, "Seat", options.dead, {
						resource: resource("cpu"),
						seat: "(g - 1)::int4"
					})
					yield* settle(fx)
				})
			/**
			 * "The claim belongs to the application's workload, which justifies a seek index over Work's kind, slot, standing, and
			 * key for the start-key seek, in the form the shipped policy picks": each installation carries the access paths its
			 * claim and settlement request.
			 */
			const base = queueSchema("Queue")
			const baseImm = immutableQueueSchema("Queue")
			const declared = queueBenchWorlds(base)
			const declaredImm = queueBenchWorlds(baseImm)
			const fx = yield* installWrites(base, "benchqueue", {
				programs: { claim: claimOf(base), settle: settleOf(base) },
				logins: [declared.workers, declared.enqueuers, declared.operators]
			})
			const fxImm = yield* installWrites(baseImm, "benchqueueimm", {
				programs: { claim: claimOf(baseImm), settle: settleOfImmutable(baseImm) },
				logins: [declaredImm.workers, declaredImm.enqueuers, declaredImm.operators]
			})
			const installedIndexes = (yield* lawObjects(fx)).indexes
			yield* seed(fx)
			yield* seed(fxImm)
			const Q = queueSchema(fx.installed.declared)
			const Qimm = immutableQueueSchema(fxImm.installed.declared)
			/** The worlds over the rebuilt schemas, which a Db opens. */
			const worlds = queueBenchWorlds(Q)
			const worldsImm = queueBenchWorlds(Qimm)
			const observer = yield* s.session({ ...ownerSession(), label: "m15c queue observer" })
			const lockObserver = yield* s.session({
				...ownerSession(),
				label: "m15c queue predicate-lock observer"
			})

			interface Holder {
				readonly claim: (params: ParamMap) => Effect.Effect<ObservedApply, ApplyError>
				readonly settle: (key: string, epoch: bigint) => Effect.Effect<ObservedApply, ApplyError>
			}
			/**
			 * The holders of one installation, each its own Db on the substrate's route with the claim and the settlement
			 * compiled on it, and the claim program's statements, which every holder's program holds alike.
			 */
			const holdersOf = (
				open: () => Effect.Effect<OpenedDb<AnyRole, unknown>, OpenError, Substrate | Scope.Scope>,
				claim: unknown,
				settlement: unknown
			) =>
				Effect.gen(function* () {
					const built = yield* Effect.forEach(
						Arr.map(indices(holderCount), (i) => i),
						() =>
							Effect.gen(function* () {
								const d = yield* open()
								const c = observedChange(d, claim, claimLabel, { kind: "none" })
								const st = observedChange(d, settlement, claimLabel, { kind: "none" })
								if (Result.isFailure(c)) {
									return yield* Effect.die(c.failure)
								}
								if (Result.isFailure(st)) {
									return yield* Effect.die(st.failure)
								}
								const holder: Holder = {
									claim: (p) => c.success.apply(p),
									settle: (key, epoch) => st.success.apply({ key, epoch, outcome: "succeeded" })
								}
								return { holder, statements: c.success.statements }
							})
					)
					const [first] = built
					if (first === undefined) {
						throw new GateSetupError({ what: "a load of no holder" })
					}
					return { holders: Arr.map(built, (b) => b.holder), claimStatements: first.statements }
				})
			type Start = "fresh" | "fixed"
			/** A claim loop: claim, and settle what was leased. The operation's result is the claim's. */
			const claimLoad = (holders: ReadonlyArray<Holder>, start: Start, stats: HolderStats) => {
				const fixed = Arr.map(holders, () => randomDigest())
				/** The start key of holder `w`'s next claim: a fresh random one per claim, or the holder's own fixed one. */
				const startKey = (w: number): string => {
					if (start === "fresh") {
						return randomDigest()
					}
					const key = fixed[w]
					if (key === undefined) {
						throw new GateSetupError({ what: `no fixed start key for holder ${w}` })
					}
					return key
				}
				return runLoad(
					holders,
					(h, w) =>
						Effect.gen(function* () {
							const from = startKey(w)
							const t0 = performance.now()
							const attempt = yield* Effect.result(
								retried(
									() =>
										h.claim({
											kind: lane.kind,
											slot: Slot(lane.slot),
											resource: lane.resource,
											from: Digest(from),
											fromSeat: SeatNo(w % seats),
											now: Instant(now),
											expires: Instant(forever)
										}),
									(o) => o.attempted.transient,
									options.retry
								)
							)
							stats.claims.push(performance.now() - t0)
							if (Result.isFailure(attempt)) {
								bump(stats.unavailable, attempt.failure._tag)
								const unavailable: OperationResult = {
									outcome: { kind: "rolledBack" },
									attempts: 1,
									retries: []
								}
								return unavailable
							}
							const claimed = attempt.success.last
							if (claimed.value.kind === "invariant-rejected") {
								stats.rejected += 1
							}
							if (claimed.value.kind === "transient") {
								stats.transient += 1
							}
							const rows = leasedRows(claimed)
							if (rows.length > 0) {
								stats.leased += 1
								for (const row of rows) {
									stats.claimed.push({ key: row.key, epoch: row.epoch })
									const t1 = performance.now()
									const settled = yield* Effect.result(
										retried(
											() => h.settle(row.key, row.epoch),
											(o) => o.attempted.transient,
											options.retry
										)
									)
									stats.settles.push(performance.now() - t1)
									if (Result.isSuccess(settled)) {
										bump(stats.settled, settled.success.last.value.kind)
									} else {
										bump(stats.settleUnavailable, settled.failure._tag)
									}
								}
							} else if (claimed.value.kind !== "transient") {
								stats.empty += 1
							}
							const result: OperationResult = {
								outcome: claimed.attempted.outcome,
								attempts: attempt.success.attempts,
								retries: attempt.success.retries
							}
							return result
						}),
					loadOptions
				)
			}
			/**
			 * The workers' SSI read locks sampled every lockSampleMs during a run: the most of each relation and granularity,
			 * and the most in all, seen in one sample. Only the fresh mutable run samples them.
			 */
			type LockSamples =
				| { readonly kind: "notSampled" }
				| {
						readonly kind: "sampled"
						readonly samples: number
						readonly max: Readonly<Record<string, number>>
						readonly maxTotal: number
				  }
			interface Run {
				readonly load: LoadMeasure
				readonly stats: HolderStats
				readonly role: RoleSamples
				readonly claimsPerSecond: number
				readonly predicateLocks: LockSamples
			}
			/** What runs alongside the claimers: nothing, or the enqueue loop, told when they are done by `claimersDone`. */
			type Beside =
				| { readonly kind: "none" }
				| { readonly kind: "alongside"; readonly run: Effect.Effect<void, ApplyError | SqlError> }
			let claimersDone = false
			const measureRun = Effect.fn("measureRun")(function* (
				role: string,
				holders: ReadonlyArray<Holder>,
				start: Start,
				beside: Beside,
				sampleLocks: boolean
			) {
				const stats = newStats()
				claimersDone = false
				const lockMax = new Map<string, number>()
				let lockSamples = 0
				let lockMaxTotal = 0
				const lockSample = Effect.map(
					lockObserver.values(
						predicateLocksSql(
							`l.pid IN (SELECT a.pid FROM pg_catalog.pg_stat_activity AS a WHERE a.usename = '${role}'::name)`
						),
						[]
					),
					(rows) => {
						const locks = predicateLocks(rows)
						lockSamples += 1
						lockMaxTotal = Math.max(
							lockMaxTotal,
							Arr.reduce(locks, 0, (sum, l) => sum + l.count)
						)
						for (const l of locks) {
							const key = `${l.relation} ${l.locktype}`
							const prior = lockMax.get(key)
							lockMax.set(key, prior === undefined ? l.count : Math.max(prior, l.count))
						}
					}
				)
				const lockFiber = sampleLocks
					? yield* Effect.forkChild(
							Effect.forever(
								Effect.andThen(Effect.sleep(Duration.millis(options.lockSampleMs)), lockSample)
							)
						)
					: undefined
				const claimers = Effect.ensuring(
					claimLoad(holders, start, stats),
					Effect.sync(() => {
						claimersDone = true
					})
				)
				const sampled = yield* sampleRole(
					observer,
					role,
					options.roleSampleMs,
					beside.kind === "none"
						? claimers
						: Effect.map(
								Effect.all([claimers, beside.run], { concurrency: "unbounded" }),
								([load]) => load
							)
				)
				if (lockFiber !== undefined) {
					yield* Fiber.interrupt(lockFiber)
				}
				const load = sampled.value
				const run: Run = {
					load,
					stats,
					role: sampled.role,
					claimsPerSecond: round2((stats.leased / load.wallMs) * 1000),
					predicateLocks: sampleLocks
						? {
								kind: "sampled",
								samples: lockSamples,
								max: Rec.fromEntries(lockMax),
								maxTotal: lockMaxTotal
							}
						: { kind: "notSampled" }
				}
				return run
			})

			/** The worker's login role: what pg_stat_activity names a worker's session by. */
			const worker = fx.installed.as(worlds.workers).role
			/** Each group of holders is its own scope, so one group's connections are open at a time. */
			const groupA = yield* Effect.scoped(
				Effect.gen(function* () {
					const { holders, claimStatements } = yield* holdersOf(
						() => openDb(fx, worlds.workers.roles.worker),
						claimOf(Q),
						settleOf(Q)
					)
					const fresh = yield* measureRun(worker, holders, "fresh", { kind: "none" }, true)
					const fixed = yield* measureRun(worker, holders, "fixed", { kind: "none" }, false)

					/** Large enqueues beside the claimers: one enqueuer applies batches of new items until the claimers finish. */
					const enqueuer = yield* openDb(fx, worlds.enqueuers.roles.enqueuer)
					const enqueueMs: Array<number> = []
					let nextItem = options.pending + options.dead + 1
					const enqueueBatch = Effect.gen(function* () {
						const from = nextItem
						nextItem += options.enqueueBatch
						const keys = Arr.map(indices(options.enqueueBatch), (i) => `${from + i}`)
						const rows = yield* s.admin.queryValues(
							`SELECT ${digestOf("x")} FROM pg_catalog.unnest($1::int8[]) AS x`,
							[`{${Arr.join(keys, ",")}}`]
						)
						const digests = trusted<ReadonlyArray<TextRow>>(rows)
						const facts = Arr.map(digests, ([key], i) => ({ key: Digest(key), i }))
						const change = ChangeSet.empty(Q)
							.insert(
								QueueWork,
								Arr.map(facts, (f) => ({
									key: f.key,
									kind: "render" as const,
									slot: Slot(0),
									standing: "wanted" as const,
									epoch: 0n,
									enqueued: Instant(BigInt(from + f.i))
								}))
							)
							.insert(
								Wanted,
								Arr.map(facts, (f) => ({ key: f.key, due: Instant(0n), attempts: 0 }))
							)
						const t = performance.now()
						/**
						 * Beside the claimers an enqueue can meet one of their commits: a TransientFailure, which the enqueuer retries as
						 * a patient application does, by the gate's enqueueRetry policy. An enqueue whose every attempt failed is
						 * tallied as `transient`.
						 */
						const outcome = yield* enqueuer.db.apply(change, {}).pipe(
							Effect.retry({
								times: options.enqueueRetry.times,
								schedule: backoffOf(options.enqueueRetry),
								while: (e) => e._tag === "TransientFailure"
							}),
							Effect.catchTag("TransientFailure", () =>
								Effect.succeed({ kind: "transient" } as const)
							)
						)
						enqueueMs.push(performance.now() - t)
						return outcome
					})
					const enqueueOutcomes = new Map<string, number>()
					const enqueueLoop = Effect.whileLoop({
						while: () => !claimersDone,
						body: () => enqueueBatch,
						step: (outcome) => {
							bump(enqueueOutcomes, outcome.kind)
						}
					})
					const beside = yield* measureRun(
						worker,
						holders,
						"fresh",
						{ kind: "alongside", run: enqueueLoop },
						false
					)
					bump(enqueueOutcomes, (yield* enqueueBatch).kind)

					/**
					 * One claim's footprint under SSI. With `live` leases held and not settled (as `live` holders would hold them
					 * mid-load), one more claim on a Db of its own reads, just before its COMMIT and inside its transaction, the
					 * predicate locks it holds, and the generic plan of every statement it ran (EXPLAIN GENERIC_PLAN, each under a
					 * savepoint, after the lock reading; a statement executed with its values may plan otherwise for its first five
					 * executions, plan_cache_mode auto); then every lease is settled.
					 */
					const probeDb = yield* openDb(fx, worlds.workers.roles.worker)
					const plainClaim = observedChange(probeDb, claimOf(Q), claimLabel, { kind: "none" })
					const probeSettle = observedChange(probeDb, settleOf(Q), claimLabel, { kind: "none" })
					if (Result.isFailure(plainClaim)) {
						return yield* Effect.die(plainClaim.failure)
					}
					if (Result.isFailure(probeSettle)) {
						return yield* Effect.die(probeSettle.failure)
					}
					/**
					 * The claim's statements, which the probed claim's program holds alike: a carrier's creation and the ANALYZE of
					 * carriers have no plan to explain.
					 */
					const explained = Arr.flatMap(plainClaim.success.statements, (statement, i) =>
						(statement.label.kind === "carrier" && statement.label.step === "create") ||
						statement.label.kind === "analyze"
							? []
							: [{ number: i + 1, sql: statement.sql }]
					)
					const footprint: {
						locks: ReadonlyArray<PredicateLocks>
						plans: Array<string>
						reads: Array<StoredRead>
					} = { locks: [], plans: [], reads: [] }
					const probe: BeforeCommit = {
						kind: "probe",
						run: (session) =>
							Effect.gen(function* () {
								const rows = yield* session.rows(
									predicateLocksSql("l.pid = pg_catalog.pg_backend_pid()"),
									[]
								)
								footprint.locks = predicateLocks(rows)
								footprint.plans = []
								footprint.reads = []
								yield* session.rows(
									"CREATE OR REPLACE FUNCTION pg_temp.grizzle_bench_explain(q text) RETURNS SETOF text LANGUAGE plpgsql AS $f$ BEGIN RETURN QUERY EXECUTE 'EXPLAIN (GENERIC_PLAN, COSTS OFF) ' || q; END $f$",
									[]
								)
								yield* session.rows(
									"CREATE OR REPLACE FUNCTION pg_temp.grizzle_bench_explain_json(q text) RETURNS SETOF json LANGUAGE plpgsql AS $f$ BEGIN RETURN QUERY EXECUTE 'EXPLAIN (GENERIC_PLAN, FORMAT JSON) ' || q; END $f$",
									[]
								)
								for (const statement of explained) {
									yield* session.rows("SAVEPOINT grizzle_bench_probe", [])
									const plan = yield* Effect.result(
										session.rows("SELECT pg_temp.grizzle_bench_explain($1::text)", [statement.sql])
									)
									if (Result.isSuccess(plan)) {
										footprint.plans.push(
											`-- statement ${statement.number}\n${Arr.join(
												Arr.map(trusted<ReadonlyArray<TextRow>>(plan.success), ([line]) => line),
												"\n"
											)}`
										)
										/** The same generic plan as JSON, for the reads of stored relations it makes. */
										const rows = yield* session.rows(
											"SELECT pg_temp.grizzle_bench_explain_json($1::text)",
											[statement.sql]
										)
										const [json] = trusted<JsonRow>(oneRow(rows))
										const tree = parsePlanTree(json)
										if (Result.isFailure(tree)) {
											return yield* Effect.die(tree.failure)
										}
										appendAll(footprint.reads, storedReads(statement.number, tree.success))
										yield* session.rows("RELEASE SAVEPOINT grizzle_bench_probe", [])
									} else {
										const f = plan.failure
										footprint.plans.push(
											`-- statement ${statement.number}: EXPLAIN failed: ${f._tag === "ServerError" ? `${f.sqlstate}${f.detail === undefined ? "" : ` ${f.detail}`}` : f._tag}`
										)
										yield* session.rows("ROLLBACK TO SAVEPOINT grizzle_bench_probe", [])
									}
								}
							})
					}
					const probedClaim = observedChange(probeDb, claimOf(Q), claimLabel, probe)
					if (Result.isFailure(probedClaim)) {
						return yield* Effect.die(probedClaim.failure)
					}
					const live = Math.max(1, Math.floor(seats / 2))
					const claimParams = (w: number) => ({
						kind: lane.kind,
						slot: Slot(lane.slot),
						resource: lane.resource,
						from: Digest(randomDigest()),
						fromSeat: SeatNo(w % seats),
						now: Instant(now),
						expires: Instant(forever)
					})
					const held: Array<{ readonly key: string; readonly epoch: bigint }> = []
					for (let i = 0; i < live; i++) {
						const claimed = yield* plainClaim.success.apply(claimParams(i))
						appendAll(held, leasedRows(claimed))
					}
					const probed = yield* probedClaim.success.apply(claimParams(live))
					appendAll(held, leasedRows(probed))
					for (const h of held) {
						yield* probeSettle.success.apply({ key: h.key, epoch: h.epoch, outcome: "succeeded" })
					}
					const rows = yield* observer.values(
						"SELECT pg_catalog.current_setting('max_pred_locks_per_transaction'), pg_catalog.current_setting('max_pred_locks_per_relation'), pg_catalog.current_setting('max_pred_locks_per_page')",
						[]
					)
					const lockSettings = trusted<SettingsRow>(oneRow(rows))
					const claimFootprint = {
						live,
						held: held.length,
						probeOutcome: probed.value.kind,
						probeTransient: probed.attempted.transient,
						locks: footprint.locks,
						plans: footprint.plans,
						reads: footprint.reads,
						settings: Arr.join(lockSettings, " / "),
						settleStatements: probeSettle.success.statements
					}

					/**
					 * Reclaim after worker loss: dead workers lease transcode items with leases already expired, never settle; a live
					 * claimer reclaims each in its own seat with the next epoch, and the dead worker's late settlement is no-change.
					 */
					const [reclaimer] = holders
					if (reclaimer === undefined) {
						throw new GateSetupError({ what: "no holder" })
					}
					const deadLeases: Array<{
						readonly key: string
						readonly epoch: bigint
						readonly seat: number
					}> = []
					for (let i = 0; i < options.dead; i++) {
						const reclaimed = yield* reclaimer.claim({
							kind: "transcode",
							slot: Slot(0),
							resource: "cpu",
							from: Digest(Str.repeat(64)("0")),
							fromSeat: SeatNo(0),
							now: Instant(now),
							expires: Instant(now)
						})
						appendAll(deadLeases, leasedRows(reclaimed))
					}
					const reclaimMs: Array<number> = []
					const reclaimed: Array<{
						readonly key: string
						readonly epoch: bigint
						readonly seat: number
					}> = []
					const lateSettles: Array<string> = []
					for (const lease of deadLeases) {
						const t = performance.now()
						const o = yield* reclaimer.claim({
							kind: "transcode",
							slot: Slot(0),
							resource: "cpu",
							from: Digest(lease.key),
							fromSeat: SeatNo(0),
							now: Instant(now + 10n),
							expires: Instant(forever)
						})
						reclaimMs.push(performance.now() - t)
						appendAll(reclaimed, leasedRows(o))
						lateSettles.push((yield* reclaimer.settle(lease.key, lease.epoch)).value.kind)
					}
					const reclaimOk =
						deadLeases.length === options.dead &&
						reclaimed.length === deadLeases.length &&
						Arr.every(deadLeases, (d) =>
							Arr.some(
								reclaimed,
								(r) => r.key === d.key && r.epoch === d.epoch + 1n && r.seat === d.seat
							)
						)
					return {
						fresh,
						fixed,
						beside,
						claimStatements,
						claimFootprint,
						enqueueMs,
						enqueueOutcomes,
						deadLeases,
						reclaimed,
						reclaimMs,
						lateSettles,
						reclaimOk
					}
				})
			)
			const {
				fresh,
				fixed,
				beside,
				claimStatements,
				claimFootprint,
				enqueueMs,
				enqueueOutcomes,
				deadLeases,
				reclaimed,
				reclaimMs,
				lateSettles,
				reclaimOk
			} = groupA
			const groupB = yield* Effect.scoped(
				Effect.gen(function* () {
					/** Immutable Work: the same load on the second installation. */
					const immutable = yield* holdersOf(
						() => openDb(fxImm, worldsImm.workers.roles.worker),
						claimOf(Qimm),
						settleOfImmutable(Qimm)
					)
					const run = yield* measureRun(
						fxImm.installed.as(worldsImm.workers).role,
						immutable.holders,
						"fresh",
						{ kind: "none" },
						false
					)
					return { run, claimStatements: immutable.claimStatements }
				})
			)
			const immutable = groupB.run

			/** The hand-written SKIP LOCKED claim on the same schema, as the owner. */
			const c = (rel: string, f: string) => fx.column(rel, f)
			const W = fx.table("Work")
			const kind = (handle: string) => fx.handle("Kind", handle)
			const standing = (handle: string) => fx.handle("Standing", handle)
			const resource = (handle: string) => fx.handle("Resource", handle)
			const baselineStats = newStats()
			const pick = (side: ">=" | "<") =>
				`SELECT w.${c("Work", "key")}::text, w.${c("Work", "epoch")}::text FROM ${W} AS w WHERE w.${c("Work", "kind")} = ${kind("render")} AND w.${c("Work", "slot")} = 0 AND w.${c("Work", "standing")} = ${standing("wanted")} AND w.${c("Work", "key")} ${side} $1::text ` +
				`AND EXISTS (SELECT 1 FROM ${fx.table("Wanted")} AS x WHERE x.${c("Wanted", "key")} = w.${c("Work", "key")} AND x.${c("Wanted", "due")} <= ${now}) ORDER BY w.${c("Work", "key")} LIMIT 1 FOR UPDATE OF w SKIP LOCKED`
			const seat = (side: ">=" | "<") =>
				`SELECT s.${c("Seat", "seat")}::text FROM ${fx.table("Seat")} AS s WHERE s.${c("Seat", "resource")} = ${resource("gpu")} AND s.${c("Seat", "seat")} ${side} $1::int4 ` +
				`AND NOT EXISTS (SELECT 1 FROM ${fx.table("Leased")} AS l WHERE l.${c("Leased", "resource")} = s.${c("Seat", "resource")} AND l.${c("Leased", "seat")} = s.${c("Seat", "seat")}) ORDER BY s.${c("Seat", "seat")} LIMIT 1 FOR UPDATE OF s SKIP LOCKED`
			const baselineOp = (session: RawSession, w: number): Effect.Effect<OperationResult> => {
				const step = (at: BaselineStep, sql: string, params: ReadonlyArray<string>) =>
					Effect.mapError(session.values(sql, params), (error): BaselineFailure => ({ at, error }))
				const statement = (label: string, sql: string, params: ReadonlyArray<string>) =>
					step({ kind: "statement", label }, sql, params)
				const begin = step({ kind: "begin" }, beginSerializable, [])
				const commit = step({ kind: "commit" }, "COMMIT", [])
				/** The first unlocked row at or after `from`, then below it. */
				const wrapped = (label: string, sql: (side: ">=" | "<") => string, from: string) =>
					Effect.gen(function* () {
						const above = yield* statement(label, sql(">="), [from])
						return above.length > 0 ? above : yield* statement(label, sql("<"), [from])
					})
				const attempt = Effect.gen(function* () {
					const t0 = performance.now()
					yield* begin
					const itemRows = yield* wrapped("pick item", pick, randomDigest())
					const seatRows = yield* wrapped("pick seat", seat, String(w % seats))
					const [item] = trusted<ReadonlyArray<ItemRow>>(itemRows)
					const [free] = trusted<ReadonlyArray<TextRow>>(seatRows)
					if (item === undefined || free === undefined) {
						yield* Effect.orDie(session.values("ROLLBACK", []))
						baselineStats.empty += 1
						baselineStats.claims.push(performance.now() - t0)
						const empty: Outcome = { kind: "rolledBack" }
						return empty
					}
					const [key, current] = item
					const epoch = BigInt(current) + 1n
					yield* statement(
						"lease item",
						`UPDATE ${W} SET ${c("Work", "standing")} = ${standing("leased")}, ${c("Work", "epoch")} = ${epoch} WHERE ${c("Work", "key")} = $1::text`,
						[key]
					)
					yield* statement(
						"delete wanted",
						`DELETE FROM ${fx.table("Wanted")} WHERE ${c("Wanted", "key")} = $1::text`,
						[key]
					)
					yield* statement(
						"insert lease",
						`INSERT INTO ${fx.table("Leased")} (${Arr.join(
							Arr.map(["key", "resource", "seat", "epoch", "expires"], (f) => c("Leased", f)),
							", "
						)}) VALUES ($1::text, ${resource("gpu")}, $2::int4, ${epoch}, ${forever})`,
						[key, free[0]]
					)
					yield* commit
					baselineStats.claims.push(performance.now() - t0)
					baselineStats.leased += 1
					const t1 = performance.now()
					yield* begin
					yield* statement(
						"delete lease",
						`DELETE FROM ${fx.table("Leased")} WHERE ${c("Leased", "key")} = $1::text AND ${c("Leased", "epoch")} = ${epoch}`,
						[key]
					)
					yield* statement(
						"insert done",
						`INSERT INTO ${fx.table("Done")} (${c("Done", "key")}, ${c("Done", "outcome")}) VALUES ($1::text, ${fx.handle("Outcome", "succeeded")})`,
						[key]
					)
					yield* statement(
						"settle item",
						`UPDATE ${W} SET ${c("Work", "standing")} = ${standing("done")} WHERE ${c("Work", "key")} = $1::text`,
						[key]
					)
					yield* commit
					baselineStats.settles.push(performance.now() - t1)
					const committed: Outcome = { kind: "committed" }
					return committed
				}).pipe(
					Effect.catch((failure: BaselineFailure) =>
						Option.match(baselineFailed(failure), {
							onNone: () => Effect.die(failure.error),
							onSome: (failed) => Effect.as(Effect.orDie(session.values("ROLLBACK", [])), failed)
						})
					)
				)
				return withRetries(
					() =>
						Effect.map(attempt, (outcome) =>
							sqlAttempted(outcome, { uniqueAborts: [], label: () => undefined })
						),
					options.retry
				)
			}
			const baselineSampled = yield* Effect.scoped(
				Effect.gen(function* () {
					const baselineSessions = yield* Effect.forEach(
						Arr.map(indices(holderCount), (i) => i),
						(i) => s.session({ ...ownerSession(), label: `m15c queue skip locked ${i}` })
					)
					return yield* sampleRole(
						observer,
						s.owner.role,
						options.roleSampleMs,
						runLoad(baselineSessions, (session, w) => baselineOp(session, w), loadOptions)
					)
				})
			)
			const baseline = baselineSampled.value

			const retryRate = (l: LoadMeasure) => round2(l.retries.total / Math.max(1, l.operations))
			const loadParameters = { holders: holderCount, bound: options.bound }
			const runCase = (name: string, run: Run, workload: string): CaseRecord<"queue"> => ({
				name,
				gates: ["queue"],
				conditions: {
					workload,
					schemaState: loadedByOwner,
					dataDistribution: `${options.pending} pending render items in slot 0 (keys are SHA-256 digests, uniform), ${seats} gpu seats`,
					parameters: loadParameters,
					resultSemantics: "every claim leases one item or finds none; every lease is settled done",
					cacheState: "warm: each holder's Db compiled its claim and settlement before the load"
				},
				phases: {
					...phaseOf("claimMs", run.stats.claims),
					...phaseOf("settleMs", run.stats.settles)
				},
				variants: [],
				comparisons: [],
				transactions: {},
				loads: { holders: run.load },
				measures: {
					claimsPerSecond: run.claimsPerSecond,
					...p95Of("claimP95Ms", run.stats.claims),
					...p95Of("settleP95Ms", run.stats.settles),
					retryRate: retryRate(run.load),
					retriesByReason: Formatter.format(run.load.retries.byReason),
					retriesByLabel: Formatter.format(run.load.retries.byLabel),
					leased: run.stats.leased,
					leasedPerHolder: round2(run.stats.leased / holderCount),
					empty: run.stats.empty,
					rejected: run.stats.rejected,
					transient: run.stats.transient,
					unavailableByReason: tally(run.stats.unavailable),
					settlements: tally(run.stats.settled),
					settlementsUnavailable: tally(run.stats.settleUnavailable),
					serverWidthMax: run.role.backends.max,
					activeBackends: run.role.active,
					lockWaitSessionMs: run.role.lockWaitSessionMs,
					...(run.predicateLocks.kind === "notSampled"
						? {}
						: {
								predicateLockSamples: run.predicateLocks.samples,
								predicateLocksMaxTotal: run.predicateLocks.maxTotal,
								predicateLocksMax: Formatter.format(run.predicateLocks.max)
							})
				}
			})
			const besideCase = runCase(
				"an enqueue beside the claimers",
				beside,
				`fresh random start keys while one enqueuer applies batches of ${options.enqueueBatch} new items`
			)
			const cases: Array<CaseRecord<"queue">> = [
				runCase(
					"fresh random start keys, mutable Work",
					fresh,
					"each holder claims from a fresh random key per claim, then settles"
				),
				runCase(
					"fixed start keys, mutable Work",
					fixed,
					"each holder claims from its own fixed random key, then settles"
				),
				{
					...besideCase,
					phases: { ...besideCase.phases, ...phaseOf("enqueueMs", enqueueMs) },
					measures: { ...besideCase.measures, enqueueOutcomes: tally(enqueueOutcomes) }
				},
				runCase(
					"fresh random start keys, immutable Work",
					immutable,
					"the same load with Work immutable"
				),
				{
					name: "reclaim after worker loss",
					gates: ["queue"],
					conditions: {
						workload: `${options.dead} transcode items leased on cpu with leases already expired and never settled; a live holder reclaims each, then the dead worker settles late`,
						schemaState: loadedByOwner,
						dataDistribution: `${options.dead} transcode items, ${options.dead} cpu seats`,
						parameters: {},
						resultSemantics:
							"each reclaim takes the next epoch in the dead lease's seat; each late settlement is no-change",
						cacheState: "warm: each holder's Db compiled its claim and settlement before the load"
					},
					phases: phaseOf("reclaimMs", reclaimMs),
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						deadLeases: deadLeases.length,
						reclaimed: reclaimed.length,
						lateSettlements: Arr.join(lateSettles, ", "),
						mutableClaimStatements: Arr.join(
							Arr.map(claimStatements, (x) => labelText(x.label)),
							", "
						),
						immutableClaimStatements: Arr.join(
							Arr.map(groupB.claimStatements, (x) => labelText(x.label)),
							", "
						)
					}
				},
				{
					name: "one claim's statements and predicate locks",
					gates: ["queue"],
					conditions: {
						workload: `with ${claimFootprint.live} leases held and not settled, one more claim on a Db of its own reads its own SSI read locks just before its COMMIT, and EXPLAIN (GENERIC_PLAN) of each statement it ran; then every lease is settled`,
						schemaState: loadedByOwner,
						dataDistribution: `the mutable installation after its loads; ${seats} gpu seats`,
						parameters: {},
						resultSemantics:
							"information for the transient failure analysis: the claim's SQL, its plans, and the predicate locks one claim holds",
						cacheState: "warm: the probing Db compiled its claim before the probe"
					},
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						held: claimFootprint.held,
						probeOutcome: claimFootprint.probeOutcome,
						...(claimFootprint.probeTransient === undefined
							? {}
							: { probeTransient: claimFootprint.probeTransient.reason }),
						indexes: Arr.join(installedIndexes, "\n"),
						predicateLocks: Formatter.format(lockCounts(claimFootprint.locks)),
						predicateLockSettings: `max_pred_locks_per_transaction / per_relation / per_page: ${claimFootprint.settings}`,
						claimPlans: Arr.join(claimFootprint.plans, "\n"),
						mutableClaimSql: Arr.join(
							Arr.map(claimStatements, (x, i) => `-- statement ${i + 1}\n${x.sql}`),
							"\n"
						),
						immutableClaimSql: Arr.join(
							Arr.map(groupB.claimStatements, (x, i) => `-- statement ${i + 1}\n${x.sql}`),
							"\n"
						),
						settleSql: Arr.join(
							Arr.map(claimFootprint.settleStatements, (x, i) => `-- statement ${i + 1}\n${x.sql}`),
							"\n"
						)
					}
				},
				{
					name: "the hand-written SKIP LOCKED claim",
					gates: ["queue"],
					conditions: {
						workload:
							"each holder claims the first unlocked wanted item from a fresh random key and the first unlocked free seat from its own, with FOR UPDATE SKIP LOCKED, then settles",
						schemaState: loadedByOwner,
						dataDistribution: `the same installation after the grizzle loads; ${seats} gpu seats`,
						parameters: loadParameters,
						resultSemantics: "every claim leases one item or finds none; the laws hold at COMMIT",
						cacheState: "warm sessions; each holder's operations run back to back"
					},
					phases: {
						...phaseOf("claimMs", baselineStats.claims),
						...phaseOf("settleMs", baselineStats.settles)
					},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: { holders: baseline },
					measures: {
						claimsPerSecond: round2((baselineStats.leased / baseline.wallMs) * 1000),
						...p95Of("claimP95Ms", baselineStats.claims),
						retryRate: retryRate(baseline),
						leased: baselineStats.leased,
						empty: baselineStats.empty,
						serverWidthMax: baselineSampled.role.backends.max
					}
				}
			]
			const runs = [fresh, fixed, beside, immutable]
			const workRelation = fx.relationName("Work")
			const wantedRelation = fx.relationName("Wanted")
			const keyed = Arr.filter(
				claimFootprint.reads,
				(r) => r.relation === workRelation || r.relation === wantedRelation
			)
			/** The reads of Wanted in the generic plan of the claim's deletion of Wanted, a statement numbered from one. */
			const wantedDeletions = writesOf(claimStatements, Wanted.name)
			const deletionReads = Arr.filter(
				claimFootprint.reads,
				(r) =>
					r.relation === wantedRelation &&
					Arr.some(wantedDeletions, (w) => w.position + 1 === r.statement)
			)
			const locks = claimFootprint.locks
			/**
			 * The accepted claims of each installation's runs, by their read-backs: the mutable installation's three runs, and
			 * the immutable one's.
			 */
			const mutableLeases = Arr.flatMap([fresh, fixed, beside], (r) => r.stats.claimed)
			const immutableLeases = immutable.stats.claimed

			const queue: VerdictInput = {
				checks: [
					mechanism(
						"the claim's put of Work is the displacing DELETE then the put's INSERT in both declarations (Work's UNIQUE (key, standing))",
						putsWorkAsPair(claimStatements) && putsWorkAsPair(groupB.claimStatements),
						`${Arr.join(Arr.map(writesOf(claimStatements, QueueWork.name), labelText), ", ")} | ${Arr.join(Arr.map(writesOf(groupB.claimStatements, QueueWork.name), labelText), ", ")}`
					),
					mechanism(
						"every claim ends accepted or no-change: none is refused by a law",
						Arr.every(runs, (r) => r.stats.rejected === 0),
						Arr.join(
							Arr.map(runs, (r) => String(r.stats.rejected)),
							", "
						)
					),
					mechanism(
						"no settlement of a live lease is invariant-rejected or no-change",
						Arr.every(
							runs,
							(r) => !r.stats.settled.has("invariant-rejected") && !r.stats.settled.has("no-change")
						),
						Arr.join(
							Arr.map(runs, (r) => tally(r.stats.settled)),
							" "
						)
					),
					mechanism(
						"reclaim after worker loss: the next epoch in the dead lease's seat, and the late settlement is no-change",
						reclaimOk && Arr.every(lateSettles, (k) => k === "no-change"),
						Formatter.format({ dead: deadLeases.length, reclaimed: reclaimed.length, lateSettles })
					),
					mechanism(
						"one claim's every read of Work and Wanted in its generic plans is an index scan with an index condition: key seeks and key joins, no sequential or unbounded scan",
						keyed.length > 0 && Arr.every(keyed, (r) => r.bounded),
						Arr.join(Arr.map(keyed, showRead), "; ")
					),
					mechanism(
						"the claim's deletion of Wanted reads Wanted once in its generic plan, by an index condition: one probe per claim",
						wantedDeletions.length === 1 &&
							deletionReads.length === 1 &&
							Arr.every(deletionReads, (r) => r.bounded),
						Arr.join(Arr.map(deletionReads, showRead), "; ")
					),
					mechanism(
						"one claim's SSI read locks on Work, Wanted and their indexes are tuple or page locks, never the relation",
						Arr.some(locks, (l) => l.relation === workRelation) &&
							Arr.some(locks, (l) => l.relation === wantedRelation) &&
							!Arr.some(
								locks,
								(l) =>
									(l.table === workRelation || l.table === wantedRelation) &&
									l.locktype === "relation"
							),
						Formatter.format(lockCounts(locks))
					),
					equivalence(
						"no two accepted claims leased the same (key, epoch)",
						distinctLeases(mutableLeases) && distinctLeases(immutableLeases),
						`${mutableLeases.length} leases of mutable Work, ${immutableLeases.length} of immutable Work`
					)
				]
			}
			return { cases, verdicts: { queue } }
		})
})
