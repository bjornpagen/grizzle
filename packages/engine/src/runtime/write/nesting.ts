/**
 * A nested write as binding runs it, from its data (`NestingData`): each fact split along its families, each level's own
 * fields admitted, the whole nesting filled in one walk by the write's filler (runtime/write/fill.ts), and its rows cut
 * into each relation its family statements write, every relation's rows one set across the stratum's nested writes.
 */
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import {
	positionalColumns,
	type RelationNormalizer,
	relationNormalizer
} from "#compiler/codec/recordset.ts"
import { admittedCell, admittedParam, carrierSpecOf } from "#compiler/codec/scalar.ts"
import type { EncodingFailure, EncodingPlace } from "#compiler/core/errors.ts"
import type { ColumnIdent, StoredRelationName } from "#compiler/core/ids.ts"
import { defect, defined, invariant } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { compareCodePoints, compareTextTuples } from "#compiler/core/text.ts"
import { type ReadonlyTupleMap, TupleMap } from "#compiler/core/tuple-map.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { FillAt } from "#compiler/ir/fill.ts"
import { type FamilyId, familyKey } from "#compiler/ir/law.ts"
import type { MessageBound } from "#compiler/ir/products.ts"
import type { Heading, HeadingColumn } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	encodeAddition,
	type NestedAddition,
	type SplitFamily
} from "#compiler/runtime/write/addition.ts"
import type { MemberKey, Row } from "#compiler/runtime/write/draw.ts"
import {
	type ColumnKey,
	fieldKey,
	type FilledNode,
	type Filler,
	type FillRefusal,
	fillRefusal,
	type GeneratedNull,
	type HostNode
} from "#compiler/runtime/write/fill.ts"
import type { Transport } from "#compiler/runtime/write/transport.ts"
import type { DigestBook } from "#compiler/scalar/values/bytes.ts"
import { admittedText } from "#compiler/scalar/values/identity.ts"

/** A row layout's column as binding reads it (`RowColumn`): its key, its type, and what it is, a field by its name or a law
 * column by its identifier. A RowColumn is one. */
export interface LaidColumn {
	readonly key: ColumnKey
	readonly type: ScalarType
	readonly column:
		| { readonly kind: "field"; readonly field: { readonly name: string } }
		| { readonly kind: "law"; readonly column: ColumnIdent }
}

/** A row layout as binding reads it (`RowLayout`): its relation, its key's columns and its others'. A RowLayout is one. */
export interface LaidLayout {
	readonly relation: StoredRelationName
	readonly key: NonEmptyReadonlyArray<LaidColumn>
	readonly columns: ReadonlyArray<LaidColumn>
}

/** A relation whose rows a nesting's family statements write, as a binding holds it (`NestedLayout`): its row layout as
 * binding reads it, the columns its counted families fill after the walk, and where its rows stand in the walk. */
export interface NestedLayoutData {
	readonly layout: LaidLayout
	readonly pending: ReadonlySet<ColumnKey>
	readonly position: FillAt
}

/** A sequence a nesting reaches (`Reached`), the level of its members: what its facts split along, with the heading
 * each member's own fields are admitted by. */
export interface NestedSequence extends SplitFamily {
	readonly heading: Heading
}

/**
 * A nested write as a binding holds it (`Nesting`), every family by id and every relation by name: its relation and its
 * primary key's fields, where its own rows stand, the heading its facts' own fields are admitted by, each sequence it
 * reaches with its members' heading, where the walk starts, the layout of each relation its family statements write,
 * and the fields its own row writes. A fact's levels are its own and then each sequence's, so a level of a nesting is
 * its fact's or exactly one sequence's members, wherever its own rows stand: the insert's own rows or a tree's roots.
 */
export interface NestingData {
	readonly relation: StoredRelationName
	readonly primary: NonEmptyReadonlyArray<HeadingColumn>
	readonly root:
		| { readonly kind: "plain" | "counted" }
		| { readonly kind: "tree"; readonly family: { readonly id: FamilyId } }
	readonly own: Heading
	/** Every sequence the nesting reaches, each once, since a relation is a member of at most one. */
	readonly sequences: ReadonlyArray<NestedSequence>
	readonly start: FillAt
	readonly layouts: ReadonlyMap<StoredRelationName, NestedLayoutData>
	readonly top: Heading
}

/** What a nested write's walk fills its rows by when it binds: the write's filler (fold.ts filler) and the installation's
 * codes, which every level's own fields are admitted by. */
export interface NestedWalk {
	readonly fill: Filler
	readonly codes: Codebook
}

/** A fact's host values by field name, as its codecs admitted them (scalar/values/identity.ts CarrierHost). */
export type NestedFact = { readonly [field: string]: unknown }

/**
 * A row one nested write fills, of a relation its family statements write: the host value of every column of its row
 * layout the walk filled, by key, every column but those its counted families fill afterwards (`NestedLayout`
 * pending); its fields' host values by name, which the host's same-key checks read; and its identity, the canonical
 * texts of every column the walk filled (scalar/values/identity.ts canonicalText), its key's first, so two rows are one
 * exactly when each such column is. The identity is those texts themselves, never one text joined from them: its size
 * is its row's arity, whatever its texts' lengths.
 */
export interface NestedRow {
	readonly identity: ReadonlyArray<string>
	/** Its key's texts, which its relation's rows are a set by. */
	readonly key: MemberKey
	readonly values: ReadonlyMap<ColumnKey, unknown>
	readonly fact: NestedFact
}

/**
 * One element of a nested fact's signature: a canonical text of its own row, the insert's own statement's to write, or
 * a row it nests as its relation's set holds it, the first of its identity, so two facts nest one row exactly when they
 * hold one element.
 */
type Signed = string | NestedRow

/**
 * One stratum's nested writes as sets (rule 0), across its every nested input, array or Stream: each insert's facts by
 * their relation and their key's texts, each signature at a key with the host values of its first fact; and each
 * reached member relation's rows by their key's texts and their identity. A fact's signature is its own row's texts
 * when the insert's own statement writes it, then every row it nests, each row the set's one of its identity: a tuple
 * as long as its rows are many, never their texts joined. A fact or a row stated twice, in one array, across arrays or
 * across inserts, is one. Two signatures or two identities at one key are a key conflict, which `nestedConflict` names
 * once every input is in, so the refusal depends on the set alone, never on the order its facts came in. Each
 * relation's rows keep the order they are inserted in: each owner's members in slot order, a tree's nodes in pre-order.
 */
export interface NestedSet {
	readonly tops: Map<
		StoredRelationName,
		TupleMap<ReadonlyArray<ParamText>, TupleMap<ReadonlyArray<Signed>, NestedFact>>
	>
	readonly rows: Map<
		StoredRelationName,
		TupleMap<MemberKey, TupleMap<ReadonlyArray<string>, NestedRow>>
	>
}

/** A stratum's nested writes before any fact: no fact and no row. */
export const nestedSet = (): NestedSet => ({ tops: new Map(), rows: new Map() })

/**
 * A nested write's generated field with no value (`GeneratedNull`), with the key of the row its walk stopped at
 * (FillRefusal key): the first of the write's rows whose term has no value, since the walk evaluates every generated
 * field of each row it meets before the next.
 */
export interface NestedGeneratedNull extends GeneratedNull {
	readonly key: FillRefusal["key"]
}

/** A walk's refusal as the nested write's (fold.ts fillRefusal), a generated field with no value at the row it stopped. */
const nestedRefusal = (
	refused: FillRefusal,
	place: EncodingPlace
): EncodingFailure | NestedGeneratedNull => {
	const refusal = fillRefusal(refused.stop, place)
	return refusal._tag === "GeneratedNull" ? { ...refusal, key: refused.key } : refusal
}

/**
 * The facts of a nested member `member` added into `into`, the stratum's nested set, by the nesting's levels'
 * normalizers for that member; their own rows, each insert's own relation's when it is no tree's, for its slot's own
 * normalization. Every fact is split along its sequences and its levels admitted before any is filled, then each is
 * filled and cut into whole rows. A fill that finds a generated field with no value refuses the write by its law
 * (NestedGeneratedNull, the first such fact's) only once every other fact has filled, so an encoding failure of any
 * fact is the write's refusal instead. A fact `into` holds already, at its key with every row it nests, adds nothing.
 * A level's row whose binary arrays no Bind message of `transport` carries alone, with the row's placeholders, is
 * refused as its MessageBound before any of its bytes is read, since a family write's statements are cut row by row
 * (write/family/order.ts).
 */
export const nestedRows = (
	nesting: NestingData,
	walk: NestedWalk,
	member: string,
	facts: Iterable<unknown>,
	into: NestedSet,
	book: DigestBook,
	transport: Transport
): Result.Result<
	ReadonlyArray<NestedFact>,
	EncodingFailure | MessageBound | NestedGeneratedNull
> => {
	const normalizerOf = (relation: StoredRelationName, heading: Heading): RelationNormalizer =>
		relationNormalizer({
			relation,
			columns: positionalColumns(heading),
			slot: { kind: "slot", name: member },
			codes: walk.codes
		})
	const sequences = nesting.sequences
	const normalizers: LevelNormalizers = {
		own: normalizerOf(nesting.relation, nesting.own),
		members: new Map(
			sequences.map((f) => [familyKey(f.id), normalizerOf(f.member, f.heading)] as const)
		)
	}
	const tops: Array<NestedFact> = []
	const relation = nesting.relation
	const byKey =
		into.tops.get(relation) ??
		new TupleMap<ReadonlyArray<ParamText>, TupleMap<ReadonlyArray<Signed>, NestedFact>>()
	into.tops.set(relation, byKey)
	const keyFields = nesting.primary
	const hosts: Array<HostNode> = []
	for (const fact of facts) {
		const split = encodeAddition(relation, fact, sequences)
		if (!split.ok) {
			return Result.err(encodeFailure(split.error.fault, slotPlace(member)))
		}
		const host = hostNodes(normalizers, split.value, { member, book, transport })
		if (!host.ok) {
			return host
		}
		hosts.push(host.value)
	}
	let stopped: NestedGeneratedNull | undefined
	for (const host of hosts) {
		const filled = walk.fill(host, nesting.start)
		if (!filled.ok) {
			const refusal = nestedRefusal(filled.error, slotPlace(member))
			if (refusal._tag !== "GeneratedNull") {
				return Result.err(refusal)
			}
			stopped ??= refusal
			continue
		}
		const root = filled.value
		const own = Object.freeze(
			Object.fromEntries(
				nesting.top.map((c) => [c.name, root.values.get(fieldKey(c.name))] as const)
			)
		)
		const key = keyFields.map((f) => text(walk.codes, f.type, root.values.get(fieldKey(f.name))))
		const signature: Array<Signed> =
			nesting.root.kind === "plain"
				? nesting.top.map((c) => canonical(walk.codes, c.type, own[c.name]))
				: []
		for (const [reached, list] of rowsOf(nesting, walk.codes, root)) {
			const known =
				into.rows.get(reached) ??
				new TupleMap<MemberKey, TupleMap<ReadonlyArray<string>, NestedRow>>()
			into.rows.set(reached, known)
			for (const row of list) {
				const identities = known.get(row.key) ?? new TupleMap<ReadonlyArray<string>, NestedRow>()
				known.set(row.key, identities)
				const held = identities.get(row.identity) ?? row
				identities.set(row.identity, held)
				signature.push(held)
			}
		}
		const signatures = byKey.get(key) ?? new TupleMap<ReadonlyArray<Signed>, NestedFact>()
		byKey.set(key, signatures)
		if (signatures.has(signature)) {
			continue
		}
		signatures.set(signature, own)
		if (nesting.root.kind === "plain") {
			tops.push(own)
		}
	}
	return stopped === undefined ? Result.ok(tops) : Result.err(stopped)
}

/** Text order by code point. */
const byCodePoint = <K extends string, A>(
	entries: Iterable<readonly [K, A]>
): ReadonlyArray<readonly [K, A]> => [...entries].toSorted(([a], [b]) => compareCodePoints(a, b))

/** Keys in their texts' order (core/text.ts compareTextTuples). */
const byTexts = <A>(
	entries: Iterable<readonly [ReadonlyArray<ParamText>, A]>
): ReadonlyArray<readonly [ReadonlyArray<ParamText>, A]> =>
	[...entries].toSorted(([a], [b]) => compareTextTuples(a, b))

/**
 * The first key conflict of a stratum's nested set: an insert's relation's key at which two facts nest different rows,
 * then a member relation's key holding two rows; relations in code point order and keys in their texts' order, so the
 * conflict named is the set's, whatever order its facts came in. `fact` is the host values of one of them, which agree
 * at the key.
 */
export const nestedConflict = (
	set: NestedSet
): { readonly relation: StoredRelationName; readonly fact: NestedFact } | undefined => {
	for (const [relation, byKey] of byCodePoint(set.tops)) {
		for (const [, signatures] of byTexts(byKey)) {
			if (signatures.size > 1) {
				const [fact] = signatures.values()
				return { relation, fact: defined(fact, "a fact of two") }
			}
		}
	}
	for (const [relation, byKey] of byCodePoint(set.rows)) {
		for (const [, identities] of byTexts(byKey)) {
			if (identities.size > 1) {
				const [row] = identities.values()
				return { relation, fact: defined(row, "a row of two").fact }
			}
		}
	}
	return undefined
}

/** A nested set with no conflict as its rows: each member relation's, by key, in the order they are inserted. */
export const nestedRowsOf = (
	set: NestedSet
): ReadonlyMap<StoredRelationName, ReadonlyTupleMap<MemberKey, NestedRow>> =>
	new Map(
		[...set.rows].map(([relation, byKey]) => {
			const rows = new TupleMap<MemberKey, NestedRow>()
			for (const [key, identities] of byKey) {
				invariant(identities.size === 1, "a nested set with no conflict holds one row at each key")
				const [row] = identities.values()
				rows.set(key, defined(row, "the row at a key"))
			}
			return [relation, rows] as const
		})
	)

/** A key value's text in its column's carrier, as the transport writes it. */
const text = (codes: Codebook, type: ScalarType, value: unknown): ParamText =>
	admittedParam(carrierSpecOf(type, codes), value)

/** A value's canonical text in its column's carrier, its identity (scalar/values/identity.ts canonicalText). */
const canonical = (codes: Codebook, type: ScalarType, value: unknown): string =>
	admittedText(carrierSpecOf(type, codes), value)

/** The normalizers of a nesting's levels: its facts' own, and each sequence's members', by the sequence's key. */
interface LevelNormalizers {
	readonly own: RelationNormalizer
	readonly members: ReadonlyMap<string, RelationNormalizer>
}

/**
 * A split fact as the filler's nesting: each level's own fields admitted through its normalizer, the fact's own
 * through its own and each member's through its sequence's, iteratively, members built before their owners, so any
 * depth converts.
 */
const hostNodes = (
	normalizers: LevelNormalizers,
	root: NestedAddition,
	write: {
		readonly member: string
		readonly book: DigestBook
		readonly transport: Transport
	}
): Result.Result<HostNode, EncodingFailure | MessageBound> => {
	/** Every addition in pre-order, with the normalizer of the level it stands at. */
	const order: Array<{
		readonly addition: NestedAddition
		readonly normalize: RelationNormalizer
	}> = []
	const pending: Array<{
		readonly addition: NestedAddition
		readonly normalize: RelationNormalizer
	}> = [{ addition: root, normalize: normalizers.own }]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		order.push(next)
		for (const g of next.addition.families) {
			const normalize = defined(
				normalizers.members.get(familyKey(g.family)),
				"a sequence the nesting splits along"
			)
			for (const m of g.members) {
				pending.push({ addition: m, normalize })
			}
		}
	}
	const built = new Map<NestedAddition, HostNode>()
	for (let i = order.length - 1; i >= 0; i -= 1) {
		const { addition, normalize } = defined(order[i], "a nested addition met in pre-order")
		const read = normalize.read([addition.fact])
		if (!read.ok) {
			return read
		}
		const { frame, messageBytes } = write.transport
		const bytes = frame.statement + normalize.columns * frame.parameter + read.value.widest
		if (bytes > messageBytes) {
			return Result.err({ _tag: "MessageBound", input: write.member, bytes, limit: messageBytes })
		}
		const admitted = normalize.admit(read.value, write.book)
		if (!admitted.ok) {
			return admitted
		}
		const values = defined(admitted.value.facts[0], "one admitted fact of one")
		built.set(
			addition,
			Object.freeze({
				relation: addition.relation,
				values: new Map(Object.entries(values).map(([k, v]) => [fieldKey(k), v] as const)),
				families: Object.freeze(
					addition.families.map((g) =>
						Object.freeze({
							family: g.family,
							members: Object.freeze(
								g.members.map((m) => defined(built.get(m), "a member built before its owner"))
							)
						})
					)
				)
			})
		)
	}
	return Result.ok(defined(built.get(root), "the nesting's root"))
}

/**
 * The columns of a relation's row layout its nesting's walk fills, key first: every one but those its counted families
 * fill after the walk (`NestedLayout` pending), which each of its nested rows holds (`NestedRow`) and a family write
 * sends them with (write/family/additions.ts RowSource).
 */
export const sentLayout = <C extends LaidColumn>(at: {
	readonly layout: {
		readonly relation: StoredRelationName
		readonly key: NonEmptyReadonlyArray<C>
		readonly columns: ReadonlyArray<C>
	}
	readonly pending: ReadonlySet<ColumnKey>
}): {
	readonly relation: StoredRelationName
	readonly key: NonEmptyReadonlyArray<C>
	readonly columns: ReadonlyArray<C>
} => ({
	relation: at.layout.relation,
	key: at.layout.key,
	columns: at.layout.columns.filter((c) => !at.pending.has(c.key))
})

/** A filled row as its relation's set holds it (`NestedRow`): every column of its row layout the walk filled, its
 * fields' host values, and its identity. */
const nestedRowOf = (codes: Codebook, at: NestedLayoutData, row: FilledNode): NestedRow => {
	const sent = sentLayout(at)
	const filled = [...sent.key, ...sent.columns]
	const values = new Map<ColumnKey, unknown>()
	for (const c of filled) {
		if (!row.values.has(c.key)) {
			throw defect(`a column ${c.key} of ${row.relation} the filler filled`)
		}
		values.set(c.key, row.values.get(c.key))
	}
	const fact = Object.freeze(
		Object.fromEntries(
			filled.flatMap((c) =>
				c.column.kind === "field" ? [[c.column.field.name, values.get(c.key)] as const] : []
			)
		)
	)
	return {
		identity: Object.freeze(filled.map((c) => canonical(codes, c.type, values.get(c.key)))),
		key: mapNonEmpty(at.layout.key, (c) => text(codes, c.type, values.get(c.key))),
		values,
		fact
	}
}

/**
 * A relation's row in its row layout's cells (draw.ts Row), from the host value of every column of it: a nested row's
 * once the walk and its counted families' fills hold every column.
 */
export const rowOfValues = (
	codes: Codebook,
	layout: LaidLayout,
	values: ReadonlyMap<ColumnKey, unknown>
): Row => {
	const valueOf = (c: LaidColumn): unknown => {
		if (!values.has(c.key)) {
			throw defect(`a column ${c.key} of ${layout.relation} its fills filled`)
		}
		return values.get(c.key)
	}
	return {
		key: mapNonEmpty(layout.key, (c) => admittedParam(carrierSpecOf(c.type, codes), valueOf(c))),
		columns: layout.columns.map((c) => admittedCell(carrierSpecOf(c.type, codes), valueOf(c)))
	}
}

/**
 * Every reached member relation's rows of one filled nesting, whole, in the order they are inserted: one iterative
 * pre-order pass over the rows, each owner's families' members in slot order, so a tree's nodes come in pre-order and
 * every sequence's members in ascending slot order, each after its owner.
 */
const rowsOf = (
	nesting: NestingData,
	codes: Codebook,
	root: FilledNode
): ReadonlyMap<StoredRelationName, ReadonlyArray<NestedRow>> => {
	const out = new Map<StoredRelationName, Array<NestedRow>>()
	const pending: Array<FilledNode> = [root]
	for (let row = pending.pop(); row !== undefined; row = pending.pop()) {
		if (row !== root || nesting.root.kind !== "plain") {
			const layout = nesting.layouts.get(row.relation)
			if (layout === undefined) {
				throw defect(`the row layout of ${row.relation}, a relation the nesting reaches`)
			}
			const list = out.get(row.relation) ?? []
			list.push(nestedRowOf(codes, layout, row))
			out.set(row.relation, list)
		}
		const members = row.families.flatMap((g) => g.members)
		for (let i = members.length - 1; i >= 0; i -= 1) {
			pending.push(defined(members[i], "a member of a filled nesting"))
		}
	}
	return out
}
