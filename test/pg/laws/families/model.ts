import { type Equivalence, exact, multiset, ordered } from "@grizzle/testing/oracle"
import { Array as Arr, Formatter, Option, Order, Record as Rec } from "effect"
import type { LawId } from "#compiler/core/ids.ts"

/**
 * A span, half-open [start, end) with start < end. Every span is built start first, so two equal spans have one text.
 */
export interface Span {
	readonly start: number
	readonly end: number
}

/**
 * A value an identity default drew, which the worlds model cannot predict: the real system shows it when a statement
 * returns or reads the fact, and the model takes it then (worlds model/draws.ts). Its draw tells it apart from every
 * other draw of the case, so it equals itself alone until it is shown. It lies in its identity's range, which ends at
 * `ceiling`: past every value at or below the ceiling the case holds, and below every value past it.
 */
export interface Drawn {
	readonly kind: "drawn"
	readonly draw: number
	readonly ceiling: number
}

export type HostValue = number | boolean | string | Span | Drawn
export type HostFact = Readonly<Record<string, HostValue>>

/** A value a writer can name and send: any host value but a draw, whose value no writer has seen. */
export type Sendable = Exclude<HostValue, Drawn>

/** A fact a writer can name and send: one holding no draw. */
export type SendableFact = Readonly<Record<string, Sendable>>

export const hostSpan = (start: number, end: number): Span => ({ start, end })

/** Whether a value is a span. */
export const isSpan = (x: HostValue): x is Span => typeof x === "object" && "start" in x

/** Whether a value is one an identity default drew and the real system has not shown yet. */
export const isDrawn = (x: HostValue): x is Drawn => typeof x === "object" && "draw" in x

/**
 * A fact as a writer names it, the one way a model fact becomes one a writer sends: every value but a draw, or none for
 * a fact holding a draw the real system has not shown, which no writer can name.
 */
export const sendableFact = (fact: HostFact): SendableFact | undefined => {
	const sent: Record<string, Sendable> = {}
	for (const [field, value] of Rec.toEntries(fact)) {
		if (isDrawn(value)) {
			return undefined
		}
		sent[field] = value
	}
	return sent
}

/**
 * A value as PostgreSQL's output function spells it: a span as int4range's canonical text. A drawn value has no
 * spelling yet; it is told apart by its draw, `#n`, which no integer's output text is.
 */
export const valueText = (x: HostValue): string => {
	if (typeof x !== "object") {
		return String(x)
	}
	return "draw" in x ? `#${x.draw}` : `[${x.start},${x.end})`
}

const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end

/** Whether two values are one value: spans by their endpoints, every other value as itself. */
export const sameValue = (a: HostValue | undefined, b: HostValue | undefined): boolean =>
	a === undefined || b === undefined ? a === b : valueText(a) === valueText(b)

/**
 * A value as PostgreSQL spells it, whether a host value or one grizzle decoded into a witness, whose span endpoints may
 * be bigints. An object that is neither a draw nor a span is no value of either, a defect of whoever handed it over.
 */
const anyText = (x: unknown): string => {
	if (typeof x !== "object" || x === null) {
		return String(x)
	}
	if ("draw" in x) {
		return `#${String(x.draw)}`
	}
	if ("start" in x && "end" in x) {
		return `[${String(x.start)},${String(x.end)})`
	}
	throw new Error("a value that is neither a draw nor a span, which PostgreSQL spells no way")
}

/** Whether two records of key values hold the same fields at the same values, as PostgreSQL spells them. */
export const sameValues = (
	a: Readonly<Record<string, unknown>>,
	b: Readonly<Record<string, unknown>>
): boolean => {
	const fields = Rec.keys(a)
	return (
		fields.length === Rec.keys(b).length &&
		Arr.every(fields, (f) => Rec.has(b, f) && anyText(a[f]) === anyText(b[f]))
	)
}

export interface HostRelation {
	readonly name: string
	/** The installed table. */
	readonly table: string
	/** The fields in heading order, each with its column. */
	readonly fields: ReadonlyArray<{ readonly name: string; readonly column: string }>
	readonly key: ReadonlyArray<string>
}

/** A side of a law: a relation, its paired fields in pair order, and the field values a selector fixes. */
export interface HostSide {
	readonly relation: string
	readonly fields: ReadonlyArray<string>
	/** The selector: the field values a fact of the side holds; none, `everyFact`, selects every fact. */
	readonly where: Readonly<Record<string, HostValue>>
}

/** What a capacity sums per group: a count, a field's values, or the widths of a span field. */
export type HostWeight =
	| { readonly kind: "count" }
	| { readonly kind: "field"; readonly field: string }
	| { readonly kind: "duration"; readonly field: string }

export type HostLaw =
	| {
			readonly kind: "key"
			readonly law: LawId
			readonly relation: string
			readonly fields: ReadonlyArray<string>
	  }
	| {
			/**
			 * A unique index over the facts its selector admits, which is no key of its relation: the index an at-most-one
			 * count capacity over an unselected target is (a partial unique index on its source's fields, with the source's
			 * selector as its predicate). A put displaces no occupant by it.
			 */
			readonly kind: "unique"
			readonly law: LawId
			readonly relation: string
			readonly fields: ReadonlyArray<string>
			readonly where: Readonly<Record<string, HostValue>>
	  }
	| {
			readonly kind: "spanKey"
			readonly law: LawId
			readonly relation: string
			readonly scalars: ReadonlyArray<string>
			readonly span: string
	  }
	| {
			readonly kind: "check"
			readonly law: LawId
			readonly relation: string
			readonly holds: (fact: HostFact) => boolean
	  }
	| {
			readonly kind: "contained"
			readonly law: LawId
			readonly source: HostSide
			readonly target: HostSide
			/** A residual law reports the violating source fact's key; a native foreign key reports none. */
			readonly residual: boolean
	  }
	| {
			readonly kind: "covered"
			readonly law: LawId
			/** The paired scalar fields of each side; `span` names each side's span field. */
			readonly source: HostSide
			readonly target: HostSide
			readonly span: { readonly source: string; readonly target: string }
			/**
			 * A selected source's coverage is residual and reports the violating source fact's key; a PERIOD foreign
			 * key reports none.
			 */
			readonly residual: boolean
	  }
	| {
			readonly kind: "obliged"
			readonly law: LawId
			readonly anchor: HostSide
			readonly dependent: HostSide
	  }
	| {
			readonly kind: "capacity"
			readonly law: LawId
			readonly target: HostSide
			readonly source: HostSide
			readonly weight: HostWeight
			readonly low: HostBound
			readonly high: HostBound | "*"
	  }

/**
 * What one fact of a law's referring side needs of its referred side: a containment's or a coverage's source a target
 * fact at its values (a coverage's at its scalars and its span), and an obligation's anchor a dependent fact.
 */
export const needs = (
	law: HostLaw
): ReadonlyArray<{ readonly from: HostSide; readonly to: HostSide }> => {
	switch (law.kind) {
		case "key":
		case "unique":
		case "spanKey":
		case "check":
		case "capacity":
			return []
		case "contained":
			return [{ from: law.source, to: law.target }]
		case "covered":
			return [
				{
					from: { ...law.source, fields: [...law.source.fields, law.span.source] },
					to: { ...law.target, fields: [...law.target.fields, law.span.target] }
				}
			]
		case "obliged":
			return [{ from: law.anchor, to: law.dependent }]
	}
}

/** A capacity bound: a literal, or `ref(field)`, the value of a field of the target fact. */
export type HostBound = bigint | { readonly ref: string }

export interface HostSchema {
	readonly relations: ReadonlyArray<HostRelation>
	readonly laws: ReadonlyArray<HostLaw>
}

/** Whether a law is checked at the statement that breaks it: a key, a unique index, a span key, a row check. */
export const isImmediate = (law: HostLaw): boolean =>
	law.kind === "key" || law.kind === "unique" || law.kind === "spanKey" || law.kind === "check"

/** Whether a law is a residual law, enforced by a law function: every law no native constraint enforces. */
export const isResidual = (law: HostLaw): boolean => {
	switch (law.kind) {
		case "key":
		case "unique":
		case "spanKey":
		case "check":
			return false
		case "contained":
		case "covered":
			return law.residual
		case "obliged":
		case "capacity":
			return true
	}
}

/** The relations a law reads: the participants a residual law's triggers fire on, and what a native law checks. */
export const lawRelations = (law: HostLaw): ReadonlyArray<string> => {
	switch (law.kind) {
		case "key":
		case "unique":
		case "spanKey":
		case "check":
			return [law.relation]
		case "obliged":
			return [law.anchor.relation, law.dependent.relation]
		case "contained":
		case "covered":
		case "capacity":
			return [law.source.relation, law.target.relation]
	}
}

/** Relation name to its facts. */
export type HostState = ReadonlyMap<string, ReadonlyArray<HostFact>>

export type OpKind = "insert" | "delete" | "put"
export interface HostOp {
	readonly relation: string
	readonly kind: OpKind
	readonly facts: ReadonlyArray<HostFact>
}

/** A violating fact, by its key. */
export interface Violator {
	readonly relation: string
	readonly values: Readonly<Record<string, HostValue>>
}

export interface Violation {
	readonly law: LawId
	readonly immediate: boolean
	/** The facts a witness may name; empty for a native violation, whose witness carries no key. */
	readonly violators: ReadonlyArray<Violator>
}

export type Expected =
	| { readonly kind: "accepted" | "no-change"; readonly state: HostState }
	| { readonly kind: "invariant-rejected"; readonly violations: ReadonlyArray<Violation> }

export const relationOf = (schema: HostSchema, name: string): HostRelation => {
	const r = Arr.findFirst(schema.relations, (x) => x.name === name)
	if (Option.isNone(r)) {
		throw new Error(`no relation ${name}`)
	}
	return r.value
}

/** A fact's value at a field; a missing field is a defect of the host model. */
const fieldValue = (fact: HostFact, field: string): HostValue => {
	const x = fact[field]
	if (x === undefined) {
		throw new Error(`a fact without its field ${field}`)
	}
	return x
}

/**
 * A fact's values at `fields` as one key: each value's output text, NUL-separated; no domain value's text holds NUL.
 * Two facts share the key exactly when they hold one value at every field.
 */
export const projection = (fact: HostFact, fields: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(fields, (f) => valueText(fieldValue(fact, f))),
		"\u0000"
	)

/** A fact's identity: its values in heading order. */
const identity = (relation: HostRelation, fact: HostFact): string =>
	projection(
		fact,
		Arr.map(relation.fields, (f) => f.name)
	)

/** A fact's values at `fields`, by field. */
const valuesAt = (
	fact: HostFact,
	fields: ReadonlyArray<string>
): Readonly<Record<string, HostValue>> =>
	Rec.fromEntries(Arr.map(fields, (f) => [f, fieldValue(fact, f)]))

export const emptyState = (schema: HostSchema): HostState =>
	new Map(Arr.map(schema.relations, (r) => [r.name, []]))

const factsIn = (state: HostState, relation: string): ReadonlyArray<HostFact> =>
	state.get(relation) ?? []

/** An integer field of a fact, as a bigint: a weight or a `ref` bound. */
const integer = (fact: HostFact, field: string): bigint => {
	const x = fact[field]
	if (typeof x !== "number" || !Number.isInteger(x)) {
		throw new Error(`${field} is not an integer: ${Formatter.format(x)}`)
	}
	return BigInt(x)
}

/** A span field of a fact. */
const spanOf = (fact: HostFact, field: string): Span => {
	const x = fact[field]
	if (x === undefined || !isSpan(x)) {
		throw new Error(
			x === undefined ? `${field} is absent` : `${field} is not a span: ${valueText(x)}`
		)
	}
	return x
}

const weightOf = (weight: HostWeight, fact: HostFact): bigint => {
	switch (weight.kind) {
		case "count":
			return 1n
		case "field":
			return integer(fact, weight.field)
		case "duration": {
			const s = spanOf(fact, weight.field)
			return BigInt(s.end - s.start)
		}
	}
}

export const selected = (fact: HostFact, where: Readonly<Record<string, HostValue>>): boolean =>
	Arr.every(Rec.toEntries(where), ([k, x]) => fact[k] === x)

/** The empty selector, which every fact holds. */
export const everyFact: Readonly<Record<string, HostValue>> = {}

/** Spans in the order of their starts. */
const byStart: Order.Order<Span> = Order.mapInput(Order.Number, (t: Span) => t.start)

/** Whether the union of `spans` covers `s`. */
const coveredBy = (s: Span, spans: ReadonlyArray<Span>): boolean => {
	let reached = s.start
	for (const t of Arr.sort(spans, byStart)) {
		if (t.start > reached) {
			break
		}
		if (t.end > reached) {
			reached = t.end
		}
		if (reached >= s.end) {
			return true
		}
	}
	return reached >= s.end
}

/**
 * Whether two facts of a relation collide under a key-like law: equal at a key's or a unique index's fields, or equal
 * at a span key's scalars with overlapping spans.
 */
export const collide = (law: HostLaw, a: HostFact, b: HostFact): boolean => {
	if (law.kind === "key" || law.kind === "unique") {
		return projection(a, law.fields) === projection(b, law.fields)
	}
	if (law.kind === "spanKey") {
		return (
			projection(a, law.scalars) === projection(b, law.scalars) &&
			overlaps(spanOf(a, law.span), spanOf(b, law.span))
		)
	}
	return false
}

/** One relation's facts after a stratum's members of it, `mine`, over its facts before, `current`. */
const relationAfter = (
	relation: HostRelation,
	current: ReadonlyArray<HostFact>,
	mine: ReadonlyArray<HostOp>
): ReadonlyArray<HostFact> => {
	const writes = Arr.filter(mine, (o) => o.kind !== "delete")
	const puts = Arr.filter(mine, (o) => o.kind === "put")
	const deletes = Arr.filter(mine, (o) => o.kind === "delete")
	const added = new Map(
		Arr.flatMap(writes, (o) => Arr.map(o.facts, (f) => [identity(relation, f), f] as const))
	)
	/** A put deletes the current occupants at its facts' keys. */
	const putKeys = new Set(
		Arr.flatMap(puts, (o) => Arr.map(o.facts, (f) => projection(f, relation.key)))
	)
	const deleted = new Set([
		...Arr.flatMap(deletes, (o) => Arr.map(o.facts, (f) => identity(relation, f))),
		...Arr.map(
			Arr.filter(current, (f) => putKeys.has(projection(f, relation.key))),
			(f) => identity(relation, f)
		)
	])
	const out = new Map(
		Arr.map(
			Arr.filter(current, (f) => !deleted.has(identity(relation, f))),
			(f) => [identity(relation, f), f] as const
		)
	)
	for (const [id, f] of added) {
		out.set(id, f)
	}
	return [...out.values()]
}

/** The add-wins transition of one stratum of enumerated members. */
export const transition = (
	schema: HostSchema,
	state: HostState,
	ops: ReadonlyArray<HostOp>
): HostState =>
	new Map(
		Arr.map(schema.relations, (relation) => [
			relation.name,
			relationAfter(
				relation,
				factsIn(state, relation.name),
				Arr.filter(ops, (o) => o.relation === relation.name)
			)
		])
	)

/**
 * What a law's witness names a violating fact by: nothing, for a native violation PostgreSQL reports only in prose, or
 * the facts of one relation by one of its keys.
 */
export type Witnessed =
	| { readonly kind: "unnamed" }
	| { readonly kind: "keyed"; readonly relation: string; readonly key: ReadonlyArray<string> }

const sameFields = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (f) => b.includes(f))

/** A relation's declared keys: its primary key, and every key and span key a law states on it. */
const declaredKeys = (
	schema: HostSchema,
	relation: string
): ReadonlyArray<ReadonlyArray<string>> => [
	relationOf(schema, relation).key,
	...Arr.flatMap(schema.laws, (l): ReadonlyArray<ReadonlyArray<string>> => {
		if (l.kind === "key" && l.relation === relation) {
			return [l.fields]
		}
		if (l.kind === "spanKey" && l.relation === relation) {
			return [[...l.scalars, l.span]]
		}
		return []
	})
]

/**
 * A residual law's witness: the facts of the relation its function names, by the law's own fields there when they are
 * a declared key of it, else by its primary key, as the law model keys the DETAIL (laws/model/plan.ts detailOf).
 */
const residualWitness = (
	schema: HostSchema,
	relation: string,
	fields: ReadonlyArray<string>
): Witnessed => ({
	kind: "keyed",
	relation,
	key: Arr.some(declaredKeys(schema, relation), (k) => sameFields(k, fields))
		? fields
		: relationOf(schema, relation).key
})

/**
 * A key's or a span key's witness names the refused fact by the law's own key fields, as a write statement's refusal
 * raises them (packages/engine/src/write/refusal.ts): a candidate key's by its fields, never by the primary key.
 */
export const witnessOf = (schema: HostSchema, law: HostLaw): Witnessed => {
	switch (law.kind) {
		case "key":
		case "unique":
			return { kind: "keyed", relation: law.relation, key: law.fields }
		case "spanKey":
			return { kind: "keyed", relation: law.relation, key: [...law.scalars, law.span] }
		case "check":
			return { kind: "unnamed" }
		case "contained":
			return law.residual
				? residualWitness(schema, law.source.relation, law.source.fields)
				: { kind: "unnamed" }
		case "covered":
			return law.residual
				? residualWitness(schema, law.source.relation, [...law.source.fields, law.span.source])
				: { kind: "unnamed" }
		case "obliged":
			return residualWitness(schema, law.anchor.relation, law.anchor.fields)
		case "capacity":
			return residualWitness(schema, law.target.relation, law.target.fields)
	}
}

/**
 * Whether a residual law's witness names the facts of a relation that another residual law's witness names by another
 * key of one arity: each law's DETAIL is then read by its own codec alone, never its sibling's.
 */
export const sharesWitnessRelation = (schema: HostSchema, law: HostLaw): boolean => {
	const w = witnessOf(schema, law)
	if (!isResidual(law) || w.kind === "unnamed") {
		return false
	}
	return Arr.some(schema.laws, (other) => {
		if (other.law === law.law || !isResidual(other)) {
			return false
		}
		const o = witnessOf(schema, other)
		return (
			o.kind === "keyed" &&
			o.relation === w.relation &&
			o.key.length === w.key.length &&
			!sameFields(o.key, w.key)
		)
	})
}

/** The violating facts `bad` of `law`, each named as the law's witness names it; none for a native violation. */
export const violatorsOf = (
	schema: HostSchema,
	law: HostLaw,
	bad: ReadonlyArray<HostFact>
): ReadonlyArray<Violator> => {
	const witness = witnessOf(schema, law)
	return witness.kind === "unnamed"
		? []
		: Arr.map(bad, (f) => ({ relation: witness.relation, values: valuesAt(f, witness.key) }))
}

/** The violation of one law in `state`, or none when it holds. */
const violationOf = (
	schema: HostSchema,
	state: HostState,
	law: HostLaw
): Option.Option<Violation> => {
	/** The violation of `bad`, its facts named as the law's witness names them. */
	const of = (bad: ReadonlyArray<HostFact>): Option.Option<Violation> =>
		bad.length === 0
			? Option.none()
			: Option.some({
					law: law.law,
					immediate: isImmediate(law),
					violators: violatorsOf(schema, law, bad)
				})
	switch (law.kind) {
		case "key":
		case "spanKey": {
			const facts = factsIn(state, law.relation)
			const bad = Arr.filter(facts, (f, i) =>
				Arr.some(facts, (g, j) => i !== j && collide(law, f, g))
			)
			return of(bad)
		}
		case "unique": {
			const facts = Arr.filter(factsIn(state, law.relation), (f) => selected(f, law.where))
			const bad = Arr.filter(facts, (f, i) =>
				Arr.some(facts, (g, j) => i !== j && collide(law, f, g))
			)
			return of(bad)
		}
		case "check": {
			const bad = Arr.filter(factsIn(state, law.relation), (f) => !law.holds(f))
			return of(bad)
		}
		case "contained": {
			const targets = new Set(
				Arr.map(
					Arr.filter(factsIn(state, law.target.relation), (f) => selected(f, law.target.where)),
					(f) => projection(f, law.target.fields)
				)
			)
			const bad = Arr.filter(
				factsIn(state, law.source.relation),
				(f) => selected(f, law.source.where) && !targets.has(projection(f, law.source.fields))
			)
			return of(bad)
		}
		case "covered": {
			const targets = Arr.filter(factsIn(state, law.target.relation), (f) =>
				selected(f, law.target.where)
			)
			const bad = Arr.filter(factsIn(state, law.source.relation), (f) => {
				if (!selected(f, law.source.where)) {
					return false
				}
				const at = projection(f, law.source.fields)
				const spans = Arr.map(
					Arr.filter(targets, (t) => projection(t, law.target.fields) === at),
					(t) => spanOf(t, law.span.target)
				)
				return !coveredBy(spanOf(f, law.span.source), spans)
			})
			return of(bad)
		}
		case "obliged": {
			const dependents = new Set(
				Arr.map(
					Arr.filter(factsIn(state, law.dependent.relation), (f) =>
						selected(f, law.dependent.where)
					),
					(f) => projection(f, law.dependent.fields)
				)
			)
			const bad = Arr.filter(
				factsIn(state, law.anchor.relation),
				(f) => selected(f, law.anchor.where) && !dependents.has(projection(f, law.anchor.fields))
			)
			return of(bad)
		}
		case "capacity": {
			const totals = new Map<string, bigint>()
			for (const f of Arr.filter(factsIn(state, law.source.relation), (fact) =>
				selected(fact, law.source.where)
			)) {
				const k = projection(f, law.source.fields)
				totals.set(k, (totals.get(k) ?? 0n) + weightOf(law.weight, f))
			}
			const bound = (b: HostBound, f: HostFact): bigint =>
				typeof b === "bigint" ? b : integer(f, b.ref)
			const bad = Arr.filter(factsIn(state, law.target.relation), (f) => {
				if (!selected(f, law.target.where)) {
					return false
				}
				const n = totals.get(projection(f, law.target.fields)) ?? 0n
				return n < bound(law.low, f) || (law.high !== "*" && n > bound(law.high, f))
			})
			return of(bad)
		}
	}
}

/**
 * The brute-force side of the law-bearing generated suites: over law-bearing generated schemas, an outcome is accepted
 * iff the brute-force evaluation of every violation query on the final state is empty.
 *
 * A family's schema is described to the host independently of the compiler: its relations with their primary keys,
 * and every law it declares as a violation query over a state. The laws are those the law model lowers, each read
 * from its statement's meaning, never from the compiler's law model:
 *
 * - `key`: a primary or candidate key, immediate; two facts at one value of its fields are a violation;
 * - `unique`: a unique index, immediate; two facts its selector admits at one value of its fields are a violation;
 * - `spanKey`: a span key, immediate; two facts equal on its scalar fields whose spans overlap are a violation (spans
 *   are half-open, so adjacent spans do not overlap);
 * - `check`: a row check, immediate; a fact the predicate refuses is a violation, reported natively without a key;
 * - `contained`: every source fact, among those its selector admits, has a target fact, among those the target's
 *   selector admits, equal on the paired fields (contained, the child half of mirrors and of alternatives' arms);
 * - `covered`: every source fact its selector admits has its span covered by the union of the spans of the target
 *   facts its selector admits that equal it on the paired scalar fields, fragments included (a span coverage law);
 * - `obliged`: every anchor fact its selector admits has a dependent fact equal on the paired fields (the reverse half
 *   of a conditional mirrors, and of alternatives for each armed handle);
 * - `capacity`: every target fact its selector admits has a group, the source facts its selector admits that equal it
 *   on the paired fields, whose count, total weight or total span width lies within the bounds, each a literal or a
 *   field of the target fact; an empty group counts zero and weighs zero, and a source fact no target fact groups is
 *   in no group, lawful unless a containment of its own requires its target. Every law is judged on the final state,
 *   so a target added beside sources already at its values is judged on that group.
 *
 * A ChangeSet of enumerated members is one add-wins transition S' = (S \ D) ∪ A, with put the deletion of the current
 * occupants at its facts' keys plus their insertion. Its outcome follows from S': a violation of an immediate law (a
 * key, a span key, a row check) is refused with that law, raised at its statement before any deferred law; otherwise a
 * violation of any other law is refused with one of the violated laws; otherwise it is accepted, or no-change when S'
 * is S. A refusal's witness names a violating fact by a key: the source fact of a selected-source containment or
 * coverage, the anchor of an obligation, the target of a capacity, each by the law's own fields when they are a key of
 * that relation and by its primary key otherwise, as the law function's DETAIL names it; a key's violation by the
 * relation's primary key; any other native violation, whose key PostgreSQL reports only in prose, carries none.
 *
 * Every law's violation query over `state`.
 */
export const violations = (schema: HostSchema, state: HostState): ReadonlyArray<Violation> => {
	const out = Arr.flatMap(schema.laws, (law) => Option.toArray(violationOf(schema, state, law)))
	/** Two laws of one identity (alternatives' obligation per armed handle) are one law: their violators merge. */
	const merged = new Map<string, Violation>()
	for (const v of out) {
		const prior = merged.get(v.law)
		merged.set(
			v.law,
			prior === undefined ? v : { ...prior, violators: [...prior.violators, ...v.violators] }
		)
	}
	return [...merged.values()]
}

/** A state's rows, relation by relation in schema order, each fact its fields' output texts in heading order. */
export type StateRows = ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>

export const stateRows = (schema: HostSchema, state: HostState): StateRows =>
	Arr.map(schema.relations, (r) =>
		Arr.map(factsIn(state, r.name), (f) =>
			Arr.map(r.fields, (x) => valueText(fieldValue(f, x.name)))
		)
	)

/** The difference between two states' rows, none when every relation holds the same rows, in any order. */
export const rowsDifference: Equivalence<StateRows> = ordered(multiset(ordered(exact)))

/** A row's order: its value texts, field by field. */
const rowOrder: Order.Order<ReadonlyArray<string>> = Arr.makeOrder(Order.String)

/** The order of two states' sorted rows (sortedStateRows): relation by relation, row by row. */
export const sortedRowsOrder: Order.Order<StateRows> = Arr.makeOrder(Arr.makeOrder(rowOrder))

/**
 * A state's rows up to the order of its facts, each relation's rows (stateRows) sorted: two states are one exactly when
 * sortedRowsOrder ranks their sorted rows equal.
 */
export const sortedStateRows = (schema: HostSchema, state: HostState): StateRows =>
	Arr.map(stateRows(schema, state), (rows) => Arr.sort(rows, rowOrder))

/** Whether two states are one: every relation holds the same rows, in any order. */
export const sameState = (schema: HostSchema, a: HostState, b: HostState): boolean =>
	Option.isNone(rowsDifference(stateRows(schema, a), stateRows(schema, b)))

/**
 * Whether a law is a coverage whose target names its fields apart from its source's: a span field of another name, or
 * a scalar paired with one of another name, so only the fields' positions in the two lists pair them.
 */
export const isRenamedCoverage = (law: HostLaw): boolean =>
	law.kind === "covered" &&
	(law.span.source !== law.span.target ||
		Arr.some(law.source.fields, (f, i) => f !== law.target.fields[i]))

/**
 * Whether a law is a coverage into the target facts a selector picks: a tagged PERIOD foreign key, its source
 * unselected (a containment admits at most one selected side).
 */
export const isSelectedTargetCoverage = (law: HostLaw): boolean =>
	law.kind === "covered" && Rec.keys(law.target.where).length > 0

/**
 * Whether a law is a candidate span key: a span key beside its relation's primary key, the UNIQUE ... WITHOUT OVERLAPS
 * form.
 */
export const isCandidateSpanKey = (host: HostSchema, law: HostLaw): boolean => {
	if (law.kind !== "spanKey") {
		return false
	}
	const fields = [...law.scalars, law.span]
	return Arr.some(
		host.relations,
		(r) =>
			r.name === law.relation &&
			(r.key.length !== fields.length || Arr.some(r.key, (f, i) => f !== fields[i]))
	)
}

/**
 * Whether `state` holds two facts a span key law judges on unequal spans that overlap, and no two on equal ones: a
 * refusal only a candidate span key's WITHOUT OVERLAPS explains, which a plain UNIQUE over the same fields would admit.
 */
export const overlapsUnequally = (state: HostState, law: HostLaw): boolean => {
	if (law.kind !== "spanKey") {
		return false
	}
	const facts = factsIn(state, law.relation)
	const pairs = Arr.flatMap(facts, (a, i) =>
		Arr.flatMap(facts.slice(i + 1), (b) => {
			const x = a[law.span]
			const y = b[law.span]
			if (x === undefined || y === undefined || !isSpan(x) || !isSpan(y)) {
				return []
			}
			if (!Arr.every(law.scalars, (f) => sameValue(a[f], b[f]))) {
				return []
			}
			return x.start < y.end && y.start < x.end ? [x.start === y.start && x.end === y.end] : []
		})
	)
	return pairs.length > 0 && Arr.every(pairs, (equal) => !equal)
}

/** What a ChangeSet of `ops` must do from the lawful `state`. */
export const expect = (
	schema: HostSchema,
	state: HostState,
	ops: ReadonlyArray<HostOp>
): Expected => {
	const next = transition(schema, state, ops)
	const all = violations(schema, next)
	const immediate = Arr.filter(all, (v) => v.immediate)
	if (immediate.length > 0) {
		return { kind: "invariant-rejected", violations: immediate }
	}
	if (all.length > 0) {
		return { kind: "invariant-rejected", violations: all }
	}
	return { kind: sameState(schema, state, next) ? "no-change" : "accepted", state: next }
}
