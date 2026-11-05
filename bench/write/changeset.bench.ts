import { Array as Arr, Effect, Option, Result, type Scope } from "effect"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"
import { retried, retryPolicy } from "#bench/harness/load.ts"
import { type Fixture, fill, settle } from "#bench/query/support/kit.ts"
import {
	attemptLabel,
	displacedThenInserted,
	installWrites,
	labelText,
	loadedByOwner,
	type ObservedApply,
	observedChange,
	observedConservative,
	type ObservedStatement,
	type ObservedValue,
	oneRow,
	openFull,
	readBackRows,
	timedSamples,
	warmedOnce,
	writeConditions,
	writesOf,
	writtenInPlace
} from "#bench/write/support/writes.ts"
import { indices } from "#compiler/core/array.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	type Schema as GrizzleSchema,
	mutable,
	relation as defineRelation,
	type Statement,
	schema
} from "#compiler/public/schema.ts"
import type { SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * R35: realize a described ChangeSet in one statement where one snapshot suffices.
 *
 * "The single-statement and sequential realizations produce the same final states, outcomes, and reads under the write
 * compiler's concurrency schedules, including two concurrent appliers whose described members overlap. Measure the
 * carrier's catalog cost per transaction against declaring the target `mutable`, which realizes a `put` as one
 * statement outside the exceptions above, needs no carrier, and changes nothing else".
 *
 * The compiler realizes a stratum in one statement where one snapshot suffices: writes of distinct relations, at least
 * two, whose members all read the stratum's starting state (write/schedule/plan.ts, write/program/single.ts); every
 * other stratum sequentially. This gate measures both:
 *
 * - a described put with a read-back over post-change state, on an immutable target (a displacing DELETE and the put's
 *   INSERT, carriers for the member both read and for the deltas the read-back reads), sequential because the pair
 *   writes one relation, and on the same schema with the target `mutable` (one statement that updates in place): the
 *   statements each program holds, by their steps, the catalog rows a transaction writes (read from
 *   pg_stat_sys_tables after the measuring Db's backend exits, which reports its counters), and the operation's time;
 *   and two concurrent appliers whose described members overlap, in both declarations, which must reach the same final
 *   state with the same outcomes and reads;
 * - a described post, every pending amount of an account becoming a ledger entry and leaving the pending set, with a
 *   read-back of the posted entries: an insert of Entry and a deletion of Pending in one stratum, one statement, and the
 *   same ChangeSet in the program's conservative realization, every statement in sequence, which the write oracle
 *   compares against: its statements, catalog rows and time in each, the same outcomes, counts, reads and final state
 *   on distinct accounts, and concurrent overlapping appliers posting one account in each, of which exactly one posts
 *   the account's entries and every other ends no-change or in a TransientFailure.
 */
const Account = defineRelation("Account", { id: pg.bigint, balance: pg.bigint }, ["id"])
const Pending = defineRelation(
	"Pending",
	{ id: pg.bigint, account: pg.bigint, amount: pg.bigint },
	["id"]
)

const Entry = defineRelation("Entry", { id: pg.bigint, account: pg.bigint, amount: pg.bigint }, [
	"id"
])
const relations = { Account, Pending, Entry } as const
const build = (name: string) => schema(name, relations, [])
const buildMutable = (name: string) => schema(name, relations, [mutable(Account)])

/**
 * The described put: credit `amount` to account `id`, reading its balance; the read-back reads the post-change row. The
 * credited balance is an exact integer, narrowed back into the bigint field under a guard that it fits; a credit past
 * bigint's range leaves the balance as it was.
 */
const credit = <St extends ReadonlyArray<Statement>>(
	s: GrizzleSchema<string, typeof relations, St>
) =>
	ChangeSet.empty(s)
		.put(
			Account,
			query(s).rule((r) => {
				const { balance } = v(Account, "account")
				return r.match(Account, { id: r.param("id", Account.fields.id), balance }).find({
					id: r.param("id", Account.fields.id),
					balance: Compute.when(
						Compute.within(
							Compute.add(balance, r.param("amount", pg.bigint)),
							-9223372036854775808n,
							9223372036854775807n
						),
						(credited) => Compute.cast(credited, pg.bigint),
						balance
					)
				})
			})
		)
		.read("after", (d) =>
			query(s).rule((r) => {
				const { id, balance } = v(Account, "account")
				const added = v(d.added(Account), "addedAccount")
				return r
					.match(d.added(Account), { id: added.id, balance: added.balance })
					.match(Account, { id, balance })
					.where(r.eq(id, added.id))
					.find({ id, balance })
			})
		)

/**
 * The post: every pending amount of account `account` becomes an entry and leaves the pending set, the posted entries
 * read back. Writes of two relations whose members read the stratum's starting state: one statement.
 */
const post = <St extends ReadonlyArray<Statement>>(
	s: GrizzleSchema<string, typeof relations, St>
) => {
	const pending = () =>
		query(s).rule((r) => {
			const { id, account, amount } = v(Pending, "pending")
			return r
				.match(Pending, { id, account, amount })
				.where(r.eq(account, r.param("account", Pending.fields.account)))
				.find({ id, account, amount })
		})
	return ChangeSet.empty(s)
		.insert(Entry, pending())
		.delete(Pending, pending())
		.read("posted", (d) =>
			query(s).rule((r) => {
				const { id, account, amount } = v(d.added(Entry), "addedEntry")
				return r.match(d.added(Entry), { id, account, amount }).find({ id, account, amount })
			})
		)
}

interface Options extends Readonly<Record<string, unknown>> {
	readonly accounts: number
	readonly samples: number
	/** Concurrent appliers on one account, and the credits each applies. */
	readonly appliers: number
	readonly credits: number
	/** The pending amounts of each account the post moves into the ledger. */
	readonly pendingPerAccount: number
}

const catalogTables = ["pg_class", "pg_attribute", "pg_type", "pg_depend"] as const

type CountRow = readonly [count: string]
type BalanceRow = readonly [balance: string]

/**
 * The tuples inserted into the catalogs a temporary relation writes, in this database, as the statistics report them.
 */
const catalogInserts = Effect.fn("catalogInserts")(function* (): Effect.fn.Return<
	number,
	SqlError,
	Substrate
> {
	const s = yield* Substrate
	const rows = yield* s.admin.queryValues(
		`SELECT COALESCE(pg_catalog.sum(n_tup_ins), 0)::text FROM pg_catalog.pg_stat_sys_tables WHERE schemaname = 'pg_catalog' AND relname = ANY ($1::text[])`,
		[`{${Arr.join(catalogTables, ",")}}`]
	)
	const [inserted] = trusted<CountRow>(oneRow(rows))
	return Number(inserted)
})

const statementsText = (statements: ReadonlyArray<ObservedStatement>) =>
	Arr.join(
		Arr.map(statements, (x) => labelText(x.label)),
		", "
	)

/** @internal */
export default defineGate({
	name: "write-changeset",
	gates: ["R35"],
	title:
		"A described ChangeSet in one statement where one snapshot suffices, and in sequence where it does not",
	scope:
		"A described put with a post-change read-back: statements, carriers, catalog rows per transaction and time on " +
		"an immutable and a mutable target, and two concurrent overlapping appliers in each; a described post of two " +
		"relations in one statement against its sequential conservative realization: statements, catalog rows, time, " +
		"outcomes, reads, final state, and concurrent overlapping appliers in each.",
	phases: ["operationMs"],
	options: {
		full: { accounts: 10000, samples: 25, appliers: 8, credits: 10, pendingPerAccount: 5 },
		quick: { accounts: 100, samples: 3, appliers: 2, credits: 2, pendingPerAccount: 3 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const imm = yield* installWrites(build("Ledger"), "benchcsimm", {
				programs: {},
				logins: []
			})
			const mut = yield* installWrites(buildMutable("Ledger"), "benchcsmut", {
				programs: {},
				logins: []
			})
			const Simm = build(imm.installed.declared)
			const Smut = buildMutable(mut.installed.declared)
			const seed = <F>(fx: Fixture<F>) =>
				Effect.gen(function* () {
					yield* fill(fx, "Account", options.accounts, { id: "g::int8", balance: "0::int8" })
					yield* fill(fx, "Pending", options.accounts * options.pendingPerAccount, {
						id: "g::int8",
						account: `((g - 1) % ${options.accounts} + 1)::int8`,
						amount: "(g % 7 + 1)::int8"
					})
					yield* settle(fx)
				})
			yield* seed(imm)
			yield* seed(mut)
			/** Credits on fresh accounts, through a Db of its own whose backend exits before the catalog reading. */
			const measure = <D extends object, E>(
				open: Effect.Effect<D, E, Substrate | Scope.Scope>,
				changes: unknown
			) =>
				Effect.gen(function* () {
					const before = yield* catalogInserts()
					const run = yield* Effect.scoped(
						Effect.gen(function* () {
							const db = yield* open
							const change = observedChange(db, changes, attemptLabel, { kind: "none" })
							if (Result.isFailure(change)) {
								return yield* Effect.die(change.failure)
							}
							const timed = yield* timedSamples(
								options.samples,
								(i) => change.success.apply({ id: BigInt(i + 1), amount: 5n }),
								1
							)
							return { timed, statements: change.success.statements }
						})
					)
					/**
					 * The Db's backend reports its counters when it exits; wait until the reading settles. The reading feeds only the
					 * catalog measure, never a check, and the wait is capped at fifty polls.
					 */
					let after = yield* catalogInserts()
					for (let i = 0; i < 50 && after === before; i++) {
						yield* Effect.sleep("100 millis")
						after = yield* catalogInserts()
					}
					return { ...run, catalogPerTransaction: (after - before) / (options.samples + 1) }
				})
			const immutable = yield* measure(openFull(imm, Simm), credit(Simm))
			const mutableRun = yield* measure(openFull(mut, Smut), credit(Smut))
			const accountWritesImm = writesOf(immutable.statements, Account.name)
			const accountWritesMut = writesOf(mutableRun.statements, Account.name)

			/** Two concurrent appliers whose described members overlap: every applier credits the same account. */
			const overlap = <F, D extends object, E>(
				fx: Fixture<F>,
				open: () => Effect.Effect<D, E, Substrate | Scope.Scope>,
				changes: unknown
			) =>
				Effect.scoped(
					Effect.gen(function* () {
						const dbs = yield* Effect.forEach(
							Arr.map(indices(options.appliers), (i) => i),
							() => open()
						)
						const results = yield* Effect.forEach(
							dbs,
							(d) =>
								Effect.gen(function* () {
									const change = observedChange(d, changes, attemptLabel, { kind: "none" })
									if (Result.isFailure(change)) {
										return yield* Effect.die(change.failure)
									}
									const apply = change.success.apply
									const out: Array<{ readonly last: ObservedApply; readonly retries: number }> = []
									for (let i = 0; i < options.credits; i++) {
										const credited = yield* retried(
											() => apply({ id: BigInt(options.accounts), amount: 1n }),
											(o) => o.attempted.transient,
											retryPolicy
										)
										out.push({ last: credited.last, retries: credited.retries.length })
									}
									return out
								}),
							{ concurrency: "unbounded" }
						)
						const rows = yield* s.admin.queryValues(
							`SELECT ${fx.column("Account", "balance")}::text FROM ${fx.table("Account")} WHERE ${fx.column("Account", "id")} = ${options.accounts}`,
							[]
						)
						const [balance] = trusted<BalanceRow>(oneRow(rows))
						const flat = results.flat()
						return {
							balance: BigInt(balance),
							values: Arr.map(flat, (o) => o.last.value),
							retries: Arr.reduce(flat, 0, (n, o) => n + o.retries)
						}
					})
				)
			const overlapImm = yield* overlap(imm, () => openFull(imm, Simm), credit(Simm))
			const overlapMut = yield* overlap(mut, () => openFull(mut, Smut), credit(Smut))
			/**
			 * A credit whose every attempt the caller's retries allow loses to a concurrent one ends in a TransientFailure and
			 * applies nothing; with many appliers on one row that is a lawful outcome, not a divergence. So each declaration's
			 * final balance must equal its accepted credits, every credit applied exactly once and none lost, and every credit
			 * must end accepted with its read-back, its one new row, or transient.
			 */
			const accepted = (o: typeof overlapImm) =>
				Arr.filter(o.values, (x) => x.kind === "accepted").length
			const transient = (o: typeof overlapImm) =>
				Arr.filter(o.values, (x) => x.kind === "transient").length
			const acceptedWithRow = (x: ObservedValue) =>
				x.kind === "transient" ||
				(x.kind === "accepted" && readBackRows(x.reads, "after").length === 1)
			const kinds = (o: typeof overlapImm) =>
				Arr.join(
					Arr.map(o.values, (x) => x.kind),
					", "
				)
			/**
			 * The post in its single statement and in the conservative realization, through a Db of its own each, on distinct
			 * accounts: the single statement posts accounts 1 to samples + 1, the sequential one the next samples + 1, each
			 * sample after one warming post.
			 */
			const measurePost = Effect.fn("measurePost")(function* (
				realization: "single" | "sequential",
				first: number
			) {
				const before = yield* catalogInserts()
				const run = yield* Effect.scoped(
					Effect.gen(function* () {
						const db = yield* openFull(imm, Simm)
						const change =
							realization === "single"
								? observedChange(db, post(Simm), attemptLabel, { kind: "none" })
								: observedConservative(db, post(Simm), attemptLabel)
						if (Result.isFailure(change)) {
							return yield* Effect.die(change.failure)
						}
						const timed = yield* timedSamples(
							options.samples,
							(i) => change.success.apply({ account: BigInt(first + i + 1) }),
							1
						)
						return { timed, statements: change.success.statements }
					})
				)
				/** As for the credits: the reading feeds only the catalog measure, never a check. */
				let after = yield* catalogInserts()
				for (let i = 0; i < 50 && after === before; i++) {
					yield* Effect.sleep("100 millis")
					after = yield* catalogInserts()
				}
				return { ...run, catalogPerTransaction: (after - before) / (options.samples + 1) }
			})
			const single = yield* measurePost("single", 1)
			const sequential = yield* measurePost("sequential", options.samples + 2)
			/** The accounts each realization posted, and the facts left: pending amounts and entries of those accounts. */
			const posted = (first: number) => Arr.map(indices(options.samples + 1), (i) => first + i)
			const postedCount = Effect.fn("postedCount")(function* (
				relation: "Pending" | "Entry",
				accounts: ReadonlyArray<number>
			) {
				const rows = yield* s.admin.queryValues(
					`SELECT pg_catalog.count(*)::text FROM ${imm.table(relation)} WHERE ${imm.column(relation, "account")} = ANY ($1::int8[])`,
					[`{${Arr.join(Arr.map(accounts, String), ",")}}`]
				)
				const [n] = trusted<CountRow>(oneRow(rows))
				return Number(n)
			})
			const finalPosts = {
				single: {
					pending: yield* postedCount("Pending", posted(1)),
					entries: yield* postedCount("Entry", posted(1))
				},
				sequential: {
					pending: yield* postedCount("Pending", posted(options.samples + 2)),
					entries: yield* postedCount("Entry", posted(options.samples + 2))
				}
			}
			/**
			 * A post's outcome as it must be: accepted, the account's pending amounts each added to Entry and deleted from
			 * Pending, and the read-back its new entries, all of that account.
			 */
			const postedWhole = (o: ObservedApply): boolean => {
				const value = o.value
				if (value.kind !== "accepted") {
					return false
				}
				const of = (relation: string) => Arr.findFirst(value.counts, (c) => c.relation === relation)
				const n = BigInt(options.pendingPerAccount)
				return (
					Option.exists(of("Entry"), (c) => c.added === n) &&
					Option.exists(of("Pending"), (c) => c.deleted === n) &&
					readBackRows(value.reads, "posted").length === options.pendingPerAccount
				)
			}
			/**
			 * Concurrent appliers posting one account, each once, retried on the caller's side while transient: the single
			 * statement on the last account, the sequential realization on the one before it.
			 */
			const overlapPost = Effect.fn("overlapPost")(function* (
				realization: "single" | "sequential",
				account: number
			) {
				const dbs = yield* Effect.forEach(
					Arr.map(indices(options.appliers), (i) => i),
					() => openFull(imm, Simm)
				)
				const values = yield* Effect.forEach(
					dbs,
					(d) =>
						Effect.gen(function* () {
							const change =
								realization === "single"
									? observedChange(d, post(Simm), attemptLabel, { kind: "none" })
									: observedConservative(d, post(Simm), attemptLabel)
							if (Result.isFailure(change)) {
								return yield* Effect.die(change.failure)
							}
							const done = yield* retried(
								() => change.success.apply({ account: BigInt(account) }),
								(o) => o.attempted.transient,
								retryPolicy
							)
							return done.last
						}),
					{ concurrency: "unbounded" }
				)
				return {
					values,
					pending: yield* postedCount("Pending", [account]),
					entries: yield* postedCount("Entry", [account])
				}
			}, Effect.scoped)
			const overlapSingle = yield* overlapPost("single", options.accounts)
			const overlapSequential = yield* overlapPost("sequential", options.accounts - 1)
			/**
			 * Exactly one applier posts the account's amounts; every other ends no-change, finding none left, or in a
			 * TransientFailure once the caller's retries ran out; the account ends with its entries and no pending amount.
			 */
			const postedOnce = (o: typeof overlapSingle): boolean =>
				Arr.filter(o.values, postedWhole).length === 1 &&
				Arr.every(
					o.values,
					(x) => postedWhole(x) || x.value.kind === "no-change" || x.value.kind === "transient"
				) &&
				o.pending === 0 &&
				o.entries === options.pendingPerAccount
			const postKinds = (o: typeof overlapSingle) =>
				Arr.join(
					Arr.map(o.values, (x) => x.value.kind),
					", "
				)
			const singleWrites = Arr.flatMap(single.statements, (x) =>
				x.label.kind === "single" ? [x.label] : []
			)
			const sequentialWrites = Arr.flatMap(sequential.statements, (x) =>
				x.label.kind === "write" ? [x.label] : []
			)

			const cases: Array<CaseRecord<"R35">> = [
				{
					name: "a described put with a post-change read-back, immutable target",
					gates: ["R35"],
					conditions: writeConditions({
						workload:
							"db.apply of a described put crediting one account, with a read-back of its new row",
						schemaState: loadedByOwner,
						data: `${options.accounts} accounts`,
						parameters: { amount: 5 },
						semantics: "accepted, one fact put, the read-back its new row",
						cache: warmedOnce
					}),
					phases: { operationMs: immutable.timed.ms },
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						statements: statementsText(immutable.statements),
						catalogTuplesPerTransaction: immutable.catalogPerTransaction,
						outcomes: Arr.join(
							Arr.map(immutable.timed.values, (o) => o.value.kind),
							", "
						)
					}
				},
				{
					name: "the same put, mutable target",
					gates: ["R35"],
					conditions: writeConditions({
						workload: "the same ChangeSet with Account declared mutable",
						schemaState: loadedByOwner,
						data: `${options.accounts} accounts`,
						parameters: { amount: 5 },
						semantics: "accepted, one fact put, the read-back its new row",
						cache: warmedOnce
					}),
					phases: { operationMs: mutableRun.timed.ms },
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						statements: statementsText(mutableRun.statements),
						catalogTuplesPerTransaction: mutableRun.catalogPerTransaction,
						outcomes: Arr.join(
							Arr.map(mutableRun.timed.values, (o) => o.value.kind),
							", "
						)
					}
				},
				{
					name: `${options.appliers} concurrent appliers crediting one account`,
					gates: ["R35"],
					conditions: writeConditions({
						workload: `each applier credits the same account ${options.credits} times by the described put`,
						schemaState: loadedByOwner,
						data: "the account starts at zero",
						parameters: { appliers: options.appliers, credits: options.credits },
						semantics: "every credit is applied exactly once",
						cache: warmedOnce
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						immutableBalance: String(overlapImm.balance),
						mutableBalance: String(overlapMut.balance),
						immutableRetries: overlapImm.retries,
						mutableRetries: overlapMut.retries,
						immutableTransient: transient(overlapImm),
						mutableTransient: transient(overlapMut),
						immutableOutcomes: kinds(overlapImm),
						mutableOutcomes: kinds(overlapMut)
					}
				},
				{
					name: "a described post with a read-back, one statement",
					gates: ["R35"],
					conditions: writeConditions({
						workload:
							"db.apply of a described post: an insert of Entry and a deletion of Pending, read back",
						schemaState: loadedByOwner,
						data: `${options.accounts} accounts of ${options.pendingPerAccount} pending amounts`,
						parameters: { account: "a fresh account per sample" },
						semantics: "accepted, the account's amounts posted, the read-back its new entries",
						cache: warmedOnce
					}),
					phases: { operationMs: single.timed.ms },
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						statements: statementsText(single.statements),
						catalogTuplesPerTransaction: single.catalogPerTransaction,
						outcomes: Arr.join(
							Arr.map(single.timed.values, (o) => o.value.kind),
							", "
						)
					}
				},
				{
					name: "the same post in its conservative realization, in sequence",
					gates: ["R35"],
					conditions: writeConditions({
						workload: "the same ChangeSet through the program's conservative realization",
						schemaState: loadedByOwner,
						data: `${options.accounts} accounts of ${options.pendingPerAccount} pending amounts`,
						parameters: { account: "a fresh account per sample" },
						semantics: "accepted, the account's amounts posted, the read-back its new entries",
						cache: warmedOnce
					}),
					phases: { operationMs: sequential.timed.ms },
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						statements: statementsText(sequential.statements),
						catalogTuplesPerTransaction: sequential.catalogPerTransaction,
						outcomes: Arr.join(
							Arr.map(sequential.timed.values, (o) => o.value.kind),
							", "
						)
					}
				},
				{
					name: `${options.appliers} concurrent appliers posting one account, in each realization`,
					gates: ["R35"],
					conditions: writeConditions({
						workload:
							"each applier posts the same account once, the single statement and the sequence",
						schemaState: loadedByOwner,
						data: `${options.pendingPerAccount} pending amounts of the account`,
						parameters: { appliers: options.appliers },
						semantics: "one applier posts the account; every other finds nothing left",
						cache: warmedOnce
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						singleOutcomes: postKinds(overlapSingle),
						sequentialOutcomes: postKinds(overlapSequential)
					}
				}
			]
			const r35: VerdictInput = {
				checks: [
					mechanism(
						"the immutable put is sequential: a displacing DELETE of Account before the put's INSERT of it",
						displacedThenInserted(accountWritesImm),
						statementsText(immutable.statements)
					),
					mechanism(
						"the mutable put writes Account in one statement that updates in place",
						writtenInPlace(accountWritesMut),
						statementsText(mutableRun.statements)
					),
					equivalence(
						"both declarations accept every credit",
						Arr.every(
							[...immutable.timed.values, ...mutableRun.timed.values],
							(o) => o.value.kind === "accepted"
						),
						Arr.join(
							Arr.map([...immutable.timed.values, ...mutableRun.timed.values], (o) => o.value.kind),
							", "
						)
					),
					equivalence(
						"concurrent overlapping appliers apply each accepted credit exactly once in both declarations",
						overlapImm.balance === BigInt(accepted(overlapImm)) &&
							overlapMut.balance === BigInt(accepted(overlapMut)),
						`balances ${overlapImm.balance} ${overlapMut.balance}, accepted ${accepted(overlapImm)} ${accepted(overlapMut)} of ${options.appliers * options.credits}`
					),
					equivalence(
						"every concurrent credit is accepted with its read-back, or ends in a TransientFailure once the caller's retries ran out, in both declarations",
						Arr.every(overlapImm.values, acceptedWithRow) &&
							Arr.every(overlapMut.values, acceptedWithRow),
						`transient ${transient(overlapImm)} ${transient(overlapMut)}`
					),
					mechanism(
						"the post's insert of Entry and deletion of Pending are one statement",
						singleWrites.length === 1 &&
							Arr.every(single.statements, (x) => x.label.kind !== "write") &&
							Arr.every(
								singleWrites,
								(w) =>
									w.parts.length === 2 &&
									Arr.some(
										w.parts,
										(p) => p.relation === Entry.name && p.result.kind === "insert"
									) &&
									Arr.some(
										w.parts,
										(p) => p.relation === Pending.name && p.result.kind === "delete"
									)
							),
						statementsText(single.statements)
					),
					mechanism(
						"the conservative realization writes Entry and Pending in sequence, a statement each",
						Arr.some(sequentialWrites, (w) => w.relation === Entry.name) &&
							Arr.some(sequentialWrites, (w) => w.relation === Pending.name) &&
							Arr.every(sequential.statements, (x) => x.label.kind !== "single"),
						statementsText(sequential.statements)
					),
					equivalence(
						"the single statement and the sequential realization post every account alike: accepted, each pending amount added to Entry and deleted from Pending, the read-back the new entries",
						Arr.every([...single.timed.values, ...sequential.timed.values], postedWhole),
						Arr.join(
							Arr.map([...single.timed.values, ...sequential.timed.values], (o) => o.value.kind),
							", "
						)
					),
					equivalence(
						"the single statement and the sequential realization leave the same final state: no pending amount of a posted account, and its every amount an entry",
						finalPosts.single.pending === 0 &&
							finalPosts.sequential.pending === 0 &&
							finalPosts.single.entries === (options.samples + 1) * options.pendingPerAccount &&
							finalPosts.sequential.entries === (options.samples + 1) * options.pendingPerAccount,
						`single ${finalPosts.single.pending} pending ${finalPosts.single.entries} entries, sequential ${finalPosts.sequential.pending} pending ${finalPosts.sequential.entries} entries`
					),
					equivalence(
						"concurrent overlapping appliers post an account exactly once in both realizations, every other ending no-change or in a TransientFailure",
						postedOnce(overlapSingle) && postedOnce(overlapSequential),
						`single ${postKinds(overlapSingle)}; sequential ${postKinds(overlapSequential)}`
					)
				]
			}
			return { cases, verdicts: { R35: r35 } }
		})
})
