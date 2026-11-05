import { Array as Arr, Formatter, Option } from "effect"
import type { TransientTag } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { expectFor } from "#test/support/history/model.ts"
import {
	collide,
	type Expected,
	type HostFact,
	type HostSchema,
	type HostState,
	type HostOp,
	projection,
	relationOf,
	sameState,
	sameValues,
	sortedRowsOrder,
	sortedStateRows,
	type StateRows,
	stateRows,
	violations
} from "#test/support/laws/model.ts"

export interface WitnessKey {
	readonly relation: string
	readonly values: Readonly<Record<string, unknown>>
}

/**
 * The TransientFailure reasons a law family's writes can meet, each from a concurrent transaction: no family writes
 * serial fields, migrates or refreshes, so GeneratedSerialUnique, StaleStatement and ConcurrentRefresh never apply.
 */
const concurrentReasons = [
	"SerializationFailure",
	"Deadlock",
	"UnseenOccupant",
	"PutTargetConflict",
	"SpanKeyChange"
] as const satisfies ReadonlyArray<TransientTag>

/** Why a direct writer's transaction committed nothing: 40001 or 40P01. */
export type DirectAbort = { readonly kind: "serialization failure" } | { readonly kind: "deadlock" }

/**
 * How an operation took its place: committed, with or without a change, or refused by the laws of one constraint, one
 * law or the several merged into one foreign key (fin.md §15 rule 3). A grizzle operation always ends so: its writer
 * calls again after each TransientFailure until a call answers (runGrizzle).
 */
export type Settled =
	| { readonly kind: "accepted" | "no-change" }
	| {
			readonly kind: "invariant-rejected"
			readonly laws: Arr.NonEmptyReadonlyArray<LawId>
			readonly keys: ReadonlyArray<WitnessKey>
	  }

/** How an operation ended: settled, or, a direct writer's alone, aborted. */
export type Outcome = Settled | { readonly kind: "aborted"; readonly cause: DirectAbort }

interface RecordedHead {
	readonly id: number
	/** The writer whose operations run in order on one connection. */
	readonly writer: string
	readonly ops: ReadonlyArray<HostOp>
	/** The operation's span on the exploration's event clock: its first move's issue and its last step's finish. */
	readonly start: number
	readonly end: number
}

export type Recorded = RecordedHead &
	(
		| {
				readonly kind: "grizzle"
				readonly outcome: Settled
				/** The TransientFailure reason each discarded attempt of the operation met, in order. */
				readonly transients: ReadonlyArray<TransientTag>
		  }
		| { readonly kind: "direct"; readonly outcome: Outcome }
	)

export interface History {
	readonly host: HostSchema
	readonly initial: HostState
	readonly recorded: ReadonlyArray<Recorded>
	readonly committed: HostState
}

/** A serial order that explains operations, by operation id, and the state after each operation of it. */
interface Explanation {
	readonly order: ReadonlyArray<number>
	readonly states: ReadonlyArray<HostState>
}

/** An explained history: the committed operations' order, and each refusal's own order, by the refusal's id. */
export type Verdict =
	| {
			readonly ok: true
			readonly committed: Explanation
			readonly refusals: ReadonlyMap<number, Explanation>
	  }
	| { readonly ok: false; readonly problem: string }

const show = (x: unknown): string => Formatter.format(x)
const showOps = (ops: ReadonlyArray<HostOp>): string =>
	Arr.join(
		Arr.map(ops, (o) => `${o.kind} ${o.relation} ${show(o.facts)}`),
		"; "
	)

const describeOutcome = (o: Outcome): string => {
	switch (o.kind) {
		case "accepted":
		case "no-change":
			return o.kind
		case "invariant-rejected":
			return `invariant-rejected by ${Arr.join(o.laws, ", ")}${o.keys.length === 0 ? "" : ` at ${show(o.keys)}`}`
		case "aborted":
			return `aborted: ${o.cause.kind}`
	}
}

export const describeHistory = (h: History): string =>
	Arr.join(
		[
			`initial ${show(stateRows(h.host, h.initial))}`,
			...Arr.map(
				h.recorded,
				(r) =>
					`  #${r.id} writer ${r.writer} (${r.kind}) [${r.start}, ${r.end}] ${showOps(r.ops)} -> ${describeOutcome(r.outcome)}`
			),
			`committed ${show(stateRows(h.host, h.committed))}`
		],
		"\n"
	)

const overlaps = (r: Recorded, q: Recorded): boolean =>
	q.id !== r.id && q.start < r.end && r.start < q.end

/** Why an operation's aborts are not explained by the history (rule 2), or undefined when they are. */
const abortProblem = (h: History, r: Recorded): string | undefined => {
	const lone = !Arr.some(h.recorded, (q) => overlaps(r, q))
	const transient = (reason: TransientTag, what: string): string | undefined => {
		if (!Arr.some(concurrentReasons, (x) => x === reason)) {
			return `#${r.id} ${what} TransientFailure ${reason}, which no write of a law family can meet`
		}
		return lone
			? `#${r.id} ${what} TransientFailure ${reason} with no operation overlapping it`
			: undefined
	}
	const discarded = Arr.flatMap(r.kind === "grizzle" ? r.transients : [], (reason) => {
		const problem = transient(reason, "met")
		return problem === undefined ? [] : [problem]
	})
	const [first] = discarded
	if (first !== undefined) {
		return first
	}
	if (r.outcome.kind !== "aborted") {
		return undefined
	}
	return lone
		? `#${r.id} aborted (${r.outcome.cause.kind}) with no operation overlapping it`
		: undefined
}

/**
 * Why the outcome of `r` is not what `expected` admits at its place, or undefined when it is. A direct writer cannot
 * tell an unchanged state from a change; it only commits.
 */
const departure = (r: Recorded, expected: Expected): string | undefined => {
	const o = r.outcome
	if (o.kind !== "invariant-rejected") {
		if (expected.kind === "invariant-rejected") {
			return `${o.kind}, where the model refuses with one of ${show(Arr.map(expected.violations, (v) => v.law))}`
		}
		if (r.kind === "direct" || o.kind === expected.kind) {
			return undefined
		}
		return `${o.kind}, where the model says ${expected.kind}`
	}
	if (expected.kind !== "invariant-rejected") {
		return `refused by ${Arr.join(o.laws, ", ")}, which this state does not violate`
	}
	const found = Arr.findFirst(expected.violations, (v) => o.laws.includes(v.law))
	if (Option.isNone(found)) {
		return `refused by ${Arr.join(o.laws, ", ")}, none of which this state violates; violated: ${show(expected.violations)}`
	}
	const violation = found.value
	/**
	 * Every law is native (fin.md §7): a violation a direct writer meets is stated in prose only, and a grizzle writer's
	 * names its violators where the host's witness does, a key's.
	 */
	const named = violation.violators.length > 0 && r.kind !== "direct"
	if (!named) {
		return o.keys.length === 0 ? undefined : `a witness that names no key carries ${show(o.keys)}`
	}
	if (o.keys.length === 0) {
		return "a witness that names its violators carries no key"
	}
	for (const key of o.keys) {
		if (
			!Arr.some(
				violation.violators,
				(v) => v.relation === key.relation && sameValues(key.values, v.values)
			)
		) {
			return `the witness key ${show(key)} names no violating fact of ${show(violation.violators)}`
		}
	}
	return undefined
}

/**
 * Whether a direct writer's refusal by a key or a span key at `state`, its place, is an occupant its snapshot did not
 * hold: a fact one of `later`, the committed operations after it in the order, made present while overlapping it in real
 * time, so committed after its snapshot, colliding under the law with a fact it writes. PostgreSQL checks a unique
 * index or an exclusion constraint against every committed row, whatever the snapshot, and makes the violation 40001
 * only when SSI finds a dangerous structure; a plain INSERT read nothing, so with a single rw-conflict, such as the
 * writer's own DELETE of the key on its snapshot, it raises 23505 or 23P01 although every serial order commits the
 * writer (README, "Direct SQL access": retryable, so run the transaction again). An upsert's arbiter meets such an occupant as 40001, so an
 * upserted row counts at its other keys only. A grizzle writer meets one as a TransientFailure, never a refusal.
 */
const unseenOccupant = (
	h: History,
	r: Recorded,
	state: HostState,
	later: ReadonlyArray<Recorded>
): boolean => {
	if (r.kind !== "direct" || r.outcome.kind !== "invariant-rejected") {
		return false
	}
	const refused = r.outcome.laws
	const found = Arr.findFirst(h.host.laws, (l) =>
		(l.kind === "key" || l.kind === "spanKey") && refused.includes(l.law)
			? Option.some(l)
			: Option.none()
	)
	if (Option.isNone(found)) {
		return false
	}
	if (r.outcome.keys.length > 0) {
		return false
	}
	const law = found.value
	const relation = relationOf(h.host, law.relation)
	const fields = Arr.map(relation.fields, (f) => f.name)
	const held = new Set(Arr.map(state.get(relation.name) ?? [], (f) => projection(f, fields)))
	const unseen = Arr.filter(
		Arr.flatMap(
			Arr.filter(later, (q) => overlaps(r, q)),
			(q: Recorded): ReadonlyArray<HostFact> =>
				Arr.flatMap(q.ops, (o: HostOp): ReadonlyArray<HostFact> =>
					o.relation === relation.name && o.kind !== "delete" ? o.facts : []
				)
		),
		(g) => !held.has(projection(g, fields))
	)
	return Arr.some(r.ops, (o) =>
		o.relation !== relation.name || o.kind === "delete"
			? false
			: Arr.some(o.facts, (f) =>
					Arr.some(
						unseen,
						(g) =>
							collide(law, f, g) &&
							!(o.kind === "put" && projection(f, relation.key) === projection(g, relation.key))
					)
				)
	)
}

/**
 * Where `r` takes its place at `state`, with `later` the operations after it: the state after it, its own when it
 * commits and `state` when it is refused, or why its outcome departs from what its writer does there.
 */
const placeAt = (
	h: History,
	r: Recorded,
	state: HostState,
	later: ReadonlyArray<Recorded>
):
	| { readonly ok: true; readonly after: HostState }
	| { readonly ok: false; readonly why: string } => {
	const expected = expectFor(r.kind, h.host, state, r.ops)
	const why = departure(r, expected)
	if (why === undefined) {
		return { ok: true, after: expected.kind === "invariant-rejected" ? state : expected.state }
	}
	return unseenOccupant(h, r, state, later) ? { ok: true, after: state } : { ok: false, why }
}

/**
 * A serial order of `placed` that respects real time, explains each one's outcome at its place and ends at the
 * committed state, or the deepest prefix explained with why each operation it could not extend with departed.
 */
const serialOrder = (
	h: History,
	placed: ReadonlyArray<Recorded>
):
	| { readonly ok: true; readonly explanation: Explanation }
	| { readonly ok: false; readonly problem: string } => {
	const n = placed.length
	/** Real-time order: every operation that ended before this one began. */
	const before = Arr.map(placed, (r) => Arr.flatMap(placed, (q, j) => (q.end < r.start ? [j] : [])))
	/**
	 * The states each set of placed operations, by its bits, was already found to lead to no explanation from: the
	 * search meets a set and a state again by another order, and goes no further there.
	 */
	const failed = new Map<bigint, Array<StateRows>>()
	const order: Array<number> = []
	const states: Array<HostState> = []
	let deepest: { readonly order: ReadonlyArray<number>; readonly reasons: ReadonlyArray<string> } =
		{
			order: [],
			reasons: []
		}
	const search = (done: ReadonlyArray<boolean>, state: HostState): boolean => {
		if (order.length === n) {
			if (sameState(h.host, state, h.committed)) {
				return true
			}
			if (order.length >= deepest.order.length) {
				deepest = {
					order: [...order],
					reasons: [`this order ends at ${show(stateRows(h.host, state))}`]
				}
			}
			return false
		}
		const placedSet = Arr.reduce(done, 0n, (bits, d, i) => (d ? bits | (1n << BigInt(i)) : bits))
		const rows = sortedStateRows(h.host, state)
		if (Arr.some(failed.get(placedSet) ?? [], (other) => sortedRowsOrder(other, rows) === 0)) {
			return false
		}
		const reasons: Array<string> = []
		for (const [i, r] of placed.entries()) {
			if (done[i] === true || Arr.some(before[i] ?? [], (j) => done[j] !== true)) {
				continue
			}
			const placing = placeAt(
				h,
				r,
				state,
				Arr.flatMap(placed, (q: Recorded, j: number): ReadonlyArray<Recorded> =>
					j !== i && done[j] !== true ? [q] : []
				)
			)
			if (!placing.ok) {
				reasons.push(`#${r.id}: ${placing.why}`)
				continue
			}
			const next = [...done]
			next[i] = true
			const after = placing.after
			order.push(r.id)
			states.push(after)
			if (search(next, after)) {
				return true
			}
			order.pop()
			states.pop()
		}
		if (order.length >= deepest.order.length && reasons.length > 0) {
			deepest = { order: [...order], reasons }
		}
		failed.set(placedSet, [...(failed.get(placedSet) ?? []), rows])
		return false
	}
	if (
		search(
			Arr.map(placed, () => false),
			h.initial
		)
	) {
		return { ok: true, explanation: { order: [...order], states: [...states] } }
	}
	return {
		ok: false,
		problem: Arr.join(
			[
				`deepest explained prefix: ${show(deepest.order)}`,
				...Arr.map(deepest.reasons, (x) => `  ${x}`),
				describeHistory(h)
			],
			"\n"
		)
	}
}

/**
 * The after-the-fact check of a generated history, Elle-style.
 *
 * A history is what concurrent writers did, every one at SERIALIZABLE: each operation's host operations, its writer
 * (grizzle, or direct SQL), its outcome, and its span on the exploration's event clock, from its first move to its last
 * step's finish. The checks:
 *
 * 1. every law's violation query, evaluated by the host, is empty on the committed
 *    state;
 * 2. every abort is a concurrency failure some other operation overlapping it in real time explains: a direct
 *    writer's 40001 or 40P01, a grizzle operation's TransientFailure of a reason a concurrent transaction causes, each
 *    discarded attempt of a grizzle operation included. Which of two deadlocked writers PostgreSQL aborts is its choice,
 *    so either may be the victim;
 * 3. the committed operations take their places in one serial order that respects real time (an operation that ended
 *    before another began comes first): each replayed through its writer's model (expectFor) from the initial
 *    state commits there, a grizzle `no-change` is no-change there, and the order ends at the committed state;
 * 4. every refusal takes its place in a serial order of the committed operations and that refusal alone, so explained
 *    as in 3: there its law is among the violated ones (an immediate law when one is violated, since those are raised
 *    at their statement), and its witness names only violating facts by their keys: none for a native violation a
 *    direct writer meets, whose key PostgreSQL states only in prose, some for every other. SSI orders the committed
 *    transactions; a refused transaction committed nothing, and only the order it read in is asked of it. A direct
 *    writer's key or span key refusal is explained there too by a fact a committed operation after it in the order and
 *    overlapping it in real time made present at the key of a fact it writes (unseenOccupant): PostgreSQL meets a key
 *    committed after the writer's snapshot at the statement, and only SSI's dangerous structures turn that into 40001.
 *
 * A writer below SERIALIZABLE is no operation of a history: its every write is refused, so it commits
 * nothing, and any effect it had is a committed state no serial order of the history reaches.
 *
 * The search memoizes on (operations placed, state), so it stays polynomial in practice; histories are small.
 */
export const checkHistory = (h: History): Verdict => {
	const lawless = violations(h.host, h.committed)
	if (lawless.length > 0) {
		return {
			ok: false,
			problem: `the committed state violates ${show(lawless)}\n${describeHistory(h)}`
		}
	}
	for (const r of h.recorded) {
		const problem = abortProblem(h, r)
		if (problem !== undefined) {
			return { ok: false, problem: `${problem}\n${describeHistory(h)}` }
		}
	}
	const committed = Arr.filter(
		h.recorded,
		(r) => r.outcome.kind === "accepted" || r.outcome.kind === "no-change"
	)
	const serial = serialOrder(h, committed)
	if (!serial.ok) {
		return {
			ok: false,
			problem: `no serial order of the committed operations explains them\n${serial.problem}`
		}
	}
	const refusals = new Map<number, Explanation>()
	for (const r of h.recorded) {
		if (r.outcome.kind !== "invariant-rejected") {
			continue
		}
		const own = serialOrder(h, [...committed, r])
		if (!own.ok) {
			return {
				ok: false,
				problem: `no serial order of the committed operations and the refusal #${r.id} explains them\n${own.problem}`
			}
		}
		refusals.set(r.id, own.explanation)
	}
	return { ok: true, committed: serial.explanation, refusals }
}
