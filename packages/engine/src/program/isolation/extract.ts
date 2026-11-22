import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import type {
	CteFacts,
	CteUse,
	ReadGroup,
	MemberFacts,
	ProbeFact,
	ReadAt,
	ReadFact,
	RowSource,
	SiteCore,
	StatementFacts,
	WriteFact
} from "#compiler/analysis/isolation/facts.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { overRowsOf } from "#compiler/lower/conservative/expr/lateral.ts"
import type {
	Assignment,
	CteBody,
	Delete,
	Expr,
	FromItem,
	FromSource,
	FunctionCall,
	Insert,
	JoinStep,
	Merge,
	MergeWhen,
	ObjectName,
	OperandBody,
	OperandSelect,
	OrderItem,
	ProbeColumn,
	QualifiedFunctionRef,
	SetOperation,
	SqlStatement,
	TableName,
	Update,
	WindowSpec,
	With
} from "#compiler/sql/ast.ts"
import { col, eq } from "#compiler/sql/build.ts"
import { printObjectName } from "#compiler/sql/print.ts"

/**
 * How the extractor reads one role's statements back:
 *
 * - `relationOf`: the relation, by its declared name, a stored table or the role's view is; none for a table the
 *   installation states no relation of, and none for one the role reaches under a row policy that reads another
 *   relation's table, whose reads no statement shows;
 * - `fieldOf`: the field a column of a relation's table is, none for a column of no field (a law column);
 * - `readsNoTable`: whether a schema function a statement calls reads no relation's table, as a refusal, a constant, a
 *   vector reads none; a world's filter function reads the relations of its membership;
 * - `retirementOf`: the tables a retirable unit's retirement function writes, its header's and its bodies', none for any
 *   other function: a call of it is the unit's retirement (analysis/isolation/facts.ts WriteFact `retire`), which reads
 *   no row besides the groups it locks;
 * - `arbitersOf`: the columns of each object an ON CONFLICT DO NOTHING with no target arbitrates on a relation's table,
 *   its primary key, each UNIQUE and each span key, each by the columns of its fields, a law column's left out.
 */
export interface ExtractNames {
	readonly relationOf: (table: ObjectName) => string | undefined
	readonly fieldOf: (relation: string, column: string) => string | undefined
	readonly readsNoTable: (fn: QualifiedFunctionRef) => boolean
	readonly retirementOf: (fn: QualifiedFunctionRef) => ReadonlyArray<ObjectName> | undefined
	readonly arbitersOf: (relation: string) => ReadonlyArray<ReadonlyArray<string>>
}

/**
 * How the rows a read finds reach what its statement does: by their presence, by their absence, or either way, where
 * they reach a value or a branch.
 */
type Polarity = "positive" | "negated" | "both"

/**
 * What a name a core sees is: a stored table's alias, whose values the statement reads, or an own source's, whose
 * values are the call's own: the session's context, one row (`one`), or a carrier, a CTE, a relation input's arrays, a
 * VALUES list, a function's or a derived table's rows, any number of rows (`many`), or an INSERT's met rows, any number
 * of them, named by their source, which a `met` source reads through.
 */
type Scope = ReadonlyMap<string, "table" | ReadGroup["rows"] | MetRows>

/** A source of the rows an INSERT proposed and did not insert (sql/ast.ts FromSource `metRows`). */
type MetRows = Extract<FromSource, { readonly kind: "metRows" }>

/** The row an INSERT's arbitration met for a met row (sql/ast.ts FromSource `met`). */
type Met = Extract<FromSource, { readonly kind: "met" }>

/** A condition with the names it sees, which a condition pushed into a derived table keeps from where it stands. */
interface Scoped {
	readonly expr: Expr
	readonly scope: Scope
}

/** A column a read's conditions bind, with what it is bound to and how many values that takes for the call. */
interface Bound {
	readonly column: string
	readonly by: string
	readonly rows: ReadGroup["rows"]
}

/**
 * What a CTE name refers to: a query, read where a source names it, under the scope and the CTEs it was defined in; a
 * data-modifying CTE, whose RETURNING rows are the call's: the rows it makes, and an INSERT's ON CONFLICT DO SELECT's
 * rows its arbitration met, the arbitration's own read (`arbitrations`), whose values bind no read as one value, a
 * column of them binding one group per row; or a recursive CTE's own working rows.
 */
type CteRef =
	| {
			readonly kind: "query"
			readonly query: OperandSelect
			readonly columns: ReadonlyArray<string>
			readonly scope: Scope
			readonly ctes: Ctes
	  }
	| { readonly kind: "write"; readonly body: Exclude<CteBody, { readonly kind: "select" }> }
	| { readonly kind: "own" }

type Ctes = ReadonlyMap<string, CteRef>

const ownRows: CteRef = { kind: "own" }

/**
 * What a body's walk stands in outside every core of its own: nothing, for a statement's own body, or the core of the
 * site that reads a query CTE's instance (`site`, analysis/isolation/facts.ts SiteCore).
 */
type Arrival = "site" | undefined

/**
 * The writes a place's reads feed and its probes gate, as a walk records them: those its statement's own writes name,
 * or, in the walk of a query CTE's query, the site's (`site`): the writes the site that reads an instance of it feeds,
 * which each instance names (Statement.instance), since a query CTE's query writes nothing of its own.
 */
type Feeds = ReadonlyArray<number> | "site"

/** The writes `feeds` names where its body arrives from a site feeding `arrival`. */
const fedAt = (feeds: Feeds, arrival: ReadonlyArray<number>): ReadonlyArray<number> =>
	feeds === "site" ? arrival : feeds

/** A probe as a walk records it (ProbeFact), the writes it gates as its place feeds them (Feeds). */
interface WalkProbe<Core extends SiteCore> {
	readonly gates: Feeds
	readonly core: Core
	readonly chain: ReadonlyArray<number>
}

/**
 * Where an expression or a source stands: the polarity its reads reach the statement with, whether a count or an
 * aggregate stands over them, whether it is a source of the core an EXISTS probes, whether an expression is a
 * condition of its core (WHERE, ON or HAVING, through AND, OR, NOT and IS TRUE), the names and CTEs it sees, the probes
 * of its body it stands beneath, and the innermost core of its body it stands in, its body's arrival (`Top`) outside
 * every core.
 */
interface Context<Top extends Arrival = Arrival> {
	readonly polarity: Polarity
	readonly counted: boolean
	readonly probe: boolean
	readonly condition: boolean
	readonly scope: Scope
	readonly ctes: Ctes
	readonly probes: ReadonlyArray<number>
	readonly core: number | Top
}

const top: Context<undefined> = {
	polarity: "positive",
	counted: false,
	probe: false,
	condition: false,
	scope: new Map(),
	ctes: new Map(),
	probes: [],
	core: undefined
}

const flipped = (p: Polarity): Polarity => {
	switch (p) {
		case "positive":
			return "negated"
		case "negated":
			return "positive"
		case "both":
			return "both"
	}
}

/** An expression's place as a value: a read under it reaches the statement either way. */
const valued = <C extends Context>(c: C): C => ({ ...c, condition: false, probe: false })

/** The polarity of a subquery's rows under a predicate, NOT EXISTS or NOT IN flipping it; either way in a value. */
const predicate = (c: Context, not: boolean): Polarity => {
	if (!c.condition) {
		return "both"
	}
	return not ? flipped(c.polarity) : c.polarity
}

/**
 * One read a walk finds: a table source, with where it stands, the conditions of its core and the writes its rows
 * feed; or a read no statement shows, a schema function's or a statement's no names clear, by its placeholder name,
 * which may reach the statement either way.
 */
type Found =
	| {
			readonly kind: "table"
			readonly table: TableName
			readonly alias: string
			readonly context: Context
			readonly conditions: ReadonlyArray<Scoped>
			readonly feeds: Feeds
			readonly columns: ReadonlyMap<string, string> | undefined
			/**
			 * The key columns it reads the row its statement's INSERT met at, where its structure proves that INSERT met it
			 * (`metSealed`), none for any other read.
			 */
			readonly met: ReadonlyArray<string> | undefined
	  }
	| {
			readonly kind: "opaque"
			readonly relation: string
			readonly probes: ReadonlyArray<number>
	  }

/** An INSERT's ON CONFLICT arbitration of the table it writes: its conflict columns, none for a constraint's. */
interface Arbitration {
	readonly table: ObjectName
	readonly columns: ReadonlyArray<string> | undefined
	readonly values: ReadonlyMap<string, string>
}

/** The parts of one core the walk reads. */
interface CoreParts {
	readonly from: ReadonlyArray<FromItem>
	readonly where: Expr | undefined
	readonly having: Expr | undefined
	readonly values: ReadonlyArray<Expr>
	readonly grouped: boolean
	readonly groups: boolean
}

/** The conjuncts of a condition: an AND's arguments, flattened, or the condition itself. */
const conjunctsOf = (e: Expr | undefined): ReadonlyArray<Expr> => {
	if (e === undefined) {
		return []
	}
	return e.kind === "and" ? e.args.flatMap(conjunctsOf) : [e]
}

const orderExprs = (items: ReadonlyArray<OrderItem>): ReadonlyArray<Expr> =>
	items.map((o) => o.expr)

const windowOperands = (w: WindowSpec | undefined): ReadonlyArray<Expr> =>
	w === undefined ? [] : [...w.partitionBy, ...orderExprs(w.orderBy)]

const callOperands = (e: FunctionCall): ReadonlyArray<Expr> => {
	if (e.star) {
		return [...(e.filter === undefined ? [] : [e.filter]), ...windowOperands(e.over)]
	}
	return [
		...e.args,
		...orderExprs(e.orderBy),
		...orderExprs(e.withinGroup),
		...windowOperands(e.over)
	]
}

/** The expressions an expression holds as its own operands; a subquery's are its query's, none of them. */
const operandsOf = (e: Expr): ReadonlyArray<Expr> => {
	switch (e.kind) {
		case "and":
		case "or":
		case "greatest":
		case "least":
		case "coalesce":
			return e.args
		case "not":
		case "isTrue":
		case "cast":
		case "collate":
		case "negate":
		case "complement":
		case "lowerAscii":
			return [e.expr]
		case "binary":
			return [e.left, e.right]
		case "nullif":
			return [e.expr, e.absent]
		case "subscript":
			return [e.array, e.index]
		case "between":
			return [e.expr, e.low, e.high]
		case "inList":
			return [e.expr, ...e.list]
		case "inQuery":
			return [e.expr]
		case "equalsAny":
			return [e.expr, e.array]
		case "row":
			return e.items
		case "case":
			return [
				...(e.operand === undefined ? [] : [e.operand]),
				...e.whens.flatMap((w) => [w.when, w.result]),
				e.else
			]
		case "call":
			return callOperands(e)
		case "exists":
		case "subquery":
		case "array":
		case "column":
		case "domainValue":
		case "excluded":
		case "field":
		case "literal":
		case "mergeAction":
		case "param":
		case "clock":
		case "plSpecial":
		case "plVar":
		case "regclass":
		case "returning":
		case "user":
			return []
	}
}

/** Whether an expression computes over many rows in its own operands (overRowsOf), a subquery's calls its own. */
const holdsRows = (e: Expr): boolean => overRowsOf(e) !== undefined || operandsOf(e).some(holdsRows)

/**
 * A FROM source with its join: `inner`, the first source, an inner join's with its ON condition or a cross join's with
 * none, every row of the core coming through it and its condition keying every source's read; or `left`, a LEFT JOIN's,
 * read where its condition holds, which keys its own read alone: the sources before it are read whatever its condition,
 * and a row of the core comes through it only where it met one, so no row is said to come through it.
 */
type JoinedSource =
	| { readonly join: "inner"; readonly source: FromSource; readonly on: Expr | undefined }
	| { readonly join: "left"; readonly source: FromSource; readonly on: Expr }

/** A join step's source with its join (JoinedSource). */
const stepSource = (step: JoinStep): JoinedSource => {
	switch (step.kind) {
		case "on":
			return { join: "inner", source: step.source, on: step.on }
		case "cross":
			return { join: "inner", source: step.source, on: undefined }
		case "left":
			return { join: "left", source: step.source, on: step.on }
	}
}

/** A FROM's sources, each with its join (JoinedSource), the first's inner with no condition. */
const sourcesOf = (from: ReadonlyArray<FromItem>): ReadonlyArray<JoinedSource> =>
	from.flatMap((item): ReadonlyArray<JoinedSource> =>
		item.kind === "joins"
			? [{ join: "inner", source: item.first, on: undefined }, ...item.steps.map(stepSource)]
			: [{ join: "inner", source: item, on: undefined }]
	)

/** The conditions of a FROM's inner joins, which key every source's read. */
const innerConditions = (sources: ReadonlyArray<JoinedSource>): ReadonlyArray<Expr> =>
	sources.flatMap((s) => (s.join === "inner" ? conjunctsOf(s.on) : []))

/** A relation's table read whole by a derived table that only renames its columns: the table, and for each of the
 * derived table's columns the table's column it is. */
interface Projection {
	readonly table: TableName
	readonly columns: ReadonlyMap<string, string>
}

/** A projection as the source of another: its table, and the table's column each of its columns is. */
const underOf = (
	p: Projection | undefined
):
	| { readonly table: TableName; readonly column: (column: string) => string | undefined }
	| undefined => (p === undefined ? undefined : { table: p.table, column: (c) => p.columns.get(c) })

/**
 * The relation a derived table reads whole, its columns renamed, through any number of such: a core of one source, a
 * table or another such derived table, every target a column of it, under no WITH, condition, grouping, HAVING,
 * DISTINCT, ORDER BY, LIMIT or OFFSET, so its rows are the source's rows, each column one of the source's. None for any
 * other derived table, whose reads its own walk keys by its own conditions alone.
 */
const projectionOf = (source: FromSource): Projection | undefined => {
	if (source.kind !== "derived") {
		return undefined
	}
	const q = source.query
	const body = q.body
	if (
		q.with !== undefined ||
		q.orderBy.length > 0 ||
		q.limit !== undefined ||
		q.offset !== undefined ||
		body.kind !== "core" ||
		body.where !== undefined ||
		body.groupBy.length > 0 ||
		body.having !== undefined ||
		body.distinct !== false
	) {
		return undefined
	}
	const [item, ...rest] = body.from
	if (item === undefined || rest.length > 0 || item.kind === "joins") {
		return undefined
	}
	const under =
		item.kind === "table"
			? { table: item.table, column: (column: string): string | undefined => column }
			: underOf(projectionOf(item))
	if (under === undefined) {
		return undefined
	}
	const names = source.columns.length > 0 ? source.columns : body.targets.map((t) => t.alias)
	if (names.length !== body.targets.length) {
		return undefined
	}
	const columns = new Map<string, string>()
	for (const [i, t] of body.targets.entries()) {
		const name = names[i]
		const base =
			t.expr.kind === "column" && t.expr.table === item.alias
				? under.column(t.expr.column)
				: undefined
		if (name === undefined || base === undefined) {
			return undefined
		}
		columns.set(name, base)
	}
	return { table: under.table, columns }
}

/**
 * Whether a derived table's query keeps every row of its one core as one row of its own: no WITH, grouping, HAVING,
 * DISTINCT, LIMIT or OFFSET, and no call over many rows, so a condition over its rows is a condition over its source's.
 */
const rowPreserving = (q: OperandSelect): boolean => {
	const body = q.body
	return (
		q.with === undefined &&
		q.limit === undefined &&
		q.offset === undefined &&
		body.kind === "core" &&
		body.groupBy.length === 0 &&
		body.having === undefined &&
		body.distinct === false &&
		![...body.targets.map((t) => t.expr), ...conjunctsOf(body.where)].some(holdsRows)
	)
}

/**
 * The equalities of the core a derived table stands in that bind its columns, carried into its core: each column that
 * is a column of the core's sources named as that column, the other side seeing the names it saw. None where the
 * derived table keeps no row as its own (rowPreserving), so a group binds through it only where it filters its rows.
 */
const pushedInto = (
	source: Extract<FromSource, { readonly kind: "derived" }>,
	conditions: ReadonlyArray<Scoped>
): ReadonlyArray<Scoped> => {
	const body = source.query.body
	if (!rowPreserving(source.query) || body.kind !== "core") {
		return []
	}
	const names = source.columns.length > 0 ? source.columns : body.targets.map((t) => t.alias)
	const lineage = (e: Expr): Expr | undefined => {
		if (e.kind !== "column" || e.table !== source.alias) {
			return undefined
		}
		const target = body.targets[names.indexOf(e.column)]
		return target?.expr.kind === "column" ? target.expr : undefined
	}
	return conditions.flatMap(({ expr, scope }): ReadonlyArray<Scoped> => {
		if (expr.kind !== "binary" || expr.op !== "=") {
			return []
		}
		const left = lineage(expr.left)
		const right = lineage(expr.right)
		if (left !== undefined && right === undefined) {
			return [{ expr: { ...expr, left }, scope }]
		}
		return right !== undefined && left === undefined ? [{ expr: { ...expr, right }, scope }] : []
	})
}

/**
 * What a source's alias names: a stored table's values, a derived table's that only renames one's columns among them,
 * or the call's own, of one row or many.
 */
const nameOf = (source: FromSource): readonly [string, "table" | ReadGroup["rows"] | MetRows] => {
	switch (source.kind) {
		case "table":
			return [source.alias, typeof source.table === "string" ? "many" : "table"]
		case "cte":
			return [source.alias ?? source.name, "many"]
		case "context":
			return [source.alias, "one"]
		case "probe":
		case "met":
			return [source.alias, "table"]
		case "metRows":
			return [source.alias, source]
		case "derived": {
			const projection = projectionOf(source)
			return [
				source.alias,
				projection === undefined || typeof projection.table === "string" ? "many" : "table"
			]
		}
		case "enclosing":
		case "transition":
		case "function":
		case "arrays":
		case "values":
			return [source.alias, "many"]
	}
}

/** A parameter's canonical name: the declared parameter it carries, else its number. */
const paramName = (n: number, paramOf: (n: number) => string | undefined): string => {
	const named = paramOf(n)
	return named === undefined ? `$${n}` : `:${named}`
}

/**
 * The canonical name of what a placeholder carries, where `e` is one: a slot's parameter (paramName), or the declared
 * parameter a clock reading binds, which is one value for the call as a parameter is, so a column equal to it is bound
 * to one value; a stamp's reading binds none.
 */
const placeholderName = (
	e: Expr,
	paramOf: (n: number) => string | undefined
): string | undefined => {
	if (e.kind === "param") {
		return paramName(e.slot.number, paramOf)
	}
	return e.kind === "clock" && e.of.kind === "param" ? `:${e.of.param}` : undefined
}

/** The query and column names a source of the call's own rows reads, a derived table's or a query CTE's; none else. */
const definedOf = (
	source: FromSource,
	ctes: Ctes
):
	| { readonly query: OperandSelect; readonly columns: ReadonlyArray<string>; readonly ctes: Ctes }
	| undefined => {
	if (source.kind === "derived") {
		return { query: source.query, columns: source.columns, ctes }
	}
	if (source.kind !== "cte" && source.kind !== "enclosing") {
		return undefined
	}
	const ref = ctes.get(source.name)
	return ref?.kind === "query"
		? { query: ref.query, columns: ref.columns, ctes: ref.ctes }
		: undefined
}

/**
 * The parameter an expression's value carries for the call, by its canonical name, through casts and the targets of
 * the call's own cores it reads, a derived table's or a query CTE's of one core: none where it reaches anything else,
 * a stored table's column, a relation input's or a computed value.
 */
const valueOf = (
	e: Expr,
	from: ReadonlyArray<FromItem>,
	ctes: Ctes,
	paramOf: (n: number) => string | undefined
): string | undefined => {
	if (e.kind === "cast" || e.kind === "collate") {
		return valueOf(e.expr, from, ctes, paramOf)
	}
	const placeholder = placeholderName(e, paramOf)
	if (placeholder !== undefined) {
		return placeholder
	}
	if (e.kind !== "column" || e.table === undefined) {
		return undefined
	}
	const alias = e.table
	const source = sourcesOf(from)
		.map((s) => s.source)
		.find((s) => nameOf(s)[0] === alias)
	const defined = source === undefined ? undefined : definedOf(source, ctes)
	const body = defined?.query.body
	if (defined === undefined || body?.kind !== "core" || defined.query.with !== undefined) {
		return undefined
	}
	const names = defined.columns.length > 0 ? defined.columns : body.targets.map((t) => t.alias)
	const target = body.targets[names.indexOf(e.column)]
	return target === undefined ? undefined : valueOf(target.expr, body.from, defined.ctes, paramOf)
}

/** The parameter each column an INSERT writes carries, where its source, one core or one VALUES row, gives one. */
const insertValues = (
	s: Insert,
	ctes: Ctes,
	paramOf: (n: number) => string | undefined
): ReadonlyMap<string, string> => {
	const out = new Map<string, string>()
	const row = (
		i: number
	): { readonly expr: Expr; readonly from: ReadonlyArray<FromItem> } | undefined => {
		if (s.source.kind === "values") {
			const [only, ...rest] = s.source.rows
			const expr = rest.length === 0 ? only[i] : undefined
			return expr === undefined ? undefined : { expr, from: [] }
		}
		const q = s.source.query
		const target = q.with === undefined && q.body.kind === "core" ? q.body.targets[i] : undefined
		return target === undefined || q.body.kind !== "core"
			? undefined
			: { expr: target.expr, from: q.body.from }
	}
	for (const [i, column] of s.columns.entries()) {
		const at = row(i)
		const value = at === undefined ? undefined : valueOf(at.expr, at.from, ctes, paramOf)
		if (value !== undefined) {
			out.set(column, value)
		}
	}
	return out
}

/** The write a MERGE's WHEN clause makes, none for DO NOTHING. */
const mergeOp = (w: MergeWhen): WriteFact["op"] | undefined => {
	switch (w.action.kind) {
		case "update":
			return "update"
		case "delete":
			return "delete"
		case "insert":
		case "insertDefault":
			return "insert"
		case "doNothing":
			return undefined
	}
}

/** The values a MERGE's WHEN clause assigns. */
const assignmentsOf = (w: MergeWhen): ReadonlyArray<Assignment> => {
	switch (w.action.kind) {
		case "update":
			return w.action.set
		case "insert":
			return w.action.row
		case "insertDefault":
		case "delete":
		case "doNothing":
			return []
	}
}

/** The conditions a MERGE's target is read under for one WHEN clause. */
const targetConditions = (w: MergeWhen, on: ReadonlyArray<Expr>): ReadonlyArray<Expr> => {
	switch (w.match) {
		case "MATCHED":
			return [...on, ...conjunctsOf(w.condition)]
		case "NOT MATCHED":
			return on
		case "NOT MATCHED BY SOURCE":
			return conjunctsOf(w.condition)
	}
}

/**
 * The walk of one body of a statement: every read it makes, with where it stands, every probe it opens and every core
 * it holds, each by its place in the body, and every query CTE it reads (`uses`). The statement's writes, its ON
 * CONFLICT arbitrations and the instances of its query CTEs are the statement's (Statement). A query CTE is read where
 * a source names it, through the instance of it its arrival there keys (Statement.instance), walked once, so its reads
 * compose with each place it is read in; a data-modifying one runs once, where it is defined. A statement's own body
 * stands in no core outside its cores (`Top` none), an instance in the core of the site that reads it (`Top` `site`).
 * It lives as long as its statement's extraction: no fact holds it (test/unit/program/isolation/facts-retention.test.ts).
 */
export class Walk<Top extends Arrival> {
	readonly found: Array<Found> = []
	readonly probes: Array<WalkProbe<number | Top>> = []
	readonly cores: Array<ReadonlyArray<RowSource>> = []
	readonly uses: Array<CteUse> = []
	readonly #statement: Statement
	readonly #arrival: Feeds
	readonly #feeding: Array<ReadonlyArray<number>> = []

	/**
	 * A walk of a body of `statement` whose reads feed the writes `arrival` outside every write of its own: the
	 * statement's own body's none, a query CTE's query's the site's (Feeds `site`).
	 */
	constructor(statement: Statement, arrival: Feeds) {
		this.#statement = statement
		this.#arrival = arrival
	}

	/** The walk of a statement's own body, from its top. */
	statement(this: Walk<undefined>, s: SqlStatement): void {
		if (s.kind === "select") {
			this.query(s, top)
			return
		}
		if (s.kind === "insert" || s.kind === "update" || s.kind === "delete" || s.kind === "merge") {
			this.#modifying(s, top)
			return
		}
		if (
			s.kind === "createCarrier" ||
			s.kind === "beginRead" ||
			s.kind === "beginWrite" ||
			s.kind === "commit" ||
			s.kind === "rollback" ||
			s.kind === "setConstraintsImmediate"
		) {
			return
		}
		this.#opaque(
			s.kind === "refresh" ? `?refresh:${printObjectName(s.view)}` : `?statement:${s.kind}`,
			top
		)
	}

	#opaque(relation: string, c: Context<Top>): void {
		this.found.push({ kind: "opaque", relation, probes: c.probes })
	}

	/**
	 * The context `next`, entered from `c`: where it flips the polarity or starts a count, it opens a probe of its own,
	 * gating the writes its place feeds, beneath every probe `c` stands beneath.
	 */
	#entering(c: Context<Top>, next: Context<Top>): Context<Top> {
		return this.#opening(c, next, undefined)
	}

	/**
	 * `#entering`, the probe judged by `own`'s rows where a grouped core opens it: a group no row reaches yields no row of
	 * it. Any other probe is judged by the rows of the core it stands in, where its value lands, as an ungrouped count
	 * yields a row over no input; one that stands in no core is never neutral.
	 */
	#opening(c: Context<Top>, next: Context<Top>, own: number | undefined): Context<Top> {
		if (next.polarity === c.polarity && (c.counted || !next.counted)) {
			return next
		}
		const id = this.probes.length
		this.probes.push(
			own === undefined
				? { gates: this.#feeds(), core: c.core, chain: c.probes }
				: { gates: this.#feeds(), core: own, chain: [...c.probes, id] }
		)
		return { ...next, probes: [...c.probes, id] }
	}

	#modifying(body: CteBody, c: Context<Top>): void {
		switch (body.kind) {
			case "select":
				return
			case "insert":
				this.#insert(body, c)
				return
			case "update":
				this.#update(body, c)
				return
			case "delete":
				this.#delete(body, c)
				return
			case "merge":
				this.#merge(body, c)
				return
		}
	}

	/** The context a WITH's CTEs are seen in, and its data-modifying CTEs walked, each once. */
	#with(w: With | undefined, c: Context<Top>): Context<Top> {
		if (w === undefined) {
			return c
		}
		const ctes = new Map(c.ctes)
		for (const cte of w.ctes) {
			ctes.set(
				cte.name,
				cte.query.kind === "select"
					? { kind: "query", query: cte.query, columns: cte.columns, scope: c.scope, ctes }
					: { kind: "write", body: cte.query }
			)
		}
		const inner: Context<Top> = { ...c, ctes }
		for (const cte of w.ctes) {
			this.#modifying(cte.query, inner)
		}
		return inner
	}

	#writeOf(table: TableName, op: WriteFact["op"]): ReadonlyArray<number> {
		if (typeof table === "string") {
			return []
		}
		this.#statement.writes.push({ table, op })
		return [this.#statement.writes.length - 1]
	}

	#feedingWrites(at: ReadonlyArray<number>, f: () => void): void {
		this.#feeding.push(at)
		f()
		this.#feeding.pop()
	}

	#insert(s: Insert, c: Context<Top>): void {
		const inner = this.#with(s.with, c)
		const conflict = s.onConflict
		const at = [
			...this.#writeOf(s.table, "insert"),
			...(conflict?.action.kind === "doUpdate" ? this.#writeOf(s.table, "update") : [])
		]
		const scope: Scope =
			s.alias === undefined ? inner.scope : new Map([...inner.scope, [s.alias, "table"]])
		const after: Context<Top> = { ...inner, scope }
		this.#feedingWrites(at, () => {
			if (s.source.kind === "query") {
				this.query(s.source.query, inner)
			} else {
				for (const e of s.source.rows.flat()) {
					this.expr(e, valued(inner))
				}
			}
			const action = conflict?.action
			if (action?.kind === "doSelect" && action.where !== undefined) {
				this.expr(action.where, { ...after, condition: true })
			}
			if (action?.kind === "doUpdate") {
				for (const a of action.set) {
					this.expr(a.value, valued(after))
				}
				if (action.where !== undefined) {
					this.expr(action.where, { ...after, condition: true })
				}
			}
		})
		if (conflict !== undefined && typeof s.table !== "string") {
			const table = s.table
			if (conflict.kind === "every" && this.#statement.level === "readCommitted") {
				this.#opaque(`?every:${printObjectName(table)}`, c)
			} else {
				const values = insertValues(s, inner.ctes, this.#statement.paramOf)
				const relation = this.#statement.names.relationOf(table)
				const arbitrated: ReadonlyArray<ReadonlyArray<string> | undefined> =
					conflict.kind === "columns"
						? [conflict.columns]
						: conflict.kind === "every" && relation !== undefined
							? this.#statement.names.arbitersOf(relation)
							: [undefined]
				for (const columns of arbitrated) {
					this.#statement.arbitrations.push({ table, columns, values })
				}
			}
		}
		for (const t of s.returning) {
			this.expr(t.expr, valued(after))
		}
	}

	#update(s: Update, c: Context<Top>): void {
		const inner = this.#with(s.with, c)
		this.#feedingWrites(this.#writeOf(s.table, "update"), () =>
			this.#core(
				{
					from: [{ kind: "table", table: s.table, alias: s.alias }, ...s.from],
					where: s.where,
					having: undefined,
					values: [...s.set.map((a) => a.value), ...s.returning.map((t) => t.expr)],
					grouped: false,
					groups: false
				},
				inner,
				[]
			)
		)
	}

	#delete(s: Delete, c: Context<Top>): void {
		const inner = this.#with(s.with, c)
		this.#feedingWrites(this.#writeOf(s.table, "delete"), () =>
			this.#core(
				{
					from: [{ kind: "table", table: s.table, alias: s.alias }, ...s.using],
					where: s.where,
					having: undefined,
					values: s.returning.map((t) => t.expr),
					grouped: false,
					groups: false
				},
				inner,
				[]
			)
		)
	}

	/**
	 * A MERGE: its source's rows, read either way where a WHEN NOT MATCHED BY SOURCE acts on their absence, and its
	 * target read once per WHEN clause: matched positively under ON and the clause's condition, not matched as a probe
	 * of the absence ON binds, and not matched by source positively under the clause's condition alone.
	 */
	#merge(s: Merge, c: Context<Top>): void {
		const inner = this.#with(s.with, c)
		const at = s.whens.flatMap((w) => {
			const op = mergeOp(w)
			return op === undefined ? [] : this.#writeOf(s.table, op)
		})
		const using = sourcesOf([s.using])
		const scope: Scope = new Map([
			...inner.scope,
			[s.alias, "table"],
			...using.map(({ source }) => nameOf(source))
		])
		const here: Context<Top> = { ...inner, scope }
		const on = [...conjunctsOf(s.on), ...innerConditions(using)]
		const bySource = s.whens.some((w) => w.match === "NOT MATCHED BY SOURCE")
		this.#feedingWrites(at, () => {
			for (const { source } of using) {
				this.#source(
					source,
					bySource ? this.#entering(here, { ...here, polarity: "both" }) : here,
					on.map((expr) => ({ expr, scope })),
					inner.scope
				)
			}
			for (const w of s.whens) {
				this.found.push({
					kind: "table",
					table: s.table,
					alias: s.alias,
					context:
						w.match === "NOT MATCHED"
							? this.#entering(here, { ...here, polarity: flipped(here.polarity), probe: true })
							: here,
					conditions: targetConditions(w, on).map((expr) => ({ expr, scope })),
					feeds: this.#feeds(),
					columns: undefined,
					met: undefined
				})
			}
			for (const e of on) {
				this.expr(e, { ...here, condition: true })
			}
			for (const w of s.whens) {
				if (w.condition !== undefined) {
					this.expr(w.condition, { ...here, condition: true })
				}
				for (const a of assignmentsOf(w)) {
					this.expr(a.value, valued(here))
				}
			}
		})
		for (const t of s.returning) {
			this.expr(t.expr, valued(here))
		}
	}

	#feeds(): Feeds {
		return this.#feeding.at(-1) ?? this.#arrival
	}

	query(q: OperandSelect, c: Context<Top>): void {
		this.#query(q, c, [])
	}

	/** An instance's query, walked from its arrival: the row sources every row of it comes through. */
	cte(this: Walk<"site">, q: OperandSelect, c: Context<"site">): ReadonlyArray<RowSource> {
		return this.#query(q, c, [])
	}

	/**
	 * A query, its one core keying its reads by `pushed` too, conditions of the core it is a derived table of: the
	 * sources every row of it comes through (StatementFacts.cores).
	 */
	#query(
		q: OperandSelect,
		c: Context<Top>,
		pushed: ReadonlyArray<Scoped>
	): ReadonlyArray<RowSource> {
		const inner = this.#with(q.with, c)
		const rows = this.#body(q.body, inner, orderExprs(q.orderBy), pushed)
		for (const e of [q.limit, q.offset]) {
			if (e !== undefined) {
				this.expr(e, valued(inner))
			}
		}
		return rows
	}

	/**
	 * A query's body, with its query's ORDER BY: a core's own expressions, or values over a set operation's rows; the
	 * sources every row of it comes through, its core or its set operation's.
	 */
	#body(
		body: OperandBody,
		c: Context<Top>,
		order: ReadonlyArray<Expr>,
		pushed: ReadonlyArray<Scoped>
	): ReadonlyArray<RowSource> {
		if (body.kind === "core") {
			const core = this.#core(
				{
					from: body.from,
					where: body.where,
					having: body.having,
					values: [
						...body.targets.map((t) => t.expr),
						...body.groupBy,
						...(typeof body.distinct === "boolean" ? [] : body.distinct.on),
						...order
					],
					grouped: body.groupBy.length > 0 || body.having !== undefined,
					groups: body.groupBy.length > 0
				},
				c,
				pushed
			)
			return [{ kind: "core", core }]
		}
		const rows = body.kind === "setOp" ? this.#setOp(body, c) : this.#query(body, c, [])
		for (const e of order) {
			this.expr(e, valued(c))
		}
		return rows
	}

	/**
	 * A set operation's arms: an EXCEPT's later arms remove rows, so their reads reach it by their absence. A UNION's
	 * rows come through its arms, each row one arm's; an INTERSECT's and an EXCEPT's through none of them.
	 */
	#setOp(op: SetOperation, c: Context<Top>): ReadonlyArray<RowSource> {
		const arms = mapNonEmpty(op.arms, (arm, i) => {
			const armContext: Context<Top> =
				op.op === "EXCEPT" && i > 0 ? this.#entering(c, { ...c, polarity: flipped(c.polarity) }) : c
			return arm.kind === "core"
				? this.#body(arm, armContext, [], [])
				: this.#query(arm, armContext, [])
		})
		return op.op === "UNION" || op.op === "UNION ALL" ? [{ kind: "union", arms }] : []
	}

	/**
	 * One core in its place, by the number it is given: a core that groups, has a HAVING, or computes over many rows in
	 * its own expressions counts, and every read beneath it is counted. Its sources see the scope it is in, a LATERAL one
	 * its own sources' names too; its expressions see both. Every row of it comes through each of its FROM sources
	 * joined inner or crosswise, unless it aggregates with no GROUP BY, which yields a row over no input: then through
	 * none. A LEFT JOIN's source is read where its own condition holds, and no row is said to come through it
	 * (JoinedSource).
	 */
	#core(parts: CoreParts, c: Context<Top>, pushed: ReadonlyArray<Scoped>): number {
		const sources = sourcesOf(parts.from)
		const conditions = [...conjunctsOf(parts.where), ...innerConditions(sources)]
		const outerConditions = sources.flatMap((s) => (s.join === "left" ? conjunctsOf(s.on) : []))
		const aggregates =
			parts.grouped ||
			[...conditions, ...outerConditions, ...conjunctsOf(parts.having), ...parts.values].some(
				holdsRows
			)
		const core = this.cores.length
		this.cores.push([])
		const here = this.#opening(
			c,
			{
				...c,
				counted: c.counted || aggregates,
				scope: new Map([...c.scope, ...sources.map(({ source }) => nameOf(source))]),
				core
			},
			parts.groups ? core : undefined
		)
		const keying = [...conditions.map((expr) => ({ expr, scope: here.scope })), ...pushed]
		const rows = sources.flatMap((s) => {
			const read = this.#source(
				s.source,
				here,
				s.join === "inner"
					? keying
					: conjunctsOf(s.on).map((expr) => ({ expr, scope: here.scope })),
				c.scope
			)
			return s.join === "inner" ? read : []
		})
		this.cores[core] = parts.groups || !aggregates ? rows : []
		for (const e of [...conditions, ...outerConditions, ...conjunctsOf(parts.having)]) {
			this.expr(e, { ...here, probe: false, condition: true })
		}
		for (const e of parts.values) {
			this.expr(e, valued(here))
		}
		return core
	}

	/**
	 * A FROM source of a core: the sources every row of it comes through, a table's read, a probe's, a CTE's or a derived
	 * table's rows, an INSERT's met rows' proposed CTE's; none for a LATERAL one, whose rows are computed per row of the
	 * sources before it, nor for the row an arbitration met, a function's rows, VALUES, a relation input's arrays or a
	 * context's fact. A probe's rows are its table's at its driving row's values, inner-joined, so every row of its core
	 * comes through one of them; met rows are rows of the CTE their INSERT proposes, read where they stand, less the
	 * rows its RETURNING holds, the call's own.
	 */
	#source(
		source: FromSource,
		here: Context<Top>,
		conditions: ReadonlyArray<Scoped>,
		enclosing: Scope
	): ReadonlyArray<RowSource> {
		const beneath: Context<Top> = { ...here, probe: false }
		switch (source.kind) {
			case "table":
				return [
					this.#table({
						kind: "table",
						table: source.table,
						alias: source.alias,
						context: here,
						conditions,
						feeds: this.#feeds(),
						columns: undefined,
						met: undefined
					})
				]
			case "probe":
				return [
					this.#probed(
						source.table,
						source.inner,
						source.by.columns,
						source.filter,
						here,
						undefined
					)
				]
			case "met":
				if (this.#statement.level === "readCommitted") {
					this.#opaque(`?met:${printObjectName(source.table)}`, here)
				} else {
					this.#probed(
						source.table,
						source.inner,
						source.key.map((k) => ({
							column: k.column,
							value: col(source.rows, k.from),
							schema: k.schema
						})),
						source.filter,
						here,
						metSealed(source, here)
					)
				}
				return []
			case "metRows":
				return this.#cteRead(source.proposed, beneath)
			case "cte":
			case "enclosing":
				return this.#cteRead(source.name, beneath)
			case "transition":
				return []
			case "derived": {
				const projection = projectionOf(source)
				const rows =
					projection === undefined
						? this.#query(
								source.query,
								source.lateral ? beneath : { ...beneath, scope: enclosing },
								pushedInto(source, conditions)
							)
						: [
								this.#table({
									kind: "table",
									table: projection.table,
									alias: source.alias,
									context: here,
									conditions,
									feeds: this.#feeds(),
									columns: projection.columns,
									met: undefined
								})
							]
				return source.lateral ? [] : rows
			}
			case "function":
				this.expr(source.call, source.lateral ? beneath : { ...beneath, scope: enclosing })
				return []
			case "values":
				for (const e of source.rows.flat()) {
					this.expr(e, valued({ ...beneath, scope: enclosing }))
				}
				return []
			case "arrays":
			case "context":
				return []
		}
	}

	/**
	 * A write's read of `table` driven by its rows (a `probe` or a `met` source), read as the table `inner` under its own
	 * conditions alone: each probed column equal to its value, which reads the driving row, and its filter, which reads
	 * the driving row and `inner`; a `met` source's at its key columns where its structure proves its INSERT met the row
	 * (`met`, metSealed). The values and the filter are walked as its conditions, seeing the core's names and `inner`.
	 */
	#probed(
		table: ObjectName,
		inner: string,
		columns: ReadonlyArray<ProbeColumn>,
		filter: ReadonlyArray<Expr>,
		here: Context<Top>,
		met: ReadonlyArray<string> | undefined
	): RowSource {
		const scope: Scope = new Map([...here.scope, [inner, "table"]])
		const conditions = [
			...columns.map((c) => eq(col(inner, c.column), c.value)),
			...filter.flatMap(conjunctsOf)
		]
		const read = this.#table({
			kind: "table",
			table,
			alias: inner,
			context: here,
			conditions: conditions.map((expr) => ({ expr, scope })),
			feeds: this.#feeds(),
			columns: undefined,
			met
		})
		for (const e of conditions) {
			this.expr(e, { ...here, probe: false, condition: true, scope })
		}
		return read
	}

	/** A table read found, as the row source it is: its place among the reads. */
	#table(found: Found): RowSource {
		this.found.push(found)
		return { kind: "read", read: this.found.length - 1 }
	}

	/**
	 * A CTE read where a source names it: a query CTE's rows, through this body's use of the instance its arrival here
	 * keys (Statement.instance); none for the call's own rows.
	 */
	#cteRead(name: string, c: Context<Top>): ReadonlyArray<RowSource> {
		const ref = c.ctes.get(name)
		if (ref === undefined) {
			throw defect(`a source names the CTE ${name}, which no WITH around it defines`)
		}
		if (ref.kind !== "query") {
			return []
		}
		this.uses.push({
			cte: this.#statement.instance(name, ref, c.polarity, c.counted, this.#feeds()),
			probes: c.probes,
			core: siteCore(c.core),
			at: this.found.length
		})
		return [{ kind: "use", use: this.uses.length - 1 }]
	}

	/**
	 * An expression's reads: a sublink's query, a call of a function that may read tables as an opaque read, and a call of
	 * a retirable unit's retirement as its unit's writes by a retirement, each relation once whatever sites call it.
	 */
	expr(e: Expr, c: Context<Top>): void {
		if (e.kind === "exists") {
			this.query(e.query, this.#entering(c, { ...c, probe: true, polarity: predicate(c, e.not) }))
		}
		if (e.kind === "inQuery") {
			this.query(e.query, this.#entering(c, { ...c, probe: false, polarity: predicate(c, e.not) }))
		}
		if (e.kind === "subquery" || e.kind === "array") {
			this.query(e.query, this.#entering(c, { ...c, probe: false, counted: true }))
		}
		if (e.kind === "call" && e.fn.kind === "qualified") {
			const retired = this.#statement.names.retirementOf(e.fn)
			if (retired !== undefined) {
				for (const table of retired) {
					if (
						!this.#statement.writes.some(
							(w) =>
								w.op === "retire" && w.table.schema === table.schema && w.table.name === table.name
						)
					) {
						this.#statement.writes.push({ table, op: "retire" })
					}
				}
			} else if (!this.#statement.names.readsNoTable(e.fn)) {
				this.#opaque(`?function:${printObjectName(e.fn)}`, c)
			}
		}
		const next = this.#operandContext(e, c)
		for (const operand of operandsOf(e)) {
			this.expr(operand, next)
		}
	}

	#operandContext(e: Expr, c: Context<Top>): Context<Top> {
		if (e.kind === "not") {
			return this.#entering(c, { ...c, polarity: flipped(c.polarity) })
		}
		return e.kind === "and" || e.kind === "or" || e.kind === "isTrue" ? c : valued(c)
	}
}

/** A query CTE as a WITH defines it (CteRef `query`). */
type QueryCte = Extract<CteRef, { readonly kind: "query" }>

/**
 * What a walk of a query CTE's query depends on, beyond the probes and the core of the site that reads it, which its
 * uses state (analysis/isolation/facts.ts CteUse): the CTE, by the definition its WITH made, and the polarity and the
 * count of the site, which decide its reads' modes and which of its places open a probe (Walk #opening). The writes the
 * site feeds, which its reads feed and its probes gate, the walk records as the site's (Feeds `site`), so one walk
 * serves every site that reads the CTE at one polarity and count (Template).
 */
type TemplateKey = readonly [QueryCte, Polarity, boolean]

/**
 * What an instance of a query CTE is keyed by: its walk's key (TemplateKey) and the writes the site that reads it feeds,
 * which its facts name where the walk recorded the site's (Statement.instance).
 */
type InstanceKey = readonly [QueryCte, Polarity, boolean, ...ReadonlyArray<number>]

/**
 * A query CTE the walk of another's query reads, as that walk records it: the CTE a source names, by its name, at the
 * source's polarity and count, whose instance each instance of the reader resolves for the writes its own site feeds
 * (Statement.instance).
 */
interface Nested {
	readonly name: string
	readonly cte: QueryCte
	readonly polarity: Polarity
	readonly counted: boolean
}

/**
 * The walk of a query CTE's query at one polarity and count (TemplateKey), walked once whatever writes the sites that
 * read it feed: its walk, the row sources every row of it comes through, and the query CTEs it reads, each of its
 * uses naming one of them by its place (Nested), in the order its walk read them.
 */
interface Template {
	readonly walk: Walk<"site">
	readonly rows: ReadonlyArray<RowSource>
	readonly nested: ReadonlyArray<Nested>
}

/**
 * An instance of a query CTE: its walk (Template), the writes the site that reads it feeds (`arrival`), where its walk
 * recorded the site's, the instance of each query CTE its walk reads, by its place among them, for those writes, and
 * the query it walks, by the number the statement gives each of its query CTEs (Statement.instance).
 */
interface Instance {
	readonly template: Template
	readonly arrival: ReadonlyArray<number>
	readonly nested: ReadonlyArray<number>
	readonly query: number
}

/**
 * What one statement's walk shares across its bodies: how it reads names back, its parameters' names and its level; the
 * writes and ON CONFLICT arbitrations its DML makes, wherever it stands; and the instances of its query CTEs, in the
 * order their walks would finish, each found by its key (InstanceKey), and the queries they walk, each by the query of
 * its CTE, one place in the statement whatever WITH walk defined it. Each query CTE's query is walked once for each
 * polarity and count it is read at (Template), however many writes the sites that read it feed. It lives as long as
 * the statement's extraction, with every walk and every query of the statement it keys: no fact holds it.
 */
export class Statement {
	readonly writes: Array<{ readonly table: ObjectName; readonly op: WriteFact["op"] }> = []
	readonly arbitrations: Array<Arbitration> = []
	readonly instances: Array<Instance> = []
	readonly names: ExtractNames
	readonly paramOf: (n: number) => string | undefined
	readonly level: Isolation
	readonly #keyed = new TupleMap<InstanceKey, number>()
	readonly #templates = new TupleMap<TemplateKey, Template>()
	/** The query CTEs each walk of a query CTE's query in progress reads, the innermost last (Template `nested`). */
	readonly #reading: Array<Array<Nested>> = []
	readonly #queries = new Map<OperandSelect, number>()

	constructor(names: ExtractNames, paramOf: (n: number) => string | undefined, level: Isolation) {
		this.names = names
		this.paramOf = paramOf
		this.level = level
	}

	/**
	 * The place of the instance of the query CTE `cte`, which a source names `name`, read at `polarity`, counted or not,
	 * where the site feeds `feeds`: found by its key (InstanceKey), or made from its walk (Template) after the instance
	 * of each query CTE that walk reads, for the same writes, as a walk of its query would have made them, in its order.
	 * Read from the walk of another query CTE's query (`feeds` the site's), it is the place among the query CTEs that
	 * walk reads, which each instance of it resolves, its own walk walked there, where a walk of the reader would have
	 * walked it, so every retirement a query's calls write (Walk expr) is written in the order the walks would have met
	 * it.
	 */
	instance(
		name: string,
		cte: QueryCte,
		polarity: Polarity,
		counted: boolean,
		feeds: Feeds
	): number {
		if (feeds === "site") {
			const reading = this.#reading.at(-1)
			if (reading === undefined) {
				throw defect("a site feeds the site's writes only in a query CTE's walk")
			}
			this.#template(name, cte, polarity, counted)
			reading.push({ name, cte, polarity, counted })
			return reading.length - 1
		}
		const key: InstanceKey = [cte, polarity, counted, ...feeds]
		const known = this.#keyed.get(key)
		if (known !== undefined) {
			return known
		}
		const template = this.#template(name, cte, polarity, counted)
		const nested = template.nested.map((n) =>
			this.instance(n.name, n.cte, n.polarity, n.counted, feeds)
		)
		const query = this.#queries.getOrInsertComputed(cte.query, () => this.#queries.size)
		const place = this.instances.length
		this.instances.push({ template, arrival: feeds, nested, query })
		this.#keyed.set(key, place)
		return place
	}

	/**
	 * The walk of `cte`'s query at `polarity` and `counted` (Template), walked once: from no probe and outside every core
	 * of its own, seeing the CTEs its WITH defines and `name` as the call's own rows of its recursion, its reads feeding
	 * and its probes gating the site's writes. A query CTE's query writes nothing but the retirements its calls write,
	 * once each for the statement, which a second walk of it would not write again.
	 */
	#template(name: string, cte: QueryCte, polarity: Polarity, counted: boolean): Template {
		return this.#templates.getOrInsertComputed([cte, polarity, counted], () => {
			const nested: Array<Nested> = []
			this.#reading.push(nested)
			const walk = new Walk<"site">(this, "site")
			const rows = walk.cte(cte.query, {
				polarity,
				counted,
				probe: false,
				condition: false,
				scope: cte.scope,
				ctes: new Map([...cte.ctes, [name, ownRows]]),
				probes: [],
				core: "site"
			})
			this.#reading.pop()
			return { walk, rows, nested }
		})
	}
}

/**
 * The core a site that reads a query CTE stands in, as its use states it: a core of its body, or none, a MERGE's source
 * at the top of a statement. A site outside every core of a CTE's query would read it from a data-modifying CTE inside
 * that query, which PostgreSQL refuses: a data-modifying statement stands in a top-level WITH alone.
 */
const siteCore = (core: number | Arrival): number | undefined => {
	if (core === "site") {
		throw defect(
			"a query CTE read outside every core of a CTE's query, where no data-modifying CTE stands"
		)
	}
	return core
}

const byColumn = (a: Bound, b: Bound): number => {
	if (a.column < b.column) {
		return -1
	}
	return a.column > b.column ? 1 : 0
}

/**
 * A read's group, from the fields it binds (each Bound's column a field), each with what it is bound to, sorted by
 * field: one value for the call where every field takes one, else one group per own row; none where it binds none.
 */
const boundGroup = (bound: ReadonlyArray<Bound>): ReadGroup | undefined => {
	const sorted = bound.toSorted(byColumn)
	return isNonEmpty(sorted)
		? {
				bound: mapNonEmpty(sorted, (b) => ({ field: b.column, by: b.by })),
				rows: sorted.every((b) => b.rows === "one") ? "one" : "many"
			}
		: undefined
}

/** What a column of the call's own sources takes: one value or many, none for a stored table's or an unknown name. */
const ownRowsOf = (scope: Scope, table: string): ReadGroup["rows"] | undefined => {
	const named = scope.get(table)
	if (named === undefined || named === "table") {
		return undefined
	}
	return typeof named === "string" ? named : "many"
}

/**
 * The columns of a table source its core's conditions bind, through a projection's renaming (`columns`, none for a
 * table read directly), each by its first equality, in the conditions' order:
 * with a parameter, one value, or with a column of a source the scope names the call's own, one value or one per row.
 * Each comes with the text of what it is bound to: a parameter by the declared parameter it carries (`:name`), so two
 * placeholders of one parameter bind one value, or by its number where it carries none.
 */
const bindingsOf = (
	alias: string,
	conditions: ReadonlyArray<Scoped>,
	columns: ReadonlyMap<string, string> | undefined,
	paramOf: (n: number) => string | undefined
): ReadonlyArray<Bound> => {
	const side = (mine: Expr, other: Expr, scope: Scope): ReadonlyArray<Bound> => {
		if (mine.kind !== "column" || mine.table !== alias) {
			return []
		}
		const column = columns === undefined ? mine.column : columns.get(mine.column)
		if (column === undefined) {
			return []
		}
		const placeholder = placeholderName(other, paramOf)
		if (placeholder !== undefined) {
			return [{ column, by: placeholder, rows: "one" }]
		}
		if (other.kind !== "column" || other.table === undefined) {
			return []
		}
		const rows = ownRowsOf(scope, other.table)
		return rows === undefined ? [] : [{ column, by: `${other.table}.${other.column}`, rows }]
	}
	const out = new Map<string, Bound>()
	for (const { expr: e, scope } of conditions) {
		if (e.kind === "binary" && e.op === "=") {
			for (const b of [...side(e.left, e.right, scope), ...side(e.right, e.left, scope)]) {
				out.getOrInsert(b.column, b)
			}
		}
	}
	return [...out.values()]
}

/**
 * Whether an INSERT proposes exactly the rows of the CTE `proposed`: its source a query over that CTE alone, under no
 * WITH, condition, grouping, HAVING, DISTINCT, LIMIT or OFFSET, so each row of it is one row the INSERT proposes.
 */
const proposesAlone = (insert: Insert, proposed: string): boolean => {
	if (insert.source.kind !== "query") {
		return false
	}
	const q = insert.source.query
	const body = q.body
	if (
		q.with !== undefined ||
		q.limit !== undefined ||
		q.offset !== undefined ||
		body.kind !== "core" ||
		body.where !== undefined ||
		body.groupBy.length > 0 ||
		body.having !== undefined ||
		body.distinct !== false
	) {
		return false
	}
	const [only, ...rest] = body.from
	return only !== undefined && rest.length === 0 && only.kind === "cte" && only.name === proposed
}

/**
 * The key columns of a `met` source where its structure proves the row it reads is the row its statement's INSERT met:
 * its `rows` name a met rows source in scope (`metRows`), whose `insert` names a data-modifying CTE of the statement
 * holding an INSERT into the met row's table that proposes that source's `proposed` alone (`proposesAlone`) and skips
 * a conflicting row by ON CONFLICT DO NOTHING with no target or over columns all among the key. Every row that drives
 * it is then a row the INSERT proposed and did not insert, and every stored row at the key conflicts with it at the
 * arbiter: under a transaction snapshot each such row is visible to the statement or raised 40001 (nodeModifyTable.c
 * ExecCheckTupleVisible). None for any other `met`, which is read by where it stands.
 */
const metSealed = (source: Met, here: Context): ReadonlyArray<string> | undefined => {
	const rows = here.scope.get(source.rows)
	if (rows === undefined || typeof rows === "string") {
		return undefined
	}
	const written = here.ctes.get(rows.insert)
	const insert =
		written?.kind === "write" && written.body.kind === "insert" ? written.body : undefined
	const key = source.key.map((k) => k.column)
	const conflict = insert?.onConflict
	return insert !== undefined &&
		typeof insert.table !== "string" &&
		insert.table.schema === source.table.schema &&
		insert.table.name === source.table.name &&
		proposesAlone(insert, rows.proposed) &&
		(conflict?.kind === "every" ||
			(conflict?.kind === "columns" &&
				conflict.action.kind === "doNothing" &&
				conflict.columns.every((c) => key.includes(c))))
		? key
		: undefined
}

/** A read's base mode: its mode were every probe above it a function of positive reads, an arbitration or positive. */
const baseOf = (arbiter: boolean): ReadFact["mode"] => (arbiter ? "arbiter" : "positive")

/** A read's mode: an arbitration, a probe of a table its statement writes; else by its polarity and its count. */
const modeOf = (c: Context, arbiter: boolean): ReadFact["mode"] => {
	if (arbiter) {
		return "arbiter"
	}
	if (c.polarity !== "positive") {
		return "negated"
	}
	return c.counted ? "counted" : "positive"
}

/** One statement's facts (analysis/isolation/facts.ts StatementFacts). */
const statementFacts = (
	s: SqlStatement,
	names: ExtractNames,
	paramOf: (n: number) => string | undefined,
	level: Isolation
): StatementFacts => {
	const statement = new Statement(names, paramOf, level)
	const walk = new Walk<undefined>(statement, [])
	walk.statement(s)
	const relation = (t: ObjectName): string => names.relationOf(t) ?? `?${printObjectName(t)}`
	const fields = (rel: string, bound: ReadonlyArray<Bound>): ReadonlyArray<Bound> =>
		bound.flatMap((b): ReadonlyArray<Bound> => {
			const field = names.fieldOf(rel, b.column)
			return field === undefined ? [] : [{ ...b, column: field }]
		})
	/** The relations the statement's DML writes, which a probe of arbitrates; a retirement arbitrates nothing. */
	const written = new Set(
		statement.writes.flatMap((w) => (w.op === "retire" ? [] : [relation(w.table)]))
	)
	const readOf = (f: Found): Placed => {
		if (f.kind === "opaque") {
			return {
				read: {
					relation: f.relation,
					mode: "negated",
					base: "negated",
					probes: f.probes,
					own: false,
					group: undefined
				},
				feeds: []
			}
		}
		if (typeof f.table === "string") {
			return {
				read: {
					relation: `carrier:${f.table}`,
					mode: modeOf(f.context, false),
					base: baseOf(false),
					probes: f.context.probes,
					own: true,
					group: undefined
				},
				feeds: f.feeds
			}
		}
		const rel = relation(f.table)
		const arbiter = f.met !== undefined || (f.context.probe && written.has(rel))
		return {
			read: {
				relation: rel,
				mode: modeOf(f.context, arbiter),
				base: baseOf(arbiter),
				probes: f.context.probes,
				own: false,
				group: boundGroup(fields(rel, bindingsOf(f.alias, f.conditions, f.columns, paramOf)))
			},
			feeds: f.feeds
		}
	}
	const reads = walk.found.map(readOf)
	/** Each query CTE walk's reads, read once for every instance of it (Template). */
	const walked = new Map<Template, ReadonlyArray<Placed>>()
	const readsOf = (t: Template): ReadonlyArray<Placed> =>
		walked.getOrInsertComputed(t, () => t.walk.found.map(readOf))
	/** Each query CTE walk's read facts, one list every instance of it holds. */
	const stated = new Map<Template, ReadonlyArray<ReadFact>>()
	const readFactsOf = (t: Template): ReadonlyArray<ReadFact> =>
		stated.getOrInsertComputed(t, () => readsOf(t).map((r) => r.read))
	const arbitrations = statement.arbitrations.map((a): ReadFact => {
		const rel = relation(a.table)
		return {
			relation: rel,
			mode: "arbiter",
			base: "arbiter",
			probes: [],
			own: false,
			group: boundGroup(
				fields(
					rel,
					(a.columns ?? []).map((column): Bound => {
						const value = a.values.get(column)
						return value === undefined
							? { column, by: `excluded.${column}`, rows: "many" }
							: { column, by: value, rows: "one" }
					})
				)
			)
		}
	})
	/** The reads of a body arriving from a site feeding `arrival` that feed `write`, by their places (ReadAt). */
	const feeding = (
		cte: number | undefined,
		found: ReadonlyArray<Placed>,
		arrival: ReadonlyArray<number>,
		write: number
	): ReadonlyArray<ReadAt> =>
		found.flatMap((r, read) =>
			r.read.mode === "positive" && fedAt(r.feeds, arrival).includes(write) ? [{ cte, read }] : []
		)
	return {
		writes: statement.writes.map((w, i): WriteFact => ({
			relation: relation(w.table),
			op: w.op,
			from: [
				...feeding(undefined, reads, [], i),
				...statement.instances.flatMap((instance, cte) =>
					feeding(cte, readsOf(instance.template), instance.arrival, i)
				)
			]
		})),
		reads: [...reads.map((r) => r.read), ...arbitrations],
		probes: walk.probes.map((p) => probeAt(p, [])),
		cores: walk.cores,
		uses: walk.uses,
		ctes: statement.instances.map((instance): CteFacts => ({
			reads: readFactsOf(instance.template),
			probes: instance.template.walk.probes.map((p) => probeAt(p, instance.arrival)),
			cores: instance.template.walk.cores,
			uses: instance.template.walk.uses.map((u) => ({
				...u,
				cte: nestedAt(instance, u.cte)
			})),
			rows: instance.template.rows,
			query: instance.query
		}))
	}
}

/** The place of the instance of the query CTE its walk reads at `place` (Template `nested`), for its arrival. */
const nestedAt = (instance: Instance, place: number): number => {
	const at = instance.nested[place]
	if (at === undefined) {
		throw defect("an instance resolves every query CTE its walk reads")
	}
	return at
}

/** A read a walk found as its facts state it, and the writes its rows feed as the walk recorded them (Feeds). */
interface Placed {
	readonly read: ReadFact
	readonly feeds: Feeds
}

/** A probe a walk recorded (WalkProbe) as its body's facts state it, arriving from a site feeding `arrival`. */
const probeAt = <Core extends SiteCore>(
	p: WalkProbe<Core>,
	arrival: ReadonlyArray<number>
): ProbeFact<Core> => ({ gates: fedAt(p.gates, arrival), core: p.core, chain: p.chain })

/**
 * The facts of one change member's flight (analysis/isolation/facts.ts MemberFacts), read from its statements in the
 * order they run: what each writes, with the reads each written row is positively joined with, and what each reads.
 *
 * - A read's mode: `arbiter` for a table an EXISTS probes that its statement writes, an ON CONFLICT, a MERGE's NOT
 *   MATCHED, and the row an arbitration met (a `met` source) wherever it stands, where its structure proves its
 *   statement's INSERT met it (metSealed); else `negated` where its rows reach the statement by their absence (NOT
 *   EXISTS, NOT IN, EXCEPT's later arms, NOT) or either way (a predicate in a value or a branch, a NOT MATCHED BY
 *   SOURCE's source, a schema function no names clear); else `counted` beneath a scalar or ARRAY subquery or a core that
 *   counts; else `positive`.
 * - A write's read of a stored table driven by its rows (a `probe` or a `met` source) is a read of that table under its
 *   own conditions alone, each probed column equal to its value or to its met row's column and the filter's conjuncts,
 *   read where it stands: a probe is a source every row of its core comes through, and the row an arbitration met none.
 *   An INSERT's met rows (a `metRows` source) are the call's own rows, which read the CTE their INSERT proposes where
 *   they stand.
 * - An ON CONFLICT with no target arbitrates every object `arbitersOf` names, one arbitration each. It and a `met`
 *   source appear only in a statement compiled for SERIALIZABLE (`level`), whose transaction snapshot the met row's
 *   seal rests on: in a READ COMMITTED one each is a read no names clear, `?every:"schema"."name"` or
 *   `?met:"schema"."name"`, which the certifier refuses.
 * - A carrier's read is the call's own, named `carrier:<name>`. A table no relation is read as `?"schema"."name"`, a
 *   schema function no names clear as `?function:"schema"."name"`, and a statement that is no DML, carrier, ANALYZE or
 *   transaction control as `?refresh:"schema"."name"` or `?statement:<kind>`: the certifier refuses each as a relation
 *   it states no fact of. Each object is named as the printer quotes it (sql/print.ts printObjectName), so two names are
 *   one text only where they are one name, as `?every:schema.name` was for `"a.b"."c"` and `"a"."b.c"`, and the
 *   refusal shows it as SQL spells it.
 * - A table read's group is the fields its core's conditions bind to a parameter or to a column of a source in scope,
 *   the enclosing cores' included, that is the call's own: one value for the call where each is a parameter or the
 *   session's context's, else one group per own row. An ON CONFLICT's is its conflict columns', each bound to
 *   EXCLUDED's, one per proposed row.
 * - A derived table that only renames a relation's columns (projectionOf) reads that relation where it stands, keyed by
 *   the conditions of the core that reads it, through the renaming. A derived table that keeps each row of its one core
 *   as one of its own (rowPreserving) carries each equality over its columns into that core (pushedInto), level by level,
 *   so a group binds through every such layer; any other derived table's reads are keyed by its own conditions alone.
 * - A parameter binds by the declared parameter it carries, `:name`, where the caller's `params` names it, else by its
 *   number; an ON CONFLICT's conflict columns bind by the parameters their proposed values carry, where they carry one.
 * - Every flip of polarity and every count opens a probe, gating the writes its place feeds; each read lists the probes
 *   of its body it stands beneath and its base mode, the certifier's to judge (analysis/isolation/certify.ts
 *   reachesOf).
 * - A query CTE is read where a source names it, with that source's polarity, count and writes, through one instance
 *   of it for each such arrival (Statement.instance): its query walked once, its reads, probes and cores the
 *   instance's, and each source naming it a use of the instance with the probes and the core it stands in
 *   (analysis/isolation/facts.ts CteFacts, CteUse). A probe its query opens outside every core of its own stands in
 *   the core of each site that reads it (SiteCore `site`). A data-modifying CTE runs once, where it is defined.
 * - Each core's row sources are the sources every row of it comes through: each FROM source, joined inner or
 *   crosswise, a table's read, a probe's, a derived table's query by its one core or by a UNION's arms, and a CTE's or
 *   met rows' proposed CTE's rows through its use; none
 *   past a LATERAL source, the row an arbitration met, an INTERSECT, an EXCEPT, the call's own rows of a data-modifying
 *   or a recursive CTE, or a core aggregating with no GROUP BY. A row source is reached by these steps alone, so no
 *   other row path can be stated.
 * - A write's rows are fed by the positive reads beneath it: an INSERT's source, an UPDATE's or a DELETE's target and
 *   FROM, a MERGE's source and target, and the query CTEs any of them read.
 */
export const memberFacts = (
	name: string,
	statements: NonEmptyReadonlyArray<SqlStatement>,
	names: ExtractNames,
	params: (statement: number, n: number) => string | undefined,
	level: Isolation
): MemberFacts => ({
	name,
	statements: mapNonEmpty(statements, (s, i) =>
		statementFacts(s, names, (n) => params(i, n), level)
	)
})
