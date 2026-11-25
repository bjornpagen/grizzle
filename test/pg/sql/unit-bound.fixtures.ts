/**
 * The unit-bound walk's model of PostgreSQL, judged by PostgreSQL (unit-bound.test.ts): drawn statements over a box of
 * four tables, two of them under the unit `child`, one under `package`, one keyed apart; each read's verdict (sql/
 * unit-bound.ts readFaults) beside what PostgreSQL's plans compare at each scan of it, under statistics that state the
 * tables as they are, huge, tiny, and huge with their keys' columns at few values.
 *
 * The space is the shapes the walk models: tables, FROM queries pulled up or fenced (DISTINCT, GROUP BY, a bound,
 * OFFSET 0), LATERAL, a function of an ARRAY of a sub-select (unnest), left joins, CTEs materialized, read in place or stated NOT MATERIALIZED, set operations, and
 * WHERE conjuncts that equate a column to a parameter, a literal, another column of the level or of an outer row, a
 * member of a parameter array or of an ARRAY of a sub-select, of no outer row or correlated, or test an EXISTS, NOT
 * EXISTS or IN.
 */
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Gen } from "@bjornpagen/testing/gen"
import { int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Result, String as Str } from "effect"
import { type EstimatedNode, parsePlanTree } from "#bench/harness/explain.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { pg } from "#compiler/public/fields.ts"
import { key, on, relation, schema, unit } from "#compiler/public/schema.ts"
import {
	type Cte,
	type Expr,
	type FromItem,
	type FromSource,
	nameKey,
	type OperandSelect,
	type Select,
	type SelectCore,
	type SetOperand,
	type Target
} from "#compiler/sql/ast.ts"
import {
	arrayOf,
	call,
	col,
	conjunction,
	core,
	cteRefAs,
	derived,
	distinctCore,
	eq,
	exists,
	grouped,
	lit,
	notExists,
	operandSelect,
	param,
	proved,
	table,
	target,
	types
} from "#compiler/sql/build.ts"
import { namedQuery } from "#compiler/sql/naming.ts"
import { identityHooks, transformSelect } from "#compiler/sql/transform.ts"
import type { ReadTable, ReadTables } from "#compiler/sql/unit-bound.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, seededTemplate } from "#test/support/install-migrate.ts"
import { countedAsVacuumed } from "#test/support/substrate/fill.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** The features a drawn statement reaches. */
export type BoundFeature =
	| "a scan the walk binds"
	| "a scan the walk leaves unbound"
	| "a fenced FROM query"
	| "a sub-link"
	| "a left join"
	| "a CTE"
	| "a set operation"
	| "an ARRAY sub-select"
	| "a correlated ARRAY sub-select"
	| "a CTE read twice"
	| "a function of a sub-select"
	| "a restricted read of a MATERIALIZED CTE"

/** One table of the box: its relation, its columns, its declared key and its unit's column, where it sits under a unit. */
interface BoxTable {
	readonly name: string
	readonly columns: NonEmptyReadonlyArray<string>
	readonly key: NonEmptyReadonlyArray<string>
	/** Each candidate key beside its primary one. */
	readonly candidates: ReadonlyArray<NonEmptyReadonlyArray<string>>
	readonly unit: { readonly name: string; readonly column: string } | undefined
	/** Each row's values, by its number g: a column of its key a function of g that keeps the key's rows distinct. */
	readonly rows: string
}

const i = pg.integer

/** The box: two relations under the unit child, one keyed apart by course, one under the unit package. */
const box: NonEmptyReadonlyArray<BoxTable> = [
	{
		name: "ua",
		columns: ["child", "n", "x"],
		key: ["child", "n"],
		candidates: [["n"]],
		unit: { name: "child", column: "child" },
		rows: "g % 997, g, g % 13"
	},
	{
		name: "ub",
		columns: ["child", "n", "m", "y"],
		key: ["child", "n", "m"],
		candidates: [],
		unit: { name: "child", column: "child" },
		rows: "g % 997, g % 5003, g, g % 17"
	},
	{
		name: "kc",
		columns: ["course", "child", "z"],
		key: ["course", "child"],
		candidates: [],
		unit: undefined,
		rows: "g % 50, g % 997, g % 19"
	},
	{
		name: "pp",
		columns: ["package", "path", "w"],
		key: ["package", "path"],
		candidates: [],
		unit: { name: "package", column: "package" },
		rows: "g % 101, g, g % 23"
	}
]

/** The box as a schema of grizzle's, each relation keyed as `box` states it, under its units. */
const ua = relation("ua", { child: i, n: i, x: i }, ["child", "n"])

const Box = schema(
	"UnitBound",
	[
		ua,
		relation("ub", { child: i, n: i, m: i, y: i }, ["child", "n", "m"]),
		relation("kc", { course: i, child: i, z: i }, ["course", "child"]),
		relation("pp", { package: i, path: i, w: i }, ["package", "path"])
	],
	[unit("child", { child: i }), unit("package", { package: i }), key(on(ua, "n"))]
)

/**
 * The box installed, its declared statistics with it, and filled once, committed, its sizes counted (`boxFill`): a case
 * that filled it in its own rolled-back transaction left dead rows behind in the tables and their indexes, whose pages
 * the planner reads, so a later case planned over an index grown past its rows.
 */
export const boxTemplate = seededTemplate({
	declaredIn: import.meta,
	name: "unit-bound box",
	schema: Box,
	options: { ambient: ordinarySession, extensions: [], label: "unit_bound_box", logins: [] },
	seed: (installed) =>
		Effect.gen(function* () {
			const { admin } = yield* Substrate
			for (const s of boxFill(installed)) {
				yield* admin.query(s, [])
			}
		})
})

/** The schema a drawn statement names the box's tables in, before a case names them as installed (installedStatement). */
const drawnSchema = "box"

/** A drawn statement with each box table named as `installed` names it. */
export const installedStatement = (statement: Select, installed: Installed): Select =>
	transformSelect(statement, {
		...identityHooks,
		objectName: (name, space) => {
			if (space !== "relation" || name.schema !== drawnSchema) {
				return name
			}
			const table = installed.names.relation(name.name)
			return { schema: table.schema, name: table.name }
		}
	})

/**
 * The box's tables as the walk reads them (sql/unit-bound.ts ReadTables), each relation under the name `named` gives it
 * and each column under the name `column` gives it.
 */
const tablesNamed = (
	named: (t: BoxTable) => { readonly schema: string; readonly name: string },
	column: (t: BoxTable, c: string) => string
): ReadTables =>
	new Map(
		Arr.map(box, (t) => {
			const at = (c: string): string => column(t, c)
			const facts: ReadTable = {
				relation: t.name,
				keys: [Arr.map(t.key, at), ...Arr.map(t.candidates, (k) => Arr.map(k, at))],
				unit:
					t.unit === undefined
						? { kind: "none" }
						: { kind: "member", name: t.unit.name, columns: [at(t.unit.column)] },
				determined: []
			}
			return [nameKey(named(t)), facts] as const
		})
	)

/** The box's tables as the walk reads them, as `installed` names them. */
export const boxTables = (installed: Installed): ReadTables =>
	tablesNamed(
		(t) => installed.names.relation(t.name),
		(t, c) => installed.names.column(t.name, c)
	)

/** A box table as `installed` names it, quoted. */
const quotedIn = (installed: Installed, t: BoxTable): string => {
	const table = installed.names.relation(t.name)
	return `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
}

/** The statements that count each box table's size as a VACUUM would (fill.ts countedAsVacuumed). */
const boxCounted = (installed: Installed): ReadonlyArray<string> =>
	Arr.map(box, (t) => countedAsVacuumed(quotedIn(installed, t)))

/** The statements that fill the box, twenty thousand rows a table, each counted as a VACUUM would (fill.ts). */
const boxFill = (installed: Installed): ReadonlyArray<string> => [
	...Arr.map(
		box,
		(t) =>
			`INSERT INTO ${quotedIn(installed, t)} SELECT ${t.rows} FROM pg_catalog.generate_series(1, 20000) AS g`
	),
	...boxCounted(installed)
]

/**
 * The statistics each statement is planned under, each stated in its transaction over the one before: first the
 * declared ones the installation stated, the box's sizes counted again, since a relation's size is stated in place, never
 * rolled back, so an earlier case's last state stands until it is; then the tables as an ANALYZE counts them; each
 * huge with its columns at few values, where a hash join beats every nested loop; each tiny, where a scan beats every
 * index; huge with each column's every value its own; and last, over those, the nested loop off, so every join a hash
 * or merge join can run runs so and no scan takes a value from its join's other side, which a bounded outer side (a
 * FROM query under a LIMIT) wins for the nested loop under any statistics. A statement is planned, never run, so a join
 * only a nested loop can run, which PostgreSQL still plans so, costs nothing (test/support/oracle/perturb.ts keeps the
 * nested loop on for the statements it runs).
 */
export const statisticsStates = (
	installed: Installed
): ReadonlyArray<{ readonly name: string; readonly statements: ReadonlyArray<string> }> => {
	const named = (t: BoxTable) => installed.names.relation(t.name)
	const stated = (t: BoxTable, pages: number, tuples: number): string =>
		`SELECT pg_catalog.pg_restore_relation_stats('schemaname', ${quoteString(named(t).schema)}, 'relname', ${quoteString(named(t).name)}, 'relpages', ${pages}::integer, 'reltuples', ${tuples}::real, 'relallvisible', 0::integer)`
	const distinct = (t: BoxTable, column: string, n: number): string =>
		`SELECT pg_catalog.pg_restore_attribute_stats('schemaname', ${quoteString(named(t).schema)}, 'relname', ${quoteString(named(t).name)}, 'attname', ${quoteString(installed.names.column(t.name, column))}, 'inherited', false, 'null_frac', 0::real, 'avg_width', 4::integer, 'n_distinct', ${n}::real)`
	return [
		{ name: "declared", statements: boxCounted(installed) },
		{
			name: "as analyzed",
			statements: Arr.map(
				box,
				(t) => `ANALYZE ${quoteIdent(named(t).schema)}.${quoteIdent(named(t).name)}`
			)
		},
		{
			name: "huge, few values",
			statements: Arr.flatMap(box, (t) => [
				stated(t, 1_000_000, 100_000_000),
				...Arr.map(t.columns, (c) => distinct(t, c, 5))
			])
		},
		{
			name: "tiny",
			statements: Arr.flatMap(box, (t) => [
				stated(t, 1, 1),
				...Arr.map(t.columns, (c) => distinct(t, c, -1))
			])
		},
		{
			name: "huge, every value its own",
			statements: Arr.flatMap(box, (t) => [
				stated(t, 1_000_000, 100_000_000),
				...Arr.map(t.columns, (c) => distinct(t, c, -1))
			])
		},
		{ name: "no nested loop", statements: ["SET LOCAL enable_nestloop = off"] }
	]
}

/** A drawn statement: its AST, each scan of a unit's table in it by its alias, and the features it reached. */
export interface Drawn {
	readonly statement: Select
	readonly scans: ReadonlyArray<{ readonly alias: string; readonly table: BoxTable }>
	readonly features: ReadonlySet<BoundFeature>
}

/** A column a condition may read: an alias's, and whether it is a unit's column. */
interface Visible {
	readonly alias: string
	readonly column: string
	readonly unit: boolean
}

/** The parameters a statement reads: three integers and an integer array. */
const params = 3

/**
 * The statement `sql` prepared as `name`, each parameter a drawn statement may read typed (`params`): a statement of
 * parameters is planned generically only through a prepared statement here, since a test connection sends every
 * statement on the extended protocol, whose Bind of EXPLAIN (GENERIC_PLAN) supplies none of the parameters its Parse
 * found.
 */
export const preparedAs = (name: string, sql: string): string =>
	`PREPARE ${name}(${Arr.join([...Array.from({ length: params }, () => "integer"), "integer[]"], ", ")}) AS ${sql}`

/** The plan of the prepared statement `name` (preparedAs), every parameter NULL, which a generic plan never reads. */
export const explainedPlan = (name: string): string =>
	`EXPLAIN (VERBOSE, FORMAT JSON) EXECUTE ${name}(${Arr.join(
		Array.from({ length: params + 1 }, () => "NULL"),
		", "
	)})`

/**
 * A drawn statement over the box (the module header): a query of depth at most three, with a CTE or none, its targets
 * the box's integers.
 */
export const drawnGen: Gen<Drawn> = (source) => {
	let next = 1
	const fresh = (): string => `r${next++}`
	const freshColumn = (): string => `c${next++}`
	const scans: Array<{ readonly alias: string; readonly table: BoxTable }> = []
	const features = new Set<BoundFeature>()
	/** How often the statement reads each CTE, by its name: one read more than once PostgreSQL computes once, whole. */
	const cteReads = new Map<string, number>()
	/** The targets that deliver a unit's column of the rows they read. */
	const unitTargets = new WeakSet<Expr>()
	/**
	 * The CTEs stated MATERIALIZED, by name, each with the columns its body delivers a unit's column at; and each read of
	 * one, by its alias, with the CTE it reads.
	 */
	const materializedCtes = new Map<string, ReadonlySet<string>>()
	const materializedReads = new Map<string, string>()
	const pick = (n: number): number => int(0, n - 1)(source)
	const chance = (outOf: number): boolean => pick(outOf) === 0

	/** A column among `visible`, a unit's three times as often as any other. */
	const columnOf = (visible: ReadonlyArray<Visible>): Visible | undefined => {
		const weighted = Arr.flatMap(visible, (v) => (v.unit ? [v, v, v] : [v]))
		return weighted.length === 0 ? undefined : weighted[pick(weighted.length)]
	}
	const value = (): Expr =>
		chance(4) ? lit.int(pick(7), types.integer) : param(1 + pick(params), types.integer)

	/** A query and its output columns, at `depth`, `width` of them where given, conditions free to read `outer` too. */
	const query = (
		depth: number,
		outer: ReadonlyArray<Visible>,
		ctes: ReadonlyArray<{ readonly name: string; readonly columns: ReadonlyArray<string> }>,
		width: number | undefined
	): { readonly query: OperandSelect; readonly columns: ReadonlyArray<string> } => {
		if (depth > 0 && chance(6)) {
			features.add("a set operation")
			const columnCount = width ?? 1 + pick(2)
			const arm = (): SelectCore => {
				const q = coreOf(depth - 1, outer, ctes, columnCount)
				return q.core
			}
			const op = (["UNION ALL", "UNION", "INTERSECT", "EXCEPT"] as const)[pick(4)] ?? "UNION ALL"
			const arms: readonly [SetOperand, SetOperand] = [arm(), arm()]
			const body =
				op === "UNION ALL"
					? { kind: "setOp" as const, op, rows: "operand" as const, arms }
					: { kind: "setOp" as const, op, arms }
			return {
				query: operandSelect(body),
				columns: Array.from({ length: columnCount }, (_, i) => `c${i}`)
			}
		}
		const { core: c, columns } = coreOf(depth, outer, ctes, width)
		const q = operandSelect(c)
		switch (pick(5)) {
			case 0:
				return { query: { ...q, orderBy: [], limit: lit.int(5, types.bigint) }, columns }
			case 1:
				return { query: { ...q, offset: lit.int(0, types.bigint) }, columns }
			default:
				return { query: q, columns }
		}
	}

	/** A core and its output columns, `width` of them where given. */
	const coreOf = (
		depth: number,
		outer: ReadonlyArray<Visible>,
		ctes: ReadonlyArray<{ readonly name: string; readonly columns: ReadonlyArray<string> }>,
		width: number | undefined
	): { readonly core: SelectCore; readonly columns: ReadonlyArray<string> } => {
		const visible: Array<Visible> = []
		const from: Array<FromItem> = []
		const where: Array<Expr> = []
		const items = 1 + pick(depth > 0 ? 3 : 2)
		/** The columns of the FROM item before, the one a left join's condition may read beside its own. */
		let before: ReadonlyArray<Visible> = []
		for (let i = 0; i < items; i += 1) {
			const { source: s, columns } = sourceOf(depth, [...outer, ...visible], ctes)
			const last = from[from.length - 1]
			if (last !== undefined && last.kind !== "joins" && chance(4)) {
				const left = columnOf(before)
				const right = columns[pick(columns.length)]
				if (left !== undefined && right !== undefined) {
					features.add("a left join")
					from[from.length - 1] = {
						kind: "joins",
						first: last,
						steps: [
							{
								kind: "left",
								source: s,
								on: eq(col(right.alias, right.column), col(left.alias, left.column))
							}
						]
					}
					Arr.forEach(columns, (v) => visible.push(v))
					continue
				}
			}
			from.push(s)
			Arr.forEach(columns, (v) => visible.push(v))
			before = columns
		}
		const conditions = pick(4)
		for (let i = 0; i < conditions; i += 1) {
			const c = conditionOf(depth, visible, outer, ctes)
			if (c !== undefined) {
				where.push(c)
			}
		}
		const count = width ?? 1 + pick(3)
		const targets: Array<Target> = []
		for (let i = 0; i < count; i += 1) {
			const v = columnOf(visible)
			const e = v === undefined ? lit.int(0, types.integer) : col(v.alias, v.column)
			if (v?.unit === true) {
				unitTargets.add(e)
			}
			targets.push(target(e))
		}
		const [first, ...rest] = targets
		const condition = conjunction(where)
		const plain = core(targets, from, condition)
		const columns = Arr.map(targets, (_, i) => `c${i}`)
		if (first === undefined) {
			return { core: proved("certified", plain), columns }
		}
		switch (pick(4)) {
			case 0:
				features.add("a fenced FROM query")
				return { core: distinctCore([first, ...rest], from, condition), columns }
			case 1:
				features.add("a fenced FROM query")
				return {
					core: grouped(
						plain,
						Arr.map(targets, (t) => t.expr)
					),
					columns
				}
			default:
				return { core: proved("certified", plain), columns }
		}
	}

	/** A FROM source and the columns it delivers. */
	const sourceOf = (
		depth: number,
		lateralVisible: ReadonlyArray<Visible>,
		ctes: ReadonlyArray<{ readonly name: string; readonly columns: ReadonlyArray<string> }>
	): { readonly source: FromSource; readonly columns: ReadonlyArray<Visible> } => {
		const alias = fresh()
		const kinds = depth > 0 ? (ctes.length > 0 ? 5 : 4) : 1
		const kind = pick(kinds)
		if (depth > 0 && kind === kinds - 1) {
			features.add("a function of a sub-select")
			const column = freshColumn()
			return {
				source: {
					kind: "function",
					call: call("unnest", [
						{ kind: "array", query: selectOf(coreOf(depth - 1, [], ctes, 1).core) }
					]),
					alias,
					columns: { kind: "named", names: [column], ordinality: false },
					lateral: false
				},
				columns: [{ alias, column, unit: true }]
			}
		}
		if (kind === 0) {
			const t = box[pick(box.length)] ?? box[0]
			scans.push({ alias, table: t })
			return {
				source: table(drawnSchema, t.name, alias),
				columns: Arr.map(t.columns, (c) => ({ alias, column: c, unit: t.unit?.column === c }))
			}
		}
		if (kind === 3) {
			features.add("a CTE")
			const c = ctes[pick(ctes.length)] ?? ctes[0]
			if (c !== undefined) {
				const reads = (cteReads.get(c.name) ?? 0) + 1
				cteReads.set(c.name, reads)
				if (materializedCtes.has(c.name)) {
					materializedReads.set(alias, c.name)
				}
				if (reads > 1) {
					features.add("a CTE read twice")
				}
				return {
					source: cteRefAs(c.name, alias),
					columns: Arr.map(c.columns, (column) => ({ alias, column, unit: true }))
				}
			}
		}
		const lateral = kind === 2
		const inner = query(depth - 1, lateral ? lateralVisible : [], ctes, undefined)
		const names = Arr.map(inner.columns, () => freshColumn())
		return {
			source: derived(namedQuery(inner.query, names), alias, lateral),
			columns: Arr.map(names, (column) => ({ alias, column, unit: true }))
		}
	}

	/** A WHERE conjunct over `visible` and `outer`. */
	const conditionOf = (
		depth: number,
		visible: ReadonlyArray<Visible>,
		outer: ReadonlyArray<Visible>,
		ctes: ReadonlyArray<{ readonly name: string; readonly columns: ReadonlyArray<string> }>
	): Expr | undefined => {
		const v = columnOf(visible)
		if (v === undefined) {
			return undefined
		}
		const here = col(v.alias, v.column)
		switch (pick(depth > 0 ? 9 : 4)) {
			case 0:
			case 1:
				if (materializedCtes.get(materializedReads.get(v.alias) ?? "")?.has(v.column) === true) {
					features.add("a restricted read of a MATERIALIZED CTE")
				}
				return eq(here, value())
			case 2: {
				const w = columnOf(Arr.filter([...visible, ...outer], (x) => x !== v))
				return w === undefined ? eq(here, value()) : eq(here, col(w.alias, w.column))
			}
			case 3:
				return {
					kind: "equalsAny",
					expr: here,
					array: param(params + 1, arrayOf(types.integer) ?? types.integer),
					schema: undefined
				}
			case 4:
			case 5: {
				features.add("a sub-link")
				const inner = coreOf(depth - 1, [...outer, ...visible], ctes, 1)
				const [t] = inner.core.targets
				const correlated = and2(inner.core.where, eq(t.expr, here))
				const q = operandSelect({ ...inner.core, where: correlated })
				return pick(2) === 0 ? exists(q) : notExists(q)
			}
			case 6:
				features.add("an ARRAY sub-select")
				return {
					kind: "equalsAny",
					expr: here,
					array: { kind: "array", query: selectOf(coreOf(depth - 1, [], ctes, 1).core) },
					schema: undefined
				}
			case 7: {
				features.add("a sub-link")
				const inner = query(depth - 1, [], ctes, 1)
				return { kind: "inQuery", expr: here, query: inner.query, not: false }
			}
			default:
				features.add("a correlated ARRAY sub-select")
				return {
					kind: "equalsAny",
					expr: here,
					array: {
						kind: "array",
						query: selectOf(coreOf(depth - 1, [...outer, ...visible], ctes, 1).core)
					},
					schema: undefined
				}
		}
	}

	const ctes: Array<Cte> = []
	const named: Array<{ readonly name: string; readonly columns: ReadonlyArray<string> }> = []
	if (chance(3)) {
		const body = query(1, [], [], undefined)
		const name = fresh()
		const columns = Arr.map(body.columns, () => freshColumn())
		const materialized = (["MATERIALIZED", "NOT MATERIALIZED", undefined] as const)[pick(3)]
		ctes.push({ name, materialized, query: namedQuery(body.query, columns) })
		if (materialized === "MATERIALIZED") {
			const delivered = targetsOf(body.query)
			materializedCtes.set(
				name,
				new Set(
					Arr.filter(columns, (_, i) => {
						const t = delivered[i]
						return t !== undefined && unitTargets.has(t.expr)
					})
				)
			)
		}
		named.push({ name, columns })
	}
	const statement: Select = {
		...selectOf(coreOf(3, [], named, undefined).core),
		with: isNonEmpty(ctes) ? { recursive: false, ctes } : undefined
	}
	return { statement, scans, features }
}

/** A core as a query of its own, its rows a set: a plain core's certified as the box's keys make them. */
const selectOf = (body: SelectCore): Select => ({
	kind: "select",
	with: undefined,
	body: body.distinct === false && body.rows === "operand" ? proved("certified", body) : body,
	orderBy: [],
	limit: undefined,
	offset: undefined
})

/** The targets of a query's first core, the columns its set operation's arms deliver by position. */
const targetsOf = (q: OperandSelect): ReadonlyArray<Target> =>
	q.body.kind === "core"
		? q.body.targets
		: q.body.kind === "select"
			? targetsOf(q.body)
			: q.body.arms[0].kind === "core"
				? q.body.arms[0].targets
				: targetsOf(q.body.arms[0])

/** Two conditions as one, the first none where undefined. */
const and2 = (a: Expr | undefined, b: Expr): Expr =>
	a === undefined ? b : { kind: "and", args: [a, b] }

/** The sub-link kinds whose sub-plan PostgreSQL costs at a fraction of its rows, as its sub-plans' names spell them. */
const fractionedSublinks: ReadonlySet<string> = new Set(["exists", "any", "all"])

/**
 * Each scan node of a plan with its alias, its node type, the conditions it compares at the scan (its own and its
 * bitmap's), those of them an index reads (its index condition and its bitmap's), and whether PostgreSQL costs it at a
 * fraction of its rows (`fractioned`), under a Limit of its own plan or in an EXISTS's, an ANY's or an ALL's sub-plan,
 * where a filtered scan may win; the aliases its own plan reads under, the rows a join of it may compare it to
 * (`local`); and whether its plan is an EXISTS's SubPlan, which PostgreSQL may run hashed instead, once over every row
 * (`hashable`), so an outer row's value fixes it only by a choice of cost.
 */
export const scansOf = (
	plan: unknown
): ReadonlyArray<{
	readonly alias: string
	readonly conditions: ReadonlyArray<string>
	readonly indexed: ReadonlyArray<string>
	readonly fractioned: boolean
	readonly node: string
	readonly local: ReadonlySet<string>
	readonly hashable: boolean
}> => {
	const tree = parsePlanTree(plan)
	if (Result.isFailure(tree)) {
		return []
	}
	const bitmaps = (n: EstimatedNode): ReadonlyArray<EstimatedNode> =>
		Arr.flatMap(n.children, (c) =>
			Str.startsWith("Bitmap")(c.nodeType) && Option.isNone(c.relation) ? [c, ...bitmaps(c)] : []
		)
	const indexed = (n: EstimatedNode): ReadonlyArray<string> => [
		...Option.toArray(n.indexCond),
		...Arr.flatMap(bitmaps(n), (b) => Option.toArray(b.indexCond))
	]
	/**
	 * Whether `c`'s tree is costed at a fraction of its rows, given whether its holder's is: a Limit's; a semi- or an
	 * anti-join's inner side, read for its first match of each outer row; or a SubPlan's or an InitPlan's of an EXISTS, ANY
	 * or ALL sub-link, which PostgreSQL plans for its first row or half its rows (subselect.c make_subplan's
	 * tuple_fraction), any other's planned whole whatever its holder's is.
	 */
	const fractioned = (
		c: EstimatedNode,
		holder: boolean,
		parent: EstimatedNode | undefined
	): boolean =>
		c.nodeType === "Limit" ||
		(parent !== undefined &&
			Option.match(parent.joinType, {
				onNone: () => false,
				onSome: (j) => j === "Semi" || j === "Anti"
			}) &&
			Option.match(c.parentRelationship, { onNone: () => false, onSome: (r) => r === "Inner" })) ||
		Option.match(c.parentRelationship, {
			onNone: () => holder,
			onSome: (r) =>
				r === "InitPlan" || r === "SubPlan"
					? Option.match(c.subplanName, {
							onNone: () => false,
							onSome: (name) =>
								fractionedSublinks.has(
									Arr.headNonEmpty(Str.split(Arr.lastNonEmpty(Str.split(name, " ")), "_"))
								)
						})
					: holder
		})
	/** Whether `c` is the root of a plan of its own: a SubPlan's or an InitPlan's. */
	const apart = (c: EstimatedNode): boolean =>
		Option.match(c.parentRelationship, {
			onNone: () => false,
			onSome: (r) => r === "InitPlan" || r === "SubPlan"
		})
	/** The aliases `n`'s plan reads under, a SubPlan's and an InitPlan's tree a plan of its own. */
	const aliasesOf = (n: EstimatedNode): ReadonlyArray<string> => [
		...Option.toArray(n.alias),
		...Arr.flatMap(n.children, (c) => (apart(c) ? [] : aliasesOf(c)))
	]
	/** Whether `c` roots an EXISTS's SubPlan, which PostgreSQL may run hashed instead (convert_EXISTS_to_ANY). */
	const existsPlan = (c: EstimatedNode): boolean =>
		Option.match(c.parentRelationship, {
			onNone: () => false,
			onSome: (r) =>
				r === "SubPlan" &&
				Option.match(c.subplanName, {
					onNone: () => false,
					onSome: (name) =>
						Arr.headNonEmpty(Str.split(Arr.lastNonEmpty(Str.split(name, " ")), "_")) === "exists"
				})
		})
	const walk = (
		n: EstimatedNode,
		holder: boolean,
		local: ReadonlySet<string>,
		hashable: boolean
	): ReadonlyArray<{
		readonly alias: string
		readonly conditions: ReadonlyArray<string>
		readonly indexed: ReadonlyArray<string>
		readonly fractioned: boolean
		readonly node: string
		readonly local: ReadonlySet<string>
		readonly hashable: boolean
	}> => {
		const children = Arr.flatMap(n.children, (c) =>
			walk(
				c,
				fractioned(c, holder, n),
				apart(c) ? new Set(aliasesOf(c)) : local,
				apart(c) ? existsPlan(c) : hashable
			)
		)
		return Option.isSome(n.relation) && Option.isSome(n.alias)
			? [
					{
						alias: n.alias.value,
						conditions: [
							...indexed(n),
							...Option.toArray(n.recheckCond),
							...Option.toArray(n.filter)
						],
						indexed: indexed(n),
						fractioned: holder,
						node: n.nodeType,
						local,
						hashable
					},
					...children
				]
			: children
	}
	return walk(
		tree.success,
		fractioned(tree.success, false, undefined),
		new Set(aliasesOf(tree.success)),
		false
	)
}

/**
 * Whether a scan's conditions bind its unit (sql/unit-bound.ts): the unit's column compared at the scan, or every
 * column of one of its table's declared keys, which reads one row, of one unit, each to a side `beside` does not refuse.
 */
export const unitBoundAt = (
	conditions: ReadonlyArray<string>,
	alias: string,
	table: BoxTable,
	column: (c: string) => string,
	beside: (side: string) => boolean
): boolean =>
	table.unit !== undefined &&
	(compared(conditions, alias, column(table.unit.column), beside) ||
		Arr.some([table.key, ...table.candidates], (k) =>
			Arr.every(k, (c) => compared(conditions, alias, column(c), beside))
		))

/** The box's tables as the walk reads them where a statement names them as drawn, no installation's names. */
export const drawnTables: ReadTables = tablesNamed(
	(t) => ({ schema: drawnSchema, name: t.name }),
	(_, c) => c
)

/** A drawn statement's FROM source over the box table `name` as drawn, under `alias`. */
export const drawnTable = (name: string, alias: string): FromSource =>
	table(drawnSchema, name, alias)

/** The top-level conjuncts of a condition PostgreSQL prints, each without its parentheses. */
const conjunctsOf = (text: string): ReadonlyArray<string> => {
	const out: Array<string> = []
	let depth = 0
	let start = 0
	const inner = Str.startsWith("((")(text) ? Str.slice(1, Str.length(text) - 1)(text) : text
	for (let i = 0; i < Str.length(inner); i += 1) {
		const ch = inner[i]
		if (ch === "(") {
			depth += 1
		} else if (ch === ")") {
			depth -= 1
		} else if (depth === 0 && Str.startsWith(" AND ", i)(inner)) {
			out.push(Str.slice(start, i)(inner))
			start = i + 5
		}
	}
	out.push(Str.slice(start)(inner))
	return Arr.map(out, (c) => (Str.startsWith("(")(c) ? Str.slice(1, Str.length(c) - 1)(c) : c))
}

/**
 * Whether a scan's conditions compare `alias.column` to a value fixed for the scan: a top-level conjunct that is an
 * equality, or a membership of an array, whose other side is no column of the scan itself, no SubPlan's output, which
 * PostgreSQL computes again for each row it reads (an InitPlan's it computes once), nor one `beside` refuses.
 */
const compared = (
	conditions: ReadonlyArray<string>,
	alias: string,
	column: string,
	beside: (side: string) => boolean
): boolean => {
	const me = `${alias}.${column}`
	const own = (side: string): boolean =>
		Str.startsWith(`${alias}.`)(side) || Str.includes("SubPlan ")(side) || beside(side)
	return Arr.some(Arr.flatMap(conditions, conjunctsOf), (c) => {
		const [left, right, ...more] = Str.split(" = ")(c)
		return (
			right !== undefined &&
			more.length === 0 &&
			((left === me && !own(right)) || (right === me && !own(left)))
		)
	})
}
