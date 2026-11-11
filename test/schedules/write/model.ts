import { exact, set, structuralHash } from "@grizzle/testing/oracle"
import { Array as Arr, Formatter, Option, Order } from "effect"
import type { TransientTag } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"

export const relationNames = [
	"Item",
	"Note",
	"Code",
	"Ticket",
	"Room",
	"Ref",
	"Zed",
	"Badge",
	"Gate"
] as const
export type Rel = (typeof relationNames)[number]

export type Fact = ReadonlyArray<string>

/** Each relation's columns, the order its facts hold them in; Room's span is its lower and upper bound. */
export const columnsOf: Readonly<Record<Rel, ReadonlyArray<string>>> = {
	Item: ["id", "label"],
	Note: ["id", "label"],
	Code: ["id", "code"],
	Ticket: ["no", "label"],
	Room: ["room", "start", "end", "label"],
	Ref: ["id", "item"],
	Zed: ["id"],
	Badge: ["id", "code"],
	Gate: ["id"]
}

/** Each relation's primary key, by column position: what a put displaces and a direct DELETE names. */
const primaryKeyOf: Readonly<Record<Rel, ReadonlyArray<number>>> = {
	Item: [0],
	Note: [0],
	Code: [0],
	Ticket: [0],
	Room: [0, 1, 2],
	Ref: [0],
	Zed: [0],
	Badge: [0],
	Gate: [0]
}

export type State = Readonly<Record<Rel, ReadonlyArray<Fact>>>

export const emptyState: State = {
	Item: [],
	Note: [],
	Code: [],
	Ticket: [],
	Room: [],
	Ref: [],
	Zed: [],
	Badge: [],
	Gate: []
}

/**
 * A law, by its meaning. A direct writer meets a unique law as 23505, a span key as 23P01 and a containment as 23503.
 */
export type LawSpec =
	| {
			readonly kind: "unique"
			readonly law: LawId
			readonly relation: Rel
			readonly columns: ReadonlyArray<number>
	  }
	| { readonly kind: "spanKey"; readonly law: LawId; readonly relation: Rel }
	| {
			readonly kind: "contained"
			readonly law: LawId
			readonly from: Rel
			readonly column: number
			readonly to: Rel
			readonly target: number
	  }

/** A fact's identity among its relation's facts: its cells, which hold no U+0001. */
const identity = (fact: Fact): string => Arr.join(fact, "\u0001")

const project = (fact: Fact, columns: ReadonlyArray<number>): string =>
	identity(Arr.map(columns, (c) => fact[c] ?? ""))

const withFacts = (state: State, relation: Rel, facts: ReadonlyArray<Fact>): State => ({
	...state,
	[relation]: facts
})

const sameFacts = (a: ReadonlyArray<Fact>, b: ReadonlyArray<Fact>): boolean =>
	Option.isNone(set(structuralHash, exact)(a, b))

const sameState = (a: State, b: State): boolean =>
	Arr.every(relationNames, (r) => sameFacts(a[r], b[r]))

const stateKey = (state: State): string =>
	Arr.join(
		Arr.map(
			relationNames,
			(r) => `${r}:${Arr.join(Arr.sort(Arr.map(state[r], identity), Order.String), "\u0002")}`
		),
		"\u0003"
	)

const spanOverlap = (a: Fact, b: Fact): boolean =>
	a[0] === b[0] && Number(a[1]) < Number(b[2]) && Number(b[1]) < Number(a[2])

/** Whether `fact`, beside `others`, breaks `law`. */
const breaksWith = (
	law: LawSpec,
	relation: Rel,
	fact: Fact,
	others: ReadonlyArray<Fact>
): boolean => {
	switch (law.kind) {
		case "unique":
			return (
				law.relation === relation &&
				Arr.some(others, (o) => project(o, law.columns) === project(fact, law.columns))
			)
		case "spanKey":
			return law.relation === relation && Arr.some(others, (o) => spanOverlap(o, fact))
		case "contained":
			return false
	}
}

/**
 * The relations whose primary key no law states: a unique law over exactly its key's columns, or Room's span key. A
 * state holds each relation's facts as a set because its primary key's law refuses a second fact at one key, an exact
 * repeat of a stored fact included, so a model missing one would let a direct INSERT hold a fact twice.
 */
/** Whether `law` is `relation`'s primary key's: a unique law over exactly its key's columns, or its span key. */
const primaryKeyLaw = (law: LawSpec, relation: Rel): boolean =>
	law.kind === "unique"
		? law.relation === relation &&
			law.columns.length === primaryKeyOf[relation].length &&
			Arr.every(law.columns, (c, i) => c === primaryKeyOf[relation][i])
		: law.kind === "spanKey" && law.relation === relation

const unkeyedRelations = (laws: ReadonlyArray<LawSpec>): ReadonlyArray<Rel> =>
	Arr.filter(relationNames, (relation) => !Arr.some(laws, (law) => primaryKeyLaw(law, relation)))

/** The laws a state breaks. */
const violated = (laws: ReadonlyArray<LawSpec>, state: State): ReadonlyArray<LawSpec> =>
	Arr.filter(laws, (law) => {
		switch (law.kind) {
			case "unique":
			case "spanKey": {
				const facts = state[law.relation]
				return Arr.some(facts, (f, i) => breaksWith(law, law.relation, f, facts.slice(i + 1)))
			}
			case "contained": {
				const targets = new Set(Arr.map(state[law.to], (f) => f[law.target]))
				return Arr.some(state[law.from], (f) => !targets.has(f[law.column]))
			}
		}
	})

/**
 * A member of a grizzle ChangeSet, as the race draws it:
 * - enumerated: facts given as values, inserted, deleted or put;
 * - generated: Ticket additions of these labels, their serial values the sequence's;
 * - move: a put of Note's fact at `id` with `label`, described over Note itself (UPDATE ... FROM);
 * - scoped: a put of Note's facts given as a relation parameter beside the deletion of every Note fact labelled `scope`
 *   whose key the parameter does not hold (MERGE);
 * - copied: a put into Note of the Item fact at `id`, described over Item, which nothing proves in place.
 */
export type Member =
	| {
			readonly kind: "enumerated"
			readonly op: "insert" | "delete" | "put"
			readonly relation: Rel
			readonly facts: ReadonlyArray<Fact>
	  }
	| { readonly kind: "generated"; readonly labels: ReadonlyArray<string> }
	| { readonly kind: "move"; readonly id: string; readonly label: string }
	| { readonly kind: "scoped"; readonly facts: ReadonlyArray<Fact>; readonly scope: string }
	| { readonly kind: "copied"; readonly id: string }

/** A grizzle ChangeSet: its strata in order, each one add-wins transition. */
export interface GrizzleOp {
	readonly strata: ReadonlyArray<ReadonlyArray<Member>>
}

/**
 * A direct writer's statement: an INSERT of a fact; a DELETE of the fact at a primary key (none there, a zero-row
 * DELETE); an UPDATE of a Note fact's label by its id; or an UPDATE of an Item fact, which no world role may
 * run on an immutable relation (42501).
 */
export type Statement =
	| { readonly kind: "insert"; readonly relation: Rel; readonly fact: Fact }
	| { readonly kind: "delete"; readonly relation: Rel; readonly key: Fact }
	| { readonly kind: "update"; readonly id: string; readonly label: string }
	| { readonly kind: "updateImmutable"; readonly id: string; readonly label: string }

/** The serial value each generated label took, read from the committed state. */
type Pins = ReadonlyMap<string, string>

const at = (relation: Rel, facts: ReadonlyArray<Fact>, key: Fact): ReadonlyArray<Fact> =>
	Arr.filter(facts, (f) => project(f, primaryKeyOf[relation]) === identity(key))

const keyOf = (relation: Rel, fact: Fact): Fact =>
	Arr.map(primaryKeyOf[relation], (c) => fact[c] ?? "")

/** What an enumerated member deletes from `state` and adds to it: a put deletes the facts stored at its keys. */
const enumeratedEffect = (
	state: State,
	member: Extract<Member, { readonly kind: "enumerated" }>
): {
	readonly relation: Rel
	readonly deleted: ReadonlyArray<Fact>
	readonly added: ReadonlyArray<Fact>
} => {
	switch (member.op) {
		case "insert":
			return { relation: member.relation, deleted: [], added: member.facts }
		case "delete":
			return { relation: member.relation, deleted: member.facts, added: [] }
		case "put":
			return {
				relation: member.relation,
				deleted: Arr.flatMap(member.facts, (f) =>
					at(member.relation, state[member.relation], keyOf(member.relation, f))
				),
				added: member.facts
			}
	}
}

/** What a member deletes from `state` and adds to it, by relation. */
const effectOf = (
	state: State,
	member: Member,
	pins: Pins
): {
	readonly relation: Rel
	readonly deleted: ReadonlyArray<Fact>
	readonly added: ReadonlyArray<Fact>
} => {
	switch (member.kind) {
		case "enumerated":
			return enumeratedEffect(state, member)
		case "generated":
			return {
				relation: "Ticket",
				deleted: [],
				added: Arr.map(member.labels, (l) => [pins.get(l) ?? `?${l}`, l])
			}
		case "move": {
			const held = at("Note", state.Note, [member.id])
			return {
				relation: "Note",
				deleted: held,
				added: held.length === 0 ? [] : [[member.id, member.label]]
			}
		}
		case "scoped": {
			const ids = new Set(Arr.map(member.facts, (f) => f[0]))
			return {
				relation: "Note",
				deleted: Arr.filter(state.Note, (f) => ids.has(f[0]) || f[1] === member.scope),
				added: member.facts
			}
		}
		case "copied": {
			const source = at("Item", state.Item, [member.id])
			return {
				relation: "Note",
				deleted: Arr.flatMap(source, (f) => at("Note", state.Note, [f[0] ?? ""])),
				added: source
			}
		}
	}
}

/** One stratum: S' = (S \ D) ∪ A, relation by relation. */
const applyStratum = (state: State, members: ReadonlyArray<Member>, pins: Pins): State => {
	const effects = Arr.map(members, (m) => effectOf(state, m, pins))
	let next = state
	for (const relation of relationNames) {
		const atRelation = Arr.filter(effects, (e) => e.relation === relation)
		const deleted = new Set(Arr.flatMap(atRelation, (e) => Arr.map(e.deleted, identity)))
		const added = Arr.flatMap(atRelation, (e) => e.added)
		if (deleted.size === 0 && added.length === 0) {
			continue
		}
		const kept = Arr.filter(state[relation], (f) => !deleted.has(identity(f)))
		const seen = new Set(Arr.map(kept, identity))
		const unseen = Arr.filter(added, (f) => !seen.has(identity(f)))
		/** Each added fact not kept already, once: two facts of one identity are one fact. */
		const fresh = [...new Map(Arr.map(unseen, (f) => [identity(f), f] as const)).values()]
		next = withFacts(next, relation, [...kept, ...fresh])
	}
	return next
}

/**
 * A grizzle write at a state: applied, with whether it changed the state, or refused by these laws. Keys are checked at
 * each stratum's end, the deferred containment at the end of the last.
 */
type GrizzleMeaning =
	| { readonly kind: "applied"; readonly changed: boolean; readonly state: State }
	| { readonly kind: "refused"; readonly laws: ReadonlyArray<LawId> }

/**
 * The primary key laws a ChangeSet's deletions break before it runs: a delete naming two facts at one key is refused,
 * where any stratum's deletions of one relation hold two facts that differ at a primary key, by that key's law
 * (runtime/write/normalize.ts, the same-key checks, which run before any statement is sent).
 */
const deletionConflicts = (laws: ReadonlyArray<LawSpec>, op: GrizzleOp): ReadonlyArray<LawId> =>
	Arr.flatMap(op.strata, (stratum) =>
		Arr.flatMap(relationNames, (relation) => {
			const deleted = Arr.flatMap(stratum, (m) =>
				m.kind === "enumerated" && m.op === "delete" && m.relation === relation ? m.facts : []
			)
			const byKey = new Map<string, string>()
			const conflict = Arr.some(deleted, (f) => {
				const key = project(f, primaryKeyOf[relation])
				const prior = byKey.get(key)
				byKey.set(key, identity(f))
				return prior !== undefined && prior !== identity(f)
			})
			return conflict ? Arr.flatMap(laws, (l) => (primaryKeyLaw(l, relation) ? [l.law] : [])) : []
		})
	)

const grizzleMeaning = (
	laws: ReadonlyArray<LawSpec>,
	state: State,
	op: GrizzleOp,
	pins: Pins
): GrizzleMeaning => {
	const conflicts = deletionConflicts(laws, op)
	if (conflicts.length > 0) {
		return { kind: "refused", laws: conflicts }
	}
	let next = state
	for (const stratum of op.strata) {
		next = applyStratum(next, stratum, pins)
		const broken = Arr.filter(violated(laws, next), (l) => l.kind !== "contained")
		if (broken.length > 0) {
			return { kind: "refused", laws: Arr.map(broken, (l) => l.law) }
		}
	}
	const deferred = violated(laws, next)
	if (deferred.length > 0) {
		return { kind: "refused", laws: Arr.map(deferred, (l) => l.law) }
	}
	return { kind: "applied", changed: !sameState(next, state), state: next }
}

/**
 * One direct statement at a state: the state it leaves and the rows it touched, or the SQLSTATE that refuses it. An
 * INSERT also meets `unseen`, facts committed after the transaction's snapshot, which its snapshot, and so its DELETEs
 * and UPDATEs, never see: PostgreSQL checks a unique index or an exclusion constraint against every committed row.
 */
const directStep = (
	laws: ReadonlyArray<LawSpec>,
	next: State,
	unseen: State,
	s: Statement
):
	| { readonly kind: "ran"; readonly state: State; readonly rows: number }
	| { readonly kind: "failed"; readonly code: string } => {
	switch (s.kind) {
		case "insert": {
			const facts = next[s.relation]
			const met = [...facts, ...unseen[s.relation]]
			return Option.match(
				Arr.findFirst(laws, (law) => breaksWith(law, s.relation, s.fact, met)),
				{
					onNone: () =>
						({
							kind: "ran",
							state: withFacts(next, s.relation, [...facts, s.fact]),
							rows: 1
						}) as const,
					onSome: (broken) => ({ kind: "failed", code: sqlstateOf(broken) }) as const
				}
			)
		}
		case "delete": {
			const gone = new Set(Arr.map(at(s.relation, next[s.relation], s.key), identity))
			return {
				kind: "ran",
				state: withFacts(
					next,
					s.relation,
					Arr.filter(next[s.relation], (f) => !gone.has(identity(f)))
				),
				rows: gone.size
			}
		}
		case "update": {
			const held = at("Note", next.Note, [s.id])
			return {
				kind: "ran",
				state: withFacts(next, "Note", [
					...Arr.filter(next.Note, (f) => f[0] !== s.id),
					...Arr.map(held, (): Fact => [s.id, s.label])
				]),
				rows: held.length
			}
		}
		case "updateImmutable":
			return { kind: "failed", code: "42501" }
	}
}

/**
 * A direct transaction at a state, ended by COMMIT: committed with each statement's row count, or failed with a
 * SQLSTATE at a statement (or at COMMIT, its index the statement count).
 */
type DirectMeaning =
	| { readonly kind: "committed"; readonly rowCounts: ReadonlyArray<number>; readonly state: State }
	| { readonly kind: "failed"; readonly at: number; readonly code: string }

const sqlstateOf = (law: LawSpec): string => {
	switch (law.kind) {
		case "unique":
			return "23505"
		case "spanKey":
			return "23P01"
		case "contained":
			return "23503"
	}
}

/** A direct transaction's meaning at a state, its INSERTs also meeting the `unseen` facts (`directStep`). */
const directMeaning = (
	laws: ReadonlyArray<LawSpec>,
	state: State,
	statements: ReadonlyArray<Statement>,
	unseen: State
): DirectMeaning => {
	let next = state
	const rowCounts: Array<number> = []
	for (const [i, statement] of statements.entries()) {
		const ran = directStep(laws, next, unseen, statement)
		if (ran.kind === "failed") {
			return { kind: "failed", at: i, code: ran.code }
		}
		next = ran.state
		rowCounts.push(ran.rows)
	}
	return Option.match(
		Arr.findFirst(violated(laws, next), (l) => l.kind === "contained"),
		{
			onNone: (): DirectMeaning => ({ kind: "committed", rowCounts, state: next }),
			onSome: (deferred): DirectMeaning => ({
				kind: "failed",
				at: statements.length,
				code: sqlstateOf(deferred)
			})
		}
	)
}

/** An operation's span on the run's event clock. */
export interface Span {
	readonly start: number
	readonly end: number
}

/**
 * What a grizzle write's calls did: the TransientFailure reasons its refused calls carried, in order, then the answer.
 * The caller calls again after every TransientFailure until a call answers (untilAnswered), so a write ends answered or
 * failed otherwise, never refused.
 */
export type GrizzleAnswer =
	| { readonly kind: "accepted" | "no-change" }
	| { readonly kind: "invariant-rejected"; readonly law: LawId }
	| { readonly kind: "failed"; readonly what: string }

/** What a direct transaction did, as the driver recorded it. */
export type DirectAnswer =
	| { readonly kind: "committed"; readonly rowCounts: ReadonlyArray<number> }
	| { readonly kind: "failed"; readonly at: number; readonly code: string }
	| { readonly kind: "other"; readonly what: string }

export type Observed =
	| {
			readonly kind: "grizzle"
			readonly label: string
			readonly session: string
			readonly op: GrizzleOp
			readonly span: Span
			readonly refused: ReadonlyArray<TransientTag>
			readonly answer: GrizzleAnswer
	  }
	| {
			readonly kind: "direct"
			readonly label: string
			readonly session: string
			readonly statements: ReadonlyArray<Statement>
			readonly span: Span
			readonly answer: DirectAnswer
	  }

/** Whether a member adds facts to `relation`: an insertion or a put into it, a generated Ticket fact. */
const adds = (m: Member, relation: Rel): boolean => {
	switch (m.kind) {
		case "enumerated":
			return m.relation === relation && m.op !== "delete"
		case "generated":
			return relation === "Ticket"
		case "move":
		case "scoped":
		case "copied":
			return relation === "Note"
	}
}

const sameColumns = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean =>
	a.length === b.length && Arr.every(a, (c, i) => c === b[i])

/** The relations with a unique object beside their arbiter, the primary key: a candidate key's. */
const besideArbiter = (laws: ReadonlyArray<LawSpec>): ReadonlyArray<Rel> =>
	Arr.flatMap(laws, (l) =>
		l.kind === "unique" && !sameColumns(l.columns, primaryKeyOf[l.relation]) ? [l.relation] : []
	)

/**
 * The TransientFailure reasons a grizzle write's shape allows, each but GeneratedSerialUnique from a concurrent
 * transaction: a serialization failure and a deadlock for any write; a conflict at a key a put deleted for a put; an
 * unseen occupant of a unique object beside the arbiter for a write that adds to a relation with one (Code, and Ticket,
 * whose generated additions have no arbiter and are probed at its label); a changed occupant of a span key for a write
 * into Room; and a stored serial value the sequence had not passed for a generated addition.
 */
const allowedReasons = (laws: ReadonlyArray<LawSpec>, op: GrizzleOp): ReadonlySet<TransientTag> => {
	const members = op.strata.flat()
	const reasons = new Set<TransientTag>(["SerializationFailure", "Deadlock"])
	if (
		Arr.some(
			members,
			(m) => (m.kind === "enumerated" && m.op === "put") || m.kind === "move" || m.kind === "scoped"
		)
	) {
		reasons.add("PutTargetConflict")
	}
	if (Arr.some(besideArbiter(laws), (relation) => Arr.some(members, (m) => adds(m, relation)))) {
		reasons.add("UnseenOccupant")
	}
	if (Arr.some(members, (m) => adds(m, "Room"))) {
		reasons.add("SpanKeyChange")
	}
	if (Arr.some(members, (m) => m.kind === "generated")) {
		reasons.add("GeneratedSerialUnique")
	}
	return reasons
}

const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end

/**
 * A direct transaction's refusal by a key or a span key, placed in a serial order at `at` though its statements fail
 * otherwise there or not at all: its explanation is pending on an unseen occupant (see `judgeRun`). `index` is its
 * place among the placed operations; `unseen` the facts the operations after it that overlap it in real time have made
 * present so far, which its snapshot, `at`, does not hold.
 */
interface Pending {
	readonly index: number
	readonly statements: ReadonlyArray<Statement>
	readonly code: string
	readonly span: Span
	readonly at: State
	readonly unseen: State
}

/** `unseen` with the facts an operation made present, those `after` it holds that `before` it and `snapshot` do not. */
const withMadePresent = (unseen: State, snapshot: State, before: State, after: State): State => {
	let next = unseen
	for (const relation of relationNames) {
		const known = new Set(
			Arr.map([...snapshot[relation], ...before[relation], ...unseen[relation]], identity)
		)
		const fresh = Arr.filter(after[relation], (f) => !known.has(identity(f)))
		if (fresh.length > 0) {
			next = withFacts(next, relation, [...unseen[relation], ...fresh])
		}
	}
	return next
}

const explicitTickets = (op: GrizzleOp): ReadonlyArray<bigint> =>
	Arr.flatMap(op.strata.flat(), (m) =>
		m.kind === "enumerated" && m.relation === "Ticket" && m.op !== "delete"
			? Arr.map(m.facts, (f) => BigInt(f[0] ?? "0"))
			: []
	)

const generatedLabels = (op: GrizzleOp): ReadonlyArray<string> =>
	Arr.flatMap(op.strata.flat(), (m) => (m.kind === "generated" ? m.labels : []))

const describeObserved = (o: Observed): string =>
	`${o.label} on ${o.session} [${o.span.start}, ${o.span.end}]`

/** Why a grizzle write's refused calls or failure have no cause the run shows, or undefined. */
const grizzleCauseProblem = (
	laws: ReadonlyArray<LawSpec>,
	o: Extract<Observed, { readonly kind: "grizzle" }>,
	concurrent: boolean,
	explicitSerials: boolean
): string | undefined => {
	const allowed = allowedReasons(laws, o.op)
	for (const reason of o.refused) {
		if (!allowed.has(reason)) {
			return `${describeObserved(o)} was refused with ${reason}, which its shape never meets`
		}
		if (reason === "GeneratedSerialUnique" ? !explicitSerials : !concurrent) {
			return `${describeObserved(o)} was refused with ${reason}, which nothing in the run explains`
		}
	}
	return o.answer.kind === "failed" ? `${describeObserved(o)} failed: ${o.answer.what}` : undefined
}

/** Why a direct transaction's failure has no cause the run shows, or is one no direct statement of a race meets. */
const directCauseProblem = (
	o: Extract<Observed, { readonly kind: "direct" }>,
	concurrent: boolean
): string | undefined => {
	switch (o.answer.kind) {
		case "other":
			return `${describeObserved(o)} failed: ${o.answer.what}`
		case "committed":
			return undefined
		case "failed": {
			const code = o.answer.code
			if ((code === "40001" || code === "40P01") && !concurrent) {
				return `${describeObserved(o)} aborted with ${code} beside no concurrent transaction`
			}
			return ["40001", "40P01", "23505", "23P01", "23503", "42501"].includes(code)
				? undefined
				: `${describeObserved(o)} failed with ${code}, which no direct statement of a race meets`
		}
	}
}

/**
 * Why a run is not serializable as the model means it: an operation the model refuses at its place, an abort or a value
 * the run does not explain (Refused), or no serial order of the placed operations that explains them all
 * (NoSerialOrder), each with its reason; the tags are the interleaving judgment's own.
 */
export type RunProblem = { readonly tag: "Refused" | "NoSerialOrder"; readonly why: string }

/**
 * The serial model of the write races: a host meaning of every grizzle ChangeSet and every direct
 * statement a race draws over the schedule schema, and the judge of one run against it.
 *
 * Every transaction runs SERIALIZABLE, so PostgreSQL commits only histories some serial order explains. The judge
 * searches for one: an order of the operations that committed, and a place among them for every operation refused by a
 * law, that respects real time (an operation that finished before another began comes first), in which each committed
 * operation does exactly what it did (a grizzle apply accepted exactly when the model changes the state, no-change
 * exactly when it does not; a direct transaction's statements with the row counts PostgreSQL answered), each refusal
 * is the model's at its place (a grizzle refusal's law among the laws the model breaks there; a direct transaction's
 * SQLSTATE the one the model fails it with), and the last state is the committed state read back. A direct
 * transaction's 23505 or 23P01 is the model's at its place also when it fails with it there once its INSERTs meet the
 * facts that operations after it in the order, overlapping it in real time and so committed after its snapshot, made
 * present (an unseen occupant, `Pending`): PostgreSQL checks a unique index or an exclusion constraint against every
 * committed row, whatever the snapshot, and only SSI's dangerous structures turn that into 40001, so a writer that
 * deleted a key on its snapshot and inserts at it meets a concurrent commit there (README, "Direct SQL access":
 * retryable, so run the transaction again). A grizzle writer meets one as a TransientFailure, never a refusal. An operation that
 * aborted takes no place: its abort needs a cause the run shows, a concurrent operation overlapping it in real time for
 * 40001, 40P01 and every TransientFailure reason the operation's shape allows, or, for GeneratedSerialUnique, an
 * explicit serial value the sequence never passed. The model never reads a src rule: its laws are the declarations'
 * meaning (a key's columns unique, a span key's spans disjoint per scalar, a containment's values present), and its
 * ChangeSet meaning is add-wins, S' = (S \ D) ∪ A per stratum, with a put deleting the facts at its keys.
 *
 * Generated serial values are the realization's own: a generated fact's value is read from the committed state by its
 * label, which no other fact holds, and the judge checks only what the contract fixes, that it collides with no fact at
 * its place and that it lies past every explicit value a grizzle write that finished before it began stored, since a
 * write advances its sequence past the explicit values it stores.
 *
 * A fact is its columns' text, in the relation's column order; a state holds each relation's facts as a set.
 *
 * Why the run is not serializable as the model means it, or undefined (see the header).
 */
export const judgeRun = (
	laws: ReadonlyArray<LawSpec>,
	initial: State,
	observed: ReadonlyArray<Observed>,
	final: State
): RunProblem | undefined => {
	const unkeyed = unkeyedRelations(laws)
	if (Arr.isReadonlyArrayNonEmpty(unkeyed)) {
		throw new Error(
			`the schedule model states no law for the primary key of ${Arr.join(unkeyed, ", ")}: without it a direct INSERT of a stored fact would hold that fact twice`
		)
	}
	const pins: Pins = new Map(Arr.map(final.Ticket, (f) => [f[1] ?? "", f[0] ?? ""]))
	const explicitSerials =
		initial.Ticket.length > 0 ||
		Arr.some(observed, (o) =>
			o.kind === "direct"
				? Arr.some(o.statements, (s) => s.kind === "insert" && s.relation === "Ticket")
				: explicitTickets(o.op).length > 0
		)
	for (const o of observed) {
		const concurrent = Arr.some(
			observed,
			(p) => p.session !== o.session && overlaps(p.span, o.span)
		)
		const problem =
			o.kind === "grizzle"
				? grizzleCauseProblem(laws, o, concurrent, explicitSerials)
				: directCauseProblem(o, concurrent)
		if (problem !== undefined) {
			return { tag: "Refused", why: problem }
		}
	}
	/** Each generated value lies past the explicit values every grizzle write that finished before it began stored. */
	const generated = Arr.flatMap(observed, (g) =>
		g.kind === "grizzle" && (g.answer.kind === "accepted" || g.answer.kind === "no-change")
			? Arr.flatMap(generatedLabels(g.op), (l) => {
					const value = pins.get(l)
					return value === undefined
						? []
						: Arr.flatMap(observed, (e) =>
								e.kind === "grizzle" && e.span.end < g.span.start && e.answer.kind === "accepted"
									? Arr.map(explicitTickets(e.op), (explicit) => ({ g, e, value, explicit }))
									: []
							)
				})
			: []
	)
	const behind = Arr.findFirst(generated, ({ value, explicit }) => BigInt(value) <= explicit)
	if (Option.isSome(behind)) {
		const { g, e, value, explicit } = behind.value
		return {
			tag: "Refused",
			why: `${describeObserved(g)} generated ${value}, not past ${explicit}, which ${describeObserved(e)} stored before it began: its sequence was not advanced`
		}
	}
	/** The operations that take a place: committed or refused by a law. */
	const placed = Arr.filter(observed, (o) =>
		o.kind === "grizzle"
			? o.answer.kind === "accepted" ||
				o.answer.kind === "no-change" ||
				o.answer.kind === "invariant-rejected"
			: o.answer.kind === "committed" ||
				(o.answer.kind === "failed" && o.answer.code !== "40001" && o.answer.code !== "40P01")
	)
	/** The state after `o` at `state`, or undefined when the model does not do there what `o` did. */
	const step = (o: Observed, state: State): State | undefined => {
		if (o.kind === "grizzle") {
			const meant = grizzleMeaning(laws, state, o.op, pins)
			switch (o.answer.kind) {
				case "accepted":
				case "no-change":
					return meant.kind === "applied" && meant.changed === (o.answer.kind === "accepted")
						? meant.state
						: undefined
				case "invariant-rejected":
					return meant.kind === "refused" && meant.laws.includes(o.answer.law) ? state : undefined
				case "failed":
					return undefined
			}
		}
		const meant = directMeaning(laws, state, o.statements, emptyState)
		switch (o.answer.kind) {
			case "committed": {
				const counts = o.answer.rowCounts
				return meant.kind === "committed" &&
					meant.rowCounts.length === counts.length &&
					Arr.every(meant.rowCounts, (n, i) => n === counts[i])
					? meant.state
					: undefined
			}
			case "failed":
				return meant.kind === "failed" && meant.code === o.answer.code ? state : undefined
			case "other":
				return undefined
		}
	}
	/** The SQLSTATEs a direct writer meets an unseen occupant with: a key's, a span key's. */
	const occupiedCodes = new Set(
		Arr.flatMap(laws, (l) => (l.kind === "contained" ? [] : [sqlstateOf(l)]))
	)
	/**
	 * Where `o`, the `i`-th placed operation, takes its place at `state`: the state after it, and, for a direct
	 * refusal by a key or a span key that the model does not fail there with its SQLSTATE, its explanation pending
	 * on an unseen occupant; or undefined when the model does not do there what `o` did.
	 */
	const place = (
		i: number,
		o: Observed,
		state: State
	): { readonly next: State; readonly opened: ReadonlyArray<Pending> } | undefined => {
		const next = step(o, state)
		if (next !== undefined) {
			return { next, opened: [] }
		}
		return o.kind === "direct" && o.answer.kind === "failed" && occupiedCodes.has(o.answer.code)
			? {
					next: state,
					opened: [
						{
							index: i,
							statements: o.statements,
							code: o.answer.code,
							span: o.span,
							at: state,
							unseen: emptyState
						}
					]
				}
			: undefined
	}
	/** Whether a pending refusal is explained: at its place, its INSERTs meeting its unseen facts, it fails with its
	 * own SQLSTATE. */
	const explained = (p: Pending): boolean => {
		const meant = directMeaning(laws, p.at, p.statements, p.unseen)
		return meant.kind === "failed" && meant.code === p.code
	}
	const failed = new Set<string>()
	const search = (
		done: ReadonlySet<number>,
		state: State,
		pending: ReadonlyArray<Pending>
	): boolean => {
		if (done.size === placed.length) {
			return pending.length === 0 && sameState(state, final)
		}
		const key = `${Arr.join(Arr.map(Arr.sort(done, Order.Number), String), ",")}|${stateKey(state)}|${Arr.join(
			Arr.map(pending, (p) => `${p.index}:${stateKey(p.at)}:${stateKey(p.unseen)}`),
			";"
		)}`
		if (failed.has(key)) {
			return false
		}
		for (const [i, o] of placed.entries()) {
			if (done.has(i)) {
				continue
			}
			if (Arr.some(placed, (p, j) => !done.has(j) && j !== i && p.span.end < o.span.start)) {
				continue
			}
			const placing = place(i, o, state)
			if (placing === undefined) {
				continue
			}
			/** What `o` made present is unseen by each pending refusal it overlaps in real time, placed before it. */
			const carried = Arr.filter(
				Arr.map(pending, (p) =>
					overlaps(p.span, o.span)
						? { ...p, unseen: withMadePresent(p.unseen, p.at, state, placing.next) }
						: p
				),
				(p) => !explained(p)
			)
			if (search(new Set([...done, i]), placing.next, [...carried, ...placing.opened])) {
				return true
			}
		}
		failed.add(key)
		return false
	}
	if (search(new Set(), initial, [])) {
		return undefined
	}
	return {
		tag: "NoSerialOrder",
		why: `no serial order of ${Arr.join(Arr.map(placed, describeObserved), ", ")} explains the run: ${Arr.join(
			Arr.map(observed, (o) => `${o.label} ${Formatter.format(o.answer)}`),
			"; "
		)}`
	}
}
