/** What the properties of collisions.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import { element, type Gen, int, constant } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Order, Result } from "effect"
import type { CallError, WriteOutcome } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, login, on, relation, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import type { DeltaSource, Witness } from "#compiler/types/changeset/changeset.ts"
import type { WriteAnswer } from "#test/support/calls.ts"
import { rigTemplate } from "#test/support/schedules/rig.ts"

export const Sitting = relation(
	"Sitting",
	{
		child: int4,
		test: int4,
		attempt: int4,
		note: int4,
		slot: int4
	},
	["child", "test", "attempt"]
)

/** The relation a held call inserts last, which the owner's SHARE lock holds it at. */
export const Gate = relation("Gate", { n: int4 }, ["n"])

/** The fields a sitting's request states: every field. */
export const statedFields = ["child", "test", "attempt", "note", "slot"] as const

export const slotKey = key(on(Sitting, "slot"))

/** The schema, the role `learner`, which inserts Sitting and Gate and nothing else, and its two logins. A call of a
 * query member reads back the sittings it added and the stored sittings it met, every field of each. */
export const collisions = (name: string) => {
	const base = schema(name, [Sitting, Gate], [slotKey])
	const learner = role(base, "learner", { Sitting, Gate }, { insert: ["Sitting", "Gate"] })
	const direct = role(base, "direct", { Sitting, Gate })
	/** The sittings a call states as its relation parameter `sittings`, every field. */
	const given = query(base).rule((r) => {
		const rows = r.relation("sittings", {
			child: Sitting.fields.child,
			test: Sitting.fields.test,
			attempt: Sitting.fields.attempt,
			note: Sitting.fields.note,
			slot: Sitting.fields.slot
		})
		const { child, test, attempt, note, slot } = v(rows, "given")
		return r
			.match(rows, { child, test, attempt, note, slot })
			.find({ child, test, attempt, note, slot })
	})
	const sittingsOf = (side: DeltaSource<typeof Sitting>) =>
		query(base).rule((r) => {
			const { child, test, attempt, note, slot } = v(side, "sitting")
			return r
				.match(side, { child, test, attempt, note, slot })
				.find({ child, test, attempt, note, slot })
		})
	return {
		schema: base,
		learner,
		direct,
		server: login(base, "server", [learner], {
			workload: [
				workload(learner, {
					start: ChangeSet.empty(base).insert(Sitting, []),
					held: ChangeSet.sequence(
						ChangeSet.empty(base).insert(Sitting, []),
						ChangeSet.empty(base).insert(Gate, [])
					),
					startRead: ChangeSet.empty(base)
						.insert(Sitting, given)
						.read("added", (d) => sittingsOf(d.added(Sitting)))
						.read("met", (d) => sittingsOf(d.met(Sitting))),
					heldRead: ChangeSet.sequence(
						ChangeSet.empty(base).insert(Sitting, given),
						ChangeSet.empty(base).insert(Gate, [])
					)
						.read("added", (d) => sittingsOf(d.added(Sitting)))
						.read("met", (d) => sittingsOf(d.met(Sitting)))
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** One requested sitting: every field. */
export interface Request {
	readonly child: number
	readonly test: number
	readonly attempt: number
	readonly note: number
	readonly slot: number
}

type Mode = "concurrent" | "sequential"

/** How both calls state their sittings: an array of the call's facts, or a query member's relation parameter, read
 * back. */
export type Form = "array" | "query"

interface Collision {
	readonly mode: Mode
	readonly form: Form
	readonly stored: ReadonlyArray<Request>
	readonly a: ReadonlyArray<Request>
	readonly b: ReadonlyArray<Request>
}

export type CollisionFeature =
	| "an exact repeat of a row in flight, after waiting"
	| "a differing row at the arbiter key in flight, refused after waiting"
	| "a 23505 at slot after waiting, its stated slot the witness"
	| "a 23505 at slot after waiting, unreported among several slots"
	| "a 23505 at slot after waiting, unreported for a query's rows"
	| "an exact repeat of a visible row"
	| "a row in flight met, read back"
	| "a visible row met, read back"
	| "a differing row at a visible arbiter key"
	| "a visible occupant at slot, refused by the probe"
	| "an insert after waiting for a row in flight"
	| "an insert without waiting"

export const sameKey = (x: Request, y: Request): boolean =>
	x.child === y.child && x.test === y.test && x.attempt === y.attempt

const samePayload = (x: Request, y: Request): boolean => x.note === y.note && x.slot === y.slot

/** Requests by their key, as the table's state is read. */
export const byKey: Order.Order<Request> = Order.combine(
	Order.mapInput(Order.Number, (r: Request) => r.child),
	Order.combine(
		Order.mapInput(Order.Number, (r: Request) => r.test),
		Order.mapInput(Order.Number, (r: Request) => r.attempt)
	)
)

const requestGen: Gen<Request> = (source) => ({
	child: source.draw(int(1, 2)),
	test: 7,
	attempt: source.draw(int(1, 2)),
	note: source.draw(int(0, 1)),
	slot: source.draw(int(1, 3))
})

/** One to `most` requests of distinct keys and distinct slots: a call no host check refuses on its own. */
const callGen =
	(least: number, most: number): Gen<ReadonlyArray<Request>> =>
	(source) => {
		const count = source.draw(int(least, most))
		let rows: ReadonlyArray<Request> = []
		for (let i = 0; i < count; i++) {
			const row = source.draw(requestGen)
			if (!Arr.some(rows, (r) => sameKey(r, row) || r.slot === row.slot)) {
				rows = Arr.append(rows, row)
			}
		}
		return rows
	}

export const collisionGen: Gen<Collision> = (source) => ({
	mode: source.draw(element(["concurrent", "sequential"] as const)),
	form: source.draw(element(["array", "query"] as const)),
	stored: source.draw(callGen(0, 2)),
	a: source.draw(callGen(1, 2)),
	b: source.draw(callGen(1, 2))
})

/**
 * Cases constructed to reach the situations that depend on a call's form or on two of B's requests, their requests
 * drawn: B repeating the row A holds in flight, or the row A committed before it, through the query member, and the
 * first beside a request at another key and slot, which B inserts once it has waited; and B stating, at another key,
 * the slot A holds in flight, alone through an array or the query member, or beside a request at a third key and slot
 * through an array.
 */
const reachingIn =
	(mode: Mode, form: Form, b: (a: Request) => ReadonlyArray<Request>): Gen<Collision> =>
	(source) => {
		const a = source.draw(requestGen)
		return { mode, form, stored: [], a: [a], b: b(a) }
	}

/** A request at another key than `a`'s, stating `a`'s slot. */
const atSlotOf = (a: Request): Request => ({ ...a, child: 3 - a.child })

/** A request at a key and a slot neither `a` nor atSlotOf(a) holds. */
const besides = (a: Request): Request => ({
	...a,
	attempt: 3 - a.attempt,
	slot: (a.slot % 3) + 1
})

/** The situations reachingIn constructs, each with its case: a witness whose turn aims at a pending one draws that case
 * (aimed), the case it runs, prints and keeps. */
export const aims: ReadonlyArray<readonly [CollisionFeature, Gen<Collision>]> = [
	["a row in flight met, read back", reachingIn("concurrent", "query", (a) => [a])],
	["a visible row met, read back", reachingIn("sequential", "query", (a) => [a])],
	[
		"an insert after waiting for a row in flight",
		reachingIn("concurrent", "query", (a) => [a, besides(a)])
	],
	[
		"a 23505 at slot after waiting, unreported for a query's rows",
		reachingIn("concurrent", "query", (a) => [atSlotOf(a)])
	],
	[
		"a 23505 at slot after waiting, its stated slot the witness",
		reachingIn("concurrent", "array", (a) => [atSlotOf(a)])
	],
	[
		"a 23505 at slot after waiting, unreported among several slots",
		reachingIn("concurrent", "array", (a) => [atSlotOf(a), besides(a)])
	]
]

/** The law a refusal names, by the statement that states it. */
export type KeyName = "sitting" | "slot"

/** What one call answers in the serial order, over the rows its statement sees and the rows it meets in flight. */
export type Expected =
	| {
			readonly kind: "inserted"
			readonly rows: ReadonlyArray<Request>
			/** The requests that repeat a stored or a committed row exactly, each of which meets that row. */
			readonly met: ReadonlyArray<Request>
	  }
	| {
			readonly kind: "refused"
			readonly law: KeyName
			readonly witnesses: Arr.NonEmptyReadonlyArray<Witness>
			readonly path: "probe" | "unique" | "arbiter"
	  }

interface Judged {
	readonly expected: Expected
	/** Whether the call's statement waits for the rows in flight. */
	readonly waits: boolean
	readonly features: ReadonlyArray<CollisionFeature>
}

const keyWitnessOf = (r: Request): Witness => ({
	kind: "key",
	relation: "Sitting",
	values: { child: r.child, test: r.test, attempt: r.attempt }
})

const slotWitnessOf = (slot: number): Witness => ({
	kind: "key",
	relation: "Sitting",
	values: { slot }
})

const rowAt = (rows: ReadonlyArray<Request>, r: Request): Option.Option<Request> =>
	Arr.findFirst(rows, (s) => sameKey(s, r))

const holds = (rows: ReadonlyArray<Request>, r: Request): boolean =>
	Arr.some(rows, (s) => s.slot === r.slot)

/**
 * One call's answer as the serial order gives it, the call's rows stated in `form`, `visible` the rows its statement's
 * snapshot sees and `flight` the rows another call holds uncommitted, which commit before the call's statement ends: a
 * visible occupant at slot of a request whose arbiter key its snapshot sees free gates the statement, which then waits
 * on nothing; otherwise a request meets a row in flight at its arbiter key, or at slot with its key free everywhere,
 * and waits. After the wait, a 23505 at slot ends the statement, witnessed by the one slot an array states, the host
 * holding no query's rows (runtime/write/witness.ts uniqueJudgement); otherwise a differing row at the arbiter key
 * refuses the key.
 */
export const judge = (
	form: Form,
	call: ReadonlyArray<Request>,
	visible: ReadonlyArray<Request>,
	flight: ReadonlyArray<Request>
): Judged => {
	const unseen = (r: Request) => Option.isNone(rowAt(visible, r))
	const free = (r: Request) => unseen(r) && Option.isNone(rowAt(flight, r))
	const inFlight = (r: Request) => Option.isSome(rowAt(flight, r))
	const gated = Arr.filter(call, (r) => unseen(r) && holds(visible, r))
	const waits =
		gated.length === 0 && Arr.some(call, (r) => unseen(r) && (inFlight(r) || holds(flight, r)))
	if (Arr.isReadonlyArrayNonEmpty(gated)) {
		return {
			expected: {
				kind: "refused",
				law: "slot",
				witnesses: Arr.map(gated, (r) => slotWitnessOf(r.slot)),
				path: "probe"
			},
			waits,
			features: ["a visible occupant at slot, refused by the probe"]
		}
	}
	if (Arr.some(call, (r) => free(r) && holds(flight, r))) {
		const slots = Arr.dedupe(Arr.map(call, (r) => r.slot))
		const [only, ...others] = slots
		const stated = form === "array" && others.length === 0
		return {
			expected: {
				kind: "refused",
				law: "slot",
				witnesses: [stated ? slotWitnessOf(only) : { kind: "unreported" }],
				path: "unique"
			},
			waits,
			features: [
				form === "query"
					? "a 23505 at slot after waiting, unreported for a query's rows"
					: stated
						? "a 23505 at slot after waiting, its stated slot the witness"
						: "a 23505 at slot after waiting, unreported among several slots"
			]
		}
	}
	const conflicts = Arr.filter(call, (r) =>
		Option.match(
			Option.orElse(rowAt(visible, r), () => rowAt(flight, r)),
			{
				onNone: () => false,
				onSome: (occupant) => !samePayload(occupant, r)
			}
		)
	)
	if (Arr.isReadonlyArrayNonEmpty(conflicts)) {
		return {
			expected: {
				kind: "refused",
				law: "sitting",
				witnesses: Arr.map(conflicts, keyWitnessOf),
				path: "arbiter"
			},
			waits,
			features: [
				inFlight(Arr.headNonEmpty(conflicts))
					? "a differing row at the arbiter key in flight, refused after waiting"
					: "a differing row at a visible arbiter key"
			]
		}
	}
	const inserted = Arr.filter(call, free)
	const met = Arr.filter(call, (r) => !free(r))
	return {
		expected: { kind: "inserted", rows: inserted, met },
		waits,
		features: [
			...Arr.flatMap(met, (r: Request): ReadonlyArray<CollisionFeature> =>
				inFlight(r)
					? [
							"an exact repeat of a row in flight, after waiting",
							...(form === "query" ? (["a row in flight met, read back"] as const) : [])
						]
					: [
							"an exact repeat of a visible row",
							...(form === "query" ? (["a visible row met, read back"] as const) : [])
						]
			),
			...(inserted.length === 0
				? []
				: [
						waits
							? ("an insert after waiting for a row in flight" as const)
							: ("an insert without waiting" as const)
					])
		]
	}
}

/** One learner's start of the sitting (child 1, test 7, attempt 1). */
const startOf = (note: number): Request => ({ child: 1, test: 7, attempt: 1, note, slot: 1 })

/** A sitting as a call reads it back: every field. */
interface SittingRow {
	readonly child: number
	readonly test: number
	readonly attempt: number
	readonly note: number
	readonly slot: number
}

/** What a call reads back: the sittings it added and the stored sittings it met. */
interface SittingReads {
	readonly added: ReadonlyArray<SittingRow>
	readonly met: ReadonlyArray<SittingRow>
}

/** What a call answered: its outcome, with the sittings a query member's call read back and none for an array's, or
 * the failure it met. */
export type Ran = Result.Result<WriteAnswer<WriteOutcome<Option.Option<SittingReads>>>, CallError>

/** A call's answer with what it read back as `reads` makes it of the member's own read-backs. */
const readingAs =
	<R>(reads: (own: R) => Option.Option<SittingReads>) =>
	(
		answer: WriteAnswer<WriteOutcome<R>>
	): WriteAnswer<WriteOutcome<Option.Option<SittingReads>>> => {
		switch (answer._tag) {
			case "accepted":
				return { _tag: "accepted", counts: answer.counts, reads: reads(answer.reads) }
			case "unchanged":
				return { _tag: "unchanged", reads: reads(answer.reads) }
			case "refused":
			case "outsideWorld":
				return answer
		}
	}

/** A sitting as a plain record, in key order among others: a read-back's row and a state row alike. */
export const plainSittings = (rows: ReadonlyArray<SittingRow>): ReadonlyArray<SittingRow> =>
	Arr.sort(
		Arr.map(rows, (r) => ({
			child: r.child,
			test: r.test,
			attempt: r.attempt,
			note: r.note,
			slot: r.slot
		})),
		byKey
	)

/** A row of the table's state, its fields as text, as a sitting. */
export const storedSitting = (row: ReadonlyArray<string>): SittingRow => ({
	child: Number(row[0]),
	test: Number(row[1]),
	attempt: Number(row[2]),
	note: Number(row[3]),
	slot: Number(row[4])
})

/** A relation's added count in an accepted outcome, none where it adds none. */
export const addedTo = (outcome: WriteAnswer<WriteOutcome<unknown>>, relation: string): bigint =>
	outcome._tag === "accepted"
		? Option.getOrElse(
				Option.map(
					Arr.findFirst(outcome.counts, (c) => c.relation === relation),
					(c) => c.added
				),
				() => 0n
			)
		: 0n

export const textOf = (value: unknown): string =>
	typeof value === "string" ? value : Formatter.format(value)

export const requestRows = (rows: ReadonlyArray<Request>) => Arr.map(rows, (r) => ({ ...r }))

export const unread = readingAs((): Option.Option<SittingReads> => Option.none())

export const read = readingAs((reads: SittingReads) => Option.some(reads))

/**
 * The cases the search kept by value, which reached their situations on every run: each is the aim of the situations
 * it reaches (aimed), so a case whose turn aims at one draws it. None ever caught a bug (git log -S on the module).
 */
const doubleStartCases: ReadonlyArray<{
	readonly why: string
	readonly value: Collision
	readonly reaches: ReadonlyArray<CollisionFeature>
}> = [
	{
		why: "a double Start of one sitting: the later waits for the earlier's in-flight row and is no change, never a 40001",
		value: { mode: "concurrent", form: "query", stored: [], a: [startOf(0)], b: [startOf(0)] },
		reaches: ["an exact repeat of a row in flight, after waiting", "a row in flight met, read back"]
	},
	{
		why: "a double Start that states another sitting at the same key: the later waits and is refused on the key",
		value: { mode: "concurrent", form: "query", stored: [], a: [startOf(0)], b: [startOf(1)] },
		reaches: ["a differing row at the arbiter key in flight, refused after waiting"]
	},
	{
		why: "a double Start in order: the later meets the committed sitting and is no change",
		value: { mode: "sequential", form: "query", stored: [], a: [startOf(0)], b: [startOf(0)] },
		reaches: ["an exact repeat of a visible row", "a visible row met, read back"]
	}
]

/** The property's aims (doubleStart): each kept case's value at every situation it reaches. */
export const doubleStartAims: ReadonlyArray<readonly [Reached<CollisionFeature>, Gen<Collision>]> =
	Arr.flatMap(doubleStartCases, (c) =>
		Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
	)

/** The schedule's installation made once per member (support/schedules/rig.ts rigTemplate), which each case's seat holds. */
export const collisionsRig = rigTemplate(import.meta, "collisions", collisions)
