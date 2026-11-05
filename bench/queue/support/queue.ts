import { type AttemptFailure, labelText } from "#bench/write/support/writes.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
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
	type Schema,
	type Statement,
	schema
} from "#compiler/public/schema.ts"
import { Instant } from "#test/support/fixtures/api/contracts.ts"
import {
	Digest,
	Done,
	epochBound,
	QueueKind,
	Leased,
	Outcome,
	Reason,
	Refused,
	Resource,
	Seat,
	SeatNo,
	Slot,
	Standing,
	Wanted,
	QueueWork
} from "#test/support/fixtures/api/queue.ts"
import { type fullWorld, heldRelations } from "#test/support/worlds.ts"

export { Digest, SeatNo, Slot, Wanted, QueueWork }

const relations = {
	Standing,
	Kind: QueueKind,
	Resource,
	Outcome,
	Reason,
	Work: QueueWork,
	Wanted,
	Leased,
	Done,
	Refused,
	Seat
} as const

type QueueRelations = typeof relations

/**
 * The work queue for the queue gate and the law gates that reuse its alternatives.
 *
 * The schema is test/support/fixtures/api/queue.ts's relations and statements, built under any name so a Db opened on
 * it logs in as the installed roles, in two declarations that differ only in `mutable(Work)`: the fixture's, where a
 * transition is an `UPDATE ... FROM` of Work, and the immutable one, where it is a DELETE and an INSERT. "`mutable`
 * against immutable `Work`, which differ in write cost only".
 *
 * The claim and the settlement are the fixture's rule for rule: their members are written over the built
 * schema (a ChangeSet's member queries must be written over a level of its schema), exactly as
 * test/pg/e2e-laws/queue-queries.ts writes them over the installed one.
 *
 * A work item's standing and its four arms: both queue schemas declare it, and a gate reads its laws from this value.
 */
export const workStanding = alternatives(QueueWork, "standing", Standing, {
	wanted: Wanted,
	leased: Leased,
	done: Done,
	refused: Refused
})

/** The queue schema, Work mutable. */
export const queueSchema = (name: string) =>
	schema(name, relations, [
		mutable(QueueWork),
		workStanding,
		keyOn(on(Leased, "resource", "seat")),
		contained(on(Leased, "resource", "seat"), on(Seat, "resource", "seat"))
	])

/** The same schema with Work immutable. */
export const immutableQueueSchema = (name: string) =>
	schema(name, relations, [
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
		write: ["Work", "Wanted", "Leased", "Done", "Refused"]
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

type QueueOf<St extends ReadonlyArray<Statement>> = Schema<string, QueueRelations, St>

/** The claimable items over `s`. */
const picking = <St extends ReadonlyArray<Statement>>(s: QueueOf<St>) => {
	const claimable = query(s)
		.rule((r) => {
			const { key, kind, slot, epoch, enqueued } = v(QueueWork, "queueWork")
			const { due, attempts } = v(Wanted, "wanted")
			return r
				.match(QueueWork, { key, kind, slot, standing: "wanted", epoch, enqueued })
				.match(Wanted, { key, due, attempts })
				.where(
					r.eq(kind, r.param("kind", QueueWork.fields.kind)),
					r.eq(slot, r.param("slot", Slot)),
					r.le(due, r.param("now", Instant)),
					r.ge(key, r.param("from", Digest))
				)
				.find({
					key,
					kind,
					slot,
					standing: Standing.handle("wanted"),
					epoch,
					enqueued,
					wrap: 0,
					due,
					attempts
				})
		})
		.rule((r) => {
			const { key, kind, slot, epoch, enqueued } = v(QueueWork, "queueWork")
			const { due, attempts } = v(Wanted, "wanted")
			return r
				.match(QueueWork, { key, kind, slot, standing: "wanted", epoch, enqueued })
				.match(Wanted, { key, due, attempts })
				.where(
					r.eq(kind, r.param("kind", QueueWork.fields.kind)),
					r.eq(slot, r.param("slot", Slot)),
					r.le(due, r.param("now", Instant)),
					r.lt(key, r.param("from", Digest))
				)
				.find({
					key,
					kind,
					slot,
					standing: Standing.handle("wanted"),
					epoch,
					enqueued,
					wrap: 1,
					due,
					attempts
				})
		})
		.rule((r) => {
			const { key, kind, slot, epoch, enqueued } = v(QueueWork, "queueWork")
			const { seat, expires } = v(Leased, "leased")
			return r
				.match(QueueWork, { key, kind, slot, standing: "leased", epoch, enqueued })
				.match(Leased, {
					key,
					resource: r.param("resource", Leased.fields.resource),
					seat,
					expires
				})
				.where(
					r.eq(kind, r.param("kind", QueueWork.fields.kind)),
					r.eq(slot, r.param("slot", Slot)),
					r.lt(expires, r.param("now", Instant)),
					r.ge(key, r.param("from", Digest))
				)
				.find({
					key,
					kind,
					slot,
					standing: Standing.handle("leased"),
					epoch,
					enqueued,
					wrap: 0,
					seat,
					expires
				})
		})
		.rule((r) => {
			const { key, kind, slot, epoch, enqueued } = v(QueueWork, "queueWork")
			const { seat, expires } = v(Leased, "leased")
			return r
				.match(QueueWork, { key, kind, slot, standing: "leased", epoch, enqueued })
				.match(Leased, {
					key,
					resource: r.param("resource", Leased.fields.resource),
					seat,
					expires
				})
				.where(
					r.eq(kind, r.param("kind", QueueWork.fields.kind)),
					r.eq(slot, r.param("slot", Slot)),
					r.lt(expires, r.param("now", Instant)),
					r.lt(key, r.param("from", Digest))
				)
				.find({
					key,
					kind,
					slot,
					standing: Standing.handle("leased"),
					epoch,
					enqueued,
					wrap: 1,
					seat,
					expires
				})
		})
		.orderBy(["wrap", "asc"], ["key", "asc"])
		.take(1)
	const freeSeat = query(s)
		.rule((r) => {
			const { resource, seat } = v(Seat, "seat")
			return r
				.match(Seat, { resource, seat })
				.where(
					r.eq(resource, r.param("resource", Seat.fields.resource)),
					r.ge(seat, r.param("fromSeat", SeatNo)),
					r.not(Leased, { resource, seat })
				)
				.find({ seat, wrap: 0 })
		})
		.rule((r) => {
			const { resource, seat } = v(Seat, "seat")
			return r
				.match(Seat, { resource, seat })
				.where(
					r.eq(resource, r.param("resource", Seat.fields.resource)),
					r.lt(seat, r.param("fromSeat", SeatNo)),
					r.not(Leased, { resource, seat })
				)
				.find({ seat, wrap: 1 })
		})
		.orderBy(["wrap", "asc"], ["seat", "asc"])
		.take(1)
	return query(s)
		.rule((r) => {
			const items = claimable.bind({
				kind: r.param("kind", QueueWork.fields.kind),
				slot: r.param("slot", Slot),
				now: r.param("now", Instant),
				from: r.param("from", Digest),
				resource: r.param("resource", Leased.fields.resource)
			})
			const seats = freeSeat.bind({
				resource: r.param("resource", Leased.fields.resource),
				fromSeat: r.param("fromSeat", SeatNo)
			})
			const { key, kind, slot, epoch, enqueued } = v(items, "items")
			const { seat } = v(seats, "seats")
			return r
				.match(items, { standing: "wanted", key, kind, slot, epoch, enqueued })
				.match(seats, { seat })
				.find({ key, kind, slot, epoch, enqueued, seat })
		})
		.rule((r) => {
			const items = claimable.bind({
				kind: r.param("kind", QueueWork.fields.kind),
				slot: r.param("slot", Slot),
				now: r.param("now", Instant),
				from: r.param("from", Digest),
				resource: r.param("resource", Leased.fields.resource)
			})
			const { key, kind, slot, epoch, enqueued } = v(items, "items")
			const { seat } = v(Leased, "leased")
			return r
				.match(items, { standing: "leased", key, kind, slot, epoch, enqueued })
				.match(Leased, { key, seat })
				.find({ key, kind, slot, epoch, enqueued, seat })
		})
}

/** The claim, with the read-back of the lease it created and the Wanted payload it left. */
export const claimOf = <St extends ReadonlyArray<Statement>>(s: QueueOf<St>) => {
	const pick = picking(s)
	return ChangeSet.empty(s)
		.put(
			QueueWork,
			query(s).rule((r) => {
				const p = pick.bind({
					kind: r.param("kind", QueueWork.fields.kind),
					slot: r.param("slot", Slot),
					now: r.param("now", Instant),
					from: r.param("from", Digest),
					resource: r.param("resource", Leased.fields.resource),
					fromSeat: r.param("fromSeat", SeatNo)
				})
				const x = v(p, "p")
				return r.match(p, x).find({
					key: x.key,
					kind: x.kind,
					slot: x.slot,
					standing: "leased",
					epoch: Compute.when(
						Compute.within(x.epoch, 0n, epochBound),
						(epoch) => Compute.cast(Compute.add(epoch, 1n), pg.bigint),
						x.epoch
					),
					enqueued: x.enqueued
				})
			})
		)
		.delete(
			Wanted,
			query(s).rule((r) => {
				const p = pick.bind({
					kind: r.param("kind", QueueWork.fields.kind),
					slot: r.param("slot", Slot),
					now: r.param("now", Instant),
					from: r.param("from", Digest),
					resource: r.param("resource", Leased.fields.resource),
					fromSeat: r.param("fromSeat", SeatNo)
				})
				const { key } = v(p, "p")
				const { due, attempts } = v(Wanted, "wanted")
				return r
					.match(p, { key })
					.match(Wanted, { key, due, attempts })
					.find({ key, due, attempts })
			})
		)
		.put(
			Leased,
			query(s).rule((r) => {
				const p = pick.bind({
					kind: r.param("kind", QueueWork.fields.kind),
					slot: r.param("slot", Slot),
					now: r.param("now", Instant),
					from: r.param("from", Digest),
					resource: r.param("resource", Leased.fields.resource),
					fromSeat: r.param("fromSeat", SeatNo)
				})
				const { key, epoch, seat } = v(p, "p")
				return r.match(p, { key, epoch, seat }).find({
					key,
					resource: r.param("resource", Leased.fields.resource),
					seat,
					epoch: Compute.when(
						Compute.within(epoch, 0n, epochBound),
						(current) => Compute.cast(Compute.add(current, 1n), pg.bigint),
						epoch
					),
					expires: r.param("expires", Leased.fields.expires)
				})
			})
		)
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
const settleBase = <St extends ReadonlyArray<Statement>>(s: QueueOf<St>) =>
	ChangeSet.empty(s)
		.delete(
			Leased,
			query(s).rule((r) => {
				const { key, resource, seat, epoch, expires } = v(Leased, "leased")
				return r
					.match(Leased, { key, resource, seat, epoch, expires })
					.where(r.eq(key, r.param("key", Digest)), r.eq(epoch, r.param("epoch", pg.bigint)))
					.find({ key, resource, seat, epoch, expires })
			})
		)
		.put(
			QueueWork,
			query(s).rule((r) => {
				const { key, resource, seat, epoch, expires } = v(Leased, "leased")
				const { kind, slot, enqueued } = v(QueueWork, "queueWork")
				return r
					.match(Leased, { key, resource, seat, epoch, expires })
					.match(QueueWork, { key, kind, slot, epoch, enqueued })
					.where(r.eq(key, r.param("key", Digest)), r.eq(epoch, r.param("epoch", pg.bigint)))
					.find({ key, kind, slot, standing: "done", epoch, enqueued })
			})
		)

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
			return `at ${labelText(label)} ${f.sqlstate}`
	}
}
