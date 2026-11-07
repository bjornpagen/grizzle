import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { compareCodePoints } from "#compiler/core/text.ts"
import { type ReadonlyTupleSet, TupleMap } from "#compiler/core/tuple-map.ts"
import {
	admittedText,
	type CarrierSpec,
	type FactIdentity,
	factIdentity,
	type HeadingField
} from "#compiler/scalar/values/identity.ts"

import {
	type AttributedChange,
	attributeStratum,
	type Counts,
	type Fact,
	type FactSet,
	factSetOf,
	identityOrder,
	identitySetOf,
	netCounts,
	outcomeKind,
	type RelationDelta,
	stateDelta
} from "#test/support/oracle/delta.ts"
import { elementAt, entryOf } from "#test/support/oracle/pick.ts"

export type { Fact, FactSet }

interface OracleKey {
	/** The key law's identity, as the outcome reports it. */
	readonly law: LawId
	readonly fields: ReadonlyArray<string>
}

/**
 * A projected key, a key over the facts one field selects: it holds among the facts whose `where.field` equals
 * `where.value` and says nothing of the others.
 */
export interface OracleProjectedKey extends OracleKey {
	readonly where: { readonly field: string; readonly value: unknown }
}

export interface OracleRelation {
	readonly name: string
	readonly heading: ReadonlyArray<HeadingField>
	readonly primaryKey: OracleKey
	/** Additional candidate keys declared with key(R, fields), none where it declares none. */
	readonly keys: ReadonlyArray<OracleKey>
	/** Projected keys, immediate like the others. */
	readonly projectedKeys: ReadonlyArray<OracleProjectedKey>
	/** Serial fields, each of carrier int2, int4 or int8. */
	readonly serial: ReadonlyArray<string>
}

export interface OracleSchema {
	readonly relations: ReadonlyArray<OracleRelation>
}

/** An identity sequence, as PostgreSQL keeps it: last_value and is_called. */
export interface SequenceState {
	readonly lastValue: bigint
	readonly isCalled: boolean
}

export interface OracleState {
	/** Relation name to its facts, identity to admitted fact. */
	readonly relations: ReadonlyMap<string, FactSet>
	/** `<relation>.<field>` to the field's identity sequence. */
	readonly sequences: ReadonlyMap<string, SequenceState>
}

const relationOf = (schema: OracleSchema, name: string): OracleRelation => {
	const relation = Arr.findFirst(schema.relations, (r) => r.name === name)
	if (Option.isNone(relation)) {
		throw new Error(`unknown relation ${name}`)
	}
	return relation.value
}

const allKeys = (relation: OracleRelation): ReadonlyArray<OracleKey> => [
	relation.primaryKey,
	...relation.keys
]

/** A serial field's value in an admitted fact: an integer carrier's host value. */
export const integerOf = (value: unknown, field: string): bigint => {
	if (typeof value === "bigint") {
		return value
	}
	if (typeof value === "number") {
		return BigInt(value)
	}
	throw new Error(`the serial field ${field} holds ${typeof value}, not an integer`)
}

const specOf = (relation: OracleRelation, field: string): CarrierSpec => {
	const f = Arr.findFirst(relation.heading, (h) => h.name === field)
	if (Option.isNone(f)) {
		throw new Error(`${relation.name} has no field ${field}`)
	}
	return f.value.spec
}

/**
 * The identity of a fact's values on `fields`, equal exactly when PostgreSQL's equality holds on each: each value's
 * identity text length-prefixed, so no value's text runs into the next.
 */
const keyIdentity = (relation: OracleRelation, fields: ReadonlyArray<string>, fact: Fact): string =>
	Arr.join(
		Arr.map(fields, (field) => {
			const text = admittedText(specOf(relation, field), fact[field])
			return `${text.length}:${text}`
		}),
		""
	)

const admit = (relation: OracleRelation, heading: ReadonlyArray<HeadingField>, fact: Fact) => {
	const admitted = factIdentity(heading, fact)
	if (!admitted.ok) {
		throw new Error(
			`${relation.name}: inadmissible fact (${admitted.error.fault}${admitted.error.field === undefined ? "" : ` in ${admitted.error.field}`})`
		)
	}
	return admitted.value
}

const sequenceKey = (relation: string, field: string): string => `${relation}.${field}`

/** The identities of a relation's facts in their canonical order, for deterministic iteration. */
const sortedEntries = (facts: FactSet): ReadonlyArray<readonly [FactIdentity, Fact]> =>
	Arr.sort(
		facts,
		Order.mapInput(identityOrder, ([identity]: readonly [FactIdentity, Fact]) => identity)
	)

export const factsOf = (state: OracleState, relation: string): ReadonlyArray<Fact> =>
	Arr.map(sortedEntries(state.relations.get(relation) ?? factSetOf([])), ([, fact]) => fact)

/** A key value that more than one fact holds. */
interface KeyViolation {
	readonly relation: string
	readonly law: LawId
	/** The key field values of the violating facts, never a payload column. */
	readonly values: Readonly<Record<string, unknown>>
}

/** A generated addition: an insert omitting all of its relation's `serial` fields, admitted against the others. */
const admitGenerated = (
	relation: OracleRelation,
	partialHeading: ReadonlyArray<HeadingField>,
	op: OracleMember["op"],
	omitted: number,
	fact: Fact
): ReturnType<typeof admit> => {
	if (op !== "insert") {
		throw new Error(`${relation.name}: a ${op} names complete facts, serial fields included`)
	}
	if (omitted !== relation.serial.length) {
		throw new Error(`${relation.name}: an addition omits all serial fields or none`)
	}
	return admit(relation, partialHeading, fact)
}

/** Whether a fact is among those a projected key holds over. */
const selectedBy = (relation: OracleRelation, key: OracleProjectedKey, fact: Fact): boolean =>
	keyIdentity(relation, [key.where.field], fact) ===
	keyIdentity(relation, [key.where.field], { [key.where.field]: key.where.value })

/**
 * Every declared key of every relation that is not unique in `state`, in schema order, primary key first, projected
 * keys last.
 */
const keyViolations = (schema: OracleSchema, state: OracleState): ReadonlyArray<KeyViolation> =>
	Arr.flatMap(schema.relations, (relation) => {
		const all = sortedEntries(state.relations.get(relation.name) ?? factSetOf([]))
		const keyed: ReadonlyArray<readonly [OracleKey, ReadonlyArray<readonly [FactIdentity, Fact]>]> =
			[
				...Arr.map(allKeys(relation), (key) => [key, all] as const),
				...Arr.map(
					relation.projectedKeys,
					(key) => [key, Arr.filter(all, ([, fact]) => selectedBy(relation, key, fact))] as const
				)
			]
		return Arr.flatMap(keyed, ([key, facts]) => duplicateKeys(relation, key, facts))
	})

/**
 * The violations of one key over `facts`: each key value two or more of them hold, in code point order, with the key
 * field values of the first fact holding it.
 */
const duplicateKeys = (
	relation: OracleRelation,
	key: OracleKey,
	facts: ReadonlyArray<readonly [FactIdentity, Fact]>
): ReadonlyArray<KeyViolation> => {
	const seen = new Map<string, number>()
	const first = new Map<string, Fact>()
	for (const [, fact] of facts) {
		const k = keyIdentity(relation, key.fields, fact)
		seen.set(k, (seen.get(k) ?? 0) + 1)
		if (!first.has(k)) {
			first.set(k, fact)
		}
	}
	return Arr.flatMap(
		Arr.sort(
			seen,
			Order.mapInput(compareCodePoints, ([k]: readonly [string, number]) => k)
		),
		([k, n]) => {
			if (n < 2) {
				return []
			}
			const fact = entryOf(first, k, "the first facts by key")
			return [
				{
					relation: relation.name,
					law: key.law,
					values: Rec.fromEntries(Arr.map(key.fields, (field) => [field, fact[field]]))
				}
			]
		}
	)
}

/** Where a migration that loaded `facts` leaves the sequence of `field`: past its largest value, or fresh at 1. */
const loadedSequence = (facts: FactSet, field: string): SequenceState => {
	const values = Arr.map([...facts.values()], (fact) => integerOf(fact[field], field))
	return Arr.isReadonlyArrayNonEmpty(values)
		? { lastValue: Arr.max(values, Order.BigInt), isCalled: true }
		: { lastValue: 1n, isCalled: false }
}

/** The sequences an initial state states none of: each starts where a migration that loaded the facts leaves it. */
export const loadedSequences: Readonly<Record<string, SequenceState>> = {}

/**
 * An initial state. Facts are admitted against their headings; the state must satisfy every key, and states each fact
 * once: a stored relation holds a fact once, its primary key refusing a second row at one key, so an initial state that
 * lists a fact twice is no state PostgreSQL holds, a defect of its caller, never one fact. Each identity sequence starts
 * where a migration that loaded these facts leaves it: past the largest stored value, or fresh at 1 when none is
 * stored, unless `sequences` states it.
 */
export const oracleState = (
	schema: OracleSchema,
	facts: Readonly<Record<string, ReadonlyArray<Fact>>>,
	sequences: Readonly<Record<string, SequenceState>>
): OracleState => {
	const relations = new Map<string, FactSet>()
	const seqs = new Map<string, SequenceState>()
	for (const relation of schema.relations) {
		const set = new TupleMap<FactIdentity, Fact>()
		for (const fact of facts[relation.name] ?? []) {
			const admitted = admit(relation, relation.heading, fact)
			if (set.has(admitted.identity)) {
				throw new Error(`initial state lists a fact of ${relation.name} twice`)
			}
			set.set(admitted.identity, admitted.fact)
		}
		relations.set(relation.name, set)
		for (const field of relation.serial) {
			const key = sequenceKey(relation.name, field)
			const stated = sequences[key]
			seqs.set(key, stated ?? loadedSequence(set, field))
		}
	}
	for (const name of Rec.keys(facts)) {
		relationOf(schema, name)
	}
	const state = { relations, sequences: seqs }
	const violations = keyViolations(schema, state)
	if (violations.length > 0) {
		throw new Error(`initial state violates ${violations[0]?.law}`)
	}
	return state
}

type MemberFacts = ReadonlyArray<Fact> | ((state: OracleState) => ReadonlyArray<Fact>)

interface OracleMember {
	readonly op: "insert" | "delete" | "put"
	readonly relation: string
	readonly facts: MemberFacts
}

/**
 * The ChangeSet value over oracle members: immutable, built by insert/delete/put, combined by
 * union and sequence.
 */
export class OracleChangeSet {
	readonly strata: ReadonlyArray<ReadonlyArray<OracleMember>>

	private constructor(strata: ReadonlyArray<ReadonlyArray<OracleMember>>) {
		this.strata = strata
	}

	static empty(): OracleChangeSet {
		return new OracleChangeSet([[]])
	}

	/** Each argument is evaluated against the state the previous arguments produced. */
	static sequence(
		first: OracleChangeSet,
		...rest: ReadonlyArray<OracleChangeSet>
	): OracleChangeSet {
		return new OracleChangeSet(Arr.flatMap([first, ...rest], (c) => c.strata))
	}

	/** The commutative combination: strata position by position. */
	static union(a: OracleChangeSet, b: OracleChangeSet): OracleChangeSet {
		const n = Math.max(a.strata.length, b.strata.length)
		return new OracleChangeSet(
			Arr.map(indices(n), (i) => [...(a.strata[i] ?? []), ...(b.strata[i] ?? [])])
		)
	}

	private add(member: OracleMember): OracleChangeSet {
		const last = this.strata.length - 1
		return new OracleChangeSet(
			Arr.map(this.strata, (stratum, i) => (i === last ? [...stratum, member] : stratum))
		)
	}

	insert(relation: string, facts: MemberFacts): OracleChangeSet {
		return this.add({ op: "insert", relation, facts })
	}

	delete(relation: string, facts: MemberFacts): OracleChangeSet {
		return this.add({ op: "delete", relation, facts })
	}

	put(relation: string, facts: MemberFacts): OracleChangeSet {
		return this.add({ op: "put", relation, facts })
	}

	/** The relations the ChangeSet writes. */
	writes(): ReadonlyArray<string> {
		return Arr.sort(
			[...new Set(Arr.flatMap(this.strata, (s) => Arr.map(s, (m) => m.relation)))],
			compareCodePoints
		)
	}
}

interface RelationCounts extends Counts {
	readonly relation: string
}

export interface AppliedOutcome {
	readonly kind: "accepted" | "no-change"
	readonly state: OracleState
	/** One entry per relation the ChangeSet writes, in code point order of the names. */
	readonly counts: ReadonlyArray<RelationCounts>
	/** delta.added(R) and delta.removed(R) for every relation the ChangeSet writes. */
	readonly delta: ReadonlyMap<string, RelationDelta>
	/** The actual change of each stratum, per written relation, for netting (delta.ts). */
	readonly strata: ReadonlyArray<ReadonlyMap<string, RelationDelta>>
	/**
	 * Per relation, the identities of the final state's facts that generated additions made: their serial values are
	 * this calculator's draws, which a realization may draw otherwise.
	 */
	readonly generated: ReadonlyMap<string, ReadonlyTupleSet<FactIdentity>>
}

interface RejectedOutcome {
	readonly kind: "invariant-rejected"
	/** The first violated key law in schema order, and every violated key law of the failing stratum. */
	readonly law: LawId
	readonly violations: ReadonlyArray<KeyViolation>
	/** The stratum whose transition violated the keys, from 0, and the state that transition reached. */
	readonly stratum: number
	readonly state: OracleState
}

export type AddWinsOutcome = AppliedOutcome | RejectedOutcome

/**
 * Where a ChangeSet's generated additions take their serial values (see the header): drawn from the identity sequences
 * in identity order, or given, by relation, as the facts a realization committed for them, each generated addition
 * taking the serial values of the given fact whose other fields it holds.
 */
export type Draws =
	| { readonly kind: "sequences" }
	| { readonly kind: "given"; readonly facts: ReadonlyMap<string, ReadonlyArray<Fact>> }

const serialCarrier = (relation: OracleRelation, field: string): "int2" | "int4" | "int8" => {
	const carrier = specOf(relation, field).carrier
	if (carrier !== "int2" && carrier !== "int4" && carrier !== "int8") {
		throw new Error(`${relation.name}.${field}: a serial field is int2, int4 or int8`)
	}
	return carrier
}

const serialHost = (carrier: "int2" | "int4" | "int8", value: bigint): number | bigint =>
	carrier === "int8" ? value : Number(value)

/** nextval on an identity sequence. */
const nextval = (s: SequenceState): { readonly value: bigint; readonly next: SequenceState } =>
	s.isCalled
		? { value: s.lastValue + 1n, next: { lastValue: s.lastValue + 1n, isCalled: true } }
		: { value: s.lastValue, next: { lastValue: s.lastValue, isCalled: true } }

/**
 * How one relation's generated additions take each serial field's value from that field's sequence: nextval, or the
 * value given for the addition, past which the sequence then stands, `id` the addition's identity over the heading
 * without its serial fields.
 */
const drawer = (
	relation: OracleRelation,
	partialHeading: ReadonlyArray<HeadingField>,
	draws: Draws
): ((
	s: SequenceState,
	id: FactIdentity,
	field: string
) => { readonly value: bigint; readonly next: SequenceState }) => {
	if (draws.kind === "sequences") {
		return nextval
	}
	const byPartial = factSetOf(
		Arr.map(draws.facts.get(relation.name) ?? [], (fact) => {
			const partial = Rec.fromEntries(
				Arr.filter(Rec.toEntries(fact), ([f]) => !relation.serial.includes(f))
			)
			return [admit(relation, partialHeading, partial).identity, fact] as const
		})
	)
	return (s, id, field) => {
		const fact = byPartial.get(id)
		if (fact === undefined) {
			throw new Error(
				`${relation.name}: no fact given for the generated addition (${Arr.join(id, ", ")})`
			)
		}
		const value = integerOf(fact[field], field)
		return { value, next: advancePast(s, value) }
	}
}

/**
 * The realization's setval, by the row comparison `(value, true) > (last_value, is_called)`: the sequence advances
 * when the value is at least the next one it would generate, which for a sequence never called is its start value.
 */
const advancePast = (s: SequenceState, value: bigint): SequenceState =>
	value > s.lastValue || (value === s.lastValue && !s.isCalled)
		? { lastValue: value, isCalled: true }
		: s

/** One stratum's transition of one relation, before key checking. */
interface RelationStep {
	readonly after: TupleMap<FactIdentity, Fact>
	readonly insert: ReadonlyArray<FactIdentity>
	readonly put: ReadonlyArray<FactIdentity>
	readonly delete: ReadonlyArray<FactIdentity>
	/** The facts its generated additions made, a subset of `insert`. */
	readonly generated: ReadonlyArray<FactIdentity>
}

/**
 * The brute-force add-wins calculator: the meaning of a ChangeSet computed directly from its definition.
 * Test-only oracle; the write oracle compares db.apply and the conservative realization against it.
 *
 * The model:
 *
 * - A ChangeSet is a list of strata, each a set of members. `ChangeSet.sequence` is the only source of strata;
 *   insert, delete and put on a sequence add to its last stratum; union combines strata position by position.
 *   Build order never matters within a stratum.
 * - Every member of a stratum is evaluated against the state before that stratum. A member is an array
 *   of facts or a function of that state, which stands for a described member (a query the caller evaluates, for
 *   example with the reference evaluator).
 * - One stratum is one add-wins transition S' = (S \ D) ∪ A, where A is the insert and put facts and D
 *   the delete facts plus, for put, the current occupants of S at the put facts' primary keys: put is sugar for that
 *   described deletion plus an insertion. A fact both added and deleted stays: additions
 *   win.
 * - Keys are immediate: after each stratum every declared key, the primary key and each
 *   candidate key, must be unique in the relation, or the ChangeSet is invariant-rejected with that key law. This
 *   covers an insert at an occupied key with a different payload, two inserts, two puts, or a put and
 *   an insert of one key with different payloads, and a candidate-key collision. The witness carries
 *   the law and the key values only.
 * - An addition omits either all of its relation's serial fields or none. One that omits them is a
 *   generated addition: equal ones within a stratum are one requested addition, and each takes fresh
 *   values from the relation's identity sequences. Explicit serial values first advance the sequence past them, as
 *   the realization's setval statement does. A drawn value that would collide on a key containing the serial
 *   field is drawn again: in the realization that collision is a 23505, a TransientFailure whose retry draws fresh
 *   values, so the committed outcome never contains it. So is a drawn value whose fact repeats a fact of the state
 *   before its stratum or of the state it joins, which a sequence lagging behind the stored values can draw: a
 *   generated addition adds a fact under an identity no fact holds, so this calculator's draws never let a stored fact
 *   stand in for it, nor re-create a fact its stratum deletes, which an immediate law meets at the deletion's own
 *   statement. A realization may still draw the key of a fact its stratum has deleted, adding that fact back, and the
 *   stratum's change nets: that is a draw of the realization's. Generated values therefore depend on draw order,
 *   which nothing fixes, and an attempt that runs again draws fresh values: the outcome is the definition's under
 *   some draws. This calculator draws in identity order (`sequences`), or takes the serial values given for each
 *   generated addition (`given`), so a comparison against a database computes the outcome under the realization's
 *   own draws.
 * - The outcome's deltas compare the initial and final states. Its counts attribute each stratum's actual change to
 *   the members of that stratum and net them across the strata in order, as the realization does over its per-stratum
 *   RETURNING carriers (delta.ts).
 *
 * Misuse that the public types forbid (an unknown relation, an inadmissible fact, a partly omitted serial set, a
 * deletion without its serial values) throws: the oracle's inputs are generated to be well-formed.
 *
 * Applies a ChangeSet to a state: one add-wins transition per stratum, keys checked after each.
 */
export const applyAddWins = (
	schema: OracleSchema,
	initial: OracleState,
	changes: OracleChangeSet,
	draws: Draws
): AddWinsOutcome => {
	const writes = changes.writes()
	for (const name of writes) {
		relationOf(schema, name)
	}
	const attributed = new Map<string, Array<AttributedChange>>(Arr.map(writes, (name) => [name, []]))
	const traces: Array<ReadonlyMap<string, RelationDelta>> = []
	/** Every fact a generated addition made, by relation; those still present in the final state are reported. */
	const drawn = new Map<string, ReadonlyTupleSet<FactIdentity>>()
	let state = initial
	for (let index = 0; index < changes.strata.length; index++) {
		const stratum = elementAt(changes.strata, index, "the ChangeSet's strata")
		const before = state
		const sequences = new Map(before.sequences)
		const relations = new Map(before.relations)
		const steps = new Map<string, RelationStep>()
		for (const name of new Set(Arr.map(stratum, (m) => m.relation))) {
			const relation = relationOf(schema, name)
			steps.set(name, transition(relation, before, stratum, sequences, draws))
		}
		for (const [name, step] of steps) {
			relations.set(name, step.after)
			drawn.set(name, identitySetOf([...(drawn.get(name) ?? []), ...step.generated]))
		}
		state = { relations, sequences }
		const violations = keyViolations(schema, state)
		if (violations.length > 0) {
			return {
				kind: "invariant-rejected",
				law: elementAt(violations, 0, "the key violations").law,
				violations,
				stratum: index,
				state
			}
		}
		const trace = new Map<string, RelationDelta>()
		for (const name of writes) {
			const from = before.relations.get(name) ?? factSetOf([])
			const to = relations.get(name) ?? factSetOf([])
			trace.set(name, stateDelta(from, to))
			/** Each stratum's change is attributed to that stratum's own members only. */
			const step = steps.get(name)
			const requested = {
				insert: identitySetOf(step?.insert ?? []),
				put: identitySetOf(step?.put ?? []),
				delete: identitySetOf(step?.delete ?? [])
			}
			attributed.get(name)?.push(attributeStratum(from, to, requested))
		}
		traces.push(trace)
	}
	/** Netted across strata in order. */
	const counts = Arr.map(writes, (name) => ({
		relation: name,
		...netCounts(attributed.get(name) ?? [])
	}))
	const delta = new Map(
		Arr.map(
			writes,
			(name) =>
				[
					name,
					stateDelta(
						initial.relations.get(name) ?? factSetOf([]),
						state.relations.get(name) ?? factSetOf([])
					)
				] as const
		)
	)
	const generated = new Map(
		Arr.map([...drawn], ([name, ids]) => {
			const present = state.relations.get(name) ?? factSetOf([])
			return [name, identitySetOf(Arr.filter([...ids], (id) => present.has(id)))] as const
		})
	)
	return { kind: outcomeKind(counts), state, counts, delta, strata: traces, generated }
}

/**
 * S' = (S \ D) ∪ A for one relation in one stratum. Generated additions draw from `sequences`, which the caller
 * threads through the stratum, or take the values `draws` gives.
 *
 * Explicit serial values advance their sequences before any value is drawn.
 */
const transition = (
	relation: OracleRelation,
	before: OracleState,
	stratum: ReadonlyArray<OracleMember>,
	sequences: Map<string, SequenceState>,
	draws: Draws
): RelationStep => {
	const serial = relation.serial
	const serialSet = new Set(serial)
	const partialHeading = Arr.filter(relation.heading, (h) => !serialSet.has(h.name))
	const inserts = new TupleMap<FactIdentity, Fact>()
	const generated = new TupleMap<FactIdentity, Fact>()
	const puts = new TupleMap<FactIdentity, Fact>()
	const deletes = new TupleMap<FactIdentity, Fact>()
	for (const member of stratum) {
		if (member.relation !== relation.name) {
			continue
		}
		const facts = typeof member.facts === "function" ? member.facts(before) : member.facts
		for (const fact of facts) {
			const omitted = Arr.filter(serial, (field) => !Rec.has(fact, field))
			const admitted =
				omitted.length > 0
					? admitGenerated(relation, partialHeading, member.op, omitted.length, fact)
					: admit(relation, relation.heading, fact)
			const target =
				omitted.length > 0
					? generated
					: member.op === "insert"
						? inserts
						: member.op === "put"
							? puts
							: deletes
			target.set(admitted.identity, admitted.fact)
		}
	}
	const current = before.relations.get(relation.name) ?? factSetOf([])
	/** put's described deletion: the current occupants at the put facts' primary keys. */
	const putKeys = new Set(
		Arr.map([...puts.values()], (f) => keyIdentity(relation, relation.primaryKey.fields, f))
	)
	const displaced = Arr.filter([...current], ([, f]) =>
		putKeys.has(keyIdentity(relation, relation.primaryKey.fields, f))
	)
	const removals = identitySetOf([...deletes.keys(), ...Arr.map(displaced, ([id]) => id)])
	const after = new TupleMap<FactIdentity, Fact>()
	for (const [id, fact] of current) {
		if (!removals.has(id)) {
			after.set(id, fact)
		}
	}
	for (const [id, fact] of [...inserts, ...puts]) {
		after.set(id, fact)
	}

	for (const field of serial) {
		const key = sequenceKey(relation.name, field)
		let seq = entryOf(sequences, key, "the sequences")
		for (const fact of [...inserts.values(), ...puts.values()]) {
			seq = advancePast(seq, integerOf(fact[field], field))
		}
		sequences.set(key, seq)
	}

	/**
	 * Generated additions, in identity order, each with fresh values that collide with no key containing a serial
	 * field and repeat no fact of the state before the stratum or of the state they join, or with the values given for
	 * it.
	 */
	const generatedIds: Array<FactIdentity> = []
	const serialKeys = Arr.filter(allKeys(relation), (k) =>
		Arr.some(k.fields, (f) => serialSet.has(f))
	)
	const draw = drawer(relation, partialHeading, draws)
	/** The generated addition `id` with its serial values drawn, again while they collide and the sequences draw them. */
	const drawGenerated = (id: FactIdentity, partial: Fact): ReturnType<typeof admit> => {
		for (;;) {
			const fact: Record<string, unknown> = { ...partial }
			for (const field of serial) {
				const key = sequenceKey(relation.name, field)
				const drawn = draw(entryOf(sequences, key, "the sequences"), id, field)
				sequences.set(key, drawn.next)
				fact[field] = serialHost(serialCarrier(relation, field), drawn.value)
			}
			const admitted = admit(relation, relation.heading, fact)
			const collides =
				current.has(admitted.identity) ||
				after.has(admitted.identity) ||
				Arr.some(serialKeys, (key) => {
					const k = keyIdentity(relation, key.fields, fact)
					return Arr.some(
						[...after.values()],
						(other) => keyIdentity(relation, key.fields, other) === k
					)
				})
			if (!collides || draws.kind !== "sequences") {
				return admitted
			}
		}
	}
	for (const [id, partial] of sortedEntries(generated)) {
		const admitted = drawGenerated(id, partial)
		after.set(admitted.identity, admitted.fact)
		generatedIds.push(admitted.identity)
	}
	return {
		after,
		generated: generatedIds,
		insert: [...inserts.keys(), ...generatedIds],
		put: [...puts.keys()],
		delete: [...deletes.keys()]
	}
}
