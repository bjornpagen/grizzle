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
import { sortInPlace } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { compareTextTuples } from "#compiler/core/text.ts"
import { type ReadonlyTupleMap, TupleMap } from "#compiler/core/tuple-map.ts"
import type { ParamBinary } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type CalendarDate, dayNumber } from "#compiler/ir/date.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { columnKeyOf, type GeneratedLaw, type SpanType } from "#compiler/ir/law.ts"
import type {
	KeyedFacts,
	KeyNormalized,
	LiteralBound,
	MessageBound,
	NormalFacts
} from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { type ScalarType, type SpanCarrier, spanOf } from "#compiler/ir/scalar.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import { type Columns, textAt } from "#compiler/runtime/write/cells.ts"
import type { MemberKey } from "#compiler/runtime/write/draw.ts"
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
import { hostOfLiteral } from "#compiler/scalar/compute/literal.ts"
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
 * the facts of an owner the stratum inserts with its counts and ends its members' appends draw (runtime/write/bind.ts freshOwners).
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
 * their facts: a single input's `admitted`, and a nested input's its nesting's own row, its slot's heading.
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

/** The member slots a compiled ChangeSet reads, each once, in the order its slot groups name them: the slots whose
 * facts `MemberFacts` must hold. */
export const memberSlots = (groups: ReadonlyArray<GroupData>): ReadonlyArray<string> => [
	...new Set(groups.flatMap((g) => g.inputs.flatMap((i) => i.members)))
]

/** An admitted fact as the same-key checks judge it: its identity, the codec's (codec/recordset.ts), each field's
 * canonical text in field-name order, and its host values by field name. */
interface FactEntry {
	readonly identity: FactIdentity
	readonly fact: Fact
}

/**
 * How the same-key checks read one kind of entry: their canonical order, the order they are judged in; the texts of an
 * entry's fields, in the fields' order, which a key compares; and an entry's value of a field, which a span's overlap
 * and a refusal's witness read; each reader built once for its fields and read per entry. An admitted fact is read by
 * its fields' names (`factReading`), a nested row at its cells' positions, its texts the ones its write holds
 * (`rowReading`), so no nested row is read through a record of its fields.
 */
interface EntryReading<E> {
	readonly order: (a: E, b: E) => number
	readonly texts: (fields: ReadonlyArray<KeySpec>) => (entry: E) => ReadonlyArray<string>
	readonly value: (field: string) => (entry: E) => unknown
}

/** An admitted fact's reading (`EntryReading`): in its identities' canonical order, each field read by its name, its
 * text worked out from its value, which the fact's carriers already admitted. */
const factReading: EntryReading<FactEntry> = {
	order: (a, b) => compareFactIdentities(a.identity, b.identity),
	texts: (fields) => (entry) =>
		fields.map(({ field, spec }) => admittedText(spec, entry.fact[field])),
	value: (field) => (entry) => entry.fact[field]
}

/** A nested row's reading (`EntryReading`), a relation's of `columns`: in its identities' order, each field read at its
 * column's position among the relation's, its text the one its write holds (cells.ts textAt). */
const rowReading = (columns: Columns): EntryReading<NestedRow> => ({
	order: (a, b) => compareTextTuples(a.identity, b.identity),
	texts: (fields) => {
		const at = fields.map(({ field, spec }) => ({ at: columns.at(columnKeyOf(field)), spec }))
		return (row) => at.map((c) => textAt(row.values, row.texts, c.at, c.spec))
	},
	value: (field) => {
		const at = columns.at(columnKeyOf(field))
		return (row) => row.values[at]
	}
})

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
					spec: {
						carrier: check.span.type.carrier,
						width: defined(spanOf(check.span.type), "a span field's span").width
					}
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
		st.start.kind === "zero" ? 0n : hostOfLiteral(st.start.type.carrier, st.start.literal)
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

/** Entries in their canonical order. */
const sorted = <E>(reading: EntryReading<E>, entries: Iterable<E>): ReadonlyArray<E> =>
	sortInPlace([...entries], reading.order)

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

/** A refused entry's values at a key's fields, read by `value` (`EntryReading`), each narrowed by its field's carrier
 * (`admitted`). */
const keyValues = <E>(
	value: EntryReading<E>["value"],
	entry: E,
	fields: ReadonlyArray<KeySpec>
): Readonly<Record<string, KeyHost>> =>
	Object.freeze(
		Object.fromEntries(
			fields.map(({ field, spec }) => [field, keyHost(admitted(spec, value(field)(entry)))])
		)
	)

/** The refusal of two additions or two deletions of `facts`'s relation at one key, `entry` the later, read by `value`:
 * the key's constraint on the stored relation's table, its witness `entry`'s key in the words the facts are stated in. */
const conflictOf = <E>(
	facts: CheckedFacts,
	value: EntryReading<E>["value"],
	entry: E,
	fields: ReadonlyArray<KeySpec>,
	law: { readonly law: LawId; readonly described: OwnLaw }
): KeyRefusal => ({
	kind: "keyConflict",
	relation: facts.relation,
	law: law.law,
	described: law.described,
	witness: keyWitness(facts.stated, keyValues(value, entry, fields))
})

/** A nested fact's field, by its name. */
const byName =
	(field: string) =>
	(fact: NestedFact): unknown =>
		fact[field]

/** The refusal of two nested facts or rows of `facts`'s relation at its primary key, the key a nested set holds them
 * by, `entry` the later, read by `value`. */
const primaryConflict = <E>(
	facts: CheckedFacts,
	value: EntryReading<E>["value"],
	entry: E
): KeyRefusal => {
	const [primary] = facts.host.keys
	if (primary === undefined) {
		throw defect(`the primary key of ${facts.relation}, which a nested write keys its rows by`)
	}
	return conflictOf(facts, value, entry, primary.fields, primary)
}

/**
 * The first of one relation's facts, in canonical order, sharing a declared key's value with an earlier one of another
 * identity under `order`, the keys tried primary key first.
 */
const keyConflictIn = <E>(
	facts: CheckedFacts,
	reading: EntryReading<E>,
	entries: ReadonlyArray<E>
): KeyRefusal | undefined => {
	for (const key of facts.host.keys) {
		const { fields } = key
		const keyTexts = reading.texts(fields)
		const seen = new TupleMap<ReadonlyArray<string>, E>()
		for (const e of entries) {
			const k = keyTexts(e)
			const prior = seen.get(k)
			if (prior !== undefined && reading.order(prior, e) !== 0) {
				return conflictOf(facts, reading.value, e, fields, key)
			}
			seen.set(k, e)
		}
	}
	return undefined
}

/**
 * Same-key refusal over one stratum's additions of one relation (`normalizeChangeSet`, step 3): the first addition, in
 * canonical order, sharing a declared key's value with an earlier one of another identity, the keys tried primary key
 * first; then the first whose span overlaps an earlier one's at equal scalar fields.
 */
const sameKey = <E>(
	facts: CheckedFacts,
	reading: EntryReading<E>,
	entries: Iterable<E>
): KeyRefusal | undefined => {
	const additions = [...entries]
	return facts.host.spans.length === 0 && !keyShared(facts, reading, additions)
		? undefined
		: firstConflict(facts, reading, sorted(reading, additions))
}

/**
 * Whether two of `entries`, complete additions alone, of different identities share a declared key's value: whether
 * `firstConflict` finds a key conflict among them, which no pair of complete additions escapes as one fact. A key that
 * holds two identities holds two that stand next to each other in canonical order, so whether one does depends on the
 * set alone, and is found in the order the entries came in, with no sort: only a write it refuses is sorted, to name
 * the refusal canonical order finds first.
 */
const keyShared = <E>(
	facts: CheckedFacts,
	reading: EntryReading<E>,
	entries: ReadonlyArray<E>
): boolean => {
	for (const { fields } of facts.host.keys) {
		const keyTexts = reading.texts(fields)
		const seen = new TupleMap<ReadonlyArray<string>, E>()
		for (const e of entries) {
			const k = keyTexts(e)
			const prior = seen.get(k)
			if (prior === undefined) {
				seen.set(k, e)
			} else if (reading.order(prior, e) !== 0) {
				return true
			}
		}
	}
	return false
}

/** `sameKey`'s refusal over additions in canonical order, `additions` sorted. */
const firstConflict = <E>(
	facts: CheckedFacts,
	reading: EntryReading<E>,
	additions: ReadonlyArray<E>
): KeyRefusal | undefined => {
	const keyed = keyConflictIn(facts, reading, additions)
	if (keyed !== undefined) {
		return keyed
	}
	for (const check of facts.host.spans) {
		const { span, witness } = check
		const keyTexts = reading.texts(check.equal)
		const spanValue = reading.value(span.field)
		const groups = new TupleMap<
			ReadonlyArray<string>,
			Array<{ readonly entry: E; readonly span: HostSpan }>
		>()
		for (const e of additions) {
			const value = admitted(span.spec, spanValue(e))
			const k = keyTexts(e)
			const group = groups.get(k) ?? []
			group.push({ entry: e, span: value })
			groups.set(k, group)
		}
		for (const group of groups.values()) {
			/** In start order, a span overlaps an earlier one of its group exactly when it starts before the latest
			 * end so far. */
			const ordered = group.toSorted((x, y) => {
				const byStart = spanStartOrder(x.span.start, y.span.start)
				return byStart !== 0 ? byStart : reading.order(x.entry, y.entry)
			})
			let reach: bigint | undefined
			for (const { entry, span: value } of ordered) {
				if (reach !== undefined && position(value.start) < reach) {
					return conflictOf(facts, reading.value, entry, witness, check)
				}
				if (reach === undefined || position(value.end) > reach) {
					reach = position(value.end)
				}
			}
		}
	}
	return undefined
}

/** One slot group's admitted facts, by how its inputs write them: a deletion's of rows (`delete`) apart from a unit
 * delete's, whose facts name units (`units`), and a retirement's, whose facts name groups (`retire`). */
type GroupSets = Readonly<
	Record<"insert" | "put" | "delete" | "units" | "retire", TupleMap<FactIdentity, FactEntry>>
>

/** The set a single input's facts join: its operation's, a unit delete's its own (frontend/compile.ts SingleAct). */
const setOf = (act: SingleAct): keyof GroupSets => {
	switch (act.op) {
		case "insert":
		case "put":
		case "retire":
			return act.op
		case "delete":
			return act.names === "units" ? "units" : "delete"
	}
}

/**
 * A slot group once every input of the ChangeSet is admitted: its facts, by how its inputs write them, with the slot of
 * each, to be judged by the keys its relation declares; or the first nested write of it whose generated field has no
 * value, whose law refuses the application when every other input admits.
 */
type AdmittedGroup =
	| {
			readonly kind: "admitted"
			readonly facts: CheckedFacts
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
 * be refused here. A unique index's pairs are the statement's, which evaluates its predicate and compares its fields
 * (insert/unique.ts `Probed`).
 *
 * Additions win: a fact both added and deleted is neither deleted nor counted. A unit delete's facts name units, not
 * rows, so no addition nets them: the unit statement keeps each row of a unit the stratum adds again unchanged
 * (write/delete/unit.ts).
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
 *    (values/identity.ts parseValue), before fact identity is taken.
 * 2. Collapses equal facts: a ChangeSet's facts of one relation are a set by identity (rule 0), so a fact stated twice,
 *    in one array, across arrays or across inserts, is one fact. A nested insert's facts are one set across its stratum (nesting.ts NestedSet):
 *    a fact stated twice with every row it nests is one, and so is each member row it nests.
 * 3. Refuses conflicting additions before any SQL is sent: two facts that one stratum adds, by insert or by put, or
 *    nests under an insert, with one value of a declared key and different identities, are a key conflict, which is
 *    invariant-rejected with that key's law; two nested facts at one key that nest different rows are one too, on
 *    their relation's primary key. Additions win the transition S' = (S \ D) ∪ A, so both facts
 *    would be in the final state and break the key whatever was stored. Keys are tried primary
 *    key first, then in declaration order, and facts in canonical order, so the refusal is deterministic. A declared
 *    key over a generated field is no host key: PostgreSQL computes the field, so the statement that writes the facts
 *    compares them there (insert/unique.ts `hostHeld`, `Probed`), and a family's member rows meet it at its index. A span
 *    candidate key also refuses two additions whose spans overlap at equal scalar fields, the pair
 *    the statement would otherwise meet as a violation that aborts it. Deletions are judged at no key: a deletion is
 *    exact fact identity, so of two deleted facts at one key at most one is stored, the other's deletion changes
 *    nothing, and the state after them is lawful whichever is.
 * 4. Nets additions against deletions within the stratum: a fact both added and deleted stays and is neither deleted
 *    nor counted, so it leaves the deletions (D EXCEPT A); and a fact both an insert and a put request is
 *    the put's, so it leaves the insert. A unit delete's facts are no deletions of rows: each names a unit, its root's
 *    row and every row nested under it, which an addition of the root's fact alone does not add again, so none leaves
 *    them; the unit statement keeps a unit's rows the stratum adds again unchanged, row by row. Deleting an absent
 *    fact, or one a put displaces anyway, stays a request: the statement decides it against the stored state.
 *
 * A retirement's facts name groups (frontend/compile.ts RetireAct): admitted and collapsed as any slot's, and judged at
 * no key and netted against nothing, since no other member of the ChangeSet writes their unit.
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
			put: new TupleMap(),
			delete: new TupleMap(),
			units: new TupleMap(),
			retire: new TupleMap()
		}
		const slotOf = new Map<keyof GroupSets, SlotData>()
		/** The first of the group's nested writes whose generated field has no value: the group's refusal, once every
		 * input after it is admitted. */
		let stopped: GeneratedRefusal | undefined
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
					const category = setOf(input.act)
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
			}
		}
		admittedGroups.push(stopped ?? { kind: "admitted", facts, sets, slotOf })
	}
	for (const group of admittedGroups) {
		if (group.kind === "generatedNull") {
			return Result.ok(group)
		}
		const { facts, sets, slotOf } = group
		for (const id of sets.put.keys()) {
			sets.insert.delete(id)
		}
		const refused = sameKey(facts, factReading, [...sets.put.values(), ...sets.insert.values()])
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
			const facts = factsOf(conflict.relation)
			return Result.ok(
				conflict.kind === "fact"
					? primaryConflict(facts, byName, conflict.fact)
					: primaryConflict(facts, rowReading(walk.columns(conflict.relation)).value, conflict.row)
			)
		}
		const held = nestedRowsOf(set)
		for (const [name, byKey] of held) {
			const refused = sameKey(factsOf(name), rowReading(walk.columns(name)), byKey.values())
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
