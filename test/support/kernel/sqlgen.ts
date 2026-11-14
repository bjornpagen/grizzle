import { array, boolean, element, type Gen, int, map, span } from "@bjornpagen/testing/gen"
import { forcedChooser, generate, recorder, type Source } from "@bjornpagen/testing/source"
import {
	keep,
	type Presence,
	type Swarm,
	swarm,
	swarmChoice,
	weightOf
} from "@bjornpagen/testing/swarm"
import { Array as Arr } from "effect"
import { exactParts } from "#compiler/core/decimal.ts"
import type {
	Assignment,
	ConflictAction,
	CountStar,
	Cte,
	Delete,
	Expr,
	FrameBound,
	FromItem,
	FromSource,
	Insert,
	InsertTarget,
	Merge,
	MergeWhen,
	OperandSelect,
	OrderItem,
	Select,
	SelectBody,
	SelectCore,
	SetArm,
	SetCore,
	SqlStatement,
	Target,
	TypeRef,
	Update,
	ValuePlaceholder,
	WindowSpec,
	With
} from "#compiler/sql/ast.ts"

import {
	arrays,
	asc,
	baseCheck,
	binary,
	call,
	cast,
	col,
	columnDefinition,
	conjunction,
	countStar,
	cteRefAs,
	cUtf8Collation,
	derived,
	desc,
	distinctCore,
	distinctOnCore,
	exists,
	join,
	lit,
	param,
	positionalValue,
	provedCore,
	select,
	table,
	tableCol,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"

import {
	identityHooks,
	inertVisitor,
	transformStatement,
	visitSelect
} from "#compiler/sql/transform.ts"

/**
 * The variants of the nodes of each kind a walk replaces: every node of a kind is a site, and each of its variants a
 * rewrite. Every kind is stated: noHoles states none of them, and a walk spreads it with the kinds it replaces.
 */
export interface Holes {
	/** The root statement itself: one site, before every other. */
	readonly statement: (s: SqlStatement) => ReadonlyArray<SqlStatement>
	readonly expr: (e: Expr) => ReadonlyArray<Expr>
	readonly fromSource: (item: FromSource) => ReadonlyArray<FromSource>
	readonly core: (c: SelectCore) => ReadonlyArray<SelectCore>
	readonly select: (s: OperandSelect) => ReadonlyArray<OperandSelect>
}

/** No variant at any site. */
export const noHoles: Holes = {
	statement: () => [],
	expr: () => [],
	fromSource: () => [],
	core: () => [],
	select: () => []
}

type HoleKind = keyof Holes

/** One rewrite: the site's kind and number in the traversal's order, and the rewritten statement. */
export interface Rewrite {
	readonly kind: HoleKind
	readonly site: number
	readonly statement: SqlStatement
}

/** The variants of every site of a statement, by kind, in the order the traversal meets the sites. */
interface Sites {
	readonly expr: Array<ReadonlyArray<Expr>>
	readonly fromSource: Array<ReadonlyArray<FromSource>>
	readonly core: Array<ReadonlyArray<SelectCore>>
	readonly select: Array<ReadonlyArray<OperandSelect>>
}

const sitesOf = (statement: SqlStatement, holes: Holes): Sites => {
	const sites: Sites = { expr: [], fromSource: [], core: [], select: [] }
	transformStatement(statement, {
		...identityHooks,
		expr: (e) => {
			sites.expr.push(holes.expr(e))
			return e
		},
		fromSource: (item) => {
			sites.fromSource.push(holes.fromSource(item))
			return item
		},
		core: (c) => {
			sites.core.push(holes.core(c))
			return c
		},
		select: (s) => {
			sites.select.push(holes.select(s))
			return s
		}
	})
	return sites
}

/** The statement with the `site`-th node of one kind replaced, every other node kept. */
const replaced = <N>(
	statement: SqlStatement,
	site: number,
	replacement: N,
	hook: (replace: (node: N) => N) => Parameters<typeof transformStatement>[1]
): SqlStatement => {
	let met = 0
	return transformStatement(
		statement,
		hook((node) => (met++ === site ? replacement : node))
	)
}

/**
 * Every statement that differs from `statement` at exactly one site.
 *
 * `oneHole` gives every statement that differs from a statement at exactly one site: one node of a kind the holes
 * name, replaced by one of its variants, everything else shared by reference. It is sql/transform.ts's own
 * traversal: a first pass, every hook returning its node, numbers the sites of each kind in the order the traversal
 * meets them and asks for their variants; a pass per variant then replaces only its site. So the walker reaches
 * every node the compiler's own passes reach, and a new node kind is reached as soon as the traversal reaches it.
 * The root statement is one site more, of kind `statement`, its rewrites listed first: it reaches what the
 * traversal's hooks do not, a DDL statement's columns and constraints, a write's target, SET and RETURNING, and the
 * data-modifying CTEs of the statement's own WITH, the only WITH that may hold one.
 */
export const oneHole = (statement: SqlStatement, holes: Holes): ReadonlyArray<Rewrite> => {
	const sites = sitesOf(statement, holes)
	const rewrites: Array<Rewrite> = Arr.map(holes.statement(statement), (variant) => ({
		kind: "statement",
		site: 0,
		statement: variant
	}))
	for (const [site, variants] of sites.expr.entries()) {
		for (const v of variants) {
			rewrites.push({
				kind: "expr",
				site,
				statement: replaced(statement, site, v, (r) => ({ ...identityHooks, expr: r }))
			})
		}
	}
	for (const [site, variants] of sites.fromSource.entries()) {
		for (const v of variants) {
			rewrites.push({
				kind: "fromSource",
				site,
				statement: replaced(statement, site, v, (r) => ({ ...identityHooks, fromSource: r }))
			})
		}
	}
	for (const [site, variants] of sites.core.entries()) {
		for (const v of variants) {
			rewrites.push({
				kind: "core",
				site,
				statement: replaced(statement, site, v, (r) => ({ ...identityHooks, core: r }))
			})
		}
	}
	for (const [site, variants] of sites.select.entries()) {
		for (const v of variants) {
			rewrites.push({
				kind: "select",
				site,
				statement: replaced(statement, site, v, (r) => ({ ...identityHooks, select: r }))
			})
		}
	}
	return rewrites
}

/**
 * One audit rule's breaker: every rewrite its holes make, the audit must refuse under `rule`.
 *
 * A Wild operator is one audit rule's breaker: holes whose every variant the audit must refuse under that rule.
 */
export interface WildOperator {
	readonly rule: string
	readonly holes: Holes
}

/** The rewrites of a Wild operator over a statement. */
export const breaks = (statement: SqlStatement, operator: WildOperator): ReadonlyArray<Rewrite> =>
	oneHole(statement, operator.holes)

export type SqlColumnType = "bigint" | "integer" | "text" | "boolean" | "numeric"

export interface SqlColumn {
	readonly name: string
	readonly type: SqlColumnType
}

export interface SqlTable {
	readonly schema: string
	readonly name: string
	readonly columns: Arr.NonEmptyReadonlyArray<SqlColumn>
}

/** The tables a generated query reads. */
export type SqlCatalog = Arr.NonEmptyReadonlyArray<SqlTable>

/** The items as a non-empty list, or undefined when there are none. */
const nonEmpty = <A>(items: ReadonlyArray<A>): Arr.NonEmptyReadonlyArray<A> | undefined => {
	const [first, ...rest] = items
	return first === undefined ? undefined : [first, ...rest]
}

/** The generator's features. A feature that is off leaves its clause out. */
const queryFeatures = [
	"where",
	"param",
	"literal",
	"join",
	"order by",
	"limit",
	"distinct",
	"count",
	"union all"
] as const

type QueryFeature = (typeof queryFeatures)[number]

const typeRefs: { readonly [T in SqlColumnType]: TypeRef } = {
	bigint: types.bigint,
	integer: types.integer,
	text: types.text,
	boolean: types.boolean,
	numeric: types.numeric
}

const comparisons = ["=", "<>", "<", "<=", ">", ">="] as const
const decimals = [
	exactParts(0n, 0),
	exactParts(1n, 0),
	exactParts(-1n, 0),
	exactParts(5n, 1),
	exactParts(12325n, 2),
	exactParts(-7125n, 3)
] as const
const texts = ["", "a", "B", "ab", "a b", "%", "\u00e4"] as const

/**
 * The magnitude bound of an integer literal of each width. Arithmetic nests at most two deep (maxExprDepth), so the
 * largest value literals fold to is a product of products, the bound's fourth power, and PostgreSQL folds constants
 * when it plans: 215^4 < 2^31 keeps an int4 expression in range, and 2^15 (2^60 < 2^63) an int8 one, so no statement
 * raises 22003 (numeric out of range) at plan time.
 */
const integerLiteralBound = { integer: 215, bigint: 0x8000 } as const

/** An integer literal of a width within its bound, shrinking toward zero. */
const integerLiteral = (type: "integer" | "bigint"): Gen<Expr> => {
	const bound = integerLiteralBound[type]
	return map(int(-bound, bound - 1), (value) => lit.int(value, types[type]))
}

/** A literal of each type, one decision apiece. */
const literals: { readonly [T in SqlColumnType]: Gen<Expr> } = {
	bigint: integerLiteral("bigint"),
	integer: integerLiteral("integer"),
	numeric: map(element(decimals), (value) => lit.decimal(value, types.numeric)),
	boolean: map(boolean, (value) => lit.bool(value)),
	text: map(element(texts), (value) => lit.text(value, types.text))
}

/** The state of one query: its swarm, the next relation alias and the parameters numbered so far. */
class Query {
	readonly swarm: Swarm<QueryFeature>
	readonly #params: Array<SqlColumnType> = []
	#relations = 0

	constructor(drawn: Swarm<QueryFeature>) {
		this.swarm = drawn
	}

	on(feature: QueryFeature): boolean {
		return weightOf(this.swarm, feature) > 0
	}

	relation(): string {
		this.#relations++
		return `r${this.#relations}`
	}

	param(type: SqlColumnType): Expr {
		this.#params.push(type)
		return param(this.#params.length, typeRefs[type])
	}
}

/** A scanned relation: its alias and table. */
interface Scanned {
	readonly alias: string
	readonly table: SqlTable
}

interface Typed {
	readonly expr: Expr
	readonly type: SqlColumnType
}

/** A column of one of the scans: the scan, then one of its columns. */
const columnOf =
	(scans: Arr.NonEmptyReadonlyArray<Scanned>): Gen<Typed> =>
	(source) => {
		const scanned = source.draw(element(scans))
		const c = source.draw(element(scanned.table.columns))
		return { expr: col(scanned.alias, c.name), type: c.type }
	}

/** A column of the given type among the scans, or a literal of it when no scanned column has the type. */
const ofType = (scans: Arr.NonEmptyReadonlyArray<Scanned>, type: SqlColumnType): Gen<Expr> => {
	const columns = nonEmpty(
		Arr.flatMap(scans, (s) =>
			Arr.map(
				Arr.filter(s.table.columns, (c) => c.type === type),
				(c) => col(s.alias, c.name)
			)
		)
	)
	return columns === undefined ? literals[type] : element(columns)
}

/** A comparison of a scanned column with a literal or, when the swarm turns parameters on, a parameter. */
const predicate =
	(q: Query, scans: Arr.NonEmptyReadonlyArray<Scanned>): Gen<Expr> =>
	(source) => {
		const left = source.draw(columnOf(scans))
		const op = left.type === "boolean" ? "=" : source.draw(element(comparisons))
		const operand =
			source.draw(swarmChoice(q.swarm, ["literal", "param"])) === "param"
				? q.param(left.type)
				: source.draw(literals[left.type])
		return binary(op, left.expr, operand)
	}

interface Arm {
	readonly core: SetCore
	/** The type of each target, which a union's other arm must match. */
	readonly types: ReadonlyArray<SqlColumnType>
}

/**
 * One arm: FROM its table, inner-joined to another when the swarm turns joins on, its targets c1, c2, ... (one to four
 * columns, or the types a union's first arm fixed) and up to three predicates.
 */
const queryArm = (
	q: Query,
	catalog: SqlCatalog,
	matching: ReadonlyArray<SqlColumnType> | undefined
): Gen<Arm> =>
	span("arm", (source) => {
		const first: Scanned = { alias: q.relation(), table: source.draw(element(catalog)) }
		const second: Scanned | undefined = q.on("join")
			? { alias: q.relation(), table: source.draw(element(catalog)) }
			: undefined
		const scans: Arr.NonEmptyReadonlyArray<Scanned> =
			second === undefined ? [first] : [first, second]
		const firstFrom = table(first.table.schema, first.table.name, first.alias)
		const from: FromItem =
			second === undefined
				? firstFrom
				: join(
						firstFrom,
						table(second.table.schema, second.table.name, second.alias),
						lit.bool(true)
					)
		const counted = q.on("count")
		const typed: ReadonlyArray<Typed> =
			matching !== undefined
				? Arr.map(matching, (type) => ({ expr: source.draw(ofType(scans, type)), type }))
				: counted
					? [{ expr: countStar(), type: "bigint" }]
					: source.draw(array(columnOf(scans), { min: 1, max: 4 }))
		const predicates = q.on("where")
			? source.draw(array(predicate(q, scans), { min: 0, max: 3 }))
			: []
		const targets = Arr.map(typed, (t, i) => targetAs(t.expr, `c${i + 1}`))
		const where = conjunction(predicates)
		return {
			core: Arr.isReadonlyArrayNonEmpty(targets)
				? q.on("distinct")
					? distinctCore(targets, [from], where)
					: provedCore("certified", targets, [from], where)
				: provedCore("certified", targets, [from], where),
			types: Arr.map(typed, (t) => t.type)
		}
	})

/**
 * Queries over a catalog, valid by construction.
 *
 * SQL generation over the typed AST, and the one-hole walker.
 * SQL a test generates is built as the compiler builds it, as a typed AST (sql/ast.ts), never as text.
 *
 * `selectGen` draws queries over a small catalog that pass every rule of the statement audit
 * (test/support/oracle/verify/sql.ts) by construction: relation aliases r1, r2, ... each defined once per statement,
 * column aliases c1, c2, ... distinct per list, every column reference qualified by a visible relation, parameters
 * numbered contiguously from 1 with one type per index, every literal typed, no NULL-yielding form. A query is a swarm
 * and the decisions drawn under it, each bounded by what the query drawn so far allows, so any tape draws a valid
 * query, every part shrinks at once and the shrunk query is still valid. ORDER BY names target expressions only, so it
 * is valid under DISTINCT, and never follows a count, whose query has no columns to order by. PostgreSQL is the second
 * oracle of what it draws: the audit accepting a query PostgreSQL refuses, or the other way round, is a bug in one of
 * them.
 */
export const selectGen =
	(catalog: SqlCatalog): Gen<Select> =>
	(source) => {
		const q = new Query(source.draw(swarm(queryFeatures)))
		const left = source.draw(queryArm(q, catalog, undefined))
		const union = q.on("union all")
		const body: SelectBody = union
			? {
					kind: "setOp",
					op: "UNION ALL",
					rows: "certified",
					arms: [left.core, source.draw(queryArm(q, catalog, left.types)).core]
				}
			: left.core
		const targets = nonEmpty(left.core.targets)
		const order: ReadonlyArray<OrderItem> =
			union || q.on("count") || !q.on("order by") || targets === undefined
				? []
				: source.draw(
						array(
							(item) => {
								const t = item.draw(element(targets)).expr
								return item.draw(boolean) ? desc(t) : asc(t)
							},
							{ min: 0, max: 2 }
						)
					)
		return {
			...select(body),
			orderBy: order,
			limit: q.on("limit") ? q.param("bigint") : undefined
		}
	}

/** The features statementGen draws. A feature that is off leaves its form out of the whole statement. */
const statementFeatures = [
	"insert",
	"update",
	"delete",
	"merge",
	"data-modifying cte",
	"returning",
	"on conflict",
	"insert query",
	"update from",
	"delete using",
	"join",
	"cross join",
	"lateral",
	"derived",
	"values",
	"arrays",
	"cte",
	"materialized",
	"recursive",
	"where",
	"group by",
	"having",
	"aggregate",
	"aggregate order by",
	"count filter",
	"within group",
	"window",
	"frame",
	"distinct",
	"distinct on",
	"order by",
	"limit",
	"offset",
	"set operation",
	"parenthesized arm",
	"public names",
	"literal",
	"param",
	"param reuse",
	"connectives",
	"exists",
	"in query",
	"scalar subquery",
	"in list",
	"between",
	"case",
	"arithmetic",
	"concat",
	"cast",
	"collate",
	"greatest",
	"coalesce",
	"zero width"
] as const

export type StatementFeature = (typeof statementFeatures)[number]

/** How deep queries nest in queries, and expressions in expressions. */
const maxQueryDepth = 2
const maxExprDepth = 2

/**
 * Text literals a printed statement must carry through the text audit unharmed: keywords, quotes, comment and dollar
 * markers inside a string are no SQL.
 */
const statementTexts = [
	"",
	"a",
	"B",
	"NULL",
	"IS NULL",
	"COALESCE(",
	"LEFT JOIN",
	"SELECT *",
	"it's",
	"$$",
	"$1",
	"-- x",
	"/* x",
	"\\",
	"ä",
	"\u{1f600}"
] as const

/** Output names the statement's own output may carry in place of c<n>: the quoting keeps each one a name. */
const publicNames = [
	"id",
	"Total",
	"select",
	"null",
	"is null",
	'say "hi"',
	"c 1",
	"üml",
	"order"
] as const

const orderableTypes: Arr.NonEmptyReadonlyArray<SqlColumnType> = [
	"bigint",
	"integer",
	"text",
	"numeric"
]

const statementTypes: Arr.NonEmptyReadonlyArray<SqlColumnType> = [
	"bigint",
	"integer",
	"text",
	"boolean",
	"numeric"
]
const setOperators = ["UNION", "UNION ALL", "INTERSECT", "EXCEPT"] as const
const mergeMatches = ["MATCHED", "NOT MATCHED", "NOT MATCHED BY SOURCE"] as const

/** A relation a column reference may name: its alias and its typed columns. */
interface Rel {
	readonly alias: string
	readonly columns: ReadonlyArray<SqlColumn>
}

/** A CTE a FROM item may read. */
interface CteDef {
	readonly name: string
	readonly columns: ReadonlyArray<SqlColumn>
}

/**
 * Where an expression or a query is drawn: the relations it may name (its own, then the enclosing queries' for
 * correlation), the CTEs in scope and how deep it already is.
 */
interface Env {
	readonly visible: ReadonlyArray<Rel>
	readonly ctes: ReadonlyArray<CteDef>
	readonly depth: number
}

const generatedColumns = (outputs: ReadonlyArray<SqlColumnType>): ReadonlyArray<SqlColumn> =>
	Arr.map(outputs, (type, i) => ({ name: `c${i + 1}`, type }))

/** A literal of each type a statement draws: its text literals are the ones a printed statement must carry unharmed. */
const statementLiterals: { readonly [T in SqlColumnType]: Gen<Expr> } = {
	...literals,
	text: map(element(statementTexts), (value) => lit.text(value, types.text))
}

/**
 * The state of one statement: the source it draws from, its swarm, the next relation alias and the parameters numbered
 * so far (an input's array is a parameter of its own, never reused). Every draw is one decision of the source, bounded
 * by what the statement drawn so far allows.
 */
class Draw {
	readonly swarm: Swarm<StatementFeature>
	readonly catalog: SqlCatalog
	readonly #source: Source
	readonly #params: Array<SqlColumnType | "array"> = []
	#relations = 0

	constructor(source: Source, catalog: SqlCatalog, drawn: Swarm<StatementFeature>) {
		this.#source = source
		this.catalog = catalog
		this.swarm = drawn
	}

	/** One of the options, the first the simplest. */
	from<A>(options: Arr.NonEmptyReadonlyArray<A>): A {
		return this.#source.draw(element(options))
	}

	/** A count from `min` to `max`, `min` the simplest. */
	count(min: number, max: number): number {
		return this.#source.draw(int(min, max))
	}

	/** Whether a feature appears at this place: always at weight 3, never when off, otherwise by one more decision. */
	keep(feature: StatementFeature): boolean {
		return this.#source.draw(keep(this.swarm, feature))
	}

	on(feature: StatementFeature): boolean {
		return weightOf(this.swarm, feature) > 0
	}

	/** The floor, or one of the options whose feature is on, each as likely. */
	choose<A>(floor: A, options: ReadonlyArray<readonly [StatementFeature, A]>): A {
		return this.from([
			floor,
			...Arr.map(
				Arr.filter(options, ([feature]) => this.on(feature)),
				([, option]) => option
			)
		])
	}

	/** What `run` draws, its decisions one unit for shrinking and mutation. */
	span<A>(label: string, run: () => A): A {
		return this.#source.span(label, run)
	}

	relation(): string {
		this.#relations++
		return `r${this.#relations}`
	}

	/** A parameter of a type: a new index, or an earlier index of the type when parameters are reused. */
	param(type: SqlColumnType): Expr {
		const earlier = nonEmpty(Arr.flatMap(this.#params, (t, i) => (t === type ? [i + 1] : [])))
		if (earlier !== undefined && this.keep("param reuse")) {
			return param(this.from(earlier), typeRefs[type])
		}
		this.#params.push(type)
		return param(this.#params.length, typeRefs[type])
	}

	/** A fresh parameter of a relation input's array or count, never reused. */
	arrayParam(): ValuePlaceholder {
		this.#params.push("array")
		return positionalValue(this.#params.length)
	}

	literal(type: SqlColumnType): Expr {
		return this.#source.draw(statementLiterals[type])
	}
}

const columnsOf = (rels: ReadonlyArray<Rel>, type: SqlColumnType): ReadonlyArray<Expr> =>
	Arr.flatMap(rels, (r) =>
		Arr.map(
			Arr.filter(r.columns, (c) => c.type === type),
			(c) => col(r.alias, c.name)
		)
	)

const typesOf = (rels: ReadonlyArray<Rel>): ReadonlyArray<SqlColumnType> => [
	...new Set(Arr.flatMap(rels, (r) => Arr.map(r.columns, (c) => c.type)))
]

/** A value of a type that names no column: a literal, or a parameter when parameters are on. */
const constant = (d: Draw, type: SqlColumnType): Expr =>
	d.on("param") && d.keep("param") ? d.param(type) : d.literal(type)

/** A leaf of a type: a visible column of it, a literal or a parameter. */
const leaf = (d: Draw, env: Env, type: SqlColumnType): Expr => {
	const columns = nonEmpty(columnsOf(env.visible, type))
	if (columns === undefined) {
		return constant(d, type)
	}
	const kind = d.choose<"column" | "constant">("column", [
		["literal", "constant"],
		["param", "constant"]
	])
	return kind === "column" ? d.from(columns) : constant(d, type)
}

/** The types a cast reaches each type from. */
const castSources: { readonly [T in SqlColumnType]: ReadonlyArray<SqlColumnType> } = {
	bigint: ["integer"],
	numeric: ["integer", "bigint"],
	integer: [],
	text: [],
	boolean: []
}

type ExprForm =
	| "leaf"
	| "comparison"
	| "connective"
	| "not"
	| "is true"
	| "between"
	| "in list"
	| "exists"
	| "in query"
	| "arithmetic"
	| "negate"
	| "abs"
	| "case"
	| "greatest"
	| "coalesce"
	| "cast"
	| "scalar subquery"
	| "concat"
	| "collate"
	| "float"

type Forms = ReadonlyArray<readonly [StatementFeature, ExprForm]>

/** The forms beyond its floor an expression of a type may take at a depth. */
const formsOf = (env: Env, type: SqlColumnType, depth: number): Forms => {
	if (depth >= maxExprDepth) {
		return []
	}
	const subqueries = env.depth < maxQueryDepth
	switch (type) {
		case "boolean": {
			const nested: Forms = subqueries
				? [
						["exists", "exists"],
						["in query", "in query"]
					]
				: []
			return [
				["connectives", "connective"],
				["connectives", "not"],
				["connectives", "is true"],
				["between", "between"],
				["in list", "in list"],
				["case", "case"],
				...nested
			]
		}
		case "text":
			return [
				["concat", "concat"],
				["collate", "collate"],
				["greatest", "greatest"],
				["coalesce", "coalesce"],
				["case", "case"]
			]
		case "integer":
		case "bigint":
		case "numeric": {
			const casts: Forms = castSources[type].length > 0 ? [["cast", "cast"]] : []
			const counts: Forms =
				subqueries && type === "bigint" ? [["scalar subquery", "scalar subquery"]] : []
			const floats: Forms = type === "numeric" ? [["literal", "float"]] : []
			return [
				["arithmetic", "arithmetic"],
				["arithmetic", "negate"],
				["arithmetic", "abs"],
				["greatest", "greatest"],
				["coalesce", "coalesce"],
				["case", "case"],
				...casts,
				...counts,
				...floats
			]
		}
	}
}

/**
 * An expression of a type over what `env` makes visible, its decisions one span. A boolean's floor is a comparison
 * while it may nest, every other floor a leaf, so the recursion ends at the depth bound.
 */
const exprOf = (d: Draw, env: Env, type: SqlColumnType, depth: number): Expr =>
	d.span(`expr ${type}`, () => formOf(d, env, type, depth))

/** The form an expression of a type takes, and its operands. */
const formOf = (d: Draw, env: Env, type: SqlColumnType, depth: number): Expr => {
	const floor: ExprForm = type === "boolean" && depth < maxExprDepth ? "comparison" : "leaf"
	const form = d.choose(floor, formsOf(env, type, depth))
	const sub = (t: SqlColumnType) => exprOf(d, env, t, depth + 1)
	const nested: Env = { ...env, depth: env.depth + 1 }
	switch (form) {
		case "leaf":
			return leaf(d, env, type)
		case "comparison": {
			const operand = d.from(nonEmpty(typesOf(env.visible)) ?? statementTypes)
			const op = operand === "boolean" ? d.from(["=", "<>"] as const) : d.from(comparisons)
			return binary(op, sub(operand), sub(operand))
		}
		case "connective": {
			const args: readonly [Expr, Expr] = [sub("boolean"), sub("boolean")]
			return d.from(["and", "or"] as const) === "and" ? { kind: "and", args } : { kind: "or", args }
		}
		case "not":
			return { kind: "not", expr: sub("boolean") }
		case "is true":
			return { kind: "isTrue", expr: sub("boolean") }
		case "between": {
			const t = d.from(orderableTypes)
			return { kind: "between", expr: sub(t), low: sub(t), high: sub(t), not: false }
		}
		case "in list": {
			const t = d.from(statementTypes)
			const extra = d.count(0, 2)
			const list: Arr.NonEmptyReadonlyArray<Expr> = [
				constant(d, t),
				...Array.from({ length: extra }, () => constant(d, t))
			]
			return { kind: "inList", expr: sub(t), list, not: false }
		}
		case "exists":
			return exists(nestedQuery(d, nested, undefined).select)
		case "in query": {
			const t = d.from(statementTypes)
			return {
				kind: "inQuery",
				expr: sub(t),
				query: nestedQuery(d, nested, [t]).select,
				not: false
			}
		}
		case "arithmetic":
			return binary(d.from(["+", "-", "*"] as const), sub(type), sub(type))
		case "negate":
			return { kind: "negate", expr: sub(type) }
		case "abs":
			return call("abs", [sub(type)])
		case "case":
			return {
				kind: "case",
				whens: [{ when: sub("boolean"), result: sub(type) }],
				else: sub(type),
				operand: undefined
			}
		case "greatest":
			return { kind: d.from(["greatest", "least"] as const), args: [sub(type), sub(type)] }
		case "coalesce":
			return { kind: "coalesce", args: [sub(type), sub(type)] }
		case "cast": {
			const sources = nonEmpty(castSources[type])
			return sources === undefined ? leaf(d, env, type) : cast(sub(d.from(sources)), typeRefs[type])
		}
		case "scalar subquery":
			return { kind: "subquery", query: countQuery(d, nested) }
		case "concat":
			return binary("||", sub("text"), sub("text"))
		case "collate":
			return { kind: "collate", expr: sub("text"), collation: cUtf8Collation }
		case "float":
			return cast(floatLiteral(d), typeRefs.numeric)
	}
}

/**
 * Finite double literals, and the specials a double holds beside them, which the printer spells and the audits read
 * apart from every finite value: NaN, the infinities and -0. A numeric holds each of them (the infinities since
 * PostgreSQL 14; -0 is 0), and nothing sqlgen draws over a numeric raises on one.
 */
const finiteFloats = [0.5, -1.25, 1e10] as const
const floatSpecials = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0] as const

/** A double precision literal: a finite value or a special, each an arm of its own. */
const floatLiteral = (d: Draw): Expr =>
	lit.float(d.from([false, true]) ? d.from(floatSpecials) : d.from(finiteFloats), types.double)

/**
 * SELECT count(*) AS c1 FROM ... [WHERE ...]: a count is a value over no row, so a scalar subquery never yields NULL.
 */
const countQuery = (d: Draw, env: Env): Select => {
	const from = fromOf(d, env)
	const inner: Env = { ...env, visible: [...from.rels, ...env.visible] }
	return select(
		provedCore(
			"oneRow",
			[targetAs(countStar(), "c1")],
			from.items,
			d.keep("where") ? exprOf(d, inner, "boolean", 0) : undefined
		)
	)
}

interface From {
	readonly items: Arr.NonEmptyReadonlyArray<FromItem>
	readonly rels: ReadonlyArray<Rel>
}

/** One FROM entry: sources only, which a join chain joins. */
interface Entry {
	readonly items: Arr.NonEmptyReadonlyArray<FromSource>
	readonly rels: ReadonlyArray<Rel>
}

/** One stored table under a fresh alias. */
const scanOf = (d: Draw): { readonly item: FromSource; readonly rel: Rel } => {
	const t = d.from(d.catalog)
	const alias = d.relation()
	return { item: table(t.schema, t.name, alias), rel: { alias, columns: t.columns } }
}

const tableEntry = (d: Draw): Entry => {
	const scan = scanOf(d)
	return { items: [scan.item], rels: [scan.rel] }
}

/** A derived table over a query that sees `outer`; LATERAL when `outer` holds earlier entries of its FROM. */
const derivedEntry = (d: Draw, env: Env, outer: ReadonlyArray<Rel>, lateral: boolean): Entry => {
	const q = nestedQuery(d, { visible: outer, ctes: env.ctes, depth: env.depth + 1 }, undefined)
	const alias = d.relation()
	const columns = generatedColumns(q.types)
	const item: FromSource = {
		kind: "derived",
		query: q.select,
		alias,
		columns: Arr.map(columns, (c) => c.name),
		lateral: lateral
	}
	return { items: [item], rels: [{ alias, columns }] }
}

/** One or two VALUES rows, each a constant of every one of `types`. */
const valuesRowsOf = (
	d: Draw,
	types: Arr.NonEmptyReadonlyArray<SqlColumnType>
): Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<Expr>> => {
	const extra = d.count(0, 1)
	const row = () => Arr.map(types, (type) => constant(d, type))
	return [row(), ...Array.from({ length: extra }, row)]
}

const valuesEntry = (d: Draw): Entry => {
	const width = d.count(0, 1)
	const outputs: Arr.NonEmptyReadonlyArray<SqlColumnType> = [
		d.from(statementTypes),
		...Array.from({ length: width }, () => d.from(statementTypes))
	]
	const rows = valuesRowsOf(d, outputs)
	const alias = d.relation()
	const columns = generatedColumns(outputs)
	return {
		items: [{ kind: "values", rows, alias, columns: Arr.map(outputs, (_, i) => `c${i + 1}`) }],
		rels: [{ alias, columns }]
	}
}

/**
 * A relation input's arrays, `(SELECT pg_catalog.unnest($n::<type>[]) AS c1, ...) AS r`: one fresh placeholder per
 * column, a text column's array under the fixed collation the lowering states (lower/conservative/input-set), or, of no
 * column, `pg_catalog.generate_series(1::bigint, $n::bigint) AS r` of a fresh count placeholder.
 */
const arraysEntry = (d: Draw): Entry => {
	const width = d.keep("zero width") ? 0 : d.count(1, 2)
	const outputs = Array.from({ length: width }, () => d.from(statementTypes))
	const alias = d.relation()
	const columns = generatedColumns(outputs)
	const named = nonEmpty(columns)
	return {
		items: [
			arrays(
				named === undefined
					? { kind: "count", count: d.arrayParam() }
					: {
							kind: "columns",
							ordinal: undefined,
							columns: Arr.map(named, (c) => ({
								definition: columnDefinition(c.name, typeRefs[c.type]),
								array: d.arrayParam(),
								check: baseCheck
							}))
						},
				alias
			)
		],
		rels: [{ alias, columns }]
	}
}

/**
 * A query of no target, never DISTINCT: `SELECT FROM <from> [WHERE ...]`, one row of no column per row its FROM reads,
 * or `SELECT` alone, the one row of no column.
 */
const unitQuery = (d: Draw, env: Env): Select =>
	d.span("unit query", () => {
		if (d.keep("zero width")) {
			return select(provedCore("oneRow", [], [], undefined))
		}
		const from = fromOf(d, env)
		const inner: Env = { ...env, visible: [...from.rels, ...env.visible] }
		const where = d.keep("where") ? exprOf(d, inner, "boolean", 0) : undefined
		return select(provedCore("certified", [], from.items, where))
	})

/** A derived table of no column over a query of no target, `(SELECT ...) AS r`: no column list, nothing to read. */
const unitDerivedEntry = (d: Draw, env: Env, outer: ReadonlyArray<Rel>): Entry => {
	const q = unitQuery(d, { visible: outer, ctes: env.ctes, depth: env.depth + 1 })
	const alias = d.relation()
	return { items: [derived(q, alias, [], false)], rels: [{ alias, columns: [] }] }
}

/**
 * A set-returning call under an alias of no column, `range_minus_multi(int4range(a, b), int4range(c, d)) AS r`: one row
 * per piece, its column named by the alias alone and read by nothing. Each span's bounds are ordered, so PostgreSQL
 * folds it at plan time without an error.
 */
const unitFunctionEntry = (d: Draw): Entry => {
	const span = (): Expr => {
		const lower = d.count(0, 3)
		return call("int4range", [
			lit.int(lower, types.integer),
			lit.int(lower + d.count(0, 3), types.integer)
		])
	}
	const alias = d.relation()
	const pieces: FromSource = {
		kind: "function",
		call: call("range_minus_multi", [span(), span()]),
		alias,
		columns: [],
		lateral: false
	}
	return { items: [pieces], rels: [{ alias, columns: [] }] }
}

const cteEntry = (d: Draw, ctes: Arr.NonEmptyReadonlyArray<CteDef>): Entry => {
	const cte = d.from(ctes)
	const alias = d.relation()
	return { items: [cteRefAs(cte.name, alias)], rels: [{ alias, columns: cte.columns }] }
}

/** One FROM entry that sees `outer` only: a table, a derived table, a VALUES list, input arrays or a CTE. */
const entryOf = (d: Draw, env: Env, outer: ReadonlyArray<Rel>): Entry =>
	d.span("from entry", () => {
		const ctes = nonEmpty(env.ctes)
		const nested: ReadonlyArray<readonly [StatementFeature, () => Entry]> =
			env.depth < maxQueryDepth
				? [
						["derived", () => derivedEntry(d, env, outer, false)],
						["zero width", () => unitDerivedEntry(d, env, outer)]
					]
				: []
		const read: ReadonlyArray<readonly [StatementFeature, () => Entry]> =
			ctes === undefined ? [] : [["cte", () => cteEntry(d, ctes)]]
		return d.choose<() => Entry>(
			() => tableEntry(d),
			[
				...nested,
				["values", () => valuesEntry(d)],
				["arrays", () => arraysEntry(d)],
				["zero width", () => unitFunctionEntry(d)],
				...read
			]
		)()
	})

/** An equality between same-typed columns of two relation lists, or `true` when they share no type. */
const joinCondition = (d: Draw, left: ReadonlyArray<Rel>, right: ReadonlyArray<Rel>): Expr => {
	const pairs = nonEmpty(
		Arr.flatMap(typesOf(left), (t) => {
			const l = nonEmpty(columnsOf(left, t))
			const r = nonEmpty(columnsOf(right, t))
			return l === undefined || r === undefined ? [] : [[l, r] as const]
		})
	)
	if (pairs === undefined) {
		return lit.bool(true)
	}
	const [l, r] = d.from(pairs)
	return binary("=", d.from(l), d.from(r))
}

/** A core's FROM: one entry, inner-joined, cross-joined or followed by a LATERAL derived table when those are on. */
const fromOf = (d: Draw, env: Env): From => {
	const outer = env.visible
	const first = entryOf(d, env, outer)
	const [left] = first.items
	const lateral: ReadonlyArray<readonly [StatementFeature, "lateral"]> =
		env.depth < maxQueryDepth ? [["lateral", "lateral"]] : []
	const extension = d.choose<"none" | "join" | "cross" | "lateral">("none", [
		["join", "join"],
		["cross join", "cross"],
		...lateral
	])
	if (extension === "none") {
		return first
	}
	if (extension === "lateral") {
		const second = derivedEntry(d, env, [...first.rels, ...outer], true)
		return {
			items: [left, ...first.items.slice(1), ...second.items],
			rels: [...first.rels, ...second.rels]
		}
	}
	const second = entryOf(d, env, outer)
	const [right] = second.items
	const item: FromItem =
		extension === "join"
			? join(left, right, joinCondition(d, first.rels, second.rels))
			: { kind: "joins", first: left, steps: [{ kind: "cross", source: right }] }
	return { items: [item], rels: [...first.rels, ...second.rels] }
}

/** A core and what its enclosing query may do with it. */
interface Core {
	readonly core: SetCore
	readonly types: Arr.NonEmptyReadonlyArray<SqlColumnType>
	/**
	 * The outputs ORDER BY may name: every output but a constant, which PostgreSQL would read as a position, and one that
	 * binds a relation alias, which naming it again would define twice.
	 */
	readonly orderable: ReadonlyArray<Expr>
	/** The DISTINCT ON keys an ORDER BY must start with. */
	readonly leading: ReadonlyArray<Expr>
}

/** The type sum yields over a column of a type, or undefined when sum takes none of it. */
const sumType = (t: SqlColumnType): SqlColumnType | undefined =>
	t === "integer" ? "bigint" : t === "bigint" || t === "numeric" ? "numeric" : undefined

/** An aggregate of a type over the core's own columns, or undefined when none yields the type. */
const aggregateOf = (d: Draw, own: ReadonlyArray<Rel>, type: SqlColumnType): Expr | undefined => {
	const same = nonEmpty(columnsOf(own, type))
	const options: Array<() => Expr> = []
	if (type === "bigint") {
		options.push(() => ({
			...countStar(),
			filter: d.keep("count filter")
				? exprOf(d, { visible: own, ctes: [], depth: maxQueryDepth }, "boolean", 1)
				: undefined
		}))
	}
	if (same !== undefined && type === "boolean") {
		options.push(() => call(d.from(["bool_and", "bool_or"] as const), [d.from(same)]))
	}
	if (same !== undefined && type !== "boolean") {
		options.push(() => ({
			...call(d.from(["min", "max"] as const), [d.from(same)]),
			distinct: d.keep("distinct")
		}))
		/**
		 * An aggregate's own ORDER BY, never beside DISTINCT: PostgreSQL refuses an ORDER BY outside the arguments of a
		 * DISTINCT aggregate.
		 */
		const sortable = nonEmpty(Arr.flatMap(orderableTypes, (t) => columnsOf(own, t)))
		if (sortable !== undefined && d.on("aggregate order by")) {
			options.push(() => ({
				...call(d.from(["min", "max"] as const), [d.from(same)]),
				orderBy: [asc(d.from(sortable))]
			}))
		}
		if (d.on("within group")) {
			options.push(() =>
				d.from([false, true])
					? { ...call("mode", []), withinGroup: [asc(d.from(same))] }
					: {
							...call("percentile_disc", [lit.float(0.5, types.double)]),
							withinGroup: [asc(d.from(same))]
						}
			)
		}
	}
	for (const source of ["integer", "bigint", "numeric"] as const) {
		const summed = nonEmpty(columnsOf(own, source))
		if (summed === undefined) {
			continue
		}
		if (sumType(source) === type) {
			options.push(() => call("sum", [d.from(summed)]))
		}
		if (type === "numeric") {
			options.push(() => call("avg", [d.from(summed)]))
		}
	}
	const chosen = nonEmpty(options)
	return chosen === undefined ? undefined : d.from(chosen)()
}

/**
 * A ROWS frame that holds the current row: it starts at or before it and ends at or after it. An offset bound is each
 * bound's first arm, so a frame carries one at either end in five draws of nine, and at both where the tape has run out.
 */
const frameOf = (d: Draw): WindowSpec["frame"] => ({
	start: d.from<FrameBound>([
		{ kind: "offset", offset: BigInt(d.count(1, 2)), direction: "PRECEDING" },
		{ kind: "unboundedPreceding" },
		{ kind: "currentRow" }
	]),
	end: d.from<FrameBound>([
		{ kind: "offset", offset: BigInt(d.count(1, 2)), direction: "FOLLOWING" },
		{ kind: "currentRow" },
		{ kind: "unboundedFollowing" }
	])
})

/**
 * A window call of a type over the core's own columns, or undefined when none yields the type. While frames are on, a
 * call that takes a frame (count(*) or min/max OVER) is drawn whenever the type has one, and carries its frame: a
 * frame, and its offset bounds, are a form of their own, not a tail behind the frame feature's thinning.
 */
const windowOf = (d: Draw, own: ReadonlyArray<Rel>, type: SqlColumnType): Expr | undefined => {
	const all = nonEmpty(Arr.flatMap(own, (r) => Arr.map(r.columns, (c) => col(r.alias, c.name))))
	const sortable = nonEmpty(Arr.flatMap(orderableTypes, (t) => columnsOf(own, t)))
	const frames = d.on("frame")
	const over = (framed: boolean): WindowSpec => {
		const frame = framed && frames ? frameOf(d) : undefined
		return {
			partitionBy: all !== undefined && d.keep("window") ? [d.from(all)] : [],
			orderBy:
				sortable !== undefined && d.keep("order by")
					? [d.from([asc(d.from(sortable)), desc(d.from(sortable))])]
					: [],
			frame
		}
	}
	const same = nonEmpty(columnsOf(own, type))
	const unframed: Array<() => Expr> = []
	const framed: Array<() => Expr> = []
	if (type === "bigint") {
		unframed.push(() => ({
			...call(d.from(["row_number", "rank", "dense_rank"] as const), []),
			over: over(false)
		}))
		framed.push(() => ({ ...countStar(), over: over(true) }))
	}
	if (same !== undefined) {
		unframed.push(() => {
			const c = d.from(same)
			return {
				...call(d.from(["lead", "lag"] as const), [c, lit.int(1, types.integer), c]),
				over: over(false)
			}
		})
		if (type !== "boolean") {
			framed.push(() => ({
				...call(d.from(["min", "max"] as const), [d.from(same)]),
				over: over(true)
			}))
		}
	}
	const framedCalls = nonEmpty(framed)
	const chosen =
		frames && framedCalls !== undefined ? framedCalls : nonEmpty([...unframed, ...framed])
	return chosen === undefined ? undefined : d.from(chosen)()
}

/**
 * The constants PostgreSQL would read as a position in ORDER BY, GROUP BY or DISTINCT ON (or refuse there as a
 * non-integer constant): a literal, and the minus of one, which gram.y's doNegate folds into the constant it negates,
 * parenthesized or not (so `-0` is the position 0).
 */
const isConstant = (e: Expr): boolean =>
	e.kind === "literal" || (e.kind === "negate" && isConstant(e.expr))

/**
 * Whether an output may be repeated in DISTINCT ON or ORDER BY: it is no constant, and it holds no query, whose FROM
 * items would define their relation aliases a second time where it is repeated (a statement defines each alias once).
 */
const repeatable = (e: Expr): boolean => {
	if (isConstant(e)) {
		return false
	}
	let bindsAlias = false
	visitSelect(select(provedCore("oneRow", [target(e)], [], undefined)), {
		...inertVisitor,
		fromItem: () => {
			bindsAlias = true
		}
	})
	return !bindsAlias
}

/**
 * `core` with each target replaced by `f`'s, under its own projection: each branch keeps that projection's targets, a
 * DISTINCT core's nonempty.
 */
const mapTargets = (core: SetCore, f: (t: Target, i: number) => Target): SetCore =>
	core.distinct === false
		? { ...core, targets: Arr.map(core.targets, f) }
		: { ...core, targets: Arr.map(core.targets, f) }

const aliased = (targets: Arr.NonEmptyReadonlyArray<Expr>): Arr.NonEmptyReadonlyArray<Target> =>
	Arr.map(targets, (e, i) => targetAs(e, `c${i + 1}`))

/**
 * A core of `targets`: DISTINCT ON its `leading` keys when there are some, else DISTINCT when drawn, else neither; the
 * DISTINCT draw is taken only where no key leads, as before.
 */
const projected = (
	d: Draw,
	leading: ReadonlyArray<Expr>,
	targets: Arr.NonEmptyReadonlyArray<Target>,
	from: ReadonlyArray<FromItem>,
	where: Expr | undefined
): SetCore =>
	Arr.isReadonlyArrayNonEmpty(leading)
		? distinctOnCore(leading, targets, from, where)
		: d.keep("distinct")
			? distinctCore(targets, from, where)
			: provedCore("certified", targets, from, where)

/** A query core with outputs of `outputs` when given, its decisions one span. */
const coreOf = (
	d: Draw,
	env: Env,
	outputs: Arr.NonEmptyReadonlyArray<SqlColumnType> | undefined
): Core => d.span("core", () => coreBody(d, env, outputs))

/**
 * A query core's clauses. A grouped core outputs its keys and aggregates of its own columns only; an ungrouped one
 * aggregates by count(*) alone, the one aggregate that is a value over no row.
 */
const coreBody = (
	d: Draw,
	env: Env,
	outputs: Arr.NonEmptyReadonlyArray<SqlColumnType> | undefined
): Core => {
	const from = fromOf(d, env)
	const own = from.rels
	const inner: Env = { ...env, visible: [...own, ...env.visible] }
	const where = d.keep("where") ? exprOf(d, inner, "boolean", 0) : undefined
	const ownTypes = nonEmpty(typesOf(own)) ?? statementTypes
	const wanted: Arr.NonEmptyReadonlyArray<SqlColumnType> = outputs ?? [
		d.from(ownTypes),
		...Array.from({ length: d.count(0, 2) }, () => d.from(ownTypes))
	]
	const keyColumns = nonEmpty(
		Arr.flatMap(own, (r) =>
			Arr.map(r.columns, (c) => ({ expr: col(r.alias, c.name), type: c.type }))
		)
	)
	const counted: ReadonlyArray<readonly [StatementFeature, "counted"]> =
		wanted.length === 1 && wanted[0] === "bigint" ? [["aggregate", "counted"]] : []
	const grouped: ReadonlyArray<readonly [StatementFeature, "grouped"]> =
		keyColumns === undefined ? [] : [["group by", "grouped"]]
	const shape = d.choose<"plain" | "grouped" | "counted">("plain", [...grouped, ...counted])
	if (shape === "counted") {
		/**
		 * PostgreSQL places an aggregate at the level of the columns its FILTER reads: over an outer column alone it is
		 * the outer query's, which a FROM item may not hold. The FILTER reads the core's own relations.
		 */
		const count: CountStar = {
			...countStar(),
			filter: d.keep("count filter") ? exprOf(d, { ...env, visible: own }, "boolean", 1) : undefined
		}
		return {
			core: provedCore("oneRow", aliased([count]), from.items, where),
			types: ["bigint"],
			orderable: repeatable(count) ? [count] : [],
			leading: []
		}
	}
	if (shape === "grouped" && keyColumns !== undefined) {
		const keys = [
			d.from(keyColumns),
			...Array.from({ length: d.count(0, 1) }, () => d.from(keyColumns))
		]
		const targets = Arr.map(wanted, (t) => {
			const aggregate = d.keep("aggregate") ? aggregateOf(d, own, t) : undefined
			const key = nonEmpty(Arr.filter(keys, (k) => k.type === t))
			return aggregate ?? (key === undefined ? d.literal(t) : d.from(key).expr)
		})
		const havingAggregate = d.keep("having") ? aggregateOf(d, own, "bigint") : undefined
		const orderable = Arr.filter(targets, repeatable)
		const keyed = nonEmpty(Arr.filter(orderable, (e) => Arr.some(keys, (k) => k.expr === e)))
		const leading = keyed !== undefined && d.keep("distinct on") ? [d.from(keyed)] : []
		const projection = projected(d, leading, aliased(targets), from.items, where)
		const having =
			havingAggregate === undefined
				? undefined
				: binary(d.from(comparisons), havingAggregate, d.literal("bigint"))
		return {
			core: { ...projection, groupBy: Arr.map(keys, (k) => k.expr), having },
			types: wanted,
			orderable,
			leading
		}
	}
	const windowAt = d.keep("window") ? d.count(0, wanted.length - 1) : -1
	const windows: Array<Expr> = []
	const targets = Arr.map(wanted, (t, i) => {
		const w = i === windowAt ? windowOf(d, own, t) : undefined
		if (w === undefined) {
			return exprOf(d, inner, t, 0)
		}
		windows.push(w)
		return w
	})
	const orderable = Arr.filter(targets, repeatable)
	const keyable = nonEmpty(Arr.filter(orderable, (e) => !windows.includes(e)))
	const leading = keyable !== undefined && d.keep("distinct on") ? [d.from(keyable)] : []
	return {
		core: projected(d, leading, aliased(targets), from.items, where),
		types: wanted,
		orderable,
		leading
	}
}

/** LIMIT or OFFSET: a bigint parameter or a nonnegative bigint literal. */
const bound = (d: Draw): Expr =>
	d.on("param") && d.keep("param") ? d.param("bigint") : lit.int(d.count(0, 3), types.bigint)

/** An ORDER BY over a core: its DISTINCT ON keys first, then a drawn output; empty when there is nothing to name. */
const orderOf = (
	d: Draw,
	orderable: ReadonlyArray<Expr>,
	leading: ReadonlyArray<Expr>
): ReadonlyArray<OrderItem> => {
	const items = nonEmpty(orderable)
	if (items === undefined) {
		return []
	}
	const extra = Array.from({ length: d.count(leading.length === 0 ? 1 : 0, 1) }, () =>
		d.from([asc(d.from(items)), desc(d.from(items))])
	)
	return [...Arr.map(leading, asc), ...extra]
}

interface DrawnArm {
	readonly body: SetArm
	readonly types: Arr.NonEmptyReadonlyArray<SqlColumnType>
}

/**
 * One arm of a set operation: a core, or a parenthesized query with an ORDER BY and a LIMIT of its own. An arm that
 * is not `named` leaves its outputs unaliased, taking the set operation's names.
 */
const armOf = (
	d: Draw,
	env: Env,
	outputs: Arr.NonEmptyReadonlyArray<SqlColumnType> | undefined,
	named: boolean
): DrawnArm => {
	const c = coreOf(d, env, outputs)
	const body: SetCore = named ? c.core : mapTargets(c.core, (t) => target(t.expr))
	const order = orderOf(d, c.orderable, c.leading)
	if (order.length === 0 || !d.keep("parenthesized arm")) {
		return { body, types: c.types }
	}
	return { body: { ...select(body), orderBy: order, limit: bound(d) }, types: c.types }
}

interface Scoped {
	readonly with: With
	readonly ctes: ReadonlyArray<CteDef>
}

/**
 * A WITH of query CTEs, each reading the CTEs before it, or, where `recursive` allows it, of one bounded recursive
 * counter.
 */
const ctesOf = (d: Draw, env: Env, recursive: boolean): Scoped | undefined => {
	if (env.depth >= maxQueryDepth || !d.keep("cte")) {
		return undefined
	}
	if (recursive && d.keep("recursive")) {
		const name = d.relation()
		const step = d.relation()
		const counter = col(step, "c1")
		const counting: Cte = {
			name,
			columns: ["c1"],
			query: select({
				kind: "setOp",
				op: "UNION",
				arms: [
					provedCore("oneRow", [targetAs(lit.int(1, types.bigint), "c1")], [], undefined),
					provedCore(
						"certified",
						[targetAs(binary("+", counter, lit.int(1, types.bigint)), "c1")],
						[cteRefAs(name, step)],
						binary("<", counter, lit.int(d.count(1, 4), types.bigint))
					)
				]
			}),
			materialized: undefined
		}
		return {
			with: { recursive: true, ctes: [counting] },
			ctes: [...env.ctes, { name, columns: [{ name: "c1", type: "bigint" }] }]
		}
	}
	const ctes: Array<CteDef> = [...env.ctes]
	/** One query CTE over the CTEs before it, in scope for the ones after it. */
	const defined = (): Cte => {
		if (d.keep("zero width")) {
			const query = unitQuery(d, { visible: [], ctes, depth: env.depth + 1 })
			const name = d.relation()
			ctes.push({ name, columns: [] })
			return { name, columns: [], materialized: undefined, query }
		}
		const q = nestedQuery(d, { visible: [], ctes, depth: env.depth + 1 }, undefined)
		const name = d.relation()
		const columns = generatedColumns(q.types)
		const materialized = d.keep("materialized")
			? d.from(["MATERIALIZED", "NOT MATERIALIZED"] as const)
			: undefined
		ctes.push({ name, columns })
		return { name, columns: Arr.map(columns, (c) => c.name), materialized, query: q.select }
	}
	const extra = d.count(0, 1)
	const first = defined()
	return {
		with: { ctes: [first, ...Array.from({ length: extra }, defined)], recursive: false },
		ctes
	}
}

/** A query nested in another, or in a write, with a WITH of its own when one is drawn. */
const nestedQuery = (
	d: Draw,
	env: Env,
	outputs: Arr.NonEmptyReadonlyArray<SqlColumnType> | undefined
): { readonly select: Select; readonly types: Arr.NonEmptyReadonlyArray<SqlColumnType> } =>
	queryOf(d, env, outputs, false, ctesOf(d, env, true))

/**
 * A query with outputs of `outputs` when given. `top`: the statement's own query, whose output may carry public
 * names; `scoped` is its WITH when the statement drew it.
 */
const queryOf = (
	d: Draw,
	env: Env,
	outputs: Arr.NonEmptyReadonlyArray<SqlColumnType> | undefined,
	top: boolean,
	scoped: Scoped | undefined
): { readonly select: Select; readonly types: Arr.NonEmptyReadonlyArray<SqlColumnType> } => {
	const inScope: Env = scoped === undefined ? env : { ...env, ctes: scoped.ctes }
	/** The query of a body and its order, with the WITH and the drawn LIMIT and OFFSET. */
	const query = (body: SelectBody, order: ReadonlyArray<OrderItem>): Select => ({
		...select(body),
		with: scoped === undefined ? undefined : scoped.with,
		orderBy: order,
		limit: d.keep("limit") ? bound(d) : undefined,
		offset: d.keep("offset") ? bound(d) : undefined
	})
	if (inScope.depth < maxQueryDepth && d.keep("set operation")) {
		const left = armOf(d, inScope, outputs, true)
		const right = armOf(d, inScope, left.types, d.from([true, false]))
		const op = d.from(setOperators)
		const arms = [left.body, right.body] as const
		const body: SelectBody =
			op === "UNION ALL"
				? { kind: "setOp", op, rows: "certified", arms }
				: { kind: "setOp", op, arms }
		const names = Arr.map(generatedColumns(left.types), (c): Expr => tableCol(c.name))
		const order = d.keep("order by") ? orderOf(d, names, []) : []
		return { select: query(body, order), types: left.types }
	}
	const c = coreOf(d, inScope, outputs)
	const start = d.count(0, publicNames.length - 1)
	const names = [...publicNames.slice(start), ...publicNames.slice(0, start)]
	const body: SetCore =
		top && d.keep("public names")
			? mapTargets(c.core, (t, i) => ({ ...t, alias: names[i] ?? `c${i + 1}` }))
			: c.core
	const order = d.keep("order by") || c.leading.length > 0 ? orderOf(d, c.orderable, c.leading) : []
	return { select: query(body, order), types: c.types }
}

/** What a write returns: its RETURNING list and the columns a CTE over it has. */
interface Returned {
	readonly returning: ReadonlyArray<Target>
	readonly columns: ReadonlyArray<SqlColumn>
}

/** A RETURNING item: an expression and its type. */
interface Returnable {
	readonly expr: Expr
	readonly type: SqlColumnType
}

/**
 * A RETURNING list of one to three of `items`: aliased c1, c2, ... or, for the statement's own output, public names.
 */
const returnedOf = (
	d: Draw,
	items: Arr.NonEmptyReadonlyArray<Returnable>,
	top: boolean
): Returned => {
	const chosen = [d.from(items), ...Array.from({ length: d.count(0, 2) }, () => d.from(items))]
	const start = d.count(0, publicNames.length - 1)
	const names =
		top && d.keep("public names")
			? [...publicNames.slice(start), ...publicNames.slice(0, start)]
			: []
	return {
		returning: Arr.map(chosen, (item, i) => targetAs(item.expr, names[i] ?? `c${i + 1}`)),
		columns: generatedColumns(Arr.map(chosen, (item) => item.type))
	}
}

const columnItems = (rels: ReadonlyArray<Rel>): ReadonlyArray<Returnable> =>
	Arr.flatMap(rels, (r) =>
		Arr.map(r.columns, (c) => ({ expr: col(r.alias, c.name), type: c.type }))
	)

const imageItems = (written: Rel, sides: ReadonlyArray<"old" | "new">): ReadonlyArray<Returnable> =>
	Arr.flatMap(sides, (side) =>
		Arr.map(written.columns, (c): Returnable => ({
			expr: { kind: "returning", side, column: c.name },
			type: c.type
		}))
	)

/** A RETURNING list when one is required (a data-modifying CTE's) or drawn. */
const returningOf = (
	d: Draw,
	items: Arr.NonEmptyReadonlyArray<Returnable>,
	required: boolean,
	top: boolean
): Returned | undefined => (required || d.keep("returning") ? returnedOf(d, items, top) : undefined)

interface Write {
	readonly statement: Insert | Update | Delete | Merge
	readonly returned: Returned | undefined
}

/** The stored table a write targets, under a fresh alias. */
const targetOf = (d: Draw): { readonly table: SqlTable; readonly rel: Rel } => {
	const t = d.from(d.catalog)
	return { table: t, rel: { alias: d.relation(), columns: t.columns } }
}

const withOf = (scoped: Scoped | undefined): Pick<Insert, "with"> =>
	scoped === undefined ? { with: undefined } : { with: scoped.with }

/** The columns of a target table, as RETURNING items: never empty, since a table has a column. */
const tableItems = (alias: string, t: SqlTable): Arr.NonEmptyReadonlyArray<Returnable> => {
	const item = (c: SqlColumn): Returnable => ({ expr: col(alias, c.name), type: c.type })
	return [item(t.columns[0]), ...Arr.map(t.columns.slice(1), item)]
}

const withItems = (
	first: Arr.NonEmptyReadonlyArray<Returnable>,
	more: ReadonlyArray<Returnable>
): Arr.NonEmptyReadonlyArray<Returnable> => [first[0], ...first.slice(1), ...more]

/**
 * INSERT INTO t AS r (every column) VALUES ... or SELECT ..., with ON CONFLICT on the key, the first column; or, under
 * the zero-width arm, INSERT INTO t AS r SELECT ... of no column, PostgreSQL's spelling of an insert whose every column
 * takes its default (a table of identities, the unit relation's insert), which plans over any table.
 *
 * DO SELECT hands the existing row to RETURNING, so it comes with one.
 */
const insertOf = (
	d: Draw,
	env: Env,
	required: boolean,
	top: boolean,
	scoped: Scoped | undefined
): Write => {
	const { table: t, rel } = targetOf(d)
	const [key, ...others] = t.columns
	const columnTypes: Arr.NonEmptyReadonlyArray<SqlColumnType> = [
		key.type,
		...Arr.map(others, (c) => c.type)
	]
	const inScope: Env = scoped === undefined ? env : { ...env, ctes: scoped.ctes }
	/** No column at all: every column takes its default, which only a table of identities gives at execution. */
	const unit = d.keep("zero width")
	const columns = Arr.map(t.columns, (c) => c.name)
	const target: InsertTarget = unit
		? {
				columns: [],
				source: { kind: "query", query: unitQuery(d, { ...inScope, depth: inScope.depth + 1 }) }
			}
		: inScope.depth < maxQueryDepth && d.keep("insert query")
			? {
					columns,
					source: {
						kind: "query",
						query: nestedQuery(d, { ...inScope, depth: inScope.depth + 1 }, columnTypes).select
					}
				}
			: { columns, source: { kind: "values", rows: valuesRowsOf(d, columnTypes) } }
	const returned = returningOf(d, tableItems(rel.alias, t), required, top)
	const excludedKey: Expr = { kind: "excluded", column: key.name }
	const condition = (): Pick<Extract<ConflictAction, { readonly kind: "doUpdate" }>, "where"> =>
		d.keep("where")
			? { where: binary("=", col(rel.alias, key.name), excludedKey) }
			: { where: undefined }
	const assignable = nonEmpty(others)
	const actions: Arr.NonEmptyArray<() => ConflictAction> = [() => ({ kind: "doNothing" })]
	if (assignable !== undefined) {
		actions.push(() => {
			const assigned = d.from(assignable)
			const excluded: Expr = { kind: "excluded", column: assigned.name }
			const value = d.from([excluded, col(rel.alias, assigned.name)])
			return { kind: "doUpdate", set: [{ column: assigned.name, value }], ...condition() }
		})
	}
	if (returned !== undefined) {
		actions.push(() => ({ kind: "doSelect", ...condition() }))
	}
	const onConflict: Pick<Insert, "onConflict"> = d.keep("on conflict")
		? { onConflict: { kind: "columns", columns: [key.name], action: d.from(actions)() } }
		: { onConflict: undefined }
	return {
		statement: {
			kind: "insert",
			...withOf(scoped),
			table: { schema: t.schema, name: t.name },
			alias: rel.alias,
			overriding: undefined,
			...target,
			...onConflict,
			returning: returned === undefined ? [] : returned.returning
		},
		returned
	}
}

/** The FROM or USING items of a write: they never see its target. */
const writeItems = (d: Draw, env: Env, feature: StatementFeature): From | undefined =>
	d.keep(feature) ? entryOf(d, { ...env, visible: [] }, []) : undefined

/** One or two distinct columns of the target, each set to an expression of its type over `visible`. */
const assignmentsOf = (d: Draw, env: Env, t: SqlTable): Arr.NonEmptyReadonlyArray<Assignment> => {
	const first = d.from(t.columns)
	const second = d.count(1, 2) === 2 ? d.from(t.columns) : first
	const assign = (c: SqlColumn): Assignment => ({
		column: c.name,
		value: exprOf(d, env, c.type, 0)
	})
	return second.name === first.name ? [assign(first)] : [assign(first), assign(second)]
}

/** UPDATE t AS r SET ... [FROM ...] [WHERE ...] [RETURNING ...], RETURNING naming the old and the new row. */
const updateOf = (
	d: Draw,
	env: Env,
	required: boolean,
	top: boolean,
	scoped: Scoped | undefined
): Write => {
	const { table: t, rel } = targetOf(d)
	const inScope: Env = scoped === undefined ? env : { ...env, ctes: scoped.ctes }
	const from = writeItems(d, inScope, "update from")
	const rels = [rel, ...(from?.rels ?? [])]
	const scope: Env = { ...inScope, visible: rels }
	const set = assignmentsOf(d, scope, t)
	const where = d.keep("where") ? exprOf(d, scope, "boolean", 0) : undefined
	const returned = returningOf(
		d,
		withItems(tableItems(rel.alias, t), [
			...columnItems(from?.rels ?? []),
			...imageItems(rel, ["old", "new"])
		]),
		required,
		top
	)
	return {
		statement: {
			kind: "update",
			...withOf(scoped),
			table: { schema: t.schema, name: t.name },
			alias: rel.alias,
			set,
			from: from === undefined ? [] : from.items,
			where,
			returning: returned === undefined ? [] : returned.returning
		},
		returned
	}
}

/** DELETE FROM t AS r [USING ...] [WHERE ...] [RETURNING ...], RETURNING naming the old row only. */
const deleteOf = (
	d: Draw,
	env: Env,
	required: boolean,
	top: boolean,
	scoped: Scoped | undefined
): Write => {
	const { table: t, rel } = targetOf(d)
	const inScope: Env = scoped === undefined ? env : { ...env, ctes: scoped.ctes }
	const using = writeItems(d, inScope, "delete using")
	const scope: Env = { ...inScope, visible: [rel, ...(using?.rels ?? [])] }
	const where = d.keep("where") ? exprOf(d, scope, "boolean", 0) : undefined
	const returned = returningOf(
		d,
		withItems(tableItems(rel.alias, t), [
			...columnItems(using?.rels ?? []),
			...imageItems(rel, ["old"])
		]),
		required,
		top
	)
	return {
		statement: {
			kind: "delete",
			...withOf(scoped),
			table: { schema: t.schema, name: t.name },
			alias: rel.alias,
			using: using === undefined ? [] : using.items,
			where,
			returning: returned === undefined ? [] : returned.returning
		},
		returned
	}
}

/**
 * MERGE INTO t AS r USING ... ON ... with one to three WHEN clauses. A WHEN NOT MATCHED clause sees the source
 * alone and a WHEN NOT MATCHED BY SOURCE clause the target alone; a WHEN without a condition is the last of its
 * match, as PostgreSQL requires.
 */
const mergeOf = (
	d: Draw,
	env: Env,
	required: boolean,
	top: boolean,
	scoped: Scoped | undefined
): Write => {
	const { table: t, rel } = targetOf(d)
	const inScope: Env = scoped === undefined ? env : { ...env, ctes: scoped.ctes }
	const source = entryOf(d, { ...inScope, visible: [] }, [])
	const [using] = source.items
	/** A WHEN clause's condition and values hold no subquery, which PostgreSQL refuses in a MERGE WHEN. */
	const both: Env = { ...inScope, visible: [rel, ...source.rels], depth: maxQueryDepth }
	const matches: Arr.NonEmptyReadonlyArray<MergeWhen["match"]> = [
		d.from(mergeMatches),
		...Array.from({ length: d.count(0, 2) }, () => d.from(mergeMatches))
	]
	/**
	 * The action is drawn before the row, so a DO NOTHING draws no value: a parameter drawn for a row it discards
	 * would leave its number unused.
	 */
	const whenOf = (match: MergeWhen["match"], i: number): MergeWhen => {
		const sees: Env =
			match === "MATCHED"
				? both
				: {
						...inScope,
						visible: match === "NOT MATCHED" ? source.rels : [rel],
						depth: maxQueryDepth
					}
		const last = !matches.slice(i + 1).includes(match)
		const condition = !last || d.keep("where") ? exprOf(d, sees, "boolean", 0) : undefined
		if (match === "NOT MATCHED") {
			if (d.from([false, true])) {
				return { match, condition, action: { kind: "doNothing" } }
			}
			return d.keep("zero width")
				? { match, condition, action: { kind: "insertDefault" } }
				: {
						match,
						condition,
						action: {
							kind: "insert",
							row: Arr.map(t.columns, (c): Assignment => ({
								column: c.name,
								value: exprOf(d, sees, c.type, 0)
							})),
							overriding: undefined
						}
					}
		}
		const action = d.from(["update", "delete", "nothing"] as const)
		return {
			match,
			condition,
			action:
				action === "update"
					? { kind: "update", set: assignmentsOf(d, sees, t) }
					: action === "delete"
						? { kind: "delete" }
						: { kind: "doNothing" }
		}
	}
	const [firstMatch, ...restMatches] = matches
	const whens: Arr.NonEmptyReadonlyArray<MergeWhen> = [
		whenOf(firstMatch, 0),
		...Arr.map(restMatches, (match, i) => whenOf(match, i + 1))
	]
	const inserts = Arr.some(
		whens,
		(w) => w.action.kind === "insert" || w.action.kind === "insertDefault"
	)
	const deletes = Arr.some(whens, (w) => w.action.kind === "delete")
	const sourceless = Arr.some(whens, (w) => w.match === "NOT MATCHED BY SOURCE")
	const sides = [...(inserts ? [] : (["old"] as const)), ...(deletes ? [] : (["new"] as const))]
	const action: Returnable = { expr: { kind: "mergeAction" }, type: "text" }
	const returned = returningOf(
		d,
		withItems(tableItems(rel.alias, t), [
			action,
			...(sourceless ? [] : columnItems(source.rels)),
			...imageItems(rel, sides)
		]),
		required,
		top
	)
	const on = joinCondition(d, [rel], source.rels)
	return {
		statement: {
			kind: "merge",
			...withOf(scoped),
			table: { schema: t.schema, name: t.name },
			alias: rel.alias,
			using,
			on,
			whens,
			returning: returned === undefined ? [] : returned.returning
		},
		returned
	}
}

type WriteKind = "insert" | "update" | "delete" | "merge"

const writeOf = (
	d: Draw,
	kind: WriteKind,
	env: Env,
	required: boolean,
	top: boolean,
	scoped: Scoped | undefined
): Write =>
	d.span(`write ${kind}`, () => {
		switch (kind) {
			case "insert":
				return insertOf(d, env, required, top, scoped)
			case "update":
				return updateOf(d, env, required, top, scoped)
			case "delete":
				return deleteOf(d, env, required, top, scoped)
			case "merge":
				return mergeOf(d, env, required, top, scoped)
		}
	})

const writeKinds: ReadonlyArray<readonly [StatementFeature, WriteKind]> = [
	["insert", "insert"],
	["update", "update"],
	["delete", "delete"],
	["merge", "merge"]
]

/**
 * The statement's own WITH: its query CTEs, and a data-modifying CTE when one is drawn, the only WITH that may hold
 * one. A data-modifying CTE is named by its RETURNING aliases. A MERGE's WITH is never recursive: PostgreSQL refuses
 * WITH RECURSIVE on a MERGE (42601).
 */
const statementWith = (d: Draw, env: Env, kind: "select" | WriteKind): Scoped | undefined => {
	const queries = ctesOf(d, env, kind !== "merge")
	const writes = Arr.map(
		Arr.filter(writeKinds, ([feature]) => d.on(feature)),
		([, write]) => write
	)
	const kinds = nonEmpty(writes)
	if (kinds === undefined || !d.keep("data-modifying cte")) {
		return queries
	}
	const inner: Env = { ...env, ctes: queries?.ctes ?? [], depth: env.depth + 1 }
	const write = writeOf(d, d.from(kinds), inner, true, false, undefined)
	if (write.returned === undefined) {
		throw new Error("a data-modifying CTE's write drew no RETURNING")
	}
	const name = d.relation()
	const cte: Cte = { name, query: write.statement, columns: [], materialized: undefined }
	const columns = write.returned.columns
	return {
		with: {
			recursive: queries?.with.recursive === true,
			ctes: Arr.append(queries === undefined ? [] : queries.with.ctes, cte)
		},
		ctes: [...(queries?.ctes ?? []), { name, columns }]
	}
}

/** The statement a swarm draws over a catalog: a SELECT or one of the writes it turns on, under its own WITH. */
const statementUnder =
	(catalog: SqlCatalog, drawn: Swarm<StatementFeature>): Gen<SqlStatement> =>
	(source) => {
		const d = new Draw(source, catalog, drawn)
		const env: Env = { visible: [], ctes: [], depth: 0 }
		const kind = d.choose<"select" | WriteKind>("select", writeKinds)
		const scoped = statementWith(d, env, kind)
		if (kind === "select") {
			return queryOf(d, env, undefined, true, scoped).select
		}
		return writeOf(d, kind, env, false, true, scoped).statement
	}

/**
 * Statements over a catalog, valid by construction.
 *
 * `statementGen` extends the query generator to every query and write form the statement audit admits: WITH
 * (query CTEs, MATERIALIZED, a bounded recursive CTE, and a data-modifying CTE in the statement's own WITH), set
 * operations whose arms may be parenthesized queries with clauses of their own, derived, lateral, VALUES and
 * input arrays FROM items and CTE references, inner and cross joins, grouped cores with aggregates (an aggregate's own
 * ORDER BY among them), HAVING, FILTER and WITHIN GROUP, window calls with ROWS frames that always hold the current
 * row, DISTINCT and DISTINCT ON, ORDER BY, LIMIT, OFFSET, correlated EXISTS, IN and scalar subqueries, and INSERT,
 * UPDATE, DELETE and MERGE with ON CONFLICT, FROM, USING, every WHEN form and RETURNING; a double literal, NaN, the
 * infinities and -0 among its values, cast to numeric; and the zero-width forms PostgreSQL spells by absence: input
 * arrays, a derived table, a CTE and a function item of no column, cores of no target, an INSERT of no column and
 * a MERGE's INSERT DEFAULT VALUES. A statement is a swarm over `statementFeatures` and the decisions drawn under it in
 * order, each bounded by what the statement drawn so far allows, the first option of each
 * the simplest; so any tape draws a valid statement, and a failing one shrinks by deleting and lowering decisions, an
 * expression, a FROM entry, a core, a query or a write at a time. It is valid on PostgreSQL too: only the forms
 * PostgreSQL accepts are drawn (no aggregate of an outer column, grouped outputs only of keys and aggregates, an
 * unconditional MERGE WHEN only last of its kind and no subquery in one, a frame that never leaves its current row
 * empty).
 * A table's first column is its key: an ON CONFLICT names it, so a database that runs the statements gives each
 * table its primary key there. Nothing NULL-yielding is drawn: an ungrouped aggregate is count(*) alone, a scalar
 * subquery is a count.
 */
export const statementGen =
	(catalog: SqlCatalog): Gen<SqlStatement> =>
	(source) =>
		source.draw(statementUnder(catalog, source.draw(swarm(statementFeatures))))

/**
 * The features that put an output other than a column in a plain core, or make the statement a write: a literal or a
 * parameter at a leaf, every expression form over a non-boolean type, a window, an aggregate and a grouping, and the
 * writes.
 */
const valueShaping: ReadonlyArray<StatementFeature> = [
	"insert",
	"update",
	"delete",
	"merge",
	"literal",
	"param",
	"arithmetic",
	"case",
	"cast",
	"greatest",
	"coalesce",
	"concat",
	"collate",
	"scalar subquery",
	"window",
	"aggregate",
	"group by"
]

/**
 * SELECTs whose body is a set operation: the swarm drawn as `statementGen` draws it, then the set operation turned on
 * at full weight and every value-shaping feature turned off, the rest of the swarm (joins, derived and lateral items,
 * VALUES, CTEs, WHERE, DISTINCT, ORDER BY, LIMIT, a parenthesized arm) as it came. A plain core's output is then a
 * column, but for a boolean one, which is a comparison, and one of a type no FROM item has a column of, which is a
 * literal; so about one statement in four has a first arm whose distinct columns the set operation's output names pass
 * through, a shape `statementGen` draws about one statement in two hundred.
 */
export const columnSetOperationGen =
	(catalog: SqlCatalog): Gen<SqlStatement> =>
	(source) => {
		const drawn = source.draw(swarm(statementFeatures))
		const on: Partial<Record<StatementFeature, Presence>> = { "set operation": 3 }
		for (const feature of statementFeatures) {
			const weight = drawn[feature]
			if (weight !== undefined && feature !== "set operation" && !valueShaping.includes(feature)) {
				on[feature] = weight
			}
		}
		return source.draw(statementUnder(catalog, on))
	}

/**
 * A statement as a planted case states it: the swarm it is drawn under, a literal such as `{ merge: 3, returning: 3 }`
 * or `fullSwarm(on)`, and the decisions `statementGen` takes after its swarm, in order. A decision past the tape's end,
 * or outside the bounds the statement drawn so far gives it, takes its simplest value, the first option, so every
 * sketch resolves to a valid statement, and an empty tape to the simplest statement of its swarm.
 */
export interface StatementSketch {
	readonly swarm: Swarm<StatementFeature>
	readonly tape: ReadonlyArray<number>
}

/**
 * The statement a sketch resolves to over a catalog: the one `statementGen` draws when its swarm comes out as the
 * sketch's and the decisions after it are the sketch's tape.
 */
export const resolveStatement = (catalog: SqlCatalog, sketch: StatementSketch): SqlStatement =>
	generate(
		recorder(),
		statementUnder(catalog, sketch.swarm),
		forcedChooser(Float64Array.from(sketch.tape), sketch.tape.length)
	).value
