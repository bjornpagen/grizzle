import { topoOrder } from "#compiler/ir/dag.ts"
import type { RootedDag } from "#compiler/ir/rel.ts"
import type { PhysicalNames } from "#compiler/lower/conservative/types.ts"
import { columnType } from "#compiler/physical/ddl/names.ts"
import type {
	Cte,
	Expr,
	FromSource,
	ObjectName,
	Select,
	SelectBody,
	TypeRef
} from "#compiler/sql/ast.ts"
import { sameTypeRef } from "#compiler/sql/build.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"

/** A FROM item that names a relation: every item but a join, which names none and whose sides are the items. */
type NamedItem = FromSource

/** The key of an installed column: its schema, table and column. */
const columnKey = (table: ObjectName, column: string): string =>
	`${table.schema}\u0000${table.name}\u0000${column}`

/**
 * The PostgreSQL type of every installed column a definition's DAG reads: each column of an ordinary relation's table,
 * and of a lower derived relation's materialized view, at its field's column type (ddl/names.ts columnType). A table
 * column is created at that type, and a materialized view's column is closed to it by its own definition
 * (definition.ts withColumnTypes).
 */
const installedColumns = (dag: RootedDag, names: PhysicalNames): ReadonlyMap<string, TypeRef> => {
	const out = new Map<string, TypeRef>()
	for (const node of topoOrder(dag)) {
		if (node.kind !== "Base" || node.relationKind === "world") {
			continue
		}
		const table = names.relation(node.relation)
		for (const c of node.heading) {
			out.set(columnKey(table, names.column(node.relation, c.name)), columnType(names, c.type).type)
		}
	}
	return out
}

/**
 * The PostgreSQL type a lowered definition delivers at each output position, where the statement fixes it, so a view
 * column already at its column type needs no cast to it.
 *
 * The type follows PostgreSQL's own resolution, back through derived tables, CTEs, VALUES lists and set operation
 * arms: a typed literal, a typed placeholder or a cast is its type; a COLLATE keeps its operand's; an installed
 * column is its column type, and a context source's column the type its claim is cast to; a set operation's column, or
 * a VALUES column, is its arms' type when every arm has the same one, which is the only way PostgreSQL resolves a set
 * operation to a domain (a domain among differing types is read as its base). Anything else, an operator, a function,
 * an aggregate, a CASE, a recursive CTE's feedback reference, is not followed: its type is unknown, undefined, and a
 * column of unknown type is cast.
 *
 * Generated names are single-assignment (sql/naming.ts NameSupply): a relation alias or CTE name is defined once per
 * statement, so a column reference resolves by its alias alone.
 */
class Delivered {
	readonly #installed: ReadonlyMap<string, TypeRef>
	readonly #items = new Map<string, NamedItem>()
	readonly #ctes = new Map<string, Cte>()

	constructor(query: Select, installed: ReadonlyMap<string, TypeRef>) {
		this.#installed = installed
		visitSelect(query, {
			...inertVisitor,
			fromItem: (item) => {
				switch (item.kind) {
					case "table":
					case "enclosing":
					case "derived":
					case "values":
					case "function":
					case "recordset":
					case "context":
						this.#items.set(item.alias, item)
						return
					case "cte":
						this.#items.set(item.alias ?? item.name, item)
						return
					case "joins":
						return
				}
			},
			with: (w) => {
				for (const c of w.ctes) {
					this.#ctes.set(c.name, c)
				}
			}
		})
	}

	/** `active` names the CTE columns whose definitions are being followed around this one. */
	body(body: SelectBody, p: number, active: ReadonlySet<string>): TypeRef | undefined {
		switch (body.kind) {
			case "core": {
				const t = body.targets[p]
				return t === undefined ? undefined : this.#expr(t.expr, active)
			}
			case "select":
				return this.body(body.body, p, active)
			case "setOp":
				return this.#common(body.arms.map((arm) => this.body(arm, p, active)))
		}
	}

	/** The one type every member has, or undefined when some member's is unknown or two differ. */
	#common(members: ReadonlyArray<TypeRef | undefined>): TypeRef | undefined {
		const [first, ...rest] = members
		return first !== undefined && rest.every((t) => t !== undefined && sameTypeRef(t, first))
			? first
			: undefined
	}

	#expr(e: Expr, active: ReadonlySet<string>): TypeRef | undefined {
		switch (e.kind) {
			case "literal":
			case "param":
			case "cast":
				return e.type
			case "collate":
				return this.#expr(e.expr, active)
			case "column":
				return e.table === undefined ? undefined : this.#column(e.table, e.column, active)
			case "subquery":
				return this.body(e.query.body, 0, active)
			case "excluded":
			case "returning":
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
			case "greatest":
			case "least":
			case "call":
			case "mergeAction":
			case "domainValue":
			case "user":
			case "plVar":
			case "plSpecial":
			case "field":
			case "regclass":
				return undefined
		}
	}

	#column(alias: string, column: string, active: ReadonlySet<string>): TypeRef | undefined {
		const item = this.#items.get(alias)
		switch (item?.kind) {
			case "table":
				return typeof item.table === "string"
					? undefined
					: this.#installed.get(columnKey(item.table, column))
			case "derived": {
				const p = item.columns.indexOf(column)
				return p < 0 ? undefined : this.body(item.query.body, p, active)
			}
			case "values": {
				const p = item.columns.indexOf(column)
				return p < 0 ? undefined : this.#common(item.rows.map((row) => this.#cell(row[p], active)))
			}
			case "cte":
				return this.#cte(item.name, column, active)
			case "context":
				return item.columns.find((c) => c.column.name === column)?.column.type
			case "enclosing":
			case "function":
			case "recordset":
			case undefined:
				return undefined
		}
	}

	#cell(e: Expr | undefined, active: ReadonlySet<string>): TypeRef | undefined {
		return e === undefined ? undefined : this.#expr(e, active)
	}

	/** A CTE without a column list names its columns by its body, which the lowering never emits: unknown. */
	#cte(name: string, column: string, active: ReadonlySet<string>): TypeRef | undefined {
		const cte = this.#ctes.get(name)
		if (cte?.query.kind !== "select" || cte.columns.length === 0) {
			return undefined
		}
		const p = cte.columns.indexOf(column)
		const key = `${name}\u0000${column}`
		return p < 0 || active.has(key)
			? undefined
			: this.body(cte.query.body, p, new Set([...active, key]))
	}
}

/**
 * The PostgreSQL type the definition `query`, lowered from `dag`, delivers at an output position, undefined where the
 * statement does not fix it (Delivered).
 */
export const deliveredTypes = (
	query: Select,
	dag: RootedDag,
	names: PhysicalNames
): ((position: number) => TypeRef | undefined) => {
	const delivered = new Delivered(query, installedColumns(dag, names))
	return (position) => delivered.body(query.body, position, new Set())
}
