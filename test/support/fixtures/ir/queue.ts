/**
 * The work queue as facts, in IR form: the Queue schema as a SchemaDesc, and the claim's and the settlement's
 * queries as checked relational IR.
 *
 * The queue example gives minimal definitions of the closed relations Kind, Resource, Outcome and Reason and the
 * contracts Digest, Slot, SeatNo and Instant, which the fixture uses:
 *
 *   const Kind = closed("Kind", ["render", "transcode"])
 *   const Resource = closed("Resource", ["gpu", "cpu"])
 *   const Outcome = closed("Outcome", ["succeeded", "failed"])
 *   const Reason = closed("Reason", ["malformed", "unsupported"])
 *   const Digest = contract("Digest", str.regex("^[0-9a-f]{64}$"))     // a lowercase SHA-256 hex digest
 *   const Slot = contract("Slot", pg.integer, (v) => v.ge(0))
 *   const SeatNo = contract("SeatNo", pg.integer, (v) => v.ge(0))
 *   const Instant = contract("Instant", pg.bigint)                      // epoch microseconds; brand only
 *
 * Digest keys are bounded ASCII text, so they are representable B-tree keys and spread uniformly; Instant is the
 * brand-only contract of the calendar pattern, as in the payroll ledger.
 *
 * The queue example states the claimable, freeSeat and pick rules only in prose. The IR below writes them out as that
 * prose says: each standing split at the holder's start key `from` with a literal `wrap` that orders the keys at or
 * after `from` first, the arms carrying the discriminant `standing` and their arm's fields, and pick consuming the
 * bounded union inside the statement through its common fields.
 */
import { SourceLoc } from "#compiler/core/loc.ts"
import type { SchemaDesc } from "#compiler/ir/desc.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import {
	type BuiltQuery,
	Ir,
	keyed,
	type OccurrenceSpec,
	order,
	plainRegion,
	SchemaModel
} from "#test/support/fixtures/ir/build.ts"

import {
	alternatives,
	closed,
	contained,
	decodedSchema,
	f,
	ge,
	key,
	literal,
	mutable,
	on,
	relation,
	value
} from "#test/support/fixtures/ir/desc.ts"

const Digest = f.contract("Digest", f.regex("^[0-9a-f]{64}$", "u"), undefined)
const Slot = f.contract("Slot", f.integer, ge(value, literal(0)))
const SeatNo = f.contract("SeatNo", f.integer, ge(value, literal(0)))
const Instant = f.contract("Instant", f.bigint, undefined)

const Standing = closed("Standing", ["wanted", "leased", "done", "refused"])
const Kind = closed("Kind", ["render", "transcode"])
const Resource = closed("Resource", ["gpu", "cpu"])
const Outcome = closed("Outcome", ["succeeded", "failed"])
const Reason = closed("Reason", ["malformed", "unsupported"])

const Work = relation(
	"Work",
	{
		key: Digest,
		kind: f.closedId("Kind"),
		slot: Slot,
		standing: f.closedId("Standing"),
		epoch: f.bigint,
		enqueued: Instant
	},
	["key"]
)
const Wanted = relation("Wanted", { key: Digest, due: Instant, attempts: f.integer }, ["key"])
const Leased = relation(
	"Leased",
	{
		key: Digest,
		resource: f.closedId("Resource"),
		seat: SeatNo,
		epoch: f.bigint,
		expires: Instant
	},
	["key"]
)
const Done = relation("Done", { key: Digest, outcome: f.closedId("Outcome") }, ["key"])
const Refused = relation("Refused", { key: Digest, reason: f.closedId("Reason") }, ["key"])
const Seat = relation("Seat", { resource: f.closedId("Resource"), seat: SeatNo }, [
	"resource",
	"seat"
])

export const Queue: SchemaDesc = decodedSchema({
	name: "Queue",
	relations: [Standing, Kind, Resource, Outcome, Reason, Work, Wanted, Leased, Done, Refused, Seat],
	statements: [
		mutable("Work"),
		alternatives(Work, "standing", Standing, {
			wanted: Wanted,
			leased: Leased,
			done: Done,
			refused: Refused
		}),
		key(on("Leased", ["resource", "seat"])),
		contained(on("Leased", ["resource", "seat"]), on("Seat", ["resource", "seat"]))
	],
	extends: undefined
})

/** The fixture schema owned, its law model compiled and its catalog built, with this module. */
const queueFixture = ownedFixture(Queue)

const queueModel = (): SchemaModel => new SchemaModel(queueFixture, {})

const int4 = (q: Ir) => q.model.fieldType(f.integer, SourceLoc("wrap", []))

/** The four arms of claimable: one standing, its arm relation's payload, and one side of `from`. */
const claimableArm = (q: Ir, standing: "wanted" | "leased", wrap: 0 | 1): RelNode => {
	const work = q.base("Work")
	const workOccurrence = {
		source: work,
		bind: { key: "key", kind: "kind", slot: "slot", epoch: "epoch", enqueued: "enqueued" },
		constants: { standing: q.litFor(work, "standing", standing) }
	}
	const arm =
		standing === "wanted"
			? {
					source: q.base("Wanted"),
					bind: { key: "key", due: "due", attempts: "attempts" },
					constants: {}
				}
			: (() => {
					const leased = q.base("Leased")
					return {
						source: leased,
						bind: { key: "key", seat: "seat", expires: "expires" },
						constants: {
							resource: q.param("resource", q.column(leased, "resource").type, "compare")
						}
					}
				})()
	const m = q.region([workOccurrence, arm], conservativeMeta)
	const keyType = q.column(m, "key").type
	const instant = q.column(m, standing === "wanted" ? "due" : "expires").type
	const time =
		standing === "wanted"
			? q.op("le", [q.col(m, "due"), q.param("now", instant, "compare")])
			: q.op("lt", [q.col(m, "expires"), q.param("now", instant, "compare")])
	const pred = q.op("and", [
		q.eq(q.col(m, "kind"), q.param("kind", q.column(m, "kind").type, "compare")),
		q.eq(q.col(m, "slot"), q.param("slot", q.column(m, "slot").type, "compare")),
		time,
		q.op(wrap === 0 ? "ge" : "lt", [q.col(m, "key"), q.param("from", keyType, "compare")])
	])
	const filtered = q.filter(m, pred)
	return q.project(
		filtered,
		[
			["key", "key"],
			["kind", "kind"],
			["slot", "slot"],
			["standing", q.lit(standing, q.model.type("Work", "standing"))],
			["epoch", "epoch"],
			["enqueued", "enqueued"],
			["wrap", q.lit(wrap, int4(q))] as const,
			...(standing === "wanted"
				? ([
						["due", "due"],
						["attempts", "attempts"]
					] as const)
				: ([
						["seat", "seat"],
						["expires", "expires"]
					] as const))
		],
		keyed([["key"]], "many")
	)
}

/**
 * Wanted and due, or leased on this resource and expired, the order starting at `from` and wrapping
 * around; take(1) closes the completed order into a set.
 */
const claimableTake = (q: Ir): RelNode => {
	const union = q.union(
		[
			claimableArm(q, "wanted", 0),
			claimableArm(q, "wanted", 1),
			claimableArm(q, "leased", 0),
			claimableArm(q, "leased", 1)
		],
		["standing"],
		keyed([["key"]], "many")
	)
	return q.take(
		union,
		order(["wrap", "asc"], ["key", "asc"]),
		{ kind: "literal", k: 1n },
		keyed([["key"]], "many")
	)
}

/** claimable delivered to the host: one statement per heading group, k per group, merged by the runtime. */
const claimable = (): BuiltQuery => {
	const q = new Ir(queueModel())
	return q.build(claimableTake(q))
}

/** A free seat of the resource from `fromSeat`, wrapping around. */
const freeSeatArm = (q: Ir, wrap: 0 | 1): RelNode => {
	const seats = q.region(
		[{ source: q.base("Seat"), bind: { resource: "resource", seat: "seat" }, constants: {} }],
		conservativeMeta
	)
	const seatType = q.column(seats, "seat").type
	const own = q.filter(
		seats,
		q.op("and", [
			q.eq(
				q.col(seats, "resource"),
				q.param("resource", q.column(seats, "resource").type, "compare")
			),
			q.op(wrap === 0 ? "ge" : "lt", [
				q.col(seats, "seat"),
				q.param("fromSeat", seatType, "compare")
			])
		])
	)
	const held = q.project(
		q.region(
			[{ source: q.base("Leased"), bind: { resource: "resource", seat: "seat" }, constants: {} }],
			conservativeMeta
		),
		[
			["resource", "resource"],
			["seat", "seat"]
		],
		conservativeMeta
	)
	const free = q.anti(own, held, [
		["resource", "resource"],
		["seat", "seat"]
	])
	return q.project(
		free,
		[
			["seat", "seat"],
			["wrap", q.lit(wrap, int4(q))]
		],
		keyed([["seat"]], "many")
	)
}

const freeSeatTake = (q: Ir): RelNode =>
	q.take(
		q.union([freeSeatArm(q, 0), freeSeatArm(q, 1)], [], keyed([["seat"]], "many")),
		order(["wrap", "asc"], ["seat", "asc"]),
		{ kind: "literal", k: 1n },
		keyed([["seat"]], "many")
	)

const freeSeat = (): BuiltQuery => {
	const q = new Ir(queueModel())
	return q.build(freeSeatTake(q))
}

/**
 * Wanted work takes the free seat; an expired lease keeps its own seat. Head: { key, kind, slot,
 * epoch, enqueued, seat }.
 */
const pickNode = (q: Ir): RelNode => {
	const claim = claimableTake(q)
	const wanted = q.regionWith(
		[
			{
				source: claim,
				bind: { key: "key", kind: "kind", slot: "slot", epoch: "epoch", enqueued: "enqueued" },
				constants: { standing: q.litFor(claim, "standing", "wanted") }
			},
			{ source: freeSeatTake(q), bind: { seat: "seat" }, constants: {} }
		],
		conservativeMeta,
		{
			...plainRegion,
			heading: { kind: "named", names: ["key", "kind", "slot", "epoch", "enqueued", "seat"] }
		}
	)
	const reclaimed = q.regionWith(
		[
			{
				source: claim,
				bind: { key: "key", kind: "kind", slot: "slot", epoch: "epoch", enqueued: "enqueued" },
				constants: { standing: q.litFor(claim, "standing", "leased") }
			},
			{ source: q.base("Leased"), bind: { key: "key", seat: "seat" }, constants: {} }
		],
		conservativeMeta,
		{
			...plainRegion,
			heading: { kind: "named", names: ["key", "kind", "slot", "epoch", "enqueued", "seat"] }
		}
	)
	return q.union([wanted, reclaimed], [], keyed([["key"]], "many"))
}

const pick = (): BuiltQuery => {
	const q = new Ir(queueModel())
	return q.build(pickNode(q))
}

/** The claim's members: each a query over pick, evaluated once in the claim's one stratum. */
const epochPlusOne = (q: Ir, m: RelNode): ScalarExpr =>
	q.op("add", [q.col(m, "epoch"), q.lit(1n, q.column(m, "epoch").type)])

const claimWorkPut = (): BuiltQuery => {
	const q = new Ir(queueModel())
	const p = q.region(
		[
			{
				source: pickNode(q),
				bind: {
					key: "key",
					kind: "kind",
					slot: "slot",
					epoch: "epoch",
					enqueued: "enqueued",
					seat: "seat"
				},
				constants: {}
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			p,
			[
				["key", "key"],
				["kind", "kind"],
				["slot", "slot"],
				["standing", q.lit("leased", q.model.type("Work", "standing"))],
				["epoch", epochPlusOne(q, p)],
				["enqueued", "enqueued"]
			],
			conservativeMeta
		)
	)
}

const claimWantedDelete = (): BuiltQuery => {
	const q = new Ir(queueModel())
	const m = q.region(
		[
			{ source: pickNode(q), bind: { key: "key" }, constants: {} },
			{
				source: q.base("Wanted"),
				bind: { key: "key", due: "due", attempts: "attempts" },
				constants: {}
			}
		],
		conservativeMeta
	)
	return q.build(
		q.project(
			m,
			[
				["key", "key"],
				["due", "due"],
				["attempts", "attempts"]
			],
			conservativeMeta
		)
	)
}

const claimLeasedPut = (): BuiltQuery => {
	const q = new Ir(queueModel())
	const p = q.region(
		[{ source: pickNode(q), bind: { key: "key", epoch: "epoch", seat: "seat" }, constants: {} }],
		conservativeMeta
	)
	/**
	 * expires is the host's now + lease, one Instant parameter: a Compute operation takes a term first, so the sum of
	 * two parameters has no public-API form.
	 */
	const expires = q.param("expires", q.model.type("Leased", "expires"), "emit")
	return q.build(
		q.project(
			p,
			[
				["key", "key"],
				["resource", q.param("resource", q.model.type("Leased", "resource"), "emit")],
				["seat", "seat"],
				["epoch", epochPlusOne(q, p)],
				["expires", expires]
			],
			conservativeMeta
		)
	)
}

/**
 * The settlement's members, parameters { key, epoch, outcome }: every member is described from
 * match(Leased, { key: r.param("key", Digest), epoch: r.param("epoch", pg.bigint) }), so a stale epoch makes every member empty. The key
 * is a refined text, so its parameter is compared through a filter, never as an occurrence constant.
 */
const liveLease = (q: Ir, occurrences: ReadonlyArray<OccurrenceSpec>): RelNode => {
	const leased = q.base("Leased")
	const m = q.region(
		[
			{
				source: leased,
				bind: {
					key: "key",
					resource: "resource",
					seat: "seat",
					epoch: "epoch",
					expires: "expires"
				},
				constants: {}
			},
			...occurrences
		],
		conservativeMeta
	)
	return q.filter(
		m,
		q.op("and", [
			q.eq(q.col(m, "key"), q.param("key", q.column(m, "key").type, "compare")),
			q.eq(q.col(m, "epoch"), q.param("epoch", q.column(m, "epoch").type, "compare"))
		])
	)
}

/** delete(Leased, ...): the lease itself, which frees its seat. */
const settleLeasedDelete = (): BuiltQuery => {
	const q = new Ir(queueModel())
	const m = liveLease(q, [])
	return q.build(
		q.project(
			m,
			[
				["key", "key"],
				["resource", "resource"],
				["seat", "seat"],
				["epoch", "epoch"],
				["expires", "expires"]
			],
			conservativeMeta
		)
	)
}

/** insert(Done, ...): the item's outcome. */
const settleDoneInsert = (): BuiltQuery => {
	const q = new Ir(queueModel())
	const m = liveLease(q, [])
	return q.build(
		q.project(
			m,
			[
				["key", "key"],
				["outcome", q.param("outcome", q.model.type("Done", "outcome"), "emit")]
			],
			conservativeMeta
		)
	)
}

/** put(Work, ...): the item with standing done, its other fields as stored, at the lease's epoch. */
const settleWorkPut = (): BuiltQuery => {
	const q = new Ir(queueModel())
	const m = liveLease(q, [
		{
			source: q.base("Work"),
			bind: { key: "key", kind: "kind", slot: "slot", epoch: "epoch", enqueued: "enqueued" },
			constants: {}
		}
	])
	return q.build(
		q.project(
			m,
			[
				["key", "key"],
				["kind", "kind"],
				["slot", "slot"],
				["standing", q.lit("done", q.model.type("Work", "standing"))],
				["epoch", "epoch"],
				["enqueued", "enqueued"]
			],
			conservativeMeta
		)
	)
}

/** The queue's queries as checked relational IR, by the name of the program each one states. */
export const queueQueries = {
	claimable,
	freeSeat,
	pick,
	claimWorkPut,
	claimWantedDelete,
	claimLeasedPut,
	settleLeasedDelete,
	settleDoneInsert,
	settleWorkPut
} as const satisfies Readonly<Record<string, () => BuiltQuery>>
