import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { Array as Arr, Record as Rec } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import {
	builtinFunctions,
	type CteBody,
	type Expr,
	type FromItem,
	type FromSource,
	type FunctionCall,
	type OperandBody,
	type OperandSelect,
	type SelectCore,
	type SetOperation,
	type SqlStatement,
	type With
} from "#compiler/sql/ast.ts"
import { printedOnce } from "#compiler/sql/print-once.ts"

/**
 * The names PostgreSQL 19's planner asks for as it plans a statement, read off the statement as it is printed
 * (print-once.ts printedOnce), and the work its naming does.
 *
 * PostgreSQL 19 names every sub-query it plans apart (planner.c choose_plan_name): a CTE by its name (subselect.c
 * SS_process_ctes), a FROM sub-query it cannot pull up by its alias (allpaths.c set_subquery_pathlist), a sublink it
 * cannot pull up by its kind, `exists`, `array`, `expr` or `any`, always numbered (subselect.c make_subplan), the hashed
 * alternative of a correlated EXISTS by `exists_to_any`, numbered, and a leaf of a set operation it cannot flatten by
 * `setop`, numbered (prepunion.c recurse_set_operations). A sub-query without an alias, a set operation's leaf or an
 * INSERT's source, is named by PostgreSQL 19's fixed `unnamed_subquery` (parse_relation.c), so every such one it plans
 * apart asks a name another has. Each ask scans every name the statement's planning has used, and a name already used,
 * or one always numbered, then scans them again for `<name>_1`, `<name>_2`, ... until one is new: n asks of one name
 * over k names used cost about n²k/4 string comparisons, the larger part of a megabyte write's planning (PRINTONCE4:
 * start/7 of metis's student login asked 2,692 names, 530 of them `unnamed_subquery`, 321 `exists`, 388 `setop`, about
 * 288 million comparisons and 1,150 of its 1,480 ms).
 *
 * The model follows PostgreSQL 19's rules: a FROM sub-query is pulled up when it is simple (prepjointree.c
 * is_simple_subquery: no set operation, aggregate, window function, set-returning target, GROUP BY, HAVING, ORDER BY,
 * DISTINCT, LIMIT, OFFSET or WITH, and no VOLATILE call among its targets); a UNION ALL is flattened into an append
 * relation (is_simple_union_all, flatten_simple_union_all), whose leaf is pulled up only when it is simple and, once its
 * own simple sub-queries are pulled up into it, reads one relation and filters none (is_safe_append_member), any other
 * leaf planned apart as `unnamed_subquery`; any other set operation plans each leaf apart as `setop`; an EXISTS that is
 * a conjunct of a WHERE or of an inner join's ON, over a query with a FROM, no WITH, set operation, aggregate, window
 * function, HAVING or OFFSET, whose WHERE reads the outer row, calls nothing VOLATILE, and whose FROM does not read the
 * outer row, is pulled up into a semi- or anti-join (subselect.c convert_EXISTS_sublink_to_join), every other sublink
 * planned apart. It is the planner's naming as its rules state it, read where they read the statement, so a column's
 * types (is_simple_union_all_recurse's) are taken to agree, as every statement grizzle prints casts them to.
 */

/**
 * A name PostgreSQL's planner asks for: its text, whether it is always numbered (choose_plan_name's always_number), what
 * it names (`site`: a CTE, a FROM sub-query, an append relation's leaf, an INSERT's source, a sublink, a hashed EXISTS's
 * second plan, a set operation's leaf) and the sub-query it plans under it.
 */
export interface AskedName {
	readonly name: string
	readonly numbered: boolean
	readonly site: "cte" | "subquery" | "leaf" | "insertSource" | "sublink" | "hashed" | "setop"
	readonly planned: unknown
}

/** The fixed name PostgreSQL 19 gives a sub-query without an alias: a set operation's leaf, an INSERT's source. */
export const unaliasedName = "unnamed_subquery"

/** Every name PostgreSQL's planner asks for as it plans `statement`, as it is printed, in about the order it asks them. */
export const plannerNamesOf = (statement: SqlStatement): ReadonlyArray<AskedName> => {
	const printed = printedOnce(statement)
	const asked: Array<AskedName> = []
	new Planning(asked).statement(printed)
	return asked
}

/** The sublink kinds of an expression: each planned apart under its always-numbered name unless pulled up. */
type Sublink = Extract<Expr, { readonly kind: "exists" | "subquery" | "array" | "inQuery" }>

/** The values a node of the AST as plain data holds: a list's items, a record's fields' values, a scalar none. */
const childrenOf = (e: unknown): ReadonlyArray<unknown> =>
	Arr.isArray(e) ? e : isRecord(e) ? Rec.values(e) : []

const sublinkName: { readonly [K in Sublink["kind"]]: string } = {
	exists: "exists",
	subquery: "expr",
	array: "array",
	inQuery: "any"
}

const isSublink = (value: unknown): value is Sublink =>
	typeof value === "object" &&
	value !== null &&
	"kind" in value &&
	"query" in value &&
	(value.kind === "exists" ||
		value.kind === "subquery" ||
		value.kind === "array" ||
		value.kind === "inQuery")

/** The sublinks an expression holds at its own level: none inside another sublink's query. */
const sublinksOf = (e: unknown): ReadonlyArray<Sublink> => {
	const out: Array<Sublink> = []
	const walk = (x: unknown): void => {
		if (isSublink(x)) {
			out.push(x)
			if (x.kind === "inQuery") {
				walk(x.expr)
			}
		} else if (
			!(typeof x === "object" && x !== null && "body" in x && "kind" in x && x.kind === "select")
		) {
			for (const y of childrenOf(x)) {
				walk(y)
			}
		}
	}
	walk(e)
	return out
}

/** Whether a node of the AST as plain data is a call. */
const isCall = (value: unknown): value is FunctionCall =>
	typeof value === "object" &&
	value !== null &&
	"kind" in value &&
	value.kind === "call" &&
	"fn" in value

/** Whether an expression calls a VOLATILE function at its own level or in a query it holds (contain_volatile_functions). */
const callsVolatile = (e: unknown): boolean =>
	(isCall(e) &&
		(e.fn.kind === "qualified" ? e.fn.volatility : builtinFunctions[e.fn.name].volatility) ===
			"VOLATILE") ||
	Arr.some(childrenOf(e), callsVolatile)

/** Whether a call aggregates or windows: a builtin of rows' reach, or any call OVER a window. */
const aggregatesOrWindows = (e: unknown): boolean =>
	!isSublink(e) &&
	((isCall(e) &&
		(e.over !== undefined ||
			(e.fn.kind === "builtin" && builtinFunctions[e.fn.name].reach === "rows"))) ||
		Arr.some(childrenOf(e), aggregatesOrWindows))

/** The conjuncts of a WHERE or ON: its AND's arguments, flattened. */
const conjunctsOf = (e: Expr | undefined): ReadonlyArray<Expr> =>
	e === undefined ? [] : e.kind === "and" ? Arr.flatMap(e.args, (a) => conjunctsOf(a)) : [e]

/** The FROM sources of a FROM list, a join chain's in order. */
const sourcesOf = (from: ReadonlyArray<FromItem>): ReadonlyArray<FromSource> =>
	Arr.flatMap(from, (item) =>
		item.kind === "joins" ? [item.first, ...Arr.map(item.steps, (s) => s.source)] : [item]
	)

/** Every alias a query defines anywhere in it: the aliases it, its FROM sub-queries and its sublinks' queries read by. */
const definedAliases = (e: unknown): ReadonlySet<string> => {
	const out = new Set<string>()
	const walk = (x: unknown): void => {
		if (typeof x === "object" && x !== null && "kind" in x) {
			if (typeof x.kind === "string" && "alias" in x && typeof x.alias === "string") {
				out.add(x.alias)
			}
			if (x.kind === "cte" && "name" in x && typeof x.name === "string" && !("query" in x)) {
				out.add(x.name)
			}
		}
		for (const y of childrenOf(x)) {
			walk(y)
		}
	}
	walk(e)
	return out
}

/** Whether `e` reads a column of an alias not in `inner`: a reference to the outer row. */
const readsOuter = (e: unknown, inner: ReadonlySet<string>): boolean => {
	if (typeof e === "object" && e !== null && "kind" in e) {
		if (e.kind === "column" && "table" in e && typeof e.table === "string" && !inner.has(e.table)) {
			return true
		}
		if (e.kind === "met" && "rows" in e && typeof e.rows === "string" && !inner.has(e.rows)) {
			return true
		}
	}
	return Arr.some(childrenOf(e), (x) => readsOuter(x, inner))
}

/** A query whose body is one core and which states no WITH, ORDER BY, LIMIT or OFFSET. */
const plainCore = (q: OperandSelect): SelectCore | undefined => {
	if (
		q.with !== undefined ||
		q.orderBy.length > 0 ||
		q.limit !== undefined ||
		q.offset !== undefined
	) {
		return undefined
	}
	return q.body.kind === "core" ? q.body : q.body.kind === "select" ? plainCore(q.body) : undefined
}

/** Whether a core is simple (is_simple_subquery): no DISTINCT, GROUP BY, HAVING, aggregate, window or VOLATILE target. */
const simpleCore = (c: SelectCore): boolean =>
	c.distinct === false &&
	c.groupBy.length === 0 &&
	c.having === undefined &&
	!aggregatesOrWindows(c.targets) &&
	!callsVolatile(c.targets)

/** A FROM sub-query PostgreSQL pulls up into its reader: a simple plain core. */
const pulledUp = (q: OperandSelect): SelectCore | undefined => {
	const c = plainCore(q)
	return c !== undefined && simpleCore(c) ? c : undefined
}

/** Whether a body is a tree of UNION ALL alone (is_simple_union_all_recurse, column types taken to agree). */
const unionAllTree = (body: OperandBody): body is SetOperation =>
	body.kind === "setOp" && body.op === "UNION ALL"

/** The leaves of a UNION ALL tree: each arm, an arm that is itself a UNION ALL (a parenthesized one too) by its leaves. */
const unionAllLeaves = (op: SetOperation): ReadonlyArray<OperandBody> =>
	Arr.flatMap(op.arms, (arm): ReadonlyArray<OperandBody> => {
		if (arm.kind === "select" && plainBody(arm) !== undefined) {
			const inner = plainBody(arm)
			return inner !== undefined && unionAllTree(inner) ? unionAllLeaves(inner) : [arm]
		}
		return [arm]
	})

/** A parenthesized query's body where it states no WITH, ORDER BY, LIMIT or OFFSET. */
const plainBody = (q: OperandSelect): OperandBody | undefined =>
	q.with === undefined && q.orderBy.length === 0 && q.limit === undefined && q.offset === undefined
		? q.body
		: undefined

/**
 * Whether a UNION ALL leaf is pulled up into its append relation: simple, and, its own simple FROM sub-queries pulled up
 * into it, reading one relation and filtering none (is_safe_append_member, checked again after the pull-up).
 */
const safeLeaf = (leaf: OperandBody): boolean => {
	const c = leaf.kind === "core" ? leaf : leaf.kind === "select" ? plainCore(leaf) : undefined
	if (c === undefined || !simpleCore(c)) {
		return false
	}
	return flattensToOne(c)
}

/** Whether a core, its simple FROM sub-queries pulled up, reads at most one relation and filters none. */
const flattensToOne = (c: SelectCore): boolean => {
	if (c.where !== undefined) {
		return false
	}
	if (c.from.length === 0) {
		return true
	}
	const [only, ...rest] = c.from
	if (rest.length > 0 || only === undefined || only.kind === "joins") {
		return false
	}
	if (only.kind === "derived") {
		const inner = pulledUp(only.query)
		return inner === undefined ? true : flattensToOne(inner)
	}
	return true
}

class Planning {
	readonly #asked: Array<AskedName>
	constructor(asked: Array<AskedName>) {
		this.#asked = asked
	}

	readonly #ask = (
		name: string,
		numbered: boolean,
		site: AskedName["site"],
		planned: unknown
	): void => {
		this.#asked.push({ name, numbered, site, planned })
	}

	statement(s: SqlStatement): void {
		switch (s.kind) {
			case "select":
				return this.query(s)
			case "insert":
			case "update":
			case "delete":
			case "merge":
				return this.cteBody(s)
			case "adoptRole":
			case "alterDefaultPrivileges":
			case "alterDomain":
			case "alterRole":
			case "alterRowType":
			case "alterTable":
			case "beginRead":
			case "beginWrite":
			case "comment":
			case "commit":
			case "createConstant":
			case "createConstraintTrigger":
			case "createDeclaredFunction":
			case "createDomain":
			case "createExtension":
			case "createFunction":
			case "createGuardTrigger":
			case "createImmutableGuardTrigger":
			case "createIndex":
			case "createLiveSecret":
			case "createPolicy":
			case "createPublication":
			case "createRole":
			case "createRowType":
			case "createSchema":
			case "createStoredTable":
			case "createTable":
			case "createTransitionTrigger":
			case "createView":
			case "declareStatistics":
			case "drop":
			case "dropFunction":
			case "dropIndex":
			case "dropPolicy":
			case "dropPublication":
			case "dropTrigger":
			case "endHolders":
			case "fillStored":
			case "grant":
			case "grantColumns":
			case "grantRole":
			case "guardBracket":
			case "handOverFunction":
			case "lockTable":
			case "packConstant":
			case "rename":
			case "renameColumn":
			case "renameConstraint":
			case "replaceConstant":
			case "revoke":
			case "revokeRole":
			case "rollback":
			case "setConstraintsImmediate":
			case "stubConstant":
				return undefined
		}
	}

	/** A query planned as a level of its own (subquery_planner): its CTEs, then its body. */
	query(q: OperandSelect): void {
		this.with(q.with, q)
		this.body(q.body, true)
	}

	/** Each CTE a WITH's statement reads or that writes, planned apart under its name (SS_process_ctes). */
	with(w: With | undefined, reader: unknown): void {
		if (w === undefined) {
			return
		}
		const read = cteReads(reader)
		for (const c of w.ctes) {
			if (c.query.kind !== "select" || read.has(c.name)) {
				this.#ask(c.name, false, "cte", c.query)
				this.cteBody(c.query)
			}
		}
	}

	cteBody(b: CteBody): void {
		switch (b.kind) {
			case "select":
				return this.query(b)
			case "insert": {
				this.with(b.with, b)
				if (b.source.kind === "query") {
					const pulled = pulledUp(b.source.query)
					if (pulled === undefined) {
						this.#ask(unaliasedName, false, "insertSource", b.source.query)
						this.query(b.source.query)
					} else {
						this.core(pulled)
					}
				}
				this.sublinks([b.onConflict, b.returning])
				return undefined
			}
			case "update":
				this.with(b.with, b)
				this.from(b.from)
				this.where(b.where)
				this.sublinks([b.set, b.returning])
				return undefined
			case "delete":
				this.with(b.with, b)
				this.from(b.using)
				this.where(b.where)
				this.sublinks(b.returning)
				return undefined
			case "merge":
				this.with(b.with, b)
				this.from([b.using])
				this.sublinks([b.on, b.whens, b.returning])
				return undefined
		}
	}

	/** A query's body at its own level: `top` where it is the whole body of a level, whose UNION ALL is flattened. */
	body(b: OperandBody, top: boolean): void {
		switch (b.kind) {
			case "core":
				return this.core(b)
			case "select":
				return this.query(b)
			case "setOp":
				if (top && unionAllTree(b)) {
					return this.appendLeaves(unionAllLeaves(b))
				}
				for (const leaf of b.arms) {
					this.#ask("setop", true, "setop", leaf)
					this.leaf(leaf)
				}
				return undefined
		}
	}

	/** An append relation's leaves: each pulled up into it, or planned apart as `unnamed_subquery`. */
	appendLeaves(leaves: ReadonlyArray<OperandBody>): void {
		for (const leaf of leaves) {
			if (safeLeaf(leaf)) {
				const c = leaf.kind === "core" ? leaf : leaf.kind === "select" ? plainCore(leaf) : undefined
				if (c !== undefined) {
					this.core(c)
				}
			} else {
				this.#ask(unaliasedName, false, "leaf", leaf)
				this.leaf(leaf)
			}
		}
	}

	leaf(leaf: OperandBody): void {
		if (leaf.kind === "select") {
			this.query(leaf)
		} else {
			this.body(leaf, true)
		}
	}

	/** A core at the level that reads it: its sublinks, then its FROM sub-queries. */
	core(c: SelectCore): void {
		this.where(c.where)
		for (const item of c.from) {
			if (item.kind === "joins") {
				for (const step of item.steps) {
					if (step.kind === "on") {
						this.where(step.on)
					} else if (step.kind === "left") {
						this.sublinks(step.on)
					}
				}
			}
		}
		this.sublinks([c.targets, c.groupBy, c.having])
		this.from(c.from)
	}

	/** A WHERE's conjuncts: a pullable EXISTS pulled up into a join, every other sublink planned apart. */
	where(where: Expr | undefined): void {
		for (const conjunct of conjunctsOf(where)) {
			const pulled = pullableExists(conjunct)
			if (pulled === undefined) {
				this.sublinks(conjunct)
			} else {
				this.core(pulled)
			}
		}
	}

	/** Every sublink of an expression planned apart under its always-numbered name, a correlated EXISTS twice. */
	sublinks(e: unknown): void {
		for (const s of sublinksOf(e)) {
			this.#ask(sublinkName[s.kind], true, "sublink", s.query)
			this.query(s.query)
			if (s.kind === "exists" && hashableExists(s.query)) {
				this.#ask("exists_to_any", true, "hashed", s.query)
				this.query(s.query)
			}
		}
	}

	from(from: ReadonlyArray<FromItem>): void {
		for (const source of sourcesOf(from)) {
			this.source(source)
		}
	}

	source(source: FromSource): void {
		switch (source.kind) {
			case "derived": {
				const pulled = pulledUp(source.query)
				if (pulled !== undefined) {
					return this.core(pulled)
				}
				const body = plainBody(source.query)
				if (body !== undefined && unionAllTree(body)) {
					return this.appendLeaves(unionAllLeaves(body))
				}
				this.#ask(source.alias, false, "subquery", source.query)
				return this.query(source.query)
			}
			case "probe":
			case "met":
			case "context":
				this.#ask(source.alias, false, "subquery", source)
				return this.sublinks(source)
			case "metRows":
				this.#ask(source.marked, false, "subquery", source)
				return undefined
			case "arrays":
				if (source.source.kind !== "count") {
					this.#ask(source.alias, false, "subquery", source)
				}
				return this.sublinks(source.source)
			case "cte":
			case "enclosing":
			case "function":
			case "table":
			case "transition":
			case "values":
				return undefined
		}
	}
}

/** The names of the CTEs a statement reads anywhere in it. */
const cteReads = (e: unknown): ReadonlySet<string> => {
	const out = new Set<string>()
	const walk = (x: unknown): void => {
		if (typeof x === "object" && x !== null && "kind" in x) {
			if (x.kind === "cte" && "name" in x && typeof x.name === "string" && !("query" in x)) {
				out.add(x.name)
			}
			if (
				x.kind === "metRows" &&
				"insert" in x &&
				typeof x.insert === "string" &&
				"proposed" in x &&
				typeof x.proposed === "string"
			) {
				out.add(x.insert)
				out.add(x.proposed)
			}
		}
		for (const y of childrenOf(x)) {
			walk(y)
		}
	}
	walk(e)
	return out
}

/**
 * The core an EXISTS conjunct is pulled up as (convert_EXISTS_sublink_to_join), or none: an EXISTS or NOT EXISTS over a
 * query that simplifies (simplify_EXISTS_query: no WITH, set operation, aggregate, window, HAVING or OFFSET), has a
 * FROM, reads the outer row in its WHERE and nowhere else, and calls nothing VOLATILE in its WHERE.
 */
const pullableExists = (e: Expr): SelectCore | undefined => {
	if (e.kind !== "exists") {
		return undefined
	}
	const c = existsCore(e.query)
	if (c === undefined || !isNonEmpty(c.from)) {
		return undefined
	}
	const inner = definedAliases(c.from)
	if (readsOuter(c.from, inner) || !readsOuter(c.where, inner) || callsVolatile(c.where)) {
		return undefined
	}
	return c
}

/** An EXISTS query as simplify_EXISTS_query reads it: one core with no aggregate, window or HAVING, no WITH or OFFSET. */
const existsCore = (q: OperandSelect): SelectCore | undefined => {
	if (q.with !== undefined || q.offset !== undefined) {
		return undefined
	}
	const c =
		q.body.kind === "core" ? q.body : q.body.kind === "select" ? existsCore(q.body) : undefined
	return c?.groupBy.length === 0 && c.having === undefined && !aggregatesOrWindows(c.targets)
		? c
		: undefined
}

/**
 * Whether a correlated EXISTS is planned again as `= ANY` for hashing (subselect.c convert_EXISTS_to_ANY): it simplifies,
 * its FROM reads no outer row, and its WHERE's conjuncts that read the outer row are each an equality of an outer side
 * and an inner one, at least one of them.
 */
const hashableExists = (q: OperandSelect): boolean => {
	const c = existsCore(q)
	if (c === undefined || !isNonEmpty(c.from)) {
		return false
	}
	const inner = definedAliases(c.from)
	if (readsOuter(c.from, inner) || callsVolatile(c.where)) {
		return false
	}
	const outer = Arr.filter(conjunctsOf(c.where), (e) => readsOuter(e, inner))
	return (
		outer.length > 0 &&
		Arr.every(
			outer,
			(e) =>
				e.kind === "binary" &&
				e.op === "=" &&
				readsOuter(e.left, inner) !== readsOuter(e.right, inner)
		)
	)
}
