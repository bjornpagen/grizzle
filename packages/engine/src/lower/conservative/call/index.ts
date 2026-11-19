import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { fieldColumnType, rowTypeOf } from "#compiler/ir/physical.ts"
import {
	columnIn,
	distinctSelect,
	type Lowerers,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import type { Expr, FromSource } from "#compiler/sql/ast.ts"
import {
	binary,
	call,
	cast,
	col,
	keyedSet,
	lit,
	or,
	qualifiedCall,
	select,
	target,
	types
} from "#compiler/sql/build.ts"

/**
 * Call: the rows a declared function returns for its arguments, a set, each value of its declared type.
 *
 *   SELECT DISTINCT r3.c3::<its type>, r3.c4::<its type>
 *     FROM <level>.<function>(<value>::<base type>, ARRAY(SELECT ROW(r2.c1, r2.c2)::<level>.__rows_<digest>
 *       FROM (<rows argument>) AS r2(c1, c2)), ...) AS r3(c3, c4)
 *     WHERE pg_catalog.num_nonnulls(r3.c3, r3.c4) = 2 OR <level>.__refuse('22004', '<function>', ...)
 *
 * Each argument is passed in the function's declared order: a value cast to its declared type's base, the type the
 * function takes it at; rows as the array of the heading's row type (ir/physical.ts rowTypeOf), each element the row
 * of the argument query's fields in the heading's declared order. An argument reads outer values through the
 * environment, a region's columns among them, so a call that reads its region's variables is placed LATERAL by the
 * region (match-region), and runs once per binding of the matches before it.
 *
 * The function's rows are its row type's, its columns renamed positionally, in its attributes' order, the heading's
 * declared order, each to a fresh column of the statement; each is cast to the type its field's
 * values are stored as (ir/physical.ts fieldColumnType): a contract's, a pattern's or a closed id's roster's domain,
 * which PostgreSQL checks the value at, raising where it is none of the type, a code no handle of the roster holds
 * among them, so the call's value is the field's typed; and DISTINCT makes them a set. A row that holds NULL at any
 * column is refused through the installation's refusal function (SQLSTATE 22004, null_value_not_allowed), since
 * grizzle holds no NULL: no row of a function's result is absent at a field.
 */
const lowerCall: NodeLowerer<"Call"> = (node, cx, env) => {
	const fn = cx.names.declaredFunction(node.function.name)
	const args = node.args.map((a): Expr => {
		if (a.kind === "value") {
			return cast(lowerExpr(cx, a.expr, env), cx.baseTypeRef(a.type))
		}
		/** The argument's query is lowered inside its ARRAY subquery, a sublink of the call's FROM item. */
		const rows = cx.inSublink().source(a.rows, env)
		const row = rowTypeOf(cx.names, fn.types, a.columns)
		const element = cast(
			{ kind: "row", items: mapNonEmpty(a.columns, (c) => columnIn(rows.map, c.name)) },
			row.type
		)
		return {
			kind: "array",
			query: select(keyedSet([target(element)], [rows.item], undefined, "a call's rows argument"))
		}
	})
	const origin = { kind: "node", node: node.id } as const
	const alias = cx.relationAlias(origin)
	/** The function's columns renamed in its row type's attribute order, the heading's declared order. */
	const columns = node.heading.map((c) => ({ name: c.name, column: cx.supply.column(origin) }))
	const item: FromSource = {
		kind: "function",
		call: qualifiedCall(fn.ref.schema, fn.ref.name, args),
		alias,
		columns: columns.map((c) => c.column),
		lateral: false,
		ordinality: false
	}
	const reads = columns.map((c) => col(alias, c.column))
	const whole = binary("=", call("num_nonnulls", reads), lit.int(reads.length, types.integer))
	const refused = qualifiedCall(cx.names.refusal.schema, cx.names.refusal.name, [
		lit.text("22004", types.text),
		lit.text(node.function.name, types.text),
		lit.text(`function ${node.function.name} returned a row holding NULL`, types.text)
	])
	const heading = node.heading
	if (!isNonEmpty(heading)) {
		throw defect("a call's heading, its result's fields, of at least one field")
	}
	return distinctSelect(
		mapNonEmpty(heading, (c, i) =>
			target(
				cast(
					col(alias, defined(columns[i], "a column of the call per field of its heading").column),
					fieldColumnType(cx.names, c.type).type
				)
			)
		),
		[item],
		[or([whole, refused])]
	)
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const callLowering: Lowerers<"Call"> = { Call: lowerCall }
