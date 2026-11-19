import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
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
}

export interface OracleSchema {
	readonly relations: ReadonlyArray<OracleRelation>
}

export interface OracleState {
	/** Relation name to its facts, identity to admitted fact. */
	readonly relations: ReadonlyMap<string, FactSet>
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

/**
 * An initial state. Facts are admitted against their headings; the state must satisfy every key, and states each fact
 * once: a stored relation holds a fact once, its primary key refusing a second row at one key, so an initial state that
 * lists a fact twice is no state PostgreSQL holds, a defect of its caller, never one fact.
 */
export const oracleState = (
	schema: OracleSchema,
	facts: Readonly<Record<string, ReadonlyArray<Fact>>>
): OracleState => {
	const relations = new Map<string, FactSet>()
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
	}
	for (const name of Rec.keys(facts)) {
		relationOf(schema, name)
	}
	const state = { relations }
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

/** One stratum's transition of one relation, before key checking. */
interface RelationStep {
	readonly after: TupleMap<FactIdentity, Fact>
	readonly insert: ReadonlyArray<FactIdentity>
	readonly put: ReadonlyArray<FactIdentity>
	readonly delete: ReadonlyArray<FactIdentity>
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
 * - The outcome's deltas compare the initial and final states. Its counts attribute each stratum's actual change to
 *   the members of that stratum and net them across the strata in order, as the realization does over its per-stratum
 *   RETURNING carriers (delta.ts).
 *
 * Misuse that the public types forbid (an unknown relation, an inadmissible fact) throws: the oracle's inputs are
 * generated to be well-formed.
 *
 * Applies a ChangeSet to a state: one add-wins transition per stratum, keys checked after each.
 */
export const applyAddWins = (
	schema: OracleSchema,
	initial: OracleState,
	changes: OracleChangeSet
): AddWinsOutcome => {
	const writes = changes.writes()
	for (const name of writes) {
		relationOf(schema, name)
	}
	const attributed = new Map<string, Array<AttributedChange>>(Arr.map(writes, (name) => [name, []]))
	const traces: Array<ReadonlyMap<string, RelationDelta>> = []
	let state = initial
	for (let index = 0; index < changes.strata.length; index++) {
		const stratum = elementAt(changes.strata, index, "the ChangeSet's strata")
		const before = state
		const relations = new Map(before.relations)
		const steps = new Map<string, RelationStep>()
		for (const name of new Set(Arr.map(stratum, (m) => m.relation))) {
			const relation = relationOf(schema, name)
			steps.set(name, transition(relation, before, stratum))
		}
		for (const [name, step] of steps) {
			relations.set(name, step.after)
		}
		state = { relations }
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
	return { kind: outcomeKind(counts), state, counts, delta, strata: traces }
}

/** S' = (S \ D) ∪ A for one relation in one stratum. */
const transition = (
	relation: OracleRelation,
	before: OracleState,
	stratum: ReadonlyArray<OracleMember>
): RelationStep => {
	const inserts = new TupleMap<FactIdentity, Fact>()
	const puts = new TupleMap<FactIdentity, Fact>()
	const deletes = new TupleMap<FactIdentity, Fact>()
	for (const member of stratum) {
		if (member.relation !== relation.name) {
			continue
		}
		const facts = typeof member.facts === "function" ? member.facts(before) : member.facts
		for (const fact of facts) {
			const admitted = admit(relation, relation.heading, fact)
			const target = member.op === "insert" ? inserts : member.op === "put" ? puts : deletes
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
	return {
		after,
		insert: [...inserts.keys()],
		put: [...puts.keys()],
		delete: [...deletes.keys()]
	}
}
