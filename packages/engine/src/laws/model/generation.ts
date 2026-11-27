/**
 * What an UPDATE of a stored relation's table meets of its stored generated columns (sql/generation.ts), read from the
 * law model: each generated field, `GENERATED ALWAYS AS (<expr>) STORED` (physical/ddl/tables.ts fieldGeneration), and
 * each generated law column, its term under its guard over the row's written fields, a generated field read through its
 * own expression (tables.ts lawColumnGeneration, lowerWrittenRow); and the anchor among the columns the UPDATE's
 * updater may assign.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { fieldReads, predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { nameKey, type ObjectName } from "#compiler/sql/ast.ts"
import {
	type StoredGenerated,
	type TableGeneration,
	tableGeneration
} from "#compiler/sql/generation.ts"

/** An expression's size: the distinct nodes of its tree (ir/expr.ts predicateTable), what a row's evaluation visits. */
const sizeOf = (expr: ScalarExpr): number => Object.keys(predicateTable(expr).exprs).length

/** The stored relation of the law model's theory named `relation`: every table an UPDATE writes is one. */
const relationOf = (laws: LawModel, relation: string): RelationInfo => {
	const r = laws.theory.relations[relation]
	if (r?.kind !== "relation") {
		defect(`the table ${relation} an UPDATE writes is a stored relation of the theory`)
	}
	return r
}

/**
 * Each stored generated column of `relation`'s table, in its fields' order then its law columns' order, with the
 * installed columns its expression reads and its size: a field or law column read by name, and a generated field
 * read by the columns and size of its own expression, which the installed expression holds in its place.
 */
const storedGenerated = (laws: LawModel, relation: string): ReadonlyArray<StoredGenerated> => {
	const info = relationOf(laws, relation)
	const fields = new Map(info.fields.map((f) => [f.name, f] as const))
	const lawColumns = laws.natives.flatMap((n) =>
		n.object.kind === "LawColumn" && n.object.relation.name === relation ? [n.object] : []
	)
	/** A law column a generated column reads, by its identifier: a drawn one, as PostgreSQL reads no generated column in
	 * another's expression. */
	const lawColumnNames = new Set(lawColumns.map((c): string => c.column))
	/** The installed columns and the size a read of `name` stands for in an installed expression. */
	const read = (
		name: string
	): { readonly columns: ReadonlyArray<string>; readonly size: number } => {
		const field = fields.get(name)
		if (field !== undefined) {
			return field.writing.kind === "generated"
				? over([field.writing.expr])
				: { columns: [field.column], size: 0 }
		}
		if (lawColumnNames.has(name)) {
			return { columns: [name], size: 0 }
		}
		defect(`the column ${name} a generated column of ${relation} reads`)
	}
	const over = (
		exprs: ReadonlyArray<ScalarExpr>
	): { readonly columns: ReadonlyArray<string>; readonly size: number } => {
		const reads = exprs.flatMap((e) => fieldReads([e])).map(read)
		return {
			columns: [...new Set(reads.flatMap((r) => r.columns))],
			size: exprs.reduce((sum, e) => sum + sizeOf(e), 0) + reads.reduce((sum, r) => sum + r.size, 0)
		}
	}
	const generated = (column: string, exprs: ReadonlyArray<ScalarExpr>): StoredGenerated => {
		const { columns, size } = over(exprs)
		return { column, reads: columns, size }
	}
	return [
		...info.fields.flatMap((f) =>
			f.writing.kind === "generated" ? [generated(f.column, [f.writing.expr])] : []
		),
		...lawColumns.flatMap((c) =>
			c.value.kind === "generated" ? [generated(c.column, [...c.value.guard, c.value.term])] : []
		)
	]
}

/** Whether an UPDATE can assign a field's column at all: every column but a generated one, which PostgreSQL computes. */
const assignable = (f: LawField): boolean => f.writing.kind !== "generated"

/**
 * Who runs a compilation's UPDATEs, and what each may assign: reality, the tables' owner, any assignable column (a
 * migration's UPDATEs, a write of reality's, a unit function's, which runs SECURITY DEFINER); or a role, only the
 * assignable columns its grants list (`updates`, physical/ddl/roles.ts roleUpdates), since PostgreSQL refuses an UPDATE
 * that assigns any other with 42501. A role's anchor is so a column it already updates: its grants are its world's,
 * and grizzle widens none for an anchor. A write's world (write/entry/precheck.ts WriteWorld) is one.
 */
export type Updater =
	| { readonly kind: "reality" }
	| { readonly kind: "role"; readonly updates: (relation: string, column: string) => boolean }

/** Reality, the tables' owner (`Updater`). */
export const reality: Updater = Object.freeze({ kind: "reality" })

/** The generation of `relation`'s table as `updater`'s UPDATEs meet it. */
const generationOf = (laws: LawModel, updater: Updater, relation: string): TableGeneration => {
	const info = relationOf(laws, relation)
	const assigned = new Set(
		info.fields.flatMap((f): ReadonlyArray<string> =>
			assignable(f) && (updater.kind === "reality" || updater.updates(relation, f.column))
				? [f.column]
				: []
		)
	)
	/** A drawn law column, which only grizzle writes, as a field it draws is. */
	const drawn = new Set(
		laws.natives.flatMap((n): ReadonlyArray<string> =>
			n.object.kind === "LawColumn" &&
			n.object.relation.name === relation &&
			n.object.value.kind === "drawn" &&
			(updater.kind === "reality" || updater.updates(relation, n.object.column))
				? [n.object.column]
				: []
		)
	)
	return tableGeneration(
		storedGenerated(laws, relation),
		(column) => assigned.has(column) || drawn.has(column)
	)
}

/** Each table's generation as `updater`'s UPDATEs meet it, each relation's computed once, where a compilation first
 * asks for it. */
export const generations = (
	laws: LawModel,
	updater: Updater
): ((relation: string) => TableGeneration) => {
	const known = new Map<string, TableGeneration>()
	return (relation) => {
		const at = known.get(relation)
		if (at !== undefined) {
			return at
		}
		const generation = generationOf(laws, updater, relation)
		known.set(relation, generation)
		return generation
	}
}

/**
 * Each stored relation's table's generation as its owner's UPDATEs meet it, by the table `tableOf` names the relation's:
 * what a migration's UPDATEs, the backfill's (deploy/diff/backfill.ts) and a fill's (deploy/diff/diff.ts), are built
 * against.
 */
export const migrationGenerations = (
	laws: LawModel,
	tableOf: (relation: string) => ObjectName
): ((table: ObjectName) => TableGeneration) => {
	const relations = new Map(
		Object.values(laws.theory.relations).flatMap((r) =>
			r.kind === "relation" ? [[nameKey(tableOf(r.name)), r.name] as const] : []
		)
	)
	const of = generations(laws, reality)
	return (table) => {
		const relation = relations.get(nameKey(table))
		if (relation === undefined) {
			defect(`the table ${table.schema}.${table.name} an UPDATE writes is a stored relation's`)
		}
		return of(relation)
	}
}
