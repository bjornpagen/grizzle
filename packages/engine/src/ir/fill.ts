/**
 * The fill order of a schema's families: every column grizzle writes on a row a family reaches, how it is filled, what
 * of its own row it reads, and when a write fills it. The analysis builds it once, when the schema compiles
 * (analysis/theory/fill.ts), and refuses there every column no write can fill; the host's filler (write/family/fold.ts)
 * fills by it, so the two never disagree.
 *
 * A write fills a row in stages. The nested walk enters the row (`entering`), walks the members of every sequence it
 * owns, an ordered family's or its tree's, and leaves it (`leaving`); then each counted family it owns fills its own
 * members, which are rows of their own, and the row's ends of that family's folds (`settling`). A row's counted
 * families fill independently of one another, each from the row as the walk left it: a column one counted family
 * fills is read by no other family's fill and by nothing the walk fills.
 */
import type { LawId } from "#compiler/core/ids.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import type { Family, FamilyFold } from "#compiler/ir/family.ts"
import type { LawRelation, NativeColumn } from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/**
 * Where a row stands in a write: written by the ChangeSet itself as no family's member (`top`), a family's member, or a
 * tree's root, which owns its tree and is outside its members.
 */
export type FillPosition =
	| { readonly kind: "top" }
	| { readonly kind: "member"; readonly family: Family }
	| { readonly kind: "root"; readonly family: Family }

/**
 * How a column of a row is filled:
 * - given: the caller's, or its sequence's, the row's own value;
 * - owner: a member's group field, or a tree node's root field below its root: its owner's column `to`;
 * - self: a tree root's group field, its parent: its own key field `to`, since the root is its own parent;
 * - own: every copy a tree's owner axis carries, on its root: its own column `to`, since the root references itself
 *   along the owner axis, stated by `law`;
 * - index, copy, count, start, end, parentStart: a drawn natural, from where the row stands: its slot, its family's
 *   count, the count of a family it owns, a tree node's pre-order start, its start plus its subtree's size, its
 *   parent's start;
 * - ownerCopy, predecessor, last: an accumulated or hidden column carried along an axis of `family`, the target row's
 *   column `to`, stated by `law`, and `base` at the predecessor and last axes' base, the first slot and the empty
 *   family (an owner axis has none, since every member has an owner);
 * - after: a fold plane's after, `combine(befores, x)` where the step side's selection holds and its before elsewhere,
 *   the fold stated by `law`;
 * - generated: a generated field, PostgreSQL's, evaluated where another column reads it and never written.
 */
export type FillRule =
	| { readonly kind: "given" }
	| { readonly kind: "owner"; readonly to: NativeColumn }
	| { readonly kind: "self"; readonly to: NativeColumn }
	| { readonly kind: "own"; readonly to: NativeColumn; readonly law: LawId }
	| { readonly kind: "index" }
	| { readonly kind: "copy" }
	| { readonly kind: "count"; readonly family: Family }
	| { readonly kind: "start" }
	| { readonly kind: "end" }
	| { readonly kind: "parentStart" }
	| {
			readonly kind: "ownerCopy"
			readonly family: Family
			readonly to: NativeColumn
			readonly law: LawId
	  }
	| {
			readonly kind: "predecessor"
			readonly family: Family
			readonly to: NativeColumn
			readonly base: TypedLiteral
			readonly law: LawId
	  }
	| {
			readonly kind: "last"
			readonly family: Family
			readonly to: NativeColumn
			readonly base: TypedLiteral
			readonly law: LawId
	  }
	| {
			readonly kind: "after"
			readonly family: Family
			readonly fold: FamilyFold
			readonly plane: 0 | 1
			readonly befores: ReadonlyArray<NativeColumn>
			readonly x: NativeColumn | undefined
			readonly law: LawId
	  }
	| { readonly kind: "generated"; readonly expr: ScalarExpr }

/** When a write fills a column of its row, in its row's stages (the module's header). */
export type FillStage = "entering" | "leaving" | "settling"

/** Who fills a column: the nested walk, or a counted family's own fill, whose columns nothing else reads. */
export type FillWriter =
	| { readonly kind: "walk" }
	| { readonly kind: "counted"; readonly family: Family }

/** A column of a row at one position: its handle and name, its type, how it is filled, when, and by whom. */
export interface FillColumn {
	readonly column: NativeColumn
	readonly name: string
	readonly type: ScalarType
	readonly rule: FillRule
	/** The row's own columns it reads, each filled before it. */
	readonly reads: ReadonlyArray<NativeColumn>
	readonly stage: FillStage
	readonly writer: FillWriter
}

/** A relation's columns at one position, in the order each stage fills them, and the families its rows own. */
export interface FillLayout {
	readonly relation: LawRelation
	readonly position: FillPosition
	readonly columns: ReadonlyArray<FillColumn>
	/** The families its rows own, sequences first, in the law model's order: the order the walk fills them in. */
	readonly owns: ReadonlyArray<Family>
}

/** A schema's fill order: its families, and every layout of every relation a family reaches, by `layoutKey`. */
export interface FillOrder {
	readonly families: ReadonlyArray<Family>
	readonly layouts: ReadonlyMap<string, FillLayout>
}
