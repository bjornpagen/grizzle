import type {
	Group,
	MemberFacts,
	ReadFact,
	StatementFacts,
	WriteFact
} from "#compiler/analysis/isolation/facts.ts"
import { defect } from "#compiler/core/invariant.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
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
	Merge,
	MergeWhen,
	ObjectName,
	OperandBody,
	OperandSelect,
	OrderItem,
	QualifiedFunctionRef,
	SetOperation,
	SqlStatement,
	TableName,
	Update,
	WindowSpec,
	With
} from "#compiler/sql/ast.ts"

/**
 * How the extractor reads one role's statements back:
 *
 * - `relationOf`: the relation, by its declared name, a stored table or the role's view is; none for a table the
 *   installation states no relation of, and none for one the role reaches under a row policy that reads another
 *   relation's table, whose reads no statement shows;
 * - `fieldOf`: the field a column of a relation's table is, none for a column of no field (a law column);
 * - `readsNoTable`: whether a schema function a statement calls reads no relation's table, as a refusal, a constant, a
 *   vector or a serial's advance function reads none; a world's filter function reads the relations of its membership.
 */
export interface ExtractNames {
	readonly relationOf: (table: ObjectName) => string | undefined
	readonly fieldOf: (relation: string, column: string) => string | undefined
	readonly readsNoTable: (fn: QualifiedFunctionRef) => boolean
}

/**
 * How the rows a read finds reach what its statement does: by their presence, by their absence, or either way, where
 * they reach a value or a branch.
 */
type Polarity = "positive" | "negated" | "both"

/**
 * What a name a core sees is: a stored table's alias, whose values the statement reads, or an own source's, whose
 * values are the call's own: the session's context, one row (`one`), or a carrier, a CTE, a relation input's arrays, a
 * VALUES list, a function's or a derived table's rows, any number of rows (`many`).
 */
type Scope = ReadonlyMap<string, "table" | Group["rows"]>

/** A column a read's conditions bind, with what it is bound to and how many values that takes for the call. */
interface Bound {
	readonly column: string
	readonly by: string
	readonly rows: Group["rows"]
}

/**
 * What a CTE name refers to: a query, read where a source names it, under the scope and the CTEs it was defined in; or
 * rows the call itself makes, a data-modifying CTE's RETURNING or a recursive CTE's own working rows.
 */
type CteRef =
	| {
			readonly kind: "query"
			readonly query: OperandSelect
			readonly scope: Scope
			readonly ctes: Ctes
	  }
	| { readonly kind: "own" }

type Ctes = ReadonlyMap<string, CteRef>

const ownRows: CteRef = { kind: "own" }

/**
 * Where an expression or a source stands: the polarity its reads reach the statement with, whether a count or an
 * aggregate stands over them, whether it is a source of the core an EXISTS probes, whether an expression is a
 * condition of its core (WHERE, ON or HAVING, through AND, OR, NOT and IS TRUE), and the names and CTEs it sees.
 */
interface Context {
	readonly polarity: Polarity
	readonly counted: boolean
	readonly probe: boolean
	readonly condition: boolean
	readonly scope: Scope
	readonly ctes: Ctes
}

const top: Context = {
	polarity: "positive",
	counted: false,
	probe: false,
	condition: false,
	scope: new Map(),
	ctes: new Map()
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
const valued = (c: Context): Context => ({ ...c, condition: false, probe: false })

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
			readonly conditions: ReadonlyArray<Expr>
			readonly feeds: ReadonlyArray<number>
			readonly columns: ReadonlyMap<string, string> | undefined
	  }
	| { readonly kind: "opaque"; readonly relation: string }

/** An INSERT's ON CONFLICT arbitration of the table it writes: its conflict columns, none for a constraint's. */
interface Arbitration {
	readonly table: ObjectName
	readonly columns: ReadonlyArray<string> | undefined
}

/** The parts of one core the walk reads. */
interface CoreParts {
	readonly from: ReadonlyArray<FromItem>
	readonly where: Expr | undefined
	readonly having: Expr | undefined
	readonly values: ReadonlyArray<Expr>
	readonly grouped: boolean
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

/** A FROM's sources, each with its join's ON condition, none for the first and a cross join's. */
const sourcesOf = (
	from: ReadonlyArray<FromItem>
): ReadonlyArray<{ readonly source: FromSource; readonly on: Expr | undefined }> =>
	from.flatMap((item) =>
		item.kind === "joins"
			? [
					{ source: item.first, on: undefined },
					...item.steps.map((step) => ({
						source: step.source,
						on: step.kind === "on" ? step.on : undefined
					}))
				]
			: [{ source: item, on: undefined }]
	)

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
 * What a source's alias names: a stored table's values, a derived table's that only renames one's columns among them,
 * or the call's own, of one row or many.
 */
const nameOf = (source: FromSource): readonly [string, "table" | Group["rows"]] => {
	switch (source.kind) {
		case "table":
			return [source.alias, typeof source.table === "string" ? "many" : "table"]
		case "cte":
			return [source.alias ?? source.name, "many"]
		case "context":
			return [source.alias, "one"]
		case "derived": {
			const projection = projectionOf(source)
			return [
				source.alias,
				projection === undefined || typeof projection.table === "string" ? "many" : "table"
			]
		}
		case "enclosing":
		case "function":
		case "arrays":
		case "values":
			return [source.alias, "many"]
	}
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
 * The walk of one statement: every read it makes, with where it stands, every table it writes, with the reads that
 * feed each, and its ON CONFLICT arbitrations. A query CTE is read where a source names it, in that source's place, so
 * its reads compose with the place it is read in; a data-modifying one runs once, where it is defined.
 */
class Walk {
	readonly found: Array<Found> = []
	readonly writes: Array<{ readonly table: ObjectName; readonly op: WriteFact["op"] }> = []
	readonly arbitrations: Array<Arbitration> = []
	readonly #names: ExtractNames
	readonly #feeding: Array<ReadonlyArray<number>> = []

	constructor(names: ExtractNames) {
		this.#names = names
	}

	statement(s: SqlStatement): void {
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
			s.kind === "analyze" ||
			s.kind === "begin" ||
			s.kind === "commit" ||
			s.kind === "rollback" ||
			s.kind === "setConstraintsImmediate"
		) {
			return
		}
		this.#opaque(
			s.kind === "refresh" ? `?refresh:${s.view.schema}.${s.view.name}` : `?statement:${s.kind}`
		)
	}

	#opaque(relation: string): void {
		this.found.push({ kind: "opaque", relation })
	}

	#modifying(body: CteBody, c: Context): void {
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
	#with(w: With | undefined, c: Context): Context {
		if (w === undefined) {
			return c
		}
		const ctes = new Map(c.ctes)
		for (const cte of w.ctes) {
			ctes.set(
				cte.name,
				cte.query.kind === "select"
					? { kind: "query", query: cte.query, scope: c.scope, ctes }
					: ownRows
			)
		}
		const inner: Context = { ...c, ctes }
		for (const cte of w.ctes) {
			this.#modifying(cte.query, inner)
		}
		return inner
	}

	#writeOf(table: TableName, op: WriteFact["op"]): ReadonlyArray<number> {
		if (typeof table === "string") {
			return []
		}
		this.writes.push({ table, op })
		return [this.writes.length - 1]
	}

	#feedingWrites(at: ReadonlyArray<number>, f: () => void): void {
		this.#feeding.push(at)
		f()
		this.#feeding.pop()
	}

	#insert(s: Insert, c: Context): void {
		const inner = this.#with(s.with, c)
		const conflict = s.onConflict
		const at = [
			...this.#writeOf(s.table, "insert"),
			...(conflict?.action.kind === "doUpdate" ? this.#writeOf(s.table, "update") : [])
		]
		const scope: Scope =
			s.alias === undefined ? inner.scope : new Map([...inner.scope, [s.alias, "table"]])
		const after: Context = { ...inner, scope }
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
			this.arbitrations.push({
				table: s.table,
				columns: conflict.kind === "columns" ? conflict.columns : undefined
			})
		}
		for (const t of s.returning) {
			this.expr(t.expr, valued(after))
		}
	}

	#update(s: Update, c: Context): void {
		const inner = this.#with(s.with, c)
		this.#feedingWrites(this.#writeOf(s.table, "update"), () =>
			this.#core(
				{
					from: [{ kind: "table", table: s.table, alias: s.alias }, ...s.from],
					where: s.where,
					having: undefined,
					values: [...s.set.map((a) => a.value), ...s.returning.map((t) => t.expr)],
					grouped: false
				},
				inner
			)
		)
	}

	#delete(s: Delete, c: Context): void {
		const inner = this.#with(s.with, c)
		this.#feedingWrites(this.#writeOf(s.table, "delete"), () =>
			this.#core(
				{
					from: [{ kind: "table", table: s.table, alias: s.alias }, ...s.using],
					where: s.where,
					having: undefined,
					values: s.returning.map((t) => t.expr),
					grouped: false
				},
				inner
			)
		)
	}

	/**
	 * A MERGE: its source's rows, read either way where a WHEN NOT MATCHED BY SOURCE acts on their absence, and its
	 * target read once per WHEN clause: matched positively under ON and the clause's condition, not matched as a probe
	 * of the absence ON binds, and not matched by source positively under the clause's condition alone.
	 */
	#merge(s: Merge, c: Context): void {
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
		const here: Context = { ...inner, scope }
		const on = [...conjunctsOf(s.on), ...using.flatMap((u) => conjunctsOf(u.on))]
		const bySource = s.whens.some((w) => w.match === "NOT MATCHED BY SOURCE")
		this.#feedingWrites(at, () => {
			for (const { source } of using) {
				this.#source(source, bySource ? { ...here, polarity: "both" } : here, on, inner.scope)
			}
			for (const w of s.whens) {
				this.found.push({
					kind: "table",
					table: s.table,
					alias: s.alias,
					context:
						w.match === "NOT MATCHED"
							? { ...here, polarity: flipped(here.polarity), probe: true }
							: here,
					conditions: targetConditions(w, on),
					feeds: this.#feeds(),
					columns: undefined
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

	#feeds(): ReadonlyArray<number> {
		return this.#feeding.at(-1) ?? []
	}

	query(q: OperandSelect, c: Context): void {
		const inner = this.#with(q.with, c)
		this.#body(q.body, inner, orderExprs(q.orderBy))
		for (const e of [q.limit, q.offset]) {
			if (e !== undefined) {
				this.expr(e, valued(inner))
			}
		}
	}

	/** A query's body, with its query's ORDER BY: a core's own expressions, or values over a set operation's rows. */
	#body(body: OperandBody, c: Context, order: ReadonlyArray<Expr>): void {
		if (body.kind === "core") {
			this.#core(
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
					grouped: body.groupBy.length > 0 || body.having !== undefined
				},
				c
			)
			return
		}
		if (body.kind === "setOp") {
			this.#setOp(body, c)
		} else {
			this.query(body, c)
		}
		for (const e of order) {
			this.expr(e, valued(c))
		}
	}

	/** A set operation's arms: an EXCEPT's later arms remove rows, so their reads reach it by their absence. */
	#setOp(op: SetOperation, c: Context): void {
		for (const [i, arm] of op.arms.entries()) {
			const armContext: Context =
				op.op === "EXCEPT" && i > 0 ? { ...c, polarity: flipped(c.polarity) } : c
			if (arm.kind === "core") {
				this.#body(arm, armContext, [])
			} else {
				this.query(arm, armContext)
			}
		}
	}

	/**
	 * One core in its place: a core that groups, has a HAVING, or computes over many rows in its own expressions
	 * counts, and every read beneath it is counted. Its sources see the scope it is in, a LATERAL one its own sources'
	 * names too; its expressions see both.
	 */
	#core(parts: CoreParts, c: Context): void {
		const sources = sourcesOf(parts.from)
		const conditions = [...conjunctsOf(parts.where), ...sources.flatMap((s) => conjunctsOf(s.on))]
		const counted =
			c.counted ||
			parts.grouped ||
			[...conditions, ...conjunctsOf(parts.having), ...parts.values].some(holdsRows)
		const here: Context = {
			...c,
			counted,
			scope: new Map([...c.scope, ...sources.map(({ source }) => nameOf(source))])
		}
		for (const { source } of sources) {
			this.#source(source, here, conditions, c.scope)
		}
		for (const e of [...conditions, ...conjunctsOf(parts.having)]) {
			this.expr(e, { ...here, probe: false, condition: true })
		}
		for (const e of parts.values) {
			this.expr(e, valued(here))
		}
	}

	#source(
		source: FromSource,
		here: Context,
		conditions: ReadonlyArray<Expr>,
		enclosing: Scope
	): void {
		const beneath: Context = { ...here, probe: false }
		switch (source.kind) {
			case "table":
				this.found.push({
					kind: "table",
					table: source.table,
					alias: source.alias,
					context: here,
					conditions,
					feeds: this.#feeds(),
					columns: undefined
				})
				return
			case "cte":
			case "enclosing":
				this.#cteRead(source.name, beneath)
				return
			case "derived": {
				const projection = projectionOf(source)
				if (projection === undefined) {
					this.query(source.query, source.lateral ? beneath : { ...beneath, scope: enclosing })
				} else {
					this.found.push({
						kind: "table",
						table: projection.table,
						alias: source.alias,
						context: here,
						conditions,
						feeds: this.#feeds(),
						columns: projection.columns
					})
				}
				return
			}
			case "function":
				this.expr(source.call, source.lateral ? beneath : { ...beneath, scope: enclosing })
				return
			case "values":
				for (const e of source.rows.flat()) {
					this.expr(e, valued({ ...beneath, scope: enclosing }))
				}
				return
			case "arrays":
			case "context":
				return
		}
	}

	#cteRead(name: string, c: Context): void {
		const ref = c.ctes.get(name)
		if (ref === undefined) {
			throw defect(`a source names the CTE ${name}, which no WITH around it defines`)
		}
		if (ref.kind === "query") {
			this.query(ref.query, {
				...c,
				scope: ref.scope,
				ctes: new Map([...ref.ctes, [name, ownRows]])
			})
		}
	}

	expr(e: Expr, c: Context): void {
		if (e.kind === "exists") {
			this.query(e.query, { ...c, probe: true, polarity: predicate(c, e.not) })
		}
		if (e.kind === "inQuery") {
			this.query(e.query, { ...c, probe: false, polarity: predicate(c, e.not) })
		}
		if (e.kind === "subquery" || e.kind === "array") {
			this.query(e.query, { ...c, probe: false, counted: true })
		}
		if (e.kind === "call" && e.fn.kind === "qualified" && !this.#names.readsNoTable(e.fn)) {
			this.#opaque(`?function:${e.fn.schema}.${e.fn.name}`)
		}
		const next = this.#operandContext(e, c)
		for (const operand of operandsOf(e)) {
			this.expr(operand, next)
		}
	}

	#operandContext(e: Expr, c: Context): Context {
		if (e.kind === "not") {
			return { ...c, polarity: flipped(c.polarity) }
		}
		return e.kind === "and" || e.kind === "or" || e.kind === "isTrue" ? c : valued(c)
	}
}

const byColumn = (a: Bound, b: Bound): number => {
	if (a.column < b.column) {
		return -1
	}
	return a.column > b.column ? 1 : 0
}

/**
 * A read's group, from the fields it binds (each Bound's column a field), sorted by field: one value for the call where
 * every field takes one, else one group per own row; none where it binds none.
 */
const boundGroup = (bound: ReadonlyArray<Bound>): Group | undefined => {
	const sorted = bound.toSorted(byColumn)
	return sorted.length === 0
		? undefined
		: {
				fields: sorted.map((b) => b.column),
				binding: sorted.map((b) => b.by).join(","),
				rows: sorted.every((b) => b.rows === "one") ? "one" : "many"
			}
}

/** What a column of the call's own sources takes: one value or many, none for a stored table's or an unknown name. */
const ownRowsOf = (scope: Scope, table: string): Group["rows"] | undefined => {
	const named = scope.get(table)
	return named === "table" ? undefined : named
}

/**
 * The columns of a table source its core's conditions bind, through a projection's renaming (`columns`, none for a
 * table read directly), each by its first equality, in the conditions' order:
 * with a parameter, one value, or with a column of a source the scope names the call's own, one value or one per row.
 * Each comes with the text of what it is bound to.
 */
const bindingsOf = (
	alias: string,
	conditions: ReadonlyArray<Expr>,
	scope: Scope,
	columns: ReadonlyMap<string, string> | undefined
): ReadonlyArray<Bound> => {
	const side = (mine: Expr, other: Expr): ReadonlyArray<Bound> => {
		if (mine.kind !== "column" || mine.table !== alias) {
			return []
		}
		const column = columns === undefined ? mine.column : columns.get(mine.column)
		if (column === undefined) {
			return []
		}
		if (other.kind === "param") {
			return [{ column, by: `$${other.slot.number}`, rows: "one" }]
		}
		if (other.kind !== "column" || other.table === undefined) {
			return []
		}
		const rows = ownRowsOf(scope, other.table)
		return rows === undefined ? [] : [{ column, by: `${other.table}.${other.column}`, rows }]
	}
	const out = new Map<string, Bound>()
	for (const e of conditions) {
		if (e.kind === "binary" && e.op === "=") {
			for (const b of [...side(e.left, e.right), ...side(e.right, e.left)]) {
				if (!out.has(b.column)) {
					out.set(b.column, b)
				}
			}
		}
	}
	return [...out.values()]
}

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
const statementFacts = (s: SqlStatement, names: ExtractNames): StatementFacts => {
	const walk = new Walk(names)
	walk.statement(s)
	const relation = (t: ObjectName): string => names.relationOf(t) ?? `?${t.schema}.${t.name}`
	const fields = (rel: string, bound: ReadonlyArray<Bound>): ReadonlyArray<Bound> =>
		bound.flatMap((b): ReadonlyArray<Bound> => {
			const field = names.fieldOf(rel, b.column)
			return field === undefined ? [] : [{ ...b, column: field }]
		})
	const written = new Set(walk.writes.map((w) => relation(w.table)))
	const reads = walk.found.map(
		(f): { readonly read: ReadFact; readonly feeds: ReadonlyArray<number> } => {
			if (f.kind === "opaque") {
				return {
					read: { relation: f.relation, mode: "negated", own: false, group: undefined },
					feeds: []
				}
			}
			if (typeof f.table === "string") {
				return {
					read: {
						relation: `carrier:${f.table}`,
						mode: modeOf(f.context, false),
						own: true,
						group: undefined
					},
					feeds: f.feeds
				}
			}
			const rel = relation(f.table)
			return {
				read: {
					relation: rel,
					mode: modeOf(f.context, f.context.probe && written.has(rel)),
					own: false,
					group: boundGroup(
						fields(rel, bindingsOf(f.alias, f.conditions, f.context.scope, f.columns))
					)
				},
				feeds: f.feeds
			}
		}
	)
	const arbitrations = walk.arbitrations.map((a): ReadFact => {
		const rel = relation(a.table)
		return {
			relation: rel,
			mode: "arbiter",
			own: false,
			group: boundGroup(
				fields(
					rel,
					(a.columns ?? []).map((column): Bound => ({
						column,
						by: `excluded.${column}`,
						rows: "many"
					}))
				)
			)
		}
	})
	return {
		writes: walk.writes.map((w, i): WriteFact => ({
			relation: relation(w.table),
			op: w.op,
			from: reads.flatMap((r, index) =>
				r.read.mode === "positive" && r.feeds.includes(i) ? [index] : []
			)
		})),
		reads: [...reads.map((r) => r.read), ...arbitrations]
	}
}

/**
 * The facts of one change member's flight (analysis/isolation/facts.ts MemberFacts), read from its statements in the
 * order they run: what each writes, with the reads each written row is positively joined with, and what each reads.
 *
 * - A read's mode: `arbiter` for a table an EXISTS probes that its statement writes, an ON CONFLICT, and a MERGE's NOT
 *   MATCHED; else `negated` where its rows reach the statement by their absence (NOT EXISTS, NOT IN, EXCEPT's later
 *   arms, NOT) or either way (a predicate in a value or a branch, a NOT MATCHED BY SOURCE's source, a schema function
 *   no names clear); else `counted` beneath a scalar or ARRAY subquery or a core that counts; else `positive`.
 * - A carrier's read is the call's own, named `carrier:<name>`. A table no relation is read as `?schema.name`, a schema
 *   function no names clear as `?function:schema.name`, and a statement that is no DML, carrier, ANALYZE or
 *   transaction control as `?refresh:schema.name` or `?statement:<kind>`: the certifier refuses each as a relation it
 *   states no fact of.
 * - A table read's group is the fields its core's conditions bind to a parameter or to a column of a source in scope,
 *   the enclosing cores' included, that is the call's own: one value for the call where each is a parameter or the
 *   session's context's, else one group per own row. An ON CONFLICT's is its conflict columns', each bound to
 *   EXCLUDED's, one per proposed row.
 * - A derived table that only renames a relation's columns (projectionOf) reads that relation where it stands, keyed by
 *   the conditions of the core that reads it, through the renaming; any other derived table's reads are keyed by its own
 *   conditions alone, so an outside condition keys none of them.
 * - A write's rows are fed by the positive reads beneath it: an INSERT's source, an UPDATE's or a DELETE's target and
 *   FROM, a MERGE's source and target, and the query CTEs any of them read.
 */
export const memberFacts = (
	name: string,
	statements: NonEmptyReadonlyArray<SqlStatement>,
	names: ExtractNames
): MemberFacts => ({
	name,
	statements: mapNonEmpty(statements, (s) => statementFacts(s, names))
})
