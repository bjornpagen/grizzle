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
import type { SchemaDesc } from "#compiler/ir/desc.ts"

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

const Standing = closed("Standing", ["wanted", "leased", "done", "denied"])
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
const Denied = relation("Denied", { key: Digest, reason: f.closedId("Reason") }, ["key"])
const Seat = relation("Seat", { resource: f.closedId("Resource"), seat: SeatNo }, [
	"resource",
	"seat"
])

export const Queue: SchemaDesc = decodedSchema({
	name: "Queue",
	relations: [Standing, Kind, Resource, Outcome, Reason, Work, Wanted, Leased, Done, Denied, Seat],
	statements: [
		mutable("Work"),
		alternatives(Work, "standing", Standing, {
			wanted: Wanted,
			leased: Leased,
			done: Done,
			denied: Denied
		}),
		key(on("Leased", ["resource", "seat"])),
		contained(on("Leased", ["resource", "seat"]), on("Seat", ["resource", "seat"]))
	],
	extends: undefined
})
