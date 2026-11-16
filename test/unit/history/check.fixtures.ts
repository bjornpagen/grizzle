/** What the properties of check.test.ts read: its spaces, models and helpers. */

import {
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	shuffled,
	subarray,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import type { TransientTag } from "#compiler/core/errors.ts"
import {
	type GrizzleSettled,
	type History,
	type Outcome,
	type Recorded
} from "#test/support/history/check.ts"
import { expectFor, type WriterKind } from "#test/support/history/model.ts"
import { wild } from "#test/support/kernel/naming.ts"
import {
	everyFact,
	type HostFact,
	type HostOp,
	type HostRelation,
	type HostSchema,
	type HostState,
	valueText
} from "#test/support/laws/model.ts"
import { upTo } from "#test/support/up-to.ts"

/** The host model's own label for its one law, never compared with a production name. */
const law = wild.lawId("the Worker key")

const worker: HostRelation = {
	name: "Worker",
	table: "worker",
	fields: [
		{ name: "id", column: "id" },
		{ name: "name", column: "name" }
	],
	key: ["id"],
	serial: [],
	mutable: false
}

const host: HostSchema = {
	relations: [worker],
	laws: [{ kind: "key", law, relation: "Worker", fields: ["id"], selection: everyFact }]
}

/** The box's ids and names. */
const ids = [1, 2] as const

const names = ["a", "b"] as const

const factGen: Gen<HostFact> = (source) => ({
	id: source.draw(element(ids)),
	name: source.draw(element(names))
})

/** Every fact of the box. */
const boxFacts: ReadonlyArray<HostFact> = Arr.flatMap(ids, (id) =>
	Arr.map(names, (name): HostFact => ({ id, name }))
)

const workers = (facts: ReadonlyArray<HostFact>): HostState => new Map([["Worker", facts]])

const factText = (f: HostFact): string => `${valueText(f["id"] ?? "")}${valueText(f["name"] ?? "")}`

const stateKey = (s: HostState): string =>
	Arr.join(Arr.sort(Arr.map(s.get("Worker") ?? [], factText), Order.String), ",")

/** A lawful state of the box: each id with no fact or one of its names. */
const lawfulGen: Gen<HostState> = (source) =>
	workers(
		Arr.flatMap(ids, (id) => {
			const name = source.draw(element([undefined, ...names] as const))
			return name === undefined ? [] : [{ id, name }]
		})
	)

const opGen: Gen<HostOp> = (source) => ({
	relation: "Worker",
	kind: source.draw(element(["insert", "delete"] as const)),
	facts: [source.draw(factGen)]
})

/**
 * The TransientFailure reasons a discarded attempt is drawn with: the concurrent ones a write of a law family meets,
 * and the ones no concurrent transaction causes, which nothing explains.
 */
const discardReasons: ReadonlyArray<TransientTag> & Readonly<{ 0: TransientTag }> = [
	"SerializationFailure",
	"Deadlock",
	"UnseenOccupant",
	"GeneratedSerialUnique"
]

/** A refusal's witness: the key of the fact the operation writes, a key outside the box, or none. */
type WitnessShape = "written" | "outside" | "none"

/** A key no fact of the box holds. */
const outsideKey = Object.freeze([{ relation: "Worker", values: { id: 3 } }])

/** The witness its writer gives a refusal: grizzle names the written fact by its key, a direct writer nothing. */
export const hostWitnessOf = (kind: WriterKind, written: ReadonlyArray<HostOp>) =>
	kind === "grizzle"
		? Arr.map(
				Arr.flatMap(written, (o) => o.facts),
				(f) => ({ relation: "Worker", values: { id: f["id"] } })
			)
		: []

const witnessGen =
	(ops: ReadonlyArray<HostOp>): Gen<ReadonlyArray<ReturnType<typeof hostWitnessOf>[number]>> =>
	(source) => {
		const shape = source.draw(element<WitnessShape>(["written", "outside", "none"]))
		switch (shape) {
			case "written":
				return hostWitnessOf("grizzle", ops)
			case "outside":
				return outsideKey
			case "none":
				return []
		}
	}

/** One operation before its outcome: its writer, its ops, and its interval on the clock. */
interface Planned {
	readonly id: number
	readonly kind: WriterKind
	readonly ops: ReadonlyArray<HostOp>
	readonly start: number
	readonly end: number
}

const plannedGen =
	(id: number): Gen<Planned> =>
	(source) => {
		const start = source.draw(int(0, 5))
		return {
			id,
			kind: source.draw(element<WriterKind>(["grizzle", "direct"])),
			ops: [source.draw(opGen)],
			start,
			end: source.draw(int(start + 1, 6))
		}
	}

/** A grizzle writer's outcome, drawn freely. */
const settledGen =
	(p: Planned): Gen<GrizzleSettled> =>
	(source) => {
		const kind = source.draw(
			element(["accepted", "no-change", "invariant-rejected", "unorderable"] as const)
		)
		return kind === "invariant-rejected"
			? { kind, laws: [law], keys: source.draw(witnessGen(p.ops)) }
			: { kind }
	}

/** A direct writer's outcome, drawn freely. */
const directGen =
	(p: Planned): Gen<Outcome> =>
	(source) => {
		const kind = source.draw(element(["accepted", "invariant-rejected", "aborted"] as const))
		switch (kind) {
			case "accepted":
				return { kind }
			case "invariant-rejected":
				return { kind, laws: [law], keys: source.draw(witnessGen(p.ops)) }
			case "aborted":
				return {
					kind,
					cause: { kind: source.draw(element(["serialization failure", "deadlock"] as const)) }
				}
		}
	}

/**
 * An operation's record at `state`, its place: most often the outcome its writer's model gives it there, otherwise one
 * drawn freely; with the state after it, the model's when the outcome is the model's and commits, `state` otherwise.
 */
const recordGen =
	(p: Planned, state: HostState): Gen<readonly [Recorded, HostState]> =>
	(source) => {
		const head = { id: p.id, writer: `w${p.id}`, ops: p.ops, start: p.start, end: p.end }
		const e = expectFor(p.kind, host, state, p.ops)
		const faithful = source.draw(
			weighted([
				[2, constant(true)],
				[1, constant(false)]
			])
		)
		const after = faithful && (e.kind === "accepted" || e.kind === "no-change") ? e.state : state
		if (p.kind === "grizzle") {
			const modelled: GrizzleSettled =
				e.kind === "invariant-rejected"
					? { kind: e.kind, laws: [law], keys: hostWitnessOf(p.kind, p.ops) }
					: { kind: e.kind }
			return [
				{
					...head,
					kind: "grizzle",
					outcome: faithful ? modelled : source.draw(settledGen(p)),
					transients: source.draw(array(element(discardReasons), { min: 0, max: 1 }))
				},
				after
			]
		}
		const modelled: Outcome =
			e.kind === "invariant-rejected"
				? { kind: e.kind, laws: [law], keys: hostWitnessOf(p.kind, p.ops) }
				: { kind: "accepted" }
		return [
			{ ...head, kind: "direct", outcome: faithful ? modelled : source.draw(directGen(p)) },
			after
		]
	}

/**
 * A history: two or three operations from a lawful initial state, placed in a drawn order, each recorded at its place
 * (recordGen), and the committed state the order reaches, or any set of the box's facts; so explained histories and
 * their near misses are both common.
 */
export const historyGen: Gen<History> = (source) => {
	const initial = source.draw(lawfulGen)
	const planned = upTo(source.draw(int(2, 3)), (id) => source.draw(plannedGen(id)))
	const order = source.draw(shuffled(planned, { min: planned.length, max: planned.length }))
	const recorded: Array<Recorded> = []
	let reached = initial
	for (const p of order) {
		const [record, after] = source.draw(recordGen(p, reached))
		recorded.push(record)
		reached = after
	}
	const committed = source.draw(
		weighted<HostState>([
			[2, () => reached],
			[1, map(subarray(boxFacts), workers)]
		])
	)
	return {
		host,
		initial,
		recorded: Arr.sort(
			recorded,
			Order.mapInput(Order.Number, (r: Recorded) => r.id)
		),
		committed
	}
}

const overlaps = (r: Recorded, q: Recorded): boolean =>
	q.id !== r.id && q.start < r.end && r.start < q.end

const permutations = <T>(xs: ReadonlyArray<T>): ReadonlyArray<ReadonlyArray<T>> =>
	xs.length === 0
		? [[]]
		: Arr.flatMap(xs, (x, i) =>
				Arr.map(permutations([...xs.slice(0, i), ...xs.slice(i + 1)]), (rest) => [x, ...rest])
			)

export const sameKeys = (
	left: ReadonlyArray<{ readonly values: Readonly<Record<string, unknown>> }>,
	right: typeof left
) =>
	left.length === right.length &&
	Arr.every(left, (k, i) => k.values["id"] === right[i]?.values["id"])

/** The reasons a concurrent transaction causes (a law family's write meets no other). */
const concurrent = (reason: TransientTag): boolean =>
	reason === "SerializationFailure" ||
	reason === "Deadlock" ||
	reason === "UnseenOccupant" ||
	reason === "PutTargetConflict" ||
	reason === "SpanKeyChange"

/** The state after `r` at `state` if its outcome is one `r.ops` from there admits, the state unchanged by a refusal. */
const replay = (r: Recorded, state: HostState): HostState | undefined => {
	const e = expectFor(r.kind, host, state, r.ops)
	const o = r.outcome
	switch (o.kind) {
		case "invariant-rejected":
			return e.kind === "invariant-rejected" &&
				Arr.some(e.violations, (v) => o.laws.includes(v.law)) &&
				sameKeys(o.keys, hostWitnessOf(r.kind, r.ops))
				? state
				: undefined
		case "accepted":
		case "no-change":
			if (e.kind === "invariant-rejected" || e.kind === "unorderable") {
				return undefined
			}
			if (r.kind === "grizzle" && o.kind !== e.kind) {
				return undefined
			}
			return e.state
		case "unorderable":
		case "aborted":
			return undefined
	}
}

/**
 * Whether direct writer `r`'s refusal by the key at `state`, its place, meets an occupant its snapshot did not hold: an
 * operation of `later`, after it in the order and overlapping it in real time, inserted a fact at the key of one `r`
 * inserts, which `state` does not hold. PostgreSQL checks the key against every committed row whatever the snapshot,
 * so the writer is refused although its place commits it. Its witness is still a direct writer's: none.
 */
const unseenOccupant = (r: Recorded, state: HostState, later: ReadonlyArray<Recorded>): boolean => {
	const o = r.outcome
	if (
		r.kind !== "direct" ||
		o.kind !== "invariant-rejected" ||
		!o.laws.includes(law) ||
		!sameKeys(o.keys, hostWitnessOf(r.kind, r.ops))
	) {
		return false
	}
	const held = state.get("Worker") ?? []
	return Arr.some(
		r.ops,
		(op) =>
			op.kind === "insert" &&
			Arr.some(op.facts, (f) =>
				Arr.some(
					later,
					(q) =>
						overlaps(r, q) &&
						Arr.some(
							q.ops,
							(qo) =>
								qo.kind === "insert" &&
								Arr.some(
									qo.facts,
									(g) =>
										g["id"] === f["id"] &&
										!Arr.some(held, (k) => k["id"] === g["id"] && k["name"] === g["name"])
								)
						)
				)
			)
	)
}

/** Whether some order of `placed` respecting real time explains each outcome and ends at the committed state. */
const ordered = (h: History, placed: ReadonlyArray<Recorded>): boolean =>
	Arr.some(permutations(placed), (order) => {
		if (Arr.some(order, (r, i) => Arr.some(order.slice(i + 1), (q) => q.end < r.start))) {
			return false
		}
		let state: HostState | undefined = h.initial
		for (const [i, r] of order.entries()) {
			if (state === undefined) {
				break
			}
			state = replay(r, state) ?? (unseenOccupant(r, state, order.slice(i + 1)) ? state : undefined)
		}
		return state !== undefined && stateKey(state) === stateKey(h.committed)
	})

/** The naive enumerator's verdict (see the header). */
export const explained = (h: History): boolean => {
	const keys = Arr.map([...(h.committed.get("Worker") ?? [])], (f) => f["id"])
	if (new Set(keys).size !== keys.length) {
		return false
	}
	for (const r of h.recorded) {
		const discarded = r.kind === "grizzle" ? r.transients : []
		if (
			Arr.some(
				discarded,
				(reason) => !concurrent(reason) || !Arr.some(h.recorded, (q) => overlaps(r, q))
			)
		) {
			return false
		}
		if (
			r.outcome.kind === "unorderable" &&
			expectFor(r.kind, host, h.initial, r.ops).kind !== "unorderable"
		) {
			return false
		}
		if (r.outcome.kind !== "aborted") {
			continue
		}
		if (!Arr.some(h.recorded, (q) => overlaps(r, q))) {
			return false
		}
	}
	const committed = Arr.filter(
		h.recorded,
		(r) => r.outcome.kind === "accepted" || r.outcome.kind === "no-change"
	)
	if (!ordered(h, committed)) {
		return false
	}
	return Arr.every(
		h.recorded,
		(r) => r.outcome.kind !== "invariant-rejected" || ordered(h, [...committed, r])
	)
}

/**
 * Whether the enumerator explains a history, one with an abort, one with a refusal, one with a refusal whose witness
 * is not the one its writer gives, one with a discarded attempt, one of three operations, and one where an operation's
 * interval ends where another's starts, neither before it nor overlapping it.
 */
export type CheckerFeature =
	| "explained"
	| "unexplained"
	| "explained abort"
	| "unexplained abort"
	| "explained refusal"
	| "unexplained refusal"
	| "a wrong witness"
	| "explained discarded attempt"
	| "unexplained discarded attempt"
	| "three operations explained"
	| "intervals that touch"
	| "an unorderable outcome its model orders"
