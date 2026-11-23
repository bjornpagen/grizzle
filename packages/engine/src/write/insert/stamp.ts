/**
 * An insert's stamps (ir/instant.ts): the fields its rows leave out, each stamped from its head at the row's child:
 * an instant with the call's instant of its clock, `greatest(c, h + 1)`, c the call's reading of the database's clock
 * in microseconds and h the child's head, the last instant stamped at it, none for a child never stamped; a place with
 * `coalesce(h + 1, 0)`, h the greatest place its group holds. The head is the child's row of the head's table, which the
 * head's stamp function advances and returns (physical/ddl/stamps.ts).
 *
 * Its input is read once, then each head's stamps are taken once per child, each child read once from the input's
 * distinct children, so the stamps are keyed by their child and want no second duplicate elimination, and the input is
 * read again with them, so every statement after reads complete facts, the input's own fields and the stamped ones
 * alike:
 *
 *   "<input>"("<x1>", …) AS (<the input's read of the fields it carries>),
 *   "<stamps>"("<c1>", …, "<at>") AS MATERIALIZED (
 *     SELECT "<s>"."<child 1>", …, "<s>"."<at>"
 *     FROM (SELECT (array_agg("<d>"."<c1>" ORDER BY "<d>"."<c1>", …))::<type 1>[], …
 *           FROM (SELECT DISTINCT "<input>"."<x1>", … FROM "<input>") AS "<d>"("<c1>", …)) AS "<a>"("<a1>", …),
 *          LATERAL "<level>"."<stamp>"("<a>"."<a1>", …[, <clock>]) AS "<s>"),
 *   "<r1>"(…) AS (SELECT "<input>"."<x1>", …, "<stamps>"."<at>" FROM "<input>" JOIN "<stamps>" ON
 *     "<input>"."<x1>" = "<stamps>"."<c1>" AND …)
 *
 * Each insert's CTE of a head's stamps calls the function once, MATERIALIZED, and the function stamps each child once a
 * call, returning a head its own call advanced as it stands, so the parts of one stratum's single statement that stamp
 * one clock at one child, its own rows and its references' alike, stamp one instant; so do a place's, one place for
 * every row of the call in its group. It locks each child's head until the call ends, so two calls that stamp one
 * child take turns at every level, the later stamping after the earlier's head, and calls that stamp different
 * children wait on nothing of each other's. The clock is the call's transaction_timestamp(), one value
 * in every statement of the call, or the instant the call states under a moved clock
 * (lower/conservative/context.ts clockReading).
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	concatNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import {
	type Computed,
	type Head,
	type HeadStamp,
	headStamped,
	sameStamp,
	type Stamped
} from "#compiler/ir/instant.ts"
import type { LawField, RelationInfo } from "#compiler/ir/law.ts"
import { fieldColumnType } from "#compiler/ir/physical.ts"
import { emptyEnv } from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import type {
	Cte,
	Delete,
	Expr,
	FromItem,
	FunctionParam,
	JoinStep,
	OperandSelect,
	Select,
	TypeRef
} from "#compiler/sql/ast.ts"
import {
	and,
	arrayOf,
	asc,
	call,
	cast,
	col,
	core,
	cte,
	cteRef,
	cteRefAs,
	derived,
	distinctCore,
	eq,
	operandSelect,
	provedCore,
	qualifiedCall,
	select,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"
import type { FieldColumns } from "#compiler/write/defined.ts"
import { statedKey } from "#compiler/write/family/keyset.ts"
import { written } from "#compiler/write/family/written.ts"
import type { WriteContext } from "#compiler/write/insert/statement.ts"

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** One head's stamps of an insert: its stamp source, the stamped fields it fills, and its CTE's names. */
interface StampGroup extends HeadStamps {
	readonly stamp: HeadStamp
	readonly fields: NonEmptyReadonlyArray<LawField>
}

/** A head's stamps as a CTE: its name, a column for each field of the head's child, in the head's child order, and the
 * stamp's column. */
export interface HeadStamps {
	readonly name: string
	readonly child: NonEmptyReadonlyArray<string>
	readonly at: string
}

/** The clock reading's parameter of a clock's stamp function (`stampParams`). */
export const stampClockParam = "__clock"

/** A head's stamp function's parameters: an array of each child field's values, in key order, `__children_1` the first,
 * and a clock's reading in microseconds, `__clock`. A declared name never starts with `__`, so no column the function's
 * statement names is one of them. */
export const stampParams = (
	head: Head,
	columnType: (field: LawField) => TypeRef
): NonEmptyReadonlyArray<FunctionParam> => {
	const children = mapNonEmpty(head.child, (field, at): FunctionParam => {
		const array = arrayOf(columnType(field))
		if (array === undefined) {
			throw defect(`a child field ${head.relation}.${field.name} of a type with an array`)
		}
		return { name: `__children_${at + 1}`, type: array }
	})
	switch (head.kind) {
		case "clock":
			return [...children, { name: stampClockParam, type: types.bigint }]
		case "place":
			return children
	}
}

/**
 * The CTE `names` of `head`'s stamps at each child `children` holds, one row a child, its columns in the head's child
 * order (see the module's header): the rows the head's stamp function returns (physical/ddl/stamps.ts), called once
 * with the children's arrays, each aggregated in key order and cast to its child field's column type, and for a clock
 * the call's reading of the database's clock in microseconds. The function advances each child's head, a clock's to
 * `greatest(c, h + 1)` and a place's to `coalesce(h + 1, 0)`, and returns it, each stamp written at its field's type.
 * `children` holds each child once, so the function meets each child's head once.
 */
export const headStampsCte = (
	w: WriteContext,
	supply: NameSupply,
	head: Head,
	names: HeadStamps,
	children: OperandSelect
): Cte => {
	const distinct = supply.relation(internal("stamped children"))
	const arrays = supply.relation(internal("stamped children's arrays"))
	const stamped = supply.relation(internal("stamped heads"))
	const columnType = (f: LawField): TypeRef => fieldColumnType(w.names, f.type).type
	const params = stampParams(head, columnType)
	const order = names.child.map((c) => asc(col(distinct, c)))
	const aggregated = mapNonEmpty(head.child, (_, i) => {
		const array = defined(params[i], "a stamped child's array parameter").type
		return {
			column: supply.column(internal("stamped child's array")),
			value: cast(
				{
					...call("array_agg", [col(distinct, defined(names.child[i], "a stamped child column"))]),
					orderBy: order
				},
				array
			)
		}
	})
	const clock: ReadonlyArray<Expr> = ((): ReadonlyArray<Expr> => {
		switch (head.kind) {
			case "clock":
				return [w.cx.clockReading({ kind: "stamp" }, "micros", types.bigint)]
			case "place":
				return []
		}
	})()
	const fn = w.names.stamp(head.relation, head.field.name)
	const headColumn = (f: LawField): Expr => col(stamped, w.names.column(head.relation, f.name))
	return {
		name: names.name,
		columns: [...names.child, names.at],
		materialized: "MATERIALIZED",
		query: select(
			provedCore(
				"keyed",
				[
					...mapNonEmpty(head.child, (f) => target(headColumn(f))),
					target(written(w, headColumn(head.field), head.field.type))
				],
				[
					derived(
						operandSelect(
							core(
								aggregated.map((a) => targetAs(a.value, a.column)),
								[derived(children, distinct, names.child, false)],
								undefined
							)
						),
						arrays,
						aggregated.map((a) => a.column),
						false
					),
					{
						kind: "function",
						call: qualifiedCall(fn.schema, fn.name, [
							...aggregated.map((a) => col(arrays, a.column)),
							...clock
						]),
						alias: stamped,
						columns: [],
						lateral: true,
						ordinality: false
					}
				],
				undefined
			)
		)
	}
}

/** The names of a head's stamps' CTE, allocated from `supply`: its relation, a column per field of its child, and the
 * stamp's column. */
export const headStampsNames = (supply: NameSupply, head: Head): HeadStamps => ({
	name: supply.relation(internal(`stamps of ${head.relation}`)),
	child: mapNonEmpty(head.child, () => supply.column(internal("stamped child"))),
	at: supply.column(internal("stamp"))
})

/** A computed record's values as a CTE (ir/instant.ts Computed): its name, and a column for each of its fields, by the
 * field's name. */
export interface CallValues {
	readonly computed: Computed
	readonly name: string
	readonly columns: ReadonlyMap<string, string>
}

/** The names of a computed record's CTE, allocated from `supply`: its relation and a column per field. */
export const callValuesNames = (supply: NameSupply, computed: Computed): CallValues => ({
	computed,
	name: supply.relation(internal("computed values")),
	columns: new Map(
		computed.fields.map(
			({ field }) => [field.name, supply.column(internal("computed value"))] as const
		)
	)
})

/** The column of `values` that holds its record's field `from`. */
export const callColumn = (values: CallValues, from: string): string =>
	defined(values.columns.get(from), `the computed value ${from}`)

/**
 * The CTE `values` of its computed record, its one row: each field's expression over the call's scalar parameters and
 * its clock reading, written at its field's type, MATERIALIZED, so the call evaluates the record once, and every row
 * that carries one of its fields joins that one row.
 */
export const callValuesCte = (w: WriteContext, values: CallValues): Cte => ({
	name: values.name,
	columns: values.computed.fields.map(({ field }) => callColumn(values, field.name)),
	materialized: "MATERIALIZED",
	query: select(
		provedCore(
			"oneRow",
			mapNonEmpty(values.computed.fields, ({ field, expr }) =>
				target(written(w, lowerExpr(w.cx, expr, emptyEnv), field.type))
			),
			[],
			undefined
		)
	)
})

/**
 * The CTEs of an insert's stamped input (see the module's header): `read`, the input's read of the fields it carries,
 * `carried`, as the CTE `input`; each computed record's values, read once (`callValuesCte`); each head's stamps, its
 * children read from the input's rows and the call's values; then the input whole as `out`, every field of `fields`
 * under its column of `columns`, a stamped field's from its head's stamps, a computed one's from the call's values,
 * which every row joins.
 */
export const stampedInput = (
	w: WriteContext,
	supply: NameSupply,
	read: Select,
	carried: ReadonlyArray<LawField>,
	stamps: NonEmptyReadonlyArray<Stamped>,
	out: {
		readonly name: string
		readonly fields: ReadonlyArray<LawField>
		readonly columns: FieldColumns<string>
	}
): NonEmptyReadonlyArray<Cte> => {
	const input = supply.relation(internal("stamped input"))
	const calls: Array<CallValues> = []
	for (const { stamp } of stamps) {
		if (stamp.kind === "call" && !calls.some((c) => c.computed === stamp.computed)) {
			calls.push(callValuesNames(supply, stamp.computed))
		}
	}
	const groups: Array<StampGroup> = []
	for (const s of headStamped(stamps)) {
		const known = groups.findIndex((g) => sameStamp(g.stamp, s.stamp))
		const group = groups[known]
		if (group !== undefined) {
			groups[known] = { ...group, fields: [...group.fields, s.field] }
			continue
		}
		groups.push({ stamp: s.stamp, fields: [s.field], ...headStampsNames(supply, s.stamp.head) })
	}
	/** A field the call computes, with the CTE of its record's values and its column there. */
	const calledOf = (
		f: LawField
	): { readonly name: string; readonly column: string } | undefined => {
		for (const { field, stamp } of stamps) {
			if (stamp.kind !== "call" || field.name !== f.name) {
				continue
			}
			const values = defined(
				calls.find((c) => c.computed === stamp.computed),
				"a computed record's values"
			)
			return { name: values.name, column: callColumn(values, stamp.from) }
		}
		return undefined
	}
	/** A field of a row of the input, before its heads stamp it: its input's, or the call's value. */
	const inCol = (f: LawField): Expr => {
		const called = calledOf(f)
		return called === undefined ? col(input, out.columns.of(f)) : col(called.name, called.column)
	}
	/** The input's rows beside the call's values, which every row joins, their one row each. */
	const [firstCall, ...moreCalls] = calls
	const withCalls: FromItem =
		firstCall === undefined
			? cteRef(input)
			: {
					kind: "joins",
					first: cteRef(input),
					steps: mapNonEmpty([firstCall, ...moreCalls], (c) => ({
						kind: "cross",
						source: cteRef(c.name)
					}))
				}
	const stampCtes = groups.map((g): Cte =>
		headStampsCte(
			w,
			supply,
			g.stamp.head,
			g,
			select(
				distinctCore(
					mapNonEmpty(g.stamp.child, (f) => target(inCol(f))),
					[g.stamp.child.some((f) => calledOf(f) !== undefined) ? withCalls : cteRef(input)],
					undefined
				)
			)
		)
	)
	const groupOf = (f: LawField): StampGroup | undefined =>
		groups.find((g) => g.fields.some((s) => s.name === f.name))
	const [first, ...more] = groups
	const from: FromItem =
		first === undefined
			? withCalls
			: {
					kind: "joins",
					first: cteRef(input),
					steps: concatNonEmpty(
						calls.map((c): JoinStep => ({ kind: "cross", source: cteRef(c.name) })),
						mapNonEmpty([first, ...more], (g): JoinStep => ({
							kind: "on",
							source: cteRef(g.name),
							on: and(
								mapNonEmpty(g.stamp.child, (f, i) =>
									eq(inCol(f), col(g.name, defined(g.child[i], "a stamped child column")))
								)
							)
						}))
					)
				}
	const whole = select(
		provedCore(
			"keyed",
			out.fields.map((f) => {
				const g = groupOf(f)
				return target(g === undefined ? inCol(f) : col(g.name, g.at))
			}),
			[from],
			undefined
		)
	)
	return [
		{
			name: input,
			columns: carried.map((f) => out.columns.of(f)),
			materialized: undefined,
			query: read
		},
		...calls.map((c) => callValuesCte(w, c)),
		...stampCtes,
		{ name: out.name, columns: out.columns.columns, materialized: undefined, query: whole }
	]
}

/**
 * The CTE that deletes the heads of the place groups the rows a delete removed belong to (physical/ddl/stamps.ts), none
 * for a relation with no place: a delete of a place's relation removes whole groups (write/frontend/instants.ts
 * Removal), so every group the delete reaches is gone, and its head goes with it, the next insert into the group
 * stamping its first place, 0, again. `removed` is the delete's own CTE, its RETURNING each removed row's fields under
 * `column`; a data-modifying CTE runs whether or not the statement reads it.
 *
 *   "<name>" AS (DELETE FROM "<level>"."<head>" AS "<h>"
 *     USING (SELECT DISTINCT "<removed>"."<g1>", … FROM "<removed>") AS "<d>"("<c1>", …)
 *     WHERE "<h>"."<g1>" = "<d>"."<c1>" AND …)
 */
export const placeReleases = (
	w: WriteContext,
	supply: NameSupply,
	relation: RelationInfo,
	removed: { readonly cte: string; readonly column: (field: LawField) => string }
): ReadonlyArray<Cte> => {
	const place = relation.fields.find((f) => f.writing.kind === "place")
	if (place === undefined) {
		return []
	}
	const group = statedKey(relation)
	const held = supply.relation(internal("released head"))
	const groups = supply.relation(internal("released groups"))
	const from = supply.relation(internal("removed row"))
	const columns = mapNonEmpty(group, () => supply.column(internal("released group")))
	const release: Delete = {
		kind: "delete",
		with: undefined,
		table: w.names.head(relation.name, place.name),
		alias: held,
		using: [
			derived(
				operandSelect(
					distinctCore(
						mapNonEmpty(group, (f) => target(col(from, removed.column(f)))),
						[cteRefAs(removed.cte, from)],
						undefined
					)
				),
				groups,
				columns,
				false
			)
		],
		where: and(
			mapNonEmpty(group, (f, i) =>
				eq(
					col(held, w.names.column(relation.name, f.name)),
					col(groups, defined(columns[i], "a released group's column"))
				)
			)
		),
		returning: []
	}
	return [cte(supply.relation(internal("place release")), [], release)]
}
