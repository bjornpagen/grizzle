/**
 * A nested write: an insert of an owner, or of a tree's roots, with every family it owns nested at its count fields,
 * to any depth.
 *
 * At compile time a nesting is the insert's relation and every family its rows reach, each at its depth (`Reached`), and
 * the heading each level's own fields are admitted by. At bind time each fact is split along its families
 * (runtime/write/addition.ts encodeAddition), each level's own fields admitted through its carriers' codecs, the whole
 * nesting filled in one walk by the write's filler, which draws and fills the rest (runtime/write/nesting.ts
 * NestedWalk, runtime/write/fill.ts), and its rows cut into each family's write: every owner the ChangeSet inserts is
 * fresh, so each sequence's write is each owner's members placed at slots 0 … n − 1 with no count statement, and a
 * tree's every node in pre-order. The insert's own relation is written by its own insert with
 * its drawn counts and its accumulated ends (`NestingRoot` plain), or, a tree's roots or a counted family's members,
 * with the rest of the rows the nesting writes.
 *
 * A row of a counted family's member, at any depth, is written whole only once that family's own fill completes it
 * (write/family/edit.ts planEdits), from the stored family the read flight finds: the walk fills every other column of
 * it and leaves those the counted family fills (`NestedLayout` pending), which the fill order lets no walked column read.
 */
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { type Family, isSequence, isTreeOf } from "#compiler/ir/family.ts"
import { type FillAt, type FillOrder, type FillPosition, layoutKey } from "#compiler/ir/fill.ts"
import { type FamilyId, familyKey, type LawRelation, type RelationInfo } from "#compiler/ir/law.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { type ColumnKey, columnKey } from "#compiler/runtime/write/fill.ts"
import type { NestingData } from "#compiler/runtime/write/nesting.ts"
import { walkStart } from "#compiler/write/family/fold.ts"
import { laidLayout, type RowLayout, rowLayout } from "#compiler/write/family/statements.ts"

/** A family a nesting reaches, at its depth: 1 for a family of the insert's own rows, n + 1 for one whose owners are a
 * depth-n family's members; with the heading each of its members' own fields are admitted by, the level they stand at. */
export interface Reached {
	readonly family: Family
	readonly depth: number
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

/** A heading as a binding holds it, each column its name and type alone. */
export const headingData = (heading: Heading): Heading =>
	heading.map((c) => ({ name: c.name, type: c.type }))

/** A family's id as a binding holds it, a record of its owner and count alone. */
const idData = (id: FamilyId): { readonly id: FamilyId } => ({
	id: { owner: id.owner, count: id.count }
})

/** A position as a binding holds it, its family by id. */
const atData = (at: FillPosition): FillAt =>
	at.kind === "top" ? { kind: "top" } : { kind: at.kind, family: idData(at.family.id) }

/** A nesting as a binding holds it (`NestingData`). */
export const nestingData = (nesting: Nesting): NestingData => ({
	relation: nesting.relation.name,
	primary: mapNonEmpty(nesting.relation.primaryFields, (f) => ({ name: f.name, type: f.type })),
	root:
		nesting.root.kind === "tree"
			? { kind: "tree", family: idData(nesting.root.family.id) }
			: { kind: nesting.root.kind },
	own: headingData(nesting.own),
	sequences: nesting.reached.map(({ family, heading }) => ({
		id: idData(family.id).id,
		owner: family.owner.name,
		member: family.member.name,
		count: family.count.name,
		heading: headingData(heading)
	})),
	start: atData(nesting.start),
	layouts: new Map(
		[...nesting.layouts].map(([relation, at]) => [
			relation,
			{ layout: laidLayout(at.layout), pending: at.pending, position: atData(at.position) }
		])
	),
	top: headingData(nesting.top)
})

/** A nested write as compiled: see the module's header. */
export interface Nesting {
	readonly relation: RelationInfo
	readonly root: NestingRoot
	readonly families: ReadonlyArray<Family>
	/** Every family the nesting reaches, in the order its writes are composed: shallowest first. */
	readonly reached: ReadonlyArray<Reached>
	/** Where the walk starts its rows: a tree's root, or the insert's own row. */
	readonly start: FillPosition
	/** The heading the fact's own fields are admitted by, where its own rows stand: the insert's own or a tree's root. */
	readonly own: Heading
	/** Each relation whose rows its family statements write: every reached member relation, and the insert's own unless
	 * its root is plain. */
	readonly layouts: ReadonlyMap<StoredRelationName, NestedLayout>
	/** The fields the insert's own row writes: every field of its relation but a generated one. */
	readonly top: Heading
}

/** The fields of a level a fact supplies: its caller's and its serial ones, but those its nesting supplies: a member's
 * group, a tree node's root field, and a tree root's parent, which is itself. */
const ownHeading = (relation: LawRelation, at: FillPosition): Heading => {
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
	let frontier: ReadonlyArray<{ readonly relation: StoredRelationName; readonly depth: number }> = [
		{ relation: relation.name, depth: 1 }
	]
	while (frontier.length > 0) {
		const next: Array<{ readonly relation: StoredRelationName; readonly depth: number }> = []
		for (const { relation: owner, depth } of frontier) {
			for (const f of families.filter((g) => g.owner.name === owner && isSequence(g))) {
				reached.push({
					family: f,
					depth,
					heading: ownHeading(f.member, { kind: "member", family: f })
				})
				if (!isTreeOf(f, owner)) {
					next.push({ relation: f.member.name, depth: depth + 1 })
				}
			}
		}
		frontier = next
	}
	const layouts = new Map<StoredRelationName, NestedLayout>()
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
	return Object.freeze({
		relation,
		root,
		families,
		reached: Object.freeze(reached.toSorted((a, b) => a.depth - b.depth)),
		start,
		own: ownHeading(
			relation,
			tree === undefined ? { kind: "top" } : { kind: "root", family: tree }
		),
		layouts,
		top: relation.fields
			.filter((f) => f.writing.kind !== "generated")
			.map((f) => ({ name: f.name, type: f.type }))
	})
}
