import { Array as Arr, Effect, Formatter } from "effect"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	grantMemoryReading,
	measureTransaction,
	summarizeTransactions,
	type TransactionMeasure,
	type TransactionSeries
} from "#bench/harness/transaction.ts"
import { fillTogether, GateSetupError, rawSession, settle } from "#bench/query/support/kit.ts"
import {
	installWrites,
	loadedByOwner,
	loginRoleOf,
	plainStatement,
	writePhases
} from "#bench/write/support/writes.ts"
import { indices } from "#compiler/core/array.ts"
import { pg } from "#compiler/public/fields.ts"
import { contained, mutable, on, relation, schema } from "#compiler/public/schema.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * R12: treat trigger queue size as a transaction resource, measured as repeated checks of one key per transaction and
 * the deferred-event queue cost.
 *
 * R12 states no gate paragraph, so its gate is the performance contract's "measurement that can disprove the
 * performance assumption". The assumptions measured:
 * - the AFTER-trigger event list grows with the events a transaction queues, in chunks of at most 1MB under
 *   TopTransactionContext, with no spill: its memory is read from the backend's AfterTriggerEvents
 *   context after the statements and before the end, when every deferred event is still queued (bench/harness
 *   transaction.ts), for growing batches of deferred foreign-key events. Every law is native (fin.md §7), so every
 *   deferred event is a foreign key's RI check. An unreadable reading is a defect of the gate's setup, never a figure;
 * - splitting a ChangeSet into smaller statements in one transaction "does not bound accumulated deferred events": the
 *   same rows in ten statements queue the same memory as in one;
 * - "A key changed many times in one transaction is checked many times; ... nothing deduplicates the keys": a `mutable`
 *   member moved between two groups K times queues K deferred checks, and the commit-time work grows with K;
 * - an UPDATE that changes no referencing column queues no event at all: PostgreSQL's RI trigger skips the row when its
 *   keys are unchanged (RI_FKey_fk_upd_check_required), so a batch of such UPDATEs queues nothing beside one insert's
 *   event.
 *
 * The fixture is a cycle of two containments, which grizzle defers (fin.md §5.1): a `mutable` Member in its Grp, and
 * each Grp's lead among the members.
 */
const Grp = relation("Grp", { id: pg.integer, lead: pg.bigint }, ["id"])
const Member = relation("Member", { id: pg.bigint, grp: pg.integer }, ["id"])

const build = (name: string) =>
	schema(
		name,
		[Grp, Member],
		[
			contained(on(Member, "grp"), on(Grp, "id")),
			contained(on(Grp, "lead"), on(Member, "id")),
			mutable(Member)
		]
	)

interface Options extends Readonly<Record<string, unknown>> {
	/** Rows one transaction inserts, growing. */
	readonly sizes: ReadonlyArray<number>
	/** Moves of one key in one transaction. */
	readonly moves: ReadonlyArray<number>
	readonly groups: number
	readonly samples: number
}

/**
 * The bytes a transaction's queued events use in the AfterTriggerEvents context, read before its end; its allocated
 * size grows by chunks, which hides small differences, and is recorded beside it in each transaction series.
 */
const usedBytes = (m: TransactionMeasure): number => {
	if (m.deferredEvents.kind === "unobserved") {
		throw new GateSetupError({ what: "the transaction read no deferred-event memory" })
	}
	const events = m.deferredEvents.value
	if (!events.available) {
		throw new GateSetupError({ what: `the deferred-event memory is unreadable: ${events.reason}` })
	}
	return events.usedBytes
}

export default defineGate({
	name: "write-events",
	gates: ["R12"],
	title:
		"The deferred-event queue: its memory by events, split statements, and repeated checks of one key",
	scope:
		"AfterTriggerEvents memory before COMMIT for growing batches of deferred foreign-key events; one batch in one " +
		"statement and in ten; a key moved K times in one transaction: its queued events and the deferred checks' time.",
	phases: writePhases,
	options: {
		full: { sizes: [10000, 100000, 1000000], moves: [1, 10, 100, 1000], groups: 1000, samples: 5 },
		quick: { sizes: [500, 5000], moves: [1, 10, 50], groups: 50, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const fx = yield* installWrites(build("Events"), "benchevents", {
				programs: {},
				logins: []
			})
			const M = fx.table("Member")
			const c = (rel: string, f: string) => fx.column(rel, f)
			yield* fillTogether(fx, [
				{ relation: "Grp", rows: options.groups, columns: { id: "g::int4", lead: "g::int8" } },
				{ relation: "Member", rows: options.groups, columns: { id: "g::int8", grp: "g::int4" } }
			])
			yield* settle(fx)
			yield* grantMemoryReading(s.admin, loginRoleOf(fx))
			const writer = yield* rawSession(fx, fx.world.app, "m15c events writer")
			const generated = (first: number, n: number) =>
				`INSERT INTO ${M} (${c("Member", "id")}, ${c("Member", "grp")}) SELECT ${first} + g, 1 + (g % ${options.groups}) FROM pg_catalog.generate_series(1, ${n}) AS g`
			/**
			 * Rolled back: the queue is read before the end, and rolling back skips the queued checks, so a size's memory is
			 * measured without paying for its checks.
			 */
			const queued = (statements: ReadonlyArray<string>) =>
				measureTransaction(writer, {
					readOnly: false,
					statements: Arr.map(statements, (sql, i) => plainStatement(`insert ${i}`, sql, [])),
					end: "rollback",
					deferredEvents: true,
					wal: false
				})
			const sizeCases: Array<CaseRecord<"R12">> = []
			const perEvent: Array<number> = []
			const splitReadings: Array<string> = []
			let splitHolds = true
			for (const n of options.sizes) {
				const deferred: Array<TransactionMeasure> = []
				const split: Array<TransactionMeasure> = []
				for (let i = 0; i < options.samples; i++) {
					const first = 10000000 + i * n
					const deferredRun = yield* queued([generated(first, n)])
					deferred.push(deferredRun)
					const tenth = Math.ceil(n / 10)
					const splitRun = yield* queued(
						Arr.map(indices(10), (k) =>
							generated(first + k * tenth, Math.max(0, Math.min(tenth, n - k * tenth)))
						)
					)
					split.push(splitRun)
				}
				const [one] = deferred
				const [ten] = split
				if (one === undefined || ten === undefined) {
					throw new GateSetupError({ what: `no sample of ${n} rows` })
				}
				const oneBytes = usedBytes(one)
				const tenBytes = usedBytes(ten)
				perEvent.push(oneBytes / n)
				if (tenBytes < oneBytes * 0.9) {
					splitHolds = false
				}
				splitReadings.push(`${tenBytes} of ${oneBytes} bytes at ${n} rows`)
				sizeCases.push({
					name: `${n} rows queued in one transaction`,
					gates: ["R12"],
					conditions: {
						workload: `INSERT of ${n} members spread over ${options.groups} groups, the event memory read before the end, rolled back`,
						schemaState: loadedByOwner,
						dataDistribution: `${options.groups} groups of one member each`,
						parameters: { rows: n },
						resultSemantics: "the events stay queued; nothing is checked",
						cacheState: "each sample a fresh transaction on a warm session"
					},
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {
						deferredFk: summarizeTransactions(deferred),
						deferredFkTenStatements: summarizeTransactions(split)
					},
					loads: {},
					measures: {
						deferredBytes: oneBytes,
						tenStatementsBytes: tenBytes,
						bytesPerRow: oneBytes / n
					}
				})
			}

			/** A key moved K times between two groups in one transaction. */
			const moveCases: Array<CaseRecord<"R12">> = []
			const moveSeries: Array<TransactionSeries> = []
			const moveBytes: Array<number> = []
			const moveSql = (k: number) =>
				Arr.map(
					indices(k),
					(i) =>
						`UPDATE ${M} SET ${c("Member", "grp")} = ${i % 2 === 0 ? 2 : 1} WHERE ${c("Member", "id")} = 1`
				)
			for (const k of options.moves) {
				const moved = yield* queued(moveSql(k))
				moveBytes.push(usedBytes(moved))
				const committed: Array<TransactionMeasure> = []
				for (let i = 0; i < options.samples; i++) {
					const committedRun = yield* measureTransaction(writer, {
						readOnly: false,
						/** An even K leaves the member where it started. */
						statements: Arr.map(
							[
								...moveSql(k),
								...(k % 2 === 1
									? [`UPDATE ${M} SET ${c("Member", "grp")} = 1 WHERE ${c("Member", "id")} = 1`]
									: [])
							],
							(sql, n) => plainStatement(`move ${n}`, sql, [])
						),
						end: "split",
						deferredEvents: true,
						wal: false
					})
					committed.push(committedRun)
				}
				const series = summarizeTransactions(committed)
				moveSeries.push(series)
				moveCases.push({
					name: `one key moved ${k} times`,
					gates: ["R12"],
					conditions: {
						workload: `${k} UPDATEs moving one member between groups 1 and 2 in one transaction, then the deferred checks and COMMIT`,
						schemaState: loadedByOwner,
						dataDistribution: `${options.groups} groups of one member each`,
						parameters: { moves: k },
						resultSemantics: "every move keeps its foreign key; the transaction commits",
						cacheState: "each sample a fresh transaction on a warm session"
					},
					phases: {},
					variants: [],
					comparisons: [],
					transactions: { moves: series },
					loads: {},
					measures: { queuedBytes: usedBytes(moved) }
				})
			}
			/**
			 * Every member's group assigned to itself, an UPDATE of its referencing column that changes nothing, beside one
			 * insert, against the insert alone: the same queue, so the UPDATE queued no event.
			 */
			const insertAlone = yield* queued([generated(30000000, 1)])
			const insertBesideUnchanged = yield* queued([
				`UPDATE ${M} SET ${c("Member", "grp")} = ${c("Member", "grp")}`,
				generated(30000000, 1)
			])
			const oneInsert = usedBytes(insertAlone)
			const withUnchanged = usedBytes(insertBesideUnchanged)
			const cases: Array<CaseRecord<"R12">> = [...sizeCases, ...moveCases]
			const [smallest] = perEvent
			const largest = perEvent.at(-1)
			if (smallest === undefined || largest === undefined) {
				throw new GateSetupError({ what: "no batch size measured" })
			}
			const r12: VerdictInput = {
				checks: [
					mechanism(
						"the queue grows with the events: its used bytes per row stay within a factor of four across sizes",
						smallest > 0 && largest > 0 && largest / smallest < 4 && smallest / largest < 4,
						Arr.join(
							Arr.map(perEvent, (b) => b.toFixed(1)),
							", "
						)
					),
					mechanism(
						"ten statements in one transaction queue at least the memory of one: splitting bounds nothing",
						splitHolds,
						Arr.join(splitReadings, ", ")
					),
					mechanism(
						`an UPDATE of ${options.groups} members that changes no referencing column queues no event: the queue is one insert's`,
						withUnchanged === oneInsert,
						`${withUnchanged} bytes beside the UPDATE, ${oneInsert} alone`
					),
					mechanism(
						"a key moved K times queues K checks: the queue grows with K, nothing deduplicates the keys",
						Arr.every(moveBytes, (b, i) => i === 0 || b >= (moveBytes[i - 1] ?? 0)) &&
							(moveBytes.at(-1) ?? 0) > (moveBytes[0] ?? 0),
						`${Arr.join(Arr.map(moveBytes, String), ", ")} bytes for moves ${Arr.join(Arr.map(options.moves, String), ", ")}`
					),
					equivalence(
						"every repeated-move transaction committed",
						Arr.every(moveSeries, (t) => t.outcomes.committed === t.samples),
						Arr.join(
							Arr.map(moveSeries, (t) => Formatter.format(t.outcomes)),
							" | "
						)
					)
				]
			}
			return { cases, verdicts: { R12: r12 } }
		})
})
