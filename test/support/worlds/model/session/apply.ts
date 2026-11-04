import { Array as Arr, Option, Record as Rec, Result } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import {
	collide,
	type HostLaw,
	type HostOp,
	projection,
	sameState,
	sameValues,
	selected,
	transition,
	valueText
} from "#test/pg/laws/families/model.ts"
import { nextDraw, withSerial, withSerials } from "#test/support/worlds/model/draws.ts"
import { entryRows, factKey, isMember } from "#test/support/worlds/model/host.ts"
import {
	type Cell,
	checkLaw,
	type RowFault,
	rowFault
} from "#test/support/worlds/model/session/domains.ts"
import { brokenAt, type Submitted, witnessFor } from "#test/support/worlds/model/session/laws.ts"
import {
	type Called,
	roleEntryOf,
	factsIn,
	relationSpecOf,
	roleOf
} from "#test/support/worlds/model/session/state.ts"

import {
	keysOf,
	serialHead,
	type UniqueIndex,
	uniquesOf,
	type Written,
	writtenNamed
} from "#test/support/worlds/model/session/writes.ts"

import type {
	BaseSpec,
	Branch,
	ContextFacts,
	EntryOp,
	FieldDomain,
	HostFact,
	HostState,
	ModelState,
	ActionOutcome,
	ReadBack,
	RoleSpec,
	HostValue
} from "#test/support/worlds/model/types.ts"

/**
 * The most distinct facts one input of a ChangeSet may hold (README "Writes"): grizzle admits every fact through its
 * encoder, collapses equal ones, and only then counts.
 */
export const inputLimit = 100_000

type QueryWritten = Extract<Written, { readonly kind: "query" }>

/**
 * The fact of the target a fact written through a query entry fills to: its head fields at the target fields they
 * supply, and each fixed field from its literal or from the claims; none when a context it is filled from holds no fact.
 */
const fillOf = (w: QueryWritten, fact: HostFact, facts: ContextFacts): HostFact | undefined => {
	const out: Record<string, HostValue> = {}
	for (const [head, { field }] of Rec.toEntries(w.head)) {
		const value = fact[head]
		if (value !== undefined) {
			out[field] = value
		}
	}
	for (const [field, fill] of Rec.toEntries(w.fills)) {
		if (fill.kind === "literal") {
			out[field] = fill.value
		} else {
			const value = facts[fill.context]?.[fill.field]
			if (value === undefined) {
				return undefined
			}
			out[field] = value
		}
	}
	return out
}

/** A field a role relation carries into its target: its name in the relation, and the target field's domain. */
interface Carried {
	readonly shown: string
	readonly domain: FieldDomain
}

/**
 * The fields a role relation carries (a whole entry's every field, a query entry's head fields), each at its target
 * field's domain. A serial field a fact leaves out is the identity default's to draw.
 */
const carriedOf = (base: BaseSpec, w: Written): ReadonlyArray<Carried> => {
	const fields = relationSpecOf(base, w.target)?.fields ?? []
	const carried: ReadonlyArray<readonly [string, string]> =
		w.kind === "whole"
			? Arr.map(fields, (f) => [f.name, f.name] as const)
			: Arr.map(Rec.toEntries(w.head), ([head, { field }]) => [head, field] as const)
	return Arr.map(carried, ([shown, field]) => {
		const domain = Option.getOrUndefined(Arr.findFirst(fields, (f) => f.name === field))?.domain
		if (domain === undefined) {
			throw new Error(
				`the written relation ${w.entry} carries ${shown} into ${w.target}.${field}, which it does not hold`
			)
		}
		return { shown, domain }
	})
}

/**
 * Values told apart as the model tells them (equalValues): a span by its endpoints, a draw by its draw, any other value
 * itself.
 */
class Values {
	readonly #plain = new Set<number | boolean | string | undefined>()
	readonly #texts = new Set<string>()

	/** Adds a value (undefined for a field a fact leaves out), and whether it was not there yet. */
	added(value: HostValue | undefined): boolean {
		return typeof value === "object"
			? addedTo(this.#texts, valueText(value))
			: addedTo(this.#plain, value)
	}

	get size(): number {
		return this.#plain.size + this.#texts.size
	}
}

/** Adds an item to a set, and whether it was not there yet. */
const addedTo = <A>(set: Set<A>, item: A): boolean => {
	if (set.has(item)) {
		return false
	}
	set.add(item)
	return true
}

/**
 * The cells of the facts an op writes through a role relation, each fact's value at each field the relation carries,
 * each (field, value) once, in the order the facts first carry it: a repeated cell meets what its first one met, so the
 * cells' fault (rowFault) is theirs all, and an input past the limit, one fact counted through a field, is judged at
 * the cost of that field's values.
 */
const cellsOf = (
	base: BaseSpec,
	w: Written,
	facts: ReadonlyArray<HostFact>
): ReadonlyArray<Cell> => {
	const columns = Arr.map(carriedOf(base, w), (c) => ({ ...c, values: new Values() }))
	const cells: Array<Cell> = []
	for (const fact of facts) {
		for (const c of columns) {
			newCell(cells, c, fact[c.shown])
		}
	}
	return cells
}

/**
 * Whether an op's facts leave out serial fields as grizzle refuses at the encoder (README "Writes", "Writing through a
 * role"): an inserted fact leaving out some of its relation's classed serial fields and not all, or one its filter
 * reads (serialHead); a deleted or put fact, which names a complete fact, leaving out any.
 */
const misshapen = (base: BaseSpec, w: Written, op: EntryOp): boolean => {
	const { classed, filtered } = serialHead(base, w)
	const carries = (fact: HostFact, field: string): boolean => fact[field] !== undefined
	return Arr.some(op.facts, (fact) => {
		if (op.kind !== "insert") {
			return !Arr.every([...classed, ...filtered], (f) => carries(fact, f))
		}
		const supplied = Arr.filter(classed, (f) => carries(fact, f)).length
		return (
			(supplied > 0 && supplied < classed.length) || !Arr.every(filtered, (f) => carries(fact, f))
		)
	})
}

/**
 * The fault of an op's facts that grizzle refuses before any SQL, judged once per op: a misshapen fact's (a base type's
 * fault, which the encoder refuses), else its cells' fault (rowFault), a base type's or a law domain's CHECK; none for
 * facts every encoder and CHECK admits.
 */
export const opFault = (base: BaseSpec, w: Written, op: EntryOp): RowFault | undefined =>
	misshapen(base, w, op)
		? { kind: "encoding", fault: "type" }
		: rowFault(cellsOf(base, w, op.facts))

/** Adds a column's cell of a value to the cells, unless the column met the value before. */
const newCell = (
	cells: Array<Cell>,
	column: Carried & { readonly values: Values },
	value: HostValue | undefined
): void => {
	if (column.values.added(value)) {
		cells.push({ domain: column.domain, value })
	}
}

/**
 * Whether an input holds more distinct facts than `inputLimit`: equal facts are one, as grizzle collapses them before
 * it counts, so only an input longer than the limit is counted, and facts holding more distinct values at one field
 * than the limit are that many distinct facts at least.
 */
const pastLimit = (facts: ReadonlyArray<HostFact>): boolean => {
	if (facts.length <= inputLimit) {
		return false
	}
	const distinctAt = (field: string): number => {
		const values = new Values()
		for (const fact of facts) {
			values.added(fact[field])
		}
		return values.size
	}
	const fields = Arr.flatMap(facts.slice(0, 1), (f) => Rec.keys(f))
	return (
		Arr.some(fields, (field) => distinctAt(field) > inputLimit) ||
		new Set(Arr.map(facts, factKey)).size > inputLimit
	)
}

/** An op through its written relation, with the CHECK laws of the law domains its values break. */
interface Checked {
	readonly op: EntryOp
	readonly written: Written
	readonly checks: ReadonlyArray<LawId>
}

/** One op through its written relation, its facts split as README "Writing through a role" judges them. */
interface Judged {
	readonly op: EntryOp
	readonly written: Written
	/** The target facts the op writes: the facts themselves for a whole entry, their fills inside the entry otherwise. */
	readonly inside: ReadonlyArray<HostFact>
	/** Whether an inserted or put fact lies outside the entry: its fill is not a member, or a context it needs is absent. */
	readonly outside: boolean
	/**
	 * The target facts the op names, inside the entry or not: each fact's fill, where every context it is filled from
	 * holds a fact.
	 */
	readonly submitted: ReadonlyArray<HostFact>
	/** The CHECK laws of the law domains its values break, each refusing the statement as it casts them. */
	readonly checks: ReadonlyArray<LawId>
	/** The first draw after the draws of its facts' serial fields. */
	readonly next: number
}

/** The facts of a list, without its holes. */
const defined = (xs: ReadonlyArray<HostFact | undefined>): ReadonlyArray<HostFact> =>
	Arr.flatMap(xs, (f) => (f === undefined ? [] : [f]))

/**
 * An op judged: each fact's fill (a whole entry's fact itself), where every context it is filled from holds a fact,
 * with each serial field the caller left out holding a draw numbered from `first` (draws.ts withSerial); a query
 * entry's fill inside the entry when it is a member, judged before the identity draws.
 */
const judge = (
	state: ModelState,
	role: string,
	facts: ContextFacts,
	{ op, written, checks }: Checked,
	first: number
): Judged => {
	let next = first
	/** Equal facts are one: equal generated additions one requested addition, drawn once. */
	const named = Arr.map(Arr.dedupeWith(op.facts, sameValues), (f) => {
		const fill = written.kind === "whole" ? f : fillOf(written, f, facts)
		if (fill === undefined) {
			return undefined
		}
		const drew = withSerial(state.install.base, written.target, fill, next)
		next = drew.next
		return { fill, drawn: drew.fact }
	})
	const submitted = defined(Arr.map(named, (n) => n?.drawn))
	if (written.kind === "whole") {
		return { op, written, inside: submitted, outside: false, submitted, checks, next }
	}
	const members = Arr.map(named, (n) =>
		n !== undefined && isMember(state, role, written.entry, facts, n.fill) ? n.drawn : undefined
	)
	return {
		op,
		written,
		inside: defined(members),
		outside: op.kind !== "delete" && Arr.some(members, (f) => f === undefined),
		submitted,
		checks,
		next
	}
}

/** The base relations a query entry's filter reads: every relation its rule matches or negates but its own target. */
const filterReads = (w: QueryWritten): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(w.rules, (r) =>
			Arr.flatMap([...r.matches, ...r.negations.flat()], (o) =>
				o.source.kind === "ordinary" && o.source.name !== w.target ? [o.source.name] : []
			)
		)
	)

/** The key law of a relation's key: its primary key's or a candidate key's, as the host schema names it. */
const keyLawOf = (
	state: ModelState,
	relation: string,
	key: ReadonlyArray<string>
): HostLaw | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(
			state.host.laws,
			(l) =>
				(l.kind === "key" &&
					l.relation === relation &&
					l.fields.length === key.length &&
					Arr.every(key, (k) => l.fields.includes(k))) ||
				(l.kind === "spanKey" &&
					l.relation === relation &&
					l.scalars.length + 1 === key.length &&
					Arr.every(key, (k) => k === l.span || l.scalars.includes(k)))
		)
	)

/** A fact's values at the head fields that supply `fields`, named as the entry names them. */
const inEntryTerms = (w: QueryWritten, fact: HostFact, fields: ReadonlyArray<string>): HostFact =>
	Rec.fromEntries(
		Arr.flatMap(Rec.toEntries(w.head), ([head, { field }]) => {
			const value = fact[field]
			return fields.includes(field) && value !== undefined ? [[head, value]] : []
		})
	)

/** The law of an at-most-one capacity's unique index, as the installation names it. */
const uniqueLawOf = (state: ModelState, u: UniqueIndex): LawId | undefined => {
	const ids = state.names.laws[u.law]
	return ids?.kind === "capacity" ? ids.law : undefined
}

/**
 * The collisions of a query entry's inserted and put facts with facts of its target outside the entry, which the
 * entry's precheck finds through its key probes and unique probes (write/entry/precheck.ts): at a key, and at a unique
 * index no key subsumes (uniquesOf) between two facts its selector admits. Each is invariant-rejected on that key's or
 * index's law, its witness the keys submitted at the law's fields, in the entry's fields.
 */
const collisionsOf = (
	state: ModelState,
	role: string,
	facts: ContextFacts,
	j: Judged
): ReadonlyArray<ActionOutcome> => {
	const w = j.written
	if (w.kind === "whole" || j.op.kind === "delete") {
		return []
	}
	const occupants = Arr.filter(
		factsIn(state.reality, w.target),
		(f) => !isMember(state, role, w.entry, facts, f)
	)
	const atKeys = Arr.flatMap(
		keysOf(state.install.base, w.target),
		(key): ReadonlyArray<ActionOutcome> => {
			const law = keyLawOf(state, w.target, key)
			if (law === undefined) {
				return []
			}
			const colliding = Arr.filter(j.inside, (f) =>
				Arr.some(occupants, (o) =>
					law.kind === "spanKey" ? collide(law, f, o) : projection(f, key) === projection(o, key)
				)
			)
			return colliding.length === 0
				? []
				: [
						{
							kind: "invariant-rejected",
							law: law.law,
							witness: { kind: "shown", keys: Arr.map(j.inside, (f) => inEntryTerms(w, f, key)) }
						}
					]
		}
	)
	const atIndexes = Arr.flatMap(
		uniquesOf(state.install.base, w.target),
		(u): ReadonlyArray<ActionOutcome> => {
			const law = uniqueLawOf(state, u)
			const at = (f: HostFact): string | undefined =>
				selected(f, u.where) ? projection(f, u.fields) : undefined
			const held = new Set(Arr.flatMap(occupants, (o) => Arr.fromNullishOr(at(o))))
			const colliding = Arr.some(j.inside, (f) => {
				const k = at(f)
				return k !== undefined && held.has(k)
			})
			return law === undefined || !colliding
				? []
				: [
						{
							kind: "invariant-rejected",
							law,
							witness: {
								kind: "shown",
								keys: Arr.map(j.inside, (f) => inEntryTerms(w, f, u.fields))
							}
						}
					]
		}
	)
	return [...atKeys, ...atIndexes]
}

/**
 * What a judged op's statement refuses itself: the CHECK of each law domain one of its values breaks, met as the
 * statement casts its input, before its row constraints, policies and triggers (a domain CHECK reports no key, so its
 * witness is withheld); else an inserted or put fact outside the entry, and each key or unique index at which a fact
 * outside a query entry collides with one it submits (collisionsOf).
 */
const refusalsOf = (
	state: ModelState,
	role: string,
	facts: ContextFacts,
	j: Judged
): ReadonlyArray<ActionOutcome> => {
	if (j.checks.length > 0) {
		return Arr.map(j.checks, (law): ActionOutcome => ({
			kind: "invariant-rejected",
			law,
			witness: { kind: "withheld" }
		}))
	}
	const outside: ReadonlyArray<ActionOutcome> = j.outside
		? [{ kind: "outside-world", relation: j.op.relation }]
		: []
	return [...outside, ...collisionsOf(state, role, facts, j)]
}

/** A fact's values at a key's fields, in the terms the role relation wrote it in. */
const keyIn = (w: Written, fact: HostFact, key: ReadonlyArray<string>): HostFact =>
	w.kind === "query"
		? inEntryTerms(w, fact, key)
		: Rec.fromEntries(
				Arr.flatMap(key, (field) => {
					const value = fact[field]
					return value === undefined ? [] : [[field, value] as const]
				})
			)

/** A fact written through a relation in its target's fields: a whole entry's itself; a query entry's head fields at the target fields they supply, its fixed fields left out. */
const targetTermsOf = (w: Written, fact: HostFact): HostFact =>
	w.kind === "whole"
		? fact
		: Rec.fromEntries(
				Arr.flatMap(Rec.toEntries(w.head), ([head, { field }]) => {
					const value = fact[head]
					return value === undefined ? [] : [[field, value] as const]
				})
			)

/** The target fields a written relation carries: a whole entry's every one, a query entry's head fields' own. */
const carriedFields = (base: BaseSpec, w: Written): ReadonlySet<string> =>
	new Set(
		w.kind === "whole"
			? Arr.map(relationSpecOf(base, w.target)?.fields ?? [], (f) => f.name)
			: Arr.map(Rec.values(w.head), (h) => h.field)
	)

/**
 * The key refusal grizzle's host normalization makes of one target's additions in a stratum (packages/engine/src/write/
 * normalize/normalize.ts), before any SQL is sent: two facts its inserts and puts submit, inside the entry or not and
 * whatever the claims fill, that agree on a key (or, of a span key, collide) and differ elsewhere break the key whatever
 * is stored, and the first key of the target holding such a pair, the primary key first and then the declared keys in
 * order, is invariant-rejected on its law, its witness the key of one of those facts in the terms it was written in.
 * A key is compared on the fields the relation it is written through carries (write/frontend/entry.ts entryFacts): a
 * query entry's fixed fields are one value for the whole stratum, so they take no part, and a span key whose span the
 * entry does not carry is not checked here. Deletions take no part: a delete names facts, and one that is not stored
 * deletes nothing. A generated addition takes part on no key holding its serial field.
 */
const keyConflictOf = (
	state: ModelState,
	ops: ReadonlyArray<Checked>,
	target: string
): ActionOutcome | undefined => {
	const base = state.install.base
	const submitted = Arr.flatMap(ops, ({ op, written }) =>
		written.target === target && op.kind !== "delete"
			? Arr.map(op.facts, (f) => ({ fact: targetTermsOf(written, f), w: written }))
			: []
	)
	const drawn = withSerials(
		base,
		target,
		Arr.map(submitted, (x) => x.fact),
		nextDraw(state)
	).facts
	const additions = Arr.map(Arr.zip(submitted, drawn), ([x, fact]) => ({ fact, w: x.w }))
	const [first] = additions
	if (first === undefined) {
		return undefined
	}
	const carried = carriedFields(base, first.w)
	const carriedOnly = (fields: ReadonlyArray<string>): ReadonlyArray<string> =>
		Arr.filter(fields, (f) => carried.has(f))
	for (const key of keysOf(base, target)) {
		const law = keyLawOf(state, target, key)
		if (law === undefined || (law.kind === "spanKey" && !carried.has(law.span))) {
			continue
		}
		const agree = (a: HostFact, b: HostFact): boolean =>
			law.kind === "spanKey"
				? collide({ ...law, scalars: carriedOnly(law.scalars) }, a, b)
				: projection(a, carriedOnly(key)) === projection(b, carriedOnly(key))
		const paired = Arr.filter(additions, (x) =>
			Arr.some(additions, (y) => agree(x.fact, y.fact) && !sameValues(x.fact, y.fact))
		)
		if (paired.length > 0) {
			return {
				kind: "invariant-rejected",
				law: law.law,
				witness: {
					kind: "shown",
					keys: Arr.map(paired, (x) => keyIn(x.w, x.fact, carriedOnly(key)))
				}
			}
		}
	}
	return undefined
}

/** The add-wins ops of judged ops over their targets. */
const baseOps = (judged: ReadonlyArray<Judged>): ReadonlyArray<HostOp> =>
	Arr.map(judged, (j) => ({ relation: j.written.target, kind: j.op.kind, facts: j.inside }))

/** The target fields a judged op's facts were written under: a query entry's head names, a whole entry's own. */
const termsOf = (base: BaseSpec, w: Written): Readonly<Record<string, string>> =>
	w.kind === "whole"
		? Rec.fromEntries(
				Arr.map(relationSpecOf(base, w.target)?.fields ?? [], (f) => [f.name, f.name] as const)
			)
		: Rec.fromEntries(Arr.map(Rec.toEntries(w.head), ([head, { field }]) => [field, head] as const))

/** A fact of a target in the terms a role relation writes it in. */
const inTerms = (fact: HostFact, terms: Readonly<Record<string, string>>): HostFact =>
	Rec.fromEntries(
		Arr.flatMap(Rec.toEntries(terms), ([field, name]) => {
			const value = fact[field]
			return value === undefined ? [] : [[name, value] as const]
		})
	)

/** The base relations a role relation's definition reads: a whole entry's relation, every relation a query matches. */
const definitionReads = (role: RoleSpec, relation: string): ReadonlySet<string> => {
	const entry = roleEntryOf(role, relation)
	if (entry === undefined) {
		return new Set()
	}
	return entry.kind === "whole"
		? new Set([entry.relation])
		: new Set(
				Arr.flatMap(entry.rules, (r) =>
					Arr.flatMap([...r.matches, ...r.negations.flat()], (o) =>
						o.source.kind === "ordinary" ? [o.source.name] : []
					)
				)
			)
}

/** How a read-back's delta is known: empty, the written target's delta in the relation's terms, or not at all. */
type DeltaOf =
	| { readonly kind: "empty" }
	| {
			readonly kind: "projected"
			readonly target: string
			readonly terms: Readonly<Record<string, string>>
	  }
	| { readonly kind: "unknown" }

/**
 * A read-back's delta (README "Writes": `read` delivers a query over the post-change state and the change's own
 * delta): empty when the ChangeSet writes nothing the relation's definition reads; the target's delta, in the
 * relation's terms, when the relation is written and the ChangeSet writes nothing else its definition reads, or when
 * the relation is a whole entry over a target the ChangeSet writes through another entry, whose delta is the target's
 * own; otherwise which facts moved in or out depends on more than the change, and the read-back is refused when it
 * compiles.
 */
const deltaOf = (
	base: BaseSpec,
	role: RoleSpec,
	relation: string,
	written: ReadonlyArray<Written>
): DeltaOf => {
	const read = definitionReads(role, relation)
	const touched = new Set(
		Arr.filter(
			Arr.map(written, (w) => w.target),
			(t) => read.has(t)
		)
	)
	if (touched.size === 0) {
		return { kind: "empty" }
	}
	const through = Option.getOrUndefined(Arr.findFirst(written, (w) => w.entry === relation))
	if (through !== undefined && touched.size === 1 && touched.has(through.target)) {
		return { kind: "projected", target: through.target, terms: termsOf(base, through) }
	}
	const entry = roleEntryOf(role, relation)
	return entry?.kind === "whole" && touched.size === 1 && touched.has(entry.relation)
		? {
				kind: "projected",
				target: entry.relation,
				terms: Rec.fromEntries(
					Arr.map(
						relationSpecOf(base, entry.relation)?.fields ?? [],
						(f) => [f.name, f.name] as const
					)
				)
			}
		: { kind: "unknown" }
}

/** The facts of `a` that `b` does not hold, each fact by every value. */
const without = (a: ReadonlyArray<HostFact>, b: ReadonlyArray<HostFact>): ReadonlyArray<HostFact> =>
	Arr.filter(a, (f) => !Arr.some(b, (g) => sameValues(f, g)))

/**
 * Whether grizzle refuses a ChangeSet of these strata and read-backs through a role when it compiles (README "Writing
 * through a role", "Writes"): a relation outside the role's write list, a stratum that writes a query entry and also a
 * relation its filter reads, or a read-back of a relation the role does not hold or whose delta the change does not
 * determine. A ChangeSet's facts are values outside its Description, so no fact, generated or complete, and no
 * relation's serial fields, is a reason to refuse it there.
 */
export const compileRefused = (
	base: BaseSpec,
	role: RoleSpec,
	strata: ReadonlyArray<ReadonlyArray<EntryOp>>,
	reads: ReadonlyArray<string>
): boolean => {
	const layers = Arr.map(strata, (ops) =>
		Arr.map(ops, (op) => ({ op, written: writtenNamed(base, role, op.relation) }))
	)
	const written = Arr.flatMap(layers, (ops) =>
		Arr.flatMap(ops, (w) => (w.written === undefined ? [] : [w.written]))
	)
	/** Whether no query a stratum writes reads a relation the stratum writes. */
	const disjoint = Arr.every(layers, (ops) => {
		const targets = new Set(
			Arr.flatMap(ops, (w) => (w.written === undefined ? [] : [w.written.target]))
		)
		return Arr.every(
			ops,
			(w) =>
				w.written?.kind !== "query" || !Arr.some([...filterReads(w.written)], (r) => targets.has(r))
		)
	})
	return (
		Arr.some(layers, (ops) => Arr.some(ops, (w) => w.written === undefined)) ||
		!disjoint ||
		Arr.some(reads, (r) => roleEntryOf(role, r) === undefined) ||
		Arr.some(reads, (relation) => deltaOf(base, role, relation, written).kind === "unknown")
	)
}

/** A call grizzle refuses on the host, before any SQL. */
const onHost = (refusal: ActionOutcome): Called => ({ kind: "host", refusals: [refusal] })

/**
 * A ChangeSet through a Db's role relations (README "Writing through a role", "Writes", "Errors and outcomes"): its strata in
 * `ChangeSet.sequence` order, each the union of its writes and judged against the state the strata before it left,
 * then the read-backs over the post-change state. The refusals before any SQL are the host's, judged by the Db's
 * snapshot (step.ts dbCall); the rest is the call's SQL phase:
 *
 * - a relation outside the role's write list, a stratum that writes a query entry and also a relation its filter reads,
 *   and a read-back whose delta the change does not determine are refused when they compile;
 * - before any SQL, stratum by stratum, a value its field's encoder refuses (a base type's fault) is refused, and two
 *   facts the stratum's inserts and puts submit to one target that agree on a key and differ elsewhere are
 *   `invariant-rejected` on that key's law (keyConflictOf); then an input of more than 100,000 distinct facts (equal
 *   facts collapse first) before any statement;
 * - an op holding a value its law domain's CHECK refuses (an integer past its contract's bounds, a text past its
 *   pattern), which the encoder admits, is `invariant-rejected` on that domain's CHECK law, its witness withheld, as
 *   its stratum's statement casts the value: before anything else the statement meets;
 * - each fact through a query entry fills its fixed fields; an inserted or put fact the entry cannot hold is
 *   `outside-world`, a deleted one a no-op; an inserted or put fact whose key a fact outside the entry holds, or that
 *   collides with one at an at-most-one capacity's unique index, is `invariant-rejected` on that key's or capacity's
 *   law. Which of these refusals, and a law another op of the stratum breaks meanwhile, on the same target or another,
 *   comes first is the order of the stratum's statements, which the model leaves open, as README "Writing through a
 *   role" leaves which refusal a ChangeSet meets first: an op's own refusal stops its statement before it writes;
 * - each stratum's S' = (S \ D) ∪ A meets the laws PostgreSQL checks at a statement, and the final state the laws it
 *   checks at COMMIT, each refusal's witness the most README "Errors and outcomes" allows; else `accepted`, or `no-change` when the
 *   final state is the first. Nothing is written on any refusal, and a derived relation keeps its facts until a refresh.
 */
export const applyCall = (
	state: ModelState,
	session: { readonly role: string; readonly facts: ContextFacts },
	strata: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<EntryOp>>,
	reads: ReadonlyArray<string>
): Called => {
	const stay = (observation: ActionOutcome): Branch => ({ observation, next: state })
	const stayAny = (
		observations: ReadonlyArray<ActionOutcome>
	): Arr.NonEmptyReadonlyArray<Branch> | undefined => {
		const [first, ...rest] = observations
		return first === undefined ? undefined : [stay(first), ...Arr.map(rest, stay)]
	}
	const base = state.install.base
	const role = roleOf(state.install, session.role)
	if (role === undefined) {
		return onHost({ kind: "handle-refused" })
	}
	if (compileRefused(base, role, strata, reads)) {
		return onHost({ kind: "compile-refused" })
	}
	const layers = Arr.map(strata, (ops) =>
		Arr.filterMap(ops, (op) => {
			const written = writtenNamed(base, role, op.relation)
			return written === undefined ? Result.failVoid : Result.succeed({ op, written })
		})
	)
	const everyWritten = Arr.map(layers.flat(), (w) => w.written)
	const deltas = Arr.map(reads, (relation) => ({
		relation,
		delta: deltaOf(base, role, relation, everyWritten)
	}))
	const faulted = Arr.map(layers, (ops) =>
		Arr.map(ops, ({ op, written }) => ({
			op,
			written,
			fault: opFault(base, written, op)
		}))
	)
	const checked = Arr.map(faulted, (ops) =>
		Arr.map(ops, ({ op, written, fault }): Checked => ({
			op,
			written,
			checks:
				fault?.kind === "checks"
					? [...new Set(Arr.map(fault.domains, (d) => checkLaw(state.names, d)))]
					: []
		}))
	)
	for (const [i, ops] of faulted.entries()) {
		const refusals = Arr.flatMap(
			[...new Set(Arr.map(ops, (w) => w.written.target))],
			(target): ReadonlyArray<ActionOutcome> => {
				if (Arr.some(ops, (w) => w.written.target === target && w.fault?.kind === "encoding")) {
					return [{ kind: "encoding-refused" }]
				}
				const conflict = keyConflictOf(state, checked[i] ?? [], target)
				return conflict === undefined ? [] : [conflict]
			}
		)
		const [refused, ...more] = refusals
		if (refused !== undefined) {
			return { kind: "host", refusals: [refused, ...more] }
		}
	}
	if (Arr.some(strata, (ops) => Arr.some(ops, (op) => pastLimit(op.facts)))) {
		return onHost({ kind: "resource-bound" })
	}
	/** The SQL phase, once the transaction's prologue lets the call through. */
	const sql = (): Arr.NonEmptyReadonlyArray<Branch> => {
		const submitted: Array<Submitted> = []
		const rejected = (at: "statement" | "commit", after: HostState): ReadonlyArray<ActionOutcome> =>
			Arr.map(brokenAt(state.host, after, at), ({ violation }) => ({
				kind: "invariant-rejected",
				law: violation.law,
				witness: witnessFor(state.host, role, violation, submitted)
			}))
		let now = state.reality
		let draws = nextDraw(state)
		for (const ops of checked) {
			const at: ModelState = { ...state, reality: now }
			const judged: Array<Judged> = []
			for (const w of ops) {
				const j = judge(at, role.name, session.facts, w, draws)
				draws = j.next
				judged.push(j)
			}
			for (const j of judged) {
				for (const fact of j.inside) {
					submitted.push({ relation: j.written.target, fact, terms: termsOf(base, j.written) })
				}
			}
			const verdicts = Arr.map(judged, (j) => ({
				j,
				refusals: refusalsOf(at, role.name, session.facts, j)
			}))
			const [refused, ...refusedToo] = Arr.flatMap(verdicts, (v) => v.refusals)
			if (refused !== undefined) {
				/** The state after every op whose own statement refuses nothing, on a refused op's target
				 * or another: each may run before a refused one, so a law it breaks at its statement may be
				 * the refusal met first. */
				const others = transition(
					state.host,
					now,
					baseOps(Arr.flatMap(verdicts, (v) => (v.refusals.length === 0 ? [v.j] : [])))
				)
				return [stay(refused), ...Arr.map([...refusedToo, ...rejected("statement", others)], stay)]
			}
			now = transition(state.host, now, baseOps(judged))
			const atStatement = stayAny(rejected("statement", now))
			if (atStatement !== undefined) {
				return atStatement
			}
		}
		const atCommit = stayAny(rejected("commit", now))
		if (atCommit !== undefined) {
			return atCommit
		}
		const next: ModelState = { ...state, reality: now }
		const readBacks: ReadonlyArray<ReadBack> = Arr.map(deltas, ({ relation, delta }) => {
			const rows = entryRows(next, role.name, relation, session.facts)
			if (delta.kind !== "projected") {
				return { relation, rows, delta: { inserted: [], deleted: [] } }
			}
			const before = factsIn(state.reality, delta.target)
			const after = factsIn(now, delta.target)
			return {
				relation,
				rows,
				delta: {
					inserted: Arr.map(without(after, before), (f) => inTerms(f, delta.terms)),
					deleted: Arr.map(without(before, after), (f) => inTerms(f, delta.terms))
				}
			}
		})
		return sameState(state.host, state.reality, now)
			? [stay({ kind: "applied", outcome: "no-change", reads: readBacks })]
			: [{ observation: { kind: "applied", outcome: "accepted", reads: readBacks }, next }]
	}
	return { kind: "sends", sql }
}
