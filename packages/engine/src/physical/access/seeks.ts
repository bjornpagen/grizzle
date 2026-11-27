import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import type { IndexMethod } from "#compiler/core/identity.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { AccessPath } from "#compiler/ir/products.ts"
import {
	baseOf,
	fewValued,
	isSpanCarrier,
	nativeNames,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import type { IndexColumn, InstallBuilder, TargetField } from "#compiler/physical/ddl/context.ts"
import type { KeyIndex } from "#compiler/physical/ddl/tables.ts"
import type { KeyTerm, PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import { datumBound } from "#compiler/schema/representability.ts"
import { type NameKey, nameKey, type SqlStatement } from "#compiler/sql/ast.ts"
import {
	runSeeks,
	type SeekProgram,
	type SeekReading,
	type SeekView,
	seekView
} from "#compiler/sql/seeks.ts"

/**
 * A missed index is an internal compiler error (README "Keys and indexes"): every read a printed statement makes of a
 * stored table at values its scope fixes is a seek some index of the table serves, so no statement grizzle installs or
 * serves reads a table by a scan whose rows a binding of its own would have bounded.
 *
 * The bound. A read of k rows of a table of n at a binding an index's leading run holds is O(k log n) pages; the same
 * read with no index leading with the binding's columns is O(n), however few rows it keeps, and grows with the store.
 * Indexes derive from the statements alone (physical/access/extract.ts extractAccess, the index engine's requests), so a
 * binding no index serves is a request the extraction never made: a defect of the compiler, never of the schema.
 *
 * What a statement binds is read off the statement as printed, before any installation exists, into its seek program
 * (sql/seeks.ts seekProgram): each level's items, the equalities over them and the classes of columns they make equal,
 * which this module runs at the installation's indexes (`judgeSeeks`), so an installation's statements, a login's served
 * reads and its compiled writes, a write compiled before the installation it is served beside plans its indexes, are
 * held by one walk and one judge. The run closes each level's equalities over its items of one row, a probe, a met row,
 * or a stored table whose bound columns hold a unique index's whole (`readingOf`), and reads each view a role reads its
 * relations through as the derived table PostgreSQL expands it into (`SeekTargets`), so a served read or write is held
 * at the tables its views read.
 * A seek is served where an index of the table leads with every bound column of many values (`covers`): a column of no
 * byte bound, a span, a vector and a search document are no B-tree's columns, and a column of few values picks a
 * roster's share of the rows, which no index bounds, a filter beside the run. A seek whose bound columns hold a unique
 * index's reads one row through it.
 *
 * An equality between two items of one level that neither fixes is a join PostgreSQL orders by its estimates, whose
 * probe side's index the extraction asks for on its own (a join partner's context), and is not judged here; nor is a
 * statement that reads what it reads whole, once (sql/seeks.ts `wholeReads`): a stored derived relation's fill.
 */

/** What a column holds for a seek: many values, few values (a roster's codes, a boolean), or nothing a B-tree holds. */
export type Holds = "many" | "few" | "none"

/**
 * An index of a stored table as a seek reads it: its leading columns up to its first that is no column's own value, and
 * whether it is a GiST index, which a seek reads through every column it binds, how much of it the seek scans decided by
 * its first column (`covers`).
 */
export interface SeekIndex {
	readonly name: string
	readonly columns: ReadonlyArray<string>
	readonly unique: boolean
	readonly gist: boolean
}

/**
 * A stored table of the installation: its relation, and whether that is a derived relation it stores; each of its
 * columns by its installed name, with the field or law column it is (physical/ddl/context.ts IndexColumn) and what it
 * holds; the columns PostgreSQL's equality on which is leaky (`leakyTypes`); and its indexes.
 */
export interface SeekTable {
	readonly relation: string
	readonly derived: boolean
	readonly columns: ReadonlyMap<string, IndexColumn>
	readonly holds: ReadonlyMap<string, Holds>
	readonly leaky: ReadonlySet<string>
	readonly indexes: ReadonlyArray<SeekIndex>
}

/**
 * An index of a stored table as `seekTargets` reads it: its relation, its name, its keys in order, and whether it is
 * unique: one the index engine planned (physical/indexes/engine.ts PlannedIndex), or, before it plans any, a key's or a
 * stored derived relation's unique index, which are every unique index an installation holds (the engine creates none).
 */
export interface TableIndex {
	readonly relation: string
	readonly name: string
	readonly keys: ReadonlyArray<KeyTerm>
	readonly unique: boolean
	readonly method: IndexMethod
}

/**
 * What `judgeSeeks` reads of an installation: every stored table with its indexes, and every view it creates, each a
 * role's view of a relation, as the derived table PostgreSQL expands it into (sql/seeks.ts seekView), each by its
 * name's key (sql/ast.ts nameKey).
 */
export interface SeekTargets {
	readonly tables: ReadonlyMap<NameKey, SeekTable>
	readonly views: ReadonlyMap<NameKey, SeekView>
}

/**
 * The PostgreSQL types of grizzle's carriers (ir/scalar.ts nativeNames) whose equality function is not leakproof, so no
 * qual of it is pushed past a security barrier (allpaths.c qual_is_pushdown_safe): numeric_eq, record_eq, range_eq
 * and tsvector_eq, and pgvector's vector_eq, which its extension script (vector--0.8.7.sql) creates without LEAKPROOF;
 * every other carrier's equality, int2eq to biteq, uuid_eq, texteq and byteaeq among them, is. PostgreSQL 19.0's
 * pg_proc.proleakproof of each `=` operator's function over two operands of one type says so.
 */
const leakyTypes: ReadonlySet<string> = new Set([
	"numeric",
	"record",
	"int4range",
	"int8range",
	"daterange",
	"tsvector",
	"vector"
])

/**
 * Whether PostgreSQL's equality on a value of `type` is leaky (`leakyTypes`): the one rule of what a security barrier
 * passes, which the missed-index check reads at a view (sql/seeks.ts pushedInto) and the access extraction at a world
 * view (physical/access/extract.ts WorldView).
 */
export const leakyEquality = (type: ScalarType): boolean =>
	leakyTypes.has(nativeNames[baseOf(type).carrier])

/** Whether PostgreSQL's equality on a field is leaky (`leakyEquality`). */
const leakyOf = (field: TargetField): boolean => leakyEquality(field.type)

/** What a field holds for a seek (`Holds`). */
const holdsOf = (field: TargetField): Holds => {
	const carrier = baseOf(field.type).carrier
	if (
		isSpanCarrier(carrier) ||
		carrier === "vector" ||
		carrier === "tsvector" ||
		field.desc.kind === "bytes" ||
		datumBound(field.desc) === undefined
	) {
		return "none"
	}
	return fewValued[carrier] ? "few" : "many"
}

/** The indexes the engine planned (physical/indexes/engine.ts planIndexes), each as a seek reads it (TableIndex). */
export const plannedTableIndexes = (
	indexes: ReadonlyArray<PlannedIndex>
): ReadonlyArray<TableIndex> =>
	indexes.map((i) => ({
		relation: i.relation,
		name: i.index.name,
		keys: i.keys.map((k) => k.column),
		unique: i.unique,
		method: i.method
	}))

/**
 * The unique indexes of the installation `b` builds before the engine plans any (TableIndex): each key's
 * (physical/ddl/tables.ts KeyIndex), and each stored derived relation's unique index. The engine creates no unique
 * index, so these are every one it holds, and a seek's items of one row are the same before its plan and after.
 */
export const keyTableIndexes = (
	b: InstallBuilder,
	keys: ReadonlyArray<KeyIndex>
): ReadonlyArray<TableIndex> => [
	...keys.map((k): TableIndex => ({
		relation: k.relation,
		name: k.name,
		keys: k.columns.map((c): KeyTerm =>
			c.kind === "field" ? { kind: "field", field: c.field.name } : c
		),
		unique: true,
		method: k.method
	})),
	...b.indexedViews().flatMap((v) =>
		v.uniqueIndexes.map((u): TableIndex => ({
			relation: v.relation,
			name: u.name,
			keys: u.columns.map((field): KeyTerm => ({ kind: "field", field })),
			unique: true,
			method: "btree"
		}))
	)
]

/**
 * Every stored table of the installation `b` builds, with the indexes `indexes` of it (TableIndex): a stored relation's
 * table and a derived relation's, each by the relation it is installed as.
 */
const seekTables = (
	b: InstallBuilder,
	indexes: ReadonlyArray<TableIndex>
): ReadonlyMap<NameKey, SeekTable> => {
	const derived = new Set(b.indexedViews().map((v) => v.relation))
	/** Each stored table's relation, with its fields by name. */
	const fields = new Map<string, ReadonlyArray<readonly [string, TargetField]>>([
		...Object.entries(b.model.theory.relations).flatMap(([name, r]) =>
			r.kind === "relation" ? [[name, r.fields.map((f) => [f.name, f] as const)] as const] : []
		),
		...b.indexedViews().map((v) => [v.relation, [...v.fields]] as const)
	])
	const out = new Map<NameKey, SeekTable>()
	for (const [relation, own] of fields) {
		const target = b.target(relation)
		if (target.kind !== "built") {
			continue
		}
		const columns = new Map<string, IndexColumn>(
			own.map(
				([field]) => [target.column({ kind: "field", field }), { kind: "field", field }] as const
			)
		)
		const holds = new Map<string, Holds>(
			own.map(([field, f]) => [target.column({ kind: "field", field }), holdsOf(f)] as const)
		)
		const leaky = new Set(
			own.flatMap(([field, f]) => (leakyOf(f) ? [target.column({ kind: "field", field })] : []))
		)
		const planned = indexes.flatMap((i): ReadonlyArray<SeekIndex> => {
			if (i.relation !== relation) {
				return []
			}
			const leading: Array<string> = []
			for (const k of i.keys) {
				if (k.kind === "suffix") {
					break
				}
				const column = target.column(k)
				const field = target.field(k)
				if (field !== undefined) {
					holds.set(column, holdsOf(field))
				}
				columns.set(column, k)
				leading.push(column)
			}
			return [{ name: i.name, columns: leading, unique: i.unique, gist: i.method === "gist" }]
		})
		out.set(nameKey(b.names.relation(relation)), {
			relation,
			derived: derived.has(relation),
			columns,
			holds,
			leaky,
			indexes: planned
		})
	}
	return out
}

/**
 * What the installation `b` builds is judged at (SeekTargets): its stored tables, with the indexes `indexes` plans on
 * them (`seekTables`), and the views among `statements`, the installation's, each read as the derived table PostgreSQL
 * expands it into.
 */
export const seekTargets = (
	b: InstallBuilder,
	indexes: ReadonlyArray<TableIndex>,
	statements: ReadonlyArray<SqlStatement>
): SeekTargets => ({
	tables: seekTables(b, indexes),
	views: new Map(
		statements.flatMap((s) =>
			s.kind === "createView" ? [[nameKey(s.name), seekView(s)] as const] : []
		)
	)
})

/** The leading run of an index a set of bound columns holds: its columns up to the first the set lacks. */
const runOf = (index: SeekIndex, bound: ReadonlySet<string>): ReadonlyArray<string> => {
	const run: Array<string> = []
	for (const c of index.columns) {
		if (!bound.has(c)) {
			break
		}
		run.push(c)
	}
	return run
}

/**
 * Whether a seek of `table` binding `bound` is served (the module header): it binds no column of many values, or some
 * index's leading run holds every one it binds, or holds a unique index whole, or it binds the first column of a GiST
 * index, which reads every column the seek binds and scans as much of itself as its first column's condition leaves
 * (PostgreSQL 19 "Multicolumn Indexes": the condition on the first column decides how much of a GiST index is scanned),
 * where a B-tree reads the leading run alone. A column of few values beside them, a roster's handle or a boolean, is a
 * filter an index may leave beside its run, the share of the rows it picks bounded whatever the store holds.
 */
const covers = (table: SeekTable, bound: ReadonlySet<string>): boolean => {
	const held = [...bound].filter((c) => table.holds.get(c) === "many")
	if (held.length === 0) {
		return true
	}
	return table.indexes.some((i) => {
		const run = runOf(i, bound)
		return (
			(i.unique && run.length === i.columns.length) ||
			(i.gist && run.length > 0) ||
			held.every((c) => run.includes(c))
		)
	})
}

/**
 * The installation `targets` as a seek program's run reads it (sql/seeks.ts SeekReading): its views; a stored table read
 * at `bound` reads one row where some unique index of it holds only columns of `bound`; and its leaky columns.
 */
const readingOf = (targets: SeekTargets): SeekReading => ({
	view: (key) => targets.views.get(key),
	unique: (key, bound) =>
		targets.tables
			.get(key)
			?.indexes.some(
				(x) => x.unique && x.columns.length > 0 && x.columns.every((c) => bound.has(c))
			) === true,
	leaky: (key, column) => targets.tables.get(key)?.leaky.has(column) === true
})

/**
 * Refuses as an internal compiler error the first seek of `program` (sql/seeks.ts SeekProgram) of a stored table of
 * `targets` at columns no index serves (the module header), naming `subject`, what the program's statements are: an
 * installed object, a read a login's served file sends, or a write it serves.
 */
export const judgeSeeks = (program: SeekProgram, targets: SeekTargets, subject: string): void =>
	runSeeks(program, readingOf(targets), ({ table: key, bound }) => {
		const table = targets.tables.get(key)
		if (table !== undefined && !covers(table, bound)) {
			defect(
				`missed index: ${subject} reads ${table.relation} at (${[...bound].toSorted(compareStrings).join(", ")}), which no index of it leads with (its indexes: ${table.indexes.map((i) => `${i.name} (${i.columns.join(", ")})`).join(", ")}): every equality the lowering prints reaches the index engine as an access request (physical/access/extract.ts extractAccess), so a seek no index serves is a request it never made (physical/access/seeks.ts)`
			)
		}
	})

/** Every seek `program` makes of a stored table of `targets` (the module header): its table and the columns it binds. */
export const tableSeeks = (
	program: SeekProgram,
	targets: SeekTargets
): ReadonlyArray<{
	readonly table: SeekTable
	readonly bound: ReadonlySet<string>
	readonly range: string | undefined
}> => {
	const out: Array<{
		readonly table: SeekTable
		readonly bound: ReadonlySet<string>
		readonly range: string | undefined
	}> = []
	runSeeks(program, readingOf(targets), (seek) => {
		const table = targets.tables.get(seek.table)
		if (table !== undefined) {
			out.push({ table, bound: seek.bound, range: seek.range })
		}
	})
	return out
}

/**
 * The access paths of the seeks `program` makes of a stored table of `targets` (`tableSeeks`), each the equality lookup
 * of the fields it binds that a B-tree holds, in name order, one binding a field of many values, then the field it reads
 * a range of past them where it reads one (sql/seeks.ts Seek `range`), one path, its fixed keys the bound fields; a law
 * column it binds is a filter beside the path, which no workload request names. What a served write asks the index engine for, so every
 * seek of a write its served file sends is asked, and only those (program/workload/compile.ts changeSetAccess).
 */
export const seekPaths = (program: SeekProgram, targets: SeekTargets): ReadonlyArray<AccessPath> =>
	tableSeeks(program, targets).flatMap(({ table, bound, range }): ReadonlyArray<AccessPath> => {
		const fields = [...bound]
			.flatMap((c) => {
				const column = table.columns.get(c)
				const holds = table.holds.get(c)
				return column?.kind === "field" && holds !== undefined && holds !== "none"
					? [{ field: column.field, holds }]
					: []
			})
			.toSorted((x, y) => compareStrings(x.field, y.field))
		const ranged = range === undefined ? undefined : table.columns.get(range)
		return fields.some((f) => f.holds === "many")
			? [
					{
						relation: table.relation,
						derived: table.derived,
						method: "btree",
						keys: [
							...fields.map((f) => ({ field: f.field, dir: "asc" as const })),
							...(ranged?.kind === "field" ? [{ field: ranged.field, dir: "asc" as const }] : [])
						],
						fixed: fields.length,
						use: "equality lookup"
					}
				]
			: []
	})

/** A seek of a stored table as `printedSeeks` names it: its relation, beside what the run met (sql/seeks.ts Seek). */
export interface PrintedSeek {
	readonly relation: string
	readonly bound: ReadonlySet<string>
	readonly against: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * Every seek `program` makes of a stored table of `targets` (the module header), each its relation, the columns, by
 * their installed names, it binds, and the enclosing items each column's value reads: what the converse of
 * `judgeSeeks` reads, that the extraction asks no path at a binding no statement prints, an index no plan reads, and
 * what a joined probe's seek is bound against.
 */
export const printedSeeks = (
	program: SeekProgram,
	targets: SeekTargets
): ReadonlyArray<PrintedSeek> => {
	const out: Array<PrintedSeek> = []
	runSeeks(program, readingOf(targets), (seek) => {
		const table = targets.tables.get(seek.table)
		if (table !== undefined) {
			out.push({ relation: table.relation, bound: seek.bound, against: seek.against })
		}
	})
	return out
}
