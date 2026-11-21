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
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ColumnIdent, Identifier, LawId } from "#compiler/core/ids.ts"
import type { MonoidName } from "#compiler/ir/desc.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type FamilyId,
	type LawField,
	type NativeColumn,
	type RelationInfo,
	sameNativeColumn,
	type FieldColumn
} from "#compiler/ir/law.ts"
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
	/** Which facts are its members and what indexes them (MemberShape). */
	readonly shape: MemberShape
	/** ‹n›, the owner's count on each member: a drawn law column. */
	readonly copy: ColumnIdent
	/** What each axis carries beyond its key: the formers' pairs and every containment merged into it. */
	readonly axes: { readonly [A in AxisKind]: ReadonlyArray<AxisPair> }
	readonly folds: ReadonlyArray<FamilyFold>
}

/**
 * Which facts are a family's members and what indexes them: an ordered family's every fact, by its drawn index field;
 * a counted family's every fact, by its drawn law column ‹i›, which hides the order; a tree's every row but its roots,
 * whose start is 0, by its drawn `at` field, with the tree's own fields. Deferral, delete plans and folds read the index.
 */
export type MemberShape =
	| { readonly kind: "ordered"; readonly index: FieldColumn }
	| { readonly kind: "counted"; readonly index: LawIndex }
	| TreeMembers

/** A tree's members (MemberShape `tree`): its index, its `at`, and its own fields. */
export type TreeMembers = { readonly kind: "tree"; readonly index: FieldColumn } & TreeShape

/** A counted family's index, its drawn law column ‹i›. */
export type LawIndex = Extract<NativeColumn, { readonly kind: "law" }>

/**
 * A tree's own fields: its root fields r…, which its relation's primary key (r…, start) leads with and each tree's rows
 * share; its drawn `parent`, the parent's start in its own tree; and its drawn interval. Its family's group is r…, then
 * parent, paired with the primary key r…, then start: each root field with itself, the parent with its parent's start.
 */
export interface TreeShape {
	readonly root: NonEmptyReadonlyArray<LawField>
	readonly parent: LawField
	readonly start: LawField
	readonly end: LawField
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

/**
 * One plane of a fold: its accumulator before and after a member's step, its end on the owner, its identity, and what
 * its family's predecessor and last axes carry of it (FoldCarrier).
 */
export interface FoldPlane {
	/** A field when the step side names it, else a drawn law column. */
	readonly before: NativeColumn
	/** A field when named, else a drawn law column: either way the host draws it and a CHECK proves it. */
	readonly after: NativeColumn
	readonly end: LawField
	readonly identity: TypedLiteral
	readonly carrier: FoldCarrier
}

/**
 * What a fold plane's axes carry of its running values: the values themselves, its predecessor axis each member's
 * before to its predecessor's after and its last axis the owner's end to its last member's after; or each value's
 * SHA-256 digest, a generated field `Crypto.sha256(row.v)` over it that PostgreSQL stores beside it, where the fold's
 * sides name those digests in the values' places: the axes then pair the digests, so a running text of any length
 * rides a UNIQUE of 32-byte digests, and the values are equal where their digests are, short of a SHA-256 collision.
 * Either way the host fills the values, and the fold's CHECK and its base pins read them.
 */
export type FoldCarrier =
	| { readonly kind: "values" }
	| {
			readonly kind: "digests"
			readonly before: LawField
			readonly after: LawField
			readonly end: LawField
	  }

/** A plane whose axes carry its running values themselves (FoldCarrier `values`). */
export const valuesCarried: FoldCarrier = Object.freeze({ kind: "values" })

/** Whether a family's order is a field, an ordered family's or a tree's, or hidden, a counted family's. */
export const orderOf = (f: Pick<Family, "shape">): "ordered" | "counted" =>
	f.shape.kind === "counted" ? "counted" : "ordered"

/** Whether a family is a sequence, ordered or a tree, whose members a write nests in order under their owner. */
export const isSequence = (f: Pick<Family, "shape">): boolean => orderOf(f) === "ordered"

/** Whether a family is the tree of the relation `relation`: its family over itself whose members are a tree's. */
export const isTreeOf = (f: Family, relation: string): boolean =>
	f.shape.kind === "tree" && f.member.name === relation && f.owner.name === relation

/** Whether `column` is a before or an after of a plane of one of `family`'s folds, a law column when hidden. */
const accumulatorOf = (family: Family, column: NativeColumn): FoldPlane | undefined => {
	for (const fold of family.folds) {
		for (const plane of fold.planes) {
			if (sameNativeColumn(plane.before, column) || sameNativeColumn(plane.after, column)) {
				return plane
			}
		}
	}
	return undefined
}

/**
 * The type of a column of a family's member or owner the family fills: a field's own; ‹n› and ‹i› the count's
 * natural, a hidden accumulator its plane's end's; none for a law column the family does not draw.
 */
export const familyColumnType = (family: Family, column: NativeColumn): ScalarType | undefined => {
	if (column.kind === "field") {
		return column.field.type
	}
	if (column.column === family.copy) {
		return family.count.type
	}
	if (family.shape.kind === "counted" && family.shape.index.column === column.column) {
		return family.count.type
	}
	return accumulatorOf(family, column)?.end.type
}

/**
 * Whether the host fills a column carried along an axis of `family` as a copy of its target: an accumulated field, or
 * a fold's hidden accumulator. The drawn columns an axis carries (‹n› → n, a tree's interval) are drawn where the row
 * stands, and a caller's column its row supplies.
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
	return plane !== undefined && sameNativeColumn(plane.before, column) ? plane.identity : undefined
}
