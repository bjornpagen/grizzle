import { refuse } from "#compiler/analysis/theory/build.ts"
import {
	type FamilyStated,
	familyStatement,
	ownSpelling
} from "#compiler/analysis/theory/spelling.ts"
import { foldRule } from "#compiler/check/fold.ts"
import { identifierOf, identity, type LawColumnStatement } from "#compiler/core/identity.ts"
import type { ColumnIdent, Identifier, LawId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { appendNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import {
	type ExprDesc,
	type MonoidName,
	type SideDesc,
	type StatementDesc,
	type TermDesc,
	termText
} from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type AxisKind,
	type AxisPair,
	type Family,
	type FamilyFold,
	orderOf,
	type TreeShape
} from "#compiler/ir/family.ts"
import type {
	FamilyId,
	LawField,
	NativeColumn,
	RelationInfo,
	TheoryRelation
} from "#compiler/ir/law.ts"
import { monoidSpecs } from "#compiler/ir/monoid.ts"

/**
 * Families and their axes, as the theory resolves them.
 *
 * A family or tree statement resolves to its shape: its owner, count, member, group, index, ‹n› and members, every one
 * a handle the checked schema typed. Each family has three axes, foreign keys every lemma, fold copy and tree law
 * rides: owner (member to owner), predecessor (member to the member one slot before it) and last (owner to its last
 * member). A containment rides an axis when its sides are the axis's ends (`ridesOf`): its relation and selection
 * are the axis's source's and target's, and its terms begin with the axis's key terms, paired in order, a user's
 * pred(i) standing for the generated ‹p›. Its remaining pairs join the axis's carried pairs and its law joins the axis's
 * laws, so a tree, a fold or a merged copy adds no foreign key of its own. It is exact because an axis's target key
 * terms are a key of its target side: a source row meets at most one target row.
 *
 * Every drawn field is named by one family or tree statement, as its index, count, start or end, and every accumulated
 * field by one statement that fills it: a fold, as an accumulator or an end, or one containment riding an axis, as a
 * carried source column. `Namings` holds both counts; the theory refuses a field named by none or two.
 */

/**
 * A family as its statement resolves it, before the containments it carries and the folds over it (ir/family.ts), its
 * owner and member the ordinary relations the checked schema typed.
 */
export interface FamilyShape extends Omit<Family, "axes" | "folds" | "owner" | "member"> {
	readonly owner: RelationInfo
	readonly member: RelationInfo
}

/** A tree's members: every row but its root, its own columns beside them. */
export type TreeMembers = { readonly kind: "tree" } & TreeShape

/** A tree's family shape, its members the tree's. */
export type TreeFamilyShape = FamilyShape & { readonly members: TreeMembers }

/** A tree's family, resolved (LawDetail's tree arm). */
export type TreeFamily = Family & { readonly members: TreeMembers }

/** A family statement as ownership admitted it. */
export type FamilyStatement = Extract<StatementDesc, { readonly kind: "family" }>
/** A tree statement as ownership admitted it. */
export type TreeStatement = Extract<StatementDesc, { readonly kind: "tree" }>
/** A fold statement as ownership admitted it. */
export type FoldStatement = Extract<StatementDesc, { readonly kind: "fold" }>

/** fin(O, n), as a refusal and a display spell a family. */
export const slotsText = (id: FamilyId): string => `fin(${id.owner}, ${id.count})`

/** A drawn law column of a family at the naming door: ‹n›, a counted family's ‹i›, a tree's ‹ps›, by the family's law. */
const drawnColumn = (
	kind: Extract<LawColumnStatement, { readonly owner: string }>["kind"] &
		("copy" | "index" | "parentStart"),
	id: FamilyId,
	family: Identifier<"law">
): ColumnIdent =>
	identifierOf(identity.lawColumn({ kind, owner: id.owner, count: id.count, family }))

/**
 * A fold's hidden accumulator at the naming door: the before or after of plane `plane` of the fold whose law is `fold`,
 * by that law's identity, which is no position among the family's folds, so removing another fold renames none of its
 * columns, and by its family's law.
 */
const accumulatorColumn = (
	kind: "before" | "after",
	f: FamilyShape,
	fold: Identifier<"law">,
	plane: 0 | 1
): ColumnIdent =>
	identifierOf(
		identity.lawColumn({
			kind,
			owner: f.id.owner,
			count: f.id.count,
			family: f.law,
			fold,
			plane
		})
	)

/** What a family's or tree's law states of it (spelling.ts FamilyStated): its member's terms are its group's member
 * fields, then its index where the index is a field. */
export const familyStated = (
	f: Pick<Family, "id" | "member" | "group" | "index" | "members">
): FamilyStated => ({
	id: f.id,
	member: f.member.name,
	terms: [...f.group.map((p) => p.member), ...(f.index.kind === "field" ? [f.index.field] : [])],
	kind:
		f.members.kind === "tree"
			? { kind: "tree", root: f.members.root }
			: { kind: "family", order: orderOf(f) }
})

/** A family's or tree's law's identifier, as the theory names the law (theory.ts lawIdentityOf). */
const familyLaw = (stated: FamilyStated): Identifier<"law"> =>
	identifierOf(identity.law(familyStatement(stated, ownSpelling)))

/** The ordinary relation `name`: a family's owner and member are stored relations a ChangeSet writes. */
const ordinary = (
	relations: ReadonlyMap<string, TheoryRelation>,
	name: string,
	role: string,
	loc: SourceLoc
): RelationInfo => {
	const r = relations.get(name)
	if (r?.kind !== "relation") {
		return refuse(
			"MalformedDescription",
			loc,
			`a family's ${role} is an ordinary relation of the schema; ${name} is ${r === undefined ? "none" : "a closed relation"}`
		)
	}
	return r
}

/** The field `name` of `r`. */
const fieldOf = (r: TheoryRelation, name: string, loc: SourceLoc): LawField =>
	r.fields.find((f) => f.name === name) ??
	refuse("MalformedDescription", loc, `a field ${r.name}.${name}`)

/** The field a side's term reads, refused when it is a pred term: a family's sides name fields. */
const fieldTerm = (r: TheoryRelation, t: TermDesc, what: string, loc: SourceLoc): LawField =>
	t.kind === "field"
		? fieldOf(r, t.field, loc)
		: refuse("MalformedDescription", loc, `${what} names fields; ${termText(t)} is a pred term`)

/** The drawn field `f`, refused when it is written otherwise: what a family draws, the caller never writes. */
const drawnField = (r: TheoryRelation, f: LawField, role: string, loc: SourceLoc): LawField =>
	f.writing.kind === "drawn"
		? f
		: refuse(
				"MalformedDescription",
				loc,
				`a family's ${role} is a drawn natural grizzle draws; ${r.name}.${f.name} is written by ${f.writing.kind}`
			)

/**
 * Each member group field with the owner key field it pairs with, in key order: the member side's first terms. The
 * group key is how a member names its owner: a projection of the member's caller fields, one per owner
 * key field; a field grizzle or PostgreSQL writes names no owner a caller chose. Each is of its key field's identity,
 * which the field classes hold (laws.ts Normalizer.familyPairings), refusing another at the family's statement.
 */
const groupOf = (
	owner: RelationInfo,
	member: RelationInfo,
	terms: ReadonlyArray<TermDesc>,
	loc: SourceLoc
): FamilyShape["group"] =>
	mapNonEmpty(owner.primaryFields, (key, j) => {
		const t = terms[j]
		if (t === undefined) {
			return refuse(
				"MalformedDescription",
				loc,
				`a family's side is its owner's key, then its index: ${member.name}'s side names ${terms.length} term(s) for ${owner.name}'s key of ${owner.primaryFields.length}`
			)
		}
		const g = fieldTerm(member, t, "a family's group", loc)
		if (g.writing.kind !== "caller") {
			return refuse(
				"MalformedDescription",
				loc,
				`a family's group key is caller fields of its member, which name its owner; ${member.name}.${g.name} is written by ${g.writing.kind}`
			)
		}
		return { member: g, owner: key }
	})

/** A family's member side reads every fact: its members are every fact of its relation, or a tree's every row but its root. */
const everyMember = (side: SideDesc, loc: SourceLoc): void => {
	if (side.selection.conjuncts.length > 0) {
		refuse(
			"MalformedDescription",
			loc,
			`a family's side reads every fact of ${side.relation}; it selects some`
		)
	}
}

/** The shape of `ordered(on(F, g…, i), fin(O, n))` or `counted(on(F, g…), fin(O, n))`. */
export const familyShape = (
	s: FamilyStatement,
	relations: ReadonlyMap<string, TheoryRelation>
): FamilyShape => {
	const loc = s.loc
	everyMember(s.member, loc)
	const id: FamilyId = { owner: s.slots.owner, count: s.slots.count }
	const owner = ordinary(relations, s.slots.owner, "owner", loc)
	const member = ordinary(relations, s.member.relation, "member", loc)
	const count = drawnField(owner, fieldOf(owner, s.slots.count, loc), "count", loc)
	const width = owner.primaryFields.length + (s.order === "ordered" ? 1 : 0)
	if (s.member.terms.length !== width) {
		return refuse(
			"MalformedDescription",
			loc,
			s.order === "ordered"
				? `an ordered family's side is its owner's key, then its drawn index: ${width} term(s); on(${member.name}, …) names ${s.member.terms.length}`
				: `a counted family's side is its owner's key: ${width} term(s); on(${member.name}, …) names ${s.member.terms.length}`
		)
	}
	const group = groupOf(owner, member, s.member.terms, loc)
	const last = s.member.terms[width - 1]
	const indexField =
		s.order === "ordered" && last !== undefined
			? drawnField(member, fieldTerm(member, last, "an ordered family's index", loc), "index", loc)
			: undefined
	const members = Object.freeze({ kind: "every" as const })
	const law = familyLaw({
		id,
		member: member.name,
		terms: [...group.map((p) => p.member), ...(indexField === undefined ? [] : [indexField])],
		kind: { kind: "family", order: indexField === undefined ? "counted" : "ordered" }
	})
	const index: NativeColumn =
		indexField === undefined
			? { kind: "law", column: drawnColumn("index", id, law) }
			: { kind: "field", field: indexField }
	return Object.freeze({
		id,
		law,
		owner,
		count,
		member,
		group,
		index,
		copy: drawnColumn("copy", id, law),
		members
	})
}

/**
 * The shape of `tree(on(T, "parent", "at"), fin(T, n), { root: r })`: the ordered family of T over itself, keyed by
 * T's one primary-key field, whose members are every row but the root, with T's drawn `start` and `end`, its caller
 * root field r, and ‹ps›, each member's parent's start.
 */
export const treeShape = (
	s: TreeStatement,
	relations: ReadonlyMap<string, TheoryRelation>
): TreeFamilyShape => {
	const loc = s.loc
	everyMember(s.member, loc)
	const t = ordinary(relations, s.member.relation, "member", loc)
	if (s.slots.owner !== t.name) {
		return refuse(
			"MalformedDescription",
			loc,
			`a tree is a family of its relation over itself, on(T, parent, at) in fin(T, n); on(${t.name}, …) is in fin(${s.slots.owner}, ${s.slots.count})`
		)
	}
	const [key, ...more] = t.primaryFields
	if (more.length > 0) {
		return refuse(
			"MalformedDescription",
			loc,
			`a tree relation keyed by one field, which its parent names; ${t.name}'s primary key has ${t.primaryFields.length}`
		)
	}
	const [parentTerm, atTerm, ...extra] = s.member.terms
	if (atTerm === undefined || extra.length > 0) {
		return refuse(
			"MalformedDescription",
			loc,
			`a tree's side is on(T, parent, at), two terms; on(${t.name}, …) names ${s.member.terms.length}`
		)
	}
	const parent = fieldTerm(t, parentTerm, "a tree's side", loc)
	if (parent === key) {
		return refuse(
			"MalformedDescription",
			loc,
			`a tree's parent field beside its key; ${t.name}.${parent.name} is its key`
		)
	}
	const at = drawnField(t, fieldTerm(t, atTerm, "a tree's side", loc), "index", loc)
	const id: FamilyId = { owner: t.name, count: s.slots.count }
	const count = drawnField(t, fieldOf(t, s.slots.count, loc), "count", loc)
	/** A tree's interval field, drawn by its one depth-first walk. */
	const interval = (name: "start" | "end"): LawField => {
		const f = t.fields.find((g) => g.name === name)
		if (f?.writing.kind !== "drawn") {
			return refuse(
				"MalformedDescription",
				loc,
				`a tree relation with drawn start and end, its pre-order interval; ${t.name} has ${f === undefined ? `no ${name}` : `${name} written by ${f.writing.kind}`}`
			)
		}
		return f
	}
	const root = fieldOf(t, s.root, loc)
	if (root.writing.kind !== "caller") {
		return refuse(
			"MalformedDescription",
			loc,
			`a tree's root field is a caller's field of its relation; ${t.name}.${root.name} is written by ${root.writing.kind}`
		)
	}
	const group: TreeFamilyShape["group"] = [{ member: parent, owner: key }]
	const index: NativeColumn = { kind: "field", field: at }
	const law = familyLaw({ id, member: t.name, terms: [parent, at], kind: { kind: "tree", root } })
	return Object.freeze({
		id,
		law,
		owner: t,
		count,
		member: t,
		group,
		index,
		copy: drawnColumn("copy", id, law),
		members: Object.freeze({
			kind: "tree",
			root,
			start: interval("start"),
			end: interval("end"),
			parentStart: drawnColumn("parentStart", id, law)
		})
	})
}

/** Whether a family's shape is a tree's. */
export const isTree = (f: FamilyShape): f is TreeFamilyShape => f.members.kind === "tree"

/**
 * The predicate that selects a family's members: none for every fact, `start > 0` for a tree's every row but its root
 * (φ₀). A lemma and an axis read their member sides through it.
 */
export const membersSelection = (f: FamilyShape): ReadonlyArray<ExprDesc> =>
	f.members.kind === "tree"
		? [
				{
					kind: "compare",
					op: "gt",
					left: { kind: "field", field: f.members.start.name },
					right: { kind: "literal", value: 0n, type: undefined }
				}
			]
		: []

/** Whether a description literal is zero. */
const isZero = (e: ExprDesc): boolean => e.kind === "literal" && (e.value === 0n || e.value === 0)

/**
 * Whether a selection's conjuncts select exactly a family's members: none for a family of every fact; for a tree, one
 * conjunct that is start above zero, spelled `start > 0`, `0 < start` or, since start is natural, `start <> 0`.
 */
const selectsMembers = (f: FamilyShape, conjuncts: ReadonlyArray<ExprDesc>): boolean => {
	if (f.members.kind === "every") {
		return conjuncts.length === 0
	}
	const start = f.members.start.name
	const [only, ...more] = conjuncts
	if (only?.kind !== "compare" || more.length > 0) {
		return false
	}
	const isStart = (e: ExprDesc): boolean => e.kind === "field" && e.field === start
	switch (only.op) {
		case "gt":
			return isStart(only.left) && isZero(only.right)
		case "lt":
			return isZero(only.left) && isStart(only.right)
		case "ne":
			return (
				(isStart(only.left) && isZero(only.right)) || (isZero(only.left) && isStart(only.right))
			)
		case "eq":
		case "ge":
		case "le":
			return false
	}
}

/** One end of an axis as a containment's side matches it: its relation, whether it is the members, its key terms. */
interface AxisEnd {
	readonly relation: string
	/** The family's members (true), or every fact of the owner (false). */
	readonly members: boolean
	readonly key: NonEmptyReadonlyArray<TermDesc>
}

/** An axis's two ends. */
export interface AxisShape {
	readonly axis: AxisKind
	readonly source: AxisEnd
	readonly target: AxisEnd
}

const fieldTermOf = (f: LawField): TermDesc => ({ kind: "field", field: f.name })

/**
 * A family's axes as a containment rides them: owner F(g…) → O(k…) always; predecessor F(g…, pred(i)) → F(g…, i) and
 * last O(k…, pred(n)) → F(g…, i) when the index is a field, which a user's side can name. A counted family's hidden
 * index is in no heading, so only its owner axis is ridden by a statement.
 */
const axisShapes = (f: FamilyShape): ReadonlyArray<AxisShape> => {
	const group = mapNonEmpty(f.group, (p) => fieldTermOf(p.member))
	const keys = mapNonEmpty(f.group, (p) => fieldTermOf(p.owner))
	const owner: AxisShape = {
		axis: "owner",
		source: { relation: f.member.name, members: true, key: group },
		target: { relation: f.owner.name, members: false, key: keys }
	}
	if (f.index.kind === "law") {
		return [owner]
	}
	const i = f.index.field.name
	return [
		owner,
		{
			axis: "predecessor",
			source: {
				relation: f.member.name,
				members: true,
				key: appendNonEmpty(group, { kind: "pred", field: i })
			},
			target: {
				relation: f.member.name,
				members: true,
				key: appendNonEmpty(group, { kind: "field", field: i })
			}
		},
		{
			axis: "last",
			source: {
				relation: f.owner.name,
				members: false,
				key: appendNonEmpty(keys, { kind: "pred", field: f.count.name })
			},
			target: {
				relation: f.member.name,
				members: true,
				key: appendNonEmpty(group, { kind: "field", field: i })
			}
		}
	]
}

/** A side as a containment states it, for the riding rule: its relation and its selection's predicates. */
export interface RidingSide {
	readonly relation: string
	readonly selection: { readonly conjuncts: ReadonlyArray<{ readonly predicate: ExprDesc }> }
}

/** A containment's pair as the riding rule reads it: each term with its field's handle. */
export interface RidingPair {
	readonly from: TermDesc & { readonly column: LawField }
	readonly to: TermDesc & { readonly column: LawField }
}

/** The axis a containment rides, with the pairs it carries beyond the axis's key. */
export interface Ride {
	readonly family: FamilyId
	readonly axis: AxisKind
	/** The pairs after the key, every one a field term on both sides: the columns it adds to the axis. */
	readonly carried: ReadonlyArray<RidingPair>
}

const sameTerm = (a: TermDesc, b: TermDesc): boolean => a.kind === b.kind && a.field === b.field

/** Whether a side is one end of an axis: its relation, and its selection the family's members or every fact. */
const atEnd = (f: FamilyShape, end: AxisEnd, side: RidingSide): boolean =>
	side.relation === end.relation &&
	(end.members
		? selectsMembers(
				f,
				side.selection.conjuncts.map((c) => c.predicate)
			)
		: side.selection.conjuncts.length === 0)

/** A family as a containment tries to ride it (`ridesOf`): its shape, and its axes as a containment rides them
 * (`axisShapes`), made once for every containment that tries it. */
export interface RiddenFamily {
	readonly shape: FamilyShape
	readonly ridden: ReadonlyArray<AxisShape>
}

/** `shape` as a containment tries to ride it (`RiddenFamily`). */
export const riddenFamily = (shape: FamilyShape): RiddenFamily => ({
	shape,
	ridden: axisShapes(shape)
})

/**
 * The axis a containment rides, or undefined when it rides none and keeps its own native: the first family, in
 * the order the families were stated, and its first axis, whose source is the containment's left side and whose target
 * its right, whose key terms begin the containment's pairs in order, and after which every pair is of two fields. Every
 * axis that admits it is exact, so the first is chosen for determinism.
 */
export const ridesOf = (
	families: Iterable<RiddenFamily>,
	from: RidingSide,
	to: RidingSide,
	pairs: NonEmptyReadonlyArray<RidingPair>
): Ride | undefined => {
	for (const { shape: f, ridden } of families) {
		for (const a of ridden) {
			const width = a.source.key.length
			const carried = pairs.slice(width)
			if (
				atEnd(f, a.source, from) &&
				atEnd(f, a.target, to) &&
				pairs.length >= width &&
				a.source.key.every((t, j) => {
					const p = pairs[j]
					const target = a.target.key[j]
					return (
						p !== undefined && target !== undefined && sameTerm(p.from, t) && sameTerm(p.to, target)
					)
				}) &&
				carried.every((p) => p.from.kind === "field" && p.to.kind === "field")
			) {
				return { family: f.id, axis: a.axis, carried }
			}
		}
	}
	return undefined
}

/**
 * Where an axis's base is, for the copies it carries: the member's index at 0 on the predecessor axis, the owner's
 * count at 0 on the last, a tree's root, start 0, on its owner axis; a non-tree's owner axis has none, since every
 * member has an owner.
 */
export interface AxisBase {
	/** The relation the base rows are rows of: the axis's source. */
	readonly relation: RelationInfo
	/** The natural field that is 0 exactly at the base. */
	readonly at: LawField
}

export const axisBase = (f: FamilyShape, axis: AxisKind): AxisBase | undefined => {
	switch (axis) {
		case "predecessor":
			return f.index.kind === "field" ? { relation: f.member, at: f.index.field } : undefined
		case "last":
			return { relation: f.owner, at: f.count }
		case "owner":
			return f.members.kind === "tree" ? { relation: f.member, at: f.members.start } : undefined
	}
}

/** A native column's identity within its relation: a field by its name, a law column by its identifier. */
const columnKey = (c: NativeColumn): string =>
	c.kind === "field" ? `field\u0000${c.field.name}` : `law\u0000${c.column}`

/** One plane of a fold before lowering: its accumulators and end, and its identity (ir/family.ts FoldPlane). */
interface PlaneEntry {
	readonly before: NativeColumn
	readonly after: NativeColumn
	readonly end: LawField
	readonly identity: TypedLiteral
}

/** A fold of a family before its selection is lowered (ir/family.ts FamilyFold). */
export interface FoldEntry {
	readonly law: Identifier<"law">
	readonly monoid: MonoidName
	/** The step side's conjuncts over the member's row, which the theory lowers into its DAG. */
	readonly where: ReadonlyArray<ExprDesc>
	readonly step: FamilyFold["step"]
	readonly planes: NonEmptyReadonlyArray<PlaneEntry>
	/** The accumulated fields the fold names, each with its relation: each before and after the step side names, and
	 * each end. */
	readonly named: ReadonlyArray<{ readonly relation: RelationInfo; readonly field: LawField }>
	/** Whether the step side names its accumulators: a fold over a counted family never does. */
	readonly visible: boolean
	/** The fold statement's location: where its selection's refusals point. */
	readonly loc: SourceLoc
}

/**
 * One family as the theory builds it: its shape, its law, the pairs each axis carries and the folds over it, filled as
 * the statements are normalized and frozen into a Family once every one is.
 */
export class FamilyEntry implements RiddenFamily {
	readonly shape: FamilyShape
	/** The family or tree statement's location: where a pairing its group makes is refused. */
	readonly loc: SourceLoc
	/** Its axes as a containment rides them (`axisShapes`), made once with the entry for every containment that tries
	 * them (`ridesOf`). */
	readonly ridden: ReadonlyArray<AxisShape>
	readonly #axes: {
		readonly [A in AxisKind]: Map<
			string,
			{ from: NativeColumn; to: NativeColumn; rank: PairRank; laws: Array<LawId> }
		>
	} = {
		owner: new Map(),
		predecessor: new Map(),
		last: new Map()
	}
	readonly #folds: Array<FoldEntry> = []

	constructor(shape: FamilyShape, loc: SourceLoc) {
		this.shape = shape
		this.loc = loc
		this.ridden = axisShapes(shape)
	}

	/** The folds over the family, by their position: a fold's number. */
	get folds(): ReadonlyArray<FoldEntry> {
		return this.#folds
	}

	/** Carries `from` → `to` on `axis` for `law`, at its place `rank` among the axis's pairs (PairRank): a pair two laws
	 * state is one pair stating both, at the place the first gave it. */
	carry(axis: AxisKind, from: NativeColumn, to: NativeColumn, rank: PairRank, law: LawId): void {
		const key = `${columnKey(from)}\u0001${columnKey(to)}`
		const pairs = this.#axes[axis]
		const known = pairs.get(key)
		if (known === undefined) {
			pairs.set(key, { from, to, rank, laws: [law] })
		} else if (!known.laws.includes(law)) {
			known.laws.push(law)
		}
	}

	/** Adds a fold, kept as the law `law`, with its copies on the predecessor and last axes. Its number is its position. */
	fold(entry: FoldEntry, law: LawId): void {
		this.#folds.push(entry)
		for (const [plane, p] of entry.planes.entries()) {
			const rank = foldRank(p.end, plane)
			this.carry("predecessor", p.before, p.after, rank, law)
			this.carry("last", { kind: "field", field: p.end }, p.after, rank, law)
		}
	}

	/** The pairs each axis carries, in the order of their ranks (PairRank). */
	axes(): Family["axes"] {
		const frozen = (axis: AxisKind): ReadonlyArray<AxisPair> =>
			Object.freeze(
				[...this.#axes[axis].values()].toSorted(byRank).map((p): AxisPair => {
					const [first, ...rest] = p.laws
					if (first === undefined) {
						throw defect("an axis pair states at least one law")
					}
					const laws: NonEmptyReadonlyArray<LawId> = Object.freeze([first, ...rest])
					return Object.freeze({ from: p.from, to: p.to, laws })
				})
			)
		return Object.freeze({
			owner: frozen("owner"),
			predecessor: frozen("predecessor"),
			last: frozen("last")
		})
	}
}

/**
 * A pair's place among its axis's pairs, which orders the columns of the axis's key and foreign key: its family's or
 * tree's own pairs first, in their fixed order; then each fold's, by its plane's end field's place in its relation's
 * declaration and the plane; then each pair a riding containment carries, by its target field's place and its source
 * field's. Each reads its target the same way on every axis, so two axes carrying one set of target columns reference
 * one UNIQUE; and a place reads no name, so a declared rename of a relation, a field or a handle keeps every axis's
 * columns in their order, and the migration renames its key and foreign key rather than building them again.
 */
export type PairRank = readonly [0 | 1 | 2, number, number]

/** The rank of a family's or tree's own `k`th pair on its axis. */
export const formerRank = (k: number): PairRank => [0, k, 0]

/** The rank of a fold's pair of plane `plane`, whose end is `end`. */
const foldRank = (end: LawField, plane: number): PairRank => [1, end.position, plane]

/** The rank of the pair a riding containment carries from `from` to `to`. */
export const carriedRank = (from: LawField, to: LawField): PairRank => [
	2,
	to.position,
	from.position
]

const byRank = (a: { readonly rank: PairRank }, b: { readonly rank: PairRank }): number =>
	a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]

/** The step side's terms after the group: the step value, then the accumulator pairs. */
const afterGroup = (f: FamilyShape, step: SideDesc, loc: SourceLoc): ReadonlyArray<TermDesc> => {
	if (step.relation !== f.member.name) {
		return refuse(
			"MalformedDescription",
			loc,
			`a fold's step side is over its family's member ${f.member.name}; it is over ${step.relation}`
		)
	}
	for (const [j, p] of f.group.entries()) {
		const t = step.terms[j]
		if (t?.kind !== "field" || t.field !== p.member.name) {
			return refuse(
				"MalformedDescription",
				loc,
				`a fold's step side begins with its family's group, ${f.group.map((g) => g.member.name).join(", ")}`
			)
		}
	}
	return step.terms.slice(f.group.length)
}

/** The end side's fields after the owner's key: one per plane. */
const endFields = (f: FamilyShape, end: SideDesc, loc: SourceLoc): ReadonlyArray<LawField> => {
	if (end.relation !== f.owner.name || end.selection.conjuncts.length > 0) {
		return refuse(
			"MalformedDescription",
			loc,
			`a fold's end side is every fact of its family's owner ${f.owner.name}`
		)
	}
	for (const [j, p] of f.group.entries()) {
		const t = end.terms[j]
		if (t?.kind !== "field" || t.field !== p.owner.name) {
			return refuse(
				"MalformedDescription",
				loc,
				`a fold's end side begins with its owner's key, ${f.group.map((g) => g.owner.name).join(", ")}`
			)
		}
	}
	return end.terms.slice(f.group.length).map((t) => fieldTerm(f.owner, t, "a fold's end side", loc))
}

/**
 * A fold statement over its family, resolved as the fold whose law is `law`: its step value, its accumulator pairs (the
 * fields the step side names, or hidden drawn law columns named by its law), its ends and each plane's identity. The
 * fold's typing is check/fold.ts foldRule's, refused here at the fold's statement: the step value, a commutative
 * monoid over a counted family, whose order is hidden, no accumulator pair over a counted family, the pair
 * and end counts, the accumulators' types and writings and their starts at the identity. A fold steps over its
 * family's member rows, each distinct by the member's primary key and by its (group, index) slot, never over a
 * projection of its step side, which names what each member contributes and not the set it ranges over: two members
 * of one step value are two steps.
 */
export const foldEntry = (s: FoldStatement, f: FamilyShape, law: Identifier<"law">): FoldEntry => {
	const loc = s.loc
	const monoid = monoidSpecs[s.monoid]
	const rest = afterGroup(f, s.step, loc)
	const valueTerm = monoid.step === "value" ? rest[0] : undefined
	const accumulators = monoid.step === "value" ? rest.slice(1) : rest
	const x =
		valueTerm === undefined ? undefined : fieldTerm(f.member, valueTerm, "a fold's step side", loc)
	const named = accumulators.map((t) => fieldTerm(f.member, t, "a fold's step side", loc))
	const pairs = named.flatMap((before, j) => {
		if (j % 2 === 1) {
			return []
		}
		const after = named[j + 1]
		return after === undefined ? [] : [{ before, after }]
	})
	if (named.length % 2 === 1) {
		return refuse(
			"MalformedDescription",
			loc,
			`a fold's step side names its accumulators in (before, after) pairs; it names ${named.length}`
		)
	}
	const ends = endFields(f, s.end, loc)
	const refused = foldRule(monoid, {
		order: orderOf(f),
		step: x,
		pairs,
		ends
	})
	if (refused !== undefined) {
		return refuse("MalformedDescription", loc, refused)
	}
	const [firstEnd] = ends
	if (firstEnd === undefined) {
		throw defect("foldRule admits a fold of one end per plane")
	}
	const identities = monoid.identity(x?.type ?? firstEnd.type)
	const planes = mapNonEmpty(identities, (identityLiteral, p): PlaneEntry => {
		const plane: 0 | 1 = p === 0 ? 0 : 1
		const pair = pairs[p]
		const end = ends[p]
		if (end === undefined) {
			throw defect("foldRule admits a fold of one end per plane")
		}
		return {
			before:
				pair === undefined
					? { kind: "law", column: accumulatorColumn("before", f, law, plane) }
					: { kind: "field", field: pair.before },
			after:
				pair === undefined
					? { kind: "law", column: accumulatorColumn("after", f, law, plane) }
					: { kind: "field", field: pair.after },
			end,
			identity: identityLiteral
		}
	})
	const step: FamilyFold["step"] = x === undefined ? { kind: "one" } : { kind: "value", field: x }
	return Object.freeze({
		law,
		monoid: s.monoid,
		where: s.step.selection.conjuncts,
		step,
		planes,
		named: [
			...named.map((field) => ({ relation: f.member, field })),
			...ends.map((field) => ({ relation: f.owner, field }))
		],
		visible: pairs.length > 0,
		loc
	})
}

/** Who names a drawn or accumulated field: a statement, spelled as a refusal names it. */
interface Naming {
	readonly field: LawField
	readonly relation: RelationInfo
	readonly by: Array<string>
}

/**
 * Who names each drawn and accumulated field: a family or tree statement each drawn field, and a fold or a riding
 * containment each accumulated one. `refuseMisnamed` refuses the first field, in relation and field order, named by
 * none or by two.
 */
export class Namings {
	readonly #names = new Map<string, Naming>()
	/** Containments that carry an accumulated field but ride no axis: what a field named by none is told. */
	readonly #unridden = new Map<string, string>()

	/** `by` names `field` of `relation`. */
	name(relation: RelationInfo, field: LawField, by: string): void {
		const key = `${relation.name}\u0000${field.name}`
		const known = this.#names.get(key)
		if (known === undefined) {
			this.#names.set(key, { field, relation, by: [by] })
		} else {
			known.by.push(by)
		}
	}

	/** The containment `by` reads the accumulated `field` as a source column but rides no axis, so it fills nothing. */
	unridden(relation: string, field: string, by: string): void {
		const key = `${relation}\u0000${field}`
		if (!this.#unridden.has(key)) {
			this.#unridden.set(key, by)
		}
	}

	/** Refuses a drawn or accumulated field of `relations` that no statement names, or that two do. */
	refuseMisnamed(relations: Iterable<TheoryRelation>): void {
		for (const r of relations) {
			if (r.kind !== "relation") {
				continue
			}
			for (const f of r.fields) {
				const w = f.writing.kind
				if (w !== "drawn" && w !== "accumulated") {
					continue
				}
				const key = `${r.name}\u0000${f.name}`
				const by = this.#names.get(key)?.by ?? []
				const at = childLoc(r.loc, "fields", f.name)
				const [first, second] = by
				if (first === undefined) {
					const unridden = this.#unridden.get(key)
					refuse(
						"MalformedDescription",
						at,
						w === "drawn"
							? `a drawn field named by one family or tree, as its index, count, start or end; ${r.name}.${f.name} is named by none`
							: unridden === undefined
								? `an accumulated field filled by one fold or one containment along a family axis; ${r.name}.${f.name} is filled by none`
								: `an accumulated field carried along a family axis; ${unridden} carries ${r.name}.${f.name} but rides no axis: its sides begin with no family axis's key`
					)
				}
				if (second !== undefined) {
					refuse(
						"MalformedDescription",
						at,
						w === "drawn"
							? `a drawn field named by one family or tree; ${r.name}.${f.name} is named by ${first} and ${second}`
							: `an accumulated field filled by one statement; ${r.name}.${f.name} is filled by ${first} and ${second}`
					)
				}
			}
		}
	}
}

/** The drawn fields a family or tree statement names: its count, an ordered family's index, a tree's start and end. */
export const drawnNamed = (
	f: FamilyShape
): ReadonlyArray<{ readonly relation: RelationInfo; readonly field: LawField }> => [
	{ relation: f.owner, field: f.count },
	...(f.index.kind === "field" ? [{ relation: f.member, field: f.index.field }] : []),
	...(f.members.kind === "tree"
		? [
				{ relation: f.member, field: f.members.start },
				{ relation: f.member, field: f.members.end }
			]
		: [])
]

/** A family statement's or a tree's description in a refusal. */
export const familyText = (f: FamilyShape): string =>
	f.members.kind === "tree"
		? `the tree of ${f.member.name}`
		: `the ${orderOf(f)} family ${slotsText(f.id)}`
