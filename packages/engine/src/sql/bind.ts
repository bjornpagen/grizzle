/**
 * The physical binding: the one pass that turns a statement as the lowering and the builders state it, its reads
 * logical (FromSource `table`, the WHERE and ON its levels state), into the statement PostgreSQL is sent, every read of a
 * stored relation stating how it is reached, and the plan (sql/plan.ts ReadPlan) the same pass proved, whose advice
 * (sql/advice.ts) holds PostgreSQL to it. Logical reads, then the logical rewrites (sql/print-once.ts printedOnce, the
 * CTEs PostgreSQL inlines printed in place and the sub-queries it pulls up flattened, and sql/print.ts foldedCore, the
 * pass-through projections folded), then this pass, then codegen: the bound statement (`BoundStatement`) is the only
 * form anything prints or plans from, and no analysis reads a binding back off printed SQL.
 *
 * Level by level, as PostgreSQL plans them, each read of a stored table becomes:
 * - a seek (FromSource `read`, LevelAccess `seek`): bound by equalities to values its level fixes, a parameter, a
 *   literal, a PL variable, a column of an enclosing level, and past them by the one range of the least column it
 *   orders against such a value (`<`, `<=`, `>=`, `>`), its request's key after the fixed ones; each moved out of the
 *   level's WHERE or ON into the read, and printed back as one of its level's conjuncts, where PostgreSQL makes it an
 *   index condition of its scan;
 * - a probe (FromSource `probe`): bound by an equality to a column of an earlier item of its level, a keyed read of a
 *   second relation, printed `LATERAL (SELECT … WHERE <bindings> LIMIT 1 | OFFSET 0)`, which PostgreSQL never
 *   flattens, so every bound column is an index condition, never a join filter (CARRY-THE-PLAN finding 5);
 * - a whole read (`read`, `whole`): no binding, or one of columns of few values alone, a roster's share of the rows;
 * - a write's target bound by another item of its statement: read at the tuple id a probe of it at that binding found
 *   (`tid`), sound where its relation is insert-only or every writer of it runs SERIALIZABLE, which the certifier's
 *   law of tid targets holds (analysis/isolation/certify.ts).
 * Every other item of a level (a derived table, a CTE's scan, a function's, arrays' or VALUES rows) is planned apart
 * under its alias: a derived table PostgreSQL would pull up is fenced (OFFSET 0), each conjunct of its reader that reads
 * it beside values its place fixes, and that its query takes, pushed into it first, which binds its reads where it
 * fixes their columns; a conjunct joining it to an earlier item of its level is pushed only where it keys a stored
 * read of the table's query, the table then read per row at that key, and otherwise stays the level's, a set join's, so
 * the table is derived once and joined by a hash, never derived again for each row before it. Every sublink and every set operation's arm reads its relations through one item of its own, its
 * whole query a derived table fenced the same way, so no target names a level PostgreSQL names itself (`exists_N`,
 * `expr_N`, `array_N`, `any_N`, `setop_N`). Every alias is minted again from the advice scope (sql/naming.ts
 * AdviceScope). A statement that reads what it reads whole, once (a stored relation's fill, a data step's re-check),
 * joins its reads by hash, each read whole or at the values it fixes, never by a probe per row.
 *
 * The pass is total and exact: it changes no result, and every binding it moves into a read node is an equality that
 * was in a WHERE or an ON. A read it cannot classify is an internal compiler error.
 */
import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { nominal } from "#compiler/core/brand.ts"
import { compareStrings, type Direction } from "#compiler/core/order.ts"
import { defaultOpclass, type IndexOpclass } from "#compiler/ir/law.ts"
import type { AccessIndexRequest, AccessUse } from "#compiler/ir/products.ts"
import {
	type AccessTag,
	type BinaryOperator,
	builtinFunctions,
	bodyPositionNames,
	type CreateFunction,
	type Cte,
	type CteBody,
	type Delete,
	type DrivenColumn,
	type Expr,
	type FromItem,
	type FromSource,
	type Insert,
	isSetQuery,
	isValuesTarget,
	type JoinStep,
	type LevelAccess,
	type Merge,
	type NameKey,
	nameKey,
	type OperandBody,
	type OperandSelect,
	type OrderedColumn,
	type OrderedUse,
	type OrderItem,
	overRowsOf,
	type RangeUse,
	type PlBlock,
	type PlStatement,
	type ObjectName,
	type ProbeBy,
	type ProbeColumn,
	returnsSet,
	type SeekBinding,
	type Select,
	type SelectCore,
	type SetOperand,
	type SqlStatement,
	selectColumns,
	type Target,
	targetColumnName,
	type TypeRef,
	type Update,
	type With
} from "#compiler/sql/ast.ts"
import {
	builtinType,
	col,
	conjunction,
	core,
	derived,
	eq,
	keyedRead,
	lit,
	operandSelect,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import {
	type Alias,
	type AdviceScope,
	namedQuery,
	type Scope,
	ViewScope
} from "#compiler/sql/naming.ts"
import type {
	JoinedItem,
	JoinMethod,
	PlanItem,
	PlanLevel,
	PlanName,
	ReadPlan
} from "#compiler/sql/plan.ts"
import { printedBlock, printedOnce } from "#compiler/sql/print-once.ts"
import { foldedCore, printPlannedQuery, printStatement } from "#compiler/sql/print.ts"
import { simpleQuery } from "#compiler/sql/pull-up.ts"
import { suffixKeyText } from "#compiler/sql/suffix.ts"
import { identityHooks, Transform, visitLevelExpr } from "#compiler/sql/transform.ts"

/** What a B-tree holds of a column: many values, or few (a roster's codes, a boolean), whose share of the rows no index
 * bounds, a filter beside a binding. */
export type Holds = "many" | "few"

/**
 * A column of a stored table an index can serve, by its installed name, `field` the field it is, a request's key, and
 * its kind, which closes the operators a read of it is classified by (`accessOf`):
 * - a B-tree's, with what it holds (`holds`): a scalar's, a text's (whose range on both sides is a prefix search), a
 *   network's (an inet or a cidr, whose containment GiST serves under inet_ops), a vector's (whose distance HNSW serves
 *   under the cosine class `cosine`, and whose own `=` pgvector's B-tree class keys); bound by `=`, `IN`, `= ANY` and,
 *   past the equalities, ranged by `<`, `<=`, `>=`, `>` and BETWEEN;
 * - a span's, which no B-tree keys: GiST under range_ops serves its Allen relations, its scalar prefix through
 *   btree_gist;
 * - a search document's, which no B-tree keys: GIN serves its match.
 * A text of no byte bound and a byte string are a text's and a scalar's like any other: a read binding one asks for it,
 * and the index engine decides what serves the request or refuses it (physical/indexes/engine.ts refusedUndigested), the
 * one place of the rule of what no entry holds.
 */
export type BindColumn =
	| {
			readonly kind: "scalar" | "text" | "network"
			readonly field: string
			readonly holds: Holds
	  }
	| {
			readonly kind: "vector"
			readonly field: string
			readonly holds: Holds
			readonly cosine: IndexOpclass
	  }
	| { readonly kind: "span" | "search"; readonly field: string }

/** A column a B-tree holds (BindColumn). */
type BTreeColumn = Extract<BindColumn, { readonly holds: Holds }>

/** `table`'s column `column` where a B-tree holds it: what an equality binds and a range ranges. */
const btreeColumn = (table: BindTable, column: string): BTreeColumn | undefined => {
	const c = table.columns.get(column)
	return c !== undefined && "holds" in c ? c : undefined
}

/**
 * A stored table as the binding reads it: its relation, as the installation plans its indexes; each installed column an
 * index can serve, with its kind (BindColumn); and every unique key, each its installed columns, a read binding one
 * whole reaching one row.
 */
export interface BindTable {
	readonly relation: string
	readonly columns: ReadonlyMap<string, BindColumn>
	readonly keys: ReadonlyArray<ReadonlyArray<string>>
}

/**
 * A role's view as the binding reads it (ReadCatalog `view`):
 * - `whole`: a whole entry's, every row and column of its relation's table, which PostgreSQL flattens into the level
 *   that reads it, the table then planned there under the alias the view's body names it by (`alias`, a spelling no
 *   advice scope mints, sql/naming.ts wholeViewAlias), so a read of it is bound as a read of its table, its plan's item
 *   named by that alias; each column of the view by the table's column it reads (`columns`), a closed id's decoded
 *   column its code's;
 * - `world`: a role's query entry's, behind a security barrier, which PostgreSQL plans apart under the reference's alias,
 *   its body's relations planned there under the aliases its view scope mints (WorldBinding);
 * - `apart`: any other view, planned apart under the reference's alias by PostgreSQL's choice, whose body no plan names.
 */
export type BindView =
	| {
			readonly kind: "whole"
			readonly table: BindTable
			readonly alias: Alias
			readonly columns: ReadonlyMap<string, string>
	  }
	| { readonly kind: "world"; readonly view: WorldBinding }
	| { readonly kind: "apart" }

/**
 * A role's world view as the binding reads it (BindView `world`): its name; its definition after its logical rewrites
 * (`prepared`, sql/print-once.ts printedOnce), which its installation binds into the body it creates (`bindView`) and a
 * reader binds again with the reader's quals PostgreSQL pushes past its barrier; its place among its role's query
 * entries, whose view scope its body's aliases come from (sql/naming.ts ViewScope); how many that binding mints; its
 * columns, as the view names them, each its definition's output at its place, which a reader's qual reads; and its
 * columns whose equality PostgreSQL holds leaky (physical/access/catalog.ts leakyEquality), no qual of which passes its
 * barrier.
 */
export interface WorldBinding {
	readonly name: ObjectName
	readonly prepared: Select
	readonly ordinal: number
	readonly minted: number
	readonly columns: NonEmptyReadonlyArray<string>
	readonly leaky: ReadonlySet<string>
}

/**
 * A stored relation a FROM source names, as the binding reads it (Binder `#stored`): its table, read as itself, under the
 * source's own alias, its columns its own; or through a whole view (BindView `whole`), its plan item named by the alias
 * the view's body names the table by, each column of the view the table's column it reads.
 */
type Stored =
	| { readonly kind: "table"; readonly table: BindTable }
	| {
			readonly kind: "view"
			readonly table: BindTable
			readonly view: Extract<BindView, { readonly kind: "whole" }>
	  }

/** The alias a stored read's plan item takes: a whole view's body's, else the read's own, `own`. */
const itemAlias = (stored: Stored, own: Alias): Alias =>
	stored.kind === "view" ? stored.view.alias : own

/** The table's columns a stored read reads, for the columns `read` the statement reads of it, in name order. */
const tableColumns = (stored: Stored, read: ReadonlyArray<string>): ReadonlyArray<string> =>
	stored.kind === "view"
		? [...new Set(read.map((c) => stored.view.columns.get(c) ?? c))].toSorted()
		: read

/**
 * What the binding reads of an installation, by the keys of the names a statement reads (sql/ast.ts nameKey): each
 * stored table, and each role's view (BindView). A relation of neither, a session's table of a judge or one of the
 * catalog's, is read as it is written, at no binding, and its plan states no scan of it, PostgreSQL's choice, since no
 * index of the installation's serves it and only the session or the catalog knows the indexes it holds.
 */
export interface ReadCatalog {
	readonly table: (key: NameKey) => BindTable | undefined
	readonly view: (key: NameKey) => BindView | undefined
	/**
	 * The columns of the table a trigger function fires on, by the key of the function's name, each its type: what its
	 * NEW and OLD fields are as PL/pgSQL hands a query reading them to the planner (`plannedOf`). None for a function
	 * no trigger fires.
	 */
	readonly fired: (fn: NameKey) => ReadonlyMap<string, TypeRef> | undefined
}

declare const boundBrand: unique symbol

/** A statement the binding made (see the header), with the plan it proved: minted here alone. */
export interface BoundStatement<S extends SqlStatement = SqlStatement> {
	readonly statement: S
	readonly plan: ReadPlan<AccessIndexRequest>
	readonly [boundBrand]: true
}

/** The name a FROM source's columns are read by where it is written: its alias, or an unaliased CTE read's CTE name. */
const writtenOf = (source: FromSource): string | undefined =>
	source.kind === "cte" ? (source.alias ?? source.name) : source.alias

/** A relation a place sees by its written name: its new alias, its level's depth, and its place among the level's. */
interface Declared {
	readonly alias: Alias
	readonly depth: number
	readonly place: number
}

/** A row's tuple id, the system column a write's target is read at where its condition states it (Binder `written`). */
const tupleId = "ctid"

/** The relations and CTEs a place sees, by their written names, the innermost binding of a name winning. */
interface Env {
	readonly relations: ReadonlyMap<string, Declared>
	readonly ctes: ReadonlyMap<string, Alias>
	readonly depth: number
}

const topEnv: Env = { relations: new Map(), ctes: new Map(), depth: 0 }

/** `env` with `written` bound to `alias` at its place `place` of the level of depth `depth`. */
const withRelation = (
	env: Env,
	written: string,
	alias: Alias,
	depth: number,
	place: number
): Env => ({
	...env,
	relations: new Map([...env.relations, [written, { alias, depth, place }]])
})

/**
 * The negator of each builtin comparison of two scalars (pg_operator `oprnegate`), by which PostgreSQL reads a NOT of
 * one as the comparison it is (clauses.c negate_clause): `NOT a <> b` is `a = b`, true, false or null alike.
 */
const negators: Partial<Readonly<Record<BinaryOperator, BinaryOperator>>> = {
	"=": "<>",
	"<>": "=",
	"<": ">=",
	">=": "<",
	">": "<=",
	"<=": ">"
}

/**
 * A conjunct as PostgreSQL reads it: a NOT of a builtin comparison of two scalars, the negated comparison (`negators`),
 * which an index serves as any comparison; any other itself.
 */
const asRead = (e: Expr): Expr => {
	if (e.kind !== "not" || e.expr.kind !== "binary" || e.expr.schema !== undefined) {
		return e
	}
	const negator = negators[e.expr.op]
	return negator === undefined || e.expr.left.kind === "row" || e.expr.right.kind === "row"
		? e
		: { ...e.expr, op: negator }
}

/** An expression's structural text: two expressions of one text are one expression. */
const exprText = (e: Expr): string =>
	JSON.stringify(e, (_, v: unknown) => (typeof v === "bigint" ? `${v}n` : v))

/**
 * Each of `conjuncts` once, the first of each text (`exprText`), in order: AND holds one conjunct twice as once, but
 * for one that holds a sublink or a VOLATILE call (`opaque`), each evaluation of which may differ, kept every time.
 */
const distinctConjuncts = (conjuncts: ReadonlyArray<Expr>): ReadonlyArray<Expr> => {
	const seen = new Set<string>()
	return conjuncts.filter((c) => {
		if (opaque(c)) {
			return true
		}
		const text = exprText(c)
		if (seen.has(text)) {
			return false
		}
		seen.add(text)
		return true
	})
}

/**
 * The equalities a builtin equality of two rows of one arity is, as PostgreSQL's parser reads it (parse_expr.c
 * make_row_comparison_op): `(a, b) = (c, d)` is `a = c AND b = d`, true, false or null alike, so each pair a conjunct
 * of its own, which a read binds by; none for any other expression.
 */
const rowEqualities = (e: Expr): ReadonlyArray<Expr> | undefined => {
	if (
		e.kind !== "binary" ||
		e.op !== "=" ||
		e.schema !== undefined ||
		e.left.kind !== "row" ||
		e.right.kind !== "row" ||
		e.left.items.length !== e.right.items.length
	) {
		return undefined
	}
	const right = e.right.items
	return e.left.items.map((l, i) =>
		eq(l, right[i] ?? defect("a row's item at each place of the row it equals"))
	)
}

const conjunctsIn = (e: Expr | undefined): ReadonlyArray<Expr> =>
	e === undefined
		? []
		: e.kind === "and"
			? e.args.flatMap(conjunctsIn)
			: (rowEqualities(e)?.flatMap(conjunctsIn) ?? [asRead(e)])

/**
 * The conjuncts of a condition, each AND's arguments in turn, each as PostgreSQL reads it (`asRead`), each once
 * (`distinctConjuncts`): a conjunct a lowering states twice binds one read once, never an index condition and a filter
 * of one column beside it (Law 2).
 */
const conjunctsOf = (e: Expr | undefined): ReadonlyArray<Expr> => distinctConjuncts(conjunctsIn(e))

/** A column reference a side of an equality is, through a collation, which keeps the column's order. */
const columnOf = (e: Expr): { readonly table: string; readonly column: string } | undefined => {
	if (e.kind === "collate") {
		return columnOf(e.expr)
	}
	return e.kind === "column" && e.table !== undefined
		? { table: e.table, column: e.column }
		: undefined
}

/** Every column reference of an expression, at its own level and in its sublinks, as `f` meets it. */
const eachColumn = (e: Expr, f: (table: string, column: string) => void): void => {
	new (class extends Transform {
		override readonly expr = (x: Expr): Expr => {
			if (x.kind === "column" && x.table !== undefined) {
				f(x.table, x.column)
			}
			return this.exprChildren(x)
		}
	})(identityHooks).expr(e)
}

/** The qualifiers of every column reference of an expression (`eachColumn`). */
const qualifiersOf = (e: Expr): ReadonlySet<string> => {
	const out = new Set<string>()
	eachColumn(e, (table) => {
		out.add(table)
	})
	return out
}

/** Whether an expression holds a sublink or a VOLATILE call, which no binding or pushed conjunct carries. */
const opaque = (e: Expr): boolean => {
	let found = false
	new (class extends Transform {
		override readonly expr = (x: Expr): Expr => {
			if (
				x.kind === "exists" ||
				x.kind === "subquery" ||
				x.kind === "array" ||
				x.kind === "inQuery"
			) {
				found = true
				return x
			}
			if (
				x.kind === "call" &&
				!x.star &&
				(x.fn.kind === "qualified"
					? x.fn.volatility === "VOLATILE"
					: builtinFunctions[x.fn.name].volatility === "VOLATILE")
			) {
				found = true
			}
			return this.exprChildren(x)
		}
	})(identityHooks).expr(e)
	return found
}

/**
 * Every column each written alias of a statement is read at, anywhere in it, by the alias: what a probe made of a table
 * delivers, and what a read's index-only scan must store. An alias two items declare reads the columns of both.
 */
const neededColumns = (statement: SqlStatement): ReadonlyMap<string, ReadonlySet<string>> =>
	neededBy((t) => t.statement(statement))

/** Every column each relation of `walk`'s walk is read at (neededColumns), by its alias. */
const neededBy = (walk: (t: Transform) => unknown): ReadonlyMap<string, ReadonlySet<string>> => {
	const out = new Map<string, Set<string>>()
	walk(
		new (class extends Transform {
			override readonly expr = (x: Expr): Expr => {
				if (x.kind === "column" && x.table !== undefined) {
					out.getOrInsertComputed(x.table, () => new Set<string>()).add(x.column)
				}
				return this.exprChildren(x)
			}
		})(identityHooks)
	)
	return out
}

/**
 * A binding of `alias`'s column a conjunct states: an equality of the column, through a collation, with a value that
 * reads no column of `alias` (`=`), or its membership in a list of such values or its equality with an element of such
 * an array (`in`).
 */
interface Binding {
	readonly conjunct: Expr
	readonly column: string
	readonly value: Expr
	readonly schema: string | undefined
	readonly op: "=" | "in"
}

const bindingOf = (c: Expr, alias: string): Binding | undefined => {
	if (opaque(c)) {
		return undefined
	}
	if (c.kind === "binary" && c.op === "=") {
		const left = columnOf(c.left)
		if (left?.table === alias && !qualifiersOf(c.right).has(alias)) {
			return { conjunct: c, column: left.column, value: c.right, schema: c.schema, op: "=" }
		}
		const right = columnOf(c.right)
		if (right?.table === alias && !qualifiersOf(c.left).has(alias)) {
			return { conjunct: c, column: right.column, value: c.left, schema: c.schema, op: "=" }
		}
		return undefined
	}
	if (c.kind === "inList" && !c.not) {
		const ref = columnOf(c.expr)
		return ref?.table === alias && !c.list.some((x) => qualifiersOf(x).has(alias))
			? {
					conjunct: c,
					column: ref.column,
					value: { kind: "row", items: c.list },
					schema: undefined,
					op: "in"
				}
			: undefined
	}
	if (c.kind === "equalsAny") {
		const ref = columnOf(c.expr)
		return ref?.table === alias && !qualifiersOf(c.array).has(alias)
			? { conjunct: c, column: ref.column, value: c.array, schema: c.schema, op: "in" }
			: undefined
	}
	return undefined
}

/** Whether a set of bound columns holds a unique key of `table` whole, so its read reaches one row at most. */
const holdsKey = (table: BindTable, bound: ReadonlySet<string>): boolean =>
	table.keys.some((k) => k.length > 0 && k.every((c) => bound.has(c)))

/** The request of a read of `table` at `bound`, its installed columns, each a key it binds by equality. */
const requestOf = (
	table: BindTable,
	bound: NonEmptyReadonlyArray<string>,
	trailing: ReadonlyArray<string>,
	use: AccessUse
): AccessIndexRequest => ({
	relation: table.relation,
	keys: [...bound, ...trailing].map((c) => {
		const column = table.columns.get(c)
		return column === undefined
			? defect(`a bound column of ${table.relation} a B-tree holds; ${c} is none`)
			: { expr: column.field, dir: "asc" as const, opclass: defaultOpclass }
	}),
	method: "btree",
	fixed: bound.length,
	role: "access",
	use
})

/**
 * Whether PostgreSQL pushes the conjunct `c` past a security barrier into the view `written` reads (allpaths.c
 * subquery_push_qual under security_barrier, contain_leaked_vars): a comparison of a column of the view by the builtin
 * `=`, `<`, `<=`, `>=` or `>`, a list or array membership by `=`, holding no sublink and no VOLATILE call, of no column
 * whose equality is leaky (`leaky`); the binding reads no other qual past one.
 */
const passesBarrier = (c: Expr, written: string, leaky: ReadonlySet<string>): boolean => {
	if (opaque(c)) {
		return false
	}
	const compares =
		(c.kind === "binary" && c.schema === undefined && (c.op === "=" || rangeOperators.has(c.op))) ||
		(c.kind === "inList" && !c.not) ||
		(c.kind === "equalsAny" && c.schema === undefined)
	if (!compares) {
		return false
	}
	let passes = true
	eachColumn(c, (table, column) => {
		passes &&= table !== written || !leaky.has(column)
	})
	return passes
}

/** The comparisons PostgreSQL reads as a B-tree's range of one column (nbtree's strategies `<`, `<=`, `>=`, `>`). */
const rangeOperators: ReadonlySet<string> = new Set(["<", "<=", ">", ">="])

/**
 * A key a range of a read ranges: a column of it, or the suffix key of a text column of it (sql/suffix.ts suffixKeyOf),
 * which a judged read's suffix test states as a range (sql/suffix.ts seekingSuffixes).
 */
interface RangedKey {
	readonly column: string
	readonly term: "column" | "suffix"
}

/** The key of `alias` a side of a range is (RangedKey): its column, through a collation, or its column's suffix key. */
const rangedKeyOf = (e: Expr, alias: string): RangedKey | undefined => {
	const ref = columnOf(e)
	if (ref !== undefined) {
		return ref.table === alias ? { column: ref.column, term: "column" } : undefined
	}
	const text = suffixKeyText(e)
	const of = text === undefined ? undefined : columnOf(text)
	return of?.table === alias ? { column: of.column, term: "suffix" } : undefined
}

/** Whether two ranged keys are one key. */
const sameRanged = (a: RangedKey, b: RangedKey): boolean =>
	a.column === b.column && a.term === b.term

/** A range of a key of `alias` a conjunct states: an ordering comparison of it with a value reading no column of it. */
const rangeOf = (
	c: Expr,
	alias: string
): { readonly conjunct: Expr; readonly key: RangedKey; readonly value: Expr } | undefined => {
	if (c.kind !== "binary" || !rangeOperators.has(c.op) || c.schema !== undefined || opaque(c)) {
		return undefined
	}
	const left = rangedKeyOf(c.left, alias)
	if (left !== undefined && !qualifiersOf(c.right).has(alias)) {
		return { conjunct: c, key: left, value: c.right }
	}
	const right = rangedKeyOf(c.right, alias)
	return right !== undefined && !qualifiersOf(c.left).has(alias)
		? { conjunct: c, key: right, value: c.left }
		: undefined
}

/** Which side of a range a conjunct bounds its column on, or both. */
type RangeSide = "lower" | "upper" | "both"

/** The side `op` bounds its left operand on, by nbtree's strategies. */
const leftSide = (op: string): RangeSide => (op === ">" || op === ">=" ? "lower" : "upper")

/** The side of `alias`'s key a range conjunct bounds (`rangeOf`), or BETWEEN's two, with the key. */
const rangeSideOf = (
	c: Expr,
	alias: string
): { readonly key: RangedKey; readonly value: Expr; readonly side: RangeSide } | undefined => {
	if (c.kind === "between" && !c.not && !opaque(c)) {
		const key = rangedKeyOf(c.expr, alias)
		return key !== undefined && !qualifiersOf(c.low).has(alias) && !qualifiersOf(c.high).has(alias)
			? { key, value: { kind: "row", items: [c.low, c.high] }, side: "both" }
			: undefined
	}
	const r = rangeOf(c, alias)
	if (r === undefined || c.kind !== "binary") {
		return undefined
	}
	const onLeft = rangedKeyOf(c.left, alias) !== undefined
	const side = leftSide(c.op)
	return {
		key: r.key,
		value: r.value,
		side: onLeft ? side : side === "lower" ? "upper" : "lower"
	}
}

/**
 * The operators each kind of column but a B-tree's is matched by against a value its level fixes (BindColumn): a
 * span's Allen relations, the range operators GiST's range_ops serves (pointIn's `@>` among them); a network's
 * containments, which inet_ops serves on either side; a search document's match. Any other operator on such a column
 * is a filter, never an access.
 */
const matchOperators = {
	span: new Set(["&&", "@>", "<@", "<<", ">>", "&<", "&>", "-|-", "="]),
	network: new Set(["<<=", "<<", "&&"]),
	search: new Set(["@@"])
} as const satisfies Readonly<Record<"span" | "network" | "search", ReadonlySet<string>>>

/**
 * A match of `alias`'s column of `kind` a conjunct states (`matchOperators`): the column on one side, through a
 * collation, and a value reading no column of `alias` on the other; a search document on the left of its query alone.
 */
const matchOf = (
	c: Expr,
	alias: string,
	kind: keyof typeof matchOperators,
	kindOf: (column: string) => BindColumn["kind"] | undefined
): { readonly column: string; readonly value: Expr } | undefined => {
	if (
		c.kind !== "binary" ||
		c.schema !== undefined ||
		!matchOperators[kind].has(c.op) ||
		opaque(c)
	) {
		return undefined
	}
	const sides =
		kind === "search"
			? ([[c.left, c.right]] as const)
			: ([
					[c.left, c.right],
					[c.right, c.left]
				] as const)
	for (const [side, other] of sides) {
		const ref = columnOf(side)
		if (ref?.table === alias && kindOf(ref.column) === kind && !qualifiersOf(other).has(alias)) {
			return { column: ref.column, value: other }
		}
	}
	return undefined
}

/**
 * The index order a level's LIMIT states of the read its ORDER BY orders (sql/ast.ts AccessTag), with that ORDER BY: the
 * level's driving read, which the binding reads it into (LevelAccess `ordered`, `nearest`).
 */
interface OrderIntent {
	readonly tag: AccessTag
	readonly orderBy: ReadonlyArray<OrderItem>
}

/**
 * How a stored read reaches its rows, classified (Binder `#classified`): the equalities it binds (`eq`), each a
 * Binding, then what its LevelAccess states past them, every conjunct it takes the read's own.
 */
type Classified =
	| { readonly kind: "whole" }
	| {
			readonly kind: "seek"
			readonly eq: NonEmptyReadonlyArray<Binding>
			readonly keyed: boolean
	  }
	| {
			readonly kind: "ordered"
			readonly eq: ReadonlyArray<Binding>
			readonly order: NonEmptyReadonlyArray<OrderedColumn>
			readonly use: OrderedUse
	  }
	| { readonly kind: "nearest"; readonly column: string; readonly cosine: IndexOpclass }
	| {
			readonly kind: "range"
			readonly eq: ReadonlyArray<Binding>
			readonly key: RangedKey
			readonly conjuncts: NonEmptyReadonlyArray<Expr>
			readonly use: RangeUse
	  }
	| {
			readonly kind: "span"
			readonly eq: ReadonlyArray<Binding>
			readonly column: string
			readonly conjunct: Expr
	  }
	| { readonly kind: "network" | "search"; readonly column: string; readonly conjunct: Expr }

/**
 * The index order a level's LIMIT states of `table`'s read under `written` (OrderIntent), where its ORDER BY orders that
 * read: an approximate search's distance, `<=>`, of one of its vectors from a fixed one (`nearest`); a take's or a
 * page's ORDER BY of its B-tree columns, past the ones its equalities `equal` fix (`ordered`). None where the ORDER BY
 * reads anything else, a sort over rows no index of the read orders.
 */
const orderedOf = (
	table: BindTable,
	written: string,
	order: OrderIntent,
	equal: ReadonlySet<string>,
	fixed: (e: Expr) => boolean
):
	| Extract<Classified, { readonly kind: "nearest" }>
	| {
			readonly kind: "ordered"
			readonly order: NonEmptyReadonlyArray<OrderedColumn>
			readonly use: OrderedUse
	  }
	| undefined => {
	switch (order.tag.kind) {
		case "nearest": {
			const [only, ...more] = order.orderBy
			const d = only?.expr
			if (d === undefined || more.length > 0 || d.kind !== "binary" || d.op !== "<=>") {
				return undefined
			}
			for (const [side, other] of [
				[d.left, d.right],
				[d.right, d.left]
			] as const) {
				const ref = columnOf(side)
				const column = ref?.table === written ? table.columns.get(ref.column) : undefined
				if (ref !== undefined && column?.kind === "vector" && fixed(other)) {
					return { kind: "nearest", column: ref.column, cosine: column.cosine }
				}
			}
			return undefined
		}
		case "ordered": {
			const columns: Array<OrderedColumn> = []
			for (const item of order.orderBy) {
				const ref = columnOf(item.expr)
				if (ref?.table !== written || btreeColumn(table, ref.column) === undefined) {
					return undefined
				}
				if (!equal.has(ref.column) && !columns.some((c) => c.column === ref.column)) {
					columns.push({ column: ref.column, dir: item.direction === "ASC" ? "asc" : "desc" })
				}
			}
			const [c0, ...cs] = columns
			return c0 === undefined
				? undefined
				: { kind: "ordered", order: [c0, ...cs], use: order.tag.use }
		}
	}
}

/**
 * A request of a read of `table` by `method` at `keys`, its installed columns in key order, each the column itself or
 * its suffix key (RangedKey `term`), `fixed` of them bound.
 */
const keyedRequest = (
	table: BindTable,
	method: AccessIndexRequest["method"],
	keys: ReadonlyArray<{
		readonly column: string
		readonly term: RangedKey["term"]
		readonly dir: Direction
		readonly opclass: IndexOpclass
	}>,
	fixed: number,
	use: AccessUse
): AccessIndexRequest => ({
	relation: table.relation,
	keys: keys.map((k) => {
		const column = table.columns.get(k.column)
		return column === undefined
			? defect(`a key column of ${table.relation} an index serves; ${k.column} is none`)
			: {
					expr: k.term === "column" ? column.field : { suffix: column.field },
					dir: k.dir,
					opclass: k.opclass
				}
	}),
	method,
	fixed,
	role: "access",
	use
})

/** Keys in ascending order under the default class, of `columns`, each the column itself. */
const ascending = (
	columns: ReadonlyArray<string>
): ReadonlyArray<{
	readonly column: string
	readonly term: RangedKey["term"]
	readonly dir: Direction
	readonly opclass: IndexOpclass
}> => columns.map((column) => ({ column, term: "column", dir: "asc", opclass: defaultOpclass }))

/** The columns equalities bind, each once, in name order. */
const columnsOf = (fixing: ReadonlyArray<Binding>): ReadonlyArray<string> =>
	[...new Set(fixing.map((b) => b.column))].toSorted()

/** The request of a read of `table` by `access` (Binder `tableEntry`), the index it reads through. */
const accessRequest = (
	table: BindTable,
	access: Exclude<Classified, { readonly kind: "whole" }>
): AccessIndexRequest => {
	switch (access.kind) {
		case "seek": {
			const [c0, ...cs] = columnsOf(access.eq)
			return c0 === undefined
				? defect("a seek binding a column at least")
				: requestOf(table, [c0, ...cs], [], access.keyed ? "key lookup" : "equality lookup")
		}
		case "ordered":
			return keyedRequest(
				table,
				"btree",
				[
					...ascending(columnsOf(access.eq)),
					...access.order.map((o) => ({
						column: o.column,
						term: "column" as const,
						dir: o.dir,
						opclass: defaultOpclass
					}))
				],
				columnsOf(access.eq).length,
				access.use
			)
		case "nearest":
			return keyedRequest(
				table,
				"hnsw",
				[{ column: access.column, term: "column", dir: "asc", opclass: access.cosine }],
				0,
				"approximate vector retrieval"
			)
		case "range":
			return keyedRequest(
				table,
				"btree",
				[
					...ascending(columnsOf(access.eq)),
					{ ...access.key, dir: "asc", opclass: defaultOpclass }
				],
				columnsOf(access.eq).length,
				access.use
			)
		case "span":
			return keyedRequest(
				table,
				"gist",
				ascending([...columnsOf(access.eq), access.column]),
				columnsOf(access.eq).length,
				"span predicate"
			)
		case "network":
			return keyedRequest(table, "gist", ascending([access.column]), 0, "network containment")
		case "search":
			return keyedRequest(table, "gin", ascending([access.column]), 0, "text search")
	}
}

/**
 * One entry of a level's FROM, flattened from its items and join chains in order: its source, and how it joins the
 * entries before it, a FROM list's item or a chain's first (`item`), an inner join on a condition, a LEFT JOIN on one,
 * or a cross join.
 */
type Entry =
	| { readonly join: "item" | "cross"; readonly source: FromSource }
	| { readonly join: "on" | "left"; readonly source: FromSource; readonly on: Expr }

const entriesOf = (from: ReadonlyArray<FromItem>): ReadonlyArray<Entry> =>
	from.flatMap((item): ReadonlyArray<Entry> =>
		item.kind === "joins"
			? [{ join: "item", source: item.first }, ...item.steps.map(stepEntry)]
			: [{ join: "item", source: item }]
	)

const stepEntry = (step: JoinStep): Entry =>
	step.kind === "cross"
		? { join: "cross", source: step.source }
		: { join: step.kind, source: step.source, on: step.on }

/** How a bound entry joins the entries before it, in the join chain of its level: crosswise, or on its ON. */
type Step = { readonly join: "cross" } | { readonly join: "on" | "left"; readonly on: Expr }

/** A bound entry: its source, its step, and its plan item and the method that joins it inner. */
interface BoundEntry {
	readonly source: FromSource
	readonly step: Step
	readonly item: PlanItem<AccessIndexRequest>
	readonly method: JoinMethod
	/**
	 * The members of the UNION ALL the item reads, which PostgreSQL flattens into the item's append relation at its level
	 * (prepjointree.c pull_up_simple_union_all), each its arm's one item: none for any other item.
	 */
	readonly appended: ReadonlyArray<PlanItem<AccessIndexRequest>>
}

/** A level's FROM, one join chain: its first entry, every other a step, each joined as it states. */
const fromOf = (entries: ReadonlyArray<BoundEntry>): ReadonlyArray<FromItem> => {
	const [first, ...rest] = entries
	if (first === undefined) {
		return []
	}
	const steps = rest.map((e): JoinStep => {
		const step = e.step
		return step.join === "cross"
			? { kind: "cross", source: e.source }
			: { kind: step.join, source: e.source, on: step.on }
	})
	return isNonEmpty(steps) ? [{ kind: "joins", first: first.source, steps }] : [first.source]
}

/** A query's ORDER BY, LIMIT and OFFSET, which read its body's FROM. */
type Tail = Pick<OperandSelect, "orderBy" | "limit" | "offset">

/** Whether an expression is the literal 0, an OFFSET that skips no row. */
const zeroOffset = (e: Expr | undefined): boolean =>
	e === undefined || (e.kind === "literal" && e.value.kind === "int" && e.value.value === 0n)

/**
 * A take's core (a LIMIT that states its level's B-tree order, sql/ast.ts AccessTag `ordered`) with no fence between
 * its ORDER BY and the stored read it orders, and its ORDER BY read through the
 * fold: each projection it begins with folded into the core it reads, the projection's OFFSET 0 fence with it, where
 * the take's core reads that one derived table alone, under no GROUP BY, HAVING or DISTINCT, and the derived table's
 * query is one core of no WITH, ORDER BY, LIMIT, DISTINCT, GROUP BY or HAVING, and an OFFSET of 0 or none, each of its
 * targets a column or a literal: a column of its own FROM, or a value an enclosing level fixes. The core's WHERE, read
 * through the projection, joins the projection's own. The take's LIMIT plans its level apart, so the fold keeps every
 * level PostgreSQL plans but the projections', and the rows are the same: an OFFSET of 0 skips none, a filter over a
 * projection of columns is the filter of what it projects, and a column read twice is read once. Each target keeps the
 * name it delivered. So
 * the take's level reads the stored table its ORDER BY orders, which its read is bound by in that order (`orderedOf`),
 * one descent of the index and k entries, where each fenced projection kept PostgreSQL from reading the index in the
 * take's order and it read every row of the unit and sorted them (STOREDFIX: Latest's upkeep loop read 23 rows where
 * 7 bound it, and Span's 24 where 8 did, growing with the unit). None where no projection folds.
 */
const takenThrough = (
	taken: SelectCore,
	orderBy: ReadonlyArray<OrderItem>
): { readonly core: SelectCore; readonly orderBy: ReadonlyArray<OrderItem> } | undefined => {
	const [source, ...more] = taken.from
	if (
		source?.kind !== "derived" ||
		source.lateral ||
		more.length > 0 ||
		taken.groupBy.length > 0 ||
		taken.having !== undefined ||
		taken.distinct !== false
	) {
		return undefined
	}
	const inner = source.query
	const body = inner.body
	if (
		inner.with !== undefined ||
		inner.orderBy.length > 0 ||
		inner.limit !== undefined ||
		!zeroOffset(inner.offset) ||
		body.kind !== "core" ||
		body.distinct !== false ||
		body.groupBy.length > 0 ||
		body.having !== undefined ||
		!body.targets.every((t) => t.expr.kind === "column" || t.expr.kind === "literal")
	) {
		return undefined
	}
	const columns = new Map(
		selectColumns(inner).map((name, at) => [name, body.targets[at]?.expr] as const)
	)
	const alias = source.alias
	/** `e` with each column of the projection read as the target that delivers it; none where one delivers none. */
	const through = (e: Expr): Expr | undefined => {
		const missing = new Set<string>()
		const out = new (class extends Transform {
			override readonly expr = (x: Expr): Expr => {
				if (x.kind !== "column" || x.table !== alias) {
					return this.exprChildren(x)
				}
				const to = columns.get(x.column)
				if (to === undefined) {
					missing.add(x.column)
					return x
				}
				return to
			}
		})(identityHooks).expr(e)
		return missing.size === 0 ? out : undefined
	}
	const targets: Array<Target> = []
	for (const t of taken.targets) {
		const expr = through(t.expr)
		if (expr === undefined) {
			return undefined
		}
		const name = targetColumnName(t)
		targets.push({
			expr,
			alias:
				name !== undefined && targetColumnName({ expr, alias: undefined }) !== name ? name : t.alias
		})
	}
	const ordered: Array<OrderItem> = []
	for (const o of orderBy) {
		const expr = through(o.expr)
		if (expr === undefined) {
			return undefined
		}
		ordered.push({ ...o, expr })
	}
	const where = taken.where === undefined ? undefined : through(taken.where)
	if (taken.where !== undefined && where === undefined) {
		return undefined
	}
	const folded: SelectCore = {
		...body,
		targets,
		where: conjunction([
			...(body.where === undefined ? [] : [body.where]),
			...(where === undefined ? [] : [where])
		])
	}
	return takenThrough(folded, ordered) ?? { core: folded, orderBy: ordered }
}

/** A query fenced by OFFSET 0 where PostgreSQL would pull it up (sql/pull-up.ts simpleQuery), so it is planned apart. */
const fenced = (q: OperandSelect): OperandSelect =>
	simpleQuery(q) ? { ...q, offset: lit.int(0, types.bigint) } : q

/** The written alias a wrapper takes (`wrapped`): one no lowering writes, whose scope's alias the binding mints. */
const wrapperAlias = "__wrapped"

/**
 * Whether a query reads its relations at its own level where that level is one PostgreSQL names itself, a sublink's or a
 * set operation's arm's: a core reading two items or more, or a stored table or a view; any other query reads through
 * one item already planned apart under the scope's alias, or reads none.
 */
const readsAtOwnLevel = (q: OperandSelect): boolean => {
	const body = q.body
	if (body.kind !== "core") {
		return false
	}
	const entries = entriesOf(body.from)
	return entries.length > 1 || entries.some((e) => e.source.kind === "table")
}

/**
 * A query a level PostgreSQL names reads through one item of the scope's (see the header): where it reads at its own
 * level (`readsAtOwnLevel`), the query whole is a derived table under a fresh alias, fenced by an OFFSET 0 where it
 * states none, so neither PostgreSQL nor the fold of pass-through projections (sql/print.ts foldedCore) takes it into
 * the wrapper, its outputs given fresh names `c<n>` and read back under their own where its reader reads them by name
 * (`named`), a set operation's arm's, and bare where it reads them by place, a sublink's, so its rows, its multiplicity
 * and every name a reader reads are the query's.
 */
const wrapped = (q: OperandSelect, named: boolean): OperandSelect =>
	readsAtOwnLevel(q) ? wrapper(q, named) : q

/**
 * Whether PostgreSQL pulls a set operation's arm up into the append relation of its UNION ALL as its one item
 * (prepjointree.c is_safe_append_member, is_simple_subquery): a simple query (sql/pull-up.ts simpleQuery), as the
 * binding reads it once its pass-through projections fold (sql/print.ts foldedCore), of no WHERE that reads one item,
 * no stored table or view, whose relation is then the member.
 */
const appendMember = (q: OperandSelect): boolean => {
	if (!simpleQuery(q) || q.body.kind !== "core") {
		return false
	}
	const body = foldedCore(q.body, true)
	if (!simpleQuery({ ...q, body }) || body.where !== undefined) {
		return false
	}
	const [entry, ...others] = entriesOf(body.from)
	return entry !== undefined && others.length === 0 && entry.source.kind !== "table"
}

/**
 * A set operation's arm as it is bound (see `appendMember`): as it stands where it is an append member, else read
 * through one item of the scope's (`wrapper`), so the arm is one under every set operation, its item the member
 * PostgreSQL pulls up into a UNION ALL's append relation, and a level of the scope's where PostgreSQL plans it apart.
 */
const armed = (q: OperandSelect): OperandSelect => (appendMember(q) ? q : wrapper(q, true))

/**
 * Whether PostgreSQL pulls the derived table of this query up into its reader's level as an append relation
 * (prepjointree.c is_simple_union_all, pull_up_simple_union_all): a UNION ALL of no WITH, ORDER BY, LIMIT or OFFSET,
 * every arm one item (`armed`), each a member of the relation at the reader's level.
 */
const pulledUnion = (q: OperandSelect): boolean =>
	q.body.kind === "setOp" &&
	q.body.op === "UNION ALL" &&
	q.with === undefined &&
	q.orderBy.length === 0 &&
	q.limit === undefined &&
	q.offset === undefined

/** Whether the query `q` reads the CTE written `name`: a recursive CTE's body that reads itself. */
const readsCte = (q: OperandSelect, name: string): boolean => {
	let reads = false
	new Transform({
		...identityHooks,
		fromSource: (source) => {
			reads ||= source.kind === "cte" && source.name === name
			return source
		}
	}).select(q)
	return reads
}

/** The query `q` read through one item of the scope's, whatever it reads (`wrapped`). */
const wrapper = (q: OperandSelect, named: boolean): OperandSelect => {
	const outputs = bodyPositionNames(q.body)
	const names = outputs.map((_, i) => `c${i + 1}`)
	const inner = namedQuery(q, names)
	const targets = names.map((n, i) => {
		const output = outputs[i]
		return output === undefined || !named
			? target(col(wrapperAlias, n))
			: targetAs(col(wrapperAlias, n), output)
	})
	const fence = inner.offset === undefined ? { ...inner, offset: lit.int(0, types.bigint) } : inner
	return operandSelect(keyedRead(targets, [derived(fence, wrapperAlias, false)], undefined))
}

/**
 * Whether a derived table's query takes a conjunct of its reader pushed into it (allpaths.c subquery_push_qual's
 * conditions, as grizzle's queries meet them), and the query with it pushed: one core of no WITH, LIMIT or OFFSET, each
 * column the conjunct reads of `alias` a target reading no aggregate, window, set-returning or VOLATILE call, in a
 * grouped core one it groups by, under DISTINCT ON one it distinguishes, and in a core that calls a window function
 * one every window partitions by, a conjunct of which keeps each partition whole (check_output_expressions,
 * targetIsInAllPartitionLists): an attachment's take ranked per partition of its input, read at the partition its
 * parent row binds, reads that partition's rows alone. The conjunct holds no sublink and no VOLATILE call. The pushed
 * conjunct reads each column's target in its place, a WHERE conjunct of the core.
 */
const pushedInto = (q: OperandSelect, alias: string, c: Expr): OperandSelect | undefined => {
	const body = q.body
	if (
		body.kind !== "core" ||
		q.with !== undefined ||
		q.limit !== undefined ||
		q.offset !== undefined ||
		opaque(c) ||
		!qualifiersOf(c).has(alias)
	) {
		return undefined
	}
	const names = selectColumns(q)
	const grouped =
		body.groupBy.length > 0 ||
		body.having !== undefined ||
		body.targets.some((t) => overRowsOf(t.expr) === "aggregate")
	const text = exprText
	const groups = new Set(body.groupBy.map(text))
	const distinguished =
		typeof body.distinct === "object" ? new Set(body.distinct.on.map(text)) : undefined
	/** Each window a target's window call reads the level's rows by, whose partitions a pushed conjunct keeps whole. */
	const windows: Array<ReadonlyArray<string>> = []
	for (const t of body.targets) {
		visitLevelExpr(t.expr, (x) => {
			if (x.kind === "call" && x.over !== undefined) {
				windows.push(x.over.partitionBy.map(text))
			}
		})
	}
	const read: Array<string> = []
	eachColumn(c, (table, column) => {
		if (table === alias) {
			read.push(column)
		}
	})
	const columns = new Map<string, Expr>()
	for (const column of read) {
		const t = body.targets[names.indexOf(column)]
		if (
			t === undefined ||
			opaque(t.expr) ||
			overRowsOf(t.expr) !== undefined ||
			returnsSet(t.expr) ||
			(grouped && !groups.has(text(t.expr))) ||
			(distinguished !== undefined && !distinguished.has(text(t.expr))) ||
			!windows.every((w) => w.includes(text(t.expr)))
		) {
			return undefined
		}
		columns.set(column, t.expr)
	}
	const substituted = new (class extends Transform {
		override readonly expr = (x: Expr): Expr =>
			x.kind === "column" && x.table === alias ? (columns.get(x.column) ?? x) : this.exprChildren(x)
	})(identityHooks).expr(c)
	return {
		...q,
		body: {
			...body,
			where: conjunction(distinctConjuncts([...conjunctsOf(body.where), substituted]))
		}
	}
}

/**
 * The binding of the statements of one scope (see the header). Local mutable state owned by one binding: the plan's
 * levels in the order the walk meets them; the columns each written alias is read at; the scope, the catalog and how
 * its reads are bound (BoundReads); and whether the statement reads what it reads whole, once (`#whole`).
 */
class Binder {
	readonly #scope: Scope
	readonly #catalog: ReadCatalog
	readonly #reads: BoundReads
	readonly #levels: Array<PlanLevel<AccessIndexRequest>> = []
	#needs: ReadonlyMap<string, ReadonlySet<string>> = new Map()
	#whole = false
	/** The world views the statement reads whose bodies hold levels of their own, by ordinal (`worldEntry`). */
	readonly #worlds = new Set<number>()
	/**
	 * The bodies of the recursive CTEs the walk is in, each the UNION of its recursion, which PostgreSQL plans as a
	 * recursion, never an append relation (prepjointree.c flatten_simple_union_all).
	 */
	readonly #recursions = new Set<OperandBody>()

	constructor(scope: Scope, catalog: ReadCatalog, reads: BoundReads) {
		this.#scope = scope
		this.#catalog = catalog
		this.#reads = reads
	}

	/**
	 * Whether a read at the values it fixes reaches its rows through the index `request` asks: a keyed binding's always,
	 * every request of it one index planning lands (physical/indexes/engine.ts planIndexes); a whole one's where an
	 * index serves it (BoundReads `whole`).
	 */
	#serves(request: AccessIndexRequest): boolean {
		return this.#reads.kind === "keyed" || this.#reads.serves(request)
	}

	/** A read of `table` by `access`, as its binding reaches it (`#serves`), else whole, its conjuncts its filters. */
	#reached(table: BindTable, access: Classified): Classified {
		return access.kind === "whole" || this.#serves(accessRequest(table, access))
			? access
			: { kind: "whole" }
	}

	plan(): ReadPlan<AccessIndexRequest> {
		return { levels: [...this.#levels] }
	}

	/** The statement bound (see the header), its columns' needs read off it first; a whole one's reads joined by hash. */
	statement(s: SqlStatement): SqlStatement {
		this.#needs = neededColumns(s)
		this.#whole = this.#reads.kind === "whole"
		const top: PlanName = { kind: "top" }
		if (s.kind === "select") {
			return this.setQuery(s, topEnv, top)
		}
		if (s.kind === "insert") {
			return this.insert(s, topEnv, top)
		}
		if (s.kind === "update") {
			return this.update(s, topEnv, top)
		}
		if (s.kind === "delete") {
			return this.delete(s, topEnv, top)
		}
		if (s.kind === "merge") {
			return this.merge(s, topEnv, top)
		}
		if (s.kind === "fillStored") {
			this.#whole = true
			return { ...s, query: this.setQuery(s.query, topEnv, top) }
		}
		return s.kind === "createFunction" ? this.routine(s) : s
	}

	#alias(written: string | undefined): Alias {
		return this.#scope.alias({ kind: "internal", purpose: `bound ${written ?? "source"}` })
	}

	/** Every column the statement reads of the written alias `alias`, in name order. */
	#needed(alias: string): ReadonlyArray<string> {
		return [...(this.#needs.get(alias) ?? [])].toSorted()
	}

	/**
	 * The stored relation the name `name` a FROM source reads is (Stored): a table, or a whole view's table; none for a
	 * world view, a session's or the catalog's relation.
	 */
	#stored(name: ObjectName): Stored | undefined {
		const key = nameKey(name)
		const table = this.#catalog.table(key)
		if (table !== undefined) {
			return { kind: "table", table }
		}
		const view = this.#catalog.view(key)
		return view?.kind === "whole" ? { kind: "view", table: view.table, view } : undefined
	}

	/**
	 * `entry` as its level reads it, a whole view's read a level of its own where the level reads that view already,
	 * by its body's alias among `viewed`: a fenced derived table under the read's written alias delivering every column
	 * the statement reads of it, its read of the view under the same written alias, so the view's table is planned once
	 * at each level, never as an occurrence PostgreSQL numbers.
	 */
	#apart(entry: Entry, viewed: ReadonlySet<Alias>): Entry {
		const source = entry.source
		if (source.kind !== "table") {
			return entry
		}
		const stored = this.#stored(source.table)
		if (stored?.kind !== "view" || !viewed.has(stored.view.alias)) {
			return entry
		}
		const read = this.#needed(source.alias)
		const [t0, ...ts] = read.map((c) => targetAs(col(source.alias, c), c))
		const viewRead = derived(
			operandSelect(
				core(
					t0 === undefined ? [targetAs(lit.int(1, types.integer), "one")] : [t0, ...ts],
					[source],
					undefined
				)
			),
			source.alias,
			false
		)
		return { ...entry, source: viewRead }
	}

	/** A transform under `env`: each column reference read at its relation's new alias, each sublink bound. */
	renamer(env: Env): Transform {
		const sublink = (q: OperandSelect) => this.sublink(q, env)
		const array = (q: OperandSelect) => this.setQuery(wrapped(q, false), env, undefined)
		return new (class extends Transform {
			override readonly expr = (x: Expr): Expr => {
				if (x.kind === "column") {
					const declared = x.table === undefined ? undefined : env.relations.get(x.table)
					return declared === undefined ? x : { ...x, table: declared.alias }
				}
				if (x.kind === "access") {
					return defect(
						"an index order stated where no level's LIMIT holds it (sql/ast.ts AccessTag), which the binding reads there alone"
					)
				}
				if (x.kind === "exists" || x.kind === "subquery") {
					return { ...x, query: sublink(x.query) }
				}
				if (x.kind === "array") {
					return { ...x, query: array(x.query) }
				}
				if (x.kind === "inQuery") {
					return { ...x, expr: this.expr(x.expr), query: sublink(x.query) }
				}
				return this.exprChildren(x)
			}
		})(identityHooks)
	}

	/** An expression under `env` (`renamer`). */
	expr(e: Expr, env: Env): Expr {
		return this.renamer(env).expr(e)
	}

	/** A sublink's query under the env its reader's place gives it: a level PostgreSQL names itself (`wrapped`). */
	sublink(q: OperandSelect, env: Env): OperandSelect {
		return this.query(wrapped(q, false), env, undefined)
	}

	/** A set query bound, a set still: every rebuild of it keeps its body's proof. */
	setQuery(
		q: OperandSelect & { readonly body: OperandSelect["body"] },
		env: Env,
		name: PlanName | undefined
	) {
		const bound = this.query(q, env, name)
		return isSetQuery(bound) ? bound : defect("a set query bound a set still")
	}

	/**
	 * A query: its WITH's CTEs, each a level its new name names, then its body under `name` (none for a level PostgreSQL
	 * names itself), then its ORDER BY, LIMIT and OFFSET over the body's FROM.
	 */
	query(q: OperandSelect, env: Env, name: PlanName | undefined): OperandSelect {
		return this.#bound(q, env, name).query
	}

	/**
	 * A query bound (`query`), with the items its level reads: its core's entries', a nested query's, or each arm's one
	 * item of a set operation.
	 */
	#bound(
		q: OperandSelect,
		env: Env,
		name: PlanName | undefined
	): {
		readonly query: OperandSelect
		readonly items: ReadonlyArray<PlanItem<AccessIndexRequest>>
	} {
		const { with: w, env: inner } = this.with(q.with, env)
		const body = this.body(q.body, inner, name, {
			orderBy: q.orderBy,
			limit: q.limit,
			offset: q.offset
		})
		return { query: { ...q, with: w, body: body.body, ...body.tail }, items: body.items }
	}

	/** A WITH: each CTE under its new name, each a level that name names, a recursive one's every CTE seen in each. */
	with(w: With | undefined, env: Env): { readonly with: With | undefined; readonly env: Env } {
		if (w === undefined) {
			return { with: undefined, env }
		}
		const ctes = new Map(env.ctes)
		const names = w.ctes.map((cte) => this.#alias(cte.name))
		if (w.recursive) {
			for (const [i, cte] of w.ctes.entries()) {
				ctes.set(cte.name, names[i] ?? defect("a name for each CTE"))
			}
		}
		const bound = w.ctes.map((cte, i): Cte => {
			const name = names[i] ?? defect("a name for each CTE")
			if (w.recursive && cte.query.kind === "select" && readsCte(cte.query, cte.name)) {
				this.#recursions.add(cte.query.body)
			}
			const query = this.cteBody(cte.query, { ...env, ctes: new Map(ctes) }, name)
			ctes.set(cte.name, name)
			return { ...cte, name, query }
		})
		return isNonEmpty(bound)
			? { with: { ...w, ctes: bound }, env: { ...env, ctes } }
			: defect("a WITH of at least one CTE")
	}

	cteBody(body: CteBody, env: Env, name: Alias): CteBody {
		const level: PlanName = { kind: "named", name }
		switch (body.kind) {
			case "select":
				return this.query(body, env, level)
			case "insert":
				return this.insert(body, env, level)
			case "update":
				return this.update(body, env, level)
			case "delete":
				return this.delete(body, env, level)
			case "merge":
				return this.merge(body, env, level)
		}
	}

	/**
	 * A query body under `env`, its query's ORDER BY, LIMIT and OFFSET read under the env its body binds. A LIMIT that
	 * states its level's index order (sql/ast.ts AccessTag) states it of the core's driving read (`core`), and is read
	 * as the LIMIT it tags: no bound statement holds a tag.
	 */
	body(
		b: OperandBody,
		env: Env,
		name: PlanName | undefined,
		stated: Tail
	): {
		readonly body: OperandBody
		readonly tail: Tail
		readonly items: ReadonlyArray<PlanItem<AccessIndexRequest>>
	} {
		const limit = stated.limit
		/** A take's core with its fences folded away under its ORDER BY (`takenThrough`). */
		const taken =
			limit?.kind === "access" && limit.access.kind === "ordered" && b.kind === "core"
				? takenThrough(b, stated.orderBy)
				: undefined
		const orderBy = taken?.orderBy ?? stated.orderBy
		const order: OrderIntent | undefined =
			limit?.kind === "access" ? { tag: limit.access, orderBy } : undefined
		const tail: Tail = limit?.kind === "access" ? { ...stated, orderBy, limit: limit.expr } : stated
		const tailUnder = (under: Env): Tail => {
			const rename = this.renamer(under)
			return {
				orderBy: rename.orderItems(tail.orderBy),
				limit: tail.limit === undefined ? undefined : rename.expr(tail.limit),
				offset: tail.offset === undefined ? undefined : rename.expr(tail.offset)
			}
		}
		switch (b.kind) {
			case "core": {
				const folded = taken?.core ?? (tail.orderBy.length > 0 ? b : foldedCore(b, true))
				const bound = this.core(folded, env, name, order)
				return { body: bound.core, tail: tailUnder(bound.env), items: bound.items }
			}
			case "select": {
				const bound = this.#bound(b, env, name)
				return { body: bound.query, tail: tailUnder(env), items: bound.items }
			}
			case "setOp": {
				const [a0, a1, ...as] = b.arms
				const one = this.arm(a0, env)
				const two = this.arm(a1, env)
				const rest = as.map((a) => this.arm(a, env))
				const arms = [one.arm, two.arm, ...rest.map((a) => a.arm)] as const
				const members: NonEmptyReadonlyArray<PlanItem<AccessIndexRequest>> = [
					one.item,
					two.item,
					...rest.map((a) => a.item)
				]
				if (b.op === "UNION ALL" && name !== undefined && !this.#recursions.has(b)) {
					this.#levels.push({ kind: "append", name, members })
				}
				if (b.op === "UNION ALL" && b.rows !== "oneRow" && b.rows !== "operand") {
					const set = (arm: SetOperand) =>
						arm.kind === "core"
							? isSetBodyCore(arm)
							: isSetQuery(arm)
								? arm
								: defect("a UNION ALL arm bound a set still, as its proof requires")
					return {
						body: { ...b, arms: [set(arms[0]), set(arms[1]), ...arms.slice(2).map(set)] },
						tail: tailUnder(env),
						items: members
					}
				}
				return { body: { ...b, arms }, tail: tailUnder(env), items: members }
			}
		}
	}

	/**
	 * A set operation's arm, its one item with it (`armed`): a level PostgreSQL names itself, or pulls up into the append
	 * relation of a UNION ALL, so it reads its relations through that item.
	 */
	arm(
		arm: SetOperand,
		env: Env
	): { readonly arm: SetOperand; readonly item: PlanItem<AccessIndexRequest> } {
		const query = arm.kind === "core" ? operandSelect(arm) : arm
		const bound = this.#bound(armed(query), env, undefined)
		const [item, ...others] = bound.items
		if (item === undefined || others.length > 0) {
			return defect("a set operation's arm reading one item")
		}
		const q = bound.query
		return {
			arm:
				arm.kind === "core" &&
				q.with === undefined &&
				q.orderBy.length === 0 &&
				q.limit === undefined &&
				q.offset === undefined &&
				q.body.kind === "core"
					? q.body
					: q,
			item
		}
	}

	/**
	 * One level (see the header): a core under `env`, planned under `name`, none for one PostgreSQL names itself. Its
	 * FROM is walked in order, each entry seeing the ones before it; each stored table's bindings are taken from the
	 * conjuncts that may bind it, moved into its read, and the rest of the level is read under every entry's new alias.
	 */
	core(
		c: SelectCore,
		env: Env,
		name: PlanName | undefined,
		order: OrderIntent | undefined
	): {
		readonly core: SelectCore
		readonly env: Env
		readonly items: ReadonlyArray<PlanItem<AccessIndexRequest>>
	} {
		const depth = env.depth + 1
		const where: Array<Expr> = [...conjunctsOf(c.where)]
		let here: Env = { ...env, depth }
		const bound: Array<BoundEntry> = []
		const viewed = new Set<Alias>()
		for (const [place, logical] of entriesOf(c.from).entries()) {
			const entry = this.#apart(logical, viewed)
			const written = writtenOf(entry.source)
			const alias = this.#alias(written)
			const read = this.entry(
				entry,
				place,
				where,
				here,
				env,
				alias,
				place === 0 ? order : undefined
			)
			bound.push(read)
			if (read.item.alias !== alias) {
				viewed.add(read.item.alias)
			}
			if (written !== undefined) {
				here = withRelation(here, written, alias, depth, place)
			}
		}
		const rename = this.renamer(here)
		this.#level(name, bound)
		const frame = {
			kind: "core",
			from: fromOf(bound),
			where: conjunction(where.map((w) => rename.expr(w))),
			groupBy: rename.exprs(c.groupBy),
			having: c.having === undefined ? undefined : rename.expr(c.having)
		} as const
		const items = bound.map((b) => b.item)
		if (c.distinct === false) {
			return {
				core: { ...frame, distinct: false, rows: c.rows, targets: rename.targets(c.targets) },
				env: here,
				items
			}
		}
		const [t0, ...ts] = rename.targets(c.targets)
		if (t0 === undefined) {
			return defect("a DISTINCT core of a target at least")
		}
		const distinct = c.distinct === true ? true : { on: rename.nonEmptyExprs(c.distinct.on) }
		return { core: { ...frame, distinct, targets: [t0, ...ts] }, env: here, items }
	}

	/** A level's plan, its first entry driving and the rest joined in order, where the scope names it. */
	#level(name: PlanName | undefined, bound: ReadonlyArray<BoundEntry>): void {
		const [first, ...joined] = bound
		if (name === undefined || first === undefined) {
			return
		}
		this.#levels.push({
			kind: "joins",
			name,
			first: first.item,
			joined: joined.map((j): JoinedItem<AccessIndexRequest> => ({ item: j.item, join: j.method })),
			appended: bound.flatMap((b) => b.appended)
		})
	}

	/**
	 * One entry of a level at `place`, under `here` (its enclosing levels' relations and its level's entries before it)
	 * and `outer` (its enclosing levels' alone): its source bound under `alias`, the conjuncts of `where` it binds or
	 * takes moved out of it.
	 */
	entry(
		entry: Entry,
		place: number,
		where: Array<Expr>,
		here: Env,
		outer: Env,
		alias: Alias,
		order: OrderIntent | undefined
	): BoundEntry {
		const source = entry.source
		const writtenAlias = writtenOf(source)
		const self =
			writtenAlias === undefined ? here : withRelation(here, writtenAlias, alias, here.depth, place)
		const step = (): Step =>
			entry.join === "on" || entry.join === "left"
				? { join: entry.join, on: this.expr(entry.on, self) }
				: { join: "cross" }
		const rows = (s: FromSource, method: JoinMethod): BoundEntry => ({
			source: s,
			step: step(),
			item: { alias, scan: { kind: "rows" } },
			method,
			appended: []
		})
		switch (source.kind) {
			case "table": {
				const view = this.#catalog.view(nameKey(source.table))
				switch (view?.kind) {
					case "world":
						this.#world(entry, source.alias, where, outer, alias, view.view)
						return rows({ ...source, alias }, this.#method(entry, source.alias, where, here, place))
					case "apart":
						return rows({ ...source, alias }, this.#method(entry, source.alias, where, here, place))
					case "whole":
					case undefined:
						return this.tableEntry(entry, source, place, where, here, alias, order)
				}
			}
			case "derived":
				return this.derivedEntry(entry, source, place, where, here, outer, alias)
			case "cte": {
				const name = here.ctes.get(source.name)
				return name === undefined
					? defect(`a CTE ${source.name} a WITH in reach binds`)
					: rows(
							{ kind: "cte", name, alias },
							this.#method(entry, source.alias ?? source.name, where, here, place)
						)
			}
			case "probe":
				return this.statedProbe(source, here, alias, step())
			case "met":
				return this.statedMet(source, here, alias, step())
			case "metRows": {
				const cteOf = (name: string) =>
					here.ctes.get(name) ?? defect(`a CTE ${name} a WITH in reach binds, which met rows read`)
				const marked = this.#alias(source.marked)
				const sides = this.#alias(source.sides)
				const scan = this.#alias(source.scan)
				const returned = this.#alias(source.returned)
				this.#levels.push({
					kind: "joins",
					name: { kind: "named", name: marked },
					first: { alias: sides, scan: { kind: "rows" } },
					joined: [],
					appended: [
						{ alias: scan, scan: { kind: "rows" } },
						{ alias: returned, scan: { kind: "rows" } }
					]
				})
				const read = rows(
					{
						...source,
						insert: cteOf(source.insert),
						proposed: cteOf(source.proposed),
						scan,
						returned,
						sides,
						marked,
						alias
					},
					this.#method(entry, source.alias, where, here, place)
				)
				return { ...read, item: { alias: marked, scan: { kind: "rows" } } }
			}
			case "read":
				return defect("a read source the lowering stated, which the binding alone makes")
			case "enclosing":
				return rows(
					{
						...source,
						name:
							here.ctes.get(source.name) ??
							defect(`a CTE ${source.name} an enclosing statement's WITH in reach binds`),
						alias
					},
					"nestedLoop"
				)
			case "transition":
				return rows({ ...source, alias }, this.#method(entry, source.alias, where, here, place))
			case "context": {
				const inner = this.#alias(source.inner)
				this.#levels.push({
					kind: "joins",
					name: { kind: "named", name: alias },
					first: { alias: inner, scan: { kind: "rows" } },
					joined: [],
					appended: []
				})
				return rows(
					{ ...source, inner, alias },
					this.#method(entry, source.alias, where, here, place)
				)
			}
			case "function":
				return rows(
					{
						...source,
						alias,
						call: { ...source.call, args: this.renamer(here).exprs(source.call.args) }
					},
					"nestedLoop"
				)
			case "arrays": {
				const arrays = source.source
				const renamer = this.renamer(here)
				return rows(
					{
						...source,
						alias,
						source:
							arrays.kind === "carried" || arrays.kind === "setting"
								? {
										...arrays,
										columns: mapNonEmpty(arrays.columns, (c) => ({
											...c,
											array: renamer.expr(c.array)
										}))
									}
								: arrays
					},
					"nestedLoop"
				)
			}
			case "values":
				return rows(
					{ ...source, alias, rows: mapNonEmpty(source.rows, (r) => this.renamer(outer).exprs(r)) },
					this.#method(entry, source.alias, where, here, place)
				)
		}
	}

	/**
	 * A read a driving row reaches that the lowering stated (FromSource `probe` and `met`), planned apart at each driving
	 * row under its alias: its inner read under a fresh alias of the scope, every value and filter read under `here` and
	 * the inner read, and its level the read of its table through the index its bound columns lead, a key's, a group's
	 * or a met row's, the group's order after them, at the columns it delivers. A table the catalog holds no B-tree
	 * column of it binds, a span key's probe read by its overlap among them, is a level of its own the plan states no scan
	 * of, PostgreSQL's choice by cost.
	 */
	#driven(
		table: ObjectName,
		written: string,
		bound: ReadonlyArray<string>,
		order: ReadonlyArray<string>,
		keyed: boolean,
		delivered: ReadonlyArray<string>,
		alias: Alias
	): { readonly inner: Alias; readonly inside: (env: Env) => Env } {
		const inner = this.#alias(written)
		const stored = this.#stored(table)
		const catalogTable = stored?.table
		const held =
			catalogTable === undefined
				? []
				: bound.filter((c) => btreeColumn(catalogTable, c) !== undefined)
		const trailing =
			catalogTable === undefined
				? []
				: order.filter((c) => btreeColumn(catalogTable, c) !== undefined && !held.includes(c))
		const [h0, ...hs] = held
		this.#levels.push({
			kind: "joins",
			name: { kind: "named", name: alias },
			first: {
				alias: stored === undefined ? inner : itemAlias(stored, inner),
				scan:
					stored === undefined || h0 === undefined || held.length !== bound.length
						? { kind: "rows" }
						: {
								kind: "index",
								index: requestOf(
									stored.table,
									[h0, ...hs],
									trailing,
									keyed ? "key lookup" : "join key"
								),
								bound: held,
								needs: tableColumns(stored, [...new Set([...delivered, ...held])].toSorted())
							}
			},
			joined: [],
			appended: []
		})
		return { inner, inside: (env) => withRelation(env, written, inner, env.depth + 1, 0) }
	}

	/** A probe the lowering stated (`#driven`): its key's, its rows', its group's or its group's last row's. */
	statedProbe(
		source: Extract<FromSource, { readonly kind: "probe" }>,
		here: Env,
		alias: Alias,
		step: Step
	): BoundEntry {
		const by = source.by
		const { inner, inside } = this.#driven(
			source.table,
			source.inner,
			by.columns.map((c) => c.column),
			by.kind === "group" || by.kind === "last" ? by.order : [],
			by.kind === "key",
			source.columns.map((c) => c.read),
			alias
		)
		const value = (c: ProbeColumn): ProbeColumn => ({ ...c, value: this.expr(c.value, here) })
		const bound: ProbeBy =
			by.kind === "key"
				? { kind: "key", columns: by.columns.map(value) }
				: by.kind === "rows"
					? { kind: "rows", columns: mapNonEmpty(by.columns, value) }
					: { kind: by.kind, columns: mapNonEmpty(by.columns, value), order: by.order }
		return {
			source: {
				...source,
				inner,
				by: bound,
				filter: source.filter.map((f) => this.expr(f, inside(here))),
				alias
			},
			step,
			item: { alias, scan: { kind: "rows" } },
			method: "nestedLoop",
			appended: []
		}
	}

	/** A met row's stored row the lowering stated (`#driven`), at its key of the met rows in scope. */
	statedMet(
		source: Extract<FromSource, { readonly kind: "met" }>,
		here: Env,
		alias: Alias,
		step: Step
	): BoundEntry {
		const { inner, inside } = this.#driven(
			source.table,
			source.inner,
			source.key.map((k) => k.column),
			[],
			true,
			source.columns.map((c) => c.read),
			alias
		)
		const rows =
			here.relations.get(source.rows)?.alias ??
			defect(`the met rows ${source.rows} a met row reads in scope`)
		return {
			source: {
				...source,
				inner,
				rows,
				filter: source.filter.map((f) => this.expr(f, inside(here))),
				alias
			},
			step,
			item: { alias, scan: { kind: "rows" } },
			method: "nestedLoop",
			appended: []
		}
	}

	/**
	 * How an item no index binds joins the items before it: by a hash where an equality of its WHERE or ON pairs one of
	 * its columns with a column of an earlier item of its level, a set join's; else by a nested loop.
	 */
	#method(
		entry: Entry,
		written: string,
		where: ReadonlyArray<Expr>,
		here: Env,
		place: number
	): JoinMethod {
		if (place === 0) {
			return "nestedLoop"
		}
		const pool =
			entry.join === "on" || entry.join === "left" ? [...where, ...conjunctsOf(entry.on)] : where
		const earlier = (a: string) => {
			const d = here.relations.get(a)
			return d?.depth === here.depth && d.place < place
		}
		return pool.some((c) => {
			const b = bindingOf(c, written)
			return b?.op === "=" && [...qualifiersOf(b.value)].some(earlier)
		})
			? "hash"
			: "nestedLoop"
	}

	/** A stored table's entry (see the header): a probe where an earlier item binds it, a seek, or a whole read. */
	tableEntry(
		entry: Entry,
		source: Extract<FromSource, { readonly kind: "table" }>,
		place: number,
		where: Array<Expr>,
		here: Env,
		alias: Alias,
		order: OrderIntent | undefined
	): BoundEntry {
		const written = source.alias
		const stored = this.#stored(source.table)
		const table = stored?.table
		const ons: Array<Expr> =
			entry.join === "on" || entry.join === "left" ? [...conjunctsOf(entry.on)] : []
		const pools: ReadonlyArray<Array<Expr>> = entry.join === "left" ? [ons] : [where, ons]
		const earlier = (a: string) => {
			const d = here.relations.get(a)
			return d?.depth === here.depth && d.place < place
		}
		const fixed = (e: Expr) =>
			[...qualifiersOf(e)].every((a) => {
				const d = here.relations.get(a)
				return d !== undefined && d.depth < here.depth
			})
		const bindings =
			table === undefined
				? []
				: pools.flatMap((pool) =>
						pool.flatMap((c): ReadonlyArray<Binding & { readonly driven: boolean }> => {
							const b = bindingOf(c, written)
							if (b === undefined || btreeColumn(table, b.column) === undefined) {
								return []
							}
							const driven = b.op === "=" && [...qualifiersOf(b.value)].some(earlier)
							return (driven && !this.#whole) || fixed(b.value) ? [{ ...b, driven }] : []
						})
					)
		const delivers = this.#needed(written)
		const needs = stored === undefined ? delivers : tableColumns(stored, delivers)
		const take = (conjunct: Expr) => {
			for (const pool of pools) {
				const at = pool.indexOf(conjunct)
				if (at >= 0) {
					pool.splice(at, 1)
				}
			}
		}
		if (stored !== undefined && bindings.some((b) => b.driven)) {
			return this.probeEntry(
				entry,
				source,
				stored,
				bindings,
				ons,
				where,
				here,
				alias,
				delivers,
				take
			)
		}
		const self = withRelation(here, written, alias, here.depth, place)
		const access: Classified =
			table === undefined
				? { kind: "whole" }
				: this.#reached(table, this.#classified(table, written, pools, bindings, fixed, order))
		/** A conjunct the read binds or matches, moved out of its level into the read, read under the read's alias. */
		const moved = (conjunct: Expr): Expr => {
			take(conjunct)
			return this.expr(conjunct, self)
		}
		const sought = (fixing: ReadonlyArray<Binding>): ReadonlyArray<SeekBinding> =>
			fixing.map((b) => ({ column: b.column, condition: moved(b.conjunct) }))
		const read = (levelAccess: LevelAccess): FromSource => ({
			kind: "read",
			table: source.table,
			alias,
			access: levelAccess
		})
		const indexed = (
			levelAccess: LevelAccess,
			request: AccessIndexRequest,
			bound: ReadonlyArray<string>
		): { readonly source: FromSource; readonly scan: PlanItem<AccessIndexRequest>["scan"] } => ({
			source: read(levelAccess),
			scan: { kind: "index", index: request, bound, needs }
		})
		const bound = ((): {
			readonly source: FromSource
			readonly scan: PlanItem<AccessIndexRequest>["scan"]
		} => {
			if (table === undefined) {
				return { source: read({ kind: "whole" }), scan: { kind: "rows" } }
			}
			switch (access.kind) {
				case "whole":
					return { source: read({ kind: "whole" }), scan: { kind: "seq" } }
				case "seek": {
					const [b0, ...bs] = sought(access.eq)
					if (b0 === undefined) {
						return defect("a seek binding a column at least")
					}
					return indexed(
						{ kind: "seek", bound: [b0, ...bs] },
						accessRequest(table, access),
						columnsOf(access.eq)
					)
				}
				case "ordered":
					return indexed(
						{ kind: "ordered", bound: sought(access.eq), order: access.order, use: access.use },
						accessRequest(table, access),
						columnsOf(access.eq)
					)
				case "nearest":
					return indexed(
						{ kind: "nearest", column: access.column },
						accessRequest(table, access),
						[]
					)
				case "range": {
					const [c0, ...cs] = access.conjuncts
					return indexed(
						{
							kind: "range",
							bound: sought(access.eq),
							column: access.key.column,
							conditions: [moved(c0), ...cs.map(moved)],
							use: access.use
						},
						accessRequest(table, access),
						[...columnsOf(access.eq), access.key.column]
					)
				}
				case "span":
					return indexed(
						{
							kind: "span",
							bound: sought(access.eq),
							column: access.column,
							condition: moved(access.conjunct)
						},
						accessRequest(table, access),
						[...columnsOf(access.eq), access.column]
					)
				case "network":
					return indexed(
						{
							kind: "network",
							bound: [],
							column: access.column,
							condition: moved(access.conjunct)
						},
						accessRequest(table, access),
						[access.column]
					)
				case "search":
					return {
						source: read({
							kind: "search",
							column: access.column,
							condition: moved(access.conjunct)
						}),
						scan: {
							kind: "bitmap",
							index: accessRequest(table, access),
							bound: [access.column],
							needs
						}
					}
			}
		})()
		const step: Step =
			entry.join === "on" || entry.join === "left"
				? {
						join: entry.join,
						on: conjunction(ons.map((c) => this.expr(c, self))) ?? lit.bool(true)
					}
				: { join: "cross" }
		return {
			source: bound.source,
			step,
			item: { alias: stored === undefined ? alias : itemAlias(stored, alias), scan: bound.scan },
			method: this.#method(entry, written, where, here, place),
			appended: []
		}
	}

	/**
	 * How a stored read reaches its rows (`tableEntry`), each conjunct of `pools` classified by its operator and its
	 * column's kind (BindColumn), against a value its level fixes, its equalities `bindings` among them, and the index
	 * order its level's LIMIT states of it (`order`), in this order of what reaches the fewest rows by construction:
	 * - its equalities where they hold a unique key whole, at one row (`seek`, a key lookup);
	 * - its level's index order: a take's or a page's ORDER BY of its B-tree columns past the ones its equalities fix,
	 *   after them (`ordered`), or an approximate search's distance from a fixed vector (`nearest`), the equalities then
	 *   filters;
	 * - a span's Allen relation, after its equalities through btree_gist (`span`);
	 * - the one range past its equalities, of the column bounded on both sides first, then the least by name, where a
	 *   column it or they bind holds many values (`range`, a text column bounded on both sides a prefix search), as the
	 *   workload's access paths have always ranged a read;
	 * - its equalities where one holds many values (`seek`);
	 * - a network's containment (`network`) or a search document's match (`search`), the equalities filters;
	 * - else whole: no conjunct an index serves, or equalities of few values alone, a roster's share of the rows.
	 * A conjunct of any other operator is a filter, never an access.
	 */
	#classified(
		table: BindTable,
		written: string,
		pools: ReadonlyArray<ReadonlyArray<Expr>>,
		bindings: ReadonlyArray<Binding>,
		fixed: (e: Expr) => boolean,
		order: OrderIntent | undefined
	): Classified {
		const conjuncts = pools.flat()
		const equal = new Set(bindings.map((b) => b.column))
		const holds = (column: string) => btreeColumn(table, column)?.holds
		const many = bindings.some((b) => holds(b.column) === "many")
		const [b0, ...bs] = bindings
		if (many && b0 !== undefined && holdsKey(table, equal)) {
			return { kind: "seek", eq: [b0, ...bs], keyed: true }
		}
		const kindOf = (column: string) => table.columns.get(column)?.kind
		if (order !== undefined) {
			const ordered = orderedOf(table, written, order, equal, fixed)
			if (ordered !== undefined) {
				return ordered.kind === "ordered" ? { ...ordered, eq: bindings } : ordered
			}
		}
		const matched = (kind: keyof typeof matchOperators) =>
			conjuncts
				.flatMap((c) => {
					const m = matchOf(c, written, kind, kindOf)
					return m !== undefined && fixed(m.value) ? [{ conjunct: c, column: m.column }] : []
				})
				.toSorted((x, y) => compareStrings(x.column, y.column))[0]
		const span = matched("span")
		if (span !== undefined) {
			return { kind: "span", eq: bindings, column: span.column, conjunct: span.conjunct }
		}
		const ranges = conjuncts.flatMap((c) => {
			const r = rangeSideOf(c, written)
			if (r === undefined || !fixed(r.value)) {
				return []
			}
			const column = btreeColumn(table, r.key.column)
			const ranging =
				r.key.term === "column"
					? column !== undefined && !equal.has(r.key.column)
					: column?.kind === "text"
			return ranging ? [{ conjunct: c, ...r }] : []
		})
		const ranged = ranges
			.map((r) => r.key)
			.filter((key, at, keys) => keys.findIndex((k) => sameRanged(k, key)) === at)
			.map((key) => {
				const sides = new Set(ranges.filter((r) => sameRanged(r.key, key)).map((r) => r.side))
				return { key, both: sides.has("both") || (sides.has("lower") && sides.has("upper")) }
			})
			.filter((r) => many || holds(r.key.column) === "many")
			.toSorted((x, y) =>
				x.both === y.both
					? compareStrings(x.key.column, y.key.column) || compareStrings(x.key.term, y.key.term)
					: x.both
						? -1
						: 1
			)[0]
		if (ranged !== undefined) {
			const [c0, ...cs] = ranges.filter((r) => sameRanged(r.key, ranged.key)).map((r) => r.conjunct)
			return c0 === undefined
				? defect("a ranged key of a range conjunct")
				: {
						kind: "range",
						eq: bindings,
						key: ranged.key,
						conjuncts: [c0, ...cs],
						use:
							ranged.both && ranged.key.term === "column" && kindOf(ranged.key.column) === "text"
								? "prefix search"
								: "range"
					}
		}
		if (many && b0 !== undefined) {
			return { kind: "seek", eq: [b0, ...bs], keyed: false }
		}
		const network = matched("network")
		if (network !== undefined) {
			return { kind: "network", column: network.column, conjunct: network.conjunct }
		}
		const search = matched("search")
		return search === undefined
			? { kind: "whole" }
			: { kind: "search", column: search.column, conjunct: search.conjunct }
	}

	/**
	 * A stored table an earlier item binds, as a probe: every binding moved into it, a `=` one as the probe's column, any
	 * other into its filter, read at its inner alias; under a LEFT JOIN its whole ON moved in, the step's ON then true;
	 * a key probe where its `=` bindings hold a unique key whole, else every row at them; delivering every column the
	 * statement reads of it under its own name, its alias the table's, so every reference reads it as it read the table.
	 */
	probeEntry(
		entry: Entry,
		source: Extract<FromSource, { readonly kind: "table" }>,
		stored: Stored,
		bindings: ReadonlyArray<Binding>,
		ons: Array<Expr>,
		where: Array<Expr>,
		here: Env,
		alias: Alias,
		needs: ReadonlyArray<string>,
		take: (conjunct: Expr) => void
	): BoundEntry {
		const table = stored.table
		const written = source.alias
		const inner = this.#alias(written)
		const inside = withRelation(here, written, inner, here.depth + 1, 0)
		for (const b of bindings) {
			take(b.conjunct)
		}
		const moved = entry.join === "left" ? ons.splice(0) : []
		const columns: Array<ProbeColumn> = []
		const filter: Array<Expr> = []
		for (const b of bindings) {
			if (b.op === "=") {
				columns.push({ column: b.column, value: this.expr(b.value, here), schema: b.schema })
			} else {
				filter.push(this.expr(b.conjunct, inside))
			}
		}
		for (const c of moved) {
			filter.push(this.expr(c, inside))
		}
		for (const c of entry.join === "on" ? ons.splice(0) : []) {
			where.push(c)
		}
		const keyed = holdsKey(table, new Set(columns.map((c) => c.column)))
		const bound = [...new Set(bindings.map((b) => b.column))].toSorted()
		const delivered = needs.length > 0 ? needs : bound
		const [d0, ...ds] = delivered.map((c): DrivenColumn => ({ read: c, as: c }))
		const [c0, ...cs] = columns
		const [k0, ...ks] = bound
		if (d0 === undefined || c0 === undefined || k0 === undefined) {
			return defect("a probe of a column at least, bound by one")
		}
		this.#levels.push({
			kind: "joins",
			name: { kind: "named", name: alias },
			first: {
				alias: itemAlias(stored, inner),
				scan: {
					kind: "index",
					index: requestOf(table, [k0, ...ks], [], keyed ? "key lookup" : "join key"),
					bound,
					needs: tableColumns(stored, delivered)
				}
			},
			joined: [],
			appended: []
		})
		return {
			source: {
				kind: "probe",
				table: source.table,
				inner,
				by: keyed ? { kind: "key", columns: [c0, ...cs] } : { kind: "rows", columns: [c0, ...cs] },
				filter,
				columns: [d0, ...ds],
				alias
			},
			step: entry.join === "left" ? { join: "left", on: lit.bool(true) } : { join: "cross" },
			item: { alias, scan: { kind: "rows" } },
			method: "nestedLoop",
			appended: []
		}
	}

	/**
	 * The plan of a read of the world view `view`, under the reference's alias `alias` (BindView `world`), which
	 * PostgreSQL plans apart under that alias: its body bound again under its view scope, so every alias it mints is its
	 * installation's, with each qual of the read's level that PostgreSQL pushes past the barrier pushed in first
	 * (`passesBarrier`), a leakproof comparison of the view's columns with values the level fixes, its top level named by
	 * `alias`, each level of its own by the scope's name. A body whose binding mints other names than its installation's,
	 * or a statement that reads one world view whose body holds levels of its own twice, which PostgreSQL would name twice
	 * (planner.c choose_plan_name), is an internal compiler error naming the view.
	 */
	#world(
		entry: Entry,
		written: string,
		where: ReadonlyArray<Expr>,
		outer: Env,
		alias: Alias,
		view: WorldBinding
	): void {
		const ons = entry.join === "on" || entry.join === "left" ? conjunctsOf(entry.on) : []
		const pool = entry.join === "left" ? ons : [...where, ...ons]
		const enclosing = (a: string) => {
			const d = outer.relations.get(a)
			return d !== undefined && d.depth <= outer.depth
		}
		let query: OperandSelect = namedQuery(view.prepared, view.columns)
		for (const c of pool) {
			if (
				!passesBarrier(c, written, view.leaky) ||
				![...qualifiersOf(c)].every((a) => a === written || enclosing(a))
			) {
				continue
			}
			query = pushedInto(query, written, c) ?? query
		}
		const scope = new ViewScope(view.ordinal)
		const nested = new Binder(scope, this.#catalog, this.#reads)
		nested.#needs = neededBy((t) => t.select(query))
		nested.#whole = this.#whole
		nested.query(query, { ...outer, ctes: new Map() }, { kind: "named", name: alias })
		const viewName = `${view.name.schema}.${view.name.name}`
		if (scope.minted() !== view.minted) {
			defect(
				`the world view ${viewName}'s body bound again under its view scope mints ${scope.minted()} names, its installation's ${view.minted}`
			)
		}
		const levels = nested.plan().levels
		if (levels.length > 1) {
			if (this.#worlds.has(view.ordinal)) {
				defect(
					`a statement that reads the world view ${viewName} twice, whose body holds levels of its own PostgreSQL would name twice: install the view in as many instances as one statement reads it, each read through its own`
				)
			}
			this.#worlds.add(view.ordinal)
		}
		appendAll(this.#levels, levels)
	}

	/**
	 * Whether a conjunct reading the derived table `written`, whose query is `q`, binds a stored read of its query's own
	 * level, every column of `written` it reads one of a stored table that level reads, a B-tree's of many values: pushed
	 * in, it is that read's key, so the table read per row before it reads its rows at the key, as a probe does.
	 */
	#keyedBy(q: OperandSelect, written: string, c: Expr): boolean {
		const body = q.body
		if (body.kind !== "core") {
			return false
		}
		const names = selectColumns(q)
		const stored = new Map(
			entriesOf(body.from).flatMap((e) => {
				const t = e.source.kind === "table" ? this.#stored(e.source.table)?.table : undefined
				return e.source.kind === "table" && t !== undefined ? [[e.source.alias, t] as const] : []
			})
		)
		let keyed = true
		eachColumn(c, (table, column) => {
			if (table !== written) {
				return
			}
			const t = body.targets[names.indexOf(column)]
			const ref = t === undefined ? undefined : columnOf(t.expr)
			const read = ref === undefined ? undefined : stored.get(ref.table)
			keyed &&=
				ref !== undefined && read !== undefined && btreeColumn(read, ref.column)?.holds === "many"
		})
		return keyed
	}

	/**
	 * A derived table's entry: each conjunct of its level that reads its columns beside values its place fixes, a
	 * parameter, a literal or an enclosing level's column, and that its query takes (`pushedInto`), pushed in first; its
	 * query bound as a level its alias names, fenced where PostgreSQL would pull it up. A conjunct that also reads an
	 * earlier item of its level is pushed only where it binds a stored read of the table's query (`#keyedBy`), the table
	 * then LATERAL, read per row before it at the key, as a probe is; any other stays the level's, a set join's
	 * condition, so the table is derived once and joined by a hash (`#method`), never derived again for each row before
	 * it, a CTE's scan or a fold over every row read once; one the lowering wrote LATERAL takes those too.
	 */
	derivedEntry(
		entry: Entry,
		source: Extract<FromSource, { readonly kind: "derived" }>,
		place: number,
		where: Array<Expr>,
		here: Env,
		outer: Env,
		alias: Alias
	): BoundEntry {
		const written = source.alias
		const ons: Array<Expr> =
			entry.join === "on" || entry.join === "left" ? [...conjunctsOf(entry.on)] : []
		const pool = entry.join === "left" ? ons : where
		const earlier = (a: string) => {
			const d = here.relations.get(a)
			return d?.depth === here.depth && d.place < place
		}
		const enclosing = (a: string) => {
			const d = here.relations.get(a)
			return d !== undefined && d.depth < here.depth
		}
		let query = source.query
		let lateral = source.lateral
		for (const c of pool.slice()) {
			const qualifiers = [...qualifiersOf(c)]
			if (!qualifiers.every((a) => a === written || enclosing(a) || earlier(a))) {
				continue
			}
			const joins = qualifiers.some(earlier)
			if (joins && !lateral && !this.#keyedBy(query, written, c)) {
				continue
			}
			const pushed = pushedInto(query, written, c)
			if (pushed === undefined) {
				continue
			}
			pool.splice(pool.indexOf(c), 1)
			query = pushed
			lateral ||= joins
		}
		const self = withRelation(here, written, alias, here.depth, place)
		const step: Step =
			entry.join === "on" || entry.join === "left"
				? {
						join: entry.join,
						on: conjunction(ons.map((c) => this.expr(c, self))) ?? lit.bool(true)
					}
				: { join: "cross" }
		const reads = lateral ? here : outer
		const appended = pulledUnion(query)
		const bound = appended
			? this.#bound(query, reads, undefined)
			: { query: this.query(fenced(query), reads, { kind: "named", name: alias }), items: [] }
		return {
			source: { kind: "derived", query: bound.query, alias, lateral },
			step,
			item: { alias, scan: { kind: "rows" } },
			method: lateral ? "nestedLoop" : this.#method(entry, written, where, here, place),
			appended: bound.items
		}
	}

	/**
	 * An INSERT: its query read through one item of the scope's where it reads at its own level (`wrapped`), the
	 * INSERT's source being a level PostgreSQL pulls up into the INSERT's or names itself; its arbitration and RETURNING
	 * read under its target's new alias.
	 */
	insert(s: Insert, env: Env, name: PlanName): Insert {
		const { with: w, env: inner } = this.with(s.with, env)
		const targetAlias = s.alias === undefined ? undefined : this.#alias(s.alias)
		const own =
			s.alias === undefined || targetAlias === undefined
				? inner
				: withRelation(inner, s.alias, targetAlias, inner.depth + 1, 0)
		const rename = this.renamer(own)
		const base = {
			kind: "insert",
			with: w,
			table: s.table,
			alias: targetAlias,
			onConflict: s.onConflict === undefined ? undefined : rename.onConflict(s.onConflict),
			returning: rename.targets(s.returning)
		} as const
		if (isValuesTarget(s)) {
			return {
				...base,
				columns: s.columns,
				source: {
					kind: "values",
					rows: mapNonEmpty(s.source.rows, (r) => this.renamer(inner).exprs(r))
				}
			}
		}
		const source = s.source
		return {
			...base,
			columns: s.columns,
			source: { kind: "query", query: this.setQuery(wrapped(source.query, false), inner, name) }
		}
	}

	/**
	 * A write's target and the items it reads beside it (an UPDATE's FROM, a DELETE's USING), at the write's level: the
	 * items first, in order, which never see the target; then the target, read at the tuple ids a probe of it at its
	 * bindings to those items finds where they bind it, else at its own bindings or whole.
	 */
	written(
		table: Extract<FromSource, { readonly kind: "table" }>["table"],
		written: string,
		items: ReadonlyArray<FromItem>,
		condition: Expr | undefined,
		env: Env,
		name: PlanName
	): {
		readonly alias: Alias
		readonly items: ReadonlyArray<FromItem>
		readonly where: Expr | undefined
		readonly env: Env
	} {
		const depth = env.depth + 1
		const where: Array<Expr> = [...conjunctsOf(condition)]
		let here: Env = { ...env, depth }
		const bound: Array<BoundEntry> = []
		for (const [place, entry] of entriesOf(items).entries()) {
			const w = writtenOf(entry.source)
			const alias = this.#alias(w)
			bound.push(this.entry(entry, place, where, here, env, alias, undefined))
			if (w !== undefined) {
				here = withRelation(here, w, alias, depth, place)
			}
		}
		const alias = this.#alias(written)
		const place = bound.length
		const catalogTable = this.#catalog.table(nameKey(table))
		const earlier = (a: string) => {
			const d = here.relations.get(a)
			return d?.depth === depth && d.place < place
		}
		/**
		 * The target's tuple id its condition states equal to a value: one its level fixes (a PL variable, a parameter, an
		 * enclosing level's column) or an earlier item's column, so the target is read at that tid, one heap fetch a row by
		 * a TID condition of its scan, never through an index or whole: a stale row's DELETE in an upkeep's loop
		 * (physical/ddl/rules.ts removal), a unit delete's of the rows it removes (write/delete/unit.ts).
		 */
		const atTid =
			catalogTable === undefined
				? undefined
				: where.map((c) => bindingOf(c, written)).find((b) => b?.op === "=" && b.column === tupleId)
		if (atTid !== undefined) {
			const tidRead: BoundEntry = {
				source: { kind: "read", table, alias, access: { kind: "whole" } },
				step: { join: "cross" },
				item: { alias, scan: { kind: "tid" } },
				method: "nestedLoop",
				appended: []
			}
			here = withRelation(here, written, alias, depth, place)
			this.#level(
				name,
				[...qualifiersOf(atTid.value)].some(earlier) ? [...bound, tidRead] : [tidRead, ...bound]
			)
			const rename = this.renamer(here)
			return {
				alias,
				items: fromOf(bound),
				where: conjunction(where.map((x) => rename.expr(x))),
				env: here
			}
		}
		const bindings =
			catalogTable === undefined
				? []
				: where.flatMap((c) => {
						const b = bindingOf(c, written)
						return b !== undefined && btreeColumn(catalogTable, b.column) !== undefined ? [b] : []
					})
		const driven = bindings.filter((b) => b.op === "=" && [...qualifiersOf(b.value)].some(earlier))
		if (catalogTable !== undefined && driven.length > 0) {
			const probeAlias = this.#alias(written)
			const probed = this.probeEntry(
				{ join: "cross", source: { kind: "table", table, alias: written } },
				{ kind: "table", table, alias: written },
				{ kind: "table", table: catalogTable },
				driven,
				[],
				where,
				here,
				probeAlias,
				[tupleId],
				(conjunct) => {
					const at = where.indexOf(conjunct)
					if (at >= 0) {
						where.splice(at, 1)
					}
				}
			)
			bound.push(probed)
			here = withRelation(here, written, alias, depth, place + 1)
			this.#level(name, [
				...bound,
				{
					source: probed.source,
					step: { join: "cross" },
					item: { alias, scan: { kind: "tid" } },
					method: "nestedLoop",
					appended: []
				}
			])
			const rename = this.renamer(here)
			return {
				alias,
				items: fromOf(bound),
				where: conjunction([
					eq(col(alias, tupleId), col(probeAlias, tupleId)),
					...where.map((x) => rename.expr(x))
				]),
				env: here
			}
		}
		const many =
			catalogTable !== undefined &&
			bindings.some((b) => btreeColumn(catalogTable, b.column)?.holds === "many")
		const fixedBindings = bindings.filter((b) =>
			[...qualifiersOf(b.value)].every((a) => {
				const d = here.relations.get(a)
				return d !== undefined && d.depth < depth
			})
		)
		const boundColumns = [...new Set((many ? fixedBindings : []).map((b) => b.column))].toSorted()
		const [b0, ...bs] = boundColumns
		const sought =
			catalogTable === undefined || b0 === undefined
				? undefined
				: requestOf(
						catalogTable,
						[b0, ...bs],
						[],
						holdsKey(catalogTable, new Set(boundColumns)) ? "key lookup" : "equality lookup"
					)
		const targetItem: PlanItem<AccessIndexRequest> =
			catalogTable === undefined
				? { alias, scan: { kind: "rows" } }
				: sought === undefined || !this.#serves(sought)
					? { alias, scan: { kind: "seq" } }
					: {
							alias,
							scan: {
								kind: "index",
								index: sought,
								bound: boundColumns,
								needs: this.#needed(written)
							}
						}
		here = withRelation(here, written, alias, depth, place)
		this.#level(name, [
			{
				source: { kind: "read", table, alias, access: { kind: "whole" } },
				step: { join: "cross" },
				item: targetItem,
				method: "nestedLoop",
				appended: []
			},
			...bound
		])
		const rename = this.renamer(here)
		return {
			alias,
			items: fromOf(bound),
			where: conjunction(where.map((x) => rename.expr(x))),
			env: here
		}
	}

	update(s: Update, env: Env, name: PlanName): Update {
		const { with: w, env: inner } = this.with(s.with, env)
		const t = this.written(s.table, s.alias, s.from, s.where, inner, name)
		const rename = this.renamer(t.env)
		return {
			...s,
			with: w,
			alias: t.alias,
			set: rename.assignments(s.set),
			from: t.items,
			where: t.where,
			returning: rename.targets(s.returning)
		}
	}

	delete(s: Delete, env: Env, name: PlanName): Delete {
		const { with: w, env: inner } = this.with(s.with, env)
		const t = this.written(s.table, s.alias, s.using, s.where, inner, name)
		return {
			...s,
			with: w,
			alias: t.alias,
			using: t.items,
			where: t.where,
			returning: this.renamer(t.env).targets(s.returning)
		}
	}

	/**
	 * A MERGE: its ON is the condition of the outer join of its target to its source, which decides each row's WHEN (a
	 * source row no target row matches takes WHEN NOT MATCHED, a target row no source row matches WHEN NOT MATCHED BY
	 * SOURCE), so it stays as it was written: no conjunct of it binds a read or moves, and the target is never read
	 * through an inner join with the source, which would drop every source row that matches no target row before its
	 * WHEN NOT MATCHED could insert it. Its target is read whole, first, and its source, the level's one other item,
	 * bound with no conjunct of the ON, is joined to it by a hash. The one MERGE grizzle sends, a data step's refill
	 * (physical/ddl/recheck.ts), has a WHEN NOT MATCHED BY SOURCE, which PostgreSQL plans as a FULL join, reading every
	 * row of the target whatever reads it, so that is its plan. A keyed MERGE of a stored table without one joins its target to its source alone,
	 * which an outer probe of it at the ON's key would read at the tuple id it finds; no MERGE needs that form, so none
	 * is bound: it is an internal compiler error, never a whole read where a probe stands.
	 */
	merge(s: Merge, env: Env, name: PlanName): Merge {
		const catalogTable = this.#catalog.table(nameKey(s.table))
		if (
			catalogTable !== undefined &&
			!this.#whole &&
			!s.whens.some((when) => when.match === "NOT MATCHED BY SOURCE")
		) {
			return defect(
				`a keyed MERGE of ${catalogTable.relation} without WHEN NOT MATCHED BY SOURCE, whose target an outer tid probe at its ON's key would read, a form no MERGE needs and none is bound in`
			)
		}
		const { with: w, env: inner } = this.with(s.with, env)
		const depth = inner.depth + 1
		const level: Env = { ...inner, depth }
		const [entry, ...others] = entriesOf([s.using])
		if (entry === undefined || others.length > 0) {
			return defect("a MERGE's one source, one item")
		}
		const sourceWritten = writtenOf(entry.source)
		const sourceAlias = this.#alias(sourceWritten)
		const source = this.entry(entry, 1, [], level, inner, sourceAlias, undefined)
		const alias = this.#alias(s.alias)
		const withTarget = withRelation(level, s.alias, alias, depth, 0)
		const here =
			sourceWritten === undefined
				? withTarget
				: withRelation(withTarget, sourceWritten, sourceAlias, depth, 1)
		this.#level(name, [
			{
				source: { kind: "read", table: s.table, alias, access: { kind: "whole" } },
				step: { join: "cross" },
				item: {
					alias,
					scan: catalogTable === undefined ? { kind: "rows" } : { kind: "seq" }
				},
				method: "nestedLoop",
				appended: []
			},
			{ ...source, method: "hash" }
		])
		const [using] = fromOf([source])
		if (using === undefined) {
			return defect("a MERGE's one source, bound as one item")
		}
		const rename = this.renamer(here)
		return {
			...s,
			with: w,
			alias,
			using,
			on: rename.expr(s.on),
			whens: mapWhens(s.whens, (when) => rename.mergeWhen(when)),
			returning: rename.targets(s.returning)
		}
	}

	/** A query bound as a statement's top level, its columns' needs read off it first. */
	selectOf(q: Select): Select {
		this.#needs = neededColumns(q)
		this.#whole = false
		return this.setQuery(q, topEnv, { kind: "top" })
	}

	/** A routine bound (`routine`), its columns' needs read off it first. */
	routineOf(fn: CreateFunction): CreateFunction {
		this.#needs = neededColumns(fn)
		this.#whole = false
		return this.routine(fn)
	}

	/** A DO block's body bound (bindBlock), its columns' needs read off it first; a whole one's reads joined by hash. */
	blockOf(b: PlBlock): PlBlock {
		this.#needs = neededBy((t) => t.plBlock(b))
		this.#whole = this.#reads.kind === "whole"
		return this.block(b)
	}

	/**
	 * A routine bound under the scope (sql/naming.ts AdviceScope `routine`): each statement PL/pgSQL hands the planner
	 * its own top level, a PL variable and a record's field a value it fixes; a SQL function's body one SELECT of it.
	 */
	routine(fn: CreateFunction): CreateFunction {
		if (fn.language === "sql") {
			return { ...fn, body: this.expr(fn.body, topEnv) }
		}
		return { ...fn, body: this.block(fn.body) }
	}

	block(b: PlBlock): PlBlock {
		const [first, ...rest] = b.body
		return { ...b, body: [this.pl(first), ...rest.map((s) => this.pl(s))] }
	}

	pl(s: PlStatement): PlStatement {
		const plain = (e: Expr) => this.expr(e, topEnv)
		switch (s.kind) {
			case "if": {
				const [b0, ...bs] = s.branches
				const branch = (b: typeof b0) => ({
					condition: plain(b.condition),
					body: b.body.map((x) => this.pl(x))
				})
				return {
					...s,
					branches: [branch(b0), ...bs.map(branch)],
					else: s.else.map((x) => this.pl(x))
				}
			}
			case "assign":
				return { ...s, value: plain(s.value) }
			case "forQuery":
				return {
					...s,
					query: this.setQuery(s.query, topEnv, { kind: "top" }),
					body: s.body.map((x) => this.pl(x))
				}
			case "perform": {
				const q = this.query(operandSelect(s.query.body), topEnv, { kind: "top" })
				const body = q.body
				return body.kind === "core"
					? { ...s, query: { ...s.query, body } }
					: defect("a PERFORM of one core bound one core")
			}
			case "whenFound": {
				const [b0, ...bs] = s.body
				return {
					...s,
					query: this.query(s.query, topEnv, { kind: "top" }),
					body: [this.pl(b0), ...bs.map((x) => this.pl(x))]
				}
			}
			case "wholeReads": {
				const whole = this.#whole
				this.#whole = true
				const [b0, ...bs] = s.body
				const body = [this.pl(b0), ...bs.map((x) => this.pl(x))] as const
				this.#whole = whole
				return { ...s, body }
			}
			case "case": {
				const [w0, ...ws] = s.whens
				const when = (w: typeof w0) => ({
					values: [plain(w.values[0]), ...w.values.slice(1).map(plain)] as const,
					body: w.body.map((x) => this.pl(x))
				})
				return { ...s, operand: plain(s.operand), whens: [when(w0), ...ws.map(when)] }
			}
			case "raise":
				return { ...s, using: s.using.map((o) => ({ ...o, value: plain(o.value) })) }
			case "return":
				return { ...s, value: plain(s.value) }
			case "modify": {
				const statement = s.statement
				switch (statement.kind) {
					case "insert":
						return { ...s, statement: this.insert(statement, topEnv, { kind: "top" }) }
					case "update":
						return { ...s, statement: this.update(statement, topEnv, { kind: "top" }) }
					case "delete":
						return { ...s, statement: this.delete(statement, topEnv, { kind: "top" }) }
					case "merge":
						return { ...s, statement: this.merge(statement, topEnv, { kind: "top" }) }
				}
			}
			case "returnQuery":
				return { ...s, query: this.query(s.query, topEnv, { kind: "top" }) }
			case "createSessionTable":
			case "createSessionIndex":
			case "createSessionTrigger":
			case "truncateSessionTable":
				return s
		}
	}
}

/** Whether a core is a set, as a UNION ALL's proof requires of each arm. */
const isSetBodyCore = (body: SelectCore) =>
	body.distinct !== false || body.rows !== "operand"
		? body
		: defect("a UNION ALL arm bound a set still, as its proof requires")

/** A MERGE's WHENs, each mapped. */
const mapWhens = <W>(whens: NonEmptyReadonlyArray<W>, f: (w: W) => W): NonEmptyReadonlyArray<W> => {
	const [w0, ...ws] = whens
	return [f(w0), ...ws.map(f)]
}

/**
 * A routine bound under a scope of its own (sql/naming.ts AdviceScope), with the plan of its statements and each query
 * PL/pgSQL hands the planner (`plannedOf`).
 */
export interface BoundRoutine {
	readonly fn: CreateFunction
	readonly plan: ReadPlan<AccessIndexRequest>
	readonly planned: ReadonlyArray<string>
}

/**
 * The routine `fn`, bound over `catalog` under a scope of its own, each statement PL/pgSQL hands the planner its own
 * top level (see the header), after its logical rewrites (sql/print-once.ts printedOnce).
 */
export const bindRoutine = (
	fn: CreateFunction,
	scope: AdviceScope,
	catalog: ReadCatalog
): BoundRoutine => {
	const binder = new Binder(scope, catalog, keyedReads)
	const once = printedOnce(fn)
	if (once.kind !== "createFunction") {
		return defect("a routine printed once a routine still")
	}
	const bound = binder.routineOf(once)
	return {
		fn: bound,
		plan: binder.plan(),
		planned: plannedOf(bound, catalog.fired(nameKey(fn.name)))
	}
}

/** A name PL/pgSQL reads in a query, as the planner gets it: a typed placeholder, each name one number. */
interface Placed {
	readonly number: number
	readonly type: TypeRef
}

/**
 * Each query PL/pgSQL hands the planner of the bound routine `fn`, in body order, printed by the one printer of its
 * statements (sql/print.ts), every PL/pgSQL name it reads a typed placeholder `$n::<type>`, numbered in the order the
 * query reads them, as PL/pgSQL passes each variable a parameter of its datum's type (pl_comp.c make_datum_param): a
 * declared variable or argument by its declared type, a field of NEW or OLD by its column's in `fired`, the table the
 * trigger fires on, TG_TABLE_NAME and TG_TABLE_SCHEMA a `name`, TG_OP a `text`. A PERFORM is the SELECT its keyword
 * replaces, a probe's `PERFORM 1 FROM (<query>) AS "found"` likewise (pl_exec.c exec_stmt_perform), a FOR's and a RETURN
 * QUERY's their query, a data-modifying statement itself, and every expression `SELECT <expr>` (exec_eval_expr), but
 * a RETURN of a name alone, which plans nothing (pl_gram.y make_return_stmt `retvarno`). An SQL function's body is
 * `SELECT <body>`, its arguments its own placeholders. A name of no declaration is an internal compiler error.
 */
const plannedOf = (
	fn: CreateFunction,
	fired: ReadonlyMap<string, TypeRef> | undefined
): ReadonlyArray<string> => {
	if (fn.language === "sql") {
		return [printPlannedQuery({ kind: "expr", expr: fn.body })]
	}
	const declared = new Map([...fn.params, ...fn.body.declare].map((d) => [d.name, d.type] as const))
	const out: Array<string> = []
	/** What `print` prints of what `placing` places, each name it reads a placeholder, numbered afresh: one query. */
	const placed = (print: (t: Transform) => string): void => {
		const numbers = new Map<string, Placed>()
		const at = (name: string, type: TypeRef): Expr => {
			const known = numbers.get(name) ?? { number: numbers.size + 1, type }
			numbers.set(name, known)
			return {
				kind: "param",
				slot: { placeholder: "value", number: known.number },
				type: known.type
			}
		}
		const name = (x: Expr): Expr | undefined => {
			if (x.kind === "plVar") {
				return at(
					x.name,
					declared.get(x.name) ?? defect(`the declaration of ${x.name} in ${fn.name.name}`)
				)
			}
			if (x.kind === "field") {
				return x.record.kind === "plSpecial"
					? at(
							`${x.record.name}.${x.field}`,
							fired?.get(x.field) ??
								defect(`the column ${x.field} of the table ${fn.name.name} fires on`)
						)
					: defect(`a field of the record ${x.record.name} in a query of ${fn.name.name}`)
			}
			if (x.kind !== "plSpecial") {
				return undefined
			}
			if (x.name === "TG_OP") {
				return at(x.name, types.text)
			}
			return x.name === "TG_TABLE_NAME" || x.name === "TG_TABLE_SCHEMA"
				? at(x.name, builtinType("name"))
				: defect(`the row ${x.name} whole in a query of ${fn.name.name}`)
		}
		const t = new (class extends Transform {
			override readonly expr = (x: Expr): Expr => name(x) ?? this.exprChildren(x)
		})(identityHooks)
		out.push(print(t))
	}
	const query = (q: OperandSelect) =>
		placed((t) => printPlannedQuery({ kind: "query", query: t.select(q) }))
	const expr = (e: Expr) => placed((t) => printPlannedQuery({ kind: "expr", expr: t.expr(e) }))
	const walk = (statements: ReadonlyArray<PlStatement>): void => {
		for (const s of statements) {
			switch (s.kind) {
				case "if":
					for (const b of s.branches) {
						expr(b.condition)
						walk(b.body)
					}
					walk(s.else)
					break
				case "assign":
					expr(s.value)
					break
				case "forQuery":
					query(s.query)
					walk(s.body)
					break
				case "perform": {
					const performed = s.query
					placed((t) => {
						const body = t.select(operandSelect(performed.body)).body
						return body.kind === "core"
							? printPlannedQuery({
									kind: "perform",
									query: {
										body,
										orderBy: t.orderItems(performed.orderBy),
										limit: performed.limit === undefined ? undefined : t.expr(performed.limit),
										offset: performed.offset === undefined ? undefined : t.expr(performed.offset)
									}
								})
							: defect("a PERFORM's one core placed one core")
					})
					break
				}
				case "whenFound": {
					const found = s.query
					placed((t) => printPlannedQuery({ kind: "found", query: t.select(found) }))
					walk(s.body)
					break
				}
				case "wholeReads":
					walk(s.body)
					break
				case "case":
					expr(s.operand)
					for (const w of s.whens) {
						for (const v of w.values) {
							expr(v)
						}
						walk(w.body)
					}
					break
				case "raise":
					for (const o of s.using) {
						expr(o.value)
					}
					break
				case "return":
					if (s.value.kind !== "plVar" && s.value.kind !== "plSpecial") {
						expr(s.value)
					}
					break
				case "modify": {
					const modified = s.statement
					placed((t) => printStatement(t.statement(modified)))
					break
				}
				case "returnQuery":
					query(s.query)
					break
				case "createSessionTable":
				case "createSessionIndex":
				case "createSessionTrigger":
				case "truncateSessionTable":
					break
			}
		}
	}
	walk(fn.body.body)
	return out
}

/** A query after its logical rewrites (sql/print-once.ts printedOnce), a query still. */
const selectOnce = (query: Select): Select => {
	const once = printedOnce(query)
	return once.kind === "select" ? once : defect("a query printed once a query still")
}

/**
 * A statement no advice holds (sql/emit.ts Emitting `costChosen`), as its logical rewrites leave it: every name its
 * builder wrote kept and none minted, so no name of it is one an advice scope mints, and its plan empty, PostgreSQL
 * choosing its plan by cost.
 */
const costChosenOf = <S extends SqlStatement>(once: S): BoundStatement<S> =>
	nominal<
		{ readonly statement: S; readonly plan: ReadPlan<AccessIndexRequest> },
		BoundStatement<S>
	>()({ statement: once, plan: { levels: [] } })

/** The statement `statement` no advice holds (`costChosenOf`), after its logical rewrites (sql/print-once.ts). */
export const costChosenStatement = (statement: SqlStatement): BoundStatement =>
	costChosenOf(printedOnce(statement))

/** The query `query` no advice holds (`costChosenOf`), after its logical rewrites, a query still. */
export const costChosenSelect = (query: Select): BoundStatement<Select> =>
	costChosenOf(selectOnce(query))

/**
 * The body of the `ordinal`-th world view of a role, its definition `definition`, bound under its view scope over
 * `catalog` (sql/naming.ts ViewScope): what its installation creates, its definition after its logical rewrites, which
 * a reader binds again (WorldBinding), and how many aliases the binding mints. A view's own DDL carries no advice: each
 * statement that reads it carries the plan of its body (Binder `#world`).
 */
export const bindView = (
	definition: Select,
	ordinal: number,
	catalog: ReadCatalog
): { readonly prepared: Select; readonly bound: Select; readonly minted: number } => {
	const prepared = selectOnce(definition)
	const scope = new ViewScope(ordinal)
	const bound = new Binder(scope, catalog, keyedReads).selectOf(prepared)
	return { prepared, bound, minted: scope.minted() }
}

/** The query `query`, bound as a statement is (`bindStatement`), a query still. */
export const bindSelect = (
	query: Select,
	scope: AdviceScope,
	catalog: ReadCatalog
): BoundStatement<Select> => {
	const once = selectOnce(query)
	const binder = new Binder(scope, catalog, keyedReads)
	const bound = binder.selectOf(once)
	return nominal<
		{ readonly statement: Select; readonly plan: ReadPlan<AccessIndexRequest> },
		BoundStatement<Select>
	>()({
		statement: bound,
		plan: binder.plan()
	})
}

/**
 * How a statement's reads are bound: `keyed`, each read of a second relation by the outer row that binds it, a probe,
 * every read one whose index request index planning plans (physical/indexes/engine.ts planIndexes): a workload's
 * statement and a routine's; or `whole`, each read whole or at the values it fixes and joined by a hash, as a statement
 * that runs once over every row reads them: a migration's data step, O(n + m) by a hash where n probes cost n descents.
 * A data step's requests are planned no index, so a read of it at the values it fixes is sought where an index `serves`
 * its request (engine.ts servingOf) and read whole beside its filter where none does.
 */
export type BoundReads =
	| { readonly kind: "keyed" }
	| { readonly kind: "whole"; readonly serves: (request: AccessIndexRequest) => boolean }

/** The reads of a keyed binding (BoundReads `keyed`). */
export const keyedReads: BoundReads = { kind: "keyed" }

/**
 * A DO block's body (sql/print.ts writeDoBlock), bound under `scope` over `catalog` as a routine's statements are, every
 * read by `reads`, after its logical rewrites (sql/print-once.ts printedBlock): a migration's violation check.
 */
export const bindBlock = (
	block: PlBlock,
	scope: AdviceScope,
	catalog: ReadCatalog,
	reads: BoundReads
): { readonly block: PlBlock; readonly plan: ReadPlan<AccessIndexRequest> } => {
	const binder = new Binder(scope, catalog, reads)
	const bound = binder.blockOf(printedBlock(block))
	return { block: bound, plan: binder.plan() }
}

/**
 * The statement `statement`, bound under `scope` over `catalog` (see the header), after its logical rewrites
 * (sql/print-once.ts printedOnce): the only form anything prints or plans from.
 */
export const bindStatement = (
	statement: SqlStatement,
	scope: AdviceScope,
	catalog: ReadCatalog,
	reads: BoundReads
): BoundStatement => {
	const binder = new Binder(scope, catalog, reads)
	const bound = binder.statement(printedOnce(statement))
	return nominal<
		{ readonly statement: SqlStatement; readonly plan: ReadPlan<AccessIndexRequest> },
		BoundStatement
	>()({ statement: bound, plan: binder.plan() })
}
