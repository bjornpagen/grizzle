import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Layer, Option } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, span, uuid } from "#compiler/public/fields.ts"
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
import { installed } from "#test/pg/reads/support.ts"
import { assert, containsEqual, unorderedEqual } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { installationGroup, replaceRows } from "#test/support/substrate/replace.ts"
import { type StateRow, tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import type { FullWorld } from "#test/support/worlds.ts"

/** Inserts and puts into span primary keys through served ChangeSets, as a property against a host interval model.
 *
 * The insert names the span key as its DO NOTHING arbiter and a later statement classifies each requested fact it did
 * not insert: an equal stored fact is an exact repeat, a stored fact overlapping it at its scalar key the span key law
 * with the requested key as the witness, and another requested fact overlapping it the same law within the ChangeSet,
 * which takes precedence, whatever the member's form. Room is immutable, the pinned default, and
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
 * The oracle is a second implementation, the host interval model above. Plant:
 * ~/.cache/grizzle-release/BR08/plants/span-key-requested-overlap-unseen.patch, the insert's verdicts blind to another
 * requested fact's overlap, must turn the property red.
 */
const note = str.regex("^[a-z]{1,8}$")
const Room = relation("Room", { room: uuid, during: span(pg.bigint), guest: uuid }, [
	"room",
	"during"
])
const Hold = relation("Hold", { room: uuid, during: span(pg.bigint), note }, ["room", "during"])
const Spans = schema("SpanKeys", { Room, Hold }, [mutable(Hold)])

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

const rooms = [
	"00000000-0000-4000-8000-000000000001",
	"00000000-0000-4000-8000-000000000002"
] as const

const guests = [
	"00000000-0000-4000-8000-000000000003",
	"00000000-0000-4000-8000-000000000004"
] as const
const notes = ["old", "new"] as const

/** A fact of either relation as the model holds it: its room, its span and which of the two payloads it carries. */
interface Fact {
	readonly room: 0 | 1
	readonly start: bigint
	readonly end: bigint
	readonly payload: 0 | 1
}

const sameKey = (a: Fact, b: Fact): boolean =>
	a.room === b.room && a.start === b.start && a.end === b.end
const same = (a: Fact, b: Fact): boolean => sameKey(a, b) && a.payload === b.payload
/** Two facts at one scalar key whose spans share a point: [a, b) and [c, d) overlap when a < d and c < b. */
const overlap = (a: Fact, b: Fact): boolean =>
	a.room === b.room && a.start < b.end && b.start < a.end

const unique = (facts: ReadonlyArray<Fact>): ReadonlyArray<Fact> =>
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
 * one before it (adjacent at a gap of none) and spanning a drawn length, so no two facts of a room overlap.
 */
const storedGen: Gen<ReadonlyArray<Fact>> = (source) =>
	Arr.flatMap([0, 1] as const, (room) => {
		let end = 0n
		return upTo(source.draw(int(0, 2)), (): Fact => {
			const start = end + BigInt(source.draw(int(0, 4)))
			end = start + BigInt(source.draw(int(1, 4)))
			return { room, start, end, payload: source.draw(element<0 | 1>([0, 1])) }
		})
	})

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

const freshFact = (s: FactSketch): Fact => ({
	room: s.room,
	start: BigInt(s.start),
	end: BigInt(s.start + s.length),
	payload: s.payload
})

/** A requested fact: fresh, or planted from a stored fact the pick selects. */
const requestedOf = (stored: ReadonlyArray<Fact>, s: FactSketch): Fact => {
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

const expected = (
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

type SpanFeature =
	| `${Op} ${Relation}`
	| `${Op} ${Form}`
	| `${Op} ${"accepted" | "unchanged" | "within the ChangeSet" | "over a stored fact"}`
	| "insert of an adjacent span accepted"
	| "put replaces a stored payload"
	| "put over a stored overlap at another key"

const situations: Arr.NonEmptyReadonlyArray<SpanFeature> = [
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
const applyCase = (
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
				? answered(
						db.workload.insertRoom.once({ params: {}, facts: { insert: { Room: roomFacts } } })
					)
				: answered(db.workload.putRoom.once({ params: {}, facts: { put: { Room: roomFacts } } }))
		}
		return c.op === "insert"
			? answered(db.workload.insertRoomItems.once({ params: { items: roomFacts }, facts: {} }))
			: answered(db.workload.putRoomItems.once({ params: { items: roomFacts }, facts: {} }))
	}
	if (c.form === "enumerated") {
		return c.op === "insert"
			? answered(
					db.workload.insertHold.once({ params: {}, facts: { insert: { Hold: holdFacts } } })
				)
			: answered(db.workload.putHold.once({ params: {}, facts: { put: { Hold: holdFacts } } }))
	}
	return c.op === "insert"
		? answered(db.workload.insertHoldItems.once({ params: { items: holdFacts }, facts: {} }))
		: answered(db.workload.putHoldItems.once({ params: { items: holdFacts }, facts: {} }))
}

layer(Substrate.layer, { excludeTestServices: true })(
	"inserts and puts into a span primary key",
	(it) => {
		it.effect(
			"agree with the interval model on drawn states and ChangeSets, both mutabilities and member forms",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(Spans, {}, { label: "real", extensions: [], programs })
						const s = yield* Substrate
						const names = namesOf(o.installed)
						const keyOf = (f: Fact): Readonly<Record<string, KeyHost>> => ({
							room: rooms[f.room],
							during: { start: f.start, end: f.end }
						})
						const rowOf = (relation: Relation, f: Fact): StateRow =>
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
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							return yield* explore(
								{
									oracle: {
										kind: "second-implementation",
										name: "a host interval model of the span key over the stored and requested facts"
									},
									suite: "write/span-key",
									draw: drawn(spanCaseGen),
									literal: Formatter.format,
									coverage: required<SpanFeature>(situations, { cases: 80, sense: notesOnly }),
									kept: [],
									runs: 80,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 16,
									caseHang
								},
								(c, cx) =>
									Effect.gen(function* () {
										const R = c.relation === "Room" ? Room : Hold
										const table = names.table(R)
										const stored = c.stored
										const requested = unique(Arr.map(c.requested, (r) => requestedOf(stored, r)))
										const payload =
											c.relation === "Room"
												? names.column(Room, "guest")
												: names.column(Hold, "note")
										yield* replaceRows(
											s.admin,
											installationGroup(names),
											Arr.map(stored, (f) => ({
												sql: `INSERT INTO ${table} (${names.column(R, "room")}, ${names.column(R, "during")}, ${payload}) VALUES ($1::uuid, pg_catalog.int8range($2::int8, $3::int8), $4::text::${c.relation === "Room" ? "uuid" : "text"})`,
												params: [
													rooms[f.room],
													String(f.start),
													String(f.end),
													c.relation === "Room" ? guests[f.payload] : notes[f.payload]
												]
											}))
										)
										const outcome = yield* applyCase(db, c, requested)
										const want = expected(c.op, stored, requested)
										const state = yield* tableState(o.installed, R)
										cx.note(`${c.op} ${c.relation}`)
										cx.note(`${c.op} ${c.form}`)
										if (want.kind === "refused") {
											if (outcome.kind !== "refused") {
												return assert.fail(`a refusal by the span key, not ${outcome.kind}`)
											}
											assert.deepEqual(refusedLaws(outcome.refused), [
												names.described(names.primaryKeyLaw(R))
											])
											const witness = outcome.witness
											if (witness.kind !== "key") {
												return assert.fail(`a witness key, not ${witness.kind}`)
											}
											assert.equal(witness.relation, c.relation)
											containsEqual(Arr.map(want.witnesses, keyOf), witness.values)
											unorderedEqual(
												state,
												Arr.map(stored, (f) => rowOf(c.relation, f))
											)
											cx.note(
												`${c.op} ${want.within ? "within the ChangeSet" : "over a stored fact"}`
											)
											if (c.op === "put" && !want.within) {
												cx.note("put over a stored overlap at another key")
											}
											return
										}
										unorderedEqual(
											state,
											Arr.map(want.final, (f) => rowOf(c.relation, f))
										)
										if (want.changed === 0) {
											assert.equal(outcome.kind, "unchanged")
											cx.note(`${c.op} unchanged`)
											return
										}
										if (outcome.kind !== "accepted") {
											return assert.fail(`accepted, not ${outcome.kind}`)
										}
										assert.deepEqual(
											Arr.map(outcome.counts, (n) => ({ ...n })),
											[
												{
													relation: c.relation,
													added: c.op === "insert" ? BigInt(want.changed) : 0n,
													deleted: 0n,
													put: c.op === "put" ? BigInt(want.changed) : 0n
												}
											]
										)
										cx.note(`${c.op} accepted`)
										if (
											c.op === "insert" &&
											Arr.some(requested, (f) =>
												Arr.some(
													stored,
													(g) => f.room === g.room && (f.start === g.end || f.end === g.start)
												)
											)
										) {
											cx.note("insert of an adjacent span accepted")
										}
										if (
											c.op === "put" &&
											Arr.some(requested, (f) =>
												Arr.some(stored, (g) => sameKey(f, g) && !same(f, g))
											)
										) {
											cx.note("put replaces a stored payload")
										}
									})
							)
						}).pipe(
							(body) =>
								Effect.flatMap(Layer.build(o.served.layer), (context) =>
									Effect.provideContext(body, context)
								),
							Effect.scoped
						)
					}).pipe(Effect.scoped)
				)
		)
	}
)
