import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { isOperandBinding } from "#compiler/lower/conservative/expr/total.ts"
import type {
	BuiltinFunctionName,
	CoreProjection,
	Expr,
	FromSource,
	OperandSelect,
	Select,
	SelectCore,
	Target
} from "#compiler/sql/ast.ts"
import { col } from "#compiler/sql/build.ts"
import type { NameOrigin, NameSupply } from "#compiler/sql/naming.ts"
import { identityHooks, transformExpr, transformSelect } from "#compiler/sql/transform.ts"

/** Where a builtin's call computes: over its row's values, or over many rows, as an aggregate or a window function does. */
const reach: { readonly [N in BuiltinFunctionName]: "row" | "rows" } = {
	count: "rows",
	sum: "rows",
	avg: "rows",
	min: "rows",
	max: "rows",
	bool_and: "rows",
	bool_or: "rows",
	range_agg: "rows",
	array_agg: "rows",
	jsonb_agg: "rows",
	row_number: "rows",
	rank: "rows",
	dense_rank: "rows",
	lead: "rows",
	lag: "rows",
	percentile_disc: "rows",
	percentile_cont: "rows",
	mode: "rows",
	abs: "row",
	sign: "row",
	gcd: "row",
	lcm: "row",
	power: "row",
	sqrt: "row",
	min_scale: "row",
	trim_scale: "row",
	float8send: "row",
	get_byte: "row",
	width_bucket: "row",
	round: "row",
	trunc: "row",
	ceil: "row",
	floor: "row",
	div: "row",
	mod: "row",
	char_length: "row",
	octet_length: "row",
	starts_with: "row",
	right: "row",
	translate: "row",
	regexp_replace: "row",
	btrim: "row",
	ltrim: "row",
	rtrim: "row",
	split_part: "row",
	replace: "row",
	left: "row",
	lower: "row",
	upper: "row",
	isempty: "row",
	lower_inc: "row",
	upper_inc: "row",
	lower_inf: "row",
	upper_inf: "row",
	int4range: "row",
	int8range: "row",
	range_minus_multi: "row",
	unnest: "row",
	to_jsonb: "row",
	setval: "row",
	pg_advisory_xact_lock: "row",
	current_setting: "row",
	set_config: "row",
	pg_jit_available: "row",
	format: "row",
	current_database: "row",
	substring: "row",
	bit_count: "row",
	set_bit: "row",
	bit_or: "rows",
	string_agg: "rows",
	generate_subscripts: "row",
	make_date: "row"
}

/** What a call over many rows is: an aggregate's, count(*) among them, or a window call. */
type OverRows = "aggregate" | "window"

const overRowsOf = (e: Expr): OverRows | undefined => {
	if (e.kind !== "call") {
		return undefined
	}
	if (e.over !== undefined) {
		return "window"
	}
	return e.star || (e.fn.kind === "builtin" && reach[e.fn.name] === "rows")
		? "aggregate"
		: undefined
}

/** Whether an expression holds a call over many rows of a kind in `kinds`, anywhere, inside a subquery of it too. */
const holds = (e: Expr, kinds: ReadonlySet<OverRows>): boolean => {
	const found = new Set<OverRows>()
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			const over = overRowsOf(x)
			if (over !== undefined) {
				found.add(over)
			}
			return x
		}
	})
	return [...found].some((k) => kinds.has(k))
}

const aggregates: ReadonlySet<OverRows> = new Set(["aggregate"])
const overRows: ReadonlySet<OverRows> = new Set(["aggregate", "window"])

/**
 * Whether a core evaluates an expression for every row of its FROM (`row`), or only for some of them or once per group
 * (`branch`).
 */
type Place = "row" | "branch"

const bindingOrigin: NameOrigin = { kind: "internal", purpose: "an operand binding read laterally" }

/** The operand bindings one core's own expressions evaluate for every row, moved into its FROM, each once. */
class CoreBinder {
	readonly #supply: NameSupply
	readonly #grouped: boolean
	readonly #bound = new Map<OperandSelect, Expr>()
	readonly laterals: Array<FromSource> = []

	constructor(supply: NameSupply, grouped: boolean) {
		this.#supply = supply
		this.#grouped = grouped
	}

	/** The column a binding's query is read from: its LATERAL item's, the item added the first time. */
	#column(query: OperandSelect): Expr {
		const seen = this.#bound.get(query)
		if (seen !== undefined) {
			return seen
		}
		const alias = this.#supply.relation(bindingOrigin)
		const column = this.#supply.column(bindingOrigin)
		this.laterals.push({ kind: "derived", query, alias, columns: [column], lateral: true })
		const read = col(alias, column)
		this.#bound.set(query, read)
		return read
	}

	/**
	 * Where a call's arguments are evaluated: for every row of the FROM when the call computes over those rows, an
	 * aggregate's in a core that groups and a window call's in one that does not, but an ordered-set aggregate's direct
	 * arguments, once per group; where the call is, otherwise.
	 */
	#arguments(e: Expr & { readonly kind: "call" }, place: Place): Place {
		const over = overRowsOf(e)
		const perRow =
			(over === "aggregate" && this.#grouped && (e.star || e.withinGroup.length === 0)) ||
			(over === "window" && !this.#grouped)
		return perRow ? "row" : place
	}

	readonly expr = (e: Expr, place: Place): Expr => {
		const at = (x: Expr): Expr => this.expr(x, place)
		switch (e.kind) {
			case "subquery":
				return place === "row" && isOperandBinding(e.query) && !holds(e, overRows)
					? this.#column(e.query)
					: e
			case "cast":
			case "collate":
			case "negate":
			case "not":
			case "isTrue":
			case "complement": {
				const inner = at(e.expr)
				return inner === e.expr ? e : { ...e, expr: inner }
			}
			case "binary": {
				const left = at(e.left)
				const right = at(e.right)
				return left === e.left && right === e.right ? e : { ...e, left, right }
			}
			case "and":
			case "or":
			case "greatest":
			case "least": {
				const args = mapNonEmpty(e.args, at)
				return args.every((a, i) => a === e.args[i]) ? e : { ...e, args }
			}
			case "between": {
				const expr = at(e.expr)
				const low = at(e.low)
				const high = at(e.high)
				return expr === e.expr && low === e.low && high === e.high ? e : { ...e, expr, low, high }
			}
			case "inList": {
				const expr = at(e.expr)
				const list = mapNonEmpty(e.list, at)
				return expr === e.expr && list.every((a, i) => a === e.list[i]) ? e : { ...e, expr, list }
			}
			case "inQuery": {
				const expr = at(e.expr)
				return expr === e.expr ? e : { ...e, expr }
			}
			case "row": {
				const items = mapNonEmpty(e.items, at)
				return items.every((a, i) => a === e.items[i]) ? e : { ...e, items }
			}
			case "nullif": {
				const expr = at(e.expr)
				const absent = at(e.absent)
				return expr === e.expr && absent === e.absent ? e : { ...e, expr, absent }
			}
			case "subscript": {
				const array = at(e.array)
				const index = at(e.index)
				return array === e.array && index === e.index ? e : { ...e, array, index }
			}
			case "case": {
				const branch = (x: Expr): Expr => this.expr(x, "branch")
				const operand = e.operand === undefined ? undefined : at(e.operand)
				const whens = mapNonEmpty(e.whens, (w, i) => {
					const when = i === 0 ? at(w.when) : branch(w.when)
					const result = branch(w.result)
					return when === w.when && result === w.result ? w : { when, result }
				})
				const otherwise = branch(e.else)
				return operand === e.operand &&
					whens.every((w, i) => w === e.whens[i]) &&
					otherwise === e.else
					? e
					: { ...e, operand, whens, else: otherwise }
			}
			case "call": {
				const inner = this.#arguments(e, place)
				if (e.star) {
					const filter = e.filter === undefined ? undefined : this.expr(e.filter, inner)
					return filter === e.filter ? e : { ...e, filter }
				}
				const args = e.args.map((a) => this.expr(a, inner))
				return args.every((a, i) => a === e.args[i]) ? e : { ...e, args }
			}
			case "column":
			case "excluded":
			case "returning":
			case "param":
			case "literal":
			case "exists":
			case "array":
			case "mergeAction":
			case "domainValue":
			case "user":
			case "plVar":
			case "plSpecial":
			case "field":
			case "regclass":
				return e
		}
	}
}

/** A core's projection, each target rebuilt by `target`. */
const projected = (c: SelectCore, target: (t: Target) => Target): CoreProjection => {
	if (c.distinct === false) {
		return c.rows === "operand"
			? { distinct: false, rows: c.rows, targets: c.targets.map(target) }
			: { distinct: false, rows: c.rows, targets: c.targets.map(target) }
	}
	return { distinct: c.distinct, targets: mapNonEmpty(c.targets, target) }
}

/**
 * A core whose own expressions' operand bindings that it evaluates for every row of its FROM are LATERAL items of that
 * FROM: its WHERE's; its targets' where it does not group; and the arguments of each call over rows, an aggregate's
 * where it groups and a window call's where it does not.
 */
const bindCore = (c: SelectCore, supply: NameSupply): SelectCore => {
	const grouped =
		c.groupBy.length > 0 ||
		c.having !== undefined ||
		c.targets.some((t) => holds(t.expr, aggregates))
	const binder = new CoreBinder(supply, grouped)
	const place: Place = grouped ? "branch" : "row"
	const projection = projected(c, (t) => {
		const expr = binder.expr(t.expr, place)
		return expr === t.expr ? t : { ...t, expr }
	})
	const where = c.where === undefined ? undefined : binder.expr(c.where, "row")
	const having = c.having === undefined ? undefined : binder.expr(c.having, "branch")
	if (binder.laterals.length === 0) {
		return c
	}
	return {
		kind: "core",
		...projection,
		from: [...c.from, ...binder.laterals],
		where,
		groupBy: c.groupBy,
		having
	}
}

/**
 * `query` with each operation's operand binding (total.ts bindOperands) read once per row: a scalar subquery binding a
 * compound operand is a SubPlan PostgreSQL runs again for every row that evaluates it, so wherever a core evaluates a
 * binding for every row of its FROM, the binding moves into that FROM as a LATERAL derived table of its one row, named
 * from `supply`, the statement's own, and the expression reads its column. PostgreSQL pulls the binding's query up into
 * the core, so the operation's form is computed in the core's own row, and the operand row, which OFFSET 0 keeps a
 * subquery, is read once per row.
 *
 * A core evaluates an expression for every row of its FROM in its WHERE, in its targets where it does not group, and in
 * the arguments of a call over those rows (bindCore). A CASE evaluates its operand and its first condition for every
 * row, and its later conditions and its results only for the rows that reach them, so a binding there stays a scalar
 * subquery, run only where its branch is taken: the exact path of a guarded form above all, which its fast test spares
 * nearly every row, and whose evaluation a branch it does not reach may never ask for. A binding that holds a call over
 * rows stays too, since a FROM item computes none of its core's. Every core is bound so, inner cores first, the
 * binding's own core and its operand row among them, so an operand that is itself a binding is read laterally in the
 * operand row.
 *
 * One binding a core names several times, as an aggregate's rounded total names its sum (total.ts roundToFloat), is one
 * LATERAL item: a node the lowering shares stays shared, its query rebuilt once (`cores`, `selects`), and the core finds
 * its bindings by that query.
 */
export const bindLaterally = (query: Select, supply: NameSupply): Select => {
	const cores = new Map<SelectCore, SelectCore>()
	const selects = new Map<OperandSelect, OperandSelect>()
	return transformSelect(query, {
		...identityHooks,
		core: (c, original) => {
			const seen = cores.get(original)
			if (seen !== undefined) {
				return seen
			}
			const bound = bindCore(c, supply)
			cores.set(original, bound)
			return bound
		},
		select: (s, original) => {
			const seen = selects.get(original)
			if (seen !== undefined) {
				return seen
			}
			selects.set(original, s)
			return s
		}
	})
}
