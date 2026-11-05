import { Array as Arr, Effect, Formatter, Record as Rec, Result } from "effect"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	committedOrConflicted,
	type RetryPolicy,
	retried,
	runLoad,
	sqlAttempted,
	withRetries
} from "#bench/harness/load.ts"

import {
	measureTransaction,
	summarizeTransactions,
	type TransactionMeasure,
	type TransactionSeries
} from "#bench/harness/transaction.ts"
import { fill, GateSetupError, settle } from "#bench/query/support/kit.ts"
import {
	attemptLabel,
	baselineSchema,
	installWrites,
	lawObjects,
	loadedByOwner,
	loginRoleOf,
	observedChange,
	oneRow,
	openFull,
	owner,
	plainStatement,
	probeLaws,
	residualLaw,
	tableScans,
	timedSamples,
	transactionOf,
	warmedOnce,
	writeConditions,
	writePhases,
	writerSession
} from "#bench/write/support/writes.ts"
import { indices, maxOf } from "#compiler/core/array.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { fieldNames } from "#compiler/ir/law.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import {
	capacity,
	contained,
	key,
	on,
	ref,
	relation,
	schema,
	select,
	within
} from "#compiler/public/schema.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * R19: capacity checks are one indexed group aggregate per affected key.
 *
 * "Measure commit latency for batches that touch one group many times and for wide groups, against hand-written
 * trigger equivalents; lock-wait time and throughput of one hot group, with grizzle and direct SQL writers, against its
 * seat-fact form; and that of two writers at the bound of one group, one commits and the other's COMMIT raises with the
 * law's identity. Verify that the partial-unique specialization removes
 * the law function and its triggers entirely for filtered at-most-one laws".
 *
 * The fixture: Grp(id, bound) and Member(id, grp) under `capacity(on(Grp, "id"), { from: on(Member, "grp"), within:
 * within(0n, ref("bound")) })` with Member contained in Grp, a residual law; Ticket and Note under a filtered
 * at-most-one capacity, which the compiler specializes to a partial UNIQUE; and the seat-fact form of a hot bound,
 * Lane, LaneSeat and Holder with a key on (lane, seat) and a containment into LaneSeat, which is native. The
 * hand-written equivalent is the same two tables in a schema of their own with what a PostgreSQL expert writes for an
 * upper bound: an index on member(grp) and one deferred constraint trigger on member insertion that locks the group
 * row by the same no-op UPDATE and then counts the group as a later statement. The direct SQL writers
 * log in as the full world's login and take on its theory role; the grizzle writers are Dbs of that role, each opened
 * through a DbLayer of its own.
 *
 * Batches and wide groups are measured as direct SQL transactions with SET CONSTRAINTS ALL IMMEDIATE timed apart
 * (deferredChecksMs, the law's commit-time work) and COMMIT after it (commitMs), and as whole grizzle applications
 * (operationMs); the hand-written equivalent's timings are information beside them. The hot group is a concurrent load
 * whose lock waits are sampled from pg_stat_activity. Its writers, SQL and grizzle alike, run SERIALIZABLE and retry a
 * transient failure on the caller's side, as an application does (bench/harness/load.ts withRetries): the gate measures
 * what each attempt does, a commit or a serialization failure or deadlock, never the caller's retry policy; so do the
 * two writers at the bound. The law is named by its declaration (S-NAMES) and its objects
 * are read from the installation record.
 */
const Grp = relation("Grp", { id: pg.integer, bound: pg.integer }, ["id"])
const Member = relation("Member", { id: pg.bigint, grp: pg.integer }, ["id"])
const Ticket = relation("Ticket", { id: pg.integer }, ["id"])
const Note = relation("Note", { id: pg.bigint, ticket: pg.integer, open: pg.boolean }, ["id"])
const Lane = relation("Lane", { id: pg.integer }, ["id"])
const LaneSeat = relation("LaneSeat", { lane: pg.integer, seat: pg.integer }, ["lane", "seat"])
const Holder = relation("Holder", { id: pg.bigint, lane: pg.integer, seat: pg.integer }, ["id"])

/** The capacity the gate measures: a group's members within its bound. */
const groupCapacity = capacity(on(Grp, "id"), {
	from: on(Member, "grp"),
	within: within(0n, ref("bound"))
})

const build = (name: string) =>
	schema(name, { Grp, Member, Ticket, Note, Lane, LaneSeat, Holder }, [
		groupCapacity,
		contained(on(Member, "grp"), on(Grp, "id")),
		capacity(on(Ticket, "id"), {
			from: on(select(Note, { open: true }), "ticket"),
			within: within(0n, 1n)
		}),
		contained(on(Note, "ticket"), on(Ticket, "id")),
		contained(on(LaneSeat, "lane"), on(Lane, "id")),
		key(Holder, ["lane", "seat"]),
		contained(on(Holder, "lane", "seat"), on(LaneSeat, "lane", "seat"))
	])

interface Options extends Readonly<Record<string, unknown>> {
	/** Members one batch inserts into one group. */
	readonly batches: ReadonlyArray<number>
	/** Members of the wide group. */
	readonly wide: number
	readonly samples: number
	/** Concurrent writers of the hot group, and the operations each runs. */
	readonly writers: number
	readonly operations: number
	/** The writers' retry policy, an application's own. */
	readonly retry: RetryPolicy
	/** How often the lock-wait sampler reads the writers' wait events, in milliseconds. */
	readonly lockSampleMs: number
}

/** Group ids: one fresh group per batch sample, the wide group, the hot group, and the group at its bound. */
const wideGroup = 900001
const hotGroup = 900002
const boundGroup = 900003
const boundGroupGrizzle = 900004
const hotLane = 1
/** The first of the groups the grizzle batches insert into. */
const grizzleGroups = 500000

type PidRow = readonly [pid: string]
type CountPair = readonly [first: string, second: string]

const membersSql = (
	table: string,
	idCol: string,
	grpCol: string,
	first: number,
	n: number,
	grp: number
) =>
	`INSERT INTO ${table} (${idCol}, ${grpCol}) SELECT ${first} + g, ${grp} FROM pg_catalog.generate_series(1, ${n}) AS g`

const split = (sql: string) => transactionOf([plainStatement("insert", sql, [])], "split")

const once = (sql: string) => transactionOf([plainStatement("insert", sql, [])], "plain")

/** @internal */
export default defineGate({
	name: "write-capacity",
	gates: ["R19"],
	title:
		"Residual capacity: batches on one group, wide groups, one hot group, the bound race, the partial UNIQUE",
	scope:
		"A count capacity against a ref bound over Grp and Member, against a hand-written deferred trigger and the " +
		"seat-fact form; commit-time law work split from COMMIT; lock waits sampled from pg_stat_activity.",
	phases: writePhases,
	options: {
		full: {
			batches: [1, 10, 100, 1000],
			wide: 100000,
			samples: 15,
			writers: 16,
			operations: 40,
			retry: { times: 4, baseMs: 5 },
			lockSampleMs: 5
		},
		quick: {
			batches: [1, 20],
			wide: 2000,
			samples: 2,
			writers: 3,
			operations: 3,
			retry: { times: 4, baseMs: 5 },
			lockSampleMs: 5
		}
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const fx = yield* installWrites(build("Caps"), "benchcapacity", {
				programs: {},
				logins: []
			})
			const S = build(fx.installed.declared)
			const law = namesOf(fx.installed).lawOf(groupCapacity)
			/** An outcome's law read back to its LawId. */
			const reported = namesOf(fx.installed).reported
			const G = fx.table("Grp")
			const M = fx.table("Member")
			const memberTable = fx.relationName("Member")
			const c = (rel: string, f: string) => fx.column(rel, f)
			const batchGroups = options.batches.length * options.samples
			const maxBatch = maxOf(options.batches, Number.NEGATIVE_INFINITY)
			yield* fill(fx, "Grp", batchGroups, { id: "g::int4", bound: `${maxBatch * 2}::int4` })
			yield* fill(fx, "Grp", options.batches.length * (options.samples + 1), {
				id: `(${grizzleGroups} + g - 1)::int4`,
				bound: `${maxBatch * 2}::int4`
			})
			yield* owner(
				`INSERT INTO ${G} (${c("Grp", "id")}, ${c("Grp", "bound")}) VALUES (${wideGroup}, ${options.wide * 2}), (${hotGroup}, 1000000000), (${boundGroup}, 3), (${boundGroupGrizzle}, 3)`
			)
			yield* owner(`ALTER TABLE ${M} DISABLE TRIGGER USER`)
			yield* fill(fx, "Member", options.wide, {
				id: "(10000000 + g)::int8",
				grp: `${wideGroup}::int4`
			})
			yield* owner(`ALTER TABLE ${M} ENABLE TRIGGER USER`)
			yield* owner(
				`INSERT INTO ${M} (${c("Member", "id")}, ${c("Member", "grp")}) VALUES (1, ${boundGroup}), (2, ${boundGroup}), (3, ${boundGroupGrizzle}), (4, ${boundGroupGrizzle})`
			)
			yield* owner(`INSERT INTO ${fx.table("Lane")} (${c("Lane", "id")}) VALUES (${hotLane})`)
			yield* fill(fx, "LaneSeat", options.writers * options.operations * 4 + 16, {
				lane: `${hotLane}::int4`,
				seat: "g::int4"
			})

			/**
			 * Every grizzle writer's Db opens before the hand-written baseline exists: admission refuses a database that
			 * co-hosts a schema the snapshot does not know (the database is grizzle's), and it runs at Db.open.
			 */
			const db = yield* openFull(fx, S)
			const dbs = yield* Effect.forEach(
				Arr.map(indices(options.writers), (i) => i),
				() => openFull(fx, S)
			)
			/** The hand-written equivalent, in a schema of its own. */
			const B = yield* baselineSchema("benchcaphand")
			yield* owner(
				`CREATE TABLE ${B}.grp (id int4 PRIMARY KEY, bound int4 NOT NULL)`,
				`CREATE TABLE ${B}.member (id int8 PRIMARY KEY, grp int4 NOT NULL REFERENCES ${B}.grp (id))`,
				`CREATE INDEX ON ${B}.member (grp)`,
				`CREATE FUNCTION ${B}.member_cap() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE b int4; n int8;
BEGIN
	UPDATE ${B}.grp SET id = id WHERE id = NEW.grp RETURNING bound INTO b;
	IF NOT FOUND THEN RETURN NULL; END IF;
	SELECT count(*) INTO n FROM ${B}.member WHERE grp = NEW.grp;
	IF n > b THEN
		RAISE EXCEPTION USING ERRCODE = '23000', CONSTRAINT = 'grp_member_count', MESSAGE = 'capacity of grp exceeded';
	END IF;
	RETURN NULL;
END $f$`,
				`CREATE CONSTRAINT TRIGGER member_cap AFTER INSERT ON ${B}.member DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${B}.member_cap()`,
				`INSERT INTO ${B}.grp SELECT g, ${maxBatch * 2} FROM pg_catalog.generate_series(1, ${batchGroups}) AS g`,
				`INSERT INTO ${B}.grp VALUES (${wideGroup}, ${options.wide * 2})`,
				`ALTER TABLE ${B}.member DISABLE TRIGGER member_cap`,
				`INSERT INTO ${B}.member SELECT 10000000 + g, ${wideGroup} FROM pg_catalog.generate_series(1, ${options.wide}) AS g`,
				`ALTER TABLE ${B}.member ENABLE TRIGGER member_cap`
			)
			yield* settle(fx)
			yield* owner(`VACUUM (ANALYZE) ${B}.grp`, `VACUUM (ANALYZE) ${B}.member`)

			const writer = yield* writerSession(fx, fx.world.app, "m15c capacity writer")
			const hand = yield* s.session({ ...ownerSession(), label: "m15c capacity hand-written" })
			const insertMembers = (ids: ReadonlyArray<bigint>, grp: number) => {
				const change = observedChange(
					db,
					ChangeSet.empty(S).insert(
						Member,
						Arr.map(ids, (id) => ({ id, grp }))
					),
					attemptLabel,
					{ kind: "none" }
				)
				return Result.isFailure(change) ? Effect.die(change.failure) : change.success.apply({})
			}

			/** 1. Batches touching one group many times: one statement inserting K members into a fresh group. */
			let nextGroup = 1
			let grizzleGroup = grizzleGroups
			let nextId = 20000000
			const batchCases: Array<CaseRecord<"R19">> = []
			const generatedBatches: Array<TransactionSeries> = []
			let lawCallsMatch = true
			const lawCalls: Array<number> = []
			const memberSeqScans: Array<number> = []
			for (const k of options.batches) {
				const generated: Array<TransactionMeasure> = []
				const handwritten: Array<TransactionMeasure> = []
				for (let i = 0; i < options.samples; i++) {
					const grp = nextGroup++
					const generatedRun = yield* measureTransaction(
						writer,
						split(membersSql(M, c("Member", "id"), c("Member", "grp"), nextId, k, grp))
					)
					generated.push(generatedRun)
					const handRun = yield* measureTransaction(
						hand,
						split(membersSql(`${B}.member`, "id", "grp", nextId, k, grp))
					)
					handwritten.push(handRun)
					nextId += k
				}
				/**
				 * The law's triggers set IMMEDIATE: the explained insert fires the law once per inserted row, and the aggregate
				 * reads Member through its index, never by a sequential scan.
				 */
				const probe = yield* probeLaws(
					writer,
					fx,
					law,
					[
						membersSql(M, c("Member", "id"), c("Member", "grp"), nextId + 5000000, k, nextGroup - 1)
					],
					[]
				)
				lawCalls.push(probe.total)
				if (probe.total !== k) {
					lawCallsMatch = false
				}
				const memberScans = tableScans(probe.scans, memberTable)
				memberSeqScans.push(memberScans.seq)
				const grizzle = yield* timedSamples(
					options.samples,
					() => {
						const ids = Arr.map(indices(k), (j) => BigInt(nextId + j))
						nextId += k
						return insertMembers(ids, grizzleGroup++)
					},
					1
				)
				const g = summarizeTransactions(generated)
				const h = summarizeTransactions(handwritten)
				generatedBatches.push(g)
				batchCases.push({
					name: `a batch of ${k} members into one group`,
					gates: ["R19"],
					conditions: writeConditions({
						workload: `one INSERT of ${k} members into one empty group, then the deferred checks and COMMIT`,
						schemaState: loadedByOwner,
						data: `${batchGroups} groups, each measured once from empty; bound ${maxBatch * 2}`,
						parameters: { members: k },
						semantics: "every batch is within the bound and commits",
						cache: warmedOnce
					}),
					phases: { operationMs: grizzle.ms },
					variants: [],
					comparisons: [],
					transactions: { generated: g, handwritten: h },
					loads: {},
					measures: {
						lawTriggerCalls: probe.total,
						memberSeqScans: memberScans.seq,
						memberIndexScans: memberScans.idx,
						scans: Formatter.format(probe.scans)
					}
				})
			}
			/** 2. A wide group: one member inserted into a group of `wide` members. */
			const wideGenerated: Array<TransactionMeasure> = []
			const wideHand: Array<TransactionMeasure> = []
			for (let i = 0; i < options.samples; i++) {
				const wideGeneratedRun = yield* measureTransaction(
					writer,
					split(membersSql(M, c("Member", "id"), c("Member", "grp"), nextId, 1, wideGroup))
				)
				wideGenerated.push(wideGeneratedRun)
				const wideHandRun = yield* measureTransaction(
					hand,
					split(membersSql(`${B}.member`, "id", "grp", nextId, 1, wideGroup))
				)
				wideHand.push(wideHandRun)
				nextId += 1
			}
			const wideGrizzle = yield* timedSamples(
				options.samples,
				() => insertMembers([BigInt(nextId++)], wideGroup),
				0
			)

			/** 3. One hot group: direct SQL writers, grizzle writers, and the seat-fact form. */
			const sessions = yield* Effect.forEach(
				Arr.map(indices(options.writers), (i) => i),
				(i) => writerSession(fx, fx.world.app, `m15c capacity hot ${i}`)
			)
			const observer = yield* s.session({ ...ownerSession(), label: "m15c capacity observer" })
			const pids = yield* Effect.forEach(sessions, (x) => x.pid)
			const sampler = (sampled: ReadonlyArray<number>) =>
				({
					kind: "sampled",
					observer,
					pids: sampled,
					intervalMs: options.lockSampleMs,
					onSample: () => Effect.void
				}) as const
			const directHot = yield* runLoad(
				sessions,
				(session) => {
					const id = nextId++
					return withRetries(
						() =>
							Effect.map(
								measureTransaction(
									session,
									once(membersSql(M, c("Member", "id"), c("Member", "grp"), id, 1, hotGroup))
								),
								(m) => sqlAttempted(m.outcome, { uniqueAborts: [], label: () => undefined })
							),
						options.retry
					)
				},
				{ bound: { kind: "operations", n: options.operations }, sampler: sampler(pids) }
			)
			let nextSeat = 1
			const seatHot = yield* runLoad(
				sessions,
				(session) => {
					const id = nextId++
					const seat = nextSeat++
					return withRetries(
						() =>
							Effect.map(
								measureTransaction(
									session,
									once(
										`INSERT INTO ${fx.table("Holder")} (${c("Holder", "id")}, ${c("Holder", "lane")}, ${c("Holder", "seat")}) VALUES (${id}, ${hotLane}, ${seat})`
									)
								),
								(m) => sqlAttempted(m.outcome, { uniqueAborts: [], label: () => undefined })
							),
						options.retry
					)
				},
				{ bound: { kind: "operations", n: options.operations }, sampler: sampler(pids) }
			)
			const rows = yield* s.admin.queryValues(
				"SELECT pid::text FROM pg_catalog.pg_stat_activity WHERE usename = $1::name AND datname = pg_catalog.current_database() AND pid <> ALL ($2::int4[])",
				[loginRoleOf(fx), `{${Arr.join(Arr.map(pids, String), ",")}}`]
			)
			const grizzlePids = Arr.map(trusted<ReadonlyArray<PidRow>>(rows), ([pid]) => Number(pid))
			const grizzleHot = yield* runLoad(
				dbs,
				(d) => {
					const id = BigInt(nextId++)
					const change = observedChange(
						d,
						ChangeSet.empty(S).insert(Member, [{ id, grp: hotGroup }]),
						attemptLabel,
						{ kind: "none" }
					)
					if (Result.isFailure(change)) {
						return Effect.die(change.failure)
					}
					const apply = change.success.apply
					return withRetries(() => Effect.map(apply({}), (o) => o.attempted), options.retry)
				},
				{ bound: { kind: "operations", n: options.operations }, sampler: sampler(grizzlePids) }
			)

			/**
			 * 4. Two writers at the bound of one group: one commits, the other's COMMIT raises with the law's identity, after
			 * any retry of a serialization failure or deadlock.
			 */
			const [a, b] = sessions
			if (a === undefined || b === undefined) {
				return yield* Effect.die(new GateSetupError({ what: "two writers are needed" }))
			}
			const race = yield* Effect.forEach(
				[a, b],
				(session, i) =>
					withRetries(
						() =>
							Effect.map(
								measureTransaction(
									session,
									once(
										membersSql(
											M,
											c("Member", "id"),
											c("Member", "grp"),
											30000000 + i * 10,
											1,
											boundGroup
										)
									)
								),
								(m) => sqlAttempted(m.outcome, { uniqueAborts: [], label: () => undefined })
							),
						options.retry
					),
				{ concurrency: "unbounded" }
			)
			const raceOutcomes = Arr.map(race, (r) => r.outcome)
			const raceRetries = Arr.flatMap(race, (r) => Arr.map(r.retries, (x) => x.reason))
			const raceCommitted = Arr.filter(raceOutcomes, (o) => o.kind === "committed").length
			/** The law's refusal at COMMIT: its SQLSTATE with the law's identity as the constraint name. */
			const raceRefused = Arr.filter(
				raceOutcomes,
				(o) =>
					o.kind === "failed" &&
					o.at === "commit" &&
					o.sqlstate === sqlstates.integrityConstraintViolation &&
					o.constraint.kind === "named" &&
					o.constraint.name === law
			).length
			const [d1, d2] = dbs
			if (d1 === undefined || d2 === undefined) {
				return yield* Effect.die(new GateSetupError({ what: "two grizzle writers are needed" }))
			}
			const grizzleRace = yield* Effect.forEach(
				[d1, d2],
				(d, i) => {
					const change = observedChange(
						d,
						ChangeSet.empty(S).insert(Member, [
							{ id: BigInt(30000100 + i), grp: boundGroupGrizzle }
						]),
						attemptLabel,
						{ kind: "none" }
					)
					if (Result.isFailure(change)) {
						return Effect.die(change.failure)
					}
					const apply = change.success.apply
					return retried(
						() => apply({}),
						(o) => o.attempted.transient,
						options.retry
					)
				},
				{ concurrency: "unbounded" }
			)
			const grizzleKinds = Arr.map(grizzleRace, (o) => o.last.value.kind)
			const grizzleRejectedByLaw = Arr.filter(
				grizzleRace,
				(o) => o.last.value.kind === "invariant-rejected" && reported(o.last.value.law) === law
			).length
			const grizzleRaceRetries = Arr.flatMap(grizzleRace, (o) =>
				Arr.map(o.retries, (r) => r.reason)
			)
			const boundCounts = yield* s.admin.queryValues(
				`SELECT (SELECT count(*) FROM ${M} WHERE ${c("Member", "grp")} = ${boundGroup})::text, (SELECT count(*) FROM ${M} WHERE ${c("Member", "grp")} = ${boundGroupGrizzle})::text`,
				[]
			)
			const [boundText, boundGrizzleText] = trusted<CountPair>(oneRow(boundCounts))
			const boundMembers = Number(boundText)
			const boundMembersGrizzle = Number(boundGrizzleText)

			/** 5. The partial-unique specialization, read from the installation record beside the catalog it installed. */
			const objects = yield* lawObjects(fx)
			const laws = fx.installed.installation.laws
			const residual = residualLaw(fx, law)
			const participantRelations = new Set(Arr.map(residual.participants, (p) => p.relation.name))
			const specialized: ReadonlyArray<string> = [Ticket.name, Note.name]
			const notePartialUnique = Arr.flatMap(laws.natives, (n) =>
				n.object.kind === "PartialUnique" && n.object.relation.name === Note.name ? [n.object] : []
			)

			const w = summarizeTransactions(wideGenerated)
			const wh = summarizeTransactions(wideHand)
			const lockWaits = (name: string, load: typeof directHot) =>
				load.lockWaits.kind === "observed" ? { [name]: load.lockWaits.value.lockWaitSessionMs } : {}
			const cases: Array<CaseRecord<"R19">> = [
				...batchCases,
				{
					name: `one member into a group of ${options.wide}`,
					gates: ["R19"],
					conditions: writeConditions({
						workload:
							"one INSERT of one member into the wide group, then the deferred checks and COMMIT",
						schemaState: loadedByOwner,
						data: `one group of ${options.wide} members, growing by one per sample`,
						parameters: { members: options.wide },
						semantics: "within the bound; commits",
						cache: warmedOnce
					}),
					phases: { operationMs: wideGrizzle.ms },
					variants: [],
					comparisons: [],
					transactions: { generated: w, handwritten: wh },
					loads: {},
					measures: {}
				},
				{
					name: `one hot group, ${options.writers} writers`,
					gates: ["R19"],
					conditions: writeConditions({
						workload: "each writer inserts one member into the same group per transaction",
						schemaState: loadedByOwner,
						data: "the hot group's bound is far above the load; Holder seats are distinct per operation",
						parameters: { writers: options.writers, operations: options.operations },
						semantics:
							"each attempt commits or fails with a serialization failure or a deadlock (40001, 40P01), which the harness retries",
						cache: "warm sessions; each writer's operations run back to back"
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: { directSql: directHot, grizzle: grizzleHot, seatFacts: seatHot },
					measures: {
						directCommittedPerSecond: directHot.committedPerSecond,
						grizzleCommittedPerSecond: grizzleHot.committedPerSecond,
						grizzleRetriesPerOperation: grizzleHot.retries.perOperation,
						seatCommittedPerSecond: seatHot.committedPerSecond,
						...lockWaits("directLockWaitSessionMs", directHot),
						...lockWaits("grizzleLockWaitSessionMs", grizzleHot),
						...lockWaits("seatLockWaitSessionMs", seatHot)
					}
				},
				{
					name: "two writers at the bound",
					gates: ["R19"],
					conditions: writeConditions({
						workload:
							"two concurrent transactions each insert one member into a group holding bound - 1",
						schemaState: loadedByOwner,
						data: "bound 3, two members",
						parameters: {},
						semantics:
							"one commits; the other is refused at COMMIT with the law's identity, after any retry of a serialization failure or deadlock",
						cache: warmedOnce
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						directOutcomes: Arr.join(
							Arr.map(raceOutcomes, (o) => Formatter.format(o)),
							", "
						),
						directRetries: Arr.join(raceRetries, ", "),
						grizzleOutcomes: Arr.join(grizzleKinds, ", "),
						grizzleRetries: Arr.join(grizzleRaceRetries, ", "),
						finalMembers: `${boundMembers}, ${boundMembersGrizzle}`
					}
				},
				{
					name: "the installed law objects",
					gates: ["R19"],
					conditions: writeConditions({
						workload: "the catalog after installation",
						schemaState: loadedByOwner,
						data: "no facts needed",
						parameters: {},
						semantics: "law functions, triggers and indexes of the fixture's schema",
						cache: warmedOnce
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						functions: Arr.join(objects.functions, ", "),
						triggers: Arr.join(objects.triggers, ", "),
						partialUnique: Arr.join(
							Arr.map(
								notePartialUnique,
								(n) => `${n.relation.name} (${Arr.join(fieldNames(n.columns), ", ")})`
							),
							"; "
						),
						lawFunction: Arr.join(Rec.values(objects.definitions), "\n")
					}
				}
			]
			const r19: VerdictInput = {
				checks: [
					mechanism(
						"one residual law: the capacity over Grp, whose participants are Grp and Member; no law for the filtered at-most-one or the seats",
						laws.residuals.length === 1 &&
							participantRelations.size === 2 &&
							participantRelations.has(Grp.name) &&
							participantRelations.has(Member.name),
						`${Arr.join(
							Arr.map(laws.residuals, (r) => r.lawId),
							", "
						)} | ${Arr.join([...participantRelations], ", ")}`
					),
					mechanism(
						"the partial-unique specialization leaves no residual participant on Ticket or Note, and installs a partial UNIQUE on Note",
						!Arr.some(laws.residuals, (r) =>
							Arr.some(r.participants, (p) => specialized.includes(p.relation.name))
						) && notePartialUnique.length === 1,
						`${Arr.join(
							Arr.flatMap(laws.residuals, (r) =>
								Arr.map([...r.participants.keys()], (p) => `${r.lawId}: ${p}`)
							),
							", "
						)} | ${notePartialUnique.length} partial UNIQUE on Note`
					),
					mechanism(
						"a batch's insertion fires the law once per inserted row (no key deduplication)",
						lawCallsMatch,
						`calls ${Arr.join(Arr.map(lawCalls, String), ", ")} for batches ${Arr.join(Arr.map(options.batches, String), ", ")}`
					),
					mechanism(
						"the group aggregate reads Member through its index, never by a sequential scan",
						Arr.every(memberSeqScans, (n) => n === 0),
						`sequential scans ${Arr.join(Arr.map(memberSeqScans, String), ", ")} for batches ${Arr.join(Arr.map(options.batches, String), ", ")}`
					),
					mechanism(
						"every attempt of a concurrent writer of one group, SQL or grizzle, commits or fails with a serialization failure or a deadlock",
						committedOrConflicted(directHot) && committedOrConflicted(grizzleHot),
						Formatter.format({
							direct: { outcomes: directHot.outcomes, retries: directHot.retries },
							grizzle: { outcomes: grizzleHot.outcomes, retries: grizzleHot.retries }
						})
					),
					equivalence(
						"two direct writers at the bound: one commits, the other's COMMIT raises 23000 with the law's identity, after any retry of a serialization failure or deadlock",
						raceCommitted === 1 && raceRefused === 1,
						Arr.join(
							Arr.map(raceOutcomes, (o) => Formatter.format(o)),
							"; "
						)
					),
					equivalence(
						"two grizzle writers at the bound: one accepted, the other invariant-rejected with the law, after any retry of a TransientFailure",
						Arr.filter(grizzleKinds, (k) => k === "accepted").length === 1 &&
							grizzleRejectedByLaw === 1,
						`${Arr.join(grizzleKinds, ", ")}; ${grizzleRejectedByLaw} rejected with ${law}`
					),
					equivalence(
						"both bound groups end at their bound of three",
						boundMembers === 3 && boundMembersGrizzle === 3,
						`${boundMembers}, ${boundMembersGrizzle}`
					),
					equivalence(
						"every generated batch committed",
						Arr.every(generatedBatches, (t) => t.outcomes.committed === t.samples),
						Arr.join(
							Arr.map(generatedBatches, (t) => Formatter.format(t.outcomes)),
							" | "
						)
					)
				]
			}
			return { cases, verdicts: { R19: r19 } }
		})
})
