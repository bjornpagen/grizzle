/**
 * Reads in the isolation oracle: a read member's transaction, plain or deferrable(...), raced against the writers whose
 * rows it reads, judged by the serial reference beside them (support/race.ts runIsolationRace).
 *
 * The shape is the read-only anomaly (Fekete, O'Neil and O'Neil, A Read-Only Transaction Anomaly Under Snapshot
 * Isolation, 2004) in grizzle's terms: the `teller`'s `deposit(batch, n)` inserts a Deposit; the `closer`'s `close`
 * copies every Deposit into Copy, rows of many teller calls, so it can miss a deposit in flight; the `auditor`'s `view`
 * reads every Deposit with the Copy rows of its batch attached, in one statement, as `view` or as its deferrable(...)
 * member `deferredView`. From
 * one stored Deposit, a closer that copied it, a teller that deposited beside it and committed first, and a view that
 * saw the deposit and not the copy make a cycle (the closer before the teller, the teller before the view, the view
 * before the closer) unless PostgreSQL breaks it. A call is a direct transaction of the statements its served member
 * sends: a write at the level its role's served file records; a read in the transaction its served BEGIN states (its
 * modes by SET TRANSACTION), DEFERRABLE exactly for a deferrable member; the barrier sees a read waiting for a safe
 * snapshot as it sees a lock wait (test/support/substrate/barrier.ts).
 *
 * - At generate's levels, where the teller and the closer are SERIALIZABLE (the closer, which runs SERIALIZABLE, reads
 *   what the teller writes: condition `laws`), every order of a race's moves is one some serial order of its calls
 *   explains, reads included, and no deferrable read fails: PostgreSQL waits for its safe snapshot, retaking it where
 *   the closer committed with a conflict out to the teller, so it never meets a serialization failure. A plain read
 *   reads at once; the cycle is broken by refusing the closer.
 * - With the teller forced READ COMMITTED, condition `laws` without its second half, SSI cannot see the closer miss the
 *   teller's deposit, and a deferrable read is safe at once: the oracle must find a run no serial order explains, and
 *   generate must keep the teller SERIALIZABLE.
 *
 * Features: a plain read and a deferrable one; a deferrable read that waited for a safe snapshot, placed after a writer
 * it waited for and placed before one; a writer refused beside a plain read; the forced teller caught.
 *
 * Plants (~/.cache/grizzle-release/DEFERRABLE/plants): read-never-deferrable.patch (a read's BEGIN never DEFERRABLE),
 * read-repeatable.patch (a deferrable read begun REPEATABLE READ READ ONLY), served-deferrable-dropped.patch (a served
 * read never deferrable), certify-laws-reader-half.patch (condition `laws` without a SERIALIZABLE member's read).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, role, schema } from "#compiler/public/schema.ts"
import { deferrable, workload } from "#compiler/public/workload.ts"
import {
	type InstalledShape,
	type IsolationRace,
	installShape,
	type RaceCall,
	runIsolationRace,
	type Shape
} from "#test/pg/isolation/support/race.ts"
import { caseHang } from "#test/support/limits.ts"
import { every } from "#test/support/schedules/interleave.ts"
import type { Explained } from "#test/support/schedules/serial.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Deposit = relation("Deposit", { batch: pg.integer, n: pg.integer }, ["batch", "n"])
const Copy = relation("Copy", { batch: pg.integer, copied: pg.integer }, ["batch", "copied"])

/** The ledger shape under the name `name` (see the header). */
const ledgerShape = (name: string): Shape => {
	const relations = { Deposit, Copy } as const
	const base = schema(name, [Deposit, Copy], [])
	const teller = role(base, "teller", relations, { insert: ["Deposit"] })
	const closer = role(base, "closer", relations, { insert: ["Copy"] })
	const auditor = role(base, "auditor", relations)
	const deposit = ChangeSet.empty(teller).insert(
		teller.relations.Deposit,
		query(teller).rule((r) =>
			r.find({ batch: r.param("batch", pg.integer), n: r.param("n", pg.integer) })
		)
	)
	const close = ChangeSet.empty(closer).insert(
		closer.relations.Copy,
		query(closer).rule((r) => {
			const { batch, n } = v(closer.relations.Deposit, "deposit")
			return r.match(closer.relations.Deposit, { batch, n }).find({ batch, copied: n })
		})
	)
	const view = query(auditor)
		.rule((r) => {
			const { batch, n } = v(auditor.relations.Deposit, "deposit")
			return r.match(auditor.relations.Deposit, { batch, n }).find({ batch, n })
		})
		.attach(
			"copies",
			(deposit) =>
				query(auditor).rule((r) => {
					const { copied } = v(auditor.relations.Copy, "copy")
					return r.match(auditor.relations.Copy, { batch: deposit.batch, copied }).find({ copied })
				}),
			"array"
		)
	const workloads = [
		workload(teller, { deposit }),
		workload(closer, { close }),
		workload(auditor, { view, deferredView: deferrable(view) })
	] as const
	return {
		schema: base,
		roles: { teller, closer, auditor },
		login: login(base, "app", [teller, closer, auditor], { workload: workloads })
	}
}

/** The stored Deposit every race starts from, which the closer copies. */
const initial = { Deposit: [{ batch: 1, n: 1 }], Copy: [] } as const

/** The read members of the auditor: plain, and deferrable(...). */
const readMembers = ["view", "deferredView"] as const

/** A race over the ledger: the read's member, plain or deferrable, and the teller's deposit beside the stored one. */
interface LedgerRace {
	readonly read: (typeof readMembers)[number]
	readonly n: number
}

/** A case: the teller's deposit beside the stored one, which a race of each read member deposits. */
const depositGen: Gen<number> = int(2, 3)

/** The closer's input: it takes no parameter. */
const noParams = { kind: "params", params: {} } as const

/** The calls of a race: the closer's close, the teller's deposit and the auditor's read, each in a session of its own. */
const raceOf = (race: LedgerRace): IsolationRace => ({
	initial,
	calls: [
		{ kind: "change", session: "closer", role: "closer", member: "close", input: noParams },
		{
			kind: "change",
			session: "teller",
			role: "teller",
			member: "deposit",
			input: { kind: "params", params: { batch: 1, n: race.n } }
		},
		{ kind: "read", session: "auditor", role: "auditor", member: race.read, params: {} }
	] satisfies Arr.NonEmptyReadonlyArray<RaceCall>
})

/** What a run reached. */
type ReadFeature =
	| "a plain read"
	| "a deferrable read"
	| "a deferrable read waited for a safe snapshot"
	| "a deferrable read placed after a writer it waited for"
	| "a deferrable read placed before a writer it waited for"
	| "a writer refused beside a plain read"

/**
 * One explained run of `race` checked and noted: a deferrable read that ended uncommitted is put in `refused`; where it
 * waited for a safe snapshot, where the serial order places it beside each writer it waited for; and a writer refused
 * beside a plain read.
 */
const judgedRun =
	(race: LedgerRace, refused: Array<string>, note: (feature: ReadFeature) => void) =>
	(e: Explained<never>): void => {
		const read = Option.fromNullishOr(e.ends.get("auditor"))
		if (race.read === "deferredView") {
			if (!Option.exists(read, (end) => end.kind === "committed")) {
				refused.push(`${Formatter.format(read)}\n${Arr.join(e.run.order, "\n")}`)
			}
			const waited = Arr.flatMap(e.run.moves, (m) =>
				m.session === "auditor" &&
				m.observed._tag === "Waited" &&
				m.observed.lock.locktype === "safe snapshot"
					? m.observed.on
					: []
			)
			if (waited.length > 0) {
				note("a deferrable read waited for a safe snapshot")
			}
			const at = (session: string) => e.order.indexOf(session)
			for (const writer of waited) {
				if (at(writer) < 0) {
					continue
				}
				note(
					at("auditor") > at(writer)
						? "a deferrable read placed after a writer it waited for"
						: "a deferrable read placed before a writer it waited for"
				)
			}
			return
		}
		if (
			Arr.some(["closer", "teller"], (writer) =>
				Option.exists(Option.fromNullishOr(e.ends.get(writer)), (end) => end.kind === "aborted")
			)
		) {
			note("a writer refused beside a plain read")
		}
	}

/**
 * How many cases the positive property runs: each draws the teller's deposit, at which each read member is a race of
 * its own, every order of it.
 */
const runs = 2

layer(Substrate.layer, { excludeTestServices: true })("reads in the isolation oracle", (it) => {
	it.effect(
		"every order of a ledger race, its read plain or deferrable, is serial at generate's levels, and no deferrable read fails",
		(ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const s: InstalledShape = yield* installShape(ledgerShape, { kind: "generate" })
						return yield* explore(
							{
								oracle: {
									kind: "specification",
									name: "a serial order of the same calls, reads included; PostgreSQL's safe snapshot"
								},
								suite: "pg/isolation/reads",
								draw: drawn(depositGen),
								literal: Formatter.format,
								coverage: required<ReadFeature>(
									[
										"a plain read",
										"a deferrable read",
										"a deferrable read waited for a safe snapshot",
										"a deferrable read placed after a writer it waited for",
										"a deferrable read placed before a writer it waited for",
										"a writer refused beside a plain read"
									],
									{ cases: runs, sense: notesOnly }
								),
								kept: [],
								runs,
								shrink: { kind: "bounded", candidates: 8 },
								concurrency: 1,
								steerEvery: runs,
								caseHang
							},
							(n, c) =>
								Effect.forEach(
									readMembers,
									(read) =>
										Effect.gen(function* () {
											const race: LedgerRace = { read, n }
											c.note(read === "view" ? "a plain read" : "a deferrable read")
											const refused: Array<string> = []
											yield* Effect.scoped(
												runIsolationRace(
													s,
													raceOf(race),
													() => every,
													judgedRun(race, refused, (feature) => c.note(feature))
												)
											)
											if (Arr.isReadonlyArrayNonEmpty(refused)) {
												return yield* Effect.die(
													new Error(
														`a deferrable read ended uncommitted, where PostgreSQL's safe snapshot admits no refusal:\n${Arr.join(refused, "\n\n")}`
													)
												)
											}
										}),
									{ discard: true }
								)
						)
					})
				)
			)
	)

	it.effect(
		"a teller forced READ COMMITTED beside the SERIALIZABLE closer that reads its deposits is caught through a deferrable read",
		(ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const s = yield* installShape(ledgerShape, {
							kind: "forced",
							flaw: "condition laws without its second half: a SERIALIZABLE member reading a READ COMMITTED role's relation",
							roles: ["teller"]
						})
						if (s.generated.get("teller") !== "serializable") {
							return yield* Effect.die(
								new Error(
									`generate certifies the teller ${String(s.generated.get("teller"))}, though the SERIALIZABLE closer reads its deposits`
								)
							)
						}
						return yield* explore(
							{
								oracle: { kind: "specification", name: "a serial order of the same calls" },
								suite: "pg/isolation/reads forced",
								draw: drawn(depositGen),
								literal: Formatter.format,
								coverage: required<"the forced teller caught">(["the forced teller caught"], {
									cases: 1,
									sense: notesOnly
								}),
								kept: [],
								runs: 1,
								shrink: { kind: "bounded", candidates: 1 },
								concurrency: 1,
								steerEvery: 1,
								caseHang
							},
							(n, c) => {
								const race: LedgerRace = { read: "deferredView", n }
								return Effect.scoped(
									Effect.flatMap(
										Effect.result(
											runIsolationRace(
												s,
												raceOf(race),
												() => every,
												() => undefined
											)
										),
										(result) => {
											if (result._tag === "Failure" && result.failure._tag === "NoSerialOrder") {
												c.note("the forced teller caught")
												return Effect.void
											}
											return result._tag === "Failure"
												? Effect.fail(result.failure)
												: Effect.die(
														new Error(
															`every order of ${Formatter.format(race)} is serial with the teller READ COMMITTED, so the oracle cannot catch the flaw`
														)
													)
										}
									)
								)
							}
						)
					})
				)
			)
	)
})
