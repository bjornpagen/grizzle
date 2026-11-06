import { type Equivalence, exact, ordered, set } from "@grizzle/testing/oracle"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
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
	/**
	 * Whether the relation is declared `mutable`: its writers hold UPDATE on it, and grizzle's put replaces a fact in
	 * place; an immutable relation's UPDATE is refused by privilege, and a put is its DELETE-then-insert pair.
	 */
	readonly mutable: boolean
}

/**
 * Which facts of its relation a law side reads: every one, or those its row predicate holds of, the predicate the
 * grizzle side's select states over a fact's own fields. `pinned` is a fact's values at the fields the predicate reads
 * that it holds of, which a fact drawn for the side takes there.
 */
export type HostSelection =
	| { readonly kind: "every" }
	| {
			readonly kind: "where"
			readonly holds: (fact: HostFact) => boolean
			readonly pinned: HostFact
	  }

/** The selection of every fact. */
export const everyFact: HostSelection = { kind: "every" }

/**
 * The selection of the facts whose every listed field holds one of its values, the first value of each the one a drawn
 * fact takes: select(R, (r) => r.and(r.in(r.f, values), ...)).
 */
export const fieldsIn = (
	values: Readonly<Record<string, Arr.NonEmptyReadonlyArray<HostValue>>>
): HostSelection => ({
	kind: "where",
	holds: (fact) =>
		Arr.every(Rec.toEntries(values), ([field, admitted]) =>
			Arr.some(admitted, (x) => sameValue(fact[field], x))
		),
	pinned: Rec.map(values, (admitted) => admitted[0])
})

/** The selection of the facts whose fields hold these values: select(R, (r) => r.and(r.eq(r.f, v), ...)). */
export const fieldsEqual = (values: Readonly<Record<string, HostValue>>): HostSelection =>
	fieldsIn(Rec.map(values, (v): Arr.NonEmptyReadonlyArray<HostValue> => [v]))

/** Whether a selection holds of a fact. */
export const selected = (fact: HostFact, selection: HostSelection): boolean =>
	selection.kind === "every" || selection.holds(fact)

/** The values a fact drawn for a selection takes to be selected: none for every fact. */
export const pinned = (selection: HostSelection): HostFact =>
	selection.kind === "every" ? {} : selection.pinned

/** A side of a law: a relation, its paired fields in pair order, and the facts it reads. */
export interface HostSide {
	readonly relation: string
	readonly fields: ReadonlyArray<string>
	readonly selection: HostSelection
}

export type HostLaw =
	| {
			/**
			 * A key over a side: no two facts its selection reads agree on its fields. A primary or candidate key reads
			 * every fact; a projected key, key(on(select(R, φ), ...)), only those φ holds of, and a put displaces no
			 * occupant by it.
			 */
			readonly kind: "key"
			readonly law: LawId
			readonly relation: string
			readonly fields: ReadonlyArray<string>
			readonly selection: HostSelection
	  }
	| {
			/**
			 * A span key over a side: no two facts its selection reads agree on its scalars with overlapping spans. A
			 * primary or candidate span key reads every fact; a projected one, key(on(select(R, φ), ..., span)), only those
			 * φ holds of, as the key over a coverage's selected target its PERIOD foreign key references.
			 */
			readonly kind: "spanKey"
			readonly law: LawId
			readonly relation: string
			readonly scalars: ReadonlyArray<string>
			readonly span: string
			readonly selection: HostSelection
	  }
	| {
			readonly kind: "check"
			readonly law: LawId
			readonly relation: string
			readonly holds: (fact: HostFact) => boolean
	  }
	| {
			/**
			 * A native foreign key, from the source's columns or its selected side's law columns: its violation names no
			 * fact. Both directions of alternatives are containments (fin.md §7): an arm's key in its parent selected by
			 * its handles, and the parent selected by a handle in that handle's arm.
			 */
			readonly kind: "contained"
			readonly law: LawId
			readonly source: HostSide
			readonly target: HostSide
	  }
	| {
			/**
			 * A PERIOD foreign key, over a selected side's range law columns where it has one (fin.md §7): its violation
			 * names no fact.
			 */
			readonly kind: "covered"
			readonly law: LawId
			/** The paired scalar fields of each side; `span` names each side's span field. */
			readonly source: HostSide
			readonly target: HostSide
			readonly span: { readonly source: string; readonly target: string }
	  }

/**
 * What one fact of a law's referring side needs of its referred side: a containment's or a coverage's source a target
 * fact at its values (a coverage's at its scalars and its span).
 */
export const needs = (
	law: HostLaw
): ReadonlyArray<{ readonly from: HostSide; readonly to: HostSide }> => {
	switch (law.kind) {
		case "key":
		case "spanKey":
		case "check":
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
	}
}

export interface HostSchema {
	readonly relations: ReadonlyArray<HostRelation>
	readonly laws: ReadonlyArray<HostLaw>
}

/** Whether `to` reaches `from` along the relations the schema's containments and coverages point at. */
const reaches = (schema: HostSchema, to: string, from: string): boolean => {
	const seen = new Set<string>()
	const walk = (at: string): boolean => {
		if (at === from) {
			return true
		}
		if (seen.has(at)) {
			return false
		}
		seen.add(at)
		return Arr.some(schema.laws, (l) =>
			l.kind === "contained" || l.kind === "covered"
				? l.source.relation === at && walk(l.target.relation)
				: false
		)
	}
	return walk(to)
}

/**
 * Whether a law is checked at the statement that breaks it: a key, a span key, a row check, and a containment whose
 * foreign key is immediate, one into an unselected target it references whole, every field of the target among the
 * fields it pairs, and on no cycle of containments, so no lawful ChangeSet replaces the referenced row in passing. A
 * coverage's PERIOD foreign key references its target's span as a period, never as a plain column, and is deferred.
 */
export const isImmediate = (schema: HostSchema, law: HostLaw): boolean => {
	switch (law.kind) {
		case "key":
		case "spanKey":
		case "check":
			return true
		case "covered":
			return false
		case "contained":
			return (
				law.target.selection.kind === "every" &&
				Arr.every(relationOf(schema, law.target.relation).fields, (f) =>
					law.target.fields.includes(f.name)
				) &&
				!reaches(schema, law.target.relation, law.source.relation)
			)
	}
}

/** A containment, the one law kind whose sides pair plain fields. */
export type HostContainment = Extract<HostLaw, { readonly kind: "contained" }>

/**
 * Whether a law is a containment or a coverage from a selected source: its source lowers to law columns, `CASE WHEN φ
 * THEN f END STORED`, read by a MATCH SIMPLE foreign key (fin.md §5.1), so a fact outside the selection is never
 * judged. The reverse direction of alternatives is one, per armed handle (§7).
 */
export const fromSelected = (law: HostLaw): boolean =>
	(law.kind === "contained" || law.kind === "covered") && law.source.selection.kind === "where"

/** Whether a law is a containment from a selected source (fromSelected), narrowed to its arm. */
export const isSelectedContainment = (law: HostLaw): law is HostContainment =>
	law.kind === "contained" && law.source.selection.kind === "where"

/** The relations a law reads: what its native constraint checks. */
export const lawRelations = (law: HostLaw): ReadonlyArray<string> => {
	switch (law.kind) {
		case "key":
		case "spanKey":
		case "check":
			return [law.relation]
		case "contained":
		case "covered":
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
 * Whether two facts of a relation collide under a key-like law: equal at a key's fields, or equal
 * at a span key's scalars with overlapping spans.
 */
export const collide = (law: HostLaw, a: HostFact, b: HostFact): boolean => {
	if (law.kind === "key") {
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

/**
 * One relation's facts after a stratum's members of it, `mine`, over its facts before, `current`: a ChangeSet's facts
 * are a set by identity, so identical facts stated twice, in one member or across members, are one fact, and two facts
 * that share a key with different identities both stay, for the relation's key law to refuse.
 */
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

/**
 * A key's or a span key's witness names the refused fact by the law's own key fields, as a write statement's refusal
 * raises them (packages/engine/src/write/refusal.ts): a candidate key's by its fields, never by the primary key.
 */
export const witnessOf = (law: HostLaw): Witnessed => {
	switch (law.kind) {
		case "key":
			return { kind: "keyed", relation: law.relation, key: law.fields }
		case "spanKey":
			return { kind: "keyed", relation: law.relation, key: [...law.scalars, law.span] }
		case "check":
		case "contained":
		case "covered":
			return { kind: "unnamed" }
	}
}

/** The violating facts `bad` of `law`, each named as the law's witness names it; none for a native violation. */
export const violatorsOf = (
	law: HostLaw,
	bad: ReadonlyArray<HostFact>
): ReadonlyArray<Violator> => {
	const witness = witnessOf(law)
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
					immediate: isImmediate(schema, law),
					violators: violatorsOf(law, bad)
				})
	switch (law.kind) {
		case "key": {
			const facts = Arr.filter(factsIn(state, law.relation), (f) => selected(f, law.selection))
			const bad = Arr.filter(facts, (f, i) =>
				Arr.some(facts, (g, j) => i !== j && collide(law, f, g))
			)
			return of(bad)
		}
		case "spanKey": {
			const facts = Arr.filter(factsIn(state, law.relation), (f) => selected(f, law.selection))
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
					Arr.filter(factsIn(state, law.target.relation), (f) => selected(f, law.target.selection)),
					(f) => projection(f, law.target.fields)
				)
			)
			const bad = Arr.filter(
				factsIn(state, law.source.relation),
				(f) => selected(f, law.source.selection) && !targets.has(projection(f, law.source.fields))
			)
			return of(bad)
		}
		case "covered": {
			const targets = Arr.filter(factsIn(state, law.target.relation), (f) =>
				selected(f, law.target.selection)
			)
			const bad = Arr.filter(factsIn(state, law.source.relation), (f) => {
				if (!selected(f, law.source.selection)) {
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
	}
}

/** Whether two field lists name the same fields, each once, in any order. */
const sameFieldSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	new Set(a).size === a.length &&
	new Set(b).size === b.length &&
	new Set([...a, ...b]).size === a.length

/**
 * The law a schema states for a relation's primary key: a key over exactly its key's fields that reads every fact, or a
 * span key whose scalars and span are its key's fields; none when the schema states neither.
 */
const primaryKeyLawOf = (schema: HostSchema, relation: HostRelation): HostLaw | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(
			schema.laws,
			(law) =>
				(law.kind === "key" &&
					law.relation === relation.name &&
					law.selection.kind === "every" &&
					sameFieldSet(law.fields, relation.key)) ||
				(law.kind === "spanKey" &&
					law.relation === relation.name &&
					law.selection.kind === "every" &&
					sameFieldSet([...law.scalars, law.span], relation.key))
		)
	)

/**
 * The relations of a schema with a key whose primary key no law states. A relation's key is one of its laws: two facts
 * at one key, an exact repeat of one fact included, violate it, so a state that holds a fact twice is a violation the
 * host names, never a state its laws pass.
 */
const unkeyedRelations = (schema: HostSchema): ReadonlyArray<string> =>
	Arr.flatMap(schema.relations, (r) =>
		r.key.length > 0 && primaryKeyLawOf(schema, r) === undefined ? [r.name] : []
	)

/** A host schema whose every keyed relation states its primary key's law; any other is a defect of the harness. */
export const keyedSchema = (schema: HostSchema): HostSchema => {
	const unkeyed = unkeyedRelations(schema)
	if (Arr.isReadonlyArrayNonEmpty(unkeyed)) {
		throw new Error(
			`the host states no law for the primary key of ${Arr.join(unkeyed, ", ")}: without it a state holding a fact twice breaks no law`
		)
	}
	return schema
}

/**
 * The brute-force side of the law-bearing generated suites: over law-bearing generated schemas, an outcome is accepted
 * iff the brute-force evaluation of every violation query on the final state is empty.
 *
 * A family's schema is described to the host independently of the compiler: its relations with their primary keys,
 * and every law it declares as a violation query over a state. The laws are those the law model lowers, each read
 * from its statement's meaning, never from the compiler's law model:
 *
 * - `key`: a primary, candidate or projected key, immediate; two facts its selection reads at one value of its fields
 *   are a violation;
 * - `spanKey`: a primary, candidate or projected span key, immediate; two facts its selection reads equal on its scalar
 *   fields whose spans overlap are a violation (spans are half-open, so adjacent spans do not overlap);
 * - `check`: a row check, immediate; a fact the predicate refuses is a violation, reported natively without a key;
 * - `contained`: every source fact, among those its selector admits, has a target fact, among those the target's
 *   selector admits, equal on the paired fields (contained, either half of mirrors, and both directions of
 *   alternatives: each arm in its parent selected by its handles, and the parent selected by each armed handle in that
 *   handle's arm);
 * - `covered`: every source fact its selector admits has its span covered by the union of the spans of the target
 *   facts its selector admits that equal it on the paired scalar fields, fragments included (a span coverage law, a
 *   PERIOD foreign key).
 *
 * Every law is native (fin.md §7, "The residual families after Fin"): grizzle installs no law function and no
 * constraint trigger, so no refusal carries a DETAIL naming a fact but a key's.
 *
 * A ChangeSet of enumerated members is one add-wins transition S' = (S \ D) ∪ A, with put the deletion of the current
 * occupants at its facts' keys plus their insertion. Its outcome follows from S': a violation of an immediate law (a
 * key, a span key, a row check, a containment into a target it references whole, isImmediate) is refused with one of
 * the immediate laws violated, raised at its statement before any deferred law; otherwise a
 * violation of any other law is refused with one of the violated laws; otherwise it is accepted, or no-change when S'
 * is S. A key's or a span key's refusal names the violating facts by the law's own fields (witnessOf); every other
 * native violation, whose key PostgreSQL reports only in prose, carries none.
 *
 * Every law's violation query over `state`.
 */
export const violations = (schema: HostSchema, state: HostState): ReadonlyArray<Violation> => {
	const out = Arr.flatMap(schema.laws, (law) => Option.toArray(violationOf(schema, state, law)))
	/** Two statements of one law identity are one law (a restated containment): their violators merge. */
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

/**
 * The difference between two states' rows, none when every relation holds the same rows, in any order, each once: a
 * relation holds each fact once, so a repeated row on either side is a difference.
 */
export const rowsDifference: Equivalence<StateRows> = ordered(set(ordered(exact)))

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
	law.kind === "covered" && law.target.selection.kind === "where"

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
	const facts = Arr.filter(factsIn(state, law.relation), (f) => selected(f, law.selection))
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

/**
 * What a ChangeSet of `ops` must do from the lawful `state`. Every relation's primary key is one of the schema's laws
 * (keyedSchema), so a state holding one fact twice is always that key's violation, never an outcome the laws pass.
 */
export const expect = (
	schema: HostSchema,
	state: HostState,
	ops: ReadonlyArray<HostOp>
): Expected => {
	const next = transition(keyedSchema(schema), state, ops)
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
