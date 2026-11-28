/**
 * The rule judge's deltas (physical/ddl/rules.ts addRules): for each side of each table a rule over a query or a stored
 * relation's upkeep reads, its row type, the rows a capture writes of it into the transaction's log, how the judge nets
 * them, and how a judged statement reads them. physical/ddl/rules.ts holds the captures, the log, the judge, its parts
 * and its blocks.
 *
 * A delta is a value, never a relation: the rows of one side, an array of its row type, which a capture builds from its
 * statement's transition table and appends to the transaction's log, which the judge claims at COMMIT into a PL/pgSQL
 * variable of its own, and which each part and block of it takes as an argument. A judged statement reads it as
 * `unnest(<variable>)`: one function scan of the array PostgreSQL holds in memory, no relation's pages, no catalog row
 * and no WAL. A selection a statement reads it under, conjuncts over its own columns and constants, is its own array,
 * each part's pass over the delta's rows making it once for every statement that reads it (`DeltaSelections`,
 * `selectionsMade`), so each read reads the rows its selection admits, never the whole delta.
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { ProbeSide } from "#compiler/analysis/theory/query.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { type Identity, identity } from "#compiler/core/identity.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { weightOf } from "#compiler/core/zset.ts"
import type { TheoryTable } from "#compiler/ir/law.ts"
import { sessionTypeRef } from "#compiler/ir/physical.ts"
import type { DeltaRelation } from "#compiler/lower/conservative/types.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { byLanguage } from "#compiler/physical/ddl/row-functions.ts"
import type {
	ColumnDefinition,
	CreateRowType,
	Expr,
	FromSource,
	ObjectName,
	OperandSelect,
	PlDeclaration,
	PlStatement,
	Revoke,
	SelectCore,
	TransitionTable,
	TypeRef
} from "#compiler/sql/ast.ts"
import { selectColumns, transitionTables } from "#compiler/sql/ast.ts"
import {
	and,
	call,
	cast,
	col,
	cUtf8Collation,
	derived,
	desc,
	eq,
	firstNonNull,
	gt,
	isIn,
	lit,
	namedType,
	notExists,
	provedCore,
	row,
	select,
	simpleSelect,
	targetAs,
	types,
	windowOf
} from "#compiler/sql/build.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { identityHooks, inertVisitor, Transform, visitSelect } from "#compiler/sql/transform.ts"
import { installedTypes } from "#compiler/sql/type-schemas.ts"

/**
 * The stem of the name of a delta of each side (identity.ruleDelta): the side of what a transaction adds is `news` and
 * of what it removes `olds`, as every capture and the judge name them.
 */
const deltaStem = { added: "news", removed: "olds" } as const satisfies Record<ProbeSide, string>

/**
 * A delta of one side of a table (`addRules`): its identity and name, which its row type, its column of the log and
 * every variable that holds its rows take; its relation's heading in the canonical order a query reads it in, a Delta
 * node's (check/checker.ts), each field by its base type (ir/physical.ts sessionTypeRef), so no row type of the judge
 * depends on a domain a migration alters or drops (PostgreSQL refuses ALTER DOMAIN ... ADD CONSTRAINT over a domain
 * an attribute of a composite some column holds is typed by); and its row's attributes: the heading's, then, on the side
 * of news, the count of each image (`countColumn`).
 */
export interface Delta {
	readonly ident: Identity<"ruleDelta">
	readonly name: string
	/**
	 * Where the delta sorts among the judge's deltas: its relation's declared name, then its side's stem, the same under
	 * any installation's name, where its name's digest is the installation's, so every list of deltas the judge prints,
	 * its log's columns, its claims, its nettings and its parts' arguments, stands in one order whatever schema it is
	 * installed in.
	 */
	readonly order: string
	readonly columns: NonEmptyReadonlyArray<ColumnDefinition>
	readonly row: NonEmptyReadonlyArray<ColumnDefinition>
}

/**
 * The column a side of news counts each image it holds in (`addRules`): the image's weight in the transaction's change,
 * a Z-set (core/zset.ts weightOf), 1 for an image a statement put and -1 for one it removed. No heading column is so
 * named: a declared field's column never starts with `__`, and a law column's name carries its digest after its stem.
 */
export const countColumn = "__count"

/**
 * One side of a table the judge holds: its delta, and the columns a statement's UPDATE of a row must change for the
 * row to stand in it, the key and every column a rule reads on that side (analysis/theory/query.ts Touches), none
 * where no rule's facts on that side read a column the UPDATE can change. A row's image is its value in those columns.
 */
export interface JudgedSide {
	readonly side: ProbeSide
	readonly delta: Delta
	readonly read: ReadonlyArray<string>
}

/**
 * The delta of `relation`'s side `side` (`Delta`): its columns, its relation's heading's, each of its field's base type
 * (ir/physical.ts sessionTypeRef: never an installation's domain, a set's bits too; a text column collated C.UTF-8 as
 * every stored text column is), its row's, and its name.
 */
export const deltaOf = (b: InstallBuilder, relation: TheoryTable, side: ProbeSide): Delta => {
	const columns = mapNonEmpty(relation.heading, (f): ColumnDefinition => {
		const type = sessionTypeRef(b.names, f.type)
		return {
			name: f.column,
			type,
			collation: type.kind === "builtin" && type.name === "text" ? cUtf8Collation : undefined
		}
	})
	const stored =
		side === "added"
			? [...columns, { name: countColumn, type: types.smallint, collation: undefined }]
			: columns
	const [first, ...rest] = stored
	const attributes: NonEmptyReadonlyArray<ColumnDefinition> = [
		defined(first, "a delta's first attribute"),
		...rest
	]
	const ident = identity.ruleDelta(
		headNonEmpty(b.names.levels),
		relation.name,
		deltaStem[side],
		canonicalTextOf(attributes)
	)
	return {
		ident,
		name: b.name(ident),
		order: `${relation.name}\u0000${deltaStem[side]}`,
		columns,
		row: attributes
	}
}

/** `delta`'s row type, in the installation's schema `schema`, named by its delta. */
export const deltaRowType = (schema: string, delta: Delta): ObjectName => ({
	schema,
	name: delta.name
})

/** An array of `delta`'s rows (`deltaRowType`): a variable's, an argument's and the log's column's type. */
export const deltaArrayType = (schema: string, delta: Delta): TypeRef => ({
	kind: "named",
	schema: installedTypes(schema),
	name: delta.name,
	typmod: [],
	array: true
})

/** `delta`'s row type's CREATE: its row's attributes. */
export const deltaRowTypeCreate = (schema: string, delta: Delta): CreateRowType => ({
	kind: "createRowType",
	name: deltaRowType(schema, delta),
	attributes: delta.row
})

/**
 * `delta` of `relation` as a Delta node reads it (lower/conservative/types.ts DeltaRelation): a CTE of the delta's name,
 * which no statement holds, each field of its relation's heading in the column of its place, c<n>: `headed` reads each
 * read of it from the array of the selection the statement reads it under, its columns those.
 */
export const deltaRelation = (relation: TheoryTable, delta: Delta): DeltaRelation => ({
	kind: "cte",
	cte: delta.name,
	columns: relation.heading.map((f, at) => ({ field: f.name, column: `c${at + 1}` }))
})

/** The PL/pgSQL variable, or argument, that holds `delta`'s rows: its name. */
export const deltaVariable = (delta: Delta): Expr => ({ kind: "plVar", name: delta.name })

/** A row of `delta` as its row type: each of `values` an attribute's, in its row's order. */
const deltaRowOf = (schema: string, delta: Delta, values: NonEmptyReadonlyArray<Expr>): Expr =>
	cast(row(values), namedType(installedTypes(schema), delta.name, []))

/**
 * The array of `delta`'s rows `rows` aggregates, of its row type, each row one element: the empty array where the query
 * aggregates no row, `coalesce(array_agg(<row>), '{}')`, so no array of the judge is NULL, and one holds a row exactly
 * where its cardinality is past 0 (`holdsRows`).
 */
const aggregated = (schema: string, delta: Delta, rows: Expr): Expr =>
	firstNonNull([call("array_agg", [rows]), lit.text("{}", deltaArrayType(schema, delta))])

/** That the array `array` holds a row: its cardinality is past 0, every array of the judge an array, never NULL. */
export const holdsRows = (array: Expr): Expr =>
	gt(call("cardinality", [array]), lit.int(0, types.integer))

/**
 * The rows of `delta`, read under `alias` with its attributes by their names, `unnest(<array>) AS <alias>`: its row
 * type's attributes, each by its name.
 */
const unnested = (array: Expr, alias: string): FromSource => ({
	kind: "function",
	call: call("unnest", [array]),
	alias,
	columns: { kind: "named", names: [], ordinality: false },
	lateral: false
})

/**
 * The array of the rows `from` delivers under `alias`, each of `delta`'s row built from its attributes there, the empty
 * array where it delivers none (`aggregated`): `(SELECT coalesce(array_agg(ROW(<alias>.<attribute>, ...)::<row type>),
 * '{}') FROM ... WHERE ...)`.
 */
const rowsArray = (
	schema: string,
	delta: Delta,
	alias: string,
	from: ReadonlyArray<FromSource>,
	where: Expr | undefined
): Expr => ({
	kind: "subquery",
	query: simpleSelect(
		[
			{
				expr: aggregated(
					schema,
					delta,
					deltaRowOf(
						schema,
						delta,
						mapNonEmpty(delta.row, (c) => col(alias, c.name))
					)
				),
				alias: undefined
			}
		],
		from,
		where
	)
})

/**
 * The statement that sets `target` to the array of `delta`'s rows, each built from `values`, its attributes' values over
 * each row `from` delivers, the empty array where it delivers none (`aggregated`), `before`'s rows first where it is
 * one: `SELECT [<before> ||] coalesce(array_agg(ROW(<value>, ...)::<row type>), '{}') FROM ... WHERE ... INTO <target>`.
 * A statement of its own, never a scalar subquery of an assignment, so the binding names each level of it (sql/bind.ts
 * plannedOf), a capture's anti-join of two transition tables among them.
 */
const rowsInto = (
	schema: string,
	delta: Delta,
	target: string,
	values: NonEmptyReadonlyArray<Expr>,
	from: ReadonlyArray<FromSource>,
	where: Expr | undefined,
	before: Expr | undefined
): PlStatement => {
	const rows = aggregated(schema, delta, deltaRowOf(schema, delta, values))
	return {
		kind: "into",
		statement: select(
			provedCore(
				"oneRow",
				[
					{
						expr:
							before === undefined
								? rows
								: { kind: "binary", op: "||", left: before, right: rows, schema: undefined },
						alias: undefined
					}
				],
				from,
				where
			)
		),
		into: [target]
	}
}

/** Each of `delta`'s attributes read off its rows under `alias`, by name. */
const attributesAt = (delta: Delta, alias: string): NonEmptyReadonlyArray<Expr> =>
	mapNonEmpty(delta.row, (c) => col(alias, c.name))

/** A row's image on a side (`JudgedSide`): its primary key's columns, then every other column the side reads. */
const imageOf = (relation: TheoryTable, side: JudgedSide): NonEmptyReadonlyArray<string> => {
	const [first, ...rest] = mapNonEmpty(relation.primaryFields, (f): string => f.column)
	return [first, ...rest, ...side.read.filter((c) => c !== first && !rest.includes(c))]
}

/**
 * The rows of one side a statement wrote, as the array a capture appends to the transaction's log, the empty array
 * where it wrote none of them (`aggregated`): every row of the transition table `rows`, or, for an UPDATE, each row the other transition table holds
 * no row of with the same image (`imageOf`), so an UPDATE of columns no rule reads there captures nothing. Every row
 * stands once in a transition table, and its key with it, so the rows are a set. The side of olds takes the rows a
 * statement found as they are. The side of news counts each image by its weight (core/zset.ts weightOf): 1 for a row
 * the statement put (`news`), -1 for one it removed (`olds`), every removal counted, which the judge nets (`netted`):
 * the transaction's change is the Z-set of every image it put and removed, whatever order its statements ran in.
 */
export const captured = (
	schema: string,
	relation: TheoryTable,
	side: JudgedSide,
	rows: TransitionTable,
	other: TransitionTable | undefined,
	before: Expr | undefined
): PlStatement => {
	const unchanged =
		other === undefined
			? undefined
			: notExists(
					simpleSelect(
						[],
						[{ kind: "transition", table: other, alias: "r2" }],
						and(mapNonEmpty(imageOf(relation, side), (c) => eq(col("r2", c), col("r1", c))))
					)
				)
	const values = mapNonEmpty(side.delta.columns, (c) => col("r1", c.name))
	const [first, ...rest] =
		side.side === "added"
			? [
					...values,
					lit.int(weightOf[rows === transitionTables.olds ? "removed" : "added"], types.smallint)
				]
			: values
	return rowsInto(
		schema,
		side.delta,
		side.delta.name,
		[defined(first, "a captured row's value"), ...rest],
		[{ kind: "transition", table: rows, alias: "r1" }],
		unchanged,
		before
	)
}

/**
 * The side of news a delta holds netted (`addRules`'s judge): of each image, the rows whose counts sum to 0 or less go,
 * and every row but one of each other image, which stands at COMMIT and stood nowhere before the transaction, so the
 * delta holds delta.added of its relation's images, each once: the relation's rows as the transaction leaves them minus
 * those it found (check/checker.ts Delta). That is the Z-set's one netting rule (core/zset.ts): an image's sum is its
 * weights, its puts less its removals, whatever order a statement's captures ran in, 1 where the transaction put it and
 * it stands, -1 where it removed one it found, 0 where it put and removed it, or removed one it found and put it back;
 * and it stands added where its sum is positive (sideOf). The empty array where no image stands added.
 *
 *   <delta> := (SELECT coalesce(array_agg(ROW(r2.c1, ..., r2.__count)::<row type>), '{}') FROM (SELECT r1.<column> AS c1, ...,
 *     sum(r1.__count) OVER (PARTITION BY <image>) AS ..., row_number() OVER (PARTITION BY <image> ORDER BY
 *     r1.__count DESC) AS ... FROM unnest(<delta>) AS r1) AS r2 WHERE <sum> > 0 AND <row number> = 1)
 */
export const netted = (schema: string, relation: TheoryTable, side: JudgedSide): PlStatement => {
	const delta = side.delta
	const image = mapNonEmpty(imageOf(relation, side), (c) => col("r1", c))
	const placed = delta.row.map((c, at) => targetAs(col("r1", c.name), `c${at + 1}`))
	const sum = `c${delta.row.length + 1}`
	const rank = `c${delta.row.length + 2}`
	const counts = simpleSelect(
		[
			...placed,
			targetAs({ ...call("sum", [col("r1", countColumn)]), over: windowOf(image, []) }, sum),
			targetAs(
				{ ...call("row_number", []), over: windowOf(image, [desc(col("r1", countColumn))]) },
				rank
			)
		],
		[unnested(deltaVariable(delta), "r1")],
		undefined
	)
	return rowsInto(
		schema,
		delta,
		delta.name,
		mapNonEmpty(delta.row, (_, at) => col("r2", `c${at + 1}`)),
		[derived(counts, "r2", false)],
		and([
			gt(col("r2", sum), lit.int(0, types.bigint)),
			eq(col("r2", rank), lit.int(1, types.bigint))
		]),
		undefined
	)
}

/** A judged table's side as the judge's statements read it (`DeltaSelections`): its relation, the side and its delta. */
export interface ReadDelta {
	readonly relation: TheoryTable
	readonly side: ProbeSide
	readonly delta: Delta
}

/**
 * A selection of a delta a judged statement reads (`headed`): the side it reads; its conjuncts, each of the statement's
 * own over the read's columns and constants alone, each over the delta's rows `r1` (`overDelta`), in the order of their
 * texts, none where the statement reads every row; and the variable, or argument, that holds the rows it admits: the
 * delta's own where it admits every row (`deltaVariable`), else its own (identity.ruleDeltaSelection), named by the
 * delta and the conjuncts' texts, which the part that runs the statement's block makes (`selectionsMade`).
 */
export interface DeltaSelection extends ReadDelta {
	readonly conditions: ReadonlyArray<Expr>
	readonly variable: string
	/**
	 * Its identity, the delta's own where it admits every row: what names a block that takes it (identity.ruleJudgeBlock,
	 * identity.storedUpkeep), an identity, never its variable's text, so a block's name reads as one identity under any
	 * installation's name.
	 */
	readonly ident: Identity<"ruleDeltaSelection" | "ruleDelta">
	/** Where it sorts among the selections: its delta's order (Delta `order`), then its conjuncts' texts. */
	readonly order: string
}

/**
 * The selections of the deltas an installation's judged statements read (`headed`), each once by its delta and its
 * conjuncts however many statements read it: each one array a part makes once for every block of it that reads it.
 */
export class DeltaSelections {
	readonly #b: InstallBuilder
	readonly #deltas: ReadonlyMap<string, ReadDelta>
	readonly #selections = new Map<string, Map<string, DeltaSelection>>()

	constructor(b: InstallBuilder, deltas: ReadonlyArray<ReadDelta>) {
		this.#b = b
		this.#deltas = new Map(deltas.map((d) => [d.delta.name, d] as const))
	}

	/** The side whose delta is named `name`, none where no delta is. */
	delta(name: string): ReadDelta | undefined {
		return this.#deltas.get(name)
	}

	/**
	 * The selection of `of`'s delta under `conjuncts`, each over its rows `r1`: each conjunct once, in the order of its
	 * text as an identity reads it, each pattern by its language (row-functions.ts byLanguage), so every statement that
	 * reads the delta under the same conditions reads one array, and two spellings of one language one.
	 */
	select(of: ReadDelta, conjuncts: ReadonlyArray<Expr>): DeltaSelection {
		const named = new Transform({
			...identityHooks,
			expr: (e) => byLanguage((are) => this.#b.languageOf(are), e)
		})
		const distinct = [
			...new Map(conjuncts.map((e) => [printExpr(named.expr(e)), e] as const)).entries()
		].toSorted(([x], [y]) => compareStrings(x, y))
		const texts = distinct.map(([text]) => text)
		const ident: Identity<"ruleDeltaSelection" | "ruleDelta"> = isNonEmpty(texts)
			? identity.ruleDeltaSelection(of.relation.name, deltaStem[of.side], of.delta.ident, texts)
			: of.delta.ident
		const variable = isNonEmpty(texts) ? this.#b.name(ident) : of.delta.name
		const held = this.#selections.getOrInsertComputed(of.delta.name, () => new Map())
		const found = held.get(variable)
		if (found !== undefined) {
			return found
		}
		const selection: DeltaSelection = {
			...of,
			conditions: distinct.map(([, e]) => e),
			variable,
			ident,
			order: [of.delta.order, ...texts].join("\u0000")
		}
		held.set(variable, selection)
		return selection
	}

	/**
	 * The selections `body`, a block's or the judge's statements, reads, each once, in their order (DeltaSelection `order`): the
	 * arguments a block takes and the arrays its part makes for it (`selectionsMade`).
	 */
	readBy(body: ReadonlyArray<PlStatement>): ReadonlyArray<DeltaSelection> {
		const read = new Set<string>()
		new Transform({
			...identityHooks,
			fromSource: (source) => {
				const [array] = source.kind === "function" ? source.call.args : []
				if (array?.kind === "plVar") {
					read.add(array.name)
				}
				return source
			}
		}).plStatements(body)
		return [...this.#selections.values()]
			.flatMap((held) => [...held.values()])
			.filter((s) => read.has(s.variable))
			.toSorted((x, y) => compareStrings(x.order, y.order))
	}
}

/**
 * A selection's equality with a constant over one of its delta's columns, which a pass grouping the delta's rows by that
 * column serves (`selectionsMade`): the column, the constant, and the selection's other conjuncts.
 */
interface Keyed {
	readonly selection: DeltaSelection
	readonly column: string
	readonly value: Expr
	readonly rest: ReadonlyArray<Expr>
}

/** A constant a conjunct compares a column with: a literal, cast or collated as the comparison reads it. */
const isConstant = (e: Expr): boolean =>
	e.kind === "literal" || ((e.kind === "cast" || e.kind === "collate") && isConstant(e.expr))

/**
 * `conjunct`'s equality of a column of the delta's rows `r1` with a constant, by builtin `=` (`overDelta`): the column
 * and the constant, none for any other conjunct.
 */
const equalityOf = (
	conjunct: Expr
): { readonly column: string; readonly value: Expr } | undefined => {
	if (conjunct.kind !== "binary" || conjunct.op !== "=" || conjunct.schema !== undefined) {
		return undefined
	}
	const { left, right } = conjunct
	return left.kind === "column" && left.table === "r1" && isConstant(right)
		? { column: left.column, value: right }
		: right.kind === "column" && right.table === "r1" && isConstant(left)
			? { column: right.column, value: left }
			: undefined
}

/**
 * Each of `selections`' equality with a constant over the column of its delta the most of them fix so, the fewest
 * passes over the delta's rows serving them all (`selectionsMade`), its ties by the column's name; none for a selection
 * that fixes no column.
 */
const keyedBy = (selections: ReadonlyArray<DeltaSelection>): ReadonlyArray<Keyed> => {
	const equalities = selections.map((selection) => ({
		selection,
		fixes: selection.conditions.flatMap((c, at) => {
			const equality = equalityOf(c)
			return equality === undefined
				? []
				: [{ ...equality, at, family: `${selection.delta.order}\u0000${equality.column}` }]
		})
	}))
	const fixing = new Map<string, number>()
	for (const { fixes } of equalities) {
		for (const family of new Set(fixes.map((f) => f.family))) {
			fixing.set(family, (fixing.get(family) ?? 0) + 1)
		}
	}
	return equalities.flatMap(({ selection, fixes }) => {
		const [best] = fixes.toSorted(
			(x, y) =>
				(fixing.get(y.family) ?? 0) - (fixing.get(x.family) ?? 0) ||
				compareStrings(x.family, y.family)
		)
		return best === undefined
			? []
			: [
					{
						selection,
						column: best.column,
						value: best.value,
						rest: selection.conditions.filter((_, at) => at !== best.at)
					}
				]
	})
}

/**
 * The stem of the variables of a grouped pass (`selectionsMade`), its group's key and its rows, none a delta's, a
 * selection's or the claim's.
 */
const groupStem = "__group_"

/**
 * The declarations and the statements that make each of `selections` that admits less than its whole delta, from its
 * delta's variable, in their order (DeltaSelection `order`): the array of the rows of the delta its conjuncts admit, the empty
 * array where it admits none (`rowsInto`). The selections of a delta that fix one column of it to two values or more,
 * each by an equality with a constant (`keyedBy`), are one pass over its rows, grouped by that column, each group's rows
 * the array of each selection that fixes its value, or of the rows of it the selection's other conjuncts admit; every
 * other selection is a pass of its own. So a COMMIT's judge passes over a delta's rows once for each column its
 * selections fix, however many selections fix it, where a pass for each selection read the delta's rows once for each
 * of them, edullm's giant pattern package's Node delta 92 times:
 *
 *   <selection> := (SELECT coalesce(array_agg(ROW(r1.<attribute>, ...)::<row type>), '{}') FROM unnest(<delta>) AS r1
 *     WHERE <conjuncts>);
 *
 *   <selection> := '{}'; ...
 *   FOR __group_key_<n>, __group_rows_<n> IN SELECT r1.<column> AS c1, array_agg(ROW(r1.<attribute>, ...)::<row type>)
 *       AS c2 FROM unnest(<delta>) AS r1 WHERE r1.<column> IN (<value>, ...) GROUP BY r1.<column> LOOP
 *     CASE __group_key_<n> WHEN <value> THEN <selection> := __group_rows_<n>; <selection> := (SELECT ... FROM
 *       unnest(__group_rows_<n>) AS r1 WHERE <other conjuncts>); ... END CASE;
 *   END LOOP;
 *
 * Each group's key is one the IN lists, so the CASE, which has no ELSE, finds a WHEN for each; its key variable is of
 * its column's type, its rows variable of the delta's array type, each declared, so every query PL/pgSQL plans reads
 * each by its type (sql/bind.ts plannedOf).
 */
export const selectionsMade = (
	schema: string,
	selections: ReadonlyArray<DeltaSelection>
): {
	readonly declare: ReadonlyArray<PlDeclaration>
	readonly body: ReadonlyArray<PlStatement>
} => {
	const own = selections.flatMap((s) => {
		const { conditions } = s
		return isNonEmpty(conditions) ? [{ ...s, conditions }] : []
	})
	const families = new Map<string, Array<Keyed>>()
	for (const k of keyedBy(own)) {
		families.getOrInsertComputed(`${k.selection.delta.order}\u0000${k.column}`, () => []).push(k)
	}
	const valuesOf = (members: ReadonlyArray<Keyed>): ReadonlyMap<string, ReadonlyArray<Keyed>> =>
		Map.groupBy(members, (k) => printExpr(k.value))
	const grouped = [...families.values()].filter((members) => valuesOf(members).size >= 2)
	const inGroup = new Set(grouped.flatMap((members) => members.map((k) => k.selection.variable)))
	const pass = (s: (typeof own)[number]): PlStatement =>
		rowsInto(
			schema,
			s.delta,
			s.variable,
			attributesAt(s.delta, "r1"),
			[unnested(deltaVariable(s.delta), "r1")],
			and(s.conditions),
			undefined
		)
	/** The variables of the `at`-th grouped pass: its group's key, by its column's type, and its rows. */
	const groupOf = (at: number) => ({
		key: `${groupStem}key_${at + 1}`,
		rows: `${groupStem}rows_${at + 1}`
	})
	const groupPass = (members: ReadonlyArray<Keyed>, at: number): ReadonlyArray<PlStatement> => {
		const first = defined(members[0], "a grouped pass's first selection")
		const { delta } = first.selection
		const { column } = first
		const group = groupOf(at)
		const rows: Expr = { kind: "plVar", name: group.rows }
		const [w0, ...ws] = [...valuesOf(members).values()].map((fixing) => ({
			values: [defined(fixing[0], "a group's selection").value] as const,
			body: fixing.map((k): PlStatement =>
				isNonEmpty(k.rest)
					? rowsInto(
							schema,
							delta,
							k.selection.variable,
							attributesAt(delta, "r1"),
							[unnested(rows, "r1")],
							and(k.rest),
							undefined
						)
					: { kind: "assign", target: k.selection.variable, value: rows }
			)
		}))
		const first0 = defined(w0, "a grouped pass's first value")
		return [
			...members.map((k): PlStatement => ({
				kind: "assign",
				target: k.selection.variable,
				value: lit.text("{}", deltaArrayType(schema, delta))
			})),
			{
				kind: "forQuery",
				variables: [group.key, group.rows],
				query: select({
					...provedCore(
						"grouped",
						[
							{ expr: col("r1", column), alias: "c1" },
							{
								expr: call("array_agg", [deltaRowOf(schema, delta, attributesAt(delta, "r1"))]),
								alias: "c2"
							}
						],
						[unnested(deltaVariable(delta), "r1")],
						isIn(col("r1", column), [first0.values[0], ...ws.map((w) => w.values[0])])
					),
					groupBy: [col("r1", column)]
				}),
				body: [
					{
						kind: "case",
						operand: { kind: "plVar", name: group.key },
						whens: [first0, ...ws]
					}
				]
			}
		]
	}
	return {
		declare: grouped.flatMap((members, at): ReadonlyArray<PlDeclaration> => {
			const first = defined(members[0], "a grouped pass's first selection")
			const group = groupOf(at)
			return [
				{
					name: group.key,
					type: defined(
						first.selection.delta.row.find((c) => c.name === first.column),
						"a grouped pass's column"
					).type
				},
				{ name: group.rows, type: deltaArrayType(schema, first.selection.delta) }
			]
		}),
		body: [...own.filter((s) => !inGroup.has(s.variable)).map(pass), ...grouped.flatMap(groupPass)]
	}
}

/** Each of `xs`, or none where one is none. */
const everyOf = (
	xs: NonEmptyReadonlyArray<Expr | undefined>
): NonEmptyReadonlyArray<Expr> | undefined => {
	const [first, ...rest] = xs
	const kept: Array<Expr> = []
	for (const x of rest) {
		if (x === undefined) {
			return undefined
		}
		kept.push(x)
	}
	return first === undefined ? undefined : [first, ...kept]
}

/**
 * `e`, a conjunct a core holds over the columns of its FROM items, over the delta's rows `r1`, where every column it
 * reads is a column of one read of a delta, which `column` names the delta's attribute of, and it reads at least one:
 * its columns, constants, and the operators, casts and connectives that read nothing else, each over a builtin type
 * (Expr `binary` and `equalsAny` with no schema); none for any other, a subquery, a function call or a column of
 * another source among them, which a part's pass over the delta's rows alone cannot read.
 */
const overDelta = (
	e: Expr,
	column: (read: Extract<Expr, { readonly kind: "column" }>) => string | undefined
): Expr | undefined => {
	let reads = 0
	const over = (x: Expr): Expr | undefined => {
		switch (x.kind) {
			case "column": {
				const c = column(x)
				if (c === undefined) {
					return undefined
				}
				reads += 1
				return col("r1", c)
			}
			case "literal":
				return x
			case "cast":
			case "access":
			case "collate":
			case "negate":
			case "not":
			case "isTrue": {
				const inner = over(x.expr)
				return inner === undefined ? undefined : { ...x, expr: inner }
			}
			case "binary": {
				const left = x.schema === undefined ? over(x.left) : undefined
				const right = left === undefined ? undefined : over(x.right)
				return left === undefined || right === undefined ? undefined : { ...x, left, right }
			}
			case "and":
			case "or":
			case "coalesce":
			case "greatest":
			case "least": {
				const args = everyOf(mapNonEmpty(x.args, over))
				return args === undefined ? undefined : { ...x, args }
			}
			case "between": {
				const expr = over(x.expr)
				const low = over(x.low)
				const high = over(x.high)
				return expr === undefined || low === undefined || high === undefined
					? undefined
					: { ...x, expr, low, high }
			}
			case "inList": {
				const [a, b, ...more] = x.list
				const expr = over(x.expr)
				const first = over(a)
				const second = over(b)
				const rest = everyOf([first, ...more.map(over)])
				return expr === undefined ||
					first === undefined ||
					second === undefined ||
					rest === undefined
					? undefined
					: { ...x, expr, list: [first, second, ...rest.slice(1)] }
			}
			case "equalsAny": {
				const expr = x.schema === undefined ? over(x.expr) : undefined
				const array = expr === undefined ? undefined : over(x.array)
				return expr === undefined || array === undefined ? undefined : { ...x, expr, array }
			}
			case "nullif": {
				const expr = over(x.expr)
				const absent = over(x.absent)
				return expr === undefined || absent === undefined ? undefined : { ...x, expr, absent }
			}
			case "excluded":
			case "returning":
			case "param":
			case "clock":
			case "exists":
			case "subquery":
			case "array":
			case "row":
			case "case":
			case "call":
			case "domainValue":
			case "user":
			case "plVar":
			case "plSpecial":
			case "field":
			case "regclass":
			case "complement":
			case "lowerAscii":
			case "subscript":
			case "attribute":
				return undefined
		}
	}
	const moved = over(e)
	return moved === undefined || reads === 0 ? undefined : moved
}

/** `e`'s conjuncts: the arguments of each AND it is, at any depth, and itself where it is no AND. */
const conjunctsOf = (e: Expr): ReadonlyArray<Expr> =>
	e.kind === "and" ? e.args.flatMap(conjunctsOf) : [e]

/** The place in a delta's columns of its CTE's column `c<n>` (`deltaRelation`), none for any other name. */
const columnPlace = (column: string): number | undefined => {
	const digits = column.startsWith("c") ? column.slice(1) : ""
	const n = Number(digits)
	return digits !== "" && Number.isSafeInteger(n) && String(n) === digits && n >= 1
		? n - 1
		: undefined
}

/** The column of the delta each column `c<n>` of its CTE holds (`deltaRelation`), none for any other name. */
const deltaColumnAt = (of: ReadDelta, column: string): string | undefined => {
	const at = columnPlace(column)
	return at === undefined ? undefined : of.delta.columns[at]?.name
}

/**
 * A pass-through projection a statement reads a delta through (`headed`): a derived table of one core that projects
 * columns of one source alone, a read of a delta, `read` saying which CTE names one, or another such projection, under
 * no condition, grouping, order or limit; its alias, its columns, and each target's column read of the source.
 */
interface PassThrough {
	readonly source: Extract<FromSource, { readonly kind: "derived" }>
	readonly core: SelectCore
	readonly inner: FromSource
	readonly reads: ReadonlyArray<Extract<Expr, { readonly kind: "column" }>>
}

/** `source` as a pass-through projection over a read of a delta (`PassThrough`), none where it is none. */
const passThrough = (
	source: FromSource,
	read: (name: string) => boolean
): PassThrough | undefined => {
	if (source.kind !== "derived") {
		return undefined
	}
	const query = source.query
	const core = query.body
	if (
		query.with !== undefined ||
		query.orderBy.length > 0 ||
		query.limit !== undefined ||
		query.offset !== undefined ||
		core.kind !== "core" ||
		core.where !== undefined ||
		core.groupBy.length > 0 ||
		core.having !== undefined ||
		(core.distinct !== false && core.distinct !== true)
	) {
		return undefined
	}
	const [inner, ...others] = core.from
	if (inner === undefined || inner.kind === "joins" || others.length > 0) {
		return undefined
	}
	const below = inner.kind === "cte" ? read(inner.name) : passThrough(inner, read) !== undefined
	const reads = core.targets.flatMap((t) => (t.expr.kind === "column" ? [t.expr] : []))
	return below && reads.length === core.targets.length ? { source, core, inner, reads } : undefined
}

/**
 * A read of a delta a core's FROM holds (`headed`): the side it reads; the delta's column each column the core reads of
 * it holds, by its alias and name; and the source with the delta's CTE read from `array` in its place. A read is the
 * delta's CTE itself (lower/conservative/delta), or a pass-through projection of one (`passThrough`: a filter's input
 * over a delta, and each projection pruning leaves around it), whose i-th target names the column the derived table's
 * i-th name holds.
 */
interface HeldRead {
	readonly of: ReadDelta
	readonly column: (read: Extract<Expr, { readonly kind: "column" }>) => string | undefined
	readonly from: (variable: string) => FromSource
}

/** The rows of the array `variable` holds read where the delta's CTE `source` stood, under its alias, by its columns. */
const fromArray = (
	source: Extract<FromSource, { readonly kind: "cte" }>,
	of: ReadDelta,
	variable: string
): FromSource => ({
	kind: "function",
	call: call("unnest", [{ kind: "plVar", name: variable }]),
	alias: source.alias ?? source.name,
	columns: {
		kind: "named",
		names: of.delta.columns.map((_, at) => `c${at + 1}`),
		ordinality: false
	},
	lateral: false
})

/** `source` as a read of a delta `selections` holds (`HeldRead`), none where it reads none. */
const heldRead = (source: FromSource, selections: DeltaSelections): HeldRead | undefined => {
	if (source.kind === "cte") {
		const of = selections.delta(source.name)
		const alias = source.alias ?? source.name
		return of === undefined
			? undefined
			: {
					of,
					column: (read) => (read.table === alias ? deltaColumnAt(of, read.column) : undefined),
					from: (variable) => fromArray(source, of, variable)
				}
	}
	const p = passThrough(source, (name) => selections.delta(name) !== undefined)
	const below = p === undefined ? undefined : heldRead(p.inner, selections)
	if (p === undefined || below === undefined) {
		return undefined
	}
	const projected = p.reads.map((read) => below.column(read))
	if (projected.some((c) => c === undefined)) {
		return undefined
	}
	return {
		of: below.of,
		column: (read) =>
			read.table === p.source.alias
				? projected[selectColumns(p.source.query).indexOf(read.column)]
				: undefined,
		from: (variable) => ({
			...p.source,
			query: { ...p.source.query, body: { ...p.core, from: [below.from(variable)] } }
		})
	}
}

/**
 * `statement` with every read of a delta read from the array of the rows its selection admits (`DeltaSelections`),
 * `unnest(<selection's variable>) AS <alias>(c1, ..., cn)`: a core's conjuncts over the columns of one read in its FROM
 * and constants alone (`overDelta`), each moved from its WHERE into the read's selection, which its part makes once for
 * every statement that reads it (`selectionsMade`), so the read reads the rows the selection admits and no other; a read
 * the core holds no such conjunct of reads every row, from the delta's own variable. Only a read where the WHERE meets
 * every row it delivers takes one, so never a LEFT join's source, whose rows the join completes. A judge's read of a
 * delta of 253,458 nodes whose rule constrains the nodes of one kind read every node, and kept that kind's: 92 statements
 * of the giant pattern package's COMMIT read 23.3 million rows, 23.3 s (edullm's s18 at 39989d602), where each read of
 * its kind reads that kind's rows.
 */
export const headed = (statement: OperandSelect, selections: DeltaSelections): OperandSelect => {
	const moved = new Transform({
		...identityHooks,
		core: (core) => {
			const sources = core.from.flatMap((item): ReadonlyArray<FromSource> =>
				item.kind === "joins"
					? [item.first, ...item.steps.flatMap((s) => (s.kind === "left" ? [] : [s.source]))]
					: [item]
			)
			const held = new Map(
				sources.flatMap((source) => {
					const read = heldRead(source, selections)
					return read === undefined ? [] : [[source, read] as const]
				})
			)
			if (held.size === 0) {
				return core
			}
			const conjuncts = core.where === undefined ? [] : conjunctsOf(core.where)
			const into = new Map<FromSource, Array<Expr>>()
			const kept = conjuncts.filter((conjunct) => {
				for (const [source, read] of held) {
					const over = overDelta(conjunct, read.column)
					if (over === undefined) {
						continue
					}
					into.getOrInsertComputed(source, () => []).push(over)
					return false
				}
				return true
			})
			if (into.size === 0) {
				return core
			}
			const replaced = (source: FromSource): FromSource => {
				const read = held.get(source)
				const conditions = into.get(source)
				return read === undefined || conditions === undefined
					? source
					: read.from(selections.select(read.of, conditions).variable)
			}
			return {
				...core,
				from: core.from.map((item) =>
					item.kind === "joins"
						? {
								...item,
								first: replaced(item.first),
								steps: mapNonEmpty(item.steps, (s) => ({ ...s, source: replaced(s.source) }))
							}
						: replaced(item)
				),
				where: isNonEmpty(kept) ? (kept.length === 1 ? headNonEmpty(kept) : and(kept)) : undefined
			}
		}
	}).select(statement)
	return new Transform({
		...identityHooks,
		fromSource: (source) => {
			if (source.kind !== "cte") {
				return source
			}
			const of = selections.delta(source.name)
			return of === undefined ? source : fromArray(source, of, selections.select(of, []).variable)
		}
	}).select(moved)
}

/** Whether `statement` reads a delta that `headed` has not read from an array: a judged statement's defect. */
export const readsDeltaUnheaded = (
	statement: OperandSelect,
	selections: DeltaSelections
): boolean => {
	let unheaded = false
	visitSelect(statement, {
		...inertVisitor,
		fromItem: (item) => {
			const sources =
				item.kind === "joins" ? [item.first, ...item.steps.map((s) => s.source)] : [item]
			unheaded ||= sources.some(
				(source) => source.kind === "cte" && selections.delta(source.name) !== undefined
			)
		}
	})
	return unheaded
}

/** REVOKE EXECUTE ON FUNCTION <fn>(<args>) FROM PUBLIC. */
export const revokeOf = (fn: ObjectName, args: ReadonlyArray<TypeRef>): Revoke => ({
	kind: "revoke",
	privileges: ["EXECUTE"],
	on: { kind: "FUNCTION", names: [{ ...fn, args }] },
	from: [{ kind: "PUBLIC" }]
})

/** The rows of `delta` an array of it holds, read under `alias` by its attributes' names (`unnested`). */
export const deltaRows = (array: Expr, alias: string): FromSource => unnested(array, alias)

/** The core of one row's aggregate over `from`: `provedCore("oneRow", ...)`, a statement's one row. */
export const oneRowOf = (
	targets: NonEmptyReadonlyArray<{ readonly expr: Expr; readonly alias: string | undefined }>,
	from: ReadonlyArray<FromSource>,
	where: Expr | undefined
): SelectCore => provedCore("oneRow", targets, from, where)

export { deltaStem, rowsArray }
