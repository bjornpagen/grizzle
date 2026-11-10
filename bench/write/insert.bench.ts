import { Array as Arr, Deferred, Effect, Fiber, Formatter } from "effect"
import type { ApplyError } from "#adapter/errors/execution.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"
import { type LoadMeasure, type RetryPolicy, runLoad, withRetries } from "#bench/harness/load.ts"
import {
	measureTransaction,
	summarizeTransactions,
	type TransactionMeasure
} from "#bench/harness/transaction.ts"
import { GateSetupError, rawSession, settle } from "#bench/query/support/kit.ts"
import {
	attemptLabel,
	insertsOf,
	installWrites,
	loadedByOwner,
	loginRoleOf,
	type ObservedApply,
	observedChange,
	type ObservedStatement,
	oneRow,
	type OpenedDb,
	openFull,
	owner,
	plainStatement,
	theStatement,
	timedSamples,
	transactionOf,
	warmedOnce,
	writePhases
} from "#bench/write/support/writes.ts"
import { indices } from "#compiler/core/array.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query } from "#compiler/public/query.ts"
import { key, mutable, on, relation as defineRelation, schema } from "#compiler/public/schema.ts"
import type { Insert } from "#compiler/sql/ast.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * R33: settle inserts in one DO SELECT statement, for repeated inserts and conflicts.
 *
 * The gate states the protocol's statement forms: "an identical insert is settled by one INSERT … ON CONFLICT DO SELECT
 * statement; exact repeats return no row". This file reads each form off the compiled program's audited AST (the DO
 * SELECT of an immutable or a `mutable` relation, without a locking clause and ordered by the key, and DO NOTHING of a
 * pure set), and runs the protocol with a grizzle writer (a Db opened through its login's served layer, applying
 * ChangeSets as members of its served workload) beside a direct SQL writer that takes on the same role through its
 * login:
 * - an identical insert in flight waits, then after its commit meets 40001, a TransientFailure, and the caller's second
 *   call is a repeat, an enumerated insert and a described one alike, since every write runs SERIALIZABLE, and after
 *   its abort is inserted; a committed different payload is a conflict with the key law; exact repeats are
 *   `no-change`. The insert in flight is reached by the substrate's lock-wait barrier: the grizzle writer's backend
 *   observed blocked by the direct writer's, never a poll on a clock;
 * - two concurrent overlapping additions to a relation whose only unique index is the primary key complete without
 *   40P01, whatever order each writer's host supplied its facts in; on a relation with an additional key, whose unique
 *   check waits in that index's order, a 40P01 is a TransientFailure, and the harness's caller-side retry reaches the
 *   same final state and outcome (bench/harness/load.ts withRetries).
 * The interleavings that need a step between two statements of one grizzle transaction are the schedules' contract
 * (test/schedules/write), reached through lock waits inside the one flight.
 *
 * Measured: N new facts, N exact repeats and N conflicts through the Db, against the hand-written protocol statement
 * (INSERT ... ON CONFLICT DO SELECT) and a plain INSERT ... ON CONFLICT DO NOTHING, which reports no conflict at all.
 */
const Item = defineRelation("Item", { id: pg.bigint, v: pg.integer }, ["id"])
const Note = defineRelation("Note", { id: pg.bigint, v: pg.integer }, ["id"])
const Tag = defineRelation("Tag", { id: pg.bigint }, ["id"])
const Coded = defineRelation("Coded", { id: pg.bigint, code: pg.bigint }, ["id"])
const Anchor = defineRelation("Anchor", { id: pg.integer }, ["id"])
const build = (name: string) =>
	schema(name, { Item, Note, Tag, Coded, Anchor }, [mutable(Note), key(on(Coded, "code"))])

interface Options extends Readonly<Record<string, unknown>> {
	/** Facts per timed batch. */
	readonly batch: number
	readonly samples: number
	/** Concurrent writers of the overlapping additions, rounds, and keys per round. */
	readonly writers: number
	readonly rounds: number
	readonly keys: number
	/** The writers' retry policy, an application's own. */
	readonly retry: RetryPolicy
}

const modulus = 2n ** 32n

/**
 * A deterministic shuffle of 0..n-1 for writer `w`, so each writer adds a round's keys in an order of its own: a
 * Fisher-Yates shuffle driven by a linear congruential generator modulo 2^32 (multiplier 1103515245, increment 12345:
 * full period, by the Hull-Dobell conditions), seeded per writer by Knuth's multiplicative hash, in BigInt arithmetic
 * so no product loses precision. The orders need no quality beyond differing between writers and rounds.
 */
const shuffled = (n: number, w: number): ReadonlyArray<number> => {
	const out = Arr.map(indices(n), (i) => i)
	let seed = (2654435761n * BigInt(w + 1)) % modulus
	for (let i = n - 1; i > 0; i--) {
		seed = (seed * 1103515245n + 12345n) % modulus
		const j = Number(seed % BigInt(i + 1))
		const a = out[i]
		const b = out[j]
		if (a === undefined || b === undefined) {
			throw new RangeError(`shuffled: positions ${i} and ${j} of ${n}`)
		}
		out[i] = b
		out[j] = a
	}
	return out
}

type CountPair = readonly [first: string, second: string]

/**
 * The caller's second call of an in-flight schedule: made when the first attempt was transient, once the holder ended.
 */
type Second =
	| { readonly kind: "none" }
	| { readonly kind: "called"; readonly observed: ObservedApply }

interface InFlight {
	readonly observed: ObservedApply
	readonly second: Second
}

/** `changes` compiled into a member of `d`'s workload and applied once with `params`, giving the facts it holds. */
const applyOn = (
	d: OpenedDb,
	changes: unknown,
	params: Readonly<Record<string, bigint | number>>
) =>
	Effect.flatMap(observedChange(d, changes, attemptLabel, { kind: "none" }), (change) =>
		change.apply(params)
	)

/** The protocol's statements: each relation's one insert statement, and the one INSERT its AST runs. */
const insertStatement = (statements: ReadonlyArray<ObservedStatement>, relation: string) =>
	theStatement(
		statements,
		`the insert of ${relation}`,
		(l) => l.kind === "write" && l.relation === relation && l.result.kind === "insert"
	)

const theInsert = (statement: ObservedStatement): Insert => {
	const [only, ...more] = insertsOf(statement.ast)
	if (only === undefined || more.length > 0) {
		throw new GateSetupError({
			what: `an insert statement running ${insertsOf(statement.ast).length} INSERTs`
		})
	}
	return only
}

/** The DO SELECT the insert's ON CONFLICT over its key columns takes, if it takes one. */
const doSelect = (insert: Insert) => {
	const onConflict = insert.onConflict
	return onConflict?.kind === "columns" && onConflict.action.kind === "doSelect"
		? { kind: "doSelect" as const }
		: { kind: "other" as const }
}

const kinds = (xs: ReadonlyArray<{ readonly value: ObservedApply["value"] }>) =>
	Arr.map(xs, (x) => x.value.kind)

const allKind = (xs: ReadonlyArray<ObservedApply>, kind: string) =>
	Arr.every(xs, (x) => x.value.kind === kind)

const deadlocks = (l: LoadMeasure) => l.retries.bySqlstate["40P01"]

/** An outcome as its measure reads: its kind, and the SQLSTATE of its wire failure when it had one. */
const outcomeText = (o: ObservedApply) =>
	`${o.value.kind}${o.failure.kind === "none" ? "" : ` ${o.failure.failure.sqlstate}`}`

/** The first attempt met 40001 as a TransientFailure, and the caller's second call was the exact repeat. */
const repeatedAfterConflict = (x: InFlight) =>
	x.observed.value.kind === "transient" &&
	x.observed.failure.kind === "refused" &&
	x.observed.failure.failure.sqlstate === "40001" &&
	x.second.kind === "called" &&
	x.second.observed.value.kind === "no-change"

export default defineGate({
	name: "write-insert",
	gates: ["R33"],
	title: "The insert protocol: its statement forms, its outcomes with real sessions, and its cost",
	scope:
		"The protocol's statement forms read off the compiled programs' ASTs; grizzle writers beside a direct SQL " +
		"writer: in-flight identical inserts, enumerated and described, committed conflicts, overlapping concurrent " +
		"additions with and without a further key; batches of new facts, repeats and conflicts against the hand-written " +
		"protocol and ON CONFLICT DO NOTHING.",
	phases: writePhases,
	options: {
		full: {
			batch: 5000,
			samples: 9,
			writers: 8,
			rounds: 20,
			keys: 200,
			retry: { times: 4, baseMs: 5 }
		},
		quick: {
			batch: 200,
			samples: 2,
			writers: 3,
			rounds: 3,
			keys: 20,
			retry: { times: 4, baseMs: 5 }
		}
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const fx = yield* installWrites(build("Inserts"), "benchinsert", {
				programs: {},
				logins: []
			})
			const S = build(fx.installed.declared)
			const I = fx.table("Item")
			const c = (rel: string, f: string) => fx.column(rel, f)
			const itemKey = namesOf(fx.installed).primaryKeyLaw(Item)
			/** An outcome's law read back to its LawId. */
			const reported = namesOf(fx.installed).reported
			yield* owner(`INSERT INTO ${fx.table("Anchor")} (${c("Anchor", "id")}) VALUES (0)`)
			yield* settle(fx)
			const role = loginRoleOf(fx)
			const db = yield* openFull(fx, S)
			const direct = yield* rawSession(fx, fx.world.app, "m15c insert direct")
			const directPid = yield* direct.pid
			const statementsOf = (changes: unknown): Effect.Effect<ReadonlyArray<ObservedStatement>> =>
				Effect.map(
					observedChange(db, changes, attemptLabel, { kind: "none" }),
					(change) => change.statements
				)
			const itemInsert = (id: bigint, v: number) => ChangeSet.empty(S).insert(Item, [{ id, v }])
			const described = ChangeSet.empty(S).insert(
				Item,
				query(S).rule((r) =>
					r
						.match(Anchor, { id: r.param("anchor", Anchor.fields.id) })
						.find({ id: r.param("id", Item.fields.id), v: r.param("v", Item.fields.v) })
				)
			)
			/**
			 * One schedule: the direct writer inserts (id, v) and holds it; grizzle applies `apply` meanwhile, and the direct
			 * writer ends with `end` once the barrier sees grizzle's backend blocked by it. A transient first attempt is the
			 * caller's to retry: its second call is made once the holder ended.
			 */
			const inFlight = Effect.fn("inFlight")(function* (
				id: number,
				end: "COMMIT" | "ROLLBACK",
				apply: Effect.Effect<ObservedApply, ApplyError>
			) {
				yield* direct.begin
				yield* direct.values(
					`INSERT INTO ${I} (${c("Item", "id")}, ${c("Item", "v")}) VALUES (${id}, 7)`,
					[]
				)
				const started = yield* Deferred.make<void>()
				const fiber = yield* Effect.forkChild(
					Effect.andThen(Deferred.succeed(started, undefined), apply)
				)
				yield* Deferred.await(started)
				yield* s.awaitBlockedBy(directPid, role)
				yield* direct.values(end, [])
				const observed = yield* Fiber.join(fiber)
				const second: Second =
					observed.value.kind === "transient"
						? { kind: "called", observed: yield* apply }
						: { kind: "none" }
				const run: InFlight = { observed, second }
				return run
			})
			const enumeratedRepeat = yield* inFlight(1, "COMMIT", applyOn(db, itemInsert(1n, 7), {}))
			const enumeratedAbort = yield* inFlight(2, "ROLLBACK", applyOn(db, itemInsert(2n, 7), {}))
			const describedRepeat = yield* inFlight(
				3,
				"COMMIT",
				applyOn(db, described, { anchor: 0, id: 3n, v: 7 })
			)
			yield* owner(`INSERT INTO ${I} (${c("Item", "id")}, ${c("Item", "v")}) VALUES (4, 1)`)
			const conflict = yield* applyOn(db, itemInsert(4n, 2), {})
			const first = yield* applyOn(db, itemInsert(5n, 1), {})
			const repeat = yield* applyOn(db, itemInsert(5n, 1), {})

			/**
			 * Overlapping concurrent additions: every writer adds the same keys of a round, each in its own order. Each
			 * writer's Db serves the insert of Item and of Coded, compiled once, each call giving its round's facts.
			 */
			const writers = yield* Effect.forEach(
				Arr.map(indices(options.writers), (i) => i),
				() =>
					Effect.flatMap(openFull(fx, S), (d) =>
						Effect.all({
							Item: observedChange(d, ChangeSet.empty(S).insert(Item, []), attemptLabel, {
								kind: "none"
							}),
							Coded: observedChange(d, ChangeSet.empty(S).insert(Coded, []), attemptLabel, {
								kind: "none"
							})
						})
					)
			)
			const overlap = (relation: "Item" | "Coded") =>
				runLoad(
					writers,
					(writer, w, round) => {
						const base = 1000000 * (relation === "Item" ? 1 : 2) + round * options.keys
						const order = shuffled(options.keys, w * 7919 + round)
						const facts =
							relation === "Item"
								? Arr.map(order, (k) => ({ id: BigInt(base + k), v: 1 }))
								: Arr.map(order, (k) => ({
										id: BigInt(base + k),
										code: BigInt(base + options.keys - k)
									}))
						return withRetries(
							() =>
								Effect.map(
									writer[relation].applyWith({ insert: { [relation]: facts } }, {}),
									(o) => o.attempted
								),
							options.retry
						)
					},
					{ bound: { kind: "operations", n: options.rounds }, sampler: { kind: "none" } }
				)
			const overlapItem: LoadMeasure = yield* overlap("Item")
			const overlapCoded: LoadMeasure = yield* overlap("Coded")
			const rows = yield* s.admin.queryValues(
				`SELECT pg_catalog.count(*)::text, pg_catalog.count(DISTINCT ${c("Coded", "code")})::text FROM ${fx.table("Coded")}`,
				[]
			)
			const [codedRowsText, codedCodesText] = trusted<CountPair>(oneRow(rows))
			const codedRows = Number(codedRowsText)
			const codedCodes = Number(codedCodesText)

			const itemStatements = yield* statementsOf(itemInsert(9n, 1))
			const noteStatements = yield* statementsOf(
				ChangeSet.empty(S).insert(Note, [{ id: 9n, v: 1 }])
			)
			const tagStatements = yield* statementsOf(ChangeSet.empty(S).insert(Tag, [{ id: 9n }]))
			const itemStatement = insertStatement(itemStatements, Item.name)
			const noteStatement = insertStatement(noteStatements, Note.name)
			const tagStatement = insertStatement(tagStatements, Tag.name)
			const itemAst = theInsert(itemStatement)
			const noteAst = theInsert(noteStatement)
			const tagAst = theInsert(tagStatement)
			const itemSelect = doSelect(itemAst)
			const noteSelect = doSelect(noteAst)
			const tagConflict = tagAst.onConflict
			const tagLabel = tagStatement.label

			/**
			 * Cost: N new facts, N exact repeats, N conflicts, through the Db and hand-written. The Db's insert of Item is
			 * compiled once, before the samples, each call giving its batch's facts.
			 */
			let next = 10000000
			const facts = (from: number, v: number) =>
				Arr.map(indices(options.batch), (i) => ({ id: BigInt(from + i), v }))
			const itemBatches = yield* observedChange(
				db,
				ChangeSet.empty(S).insert(Item, []),
				attemptLabel,
				{ kind: "none" }
			)
			const newFacts = yield* timedSamples(
				options.samples,
				() => {
					const from = next
					next += options.batch
					return itemBatches.applyWith({ insert: { Item: facts(from, 1) } }, {})
				},
				1
			)
			const repeatFrom = next - options.batch
			const repeats = yield* timedSamples(
				options.samples,
				() => itemBatches.applyWith({ insert: { Item: facts(repeatFrom, 1) } }, {}),
				0
			)
			const conflicts = yield* timedSamples(
				options.samples,
				() => itemBatches.applyWith({ insert: { Item: facts(repeatFrom, 2) } }, {}),
				0
			)
			/** The batch as the arrays the protocol reads, one per column, as grizzle sends an input. */
			const arrays = (from: number, v: number): ReadonlyArray<string> => [
				`{${Arr.join(
					Arr.map(indices(options.batch), (i) => String(from + i)),
					","
				)}}`,
				`{${Arr.join(
					Arr.map(indices(options.batch), () => String(v)),
					","
				)}}`
			]
			const input =
				"(SELECT pg_catalog.unnest($1::int8[]) AS c1, pg_catalog.unnest($2::int4[]) AS c2) AS r0"
			const protocol =
				`WITH r1(c1, c2) AS (SELECT r0.c1, r0.c2 FROM ${input}), ` +
				`r2 AS (INSERT INTO ${I} AS r3 (${c("Item", "id")}, ${c("Item", "v")}) SELECT r1.c1, r1.c2 FROM r1 ORDER BY r1.c1 ` +
				`ON CONFLICT (${c("Item", "id")}) DO SELECT WHERE r3.${c("Item", "v")} <> EXCLUDED.${c("Item", "v")} ` +
				`RETURNING r3.${c("Item", "id")} AS c4, r3.${c("Item", "v")} AS c5) ` +
				"SELECT r2.c4::text, (r2.c5 = r1.c2)::text FROM r2 JOIN r1 ON r1.c1 = r2.c4"
			const doNothing = `INSERT INTO ${I} (${c("Item", "id")}, ${c("Item", "v")}) SELECT r0.c1, r0.c2 FROM ${input} ORDER BY r0.c1 ON CONFLICT (${c("Item", "id")}) DO NOTHING`
			const handProtocol: Array<TransactionMeasure> = []
			const handDoNothing: Array<TransactionMeasure> = []
			for (let i = 0; i < options.samples; i++) {
				const from = next
				next += options.batch
				const protocolRun = yield* measureTransaction(
					direct,
					transactionOf([plainStatement("protocol", protocol, arrays(from, 1))], "plain")
				)
				handProtocol.push(protocolRun)
				const from2 = next
				next += options.batch
				const doNothingRun = yield* measureTransaction(
					direct,
					transactionOf([plainStatement("do nothing", doNothing, arrays(from2, 1))], "plain")
				)
				handDoNothing.push(doNothingRun)
			}

			const scheduleText = (x: InFlight) =>
				`${outcomeText(x.observed)}${x.second.kind === "none" ? "" : `; retried ${outcomeText(x.second.observed)}`}`
			const cases: Array<CaseRecord<"R33">> = [
				{
					name: "schedules: an identical insert in flight, a committed conflict, an exact repeat",
					gates: ["R33"],
					conditions: {
						workload:
							"a direct SQL writer holds an uncommitted insert of a key while a grizzle writer inserts the same fact, then commits or rolls back once the grizzle writer's backend waits on it; a grizzle insert over a committed different payload; one fact inserted twice",
						schemaState: loadedByOwner,
						dataDistribution: "Item keyed by id, immutable",
						parameters: {},
						resultSemantics:
							"a repeat is no-change, an aborted holder's fact is inserted, a conflict is invariant-rejected with the key law",
						cacheState: warmedOnce
					},
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						enumeratedRepeat: scheduleText(enumeratedRepeat),
						enumeratedAbort: scheduleText(enumeratedAbort),
						describedRepeat: scheduleText(describedRepeat),
						conflict:
							conflict.value.kind === "invariant-rejected"
								? `invariant-rejected ${Arr.join(
										Arr.map(refusedLaws(conflict.value.refused), (l) => l.kind),
										", "
									)}`
								: conflict.value.kind,
						repeat: `${first.value.kind} then ${repeat.value.kind}`
					}
				},
				{
					name: `overlapping concurrent additions, ${options.writers} writers`,
					gates: ["R33"],
					conditions: {
						workload: `each round, every writer adds the same ${options.keys} keys in its own order; Item has only its primary key, Coded also a key on code in the reverse order`,
						schemaState: loadedByOwner,
						dataDistribution: "fresh keys per round",
						parameters: { writers: options.writers, rounds: options.rounds, keys: options.keys },
						resultSemantics:
							"per key one writer inserts and the others meet an exact repeat; a 40001 or a 40P01 is a TransientFailure, which the harness retries",
						cacheState: warmedOnce
					},
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: { primaryKeyOnly: overlapItem, withFurtherKey: overlapCoded },
					measures: {
						...(deadlocks(overlapItem) === undefined
							? {}
							: { primaryKeyDeadlocks: deadlocks(overlapItem) }),
						...(deadlocks(overlapCoded) === undefined
							? {}
							: { furtherKeyDeadlocks: deadlocks(overlapCoded) }),
						codedRows: `${codedRows}, ${codedCodes}`
					}
				},
				{
					name: `batches of ${options.batch} facts`,
					gates: ["R33"],
					conditions: {
						workload:
							"a served insert member's apply of new facts, of the same facts again, and of them with another payload, each call's facts; the hand-written protocol and ON CONFLICT DO NOTHING on new facts",
						schemaState: loadedByOwner,
						dataDistribution: "Item keyed by id",
						parameters: { batch: options.batch },
						resultSemantics:
							"accepted, no-change, invariant-rejected; DO NOTHING reports no conflict",
						cacheState: warmedOnce
					},
					phases: { operationMs: newFacts.ms },
					variants: [],
					comparisons: [],
					transactions: {
						handwrittenProtocol: summarizeTransactions(handProtocol),
						onConflictDoNothing: summarizeTransactions(handDoNothing)
					},
					loads: {},
					measures: {
						repeatOperationMs: repeats.ms,
						conflictOperationMs: conflicts.ms,
						outcomes: Arr.join(
							[...kinds(newFacts.values), ...kinds(repeats.values), ...kinds(conflicts.values)],
							", "
						)
					}
				},
				{
					name: "the protocol's statements",
					gates: ["R33"],
					conditions: {
						workload:
							"the compiled insert of one fact into an immutable, a mutable and a pure-set relation",
						schemaState: loadedByOwner,
						dataDistribution: "no facts needed",
						parameters: {},
						resultSemantics: "the statements as the runtime sends them",
						cacheState: warmedOnce
					},
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						immutable: Arr.join(
							Arr.map(itemStatements, (x) => x.sql),
							"\n"
						),
						mutable: Arr.join(
							Arr.map(noteStatements, (x) => x.sql),
							"\n"
						),
						pureSet: Arr.join(
							Arr.map(tagStatements, (x) => x.sql),
							"\n"
						)
					}
				}
			]
			const r33: VerdictInput = {
				checks: [
					mechanism(
						"an immutable relation's insert is ON CONFLICT on its key DO SELECT, ordered by the key",
						itemSelect.kind === "doSelect" &&
							itemAst.source.kind === "query" &&
							itemAst.source.query.orderBy.length > 0,
						itemStatement.sql
					),
					mechanism(
						"a mutable relation's insert is ON CONFLICT on its key DO SELECT",
						noteSelect.kind === "doSelect",
						noteStatement.sql
					),
					mechanism(
						"a pure set's insert is the pureSet variant: ON CONFLICT on its key DO NOTHING",
						tagLabel.kind === "write" &&
							tagLabel.result.kind === "insert" &&
							tagLabel.result.variant === "pureSet" &&
							tagConflict?.kind === "columns" &&
							tagConflict.action.kind === "doNothing",
						tagStatement.sql
					),
					mechanism(
						"two overlapping additions on a relation whose only unique index is the key never deadlock",
						deadlocks(overlapItem) === undefined,
						Formatter.format(overlapItem.retries)
					),
					equivalence(
						"an enumerated insert waiting on an identical one in flight fails with a 40001 TransientFailure, and the caller's second call is the exact repeat",
						repeatedAfterConflict(enumeratedRepeat),
						scheduleText(enumeratedRepeat)
					),
					equivalence(
						"after the holder's abort the fact is inserted",
						enumeratedAbort.observed.value.kind === "accepted",
						scheduleText(enumeratedAbort)
					),
					equivalence(
						"a described insert waiting on an identical one in flight fails with a 40001 TransientFailure, and the caller's second call is the exact repeat",
						repeatedAfterConflict(describedRepeat),
						scheduleText(describedRepeat)
					),
					equivalence(
						"a committed different payload is a conflict, invariant-rejected with the key law",
						conflict.value.kind === "invariant-rejected" &&
							Arr.every(conflict.value.refused.laws, (l) => reported(l) === itemKey),
						outcomeText(conflict)
					),
					equivalence(
						"an exact repeat is no-change",
						first.value.kind === "accepted" && repeat.value.kind === "no-change",
						`${first.value.kind} then ${repeat.value.kind}`
					),
					equivalence(
						"every overlapping addition ends accepted or no-change within the caller's retries, a deadlock being a TransientFailure, and the further key holds",
						Arr.every([overlapItem, overlapCoded], (l) => l.outcomes.committed === l.operations) &&
							codedRows === options.rounds * options.keys &&
							codedCodes === options.rounds * options.keys,
						Formatter.format({
							item: overlapItem.outcomes,
							coded: overlapCoded.outcomes,
							state: [codedRows, codedCodes]
						})
					),
					equivalence(
						"batches: new facts accepted, repeats no-change, other payloads invariant-rejected",
						allKind(newFacts.values, "accepted") &&
							allKind(repeats.values, "no-change") &&
							allKind(conflicts.values, "invariant-rejected"),
						Arr.join(
							[...kinds(newFacts.values), ...kinds(repeats.values), ...kinds(conflicts.values)],
							", "
						)
					)
				]
			}
			return { cases, verdicts: { R33: r33 } }
		})
})
