import { Array as Arr, Option, Order } from "effect"
import type {
	BinaryOperator,
	Cte,
	CteBody,
	Expr,
	FromSource,
	JoinChain,
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
	"mode"
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
	| "from arrays"
	| "from values"
	| "from context"
	| `${"derived" | "function" | "arrays" | "cte"} of no column`
	| "core of no target"
	| "insert of no column"
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
	| "nullif"
	| "subscript"
	| "complement"
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
		case "regclass":
		case "complement":
		case "nullif":
		case "subscript":
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

const fromFeature = (item: FromSource): ReadonlyArray<ShapeFeature> => {
	switch (item.kind) {
		case "table":
		case "enclosing":
			return ["from table"]
		case "cte":
			return ["from cte"]
		case "derived":
			return [
				"from derived",
				...(item.lateral ? (["lateral"] as const) : []),
				...(item.columns.length === 0 ? (["derived of no column"] as const) : [])
			]
		case "function":
			return [
				"from function",
				...(item.lateral ? (["lateral"] as const) : []),
				...(item.columns.length === 0 ? (["function of no column"] as const) : [])
			]
		case "arrays":
			return item.source.kind === "count" ? ["from arrays", "arrays of no column"] : ["from arrays"]
		case "values":
			return ["from values"]
		case "context":
			return ["from context"]
	}
}

/** A set operation's operator once per arm it adds to the first; a parenthesized query arm is a select of its own and
 * counted where the traversal meets it. */
const setOpFeatures = (body: Select["body"]): ReadonlyArray<ShapeFeature> => {
	if (body.kind !== "setOp") {
		return []
	}
	const feature = setOperatorFeature[body.op]
	return Arr.map(Arr.drop(body.arms, 1), () => feature)
}

/** A join chain: one join per step, on a condition or crosswise. */
const joinFeatures = (chain: JoinChain): ReadonlyArray<ShapeFeature> =>
	Arr.map(chain.steps, (step): ShapeFeature => (step.kind === "on" ? "join" : "cross join"))

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
		case "nullif":
		case "subscript":
		case "complement":
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
		case "regclass":
			return []
	}
}

const coreFeatures = (core: SelectCore): ReadonlyArray<ShapeFeature> => [
	...(core.distinct === false
		? []
		: ([core.distinct === true ? "distinct" : "distinct on"] as const)),
	...(core.targets.length === 0 ? (["core of no target"] as const) : []),
	...(core.groupBy.length === 0 ? [] : (["group by"] as const)),
	...(core.having === undefined ? [] : (["having"] as const))
]

const cteFeatures = (cte: Cte): ReadonlyArray<ShapeFeature> => [
	...(cte.materialized === undefined
		? []
		: ([`cte ${materializedFeature[cte.materialized]}`] as const)),
	...(cte.query.kind === "select"
		? cte.columns.length === 0
			? (["cte of no column"] as const)
			: []
		: ([`cte ${cte.query.kind}`] as const)),
	...(insertsNoColumn(cte.query) ? (["insert of no column"] as const) : [])
]

/** Whether a write inserts a row of no column: an INSERT that lists none, or a MERGE's INSERT DEFAULT VALUES. */
const insertsNoColumn = (statement: SqlStatement): boolean =>
	statement.kind === "insert"
		? statement.columns.length === 0
		: statement.kind === "merge" &&
			Arr.some(statement.whens, (w) => w.action.kind === "insertDefault")

const selectFeatures = (s: Select): ReadonlyArray<ShapeFeature> => [
	...(s.with === undefined
		? []
		: ([
				s.with.recursive ? "with recursive" : "with",
				...Arr.flatMap(s.with.ctes, cteFeatures)
			] as const)),
	...setOpFeatures(s.body),
	...(s.orderBy.length === 0 ? [] : (["order by"] as const)),
	...(s.limit === undefined ? [] : [bound("limit", s.limit)]),
	...(s.offset === undefined ? [] : [bound("offset", s.offset)])
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
 * - FROM items by kind (`from table`, `from derived`, `from arrays`, `from values`, `join`, `cross join`) and
 *   `lateral` for a lateral derived table or function;
 * - the zero-width forms PostgreSQL spells by absence: a derived table, function, input arrays or query CTE of no column
 *   (`derived of no column`, ...), a `core of no target`, an `insert of no column`;
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
		fromSource: (item) => {
			add(fromFeature(item))
			return item
		},
		joins: (chain) => {
			add(joinFeatures(chain))
			return chain
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
	if (insertsNoColumn(statement)) {
		add(["insert of no column"])
	}
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
