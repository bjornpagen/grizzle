/**
 * The fill order of a schema's families: every column grizzle writes on a row a family reaches, how it is filled, what
 * of its own row it reads, and when a write fills it. The analysis builds it once, when the schema compiles
 * (analysis/theory/fill.ts), and refuses there every column no write can fill; the host's filler (runtime/write/fill.ts)
 * fills by it, so the two never disagree.
 *
 * A write fills a row in stages. The nested walk enters the row (`entering`), then walks the members of each sequence
 * it owns, an ordered family's or its tree's, one family after another in the order its layout states (`owns`), and
 * once a family's members are filled it fills the row's columns that wait on that family (`after`): its fold's ends,
 * its last copies, and every column that reads them. A member of a later family may copy such a column of its owner,
 * which is why the order puts the family it waits on first. Then each counted family the row owns fills its own
 * members, which are rows of their own, and the row's ends of that family's folds (`settling`). A row's counted
 * families fill independently of one another, each from the row as the walk left it: a column one counted family
 * fills is read by no other family's fill and by nothing the walk fills.
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { LawId } from "#compiler/core/ids.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import { type Family, type FamilyFold, isSequence } from "#compiler/ir/family.ts"
import {
	type ColumnKey,
	columnKey,
	type FamilyId,
	familyKey,
	type NativeColumn,
	type TableRelation
} from "#compiler/ir/law.ts"
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
 * A position as a fill reads it (`FillPosition`), its family by its id alone: what the host's fill data names a position
 * by (runtime/write/fill.ts HostFill). Every FillPosition is one.
 */
export type FillAt =
	| { readonly kind: "top" }
	| { readonly kind: "member" | "root"; readonly family: { readonly id: FamilyId } }

/** The key of a relation's layout at a position, in the schema's fill order (`FillOrder.layouts`) and in a write's host
 * fill (runtime/write/fill.ts HostFill). */
export const layoutKey = (relation: string, position: FillAt): string =>
	position.kind === "top"
		? `${relation}\u0000top`
		: `${relation}\u0000${position.kind}\u0000${familyKey(position.family.id)}`

/**
 * How a column of a row is filled:
 * - given: the caller's, or its sequence's, the row's own value;
 * - owner: a member's group field, a tree node's root fields and parent below its root among them: its owner's column
 *   `to`;
 * - self: a tree root's parent: its own start `to`, since the root is its own parent; its root fields are the caller's;
 * - base: every copy a tree's owner axis carries, on its root, the owner axis's base: the copy's start `base`, since the
 *   root has no parent to copy, stated by `law`;
 * - index, next, count, start, end: a drawn natural, from where the row stands: its slot, its successor (the slot after
 *   its own where its family's count passes that slot, its own slot at its group's last, which no member follows, and a
 *   tree's root's), the count of a family it owns, a tree node's pre-order start, its start plus its subtree's size;
 * - ownerCopy, predecessor, last: an accumulated or hidden column carried along an axis of `family`, the target row's
 *   column `to`, stated by `law`, and `base` at the predecessor and last axes' base, the first slot and the empty
 *   family (an owner axis's base, a tree's root, stands at the root's position: `base` above). A predecessor copy may
 *   read a column that reads the copy back through its row, a generated field over it among them: a chain, a left fold
 *   along the family's slots whose step is that column's rule, the walk's one member after another and the family
 *   scan's recursion (write/family/scan.ts);
 * - after: a fold plane's after, `combine(befores, x)` where the step side's selection holds and its before elsewhere,
 *   the fold stated by `law`;
 * - generated: a generated field, PostgreSQL's, evaluated where another column reads it and never written.
 */
export type FillRule =
	| { readonly kind: "given" }
	| { readonly kind: "owner"; readonly to: NativeColumn }
	| { readonly kind: "self"; readonly to: NativeColumn }
	| { readonly kind: "base"; readonly base: TypedLiteral; readonly law: LawId }
	| { readonly kind: "index" }
	| { readonly kind: "next" }
	| { readonly kind: "count"; readonly family: Family }
	| { readonly kind: "start" }
	| { readonly kind: "end" }
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
			readonly step: FillStep<NativeColumn>
			readonly law: LawId
	  }
	| { readonly kind: "generated"; readonly expr: ScalarExpr }

/**
 * What a fold's after steps by at a member (ir/family.ts FamilyFold `step`): one, a count's, or the value of the member's
 * column `x`, the field its step side names, at the column's key `C`.
 */
export type FillStep<C> = { readonly kind: "one" } | { readonly kind: "value"; readonly x: C }

/**
 * When a write fills a column of its row, in its row's stages (the module's header): on entering the row; once the walk
 * has filled the members of `family`, the last of the sequences the row owns that the column waits on, by its layout's
 * order; or when a counted family the row owns settles it.
 */
export type FillStage =
	| { readonly kind: "entering" }
	| { readonly kind: "after"; readonly family: Family }
	| { readonly kind: "settling" }

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

/**
 * The columns a fill column reads, its rule `rule` and its row's own columns `reads` (FillColumn.reads): a predecessor
 * copy's column, which it reads on the member before, or the columns of its own row every other rule reads: the one
 * reading a backfill's scan reads its rows by (deploy/diff/backfill.ts scanReads).
 */
export const filledFrom = (
	rule: FillRule,
	reads: ReadonlyArray<NativeColumn>
): ReadonlyArray<NativeColumn> => (rule.kind === "predecessor" ? [rule.to] : reads)

/** A relation's columns at one position, in the order each stage fills them, and the families its rows own. */
export interface FillLayout {
	readonly relation: TableRelation
	readonly position: FillPosition
	readonly columns: ReadonlyArray<FillColumn>
	/**
	 * The families its rows own in the order the walk fills them: its sequences first, each after every sequence a column
	 * its members copy waits on, else in the law model's order; then its counted families.
	 */
	readonly owns: ReadonlyArray<Family>
}

/** A schema's fill order: its families, and every layout of every relation a family reaches, by `layoutKey`. */
export interface FillOrder {
	readonly families: ReadonlyArray<Family>
	readonly layouts: ReadonlyMap<string, FillLayout>
}

/**
 * The columns `family` draws on a row of `relation`, its member, in fill order: its fill layout's at the member's position
 * in the family, a counted family's own fill's, or a sequence's walk's of the family's own rules. A generated field a
 * counted family's fill evaluates, one that reads a column the family draws, is PostgreSQL's to write, so none of them.
 */
export const familyDrawn = (
	fill: FillOrder,
	relation: string,
	family: Family
): ReadonlyArray<FillColumn> =>
	defined(
		fill.layouts.get(layoutKey(relation, { kind: "member", family })),
		`the fill layout of ${relation} as a member of ${family.id.owner}.${family.id.count}`
	).columns.filter((c) => {
		if (isSequence(family)) {
			const rule = c.rule
			return (
				c.writer.kind === "walk" &&
				(rule.kind === "index" ||
					rule.kind === "next" ||
					((rule.kind === "ownerCopy" || rule.kind === "predecessor" || rule.kind === "after") &&
						familyKey(rule.family.id) === familyKey(family.id)))
			)
		}
		return (
			c.writer.kind === "counted" &&
			familyKey(c.writer.family.id) === familyKey(family.id) &&
			c.rule.kind !== "generated"
		)
	})

/**
 * Where an append draws a counted family's groups that hold stored members (write/family/additions.ts):
 * - `kept`: from each group's kept count on, past its stored members, which keep every column but the successor ‹s› of
 *   the last of them, which the appended member after it becomes (write/family/written.ts seamUpdate);
 * - `whole`: from slot 0, each stored member drawn again beside the appended ones and updated in place. A value the
 *   family draws (a fold's step or selection, a predecessor copy, or a member column its last axis carries) reads,
 *   through the member's row, a settled copy: a copy along the family's own owner axis of an owner column the family's
 *   own fill writes (`FillWriter` counted), its count or a generated field over it, which an append changes on every
 *   member at once. Such a group is drawn as the host's fill draws a fresh one: its count, then each such owner column
 *   at it (`settled`, by the owner column's key), then every member's copies and the family's values over them.
 */
export type AppendStart =
	| { readonly kind: "kept" }
	| { readonly kind: "whole"; readonly settled: NonEmptyReadonlyArray<ColumnKey> }

/** The family a rule draws a column for, none for a rule of no family's. */
const ruleFamily = (rule: FillRule): Family | undefined => {
	switch (rule.kind) {
		case "count":
		case "ownerCopy":
		case "predecessor":
		case "last":
		case "after":
			return rule.family
		case "given":
		case "owner":
		case "self":
		case "base":
		case "index":
		case "next":
		case "start":
		case "end":
		case "generated":
			return undefined
	}
}

/**
 * Where an append to `family` draws its groups of `relation`, its member (`AppendStart`), by the fill order: a sequence's
 * and an immutable owner's from their kept counts, a sequence's members being the walk's and an immutable owner's
 * family fixed when its owner is inserted; a mutable owner's counted family whole where a value it draws reads a settled
 * copy.
 */
export const appendStartOf = (fill: FillOrder, relation: string, family: Family): AppendStart => {
	if (isSequence(family) || !family.owner.mutable) {
		return { kind: "kept" }
	}
	const own = (rule: FillRule): boolean => {
		const f = ruleFamily(rule)
		return f !== undefined && familyKey(f.id) === familyKey(family.id)
	}
	/** The owner's columns the family's own fill writes, by key, at any position of the owner's: each position lays the
	 * owner's counts and its generated fields out alike. */
	const written = new Set(
		[...fill.layouts.values()].flatMap((l) =>
			l.relation.name === family.owner.name
				? l.columns.flatMap((c) =>
						c.writer.kind === "counted" && familyKey(c.writer.family.id) === familyKey(family.id)
							? [columnKey(c.column)]
							: []
					)
				: []
		)
	)
	const columns = defined(
		fill.layouts.get(layoutKey(relation, { kind: "member", family })),
		`the fill layout of ${relation} as a member of ${family.id.owner}.${family.id.count}`
	).columns
	const settled = columns.flatMap((c) =>
		c.rule.kind === "ownerCopy" && own(c.rule) && written.has(columnKey(c.rule.to))
			? [{ member: columnKey(c.column), owner: columnKey(c.rule.to) }]
			: []
	)
	/** The member's columns that read a settled copy, through any column of its row between. */
	const reading = new Set(settled.map((x) => x.member))
	for (let grown = true; grown;) {
		grown = false
		for (const c of columns) {
			const key = columnKey(c.column)
			if (!reading.has(key) && filledFrom(c.rule, c.reads).some((r) => reading.has(columnKey(r)))) {
				reading.add(key)
				grown = true
			}
		}
	}
	const owners = [...new Set(settled.map((x) => x.owner))]
	const readsSettled =
		columns.some(
			(c) =>
				(c.rule.kind === "after" || c.rule.kind === "predecessor") &&
				own(c.rule) &&
				reading.has(columnKey(c.column))
		) || family.axes.last.some((p) => reading.has(columnKey(p.to)))
	return readsSettled && isNonEmpty(owners) ? { kind: "whole", settled: owners } : { kind: "kept" }
}
