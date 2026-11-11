import { byteaArray } from "#compiler/codec/bytea.ts"
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import {
	normalFacts,
	positionalColumns,
	type RelationNormalizer,
	relationNormalizer
} from "#compiler/codec/recordset.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { nominal } from "#compiler/core/brand.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import type { LawId, ParamId, RoleRelationName, StoredRelationName } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { compareTextTuples } from "#compiler/core/text.ts"
import { type ReadonlyTupleMap, TupleMap } from "#compiler/core/tuple-map.ts"
import type { ParamBinary } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type CalendarDate, dayNumber } from "#compiler/ir/date.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { GeneratedLaw, SpanType } from "#compiler/ir/law.ts"
import type {
	KeyedFacts,
	KeyNormalized,
	LiteralBound,
	MessageBound,
	NormalFacts
} from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import type { ScalarType, SpanCarrier } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import type { MemberKey } from "#compiler/runtime/write/draw.ts"
import { literalHost } from "#compiler/runtime/write/fill.ts"
import {
	nestedConflict,
	type NestedFact,
	type NestedRow,
	nestedRows,
	nestedRowsOf,
	type NestedSet,
	nestedSet,
	type NestedWalk,
	type NestingData
} from "#compiler/runtime/write/nesting.ts"
import { type KeyWitness, keyWitness } from "#compiler/runtime/write/outcome.ts"
import type { Transport } from "#compiler/runtime/write/transport.ts"
import { DigestBook, isAdmittedBytes } from "#compiler/scalar/values/bytes.ts"
import {
	admitted,
	admittedText,
	type Carrier,
	type CarrierHost,
	type CarrierSpec,
	compareFactIdentities,
	type FactIdentity
} from "#compiler/scalar/values/identity.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type { KeyHost, OwnLaw } from "#compiler/types/changeset/changeset.ts"
import type { SingleAct, SlotFacts } from "#compiler/write/frontend/compile.ts"

type Fact = { readonly [field: string]: unknown }

/** A slot's normal facts (ir/products.ts NormalFacts): the distinct admitted facts, in canonical order of their
 * identities, which every placeholder of the slot encodes without normalizing them again. */
export type NormalizedSlot = KeyNormalized & {
	readonly slot: SlotData
	readonly count: number
}

/** The one mint of KeyNormalized: a slot's normal facts after normalization's same-key checks. */
const keyNormalized = nominal<KeyedFacts, KeyNormalized>()

/**
 * A slot's normal facts with the binary array of each of its bytes columns (ir/products.ts KeyedFacts), each written
 * once from its facts' values, in their canonical order (codec/bytea.ts byteaArray): the one copy the write makes of
 * a member's bytes, which every placeholder of the column carries. An array no message carries is its LiteralBound,
 * and a value its caller changed since admission its EncodingFailure, before any SQL is sent.
 */
const keyedFacts = (
	slot: SlotData,
	relation: RoleRelationName,
	normal: NormalFacts
): Result.Result<KeyedFacts, EncodingFailure | LiteralBound> => {
	const binary = new Map<string, ParamBinary>()
	for (const field of slot.heading) {
		if (field.type.carrier !== "bytes") {
			continue
		}
		const array = byteaArray(
			relation,
			field.name,
			normal.facts.map((fact) => admitted({ carrier: "bytes" }, fact[field.name]))
		)
		if (!array.ok) {
			return array
		}
		binary.set(field.name, array.value)
	}
	return Result.ok({ ...normal, binary })
}

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
	const refilled = new TupleMap<FactIdentity, { readonly fact: Fact }>()
	for (const e of slot.entries) {
		refilled.set(e.identity, { fact: Object.freeze(facts(e.fact)) })
	}
	const normal = normalFacts(refilled)
	return Object.freeze({
		...keyNormalized({ ...normal, binary: slot.binary }),
		slot: slot.slot,
		count: normal.facts.length
	})
}

/**
 * A same-key conflict between two additions, or two deletions, of one stratum: invariant-rejected with the key law and
 * its description, refused by the key's constraint on the table of `relation`, the stored relation the facts write;
 * its witness is the key values only, in the words the facts were stated in: a query entry's head fields under the
 * entry's name, where the facts are written through one.
 */
interface KeyRefusal {
	readonly kind: "keyConflict"
	readonly relation: StoredRelationName
	readonly law: LawId
	readonly described: OwnLaw
	readonly witness: KeyWitness
}

export interface Normalized {
	readonly kind: "normalized"
	readonly slots: ReadonlyMap<ParamId, NormalizedSlot>
	/** Each stratum's nested rows, by reached member relation, a set by key (nesting.ts NestedSet), in the order they
	 * are inserted. */
	readonly nested: ReadonlyMap<
		StratumAt,
		ReadonlyMap<StoredRelationName, ReadonlyTupleMap<MemberKey, NestedRow>>
	>
}

/**
 * A nested write's generated field with no value, which its walk found (nesting.ts NestedGeneratedNull):
 * invariant-rejected on the field's law, whose witness is the key of the row the walk stopped at, none where it holds no
 * whole key.
 */
interface GeneratedRefusal {
	readonly kind: "generatedNull"
	readonly law: GeneratedLaw
	readonly values: Readonly<Record<string, KeyHost>> | undefined
}

export type Normalization = Normalized | KeyRefusal | GeneratedRefusal

/** The facts each member slot of the ChangeSet value supplies: an array's, or a Stream's collected. */
export type MemberFacts = ReadonlyMap<string, Iterable<unknown>>

/** A member slot as normalization reads it (frontend/compile.ts MemberSlot): its parameter, how its members travel, and
 * the fields its facts carry, in heading order. */
export interface SlotData {
	readonly slot: ParamId
	readonly transport: "enumerated" | "stream"
	readonly heading: Heading
}

/** A count or an end an owner's slot carries beyond its facts, at its start: a count at 0, an end at its accumulated
 * field's start. */
export interface StartData {
	readonly name: string
	readonly start:
		| { readonly kind: "zero" }
		| { readonly kind: "literal"; readonly type: ScalarType; readonly literal: TypedLiteral }
}

/**
 * An enumerated input as a binding holds it (frontend/compile.ts EnumeratedInput): its members by name, and what admits
 * their facts: a single input's `admitted`, a classed input's each of its slots' headings, and a nested input's its
 * nesting's own row, its slot's heading.
 */
export type InputData =
	| {
			readonly kind: "single"
			readonly act: SingleAct
			readonly slot: SlotData
			readonly members: NonEmptyReadonlyArray<string>
			readonly admitted: Heading
			readonly starts: ReadonlyArray<StartData>
	  }
	| {
			readonly kind: "classed"
			readonly serial: NonEmptyReadonlyArray<string>
			readonly complete: SlotData
			readonly generated: SlotData
			readonly members: NonEmptyReadonlyArray<string>
	  }
	| {
			readonly kind: "nested"
			readonly act: Extract<SingleAct, { readonly op: "insert" }>
			readonly slot: SlotData
			readonly nesting: NestingData
			readonly reached: ReadonlyMap<StoredRelationName, HostChecks>
			readonly members: NonEmptyReadonlyArray<string>
	  }

/** A slot group as a binding holds it (frontend/compile.ts SlotGroup): its stratum, its written relation by name, its
 * facts as the host checks them, and its inputs. */
export interface GroupData {
	readonly stratum: StratumAt
	readonly relation: StoredRelationName
	readonly facts: SlotFacts
	readonly inputs: NonEmptyReadonlyArray<InputData>
}

/** A member an enumerated input reads, by its member slot's name, with what admits its facts, whose faults name it. */
export interface InputMember<N> {
	readonly name: string
	readonly normalize: N
}

/** An enumerated input as normalization runs it (`InputData`), each member with the normalizer that admits its facts. */
export type BindInput =
	| {
			readonly kind: "single"
			readonly act: SingleAct
			readonly slot: SlotData
			readonly members: NonEmptyReadonlyArray<InputMember<RelationNormalizer>>
			readonly starts: ReadonlyArray<{ readonly name: string; readonly value: unknown }>
	  }
	| {
			readonly kind: "classed"
			readonly serial: NonEmptyReadonlyArray<string>
			/** The fields a generated addition states, each by its carrier's spec: where a complete addition of its stratum
			 * agrees with it at every one, the two are one fact (`sameKey`). */
			readonly stated: ReadonlyArray<KeySpec>
			readonly complete: SlotData
			readonly generated: SlotData
			readonly members: NonEmptyReadonlyArray<
				InputMember<{
					readonly complete: RelationNormalizer
					readonly generated: RelationNormalizer
				}>
			>
	  }
	| {
			readonly kind: "nested"
			readonly act: Extract<SingleAct, { readonly op: "insert" }>
			readonly slot: SlotData
			readonly nesting: NestingData
			readonly reached: ReadonlyMap<StoredRelationName, CheckedFacts>
			readonly members: NonEmptyReadonlyArray<InputMember<RelationNormalizer>>
	  }

/** A slot group as normalization runs it (`GroupData`), under the installation's codes: its written relation is its
 * facts' (`CheckedFacts`). */
export interface BindGroup {
	readonly stratum: StratumAt
	readonly facts: CheckedFacts
	readonly inputs: NonEmptyReadonlyArray<BindInput>
}

/** The member slots an enumerated input fills, in the order the front end drafts them (frontend/compile.ts
 * inputSlots): its one slot, or the complete slot and then the generated one. */
export const inputSlotsOf = (input: InputData): NonEmptyReadonlyArray<SlotData> =>
	input.kind === "classed" ? [input.complete, input.generated] : [input.slot]

/** The member slots a compiled ChangeSet reads, each once, in the order its slot groups name them: the slots whose
 * facts `MemberFacts` must hold. */
export const memberSlots = (groups: ReadonlyArray<GroupData>): ReadonlyArray<string> => [
	...new Set(groups.flatMap((g) => g.inputs.flatMap((i) => i.members)))
]

/** A fact or a nested row as the same-key checks judge it: its identity, and its host values by field name. */
interface Entry<I> {
	readonly identity: I
	readonly fact: Fact
}

/** An admitted fact, its identity the codec's (codec/recordset.ts): each field's canonical text in field-name order. */
type FactEntry = Entry<FactIdentity>

/** A nested row, its identity its filled columns' texts (write/family/nesting.ts NestedRow). */
type RowEntry = Entry<ReadonlyArray<string>>

/** The canonical order of one kind of entries' identities, the order their same-key checks judge them in. */
type IdentityOrder<I> = (a: I, b: I) => number

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

/**
 * The admitted facts of `facts`, member `member`'s, against a slot's heading, by its member's normalizer, refused with
 * the codec's fault at the member slot. The codec checks no key: normalization refuses a same-key pair itself (step 3).
 * Its facts are read first, none of their bytes read (codec/recordset.ts ReadRelation), and an input whose arrays no
 * Bind message of `transport` carries, with the statement's own fields and its placeholders, is refused as its
 * MessageBound before any is: before a digest is worked out or a copy made.
 *
 * The codec's identities are factIdentity's over the slot heading, the identity this module keys facts by.
 */
const admit = (
	normalize: RelationNormalizer,
	member: string,
	facts: Iterable<unknown>,
	book: DigestBook,
	transport: Transport
): Result.Result<ReadonlyArray<FactEntry>, EncodingFailure | MessageBound> => {
	const read = normalize.read(facts)
	if (!read.ok) {
		return read
	}
	const bytes =
		transport.frame.statement + normalize.columns * transport.frame.parameter + read.value.together
	if (bytes > transport.messageBytes) {
		return Result.err({
			_tag: "MessageBound",
			input: member,
			bytes,
			limit: transport.messageBytes
		})
	}
	const normalized = normalize.admit(read.value, book)
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
const collect = (
	set: TupleMap<FactIdentity, FactEntry>,
	entries: ReadonlyArray<FactEntry>
): void => {
	for (const e of entries) {
		if (!set.has(e.identity)) {
			set.set(e.identity, e)
		}
	}
}

/** A key field of a fact, by the name the fact holds it under, and its type. */
export interface HostKeyField {
	readonly field: string
	readonly type: ScalarType
}

/** The host's same-key checks of one written relation's additions (see `normalizeChangeSet`, step 3), decided with the
 * relation: each declared key's law and fields, primary key first, but a key over a generated field, which PostgreSQL
 * computes and the host never does, so the statement that writes the facts compares them there (insert/unique.ts
 * `hostHeld`); and each span candidate key whose pairs the probe leaves to the host (`checks`, `Probed`), its law, its
 * compared fields and its span field. A conflict at a span key names its compared fields, then its span field. */
export interface HostChecks {
	readonly keys: ReadonlyArray<HostKey>
	readonly spans: ReadonlyArray<{
		readonly law: LawId
		readonly described: OwnLaw
		readonly equal: ReadonlyArray<HostKeyField>
		readonly span: { readonly field: string; readonly type: SpanType }
	}>
}

/** A declared key the host compares a relation's additions at: its law and its fields. */
export interface HostKey {
	readonly law: LawId
	readonly described: OwnLaw
	readonly fields: ReadonlyArray<HostKeyField>
}

/** A key field as the host compares facts at it: its name, and its carrier's spec under the installation's codes. */
interface KeySpec {
	readonly field: string
	readonly spec: CarrierSpec
}

/** A declared key as the host compares facts at it (`HostKey`), each field by its spec. */
interface CheckedKey {
	readonly law: LawId
	readonly described: OwnLaw
	readonly fields: ReadonlyArray<KeySpec>
}

/** The host's same-key checks under the installation's codes (`HostChecks`): each key's fields by their specs, and each
 * span key's compared fields, its span field's range spec and the fields a conflict at it names. */
interface CheckedKeys {
	readonly keys: ReadonlyArray<CheckedKey>
	readonly spans: ReadonlyArray<{
		readonly law: LawId
		readonly described: OwnLaw
		readonly equal: ReadonlyArray<KeySpec>
		readonly span: {
			readonly field: string
			readonly spec: Extract<CarrierSpec, { readonly carrier: SpanCarrier }>
		}
		readonly witness: ReadonlyArray<KeySpec>
	}>
}

/**
 * A slot group's facts as the host checks them under the installation's codes (`SlotFacts`): `stated`, the name of the
 * relation they are stated in, which a fault and a refusal's witness name them by, the stored relation's own or a
 * query entry's; `relation`, the stored relation they write, a query entry's target, whose declared keys the checks
 * compare and whose table's constraints refuse a pair at one; and the checks.
 */
export interface CheckedFacts {
	readonly stated: RoleRelationName
	readonly relation: StoredRelationName
	readonly host: CheckedKeys
}

/** The host checks `host` of facts of the stored relation `relation`, stated in `stated`, under the installation's
 * codes, built once (`CheckedFacts`). */
const checkedFacts = (
	stated: RoleRelationName,
	relation: StoredRelationName,
	host: HostChecks,
	codes: Codebook
): CheckedFacts => {
	const specOf = (f: HostKeyField): KeySpec => ({
		field: f.field,
		spec: carrierSpecOf(f.type, codes)
	})
	return Object.freeze({
		stated,
		relation,
		host: Object.freeze({
			keys: host.keys.map((k) => ({
				law: k.law,
				described: k.described,
				fields: k.fields.map(specOf)
			})),
			spans: host.spans.map((check) => {
				const equal = check.equal.map(specOf)
				const span = {
					field: check.span.field,
					spec: { carrier: check.span.type.carrier, width: check.span.type.span.width }
				}
				return {
					law: check.law,
					described: check.described,
					equal,
					span,
					witness: [...equal, { field: span.field, spec: span.spec }]
				}
			})
		})
	})
}

/** The name of the relation a slot group's facts are stated in: its written relation's own, or its query entry's. */
const statedName = (group: GroupData): RoleRelationName => {
	const stated = group.facts.stated
	switch (stated.kind) {
		case "relation":
			return group.relation
		case "entry":
			return stated.entry.entry
	}
}

/**
 * A slot group as normalization runs it (`BindGroup`), built once from its data under the installation's codes: each
 * member's normalizer over the heading its facts are admitted by, the name a refusal locates being the relation its
 * facts are stated in (the stored relation's own, or a query entry's), each single input's starts as their host
 * values, and its facts' checks by their specs.
 */
export const bindGroup = (group: GroupData, codes: Codebook): BindGroup => {
	const stated = statedName(group)
	const normalizer =
		(heading: Heading) =>
		(member: string): RelationNormalizer =>
			relationNormalizer({
				relation: stated,
				columns: positionalColumns(heading),
				slot: { kind: "slot", name: member },
				codes
			})
	const startOf = (st: StartData): unknown =>
		st.start.kind === "zero"
			? 0n
			: literalHost(carrierSpecOf(st.start.type, codes), st.start.literal)
	const inputOf = (input: InputData): BindInput => {
		switch (input.kind) {
			case "single": {
				const admitBy = normalizer(input.admitted)
				return {
					kind: "single",
					act: input.act,
					slot: input.slot,
					members: mapNonEmpty(input.members, (name) => ({ name, normalize: admitBy(name) })),
					starts: input.starts.map((st) => ({ name: st.name, value: startOf(st) }))
				}
			}
			case "classed": {
				const complete = normalizer(input.complete.heading)
				const generated = normalizer(input.generated.heading)
				return {
					kind: "classed",
					serial: input.serial,
					stated: input.generated.heading.map((h) => ({
						field: h.name,
						spec: carrierSpecOf(h.type, codes)
					})),
					complete: input.complete,
					generated: input.generated,
					members: mapNonEmpty(input.members, (name) => ({
						name,
						normalize: { complete: complete(name), generated: generated(name) }
					}))
				}
			}
			case "nested": {
				const admitBy = normalizer(input.slot.heading)
				return {
					kind: "nested",
					act: input.act,
					slot: input.slot,
					nesting: input.nesting,
					reached: new Map(
						[...input.reached].map(
							([name, host]) => [name, checkedFacts(name, name, host, codes)] as const
						)
					),
					members: mapNonEmpty(input.members, (name) => ({ name, normalize: admitBy(name) }))
				}
			}
		}
	}
	return Object.freeze({
		stratum: group.stratum,
		facts: checkedFacts(stated, group.relation, group.facts.host, codes),
		inputs: mapNonEmpty(group.inputs, inputOf)
	})
}

/** The key of a fact at `fields`: each field's canonical text, in the fields' order, so two facts share it exactly when
 * they share every field's value. The fact was admitted against the same carriers, so its values are already their
 * carriers' host values and are not admitted again. */
const keyTextsOf =
	(fields: ReadonlyArray<KeySpec>) =>
	(fact: Fact): ReadonlyArray<string> =>
		fields.map(({ field, spec }) => admittedText(spec, fact[field]))

/** Entries in their identities' canonical order. */
const sorted = <I>(order: IdentityOrder<I>, entries: Iterable<Entry<I>>): ReadonlyArray<Entry<I>> =>
	[...entries].toSorted((a, b) => order(a.identity, b.identity))

/** An admitted span: a nonempty half-open interval of integers, bigints or dates. */
type HostSpan = Span<number> | Span<bigint> | Span<CalendarDate>

/** A span endpoint's position on its line: an integer itself, a date its day number. */
const position = (endpoint: HostSpan["start"]): bigint =>
	typeof endpoint === "string" ? BigInt(dayNumber(endpoint)) : BigInt(endpoint)

/** Span starts by position. */
const spanStartOrder = (a: HostSpan["start"], b: HostSpan["start"]): number => {
	const x = position(a)
	const y = position(b)
	return x < y ? -1 : x > y ? 1 : 0
}

/** Whether an admitted value is a set's. */
const isSet = (value: CarrierHost[Carrier]): value is ReadonlySet<string> => value instanceof Set

/**
 * A key field's admitted value as a key value: ownership refuses a key over a set or bytes, so neither is a key field's.
 */
const keyHost = (value: CarrierHost[Carrier]): KeyHost => {
	if (isSet(value) || isAdmittedBytes(value)) {
		throw defect("a key field over a set or bytes, which ownership refuses")
	}
	return value
}

/** A refused fact's values at a key's fields, each narrowed by its field's carrier (`admitted`). */
const keyValues = (fact: Fact, fields: ReadonlyArray<KeySpec>): Readonly<Record<string, KeyHost>> =>
	Object.freeze(
		Object.fromEntries(
			fields.map(({ field, spec }) => [field, keyHost(admitted(spec, fact[field]))])
		)
	)

/** The refusal of two additions or two deletions of `facts`'s relation at one key, `fact` the later: the key's
 * constraint on the stored relation's table, its witness `fact`'s key in the words the facts are stated in. */
const conflictOf = (
	facts: CheckedFacts,
	fact: Fact,
	fields: ReadonlyArray<KeySpec>,
	law: { readonly law: LawId; readonly described: OwnLaw }
): KeyRefusal => ({
	kind: "keyConflict",
	relation: facts.relation,
	law: law.law,
	described: law.described,
	witness: keyWitness(facts.stated, keyValues(fact, fields))
})

/** The refusal of two nested facts or rows of `facts`'s relation at its primary key, the key a nested set holds them
 * by, `fact` the later. */
const primaryConflict = (facts: CheckedFacts, fact: NestedFact): KeyRefusal => {
	const [primary] = facts.host.keys
	if (primary === undefined) {
		throw defect(`the primary key of ${facts.relation}, which a nested write keys its rows by`)
	}
	return conflictOf(facts, fact, primary.fields, primary)
}

/**
 * The first of one relation's facts, in canonical order, sharing a declared key's value with an earlier one of another
 * identity under `order`, the keys tried primary key first, each over the facts `onKey` takes part on it, and two
 * entries there one fact where `oneFact` holds of them at that key.
 */
const keyConflictIn = <I>(
	facts: CheckedFacts,
	order: IdentityOrder<I>,
	onKey: (key: CheckedKey) => ReadonlyArray<Entry<I>>,
	oneFact: (key: CheckedKey, a: Entry<I>, b: Entry<I>) => boolean
): KeyRefusal | undefined => {
	for (const key of facts.host.keys) {
		const { fields } = key
		const keyTexts = keyTextsOf(fields)
		const seen = new TupleMap<ReadonlyArray<string>, Entry<I>>()
		for (const e of onKey(key)) {
			const k = keyTexts(e.fact)
			const prior = seen.get(k)
			if (
				prior !== undefined &&
				order(prior.identity, e.identity) !== 0 &&
				!oneFact(key, prior, e)
			) {
				return conflictOf(facts, e.fact, fields, key)
			}
			seen.set(k, e)
		}
	}
	return undefined
}

/** Whether a span field is among a key's fields: such a key is no generated addition's arbiter. */
const holdsSpan = (key: CheckedKey): boolean =>
	key.fields.some(
		({ spec }) =>
			spec.carrier === "range4" || spec.carrier === "range8" || spec.carrier === "rangeDate"
	)

/**
 * Same-key refusal over one stratum's additions of one relation (`normalizeChangeSet`, step 3): the first addition, in
 * canonical order, sharing a declared key's value with an earlier one of another identity, the keys tried primary key
 * first; then the first whose span overlaps an earlier one's at equal scalar fields. A generated addition takes part
 * only on the keys and spans that hold no serial field. At such a key with no span, which makes one its arbiter
 * (insert/unique.ts generatedArbiter), a generated addition and a complete one that agrees with it at every field it
 * states, `stated`, are one fact: its statement, after the complete one's, meets that row there and is no change.
 */
const sameKey = <I>(
	facts: CheckedFacts,
	order: IdentityOrder<I>,
	serial: ReadonlyArray<string>,
	stated: ReadonlyArray<KeySpec>,
	complete: ReadonlyArray<Entry<I>>,
	generated: ReadonlyArray<Entry<I>>
): KeyRefusal | undefined => {
	const drawn: ReadonlySet<Entry<I>> = new Set(generated)
	const statedTexts = keyTextsOf(stated)
	const oneFact = (key: CheckedKey, a: Entry<I>, b: Entry<I>): boolean => {
		const bTexts = statedTexts(b.fact)
		return (
			drawn.has(a) !== drawn.has(b) &&
			!holdsSpan(key) &&
			statedTexts(a.fact).every((text, i) => text === bTexts[i])
		)
	}
	const keyed = keyConflictIn(
		facts,
		order,
		({ fields }) =>
			fields.some((f) => serial.includes(f.field)) ? complete : [...complete, ...generated],
		oneFact
	)
	if (keyed !== undefined) {
		return keyed
	}
	for (const check of facts.host.spans) {
		const { span, witness } = check
		const keyTexts = keyTextsOf(check.equal)
		const onKey = witness.some((f) => serial.includes(f.field))
			? complete
			: [...complete, ...generated]
		const groups = new TupleMap<
			ReadonlyArray<string>,
			Array<{ readonly entry: Entry<I>; readonly span: HostSpan }>
		>()
		for (const e of onKey) {
			const value = admitted(span.spec, e.fact[span.field])
			const k = keyTexts(e.fact)
			const group = groups.get(k) ?? []
			group.push({ entry: e, span: value })
			groups.set(k, group)
		}
		for (const group of groups.values()) {
			/** In start order, a span overlaps an earlier one of its group exactly when it starts before the latest
			 * end so far. */
			const ordered = group.toSorted((x, y) => {
				const byStart = spanStartOrder(x.span.start, y.span.start)
				return byStart !== 0 ? byStart : order(x.entry.identity, y.entry.identity)
			})
			let reach: bigint | undefined
			for (const { entry, span: value } of ordered) {
				if (reach !== undefined && position(value.start) < reach) {
					return conflictOf(facts, entry.fact, witness, check)
				}
				if (reach === undefined || position(value.end) > reach) {
					reach = position(value.end)
				}
			}
		}
	}
	return undefined
}

/** One slot group's admitted facts, by how its inputs write them. */
type GroupSets = Readonly<
	Record<"insert" | "generated" | "put" | "delete", TupleMap<FactIdentity, FactEntry>>
>

/**
 * A slot group once every input of the ChangeSet is admitted: its facts, by how its inputs write them, with the slot of
 * each, to be judged by the keys its relation declares; or the first nested write of it whose generated field has no
 * value, whose law refuses the application when every other input admits.
 */
type AdmittedGroup =
	| {
			readonly kind: "admitted"
			readonly facts: CheckedFacts
			readonly serial: ReadonlyArray<string>
			readonly stated: ReadonlyArray<KeySpec>
			readonly sets: GroupSets
			readonly slotOf: ReadonlyMap<keyof GroupSets, SlotData>
	  }
	| GeneratedRefusal

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
 * (`SlotGroup`), it does what follows, step 1 over every slot before any slot is judged: an input that does not admit
 * is its EncodingFailure whatever law the others break, and a nested write's generated field with no value refuses the
 * application only once every input admits.
 *
 * 1. Admits every fact through its heading's exact carriers: the null ban, the field set, and each value's exact parse
 *    (values/identity.ts parseValue), before fact identity is taken. An addition into a classed target
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
 *    key first, then in declaration order, and facts in canonical order, so the refusal is deterministic. A declared
 *    key over a generated field is no host key: PostgreSQL computes the field, so the statement that writes the facts
 *    compares them there (insert/unique.ts `hostHeld`, `Probed`), and a family's member rows meet it at its index. A span
 *    candidate key also refuses two additions whose spans overlap at equal scalar fields, the pair
 *    the statement would otherwise meet as a violation that aborts it. Deletions are judged at no key: a deletion is
 *    exact fact identity, so of two deleted facts at one key at most one is stored, the other's deletion changes
 *    nothing, and the state after them is lawful whichever is.
 * 4. Nets additions against deletions within the stratum: a fact both added and deleted stays and is neither deleted
 *    nor counted, so it leaves the deletions (D EXCEPT A); and a fact both an insert and a put request is
 *    the put's, so it leaves the insert. Deleting an absent fact, or one a put displaces anyway, stays a
 *    request: the statement decides it against the stored state.
 *
 * A nested write's facts are filled by `walk`, the write's filler (nesting.ts NestedWalk).
 *
 * The result is each slot's distinct admitted facts in canonical order, the facts the statements read, which the codec
 * encodes. A described member is not normalized here: its DISTINCT and same-key check are in the
 * statement that reads it. */
export const normalizeChangeSet = (
	groups: ReadonlyArray<BindGroup>,
	walk: NestedWalk,
	inputs: MemberFacts,
	transport: Transport
): Result.Result<Normalization, EncodingFailure | MessageBound | LiteralBound> => {
	const out = new Map<ParamId, NormalizedSlot>()
	/**
	 * Each slot's normal facts, distinct by identity over its heading and in identity order, which its encoders take as
	 * they are: their binary arrays are written once every input is measured and judged, so a write refused anywhere
	 * copies no value (`keyedFacts`).
	 */
	const normals: Array<{
		readonly slot: SlotData
		readonly relation: RoleRelationName
		readonly normal: NormalFacts
	}> = []
	/** The write's bytes values, each the one value of its digest (scalar/values/bytes.ts DigestBook). */
	const book = new DigestBook()
	/** Each stratum's nested writes, one set across its every nested input, and the relations their rows are of. */
	const nested = new Map<StratumAt, NestedSet>()
	const reached = new Map<StratumAt, Map<StoredRelationName, CheckedFacts>>()
	const admittedGroups: Array<AdmittedGroup> = []
	for (const { stratum, facts, inputs: enumerated } of groups) {
		const sets: GroupSets = {
			insert: new TupleMap(),
			generated: new TupleMap(),
			put: new TupleMap(),
			delete: new TupleMap()
		}
		const slotOf = new Map<keyof GroupSets, SlotData>()
		/** The first of the group's nested writes whose generated field has no value: the group's refusal, once every
		 * input after it is admitted. */
		let stopped: GeneratedRefusal | undefined
		/** The serial fields of the group's classed input, which exclude its generated facts from the keys that read
		 * them; a group with no classed input has no generated fact. */
		const serial = enumerated.flatMap((input) => (input.kind === "classed" ? input.serial : []))
		/** The fields the group's generated facts state, its classed input's; a group with no classed input has none. */
		const stated = enumerated.flatMap((input) => (input.kind === "classed" ? input.stated : []))
		for (const input of enumerated) {
			switch (input.kind) {
				case "nested": {
					slotOf.set("insert", input.slot)
					const set = nested.get(stratum) ?? nestedSet()
					nested.set(stratum, set)
					const relations = reached.get(stratum) ?? new Map<StoredRelationName, CheckedFacts>()
					reached.set(stratum, relations)
					relations.set(input.nesting.relation, facts)
					for (const [name, reachedFacts] of input.reached) {
						relations.set(name, reachedFacts)
					}
					for (const member of input.members) {
						const given = inputs.get(member.name)
						if (given === undefined) {
							return Result.err(encodeFailure("factShape", slotPlace(member.name)))
						}
						const rows = nestedRows(input.nesting, walk, member.name, given, set, book, transport)
						if (!rows.ok) {
							if (rows.error._tag !== "GeneratedNull") {
								return Result.err(rows.error)
							}
							stopped ??= { kind: "generatedNull", law: rows.error.law, values: rows.error.key }
							continue
						}
						const own = admit(member.normalize, member.name, rows.value, book, transport)
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
						const admittedFacts = admit(member.normalize, member.name, given, book, transport)
						if (!admittedFacts.ok) {
							return admittedFacts
						}
						/** A slot that carries fields beyond its facts' holds each at its start (frontend/compile.ts
						 * EnumeratedInput "single"), its identity its facts'. */
						const started = admittedFacts.value.map((e): FactEntry =>
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
						const complete = admit(
							member.normalize.complete,
							member.name,
							byClass.value.complete,
							book,
							transport
						)
						if (!complete.ok) {
							return complete
						}
						const generated = admit(
							member.normalize.generated,
							member.name,
							byClass.value.generated,
							book,
							transport
						)
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
		admittedGroups.push(stopped ?? { kind: "admitted", facts, serial, stated, sets, slotOf })
	}
	for (const group of admittedGroups) {
		if (group.kind === "generatedNull") {
			return Result.ok(group)
		}
		const { facts, serial, stated, sets, slotOf } = group
		for (const id of sets.put.keys()) {
			sets.insert.delete(id)
		}
		const refused = sameKey(
			facts,
			compareFactIdentities,
			serial,
			stated,
			sorted(compareFactIdentities, [...sets.put.values(), ...sets.insert.values()]),
			sorted(compareFactIdentities, sets.generated.values())
		)
		if (refused !== undefined) {
			return Result.ok(refused)
		}
		for (const id of [...sets.insert.keys(), ...sets.put.keys()]) {
			sets.delete.delete(id)
		}
		for (const [category, slot] of slotOf) {
			normals.push({ slot, relation: facts.stated, normal: normalFacts(sets[category]) })
		}
	}
	/** Each stratum's nested rows by relation, judged as the stratum's additions of that relation (step 3): a row its
	 * set holds once at its key may still share another declared key with another row. */
	const rows = new Map<
		StratumAt,
		ReadonlyMap<StoredRelationName, ReadonlyTupleMap<MemberKey, NestedRow>>
	>()
	for (const [stratum, set] of nested) {
		const factsOf = (name: StoredRelationName): CheckedFacts =>
			defined(
				reached.get(stratum)?.get(name),
				`the facts of ${name}, a relation a nested write writes`
			)
		const conflict = nestedConflict(set)
		if (conflict !== undefined) {
			return Result.ok(primaryConflict(factsOf(conflict.relation), conflict.fact))
		}
		const held = nestedRowsOf(set)
		for (const [name, byKey] of held) {
			const refused = sameKey(
				factsOf(name),
				compareTextTuples,
				[],
				[],
				sorted(
					compareTextTuples,
					[...byKey.values()].map((r): RowEntry => ({ identity: r.identity, fact: r.fact }))
				),
				[]
			)
			if (refused !== undefined) {
				return Result.ok(refused)
			}
		}
		rows.set(stratum, held)
	}
	for (const { slot, relation, normal } of normals) {
		const keyed = keyedFacts(slot, relation, normal)
		if (!keyed.ok) {
			return keyed
		}
		out.set(
			slot.slot,
			Object.freeze({ ...keyNormalized(keyed.value), slot, count: normal.facts.length })
		)
	}
	return Result.ok({ kind: "normalized", slots: out, nested: rows })
}
