import { Compute } from "#compiler/public/compute.ts"
import { closedId, contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	alternatives,
	closed,
	contained,
	key as candidateKey,
	login,
	mutable,
	on,
	relation,
	role,
	type Schema,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Instant } from "#test/support/fixtures/api/contracts.ts"

export const QueueKind = closed("Kind", ["render", "transcode"])
export const Resource = closed("Resource", ["gpu", "cpu"])
export const Outcome = closed("Outcome", ["succeeded", "failed"])
export const Reason = closed("Reason", ["malformed", "unsupported"])
export const Digest = contract("Digest", str.regex("^[0-9a-f]{64}$"))
export const Slot = contract("Slot", pg.integer, (x) => x.ge(0))
export const SeatNo = contract("SeatNo", pg.integer, (x) => x.ge(0))

export const Standing = closed("Standing", ["wanted", "leased", "done", "refused"])
export const QueueWork = relation(
	"Work",
	{
		key: Digest,
		kind: closedId(QueueKind),
		slot: Slot,
		standing: closedId(Standing),
		epoch: pg.bigint,
		enqueued: Instant
	},
	["key"]
)

export const Wanted = relation("Wanted", { key: Digest, due: Instant, attempts: pg.integer }, [
	"key"
])

export const Leased = relation(
	"Leased",
	{ key: Digest, resource: closedId(Resource), seat: SeatNo, epoch: pg.bigint, expires: Instant },
	["key"]
)
export const Done = relation("Done", { key: Digest, outcome: closedId(Outcome) }, ["key"])
export const Refused = relation("Refused", { key: Digest, reason: closedId(Reason) }, ["key"])
export const Seat = relation("Seat", { resource: closedId(Resource), seat: SeatNo }, [
	"resource",
	"seat"
])

/**
 * The work queue as facts, in public-API form: the Queue schema built by the real schema constructors, and the claim's
 * and the settlement's queries built by the real query builder through the typed facade. Each query is checked into the
 * IR test/support/fixtures/ir/queue.ts states for it.
 *
 * The queue example gives the closed relations and contracts minimally, and states claimable, freeSeat and pick only in
 * prose; the rules below write them out as that prose says, in the form the IR fixture states: each arm matches Work
 * with its standing fixed and its arm relation's payload bound, filters kind, slot, its time and its side of `from` in
 * that order, and carries a literal `wrap`.
 *
 * claimable and freeSeat have parameters, and so has pick, which reads them; an import of a query with parameters takes
 * a complete `.bind(...)` map, so pick and the claim's members import through bind with the claim's own parameters of
 * the same names, rather than a bare `match(claimable, ...)` and `v(pick)`. The put of Leased binds only key, epoch and
 * seat, the fields it reads, as its IR states; `r.match(pick, p)` with `p = v(pick)` binds every field of pick, which
 * is the same set of facts.
 */
export const Queue = schema(
	"Queue",
	{
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
	},
	[
		mutable(QueueWork),
		alternatives(QueueWork, "standing", Standing, {
			wanted: Wanted,
			leased: Leased,
			done: Done,
			refused: Refused
		}),
		candidateKey(Leased, ["resource", "seat"]),
		contained(on(Leased, "resource", "seat"), on(Seat, "resource", "seat"))
	]
)

/** Queue under another name, as an installation under a unique schema name opens it. */
export type QueueNamed<N extends string> = Schema<
	N,
	(typeof Queue)["relations"],
	(typeof Queue)["statements"]
>

/**
 * Queue's worlds over the schema they are given: the worker claims and settles, the enqueuer adds work, the operator
 * keeps the seats; full roles all, in one login.
 */
export const queueWorlds = (installed: QueueNamed<string>) => {
	const worker = role(installed, "worker", installed.relations, {
		write: ["Work", "Wanted", "Leased", "Done", "Refused"]
	})
	const enqueuer = role(installed, "enqueuer", installed.relations, { write: ["Work", "Wanted"] })
	const operator = role(installed, "operator", installed.relations, { write: ["Seat"] })
	return {
		worker,
		enqueuer,
		operator,
		server: login(installed, "server", [worker, enqueuer, operator])
	}
}

/** Wanted and due, or leased on this resource and expired, from the holder's key `from`, wrapping around. */
export const claimable = query(Queue)
	.rule((r) => {
		const { key, kind, slot, epoch, enqueued } = v(QueueWork)
		const { due, attempts } = v(Wanted)
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
				wrap: r.literal(0),
				due,
				attempts
			})
	})
	.rule((r) => {
		const { key, kind, slot, epoch, enqueued } = v(QueueWork)
		const { due, attempts } = v(Wanted)
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
				wrap: r.literal(1),
				due,
				attempts
			})
	})
	.rule((r) => {
		const { key, kind, slot, epoch, enqueued } = v(QueueWork)
		const { seat, expires } = v(Leased)
		return r
			.match(QueueWork, { key, kind, slot, standing: "leased", epoch, enqueued })
			.match(Leased, { key, resource: r.param("resource", Leased.fields.resource), seat, expires })
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
				wrap: r.literal(0),
				seat,
				expires
			})
	})
	.rule((r) => {
		const { key, kind, slot, epoch, enqueued } = v(QueueWork)
		const { seat, expires } = v(Leased)
		return r
			.match(QueueWork, { key, kind, slot, standing: "leased", epoch, enqueued })
			.match(Leased, { key, resource: r.param("resource", Leased.fields.resource), seat, expires })
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
				wrap: r.literal(1),
				seat,
				expires
			})
	})
	.orderBy(["wrap", "asc"], ["key", "asc"])
	.take(1)

/** A free seat of the resource from `fromSeat`, wrapping around. */
export const freeSeat = query(Queue)
	.rule((r) => {
		const { resource, seat } = v(Seat)
		return r
			.match(Seat, { resource, seat })
			.where(
				r.eq(resource, r.param("resource", Seat.fields.resource)),
				r.ge(seat, r.param("fromSeat", SeatNo)),
				r.not(Leased, { resource, seat })
			)
			.find({ seat, wrap: r.literal(0) })
	})
	.rule((r) => {
		const { resource, seat } = v(Seat)
		return r
			.match(Seat, { resource, seat })
			.where(
				r.eq(resource, r.param("resource", Seat.fields.resource)),
				r.lt(seat, r.param("fromSeat", SeatNo)),
				r.not(Leased, { resource, seat })
			)
			.find({ seat, wrap: r.literal(1) })
	})
	.orderBy(["wrap", "asc"], ["seat", "asc"])
	.take(1)

/**
 * Wanted work takes the free seat; an expired lease keeps its own seat. claimable and freeSeat have
 * parameters, so each is imported through bind, with the claim's own parameters of the same names.
 */
export const pick = query(Queue)
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
		const { key, kind, slot, epoch, enqueued } = v(items)
		const { seat } = v(seats)
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
		const { key, kind, slot, epoch, enqueued } = v(items)
		const { seat } = v(Leased)
		return r
			.match(items, { standing: "leased", key, kind, slot, epoch, enqueued })
			.match(Leased, { key, seat })
			.find({ key, kind, slot, epoch, enqueued, seat })
	})

/** The claim's members, each over pick bound with the claim's parameters of the same names. */
export const claimWorkPut = query(Queue).rule((r) => {
	const picked = pick.bind({
		kind: r.param("kind", QueueWork.fields.kind),
		slot: r.param("slot", Slot),
		now: r.param("now", Instant),
		from: r.param("from", Digest),
		resource: r.param("resource", Leased.fields.resource),
		fromSeat: r.param("fromSeat", SeatNo)
	})
	const p = v(picked)
	return r.match(picked, p).find({
		key: p.key,
		kind: p.kind,
		slot: p.slot,
		standing: r.literal("leased"),
		epoch: Compute.add(p.epoch, 1n),
		enqueued: p.enqueued
	})
})

export const claimWantedDelete = query(Queue).rule((r) => {
	const picked = pick.bind({
		kind: r.param("kind", QueueWork.fields.kind),
		slot: r.param("slot", Slot),
		now: r.param("now", Instant),
		from: r.param("from", Digest),
		resource: r.param("resource", Leased.fields.resource),
		fromSeat: r.param("fromSeat", SeatNo)
	})
	const { key } = v(picked)
	const { due, attempts } = v(Wanted)
	return r.match(picked, { key }).match(Wanted, { key, due, attempts }).find({ key, due, attempts })
})

export const claimLeasedPut = query(Queue).rule((r) => {
	const picked = pick.bind({
		kind: r.param("kind", QueueWork.fields.kind),
		slot: r.param("slot", Slot),
		now: r.param("now", Instant),
		from: r.param("from", Digest),
		resource: r.param("resource", Leased.fields.resource),
		fromSeat: r.param("fromSeat", SeatNo)
	})
	const { key, epoch, seat } = v(picked)
	return r.match(picked, { key, epoch, seat }).find({
		key,
		resource: r.param("resource", Leased.fields.resource),
		seat,
		epoch: Compute.add(epoch, 1n),
		/**
		 * Compute.cast(Compute.add(r.param("now", Instant), r.param("lease", pg.bigint)), Instant) would be refused by
		 * the builder: a Compute operation takes a term first and a parameter takes the type it meets, so two
		 * parameters make no term. The host computes the expiry and passes it as one Instant.
		 */
		expires: r.param("expires", Leased.fields.expires)
	})
})

/** The settlement's members, parameters { key, epoch, outcome }: each described from the live lease. */
export const settleLeasedDelete = query(Queue).rule((r) => {
	const { key, resource, seat, epoch, expires } = v(Leased)
	return r
		.match(Leased, { key, resource, seat, epoch, expires })
		.where(r.eq(key, r.param("key", Digest)), r.eq(epoch, r.param("epoch", pg.bigint)))
		.find({ key, resource, seat, epoch, expires })
})

export const settleDoneInsert = query(Queue).rule((r) => {
	const { key, resource, seat, epoch, expires } = v(Leased)
	return r
		.match(Leased, { key, resource, seat, epoch, expires })
		.where(r.eq(key, r.param("key", Digest)), r.eq(epoch, r.param("epoch", pg.bigint)))
		.find({ key, outcome: r.param("outcome", Done.fields.outcome) })
})

export const settleWorkPut = query(Queue).rule((r) => {
	const { key, resource, seat, epoch, expires } = v(Leased)
	const { kind, slot, enqueued } = v(QueueWork)
	return r
		.match(Leased, { key, resource, seat, epoch, expires })
		.match(QueueWork, { key, kind, slot, epoch, enqueued })
		.where(r.eq(key, r.param("key", Digest)), r.eq(epoch, r.param("epoch", pg.bigint)))
		.find({ key, kind, slot, standing: r.literal("done"), epoch, enqueued })
})
