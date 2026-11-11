import { type AttemptFailure, labelText } from "#bench/write/support/writes.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	alternatives,
	contained,
	key as keyOn,
	login,
	mutable,
	on,
	role,
	type Statement,
	schema
} from "#compiler/public/schema.ts"
import {
	Digest,
	Done,
	Queue,
	type QueueShaped,
	Leased,
	queueQueries,
	Denied,
	Seat,
	SeatNo,
	Slot,
	Standing,
	Wanted,
	QueueWork
} from "#test/support/fixtures/api/queue.ts"
import { type fullWorld, heldRelations } from "#test/support/worlds.ts"

export { Digest, SeatNo, Slot, Wanted, QueueWork }

/**
 * The work queue for the queue gate and the law gates that reuse its alternatives.
 *
 * The schema is test/support/fixtures/api/queue.ts's relations and statements, built under any name so a Db opened on
 * it logs in as the installed roles, in two declarations that differ only in `mutable(Work)`: the fixture's, where a
 * transition is an `UPDATE ... FROM` of Work, and the immutable one, where it is a DELETE and an INSERT. "`mutable`
 * against immutable `Work`, which differ in write cost only".
 *
 * The claim and the settlement are the fixture's, built over each declaration (queueQueries): a ChangeSet's member
 * queries must be written over a level of its schema.
 *
 * A work item's standing and its four arms: both queue schemas declare it, and a gate reads its laws from this value.
 */
const workStanding = alternatives(QueueWork, "standing", Standing, {
	wanted: Wanted,
	leased: Leased,
	done: Done,
	denied: Denied
})

/** The queue schema, Work mutable. */
export const queueSchema = (name: string) =>
	schema(name, Queue.relations, [
		mutable(QueueWork),
		workStanding,
		keyOn(on(Leased, "resource", "seat")),
		contained(on(Leased, "resource", "seat"), on(Seat, "resource", "seat"))
	])

/** The same schema with Work immutable. */
export const immutableQueueSchema = (name: string) =>
	schema(name, Queue.relations, [
		workStanding,
		keyOn(on(Leased, "resource", "seat")),
		contained(on(Leased, "resource", "seat"), on(Seat, "resource", "seat"))
	])

/**
 * The queue's worlds over a queue schema `s`, each a full role in a login of its own, so a session's user names the
 * world it writes as: the worker, which claims and settles; the enqueuer, which adds work; and the operator, which
 * keeps the seats.
 */
export const queueBenchWorlds = (s: Parameters<typeof fullWorld>[0]) => {
	const worker = role(s, "worker", heldRelations(s), {
		write: ["Work", "Wanted", "Leased", "Done", "Denied"]
	})
	const enqueuer = role(s, "enqueuer", heldRelations(s), { write: ["Work", "Wanted"] })
	const operator = role(s, "operator", heldRelations(s), { write: ["Seat"] })
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
export const claimOf = <St extends ReadonlyArray<Statement>>(s: QueueShaped<St>) => {
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
const settleBase = <St extends ReadonlyArray<Statement>>(s: QueueShaped<St>) => {
	const m = queueQueries(s)
	return ChangeSet.empty(s).delete(Leased, m.settleLeasedDelete).put(QueueWork, m.settleWorkPut)
}

type MutableQueue = ReturnType<typeof queueSchema>
type ImmutableQueue = ReturnType<typeof immutableQueueSchema>

/**
 * The settlement, parameters { key, epoch, outcome }. Its Done insertion's `outcome` parameter takes the closed type it
 * meets, which TypeScript resolves only over a concrete schema, so each declaration has its own.
 */
export const settleOf = (s: MutableQueue) =>
	settleBase(s).insert(
		Done,
		query(s).rule((r) => {
			const { key, resource, seat, epoch, expires } = v(Leased, "leased")
			return r
				.match(Leased, { key, resource, seat, epoch, expires })
				.where(r.eq(key, r.param("key", Digest)), r.eq(epoch, r.param("epoch", pg.bigint)))
				.find({ key, outcome: r.param("outcome", Done.fields.outcome) })
		})
	)

export const settleOfImmutable = (s: ImmutableQueue) =>
	settleBase(s).insert(
		Done,
		query(s).rule((r) => {
			const { key, resource, seat, epoch, expires } = v(Leased, "leased")
			return r
				.match(Leased, { key, resource, seat, epoch, expires })
				.where(r.eq(key, r.param("key", Digest)), r.eq(epoch, r.param("epoch", pg.bigint)))
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
		case "analyze":
		case "advance":
		case "readBack":
		case "check":
		case "single":
		case "family":
			return `at ${labelText(label)} ${f.sqlstate}`
	}
}
