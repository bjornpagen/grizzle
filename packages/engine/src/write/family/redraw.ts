/**
 * What a write changes on rows already stored beyond the rows it writes, and the values a family draws from such a
 * column that nothing draws again (StaleDerivedRead).
 *
 * A put of a relation changes its fields outside its primary key that its caller writes or PostgreSQL generates. A
 * write of a family's member, a tree's aside, edits the family, which changes its owner's count and every column its
 * last axis carries there, a fold's end and a last copy, and draws its members' index and copies again. A family's
 * owner axis, a tree's aside, carries such a change on by its ON UPDATE CASCADE into the member's column it pairs with
 * the changed one, and PostgreSQL generates again every field generated from a changed one.
 *
 * Every other value a family derives from a column is drawn when its row is written: a fold's step or selection over
 * it, a predecessor copy and a last copy of it, and a tree node's copy of its parent's. The family planner draws them
 * again for the families whose member a write writes, from the rows it reads (write/family/edit.ts), so the written
 * relation's own columns are its; a change the cascade carries into a member's column, or a family's edit of an owner
 * that is itself a member, reaches none of them, and PostgreSQL refuses the stale value at its CHECK or its axis's
 * foreign key.
 */
import { readsOf } from "#compiler/analysis/theory/fill.ts"
import type { ChangedColumn, ColumnName, DerivedReader } from "#compiler/core/causes.ts"
import { type Family, isTreeOf } from "#compiler/ir/family.ts"
import type { NativeColumn, RelationInfo } from "#compiler/ir/law.ts"
import { columnKey } from "#compiler/write/family/fold.ts"

/** A value drawn from a column a write changes: the change, the columns the cascade carries it into, and the value. */
export interface StaleRead {
	readonly changed: ChangedColumn
	readonly copies: ReadonlyArray<ColumnName>
	readonly reader: DerivedReader
}

/** A native column's name as a refusal names it: a field's name, a law column's identifier. */
const nameOf = (c: NativeColumn): string => (c.kind === "field" ? c.field.name : c.column)

/**
 * The value of family `l`, whose member holds `column`, that reads it and is drawn only when its row is written: a
 * fold's step or selection, a predecessor copy, a last copy, or, for a tree, a node's copy of its parent's; none when
 * no such value reads it.
 */
const readerIn = (l: Family, column: NativeColumn): DerivedReader | undefined => {
	const family = { owner: l.id.owner, count: l.id.count }
	const key = columnKey(column)
	for (const fold of l.folds) {
		const reads =
			column.kind === "field" &&
			((fold.step.kind === "value" && fold.step.field.name === column.field.name) ||
				fold.where.some((w) => readsOf(w).includes(column.field.name)))
		if (reads) {
			return { kind: "fold", family, relation: l.owner.name, column: fold.planes[0].end.name }
		}
	}
	for (const p of l.axes.predecessor) {
		if (columnKey(p.to) === key) {
			return { kind: "predecessor", family, relation: l.member.name, column: nameOf(p.from) }
		}
	}
	for (const p of l.axes.last) {
		if (columnKey(p.to) === key) {
			return { kind: "last", family, relation: l.owner.name, column: nameOf(p.from) }
		}
	}
	if (isTreeOf(l, l.member.name)) {
		for (const p of l.axes.owner) {
			if (columnKey(p.to) === key) {
				return { kind: "tree", family, relation: l.member.name, column: nameOf(p.from) }
			}
		}
	}
	return undefined
}

/**
 * The first value among `families` drawn from a column a write of `relation` by `op` changes on rows already stored,
 * with the change and the columns the cascade carries it into; none when every value such a change reaches is drawn
 * again: see the module's header. `edited` are the families of `relation` the write edits: every one it is a member
 * of, a tree's aside, for its own write, and its counted families alone for a nested write's row, whose sequences the
 * nested walk fills with their fresh owners.
 */
export const staleRead = (
	families: ReadonlyArray<Family>,
	relation: RelationInfo,
	op: "insert" | "put" | "delete",
	edited: ReadonlyArray<Family>
): StaleRead | undefined => {
	const seen = new Set<string>()
	/**
	 * A value that reads `column` of `at`, a change reaches by `copies`: among the families `at` is a member of where
	 * `drawn`, else among those its owner axes carry the change on to, and the fields generated from it.
	 */
	const reach = (
		at: RelationInfo,
		column: NativeColumn,
		drawn: boolean,
		copies: ReadonlyArray<ColumnName>
	): { readonly copies: ReadonlyArray<ColumnName>; readonly reader: DerivedReader } | undefined => {
		const visit = `${at.name}\u0000${columnKey(column)}\u0000${drawn ? "drawn" : "planned"}`
		if (seen.has(visit)) {
			return undefined
		}
		seen.add(visit)
		if (drawn) {
			for (const l of families) {
				const reader = l.member.name === at.name ? readerIn(l, column) : undefined
				if (reader !== undefined) {
					return { copies, reader }
				}
			}
		}
		for (const j of families) {
			if (j.owner.name !== at.name || j.members.kind === "tree") {
				continue
			}
			for (const p of j.axes.owner) {
				if (columnKey(p.to) !== columnKey(column)) {
					continue
				}
				const found = reach(j.member, p.from, true, [
					...copies,
					{ relation: j.member.name, column: nameOf(p.from) }
				])
				if (found !== undefined) {
					return found
				}
			}
		}
		for (const g of at.fields) {
			const generated =
				g.writing.kind === "generated" &&
				column.kind === "field" &&
				readsOf(g.writing.expr).includes(column.field.name)
			const found = generated ? reach(at, { kind: "field", field: g }, drawn, copies) : undefined
			if (found !== undefined) {
				return found
			}
		}
		return undefined
	}
	const changes: Array<{
		readonly owner: RelationInfo
		readonly columns: ReadonlyArray<NativeColumn>
		readonly by: ChangedColumn["by"]
	}> = []
	if (op === "put") {
		const key = new Set(relation.primaryFields.map((f) => f.name))
		changes.push({
			owner: relation,
			by: "put",
			columns: relation.fields.flatMap((field): ReadonlyArray<NativeColumn> =>
				!key.has(field.name) &&
				(field.writing.kind === "caller" || field.writing.kind === "generated")
					? [{ kind: "field", field }]
					: []
			)
		})
	}
	for (const h of edited) {
		if (h.member.name === relation.name && h.members.kind !== "tree") {
			changes.push({
				owner: h.owner,
				by: "owner",
				columns: [{ kind: "field", field: h.count }, ...h.axes.last.map((p) => p.from)]
			})
			changes.push({
				owner: relation,
				by: "member",
				columns: [
					h.index,
					...h.axes.owner.map((p) => p.from),
					...h.axes.predecessor.map((p) => p.from)
				]
			})
		}
	}
	for (const change of changes) {
		for (const column of change.columns) {
			const found = reach(change.owner, column, change.by === "owner", [])
			if (found !== undefined) {
				return {
					changed: { relation: change.owner.name, column: nameOf(column), by: change.by },
					copies: found.copies,
					reader: found.reader
				}
			}
		}
	}
	return undefined
}
