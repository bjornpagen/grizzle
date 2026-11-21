import { dependencyOrder } from "@bjornpagen/grizzle-text/base/graph"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	type AlterTableAction,
	type ColumnDef,
	type CreateTable,
	type InlineConstraint,
	type NameKey,
	nameKey,
	type SqlStatement
} from "#compiler/sql/ast.ts"
import { generationColumns } from "#compiler/sql/transform.ts"

/**
 * Tables created whole. A table an installation or a migration creates is one CREATE TABLE that states every column,
 * key, exclusion and CHECK of its own an ALTER TABLE after it would add (InlineSubcommand): its law columns and its own
 * keys and CHECKs are objects of their own (physical/ddl/tables.ts addNatives), each an ALTER TABLE of the table, and
 * each such statement rewrote the empty table and built every index it had again (P5: 57 s of a fresh pantry install's
 * 188 s in 19 such statements on a loaded machine). The installation's script (physical/install/compile.ts, wholeTables)
 * and a migration's Differ (deploy/diff/diff.ts, wholeTable) create every new table by this one path, so a first
 * migration runs the installation's script statement for statement.
 */

/** A subcommand of a new table's ALTER TABLE that its CREATE TABLE states itself: a column, or a key, exclusion or CHECK
 * added valid. A foreign key stays its own ALTER TABLE after every table (sql/ast.ts InlineConstraint), as does any
 * other subcommand. */
export type InlineSubcommand =
	| Extract<AlterTableAction, { readonly kind: "addColumn" }>
	| {
			readonly kind: "addConstraint"
			readonly constraint: InlineConstraint
			readonly notValid: false
	  }

/** `a` as its table's CREATE TABLE states it, where it can (InlineSubcommand); none for any other subcommand. */
const inlineSubcommand = (a: AlterTableAction): InlineSubcommand | undefined => {
	if (a.kind === "addColumn") {
		return a
	}
	if (a.kind !== "addConstraint" || a.notValid) {
		return undefined
	}
	const c = a.constraint
	switch (c.kind) {
		case "unique":
		case "exclude":
		case "check":
			return { kind: "addConstraint", constraint: c, notValid: false }
		case "primaryKey":
		case "foreignKey":
			return undefined
	}
}

/** The subcommands of `actions` an ALTER TABLE of their table still runs: each its CREATE TABLE states itself
 * (inlineSubcommand) goes into `created`, the subcommands of a table created whole, and every one stays where the table
 * is not created (`created` none). */
export const notInline = (
	actions: ReadonlyArray<AlterTableAction>,
	created: Array<InlineSubcommand> | undefined
): ReadonlyArray<AlterTableAction> => {
	if (created === undefined) {
		return actions
	}
	const rest: Array<AlterTableAction> = []
	for (const a of actions) {
		const inline = inlineSubcommand(a)
		if (inline === undefined) {
			rest.push(a)
		} else {
			created.push(inline)
		}
	}
	return rest
}

/** Whether the column `reader` is generated over the column `read`. */
const readsColumn = (reader: ColumnDef, read: ColumnDef): boolean =>
	generationColumns(reader.generated).includes(read.name)

/**
 * `create` stating the subcommands `inline` itself, in the order one ALTER TABLE of them runs them in
 * (deploy/diff/plan.ts alterTablePasses), so each takes the place it took there: its columns, then each column added,
 * each after the columns its generation reads (dependencyOrder), otherwise in the order given; its constraints, then
 * each key and exclusion added, then each CHECK, each in the order given.
 */
export const wholeTable = (
	create: CreateTable,
	inline: ReadonlyArray<InlineSubcommand>
): CreateTable => {
	const columns = inline.flatMap((a) => (a.kind === "addColumn" ? [a.column] : []))
	const constraints = inline.flatMap((a) => (a.kind === "addConstraint" ? [a.constraint] : []))
	return {
		...create,
		columns: [
			...create.columns,
			...(isNonEmpty(columns) ? dependencyOrder(columns, readsColumn) : [])
		],
		secondary: [
			...create.secondary,
			...constraints.filter((c) => c.kind !== "check"),
			...constraints.filter((c) => c.kind === "check")
		]
	}
}

/** `statements` with each table they create created whole (wholeTable): every subcommand of an ALTER TABLE after its
 * CREATE TABLE that the CREATE TABLE states itself, in the order the statements give them, stated there; an ALTER TABLE
 * left with none goes, and one left with others runs them in its place. */
export const wholeTables = (
	statements: ReadonlyArray<SqlStatement>
): ReadonlyArray<SqlStatement> => {
	const created = new Map<NameKey, Array<InlineSubcommand>>()
	const kept: Array<SqlStatement> = []
	for (const s of statements) {
		if (s.kind === "createTable") {
			created.set(nameKey(s.table), [])
			kept.push(s)
		} else if (s.kind === "alterTable") {
			const rest = notInline(s.actions, created.get(nameKey(s.table)))
			if (isNonEmpty(rest)) {
				kept.push(rest.length === s.actions.length ? s : { ...s, actions: rest })
			}
		} else {
			kept.push(s)
		}
	}
	return kept.map((s) =>
		s.kind === "createTable"
			? wholeTable(s, defined(created.get(nameKey(s.table)), "a created table's subcommands"))
			: s
	)
}
