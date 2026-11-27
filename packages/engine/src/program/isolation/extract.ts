import { equalityClosure } from "@bjornpagen/grizzle-text/base/equality"
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { TupleMap } from "@bjornpagen/grizzle-text/base/tuple-map"
import {
	type Binding,
	bindingRows,
	type CteFacts,
	type CteUse,
	type FieldBinding,
	type MemberFacts,
	type ProbeFact,
	type ReadAt,
	type ReadFact,
	type ReadGroup,
	type RowSource,
	type SiteCore,
	type StatementFacts,
	sameBinding,
	type WriteFact
} from "#compiler/analysis/isolation/facts.ts"
import type { ParamId } from "#compiler/core/ids.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { compareStrings } from "#compiler/core/order.ts"
import {
	type Assignment,
	type CteBody,
	type Delete,
	type Expr,
	type FromItem,
	type FromSource,
	type FunctionCall,
	type Insert,
	type JoinStep,
	type Merge,
	type MergeWhen,
	type ObjectName,
	type OperandBody,
	type OperandSelect,
	type OrderItem,
	overRowsOf,
	type ProbeColumn,
	type QualifiedFunctionRef,
	selectColumns,
	type SetOperation,
	type SqlStatement,
	type Update,
	type WindowSpec,
	type With
} from "#compiler/sql/ast.ts"
import { col, derived, eq, simpleSelect, targetAs } from "#compiler/sql/build.ts"
import { printExpr, printObjectName } from "#compiler/sql/print.ts"

/**
 * How the extractor reads one role's statements back:
 *
 * - `relationOf`: the relation, by its declared name, a stored table or the role's view of a whole entry is; none for a
 *   table the installation states no relation of;
 * - `fieldOf`: the field a column of a relation's table is, none for a column of no field (a law column);
 * - `readsNoTable`: whether a schema function a statement calls reads no relation's table, as a refusal, a constant, a
 *   vector reads none;
 * - `bodyOf`: the body of a world function the role installs, a writable entry's filter function or one of its key and
 *   unique probes, over its arguments (argumentsRow), which a call of it reads as the function's owner, which no row
 *   policy holds; none for any other function;
 * - `policyOf`: the predicate of the role's row policy on a table its own entry narrows, a writable entry's target or a
 *   family's owner its member writes reach, over the table's row (policyRow): its USING, which holds every read of the
 *   table a statement of the role makes directly to the rows it admits; none for any other table, and none where the
 *   role's policy admits every row. Its WITH CHECK only refuses, which no fact of a read states;
 * - `definitionOf`: the definition of the role's view of a query entry, whose reads are its owner's (physical/ddl/roles.ts
 *   worldView), with the view's columns, one per column of its definition; none for any other table;
 * - `arbitersOf`: the columns of each object an ON CONFLICT DO NOTHING with no target arbitrates on a relation's table,
 *   its primary key, each UNIQUE and each span key, each by the columns of its fields, a law column's left out.
 */
export interface ExtractNames {
	readonly relationOf: (table: ObjectName) => string | undefined
	readonly fieldOf: (relation: string, column: string) => string | undefined
	readonly readsNoTable: (fn: QualifiedFunctionRef) => boolean
	readonly bodyOf: (fn: QualifiedFunctionRef) => Expr | undefined
	readonly policyOf: (table: ObjectName) => Expr | undefined
	readonly definitionOf: (view: ObjectName) => Definition | undefined
	readonly arbitersOf: (relation: string) => ReadonlyArray<ReadonlyArray<string>>
}

/** A view's definition (ExtractNames `definitionOf`): its query, and the view's column each of its targets is, in order. */
export interface Definition {
	readonly query: OperandSelect
	readonly columns: ReadonlyArray<string>
}

/**
 * The alias a row policy's predicate reads its table's row by (ExtractNames `policyOf`), which a walk names a stored row
 * of no binding: the row a read finds, whatever the policy reads of it. No statement names a source with a `?`.
 */
export const policyRow = "?row"

/**
 * The alias a world function's body reads its arguments by (ExtractNames `bodyOf`), its n-th argument at the column
 * `argumentColumn(n)`, from 0: a walk binds each column to what the call's argument is bound to (Walk #inlined).
 */
export const argumentsRow = "?arguments"

/** The column of argumentsRow a world function's body reads its argument at `position` by, from 0. */
export const argumentColumn = (position: number): string => `${position}`

/**
 * How the rows a read finds reach what its statement does: by their presence, by their absence, or either way, where
 * they reach a value or a branch.
 */
type Polarity = "positive" | "negated" | "both"

/**
 * What a name a core sees is: a stored table's alias, whose values the statement reads (Stored), an own source's, whose
 * values are the call's own (OwnRows), or an INSERT's met rows, any number of them, named by their source, which a `met`
 * source reads through.
 */
type Named = Stored | OwnRows | MetRows

/**
 * A stored table's alias as a core sees it, by the statement's node that names it (`at`): its FROM source, a MERGE's or
 * an INSERT's target. The walk keeps the place of that node's read (Walk `places`), so a column of it binds another
 * read of the body, however many derived tables carry the column up to it, to the row this one finds (Binding
 * `stored`); every name of one node, wherever a query is read again for its columns, is the one name.
 */
interface Stored {
	readonly kind: "stored"
	readonly at: StoredAt
	/** The field each column of it is, through a projection's renaming; none for a column of no field (a law column's)
	 * or of a table no relation is. */
	readonly field: (column: string) => string | undefined
}

/** The name of the stored table `table` a node names, its columns renamed by `columns` (none for the table itself). */
const storedAt = (
	at: StoredAt,
	table: ObjectName,
	columns: ReadonlyMap<string, string> | undefined,
	names: ExtractNames
): Stored => {
	const relation = names.relationOf(table)
	return {
		kind: "stored",
		at,
		field: (column) => {
			const own = columns === undefined ? column : columns.get(column)
			return relation === undefined || own === undefined ? undefined : names.fieldOf(relation, own)
		}
	}
}

/** The name of a source nameOf finds a stored table's: a table's, a renaming projection's, a probe's or a met row's. */
const storedOf = (source: FromSource, names: ExtractNames): Stored => {
	switch (source.kind) {
		case "table":
		case "read":
		case "probe":
		case "met":
			return storedAt(source, source.table, undefined, names)
		case "derived": {
			const projection = projectionOf(source)
			if (projection === undefined) {
				defect("a derived table names a stored table only where it renames one")
			}
			return storedAt(source, projection.table, projection.columns, names)
		}
		case "cte":
		case "context":
		case "metRows":
		case "enclosing":
		case "transition":
		case "function":
		case "arrays":
		case "values":
			defect("only a table, a renaming projection, a probe or a met row names a stored table")
	}
}

/** The statement's node that names a stored table's source (Stored `at`). */
type StoredAt = FromSource | Merge | Insert

/**
 * A source of the call's own rows as a core sees it: the session's context, one row (`one`), or a carrier, a CTE, a
 * relation input's arrays, a VALUES list, a function's or a derived table's rows, any number of rows (`many`); and each
 * column of it that carries a binding in every row (`bound`, Statement.columnBindings): a context's field, a relation
 * input's, one value the call holds once, or a column of a stored table's source its query reads, which a read bound to
 * the column is bound to, whatever rows the source holds.
 */
interface OwnRows {
	readonly kind: "own"
	readonly rows: "one" | "many"
	readonly bound: ReadonlyMap<string, BoundTo>
}

/** A binding the call holds or its own rows carry, wherever it stands: any but a stored row's (Binding `stored`). */
type CallBinding = Exclude<Binding, { readonly kind: "stored" }>

/**
 * What fills a placeholder $n of a statement, as its bindings read it: a declared scalar parameter, by its name
 * (`param`); one array of a relation input, a relation parameter's or a member slot's, by its ParamId, the array of its
 * heading's `field` (`input`); or any other array (`rows`), a stratum's nested rows' or an input's count, which binds no
 * read by itself.
 */
export type SlotFill =
	| { readonly kind: "param"; readonly name: string }
	| { readonly kind: "input"; readonly parameter: ParamId; readonly field: string }
	| { readonly kind: "rows" }

type Scope = ReadonlyMap<string, Named>

/** A source of the rows an INSERT proposed and did not insert (sql/ast.ts FromSource `metRows`). */
type MetRows = Extract<FromSource, { readonly kind: "metRows" }>

/** The row an INSERT's arbitration met for a met row (sql/ast.ts FromSource `met`). */
type Met = Extract<FromSource, { readonly kind: "met" }>

/** A condition with the names it sees, which a condition pushed into a derived table keeps from where it stands. */
interface Scoped {
	readonly expr: Expr
	readonly scope: Scope
}

/** A column a read's conditions bind, and what it is bound to (BoundTo). */
interface Bound {
	readonly column: string
	readonly by: BoundTo
}

/**
 * What a column a read's conditions bind is bound to as the walk finds it: a binding the call holds or its own rows
 * carry (CallBinding); or a column of a stored table's source in scope, or one an own source carries up from such a
 * source its query reads, that is a field (`column`, by the field), which the body's facts resolve to that source's read
 * (Binding `stored`). A column of no field carries nothing up: an own source's is the own column itself.
 */
type BoundTo =
	| CallBinding
	| { readonly kind: "column"; readonly of: Stored; readonly field: string }

/**
 * What a CTE name refers to: a query, read where a source names it, under the scope, the CTEs and the privileges
 * (Context `reader`) it was defined in; a data-modifying CTE, whose RETURNING rows are the call's: the rows it makes, and an INSERT's ON CONFLICT DO SELECT's
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
			readonly reader: Reader
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
 * Whose privileges a read runs under: the role's, which its row policies hold to the rows they admit (ExtractNames
 * `policyOf`), in its statements; or the owner's, which no policy holds, in a query entry's view's definition, a world
 * function's body and a policy's predicate, each the installation's owner's (physical/ddl/roles.ts: a view, a SECURITY
 * DEFINER function), which owns every table and bypasses its row security.
 */
type Reader = "role" | "owner"

/**
 * Where an expression or a source stands: the polarity its reads reach the statement with, whether a count or an
 * aggregate stands over them, whether it is a source of the core an EXISTS probes, whether an expression is a
 * condition of its core (WHERE, ON or HAVING, through AND, OR, NOT and IS TRUE), the names and CTEs it sees, whose
 * privileges its reads run under (Reader), the probes of its body it stands beneath, and the innermost core of its body
 * it stands in, its body's arrival (`Top`) outside every core.
 */
interface Context<Top extends Arrival = Arrival> {
	readonly polarity: Polarity
	readonly counted: boolean
	readonly probe: boolean
	readonly condition: boolean
	readonly scope: Scope
	readonly ctes: Ctes
	readonly reader: Reader
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
	reader: "role",
	probes: [],
	core: undefined
}

/**
 * `c` where an object the installation's owner runs stands (Reader `owner`), which sees `scope` alone: no name or CTE of
 * the statement that reaches it, since its text names none.
 */
const ownedAt = <C extends Context>(c: C, scope: Scope): C => ({
	...c,
	reader: "owner",
	scope,
	ctes: new Map()
})

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
type Found<Top extends Arrival = Arrival> =
	| {
			readonly kind: "table"
			readonly table: ObjectName
			readonly alias: string
			readonly context: Context<Top>
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

/** A table read a walk finds (Found `table`). */
type TableFound<Top extends Arrival> = Extract<Found<Top>, { readonly kind: "table" }>

/** A derived table, (SELECT ...) AS alias(columns) (sql/ast.ts FromSource `derived`). */
type DerivedSource = Extract<FromSource, { readonly kind: "derived" }>

/**
 * The alias a read of a query entry's view reads its definition's rows by (Walk #defined), in a core of its own over the
 * definition alone, under no other name.
 */
const viewRow = "?view"

/** An INSERT's ON CONFLICT arbitration of the table it writes: its conflict columns, none for a constraint's, and the
 * binding each column it writes carries (insertValues). */
interface Arbitration {
	readonly table: ObjectName
	readonly columns: ReadonlyArray<string> | undefined
	readonly values: ReadonlyMap<string, CallBinding>
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
		case "attribute":
			return [e.record]
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
	readonly table: ObjectName
	readonly columns: ReadonlyMap<string, string>
}

/** A projection as the source of another: its table, and the table's column each of its columns is. */
const underOf = (
	p: Projection | undefined
):
	| { readonly table: ObjectName; readonly column: (column: string) => string | undefined }
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
	const names = selectColumns(source.query)
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
	source: DerivedSource,
	conditions: ReadonlyArray<Scoped>
): ReadonlyArray<Scoped> => {
	const body = source.query.body
	if (!rowPreserving(source.query) || body.kind !== "core") {
		return []
	}
	const names = selectColumns(source.query)
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
 * Whether an expression of a core is a value the call holds once, from `own`, the aliases of the core's sources that are
 * such a row (callRow): a placeholder, a literal, a column of one of `own`, or a builtin operator, cast or call that
 * computes over no rows, over such values alone. No subquery, no schema function and no other name is one: each may
 * read a stored row, or a row of the call's many.
 */
const callValue = (e: Expr, own: ReadonlySet<string>): boolean => {
	switch (e.kind) {
		case "param":
		case "clock":
		case "literal":
			return true
		case "column":
			return e.table !== undefined && own.has(e.table)
		case "call":
			return (
				e.fn.kind === "builtin" &&
				overRowsOf(e) === undefined &&
				callOperands(e).every((o) => callValue(o, own))
			)
		case "and":
		case "or":
		case "greatest":
		case "least":
		case "coalesce":
		case "not":
		case "isTrue":
		case "cast":
		case "collate":
		case "negate":
		case "complement":
		case "lowerAscii":
		case "binary":
		case "nullif":
		case "subscript":
		case "attribute":
		case "between":
		case "inList":
		case "equalsAny":
		case "row":
		case "case":
			return operandsOf(e).every((o) => callValue(o, own))
		case "inQuery":
		case "exists":
		case "subquery":
		case "array":
		case "domainValue":
		case "excluded":
		case "field":
		case "mergeAction":
		case "plSpecial":
		case "plVar":
		case "regclass":
		case "returning":
		case "user":
			return false
	}
}

/**
 * Whether a derived table's query yields one row at most, each of its values one the call holds once: one core under no
 * WITH, grouping or HAVING, each of its sources such a row itself, a context's fact or a derived table of one, and each
 * expression it holds, its targets', conditions', order's and bounds', a value over them alone (callValue). A column
 * bound to it binds one value for the call, as a column bound to the context's fact itself does (facts.ts ReadGroup
 * `one`): a write reads a context's fact through such derived tables, which rename and cast its claims.
 */
const callRow = (q: OperandSelect): boolean => {
	const body = q.body
	if (
		q.with !== undefined ||
		body.kind !== "core" ||
		body.groupBy.length > 0 ||
		body.having !== undefined
	) {
		return false
	}
	const sources = sourcesOf(body.from)
	if (!sources.every(({ source }) => nameOf(source)[1] === "one")) {
		return false
	}
	const own = new Set(sources.map(({ source }) => nameOf(source)[0]))
	return [
		...body.targets.map((t) => t.expr),
		...(typeof body.distinct === "object" ? body.distinct.on : []),
		...conjunctsOf(body.where),
		...sources.flatMap(({ on }) => conjunctsOf(on)),
		...orderExprs(q.orderBy),
		...(q.limit === undefined ? [] : [q.limit]),
		...(q.offset === undefined ? [] : [q.offset])
	].every((e) => callValue(e, own))
}

/**
 * What a source's alias names: a stored table's values, a derived table's that only renames one's columns among them,
 * or the call's own, of one row (a context's fact, a derived table of one, callRow) or many.
 */
const nameOf = (source: FromSource): readonly [string, "table" | OwnRows["rows"] | MetRows] => {
	switch (source.kind) {
		case "table":
		case "read":
			return [source.alias, "table"]
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
			if (projection !== undefined) {
				return [source.alias, "table"]
			}
			return [source.alias, callRow(source.query) ? "one" : "many"]
		}
		case "enclosing":
		case "transition":
		case "function":
		case "arrays":
		case "values":
			return [source.alias, "many"]
	}
}

/**
 * The met rows a query CTE holds whole (sql/ast.ts FromSource `metRows`), none for any other query: one core over a met
 * rows source alone, under no WITH, condition, grouping, HAVING, DISTINCT, ORDER BY, LIMIT or OFFSET, each of its
 * columns the met rows' column of its own name, as the insert protocol keeps them once in a MATERIALIZED CTE of their
 * own (write/insert/protocol.ts classifyMet), so every row of it is a met row, column for column.
 */
const metRowsHeld = (query: OperandSelect, columns: ReadonlyArray<string>): MetRows | undefined => {
	const body = query.body
	if (
		query.with !== undefined ||
		query.orderBy.length > 0 ||
		query.limit !== undefined ||
		query.offset !== undefined ||
		body.kind !== "core" ||
		body.where !== undefined ||
		body.groupBy.length > 0 ||
		body.having !== undefined ||
		body.distinct !== false
	) {
		return undefined
	}
	const [only, ...rest] = body.from
	if (only === undefined || rest.length > 0 || only.kind !== "metRows") {
		return undefined
	}
	const names = columns.length > 0 ? columns : body.targets.map((t) => t.alias)
	return names.length === body.targets.length &&
		body.targets.every(
			(t, i) =>
				t.expr.kind === "column" && t.expr.table === only.alias && t.expr.column === names[i]
		)
		? only
		: undefined
}

/**
 * What a source's alias names where `ctes` are in scope (nameOf): a query CTE that holds an INSERT's met rows whole
 * (metRowsHeld) names them, as their own source does, so a `met` source driven by its rows is read as the met row it is
 * (metSealed); a stored table's source names its rows (Stored); an own source names its rows with the binding each of
 * its columns carries (OwnRows `bound`): a context's each its field's, a relation input's arrays each its field's, a
 * derived table's or a query CTE's each its query's (Statement.columnBindings).
 */
const namedIn = (
	source: FromSource,
	ctes: Ctes,
	statement: Statement
): readonly [string, Named] => {
	if (source.kind === "cte") {
		const ref = ctes.get(source.name)
		const held = ref?.kind === "query" ? metRowsHeld(ref.query, ref.columns) : undefined
		if (held !== undefined) {
			return [source.alias ?? source.name, held]
		}
	}
	const [alias, named] = nameOf(source)
	if (named === "table") {
		return [alias, storedOf(source, statement.names)]
	}
	if (typeof named === "object") {
		return [alias, named]
	}
	return [alias, { kind: "own", rows: named, bound: ownColumns(source, ctes, statement) }]
}

/**
 * The binding each column of an own source carries (OwnRows `bound`), none where it carries none: a context's its
 * claim, a relation input's its field, a derived table's what its query carries, and a query CTE's what its query
 * carries but a stored table's column, whose read stands in the CTE's own body, which no read of the reader's names.
 */
const ownColumns = (
	source: FromSource,
	ctes: Ctes,
	statement: Statement
): ReadonlyMap<string, BoundTo> => {
	if (source.kind === "context") {
		return new Map(
			source.columns.map((c) => [
				c.column.name,
				{ kind: "context", context: source.context, field: c.field }
			])
		)
	}
	if (source.kind === "arrays") {
		return source.source.kind === "columns"
			? new Map(
					source.source.columns.flatMap((c): ReadonlyArray<readonly [string, CallBinding]> => {
						const fill = statement.slotOf(c.array.number)
						return fill.kind === "input"
							? [
									[
										c.definition.name,
										{ kind: "input", parameter: fill.parameter, field: fill.field }
									]
								]
							: []
					})
				)
			: new Map()
	}
	const defined = definedOf(source, ctes)
	if (defined === undefined) {
		return new Map()
	}
	const carried = statement.columnBindings(defined.query, defined.columns, defined.ctes)
	return source.kind === "derived"
		? carried
		: new Map(
				[...carried].flatMap(([column, by]): ReadonlyArray<readonly [string, BoundTo]> =>
					by.kind === "column" ? [] : [[column, by]]
				)
			)
}

/** The names of a body's columns as its targets give them: its first core's aliases, which name a set operation's. */
const targetNames = (body: OperandBody): ReadonlyArray<string | undefined> => {
	switch (body.kind) {
		case "core":
			return body.targets.map((t) => t.alias)
		case "select":
			return targetNames(body.body)
		case "setOp": {
			const [first] = body.arms
			return first.kind === "core" ? targetNames(first) : targetNames(first.body)
		}
	}
}

/** An expression through its casts and collations, which keep the value it is equal to. */
const uncast = (e: Expr): Expr => (e.kind === "cast" || e.kind === "collate" ? uncast(e.expr) : e)

/** The name a closure joins a column of a source by (equalityClosure): its alias and its name, none for any other
 * expression, through its casts. */
const columnName = (e: Expr): string | undefined => {
	const u = uncast(e)
	return u.kind === "column" && u.table !== undefined
		? JSON.stringify([u.table, u.column])
		: undefined
}

/**
 * The binding an expression of a core carries, where it carries one (BoundTo): a value the statement spells
 * (valueBinding), through casts; a column of an own source among `named`, the core's sources, the binding its source
 * carries there (OwnRows `bound`), else, of a source of one row, the column itself, as a read bound to it is
 * (bindingsOf); or a column of a stored table's source among them (BoundTo `column`). None for any other: a computed
 * value, a column of many own rows that carries nothing.
 */
const carriedBinding = (
	e: Expr,
	named: ReadonlyMap<string, Named>,
	slotOf: (n: number) => SlotFill
): BoundTo | undefined => {
	const u = uncast(e)
	const value = valueBinding(u, slotOf)
	if (value !== undefined) {
		return value
	}
	if (u.kind !== "column" || u.table === undefined) {
		return undefined
	}
	const source = named.get(u.table)
	if (source?.kind === "stored") {
		const field = source.field(u.column)
		return field === undefined ? undefined : { kind: "column", of: source, field }
	}
	if (source?.kind !== "own") {
		return undefined
	}
	return (
		source.bound.get(u.column) ??
		(source.rows === "one"
			? { kind: "own", alias: u.table, column: u.column, rows: "one" }
			: undefined)
	)
}

/** A carried binding the call holds or its own rows carry, none for a stored table's column (BoundTo `column`). */
const callOf = (by: BoundTo | undefined): CallBinding | undefined =>
	by === undefined || by.kind === "column" ? undefined : by

/** Whether two carried bindings bind one value: one call binding (sameBinding), or one column of one stored source. */
const sameBoundTo = (a: BoundTo, b: BoundTo): boolean =>
	a.kind === "column" || b.kind === "column"
		? a.kind === "column" && b.kind === "column" && a.of.at === b.of.at && a.field === b.field
		: sameBinding(a, b)

/**
 * What a value the statement spells binds, where `e` is one: a placeholder's declared scalar parameter, by its name; the
 * declared parameter a clock reading binds, which is one value for the call as a parameter is, so a column equal to it
 * is bound to one value; or a literal, the constant itself. None for a stamp's reading or an array's placeholder, which
 * an arrays source reads (ownColumns).
 */
const valueBinding = (e: Expr, slotOf: (n: number) => SlotFill): CallBinding | undefined => {
	if (e.kind === "param") {
		const fill = slotOf(e.slot.number)
		return fill.kind === "param" ? { kind: "param", name: fill.name } : undefined
	}
	if (e.kind === "literal") {
		return { kind: "constant", spelled: printExpr(e) }
	}
	return e.kind === "clock" && e.of.kind === "param"
		? { kind: "param", name: e.of.param }
		: undefined
}

/** The query and column names a source of the call's own rows reads, a derived table's or a query CTE's; none else. */
const definedOf = (
	source: FromSource,
	ctes: Ctes
):
	| { readonly query: OperandSelect; readonly columns: ReadonlyArray<string>; readonly ctes: Ctes }
	| undefined => {
	if (source.kind === "derived") {
		return { query: source.query, columns: selectColumns(source.query), ctes }
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
 * The binding each column an INSERT writes carries, where the call holds it or its own rows carry it: each item of its
 * one VALUES row that carries one (carriedBinding, over no source), or each column its source query carries one in
 * (Statement.columnBindings), a stored table's column left out.
 */
const insertValues = (
	s: Insert,
	ctes: Ctes,
	statement: Statement
): ReadonlyMap<string, CallBinding> => {
	if (s.source.kind === "query") {
		return new Map(
			[...statement.columnBindings(s.source.query, s.columns, ctes)].flatMap(
				([column, by]): ReadonlyArray<readonly [string, CallBinding]> => {
					const call = callOf(by)
					return call === undefined ? [] : [[column, call]]
				}
			)
		)
	}
	const [only, ...rest] = s.source.rows
	const out = new Map<string, CallBinding>()
	if (rest.length > 0) {
		return out
	}
	for (const [i, column] of s.columns.entries()) {
		const item = only[i]
		const value =
			item === undefined ? undefined : callOf(carriedBinding(item, new Map(), statement.slotOf))
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
	readonly found: Array<Found<Top>> = []
	/** The place of the read of each stored table's source among `found` (Stored), the first where several read it. */
	readonly places = new Map<StoredAt, number>()
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
			s.kind === "beginRead" ||
			s.kind === "beginWrite" ||
			s.kind === "commit" ||
			s.kind === "rollback" ||
			s.kind === "setConstraintsImmediate"
		) {
			return
		}
		this.#opaque(`?statement:${s.kind}`, top)
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
					? {
							kind: "query",
							query: cte.query,
							columns: selectColumns(cte.query),
							scope: c.scope,
							ctes,
							reader: c.reader
						}
					: { kind: "write", body: cte.query }
			)
		}
		const inner: Context<Top> = { ...c, ctes }
		for (const cte of w.ctes) {
			this.#modifying(cte.query, inner)
		}
		return inner
	}

	#writeOf(table: ObjectName, op: WriteFact["op"]): ReadonlyArray<number> {
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
			s.alias === undefined
				? inner.scope
				: new Map([
						...inner.scope,
						[s.alias, storedAt(s, s.table, undefined, this.#statement.names)]
					])
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
				const values = insertValues(s, inner.ctes, this.#statement)
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
			[s.alias, storedAt(s, s.table, undefined, this.#statement.names)],
			...using.map(({ source }) => namedIn(source, inner.ctes, this.#statement))
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
				const target: TableFound<Top> = {
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
				}
				this.found.push(target)
				this.#policed(target)
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
				scope: new Map([
					...c.scope,
					...sources.map(({ source }) => namedIn(source, c.ctes, this.#statement))
				]),
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
	 * table's rows, a LATERAL one's among them, whose rows are computed per row of the sources before it, each row of the
	 * core one of them, as a region's chain reads each step at the steps before it (lower/shapes/region chainedSelect), an
	 * INSERT's met rows' proposed CTE's; none for the row an arbitration met, a function's rows, VALUES, a relation
	 * input's arrays or a context's fact. A probe's rows are its table's at its driving row's values, inner-joined, so every row of its core
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
			case "read":
				return defect(
					"a bound read in a statement the isolation facts read: they read each statement as the lowering states it, before the binding pass (sql/bind.ts)"
				)
			case "table":
				return this.#table({
					kind: "table",
					table: source.table,
					alias: source.alias,
					context: here,
					conditions,
					feeds: this.#feeds(),
					columns: undefined,
					met: undefined
				})
			case "probe":
				return this.#probed(
					source,
					source.table,
					source.inner,
					source.by.columns,
					source.filter,
					here,
					undefined
				)
			case "met":
				if (this.#statement.level === "readCommitted") {
					this.#opaque(`?met:${printObjectName(source.table)}`, here)
				} else {
					this.#probed(
						source,
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
						: this.#table({
								kind: "table",
								table: projection.table,
								alias: source.alias,
								context: here,
								conditions,
								feeds: this.#feeds(),
								columns: projection.columns,
								met: undefined
							})
				return rows
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
		source: FromSource,
		table: ObjectName,
		inner: string,
		columns: ReadonlyArray<ProbeColumn>,
		filter: ReadonlyArray<Expr>,
		here: Context<Top>,
		met: ReadonlyArray<string> | undefined
	): ReadonlyArray<RowSource> {
		const scope: Scope = new Map([
			...here.scope,
			[inner, storedAt(source, table, undefined, this.#statement.names)]
		])
		const conditions = [
			...columns.map((c) => eq(col(inner, c.column), c.value)),
			...filter.flatMap(conjunctsOf)
		]
		const read = this.#table({
			kind: "table",
			table,
			alias: inner,
			context: { ...here, scope },
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

	/**
	 * A table read found, as the row sources it is: a read of the role's view of a query entry is its definition's reads
	 * (#defined); any other its place among the reads, which its source's name (Stored) keeps, read under the role's row
	 * policy on its table where it has one (#policed).
	 */
	#table(found: TableFound<Top>): ReadonlyArray<RowSource> {
		const table = found.table
		const definition = this.#statement.names.definitionOf(table)
		if (definition !== undefined) {
			return this.#defined(found, definition)
		}
		const place = this.found.length
		this.found.push(found)
		const named = found.context.scope.get(found.alias)
		if (named?.kind === "stored") {
			this.places.getOrInsert(named.at, place)
		}
		this.#policed(found)
		return [{ kind: "read", read: place }]
	}

	/**
	 * Where the role reads a table under a row policy of its own (ExtractNames `policyOf`), the policy's predicate walked
	 * as a condition of where the read stands, over the row the read finds (policyRow), named as the read's own source, so a
	 * column of it binds a read of the predicate to that row (Binding `stored`): PostgreSQL
	 * adds it to the read's scan, so a row the policy hides is no row of the read, and every read of its predicate reaches
	 * the statement as a condition there does. A query entry's view, a world function and a predicate read as their
	 * owner, under no policy (Reader).
	 */
	#policed(found: TableFound<Top>): void {
		const table = found.table
		const policy =
			found.context.reader === "owner" ? undefined : this.#statement.names.policyOf(table)
		if (policy === undefined) {
			return
		}
		const row = found.context.scope.get(found.alias)
		if (row?.kind !== "stored") {
			defect("a policed read is of a stored table's source, which its scope names")
		}
		this.expr(
			policy,
			ownedAt({ ...found.context, probe: false, condition: true }, new Map([[policyRow, row]]))
		)
	}

	/**
	 * A read of the role's view of a query entry (ExtractNames `definitionOf`): its definition read where the read stands,
	 * as a derived table of the view's columns under the read's conditions (pushedInto), each through the view's column
	 * the read's column renames (Found `columns`, a projection of the view), its every read the view's owner's (Reader).
	 */
	#defined(found: TableFound<Top>, definition: Definition): ReadonlyArray<RowSource> {
		const renamed = found.columns
		const columns = renamed === undefined ? definition.columns : [...renamed.keys()]
		const query = simpleSelect(
			columns.map((c) => targetAs(col(viewRow, renamed?.get(c) ?? c), c)),
			[derived(definition.query, viewRow, false)],
			undefined
		)
		const source: DerivedSource = { kind: "derived", query, alias: found.alias, lateral: false }
		return this.#query(
			query,
			ownedAt({ ...found.context, probe: false }, new Map()),
			pushedInto(source, found.conditions)
		)
	}

	/**
	 * A CTE read where a source names it: a query CTE's rows, through this body's use of the instance its arrival here
	 * keys (Statement.instance); none for the call's own rows.
	 */
	#cteRead(name: string, c: Context<Top>): ReadonlyArray<RowSource> {
		const ref = c.ctes.get(name)
		if (ref === undefined) {
			defect(`a source names the CTE ${name}, which no WITH around it defines`)
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
	 * An expression's reads: a sublink's query, and a call of a function that may read tables as an opaque read.
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
			const body = this.#statement.names.bodyOf(e.fn)
			if (body !== undefined) {
				this.#inlined(body, e.args, c)
			} else if (!this.#statement.names.readsNoTable(e.fn)) {
				this.#opaque(`?function:${printObjectName(e.fn)}`, c)
			}
		}
		const next = this.#operandContext(e, c)
		for (const operand of operandsOf(e)) {
			this.expr(operand, next)
		}
	}

	/**
	 * A call of a world function (ExtractNames `bodyOf`), read as its body at its arguments where the call stands, its
	 * value the body's: the body sees its arguments alone (argumentsRow), each column carrying what its argument carries
	 * (carriedBinding), else one value per row the call stands over, and reads as the function's owner (Reader). The
	 * arguments themselves are the call's operands, walked where it stands.
	 */
	#inlined(body: Expr, args: ReadonlyArray<Expr>, c: Context<Top>): void {
		const bound = new Map<string, BoundTo>()
		for (const [position, arg] of args.entries()) {
			const binding = carriedBinding(arg, c.scope, this.#statement.slotOf)
			if (binding !== undefined) {
				bound.set(argumentColumn(position), binding)
			}
		}
		this.expr(body, ownedAt(c, new Map([[argumentsRow, { kind: "own", rows: "many", bound }]])))
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
	readonly slotOf: (n: number) => SlotFill
	readonly level: Isolation
	readonly #keyed = new TupleMap<InstanceKey, number>()
	readonly #templates = new TupleMap<TemplateKey, Template>()
	/** The query CTEs each walk of a query CTE's query in progress reads, the innermost last (Template `nested`). */
	readonly #reading: Array<Array<Nested>> = []
	readonly #queries = new Map<OperandSelect, number>()

	readonly #carried = new Map<OperandSelect, ReadonlyMap<string, BoundTo>>()

	constructor(names: ExtractNames, slotOf: (n: number) => SlotFill, level: Isolation) {
		this.names = names
		this.slotOf = slotOf
		this.level = level
	}

	/**
	 * The columns of a query, named `columns` (or its targets' aliases where none), that carry a binding in every row it
	 * yields (callBinding), each with it, found once per query of the statement: a core's target that carries one
	 * itself, or is a column its conditions equate with one, its WHERE's and its inner joins', through any chain of
	 * their equalities (equalityClosure, the one closure grizzle reads a conjunction's equalities by), a value the call
	 * holds once before any its own rows carry, a column of each own source among them the binding its source carries
	 * there; a UNION's or UNION ALL's where every arm carries the same. A query with a WITH of its own carries none, nor
	 * does any other set operation. A row that carries a binding in a column equals it there, so a read bound to the
	 * column is bound to it, however many rows the query yields: a relation parameter's query at `child = :child` binds
	 * every read joined on its `child` to `:child`, and an input's query binds every read joined on a column of its
	 * arrays to that field of the input.
	 */
	columnBindings(
		q: OperandSelect,
		columns: ReadonlyArray<string>,
		ctes: Ctes
	): ReadonlyMap<string, BoundTo> {
		return this.#carried.getOrInsertComputed(q, () => {
			const targets = q.with === undefined ? this.#targetBindings(q.body, ctes) : undefined
			const out = new Map<string, BoundTo>()
			if (targets === undefined) {
				return out
			}
			const names = columns.length > 0 ? columns : targetNames(q.body)
			for (const [i, name] of names.entries()) {
				const value = targets[i]
				if (name !== undefined && value !== undefined) {
					out.set(name, value)
				}
			}
			return out
		})
	}

	/** The binding each target of a body carries, by its place, where it carries one (columnBindings); none for a body
	 * no target of which can be said to. */
	#targetBindings(body: OperandBody, ctes: Ctes): ReadonlyArray<BoundTo | undefined> | undefined {
		switch (body.kind) {
			case "core": {
				const sources = sourcesOf(body.from)
				const named = new Map(sources.map(({ source }) => namedIn(source, ctes, this)))
				const equalities = [...conjunctsOf(body.where), ...innerConditions(sources)].flatMap(
					(e): ReadonlyArray<readonly [Expr, Expr]> =>
						e.kind === "binary" && e.op === "=" ? [[e.left, e.right]] : []
				)
				const bindingOf = (e: Expr): BoundTo | undefined => carriedBinding(e, named, this.slotOf)
				const once = equalityClosure(equalities, columnName, (e) => {
					const b = callOf(bindingOf(e))
					return b !== undefined && bindingRows(b) === "one"
				})
				const carried = equalityClosure(
					equalities,
					columnName,
					(e) => callOf(bindingOf(e)) !== undefined
				)
				const learned = equalityClosure(equalities, columnName, (e) => bindingOf(e) !== undefined)
				return body.targets.map((t) => {
					const name = columnName(t.expr)
					const anchor =
						name === undefined ? undefined : (once(name) ?? carried(name) ?? learned(name))
					const direct = bindingOf(t.expr)
					const call =
						callOf(direct) ?? (anchor === undefined ? undefined : callOf(bindingOf(anchor)))
					return call ?? direct ?? (anchor === undefined ? undefined : bindingOf(anchor))
				})
			}
			case "select":
				return body.with === undefined ? this.#targetBindings(body.body, ctes) : undefined
			case "setOp": {
				if (body.op !== "UNION" && body.op !== "UNION ALL") {
					return undefined
				}
				const [first, ...rest] = body.arms.map((arm) =>
					arm.kind === "core"
						? this.#targetBindings(arm, ctes)
						: arm.with === undefined
							? this.#targetBindings(arm.body, ctes)
							: undefined
				)
				if (first === undefined || rest.some((arm) => arm === undefined)) {
					return undefined
				}
				return first.map((value, i) =>
					value !== undefined &&
					rest.every((arm) => {
						const other = arm?.[i]
						return other !== undefined && sameBoundTo(other, value)
					})
						? value
						: undefined
				)
			}
		}
	}

	/**
	 * The place of the instance of the query CTE `cte`, which a source names `name`, read at `polarity`, counted or not,
	 * where the site feeds `feeds`: found by its key (InstanceKey), or made from its walk (Template) after the instance
	 * of each query CTE that walk reads, for the same writes, as a walk of its query would have made them, in its order.
	 * Read from the walk of another query CTE's query (`feeds` the site's), it is the place among the query CTEs that
	 * walk reads, which each instance of it resolves, its own walk walked there, where a walk of the reader would have
	 * walked it.
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
				defect("a site feeds the site's writes only in a query CTE's walk")
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
	 * and its probes gating the site's writes.
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
				reader: cte.reader,
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
		defect(
			"a query CTE read outside every core of a CTE's query, where no data-modifying CTE stands"
		)
	}
	return core
}

/**
 * A read's group, from the fields it binds (each FieldBinding's), sorted by field; none where it binds none.
 */
const boundGroup = (bound: ReadonlyArray<FieldBinding>): ReadGroup | undefined => {
	const sorted = bound.toSorted((a, b) => compareStrings(a.field, b.field))
	return isNonEmpty(sorted) ? { bound: sorted } : undefined
}

/**
 * What a column of a source in scope binds a column equal to it to: a stored table's column, the row its source's read
 * finds (BoundTo `column`); an INSERT's met rows' column, one per row; an own source's, the binding it carries there
 * (OwnRows `bound`), else the column itself, one value or one per row as its source holds; none for an unknown name.
 */
const ownBinding = (scope: Scope, table: string, column: string): BoundTo | undefined => {
	const named = scope.get(table)
	if (named === undefined) {
		return undefined
	}
	switch (named.kind) {
		case "stored": {
			const field = named.field(column)
			return field === undefined ? undefined : { kind: "column", of: named, field }
		}
		case "metRows":
			return { kind: "own", alias: table, column, rows: "many" }
		case "own": {
			return named.bound.get(column) ?? { kind: "own", alias: table, column, rows: named.rows }
		}
	}
}

/**
 * The columns of a table source its core's conditions bind, through a projection's renaming (`columns`, none for a
 * table read directly), each by its first equality, in the conditions' order, with a binding the call holds or its own
 * rows carry before one with a column of another stored table's source: with a parameter, one value; with a column of
 * a source the scope names the call's own, the binding it carries there or the column itself; or with a column of
 * another stored table's source, the row that source's read finds (BoundTo `column`).
 */
const bindingsOf = (
	alias: string,
	conditions: ReadonlyArray<Scoped>,
	columns: ReadonlyMap<string, string> | undefined,
	slotOf: (n: number) => SlotFill
): ReadonlyArray<Bound> => {
	const side = (mine: Expr, other: Expr, scope: Scope): ReadonlyArray<Bound> => {
		if (mine.kind !== "column" || mine.table !== alias) {
			return []
		}
		const column = columns === undefined ? mine.column : columns.get(mine.column)
		if (column === undefined) {
			return []
		}
		const value = valueBinding(other, slotOf)
		if (value !== undefined) {
			return [{ column, by: value }]
		}
		if (other.kind !== "column" || other.table === undefined || other.table === alias) {
			return []
		}
		const by = ownBinding(scope, other.table, other.column)
		return by === undefined ? [] : [{ column, by }]
	}
	const out = new Map<string, Bound>()
	const learned = new Map<string, Bound>()
	for (const { expr: e, scope } of conditions) {
		if (e.kind === "binary" && e.op === "=") {
			for (const b of [...side(e.left, e.right, scope), ...side(e.right, e.left, scope)]) {
				;(b.by.kind === "column" ? learned : out).getOrInsert(b.column, b)
			}
		}
	}
	for (const [column, b] of learned) {
		out.getOrInsert(column, b)
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
 * its `rows` name met rows in scope, a met rows source (`metRows`) or a query CTE that holds one whole (namedIn), whose
 * `insert` names a data-modifying CTE of the statement holding an INSERT into the met row's table that proposes their
 * `proposed` alone (`proposesAlone`) and skips a conflicting row by ON CONFLICT DO NOTHING with no target or over columns
 * all among the key. Every row that drives
 * it is then a row the INSERT proposed and did not insert, and every stored row at the key conflicts with it at the
 * arbiter: under a transaction snapshot each such row is visible to the statement or raised 40001 (nodeModifyTable.c
 * ExecCheckTupleVisible). None for any other `met`, which is read by where it stands.
 */
const metSealed = (source: Met, here: Context): ReadonlyArray<string> | undefined => {
	const rows = here.scope.get(source.rows)
	if (rows === undefined || typeof rows === "string" || rows.kind !== "metRows") {
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
	sent: SqlStatement,
	names: ExtractNames,
	slotOf: (n: number) => SlotFill,
	level: Isolation
): StatementFacts => {
	const statement = new Statement(names, slotOf, level)
	const walk = new Walk<undefined>(statement, [])
	walk.statement(sent)
	const relation = (t: ObjectName): string => names.relationOf(t) ?? `?${printObjectName(t)}`
	/**
	 * What a read's column is bound to as its body's facts state it (Binding): a stored table's field resolved to its
	 * source's read among `body`'s; none where no read of the body is that source's, a CTE's query's or another body's.
	 */
	const resolved = (body: Body, by: BoundTo): Binding | undefined => {
		if (by.kind !== "column") {
			return by
		}
		const read = body.places.get(by.of.at)
		return read === undefined ? undefined : { kind: "stored", read, field: by.field }
	}
	/** The fields of `rel` a read's bound columns are, each with what it is bound to, in `body` (resolved); none for a
	 * column of no field, a law column, or a binding its body cannot state. */
	const fields = (
		body: Body,
		rel: string,
		bound: ReadonlyArray<Bound>
	): ReadonlyArray<FieldBinding> =>
		bound.flatMap((b): ReadonlyArray<FieldBinding> => {
			const field = names.fieldOf(rel, b.column)
			const by = resolved(body, b.by)
			return field === undefined || by === undefined ? [] : [{ field, by }]
		})
	/** The relations the statement's DML writes, which a probe of arbitrates. */
	const written = new Set(statement.writes.map((w) => relation(w.table)))
	const readOf = (body: Body, f: Found): Placed => {
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
		const rel = relation(f.table)
		const arbiter =
			f.met !== undefined || (f.context.probe && f.context.reader === "role" && written.has(rel))
		return {
			read: {
				relation: rel,
				mode: modeOf(f.context, arbiter),
				base: baseOf(arbiter),
				probes: f.context.probes,
				own: false,
				group: boundGroup(fields(body, rel, bindingsOf(f.alias, f.conditions, f.columns, slotOf)))
			},
			feeds: f.feeds
		}
	}
	const reads = walk.found.map((f) => readOf(walk, f))
	/** Each query CTE walk's reads, read once for every instance of it (Template). */
	const walked = new Map<Template, ReadonlyArray<Placed>>()
	const readsOf = (t: Template): ReadonlyArray<Placed> =>
		walked.getOrInsertComputed(t, () => t.walk.found.map((f) => readOf(t.walk, f)))
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
					walk,
					rel,
					(a.columns ?? []).map((column): Bound => ({
						column,
						by: a.values.get(column) ?? { kind: "proposed", column }
					}))
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
		defect("an instance resolves every query CTE its walk reads")
	}
	return at
}

/** A body's walk as its facts read it back: every read it found, and the place of each stored table's source's read. */
interface Body {
	readonly found: ReadonlyArray<Found>
	readonly places: ReadonlyMap<StoredAt, number>
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
 * - A read's mode: `arbiter` for a table an EXISTS of the statement's own text probes that its statement writes, an ON
 *   CONFLICT, a MERGE's NOT MATCHED, and the row an arbitration met (a `met` source) wherever it stands, where its
 *   structure proves its statement's INSERT met it (metSealed); else `negated` where its rows reach the statement by their absence (NOT
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
 * - A carrier's read is the call's own rows, its columns' arrays read from the transaction's settings
 *   (write/carriers/carriers.ts carrierRead). A table no relation is read as `?"schema"."name"`, a
 *   schema function no names clear as `?function:"schema"."name"`, and a statement that is no DML, carrier, ANALYZE or
 *   transaction control as `?statement:<kind>`: the certifier refuses each as a relation
 *   it states no fact of. Each object is named as the printer quotes it (sql/print.ts printObjectName), so two names are
 *   one text only where they are one name, as `?every:schema.name` was for `"a.b"."c"` and `"a"."b.c"`, and the
 *   refusal shows it as SQL spells it.
 * - A table read's group is the fields its core's conditions bind (analysis/isolation/facts.ts Binding), the
 *   enclosing cores' included: to a parameter; to a column of a source in scope that is the call's own, the binding it
 *   carries there, a context's field, a relation input's or one its query carries, else the column itself; or, where
 *   no such binding binds the field, to a column of another stored table's source of the same body, the field of the
 *   row that source's read finds. An ON CONFLICT's is its conflict columns', each bound to what its proposed value
 *   carries, else to EXCLUDED's.
 * - A derived table that only renames a relation's columns (projectionOf) reads that relation where it stands, keyed by
 *   the conditions of the core that reads it, through the renaming. A derived table that keeps each row of its one core
 *   as one of its own (rowPreserving) carries each equality over its columns into that core (pushedInto), level by level,
 *   so a group binds through every such layer; any other derived table's reads are keyed by its own conditions alone.
 * - A placeholder binds by what the caller's `slots` says fills it (SlotFill): a declared scalar parameter by its name,
 *   so two placeholders of one parameter, in one statement or two, bind one value; an array of a relation input, read
 *   by an arrays source, binds each read bound to that source's column to the input's field.
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
 * - What the role's installation runs where a statement reaches it is read where it stands, as its owner (Reader), whose
 *   reads no row policy holds: a read of the role's view of a query entry as the view's definition under the read's
 *   conditions (ExtractNames `definitionOf`), a call of a world function as its body at its arguments (`bodyOf`), and a
 *   read of a table the role's own row policy narrows under the policy's predicate as a condition of the read, its USING
 *   (`policyOf`). A policy's WITH CHECK, and its USING over the row an INSERT's ON CONFLICT or RETURNING meets, refuse a
 *   row and keep none from the statement, so no fact states them.
 */
export const memberFacts = (
	name: string,
	statements: NonEmptyReadonlyArray<SqlStatement>,
	names: ExtractNames,
	slots: (statement: number, n: number) => SlotFill,
	level: Isolation
): MemberFacts => ({
	name,
	statements: mapNonEmpty(statements, (s, i) => statementFacts(s, names, (n) => slots(i, n), level))
})
