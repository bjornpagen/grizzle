import { defect, defined, invariant } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { type ReadonlyTupleMap, TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
/**
 * A nested write as binding runs it, from its data (`NestingData`): each fact split along its families, each level's own
 * fields admitted, the whole nesting filled in one walk by the write's filler (runtime/write/fill.ts), and its rows cut
 * into each relation its family statements write, every relation's rows one set across the stratum's nested writes.
 */
import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { slotPlace } from "#compiler/codec/fault.ts"
import {
	positionalColumns,
	type RelationNormalizer,
	relationNormalizer,
	type RowRefusal
} from "#compiler/codec/recordset.ts"
import { carrierSpecOf, cellOfText, paramOfText } from "#compiler/codec/scalar.ts"
import type { EncodingFailure, EncodingPlace } from "#compiler/core/errors.ts"
import type { ColumnIdent, StoredRelationName } from "#compiler/core/ids.ts"
import { compareTextTuples } from "#compiler/core/text.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { FillAt } from "#compiler/ir/fill.ts"
import { type FamilyId, type ColumnKey, columnKeyOf } from "#compiler/ir/law.ts"
import type { MessageBound } from "#compiler/ir/products.ts"
import type { Heading, HeadingColumn } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	type AdditionSplitter,
	additionSplitter,
	type LevelRead,
	levelOrder,
	type NestedAddition,
	type NestedReading,
	type NestingLevels,
	type SplitFamily
} from "#compiler/runtime/write/addition.ts"
import {
	type Cells,
	type ColumnIndex,
	type Columns,
	emptyCells,
	type Texts,
	textAt
} from "#compiler/runtime/write/cells.ts"
import { keptReadings } from "#compiler/runtime/write/decoded.ts"
import type { MemberCell, MemberKey } from "#compiler/runtime/write/draw.ts"
import {
	type FilledNode,
	type Filler,
	type FillRefusal,
	fillRefusal,
	type GeneratedNull,
	type HostNode
} from "#compiler/runtime/write/fill.ts"
import type { Transport } from "#compiler/runtime/write/transport.ts"
import type { DigestBook } from "#compiler/scalar/values/bytes.ts"
import type { CarrierSpec } from "#compiler/scalar/values/identity.ts"

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

/** What a nested write's walk fills its rows by when it binds: the write's filler (fill.ts filler), the installation's
 * codes, which every level's own fields are admitted by, and the write's column index (cells.ts ColumnIndex), which its
 * filler lays its rows out by. */
export interface NestedWalk {
	readonly fill: Filler
	readonly codes: Codebook
	readonly columns: ColumnIndex
}

/** A fact's host values by field name, as its codecs admitted them (scalar/values/identity.ts CarrierHost). */
export type NestedFact = { readonly [field: string]: unknown }

/**
 * A row one nested write fills, of a relation its family statements write: its walk's cells (cells.ts Cells), which hold
 * every column of its row layout but those its counted families fill afterwards (`NestedLayout` pending), the row as
 * the walk filled it, never copied, and the texts the write holds of them (cells.ts Texts), every such column's, which
 * the host's same-key checks read at their columns' positions as they read its values (normalize.ts rowReading); and
 * its identity, the canonical texts of every column the walk filled (scalar/values/identity.ts canonicalText), its
 * key's first, so two rows are one exactly when each such column is. The identity is those texts themselves, never one text joined from them: its size is its row's
 * arity, whatever its texts' lengths. Its cells are the same texts but a bytes column's, which travels as its value:
 * each value's text is the one its admission worked out, or, a value the walk drew, worked out once where the row is
 * made (`nestedRowOf`).
 */
export interface NestedRow {
	readonly identity: ReadonlyArray<string>
	/** Its key's texts, which its relation's rows are a set by. */
	readonly key: MemberKey
	readonly values: Cells
	readonly texts: Texts
	/** Its cells, key first, as its family statements send it (draw.ts MemberCell), each column's in its layout's order. */
	readonly cells: ReadonlyArray<MemberCell>
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
		TupleMap<ReadonlyArray<ParamText>, AtKey<ReadonlyArray<Signed>, NestedFact>>
	>
	readonly rows: Map<
		StoredRelationName,
		TupleMap<MemberKey, AtKey<ReadonlyArray<string>, NestedRow>>
	>
}

/** Whether two identities hold the same elements in order, each pair one value. */
const sameIdentity = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean => {
	if (a.length !== b.length) {
		return false
	}
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) {
			return false
		}
	}
	return true
}

/**
 * The distinct values a nested set holds at one key, by their identities, the first first: the first alone while no
 * other identity has come, which is every key of a set with no conflict, and a set of all of them once one has, so a
 * key costs no set of its own until its conflict.
 */
class AtKey<I extends ReadonlyArray<unknown>, V> {
	readonly #identity: I
	readonly #value: V
	#all: TupleMap<I, V> | undefined = undefined
	constructor(identity: I, value: V) {
		this.#identity = identity
		this.#value = value
	}

	/** How many distinct identities the key holds. */
	get size(): number {
		return this.#all?.size ?? 1
	}

	/** The value the key's first identity came with. */
	get first(): V {
		return this.#value
	}

	/** The key's identities, the first first. */
	*keys(): IterableIterator<I> {
		if (this.#all === undefined) {
			yield this.#identity
			return
		}
		yield* this.#all.keys()
	}

	/** The value the key holds of `identity`, `value` added where it holds none. */
	held(identity: I, value: V): V {
		if (sameIdentity(identity, this.#identity)) {
			return this.#value
		}
		const all = this.#all ?? new TupleMap<I, V>().set(this.#identity, this.#value)
		this.#all = all
		const known = all.get(identity)
		if (known !== undefined) {
			return known
		}
		all.set(identity, value)
		return value
	}
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
 * normalization. Every fact is read, split along its sequences and its levels read (`nestedReader`), or, where `facts`
 * is an array decode admitted, its levels read under equal headings, taken as decode read it at these levels re-keyed by
 * decode's families (runtime/write/decoded.ts keptReadings), then its levels measured and admitted, before any is
 * filled, then each is
 * filled and cut into whole rows. A fill that finds a generated field with no value refuses the write by its law
 * (NestedGeneratedNull, the first such fact's) only once every other fact has filled, so an encoding failure of any
 * fact is the write's refusal instead. A fact `into` holds already, at its key with every row it nests, adds nothing.
 * A level's row whose binary arrays no Bind message of `transport` carries alone, with the row's placeholders, is
 * refused as its MessageBound before any of its bytes is read, since a nested write's rows are cut row by row into its
 * statement's fills (runtime/write/staged.ts executionsOf).
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
	const normalizerOf = (relation: StoredRelationName, heading: Heading): Level => {
		const columns = walk.columns(relation)
		const normalize = levelNormalizer(relation, heading, member, walk.codes)
		return {
			normalize,
			fields: normalize.fields.map((name) => ({ name, at: columns.at(columnKeyOf(name)) }))
		}
	}
	const normalizers: NestingLevels<Level> = {
		own: normalizerOf(nesting.relation, nesting.own),
		members: new Map(
			nesting.sequences.map((f) => [f.id, normalizerOf(f.member, f.heading)] as const)
		)
	}
	/** Every level's refusal is placed at the member slot, which each level's normalizer names alike. */
	const place = normalizers.own.normalize.place
	const shapes = new Map<StoredRelationName, RowShape>()
	/** The shape of a reached relation's rows, each relation's made once for the write. */
	const shapeOf = (reached: StoredRelationName): RowShape => {
		const known = shapes.get(reached)
		if (known !== undefined) {
			return known
		}
		const layout = nesting.layouts.get(reached)
		if (layout === undefined) {
			throw defect(`the row layout of ${reached}, a relation the nesting reaches`)
		}
		const made = rowShape(walk.codes, walk.columns(reached), layout)
		shapes.set(reached, made)
		return made
	}
	const tops: Array<NestedFact> = []
	const relation = nesting.relation
	const byKey =
		into.tops.get(relation) ??
		new TupleMap<ReadonlyArray<ParamText>, AtKey<ReadonlyArray<Signed>, NestedFact>>()
	into.tops.set(relation, byKey)
	const own = walk.columns(relation)
	/** A field of the insert's own row as its facts are read: its name, its position among its relation's columns and its
	 * carrier's spec. */
	const shapedField = (c: HeadingColumn) => ({
		name: c.name,
		at: own.at(columnKeyOf(c.name)),
		spec: carrierSpecOf(c.type, walk.codes)
	})
	const keyColumns = nesting.primary.map(shapedField)
	const top = nesting.top.map(shapedField)
	const write = { member, book, transport }
	/** The host nodes of `items` at `levels`, each read into its reading by `readingOf`, then measured and admitted, one
	 * after another, or the first refusal of either. */
	const hostsOf = <A>(
		levels: NestingLevels<Level>,
		items: Iterable<A>,
		readingOf: (item: A) => Result.Result<NestedReading<unknown>, EncodingFailure>
	): Result.Result<ReadonlyArray<HostNode>, EncodingFailure | MessageBound> => {
		const built: Array<HostNode> = []
		for (const item of items) {
			const reading = readingOf(item)
			if (!reading.ok) {
				return reading
			}
			const host = hostNodes(levels, reading.value, write)
			if (!host.ok) {
				return host
			}
			built.push(host.value)
		}
		return Result.ok(built)
	}
	const kept = keptReadings(facts, normalizers)
	const read = nestedReader(relation, normalizers, additionSplitter(nesting.sequences))
	const taken =
		kept === undefined
			? hostsOf(normalizers, facts, (fact) => Result.mapError(read(fact), place))
			: hostsOf(kept.levels, kept.readings, (reading) => readingAgain(kept.levels, reading))
	if (!taken.ok) {
		return taken
	}
	const hosts = taken.value
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
		const fact = Object.freeze(
			Object.fromEntries(top.map((c) => [c.name, root.values[c.at]] as const))
		)
		const textOf = (c: { readonly at: number; readonly spec: CarrierSpec }): string =>
			textAt(root.values, root.texts, c.at, c.spec)
		const key = keyColumns.map((c) => paramOfText(c.spec, textOf(c)))
		const signature: Array<Signed> = nesting.root.kind === "plain" ? top.map(textOf) : []
		for (const [reached, list] of rowsOf(nesting, shapeOf, root)) {
			const known =
				into.rows.get(reached) ?? new TupleMap<MemberKey, AtKey<ReadonlyArray<string>, NestedRow>>()
			into.rows.set(reached, known)
			for (const row of list) {
				const identities = known.get(row.key)
				const held = identities === undefined ? row : identities.held(row.identity, row)
				if (identities === undefined) {
					known.set(row.key, new AtKey(row.identity, row))
				}
				signature.push(held)
			}
		}
		const signatures = byKey.get(key)
		if (signatures === undefined) {
			byKey.set(key, new AtKey<ReadonlyArray<Signed>, NestedFact>(signature, fact))
		} else if (signatures.held(signature, fact) !== fact) {
			continue
		}
		if (nesting.root.kind === "plain") {
			tops.push(fact)
		}
	}
	return stopped === undefined ? Result.ok(tops) : Result.err(stopped)
}

/** Text order by code point. */
const byCodePoint = <K extends string, A>(
	entries: Iterable<readonly [K, A]>
): ReadonlyArray<readonly [K, A]> => [...entries].toSorted(([a], [b]) => compareCodePoints(a, b))

/** The first, in its texts' order (core/text.ts compareTextTuples), of the keys that hold more than one value. */
const firstConflicting = <V>(
	byKey: ReadonlyTupleMap<ReadonlyArray<ParamText>, AtKey<ReadonlyArray<unknown>, V>>
): V | undefined => {
	let first: { readonly key: ReadonlyArray<ParamText>; readonly value: V } | undefined
	for (const [key, held] of byKey) {
		if (held.size > 1 && (first === undefined || compareTextTuples(key, first.key) < 0)) {
			first = { key, value: held.first }
		}
	}
	return first?.value
}

/**
 * The first key conflict of a stratum's nested set: an insert's relation's key at which two facts nest different rows,
 * then a member relation's key holding two rows; relations in code point order and keys in their texts' order, so the
 * conflict named is the set's, whatever order its facts came in. It names one of the two, its fact or its row, which
 * agree at the key.
 */
export const nestedConflict = (
	set: NestedSet
):
	| { readonly kind: "fact"; readonly relation: StoredRelationName; readonly fact: NestedFact }
	| { readonly kind: "row"; readonly relation: StoredRelationName; readonly row: NestedRow }
	| undefined => {
	for (const [relation, byKey] of byCodePoint(set.tops)) {
		const fact = firstConflicting(byKey)
		if (fact !== undefined) {
			return { kind: "fact", relation, fact }
		}
	}
	for (const [relation, byKey] of byCodePoint(set.rows)) {
		const row = firstConflicting(byKey)
		if (row !== undefined) {
			return { kind: "row", relation, row }
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
				rows.set(key, identities.first)
			}
			return [relation, rows] as const
		})
	)

/**
 * A level of a nesting as its facts are admitted: its normalizer, and each field of its heading with its position among
 * its relation's columns, resolved once for the write, in the order an admitted fact's identity holds their texts
 * (codec/recordset.ts RelationNormalizer fields), which a level's admitted fact is laid out by as cells and texts.
 */
interface Level {
	readonly normalize: RelationNormalizer
	readonly fields: ReadonlyArray<{ readonly name: string; readonly at: number }>
}

/**
 * The normalizer of a nesting's level, `relation`'s facts admitted by `heading` under `codes`, each refusal placed at
 * the nested input's member slot `member`: the one a nested write reads each level of its facts by, and a decoded
 * relation's level its rows (program/decode.ts).
 */
export const levelNormalizer = (
	relation: StoredRelationName,
	heading: Heading,
	member: string,
	codes: Codebook
): RelationNormalizer =>
	relationNormalizer({
		relation,
		columns: positionalColumns(heading),
		slot: { kind: "slot", name: member },
		codes
	})

/**
 * The reader of `relation`'s nested facts over `levels`, each with the normalizer it reads its facts by, the one a
 * nested write reads its facts by and a decoded relation its rows (program/decode.ts): each fact split along its
 * sequences by `split`, then every level of it read by its level's normalizer, members before their owners
 * (`levelOrder`), into a reading (`NestedReading`), or the refusal of the first that does not read, unplaced, a fact
 * that does not split refused at its shape. Nothing is measured or admitted: the write measures each level, then admits
 * it (`hostNodes`).
 */
export const nestedReader =
	<L extends { readonly normalize: RelationNormalizer }>(
		relation: StoredRelationName,
		levels: NestingLevels<L>,
		split: AdditionSplitter
	) =>
	(fact: unknown): Result.Result<NestedReading<L>, RowRefusal> => {
		const addition = split(relation, fact)
		if (!addition.ok) {
			return Result.err({ fault: addition.error.fault, field: undefined })
		}
		const order = levelOrder(levels, addition.value)
		const reads: Array<LevelRead<L>> = []
		for (let i = order.length - 1; i >= 0; i -= 1) {
			const { addition: at, level } = defined(order[i], "a nested addition met in pre-order")
			const read = level.normalize.readRow(at.fact)
			if (!read.ok) {
				return read
			}
			reads.push({ level, read: read.value })
		}
		return Result.ok({ addition: addition.value, reads })
	}

/**
 * A reading made earlier (`NestedReading`), a decoded row's, as the write reads it now under its own levels, of
 * headings equal to those it was read under: each level's read taken as it is but its bytes values, checked again
 * (codec/recordset.ts RelationNormalizer again), its refusal placed at the member slot.
 */
const readingAgain = (
	levels: NestingLevels<Level>,
	kept: NestedReading<unknown>
): Result.Result<NestedReading<Level>, EncodingFailure> => {
	const order = levelOrder(levels, kept.addition)
	const reads: Array<LevelRead<Level>> = []
	for (const [at, { read }] of kept.reads.entries()) {
		const { level } = defined(order[order.length - 1 - at], "a level read of each addition")
		const now = level.normalize.again(read)
		if (!now.ok) {
			return now
		}
		reads.push({ level, read: now.value })
	}
	return Result.ok({ addition: kept.addition, reads })
}

/**
 * A nested fact's reading as the filler's nesting: each level's read measured and admitted through its normalizer, the
 * fact's own through its own and each member's through its sequence's, and laid out as its level's cells,
 * iteratively, members built before their owners, so any depth converts.
 */
const hostNodes = (
	normalizers: NestingLevels<Level>,
	reading: NestedReading<unknown>,
	write: {
		readonly member: string
		readonly book: DigestBook
		readonly transport: Transport
	}
): Result.Result<HostNode, EncodingFailure | MessageBound> => {
	const order = levelOrder(normalizers, reading.addition)
	const built = new Map<NestedAddition, HostNode>()
	for (let i = order.length - 1; i >= 0; i -= 1) {
		const { addition, level } = defined(order[i], "a nested addition met in pre-order")
		const { read } = defined(reading.reads[order.length - 1 - i], "a level read of each addition")
		const normalize = level.normalize
		const { frame, messageBytes } = write.transport
		const bytes = frame.statement + normalize.columns * frame.parameter + normalize.alone(read)
		if (bytes > messageBytes) {
			return Result.err({ _tag: "MessageBound", input: write.member, bytes, limit: messageBytes })
		}
		const admitted = normalize.admitOne(read, write.book)
		if (!admitted.ok) {
			return admitted
		}
		const { fact, texts: admittedTexts } = admitted.value
		const values = emptyCells()
		const texts: Texts = []
		for (const [place, field] of level.fields.entries()) {
			values[field.at] = fact[field.name]
			texts[field.at] = admittedTexts[place]
		}
		built.set(
			addition,
			Object.freeze({
				relation: addition.relation,
				values,
				texts,
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
	return Result.ok(defined(built.get(reading.addition), "the nesting's root"))
}

/**
 * The columns of a relation's row layout its nesting's walk fills, key first: every one but those its family statement
 * fills after the walk, its counted families' and its stamps' (`NestedLayout` pending), which each of its nested rows
 * holds (`NestedRow`) and a family write sends them with (write/family/additions.ts RowSource). A stamp fills a key
 * field after its child, so the key keeps that child: the rows of one call are keyed by it, each group's stamp one.
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
} => {
	const [first, ...rest] = at.layout.key.filter((c) => !at.pending.has(c.key))
	if (first === undefined) {
		throw defect(`the key of ${at.layout.relation} its walk fills, a stamp's child`)
	}
	return {
		relation: at.layout.relation,
		key: [first, ...rest],
		columns: at.layout.columns.filter((c) => !at.pending.has(c.key))
	}
}

/** A column of a row layout as a nested row reads it: its key, its position among its relation's columns, and its
 * carrier's spec under the installation's codes. */
interface ShapedColumn {
	readonly key: ColumnKey
	readonly at: number
	readonly spec: CarrierSpec
}

/**
 * What a relation's nested rows are read by, worked out once per write rather than once per row: the columns of its
 * row layout the walk fills (`sentLayout`), its key's then the others', each with its spec.
 */
interface RowShape {
	readonly key: NonEmptyReadonlyArray<ShapedColumn>
	readonly rest: ReadonlyArray<ShapedColumn>
}

const rowShape = (codes: Codebook, columns: Columns, at: NestedLayoutData): RowShape => {
	const shaped = (c: LaidColumn): ShapedColumn => ({
		key: c.key,
		at: columns.at(c.key),
		spec: carrierSpecOf(c.type, codes)
	})
	const sent = sentLayout(at)
	return { key: mapNonEmpty(sent.key, shaped), rest: sent.columns.map(shaped) }
}

/** A filled row as its relation's set holds it (`NestedRow`): its walk's cells and their texts, every sent column's held
 * once it is made, its cells as sent, and its identity, its sent columns' texts. */
const nestedRowOf = (shape: RowShape, row: FilledNode): NestedRow => {
	const { values, texts } = row
	const key = mapNonEmpty(shape.key, (c) =>
		paramOfText(c.spec, textAt(values, texts, c.at, c.spec))
	)
	const cells: Array<MemberCell> = [...key]
	const identity: Array<string> = [...key]
	for (const c of shape.rest) {
		const text = textAt(values, texts, c.at, c.spec)
		cells.push(cellOfText(c.spec, values[c.at], text))
		identity.push(text)
	}
	return { identity: Object.freeze(identity), key, values, texts, cells: Object.freeze(cells) }
}

/**
 * The reader of a relation's rows' cells in a row layout, its key's first (draw.ts MemberCell), from the host value of
 * every column of it and the texts the write holds of them (cells.ts textAt): each column's spec worked out once for
 * the layout, so a row's cells cost one text of each value the write holds none of. A nested owner's row once its
 * counted families' fills drew its counts and ends, and a fresh group's member as its fill drew it, are read so.
 */
export const cellsReader = (
	codes: Codebook,
	columns: Columns,
	layout: LaidLayout
): ((values: Cells, texts: Texts) => ReadonlyArray<MemberCell>) => {
	const shaped = (c: LaidColumn): ShapedColumn => ({
		key: c.key,
		at: columns.at(c.key),
		spec: carrierSpecOf(c.type, codes)
	})
	const key = layout.key.map(shaped)
	const rest = layout.columns.map(shaped)
	return (values, texts) => [
		...key.map((c) => paramOfText(c.spec, textAt(values, texts, c.at, c.spec))),
		...rest.map((c) => cellOfText(c.spec, values[c.at], textAt(values, texts, c.at, c.spec)))
	]
}

/**
 * Every reached member relation's rows of one filled nesting, whole, in the order they are inserted: one iterative
 * pre-order pass over the rows, each owner's families' members in slot order, so a tree's nodes come in pre-order and
 * every sequence's members in ascending slot order, each after its owner.
 */
const rowsOf = (
	nesting: NestingData,
	shapeOf: (relation: StoredRelationName) => RowShape,
	root: FilledNode
): ReadonlyMap<StoredRelationName, ReadonlyArray<NestedRow>> => {
	const out = new Map<StoredRelationName, Array<NestedRow>>()
	const pending: Array<FilledNode> = [root]
	for (let row = pending.pop(); row !== undefined; row = pending.pop()) {
		if (row !== root || nesting.root.kind !== "plain") {
			const list = out.get(row.relation) ?? []
			list.push(nestedRowOf(shapeOf(row.relation), row))
			out.set(row.relation, list)
		}
		const members = row.families.flatMap((g) => g.members)
		for (let i = members.length - 1; i >= 0; i -= 1) {
			pending.push(defined(members[i], "a member of a filled nesting"))
		}
	}
	return out
}
