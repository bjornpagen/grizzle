import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	type ArraysSource,
	bodyPositionNames,
	type ColumnDef,
	type Cte,
	type CteBody,
	cteNames,
	type Delete,
	type Expr,
	type FromItem,
	type FromSource,
	type FunctionCall,
	type Insert,
	type Merge,
	type MergeWhen,
	type OperandBody,
	type OperandSelect,
	type OrderItem,
	type PlBlock,
	type PlFunction,
	type PlStatement,
	type SeekBinding,
	type SelectCore,
	selectNames,
	type SqlStatement,
	type TableConstraint,
	type Target,
	type Update,
	type With
} from "#compiler/sql/ast.ts"

/**
 * Print scope: every name a statement the printer prints reads is bound where it reads it.
 *
 * A column reference in a query is qualified by a relation in reach of its place: an item of an enclosing FROM, or of
 * the FROM of a query it is correlated into, as PostgreSQL resolves it level by level. Within a FROM, a LATERAL item (a
 * probe and a met row among them) and a function's rows, whose LATERAL PostgreSQL reads as a noise word, reach the items
 * before it, a join chain's too, and no other item reaches its siblings; a join's ON reaches its own chain alone; a write's FROM and USING never reach its target; a MERGE's WHEN
 * reaches the side its match has, and its RETURNING the target alone where a WHEN NOT MATCHED BY SOURCE leaves rows of
 * no source. A relation the statement lists the columns of (a derived table, a CTE, a function's rows, VALUES, a
 * relation input's arrays, a context source, a probe) is read only at one of them. A CTE, the met rows' proposed rows
 * and INSERT, and the CTE an enclosing source reads are read only where a WITH in reach binds them: a non-recursive
 * WITH's CTE in the CTEs after it and in its query, a recursive WITH's in all of them, and a data-modifying CTE only
 * where it returns rows. A DDL expression and a set operation's ORDER BY name columns unqualified, each a column of its
 * table or an output of the operation where those are known; a key names a column of its table. A PL/pgSQL body names
 * only its arguments and the variables it declares.
 *
 * An escape is a defect of the compiler, never a property of its input: PostgreSQL refuses it at install or at its
 * first call (42P01, 42703), past every check grizzle runs at generate. So the printer holds every statement it prints to
 * it (sql/print-once.ts printedOnce, printedFunction; sql/print.ts writeDoBlock), an internal compiler error that names
 * the statement, the name and its place. It holds the statement as the lowering built it, before print once inlines a
 * CTE or pulls a sub-query up: scope is the lowering's meaning, and an escape a flatten happens to remove (a simple
 * sub-query, not LATERAL, naming an earlier FROM entry) is still the lowering's defect, visible the day the sub-query
 * is not flattenable; inlining and the flatten keep every name in its scope, each held to its own invariant.
 *
 * The check is one walk of the statement: each node is visited once, each binding made and undone once, and each
 * reference is one probe of the names bound at its place, whose visibility a window over its FROM decides at once (a
 * Frame's [lo, hi)), never a search of the scopes around it. Its work is linear in the statement, a constant factor of
 * the print.
 */

/** Where a column is named unqualified: a DDL expression over its table, or a set operation's ORDER BY. */
type UnqualifiedPlace = "DDL" | "a set operation's ORDER BY"

/**
 * A name a statement reads where nothing binds it, at `at`, its path in the statement: a column qualified by a relation
 * no FROM in reach binds (`relation`); one its relation in reach does not list (`column`); a query's column with no
 * qualifier (`unqualified`); a qualified column, or one its table or the operation's outputs do not list, where names
 * are unqualified (`qualified`, `unlisted`); a CTE no WITH in reach binds (`cte`); a PL/pgSQL variable its body does not
 * declare (`variable`).
 */
export type ScopeEscape =
	| {
			readonly kind: "relation"
			readonly alias: string
			readonly column: string
			readonly at: string
	  }
	| {
			readonly kind: "column"
			readonly alias: string
			readonly column: string
			readonly at: string
	  }
	| { readonly kind: "unqualified"; readonly column: string; readonly at: string }
	| {
			readonly kind: "qualified"
			readonly alias: string
			readonly column: string
			readonly place: UnqualifiedPlace
			readonly at: string
	  }
	| {
			readonly kind: "unlisted"
			readonly column: string
			readonly place: UnqualifiedPlace
			readonly at: string
	  }
	| { readonly kind: "cte"; readonly name: string; readonly at: string }
	| { readonly kind: "variable"; readonly name: string; readonly at: string }

/** The columns a relation in reach exposes where the statement lists them; undefined for a stored table's, unknown here. */
type Columns = ReadonlySet<string> | undefined

/**
 * What an expression's column references read: relations in reach (`query`); unqualified columns of a table or an
 * operation's outputs (`unqualified`), its columns undefined where they are not known; or nothing grizzle names, a
 * domain's CHECK, whose column references are the kernel audit's to refuse (`domain`).
 */
type Reach =
	| { readonly kind: "query" }
	| { readonly kind: "unqualified"; readonly place: UnqualifiedPlace; readonly columns: Columns }
	| { readonly kind: "domain" }

const query: Reach = Object.freeze({ kind: "query" })
const domain: Reach = Object.freeze({ kind: "domain" })

/** A DDL expression's reach: the columns of its table, where known. */
const ddl = (columns: Columns): Reach => ({ kind: "unqualified", place: "DDL", columns })

/**
 * One query level's FROM: the names it binds, in order, and the window [lo, hi) of them the place the walk stands at
 * reaches. Its owner moves the window as the walk enters each part of the level: a LATERAL item's reaches the items
 * before it, every other item's none, a join's ON its own chain, every clause after the FROM all of them.
 */
class Frame {
	readonly names: Array<string> = []
	lo = 0
	hi = 0

	/** The window over every name bound from `lo` on, as a LATERAL item placed now reaches them. */
	reachFrom(lo: number): void {
		this.lo = lo
		this.hi = this.names.length
	}

	/** The window over no name, as an item that is not LATERAL reaches. */
	reachNone(): void {
		this.lo = this.names.length
		this.hi = this.names.length
	}
}

/** A relation bound at one place of its frame, with the columns it exposes. */
interface Binder {
	readonly frame: Frame
	readonly index: number
	readonly columns: Columns
}

/** A CTE bound by a WITH in reach, with the columns it exposes. */
interface CteBinder {
	readonly columns: Columns
}

/** The names `names` lists, as a set, where every one is known; undefined where one is not. */
const knownNames = (names: ReadonlyArray<string | undefined>): Columns => {
	const known = new Set<string>()
	for (const name of names) {
		if (name === undefined) {
			return undefined
		}
		known.add(name)
	}
	return known
}

/** The columns a CTE exposes, where PostgreSQL names every one (sql/ast.ts cteNames). */
const cteColumns = (cte: Cte): Columns => knownNames(cteNames(cte))

/** Whether a CTE's rows are readable: a query's, or a data-modifying CTE's that returns rows. */
const readable = (cte: Cte): boolean =>
	cte.query.kind === "select" || cte.query.returning.length > 0

/**
 * The columns a FROM source exposes, as PostgreSQL names them from its print (sql/print.ts printFromItem): its column
 * list where it states one; a derived table's query's output names (sql/ast.ts selectNames); a function's rows' columns where it
 * names or defines them, unknown where it names none; the count of an input of no column, one column under the source's
 * alias, as PostgreSQL names a scalar function's; an input's arrays and its ordinal.
 */
const sourceColumns = (
	source: Exclude<FromSource, { readonly kind: "cte" | "enclosing" }>
): Columns => {
	switch (source.kind) {
		case "table":
		case "read":
		case "transition":
			return undefined
		case "probe":
		case "met":
			return new Set(source.columns.map((c) => c.as))
		case "metRows":
			return new Set(source.columns.map((c) => c.column))
		case "derived":
			return knownNames(selectNames(source.query))
		case "function":
			return source.columns.kind === "defined"
				? new Set(source.columns.definitions.map((d) => d.name))
				: source.columns.names.length > 0
					? new Set(source.columns.names)
					: undefined
		case "arrays":
			return arraysColumns(source.source, source.alias)
		case "values":
			return new Set(source.columns)
		case "context":
			return new Set(source.columns.map((c) => c.column.name))
	}
}

/**
 * The columns of rows as arrays under `alias`: an input's arrays and its ordinal, each under its definition's name; the
 * count of an input of no column, one column under the alias, as PostgreSQL names a scalar function's; or the arrays a
 * row carries.
 */
const arraysColumns = (source: ArraysSource, alias: string): Columns => {
	switch (source.kind) {
		case "count":
			return new Set([alias])
		case "columns": {
			const names = source.columns.map((c) => c.definition.name)
			return new Set(source.ordinal === undefined ? names : [...names, source.ordinal])
		}
		case "carried":
		case "setting":
			return new Set(source.columns.map((c) => c.definition.name))
	}
}

/** A path into the statement, as the kernel audit spells one: `with[0].query.body.from[1].alias`. */
const formatPath = (path: ReadonlyArray<string | number>): string => {
	let out = ""
	for (const segment of path) {
		if (typeof segment === "number") {
			out += `[${segment}]`
		} else {
			out += out === "" ? segment : `.${segment}`
		}
	}
	return out === "" ? "statement" : out
}

/**
 * The walk: the relations bound at the current place, by name, each name's binders innermost last; the CTEs bound, by
 * name, likewise; the PL/pgSQL variables declared, undefined outside a body; the path to the current place; and every
 * escape met, in walk order. Where `sought` names a relation or a CTE, every place that binds it is kept in `bound`, for
 * the report of an escape of it.
 */
class ScopeWalk {
	readonly escapes: Array<ScopeEscape> = []
	readonly bound = new Map<string, Array<string>>()
	readonly #sought: ReadonlySet<string>
	readonly #relations = new Map<string, Array<Binder>>()
	readonly #ctes = new Map<string, Array<CteBinder>>()
	readonly #path: Array<string | number> = []
	#variables: ReadonlySet<string> | undefined = undefined

	constructor(sought: ReadonlySet<string>) {
		this.#sought = sought
	}

	#at<A>(segment: string | number, f: () => A): A {
		this.#path.push(segment)
		const out = f()
		this.#path.pop()
		return out
	}

	#where(): string {
		return formatPath(this.#path)
	}

	#note(name: string, segment: string): void {
		if (!this.#sought.has(name)) {
			return
		}
		const at = formatPath([...this.#path, segment])
		const places = this.bound.get(name)
		if (places === undefined) {
			this.bound.set(name, [at])
		} else {
			places.push(at)
		}
	}

	/** Binds `name` at the next place of `frame`, exposing `columns`. */
	#bind(frame: Frame, name: string, columns: Columns, segment: string): void {
		this.#note(name, segment)
		const binder: Binder = { frame, index: frame.names.length, columns }
		frame.names.push(name)
		const stack = this.#relations.get(name)
		if (stack === undefined) {
			this.#relations.set(name, [binder])
		} else {
			stack.push(binder)
		}
	}

	/** Undoes every binding of `frame`, each the innermost of its name: frames close in the order opposite to their opening. */
	#close(frame: Frame): void {
		for (const name of frame.names) {
			this.#relations.get(name)?.pop()
		}
	}

	/** Whether a binder's place lies in its frame's window. */
	#reaches(binder: Binder): boolean {
		return binder.index >= binder.frame.lo && binder.index < binder.frame.hi
	}

	/** The innermost relation of `alias` in reach of the current place, or undefined where none is. */
	#relation(alias: string): Binder | undefined {
		const stack = this.#relations.get(alias)
		if (stack === undefined) {
			return undefined
		}
		for (let i = stack.length - 1; i >= 0; i -= 1) {
			const binder = stack[i]
			if (binder !== undefined && this.#reaches(binder)) {
				return binder
			}
		}
		return undefined
	}

	#bindCte(cte: Cte, bound: Array<string>): void {
		this.#note(cte.name, "name")
		const binder: CteBinder = { columns: cteColumns(cte) }
		const stack = this.#ctes.get(cte.name)
		if (stack === undefined) {
			this.#ctes.set(cte.name, [binder])
		} else {
			stack.push(binder)
		}
		bound.push(cte.name)
	}

	#unbindCtes(bound: ReadonlyArray<string>): void {
		for (const name of bound) {
			this.#ctes.get(name)?.pop()
		}
	}

	/** The CTE `name` a WITH in reach binds, reported where none does. */
	#cte(name: string, segment: string): CteBinder | undefined {
		const binder = this.#ctes.get(name)?.at(-1)
		if (binder === undefined) {
			this.escapes.push({ kind: "cte", name, at: formatPath([...this.#path, segment]) })
		}
		return binder
	}

	/** A reference `"<alias>"."<column>"` in a query, as a printed source states one past any Expr. */
	#reference(alias: string, column: string): void {
		const binder = this.#relation(alias)
		if (binder === undefined) {
			this.escapes.push({ kind: "relation", alias, column, at: this.#where() })
		} else if (binder.columns !== undefined && !binder.columns.has(column)) {
			this.escapes.push({ kind: "column", alias, column, at: this.#where() })
		}
	}

	#column(e: Extract<Expr, { readonly kind: "column" }>, reach: Reach): void {
		switch (reach.kind) {
			case "query":
				if (e.table === undefined) {
					this.escapes.push({ kind: "unqualified", column: e.column, at: this.#where() })
				} else {
					this.#reference(e.table, e.column)
				}
				return
			case "unqualified":
				if (e.table !== undefined) {
					this.escapes.push({
						kind: "qualified",
						alias: e.table,
						column: e.column,
						place: reach.place,
						at: this.#where()
					})
				} else if (reach.columns !== undefined && !reach.columns.has(e.column)) {
					this.escapes.push({
						kind: "unlisted",
						column: e.column,
						place: reach.place,
						at: this.#where()
					})
				}
				return
			case "domain":
				return
		}
	}

	#variable(name: string): void {
		if (this.#variables !== undefined && !this.#variables.has(name)) {
			this.escapes.push({ kind: "variable", name, at: this.#where() })
		}
	}

	/** The names of a key, each a column of `columns` where those are known. */
	#keyColumns(names: ReadonlyArray<string>, columns: Columns, segment: string): void {
		if (columns === undefined) {
			return
		}
		this.#at(segment, () => {
			for (const [i, name] of names.entries()) {
				if (!columns.has(name)) {
					this.escapes.push({
						kind: "unlisted",
						column: name,
						place: "DDL",
						at: formatPath([...this.#path, i])
					})
				}
			}
		})
	}

	/** A VALUES list's rows, each value a query expression. */
	#rows(rows: ReadonlyArray<ReadonlyArray<Expr>>): void {
		this.#at("rows", () => {
			for (const [i, row] of rows.entries()) {
				this.#at(i, () => {
					for (const [j, e] of row.entries()) {
						this.#at(j, () => {
							this.#expr(e, query)
						})
					}
				})
			}
		})
	}

	#exprs(list: ReadonlyArray<Expr>, reach: Reach, segment: string): void {
		this.#at(segment, () => {
			for (const [i, e] of list.entries()) {
				this.#at(i, () => {
					this.#expr(e, reach)
				})
			}
		})
	}

	#expr(e: Expr, reach: Reach): void {
		switch (e.kind) {
			case "column":
				this.#column(e, reach)
				return
			case "excluded":
			case "returning":
			case "param":
			case "literal":
			case "domainValue":
			case "user":
			case "plSpecial":
			case "regclass":
				return
			case "clock":
				if (e.instant.kind === "moved") {
					const at = e.instant.at
					this.#at("instant", () => {
						this.#expr(at, reach)
					})
				}
				return
			case "plVar":
				this.#variable(e.name)
				return
			case "field":
				if (e.record.kind === "plVar") {
					this.#variable(e.record.name)
				}
				return
			case "cast":
			case "access":
			case "collate":
			case "negate":
			case "not":
			case "isTrue":
			case "complement":
			case "lowerAscii":
				this.#at("expr", () => {
					this.#expr(e.expr, reach)
				})
				return
			case "binary":
				this.#at("left", () => {
					this.#expr(e.left, reach)
				})
				this.#at("right", () => {
					this.#expr(e.right, reach)
				})
				return
			case "nullif":
				this.#at("expr", () => {
					this.#expr(e.expr, reach)
				})
				this.#at("absent", () => {
					this.#expr(e.absent, reach)
				})
				return
			case "subscript":
				this.#at("array", () => {
					this.#expr(e.array, reach)
				})
				this.#at("index", () => {
					this.#expr(e.index, reach)
				})
				return
			case "attribute":
				this.#at("record", () => {
					this.#expr(e.record, reach)
				})
				return
			case "and":
			case "or":
			case "greatest":
			case "least":
			case "coalesce":
				this.#exprs(e.args, reach, "args")
				return
			case "between":
				this.#at("expr", () => {
					this.#expr(e.expr, reach)
				})
				this.#at("low", () => {
					this.#expr(e.low, reach)
				})
				this.#at("high", () => {
					this.#expr(e.high, reach)
				})
				return
			case "inList":
				this.#at("expr", () => {
					this.#expr(e.expr, reach)
				})
				this.#exprs(e.list, reach, "list")
				return
			case "inQuery":
				this.#at("expr", () => {
					this.#expr(e.expr, reach)
				})
				this.#at("query", () => {
					this.#select(e.query)
				})
				return
			case "equalsAny":
				this.#at("expr", () => {
					this.#expr(e.expr, reach)
				})
				this.#at("array", () => {
					this.#expr(e.array, reach)
				})
				return
			case "exists":
			case "subquery":
			case "array":
				this.#at("query", () => {
					this.#select(e.query)
				})
				return
			case "row":
				this.#exprs(e.items, reach, "items")
				return
			case "case":
				if (e.operand !== undefined) {
					const operand = e.operand
					this.#at("operand", () => {
						this.#expr(operand, reach)
					})
				}
				this.#at("whens", () => {
					for (const [i, branch] of e.whens.entries()) {
						this.#at(i, () => {
							this.#at("when", () => {
								this.#expr(branch.when, reach)
							})
							this.#at("result", () => {
								this.#expr(branch.result, reach)
							})
						})
					}
				})
				this.#at("else", () => {
					this.#expr(e.else, reach)
				})
				return
			case "call":
				this.#call(e, reach)
				return
		}
	}

	#call(call: FunctionCall, reach: Reach): void {
		if (call.star) {
			if (call.filter !== undefined) {
				const filter = call.filter
				this.#at("filter", () => {
					this.#expr(filter, reach)
				})
			}
		} else {
			this.#exprs(call.args, reach, "args")
			this.#orderBy(call.orderBy, reach, "orderBy")
			this.#orderBy(call.withinGroup, reach, "withinGroup")
		}
		if (call.over !== undefined) {
			const over = call.over
			this.#at("over", () => {
				this.#exprs(over.partitionBy, reach, "partitionBy")
				this.#orderBy(over.orderBy, reach, "orderBy")
			})
		}
	}

	#orderBy(items: ReadonlyArray<OrderItem>, reach: Reach, segment: string): void {
		this.#at(segment, () => {
			for (const [i, item] of items.entries()) {
				this.#at(i, () => {
					this.#expr(item.expr, reach)
				})
			}
		})
	}

	#targets(targets: ReadonlyArray<Target>, segment: string): void {
		this.#at(segment, () => {
			for (const [i, target] of targets.entries()) {
				this.#at(i, () => {
					this.#at("expr", () => {
						this.#expr(target.expr, query)
					})
				})
			}
		})
	}

	/** A WITH's CTEs, each body walked where its CTE is not yet bound unless the WITH is recursive; the names it bound. */
	#with(w: With): ReadonlyArray<string> {
		const bound: Array<string> = []
		this.#at("with", () => {
			if (w.recursive) {
				for (const [i, cte] of w.ctes.entries()) {
					this.#at(i, () => {
						this.#bindCte(cte, bound)
					})
				}
			}
			for (const [i, cte] of w.ctes.entries()) {
				this.#at(i, () => {
					this.#at("query", () => {
						this.#cteBody(cte.query)
					})
					if (!w.recursive && readable(cte)) {
						this.#bindCte(cte, bound)
					}
				})
			}
		})
		return bound
	}

	#cteBody(body: CteBody): void {
		switch (body.kind) {
			case "select":
				this.#select(body)
				return
			case "insert":
				this.#insert(body)
				return
			case "update":
				this.#update(body)
				return
			case "delete":
				this.#delete(body)
				return
			case "merge":
				this.#merge(body)
				return
		}
	}

	/**
	 * A query, in reach of whatever reaches its place: its WITH, its body, its ORDER BY over its core's FROM or its set
	 * operation's outputs, and its LIMIT and OFFSET, which reach no FROM of its own.
	 */
	#select(q: OperandSelect): void {
		const ctes = q.with === undefined ? [] : this.#with(q.with)
		const body = q.body
		if (body.kind === "core") {
			const frame = this.#at("body", () => this.#core(body))
			this.#orderBy(q.orderBy, query, "orderBy")
			this.#close(frame)
		} else {
			this.#at("body", () => {
				this.#body(body)
			})
			this.#orderBy(
				q.orderBy,
				{
					kind: "unqualified",
					place: "a set operation's ORDER BY",
					columns: knownNames(bodyPositionNames(body))
				},
				"orderBy"
			)
		}
		if (q.limit !== undefined) {
			const limit = q.limit
			this.#at("limit", () => {
				this.#expr(limit, query)
			})
		}
		if (q.offset !== undefined) {
			const offset = q.offset
			this.#at("offset", () => {
				this.#expr(offset, query)
			})
		}
		this.#unbindCtes(ctes)
	}

	/** A body that is no core: a set operation's arms, each in reach of the body's place alone, or a parenthesized query. */
	#body(body: Exclude<OperandBody, SelectCore>): void {
		if (body.kind === "select") {
			this.#select(body)
			return
		}
		this.#at("arms", () => {
			for (const [i, arm] of body.arms.entries()) {
				this.#at(i, () => {
					if (arm.kind === "core") {
						this.#close(this.#core(arm))
					} else {
						this.#select(arm)
					}
				})
			}
		})
	}

	/** A core's FROM, then its clauses over all of it; its frame, still open for its query's ORDER BY. */
	#core(core: SelectCore): Frame {
		const frame = new Frame()
		this.#at("from", () => {
			for (const [i, item] of core.from.entries()) {
				this.#at(i, () => {
					this.#fromItem(item, frame, 0)
				})
			}
		})
		frame.reachFrom(0)
		if (typeof core.distinct === "object") {
			this.#exprs(core.distinct.on, query, "distinct")
		}
		this.#targets(core.targets, "targets")
		if (core.where !== undefined) {
			const where = core.where
			this.#at("where", () => {
				this.#expr(where, query)
			})
		}
		this.#levelReads(core.from, "from")
		this.#exprs(core.groupBy, query, "groupBy")
		if (core.having !== undefined) {
			const having = core.having
			this.#at("having", () => {
				this.#expr(having, query)
			})
		}
		return frame
	}

	/**
	 * A FROM item bound in `frame`, whose FROM items begin at `lo` (a write's target stands before them). A join chain's
	 * ON reaches the chain alone.
	 */
	#fromItem(item: FromItem, frame: Frame, lo: number): void {
		if (item.kind !== "joins") {
			this.#source(item, frame, lo)
			return
		}
		const start = frame.names.length
		this.#at("first", () => {
			this.#source(item.first, frame, lo)
		})
		this.#at("steps", () => {
			for (const [i, step] of item.steps.entries()) {
				this.#at(i, () => {
					this.#at("source", () => {
						this.#source(step.source, frame, lo)
					})
					if (step.kind === "cross") {
						return
					}
					frame.reachFrom(start)
					this.#at("on", () => {
						this.#expr(step.on, query)
					})
					this.#at("source", () => {
						this.#readConditions(step.source)
					})
				})
			}
		})
	}

	/**
	 * A source bound in `frame`: what it reads walked first, in reach of the items before it where it is LATERAL or a
	 * function's rows, and of none of them otherwise.
	 */
	#source(source: FromSource, frame: Frame, lo: number): void {
		switch (source.kind) {
			case "table":
			case "read":
			case "transition":
			case "context":
				break
			case "probe":
			case "met": {
				frame.reachFrom(lo)
				const inner = new Frame()
				this.#bind(inner, source.inner, undefined, "inner")
				inner.reachFrom(0)
				if (source.kind === "probe") {
					this.#at("by", () => {
						for (const [i, c] of source.by.columns.entries()) {
							this.#at(i, () => {
								this.#at("value", () => {
									this.#expr(c.value, query)
								})
							})
						}
					})
				} else {
					this.#at("key", () => {
						for (const [i, k] of source.key.entries()) {
							this.#at(i, () => {
								this.#reference(source.rows, k.from)
							})
						}
					})
				}
				this.#exprs(source.filter, query, "filter")
				this.#close(inner)
				break
			}
			case "metRows": {
				const proposed = this.#cte(source.proposed, "proposed")
				const inserted = this.#cte(source.insert, "insert")
				this.#at("columns", () => {
					for (const [i, c] of source.columns.entries()) {
						this.#at(i, () => {
							this.#listed(proposed, source.scan, c.column)
							this.#listed(inserted, source.returned, c.returned)
						})
					}
				})
				this.#at("key", () => {
					for (const [i, k] of source.key.entries()) {
						this.#at(i, () => {
							this.#listed(proposed, source.scan, k.column)
							this.#listed(inserted, source.returned, k.from)
						})
					}
				})
				break
			}
			case "cte": {
				const cte = this.#cte(source.name, "name")
				this.#bind(frame, source.alias ?? source.name, cte?.columns, "alias")
				return
			}
			case "enclosing": {
				const cte = this.#cte(source.name, "name")
				this.#bind(frame, source.alias, cte?.columns, "alias")
				return
			}
			case "derived":
				if (source.lateral) {
					frame.reachFrom(lo)
				} else {
					frame.reachNone()
				}
				this.#at("query", () => {
					this.#select(source.query)
				})
				break
			case "function":
				frame.reachFrom(lo)
				this.#at("call", () => {
					this.#call(source.call, query)
				})
				break
			case "arrays":
				if (source.source.kind === "carried") {
					frame.reachNone()
					const columns = source.source.columns
					this.#at("source", () => {
						for (const [i, c] of columns.entries()) {
							this.#at(i, () => {
								this.#expr(c.array, query)
							})
						}
					})
				}
				break
			case "values":
				frame.reachNone()
				this.#rows(source.rows)
				break
		}
		this.#bind(frame, source.alias, sourceColumns(source), "alias")
	}

	/** A column the met rows read of the CTE `cte` under `alias`, which it lists where it lists its columns. */
	#listed(cte: CteBinder | undefined, alias: string, column: string): void {
		if (cte?.columns !== undefined && !cte.columns.has(column)) {
			this.escapes.push({ kind: "column", alias, column, at: this.#where() })
		}
	}

	#assignments(set: ReadonlyArray<{ readonly value: Expr }>, segment: string): void {
		this.#at(segment, () => {
			for (const [i, a] of set.entries()) {
				this.#at(i, () => {
					this.#expr(a.value, query)
				})
			}
		})
	}

	/** An INSERT: its source in reach of nothing of its own, its ON CONFLICT and RETURNING of its alias alone. */
	#insert(insert: Insert): void {
		const ctes = insert.with === undefined ? [] : this.#with(insert.with)
		const source = insert.source
		this.#at("source", () => {
			if (source.kind === "query") {
				this.#at("query", () => {
					this.#select(source.query)
				})
			} else {
				this.#rows(source.rows)
			}
		})
		const frame = new Frame()
		if (insert.alias !== undefined) {
			this.#bind(frame, insert.alias, undefined, "alias")
		}
		frame.reachFrom(0)
		const conflict = insert.onConflict
		if (conflict?.kind === "columns") {
			const action = conflict.action
			this.#at("onConflict", () => {
				if (action.kind === "doUpdate") {
					this.#assignments(action.set, "set")
				}
				if (action.kind !== "doNothing" && action.where !== undefined) {
					const where = action.where
					this.#at("where", () => {
						this.#expr(where, query)
					})
				}
			})
		}
		this.#targets(insert.returning, "returning")
		this.#close(frame)
		this.#unbindCtes(ctes)
	}

	/**
	 * The conditions of the bound reads of a FROM list its WHERE states (sql/print.ts levelWhere), each read where its
	 * level's WHERE reads: a FROM list's item's, a join chain's first source's and each cross join's source's.
	 */
	#levelReads(from: ReadonlyArray<FromItem>, segment: string): void {
		this.#at(segment, () => {
			for (const [i, item] of from.entries()) {
				this.#at(i, () => {
					if (item.kind !== "joins") {
						this.#readConditions(item)
						return
					}
					this.#at("first", () => {
						this.#readConditions(item.first)
					})
					this.#at("steps", () => {
						for (const [j, step] of item.steps.entries()) {
							if (step.kind === "cross") {
								this.#at(j, () => {
									this.#at("source", () => {
										this.#readConditions(step.source)
									})
								})
							}
						}
					})
				})
			}
		})
	}

	/**
	 * A bound read's conditions, its access's bindings and stated conditions or its tuple id, read where they print; none
	 * of any other source.
	 */
	#readConditions(source: FromSource): void {
		if (source.kind !== "read") {
			return
		}
		const access = source.access
		const bound = (bindings: ReadonlyArray<SeekBinding>) => {
			this.#at("bound", () => {
				for (const [i, b] of bindings.entries()) {
					this.#at(i, () => {
						this.#at("condition", () => {
							this.#expr(b.condition, query)
						})
					})
				}
			})
		}
		const condition = (e: Expr) => {
			this.#at("condition", () => {
				this.#expr(e, query)
			})
		}
		this.#at("access", () => {
			switch (access.kind) {
				case "whole":
				case "nearest":
					return
				case "seek":
				case "ordered":
					bound(access.bound)
					return
				case "row":
					this.#at("values", () => {
						for (const [i, v] of access.values.entries()) {
							this.#at(i, () => {
								this.#expr(v, query)
							})
						}
					})
					return
				case "range":
					bound(access.bound)
					this.#at("conditions", () => {
						for (const [i, c] of access.conditions.entries()) {
							this.#at(i, () => {
								this.#expr(c, query)
							})
						}
					})
					return
				case "span":
				case "network":
					bound(access.bound)
					condition(access.condition)
					return
				case "search":
					condition(access.condition)
					return
				case "tid":
					this.#at("at", () => {
						this.#expr(access.at, query)
					})
					return
			}
		})
	}

	/** A write's target, then its FROM or USING, which never reach the target, in one frame. */
	#writeFrame(alias: string, items: ReadonlyArray<FromItem>, segment: string): Frame {
		const frame = new Frame()
		this.#bind(frame, alias, undefined, "alias")
		this.#at(segment, () => {
			for (const [i, item] of items.entries()) {
				this.#at(i, () => {
					this.#fromItem(item, frame, 1)
				})
			}
		})
		frame.reachFrom(0)
		return frame
	}

	#update(update: Update): void {
		const ctes = update.with === undefined ? [] : this.#with(update.with)
		const frame = this.#writeFrame(update.alias, update.from, "from")
		this.#assignments(update.set, "set")
		if (update.where !== undefined) {
			const where = update.where
			this.#at("where", () => {
				this.#expr(where, query)
			})
		}
		this.#levelReads(update.from, "from")
		this.#targets(update.returning, "returning")
		this.#close(frame)
		this.#unbindCtes(ctes)
	}

	#delete(del: Delete): void {
		const ctes = del.with === undefined ? [] : this.#with(del.with)
		const frame = this.#writeFrame(del.alias, del.using, "using")
		if (del.where !== undefined) {
			const where = del.where
			this.#at("where", () => {
				this.#expr(where, query)
			})
		}
		this.#levelReads(del.using, "using")
		this.#targets(del.returning, "returning")
		this.#close(frame)
		this.#unbindCtes(ctes)
	}

	/**
	 * A MERGE: its target, then its source, which never reaches it. Its ON reaches both, a WHEN the side its match has
	 * (WHEN NOT MATCHED the source, WHEN NOT MATCHED BY SOURCE the target), and its RETURNING the target alone where a
	 * WHEN NOT MATCHED BY SOURCE returns rows of no source.
	 */
	#merge(merge: Merge): void {
		const ctes = merge.with === undefined ? [] : this.#with(merge.with)
		const frame = new Frame()
		this.#bind(frame, merge.alias, undefined, "alias")
		this.#at("using", () => {
			this.#fromItem(merge.using, frame, 1)
		})
		const both = (): void => {
			frame.reachFrom(0)
		}
		const side = (match: MergeWhen["match"]): void => {
			switch (match) {
				case "MATCHED":
					frame.reachFrom(0)
					return
				case "NOT MATCHED":
					frame.reachFrom(1)
					return
				case "NOT MATCHED BY SOURCE":
					frame.lo = 0
					frame.hi = 1
					return
			}
		}
		both()
		this.#at("on", () => {
			this.#expr(merge.on, query)
		})
		this.#at("whens", () => {
			for (const [i, when] of merge.whens.entries()) {
				this.#at(i, () => {
					side(when.match)
					if (when.condition !== undefined) {
						const condition = when.condition
						this.#at("condition", () => {
							this.#expr(condition, query)
						})
					}
					const action = when.action
					if (action.kind === "update") {
						this.#assignments(action.set, "set")
					} else if (action.kind === "insert") {
						this.#assignments(action.row, "row")
					}
				})
			}
		})
		if (merge.whens.some((when) => when.match === "NOT MATCHED BY SOURCE")) {
			side("NOT MATCHED BY SOURCE")
		} else {
			both()
		}
		this.#targets(merge.returning, "returning")
		this.#close(frame)
		this.#unbindCtes(ctes)
	}

	/** A DDL expression over a table whose columns are `columns`, where known, at `segment`. */
	#ddl(e: Expr, columns: Columns, segment: string): void {
		this.#at(segment, () => {
			this.#expr(e, ddl(columns))
		})
	}

	/** A DDL expression in which a PL/pgSQL variable names nothing declared, as no body declares one around it. */
	#bodiless(e: Expr, segment: string): void {
		this.#variables = new Set()
		this.#ddl(e, undefined, segment)
		this.#variables = undefined
	}

	#columnDef(column: ColumnDef, columns: Columns): void {
		const generated = column.generated
		if (generated === undefined) {
			return
		}
		switch (generated.kind) {
			case "stored":
				this.#ddl(generated.expr, columns, "generated")
				return
			case "partial":
				this.#at("generated", () => {
					this.#ddl(generated.when, columns, "when")
					this.#ddl(generated.expr, columns, "expr")
				})
				return
		}
	}

	#columnDefs(defs: ReadonlyArray<ColumnDef>, columns: Columns): void {
		this.#at("columns", () => {
			for (const [i, column] of defs.entries()) {
				this.#at(i, () => {
					this.#columnDef(column, columns)
				})
			}
		})
	}

	#constraint(constraint: TableConstraint, columns: Columns): void {
		switch (constraint.kind) {
			case "primaryKey":
			case "unique":
				this.#keyColumns(
					constraint.columns.map((c) => c.column),
					columns,
					"columns"
				)
				return
			case "foreignKey":
				this.#keyColumns(
					constraint.columns.map((c) => c.column),
					columns,
					"columns"
				)
				return
			case "check":
				this.#ddl(constraint.predicate, columns, "predicate")
				return
			case "exclude":
				this.#keyColumns(
					constraint.elements.map((e) => e.column),
					columns,
					"elements"
				)
				return
		}
	}

	#plStatements(statements: ReadonlyArray<PlStatement>, segment: string): void {
		this.#at(segment, () => {
			for (const [i, s] of statements.entries()) {
				this.#at(i, () => {
					this.#plStatement(s)
				})
			}
		})
	}

	#plStatement(statement: PlStatement): void {
		switch (statement.kind) {
			case "if":
				this.#at("branches", () => {
					for (const [i, branch] of statement.branches.entries()) {
						this.#at(i, () => {
							this.#at("condition", () => {
								this.#expr(branch.condition, query)
							})
							this.#plStatements(branch.body, "body")
						})
					}
				})
				this.#plStatements(statement.else, "else")
				return
			case "assign":
				this.#variable(statement.target)
				this.#at("value", () => {
					this.#expr(statement.value, query)
				})
				return
			case "forQuery":
				this.#variable(statement.variable)
				this.#at("query", () => {
					this.#select(statement.query)
				})
				this.#plStatements(statement.body, "body")
				return
			case "perform":
				this.#at("query", () => {
					this.#select({ kind: "select", with: undefined, ...statement.query })
				})
				return
			case "whenFound":
				this.#at("query", () => {
					this.#select(statement.query)
				})
				this.#plStatements(statement.body, "body")
				return
			case "wholeReads":
				this.#plStatements(statement.body, "body")
				return
			case "modify":
				this.#at("statement", () => {
					this.#cteBody(statement.statement)
				})
				return
			case "returnQuery":
				this.#at("query", () => {
					this.#select(statement.query)
				})
				return
			case "case":
				this.#at("operand", () => {
					this.#expr(statement.operand, query)
				})
				this.#at("whens", () => {
					for (const [i, when] of statement.whens.entries()) {
						this.#at(i, () => {
							this.#exprs(when.values, query, "values")
							this.#plStatements(when.body, "body")
						})
					}
				})
				return
			case "raise":
				this.#at("using", () => {
					for (const [i, option] of statement.using.entries()) {
						this.#at(i, () => {
							this.#at("value", () => {
								this.#expr(option.value, query)
							})
						})
					}
				})
				return
			case "return":
				this.#at("value", () => {
					this.#expr(statement.value, query)
				})
				return
			case "createSessionTable":
			case "createSessionIndex":
			case "truncateSessionTable":
			case "createSessionTrigger":
				return
		}
	}

	/** A PL/pgSQL block whose arguments are `params`: they and its declared variables are the names its body reads. */
	block(params: ReadonlyArray<{ readonly name: string }>, block: PlBlock): void {
		this.#variables = new Set([...params.map((p) => p.name), ...block.declare.map((d) => d.name)])
		this.#plStatements(block.body, "body")
		this.#variables = undefined
	}

	#plFunction(fn: PlFunction): void {
		this.#at("body", () => {
			this.block(fn.params, fn.body)
		})
	}

	statement(statement: SqlStatement): void {
		switch (statement.kind) {
			case "select":
				this.#select(statement)
				return
			case "insert":
			case "update":
			case "delete":
			case "merge":
				this.#cteBody(statement)
				return
			case "fillStored":
			case "createStoredTable":
			case "createView":
				this.#at("query", () => {
					this.#select(statement.query)
				})
				return
			case "createTable": {
				const columns = new Set(statement.columns.map((c) => c.name))
				this.#columnDefs(statement.columns, columns)
				this.#at("primaryKey", () => {
					this.#constraint(statement.primaryKey, columns)
				})
				this.#at("secondary", () => {
					for (const [i, c] of statement.secondary.entries()) {
						this.#at(i, () => {
							this.#constraint(c, columns)
						})
					}
				})
				return
			}
			case "alterTable":
				this.#at("actions", () => {
					for (const [i, action] of statement.actions.entries()) {
						this.#at(i, () => {
							switch (action.kind) {
								case "setExpression": {
									const g = action.generation
									this.#at("generation", () => {
										if (g.kind === "partial") {
											this.#bodiless(g.when, "when")
										}
										this.#bodiless(g.expr, "expr")
									})
									return
								}
								case "addColumn":
								case "addColumnPlaceholder":
								case "addColumnUnchecked":
									this.#at("column", () => {
										this.#columnDef(action.column, undefined)
									})
									return
								case "addColumnDefault":
									this.#at("column", () => {
										this.#columnDef(action.column, undefined)
									})
									this.#bodiless(action.default, "default")
									return
								case "addConstraint":
									this.#at("constraint", () => {
										this.#constraint(action.constraint, undefined)
									})
									return
								case "alterColumnType":
									if (action.using.kind === "expr") {
										const using = action.using.expr
										this.#at("using", () => {
											this.#ddl(using, undefined, "expr")
										})
									}
									return
								case "addConstraintUsingIndex":
								case "dropColumn":
								case "dropDefault":
								case "setNotNull":
								case "validateConstraint":
								case "alterConstraintDeferral":
								case "dropConstraint":
								case "enableRowSecurity":
								case "disableRowSecurity":
								case "replicaIdentity":
									return
							}
						})
					}
				})
				return
			case "createDomain":
				this.#at("constraints", () => {
					for (const [i, c] of statement.constraints.entries()) {
						this.#at(i, () => {
							this.#at("predicate", () => {
								this.#expr(c.predicate, domain)
							})
						})
					}
				})
				return
			case "alterDomain":
				if (statement.action.kind === "addConstraint") {
					const predicate = statement.action.constraint.predicate
					this.#at("predicate", () => {
						this.#expr(predicate, domain)
					})
				}
				return
			case "createIndex":
				this.#at("keys", () => {
					for (const [i, key] of statement.keys.entries()) {
						if (key.key.kind === "expr") {
							const e = key.key.expr
							this.#at(i, () => {
								this.#ddl(e, undefined, "key")
							})
						}
					}
				})
				if (statement.where !== undefined) {
					this.#ddl(statement.where, undefined, "where")
				}
				return
			case "createPolicy": {
				const frame = new Frame()
				this.#bind(frame, statement.table.name, undefined, "table")
				frame.reachFrom(0)
				this.#at("filter", () => {
					this.#expr(statement.filter, query)
				})
				this.#close(frame)
				return
			}
			case "createFunction":
				if (statement.language === "plpgsql") {
					this.#plFunction(statement)
					return
				}
				this.#variables = new Set()
				this.#at("body", () => {
					this.#expr(statement.body, query)
				})
				this.#variables = undefined
				return
			case "createConstant":
				this.#constantBody(statement.body)
				return
			case "replaceConstant":
				this.#at("constant", () => {
					this.#constantBody(statement.constant.body)
				})
				return
			case "createSchema":
			case "rename":
			case "renameColumn":
			case "renameConstraint":
			case "dropIndex":
			case "drop":
			case "dropPolicy":
			case "grantRole":
			case "revokeRole":
			case "grantColumns":
			case "dropFunction":
			case "dropTrigger":
			case "createDeclaredFunction":
			case "handOverFunction":
			case "createRowType":
			case "alterRowType":
			case "adoptRole":
			case "endHolders":
			case "stubConstant":
			case "packConstant":
			case "createGuardTrigger":
			case "createImmutableGuardTrigger":
			case "createConstraintTrigger":
			case "createTransitionTrigger":
			case "createPublication":
			case "dropPublication":
			case "createLiveSecret":
			case "guardBracket":
			case "createRole":
			case "alterRole":
			case "grant":
			case "revoke":
			case "alterDefaultPrivileges":
			case "createExtension":
			case "lockTable":
			case "comment":
			case "beginRead":
			case "beginWrite":
			case "commit":
			case "rollback":
			case "setConstraintsImmediate":
				return
		}
	}

	/** A constant's RETURN: a scalar subquery of no outer scope, or a DDL expression of no table. */
	#constantBody(body: Expr): void {
		if (body.kind === "subquery") {
			const subquery = body.query
			this.#at("body", () => {
				this.#at("query", () => {
					this.#select(subquery)
				})
			})
			return
		}
		this.#ddl(body, undefined, "body")
	}
}

/** What the scope check walks: a statement, or a PL/pgSQL block with the arguments its body reads, a DO block's none. */
type Walked =
	| { readonly kind: "statement"; readonly statement: SqlStatement }
	| {
			readonly kind: "block"
			readonly params: ReadonlyArray<{ readonly name: string }>
			readonly block: PlBlock
	  }

const walked = (subject: Walked, sought: ReadonlySet<string>): ScopeWalk => {
	const walk = new ScopeWalk(sought)
	switch (subject.kind) {
		case "statement":
			walk.statement(subject.statement)
			break
		case "block":
			walk.block(subject.params, subject.block)
			break
	}
	return walk
}

/** Every name `statement` reads where nothing binds it, in walk order (the module header); none where it is in scope. */
export const scopeEscapes = (statement: SqlStatement): ReadonlyArray<ScopeEscape> =>
	walked({ kind: "statement", statement }, new Set()).escapes

/** Every name a PL/pgSQL block reads where nothing binds it, its arguments `params`, a DO block's none, in walk order. */
const blockEscapes = (
	params: ReadonlyArray<{ readonly name: string }>,
	block: PlBlock
): ReadonlyArray<ScopeEscape> => walked({ kind: "block", params, block }, new Set()).escapes

/** A statement as an internal compiler error names it: its kind, and the object it creates, writes or defines. */
const headOf = (subject: Walked): string => {
	if (subject.kind === "block") {
		return "a PL/pgSQL block"
	}
	const s = subject.statement
	switch (s.kind) {
		case "insert":
		case "delete":
			return `${s.kind} into ${typeof s.table === "string" ? s.table : `${s.table.schema}.${s.table.name}`}`
		case "update":
		case "merge":
		case "fillStored":
		case "createTable":
		case "alterTable":
		case "createIndex":
		case "createPolicy":
			return `${s.kind} of ${s.table.schema}.${s.table.name}`
		case "createStoredTable":
		case "createView":
		case "createFunction":
		case "createConstant":
		case "createDomain":
		case "alterDomain":
			return `${s.kind} ${s.name.schema}.${s.name.name}`
		case "replaceConstant":
			return `${s.kind} ${s.constant.name.schema}.${s.constant.name.name}`
		case "select":
		case "createSchema":
		case "rename":
		case "renameColumn":
		case "renameConstraint":
		case "dropIndex":
		case "drop":
		case "dropPolicy":
		case "grantRole":
		case "revokeRole":
		case "grantColumns":
		case "dropFunction":
		case "dropTrigger":
		case "createDeclaredFunction":
		case "handOverFunction":
		case "createRowType":
		case "alterRowType":
		case "adoptRole":
		case "endHolders":
		case "stubConstant":
		case "packConstant":
		case "createGuardTrigger":
		case "createImmutableGuardTrigger":
		case "createConstraintTrigger":
		case "createTransitionTrigger":
		case "createPublication":
		case "dropPublication":
		case "createLiveSecret":
		case "guardBracket":
		case "createRole":
		case "alterRole":
		case "grant":
		case "revoke":
		case "alterDefaultPrivileges":
		case "createExtension":
		case "lockTable":
		case "comment":
		case "beginRead":
		case "beginWrite":
		case "commit":
		case "rollback":
		case "setConstraintsImmediate":
			return s.kind
	}
}

/** One escape in words: the name it reads, what it is, and where. */
const escapeText = (e: ScopeEscape): string => {
	switch (e.kind) {
		case "relation":
			return `"${e.alias}"."${e.column}" at ${e.at}, where no relation "${e.alias}" is in reach`
		case "column":
			return `"${e.alias}"."${e.column}" at ${e.at}, where "${e.alias}" lists no column "${e.column}"`
		case "unqualified":
			return `the column "${e.column}" at ${e.at}, unqualified in a query`
		case "qualified":
			return `"${e.alias}"."${e.column}" at ${e.at}, qualified in ${e.place}`
		case "unlisted":
			return `the column "${e.column}" at ${e.at}, which ${e.place === "DDL" ? "its table" : "the operation's output"} does not list`
		case "cte":
			return `the CTE "${e.name}" at ${e.at}, where no WITH in reach binds it`
		case "variable":
			return `the variable "${e.name}" at ${e.at}, which its body does not declare`
	}
}

/** The relation or CTE an escape names, whose binding places its report shows. */
const soughtName = (e: ScopeEscape): string | undefined => {
	switch (e.kind) {
		case "relation":
		case "column":
		case "qualified":
			return e.alias
		case "cte":
			return e.name
		case "unqualified":
		case "unlisted":
		case "variable":
			return undefined
	}
}

/**
 * The internal compiler error of a walked statement that reads a name where nothing binds it (the module header): its
 * head, its first escape, where the statement binds that name, out of reach of it, and how many escapes it holds.
 */
const refuse = (subject: Walked, escapes: ReadonlyArray<ScopeEscape>): void => {
	const [first] = escapes
	if (first === undefined) {
		return
	}
	const name = soughtName(first)
	const bound =
		name === undefined
			? ""
			: (() => {
					const places = walked(subject, new Set([name])).bound.get(name)
					return places === undefined
						? `; the statement binds "${name}" nowhere`
						: `; the statement binds "${name}" at ${places.join(", ")}, out of its reach`
				})()
	const more = escapes.length > 1 ? `, and ${escapes.length - 1} more` : ""
	defect(
		`print scope: ${headOf(subject)} reads ${escapeText(first)}${bound}${more}: PostgreSQL refuses it (42P01, 42703), so the printer never prints it (sql/scope.ts)`
	)
}

/** Refuses as an internal compiler error a statement that reads a name where nothing binds it (refuse). */
export const assertScoped = (statement: SqlStatement): void => {
	refuse({ kind: "statement", statement }, scopeEscapes(statement))
}

/**
 * Refuses as an internal compiler error a PL/pgSQL block, its arguments `params`, a DO block's none, that reads a name
 * where nothing binds it (refuse).
 */
export const assertBlockScoped = (
	params: ReadonlyArray<{ readonly name: string }>,
	block: PlBlock
): void => {
	refuse({ kind: "block", params, block }, blockEscapes(params, block))
}
