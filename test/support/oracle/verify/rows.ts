import { Array as Arr, Option } from "effect"
import {
	type Cte,
	type Expr,
	type FromItem,
	type FromSource,
	isSetBody,
	isSetQuery,
	type OperandSelect,
	type OrderItem,
	type SelectCore,
	type SqlStatement
} from "#compiler/sql/ast.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"

/**
 * The aggregates whose result no repeated input row changes: a fold of them over rows that may repeat equals its fold
 * over their set.
 */
const repeatBlind: ReadonlySet<string> = new Set([
	"min",
	"max",
	"bool_and",
	"bool_or",
	"bit_and",
	"bit_or",
	"every",
	"range_agg"
])

/** The builtin aggregates whose result a repeated input row changes, unless the call is DISTINCT. */
const repeatCounting: ReadonlySet<string> = new Set([
	"count",
	"sum",
	"avg",
	"array_agg",
	"jsonb_agg",
	"jsonb_object_agg",
	"json_agg",
	"string_agg",
	"mode",
	"percentile_cont",
	"percentile_disc",
	"stddev",
	"stddev_pop",
	"stddev_samp",
	"variance",
	"var_pop",
	"var_samp"
])

/** A function call of an expression: an aggregate, a window call or a plain call. */
type CallExpr = Extract<Expr, { readonly kind: "call" }>

/** Whether some call of an expression, outside its nested queries (each a core of its own), satisfies `test`. */
const anyCall = (e: Expr, test: (call: CallExpr) => boolean): boolean => {
	const any = (list: ReadonlyArray<Expr>): boolean => Arr.some(list, (x) => anyCall(x, test))
	const ordered = (items: ReadonlyArray<OrderItem>): boolean =>
		any(Arr.map(items, (item) => item.expr))
	switch (e.kind) {
		case "column":
		case "excluded":
		case "returning":
		case "param":
		case "literal":
		case "exists":
		case "subquery":
		case "array":
		case "mergeAction":
		case "domainValue":
		case "plVar":
		case "plSpecial":
		case "field":
		case "user":
		case "regclass":
			return false
		case "cast":
		case "collate":
		case "negate":
		case "not":
		case "isTrue":
		case "complement":
		case "inQuery":
			return anyCall(e.expr, test)
		case "nullif":
			return any([e.expr, e.absent])
		case "subscript":
			return any([e.array, e.index])
		case "binary":
			return any([e.left, e.right])
		case "and":
		case "or":
		case "greatest":
		case "least":
		case "coalesce":
			return any(e.args)
		case "between":
			return any([e.expr, e.low, e.high])
		case "inList":
			return any([e.expr, ...e.list])
		case "row":
			return any(e.items)
		case "case":
			return (
				(e.operand !== undefined && anyCall(e.operand, test)) ||
				Arr.some(e.whens, (branch) => any([branch.when, branch.result])) ||
				anyCall(e.else, test)
			)
		case "call":
			return (
				test(e) ||
				any(e.args) ||
				(e.star
					? e.filter !== undefined && anyCall(e.filter, test)
					: ordered(e.orderBy) || ordered(e.withinGroup)) ||
				(e.over !== undefined && (any(e.over.partitionBy) || ordered(e.over.orderBy)))
			)
	}
}

/** Whether a call is of a builtin aggregate, not windowed. */
const isAggregate = (call: CallExpr): boolean =>
	call.over === undefined &&
	(call.star ||
		(call.fn.kind === "builtin" &&
			(repeatCounting.has(call.fn.name) || repeatBlind.has(call.fn.name))))

/** Whether a call counts how many times a row repeats: a window call, or an aggregate a repeated row changes. */
const countsRepeat = (call: CallExpr): boolean =>
	call.over !== undefined ||
	call.star ||
	(call.fn.kind === "builtin" && !call.distinct && repeatCounting.has(call.fn.name))

const countsRepeats = (e: Expr): boolean => anyCall(e, countsRepeat)

/** Whether a core's rows change with how many times a row of its FROM repeats, beyond which rows it holds. */
const observesRepeats = (c: SelectCore): boolean =>
	Arr.some(c.targets, (t) => countsRepeats(t.expr)) ||
	(c.having !== undefined && countsRepeats(c.having))

/**
 * What a core asks of the rows its FROM reads: a set when its proof is a claim about those rows (`keyed`, `input`,
 * `certified`) or when its expressions count repeats; otherwise rows that may repeat, which it makes a set (DISTINCT,
 * GROUP BY, one row) or passes on as an operand.
 */
const fromNeed = (c: SelectCore): "set" | "operand" =>
	(c.distinct === false && (c.rows === "keyed" || c.rows === "input" || c.rows === "certified")) ||
	observesRepeats(c)
		? "set"
		: "operand"

/** The sources of a FROM item, a join chain's each. */
const sourcesOf = (item: FromItem): ReadonlyArray<FromSource> =>
	item.kind === "joins" ? [item.first, ...Arr.map(item.steps, (s) => s.source)] : [item]

const isLiteralOne = (e: Expr | undefined): boolean =>
	e?.kind === "literal" && e.value.kind === "int" && e.value.value === 1n

/** Whether a query keeps at most one row of its body: LIMIT 1 and no OFFSET. */
const firstRowOnly = (q: OperandSelect): boolean => isLiteralOne(q.limit) && q.offset === undefined

/**
 * The expression a derived table of a core's FROM delivers at the column `e` reads, when that table's query is one core:
 * undefined for any other expression.
 */
const deliveredAt = (c: SelectCore, e: Expr): Expr | undefined => {
	if (e.kind !== "column" || e.table === undefined) {
		return undefined
	}
	const { table, column } = e
	const source = Arr.findFirst(
		Arr.flatMap(c.from, sourcesOf),
		(s) => s.kind === "derived" && s.alias === table
	)
	if (Option.isNone(source) || source.value.kind !== "derived") {
		return undefined
	}
	const { columns, query } = source.value
	if (query.body.kind !== "core") {
		return undefined
	}
	const targets = query.body.targets
	const at =
		columns.length > 0
			? Arr.findFirstIndex(columns, (name) => name === column)
			: Arr.findFirstIndex(targets, (t) => t.alias === column)
	return Option.isSome(at) ? targets[at.value]?.expr : undefined
}

/**
 * Whether a source holds at most one row: a context source, or a derived table whose query is one set core of constant
 * rows or of a shape that shows one row (oneRowShape), as an operation's operand binding read laterally does (total.ts
 * bindOperands).
 */
const atMostOneRow = (s: FromSource): boolean =>
	s.kind === "context" ||
	(s.kind === "derived" &&
		isSetQuery(s.query) &&
		s.query.body.kind === "core" &&
		(Arr.every(s.query.body.targets, (t) => t.expr.kind === "literal") ||
			oneRowShape(s.query.body)))

/**
 * Whether a core shows by its own shape that it holds at most one row: no FROM; a FROM of sources of at most one row
 * each, a context source, a set of constant rows or a derived table of one row by its own shape; aggregates and no
 * GROUP BY; or a GROUP BY of constants, each a literal a derived table of its FROM delivers, one group at most.
 */
const oneRowShape = (c: SelectCore): boolean => {
	const aggregates = Arr.some(c.targets, (t) => anyCall(t.expr, isAggregate))
	return (
		Arr.every(Arr.flatMap(c.from, sourcesOf), atMostOneRow) ||
		(aggregates && c.groupBy.length === 0) ||
		(c.groupBy.length > 0 && Arr.every(c.groupBy, (g) => deliveredAt(c, g)?.kind === "literal"))
	)
}

/** Whether a core shows by its own shape that each group is one row: grouped, each GROUP BY expression a target. */
const groupedShape = (c: SelectCore): boolean => {
	const targets = new Set(Arr.map(c.targets, (t) => printExpr(t.expr)))
	return c.groupBy.length > 0 && Arr.every(c.groupBy, (g) => targets.has(printExpr(g)))
}

/** A FROM source read by a reader that needs a set or takes rows that may repeat. */
interface Read {
	readonly need: "set" | "operand"
	readonly source: FromSource
}

/** Each source of `items`, read under `need`. */
const appendReads = (
	reads: Array<Read>,
	need: "set" | "operand",
	items: ReadonlyArray<FromItem>
): void => {
	for (const item of items) {
		for (const source of sourcesOf(item)) {
			reads.push({ need, source })
		}
	}
}

/**
 * The FROM items a write matches its target rows by. A write changes each target row once whatever matches it, so
 * they may repeat rows.
 */
const writeSources = (statement: SqlStatement): ReadonlyArray<FromItem> => {
	if (statement.kind === "update") {
		return statement.from
	}
	if (statement.kind === "delete") {
		return statement.using
	}
	return statement.kind === "merge" ? [statement.using] : []
}

/**
 * Every place a statement's rows could repeat where a set is required (rule 0: every fragment delivers a set, without
 * a duplicate elimination only where a proof says its rows are distinct or where it is the operand of an operator that
 * makes it a set, sql/ast.ts SetCore). The AST's types keep a plain core or a plain UNION ALL out of every position a set
 * must stand at but the two the types leave open, a derived table and a CTE, which a reader may take rows from that
 * repeat only when it makes them a set; so this checks:
 *
 * - every derived table and query CTE whose rows may repeat is read only by a core that keeps no repeat it reads and
 *   counts none (fromNeed), or by a write, which changes each target row once whatever matches it;
 * - a LIMIT or OFFSET over rows that may repeat is LIMIT 1 alone, which keeps one of equal rows;
 * - a core claiming one row shows it by its shape (no FROM, aggregates and no GROUP BY) or is the body of a query whose
 *   LIMIT is 1, and a UNION ALL claiming one row is such a body;
 * - a core claiming its groups shows each GROUP BY expression among its targets.
 *
 * The claims `keyed`, `certified` and `input` say what no shape shows; the physical analysis and the codec state them,
 * and the result oracle holds them to the rows PostgreSQL returns. A statement other than a query, a write or a view's
 * definition holds no query and is not entered.
 */
export const rowsViolations = (statement: SqlStatement): ReadonlyArray<string> => {
	const out: Array<string> = []
	const ctes = new Map<string, Cte>()
	const reads: Array<Read> = []
	const limited = new Set<unknown>()
	const claimsOneRow: Array<SelectCore> = []
	const withCtes = (w: { readonly ctes: ReadonlyArray<Cte> } | undefined): void => {
		for (const cte of w?.ctes ?? []) {
			ctes.set(cte.name, cte)
		}
	}
	if (
		statement.kind === "insert" ||
		statement.kind === "update" ||
		statement.kind === "delete" ||
		statement.kind === "merge"
	) {
		withCtes(statement.with)
	}
	appendReads(reads, "operand", writeSources(statement))
	transformStatement(statement, {
		...identityHooks,
		core: (c) => {
			appendReads(reads, fromNeed(c), c.from)
			if (c.distinct === false && c.rows === "oneRow" && !oneRowShape(c)) {
				claimsOneRow.push(c)
			}
			if (c.distinct === false && c.rows === "grouped" && !groupedShape(c)) {
				out.push("a core claims its groups, and a GROUP BY expression is none of its targets")
			}
			return c
		},
		select: (s) => {
			withCtes(s.with)
			const body = s.body
			if (firstRowOnly(s)) {
				limited.add(body)
			} else if (!isSetBody(body) && (s.limit !== undefined || s.offset !== undefined)) {
				out.push(
					"a LIMIT or OFFSET counts the rows of a body that may repeat them: a bound reads a set, or is LIMIT 1 alone"
				)
			}
			if (
				body.kind === "setOp" &&
				body.op === "UNION ALL" &&
				body.rows === "oneRow" &&
				!firstRowOnly(s)
			) {
				out.push("a UNION ALL claims one row outside a query whose LIMIT is 1")
			}
			return s
		}
	})
	for (const c of claimsOneRow) {
		if (!limited.has(c)) {
			out.push(
				"a core claims one row, and holds a FROM, no aggregate without GROUP BY, and no LIMIT 1 over it"
			)
		}
	}
	for (const read of reads) {
		if (read.need === "operand") {
			continue
		}
		const { source } = read
		if (source.kind === "derived" && !isSetQuery(source.query)) {
			out.push(
				`the derived table ${source.alias} may repeat rows, and a core whose rows its repeats change reads it: a key claim, an aggregate or a window reads a set`
			)
		}
		if (source.kind === "cte") {
			const cte = ctes.get(source.name)
			if (cte?.query.kind === "select" && !isSetQuery(cte.query)) {
				out.push(
					`the CTE ${source.name} may repeat rows, and a core whose rows its repeats change reads it: a key claim, an aggregate or a window reads a set`
				)
			}
		}
	}
	return out
}
