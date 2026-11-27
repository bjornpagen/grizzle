import { Array as Arr, Option, String as Str } from "effect"
import type { Step } from "#compiler/deploy/diff/plan.ts"
import type { SnapshotTheory } from "#compiler/deploy/snapshot/types.ts"
import type { NativeColumn } from "#compiler/ir/law.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { Expr, FromSource, SqlStatement, Update, With } from "#compiler/sql/ast.ts"
import { identityHooks, transformExpr, transformStatement } from "#compiler/sql/transform.ts"

/**
 * The per-row reads of a migration's backfill, the oracle of "a backfill is set-based": every statement of its slot
 * (structure.backfill) is a join of row sets, each computed once, never a read PostgreSQL runs again for each row of
 * another. Before any index of a table exists, which structure.backfill runs ahead of, such a read scans the table once
 * per row. Two forms make one, both judged on the drafted statement's SQL AST:
 *
 * - a subquery (a scalar one, EXISTS, IN or ARRAY) that reads a column of a FROM item outside it, or a column it does
 *   not qualify, which PostgreSQL runs as a SubPlan once per outer row;
 * - a LATERAL source, a derived table or a function's rows, or a write's probe of a stored table, run once per row
 *   that drives it.
 *
 * A subquery that reads only what it holds is run once, its rows an InitPlan, and is no per-row read.
 */
export const perRowReads = (steps: ReadonlyArray<Step>): ReadonlyArray<string> =>
	Arr.flatMap(steps, (step) =>
		step.slot === "structure.backfill" && step.draft.kind === "statement"
			? statementReads(step.draft.statement)
			: []
	)

/**
 * The recursions of a migration's backfill, the oracle of "a backfill's cost is a sort of its rows": no statement of
 * structure.backfill holds a WITH RECURSIVE, at its top or in any query inside it. A recursive CTE's step joins its
 * worktable to the rows it reads again at every step, so a recursion over a tree runs once per level of its depth, or
 * builds the closure of its parents, n²/2 pairs over a chain of n. Each is named by its statement's table and the CTEs
 * of the WITH.
 */
export const recursions = (steps: ReadonlyArray<Step>): ReadonlyArray<string> =>
	Arr.flatMap(steps, (step) => {
		if (step.slot !== "structure.backfill" || step.draft.kind !== "statement") {
			return []
		}
		const statement = step.draft.statement
		const found: Array<string> = []
		const recursive = (w: With | undefined): void => {
			if (w?.recursive === true) {
				found.push(
					`a WITH RECURSIVE of ${Arr.join(
						Arr.map(w.ctes, (c) => c.name),
						", "
					)}`
				)
			}
		}
		if (statement.kind === "update") {
			recursive(statement.with)
		}
		transformStatement(statement, {
			...identityHooks,
			select: (select) => {
				recursive(select.with)
				return select
			}
		})
		return found
	})

/** Each per-row read of one statement, by what it is. */
const statementReads = (statement: SqlStatement): ReadonlyArray<string> => {
	const found: Array<string> = []
	transformStatement(statement, {
		...identityHooks,
		fromSource: (source) => {
			const lateral = lateralSource(source)
			if (lateral !== undefined) {
				found.push(lateral)
			}
			return source
		},
		expr: (e) => {
			const outer = isSubquery(e) ? outerReads(e) : []
			if (outer.length > 0) {
				found.push(`a subquery reading ${Arr.join(outer, ", ")} from outside it`)
			}
			return e
		}
	})
	return found
}

/** A FROM source PostgreSQL reads once per row that drives it, by what it is. */
const lateralSource = (source: FromSource): string | undefined =>
	(source.kind === "derived" || source.kind === "function") && source.lateral
		? `a LATERAL source "${source.alias}"`
		: source.kind === "probe" || source.kind === "met"
			? `a probe "${source.alias}"`
			: undefined

/** Whether an expression is a subquery: a scalar one, EXISTS, IN or ARRAY. */
const isSubquery = (e: Expr): boolean =>
	e.kind === "subquery" || e.kind === "exists" || e.kind === "inQuery" || e.kind === "array"

/** The name a FROM source's columns are read under. */
const aliasOf = (source: FromSource): string | undefined =>
	source.kind === "cte"
		? (source.alias ?? source.name)
		: "alias" in source
			? source.alias
			: undefined

/** The columns a subquery reads from outside it: each qualified by a FROM item it does not hold, and each unqualified
 * one, which may name an outer row's. */
const outerReads = (subquery: Expr): ReadonlyArray<string> => {
	const held = new Set<string>()
	const read: Array<{ readonly table: string | undefined; readonly column: string }> = []
	transformExpr(subquery, {
		...identityHooks,
		fromSource: (source) => {
			const alias = aliasOf(source)
			if (alias !== undefined) {
				held.add(alias)
			}
			return source
		},
		expr: (e) => {
			if (e.kind === "column") {
				read.push({ table: e.table, column: e.column })
			}
			return e
		}
	})
	return Arr.dedupe(
		Arr.flatMap(read, (c) =>
			c.table === undefined
				? [`"${c.column}"`]
				: held.has(c.table)
					? []
					: [`"${c.table}"."${c.column}"`]
		)
	)
}

/**
 * The tables a migration's backfill writes more than once, each named with how many UPDATEs of its slot
 * (structure.backfill) write it: the oracle of "a backfill writes each row once", since each UPDATE writes a new
 * version of every row it names, which holds its space until the migration's transaction ends.
 */
export const rewrittenTables = (steps: ReadonlyArray<Step>): ReadonlyArray<string> => {
	const writes = new Map<string, number>()
	for (const step of steps) {
		if (
			step.slot !== "structure.backfill" ||
			step.draft.kind !== "statement" ||
			step.draft.statement.kind !== "update"
		) {
			continue
		}
		const { table } = step.draft.statement
		const name = `${table.schema}.${table.name}`
		writes.set(name, (writes.get(name) ?? 0) + 1)
	}
	return Arr.flatMap(Arr.fromIterable(writes), ([name, count]) =>
		count > 1 ? [`${name}, written by ${count} UPDATEs`] : []
	)
}

/**
 * The derivations a migration's backfill draws in more than one statement, the oracle of "each derived column is drawn
 * once per migration": every derivation is a CTE of the WITH of each UPDATE of structure.backfill that reads it, named
 * by its place in the backfill's order (deploy/diff/backfill.ts drawingName, `__drawing_<n>`), and a later UPDATE reads
 * a column an earlier one wrote as stored, so no derivation of a table whose UPDATE ran before stands in the WITH of an
 * UPDATE after it. Each derivation drawn again is named with the tables of the UPDATEs that draw it.
 */
export const rederived = (steps: ReadonlyArray<Step>): ReadonlyArray<string> => {
	const drawnBy = new Map<string, Array<string>>()
	for (const step of steps) {
		if (
			step.slot !== "structure.backfill" ||
			step.draft.kind !== "statement" ||
			step.draft.statement.kind !== "update"
		) {
			continue
		}
		const { table, with: w } = step.draft.statement
		for (const cte of w?.ctes ?? []) {
			if (Str.startsWith("__drawing_")(cte.name)) {
				drawnBy.set(cte.name, [...(drawnBy.get(cte.name) ?? []), `${table.schema}.${table.name}`])
			}
		}
	}
	return Arr.flatMap(Arr.fromIterable(drawnBy), ([name, tables]) =>
		tables.length > 1 ? [`${name}, drawn by the UPDATEs of ${Arr.join(tables, ", ")}`] : []
	)
}

/** The installed column of a family's native column. */
const nativeColumn = (c: NativeColumn): string => (c.kind === "field" ? c.field.column : c.column)

/** A table's key as the oracle states it: the table, its columns, and the law that holds it unique. */
export interface StatedKey {
	readonly law: string
	readonly table: string
	readonly columns: ReadonlyArray<string>
}

/**
 * The key checks a migration's backfill owes, the oracle of "a backfill computes over unique keys or not at all": for
 * each family whose columns an UPDATE of structure.backfill sets, each key its rows are met at, its member's primary
 * key, its owner's, and its slot key (its group and its index), whose law the previous snapshot does not record and none
 * of whose columns the backfill sets, so no constraint holds it while the backfill runs and the stored rows already hold
 * it. Each is stated by its law, its table and its columns.
 */
export const owedKeyChecks = (
	installation: Installation,
	previous: SnapshotTheory,
	steps: ReadonlyArray<Step>
): ReadonlyArray<StatedKey> => {
	const backfill = Arr.filter(steps, (s) => s.slot === "structure.backfill")
	const updates = Arr.flatMap(backfill, (s): ReadonlyArray<Update> =>
		s.draft.kind === "statement" && s.draft.statement.kind === "update" ? [s.draft.statement] : []
	)
	const set = new Set(
		Arr.flatMap(updates, (u) => Arr.map(u.set, (a) => `${u.table.name}.${a.column}`))
	)
	const tableOf = (relation: string): string => {
		const r = installation.laws.theory.relations[relation]
		return r?.kind === "relation" ? r.ident : relation
	}
	const primaryKey = (relation: string): ReadonlyArray<StatedKey> =>
		Arr.flatMap(installation.laws.theory.primaryKeys, (pk) =>
			pk.relation.name === relation
				? [
						{
							law: pk.law.id,
							table: tableOf(relation),
							columns: Arr.map(pk.relation.primaryFields, (f) => f.column)
						}
					]
				: []
		)
	const owed = Arr.flatMap(installation.laws.families, (family) => {
		const member = tableOf(family.member.name)
		const owner = tableOf(family.owner.name)
		const drawn = [
			...Arr.map(
				[
					nativeColumn(family.shape.index),
					family.next,
					...Arr.flatMap(family.folds, (fold) =>
						Arr.flatMap(fold.planes, (p) => [nativeColumn(p.before), nativeColumn(p.after)])
					),
					...(family.shape.kind === "tree" ? [family.shape.parent.column] : [])
				],
				(c) => `${member}.${c}`
			),
			...Arr.map(
				[
					family.count.column,
					...Arr.flatMap(family.folds, (fold) => Arr.map(fold.planes, (p) => p.end.column))
				],
				(c) => `${owner}.${c}`
			)
		]
		if (!Arr.some(drawn, (cell) => set.has(cell))) {
			return []
		}
		const keys: ReadonlyArray<StatedKey> = [
			...primaryKey(family.member.name),
			...primaryKey(family.owner.name),
			{
				law: family.law,
				table: member,
				columns: [
					...Arr.map(family.group, (g) => g.member.column),
					nativeColumn(family.shape.index)
				]
			}
		]
		return Arr.filter(
			keys,
			(key) =>
				previous.laws[key.law] === undefined &&
				!Arr.some(key.columns, (c) => set.has(`${key.table}.${c}`))
		)
	})
	return Arr.dedupeWith(owed, (a, b) => a.law === b.law && a.table === b.table)
}

/** The key checks a migration's backfill owes (owedKeyChecks) and does not run first: owed is a violation check of the
 * key's law in structure.backfill ahead of its first UPDATE. Each is named by its law, its table and its columns. */
export const missingKeyChecks = (
	installation: Installation,
	previous: SnapshotTheory,
	steps: ReadonlyArray<Step>
): ReadonlyArray<string> => {
	const backfill = Arr.filter(steps, (s) => s.slot === "structure.backfill")
	const firstUpdate = Arr.findFirstIndex(
		backfill,
		(s) => s.draft.kind === "statement" && s.draft.statement.kind === "update"
	)
	const before = Option.match(firstUpdate, {
		onNone: () => [],
		onSome: (at) => backfill.slice(0, at)
	})
	const checked = new Set(
		Arr.flatMap(before, (s) => (s.draft.kind === "violation" ? [String(s.draft.law)] : []))
	)
	return Arr.flatMap(owedKeyChecks(installation, previous, steps), (key) =>
		checked.has(key.law)
			? []
			: [
					`${key.law} on ${key.table} (${Arr.join(key.columns, ", ")}), no check ahead of the backfill`
				]
	)
}
