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
 *   literal, a PL variable, a column of an enclosing level, an `= ANY` of an array sublink that reads nothing of the
 *   level (an InitPlan, the keys a write holds among them, write/probe.ts amongHeld), and past them by the one range of
 *   the least column it orders against such a value (`<`, `<=`, `>=`, `>`), its request's key after the fixed ones, a
 *   field or a law column alike (BindColumn); each moved out of the level's WHERE or ON into the read, an inner join's
 *   ON conjunct that reads none of its own step a conjunct of the level (`innerHoisted`), and printed back as one of its
 *   level's conjuncts, where PostgreSQL makes it an index condition of its scan;
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
 * the table is derived once and joined by a hash where PostgreSQL keeps a clause to hash on, never derived again for
 * each row before it. Every sublink and every set operation's arm reads its relations through one item of its own, its
 * whole query a derived table fenced the same way, so no target names a level PostgreSQL names itself (`exists_N`,
 * `expr_N`, `array_N`, `any_N`, `setop_N`). Every alias is minted again from the advice scope (sql/naming.ts
 * AdviceScope). A statement that reads what it reads whole, once (a stored relation's fill, a data step's re-check),
 * joins its reads by hash, each read whole or at the values it fixes, never by a probe per row.
 *
 * The pass is total and exact: it changes no result, and every binding it moves into a read node is an equality that
 * was in a WHERE or an ON. A read it cannot classify is an internal compiler error.
 */
import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { nominal } from "#compiler/core/brand.ts"
import { compareStrings, type Direction } from "#compiler/core/order.ts"
import { defaultOpclass, type IndexOpclass } from "#compiler/ir/law.ts"
import type { AccessIndexRequest, AccessKeyTerm, AccessUse } from "#compiler/ir/products.ts"
import type { IndexColumn } from "#compiler/physical/ddl/context.ts"
import {
	type AccessTag,
	type BinaryOperator,
	builtinFunctions,
	closedSearchPath,
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
	readConditions,
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
	JoinedMember,
	JoinMember,
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
 * A column of a stored table an index can serve, by its installed name, `column` the field or the law column it is, a
 * request's key, by its arm (physical/ddl/context.ts IndexColumn), and its kind, which closes the operators a read of it
 * is classified by (`accessOf`):
 * - a B-tree's, with what it holds (`holds`): a scalar's, a text's (whose range on both sides is a prefix search), a
 *   network's (an inet or a cidr, whose containment GiST serves under inet_ops), a vector's (whose distance HNSW serves
 *   under the cosine class `cosine`, and whose own `=` pgvector's B-tree class keys); bound by `=`, `IN`, `= ANY` and,
 *   past the equalities, ranged by `<`, `<=`, `>=`, `>` and BETWEEN;
 * - a span's, which no B-tree keys: GiST under range_ops serves its Allen relations, its scalar prefix through
 *   btree_gist;
 * - a search document's, which no B-tree keys: GIN serves its match.
 * - a byte string's (`bytes`), which no B-tree entry holds: a read binding it alone asks for it as a scalar's, which a
 *   hash index on it serves, and a read binding several, each by equality, binds their row (BindTable `hashRow`).
 * A text of no byte bound is a text's like any other: a read binding one asks for it, and the index engine decides what
 * serves the request or refuses it (physical/indexes/engine.ts refusedUndigested), the one place of the rule of what no
 * entry holds.
 */
export type BindColumn =
	| {
			readonly kind: "scalar" | "text" | "network" | "bytes"
			readonly column: IndexColumn
			readonly holds: Holds
	  }
	| {
			readonly kind: "vector"
			readonly column: IndexColumn
			readonly holds: Holds
			readonly cosine: IndexOpclass
	  }
	| { readonly kind: "span" | "search"; readonly column: IndexColumn }

/** A column as a request's key names it (AccessKeyTerm): a field by its name, a law column by its identifier. */
const keyTermOf = (column: IndexColumn): AccessKeyTerm =>
	column.kind === "field" ? column.field : { law: column.column }

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
	readonly hashRow: HashRow
}

/**
 * How a read binds several byte strings of a table by equality, each a column no B-tree entry holds (BindColumn
 * `bytes`): through the hash index the installation makes of their row, cast to its own composite type, which `type`
 * names for the bound columns, in the table's column order (physical/indexes/engine.ts hashedRow), a stored derived
 * relation's table's (`typed`); none for any other table, whose read binding several is refused by the index engine.
 */
export type HashRow =
	| { readonly kind: "none" }
	| { readonly kind: "typed"; readonly type: (columns: NonEmptyReadonlyArray<string>) => TypeRef }

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
 * (`prepared`, sql/print-once.ts printedOnce), its top core as the binding reads it, each pass-through projection it
 * begins with folded (`readCore`), the body its installation creates and PostgreSQL plans, which its installation binds
 * (`bindView`) and a reader binds again with the reader's quals PostgreSQL pushes past its barrier pushed into that
 * core, as PostgreSQL pushes them; its place among its role's query entries, whose view scope its body's aliases come
 * from (sql/naming.ts ViewScope); how many that binding mints; its
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

/**
 * Whether a relation is one of PostgreSQL's system catalogs, of its schema pg_catalog (sql/ast.ts closedSearchPath's
 * first): a read of it is planned by PostgreSQL's costs over the catalog's real statistics (sql/plan.ts PlanScan
 * `catalog`).
 */
const systemCatalog = (name: ObjectName): boolean => name.schema === closedSearchPath[0]

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
 * index of the installation's serves it and only the session or the catalog knows the indexes it holds; a catalog's
 * relation its plan states no NO_GATHER of either (`systemCatalog`).
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

/** Whether an expression holds a VOLATILE call, at its level or in its sublinks: each evaluation of it may differ. */
const volatile = (e: Expr): boolean => {
	let found = false
	new (class extends Transform {
		override readonly expr = (x: Expr): Expr => {
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
 * The free qualifiers of an expression: those of its column references that name no item a sublink of it binds itself,
 * so an uncorrelated sublink, which PostgreSQL plans once as an InitPlan, has none, and a correlated one the items of
 * the levels it reads around it.
 */
const freeQualifiersOf = (e: Expr): ReadonlySet<string> => {
	const read = new Set<string>()
	const bound = new Set<string>()
	new (class extends Transform {
		override readonly expr = (x: Expr): Expr => {
			if (x.kind === "column" && x.table !== undefined) {
				read.add(x.table)
			}
			return this.exprChildren(x)
		}
		override source(s: FromSource): FromSource {
			if ("alias" in s && s.alias !== undefined) {
				bound.add(s.alias)
			}
			return super.source(s)
		}
	})(identityHooks).expr(e)
	return new Set([...read].filter((a) => !bound.has(a)))
}

/** Whether an expression holds a sublink, at its own level. */
const sublinked = (e: Expr): boolean => {
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
			return this.exprChildren(x)
		}
	})(identityHooks).expr(e)
	return found
}

/** Whether an expression holds a sublink or a VOLATILE call, which no binding or pushed conjunct carries. */
const opaque = (e: Expr): boolean => sublinked(e) || volatile(e)

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

/**
 * A conjunct as a binding of the read of `alias`: an equality of one of its columns, an IN list, or an `= ANY` of an
 * array, a sublink's ARRAY(...) among them, whose value its level fixes where the sublink reads nothing of the level
 * (`freeQualifiersOf`), so a seek reads the rows at the array's values; none for a conjunct holding any other sublink or a
 * VOLATILE call (`opaque`).
 */
const bindingOf = (c: Expr, alias: string): Binding | undefined => {
	if (c.kind === "equalsAny") {
		const ref = columnOf(c.expr)
		return ref?.table === alias &&
			!opaque(c.expr) &&
			(c.array.kind === "array" || !opaque(c.array)) &&
			!freeQualifiersOf(c.array).has(alias)
			? { conjunct: c, column: ref.column, value: c.array, schema: c.schema, op: "in" }
			: undefined
	}
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
			: { expr: keyTermOf(column.column), dir: "asc" as const, opclass: defaultOpclass }
	}),
	method: "btree",
	fixed: bound.length,
	role: "access",
	use
})

/**
 * How a read a driving row reaches meets the rows at its bound columns (sql/ast.ts ProbeBy, `#driven`): at a key, at
 * most one row (`key`); every row there in no order (`rows`); or every row there, or only the last, in an order of its
 * columns past the bound ones (`ordered`), which the index it reads through must hold after them.
 */
type DrivenReach =
	| { readonly kind: "key" }
	| { readonly kind: "rows" }
	| { readonly kind: "ordered"; readonly order: NonEmptyReadonlyArray<string> }

/**
 * The index a driven read at `bound` of `table` asks for (`#driven`): a key's lookup; a lookup of its rows, every
 * bound column fixed by equality in any order; or an ordered seek, its bound columns fixed and then its order's, an
 * index holding that order after them, each of which a B-tree of the table must hold: a read in an order no index holds
 * sorts every row of its group for each driving row, so an order column the catalog holds no B-tree column of is an
 * internal compiler error, as a missed index is.
 */
const drivenRequest = (
	table: BindTable,
	bound: NonEmptyReadonlyArray<string>,
	reach: DrivenReach
): AccessIndexRequest => {
	switch (reach.kind) {
		case "key":
			return requestOf(table, bound, [], "key lookup")
		case "rows":
			return requestOf(table, bound, [], "join key")
		case "ordered":
			return requestOf(
				table,
				bound,
				reach.order
					.filter((c) => !bound.includes(c))
					.map((c) =>
						btreeColumn(table, c) === undefined
							? defect(
									`an ordered read of ${table.relation} in an order of ${c}, which no B-tree column of its table holds`
								)
							: c
					),
				"take seek"
			)
	}
}

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
			readonly kind: "row"
			readonly eq: NonEmptyReadonlyArray<Binding>
			readonly columns: NonEmptyReadonlyArray<string>
			readonly type: TypeRef
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
		if (column === undefined) {
			return defect(`a key column of ${table.relation} an index serves; ${k.column} is none`)
		}
		const key = column.column
		return {
			expr:
				k.term === "column"
					? keyTermOf(key)
					: key.kind === "field"
						? { suffix: key.field }
						: defect(
								`a suffix key of the law column ${key.column} of ${table.relation}, which no text read ranges`
							),
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
		case "row":
			return requestOf(table, access.columns, [], "row equality")
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
				"range predicate"
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

/**
 * A level's entries with every conjunct of an inner join's ON that reads none of its own step's columns (`writtenOf`,
 * by its free qualifiers) moved into the level's WHERE, `where`, as PostgreSQL distributes an inner join's quals to the
 * lowest level that reads them, so the read of an earlier entry an `= ANY` of a held array restricts binds it there; a
 * step left with no conjunct of its own is a cross join. A LEFT join's ON, and a step whose source names no alias, keep
 * theirs.
 */
const innerHoisted = (entries: ReadonlyArray<Entry>, where: Array<Expr>): ReadonlyArray<Entry> =>
	entries.map((entry): Entry => {
		if (entry.join !== "on") {
			return entry
		}
		const own = writtenOf(entry.source)
		if (own === undefined) {
			return entry
		}
		const conjuncts = conjunctsOf(entry.on)
		const kept = conjuncts.filter((c) => freeQualifiersOf(c).has(own))
		if (kept.length === conjuncts.length) {
			return entry
		}
		for (const c of conjuncts) {
			if (!freeQualifiersOf(c).has(own)) {
				where.push(c)
			}
		}
		const on = conjunction(kept)
		return on === undefined
			? { join: "cross", source: entry.source }
			: { join: "on", source: entry.source, on }
	})

/** How a bound entry joins the entries before it, in the join chain of its level: crosswise, or on its ON. */
type Step = { readonly join: "cross" } | { readonly join: "on" | "left"; readonly on: Expr }

/**
 * How a bound entry joins what its level joins before it: by a nested loop, read again per row before it (a probe, a
 * LATERAL item, a function's or arrays' rows, a write's target at tuple ids); by a hash, hashed whole (a MERGE's source,
 * on the ON its outer join keeps); or as a set join (`set`), whose method its level decides once every entry of it is
 * bound (`levelJoins`), from the join clauses PostgreSQL keeps of the level's printed conditions.
 */
type Joining = JoinMethod | "set"

/** A bound entry: its source, its step, and its plan item and how it joins what its level joins before it. */
interface BoundEntry {
	readonly source: FromSource
	readonly step: Step
	readonly item: PlanItem<AccessIndexRequest>
	readonly method: Joining
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

/**
 * A level's equivalence classes, as PostgreSQL makes them of the equalities its level states (equivclass.c
 * process_equivalence): each `=` of two sides, neither holding a VOLATILE call, unites them; a side is a column of an
 * item of the level, by its alias and name, or a member of its own where it reads an item of the level otherwise, or a
 * value the level fixes where it reads none (a parameter, a literal, a PL variable, an enclosing level's column, which
 * PostgreSQL plans as a parameter of the level), one member by its text however many sides state it. `reads` holds each
 * member's items, `fixed` the roots of the classes holding a fixed value (ec_has_const).
 */
interface LevelClasses {
	readonly root: (member: string) => string
	readonly reads: ReadonlyMap<string, ReadonlySet<string>>
	readonly fixed: ReadonlySet<string>
}

const levelClasses = (
	equalities: ReadonlyArray<Expr>,
	items: ReadonlySet<string>
): LevelClasses => {
	const parent = new Map<string, string>()
	const reads = new Map<string, ReadonlySet<string>>()
	const root = (member: string): string => {
		const up = parent.get(member)
		if (up === undefined) {
			return member
		}
		const top = root(up)
		parent.set(member, top)
		return top
	}
	/** The members holding a value the level fixes, each by its text. */
	const values = new Set<string>()
	/** A side's member: a column of an item by its alias and name, any other side reading an item one of its own, and a
	 * value the level fixes one member by its text, of every side that states it (equivclass.c process_equivalence
	 * finds an equal() member of a class, so two columns equal to one parameter share a class). */
	const member = (side: Expr, own: string): string => {
		const read = new Set([...qualifiersOf(side)].filter((a) => items.has(a)))
		if (read.size === 0) {
			const key = `= ${exprText(side)}`
			values.add(key)
			return key
		}
		const column = columnOf(side)
		const key = column === undefined ? own : `${column.table}.${column.column}`
		reads.set(key, read)
		return key
	}
	for (const [at, c] of equalities.entries()) {
		if (c.kind !== "binary" || c.op !== "=" || volatile(c)) {
			continue
		}
		const [l, r] = [root(member(c.left, `${at}<`)), root(member(c.right, `${at}>`))]
		if (l !== r) {
			parent.set(l, r)
		}
	}
	const fixed = new Set([...values].map(root))
	return { root, reads, fixed }
}

/** Whether every item a member reads is among `among`, and it reads one at least. */
const readsWithin = (read: ReadonlySet<string> | undefined, among: ReadonlySet<string>): boolean =>
	read !== undefined && read.size > 0 && [...read].every((a) => among.has(a))

/**
 * Whether PostgreSQL keeps a join clause pairing `inner`'s items with `outer`'s, one a hash join is keyed by: two members
 * of one class of no fixed value, one reading `outer`'s items alone and one `inner`'s (equivclass.c
 * generate_join_implied_equalities, which draws no clause from a class holding a fixed value, stating each member's
 * equality with the value instead, generate_base_implied_equalities_const); or an equality of an outer join's ON
 * (`kept`) of those two sides, which PostgreSQL keeps as the join's clause whatever its classes (equivclass.c
 * reconsider_outer_join_clauses).
 */
const keysJoin = (
	classes: LevelClasses,
	kept: ReadonlyArray<Expr>,
	inner: ReadonlySet<string>,
	outer: ReadonlySet<string>
): boolean => {
	const sides = new Map<string, { inner: boolean; outer: boolean }>()
	for (const [m, read] of classes.reads) {
		const r = classes.root(m)
		if (classes.fixed.has(r)) {
			continue
		}
		const side = sides.getOrInsertComputed(r, () => ({ inner: false, outer: false }))
		side.inner ||= readsWithin(read, inner)
		side.outer ||= readsWithin(read, outer)
	}
	const read = (e: Expr) =>
		new Set([...qualifiersOf(e)].filter((a) => inner.has(a) || outer.has(a)))
	return (
		[...sides.values()].some((s) => s.inner && s.outer) ||
		kept.some(
			(c) =>
				c.kind === "binary" &&
				c.op === "=" &&
				!volatile(c) &&
				((readsWithin(read(c.left), inner) && readsWithin(read(c.right), outer)) ||
					(readsWithin(read(c.left), outer) && readsWithin(read(c.right), inner)))
		)
	)
}

/**
 * PostgreSQL's join_collapse_limit, its default: the most members of a level's explicit joins it folds into one join
 * problem (initsplan.c deconstruct_recurse). A level's FROM is one chain of explicit joins, its first item then each
 * joined one in order (`fromOf`), and each NOT EXISTS PostgreSQL makes an anti join wraps it whole: so its problem
 * gathers the chain's members in order until it holds this many, and the next member then joins that problem as one
 * member of a problem of its own, nested, as far as the chain goes (`levelJoins`). The planner settings stay
 * PostgreSQL's own: grizzle sets none, its join orders following the default.
 */
const joinCollapseLimit = 8

/** The least of `places`, a unit's first in the FROM's order. */
const leastPlace = (places: Iterable<number>): number => {
	let least = Number.POSITIVE_INFINITY
	for (const p of places) {
		least = Math.min(least, p)
	}
	return least
}

/** The item of an anti join PostgreSQL makes of a NOT EXISTS conjunct of a level (`#anti`), with its method. */
interface AntiJoin {
	readonly item: PlanItem<AccessIndexRequest>
	readonly join: JoinMethod
}

/** What a level's join tree orders (`levelJoins`): the entries of the level at `places`, joined as `member`. */
interface JoinUnit {
	readonly places: ReadonlySet<number>
	readonly member: JoinMember<AccessIndexRequest>
}

/**
 * A level's join problem as the tree PostgreSQL's join search builds (joinrels.c join_search_one_level), over its bound
 * entries and then the items of its anti joins (`antis`), and each join's method. Its clauses are the level's printed
 * conditions (sql/print.ts levelWhere, stepCondition): its WHERE `where`, every bound read's conditions and every inner
 * join's ON, one conjunction PostgreSQL makes its equivalence classes of (`levelClasses`), and each LEFT JOIN's ON,
 * its entry's alone.
 *
 * Two entries are linked where PostgreSQL considers joining them: a clause reads both, a class holds a member of each
 * (have_relevant_eclass_joinclause, a class holding a fixed value among them), one reads the other laterally
 * (have_join_order_restriction), or the later is a LEFT JOIN, whose ON joins it to every entry before it. A join of a
 * set of entries to an entry linked to none of them is a clauseless join, which PostgreSQL builds only where the set is
 * linked to nothing at all; so the tree is built from the first entry in the order of the FROM, each step joining the
 * first entry not yet joined that is linked to those joined and whose lateral reads they hold, left-deep. Where none
 * is, the first entry linked to those joined reads laterally an entry not yet joined, which nothing joined is linked
 * to: it is joined in a group, the entries it reads that are not yet joined, as far as their own reads go, and itself,
 * a tree of its own built the same way beneath what is joined, which PostgreSQL builds as the join's inner side, its
 * lateral reads its parameters. Entries linked to none of the rest are a component of their own, each built so and
 * joined to the ones before it as a cross product, which PostgreSQL builds only where those are linked to nothing
 * outside them: the components linked to no entry past their problem join first, in the FROM's order (`problem`).
 * The anti joins join last, by their methods.
 *
 * A join's method: a member's own where it states one (a probe's nested loop), or of a group reading the joined
 * entries laterally a nested loop; else a set join's, a hash where PostgreSQL keeps a join clause pairing the member's
 * entries with the joined ones (`keysJoin`), else a nested loop.
 *
 * Past join_collapse_limit the chain's first members are a problem of their own, which joins the next problem as its
 * first member (`joinCollapseLimit`); a problem's tree is built of its members alone.
 */
const levelJoins = (
	bound: NonEmptyReadonlyArray<BoundEntry>,
	where: Expr | undefined,
	antis: ReadonlyArray<AntiJoin>
): JoinMember<AccessIndexRequest> => {
	const aliases = bound.map((b) => writtenOf(b.source))
	const placeOf = new Map(
		aliases.flatMap((a, at): ReadonlyArray<readonly [string, number]> =>
			a === undefined ? [] : [[a, at]]
		)
	)
	const items = new Set(placeOf.keys())
	const placesOf = (read: Iterable<string>): ReadonlySet<number> =>
		new Set(
			[...read].flatMap((a) => {
				const p = placeOf.get(a)
				return p === undefined ? [] : [p]
			})
		)
	const aliasesAt = (places: Iterable<number>): ReadonlySet<string> =>
		new Set(
			[...places].flatMap((p) => {
				const a = aliases[p]
				return a === undefined ? [] : [a]
			})
		)
	const ownConditions = (b: BoundEntry): ReadonlyArray<Expr> => [
		...readConditions(b.source),
		...(b.step.join === "cross" ? [] : conjunctsOf(b.step.on))
	]
	const innerClauses = [
		...conjunctsOf(where),
		...bound.flatMap((b) => (b.step.join === "left" ? [] : ownConditions(b)))
	]
	const classes = levelClasses(innerClauses, items)
	/** Each entry's lateral reads: the entries before it it reads in its source. */
	const reads: ReadonlyArray<ReadonlySet<number>> = bound.map((b, at) => {
		const read = placesOf([
			...neededBy((t) => t.source(b.source)).keys(),
			...(b.source.kind === "met" ? [b.source.rows] : [])
		])
		return new Set([...read].filter((p) => p < at))
	})
	const linked: ReadonlyArray<Set<number>> = bound.map(() => new Set<number>())
	const link = (places: Iterable<number>): void => {
		const all = [...places]
		for (const a of all) {
			for (const b of all) {
				if (a !== b) {
					linked[a]?.add(b)
				}
			}
		}
	}
	for (const c of [
		...innerClauses,
		...bound.flatMap((b) => (b.step.join === "left" ? ownConditions(b) : []))
	]) {
		link(placesOf(qualifiersOf(c)))
	}
	const classReads = new Map<string, Set<string>>()
	for (const [m, read] of classes.reads) {
		const into = classReads.getOrInsertComputed(classes.root(m), () => new Set<string>())
		for (const a of read) {
			into.add(a)
		}
	}
	for (const read of classReads.values()) {
		link(placesOf(read))
	}
	bound.forEach((b, at) => {
		for (const p of reads[at] ?? []) {
			link([p, at])
		}
		if (b.step.join === "left") {
			for (let p = 0; p < at; p++) {
				link([p, at])
			}
		}
	})
	const linkedTo = (unit: JoinUnit, to: ReadonlySet<number>): boolean =>
		[...unit.places].some((p) => [...(linked[p] ?? [])].some((q) => to.has(q)))
	/** A unit's lateral reads outside it. */
	const readsOf = (unit: JoinUnit): ReadonlySet<number> =>
		new Set(
			[...unit.places].flatMap((p) => [...(reads[p] ?? [])]).filter((p) => !unit.places.has(p))
		)
	/** The aliases of entries at `places` and of the anti joins `after`, in the order of their range-table entries: the
	 * FROM's, then each anti join's PostgreSQL pulls up into the level (prepjointree.c pull_up_sublinks), then each
	 * whole view's table it pulls up after (pull_up_subqueries), an entry whose item is not the relation it reads. */
	const rangeOrder = (
		places: ReadonlySet<number>,
		after: ReadonlyArray<AntiJoin>
	): NonEmptyReadonlyArray<Alias> => {
		const entries = [...places]
			.toSorted((a, b) => a - b)
			.flatMap((p) => {
				const b = bound[p]
				return b === undefined ? [] : [b]
			})
		const own = (b: BoundEntry) => b.item.alias === writtenOf(b.source)
		const [a0, ...as] = [
			...entries.filter(own).map((b) => b.item.alias),
			...after.map((a) => a.item.alias),
			...entries.filter((b) => !own(b)).map((b) => b.item.alias)
		]
		return a0 === undefined ? defect("a join of an item at least") : [a0, ...as]
	}
	const method = (unit: JoinUnit, before: ReadonlySet<number>): JoinMethod => {
		const [only, ...others] = unit.places
		const entry = only === undefined || others.length > 0 ? undefined : bound[only]
		if (entry !== undefined && entry.method !== "set") {
			return entry.method
		}
		if (entry === undefined && [...readsOf(unit)].some((p) => before.has(p))) {
			return "nestedLoop"
		}
		return keysJoin(
			classes,
			entry?.step.join === "left" ? ownConditions(entry) : [],
			aliasesAt(unit.places),
			aliasesAt(before)
		)
			? "hash"
			: "nestedLoop"
	}
	/** The group `reaching` joins in (see the header): the units of `left` it reads, as far as their reads go, and itself,
	 * in the FROM's order. */
	const groupOf = (
		reaching: JoinUnit,
		left: ReadonlyArray<JoinUnit>
	): NonEmptyReadonlyArray<JoinUnit> => {
		const group = new Set([reaching])
		for (let grew = true; grew;) {
			grew = false
			for (const u of left) {
				if (!group.has(u) && [...group].some((g) => [...readsOf(g)].some((p) => u.places.has(p)))) {
					group.add(u)
					grew = true
				}
			}
		}
		const [g0, ...gs] = left.filter((u) => group.has(u))
		return g0 === undefined ? defect("a group of the unit that reaches it") : [g0, ...gs]
	}
	/** A join's spine: the entries it joins, its first unit and the members joined after it, by their methods. */
	interface Spine {
		readonly places: ReadonlySet<number>
		readonly first: JoinUnit
		readonly joined: ReadonlyArray<JoinedMember<AccessIndexRequest>>
	}
	/** A spine as one unit, the anti joins `after` joined last: a tree, or its first unit's member where it joins none. */
	const unitOf = (spine: Spine, after: ReadonlyArray<AntiJoin>): JoinUnit => {
		const all = [
			...spine.joined,
			...after.map((a): JoinedMember<AccessIndexRequest> => ({
				member: { kind: "item", item: a.item },
				join: a.join
			}))
		]
		return {
			places: spine.places,
			member: isNonEmpty(all)
				? {
						kind: "tree",
						tree: { first: spine.first.member, joined: all },
						range: rangeOrder(spine.places, after)
					}
				: spine.first.member
		}
	}
	/** The spine of `units`, in the FROM's order, beneath the entries `outer` holds (see the header). */
	const spineOf = (units: NonEmptyReadonlyArray<JoinUnit>, outer: ReadonlySet<number>): Spine => {
		const [first, ...rest] = units
		const joinedPlaces = new Set(first.places)
		const joined: Array<JoinedMember<AccessIndexRequest>> = []
		let left = rest
		while (isNonEmpty(left)) {
			const held = (u: JoinUnit) =>
				[...readsOf(u)].every((p) => joinedPlaces.has(p) || outer.has(p))
			const reaching = left.find((u) => linkedTo(u, joinedPlaces))
			const next =
				left.find((u) => held(u) && linkedTo(u, joinedPlaces)) ??
				(reaching === undefined
					? undefined
					: unitOf(spineOf(groupOf(reaching, left), new Set([...outer, ...joinedPlaces])), [])) ??
				left.find(held) ??
				defect("an entry whose lateral reads its level's joined entries hold")
			joined.push({ member: next.member, join: method(next, joinedPlaces) })
			for (const p of next.places) {
				joinedPlaces.add(p)
			}
			left = left.filter((u) => ![...u.places].some((p) => next.places.has(p)))
		}
		return { places: joinedPlaces, first, joined }
	}
	type Link =
		| { readonly kind: "unit"; readonly unit: JoinUnit }
		| { readonly kind: "anti"; readonly anti: AntiJoin }
	const chain: ReadonlyArray<Link> = [
		...bound.map((b, at): Link => ({
			kind: "unit",
			unit: { places: new Set([at]), member: { kind: "item", item: b.item } }
		})),
		...antis.map((anti): Link => ({ kind: "anti", anti }))
	]
	/**
	 * A join problem of `members` (see the header): its units' components, the units linked among themselves apart from
	 * the rest, each a spine of its own; joined left-deep, those linked to no entry past the problem first, in the
	 * FROM's order, so each cross product among them joins a set of entries linked to nothing outside it, which
	 * PostgreSQL makes a clauseless join of (joinrels.c join_search_one_level: an entry linked past its problem holds
	 * that link's clause in the problem, joining nothing by it there); then those linked to one, the largest first, each
	 * joined where no other set of its size is linked within the problem, by PostgreSQL's last-ditch clauseless join of
	 * every set of the size below to every entry (join_search_one_level's "last-ditch effort"); then the anti joins.
	 */
	const problem = (members: ReadonlyArray<Link>): JoinUnit => {
		const units = members.flatMap((m) => (m.kind === "unit" ? [m.unit] : []))
		const inside = new Set(units.flatMap((u) => [...u.places]))
		let components: ReadonlyArray<ReadonlyArray<JoinUnit>> = []
		for (const u of units) {
			const reached = components.filter((c) => c.some((v) => linkedTo(u, v.places)))
			components = [
				...components.filter((c) => !reached.includes(c)),
				[...reached.flat(), u].toSorted((a, b) => leastPlace(a.places) - leastPlace(b.places))
			]
		}
		const past = (c: ReadonlyArray<JoinUnit>) =>
			c.some((u) => [...u.places].some((p) => [...(linked[p] ?? [])].some((q) => !inside.has(q))))
		const placesIn = (c: ReadonlyArray<JoinUnit>) => c.flatMap((u) => [...u.places])
		const byPlace = (a: ReadonlyArray<JoinUnit>, b: ReadonlyArray<JoinUnit>) =>
			leastPlace(placesIn(a)) - leastPlace(placesIn(b))
		const bySize = (a: ReadonlyArray<JoinUnit>, b: ReadonlyArray<JoinUnit>) =>
			placesIn(b).length - placesIn(a).length || byPlace(a, b)
		const [c0, ...cs] = [
			...components.filter((c) => !past(c)).toSorted(byPlace),
			...components.filter(past).toSorted(bySize)
		].flatMap((c) => {
			const [u0, ...us] = c
			return u0 === undefined ? [] : [spineOf([u0, ...us], new Set())]
		})
		if (c0 === undefined) {
			return defect("a join problem of an entry at least")
		}
		const spine = cs.reduce(
			(joinedSoFar: Spine, next: Spine): Spine => ({
				places: new Set([...joinedSoFar.places, ...next.places]),
				first: joinedSoFar.first,
				joined: [
					...joinedSoFar.joined,
					{ member: next.first.member, join: method(next.first, joinedSoFar.places) },
					...next.joined
				]
			}),
			c0
		)
		return unitOf(
			spine,
			members.flatMap((m) => (m.kind === "anti" ? [m.anti] : []))
		)
	}
	let built = problem(chain.slice(0, joinCollapseLimit))
	for (let at = joinCollapseLimit; at < chain.length; at += joinCollapseLimit - 1) {
		built = problem([{ kind: "unit", unit: built }, ...chain.slice(at, at + joinCollapseLimit - 1)])
	}
	return built.member
}

/** A query's ORDER BY, LIMIT and OFFSET, which read its body's FROM. */
type Tail = Pick<OperandSelect, "orderBy" | "limit" | "offset">

/**
 * The core `b` as the binding reads it under its query's ORDER BY `orderBy` (Binder `body`): as written where the ORDER BY
 * reads the core's own FROM by name, which a fold would take away; else each pass-through projection it begins with
 * folded into the core it reads (sql/print.ts foldedCore), as its printer prints it and PostgreSQL plans it.
 */
const readCore = (b: SelectCore, orderBy: ReadonlyArray<OrderItem>): SelectCore =>
	orderBy.length > 0 ? b : foldedCore(b, true)

/** Whether an expression is the literal 0, an OFFSET that skips no row. */
const zeroOffset = (e: Expr | undefined): boolean =>
	e === undefined || (e.kind === "literal" && e.value.kind === "int" && e.value.value === 0n)

/** Whether a LIMIT is the literal 1, a take of one row. */
const oneRowLimit = (e: Expr): boolean =>
	e.kind === "literal" && e.value.kind === "int" && e.value.value === 1n

/**
 * A take's core (a LIMIT that states its level's B-tree order, sql/ast.ts AccessTag `ordered`) with no fence between
 * its ORDER BY and the stored read it orders, and its ORDER BY read through the
 * fold: each projection it begins with folded into the core it reads, the projection's OFFSET 0 fence with it, where
 * the take's core reads that one derived table alone, under no GROUP BY, HAVING or DISTINCT, and the derived table's
 * query is one core of no WITH, ORDER BY, LIMIT, DISTINCT, GROUP BY or HAVING, and an OFFSET of 0 or none, each of its
 * targets a column or a literal: a column of its own FROM, or a value an enclosing level fixes; under a take of one row
 * (`one`, a LIMIT of 1), a projection's plain DISTINCT folds with it, since the first row of any order is a distinct one
 * (Unmoved's upkeep: its witness, a take of one over the DISTINCT of the session's unmoved items, read every shown item
 * of the session for the first, 22 rows where 6 bound it). The core's WHERE, read
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
	orderBy: ReadonlyArray<OrderItem>,
	one: boolean
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
		(body.distinct !== false && !(one && body.distinct === true)) ||
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
	const conditions = conjunction([
		...(body.where === undefined ? [] : [body.where]),
		...(where === undefined ? [] : [where])
	])
	const folded: SelectCore = body.distinct
		? { ...body, distinct: false, rows: "oneRow", targets, where: conditions }
		: { ...body, targets, where: conditions }
	return takenThrough(folded, ordered, one) ?? { core: folded, orderBy: ordered }
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
 * every arm one item (`armed`), each a member of the relation at the reader's level; or such a query in parentheses
 * of none of them, `((… UNION ALL …))`, which PostgreSQL's parser reads as the UNION ALL itself (gram.y
 * select_with_parens), so its members stand at the reader's level too, never at a level of the derived table's own.
 */
const pulledUnion = (q: OperandSelect): boolean =>
	q.with === undefined &&
	q.orderBy.length === 0 &&
	q.limit === undefined &&
	q.offset === undefined &&
	(q.body.kind === "select"
		? pulledUnion(q.body)
		: q.body.kind === "setOp" && q.body.op === "UNION ALL")

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
 * Whether an OFFSET is a fence alone, `OFFSET 0`, which skips no row: PostgreSQL pushes no qual past it, and the binding
 * moves one into the query beneath it as it moves one into a query of none (`pushedInto`), the rows the same.
 */
const fenceOnly = (offset: Expr): boolean =>
	offset.kind === "literal" && offset.value.kind === "int" && offset.value.value === 0n

/**
 * Whether a derived table's query takes a conjunct of its reader pushed into it (allpaths.c subquery_push_qual's
 * conditions, as grizzle's queries meet them), and the query with it pushed (`pushedThrough`): the conjunct holds no
 * sublink and no VOLATILE call, and reads `alias`, each column it reads of `alias` at that column's place among the
 * query's outputs.
 */
const pushedInto = (
	q: OperandSelect,
	alias: string,
	c: Expr,
	past: "fences" | "nothing"
): OperandSelect | undefined => {
	if (opaque(c) || !qualifiersOf(c).has(alias)) {
		return undefined
	}
	const names = selectColumns(q)
	return pushedThrough(q, alias, c, (column) => names.indexOf(column), past)
}

/**
 * A query with a conjunct of its reader pushed into its body (`pushedBody`), each column of `alias` it reads its output
 * at the place `at` gives: a query of no WITH, LIMIT or OFFSET, but for a fence (`fenceOnly`) where the binding moves
 * the conjunct itself (`past` "fences"), which PostgreSQL pushes no qual past, never where it states what PostgreSQL
 * pushes (a world view's barrier, `#world`).
 */
const pushedThrough = (
	q: OperandSelect,
	alias: string,
	c: Expr,
	at: (column: string) => number,
	past: "fences" | "nothing"
): OperandSelect | undefined => {
	if (
		q.with !== undefined ||
		(q.offset !== undefined && (past === "nothing" || !fenceOnly(q.offset))) ||
		q.limit !== undefined
	) {
		return undefined
	}
	const body = pushedBody(q.body, alias, c, at, past)
	return body === undefined ? undefined : { ...q, body }
}

/**
 * A query body with a conjunct of its reader pushed into it, each column of `alias` it reads the body's output at the
 * place `at` gives: a core's WHERE takes it (`pushedCore`); a set operation's every arm does, as PostgreSQL pushes a
 * qual into each leaf of a set operation (allpaths.c recurse_push_qual), the arm's output at that place standing for the
 * column, through every set operation an arm's query holds, however deep, and through each arm's fence, so the stored
 * read of every arm is bound where it stands; a nested query's body does. A conjunct one arm cannot take stays its
 * reader's, pushed into no arm, since its reader's filter must hold the rows of every arm alike.
 */
const pushedBody = (
	b: OperandBody,
	alias: string,
	c: Expr,
	at: (column: string) => number,
	past: "fences" | "nothing"
): OperandBody | undefined => {
	switch (b.kind) {
		case "core":
			return pushedCore(b, alias, c, at)
		case "select":
			return pushedThrough(b, alias, c, at, past)
		case "setOp": {
			const operand = (o: SetOperand): SetOperand | undefined =>
				o.kind === "core" ? pushedCore(o, alias, c, at) : pushedThrough(o, alias, c, at, past)
			const [a0, a1, ...as] = b.arms
			const one = operand(a0)
			const two = operand(a1)
			const rest = as.map(operand)
			if (one === undefined || two === undefined || !isDefinedEach(rest)) {
				return undefined
			}
			if (b.op !== "UNION ALL" || b.rows === "oneRow" || b.rows === "operand") {
				return { ...b, arms: [one, two, ...rest] }
			}
			const set = (arm: SetOperand) =>
				arm.kind === "core"
					? isSetBodyCore(arm)
					: isSetQuery(arm)
						? arm
						: defect("a UNION ALL arm a pushed conjunct keeps a set, as its proof requires")
			return { ...b, arms: [set(one), set(two), ...rest.map(set)] }
		}
	}
}

/** Whether every element of `xs` is defined, read back as the array of them. */
const isDefinedEach = <A>(xs: ReadonlyArray<A | undefined>): xs is ReadonlyArray<A> =>
	xs.every((x) => x !== undefined)

/**
 * A core with a conjunct of its reader pushed into its WHERE, each column of `alias` it reads the core's target at the
 * place `at` gives: each such target reading no aggregate, window, set-returning or VOLATILE call, in a grouped core one
 * it groups by, under DISTINCT ON one it distinguishes, and in a core that calls a window function one every window
 * partitions by, a conjunct of which keeps each partition whole (check_output_expressions,
 * targetIsInAllPartitionLists): an attachment's take ranked per partition of its input, read at the partition its
 * parent row binds, reads that partition's rows alone. The pushed conjunct reads each column's target in its place, a
 * WHERE conjunct of the core.
 */
const pushedCore = (
	body: SelectCore,
	alias: string,
	c: Expr,
	at: (column: string) => number
): SelectCore | undefined => {
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
		const t = body.targets[at(column)]
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
		...body,
		where: conjunction(distinctConjuncts([...conjunctsOf(body.where), substituted]))
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
	/** Whether a statement of the binding read what it read whole, once (`#whole`), a PL/pgSQL block of whole reads. */
	#readWhole = false
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
	 * Whether a read at the values it fixes reaches its rows through the index `request` asks: a keyed binding's, every
	 * request of it one index planning lands (physical/indexes/engine.ts planIndexes), but where the statement reads what
	 * it reads whole, once (`#whole`), a stored table's fill or a data step's re-check (physical/ddl/recheck.ts), for
	 * which no index stands alone: that read asks none, and its routine is bound again once the installation's indexes
	 * stand (physical/install/compile.ts), its read sought where one of them serves it; a whole binding's where an index
	 * serves it (BoundReads `whole`).
	 */
	#serves(request: AccessIndexRequest): boolean {
		return this.#reads.kind === "keyed" ? !this.#whole : this.#reads.serves(request)
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

	/** Whether a statement of the binding read what it read whole, once, in a block of whole reads (`#readWhole`). */
	readWhole(): boolean {
		return this.#readWhole
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
		/**
		 * An EXISTS no anti join of its level reads (`#anti`), read through one item of the scope's wherever PostgreSQL
		 * would make it a join (`#joinedBy`), which it then plans as a subplan: a semi join's plan, whose unique form
		 * PostgreSQL weighs by cost, is no plan the binding states.
		 */
		const existing = (q: OperandSelect) =>
			this.#joinedBy(q, env) === undefined
				? this.sublink(q, env)
				: this.query(wrapper(q, false), env, undefined)
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
				if (x.kind === "exists") {
					return { ...x, query: existing(x.query) }
				}
				if (x.kind === "subquery") {
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
				? takenThrough(b, stated.orderBy, oneRowLimit(limit.expr))
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
				const folded = taken?.core ?? readCore(b, tail.orderBy)
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
		for (const [place, logical] of innerHoisted(entriesOf(c.from), where).entries()) {
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
		const antis: Array<AntiJoin> = []
		const conjuncts = where.map((w) => {
			const anti = this.#anti(w, here, bound.length + antis.length)
			if (anti === undefined) {
				return rename.expr(w)
			}
			antis.push(anti.anti)
			return anti.conjunct
		})
		const frame = {
			kind: "core",
			from: fromOf(bound),
			where: conjunction(conjuncts),
			groupBy: rename.exprs(c.groupBy),
			having: c.having === undefined ? undefined : rename.expr(c.having)
		} as const
		this.#level(name, bound, frame.where, antis)
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

	/**
	 * A level's plan, where the scope names it: its join problem over its bound entries (`levelJoins`), under `where`,
	 * the conditions its WHERE states beside its bound reads', then the items of the anti joins PostgreSQL makes of its
	 * NOT EXISTS conjuncts (`#anti`).
	 */
	#level(
		name: PlanName | undefined,
		bound: ReadonlyArray<BoundEntry>,
		where: Expr | undefined,
		antis: ReadonlyArray<AntiJoin>
	): void {
		const [catalog] = bound.flatMap((b) => (b.item.scan.kind === "catalog" ? [b.item.alias] : []))
		if (catalog !== undefined && bound.length + antis.length > 1) {
			return defect(
				`a level reading the system catalog's relation ${catalog} alone, which no plan of grizzle's joins to another; it joins ${bound.length + antis.length - 1} more`
			)
		}
		if (name === undefined || !isNonEmpty(bound)) {
			return
		}
		this.#levels.push({
			kind: "joins",
			name,
			problem: levelJoins(bound, where, antis),
			appended: bound.flatMap((b) => b.appended)
		})
	}

	/**
	 * The one entry the EXISTS of `q`, a conjunct of the level `here`, reads where PostgreSQL makes the EXISTS a join of
	 * that level (subselect.c convert_EXISTS_sublink_to_join, simplify_EXISTS_query): a core of no WITH, grouping,
	 * aggregate, window, set-returning target or OFFSET, its LIMIT none or a literal, of one entry no stored table or
	 * view (a stored read's sublink reads it through one item of the scope's, `wrapped`), whose FROM reads no relation
	 * of an enclosing level, and whose WHERE reads one of this level's and calls nothing VOLATILE; none for any other,
	 * which PostgreSQL plans as a subplan.
	 */
	#joinedBy(q: OperandSelect, here: Env): Entry | undefined {
		const body = q.body
		if (
			q.with !== undefined ||
			q.offset !== undefined ||
			(q.limit !== undefined && q.limit.kind !== "literal") ||
			body.kind !== "core" ||
			body.distinct !== false ||
			body.groupBy.length > 0 ||
			body.having !== undefined ||
			!body.targets.every((t) => overRowsOf(t.expr) === undefined && !returnsSet(t.expr))
		) {
			return undefined
		}
		const [entry, ...others] = entriesOf(body.from)
		if (entry === undefined || others.length > 0 || entry.source.kind === "table") {
			return undefined
		}
		const outer = (a: string) => here.relations.has(a)
		if ([...neededBy((t) => t.fromItem(entry.source)).keys()].some(outer)) {
			return undefined
		}
		const conjuncts = conjunctsOf(body.where)
		const level = (a: string) => here.relations.get(a)?.depth === here.depth
		return conjuncts.some((c) => [...qualifiersOf(c)].some(level)) && !conjuncts.some(opaque)
			? entry
			: undefined
	}

	/**
	 * A NOT EXISTS conjunct of the level `here` PostgreSQL makes an anti join of the level (`#joinedBy`), bound, with the
	 * item it joins at `place`: its one entry's, read after every item of the level, by a hash where its WHERE equates a
	 * column of it with a value of the level's items, a set join's of an item no index binds, else by a nested loop;
	 * none for any other conjunct.
	 */
	#anti(
		c: Expr,
		here: Env,
		place: number
	): { readonly conjunct: Expr; readonly anti: AntiJoin } | undefined {
		if (c.kind !== "exists" || !c.not) {
			return undefined
		}
		const entry = this.#joinedBy(c.query, here)
		const written = entry === undefined ? undefined : writtenOf(entry.source)
		if (entry === undefined || written === undefined) {
			return undefined
		}
		const bound = this.#bound(c.query, here, undefined)
		const [item, ...others] = bound.items
		if (item === undefined || others.length > 0) {
			return defect("an anti join's sublink reading one item")
		}
		const body = c.query.body
		const level = (a: string) => {
			const d = here.relations.get(a)
			return d?.depth === here.depth && d.place < place
		}
		const hashed =
			body.kind === "core" &&
			conjunctsOf(body.where).some((x) => {
				const b = bindingOf(x, written)
				return b?.op === "=" && [...qualifiersOf(b.value)].some(level)
			})
		return {
			conjunct: { ...c, query: bound.query },
			anti: { item, join: hashed ? "hash" : "nestedLoop" }
		}
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
		const rows = (s: FromSource, method: Joining): BoundEntry => ({
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
						return rows({ ...source, alias }, "set")
					case "apart":
						return rows({ ...source, alias }, "set")
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
					: rows({ kind: "cte", name, alias }, "set")
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
					problem: { kind: "item", item: { alias: sides, scan: { kind: "rows" } } },
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
					"set"
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
				return rows({ ...source, alias }, "set")
			case "context": {
				const inner = this.#alias(source.inner)
				this.#levels.push({
					kind: "joins",
					name: { kind: "named", name: alias },
					problem: { kind: "item", item: { alias: inner, scan: { kind: "rows" } } },
					appended: []
				})
				return rows({ ...source, inner, alias }, "set")
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
					"set"
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
		reach: DrivenReach,
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
		const [h0, ...hs] = held
		this.#levels.push({
			kind: "joins",
			name: { kind: "named", name: alias },
			problem: {
				kind: "item",
				item: {
					alias: stored === undefined ? inner : itemAlias(stored, inner),
					scan:
						stored === undefined || h0 === undefined || held.length !== bound.length
							? { kind: "rows" }
							: {
									kind: "index",
									index: drivenRequest(stored.table, [h0, ...hs], reach),
									bound: held,
									needs: tableColumns(stored, [...new Set([...delivered, ...held])].toSorted())
								}
				}
			},
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
			by.kind === "group" || by.kind === "last"
				? { kind: "ordered", order: by.order }
				: { kind: by.kind },
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
			{ kind: "key" },
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
			[...freeQualifiersOf(e)].every((a) => {
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
							const driven = b.op === "=" && [...freeQualifiersOf(b.value)].some(earlier)
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
				return {
					source: read({ kind: "whole" }),
					scan: systemCatalog(source.table) ? { kind: "catalog" } : { kind: "rows" }
				}
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
				case "row": {
					for (const b of access.eq) {
						take(b.conjunct)
					}
					const valueOf = (column: string): Expr =>
						this.expr(
							defined(
								access.eq.find((b) => b.column === column),
								`the binding of ${column}, a column of the row`
							).value,
							self
						)
					return indexed(
						{
							kind: "row",
							type: access.type,
							columns: access.columns,
							values: mapNonEmpty(access.columns, valueOf)
						},
						accessRequest(table, access),
						access.columns
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
			method: "set",
			appended: []
		}
	}

	/**
	 * How a stored read reaches its rows (`tableEntry`), each conjunct of `pools` classified by its operator and its
	 * column's kind (BindColumn), against a value its level fixes, its equalities `bindings` among them, and the index
	 * order its level's LIMIT states of it (`order`), in this order of what reaches the fewest rows by construction:
	 * - its equalities where they hold a unique key whole, at one row (`seek`, a key lookup);
	 * - a search document's match (`search`), its rows those its query's lexemes hold, every row the read delivers among
	 *   them, its other conjuncts filters above them: the match drives its read, and no index is asked of the relation
	 *   for the filters beside it (docs/reads-and-writes.md "Full text search");
	 * - its level's index order: a take's or a page's ORDER BY of its B-tree columns past the ones its equalities fix,
	 *   after them (`ordered`), or an approximate search's distance from a fixed vector (`nearest`), the equalities then
	 *   filters;
	 * - a span's Allen relation, after its equalities through btree_gist (`span`);
	 * - the one range past its equalities, of the column bounded on both sides first, then the least by name, where a
	 *   column it or they bind holds many values (`range`, a text column bounded on both sides a prefix search), as the
	 *   workload's access paths have always ranged a read;
	 * - its equalities where one holds many values (`seek`);
	 * - a network's containment (`network`), the equalities filters;
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
		const [r0, ...rs] = [...table.columns.keys()].filter((c) => equal.has(c))
		if (
			table.hashRow.kind === "typed" &&
			b0 !== undefined &&
			r0 !== undefined &&
			rs.length > 0 &&
			bindings.every((b) => b.op === "=" && table.columns.get(b.column)?.kind === "bytes")
		) {
			return {
				kind: "row",
				eq: [b0, ...bs],
				columns: [r0, ...rs],
				type: table.hashRow.type([r0, ...rs])
			}
		}
		if (many && b0 !== undefined && holdsKey(table, equal)) {
			return { kind: "seek", eq: [b0, ...bs], keyed: true }
		}
		const kindOf = (column: string) => table.columns.get(column)?.kind
		const matched = (kind: keyof typeof matchOperators) =>
			conjuncts
				.flatMap((c) => {
					const m = matchOf(c, written, kind, kindOf)
					return m !== undefined && fixed(m.value) ? [{ conjunct: c, column: m.column }] : []
				})
				.toSorted((x, y) => compareStrings(x.column, y.column))[0]
		const search = matched("search")
		if (search !== undefined) {
			return { kind: "search", column: search.column, conjunct: search.conjunct }
		}
		if (order !== undefined) {
			const ordered = orderedOf(table, written, order, equal, fixed)
			if (ordered !== undefined) {
				return ordered.kind === "ordered" ? { ...ordered, eq: bindings } : ordered
			}
		}
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
		return network === undefined
			? { kind: "whole" }
			: { kind: "network", column: network.column, conjunct: network.conjunct }
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
			problem: {
				kind: "item",
				item: {
					alias: itemAlias(stored, inner),
					scan: {
						kind: "index",
						index: requestOf(table, [k0, ...ks], [], keyed ? "key lookup" : "join key"),
						bound,
						needs: tableColumns(stored, delivered)
					}
				}
			},
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
			query = pushedInto(query, written, c, "nothing") ?? query
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
	 * condition, so the table is derived once and joined as a set (`levelJoins`), never derived again for each row
	 * before it, a CTE's scan or a fold over every row read once; one the lowering wrote LATERAL takes those too.
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
			const pushed = pushedInto(query, written, c, "fences")
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
			method: lateral ? "nestedLoop" : "set",
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
	 * items first, in order, which never see the target; then the target: at the tuple id its own condition states it at
	 * (an owner's routine's, which holds the table's privileges); where those items bind it, through the index its
	 * bindings lead, the inner of a nested loop over them, each binding an index condition of its scan, so a statement
	 * served under a role reads no column its grants leave out, a tuple id, which PostgreSQL checks against the table's
	 * SELECT alone, among them (a column-granted query entry's writer, test/pg/live/errors); else at its own bindings or
	 * whole.
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
			const rename = this.renamer(here)
			const tidWhere = conjunction(where.map((x) => rename.expr(x)))
			this.#level(
				name,
				[...qualifiersOf(atTid.value)].some(earlier) ? [...bound, tidRead] : [tidRead, ...bound],
				tidWhere,
				[]
			)
			return { alias, items: fromOf(bound), where: tidWhere, env: here }
		}
		const bindings =
			catalogTable === undefined
				? []
				: where.flatMap((c) => {
						const b = bindingOf(c, written)
						return b !== undefined && btreeColumn(catalogTable, b.column) !== undefined ? [b] : []
					})
		const driven = bindings.filter(
			(b) => b.op === "=" && [...freeQualifiersOf(b.value)].some(earlier)
		)
		if (catalogTable !== undefined && driven.length > 0) {
			const boundColumns = [...new Set(bindings.map((b) => b.column))].toSorted()
			const [b0, ...bs] = boundColumns
			if (b0 === undefined) {
				return defect("a write's target its driven bindings bind no column of")
			}
			here = withRelation(here, written, alias, depth, place)
			const rename = this.renamer(here)
			const drivenWhere = conjunction(where.map((x) => rename.expr(x)))
			this.#level(
				name,
				[
					...bound,
					{
						source: { kind: "read", table, alias, access: { kind: "whole" } },
						step: { join: "cross" },
						item: {
							alias,
							scan: {
								kind: "index",
								index: requestOf(
									catalogTable,
									[b0, ...bs],
									[],
									holdsKey(catalogTable, new Set(driven.map((b) => b.column)))
										? "key lookup"
										: "join key"
								),
								bound: boundColumns,
								needs: this.#needed(written)
							}
						},
						method: "nestedLoop",
						appended: []
					}
				],
				drivenWhere,
				[]
			)
			return { alias, items: fromOf(bound), where: drivenWhere, env: here }
		}
		const many =
			catalogTable !== undefined &&
			bindings.some((b) => btreeColumn(catalogTable, b.column)?.holds === "many")
		const fixedBindings = bindings.filter((b) =>
			[...freeQualifiersOf(b.value)].every((a) => {
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
		const rename = this.renamer(here)
		const targetWhere = conjunction(where.map((x) => rename.expr(x)))
		this.#level(
			name,
			[
				{
					source: { kind: "read", table, alias, access: { kind: "whole" } },
					step: { join: "cross" },
					item: targetItem,
					method: "nestedLoop",
					appended: []
				},
				...bound
			],
			targetWhere,
			[]
		)
		return { alias, items: fromOf(bound), where: targetWhere, env: here }
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
		this.#level(
			name,
			[
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
			],
			undefined,
			[]
		)
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

	/** A routine bound (`routine`), each query it hands the planner over its own columns' needs (`planned`). */
	routineOf(fn: CreateFunction): CreateFunction {
		this.#whole = false
		return this.routine(fn)
	}

	/** A DO block's body bound (bindBlock), each query it hands the planner over its own columns' needs (`planned`); a
	 * whole one's reads joined by hash. */
	blockOf(b: PlBlock): PlBlock {
		this.#whole = this.#reads.kind === "whole"
		return this.block(b)
	}

	/**
	 * `bind` run over the needs of one query PL/pgSQL hands the planner on its own, which `collect` walks: each alias's
	 * columns that query reads, never another's. A routine's statements are lowered apart, each naming its items from a
	 * supply of its own, so one alias names items of two of them, and a routine's needs read off it whole counted the
	 * columns of both among a read's: the cover an index-only scan's choice reads (sql/advice.ts), so rule-guard's guard,
	 * which reads of Value its package alone, was advised an INDEX_SCAN for the columns of an item of its probe's
	 * statement under the same alias.
	 */
	#planned<A>(collect: (t: Transform) => unknown, bind: () => A): A {
		const needs = this.#needs
		this.#needs = neededBy(collect)
		const bound = bind()
		this.#needs = needs
		return bound
	}

	/**
	 * A routine bound under the scope (sql/naming.ts AdviceScope `routine`): each statement PL/pgSQL hands the planner
	 * its own top level, a PL variable and a record's field a value it fixes; a SQL function's body one SELECT of it.
	 */
	routine(fn: CreateFunction): CreateFunction {
		if (fn.language === "sql") {
			const body = fn.body
			return {
				...fn,
				body: this.#planned(
					(t) => t.expr(body),
					() => this.expr(body, topEnv)
				)
			}
		}
		return { ...fn, body: this.block(fn.body) }
	}

	block(b: PlBlock): PlBlock {
		const [first, ...rest] = b.body
		return { ...b, body: [this.pl(first), ...rest.map((s) => this.pl(s))] }
	}

	pl(s: PlStatement): PlStatement {
		const plain = (e: Expr) =>
			this.#planned(
				(t) => t.expr(e),
				() => this.expr(e, topEnv)
			)
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
			case "forQuery": {
				const query = s.query
				return {
					...s,
					query: this.#planned(
						(t) => t.setQuery(query),
						() => this.setQuery(query, topEnv, { kind: "top" })
					),
					body: s.body.map((x) => this.pl(x))
				}
			}
			case "perform": {
				const performed = operandSelect(s.query.body)
				const q = this.#planned(
					(t) => t.select(performed),
					() => this.query(performed, topEnv, { kind: "top" })
				)
				const body = q.body
				return body.kind === "core"
					? { ...s, query: { ...s.query, body } }
					: defect("a PERFORM of one core bound one core")
			}
			case "whenFound": {
				const [b0, ...bs] = s.body
				const query = s.query
				return {
					...s,
					query: this.#planned(
						(t) => t.select(query),
						() => this.query(query, topEnv, { kind: "top" })
					),
					body: [this.pl(b0), ...bs.map((x) => this.pl(x))]
				}
			}
			case "wholeReads": {
				const whole = this.#whole
				this.#whole = true
				this.#readWhole = true
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
				const modified = <M>(bind: () => M): M =>
					this.#planned((t) => t.plStatement({ kind: "modify", statement }), bind)
				switch (statement.kind) {
					case "insert":
						return {
							...s,
							statement: modified(() => this.insert(statement, topEnv, { kind: "top" }))
						}
					case "update":
						return {
							...s,
							statement: modified(() => this.update(statement, topEnv, { kind: "top" }))
						}
					case "delete":
						return {
							...s,
							statement: modified(() => this.delete(statement, topEnv, { kind: "top" }))
						}
					case "merge":
						return {
							...s,
							statement: modified(() => this.merge(statement, topEnv, { kind: "top" }))
						}
				}
			}
			case "returnQuery": {
				const query = s.query
				return {
					...s,
					query: this.#planned(
						(t) => t.select(query),
						() => this.query(query, topEnv, { kind: "top" })
					)
				}
			}
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
	/** Whether a statement of it reads what it reads whole, once (PlStatement `wholeReads`), which a keyed binding reads
	 * whole and a whole one at the values it fixes where an index serves them (Binder `#serves`). */
	readonly readsWhole: boolean
}

/**
 * The routine `fn`, bound over `catalog` under a scope of its own, its reads by `reads`, each statement PL/pgSQL hands
 * the planner its own top level (see the header), after its logical rewrites (sql/print-once.ts printedOnce).
 */
export const bindRoutine = (
	fn: CreateFunction,
	scope: AdviceScope,
	catalog: ReadCatalog,
	reads: BoundReads
): BoundRoutine => {
	const binder = new Binder(scope, catalog, reads)
	const once = printedOnce(fn)
	if (once.kind !== "createFunction") {
		return defect("a routine printed once a routine still")
	}
	const bound = binder.routineOf(once)
	return {
		fn: bound,
		plan: binder.plan(),
		planned: plannedOf(bound, catalog.fired(nameKey(fn.name))),
		readsWhole: binder.readWhole()
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
 * `catalog` (sql/naming.ts ViewScope): what its installation creates; its definition after its logical rewrites, its top
 * core as the binding reads it (`readCore`), which a reader binds again (WorldBinding), so a qual a reader pushes in
 * lands in the core the installation created, never above a projection the binding folds away, which a WHERE would keep
 * as a level of its own, its alias one the installation never minted; and how many aliases the binding mints. A view's
 * own DDL carries no advice: each statement that reads it carries the plan of its body (Binder `#world`).
 */
export const bindView = (
	definition: Select,
	ordinal: number,
	catalog: ReadCatalog
): { readonly prepared: Select; readonly bound: Select; readonly minted: number } => {
	const once = selectOnce(definition)
	const top = once.body
	const read: OperandSelect =
		top.kind === "core" && once.limit?.kind !== "access"
			? { ...once, body: readCore(top, once.orderBy) }
			: once
	const prepared = isSetQuery(read)
		? read
		: defect("a view's body read as its binding reads it a set still")
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
 * every read one whose index request index planning plans (physical/indexes/engine.ts planIndexes), but a read of a
 * statement that reads what it reads whole, once, which asks none (Binder `#serves`): a workload's statement and a
 * routine's; or `whole`, each read whole or at the values it fixes and joined by a hash, as a statement
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
