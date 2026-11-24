import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { NodeId } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { fieldColumnType, rowTypeOf } from "#compiler/ir/physical.ts"
import {
	type CallFunction,
	type Heading,
	type NodeOf,
	seriesArguments,
	seriesHeading,
	type TextSplit,
	tokensHeading
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	columnIn,
	type ColumnMap,
	distinctSelect,
	emptyEnv,
	type Env,
	envOf,
	type EvaluationLookup,
	type LowerContext,
	type Lowerers,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import type { ParentRows } from "#compiler/lower/conservative/deliver.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { collapsedText } from "#compiler/lower/conservative/expr/ops.ts"
import type { Cte, Expr, FromSource, OperandSelect, Select } from "#compiler/sql/ast.ts"
import {
	binary,
	call,
	cast,
	col,
	conjunction,
	cteRefAs,
	derived,
	keyedSet,
	lit,
	or,
	qualifiedCall,
	select,
	target,
	types
} from "#compiler/sql/build.ts"

/** The node a call's names are minted for, and the label refusals name it by. */
const originOf = (node: NodeOf<"Call">) => ({ kind: "node", node: node.id }) as const

/**
 * A declared function's call at its arguments, as its FROM item, `<level>.<function>(<args>) AS <alias>(<columns>)`,
 * `count` fresh columns renaming its result's columns positionally, a row's attributes or a set's columns in its row
 * type's order.
 *
 * Each argument is passed in the function's parameters' order, its arguments' names' code point order: a value cast to
 * its declared type's base, the type the function takes it at; rows as the array of the heading's row type
 * (ir/physical.ts rowTypeOf), each element the row of the argument query's fields in the heading's order, its row
 * type's attributes',
 * `ARRAY(SELECT ROW(r2.c1, r2.c2)::<level>.__rows_<digest> FROM (<rows argument>) AS r2(c1, c2))`. An argument reads
 * outer values through the environment, a region's columns among them, so a call that reads its region's variables is
 * placed LATERAL by the region (match-region), and runs once per binding of the matches before it.
 */
const calledItem = (
	node: NodeOf<"Call">,
	name: string,
	count: number,
	cx: LowerContext,
	env: Env
): { readonly item: FromSource; readonly columns: ReadonlyArray<Expr> } => {
	const fn = cx.names.declaredFunction(name)
	const args = node.args.map((a): Expr => {
		if (a.kind === "value") {
			return cast(lowerExpr(cx, a.expr, env), cx.baseTypeRef(a.type))
		}
		/** The argument's query is lowered inside its ARRAY subquery, a sublink of the call's FROM item. */
		const rows = cx.inSublink().source(a.rows, env)
		const row = rowTypeOf(
			cx.names,
			fn.types,
			mapNonEmpty(a.columns, (c) => ({ name: c.name, type: { kind: "value", type: c.type } }))
		)
		const element = cast(
			{ kind: "row", items: mapNonEmpty(a.columns, (c) => columnIn(rows.map, c.name)) },
			row.type
		)
		return {
			kind: "array",
			query: select(keyedSet([target(element)], [rows.item], undefined, "a call's rows argument"))
		}
	})
	const alias = cx.relationAlias(originOf(node))
	const columns = Array.from({ length: count }, () => cx.supply.column(originOf(node)))
	return {
		item: {
			kind: "function",
			call: qualifiedCall(fn.ref.schema, fn.ref.name, args),
			alias,
			columns,
			lateral: false,
			ordinality: false
		},
		columns: columns.map((c) => col(alias, c))
	}
}

/**
 * The refusal of a NULL a function returned where grizzle holds a value: `pg_catalog.num_nonnulls(<values>) = n OR
 * <level>.__refuse('22004', '<function>', '<what held it>')`, through the installation's refusal function (SQLSTATE
 * 22004, null_value_not_allowed), since grizzle holds no NULL, so no row of a function's result is absent at a field.
 */
const refusingNull = (
	cx: LowerContext,
	name: string,
	values: NonEmptyReadonlyArray<Expr>,
	held: string
): Expr =>
	or([
		binary("=", call("num_nonnulls", values), lit.int(values.length, types.integer)),
		qualifiedCall(cx.names.refusal.schema, cx.names.refusal.name, [
			lit.text(sqlstates.nullValueNotAllowed, types.text),
			lit.text(name, types.text),
			lit.text(`function ${name} returned ${held}`, types.text)
		])
	])

/**
 * A call's rows, a set, each value of its declared type: the columns `columns` of the sources `from` where `where`
 * holds, each cast to the type its field's values are stored as (ir/physical.ts fieldColumnType): a contract's, a
 * pattern's or a closed id's roster's domain, which PostgreSQL checks the value at, raising where it is none of the
 * type, a code no handle of the roster holds among them, so the call's value is the field's typed; and DISTINCT makes
 * them a set.
 */
const calledRows = (
	node: NodeOf<"Call">,
	columns: ReadonlyArray<Expr>,
	from: ReadonlyArray<FromSource>,
	where: ReadonlyArray<Expr>,
	cx: LowerContext
): OperandSelect => {
	const heading = node.heading
	if (!isNonEmpty(heading)) {
		throw defect("a call's heading, its result's fields, of at least one field")
	}
	return distinctSelect(
		mapNonEmpty(heading, (c, i) =>
			target(
				cast(
					defined(columns[i], "a column of the call per field of its heading"),
					fieldColumnType(cx.names, c.type).type
				)
			)
		),
		from,
		where
	)
}

/**
 * A declared function's call that returns rows: the rows it returns for its arguments, a set, each value of its
 * declared type (calledRows).
 *
 *   SELECT DISTINCT r3.c3::<its type>, r3.c4::<its type>
 *     FROM <level>.<function>(<value>::<base type>, ARRAY(...), ...) AS r3(c3, c4)
 *     WHERE pg_catalog.num_nonnulls(r3.c3, r3.c4) = 2 OR <level>.__refuse('22004', '<function>', ...)
 *
 * The function's rows are its row type's (calledItem), its columns renamed positionally, in its attributes' order, its
 * heading's fields' names' code point order, each to a fresh column of the statement; a row that holds NULL at any column is refused
 * (refusingNull).
 */
const lowerDeclared = (
	node: NodeOf<"Call">,
	called: Extract<CallFunction, { readonly kind: "declared" }>,
	cx: LowerContext,
	env: Env
): OperandSelect => {
	return cx.evaluationOf(node, env, () => {
		const { item, columns } = calledItem(node, called.name, node.heading.length, cx, env)
		if (!isNonEmpty(columns)) {
			throw defect("a call's heading, its result's fields, of at least one field")
		}
		const noNull = refusingNull(cx, called.name, columns, "a row holding NULL")
		return calledRows(node, columns, [item], [noNull], cx)
	})
}

/** The place of the field a read reads among the fields of the call's row (CallFunction `field`). */
const fieldAt = (called: Extract<CallFunction, { readonly kind: "field" }>): number => {
	const at = called.row.indexOf(called.field)
	if (at < 0) {
		throw defect(`${called.field}, a field of ${called.name}'s row`)
	}
	return at
}

/**
 * The evaluation of a call of a declared function that returns one row, which every read of one of its row's fields
 * reads: its FROM item (calledItem), one row, each attribute of its row type a column, and the refusal of a row holding
 * NULL at any of its fields (refusingNull), a NULL row among them, which PostgreSQL's FROM reads as a row of NULLs.
 */
const evaluationOf = (
	node: NodeOf<"Call">,
	called: Extract<CallFunction, { readonly kind: "field" }>,
	cx: LowerContext,
	env: Env
): {
	readonly item: FromSource
	readonly attributes: NonEmptyReadonlyArray<Expr>
	readonly check: Expr
} => {
	const { item, columns } = calledItem(node, called.name, called.row.length, cx, env)
	if (!isNonEmpty(columns)) {
		throw defect(`the row of ${called.name}, of at least one field`)
	}
	return {
		item,
		attributes: columns,
		check: refusingNull(cx, called.name, columns, "a row holding NULL")
	}
}

/**
 * A call's evaluation as a read places it itself, where no query around it hosts it: its FROM item, its attributes,
 * and the refusal of a row holding NULL, which the read's WHERE states of the item alone, so PostgreSQL evaluates it
 * where it scans the call, before the read unnests a field (evaluationOf).
 */
const ownEvaluation = (
	node: NodeOf<"Call">,
	called: Extract<CallFunction, { readonly kind: "field" }>,
	cx: LowerContext,
	env: Env
): {
	readonly from: ReadonlyArray<FromSource>
	readonly attributes: NonEmptyReadonlyArray<Expr>
	readonly where: ReadonlyArray<Expr>
} => {
	const { item, attributes, check } = evaluationOf(node, called, cx, env)
	return { from: [item], attributes, where: [check] }
}

/**
 * A call's evaluation as a query of its own, which a host places once for every read of its row's fields it holds
 * (HostedEvaluation): `SELECT r3.c3, ..., r3.cn FROM <level>.<function>(<args>) AS r3(c3, ..., cn) WHERE <no NULL>`,
 * one row of the row type's attributes, an array of rows for each field of rows. Its columns are the attributes in
 * their order, `count` of them (evaluationWidth).
 */
export const evaluationQuery = (node: NodeOf<"Call">, cx: LowerContext, env: Env): Select => {
	const called = node.function
	if (called.kind !== "field") {
		throw defect("an evaluation of a call whose row's fields a query reads")
	}
	return cx.evaluationOf(node, env, () => {
		const { item, attributes, check } = evaluationOf(node, called, cx, env)
		return select(
			keyedSet(
				mapNonEmpty(attributes, (a) => target(a)),
				[item],
				check,
				"a call's one row"
			)
		)
	})
}

/** The columns of a call's evaluation (evaluationQuery): its row's attributes, one per field of the row. */
export const evaluationWidth = (node: NodeOf<"Call">): number => {
	const called = node.function
	if (called.kind !== "field") {
		throw defect("an evaluation of a call whose row's fields a query reads")
	}
	return called.row.length
}

/**
 * Whether a field read's call reads nothing outside the read: no outer reference and no recursion's feedback, so its
 * evaluation stands at its statement's WITH, which it may be read from wherever the read stands.
 */
export const readsOnlyParameters = (cx: LowerContext, read: NodeOf<"Call">): boolean =>
	cx.freeRefs(read).size === 0 && !cx.readsFeedback(read)

/**
 * The evaluations a statement holds once each, as MATERIALIZED CTEs `ctes` holds, its WITH's entries
 * (LowerContext.hostStatementEvaluations): every call a read of a field reads that reads only parameters
 * (readsOnlyParameters), one CTE per evaluation key, defined at the first read of it, its body lowered in `root`,
 * after every entry it reads, and read by each read of it under an alias of its own; a call that reads an outer row is
 * no statement's to hold.
 */
export const statementEvaluations = (ctes: Set<Cte>, root: LowerContext): EvaluationLookup => {
	const held = new Map<
		string,
		{ readonly name: string; readonly columns: NonEmptyReadonlyArray<string> }
	>()
	return (read, key, cx) => {
		if (!readsOnlyParameters(cx, read)) {
			return undefined
		}
		const known = held.get(key)
		const cte = known ?? definedEvaluation(read, root, ctes)
		held.set(key, cte)
		const alias = cx.relationAlias(originOf(read))
		return {
			from: [{ kind: "cte", name: cte.name, alias }],
			attributes: mapNonEmpty(cte.columns, (c) => col(alias, c))
		}
	}
}

/**
 * The evaluations a statement holds once each for the rows of an attachment's parent (lower/shapes/index.ts
 * pipelinedQuery), its WITH's entries, `ctes`: every call a read of a field reads whose call reads nothing outside it
 * but columns of the parent's delivered rows, nodes of `spine` (no parameter-only call: the statement holds those), one
 * MATERIALIZED CTE per evaluation key, the call evaluated once for each distinct value of the columns it reads among the
 * parent's rows (`parents`' keys):
 *
 *   WITH r9(c1, c2, c3) AS MATERIALIZED (SELECT p.c1, e.c2, e.c3 FROM (<the parents' keys>) AS p(c1),
 *     LATERAL (SELECT ... FROM <level>.<function>(<args at p.c1>) ...) AS e(c2, c3))
 *
 * and each read of it, in any attachment under those rows, reads it at its parent's values, which its environment
 * binds, `LATERAL (SELECT r10.c2, r10.c3 FROM r9 AS r10 WHERE r10.c1 = <the parent's c1>)`. So N attachments of one
 * parent that read one call at the parent's key, each the same function at the same arguments (edullm's sittingItem and
 * servedItem, metis's sittingRead and memberRead: qti-pie's sessionStartOf reads the machine's run of a session's start,
 * Fn.row at the session's key, in each of 44 attachments), call it once per parent row, where each attachment's child
 * evaluated it again: 44 machine calls, 23 MB of statement.
 */
export const parentEvaluations = (
	ctes: Set<Cte>,
	parents: ParentRows,
	spine: ReadonlySet<NodeId>
): EvaluationLookup => {
	const held = new Map<string, ParentEvaluation>()
	return (read, key, cx, env) => {
		const free = cx.freeRefs(read)
		if (
			free.size === 0 ||
			cx.readsFeedback(read) ||
			[...free.keys()].some((id) => !spine.has(id))
		) {
			return undefined
		}
		const readColumns = new Set([...free.values()].flatMap((columns) => [...columns]))
		const demand = parents.heading.filter((c) => readColumns.has(c.name))
		const evaluation = held.getOrInsertComputed(key, () =>
			definedParentEvaluation(read, cx, ctes, parents, demand, spine)
		)
		const origin = originOf(read)
		const at = cx.relationAlias(origin)
		const columns = evaluation.attributes.map(() => cx.supply.column(origin))
		const [first, ...rest] = columns
		if (first === undefined) {
			throw defect("a call's row, of at least one field")
		}
		const valueAt = (name: string): Expr => {
			for (const [id, named] of free) {
				const value = named.has(name) ? env.columns.get(id)?.get(name) : undefined
				if (value !== undefined) {
					return value
				}
			}
			throw defect(`the parent's column ${name} in the environment of a read of its evaluation`)
		}
		const from = cteRefAs(evaluation.name, at)
		const query = select(
			keyedSet(
				evaluation.attributes.map((c) => target(col(at, c))),
				[from],
				conjunction(
					evaluation.keys.map((k) => cx.equal(k.type, col(at, k.column), valueAt(k.name)))
				),
				"a call's one row at its parent's values"
			)
		)
		const alias = cx.relationAlias(origin)
		return {
			from: [derived(query, alias, columns, true)],
			attributes: mapNonEmpty([first, ...rest], (c) => col(alias, c))
		}
	}
}

/**
 * A call's evaluation for each parent key (parentEvaluations): its CTE's name, its parent key columns, each the parent's
 * column `name` of `type`, and its attributes' columns, one per field of the call's row.
 */
interface ParentEvaluation {
	readonly name: string
	readonly keys: ReadonlyArray<{
		readonly name: string
		readonly type: ScalarType
		readonly column: string
	}>
	readonly attributes: NonEmptyReadonlyArray<string>
}

/**
 * The call `read` reads evaluated for each distinct value of the parent's columns `demand` (parentEvaluations), a
 * MATERIALIZED CTE of `ctes` entered after every entry its body defines: the parents' keys, and the call LATERAL beside
 * each, its arguments lowered over the key's columns as the parent's.
 */
const definedParentEvaluation = (
	read: NodeOf<"Call">,
	cx: LowerContext,
	ctes: Set<Cte>,
	parents: ParentRows,
	demand: Heading,
	spine: ReadonlySet<NodeId>
): ParentEvaluation => {
	const origin = originOf(read)
	const keys = cx.wrap(parents.keys(demand), demand, origin)
	const keyMap: ColumnMap = keys.map
	const env: Env = envOf([...spine].map((id) => [id, keyMap] as const))
	const width = evaluationWidth(read)
	const evaluated = Array.from({ length: width }, () => cx.supply.column(origin))
	const at = cx.relationAlias(origin)
	const query = select(
		keyedSet(
			[
				...demand.map((c) => target(columnIn(keyMap, c.name))),
				...evaluated.map((c) => target(col(at, c)))
			],
			[keys.item, derived(evaluationQuery(read, cx, env), at, evaluated, true)],
			undefined,
			"a call's one row at each of its parents' keys"
		)
	)
	const name = cx.relationAlias(origin)
	const keyColumns = demand.map(() => cx.supply.column(origin))
	const [first, ...rest] = Array.from({ length: width }, () => cx.supply.column(origin))
	if (first === undefined) {
		throw defect("a call's row, of at least one field")
	}
	ctes.add({ name, columns: [...keyColumns, first, ...rest], materialized: "MATERIALIZED", query })
	return {
		name,
		keys: demand.map((c, i) => ({
			name: c.name,
			type: c.type,
			column: defined(keyColumns[i], "a parent key column of the evaluation")
		})),
		attributes: [first, ...rest]
	}
}

/**
 * A call's evaluation as a MATERIALIZED CTE of `ctes` (evaluationQuery), its body lowered in `cx`, entered after every
 * entry its body defines: its name and columns, one per attribute of the call's row.
 */
const definedEvaluation = (
	read: NodeOf<"Call">,
	cx: LowerContext,
	ctes: Set<Cte>
): { readonly name: string; readonly columns: NonEmptyReadonlyArray<string> } => {
	const query = evaluationQuery(read, cx, emptyEnv)
	const origin = originOf(read)
	const name = cx.relationAlias(origin)
	const [first, ...rest] = Array.from({ length: evaluationWidth(read) }, () =>
		cx.supply.column(origin)
	)
	if (first === undefined) {
		throw defect("a call's row, of at least one field")
	}
	const columns: NonEmptyReadonlyArray<string> = [first, ...rest]
	ctes.add({ name, columns, materialized: "MATERIALIZED", query })
	return { name, columns }
}

/**
 * A read of a field of a declared function's one row (Fn.row): the rows the field holds for its arguments, a
 * set, each value of its declared type (calledRows), read from the call's evaluation (evaluationOf) by unnesting the
 * field's array of rows.
 *
 *   SELECT DISTINCT r4.c5::<its type>, r4.c6::<its type>
 *     FROM <level>.<function>(<args>) AS r3(c1, c2, c3), LATERAL pg_catalog.unnest(r3.c2) AS r4(c5, c6)
 *     WHERE (pg_catalog.num_nonnulls(r3.c1, r3.c2, r3.c3) = 3 OR <level>.__refuse(...))
 *       AND (pg_catalog.num_nonnulls(r4.c5, r4.c6) = 2 OR <level>.__refuse(...))
 *
 * The call's row is evaluated once for every read of its fields a query around the read hosts
 * (LowerContext.hostedEvaluation): a region's LATERAL item for the reads its occurrences make, a statement's
 * MATERIALIZED CTE for every read of a call over parameters alone; a read no host holds evaluates the call itself, as
 * above. A row holding NULL at any field is refused where it is evaluated, before any field of it is read, so an empty
 * array is a field of no rows, the empty source, and a NULL one never reads as one; a row of a field that holds NULL,
 * a NULL element of the array among them, which unnest reads as a row of NULLs, is refused where the field is read.
 */
const lowerField = (
	node: NodeOf<"Call">,
	called: Extract<CallFunction, { readonly kind: "field" }>,
	cx: LowerContext,
	env: Env
): OperandSelect => {
	const hosted = cx.hostedEvaluation(node, cx.evaluationKey(node), env)
	return hosted === undefined
		? cx.evaluationOf(node, env, () =>
				fieldRows(node, called, cx, ownEvaluation(node, called, cx, env))
			)
		: fieldRows(node, called, cx, { ...hosted, where: [] })
}

/**
 * A field read's rows from its call's evaluation, `evaluated`: the evaluation's FROM items, where the read places the
 * evaluation itself, or a host's read of it, beside the field's array unnested (lowerField).
 */
const fieldRows = (
	node: NodeOf<"Call">,
	called: Extract<CallFunction, { readonly kind: "field" }>,
	cx: LowerContext,
	evaluated: {
		readonly from: ReadonlyArray<FromSource>
		readonly attributes: NonEmptyReadonlyArray<Expr>
		readonly where: ReadonlyArray<Expr>
	}
): OperandSelect => {
	const array = defined(
		evaluated.attributes[fieldAt(called)],
		"the attribute of the field a read reads"
	)
	const alias = cx.relationAlias(originOf(node))
	const columns = node.heading.map(() => cx.supply.column(originOf(node)))
	const reads = columns.map((c) => col(alias, c))
	if (!isNonEmpty(reads)) {
		throw defect("a field's heading, of at least one field")
	}
	const rows: FromSource = {
		kind: "function",
		call: call("unnest", [array]),
		alias,
		columns,
		lateral: evaluated.from.length > 0,
		ordinality: false
	}
	const noNullRow = refusingNull(
		cx,
		called.name,
		reads,
		`a row holding NULL in field ${called.field}`
	)
	return calledRows(node, reads, [...evaluated.from, rows], [...evaluated.where, noNullRow], cx)
}

/**
 * A token split's call (r.tokens): the tokens of its text, each numbered by its place from 0.
 *
 *   SELECT r3.c4 - 1, r3.c3
 *     FROM pg_catalog.unnest(pg_catalog.string_to_array(<the text collapsed>, ' ')) WITH ORDINALITY AS r3(c3, c4)
 *
 * The text collapsed (expr/ops.ts collapsedText) holds its tokens, each run of no XML whitespace, one space apart and
 * none at either end, so its pieces split at the spaces are its tokens in order, and the collapse of a text of
 * whitespace alone is the empty text, whose split is the empty array (PostgreSQL's string_to_array: "If the input
 * string is empty, an empty array is returned"), so it has none. WITH ORDINALITY numbers each piece by its place from
 * 1, so a token's place is its number less 1; two tokens never share one, so the rows are a set its place keys, and no
 * token is NULL.
 */
const lowerTokens = (node: NodeOf<"Call">, cx: LowerContext, env: Env): OperandSelect => {
	const [text, ...more] = node.args
	if (text?.kind !== "value" || more.length > 0) {
		throw defect("a token split's one argument, its text")
	}
	const origin = { kind: "node", node: node.id } as const
	const alias = cx.relationAlias(origin)
	const piece = cx.supply.column(origin)
	const number = cx.supply.column(origin)
	const item: FromSource = {
		kind: "function",
		call: call("unnest", [
			call("string_to_array", [
				collapsedText(lowerExpr(cx, text.expr, env)),
				lit.text(" ", types.text)
			])
		]),
		alias,
		columns: [piece, number],
		lateral: false,
		ordinality: true
	}
	/** A column of the split's heading: a token's place, its number less 1, or the token, its piece. */
	const delivered = (name: string): Expr => {
		if (name === tokensHeading.at) {
			return binary("-", col(alias, number), lit.int(1, types.bigint))
		}
		if (name === tokensHeading.token) {
			return col(alias, piece)
		}
		throw defect(`a token split's heading of its place and its token, not ${name}`)
	}
	const heading = node.heading
	if (!isNonEmpty(heading)) {
		throw defect("a token split's heading, its place and its token")
	}
	return select(
		keyedSet(
			mapNonEmpty(heading, (c) => target(delivered(c.name))),
			[item],
			undefined,
			"a token split's rows"
		)
	)
}

/**
 * A series' call (r.series): each integer from its low end to its high end, both included, none where the low end lies
 * above the high end.
 *
 *   SELECT r3.c3 FROM pg_catalog.generate_series(<low>::<type>, <high>::<type>) AS r3(c3)
 *
 * Each end is cast to the element's type's base, the common type the checker gave them, so generate_series is the one
 * overload of that type; it yields every value from the low end to the high end stepping by 1, each once, so the rows
 * are a set its one column keys, and none is NULL (an end is never NULL). Each element lies between its row's ends,
 * which is what a rule reads of it (check/checker.ts Checker.series).
 */
const lowerSeries = (node: NodeOf<"Call">, cx: LowerContext, env: Env): OperandSelect => {
	const end = (name: string): Expr => {
		const a = node.args.find((x) => x.name === name)
		if (a?.kind !== "value") {
			throw defect(`a series' ${name} end, a value argument`)
		}
		return cast(lowerExpr(cx, a.expr, env), cx.baseTypeRef(a.type))
	}
	const origin = originOf(node)
	const alias = cx.relationAlias(origin)
	const element = cx.supply.column(origin)
	const item: FromSource = {
		kind: "function",
		call: call("generate_series", [end(seriesArguments.low), end(seriesArguments.high)]),
		alias,
		columns: [element],
		lateral: false,
		ordinality: false
	}
	const [column, ...more] = node.heading
	if (column?.name !== seriesHeading.at || more.length > 0) {
		throw defect("a series' heading, its element")
	}
	return select(keyedSet([target(col(alias, element))], [item], undefined, "a series' rows"))
}

/** Each split's rows (ir/rel.ts TextSplit): a token split's (lowerTokens). */
const splitLowerings: {
	readonly [K in TextSplit]: (node: NodeOf<"Call">, cx: LowerContext, env: Env) => OperandSelect
} = { tokens: lowerTokens }

/**
 * Call: the rows a function returns for its arguments, a set, by its function (ir/rel.ts CallFunction): a declared
 * function's (lowerDeclared), a field's of a declared function's one row (lowerField), or one of grizzle's splits'
 * (splitLowerings).
 */
const lowerCall: NodeLowerer<"Call"> = (node, cx, env) => {
	const called = node.function
	switch (called.kind) {
		case "declared":
			return lowerDeclared(node, called, cx, env)
		case "field":
			return lowerField(node, called, cx, env)
		case "split":
			return splitLowerings[called.split](node, cx, env)
		case "series":
			return lowerSeries(node, cx, env)
	}
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const callLowering: Lowerers<"Call"> = { Call: lowerCall }
