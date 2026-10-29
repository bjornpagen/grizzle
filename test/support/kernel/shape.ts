import { Array as Arr, Option, Order } from "effect"
import type {
	BinaryOperator,
	Cte,
	CteBody,
	Expr,
	FromItem,
	Select,
	SelectCore,
	SetOperator,
	SqlStatement
} from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"

/** The role of a predicate's operand: what it is once casts and collations are seen through. */
type Role = "column" | "param" | "literal" | "subquery" | "expression"

/** The builtin functions a shape names as aggregates; every other function is a call. */
const aggregateNames = [
	"count",
	"sum",
	"avg",
	"min",
	"max",
	"bool_and",
	"bool_or",
	"range_agg",
	"array_agg",
	"jsonb_agg",
	"percentile_disc",
	"percentile_cont",
	"mode",
	"regr_slope",
	"regr_sxx"
] as const
export type Aggregate = (typeof aggregateNames)[number]

/** What bounds a LIMIT or OFFSET. */
type BoundRole = "param" | "literal" | "expression"

/** Every structural feature a statement's shape may hold. */
export type ShapeFeature =
	| "from table"
	| "from cte"
	| "from derived"
	| "from function"
	| "from recordset"
	| "from values"
	| "from context"
	| "join"
	| "cross join"
	| "lateral"
	| `predicate ${BinaryOperator} ${Role} ${Role}`
	| "count(*)"
	| `window ${string}`
	| `aggregate ${Aggregate}`
	| `call ${string}`
	| "exists"
	| "not exists"
	| "in query"
	| "not in query"
	| "in list"
	| "not in list"
	| "scalar subquery"
	| "array subquery"
	| "between"
	| "not between"
	| "case"
	| "greatest"
	| "least"
	| "distinct"
	| "distinct on"
	| "group by"
	| "having"
	| "with"
	| "with recursive"
	| `cte ${Lowercase<NonNullable<Cte["materialized"]>>}`
	| `cte ${Exclude<CteBody["kind"], "select">}`
	| Lowercase<SetOperator>
	| "order by"
	| `limit ${BoundRole}`
	| `offset ${BoundRole}`

/** A statement's structural features, each with how often it occurs. */
export interface Shape {
	readonly statement: SqlStatement["kind"]
	readonly counts: ReadonlyMap<ShapeFeature, number>
}

const setOperatorFeature = {
	UNION: "union",
	"UNION ALL": "union all",
	INTERSECT: "intersect",
	EXCEPT: "except"
} as const satisfies { readonly [O in SetOperator]: Lowercase<O> }

const materializedFeature = {
	MATERIALIZED: "materialized",
	"NOT MATERIALIZED": "not materialized"
} as const satisfies { readonly [M in NonNullable<Cte["materialized"]>]: Lowercase<M> }

const roleOf = (e: Expr): Role => {
	switch (e.kind) {
		case "cast":
		case "collate":
			return roleOf(e.expr)
		case "column":
		case "excluded":
		case "returning":
			return "column"
		case "param":
			return "param"
		case "literal":
			return "literal"
		case "subquery":
			return "subquery"
		case "binary":
		case "negate":
		case "and":
		case "or":
		case "not":
		case "isTrue":
		case "between":
		case "inList":
		case "inQuery":
		case "exists":
		case "array":
		case "row":
		case "case":
		case "call":
		case "greatest":
		case "least":
		case "mergeAction":
		case "domainValue":
		case "plVar":
		case "plSpecial":
		case "field":
		case "user":
			return "expression"
	}
}

const bound = (clause: "limit" | "offset", e: Expr): ShapeFeature => {
	switch (roleOf(e)) {
		case "param":
			return `${clause} param`
		case "literal":
			return `${clause} literal`
		case "column":
		case "subquery":
		case "expression":
			return `${clause} expression`
	}
}

const fromFeature = (item: FromItem): ReadonlyArray<ShapeFeature> => {
	switch (item.kind) {
		case "table":
		case "enclosing":
			return ["from table"]
		case "cte":
			return ["from cte"]
		case "derived":
			return item.lateral ? ["from derived", "lateral"] : ["from derived"]
		case "function":
			return item.lateral ? ["from function", "lateral"] : ["from function"]
		case "recordset":
			return ["from recordset"]
		case "values":
			return ["from values"]
		case "context":
			return ["from context"]
		case "join":
			return ["join"]
		case "crossJoin":
			return ["cross join"]
	}
}

const exprFeature = (e: Expr): ReadonlyArray<ShapeFeature> => {
	switch (e.kind) {
		case "binary":
			return [`predicate ${e.op} ${roleOf(e.left)} ${roleOf(e.right)}`]
		case "call": {
			const name = e.fn.kind === "builtin" ? e.fn.name : `${e.fn.schema}.${e.fn.name}`
			if (e.star) {
				return [e.over === undefined ? "count(*)" : "window count(*)"]
			}
			if (e.over !== undefined) {
				return [`window ${name}`]
			}
			const aggregate =
				e.fn.kind === "builtin"
					? Option.getOrUndefined(Arr.findFirst(aggregateNames, (a) => a === name))
					: undefined
			return [aggregate === undefined ? `call ${name}` : `aggregate ${aggregate}`]
		}
		case "exists":
			return [e.not ? "not exists" : "exists"]
		case "inQuery":
			return [e.not ? "not in query" : "in query"]
		case "inList":
			return [e.not ? "not in list" : "in list"]
		case "subquery":
			return ["scalar subquery"]
		case "array":
			return ["array subquery"]
		case "between":
			return [e.not ? "not between" : "between"]
		case "case":
			return ["case"]
		case "greatest":
		case "least":
			return [e.kind]
		case "column":
		case "excluded":
		case "returning":
		case "param":
		case "literal":
		case "cast":
		case "collate":
		case "negate":
		case "and":
		case "or":
		case "not":
		case "isTrue":
		case "row":
		case "mergeAction":
		case "domainValue":
		case "plVar":
		case "plSpecial":
		case "field":
		case "user":
			return []
	}
}

const coreFeatures = (core: SelectCore): ReadonlyArray<ShapeFeature> => [
	...(core.distinct === false
		? []
		: ([core.distinct === true ? "distinct" : "distinct on"] as const)),
	...(core.groupBy.length === 0 ? [] : (["group by"] as const)),
	...(core.having === undefined ? [] : (["having"] as const))
]

const cteFeatures = (cte: Cte): ReadonlyArray<ShapeFeature> => [
	...(cte.materialized === undefined
		? []
		: ([`cte ${materializedFeature[cte.materialized]}`] as const)),
	...(cte.query.kind === "select" ? [] : ([`cte ${cte.query.kind}`] as const))
]

const selectFeatures = (s: Select): ReadonlyArray<ShapeFeature> => [
	...(s.with === undefined
		? []
		: ([
				s.with.recursive ? "with recursive" : "with",
				...Arr.flatMap(s.with.ctes, cteFeatures)
			] as const)),
	...(s.body.kind === "setOp" ? setOps(s.body.op, s.body.left, s.body.right) : []),
	...(s.orderBy.length === 0 ? [] : (["order by"] as const)),
	...(s.limit === undefined ? [] : [bound("limit", s.limit)]),
	...(s.offset === undefined ? [] : [bound("offset", s.offset)])
]

/**
 * A chain of set operations, each operator once per arm it joins; a parenthesized query arm is a select of its own
 * and counted where the traversal meets it.
 */
const setOps = (
	op: SetOperator,
	left: Select["body"],
	right: Select["body"]
): ReadonlyArray<ShapeFeature> => [
	setOperatorFeature[op],
	...(left.kind === "setOp" ? setOps(left.op, left.left, left.right) : []),
	...(right.kind === "setOp" ? setOps(right.op, right.left, right.right) : [])
]

/**
 * The shape of a statement.
 *
 * The structural shape of an SQL statement: what a test asserts about emitted SQL instead of its text.
 *
 * emitted SQL is checked by its structure, read off the typed AST (sql/ast.ts) the compiler built, never by a
 * regular expression over its text. Text matches break on every harmless change of spelling, aliasing or order and
 * still miss the change that matters. The text is asserted only where the text is the contract, as for migration DDL
 * a person reviews.
 *
 * A statement's shape is the multiset of its structural features, each named in words:
 *
 * - FROM items by kind (`from table`, `from derived`, `from recordset`, `from values`, `join`, `cross join`) and
 *   `lateral` for a lateral derived table or function;
 * - set operations (`union all`, `except`, ...), WITH (`with`, `with recursive`, `cte materialized`, a data-modifying
 *   `cte insert`), `distinct`, `distinct on`, `group by`, `having`, `order by`;
 * - LIMIT and OFFSET by what bounds them (`limit param`, `limit literal`, `limit expression`);
 * - calls by function: `aggregate sum`, `count(*)`, `window row_number`, `call abs`, a qualified extension function
 *   by its schema and name;
 * - predicates by operator and the roles of their operands (`predicate = column param`), a cast or collation seen
 *   through to the operand it wraps;
 * - subqueries by form: `exists`, `not exists`, `in query`, `scalar subquery`, `array subquery`.
 *
 * Nothing allocated is a feature: no alias, no table or column name, no parameter number, no literal value, so the
 * shape of a statement is stable across every renaming that keeps its structure. Shapes are semantic features too, so
 * a suite may note them into its feature registry. The features are a closed union, `ShapeFeature`, so a misspelt
 * feature is a compile error.
 *
 * The walk is sql/transform.ts's traversal, every hook returning its node unchanged, so the shape sees every node of
 * every statement form the compiler emits, and a new node kind is reached as soon as the traversal reaches it.
 */
export const shapeOf = (statement: SqlStatement): Shape => {
	const counts = new Map<ShapeFeature, number>()
	const add = (features: ReadonlyArray<ShapeFeature>) => {
		for (const feature of features) {
			counts.set(feature, (counts.get(feature) ?? 0) + 1)
		}
	}
	transformStatement(statement, {
		...identityHooks,
		expr: (e) => {
			add(exprFeature(e))
			return e
		},
		fromItem: (item) => {
			add(fromFeature(item))
			return item
		},
		core: (core) => {
			add(coreFeatures(core))
			return core
		},
		select: (s) => {
			add(selectFeatures(s))
			return s
		}
	})
	return { statement: statement.kind, counts }
}

/** How often a feature occurs in a shape. */
export const featureCount = (shape: Shape, feature: ShapeFeature): number =>
	shape.counts.get(feature) ?? 0

export const has = (shape: Shape, feature: ShapeFeature): boolean =>
	featureCount(shape, feature) > 0

/** The distinct features of a shape, sorted: what a feature registry notes. */
export const shapeFeatures = (shape: Shape): ReadonlyArray<ShapeFeature> =>
	Arr.sort([...shape.counts.keys()], Order.String)
