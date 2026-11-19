/** What the properties of reads.test.ts read: the ledger shape, its races and templates, and a run's judgment. */

import type { Gen } from "@bjornpagen/testing/gen"
import { int } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, role, schema } from "#compiler/public/schema.ts"
import { deferrable, workload } from "#compiler/public/workload.ts"
import {
	certifiedShapeTemplate,
	generatedShapeTemplate,
	type IsolationRace,
	type RaceCall,
	type Shape
} from "#test/pg/isolation/support/race.ts"
import type { Explained } from "#test/support/schedules/serial.ts"

const Deposit = relation("Deposit", { batch: pg.integer, n: pg.integer }, ["batch", "n"])
const Copy = relation("Copy", { batch: pg.integer, copied: pg.integer }, ["batch", "copied"])

/** The ledger shape under the name `name` (see reads.test.ts's header). */
export const ledgerShape = (name: string): Shape => {
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
export const readMembers = ["view", "deferredView"] as const

/** A race over the ledger: the read's member, plain or deferrable, and the teller's deposit beside the stored one. */
export interface LedgerRace {
	readonly read: (typeof readMembers)[number]
	readonly n: number
}

/** A case: the teller's deposit beside the stored one, which a race of each read member deposits. */
export const depositGen: Gen<number> = int(2, 3)

/** The closer's input: it takes no parameter. */
const noParams = { kind: "params", params: {} } as const

/** The calls of a race: the closer's close, the teller's deposit and the auditor's read, each in a session of its own. */
export const raceOf = (race: LedgerRace): IsolationRace => ({
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
export type ReadFeature =
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
export const judgedRun =
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
export const runs = 2

/** The ledger as generate certifies it, installed once per member (race.ts generatedShapeTemplate). */
export const generatedLedger = generatedShapeTemplate(import.meta, "reads ledger", ledgerShape)

/**
 * The ledger with the teller forced READ COMMITTED, installed once per member (race.ts certifiedShapeTemplate): the
 * flaw a certifier without condition laws's second half would pass.
 */
export const forcedTellerLedger = certifiedShapeTemplate(
	import.meta,
	"reads forced teller",
	ledgerShape,
	{
		kind: "forced",
		flaw: "condition laws without its second half: a SERIALIZABLE member reading a READ COMMITTED role's relation",
		roles: ["teller"]
	}
)
