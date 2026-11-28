import { Record as Rec } from "effect"
import { type AttemptFailure, labelText } from "#bench/write/support/writes.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	key as keyOn,
	login,
	mirrors,
	mutable,
	on,
	role,
	schema,
	select,
	unit
} from "#compiler/public/schema.ts"
import {
	Digest,
	Done,
	Queue,
	Leased,
	queueQueries,
	Denied,
	Seat,
	toDigest,
	toSeatNo,
	toSlot,
	Wanted,
	QueueWork
} from "#test/support/fixtures/api/queue.ts"
import { type fullWorld, heldRelations } from "#test/support/worlds.ts"

export { toDigest, toSeatNo, toSlot, Wanted, QueueWork }

/**
 * The work queue for the queue gate and the law gates that reuse its standings' arms.
 *
 * The schema is test/support/fixtures/api/queue.ts's relations and statements, built under any name so a Db opened on
 * it logs in as the installed roles: Work, Wanted and Leased open, mutable inside the unit of an item's key, so a
 * transition is an `UPDATE ... FROM` of Work.
 *
 * The claim and the settlement are the fixture's, built over the schema (queueQueries): a ChangeSet's member queries
 * must be written over a level of its schema.
 *
 * A work item's standing and its four arms, each mirrored with the work of its standing: the queue schema declares
 * them.
 */
const standingOf = (s: "wanted" | "leased" | "done" | "denied") =>
	on(
		select(QueueWork, (w) => w.eq(w.standing, s)),
		"key"
	)
const workStanding = [
	mirrors(on(Wanted, "key"), standingOf("wanted")),
	mirrors(on(Leased, "key"), standingOf("leased")),
	mirrors(on(Done, "key"), standingOf("done")),
	mirrors(on(Denied, "key"), standingOf("denied"))
] as const

/** The queue schema, Work, Wanted and Leased open in the unit of an item's key. */
export const queueSchema = (name: string) =>
	schema(name, Rec.values(Queue.relations), [
		unit("Item", { key: Digest }),
		mutable(QueueWork),
		mutable(Wanted),
		mutable(Leased),
		...workStanding,
		keyOn(on(Leased, "resource", "seat")),
		contained(on(Leased, "resource", "seat"), on(Seat, "resource", "seat"))
	])

/** The queue schema's type, over which the claim and the settlement are built. */
type MutableQueue = ReturnType<typeof queueSchema>

/**
 * The queue's worlds over a queue schema `s`, each a full role in a login of its own, so a session's user names the
 * world it writes as: the worker, which claims and settles; the enqueuer, which adds work; and the operator, which
 * keeps the seats.
 */
export const queueBenchWorlds = (s: Parameters<typeof fullWorld>[0]) => {
	const worker = role(s, "worker", heldRelations(s), {
		insert: ["Done", "Denied"],
		write: ["Work", "Wanted", "Leased"]
	})
	const enqueuer = role(s, "enqueuer", heldRelations(s), { write: ["Work", "Wanted"] })
	const operator = role(s, "operator", heldRelations(s), { insert: ["Seat"] })
	return {
		worker,
		enqueuer,
		operator,
		workers: login(s, "workers", [worker]),
		enqueuers: login(s, "enqueuers", [enqueuer]),
		operators: login(s, "operators", [operator])
	}
}

/** The claim, with the read-back of the lease it created and the Wanted payload it left. */
export const claimOf = (s: MutableQueue) => {
	const m = queueQueries(s)
	return ChangeSet.empty(s)
		.put(QueueWork, m.claimWorkPut)
		.delete(Wanted, m.claimWantedDelete)
		.put(Leased, m.claimLeasedPut)
		.read("claimed", (delta) =>
			query(s).rule((r) => {
				const l = v(delta.added(Leased), "addedLeased")
				const { kind, slot, enqueued } = v(QueueWork, "queueWork")
				return r
					.match(delta.added(Leased), l)
					.match(QueueWork, {
						key: l.key,
						kind,
						slot,
						standing: "leased",
						epoch: l.epoch,
						enqueued
					})
					.find({
						key: l.key,
						kind,
						slot,
						enqueued,
						seat: l.seat,
						epoch: l.epoch,
						expires: l.expires
					})
			})
		)
}

/** The settlement's deletion of the live lease and its put of Work done, parameters { key, epoch }. */
const settleBase = (s: MutableQueue) => {
	const m = queueQueries(s)
	return ChangeSet.empty(s).delete(Leased, m.settleLeasedDelete).put(QueueWork, m.settleWorkPut)
}

/**
 * The settlement, parameters { key, epoch, outcome }. Its Done insertion's `outcome` parameter takes the closed type it
 * meets, which TypeScript resolves only over a concrete schema.
 */
export const settleOf = (s: MutableQueue) =>
	settleBase(s).insert(
		Done,
		query(s).rule((r) => {
			const { key, resource, seat, epoch, expires } = v(Leased, "leased")
			return r
				.match(Leased, { key, resource, seat, epoch, expires })
				.where(r.eq(key, r.param("key", Digest)), r.eq(epoch, r.param("epoch", int8)))
				.find({ key, outcome: r.param("outcome", Done.fields.outcome) })
		})
	)

/**
 * SQL expressions over a row number `g`: the item's digest key (a lowercase SHA-256 hex digest, so keys spread
 * uniformly over the key space) and its enqueue instant.
 */
export const digestOf = (g: string): string =>
	`pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((${g})::text, 'UTF8')), 'hex')`

/** A random digest on the host, as a holder draws a fresh start key. */
export const randomDigest = (): string => {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return Buffer.from(bytes).toString("hex")
}

/**
 * The retry label of a claim attempt's failure, by the statement its label names: an item collision where a write of
 * Work or Wanted raised it, a seat collision where a write of Leased did, a commit-time failure at COMMIT, and the
 * statement otherwise.
 */
export const claimLabel = (f: AttemptFailure): string => {
	const label = f.statement
	switch (label.kind) {
		case "commit":
			return `commit ${f.sqlstate}`
		case "write":
			if (label.relation === QueueWork.name || label.relation === Wanted.name) {
				return `item collision at ${labelText(label)} ${f.sqlstate}`
			}
			if (label.relation === Leased.name) {
				return `seat collision at ${labelText(label)} ${f.sqlstate}`
			}
			return `at ${labelText(label)} ${f.sqlstate}`
		case "carrier":
		case "readBack":
		case "check":
		case "single":
			return `at ${labelText(label)} ${f.sqlstate}`
	}
}
