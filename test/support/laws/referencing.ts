/**
 * Every foreign key an installation drafts is served on its referencing side, read off the drafted DDL alone: some
 * index of its relation leads with exactly the referencing columns that pair with a key of its target, in any order,
 * or is a unique one all of whose columns are among its referencing columns. A key of the target is a unique B-tree of
 * the target whose columns are all referenced; the referenced columns themselves, which PostgreSQL requires a unique
 * index over, are one, so an index led by every referencing column serves too.
 *
 * Before a referenced row is deleted or its key updated, PostgreSQL's RI trigger (ri_triggers.c, RI_FKey_noaction_del)
 * probes the referencing relation once per row, `SELECT 1 FROM ONLY <relation> x WHERE $1 = <column> AND ... FOR KEY
 * SHARE OF x`, binding every referencing column by equality. The rows equal at the columns that pair with a key of the
 * target reference at most one target row, so an index led by exactly those columns finds only rows that reference the
 * one row probed, and a unique index within the referencing columns finds at most one row; PostgreSQL rechecks the
 * rest on the rows it finds. An index led by only some of those columns, such as a family's key (g, at) for its
 * predecessor axis (g, ‹p›), which pairs with the family key (g, at), finds every row the shorter prefix selects, each
 * probe reading a whole family, so deleting a family of n members reads n² rows.
 *
 * The property holds where one B-tree entry holds the columns that pair with some key: a referencing column of a text
 * of no bound is indexed by the longest leading run of the columns an entry holds (test/support/laws/reverse.ts
 * expectedOf), which test/unit/laws/model/reverse-index.test.ts states for a containment.
 */
import { Array as Arr } from "effect"
import type { IndexMethod } from "#compiler/core/identity.ts"
import type { ObjectName, SqlStatement, TableConstraint } from "#compiler/sql/ast.ts"
import { tableConstraints } from "#compiler/sql/ast.ts"
import { assert } from "#test/support/assert.ts"

/** An index of a table as the DDL drafts it: its method, its columns in key order, and whether it is unique. */
interface DraftedIndex {
	readonly method: IndexMethod
	readonly columns: ReadonlyArray<string>
	readonly unique: boolean
}

/**
 * A foreign key as the DDL drafts it: its name, its relation, its referencing columns, a PERIOD's span among them, its
 * target and the columns it references, pairwise.
 */
interface DraftedReference {
	readonly name: string
	readonly table: string
	readonly columns: ReadonlyArray<string>
	readonly target: string
	readonly referenced: ReadonlyArray<string>
}

const tableKey = (t: ObjectName): string => `${t.schema}.${t.name}`

/** The index a key constraint installs: a B-tree, unique, or a GiST one where it holds a span WITHOUT OVERLAPS, which
 * holds apart overlapping spans and no two equal rows; an exclusion constraint's GiST index; none for a CHECK or a
 * foreign key. */
const constraintIndex = (c: TableConstraint): ReadonlyArray<DraftedIndex> => {
	switch (c.kind) {
		case "primaryKey":
		case "unique": {
			const temporal = Arr.some(c.columns, (k) => k.withoutOverlaps)
			return [
				{
					method: temporal ? "gist" : "btree",
					columns: Arr.map(c.columns, (k) => k.column),
					unique: !temporal
				}
			]
		}
		case "exclude":
			return [{ method: "gist", columns: Arr.map(c.elements, (e) => e.column), unique: false }]
		case "check":
		case "foreignKey":
			return []
	}
}

/** Every index and foreign key the statements draft, each by its table. */
const drafted = (
	statements: ReadonlyArray<SqlStatement>
): {
	readonly indexes: ReadonlyMap<string, ReadonlyArray<DraftedIndex>>
	readonly references: ReadonlyArray<DraftedReference>
} => {
	const indexes = new Map<string, Array<DraftedIndex>>()
	const references: Array<DraftedReference> = []
	const add = (table: ObjectName, index: DraftedIndex): void => {
		const key = tableKey(table)
		indexes.set(key, [...(indexes.get(key) ?? []), index])
	}
	const constraint = (table: ObjectName, c: TableConstraint): void => {
		for (const index of constraintIndex(c)) {
			add(table, index)
		}
		if (c.kind === "foreignKey") {
			references.push({
				name: c.name,
				table: tableKey(table),
				columns: Arr.map(c.columns, (k) => k.column),
				target: tableKey(c.references),
				referenced: Arr.map(c.referencedColumns, (k) => k.column)
			})
		}
	}
	for (const s of statements) {
		if (s.kind === "createTable") {
			for (const c of tableConstraints(s)) {
				constraint(s.table, c)
			}
		} else if (s.kind === "alterTable") {
			for (const a of s.actions) {
				if (a.kind === "addConstraint") {
					constraint(s.table, a.constraint)
				}
			}
		} else if (s.kind === "createIndex") {
			add(s.table, {
				method: s.method,
				columns: Arr.flatMap(s.keys, (k) => (k.key.kind === "column" ? [k.key.column] : [])),
				unique: s.unique
			})
		}
	}
	return { indexes, references }
}

/** Whether every one of `xs` is among `ys`. */
const within = (xs: ReadonlyArray<string>, ys: ReadonlyArray<string>): boolean =>
	Arr.every(xs, (x) => Arr.contains(ys, x))

/** Whether `index` leads with exactly `columns`, in any order. */
const ledBy = (index: DraftedIndex, columns: ReadonlyArray<string>): boolean =>
	index.method !== "hnsw" &&
	index.columns.length >= columns.length &&
	within(Arr.take(index.columns, columns.length), columns)

/**
 * The referencing columns of `r` that pair with each key of its target (the header): every referencing column, for the
 * referenced columns themselves, and those paired with each unique B-tree of the target within the referenced columns.
 */
const keyedRuns = (
	r: DraftedReference,
	targetIndexes: ReadonlyArray<DraftedIndex>
): ReadonlyArray<ReadonlyArray<string>> => [
	r.columns,
	...Arr.flatMap(targetIndexes, (key): ReadonlyArray<ReadonlyArray<string>> =>
		key.unique && key.method === "btree" && within(key.columns, r.referenced)
			? [
					Arr.flatMap(
						Arr.zip(r.columns, r.referenced),
						([column, referenced]: readonly [string, string]): ReadonlyArray<string> =>
							Arr.contains(key.columns, referenced) ? [column] : []
					)
				]
			: []
	)
]

/** Whether `index` serves the probe of `r` (the header). */
const serves = (
	index: DraftedIndex,
	r: DraftedReference,
	runs: ReadonlyArray<ReadonlyArray<string>>
): boolean =>
	Arr.some(runs, (run) => ledBy(index, run)) ||
	(index.unique && index.method === "btree" && within(index.columns, r.columns))

/**
 * Every foreign key the statements draft that no index of its relation serves (the header), each as `<name> on
 * <table> (<columns>)`: none where the property holds.
 */
const unservedReferences = (statements: ReadonlyArray<SqlStatement>): ReadonlyArray<string> => {
	const { indexes, references } = drafted(statements)
	return Arr.flatMap(references, (r) => {
		const runs = keyedRuns(r, indexes.get(r.target) ?? [])
		return Arr.some(indexes.get(r.table) ?? [], (index) => serves(index, r, runs))
			? []
			: [`${r.name} on ${r.table} (${Arr.join(r.columns, ", ")})`]
	})
}

/** Fails unless every foreign key the statements draft is served on its referencing side (`unservedReferences`). */
export const assertReferencesServed = (statements: ReadonlyArray<SqlStatement>): void =>
	assert.deepEqual(
		unservedReferences(statements),
		[],
		"every foreign key's referencing columns that pair with a key of its target lead an index of its relation, or hold a unique one's"
	)
