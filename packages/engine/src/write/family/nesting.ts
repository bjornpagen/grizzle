/**
 * A nested write: an insert of an owner, or of a tree's roots, with every family it owns nested at its count fields,
 * to any depth.
 *
 * At compile time a nesting is the insert's relation and every family its rows reach, each at its depth (`Reached`), and
 * the heading each level's own fields are admitted by. At bind time each fact is split along its families
 * (runtime/write/addition.ts additionSplitter), each level's own fields admitted through its carriers' codecs, the whole
 * nesting filled in one walk by the write's filler, which draws and fills the rest (runtime/write/nesting.ts
 * NestedWalk, runtime/write/fill.ts), and its rows cut into each family's write: every owner the ChangeSet inserts is
 * fresh, so each sequence's write is each owner's members placed at slots 0 … n − 1 with no count statement, and a
 * tree's every node in pre-order. The insert's own relation is written by its own insert with
 * its drawn counts and its accumulated ends (`NestingRoot` plain), or, a tree's roots or a counted family's members,
 * with the rest of the rows the nesting writes.
 *
 * A row of a counted family's member, at any depth, is written whole only once that family's own fill completes it, in
 * its stratum's additions (write/family/additions.ts), from the stored family its statement finds: the walk fills every
 * other column of it and leaves those the counted family fills (`NestedLayout` pending), which the fill order lets no
 * walked column read.
 *
 * What a nested fact states is every column the walk fills of its row (`walkedAt`): its key and its caller's fields,
 * and each column a sequence draws from where the nesting places the row, an owner's count and ends of each sequence it
 * nests and a member's place, copies and accumulators along its sequence, a tree node's interval among them, so an owner
 * inserted again states its whole sequence. A column a counted family fills, its member's index, copies and accumulators
 * and its owner's count and ends, is drawn from the family's stored group, a counted family being a set its inserts
 * append to, so no fact states it: an owner inserted again beside a new member of its counted family is the same fact,
 * and the member is appended.
 *
 * A nesting whose rows leave out a field a stamp fills (ir/instant.ts Stamped), its root's place or clock and every
 * member's field its group carries from one, is a stamped nesting (`stamps`): the walk fills no stamped column, which no
 * fact states and no nested row sends (`NestedLayout` pending), and its one family statement stamps each head once at
 * each of its rows' children and fills every row that carries it from that one stamp (write/family/additions.ts), so
 * every member carries exactly its owner's stamp, never one read again.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { FillAxis } from "#compiler/core/causes.ts"
import { CompileError } from "#compiler/core/errors.ts"
import type { LawId, StoredRelationName } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { type Family, isCopy, isSequence, isTreeOf } from "#compiler/ir/family.ts"
import {
	type FillAt,
	type FillColumn,
	type FillOrder,
	type FillPosition,
	layoutKey
} from "#compiler/ir/fill.ts"
import type { Stamped } from "#compiler/ir/instant.ts"
import {
	type FamilyId,
	familyKey,
	type LawField,
	type LawRelation,
	type RelationInfo,
	type ColumnKey,
	columnKey,
	columnKeyOf,
	type NativeColumn
} from "#compiler/ir/law.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import type { NestedLayoutData, NestingData } from "#compiler/runtime/write/nesting.ts"
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
 * its family statement fills after the walk, those the counted families it is a member of fill and those a stamp fills
 * (Nesting `stamps`), none for a relation of neither, the columns of it the walk fills, which its rows state
 * (`walkedAt`), and where its rows stand in the walk, at which the counts and ends of the counted families they own are
 * filled (runtime/write/bind.ts freshOwners).
 */
export interface NestedLayout {
	readonly layout: RowLayout
	readonly pending: ReadonlySet<ColumnKey>
	readonly walked: ReadonlySet<ColumnKey>
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

/** A relation's layout in a nesting as a binding holds it (`NestedLayoutData`). */
export const nestedLayoutData = (at: NestedLayout): NestedLayoutData => ({
	layout: laidLayout(at.layout),
	pending: at.pending,
	position: atData(at.position)
})

/** A nesting as a binding holds it (`NestingData`): its own rows keyed by their key's fields but those a stamp fills,
 * which every row of a call holds alike in each group (`keyedOf`). */
export const nestingData = (nesting: Nesting): NestingData => ({
	relation: nesting.relation.name,
	primary: mapNonEmpty(
		keyedOf(nesting.relation, nesting.stamps.get(nesting.relation.name) ?? []),
		(f) => ({
			name: f.name,
			type: f.type
		})
	),
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
	layouts: new Map([...nesting.layouts].map(([relation, at]) => [relation, nestedLayoutData(at)])),
	top: headingData(nesting.top),
	pending: nesting.pending
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
	/** The fields the insert's own row writes: every field of its relation but a generated one and those its stamps fill. */
	readonly top: Heading
	/** The columns of the insert's own row the walk fills where it starts (`walkedAt`), which its facts state. */
	readonly walked: ReadonlySet<ColumnKey>
	/** The columns of the insert's own rows its family statement fills, which the walk leaves to it (`statementFilled`):
	 * its stamps' and every generated field over one; none where nothing stamps its rows. */
	readonly pending: ReadonlySet<ColumnKey>
	/**
	 * Each relation of the nesting whose rows leave out a field a stamp fills, with those fields (ir/instant.ts Stamped):
	 * the insert's own, its place, clocks and stamped references, and each member's group field paired with a stamped
	 * field of its owner, stamped by the owner's stamp at the member's fields paired with that stamp's child; none where
	 * no row leaves one out. Its one family statement stamps them all (write/family/additions.ts).
	 */
	readonly stamps: ReadonlyMap<StoredRelationName, NonEmptyReadonlyArray<Stamped>>
}

/**
 * The key fields of `relation` its rows in one call are keyed by: every field of its primary key but one a stamp fills
 * (`stamped`), which every row of the call holds alike at its group, so two rows that agree at the rest meet at the key.
 * A stamp stands after its child in the key, so at least that child is left.
 */
const keyedOf = (
	relation: RelationInfo,
	stamped: ReadonlyArray<Stamped>
): NonEmptyReadonlyArray<LawField> => {
	const [first, ...rest] = relation.primaryFields.filter(
		(f) => !stamped.some((s) => s.field.name === f.name)
	)
	if (first === undefined) {
		defect(`the key of ${relation.name} beyond its stamped fields, its stamps' child`)
	}
	return [first, ...rest]
}

/**
 * The stamps a nesting's members carry from `owned`, the stamps of the rows of their families' owner (Nesting `stamps`):
 * each member field filled with an owner's stamped field, its group field paired with it or its copy along the owner
 * axis, stamped by the owner's stamp at the member's fields the group pairs with that stamp's child, or filled by the
 * owner's computed value, the call's one value of it. A family's group pairs its owner's whole key, and a stamp's child
 * stands in its row's key, so every child field is paired.
 */
const carriedStamps = (family: Family, owned: ReadonlyArray<Stamped>): ReadonlyArray<Stamped> =>
	owned.flatMap((s): ReadonlyArray<Stamped> => {
		const carriers = [
			...family.group.flatMap((g) => (g.owner.name === s.field.name ? [g.member] : [])),
			...family.axes.owner.flatMap((p) =>
				p.to.kind === "field" &&
				p.to.field.name === s.field.name &&
				p.from.kind === "field" &&
				isCopy(family, p.from)
					? [p.from.field]
					: []
			)
		]
		if (carriers.length === 0) {
			return []
		}
		const stamp = s.stamp
		if (stamp.kind === "call") {
			return carriers.map((field) => ({ field, stamp }))
		}
		const child = mapNonEmpty(stamp.child, (c) => {
			const paired = family.group.find((g) => g.owner.name === c.name)
			if (paired === undefined) {
				defect(
					`the member field of ${family.member.name} its group pairs with ${family.owner.name}.${c.name}, a stamp's child`
				)
			}
			return paired.member
		})
		return carriers.map((field) => ({ field, stamp: { ...stamp, child } }))
	})

/** The fields of a level a fact supplies: its caller's, but those its nesting supplies: a member's
 * group, a tree node's root fields among them. A tree's root states its root fields; its parent is drawn. */
const ownHeading = (relation: LawRelation, at: FillPosition): Heading => {
	const supplied = new Set<string>(
		at.kind === "member" ? at.family.group.map((g) => g.member.name) : []
	)
	return relation.fields
		.filter((f) => f.writing.kind === "caller" && !supplied.has(f.name))
		.map((f) => ({ name: f.name, type: f.type }))
}

/**
 * The columns of `relation` the counted families it is a member of fill, after the walk: each one's columns at its
 * member's position that its own fill writes, its index, ‹s›, copies and accumulators.
 */
const pendingOf = (fill: FillOrder, relation: string): ReadonlySet<ColumnKey> =>
	new Set(
		fill.families
			.filter((f) => f.member.name === relation && !isSequence(f))
			.flatMap((family) => {
				const layout = fill.layouts.get(layoutKey(relation, { kind: "member", family }))
				if (layout === undefined) {
					defect(`the layout of ${relation} as a member of ${familyKey(family.id)}`)
				}
				return layout.columns.flatMap((c) =>
					c.writer.kind === "counted" && familyKey(c.writer.family.id) === familyKey(family.id)
						? [columnKey(c.column)]
						: []
				)
			})
	)

/**
 * The columns of `relation` the walk fills where its rows stand at `position` (ir/fill.ts FillWriter `walk`): its key and
 * caller's fields, and every column a sequence draws from where the nesting places the row; never one a counted family
 * fills, which its stored group draws.
 */
const walkedAt = (
	fill: FillOrder,
	relation: RelationInfo,
	position: FillPosition
): ReadonlySet<ColumnKey> => {
	const layout = fill.layouts.get(layoutKey(relation.name, position))
	if (layout === undefined) {
		defect(`the layout of ${relation.name} where a nesting writes its rows`)
	}
	return new Set([
		...relation.primaryFields.map((f) => columnKeyOf(f.name)),
		...layout.columns.flatMap((c) => (c.writer.kind === "walk" ? [columnKey(c.column)] : []))
	])
}

/** A column a fill reads, by the relation of the row that holds it. */
interface Source {
	readonly relation: StoredRelationName
	readonly column: NativeColumn
}

/**
 * The first column the fill of `column` reads that `stamped` holds, of `relation`'s rows at `position`: of its own row
 * (FillColumn reads), its owner's along the owner axis, its predecessor's, or its family's last member's; none where it
 * reads none.
 */
const stampedSource = (
	column: FillColumn,
	relation: StoredRelationName,
	position: FillPosition,
	stamped: (source: Source) => boolean
): Source | undefined => {
	const rule = column.rule
	const across = ((): ReadonlyArray<Source> => {
		switch (rule.kind) {
			case "owner":
			case "ownerCopy":
				return position.kind === "member"
					? [{ relation: position.family.owner.name, column: rule.to }]
					: []
			case "predecessor":
				return [{ relation, column: rule.to }]
			case "last":
				return [{ relation: rule.family.member.name, column: rule.to }]
			case "given":
			case "self":
			case "base":
			case "index":
			case "next":
			case "count":
			case "start":
			case "end":
			case "after":
			case "generated":
				return []
		}
	})()
	return [...column.reads.map((c) => ({ relation, column: c })), ...across].find(stamped)
}

/** The law that fills a column the walk fills by reading another row's column or its own, its family and the axis it reads
 * along: a copy's along its axis, a fold's after on its own row. */
const fillingLaw = (
	column: FillColumn
): { readonly law: LawId; readonly family: Family; readonly axis: FillAxis } => {
	const rule = column.rule
	switch (rule.kind) {
		case "ownerCopy":
			return { law: rule.law, family: rule.family, axis: "owner" }
		case "predecessor":
			return { law: rule.law, family: rule.family, axis: "predecessor" }
		case "last":
			return { law: rule.law, family: rule.family, axis: "last" }
		case "after":
			return { law: rule.law, family: rule.family, axis: "row" }
		case "given":
		case "owner":
		case "self":
		case "base":
		case "index":
		case "next":
		case "count":
		case "start":
		case "end":
		case "generated":
			defect(
				`a ${rule.kind} column ${column.name} reading a stamped one, which its stamps carry or no rule of its reads`
			)
	}
}

/**
 * The columns of each relation a host fill meets, `walked`, a nesting's walk or a fresh fill (frontend/compile.ts
 * freshFillOf), that the statement writing its rows fills: those its stamps fill, `stamped`, and every generated field
 * reading one of them or another such, which PostgreSQL alone computes as it stores the row; or, refused as
 * UnfillableField (FilledLater `stamped`), the first column the fill draws that reads one, which no row the host fills
 * holds. A member's field its group carries from a stamped field is stamped itself (`carriedStamps`), so the walk reads
 * no stamp through its owner.
 */
export const statementFilled = (
	fill: FillOrder,
	walked: ReadonlyArray<{ readonly relation: RelationInfo; readonly position: FillPosition }>,
	stamped: (relation: StoredRelationName) => ReadonlySet<ColumnKey>,
	loc: SourceLoc
): Result.Result<ReadonlyMap<StoredRelationName, ReadonlySet<ColumnKey>>, CompileError> => {
	const filled = new Map<StoredRelationName, Set<ColumnKey>>(
		walked.map((w) => [w.relation.name, new Set(stamped(w.relation.name))] as const)
	)
	const isFilled = (source: Source): boolean =>
		filled.get(source.relation)?.has(columnKey(source.column)) === true
	const layouts = walked.map((w) => ({
		...w,
		layout: defined(
			fill.layouts.get(layoutKey(w.relation.name, w.position)),
			`the layout of ${w.relation.name} where a nesting walks its rows`
		)
	}))
	for (let grew = true; grew;) {
		grew = false
		for (const { relation, position, layout } of layouts) {
			const own = defined(
				filled.get(relation.name),
				`the columns of ${relation.name} its statement fills`
			)
			for (const column of layout.columns) {
				if (own.has(columnKey(column.column))) {
					continue
				}
				const source = stampedSource(column, relation.name, position, isFilled)
				if (source === undefined) {
					continue
				}
				if (column.rule.kind === "generated") {
					own.add(columnKey(column.column))
					grew = true
					continue
				}
				const { law, family, axis } = fillingLaw(column)
				return Result.err(
					CompileError.make({
						_tag: "UnfillableField",
						at: loc,
						relation: relation.name,
						field: column.name,
						law,
						axis,
						family: { owner: family.id.owner, count: family.id.count },
						source: { relation: source.relation, column: columnKey(source.column) },
						later: { kind: "stamped" }
					})
				)
			}
		}
	}
	return Result.ok(filled)
}

/**
 * The nesting of an insert into `relation` by the schema's fill order: every family it reaches, each at its depth, and
 * its levels' headings, its own rows leaving out `stamped`, the fields its insert stamps. The fill order admits no
 * sequences that nest each other in a cycle, so each sequence is reached once, a tree's own members by its recursion, and
 * every reached row is filled by the walk, but the columns its counted families fill and those its family statement fills
 * (`statementFilled`): a stamp's (`stamps`), and every generated field over one. Refused, at `loc`, where the walk would
 * read one of those (`statementFilled`).
 */
export const nestingOf = (
	relation: RelationInfo,
	fill: FillOrder,
	stamped: ReadonlyArray<Stamped>,
	loc: SourceLoc
): Result.Result<Nesting, CompileError> => {
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
	/** Each relation's stamps, its own rows' first, each member's carried from its owner's as the walk reaches it. */
	const stamps = new Map<StoredRelationName, NonEmptyReadonlyArray<Stamped>>()
	const [firstStamp, ...moreStamps] = stamped
	if (firstStamp !== undefined) {
		stamps.set(relation.name, [firstStamp, ...moreStamps])
	}
	for (const { family } of reached.toSorted((a, b) => a.depth - b.depth)) {
		const [first, ...more] = carriedStamps(family, stamps.get(family.owner.name) ?? [])
		if (first !== undefined && !isTreeOf(family, family.member.name)) {
			stamps.set(family.member.name, [first, ...more])
		}
	}
	const start = walkStart(families, relation.name)
	const statement = statementFilled(
		fill,
		[
			{ relation, position: start },
			...reached.map((r) => ({
				relation: r.family.member,
				position: { kind: "member" as const, family: r.family }
			}))
		],
		(name) => new Set((stamps.get(name) ?? []).map((s) => columnKeyOf(s.field.name))),
		loc
	)
	if (!statement.ok) {
		return statement
	}
	/** The columns of `name` its family statement fills, which the walk leaves to it. */
	const stampedOf = (name: StoredRelationName): ReadonlySet<ColumnKey> =>
		statement.value.get(name) ?? new Set()
	const layouts = new Map<StoredRelationName, NestedLayout>()
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
			const filled = stampedOf(member.name)
			layouts.set(member.name, {
				layout: rowLayout(member, families),
				pending: new Set([...pendingOf(fill, member.name), ...filled]),
				walked: new Set([...walkedAt(fill, member, position)].filter((k) => !filled.has(k))),
				position
			})
		}
	}
	const ownStamped = stampedOf(relation.name)
	return Result.ok(
		Object.freeze({
			relation,
			root,
			families,
			/** Each level's heading leaves out the fields its stamps fill, as its own rows' does: a tree's nodes are all the
			 * insert's own rows, every one leaving out what the insert computes. */
			reached: Object.freeze(
				reached
					.map((r) => ({
						...r,
						heading: r.heading.filter(
							(f) => !stampedOf(r.family.member.name).has(columnKeyOf(f.name))
						)
					}))
					.toSorted((a, b) => a.depth - b.depth)
			),
			start,
			own: ownHeading(
				relation,
				tree === undefined ? { kind: "top" } : { kind: "root", family: tree }
			).filter((f) => !ownStamped.has(columnKeyOf(f.name))),
			layouts,
			top: relation.fields
				.filter((f) => f.writing.kind !== "generated" && !ownStamped.has(columnKeyOf(f.name)))
				.map((f) => ({ name: f.name, type: f.type })),
			walked: new Set([...walkedAt(fill, relation, start)].filter((k) => !ownStamped.has(k))),
			pending: ownStamped,
			stamps
		})
	)
}
