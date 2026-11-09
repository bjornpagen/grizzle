/**
 * A nested write: an insert of an owner, or of a tree's roots, with every family it owns nested at its count fields,
 * to any depth.
 *
 * At compile time a nesting is the insert's relation and every family its rows reach, each at its depth (`Reached`), and
 * the heading each level's own fields are admitted by. At bind time each fact is split along its families
 * (write/changeset/value.ts encodeAddition), each level's own fields admitted through its carriers' codecs, the whole
 * nesting filled in one walk by the write's filler, which draws and fills the rest (`NestedWalk`, fold.ts), and its
 * rows cut into each family's write: every
 * owner the ChangeSet inserts is fresh, so each sequence's write is each owner's members placed at slots 0 … n − 1 with
 * no count statement, and a tree's every node in pre-order. The insert's own relation is written by its own insert with
 * its drawn counts and its accumulated ends (`NestingRoot` plain), or, a tree's roots or a counted family's members,
 * with the rest of the rows the nesting writes.
 *
 * A row of a counted family's member, at any depth, is written whole only once that family's own fill completes it
 * (write/family/edit.ts planEdits), from the stored family the read flight finds: the walk fills every other column of
 * it and leaves those the counted family fills (`NestedLayout` pending), which the fill order lets no walked column read.
 */
import { layoutKey } from "#compiler/analysis/theory/fill.ts"
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import {
	positionalColumns,
	type RelationNormalizer,
	relationNormalizer
} from "#compiler/codec/recordset.ts"
import { admittedCell, admittedParam, carrierSpecOf } from "#compiler/codec/scalar.ts"
import type { EncodingFailure, EncodingPlace } from "#compiler/core/errors.ts"
import { defect, defined, invariant } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { compareCodePoints, compareTextTuples } from "#compiler/core/text.ts"
import { type ReadonlyTupleMap, TupleMap } from "#compiler/core/tuple-map.ts"
import type { ParamText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type Family, isSequence, isTreeOf } from "#compiler/ir/family.ts"
import type { FillAt, FillOrder, FillPosition } from "#compiler/ir/fill.ts"
import type { FamilyId, LawField, LawRelation, RelationInfo } from "#compiler/ir/law.ts"
import type { MessageBound } from "#compiler/ir/products.ts"
import type { Heading, HeadingColumn } from "#compiler/ir/rel.ts"
import type { DigestBook } from "#compiler/scalar/values/bytes.ts"
import { admittedText } from "#compiler/scalar/values/identity.ts"
import {
	encodeAddition,
	type NestedAddition,
	type SplitFamily
} from "#compiler/write/changeset/value.ts"
import type { MemberKey, Row } from "#compiler/write/family/draw.ts"
import {
	type ColumnKey,
	columnKey,
	familyKey,
	fieldKey,
	type FilledNode,
	type FillRefusal,
	fillRefusal,
	type GeneratedNull,
	type Filler,
	type HostNode,
	walkStart
} from "#compiler/write/family/fold.ts"
import type { Transport } from "#compiler/write/family/order.ts"
import {
	type LaidColumn,
	type LaidLayout,
	laidLayout,
	type RowLayout,
	rowLayout
} from "#compiler/write/family/statements.ts"

/** A family a nesting reaches, at its depth: 1 for a family of the insert's own rows, n + 1 for one whose owners are a
 * depth-n family's members. */
export interface Reached {
	readonly family: Family
	readonly depth: number
}

/** Where a level of a nesting stands: the insert's own rows, a tree's roots, or a family's members. */
type LevelOf =
	| { readonly kind: "top" }
	| { readonly kind: "root"; readonly family: Family }
	| { readonly kind: "member"; readonly family: Family }

/** One level of a nesting: its relation, where it stands, and the heading its own fields are admitted by. */
interface Level {
	readonly relation: string
	readonly at: LevelOf
	readonly heading: Heading
}

/**
 * Where a nesting's own rows stand and what writes them:
 * - `plain`: the ChangeSet's own rows, which the insert's own statement writes;
 * - `tree`: the roots of the tree of the insert's relation, which their trees' writes insert;
 * - `counted`: the ChangeSet's own rows of a counted family's member, which the rows the nesting writes include, once the
 *   counted family's fill completes them.
 */
export type NestingRoot =
	| { readonly kind: "plain" }
	| { readonly kind: "tree"; readonly family: Family }
	| { readonly kind: "counted" }

/**
 * A relation whose rows a nesting's family statements write: its row layout (statements.ts rowLayout), the columns of it
 * the counted families it is a member of fill after the walk, none for a relation of no counted family, and where its
 * rows stand in the walk, at which the counts and ends of the counted families they own are filled (write/program/
 * bind.ts freshOwners).
 */
export interface NestedLayout {
	readonly layout: RowLayout
	readonly pending: ReadonlySet<ColumnKey>
	readonly position: FillPosition
}

/** A relation whose rows a nesting's family statements write, as a binding holds it (`NestedLayout`): its row layout as
 * binding reads it, the columns its counted families fill after the walk, and where its rows stand in the walk. */
export interface NestedLayoutData {
	readonly layout: LaidLayout
	readonly pending: ReadonlySet<ColumnKey>
	readonly position: FillAt
}

/** Where a level of a nesting stands (`LevelOf`), its family by id. */
type LevelAt =
	| { readonly kind: "top" }
	| { readonly kind: "root" | "member"; readonly family: { readonly id: FamilyId } }

/**
 * A nested write as a binding holds it (`Nesting`), every family by id and every relation by name: its relation and its
 * primary key's fields, where its own rows stand, the sequences its facts split along, where the walk starts, its
 * levels with the heading each one's own fields are admitted by, the layout of each relation its family statements
 * write, and the fields its own row writes.
 */
export interface NestingData {
	readonly relation: string
	readonly primary: NonEmptyReadonlyArray<HeadingColumn>
	readonly root:
		| { readonly kind: "plain" | "counted" }
		| { readonly kind: "tree"; readonly family: { readonly id: FamilyId } }
	readonly sequences: ReadonlyArray<SplitFamily>
	readonly start: FillAt
	readonly levels: ReadonlyArray<{
		readonly relation: string
		readonly at: LevelAt
		readonly heading: Heading
	}>
	readonly layouts: ReadonlyMap<string, NestedLayoutData>
	readonly top: Heading
}

/** A heading as a binding holds it, each column its name and type alone. */
export const headingData = (heading: Heading): Heading =>
	heading.map((c) => ({ name: c.name, type: c.type }))

/** A family's id as a binding holds it, a record of its owner and count alone. */
const idData = (id: FamilyId): { readonly id: FamilyId } => ({
	id: { owner: id.owner, count: id.count }
})

/** A position as a binding holds it, its family by id. */
const atData = (at: LevelOf | FillPosition): LevelAt =>
	at.kind === "top" ? { kind: "top" } : { kind: at.kind, family: idData(at.family.id) }

/** A nesting as a binding holds it (`NestingData`). */
export const nestingData = (nesting: Nesting): NestingData => ({
	relation: nesting.relation.name,
	primary: mapNonEmpty(nesting.relation.primaryFields, (f) => ({ name: f.name, type: f.type })),
	root:
		nesting.root.kind === "tree"
			? { kind: "tree", family: idData(nesting.root.family.id) }
			: { kind: nesting.root.kind },
	sequences: nesting.families.filter(isSequence).map((f) => ({
		id: idData(f.id).id,
		owner: f.owner.name,
		member: f.member.name,
		count: f.count.name
	})),
	start: atData(nesting.start),
	levels: nesting.levels.map((l) => ({
		relation: l.relation,
		at: atData(l.at),
		heading: headingData(l.heading)
	})),
	layouts: new Map(
		[...nesting.layouts].map(([relation, at]) => [
			relation,
			{ layout: laidLayout(at.layout), pending: at.pending, position: atData(at.position) }
		])
	),
	top: headingData(nesting.top)
})

/** What a nested write's walk fills its rows by when it binds: the write's filler (fold.ts filler) and the installation's
 * codes, which every level's own fields are admitted by. */
export interface NestedWalk {
	readonly fill: Filler
	readonly codes: Codebook
}

/** A nested write as compiled: see the module's header. */
export interface Nesting {
	readonly relation: RelationInfo
	readonly root: NestingRoot
	readonly families: ReadonlyArray<Family>
	/** Every family the nesting reaches, in the order its writes are composed: shallowest first. */
	readonly reached: ReadonlyArray<Reached>
	/** Where the walk starts its rows: a tree's root, or the insert's own row. */
	readonly start: FillPosition
	readonly levels: ReadonlyArray<Level>
	/** Each relation whose rows its family statements write: every reached member relation, and the insert's own unless
	 * its root is plain. */
	readonly layouts: ReadonlyMap<string, NestedLayout>
	/** The fields the insert's own row writes: every field of its relation but a generated one. */
	readonly top: Heading
}

/** A level's key in a nesting's normalizers. */
const levelKey = (relation: string, at: LevelAt): string =>
	at.kind === "top"
		? `${relation}\u0000top`
		: `${relation}\u0000${at.kind}\u0000${familyKey(at.family.id)}`

/** The fields of a level a fact supplies: its caller's and its serial ones, but those its nesting supplies: a member's
 * group, a tree node's root field, and a tree root's parent, which is itself. */
const ownHeading = (relation: LawRelation, at: LevelOf): Heading => {
	const supplied = new Set<string>(
		at.kind === "top"
			? []
			: [
					...at.family.group.map((g) => g.member.name),
					...(at.kind === "member" && at.family.members.kind === "tree"
						? [at.family.members.root.name]
						: [])
				]
	)
	return relation.fields
		.filter(
			(f) => (f.writing.kind === "caller" || f.writing.kind === "serial") && !supplied.has(f.name)
		)
		.map((f) => ({ name: f.name, type: f.type }))
}

/**
 * The columns of `relation` the counted families it is a member of fill, after the walk: each one's columns at its
 * member's position that its own fill writes, its index, ‹n›, copies and accumulators.
 */
const pendingOf = (fill: FillOrder, relation: string): ReadonlySet<ColumnKey> =>
	new Set(
		fill.families
			.filter((f) => f.member.name === relation && !isSequence(f))
			.flatMap((family) => {
				const layout = fill.layouts.get(layoutKey(relation, { kind: "member", family }))
				if (layout === undefined) {
					throw defect(`the layout of ${relation} as a member of ${familyKey(family.id)}`)
				}
				return layout.columns.flatMap((c) =>
					c.writer.kind === "counted" && familyKey(c.writer.family.id) === familyKey(family.id)
						? [columnKey(c.column)]
						: []
				)
			})
	)

/**
 * The nesting of an insert into `relation` by the schema's fill order: every family it reaches, each at its depth, and
 * its levels' headings. The fill order admits no sequences that nest each other in a cycle, so each sequence is reached
 * once, a tree's own members by its recursion, and every reached row is filled by the walk, but the columns its counted
 * families fill.
 */
export const nestingOf = (relation: RelationInfo, fill: FillOrder): Nesting => {
	const families = fill.families
	const tree = families.find((f) => isTreeOf(f, relation.name))
	const root: NestingRoot =
		tree !== undefined
			? { kind: "tree", family: tree }
			: families.some((f) => f.member.name === relation.name && !isSequence(f))
				? { kind: "counted" }
				: { kind: "plain" }
	const reached: Array<Reached> = []
	let frontier: ReadonlyArray<{ readonly relation: string; readonly depth: number }> = [
		{ relation: relation.name, depth: 1 }
	]
	while (frontier.length > 0) {
		const next: Array<{ readonly relation: string; readonly depth: number }> = []
		for (const { relation: owner, depth } of frontier) {
			for (const f of families.filter((g) => g.owner.name === owner && isSequence(g))) {
				reached.push({ family: f, depth })
				if (!isTreeOf(f, owner)) {
					next.push({ relation: f.member.name, depth: depth + 1 })
				}
			}
		}
		frontier = next
	}
	const layouts = new Map<string, NestedLayout>()
	const start = walkStart(families, relation.name)
	/** The insert's own relation as a family's member, a tree's or a counted family's, when its family statements write
	 * its rows, at the walk's start. */
	const own = families.find((f) => f.member.name === relation.name)?.member
	const written: ReadonlyArray<{ readonly member: RelationInfo; readonly position: FillPosition }> =
		[
			...(root.kind === "plain" || own === undefined ? [] : [{ member: own, position: start }]),
			...reached.map((r) => ({
				member: r.family.member,
				position: { kind: "member" as const, family: r.family }
			}))
		]
	for (const { member, position } of written) {
		if (!layouts.has(member.name)) {
			layouts.set(member.name, {
				layout: rowLayout(member, families),
				pending: pendingOf(fill, member.name),
				position
			})
		}
	}
	const rootAt: LevelOf = tree === undefined ? { kind: "top" } : { kind: "root", family: tree }
	const levels: Array<Level> = [
		{ relation: relation.name, at: rootAt, heading: ownHeading(relation, rootAt) },
		...reached.map(({ family }) => {
			const at: LevelOf = { kind: "member", family }
			return { relation: family.member.name, at, heading: ownHeading(family.member, at) }
		})
	]
	return Object.freeze({
		relation,
		root,
		families,
		reached: Object.freeze(reached.toSorted((a, b) => a.depth - b.depth)),
		start,
		levels: Object.freeze(levels),
		layouts,
		top: relation.fields
			.filter((f) => f.writing.kind !== "generated")
			.map((f) => ({ name: f.name, type: f.type }))
	})
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
		string,
		TupleMap<ReadonlyArray<ParamText>, TupleMap<ReadonlyArray<Signed>, NestedFact>>
	>
	readonly rows: Map<string, TupleMap<MemberKey, TupleMap<ReadonlyArray<string>, NestedRow>>>
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
	const normalizers = new Map(
		nesting.levels.map((l): readonly [string, RelationNormalizer] => [
			levelKey(l.relation, l.at),
			relationNormalizer({
				relation: l.relation,
				columns: positionalColumns(l.heading),
				slot: { kind: "slot", name: member },
				codes: walk.codes
			})
		])
	)
	const sequences = nesting.sequences
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
		const host = hostNodes(nesting, normalizers, split.value, { member, book, transport })
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
const byCodePoint = <A>(
	entries: Iterable<readonly [string, A]>
): ReadonlyArray<readonly [string, A]> =>
	[...entries].toSorted(([a], [b]) => compareCodePoints(a, b))

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
): { readonly relation: string; readonly fact: NestedFact } | undefined => {
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
): ReadonlyMap<string, ReadonlyTupleMap<MemberKey, NestedRow>> =>
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
const text = (codes: Codebook, type: LawField["type"], value: unknown): ParamText =>
	admittedParam(carrierSpecOf(type, codes), value)

/** A value's canonical text in its column's carrier, its identity (scalar/values/identity.ts canonicalText). */
const canonical = (codes: Codebook, type: LawField["type"], value: unknown): string =>
	admittedText(carrierSpecOf(type, codes), value)

/**
 * A split fact as the filler's nesting: each level's own fields admitted through its normalizer, iteratively, members
 * built before their owners, so any depth converts.
 */
const hostNodes = (
	nesting: NestingData,
	normalizers: ReadonlyMap<string, RelationNormalizer>,
	root: NestedAddition,
	write: {
		readonly member: string
		readonly book: DigestBook
		readonly transport: Transport
	}
): Result.Result<HostNode, EncodingFailure | MessageBound> => {
	/** Every addition in pre-order, with the level it stands at. */
	const order: Array<{ readonly addition: NestedAddition; readonly at: LevelAt }> = []
	const pending: Array<{ readonly addition: NestedAddition; readonly at: LevelAt }> = [
		{
			addition: root,
			at:
				nesting.root.kind === "tree"
					? { kind: "root", family: nesting.root.family }
					: { kind: "top" }
		}
	]
	const byId = new Map(nesting.sequences.map((f) => [familyKey(f.id), f] as const))
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		order.push(next)
		for (const g of next.addition.families) {
			const family = defined(byId.get(familyKey(g.family)), "a sequence the nesting splits along")
			for (const m of g.members) {
				pending.push({ addition: m, at: { kind: "member", family } })
			}
		}
	}
	const built = new Map<NestedAddition, HostNode>()
	for (let i = order.length - 1; i >= 0; i -= 1) {
		const { addition, at } = defined(order[i], "a nested addition met in pre-order")
		const normalize = normalizers.get(levelKey(addition.relation, at))
		if (normalize === undefined) {
			throw defect(`the level of ${addition.relation} a nesting reaches`)
		}
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
		readonly relation: string
		readonly key: NonEmptyReadonlyArray<C>
		readonly columns: ReadonlyArray<C>
	}
	readonly pending: ReadonlySet<ColumnKey>
}): {
	readonly relation: string
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
): ReadonlyMap<string, ReadonlyArray<NestedRow>> => {
	const out = new Map<string, Array<NestedRow>>()
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
