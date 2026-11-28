import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
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
import { sortInPlace } from "#compiler/core/order.ts"
import {
	compareTextLists,
	compareTextsIds,
	type TextsId,
	TextsMap,
	textsId
} from "#compiler/core/text.ts"
import type { ParamBinary } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type CalendarDate, dayNumber } from "#compiler/ir/date.ts"
import type { ExprTable, TypedLiteral } from "#compiler/ir/expr.ts"
import { columnKeyOf, type GeneratedLaw, generatedLaw, type SpanType } from "#compiler/ir/law.ts"
import type {
	IdentifiedFact,
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
import { keptReads } from "#compiler/runtime/write/decoded.ts"
import {
	type EvaluatedRelation,
	evaluatedRelation,
	type FillRefusal,
	fillRefusal,
	type GeneratedNull,
	type Generation,
	generation,
	type HostEvaluator,
	keyHostOf,
	wholeKey
} from "#compiler/runtime/write/fill.ts"
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
	keyText,
	type Carrier,
	type CarrierHost,
	type CarrierSpec
} from "#compiler/scalar/values/identity.ts"
import type { Span } from "#compiler/scalar/values/span.ts"
import type { KeyHost, RecordedLaw } from "#compiler/types/changeset/changeset.ts"
import type { SingleAct, SlotFacts } from "#compiler/write/frontend/compile.ts"

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
	const refilled = new TextsMap<IdentifiedFact>()
	for (const e of slot.entries) {
		refilled.set(e.identity, { identity: e.identity, fact: Object.freeze(facts(e.fact)) })
	}
	const normal = normalFacts(refilled)
	return Object.freeze({
		...keyNormalized({ ...normal, binary: slot.binary }),
		slot: slot.slot,
		count: normal.facts.length
	})
}

/**
 * A slot's facts `from` to `to`, in their canonical order, as normalization would hold them had the slot stated them
 * alone: one execution's share of a batched statement (runtime/write/bind.ts batchedExecutions). The brand's claim
 * holds of every share of a normalized slot. A slot with a bytes column holds one binary array of all its facts, which
 * no share of it carries, so only a slot of none is cut (`cuttable`).
 */
export const slicedSlot = (slot: NormalizedSlot, from: number, to: number): NormalizedSlot => {
	const sliced = new TextsMap<IdentifiedFact>()
	for (const e of slot.entries.slice(from, to)) {
		sliced.set(e.identity, e)
	}
	const normal = normalFacts(sliced)
	return Object.freeze({
		...keyNormalized({ ...normal, binary: slot.binary }),
		slot: slot.slot,
		count: normal.facts.length
	})
}

/** Whether a slot's facts may be cut into shares (`slicedSlot`): it has no bytes column, whose one array spans them. */
export const cuttable = (slot: NormalizedSlot): boolean => slot.binary.size === 0

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
	readonly described: RecordedLaw
	readonly witness: KeyWitness
}

export interface Normalized {
	readonly kind: "normalized"
	readonly slots: ReadonlyMap<ParamId, NormalizedSlot>
	/** Each stratum's nested rows, by reached member relation, one at each key (nesting.ts NestedSet), in the order they
	 * are inserted. */
	readonly nested: ReadonlyMap<StratumAt, ReadonlyMap<StoredRelationName, ReadonlyArray<NestedRow>>>
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

/** The facts each member slot of the ChangeSet value supplies: its array's. */
export type MemberFacts = ReadonlyMap<string, Iterable<unknown>>

/** A member slot as normalization reads it (frontend/compile.ts MemberSlot): its parameter, and the fields its facts
 * carry, in heading order. */
export interface SlotData {
	readonly slot: ParamId
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

/** An enumerated input as normalization runs it (`InputData`), each member with the normalizer that admits its facts,
 * and a single input with the key generations its slot's heading lists, which its facts are filled with
 * (`SlotFill`). */
export type BindInput =
	| {
			readonly kind: "single"
			readonly act: SingleAct
			readonly slot: SlotData
			readonly members: NonEmptyReadonlyArray<InputMember<RelationNormalizer>>
			readonly starts: ReadonlyArray<{ readonly name: string; readonly value: unknown }>
			readonly fill: SlotFill
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

/**
 * What a single input's facts are filled with before any is judged (`filledFacts`): the fields its admission heading
 * states, as the evaluator reads them (fill.ts EvaluatedRelation), and each key generation its slot's heading lists, by
 * its field, the column its statement writes and PostgreSQL's CHECK proves again (ir/law.ts FieldWriting
 * `keyGenerated`). A slot of none fills nothing.
 */
export interface SlotFill {
	readonly stated: EvaluatedRelation
	readonly generations: ReadonlyArray<{ readonly field: string; readonly generation: Generation }>
}

/**
 * The single input's facts `stated`, member `member`'s, each with its key generations filled (`SlotFill`), its identity
 * the one admission gave it, since a key generation is a function of the fields it reads; or the refusal of the first
 * whose generation has none: an expression the host cannot evaluate over it is an encoding failure at the member slot
 * (fill.ts fillRefusal), and NULL its field's law, its witness the fact's first declared key it states whole.
 */
const filledFacts = (
	fill: SlotFill,
	facts: CheckedFacts,
	evaluate: HostEvaluator,
	member: string,
	stated: ReadonlyArray<IdentifiedFact>
): Result.Result<
	ReadonlyArray<IdentifiedFact>,
	EncodingFailure | (GeneratedNull & { readonly key: FillRefusal["key"] })
> => {
	if (fill.generations.length === 0) {
		return Result.ok(stated)
	}
	const filled: Array<IdentifiedFact> = []
	for (const e of stated) {
		const read = (field: string): unknown => e.fact[field]
		const values: Array<readonly [string, unknown]> = []
		for (const { field, generation: g } of fill.generations) {
			const value = generation(evaluate, fill.stated, g, read)
			if (!value.ok) {
				const refusal = fillRefusal(value.error, slotPlace(member))
				return Result.err(
					refusal._tag === "GeneratedNull" ? { ...refusal, key: statedKey(facts, e.fact) } : refusal
				)
			}
			values.push([field, value.value])
		}
		filled.push({
			identity: e.identity,
			fact: Object.freeze({ ...e.fact, ...Object.fromEntries(values) })
		})
	}
	return Result.ok(filled)
}

/** A stated fact's first declared key, its primary key first, whose every field it holds, by field name (fill.ts
 * wholeKey); none where it holds none whole. */
const statedKey = (
	facts: CheckedFacts,
	fact: { readonly [field: string]: unknown }
): Readonly<Record<string, KeyHost>> | undefined => {
	const specs = new Map(
		facts.host.keys.flatMap((k) => k.fields).map((f) => [f.field, f.spec] as const)
	)
	return wholeKey(
		facts.host.keys.map((k) => k.fields.map((f) => f.field)),
		(name) => {
			const value = fact[name]
			const spec = specs.get(name)
			return value === undefined || spec === undefined
				? undefined
				: keyHostOf(admitted(spec, value))
		}
	)
}

/** The member slots a compiled ChangeSet reads, each once, in the order its slot groups name them: the slots whose
 * facts `MemberFacts` must hold. */
export const memberSlots = (groups: ReadonlyArray<GroupData>): ReadonlyArray<string> => [
	...new Set(groups.flatMap((g) => g.inputs.flatMap((i) => i.members)))
]

/**
 * How the same-key checks read one kind of entry: their canonical order, the order they are judged in; the key of an
 * entry's fields, their key texts in the fields' order (identity.ts keyText: a float's -0 and +0 one key, as
 * PostgreSQL's equality holds them) as one identity (core/text.ts textsId), which a TextsMap holds a key's entries by,
 * hashing it once; and an entry's value of a field, which a span's overlap and a refusal's witness read; each reader
 * built once for its fields and read per entry. An admitted fact is read by
 * its fields' names (`factReading`), a nested row at its cells' positions, its texts the ones its write holds
 * (`rowReading`), so no nested row is read through a record of its fields.
 */
interface EntryReading<E> {
	readonly order: (a: E, b: E) => number
	readonly key: (fields: ReadonlyArray<KeySpec>) => (entry: E) => TextsId
	readonly value: (field: string) => (entry: E) => unknown
}

/** An admitted fact's reading (`EntryReading`): in its identities' canonical order, each field read by its name, its
 * key text worked out from its value, which the fact's carriers already admitted (identity.ts keyText). */
const factReading: EntryReading<IdentifiedFact> = {
	order: (a, b) => compareTextsIds(a.identity, b.identity),
	key: (fields) => (entry) =>
		textsId(fields.map(({ field, spec }) => keyText(spec, admittedText(spec, entry.fact[field])))),
	value: (field) => (entry) => entry.fact[field]
}

/** A nested row's reading (`EntryReading`), a relation's of `columns`: in its identities' canonical order, an admitted
 * fact's, each field read at its column's position among the relation's, its key text of the text its write holds
 * (cells.ts textAt, identity.ts keyText). */
const rowReading = (columns: Columns): EntryReading<NestedRow> => ({
	order: (a, b) => compareTextLists(a.identity, b.identity),
	key: (fields) => {
		const at = fields.map(({ field, spec }) => ({ at: columns.at(columnKeyOf(field)), spec }))
		return (row) =>
			textsId(at.map((c) => keyText(c.spec, textAt(row.values, row.texts, c.at, c.spec))))
	},
	value: (field) => {
		const at = columns.at(columnKeyOf(field))
		return (row) => row.values[at]
	}
})

/**
 * The admitted facts of `facts`, member `member`'s, against a slot's heading, by its member's normalizer, refused with
 * the codec's fault at the member slot. The codec checks no key: normalization refuses a same-key pair itself (step 3).
 * Its facts are read first, none of their bytes read (codec/recordset.ts ReadRelation), or, where `facts` is an array
 * decode admitted, its facts read under an equal heading, taken as decode read them (runtime/write/decoded.ts
 * keptReads); then an input whose arrays no Bind message of `transport` carries, with the statement's own fields and
 * its placeholders, is refused as its MessageBound before any is: before a digest is worked out or a copy made.
 *
 * The codec's identities are factIdentity's over the slot heading, the identity this module keys facts by.
 */
const admit = (
	normalize: RelationNormalizer,
	member: string,
	facts: Iterable<unknown>,
	book: DigestBook,
	transport: Transport
): Result.Result<ReadonlyArray<IdentifiedFact>, EncodingFailure | MessageBound> => {
	const kept = keptReads(facts, normalize.plan)
	const read = kept === undefined ? normalize.read(facts) : normalize.kept(kept)
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
const collect = (set: TextsMap<IdentifiedFact>, entries: ReadonlyArray<IdentifiedFact>): void => {
	for (const e of entries) {
		set.getOrInsertComputed(e.identity, () => e)
	}
}

/** A key field of a fact, by the name the fact holds it under, and its type: a field the fact states, or a key
 * generation, which the host fills before any key is compared (`KeyGeneration`, `filledFacts`). */
export interface HostKeyField {
	readonly field: string
	readonly type: ScalarType
}

/**
 * A key generation of a written relation (ir/law.ts FieldWriting `keyGenerated`): its field, its type and the table of
 * the expression it is generated by, which the host fills every stated fact's value of by its one generation (fill.ts
 * generation) before any key is compared or any row is sent (`filledFacts`), whichever keys the host checks.
 */
export interface KeyGeneration {
	readonly field: string
	readonly type: ScalarType
	readonly generation: ExprTable
}

/** The host's same-key checks of one written relation's additions (see `normalizeChangeSet`, step 3), decided with the
 * relation: each declared key's law and fields, primary key first, but a key over a generated field PostgreSQL computes,
 * which the host never holds, so the statement that writes the facts compares them there (insert/unique.ts
 * `hostHeld`), a key generation being one the host fills; and each span candidate key whose pairs the probe leaves to
 * the host (`checks`, `Probed`), its law, its compared fields and its span field. A conflict at a span key names its
 * compared fields, then its span field. Each compares every addition, or the ones it names (`AdditionOp`). */
export interface HostChecks {
	readonly keys: ReadonlyArray<HostKey>
	readonly spans: ReadonlyArray<HostSpanKey>
}

/** A declared key the host compares a relation's additions at: its law and its fields, every addition's, or those of
 * one kind (`AdditionOp`). */
export type HostKey =
	| {
			readonly law: LawId
			readonly described: RecordedLaw
			readonly fields: ReadonlyArray<HostKeyField>
	  }
	| {
			readonly law: LawId
			readonly described: RecordedLaw
			readonly fields: ReadonlyArray<HostKeyField>
			readonly compares: AdditionOp
	  }

/** A span candidate key the host compares a relation's additions at (`HostChecks`), every addition's, or those of one
 * kind (`AdditionOp`). */
export type HostSpanKey =
	| {
			readonly law: LawId
			readonly described: RecordedLaw
			readonly equal: ReadonlyArray<HostKeyField>
			readonly span: { readonly field: string; readonly type: SpanType }
	  }
	| {
			readonly law: LawId
			readonly described: RecordedLaw
			readonly equal: ReadonlyArray<HostKeyField>
			readonly span: { readonly field: string; readonly type: SpanType }
			readonly compares: AdditionOp
	  }

/**
 * The operation whose additions of a stratum's one relation a key or span key over a field the stratum's insert
 * computes compares: every row of the call holds the call's one value of that field (ir/instant.ts Stamp `call`), which only the
 * statement that writes the rows computes, so the key compares the puts' alone at all of its fields (`put`) and the
 * inserted facts' alone at its other fields (`insert`), which tell two rows of one call apart. A put and an inserted
 * fact meet at such a key in their statements, the insert after the put (write/frontend/schedule.ts), whose arbiter or
 * probe meets the put's fact as a stored one. Every other key compares every addition.
 */
export type AdditionOp = "put" | "insert"

/** Whose additions a checked key compares: every addition's, or one kind's (`AdditionOp`). */
type KeyCompares = "every" | AdditionOp

/** Whose additions `key` compares (`KeyCompares`). */
const comparedBy = (key: HostKey | HostSpanKey): KeyCompares =>
	"compares" in key ? key.compares : "every"

/** A key field as the host compares facts at it: its name, and its carrier's spec under the installation's codes. */
interface KeySpec {
	readonly field: string
	readonly spec: CarrierSpec
}

/** A declared key as the host compares facts at it (`HostKey`), each field by its spec. */
interface CheckedKey {
	readonly law: LawId
	readonly described: RecordedLaw
	readonly fields: ReadonlyArray<KeySpec>
	readonly compares: KeyCompares
}

/** The host's same-key checks under the installation's codes (`HostChecks`): each key's fields by their specs, and each
 * span key's compared fields, its span field's range spec and the fields a conflict at it names. */
interface CheckedKeys {
	readonly keys: ReadonlyArray<CheckedKey>
	readonly spans: ReadonlyArray<{
		readonly law: LawId
		readonly described: RecordedLaw
		readonly equal: ReadonlyArray<KeySpec>
		readonly span: {
			readonly field: string
			readonly spec: Extract<CarrierSpec, { readonly carrier: SpanCarrier }>
		}
		readonly witness: ReadonlyArray<KeySpec>
		readonly compares: KeyCompares
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
				fields: k.fields.map(specOf),
				compares: comparedBy(k)
			})),
			spans: host.spans.map((check) => {
				const equal = check.equal.map(specOf)
				const span = {
					field: check.span.field,
					spec: {
						carrier: check.span.type.carrier,
						width: defined(spanOf(check.span.type), "a range field's range").width
					}
				}
				return {
					law: check.law,
					described: check.described,
					equal,
					span,
					witness: [...equal, { field: span.field, spec: span.spec }],
					compares: comparedBy(check)
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
	const facts = checkedFacts(stated, group.relation, group.facts.host, codes)
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
	/** Each key generation of the group's written relation, by its field, as the host fills it (fill.ts Generation). */
	const generations = new Map(
		group.facts.generations.map((g) => [
			g.field,
			{ expr: g.generation, type: g.type, law: generatedLaw(group.relation, g.field) }
		])
	)
	/** A single input's fill (`SlotFill`): each key generation its slot's heading lists, every one its statement writes,
	 * whichever keys the host checks, so the checks the facts meet and the rows the statement sends hold exactly the
	 * values PostgreSQL's CHECK proves. */
	const fillOf = (input: Extract<InputData, { readonly kind: "single" }>): SlotFill => ({
		stated: evaluatedRelation(input.admitted),
		generations: input.slot.heading.flatMap((column) => {
			const generated = generations.get(column.name)
			return generated === undefined ? [] : [{ field: column.name, generation: generated }]
		})
	})
	const inputOf = (input: InputData): BindInput => {
		switch (input.kind) {
			case "single": {
				const admitBy = normalizer(input.admitted)
				return {
					kind: "single",
					act: input.act,
					slot: input.slot,
					members: mapNonEmpty(input.members, (name) => ({ name, normalize: admitBy(name) })),
					starts: input.starts.map((st) => ({ name: st.name, value: startOf(st) })),
					fill: fillOf(input)
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
		facts,
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
		defect("a key field over a set or bytea, which ownership refuses")
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
	law: { readonly law: LawId; readonly described: RecordedLaw }
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
		defect(`the primary key of ${facts.relation}, which a nested write keys its rows by`)
	}
	return conflictOf(facts, value, entry, primary.fields, primary)
}

/** A stratum's additions of one relation, its puts' and its inserted facts' apart, which a key over a field its insert
 * computes compares each alone (`KeyCompares`). */
interface Additions<E> {
	readonly put: ReadonlyArray<E>
	readonly insert: ReadonlyArray<E>
}

/** The additions a key or span key compares (`KeyCompares`), in the order `additions` holds them. */
const compared = <E>(compares: KeyCompares, additions: Additions<E>): ReadonlyArray<E> =>
	compares === "every" ? [...additions.put, ...additions.insert] : additions[compares]

/**
 * The first of one relation's facts, in canonical order, sharing a declared key's value with an earlier one of another
 * identity under `order`, the keys tried primary key first, each over the additions it compares, `inOrder`'s.
 */
const keyConflictIn = <E>(
	facts: CheckedFacts,
	reading: EntryReading<E>,
	inOrder: (compares: KeyCompares) => ReadonlyArray<E>
): KeyRefusal | undefined => {
	for (const key of facts.host.keys) {
		const { fields } = key
		const keyOf = reading.key(fields)
		const seen = new TextsMap<E>()
		for (const e of inOrder(key.compares)) {
			const k = keyOf(e)
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
	additions: Additions<E>
): KeyRefusal | undefined => {
	if (facts.host.spans.length === 0 && !keyShared(facts, reading, additions)) {
		return undefined
	}
	/** Each kind of addition's in canonical order, sorted once where a check first compares it. */
	const ordered = new Map<KeyCompares, ReadonlyArray<E>>()
	return firstConflict(facts, reading, (compares) =>
		ordered.getOrInsertComputed(compares, () => sorted(reading, compared(compares, additions)))
	)
}

/**
 * Whether two of the additions a key compares, complete additions alone, of different identities share its value: whether
 * `firstConflict` finds a key conflict among them, which no pair of complete additions escapes as one fact. A key that
 * holds two identities holds two that stand next to each other in canonical order, so whether one does depends on the
 * set alone, and is found in the order the entries came in, with no sort: only a write it refuses is sorted, to name
 * the refusal canonical order finds first.
 */
const keyShared = <E>(
	facts: CheckedFacts,
	reading: EntryReading<E>,
	additions: Additions<E>
): boolean => {
	for (const { fields, compares } of facts.host.keys) {
		const keyOf = reading.key(fields)
		const seen = new TextsMap<E>()
		for (const e of compared(compares, additions)) {
			const k = keyOf(e)
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

/** `sameKey`'s refusal over additions in canonical order, each kind's `inOrder`'s. */
const firstConflict = <E>(
	facts: CheckedFacts,
	reading: EntryReading<E>,
	inOrder: (compares: KeyCompares) => ReadonlyArray<E>
): KeyRefusal | undefined => {
	const keyed = keyConflictIn(facts, reading, inOrder)
	if (keyed !== undefined) {
		return keyed
	}
	for (const check of facts.host.spans) {
		const { span, witness } = check
		const keyOf = reading.key(check.equal)
		const spanValue = reading.value(span.field)
		const groups = new TextsMap<Array<{ readonly entry: E; readonly span: HostSpan }>>()
		for (const e of inOrder(check.compares)) {
			const value = admitted(span.spec, spanValue(e))
			const k = keyOf(e)
			const group = groups.getOrInsertComputed(k, () => [])
			group.push({ entry: e, span: value })
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
 * delete's, whose facts name units (`units`). */
type GroupSets = Readonly<Record<"insert" | "put" | "delete" | "units", TextsMap<IdentifiedFact>>>

/** The set a single input's facts join: its operation's, a unit delete's its own (frontend/compile.ts SingleAct). */
const setOf = (act: SingleAct): keyof GroupSets => {
	switch (act.op) {
		case "insert":
		case "put":
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
 * An enumerated member is the query over a relation parameter its array binds, so the host owns its set
 * property and its null ban. For each stratum and each relation, over the write front end's slots
 * (`SlotGroup`), it does what follows, step 1 over every slot before any slot is judged: an input that does not admit
 * is its EncodingFailure whatever law the others break, and a nested write's generated field with no value refuses the
 * application only once every input admits.
 *
 * 1. Admits every fact through its heading's exact carriers, each fact read once and refused by the first fault of
 *    that read (values/identity.ts readFact): the fact whole, NULL or of another shape than its heading's, then each
 *    field in name order, missing, NULL or a value its carrier's exact parse refuses (values/identity.ts admitValue),
 *    before fact identity is taken.
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
 * A nested write's facts are filled by `walk`, the write's filler (nesting.ts NestedWalk), and a single input's key
 * generations by the one generation (fill.ts generation) over `evaluate`, the write's evaluator, each before any key of
 * it is compared (`filledFacts`): every key the host compares is the key its statement writes.
 *
 * The result is each slot's distinct admitted facts in canonical order, the facts the statements read, which the codec
 * encodes. A described member is not normalized here: its DISTINCT and same-key check are in the
 * statement that reads it. */
export const normalizeChangeSet = (
	groups: ReadonlyArray<BindGroup>,
	walk: NestedWalk,
	evaluate: HostEvaluator,
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
			insert: new TextsMap(),
			put: new TextsMap(),
			delete: new TextsMap(),
			units: new TextsMap()
		}
		const slotOf = new Map<keyof GroupSets, SlotData>()
		/** The first of the group's nested writes whose generated field has no value: the group's refusal, once every
		 * input after it is admitted. */
		let stopped: GeneratedRefusal | undefined
		for (const input of enumerated) {
			switch (input.kind) {
				case "nested": {
					slotOf.set("insert", input.slot)
					const set = nested.getOrInsertComputed(stratum, () => nestedSet())
					const relations = reached.getOrInsertComputed(
						stratum,
						() => new Map<StoredRelationName, CheckedFacts>()
					)
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
						/** Its key generations filled before any key of it is compared (`filledFacts`); a generation
						 * with no value refuses the application only once every input admits, as a nested write's. */
						const filled = filledFacts(
							input.fill,
							facts,
							evaluate,
							member.name,
							admittedFacts.value
						)
						if (!filled.ok) {
							if (filled.error._tag !== "GeneratedNull") {
								return Result.err(filled.error)
							}
							stopped ??= {
								kind: "generatedNull",
								law: filled.error.law,
								values: filled.error.key
							}
							continue
						}
						/** A slot that carries fields beyond its facts' holds each at its start (frontend/compile.ts
						 * EnumeratedInput "single"), its identity its facts'. */
						const started = filled.value.map((e): IdentifiedFact =>
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
		for (const [id] of sets.put) {
			sets.insert.delete(id)
		}
		const refused = sameKey(facts, factReading, {
			put: [...sets.put.values()],
			insert: [...sets.insert.values()]
		})
		if (refused !== undefined) {
			return Result.ok(refused)
		}
		for (const [id] of [...sets.insert, ...sets.put]) {
			sets.delete.delete(id)
		}
		for (const [category, slot] of slotOf) {
			normals.push({ slot, relation: facts.stated, normal: normalFacts(sets[category]) })
		}
	}
	/** Each stratum's nested rows by relation, judged as the stratum's additions of that relation (step 3): a row its
	 * set holds once at its key may still share another declared key with another row. */
	const rows = new Map<StratumAt, ReadonlyMap<StoredRelationName, ReadonlyArray<NestedRow>>>()
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
		for (const [name, relationRows] of held) {
			const refused = sameKey(factsOf(name), rowReading(walk.columns(name)), {
				put: [],
				insert: relationRows
			})
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
