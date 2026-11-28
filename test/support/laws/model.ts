import { type Equivalence, exact, ordered, set, structuralHash } from "@bjornpagen/testing/oracle"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import {
	type OrderMember,
	type OrderSchema,
	type StratumOrder,
	stratumOrder,
	unorderable
} from "#test/support/stratum-order.ts"

/**
 * A span, half-open [start, end) with start < end. Every span is built start first, so two equal spans have one text.
 */
export interface Span {
	readonly start: number
	readonly end: number
}

export type HostValue = number | boolean | string | Span
export type HostFact = Readonly<Record<string, HostValue>>

export const hostSpan = (start: number, end: number): Span => ({ start, end })

/** Whether a value is a span. */
export const isSpan = (x: HostValue): x is Span => typeof x === "object" && "start" in x

/** A value as PostgreSQL's output function spells it: a span as int4range's canonical text. */
export const valueText = (x: HostValue): string =>
	typeof x !== "object" ? String(x) : `[${x.start},${x.end})`

const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end

/** Whether two values are one value: spans by their endpoints, every other value as itself. */
export const sameValue = (a: HostValue | undefined, b: HostValue | undefined): boolean =>
	a === undefined || b === undefined ? a === b : valueText(a) === valueText(b)

/**
 * A value as PostgreSQL spells it, whether a host value or one grizzle decoded into a witness, whose span endpoints may
 * be bigints. An object that is no span is no value, a defect of whoever handed it over.
 */
const anyText = (x: unknown): string => {
	if (typeof x !== "object" || x === null) {
		return String(x)
	}
	if ("start" in x && "end" in x) {
		return `[${String(x.start)},${String(x.end)})`
	}
	throw new Error("a value that is no span, which PostgreSQL spells no way")
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
 * fact takes: select(R, (r) => r.and([r.in(r.f, values), ...])).
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

/** The selection of the facts whose fields hold these values: select(R, (r) => r.and([r.eq(r.f, v), ...])). */
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
			 * fact. Both directions of a tagged header's arm are containments (fin.md §7): an arm's key in its parent
			 * selected by its handles, and the parent selected by a handle in that handle's arm.
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

/**
 * Relation name to its facts, each relation's a set by identity (docs/reads-and-writes.md "A relation's rows are a set"): no two of its
 * facts hold one value at every field. A state the laws admit is one, every relation keyed by a law (keyedSchema), and
 * a transition keeps it one.
 */
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
	/** The facts a witness may name; empty for a foreign key's violation, whose witness carries no key. */
	readonly violators: ReadonlyArray<Violator>
	/**
	 * A deferred containment's or coverage's source facts its target leaves unmatched, by the source's primary key: the
	 * rows its refusal at COMMIT may be witnessed by, which the diagnosis flight reads where the role writes the source
	 * and the target whole and the write changes the source (docs/errors-and-concurrency.md "Errors and outcomes", Witness), or none of them;
	 * empty for every other law.
	 */
	readonly unmatched: ReadonlyArray<Violator>
}

/**
 * What a ChangeSet of one stratum must do: commit, changing the state or not; be refused by the laws its final state
 * violates; or be refused when it compiles, before any SQL and whatever the state, since its writes `order` requires
 * run in a cycle (UnorderableStratum).
 */
export type Expected =
	| { readonly kind: "accepted" | "no-change"; readonly state: HostState }
	| { readonly kind: "invariant-rejected"; readonly violations: ReadonlyArray<Violation> }
	| { readonly kind: "unorderable"; readonly order: StratumOrder }

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

/** A fact of a relation beside its identity, read once. */
interface Identified {
	readonly fact: HostFact
	readonly id: string
}

/**
 * Whether two facts of `relation` collide at its primary key: equal at its fields, or, where the schema states it as a
 * span key, equal at its scalars with overlapping spans (`collide`), which its WITHOUT OVERLAPS refuses together.
 */
const primaryCollision = (
	schema: HostSchema,
	relation: HostRelation
): ((a: HostFact, b: HostFact) => boolean) =>
	Option.match(
		Arr.findFirst(
			schema.laws,
			(law) =>
				law.kind === "spanKey" &&
				law.relation === relation.name &&
				law.selection.kind === "every" &&
				Arr.join(Arr.sort([...law.scalars, law.span], Order.String), "\u0000") ===
					Arr.join(Arr.sort(relation.key, Order.String), "\u0000")
		),
		{
			onNone: () => (a: HostFact, b: HostFact) =>
				projection(a, relation.key) === projection(b, relation.key),
			onSome: (law) => (a: HostFact, b: HostFact) => collide(law, a, b)
		}
	)

/**
 * One relation's facts after a stratum's members of it, `mine`, over its facts before, `current`, each fact identified
 * once: a ChangeSet's facts are a set by identity, so identical facts stated twice, in one member or across members, are
 * one fact, and two facts that share a key with different identities both stay, for the relation's key law to refuse.
 * A put deletes every current occupant its facts collide with at the primary key (`primaryCollision`): at a span key
 * each of its scalars whose span overlaps a fact's. The additions join the state its removals leave.
 */
const relationAfter = (
	schema: HostSchema,
	relation: HostRelation,
	current: ReadonlyArray<HostFact>,
	mine: ReadonlyArray<HostOp>
): ReadonlyArray<HostFact> => {
	const identified = (fact: HostFact): Identified => ({ fact, id: identity(relation, fact) })
	const before = Arr.map(current, identified)
	const writes = Arr.filter(mine, (o) => o.kind !== "delete")
	const puts = Arr.flatMap(mine, (o) => (o.kind === "put" ? o.facts : []))
	const deletes = Arr.filter(mine, (o) => o.kind === "delete")
	const added = Arr.flatMap(writes, (o) => o.facts)
	const collides = primaryCollision(schema, relation)
	const deleted = new Set([
		...Arr.flatMap(deletes, (o) => Arr.map(o.facts, (f) => identity(relation, f))),
		...Arr.map(
			Arr.filter(before, (b) => Arr.some(puts, (f) => collides(b.fact, f))),
			(b) => b.id
		)
	])
	const out = new Map(
		Arr.map(
			Arr.filter(before, (b) => !deleted.has(b.id)),
			(b) => [b.id, b.fact] as const
		)
	)
	for (const fact of added) {
		out.set(identity(relation, fact), fact)
	}
	return [...out.values()]
}

/**
 * The add-wins transition of one stratum of enumerated members: each relation a member names, rewritten
 * (relationAfter), and every other one as it stands, already the set a state's relation is (HostState).
 */
export const transition = (
	schema: HostSchema,
	state: HostState,
	ops: ReadonlyArray<HostOp>
): HostState => {
	const named = new Set(Arr.map(ops, (o) => o.relation))
	return new Map(
		Arr.map(schema.relations, (relation) => [
			relation.name,
			named.has(relation.name)
				? relationAfter(
						schema,
						relation,
						factsIn(state, relation.name),
						Arr.filter(ops, (o) => o.relation === relation.name)
					)
				: factsIn(state, relation.name)
		])
	)
}

/**
 * What a law's witness names a violating fact by: nothing, for a native violation PostgreSQL reports only in prose, or
 * the facts of one relation by one of its keys.
 */
export type Witnessed =
	| { readonly kind: "unnamed" }
	| { readonly kind: "keyed"; readonly relation: string; readonly key: ReadonlyArray<string> }

/**
 * A key's or a span key's witness names the refused fact by the law's own key fields, as a write statement's refusal
 * raises them (packages/engine/src/write/refusal.ts): a candidate key's by its fields, never by the primary key. A row
 * check's names the fact that breaks it by its relation's primary key, as the host judges the facts a ChangeSet states
 * (packages/engine/src/runtime/write/witness.ts); a containment's and a coverage's name none.
 */
export const witnessOf = (law: HostLaw, schema: HostSchema): Witnessed => {
	switch (law.kind) {
		case "key":
			return { kind: "keyed", relation: law.relation, key: law.fields }
		case "spanKey":
			return { kind: "keyed", relation: law.relation, key: [...law.scalars, law.span] }
		case "check":
			return { kind: "keyed", relation: law.relation, key: relationOf(schema, law.relation).key }
		case "contained":
		case "covered":
			return { kind: "unnamed" }
	}
}

/** The violating facts `bad` of `law`, each named as the law's witness names it; none for a native violation. */
export const violatorsOf = (
	law: HostLaw,
	bad: ReadonlyArray<HostFact>,
	schema: HostSchema
): ReadonlyArray<Violator> => {
	const witness = witnessOf(law, schema)
	return witness.kind === "unnamed"
		? []
		: Arr.map(bad, (f) => ({ relation: witness.relation, values: valuesAt(f, witness.key) }))
}

/**
 * The violating facts `bad` of a deferred containment or coverage, by their source's primary key (Violation
 * `unmatched`); none of any other law.
 */
const unmatchedOf = (
	law: HostLaw,
	bad: ReadonlyArray<HostFact>,
	schema: HostSchema
): ReadonlyArray<Violator> => {
	if ((law.kind !== "contained" && law.kind !== "covered") || isImmediate(schema, law)) {
		return []
	}
	const source = law.source.relation
	const key = relationOf(schema, source).key
	return Arr.map(bad, (f) => ({ relation: source, values: valuesAt(f, key) }))
}

/**
 * The facts of `facts` another of them shares its values at `fields` with, in their order: a key law's violators, as
 * colliding pairs name them (collide), each fact's key read once.
 */
const sharingAKey = (
	facts: ReadonlyArray<HostFact>,
	fields: ReadonlyArray<string>
): ReadonlyArray<HostFact> => {
	const keyed = Arr.map(facts, (fact) => ({ fact, key: projection(fact, fields) }))
	const counts = new Map<string, number>()
	for (const { key } of keyed) {
		counts.set(key, (counts.get(key) ?? 0) + 1)
	}
	return Arr.flatMap(keyed, ({ fact, key }) => ((counts.get(key) ?? 0) > 1 ? [fact] : []))
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
					violators: violatorsOf(law, bad, schema),
					unmatched: unmatchedOf(law, bad, schema)
				})
	switch (law.kind) {
		case "key": {
			const facts = Arr.filter(factsIn(state, law.relation), (f) => selected(f, law.selection))
			return of(facts.length < 2 ? [] : sharingAKey(facts, law.fields))
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
 * Violations one per law, in the order each law first breaks: two of one law are one violation, its violators both's,
 * whether two statements of one law identity broke it (a restated containment) or a stratum's deletions and its final
 * state did (expect), so a refusal by a law may name any fact either names.
 */
const byLaw = (found: ReadonlyArray<Violation>): ReadonlyArray<Violation> => {
	const merged = new Map<LawId, Violation>()
	for (const v of found) {
		const prior = merged.get(v.law)
		merged.set(
			v.law,
			prior === undefined
				? v
				: {
						...prior,
						violators: Arr.appendAll(prior.violators, v.violators),
						unmatched: Arr.appendAll(prior.unmatched, v.unmatched)
					}
		)
	}
	return [...merged.values()]
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
 *   selector admits, equal on the paired fields (contained, and either half of mirrors: a tagged header's arm in its
 *   parent selected by its handles, and the parent selected by each armed handle in that handle's arm);
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
 * is S. A key's or a span key's refusal names the violating facts by the law's own fields (witnessOf); a deferred
 * containment's or coverage's, refused at COMMIT, may name a source fact it leaves unmatched by its primary key
 * (Violation `unmatched`); every other native violation, whose key PostgreSQL reports only in prose, carries none.
 *
 * Every law's violation query over `state`.
 */
export const violations = (schema: HostSchema, state: HostState): ReadonlyArray<Violation> =>
	byLaw(Arr.flatMap(schema.laws, (law) => Option.toArray(violationOf(schema, state, law))))

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
export const rowsDifference: Equivalence<StateRows> = ordered(set(structuralHash, ordered(exact)))

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
 * A schema as a stratum's order reads it (stratum-order.ts): where each relation's facts meet, at its key where a field
 * lies outside it, else, a pure set's, at another key or a span key of it, else nowhere; and the containments whose
 * foreign key is immediate (isImmediate).
 */
const orderSchemaOf = (schema: HostSchema): OrderSchema => ({
	relations: Arr.map(schema.relations, (r) => {
		const primary = (fields: ReadonlyArray<string>): boolean =>
			fields.length === r.key.length && Arr.every(fields, (f) => r.key.includes(f))
		return {
			name: r.name,
			meeting: !Arr.every(r.fields, (f) => r.key.includes(f.name))
				? "key"
				: Arr.some(
							schema.laws,
							(l) =>
								(l.kind === "key" &&
									l.relation === r.name &&
									!(l.selection.kind === "every" && primary(l.fields))) ||
								(l.kind === "spanKey" && l.relation === r.name)
					  )
					? "unique"
					: "nowhere"
		}
	}),
	references: Arr.flatMap(schema.laws, (l) =>
		l.kind === "contained" && l.source.relation !== l.target.relation && isImmediate(schema, l)
			? [{ from: l.source.relation, to: l.target.relation }]
			: []
	)
})

/** The order a stratum of `ops` takes (stratum-order.ts), each op an enumerated member. */
const orderOf = (schema: HostSchema, ops: ReadonlyArray<HostOp>): StratumOrder =>
	stratumOrder(
		orderSchemaOf(schema),
		Arr.map(ops, (o): OrderMember => ({ relation: o.relation, op: o.kind }))
	)

/**
 * The laws a stratum is refused by, each with the facts its witness may name; none when it commits: the immediate laws
 * its final state breaks, raised at their statements before any deferred law, and otherwise every law it breaks.
 */
export const refusedBy = (all: ReadonlyArray<Violation>): ReadonlyArray<Violation> => {
	const immediate = Arr.filter(all, (v) => v.immediate)
	return Arr.isReadonlyArrayNonEmpty(immediate) ? immediate : all
}

/**
 * What a ChangeSet of one stratum meets of the laws, before whether a commit changes the state is asked: it commits to
 * `state`, is refused by the laws its final state violates, or is refused when it compiles (Expected).
 */
type Judged =
	| { readonly kind: "commits"; readonly state: HostState }
	| Extract<Expected, { readonly kind: "invariant-rejected" | "unorderable" }>

/** What a ChangeSet of `ops` meets of the laws from the lawful `state` (expect), its commit's change unread. */
const judgedOps = (schema: HostSchema, state: HostState, ops: ReadonlyArray<HostOp>): Judged => {
	const order = orderOf(schema, ops)
	if (unorderable(order)) {
		return { kind: "unorderable", order }
	}
	const next = transition(keyedSchema(schema), state, ops)
	const refused = refusedBy(violations(schema, next))
	return Arr.isReadonlyArrayNonEmpty(refused)
		? { kind: "invariant-rejected", violations: refused }
		: { kind: "commits", state: next }
}

/**
 * What a ChangeSet of `ops` must do from the lawful `state`. A stratum whose writes' order (`orderOf`) runs in a
 * cycle is refused when it compiles, before any SQL or host normalization. Every relation's primary key is one of the
 * schema's laws (keyedSchema), so a state holding one fact twice is always that key's violation, never an outcome the
 * laws pass. Two facts a stratum deletes at one key are no refusal: a deletion names its fact exactly, so at most one
 * of them is stored and deleting the other changes nothing (docs/reads-and-writes.md "A relation's rows are a set"), as the transition
 * removes facts by identity.
 */
export const expect = (
	schema: HostSchema,
	state: HostState,
	ops: ReadonlyArray<HostOp>
): Expected => {
	const judged = judgedOps(schema, state, ops)
	return judged.kind === "commits"
		? {
				kind: sameState(schema, state, judged.state) ? "no-change" : "accepted",
				state: judged.state
			}
		: judged
}

/**
 * Whether the laws refuse a ChangeSet of `ops` from the lawful `state`, as expect's invariant-rejected: a reading of the
 * laws alone, which never compares a commit's state with `state`.
 */
export const lawsRefuse = (
	schema: HostSchema,
	state: HostState,
	ops: ReadonlyArray<HostOp>
): boolean => judgedOps(schema, state, ops).kind === "invariant-rejected"
