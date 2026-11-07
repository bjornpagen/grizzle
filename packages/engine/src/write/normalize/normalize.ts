import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import type { RelationNormalizer } from "#compiler/codec/recordset.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { nominal } from "#compiler/core/brand.ts"
import { type EncodingFailure, KeyConflict } from "#compiler/core/errors.ts"
import type { LawId, ParamId } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { compareCodePoints } from "#compiler/core/text.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { KeyNormalized, NormalFacts } from "#compiler/ir/products.ts"
import type { KeySet } from "#compiler/ir/rel.ts"
import {
	admitted,
	admittedText,
	type Carrier,
	type CarrierHost,
	type CarrierSpec
} from "#compiler/scalar/values/identity.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type { KeyHost, Law } from "#compiler/types/changeset/changeset.ts"
import {
	type NestedFact,
	type NestedRow,
	type NestedSet,
	nestedConflict,
	nestedRows,
	nestedRowsOf,
	nestedSet
} from "#compiler/write/family/nesting.ts"
import type { MemberSlot, SlotFacts, WriteFrontend } from "#compiler/write/frontend/compile.ts"
import { isCarried } from "#compiler/write/insert/statement.ts"
import type { RelationUniques } from "#compiler/write/insert/unique.ts"

type Fact = { readonly [field: string]: unknown }

/** A slot's normal facts (ir/products.ts NormalFacts): the distinct admitted facts, in canonical order of their
 * identities, which every placeholder of the slot encodes without normalizing them again. */
export type NormalizedSlot = KeyNormalized & {
	readonly slot: MemberSlot
	readonly count: number
}

/** The one mint of KeyNormalized: a slot's normal facts after normalization's same-key checks. */
const keyNormalized = nominal<NormalFacts, KeyNormalized>()

/**
 * A slot's normal facts with each fact replaced by `facts`, their identities kept, as normalization would hold them:
 * the facts of an owner the stratum inserts with its counts and ends its members' appends draw (write/program/bind.ts).
 * The brand's claim, that no two facts share a key, still holds: bind refills only fields no key of the owner reads,
 * so every key value is the one the same-key checks judged.
 */
export const refilledSlot = (
	slot: NormalizedSlot,
	facts: (fact: { readonly [field: string]: unknown }) => { readonly [field: string]: unknown }
): NormalizedSlot => {
	const normal = slot.slot.normalForm(
		new Map(slot.entries.map((e) => [e.identity, { fact: Object.freeze(facts(e.fact)) }] as const))
	)
	return Object.freeze({ ...keyNormalized(normal), slot: slot.slot, count: normal.facts.length })
}

/** A same-key conflict between two additions, or two deletions, of one stratum: invariant-rejected with the key law and
 * its description, whose witness is the key values only. */
interface KeyRefusal {
	readonly kind: "keyConflict"
	readonly stratum: number
	readonly relation: string
	readonly fields: KeySet
	readonly law: LawId
	readonly described: Law
	readonly values: Readonly<Record<string, KeyHost>>
	readonly conflict: KeyConflict
}

export interface Normalized {
	readonly kind: "normalized"
	readonly slots: ReadonlyMap<ParamId, NormalizedSlot>
	/** Each stratum's nested rows, by reached member relation, a set by key (nesting.ts NestedSet), in the order they
	 * are inserted. */
	readonly nested: ReadonlyMap<number, ReadonlyMap<string, ReadonlyMap<string, NestedRow>>>
}

export type Normalization = Normalized | KeyRefusal

/** The facts each member slot of the ChangeSet value supplies: an array's, or a Stream's collected. */
export type MemberFacts = ReadonlyMap<string, Iterable<unknown>>

/** The member slots a compiled ChangeSet reads, each once, in the order its slot groups name them: the slots whose
 * facts `MemberFacts` must hold. */
export const memberSlots = (frontend: WriteFrontend): ReadonlyArray<string> => [
	...new Set(frontend.slots.flatMap((g) => g.inputs.flatMap((i) => i.members.map((m) => m.name))))
]

interface Entry {
	readonly identity: string
	readonly fact: Fact
}

/** Facts in identity order, by code point. */
const identityOrder = (a: Entry, b: Entry): number => compareCodePoints(a.identity, b.identity)

/** A non-null object, whose fields a string key reads as unknown values. */
const isObject = (value: unknown): value is Fact => typeof value === "object" && value !== null

/** A fact's own non-undefined fields among `fields`. */
const supplied = (fact: unknown, fields: ReadonlyArray<string>): number => {
	if (!isObject(fact)) {
		return fields.length
	}
	let n = 0
	for (const f of fields) {
		if (Object.hasOwn(fact, f) && fact[f] !== undefined) {
			n++
		}
	}
	return n
}

/** The admitted facts of `facts` against a slot's heading, by its member's normalizer, refused with the codec's fault at
 * the member slot. The codec checks no key: normalization refuses a same-key pair itself (step 3).
 *
 * The codec's identities are factIdentity's over the slot heading, the identity this module keys facts by. */
const admit = (
	normalize: RelationNormalizer,
	facts: Iterable<unknown>
): Result.Result<ReadonlyArray<Entry>, EncodingFailure> => {
	const normalized = normalize(facts)
	if (!normalized.ok) {
		return normalized
	}
	return Result.ok(normalized.value.entries)
}

/** A classed insertion's facts of one member, each routed by its supplied serial fields: none to the generated slot,
 * every one to the complete slot; a fact supplying some and not all is no fact of either heading. Each fact is
 * classified once. */
const routed = (
	serial: NonEmptyReadonlyArray<string>,
	member: string,
	facts: Iterable<unknown>
): Result.Result<
	{ readonly complete: ReadonlyArray<unknown>; readonly generated: ReadonlyArray<unknown> },
	EncodingFailure
> => {
	const complete: Array<unknown> = []
	const generated: Array<unknown> = []
	for (const fact of facts) {
		const n = supplied(fact, serial)
		if (n === 0) {
			generated.push(fact)
		} else if (n === serial.length) {
			complete.push(fact)
		} else {
			return Result.err(encodeFailure("factShape", slotPlace(member)))
		}
	}
	return Result.ok({ complete, generated })
}

/** Each admitted entry of `entries` into `set`, the first of each identity kept. */
const collect = (set: Map<string, Entry>, entries: ReadonlyArray<Entry>): void => {
	for (const e of entries) {
		if (!set.has(e.identity)) {
			set.set(e.identity, e)
		}
	}
}

/** A key field of a fact, by the name the fact holds it under, and its carrier's spec. */
export interface HostKeyField {
	readonly field: string
	readonly spec: CarrierSpec
}

/** The host's same-key checks of one written relation's additions (see `normalizeChangeSet`, step 3), built with the relation:
 * each declared key's law and fields, primary key first; and each span candidate key whose pairs the probe leaves to
 * the host (`checks`, `Probed`), its law, its compared fields, its span field with its range carrier's spec, and the
 * fields a conflict at it names. */
export interface HostChecks {
	readonly keys: ReadonlyArray<HostKey>
	readonly spans: ReadonlyArray<{
		readonly law: LawId
		readonly described: Law
		readonly equal: ReadonlyArray<HostKeyField>
		readonly span: {
			readonly field: string
			readonly spec: Extract<CarrierSpec, { readonly carrier: Range }>
		}
		readonly witness: ReadonlyArray<HostKeyField>
	}>
}

export type Range = "range4" | "range8"

/**
 * A declared key the host compares a relation's facts at: its law, its fields, and whether a fact as its caller writes
 * it states every one of them, its caller's and serial fields alone (`stated`): a deletion's facts, which state no
 * field grizzle writes, are compared only at such a key.
 */
export interface HostKey {
	readonly law: LawId
	readonly described: Law
	readonly fields: ReadonlyArray<HostKeyField>
	readonly stated: boolean
}

/** A key field of the relation's facts, by its name, with its spec under the installation's codes. */
const hostKeyField =
	(codes: Codebook) =>
	(f: LawField): HostKeyField => ({ field: f.name, spec: carrierSpecOf(f.type, codes) })

/** The host checks of a relation's keys and span candidate keys, each field's spec its type's carrier's. */
export const hostChecks = (
	keyLaws: ReadonlyArray<{
		readonly fields: ReadonlyArray<LawField>
		readonly law: LawId
		readonly described: Law
	}>,
	uniques: RelationUniques,
	codes: Codebook
): HostChecks =>
	Object.freeze({
		keys: keyLaws.map((k): HostKey =>
			Object.freeze({
				law: k.law,
				described: k.described,
				fields: k.fields.map(hostKeyField(codes)),
				stated: k.fields.every(isCarried)
			})
		),
		spans: uniques.checks.flatMap(({ object: check, pairs }) => {
			if (check.kind !== "span" || pairs !== "host") {
				return []
			}
			const span = {
				field: check.span.name,
				spec: { carrier: check.span.type.carrier, width: check.span.type.span.width }
			}
			const equal = check.equal.map(hostKeyField(codes))
			return [
				Object.freeze({
					law: check.law,
					described: check.described,
					equal,
					span,
					witness: [...equal, { field: span.field, spec: span.spec }]
				})
			]
		})
	})

/** The key of a fact at `fields`: each field's canonical text after its length, so two facts share it exactly when they
 * share every field's value. The fact was admitted against the same carriers, so its values are already their
 * carriers' host values and are not admitted again. */
const keyTextOf = (fields: ReadonlyArray<HostKeyField>) => (fact: Fact) => {
	let key = ""
	for (const { field, spec } of fields) {
		const text = admittedText(spec, fact[field])
		key = `${key}${text.length}:${text}`
	}
	return key
}

const sorted = (entries: Iterable<Entry>): ReadonlyArray<Entry> =>
	[...entries].toSorted(identityOrder)

/** Span starts, numbers or bigints, by value. */
const spanStartOrder = (a: HostSpan["start"], b: HostSpan["start"]): number =>
	a < b ? -1 : a > b ? 1 : 0

/** An admitted span: a nonempty half-open interval of integers or bigints. */
type HostSpan = Span<number> | Span<bigint>

/** Whether an admitted value is a set's. */
const isSet = (value: CarrierHost[Carrier]): value is ReadonlySet<string> => value instanceof Set

/** A key field's admitted value as a key value: ownership refuses a key over a set, so a set is no key field's. */
const keyHost = (value: CarrierHost[Carrier]): KeyHost => {
	if (isSet(value)) {
		throw defect("a key field over a set, which ownership refuses")
	}
	return value
}

/** A refused fact's values at a key's fields, each narrowed by its field's carrier (`admitted`). */
const keyValues = (
	fact: Fact,
	fields: ReadonlyArray<HostKeyField>
): Readonly<Record<string, KeyHost>> =>
	Object.freeze(
		Object.fromEntries(
			fields.map(({ field, spec }) => [field, keyHost(admitted(spec, fact[field]))])
		)
	)

const names = (fields: ReadonlyArray<HostKeyField>): KeySet => fields.map((f) => f.field)

/** The refusal of two additions or two deletions of `facts`'s relation at one key, `fact` the later. */
const conflictOf = (
	stratum: number,
	facts: SlotFacts,
	fact: Fact,
	fields: ReadonlyArray<HostKeyField>,
	law: { readonly law: LawId; readonly described: Law }
): KeyRefusal => {
	const keyFields = names(fields)
	return {
		kind: "keyConflict",
		stratum,
		relation: facts.name,
		fields: keyFields,
		law: law.law,
		described: law.described,
		values: keyValues(fact, fields),
		conflict: KeyConflict.make({
			relation: facts.name,
			fields: keyFields,
			values: keyFields.map((f) => fact[f])
		})
	}
}

/** The refusal of two nested facts or rows of `facts`'s relation at its primary key, the key a nested set holds them
 * by, `fact` the later. */
const primaryConflict = (stratum: number, facts: SlotFacts, fact: NestedFact): KeyRefusal => {
	const [primary] = facts.host.keys
	if (primary === undefined) {
		throw defect(`the primary key of ${facts.name}, which a nested write keys its rows by`)
	}
	return conflictOf(stratum, facts, fact, primary.fields, primary)
}

/**
 * The first of one relation's facts, in canonical order, sharing a declared key's value with an earlier one of another
 * identity, the keys tried primary key first, each over the facts `onKey` takes part on it.
 */
const keyConflictIn = (
	stratum: number,
	facts: SlotFacts,
	onKey: (key: HostKey) => ReadonlyArray<Entry>
): KeyRefusal | undefined => {
	for (const key of facts.host.keys) {
		const { fields } = key
		const keyText = keyTextOf(fields)
		const seen = new Map<string, Entry>()
		for (const e of onKey(key)) {
			const k = keyText(e.fact)
			const prior = seen.get(k)
			if (prior !== undefined && prior.identity !== e.identity) {
				return conflictOf(stratum, facts, e.fact, fields, key)
			}
			seen.set(k, e)
		}
	}
	return undefined
}

/**
 * Same-key refusal over one stratum's additions of one relation (`normalizeChangeSet`, step 3): the first addition, in
 * canonical order, sharing a declared key's value with an earlier one of another identity, the keys tried primary key
 * first; then the first whose span overlaps an earlier one's at equal scalar fields. A generated addition takes part
 * only on the keys and spans that hold no serial field.
 */
const sameKey = (
	stratum: number,
	facts: SlotFacts,
	serial: ReadonlyArray<string>,
	complete: ReadonlyArray<Entry>,
	generated: ReadonlyArray<Entry>
): KeyRefusal | undefined => {
	const keyed = keyConflictIn(stratum, facts, ({ fields }) =>
		fields.some((f) => serial.includes(f.field)) ? complete : [...complete, ...generated]
	)
	if (keyed !== undefined) {
		return keyed
	}
	for (const check of facts.host.spans) {
		const { span, witness } = check
		const keyText = keyTextOf(check.equal)
		const onKey = witness.some((f) => serial.includes(f.field))
			? complete
			: [...complete, ...generated]
		const groups = new Map<string, Array<{ readonly entry: Entry; readonly span: HostSpan }>>()
		for (const e of onKey) {
			const value = admitted(span.spec, e.fact[span.field])
			const k = keyText(e.fact)
			const group = groups.get(k) ?? []
			group.push({ entry: e, span: value })
			groups.set(k, group)
		}
		for (const group of groups.values()) {
			/** In start order, a span overlaps an earlier one of its group exactly when it starts before the latest
			 * end so far. */
			const ordered = group.toSorted((x, y) => {
				const byStart = spanStartOrder(x.span.start, y.span.start)
				return byStart !== 0 ? byStart : identityOrder(x.entry, y.entry)
			})
			let reach: HostSpan["end"] | undefined
			for (const { entry, span: value } of ordered) {
				if (reach !== undefined && value.start < reach) {
					return conflictOf(stratum, facts, entry.fact, witness, check)
				}
				if (reach === undefined || value.end > reach) {
					reach = value.end
				}
			}
		}
	}
	return undefined
}

/** Normalizes every enumerated slot of a compiled ChangeSet over the facts its member slots supply.
 *
 * A fact both an insert and a put request is the put's.
 *
 * Overlapping additions under a span candidate key, which exact key values do not show: the
 * statement treats a violation of one as an occupant its snapshot did not see, so a pair within the input must
 * be refused here. A unique index's pairs are the statement's, which evaluates its predicate and compares its fields,
 * and so are a span primary key's among generated additions (insert/unique.ts `Probed`).
 *
 * Additions win: a fact both added and deleted is neither deleted nor counted.
 *
 * Host normalization of a ChangeSet's enumerated members.
 *
 * An enumerated member is the query over a relation parameter its array or Stream binds, so the host owns its set
 * property and its null ban. For each stratum and each relation, over the write front end's slots
 * (`SlotGroup`), it:
 *
 * 1. Admits every fact through its heading's exact carriers: the null ban, the field set, each value's representation
 *    and PostgreSQL's own coercion, before fact identity is taken. An addition into a classed target
 *    (`EnumeratedInput` "classed") is routed once by the serial fields it supplies: one that omits all is a generated
 *    addition, admitted against its class's heading, the unit relation's when that holds no field; one that supplies
 *    all is complete; one that omits some is no fact of either heading (factShape).
 * 2. Collapses equal facts: a ChangeSet's facts of one relation are a set by identity (rule 0), so a fact stated twice,
 *    in one array, across arrays or across inserts, is one fact, and equal generated additions are one requested
 *    addition that yields one new fact. A nested insert's facts are one set across its stratum (nesting.ts NestedSet):
 *    a fact stated twice with every row it nests is one, and so is each member row it nests.
 * 3. Refuses conflicting additions before any SQL is sent: two facts that one stratum adds, by insert or by put, or
 *    nests under an insert, with one value of a declared key and different identities, are a key conflict, which is
 *    invariant-rejected with that key's law; two nested facts at one key that nest different rows are one too, on
 *    their relation's primary key. Additions win the transition S' = (S \ D) ∪ A, so both facts
 *    would be in the final state and break the key whatever was stored. A generated addition takes part on every key
 *    that holds no serial field; its identity does not exist yet on the others. Keys are tried primary
 *    key first, then in declaration order, and facts in canonical order, so the refusal is deterministic. A span
 *    candidate key also refuses two additions whose spans overlap at equal scalar fields, the pair
 *    the statement would otherwise meet as a violation that aborts it. Deletions are a relation's facts too: two facts
 *    the stratum deletes with one value of a declared key and different identities name two facts where the key names
 *    one, a key conflict on that key's law, judged over the deletions alone and before netting, since an addition at a
 *    deleted key is a replacement, and only at a key a deletion's facts state (HostKey `stated`): a deletion states no
 *    field grizzle writes, so a declared key holding one compares none of them.
 * 4. Nets additions against deletions within the stratum: a fact both added and deleted stays and is neither deleted
 *    nor counted, so it leaves the deletions (D EXCEPT A); and a fact both an insert and a put request is
 *    the put's, so it leaves the insert. Deleting an absent fact, or one a put displaces anyway, stays a
 *    request: the statement decides it against the stored state.
 *
 * The result is each slot's distinct admitted facts in canonical order, the facts the statements read, which the codec
 * encodes. A described member is not normalized here: its DISTINCT and same-key check are in the
 * statement that reads it. */
export const normalizeChangeSet = (
	frontend: WriteFrontend,
	inputs: MemberFacts
): Result.Result<Normalization, EncodingFailure> => {
	const out = new Map<ParamId, NormalizedSlot>()
	/** Each stratum's nested writes, one set across its every nested input, and the relations their rows are of. */
	const nested = new Map<number, NestedSet>()
	const reached = new Map<number, Map<string, SlotFacts>>()
	for (const { stratum, facts: relation, inputs: enumerated } of frontend.slots) {
		const sets: Record<"insert" | "generated" | "put" | "delete", Map<string, Entry>> = {
			insert: new Map(),
			generated: new Map(),
			put: new Map(),
			delete: new Map()
		}
		const slotOf = new Map<keyof typeof sets, MemberSlot>()
		/** The serial fields of the group's classed input, which exclude its generated facts from the keys that read
		 * them; a group with no classed input has no generated fact. */
		const serial = enumerated.flatMap((input) => (input.kind === "classed" ? input.serial : []))
		for (const input of enumerated) {
			switch (input.kind) {
				case "nested": {
					slotOf.set("insert", input.slot)
					const set = nested.get(stratum) ?? nestedSet()
					nested.set(stratum, set)
					const relations = reached.get(stratum) ?? new Map<string, SlotFacts>()
					reached.set(stratum, relations)
					relations.set(input.nesting.relation.name, relation)
					for (const [name, facts] of input.reached) {
						relations.set(name, facts)
					}
					for (const member of input.members) {
						const given = inputs.get(member.name)
						if (given === undefined) {
							return Result.err(encodeFailure("factShape", slotPlace(member.name)))
						}
						const rows = nestedRows(input.nesting, member.name, given, set)
						if (!rows.ok) {
							return rows
						}
						const own = admit(member.normalize, rows.value)
						if (!own.ok) {
							return own
						}
						collect(sets.insert, own.value)
					}
					break
				}
				case "single": {
					const category = input.act.op
					slotOf.set(category, input.slot)
					for (const member of input.members) {
						const given = inputs.get(member.name)
						if (given === undefined) {
							return Result.err(encodeFailure("factShape", slotPlace(member.name)))
						}
						const admittedFacts = admit(member.normalize, given)
						if (!admittedFacts.ok) {
							return admittedFacts
						}
						/** A slot that carries fields beyond its facts' holds each at its start (frontend/compile.ts
						 * EnumeratedInput "single"), its identity its facts'. */
						const started = admittedFacts.value.map((e): Entry =>
							input.starts.length === 0
								? e
								: {
										identity: e.identity,
										fact: Object.freeze(
											Object.fromEntries([
												...Object.entries(e.fact),
												...input.starts.map((st) => [st.name, st.value] as const)
											])
										)
									}
						)
						collect(sets[category], started)
					}
					break
				}
				case "classed": {
					slotOf.set("insert", input.complete)
					slotOf.set("generated", input.generated)
					for (const member of input.members) {
						const given = inputs.get(member.name)
						if (given === undefined) {
							return Result.err(encodeFailure("factShape", slotPlace(member.name)))
						}
						const byClass = routed(input.serial, member.name, given)
						if (!byClass.ok) {
							return byClass
						}
						const complete = admit(member.normalize.complete, byClass.value.complete)
						if (!complete.ok) {
							return complete
						}
						const generated = admit(member.normalize.generated, byClass.value.generated)
						if (!generated.ok) {
							return generated
						}
						collect(sets.insert, complete.value)
						collect(sets.generated, generated.value)
					}
					break
				}
			}
		}
		for (const id of sets.put.keys()) {
			sets.insert.delete(id)
		}
		const refused =
			sameKey(
				stratum,
				relation,
				serial,
				sorted([...sets.put.values(), ...sets.insert.values()]),
				sorted(sets.generated.values())
			) ??
			keyConflictIn(stratum, relation, (key) => (key.stated ? sorted(sets.delete.values()) : []))
		if (refused !== undefined) {
			return Result.ok(refused)
		}
		for (const id of [...sets.insert.keys(), ...sets.put.keys()]) {
			sets.delete.delete(id)
		}
		for (const [category, slot] of slotOf) {
			/** Distinct by identity over the slot heading and in identity order: the slot's normal facts, which its
			 * encoders take as they are. */
			const normal = slot.normalForm(sets[category])
			out.set(
				slot.slot,
				Object.freeze({ ...keyNormalized(normal), slot, count: normal.facts.length })
			)
		}
	}
	/** Each stratum's nested rows by relation, judged as the stratum's additions of that relation (step 3): a row its
	 * set holds once at its key may still share another declared key with another row. */
	const rows = new Map<number, ReadonlyMap<string, ReadonlyMap<string, NestedRow>>>()
	for (const [stratum, set] of nested) {
		const factsOf = (name: string): SlotFacts =>
			defined(
				reached.get(stratum)?.get(name),
				`the facts of ${name}, a relation a nested write writes`
			)
		const conflict = nestedConflict(set)
		if (conflict !== undefined) {
			return Result.ok(primaryConflict(stratum, factsOf(conflict.relation), conflict.fact))
		}
		const held = nestedRowsOf(set)
		for (const [name, byKey] of held) {
			const facts = factsOf(name)
			const refused = sameKey(
				stratum,
				facts,
				[],
				sorted([...byKey.values()].map((r) => ({ identity: r.identity, fact: r.fact }))),
				[]
			)
			if (refused !== undefined) {
				return Result.ok(refused)
			}
		}
		rows.set(stratum, held)
	}
	return Result.ok({ kind: "normalized", slots: out, nested: rows })
}
