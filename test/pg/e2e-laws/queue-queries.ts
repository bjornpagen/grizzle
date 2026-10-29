import { Compute } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import type { Schema } from "#compiler/public/schema.ts"
import { Instant } from "#test/support/fixtures/api/contracts.ts"
import * as Q from "#test/support/fixtures/api/queue.ts"

/** Queue under the name of its installation, the schema the Db opens. */
export type QueueInstalled = Schema<
	string,
	(typeof Q.Queue)["relations"],
	(typeof Q.Queue)["statements"]
>

/**
 * The queue example's claim and settlement queries over an installed Queue.
 *
 * A ChangeSet's member queries must be written over a level of the ChangeSet's schema, and every pg test
 * installs the fixture under a fresh schema name, so the queries of test/support/fixtures/api/queue.ts,
 * written over `Queue` itself, are written here once more over the rebuilt schema value, rule for rule as that fixture
 * states them, each arm matching Work with its standing fixed, filtering kind, slot, its time and
 * its side of `from`, and carrying a literal `wrap`.
 */
export const queueQueries = (s: QueueInstalled) => {
	/** The claimable work. */
	const claimable = query(s)
		.rule((r) => {
			const { key, kind, slot, epoch, enqueued } = v(Q.QueueWork)
			const { due, attempts } = v(Q.Wanted)
			return r
				.match(Q.QueueWork, { key, kind, slot, standing: "wanted", epoch, enqueued })
				.match(Q.Wanted, { key, due, attempts })
				.where(
					r.eq(kind, r.param("kind", Q.QueueWork.fields.kind)),
					r.eq(slot, r.param("slot", Q.QueueWork.fields.slot)),
					r.le(due, r.param("now", Q.Wanted.fields.due)),
					r.ge(key, r.param("from", Q.QueueWork.fields.key))
				)
				.find({
					key,
					kind,
					slot,
					standing: Q.Standing.handle("wanted"),
					epoch,
					enqueued,
					wrap: r.literal(0),
					due,
					attempts
				})
		})
		.rule((r) => {
			const { key, kind, slot, epoch, enqueued } = v(Q.QueueWork)
			const { due, attempts } = v(Q.Wanted)
			return r
				.match(Q.QueueWork, { key, kind, slot, standing: "wanted", epoch, enqueued })
				.match(Q.Wanted, { key, due, attempts })
				.where(
					r.eq(kind, r.param("kind", Q.QueueWork.fields.kind)),
					r.eq(slot, r.param("slot", Q.QueueWork.fields.slot)),
					r.le(due, r.param("now", Q.Wanted.fields.due)),
					r.lt(key, r.param("from", Q.QueueWork.fields.key))
				)
				.find({
					key,
					kind,
					slot,
					standing: Q.Standing.handle("wanted"),
					epoch,
					enqueued,
					wrap: r.literal(1),
					due,
					attempts
				})
		})
		.rule((r) => {
			const { key, kind, slot, epoch, enqueued } = v(Q.QueueWork)
			const { seat, expires } = v(Q.Leased)
			return r
				.match(Q.QueueWork, { key, kind, slot, standing: "leased", epoch, enqueued })
				.match(Q.Leased, {
					key,
					resource: r.param("resource", Q.Seat.fields.resource),
					seat,
					expires
				})
				.where(
					r.eq(kind, r.param("kind", Q.QueueWork.fields.kind)),
					r.eq(slot, r.param("slot", Q.QueueWork.fields.slot)),
					r.lt(expires, r.param("now", Q.Leased.fields.expires)),
					r.ge(key, r.param("from", Q.QueueWork.fields.key))
				)
				.find({
					key,
					kind,
					slot,
					standing: Q.Standing.handle("leased"),
					epoch,
					enqueued,
					wrap: r.literal(0),
					seat,
					expires
				})
		})
		.rule((r) => {
			const { key, kind, slot, epoch, enqueued } = v(Q.QueueWork)
			const { seat, expires } = v(Q.Leased)
			return r
				.match(Q.QueueWork, { key, kind, slot, standing: "leased", epoch, enqueued })
				.match(Q.Leased, {
					key,
					resource: r.param("resource", Q.Seat.fields.resource),
					seat,
					expires
				})
				.where(
					r.eq(kind, r.param("kind", Q.QueueWork.fields.kind)),
					r.eq(slot, r.param("slot", Q.QueueWork.fields.slot)),
					r.lt(expires, r.param("now", Q.Leased.fields.expires)),
					r.lt(key, r.param("from", Q.QueueWork.fields.key))
				)
				.find({
					key,
					kind,
					slot,
					standing: Q.Standing.handle("leased"),
					epoch,
					enqueued,
					wrap: r.literal(1),
					seat,
					expires
				})
		})
		.orderBy(["wrap", "asc"], ["key", "asc"])
		.take(1)
	/** A free seat of a resource. */
	const freeSeat = query(s)
		.rule((r) => {
			const { resource, seat } = v(Q.Seat)
			return r
				.match(Q.Seat, { resource, seat })
				.where(
					r.eq(resource, r.param("resource", Q.Seat.fields.resource)),
					r.ge(seat, r.param("fromSeat", Q.Seat.fields.seat)),
					r.not(Q.Leased, { resource, seat })
				)
				.find({ seat, wrap: r.literal(0) })
		})
		.rule((r) => {
			const { resource, seat } = v(Q.Seat)
			return r
				.match(Q.Seat, { resource, seat })
				.where(
					r.eq(resource, r.param("resource", Q.Seat.fields.resource)),
					r.lt(seat, r.param("fromSeat", Q.Seat.fields.seat)),
					r.not(Q.Leased, { resource, seat })
				)
				.find({ seat, wrap: r.literal(1) })
		})
		.orderBy(["wrap", "asc"], ["seat", "asc"])
		.take(1)
	const pick = query(s)
		.rule((r) => {
			const items = claimable.bind({
				kind: r.param("kind", Q.QueueWork.fields.kind),
				slot: r.param("slot", Q.QueueWork.fields.slot),
				now: r.param("now", Instant),
				from: r.param("from", Q.QueueWork.fields.key),
				resource: r.param("resource", Q.Seat.fields.resource)
			})
			const seats = freeSeat.bind({
				resource: r.param("resource", Q.Seat.fields.resource),
				fromSeat: r.param("fromSeat", Q.Seat.fields.seat)
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
				kind: r.param("kind", Q.QueueWork.fields.kind),
				slot: r.param("slot", Q.QueueWork.fields.slot),
				now: r.param("now", Instant),
				from: r.param("from", Q.QueueWork.fields.key),
				resource: r.param("resource", Q.Seat.fields.resource)
			})
			const { key, kind, slot, epoch, enqueued } = v(items)
			const { seat } = v(Q.Leased)
			return r
				.match(items, { standing: "leased", key, kind, slot, epoch, enqueued })
				.match(Q.Leased, { key, seat })
				.find({ key, kind, slot, epoch, enqueued, seat })
		})
	return {
		claimWorkPut: query(s).rule((r) => {
			const picked = pick.bind({
				kind: r.param("kind", Q.QueueWork.fields.kind),
				slot: r.param("slot", Q.QueueWork.fields.slot),
				now: r.param("now", Instant),
				from: r.param("from", Q.QueueWork.fields.key),
				resource: r.param("resource", Q.Seat.fields.resource),
				fromSeat: r.param("fromSeat", Q.Seat.fields.seat)
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
		}),
		claimWantedDelete: query(s).rule((r) => {
			const picked = pick.bind({
				kind: r.param("kind", Q.QueueWork.fields.kind),
				slot: r.param("slot", Q.QueueWork.fields.slot),
				now: r.param("now", Instant),
				from: r.param("from", Q.QueueWork.fields.key),
				resource: r.param("resource", Q.Seat.fields.resource),
				fromSeat: r.param("fromSeat", Q.Seat.fields.seat)
			})
			const { key } = v(picked)
			const { due, attempts } = v(Q.Wanted)
			return r
				.match(picked, { key })
				.match(Q.Wanted, { key, due, attempts })
				.find({ key, due, attempts })
		}),
		claimLeasedPut: query(s).rule((r) => {
			const picked = pick.bind({
				kind: r.param("kind", Q.QueueWork.fields.kind),
				slot: r.param("slot", Q.QueueWork.fields.slot),
				now: r.param("now", Instant),
				from: r.param("from", Q.QueueWork.fields.key),
				resource: r.param("resource", Q.Seat.fields.resource),
				fromSeat: r.param("fromSeat", Q.Seat.fields.seat)
			})
			const { key, epoch, seat } = v(picked)
			return r.match(picked, { key, epoch, seat }).find({
				key,
				resource: r.param("resource", Q.Seat.fields.resource),
				seat,
				epoch: Compute.add(epoch, 1n),
				/** The host computes the expiry and passes it as one Instant (test/support/fixtures/api/queue.ts). */
				expires: r.param("expires", Q.Leased.fields.expires)
			})
		}),
		/** The settlement. */
		settleLeasedDelete: query(s).rule((r) => {
			const { key, resource, seat, epoch, expires } = v(Q.Leased)
			return r
				.match(Q.Leased, { key, resource, seat, epoch, expires })
				.where(
					r.eq(key, r.param("key", Q.Leased.fields.key)),
					r.eq(epoch, r.param("epoch", pg.bigint))
				)
				.find({ key, resource, seat, epoch, expires })
		}),
		settleDoneInsert: query(s).rule((r) => {
			const { key, resource, seat, epoch, expires } = v(Q.Leased)
			return r
				.match(Q.Leased, { key, resource, seat, epoch, expires })
				.where(
					r.eq(key, r.param("key", Q.Leased.fields.key)),
					r.eq(epoch, r.param("epoch", pg.bigint))
				)
				.find({ key, outcome: r.param("outcome", Q.Done.fields.outcome) })
		}),
		settleWorkPut: query(s).rule((r) => {
			const { key, resource, seat, epoch, expires } = v(Q.Leased)
			const { kind, slot, enqueued } = v(Q.QueueWork)
			return r
				.match(Q.Leased, { key, resource, seat, epoch, expires })
				.match(Q.QueueWork, { key, kind, slot, epoch, enqueued })
				.where(
					r.eq(key, r.param("key", Q.Leased.fields.key)),
					r.eq(epoch, r.param("epoch", pg.bigint))
				)
				.find({ key, kind, slot, standing: r.literal("done"), epoch, enqueued })
		})
	}
}
