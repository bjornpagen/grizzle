/**
 * A nested write: an insert of an owner, or of a tree's roots, with every family it owns nested at its count fields,
 * to any depth (fin.md §4.5, D4).
 *
 * At compile time a nesting is the insert's relation and every family its rows reach, each at its depth (`Reached`), the
 * heading each level's own fields are admitted by, and the filler that draws and fills the rest (fold.ts). At bind time
 * each fact is split along its families (write/changeset/value.ts encodeAddition), each level's own fields admitted
 * through its carriers' codecs, the whole nesting filled in one walk, and its rows cut into each family's write
 * (order.ts FamilyWrite): every owner the ChangeSet inserts is fresh, so each family's write is each owner's members
 * placed at slots 0 … n − 1 with no count statement (`count: inserted`), and a tree's every node in pre-order
 * (tree.ts walk). The insert's own relation, when no tree's, is written by its own insert with its drawn count and its
 * accumulated ends; a tree's roots are written with the rest of their trees.
 */
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import {
	positionalColumns,
	type RelationNormalizer,
	relationNormalizer
} from "#compiler/codec/recordset.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import type { EncodingFailure } from "#compiler/core/errors.ts"
import { defect, defined, invariant } from "#compiler/core/invariant.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { compareCodePoints } from "#compiler/core/text.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type Family, isSequence, isTreeOf } from "#compiler/ir/family.ts"
import type { FillOrder } from "#compiler/ir/fill.ts"
import type { LawField, LawRelation } from "#compiler/ir/law.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { admittedText } from "#compiler/scalar/values/identity.ts"
import { encodeAddition, type NestedAddition } from "#compiler/write/changeset/value.ts"
import { type Row, textsKey } from "#compiler/write/family/draw.ts"
import {
	familyKey,
	fieldKey,
	type FilledNode,
	type FillRefusal,
	filler as fillerOf,
	type Filler,
	type HostEvaluator,
	type HostNode
} from "#compiler/write/family/fold.ts"
import { type RowLayout, rowLayout } from "#compiler/write/family/statements.ts"

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

/** A nested write as compiled: see the module's header. */
export interface Nesting {
	readonly relation: LawRelation
	/** The tree the insert's relation is the relation of, whose roots its facts are. */
	readonly tree: Family | undefined
	readonly families: ReadonlyArray<Family>
	/** Every family the nesting reaches, in the order its writes are composed: shallowest first. */
	readonly reached: ReadonlyArray<Reached>
	readonly codes: Codebook
	readonly filler: Filler
	readonly levels: ReadonlyArray<Level>
	/** Each reached member relation's row layout (statements.ts rowLayout). */
	readonly layouts: ReadonlyMap<string, RowLayout>
	/** The fields the insert's own row writes: every field of its relation but a generated one. */
	readonly top: Heading
}

/** A level's key in a nesting's normalizers. */
const levelKey = (relation: string, at: LevelOf): string =>
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
 * The nesting of an insert into `relation` by the schema's fill order: every family it reaches, each at its depth, its
 * levels' headings, and its filler. The fill order admits no sequences that nest each other in a cycle and no counted
 * family's member a nesting reaches, so each sequence is reached once, a tree's own members by its recursion, and every
 * reached row is filled by the walk.
 */
export const nestingOf = (
	relation: LawRelation,
	fill: FillOrder,
	codes: Codebook,
	evaluate: HostEvaluator
): Nesting => {
	const families = fill.families
	const tree = families.find((f) => isTreeOf(f, relation.name))
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
	const built = fillerOf(fill, codes, evaluate)
	const layouts = new Map<string, RowLayout>()
	for (const name of new Set(reached.map((r) => r.family.member.name))) {
		const member = defined(
			reached.find((r) => r.family.member.name === name),
			"a reached member"
		).family.member
		layouts.set(name, rowLayout(member, families))
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
		tree,
		families,
		reached: Object.freeze(reached.toSorted((a, b) => a.depth - b.depth)),
		codes,
		filler: built,
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
 * A reached member relation's row, as one nested write fills it: its texts in its relation's row layout (draw.ts Row),
 * its fields' host values by name, which the host's same-key checks read, and its identity, the texts of every column,
 * so two rows are one exactly when every column is.
 */
export interface NestedRow {
	readonly identity: string
	readonly row: Row
	readonly fact: NestedFact
}

/**
 * One stratum's nested writes as sets (rule 0), across its every nested input, array or Stream: each insert's facts by
 * their relation and their key's text, each with its host values and the signature of every row it nests; and each
 * reached member relation's rows by their key's text (draw.ts textsKey) and their identity. A fact or a row stated
 * twice, in one array, across arrays or across inserts, is one. Two signatures or two identities at one key are a key
 * conflict, which `nestedConflict` names once every input is in, so the refusal depends on the set alone, never on the
 * order its facts came in. Each relation's rows keep the order they are inserted in: each owner's members in slot
 * order, a tree's nodes in pre-order.
 */
export interface NestedSet {
	readonly tops: Map<string, Map<string, NestedTop>>
	readonly rows: Map<string, Map<string, Map<string, NestedRow>>>
}

/** An insert's facts at one key of its relation: the first's host values, and the signature of every row each nests. */
interface NestedTop {
	readonly fact: NestedFact
	readonly signatures: Set<string>
}

/** A stratum's nested writes before any fact: no fact and no row. */
export const nestedSet = (): NestedSet => ({ tops: new Map(), rows: new Map() })

/** A fill's refusal as the member's encoding failure: the value it could not fill is outside its column's type. */
const fillFailure = (member: string, refused: FillRefusal): EncodingFailure =>
	encodeFailure(refused.kind === "range" ? "integerRange" : "factShape", slotPlace(member))

/**
 * The facts of a nested member `member` added into `into`, the stratum's nested set, by the nesting's levels'
 * normalizers for that member; their own rows, each insert's own relation's when it is no tree's, for its slot's own
 * normalization. Each fact is split along its sequences, its levels admitted, filled, and cut into whole rows. A fact
 * `into` holds already, at its key with every row it nests, adds nothing.
 */
export const nestedRows = (
	nesting: Nesting,
	member: string,
	facts: Iterable<unknown>,
	into: NestedSet
): Result.Result<ReadonlyArray<NestedFact>, EncodingFailure> => {
	const normalizers = new Map(
		nesting.levels.map((l): readonly [string, RelationNormalizer] => [
			levelKey(l.relation, l.at),
			relationNormalizer({
				relation: l.relation,
				columns: positionalColumns(l.heading),
				slot: { kind: "slot", name: member },
				codes: nesting.codes
			})
		])
	)
	const sequences = nesting.families.filter(isSequence)
	const tops: Array<NestedFact> = []
	const relation = nesting.relation.name
	const byKey = into.tops.get(relation) ?? new Map<string, NestedTop>()
	into.tops.set(relation, byKey)
	const keyFields = nesting.relation.keyNames.find((k) => k.primary)?.fields ?? []
	for (const fact of facts) {
		const split = encodeAddition(relation, fact, sequences)
		if (!split.ok) {
			return Result.err(encodeFailure(split.error.fault, slotPlace(member)))
		}
		const host = hostNodes(nesting, normalizers, split.value)
		if (!host.ok) {
			return host
		}
		const filled = nesting.filler(host.value)
		if (!filled.ok) {
			return Result.err(fillFailure(member, filled.error))
		}
		const root = filled.value
		const own = Object.freeze(
			Object.fromEntries(
				nesting.top.map((c) => [c.name, root.values.get(fieldKey(c.name))] as const)
			)
		)
		const key = textsKey(
			keyFields.map((f) => text(nesting, f.type, root.values.get(fieldKey(f.name))))
		)
		const written = rowsOf(nesting, root)
		const signature = textsKey(
			[...written].flatMap(([r, list]) => [r, ...list.map((n) => n.identity)])
		)
		const held = byKey.get(key)
		if (held?.signatures.has(signature) === true) {
			continue
		}
		if (held === undefined) {
			byKey.set(key, { fact: own, signatures: new Set([signature]) })
		} else {
			held.signatures.add(signature)
		}
		if (nesting.tree === undefined) {
			tops.push(own)
		}
		for (const [reached, list] of written) {
			const known = into.rows.get(reached) ?? new Map<string, Map<string, NestedRow>>()
			into.rows.set(reached, known)
			for (const row of list) {
				const at = textsKey(row.row.key)
				const identities = known.get(at) ?? new Map<string, NestedRow>()
				known.set(at, identities)
				identities.set(row.identity, row)
			}
		}
	}
	return Result.ok(tops)
}

/** Text order by code point. */
const byCodePoint = <A>(
	entries: Iterable<readonly [string, A]>
): ReadonlyArray<readonly [string, A]> =>
	[...entries].toSorted(([a], [b]) => compareCodePoints(a, b))

/**
 * The first key conflict of a stratum's nested set: an insert's relation's key at which two facts nest different rows,
 * then a member relation's key holding two rows; relations in code point order and keys in their texts' code point
 * order, so the conflict named is the set's, whatever order its facts came in. `fact` is the host values of one of
 * them, which agree at the key.
 */
export const nestedConflict = (
	set: NestedSet
): { readonly relation: string; readonly fact: NestedFact } | undefined => {
	for (const [relation, byKey] of byCodePoint(set.tops)) {
		for (const [, top] of byCodePoint(byKey)) {
			if (top.signatures.size > 1) {
				return { relation, fact: top.fact }
			}
		}
	}
	for (const [relation, byKey] of byCodePoint(set.rows)) {
		for (const [, identities] of byCodePoint(byKey)) {
			if (identities.size > 1) {
				const [row] = identities.values()
				return { relation, fact: defined(row, "a row of two").fact }
			}
		}
	}
	return undefined
}

/** A nested set with no conflict as its rows: each member relation's, by key, in the order they are inserted. */
export const nestedRowsOf = (set: NestedSet): ReadonlyMap<string, ReadonlyMap<string, NestedRow>> =>
	new Map(
		[...set.rows].map(([relation, byKey]) => [
			relation,
			new Map(
				[...byKey].map(([key, identities]) => {
					invariant(
						identities.size === 1,
						"a nested set with no conflict holds one row at each key"
					)
					const [row] = identities.values()
					return [key, defined(row, "the row at a key")] as const
				})
			)
		])
	)

/** A value's text in its column's carrier, as the transport writes it. */
const text = (nesting: Nesting, type: LawField["type"], value: unknown): string =>
	admittedText(carrierSpecOf(type, nesting.codes), value)

/**
 * A split fact as the filler's nesting: each level's own fields admitted through its normalizer, iteratively, members
 * built before their owners, so any depth converts.
 */
const hostNodes = (
	nesting: Nesting,
	normalizers: ReadonlyMap<string, RelationNormalizer>,
	root: NestedAddition
): Result.Result<HostNode, EncodingFailure> => {
	/** Every addition in pre-order, with the level it stands at. */
	const order: Array<{ readonly addition: NestedAddition; readonly at: LevelOf }> = []
	const pending: Array<{ readonly addition: NestedAddition; readonly at: LevelOf }> = [
		{
			addition: root,
			at: nesting.tree === undefined ? { kind: "top" } : { kind: "root", family: nesting.tree }
		}
	]
	const byId = new Map(nesting.families.map((f) => [familyKey(f.id), f] as const))
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		order.push(next)
		for (const g of next.addition.families) {
			const family = defined(byId.get(familyKey(g.family)), "a nested family of the law model")
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
		const admitted = normalize([addition.fact])
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

/** A filled row as its relation's set holds it (`NestedRow`): its texts in its relation's row layout, its key and then
 * its other columns, its fields' host values, and its identity. */
const nestedRowOf = (nesting: Nesting, layout: RowLayout, row: FilledNode): NestedRow => {
	const valueOf = (c: RowLayout["columns"][number]): unknown => {
		if (!row.values.has(c.key)) {
			throw defect(`a column ${c.key} of ${row.relation} the filler filled`)
		}
		return row.values.get(c.key)
	}
	const textOf = (c: RowLayout["columns"][number]): string => text(nesting, c.type, valueOf(c))
	const texts: Row = { key: mapNonEmpty(layout.key, textOf), columns: layout.columns.map(textOf) }
	const fact = Object.freeze(
		Object.fromEntries(
			[...layout.key, ...layout.columns].flatMap((c) =>
				c.column.kind === "field" ? [[c.column.field.name, valueOf(c)] as const] : []
			)
		)
	)
	return { identity: textsKey([...texts.key, ...texts.columns]), row: texts, fact }
}

/**
 * Every reached member relation's rows of one filled nesting, whole, in the order they are inserted: one iterative
 * pre-order pass over the rows, each owner's families' members in slot order, so a tree's nodes come in pre-order and
 * every sequence's members in ascending slot order, each after its owner.
 */
const rowsOf = (
	nesting: Nesting,
	root: FilledNode
): ReadonlyMap<string, ReadonlyArray<NestedRow>> => {
	const out = new Map<string, Array<NestedRow>>()
	const pending: Array<FilledNode> = [root]
	for (let row = pending.pop(); row !== undefined; row = pending.pop()) {
		if (row !== root || nesting.tree !== undefined) {
			const layout = nesting.layouts.get(row.relation)
			if (layout === undefined) {
				throw defect(`the row layout of ${row.relation}, a relation the nesting reaches`)
			}
			const list = out.get(row.relation) ?? []
			list.push(nestedRowOf(nesting, layout, row))
			out.set(row.relation, list)
		}
		const members = row.families.flatMap((g) => g.members)
		for (let i = members.length - 1; i >= 0; i -= 1) {
			pending.push(defined(members[i], "a member of a filled nesting"))
		}
	}
	return out
}
