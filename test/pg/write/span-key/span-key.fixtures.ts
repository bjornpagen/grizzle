/** What the properties of span-key.test.ts read: its spaces, models and helpers. */

import { type Aimed, aimed, array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, span } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	mutable,
	relation,
	type Schema,
	schema,
	type StatementsByName
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { KeyHost } from "#compiler/types/changeset/changeset.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { Id } from "#test/support/ids.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import type { StateRow } from "#test/support/substrate/state.ts"
import { upTo } from "#test/support/up-to.ts"
import type { FullWorld } from "#test/support/worlds.ts"

/** Inserts and puts into span primary keys through served ChangeSets, as a property against a host interval model.
 *
 * The role writes SERIALIZABLE, where the insert arbitrates every object, the span key among them, and classifies each
 * requested fact it met (write/insert/protocol.ts Arbitration `every`; at READ COMMITTED an insert into a span primary
 * key has no form, NoReadCommittedForm): an equal stored fact is an exact repeat, a stored fact overlapping it at its
 * scalar key the span key law with the requested key as the witness, and another requested fact overlapping it the same
 * law within the ChangeSet, which takes precedence, whatever the member's form. Room is immutable, the pinned default, and
 * Hold its mutable twin, whose enumerated put is the DELETE-then-insert pair because no ON CONFLICT DO UPDATE accepts
 * an exclusion constraint. A put displaces only the facts at its own keys, so a stored fact overlapping it at another
 * key is the span key law at once, never a TransientFailure.
 *
 * Each case draws a lawful stored state of one relation (spans [start, end) over 0..12 in two rooms), a ChangeSet of
 * one to three requested facts (fresh, an exact repeat of a stored fact, a stored key with the other payload, the span
 * adjacent to a stored one, or one overlapping a stored one at another key: the last four planted from the state, since
 * fresh spans rarely meet it exactly), inserted or put, enumerated or described over a relation parameter. The model
 * gives the outcome: a requested fact no equal stored fact accounts for that overlaps another requested fact refuses
 * with the relation's key law and one such fact's key as the witness; failing that, one overlapping a stored fact the
 * member does not displace refuses the same way; otherwise the final state is the stored one with the displaced facts
 * gone and the requested ones in, accepted with the requested facts not already stored counted as added (insert) or put
 * (put), or unchanged when there are none. A refusal leaves the stored state as it was.
 *
 * The oracle is a second implementation, the host interval model above.
 */
const note = str.regex("^[a-z]{1,8}$")

export const Room = relation("Room", { room: Id, during: span(pg.bigint), guest: Id }, [
	"room",
	"during"
])

export const Hold = relation("Hold", { room: Id, during: span(pg.bigint), note }, [
	"room",
	"during"
])

export const Spans = schema("SpanKeys", [Room, Hold], [mutable(Hold)])

/**
 * The full world's workload: an insert and a put of each relation, enumerated from each call's facts, and described
 * over the relation parameter `items`, which nobody normalized on the host.
 */
const programs = Object.freeze({
	insertRoom: ChangeSet.empty(Spans).insert(Room, []),
	putRoom: ChangeSet.empty(Spans).put(Room, []),
	insertRoomItems: ChangeSet.empty(Spans).insert(
		Room,
		query(Spans).rule((r) => {
			const x = v(Room, "room")
			const all = { room: x.room, during: x.during, guest: x.guest }
			return r.match(r.relation("items", Room), all).find(all)
		})
	),
	putRoomItems: ChangeSet.empty(Spans).put(
		Room,
		query(Spans).rule((r) => {
			const x = v(Room, "room")
			const all = { room: x.room, during: x.during, guest: x.guest }
			return r.match(r.relation("items", Room), all).find(all)
		})
	),
	insertHold: ChangeSet.empty(Spans).insert(Hold, []),
	putHold: ChangeSet.empty(Spans).put(Hold, []),
	insertHoldItems: ChangeSet.empty(Spans).insert(
		Hold,
		query(Spans).rule((r) => {
			const x = v(Hold, "hold")
			const all = { room: x.room, during: x.during, note: x.note }
			return r.match(r.relation("items", Hold), all).find(all)
		})
	),
	putHoldItems: ChangeSet.empty(Spans).put(
		Hold,
		query(Spans).rule((r) => {
			const x = v(Hold, "hold")
			const all = { room: x.room, during: x.during, note: x.note }
			return r.match(r.relation("items", Hold), all).find(all)
		})
	)
})

type SpansInstalled = Schema<
	string,
	(typeof Spans)["relations"],
	StatementsByName<(typeof Spans)["statements"], (typeof Spans)["relations"]>
>

export const rooms = [
	Id("00000000-0000-4000-8000-000000000001"),
	Id("00000000-0000-4000-8000-000000000002")
] as const

export const guests = [
	Id("00000000-0000-4000-8000-000000000003"),
	Id("00000000-0000-4000-8000-000000000004")
] as const

export const notes = ["old", "new"] as const

/** A fact of either relation as the model holds it: its room, its span and which of the two payloads it carries. */
interface Fact {
	readonly room: 0 | 1
	readonly start: bigint
	readonly end: bigint
	readonly payload: 0 | 1
}

export const sameKey = (a: Fact, b: Fact): boolean =>
	a.room === b.room && a.start === b.start && a.end === b.end

export const same = (a: Fact, b: Fact): boolean => sameKey(a, b) && a.payload === b.payload

/** Two facts at one scalar key whose spans share a point: [a, b) and [c, d) overlap when a < d and c < b. */
const overlap = (a: Fact, b: Fact): boolean =>
	a.room === b.room && a.start < b.end && b.start < a.end

export const unique = (facts: ReadonlyArray<Fact>): ReadonlyArray<Fact> =>
	Arr.filter(facts, (f, i) =>
		Option.contains(
			Arr.findFirstIndex(facts, (g) => same(f, g)),
			i
		)
	)

type Relation = "Room" | "Hold"

type Op = "insert" | "put"

type Form = "enumerated" | "described"

type Mode = "fresh" | "repeat" | "other payload" | "adjacent" | "overlapping"

interface FactSketch {
	readonly mode: Mode
	readonly pick: number
	readonly room: 0 | 1
	readonly start: number
	readonly length: number
	readonly payload: 0 | 1
}

interface SpanCase {
	readonly relation: Relation
	readonly op: Op
	readonly form: Form
	readonly stored: ReadonlyArray<Fact>
	readonly requested: ReadonlyArray<FactSketch>
}

const factSketchGen =
	(modes: Arr.NonEmptyReadonlyArray<Mode>): Gen<FactSketch> =>
	(source) => ({
		mode: source.draw(element(modes)),
		pick: source.draw(pickGen),
		room: source.draw(element<0 | 1>([0, 1])),
		start: source.draw(int(0, 8)),
		length: source.draw(int(1, 4)),
		payload: source.draw(element<0 | 1>([0, 1]))
	})

/**
 * A lawful stored state by construction: in each room up to two facts, each starting a drawn gap past the end of the
 * one before it (adjacent at a gap of none) and spanning a drawn length, so no two facts of a room overlap; the first
 * room holding at least `least`.
 */
const storedOf =
	(least: 0 | 1): Gen<ReadonlyArray<Fact>> =>
	(source) =>
		Arr.flatMap([0, 1] as const, (room) => {
			let end = 0n
			return upTo(source.draw(int(room === 0 ? least : 0, 2)), (): Fact => {
				const start = end + BigInt(source.draw(int(0, 4)))
				end = start + BigInt(source.draw(int(1, 4)))
				return { room, start, end, payload: source.draw(element<0 | 1>([0, 1])) }
			})
		})

const storedGen: Gen<ReadonlyArray<Fact>> = storedOf(0)

const spanCaseGen: Gen<SpanCase> = (source) => ({
	relation: source.draw(element<Relation>(["Room", "Hold"])),
	op: source.draw(element<Op>(["insert", "put"])),
	form: source.draw(element<Form>(["enumerated", "described"])),
	stored: source.draw(storedGen),
	requested: source.draw(
		array(factSketchGen(["fresh", "repeat", "other payload", "adjacent", "overlapping"]), {
			min: 1,
			max: 3
		})
	)
})

/**
 * An insert every requested fact of which repeats a stored one, over a state of at least one fact: the model's
 * unchanged insert, which a drawn ChangeSet reaches only when every one of its one to three facts is planted a repeat.
 */
const unchangedInsertGen: Gen<SpanCase> = (source) => ({
	relation: source.draw(element<Relation>(["Room", "Hold"])),
	op: "insert",
	form: source.draw(element<Form>(["enumerated", "described"])),
	stored: source.draw(storedOf(1)),
	requested: source.draw(array(factSketchGen(["repeat"]), { min: 1, max: 3 }))
})

/** The cases, aimed at an unchanged insert while it is pending (`unchangedInsertGen`). */
export const spanCases: Aimed<SpanCase, SpanFeature> = aimed(spanCaseGen, [
	["insert unchanged", unchangedInsertGen]
])

const freshFact = (s: FactSketch): Fact => ({
	room: s.room,
	start: BigInt(s.start),
	end: BigInt(s.start + s.length),
	payload: s.payload
})

/** A requested fact: fresh, or planted from a stored fact the pick selects. */
export const requestedOf = (stored: ReadonlyArray<Fact>, s: FactSketch): Fact => {
	const [first, ...rest] = stored
	if (s.mode === "fresh" || first === undefined) {
		return freshFact(s)
	}
	const at = pickFrom([first, ...rest], s.pick)
	const length = BigInt(s.length)
	switch (s.mode) {
		case "repeat":
			return at
		case "other payload":
			return { ...at, payload: at.payload === 0 ? 1 : 0 }
		case "adjacent":
			return { ...at, start: at.end, end: at.end + length, payload: s.payload }
		case "overlapping":
			return { ...at, end: at.end + length, payload: s.payload }
	}
}

/** The model's outcome (see the header). */
type Expected =
	| { readonly kind: "refused"; readonly within: boolean; readonly witnesses: ReadonlyArray<Fact> }
	| { readonly kind: "applied"; readonly changed: number; readonly final: ReadonlyArray<Fact> }

export const expected = (
	op: Op,
	stored: ReadonlyArray<Fact>,
	requested: ReadonlyArray<Fact>
): Expected => {
	const displaced =
		op === "put" ? Arr.filter(stored, (s) => Arr.some(requested, (f) => sameKey(f, s))) : []
	const kept = Arr.filter(stored, (s) => !displaced.includes(s))
	const fresh = Arr.filter(requested, (f) => !Arr.some(stored, (s) => same(f, s)))
	/** An insert's exact repeat is accounted for by the stored fact; a put's may be displaced and inserted again. */
	const candidates = op === "insert" ? fresh : requested
	const within = Arr.filter(candidates, (f) =>
		Arr.some(requested, (g) => !same(f, g) && overlap(f, g))
	)
	if (within.length > 0) {
		return { kind: "refused", within: true, witnesses: within }
	}
	const across = Arr.filter(fresh, (f) => Arr.some(kept, (s) => !same(f, s) && overlap(f, s)))
	if (across.length > 0) {
		return { kind: "refused", within: false, witnesses: across }
	}
	return {
		kind: "applied",
		changed: fresh.length,
		final: [...kept, ...Arr.filter(requested, (f) => !Arr.some(kept, (s) => same(f, s)))]
	}
}

export type SpanFeature =
	| `${Op} ${Relation}`
	| `${Op} ${Form}`
	| `${Op} ${"accepted" | "unchanged" | "within the ChangeSet" | "over a stored fact"}`
	| "insert of an adjacent span accepted"
	| "put replaces a stored payload"
	| "put over a stored overlap at another key"

export const situations: Arr.NonEmptyReadonlyArray<SpanFeature> = [
	"insert Room",
	"insert Hold",
	"put Room",
	"put Hold",
	"insert enumerated",
	"insert described",
	"put enumerated",
	"put described",
	"insert accepted",
	"insert unchanged",
	"insert within the ChangeSet",
	"insert over a stored fact",
	"put accepted",
	"put unchanged",
	"put within the ChangeSet",
	"put over a stored fact",
	"insert of an adjacent span accepted",
	"put replaces a stored payload",
	"put over a stored overlap at another key"
]

/** The case's write through its member of the full world's served workload, applied on `db`. */
export const applyCase = (
	db: Db<FullWorld<SpansInstalled>["app"], typeof programs>,
	c: SpanCase,
	requested: ReadonlyArray<Fact>
) => {
	const during = (f: Fact) => ({ start: f.start, end: f.end })
	const roomFacts = Arr.map(requested, (f) => ({
		room: rooms[f.room],
		during: during(f),
		guest: guests[f.payload]
	}))
	const holdFacts = Arr.map(requested, (f) => ({
		room: rooms[f.room],
		during: during(f),
		note: notes[f.payload]
	}))
	if (c.relation === "Room") {
		if (c.form === "enumerated") {
			return c.op === "insert"
				? writeAnswerOf(
						db.workload.insertRoom.once({ params: {}, facts: { insert: { Room: roomFacts } } })
					)
				: writeAnswerOf(
						db.workload.putRoom.once({ params: {}, facts: { put: { Room: roomFacts } } })
					)
		}
		return c.op === "insert"
			? writeAnswerOf(db.workload.insertRoomItems.once({ params: { items: roomFacts }, facts: {} }))
			: writeAnswerOf(db.workload.putRoomItems.once({ params: { items: roomFacts }, facts: {} }))
	}
	if (c.form === "enumerated") {
		return c.op === "insert"
			? writeAnswerOf(
					db.workload.insertHold.once({ params: {}, facts: { insert: { Hold: holdFacts } } })
				)
			: writeAnswerOf(db.workload.putHold.once({ params: {}, facts: { put: { Hold: holdFacts } } }))
	}
	return c.op === "insert"
		? writeAnswerOf(db.workload.insertHoldItems.once({ params: { items: holdFacts }, facts: {} }))
		: writeAnswerOf(db.workload.putHoldItems.once({ params: { items: holdFacts }, facts: {} }))
}

export const keyOf = (f: Fact): Readonly<Record<string, KeyHost>> => ({
	room: rooms[f.room],
	during: { start: f.start, end: f.end }
})

export const rowOf = (relation: Relation, f: Fact): StateRow =>
	relation === "Room"
		? {
				room: rooms[f.room],
				during: { start: f.start, end: f.end },
				guest: guests[f.payload]
			}
		: {
				room: rooms[f.room],
				during: { start: f.start, end: f.end },
				note: notes[f.payload]
			}

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const spansInstall = Object.freeze({ label: "real", programs })

/** Spans installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const spansTemplate = fixtureTemplate(import.meta, Spans, spansInstall)
