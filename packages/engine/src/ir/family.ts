/**
 * The one Family IR: every family, ordered, counted or a tree, by its owner, its count, its members, its index and the
 * three axes every lemma, fold copy and tree law rides.
 *
 * A family Φ has a member relation F, an owner O with primary key k…, a group g… on F paired with k… in order, a count
 * n (a drawn natural of O), an index i (a drawn field when ordered, a drawn law column when counted), and ‹n›, the
 * owner's count copied onto each member. Its three axes are foreign keys: owner (member to owner, carrying ‹n›),
 * predecessor (each member to the one before it) and last (the owner to its last member). A containment of an axis's
 * shape rides it, its pairs joining the axis's, so a family adds one foreign key per axis whatever its laws.
 */
import type { ColumnIdent, Identifier, LawId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { MonoidName } from "#compiler/ir/desc.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import type { FamilyId, LawField, NativeColumn, RelationInfo } from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/** One family: each owner's members indexed by exactly 0 … n − 1. */
export interface Family {
	readonly id: FamilyId
	/** The family's own law, which names its drawn law columns (core/identity.ts LawColumnStatement). */
	readonly law: Identifier<"law">
	/** O: an ordinary relation of the schema, as its member is. */
	readonly owner: RelationInfo
	/** n: a drawn natural of the owner. */
	readonly count: LawField
	readonly member: RelationInfo
	/** g…: each member field with the owner primary-key field it pairs with, in key order. */
	readonly group: NonEmptyReadonlyArray<{ readonly member: LawField; readonly owner: LawField }>
	/** A field when ordered, a drawn law column (‹i›) when counted: deferral, delete plan and folds read this arm. */
	readonly index: NativeColumn
	/** ‹n›, the owner's count on each member: a drawn law column. */
	readonly copy: ColumnIdent
	/** Which facts are members: every fact, or a tree's every row but its root, whose start is 0. */
	readonly members: { readonly kind: "every" } | ({ readonly kind: "tree" } & TreeShape)
	/** What each axis carries beyond its key: the formers' pairs and every containment merged into it. */
	readonly axes: { readonly [A in AxisKind]: ReadonlyArray<AxisPair> }
	readonly folds: ReadonlyArray<FamilyFold>
}

/** A tree's own columns: its root field, its drawn interval, and ‹ps›, the parent's start. */
export interface TreeShape {
	readonly root: LawField
	readonly start: LawField
	readonly end: LawField
	readonly parentStart: ColumnIdent
}

/** A family's three foreign keys: member to owner, member to its predecessor, owner to its last member. */
export type AxisKind = "owner" | "predecessor" | "last"

/**
 * A column an axis carries: `from` on its source row, `to` on its target row. A drawn or accumulated `from` is filled
 * by the host with `to`'s value, which the axis's foreign key proves.
 */
export interface AxisPair {
	readonly from: NativeColumn
	readonly to: NativeColumn
	/** The laws this pair states: a former's, or a merged containment's. */
	readonly laws: NonEmptyReadonlyArray<LawId>
}

/** A fold over a family: its monoid, the members it steps over, its step, and its planes. */
export interface FamilyFold {
	/** The fold's own law, which names its hidden accumulators (core/identity.ts LawColumnStatement). */
	readonly law: Identifier<"law">
	readonly monoid: MonoidName
	/** The step side's selection over the member's row, each a conjunct: none steps over every member. */
	readonly where: ReadonlyArray<ScalarExpr>
	readonly step: { readonly kind: "one" } | { readonly kind: "value"; readonly field: LawField }
	readonly planes: NonEmptyReadonlyArray<FoldPlane>
}

/** One plane of a fold: its accumulator before and after a member's step, its end on the owner, and its identity. */
export interface FoldPlane {
	/** A field when the step side names it, else a drawn law column. */
	readonly before: NativeColumn
	/** A field when named, else a drawn law column: either way the host draws it and a CHECK proves it. */
	readonly after: NativeColumn
	readonly end: LawField
	readonly identity: TypedLiteral
}

/** Whether a family is ordered, its index a field, or counted, its index a drawn law column that hides the order. */
export const orderOf = (f: Pick<Family, "index">): "ordered" | "counted" =>
	f.index.kind === "field" ? "ordered" : "counted"

/** Whether a family is a sequence, ordered or a tree, whose members a write nests in order under their owner. */
export const isSequence = (f: Family): boolean =>
	f.members.kind === "tree" || f.index.kind === "field"

/** Whether a family is the tree of the relation `relation`: its family over itself whose members are a tree's. */
export const isTreeOf = (f: Family, relation: string): boolean =>
	f.members.kind === "tree" && f.member.name === relation && f.owner.name === relation

/** Whether `column` is a before or an after of a plane of one of `family`'s folds, a law column when hidden. */
const accumulatorOf = (family: Family, column: NativeColumn): FoldPlane | undefined => {
	for (const fold of family.folds) {
		for (const plane of fold.planes) {
			if (sameColumn(plane.before, column) || sameColumn(plane.after, column)) {
				return plane
			}
		}
	}
	return undefined
}

/** Whether two native columns are one: a field by its name, a law column by its identifier. */
const sameColumn = (a: NativeColumn, b: NativeColumn): boolean =>
	a.kind === "field"
		? b.kind === "field" && a.field.name === b.field.name
		: b.kind === "law" && a.column === b.column

/**
 * The type of a column of a family's member or owner the family fills: a field's own; ‹n› and ‹i› the count's
 * natural, ‹ps› the tree's start's, a hidden accumulator its plane's end's; none for a law column the family does not
 * draw.
 */
export const familyColumnType = (family: Family, column: NativeColumn): ScalarType | undefined => {
	if (column.kind === "field") {
		return column.field.type
	}
	if (column.column === family.copy) {
		return family.count.type
	}
	if (family.index.kind === "law" && family.index.column === column.column) {
		return family.count.type
	}
	if (family.members.kind === "tree" && family.members.parentStart === column.column) {
		return family.members.start.type
	}
	return accumulatorOf(family, column)?.end.type
}

/**
 * Whether the host fills a column carried along an axis of `family` as a copy of its target: an accumulated field, or
 * a fold's hidden accumulator. The drawn columns an axis carries (‹n› → n, a tree's ‹ps› → start, its interval) are
 * drawn where the row stands, and a caller's column its row supplies.
 */
export const isCopy = (family: Family, column: NativeColumn): boolean =>
	column.kind === "field"
		? column.field.writing.kind === "accumulated"
		: accumulatorOf(family, column) !== undefined

/**
 * The base of a copy carried along an axis of `family`: an accumulated field's start, a hidden before's plane
 * identity; none for a column that is neither.
 */
export const baseLiteral = (family: Family, column: NativeColumn): TypedLiteral | undefined => {
	if (column.kind === "field") {
		return column.field.writing.kind === "accumulated" ? column.field.writing.start : undefined
	}
	const plane = accumulatorOf(family, column)
	return plane !== undefined && sameColumn(plane.before, column) ? plane.identity : undefined
}
