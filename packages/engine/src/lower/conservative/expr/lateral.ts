import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { isOperandBinding } from "#compiler/lower/conservative/expr/total.ts"
import {
	type CoreProjection,
	type Expr,
	type FromSource,
	type OperandSelect,
	type OverRows,
	overRowsOf,
	type Select,
	type SelectCore,
	type Target
} from "#compiler/sql/ast.ts"
import { col, derived } from "#compiler/sql/build.ts"
import { namedQuery, type NameOrigin, type NameSupply } from "#compiler/sql/naming.ts"
import { identityHooks, transformExpr, transformSelect } from "#compiler/sql/transform.ts"

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

/**
 * Each operand select the transform rebuilt, by its original as the lowering built it: what a core finds a binding by,
 * so one it names several times is one binding, however many times the transform rebuilt it.
 */
type Originals = ReadonlyMap<OperandSelect, OperandSelect>

/** The operand bindings one core's own expressions evaluate for every row, moved into its FROM, each once. */
class CoreBinder {
	readonly #supply: NameSupply
	readonly #grouped: boolean
	readonly #originals: Originals
	readonly #bound = new Map<OperandSelect, Expr>()
	readonly laterals: Array<FromSource> = []

	constructor(supply: NameSupply, grouped: boolean, originals: Originals) {
		this.#supply = supply
		this.#grouped = grouped
		this.#originals = originals
	}

	/**
	 * The column a binding's query is read from: its LATERAL item's, the item added the first time the core names the
	 * binding, by its original query (Originals).
	 */
	#column(query: OperandSelect): Expr {
		const original = this.#originals.get(query) ?? query
		const seen = this.#bound.get(original)
		if (seen !== undefined) {
			return seen
		}
		const alias = this.#supply.relation(bindingOrigin)
		const column = this.#supply.column(bindingOrigin)
		this.laterals.push(derived(namedQuery(query, [column]), alias, true))
		const read = col(alias, column)
		this.#bound.set(original, read)
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
			case "complement":
			case "lowerAscii": {
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
			case "least":
			case "coalesce": {
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
				const [first, second, ...rest] = e.list
				const list: readonly [Expr, Expr, ...Array<Expr>] = [at(first), at(second), ...rest.map(at)]
				return expr === e.expr && list.every((a, i) => a === e.list[i]) ? e : { ...e, expr, list }
			}
			case "inQuery": {
				const expr = at(e.expr)
				return expr === e.expr ? e : { ...e, expr }
			}
			case "equalsAny": {
				const expr = at(e.expr)
				const array = at(e.array)
				return expr === e.expr && array === e.array ? e : { ...e, expr, array }
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
			case "attribute": {
				const record = at(e.record)
				return record === e.record ? e : { ...e, record }
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
			case "clock":
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
const bindCore = (c: SelectCore, supply: NameSupply, originals: Originals): SelectCore => {
	const grouped =
		c.groupBy.length > 0 ||
		c.having !== undefined ||
		c.targets.some((t) => holds(t.expr, aggregates))
	const binder = new CoreBinder(supply, grouped, originals)
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
 * LATERAL item: the core finds its bindings by their original queries (Originals), however many times the transform
 * rebuilt them. A core the lowering shares between two cores, an operand two operations of a term read, is bound anew
 * at each, its LATERAL items named afresh from the statement's supply, since a statement defines no name twice
 * (lower/shapes/index.ts); the transform's work is the printed statement's size, which prints the shared core at each.
 */
export const bindLaterally = (query: Select, supply: NameSupply): Select => {
	const originals = new Map<OperandSelect, OperandSelect>()
	return transformSelect(query, {
		...identityHooks,
		core: (c) => bindCore(c, supply, originals),
		select: (s, original) => {
			originals.set(s, original)
			return s
		}
	})
}
