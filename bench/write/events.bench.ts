import { Array as Arr, Effect } from "effect"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	jsonText,
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
import { fill, GateSetupError, settle } from "#bench/query/support/kit.ts"
import {
	installWrites,
	loadedByOwner,
	loginRoleOf,
	plainStatement,
	probeLaws,
	writeConditions,
	writePhases,
	writerSession
} from "#bench/write/support/writes.ts"
import { indices } from "#compiler/core/array.ts"
import { pg } from "#compiler/public/fields.ts"
import {
	capacity,
	contained,
	mutable,
	on,
	ref,
	relation,
	schema,
	within
} from "#compiler/public/schema.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
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
 *   transaction.ts), for growing batches of a law's custom events beside native foreign-key events ("Measure custom and
 *   native event memory together"). An unreadable reading is a defect of the gate's setup, never a figure;
 * - splitting a ChangeSet into smaller statements in one transaction "does not bound accumulated deferred events": the
 *   same rows in ten statements queue the same memory as in one;
 * - "A key changed many times in one transaction is checked many times; ... nothing deduplicates the keys": a `mutable`
 *   member moved between two groups K times calls the law K times, and the commit-time work grows with K;
 * - an UPDATE that changes no field its law trigger's UPDATE OF lists queues no law event at all: the trigger's WHEN
 *   compares OLD with NEW at the row event, so a batch of such UPDATEs calls the law zero times.
 *
 * The fixture is a residual count capacity, Grp and a `mutable` Member contained in it.
 */
const Grp = relation("Grp", { id: pg.integer, bound: pg.integer }, ["id"])
const Member = relation("Member", { id: pg.bigint, grp: pg.integer }, ["id"])
/** The capacity whose events the gate queues: a group's members within its bound. */
const groupCapacity = capacity(on(Grp, "id"), {
	from: on(Member, "grp"),
	within: within(0n, ref("bound"))
})

const build = (name: string) =>
	schema(name, { Grp, Member }, [
		groupCapacity,
		contained(on(Member, "grp"), on(Grp, "id")),
		mutable(Member)
	])

interface Options extends Readonly<Record<string, unknown>> {
	/** Rows one transaction inserts, growing. */
	readonly sizes: ReadonlyArray<number>
	/** Moves of one key in one transaction. */
	readonly moves: ReadonlyArray<number>
	readonly groups: number
	readonly samples: number
}

const bound = 1000000000

/**
 * The bytes a transaction's queued events use in the AfterTriggerEvents context, read before its end; its allocated
 * size grows by chunks, which hides small differences, and is recorded beside it in each transaction series.
 */
const usedBytes = (m: TransactionMeasure): number => {
	if (m.deferredEvents.kind === "unobserved") {
		throw GateSetupError.make({ what: "the transaction read no deferred-event memory" })
	}
	const events = m.deferredEvents.value
	if (!events.available) {
		throw GateSetupError.make({ what: `the deferred-event memory is unreadable: ${events.reason}` })
	}
	return events.usedBytes
}

/** @internal */
export default defineGate({
	name: "write-events",
	gates: ["R12"],
	title:
		"The deferred-event queue: its memory by events, split statements, and repeated checks of one key",
	scope:
		"AfterTriggerEvents memory before COMMIT for growing batches with a law's and native events; one batch in one " +
		"statement and in ten; a key moved K times in one transaction: law calls and the deferred checks' time.",
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
			const law = namesOf(fx.installed).lawOf(groupCapacity)
			const M = fx.table("Member")
			const c = (rel: string, f: string) => fx.column(rel, f)
			yield* fill(fx, "Grp", options.groups, { id: "g::int4", bound: `${bound}::int4` })
			yield* fill(fx, "Member", options.groups, { id: "g::int8", grp: "g::int4" })
			yield* settle(fx)
			yield* grantMemoryReading(s.admin, loginRoleOf(fx))
			const writer = yield* writerSession(fx, fx.world.app, "m15c events writer")
			const generated = (first: number, n: number) =>
				`INSERT INTO ${M} (${c("Member", "id")}, ${c("Member", "grp")}) SELECT ${first} + g, 1 + (g % ${options.groups}) FROM pg_catalog.generate_series(1, ${n}) AS g`
			/**
			 * Rolled back: the queue is read before the end, and rolling back skips the queued checks, so a size's memory is
			 * measured without paying for its law calls.
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
				const lawAndNative: Array<TransactionMeasure> = []
				const split: Array<TransactionMeasure> = []
				for (let i = 0; i < options.samples; i++) {
					const first = 10000000 + i * n
					lawAndNative.push(yield* queued([generated(first, n)]))
					const tenth = Math.ceil(n / 10)
					split.push(
						yield* queued(
							Arr.map(indices(10), (k) =>
								generated(first + k * tenth, Math.max(0, Math.min(tenth, n - k * tenth)))
							)
						)
					)
				}
				const [one] = lawAndNative
				const [ten] = split
				if (one === undefined || ten === undefined) {
					throw GateSetupError.make({ what: `no sample of ${n} rows` })
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
					conditions: writeConditions({
						workload: `INSERT of ${n} members spread over ${options.groups} groups, the event memory read before the end, rolled back`,
						schemaState: loadedByOwner,
						data: `${options.groups} groups of one member each`,
						parameters: { rows: n },
						semantics: "the events stay queued; nothing is checked",
						cache: "each sample a fresh transaction on a warm session"
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {
						lawAndNativeFk: summarizeTransactions(lawAndNative),
						lawAndNativeFkTenStatements: summarizeTransactions(split)
					},
					loads: {},
					measures: {
						lawAndNativeBytes: oneBytes,
						tenStatementsBytes: tenBytes,
						bytesPerRow: oneBytes / n
					}
				})
			}

			/** A key moved K times between two groups in one transaction. */
			const moveCases: Array<CaseRecord<"R12">> = []
			const moveSeries: Array<TransactionSeries> = []
			const moveCalls: Array<number> = []
			let callsMatch = true
			const moveSql = (k: number) =>
				Arr.map(
					indices(k),
					(i) =>
						`UPDATE ${M} SET ${c("Member", "grp")} = ${i % 2 === 0 ? 2 : 1} WHERE ${c("Member", "id")} = 1`
				)
			for (const k of options.moves) {
				const probe = yield* probeLaws(writer, fx, law, moveSql(k), [])
				moveCalls.push(probe.total)
				if (probe.total !== k) {
					callsMatch = false
				}
				const committed: Array<TransactionMeasure> = []
				for (let i = 0; i < options.samples; i++) {
					committed.push(
						yield* measureTransaction(writer, {
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
					)
				}
				const series = summarizeTransactions(committed)
				moveSeries.push(series)
				moveCases.push({
					name: `one key moved ${k} times`,
					gates: ["R12"],
					conditions: writeConditions({
						workload: `${k} UPDATEs moving one member between groups 1 and 2 in one transaction, then the deferred checks and COMMIT`,
						schemaState: loadedByOwner,
						data: `${options.groups} groups of one member each`,
						parameters: { moves: k },
						semantics: "every move keeps the bound; the transaction commits",
						cache: "each sample a fresh transaction on a warm session"
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: { moves: series },
					loads: {},
					measures: { lawCalls: probe.total }
				})
			}
			/** Every member's group assigned to itself: an UPDATE OF its field that changes nothing. */
			const unchanged = yield* probeLaws(
				writer,
				fx,
				law,
				[`UPDATE ${M} SET ${c("Member", "grp")} = ${c("Member", "grp")}`],
				[]
			)
			const cases: Array<CaseRecord<"R12">> = [...sizeCases, ...moveCases]
			const [smallest] = perEvent
			const largest = perEvent.at(-1)
			if (smallest === undefined || largest === undefined) {
				throw GateSetupError.make({ what: "no batch size measured" })
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
						`an UPDATE of ${options.groups} members that changes no UPDATE OF field queues no law event: it calls the law zero times`,
						unchanged.total === 0,
						`calls ${unchanged.total}`
					),
					mechanism(
						"a key moved K times calls the law K times: nothing deduplicates the keys",
						callsMatch,
						`calls ${Arr.join(Arr.map(moveCalls, String), ", ")} for moves ${Arr.join(Arr.map(options.moves, String), ", ")}`
					),
					equivalence(
						"every repeated-move transaction committed",
						Arr.every(moveSeries, (t) => t.outcomes.committed === t.samples),
						Arr.join(
							Arr.map(moveSeries, (t) => jsonText(t.outcomes)),
							" | "
						)
					)
				]
			}
			return { cases, verdicts: { R12: r12 } }
		})
})
