import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	committedOrConflicted,
	type LoadMeasure,
	retryPolicy,
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
import { type Fixture, fill, GateSetupError, settle } from "#bench/query/support/kit.ts"
import {
	attemptLabel,
	displacedThenInserted,
	installWrites,
	labelText,
	loadedByOwner,
	type ObservedStatement,
	observedChange,
	openFull,
	plainStatement,
	probeLaws,
	residualLaw,
	timedSamples,
	transactionOf,
	warmedOnce,
	writeConditions,
	writePhases,
	writerSession,
	writesOf,
	writtenInPlace
} from "#bench/write/support/writes.ts"

import { indices } from "#compiler/core/array.ts"
import {
	eventsInOrder,
	type Participant,
	type ParticipantEvents,
	type SidedImage
} from "#compiler/ir/law.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import {
	capacity,
	contained,
	mutable,
	on,
	ref,
	relation as defineRelation,
	schema,
	within
} from "#compiler/public/schema.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * R23: immutability shrinks residual event lists.
 *
 * "Commit latency scales with the group aggregate, not with transaction size. Measure lock-wait time and throughput
 * for one hot group or parent, and event counts and commit latency against the same schema declared `mutable`, which
 * differs only in event lists and `put` realization".
 *
 * Two installations of one schema, a residual count capacity over Grp and Member with a payload field and an
 * unrelated Log relation: the default, where every relation is immutable, and the same schema with Grp and Member
 * declared `mutable`. The law's events per participant are read from each installation record, and its calls per change
 * are counted with its triggers IMMEDIATE; the hot group is a concurrent load of direct SQL writers that insert and
 * delete members of one group, with lock waits sampled from pg_stat_activity, and of grizzle writers doing the same
 * through ChangeSets; every writer runs SERIALIZABLE, and an attempt that fails with a serialization failure or a
 * deadlock is retried on the caller's side as an application does (bench/harness/load.ts withRetries); a `put`'s
 * realization is read from the steps of the statements each declaration compiles it to, and timed through the Db.
 */
const Grp = defineRelation("Grp", { id: pg.integer, bound: pg.integer }, ["id"])
const Member = defineRelation("Member", { id: pg.bigint, grp: pg.integer, note: pg.integer }, [
	"id"
])
const Log = defineRelation("Log", { id: pg.bigint }, ["id"])
const relations = { Grp, Member, Log } as const
/** Each relation's fields, by name: what a mutable participant's UPDATE OF may list. */
const fieldsOf: Readonly<Record<string, ReadonlyArray<string>>> = {
	[Grp.name]: Rec.keys(Grp.fields),
	[Member.name]: Rec.keys(Member.fields),
	[Log.name]: Rec.keys(Log.fields)
}

/** The capacity both installations declare: a group's members within its bound. */
const groupCapacity = capacity(on(Grp, "id"), {
	from: on(Member, "grp"),
	within: within(0n, ref("bound"))
})

const build = (name: string) =>
	schema(name, relations, [groupCapacity, contained(on(Member, "grp"), on(Grp, "id"))])

const buildMutable = (name: string) =>
	schema(name, relations, [
		groupCapacity,
		contained(on(Member, "grp"), on(Grp, "id")),
		mutable(Grp),
		mutable(Member)
	])

interface Options extends Readonly<Record<string, unknown>> {
	/** Unrelated rows a transaction writes beside its one member. */
	readonly sizes: ReadonlyArray<number>
	/** Members of the small and the large group. */
	readonly groupSizes: ReadonlyArray<number>
	readonly samples: number
	readonly writers: number
	readonly operations: number
}

const hot = 1
const bound = 1000000000
/** Groups 10.. are the measured groups, one per group size. */
const sized = 10

/** A participant's event units, each as its kind and the row images it checks. */
const rowEvents = (events: ParticipantEvents) =>
	eventsInOrder<{
		readonly text: string
		readonly kind: string
		readonly images: ReadonlyArray<SidedImage>
	}>(events, {
		insert: (_unit, images) => ({ text: "INSERT", kind: "INSERT", images }),
		delete: (_unit, images) => ({ text: "DELETE", kind: "DELETE", images }),
		update: (unit, images) => ({
			text: `UPDATE OF ${Arr.join(
				Arr.map(unit.on.of, (f) => f.name),
				", "
			)}`,
			kind: "UPDATE",
			images
		})
	})

const participantsText = (participants: ReadonlyArray<Participant>): string =>
	Arr.join(
		Arr.map(
			participants,
			(p) =>
				`${p.relation.name}: ${Arr.join(
					Arr.map(rowEvents(p.events), (e) => e.text),
					", "
				)}`
		),
		" | "
	)

/** The one participant of `relation` among a law's; none is a defect of the gate's setup. */
const participantOn = (participants: ReadonlyArray<Participant>, relation: string): Participant =>
	Option.getOrThrowWith(
		Arr.findFirst(participants, (p) => p.relation.name === relation),
		() => new GateSetupError({ what: `${relation} is no participant of the law` })
	)

const c = <F>(fx: Fixture<F>, rel: string, f: string) => fx.column(rel, f)

const M = <F>(fx: Fixture<F>) => fx.table("Member")

const statementsOf = (db: object, changes: unknown): ReadonlyArray<ObservedStatement> => {
	const change = observedChange(db, changes, attemptLabel, { kind: "none" })
	if (Result.isFailure(change)) {
		throw change.failure
	}
	return change.success.statements
}

const statementsText = (statements: ReadonlyArray<ObservedStatement>) =>
	Arr.join(
		Arr.map(statements, (x) => labelText(x.label)),
		", "
	)

const lockWaits = (name: string, load: LoadMeasure) =>
	load.lockWaits.kind === "observed" ? { [name]: load.lockWaits.value.lockWaitSessionMs } : {}

/** @internal */
export default defineGate({
	name: "write-immutable",
	gates: ["R23"],
	title:
		"Immutable against mutable participants: events, put realization, the hot group, transaction size",
	scope:
		"One residual capacity installed immutable and mutable: law trigger events per change, put statements, " +
		"inserters and deleters of one hot group, and commit-time work by transaction and group size.",
	phases: writePhases,
	options: {
		full: {
			sizes: [0, 1000, 100000],
			groupSizes: [10, 10000],
			samples: 9,
			writers: 16,
			operations: 40
		},
		quick: { sizes: [0, 1000], groupSizes: [10, 1000], samples: 2, writers: 3, operations: 4 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const imm = yield* installWrites(build("Imm"), "benchimm", { programs: {}, logins: [] })
			const mut = yield* installWrites(buildMutable("Mut"), "benchmut", {
				programs: {},
				logins: []
			})
			const Simm = build(imm.installed.declared)
			const Smut = buildMutable(mut.installed.declared)
			const memberCols = <F>(fx: Fixture<F>) =>
				Arr.join(
					Arr.map(["id", "grp", "note"], (f) => c(fx, "Member", f)),
					", "
				)
			const seed = <F>(fx: Fixture<F>) =>
				Effect.gen(function* () {
					yield* fill(fx, "Grp", sized + options.groupSizes.length, {
						id: "g::int4",
						bound: `${bound}::int4`
					})
					let first = 1
					for (const [i, n] of options.groupSizes.entries()) {
						yield* fill(fx, "Member", n, {
							id: `(${first} + g)::int8`,
							grp: `${sized + i + 1}::int4`,
							note: "0::int4"
						})
						first += n
					}
					yield* settle(fx)
				})
			yield* seed(imm)
			yield* seed(mut)
			const lawImm = namesOf(imm.installed).lawOf(groupCapacity)
			const lawMut = namesOf(mut.installed).lawOf(groupCapacity)
			const participantsImm = residualLaw(imm, lawImm).participants
			const participantsMut = residualLaw(mut, lawMut).participants
			const wImm = yield* writerSession(imm, imm.world.app, "m15c immutable writer")
			const wMut = yield* writerSession(mut, mut.world.app, "m15c mutable writer")

			/** 1. Law calls per logical change, each declaration in its own realization. */
			const smallGroup = sized + 1
			const otherGroup = sized + 2
			const callsImm = {
				payload: yield* probeLaws(
					wImm,
					imm,
					lawImm,
					[
						`DELETE FROM ${M(imm)} WHERE ${c(imm, "Member", "id")} = 2`,
						`INSERT INTO ${M(imm)} (${memberCols(imm)}) VALUES (2, ${smallGroup}, 1)`
					],
					[]
				),
				move: yield* probeLaws(
					wImm,
					imm,
					lawImm,
					[
						`DELETE FROM ${M(imm)} WHERE ${c(imm, "Member", "id")} = 2`,
						`INSERT INTO ${M(imm)} (${memberCols(imm)}) VALUES (2, ${otherGroup}, 0)`
					],
					[]
				)
			}
			const callsMut = {
				payload: yield* probeLaws(
					wMut,
					mut,
					lawMut,
					[
						`UPDATE ${M(mut)} SET ${c(mut, "Member", "note")} = 1 WHERE ${c(mut, "Member", "id")} = 2`
					],
					[]
				),
				move: yield* probeLaws(
					wMut,
					mut,
					lawMut,
					[
						`UPDATE ${M(mut)} SET ${c(mut, "Member", "grp")} = ${otherGroup} WHERE ${c(mut, "Member", "id")} = 2`
					],
					[]
				)
			}
			const updateImm = yield* measureTransaction(
				wImm,
				transactionOf(
					[
						plainStatement(
							"update",
							`UPDATE ${M(imm)} SET ${c(imm, "Member", "note")} = 1 WHERE ${c(imm, "Member", "id")} = 2`,
							[]
						)
					],
					"rollback"
				)
			)
			/**
			 * An immutable change of one member is its deletion and its insertion: each fires the law once for each of Member's
			 * events among DELETE and INSERT, every one of which checks one row image.
			 */
			const memberRowEvents = Arr.filter(
				rowEvents(participantOn(participantsImm, Member.name).events),
				(e) => e.kind === "DELETE" || e.kind === "INSERT"
			)

			/** 2. A put of a payload change, as each declaration realizes it. */
			const dbImm = yield* openFull(imm, Simm)
			const dbMut = yield* openFull(mut, Smut)
			let note = 10
			const putImm = () => {
				const change = observedChange(
					dbImm,
					ChangeSet.empty(Simm).put(Member, [{ id: 3n, grp: smallGroup, note: note++ }]),
					attemptLabel,
					{ kind: "none" }
				)
				return Result.isFailure(change) ? Effect.die(change.failure) : change.success.apply({})
			}
			const putMut = () => {
				const change = observedChange(
					dbMut,
					ChangeSet.empty(Smut).put(Member, [{ id: 3n, grp: smallGroup, note: note++ }]),
					attemptLabel,
					{ kind: "none" }
				)
				return Result.isFailure(change) ? Effect.die(change.failure) : change.success.apply({})
			}
			const putStatementsImm = statementsOf(
				dbImm,
				ChangeSet.empty(Simm).put(Member, [{ id: 3n, grp: smallGroup, note: 0 }])
			)
			const putStatementsMut = statementsOf(
				dbMut,
				ChangeSet.empty(Smut).put(Member, [{ id: 3n, grp: smallGroup, note: 0 }])
			)
			const putTimedImm = yield* timedSamples(options.samples, putImm, 1)
			const putTimedMut = yield* timedSamples(options.samples, putMut, 1)

			/** 3. Commit-time work by transaction size and by group size. */
			const sizeSeries = <F>(
				fx: Fixture<F>,
				session: typeof wImm,
				law: typeof lawImm,
				idBase: number
			) =>
				Effect.gen(function* () {
					const bySize: Record<string, TransactionSeries> = {}
					const calls: Record<string, number> = {}
					let id = idBase
					for (const t of options.sizes) {
						const statements = (memberId: number, logFirst: number, grp: number) => [
							`INSERT INTO ${fx.table("Member")} (${memberCols(fx)}) VALUES (${memberId}, ${grp}, 0)`,
							...(t === 0
								? []
								: [
										`INSERT INTO ${fx.table("Log")} (${c(fx, "Log", "id")}) SELECT ${logFirst} + g FROM pg_catalog.generate_series(1, ${t}) AS g`
									])
						]
						const measured: Array<TransactionMeasure> = []
						for (let i = 0; i < options.samples; i++) {
							const measuredRun = yield* measureTransaction(
								session,
								transactionOf(
									Arr.map(statements(id, id * 1000000, smallGroup), (sql, k) =>
										plainStatement(`s${k}`, sql, [])
									),
									"split"
								)
							)
							measured.push(measuredRun)
							id += 1
						}
						bySize[`log${t}`] = summarizeTransactions(measured)
						calls[`log${t}`] = (yield* probeLaws(
							session,
							fx,
							law,
							statements(id + 500000, (id + 500000) * 1000000, smallGroup),
							[]
						)).total
					}
					const byGroup: Record<string, TransactionSeries> = {}
					for (const [g, n] of options.groupSizes.entries()) {
						const measured: Array<TransactionMeasure> = []
						for (let i = 0; i < options.samples; i++) {
							const measuredRun = yield* measureTransaction(
								session,
								transactionOf(
									[
										plainStatement(
											"member",
											`INSERT INTO ${fx.table("Member")} (${memberCols(fx)}) VALUES (${id}, ${sized + g + 1}, 0)`,
											[]
										)
									],
									"split"
								)
							)
							measured.push(measuredRun)
							id += 1
						}
						byGroup[`group${n}`] = summarizeTransactions(measured)
					}
					return { bySize, calls, byGroup }
				})
			const seriesImm = yield* sizeSeries(imm, wImm, lawImm, 50000000)
			const seriesMut = yield* sizeSeries(mut, wMut, lawMut, 50000000)

			/** 4. One hot group: inserters and deleters, direct SQL and grizzle writers. */
			const observer = yield* s.session({ ...ownerSession(), label: "m15c immutable observer" })
			const hotLoad = <F>(fx: Fixture<F>, base: number) =>
				Effect.gen(function* () {
					const sessions = yield* Effect.forEach(
						Arr.map(indices(options.writers), (i) => i),
						(i) => writerSession(fx, fx.world.app, `m15c immutable hot ${i}`)
					)
					const pids = yield* Effect.forEach(sessions, (x) => x.pid)
					return yield* runLoad(
						sessions,
						(session, w, i) => {
							/** Even iterations insert the worker's next member, odd ones delete it. */
							const id = base + w * 100000 + Math.floor(i / 2)
							const sql =
								i % 2 === 0
									? `INSERT INTO ${fx.table("Member")} (${memberCols(fx)}) VALUES (${id}, ${hot}, 0)`
									: `DELETE FROM ${fx.table("Member")} WHERE ${c(fx, "Member", "id")} = ${id}`
							return withRetries(
								() =>
									Effect.map(
										measureTransaction(
											session,
											transactionOf(
												[plainStatement(i % 2 === 0 ? "insert" : "delete", sql, [])],
												"plain"
											)
										),
										(m) => sqlAttempted(m.outcome, { uniqueAborts: [], label: () => undefined })
									),
								retryPolicy
							)
						},
						{
							bound: { kind: "operations", n: options.operations },
							sampler: {
								kind: "sampled",
								observer,
								pids,
								intervalMs: 5,
								onSample: () => Effect.void
							}
						}
					)
				})
			const hotImm = yield* hotLoad(imm, 70000000)
			const hotMut = yield* hotLoad(mut, 70000000)
			const dbs = yield* Effect.forEach(
				Arr.map(indices(options.writers), (i) => i),
				() => openFull(imm, Simm)
			)
			const hotGrizzle: LoadMeasure = yield* runLoad(
				dbs,
				(d, w, i) => {
					const fact = { id: BigInt(80000000 + w * 100000 + Math.floor(i / 2)), grp: hot, note: 0 }
					const changes =
						i % 2 === 0
							? ChangeSet.empty(Simm).insert(Member, [fact])
							: ChangeSet.empty(Simm).delete(Member, [fact])
					const change = observedChange(d, changes, attemptLabel, { kind: "none" })
					if (Result.isFailure(change)) {
						return Effect.die(change.failure)
					}
					const apply = change.success.apply
					return withRetries(() => Effect.map(apply({}), (o) => o.attempted), retryPolicy)
				},
				{ bound: { kind: "operations", n: options.operations }, sampler: { kind: "none" } }
			)

			const cases: Array<CaseRecord<"R23">> = [
				{
					name: "law calls per change, immutable and mutable",
					gates: ["R23"],
					conditions: writeConditions({
						workload:
							"a payload change and a group move of one member, as a DELETE and an INSERT (immutable) and as an UPDATE (mutable), with the law's triggers IMMEDIATE, rolled back",
						schemaState: loadedByOwner,
						data: `groups of ${Arr.join(Arr.map(options.groupSizes, String), " and ")} members`,
						parameters: {},
						semantics: "every change keeps the bound",
						cache: warmedOnce
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						immutablePayloadCalls: callsImm.payload.total,
						immutableMoveCalls: callsImm.move.total,
						mutablePayloadCalls: callsMut.payload.total,
						mutableMoveCalls: callsMut.move.total,
						immutableEvents: participantsText(participantsImm),
						mutableEvents: participantsText(participantsMut),
						immutableUpdate: Formatter.format(updateImm.outcome)
					}
				},
				{
					name: "a put of a payload change",
					gates: ["R23"],
					conditions: writeConditions({
						workload: "db.apply of an enumerated put changing one member's payload",
						schemaState: loadedByOwner,
						data: "the member exists with another payload",
						parameters: {},
						semantics: "accepted, one fact put",
						cache: warmedOnce
					}),
					phases: { operationMs: putTimedImm.ms },
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						immutablePutStatements: statementsText(putStatementsImm),
						mutablePutStatements: statementsText(putStatementsMut),
						mutablePutOperationMs: putTimedMut.ms,
						outcomes: Arr.join(
							Arr.map([...putTimedImm.values, ...putTimedMut.values], (o) => o.value.kind),
							", "
						)
					}
				},
				{
					name: "commit-time work by transaction size and group size",
					gates: ["R23"],
					conditions: writeConditions({
						workload:
							"one member inserted beside 0 or more unrelated Log rows, and one member into groups of two sizes, then the deferred checks and COMMIT",
						schemaState: loadedByOwner,
						data: `groups of ${Arr.join(Arr.map(options.groupSizes, String), " and ")} members; Log rows ${Arr.join(Arr.map(options.sizes, String), ", ")}`,
						parameters: {},
						semantics: "every transaction commits",
						cache: warmedOnce
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: Rec.fromEntries([
						...Arr.map(Rec.toEntries(seriesImm.bySize), ([k, v]) => [`immutable ${k}`, v] as const),
						...Arr.map(Rec.toEntries(seriesMut.bySize), ([k, v]) => [`mutable ${k}`, v] as const),
						...Arr.map(
							Rec.toEntries(seriesImm.byGroup),
							([k, v]) => [`immutable ${k}`, v] as const
						),
						...Arr.map(Rec.toEntries(seriesMut.byGroup), ([k, v]) => [`mutable ${k}`, v] as const)
					]),
					loads: {},
					measures: {
						immutableLawCallsBySize: Formatter.format(seriesImm.calls),
						mutableLawCallsBySize: Formatter.format(seriesMut.calls)
					}
				},
				{
					name: `one hot group, ${options.writers} inserters and deleters`,
					gates: ["R23"],
					conditions: writeConditions({
						workload:
							"each writer alternately inserts a member into the hot group and deletes it again",
						schemaState: loadedByOwner,
						data: "the hot group's bound is far above the load",
						parameters: { writers: options.writers, operations: options.operations },
						semantics:
							"each attempt commits or fails with a serialization failure or a deadlock (40001, 40P01), which the harness retries",
						cache: "warm sessions; each writer's operations run back to back"
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: { immutable: hotImm, mutable: hotMut, grizzleImmutable: hotGrizzle },
					measures: {
						...lockWaits("immutableLockWaitSessionMs", hotImm),
						...lockWaits("mutableLockWaitSessionMs", hotMut),
						grizzleRetriesPerOperation: hotGrizzle.retries.perOperation
					}
				}
			]
			const sizeCallsOne = (calls: Readonly<Record<string, number>>) =>
				Arr.every(Rec.values(calls), (n) => n === 1)
			/** A mutable participant's UPDATE lists fields of its own relation. */
			const updatesOfItsFields = (p: Participant) => {
				const relation = p.relation.name
				const fields = fieldsOf[relation]
				if (fields === undefined) {
					throw new GateSetupError({ what: `${relation} is no relation of the schema` })
				}
				const update = p.events.update
				if (update === undefined) {
					return false
				}
				return Arr.every(update.on.of, (f) => fields.includes(f.name))
			}
			const r23: VerdictInput = {
				checks: [
					mechanism(
						"the immutable law's participants have no UPDATE event; the mutable one's each have UPDATE OF its fields",
						Arr.every(participantsImm, (p) => p.events.update === undefined) &&
							Arr.every(participantsMut, updatesOfItsFields),
						`${participantsText(participantsImm)} || ${participantsText(participantsMut)}`
					),
					mechanism(
						"UPDATE is refused to the writing world role on an immutable relation",
						updateImm.outcome.kind === "failed" && updateImm.outcome.sqlstate === "42501",
						Formatter.format(updateImm.outcome)
					),
					mechanism(
						"a mutable payload-only update calls no law; its group move calls it once",
						callsMut.payload.total === 0 && callsMut.move.total === 1,
						`${callsMut.payload.total}, ${callsMut.move.total}`
					),
					mechanism(
						"an immutable change is a deletion and an insertion: it calls the law once for each of Member's DELETE and INSERT events, each with one row image",
						memberRowEvents.length > 0 &&
							Arr.every(memberRowEvents, (e) => e.images.length === 1) &&
							callsImm.payload.total === memberRowEvents.length &&
							callsImm.move.total === memberRowEvents.length,
						`events ${Arr.join(
							Arr.map(memberRowEvents, (e) => e.text),
							", "
						)}; calls ${Formatter.format(callsImm.payload.calls)} ${Formatter.format(callsImm.move.calls)}`
					),
					mechanism(
						"an immutable put is a displacing DELETE then the put's INSERT; a mutable one is a single statement that updates in place",
						displacedThenInserted(writesOf(putStatementsImm, Member.name)) &&
							writtenInPlace(writesOf(putStatementsMut, Member.name)),
						`${statementsText(putStatementsImm)} | ${statementsText(putStatementsMut)}`
					),
					mechanism(
						"the law is called once per transaction whatever its unrelated size",
						sizeCallsOne(seriesImm.calls) && sizeCallsOne(seriesMut.calls),
						`${Formatter.format(seriesImm.calls)} ${Formatter.format(seriesMut.calls)}`
					),
					mechanism(
						"every attempt of an inserter or deleter of one hot group, SQL or grizzle, commits or fails with a serialization failure or a deadlock",
						committedOrConflicted(hotImm) &&
							committedOrConflicted(hotMut) &&
							committedOrConflicted(hotGrizzle),
						Formatter.format({
							immutable: { outcomes: hotImm.outcomes, retries: hotImm.retries },
							mutable: { outcomes: hotMut.outcomes, retries: hotMut.retries },
							grizzle: { outcomes: hotGrizzle.outcomes, retries: hotGrizzle.retries }
						})
					),
					equivalence(
						"both declarations' puts are accepted",
						Arr.every(
							[...putTimedImm.values, ...putTimedMut.values],
							(o) => o.value.kind === "accepted"
						),
						Arr.join(
							Arr.map([...putTimedImm.values, ...putTimedMut.values], (o) => o.value.kind),
							", "
						)
					),
					equivalence(
						"every measured transaction committed in both declarations",
						Arr.every([seriesImm, seriesMut], (x) =>
							Arr.every(
								[...Rec.values(x.bySize), ...Rec.values(x.byGroup)],
								(t) => t.outcomes.committed === t.samples
							)
						),
						Arr.join(
							Arr.map(
								Arr.flatMap([seriesImm, seriesMut], (x) => [
									...Rec.values(x.bySize),
									...Rec.values(x.byGroup)
								]),
								(t) => Formatter.format(t.outcomes)
							),
							" | "
						)
					)
				]
			}
			return { cases, verdicts: { R23: r23 } }
		})
})
