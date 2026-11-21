/**
 * An insert's stamps (ir/instant.ts): the fields its rows leave out, each stamped from its head at the row's child:
 * an instant with the call's instant of its clock, `greatest(c, h + 1)`, c the call's reading of the database's clock
 * in microseconds and h the latest instant the child holds, none where it holds none, which `greatest` passes over as
 * it does a NULL; a place with `coalesce(h + 1, 0)`, h the greatest place its group holds.
 *
 * Its input is read once, then each head's stamps are worked out once per child, each child read once from the input's
 * distinct children, so the stamps are keyed by their child and want no second duplicate elimination, and the input is
 * read again with them, so every statement after reads complete facts, the input's own fields and the stamped ones
 * alike:
 *
 *   "<input>"("<x1>", …) AS (<the input's read of the fields it carries>),
 *   "<stamps>"("<c1>", …, "<at>") AS MATERIALIZED (
 *     SELECT "<d>"."<c1>", …, greatest(<clock>, (SELECT "<h>"."<at>" + 1 FROM LATERAL (SELECT
 *       "<inner>"."<at>" FROM <clock's table> AS "<inner>" WHERE "<inner>"."<child1>" = "<d>"."<c1>" AND …
 *       ORDER BY "<inner>"."<at>" DESC LIMIT 1) AS "<h>"("<at>")))
 *     FROM (SELECT DISTINCT "<input>"."<x1>", … FROM "<input>") AS "<d>"("<c1>", …)),
 *   "<r1>"(…) AS (SELECT "<input>"."<x1>", …, "<stamps>"."<at>" FROM "<input>" JOIN "<stamps>" ON
 *     "<input>"."<x1>" = "<stamps>"."<c1>" AND …)
 *
 * The head is the clock's or the place's primary key read backwards from the child, its last row, one index probe per
 * child
 * (write/probe.ts probeGroup `last`), as a counted family's kept count reads its last member (family/additions.ts
 * storedKept). Every part of the statement that stamps a clock reads it at the statement's one snapshot, so the parts
 * of one stratum's single statement that stamp one clock at one child, its own rows and its references' alike, stamp
 * one instant, and none sees another's row; so do a place's, one place for every row of the call in its group. The
 * clock is the call's transaction_timestamp(), one value in every statement of the call, or that instant moved by the
 * call's offset under a moved clock (lower/conservative/context.ts clockReading).
 * Under SERIALIZABLE, two calls that stamp one group's place each read the other's head or are refused, so no two
 * commit one place.
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
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
import type { LawField } from "#compiler/ir/law.ts"
import { emptyEnv } from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import type { Cte, Expr, FromItem, JoinStep, OperandSelect, Select } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	cast,
	col,
	cteRef,
	derived,
	distinctCore,
	eq,
	lit,
	provedCore,
	select,
	simpleSelect,
	target,
	types
} from "#compiler/sql/build.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"
import type { FieldColumns } from "#compiler/write/defined.ts"
import { written } from "#compiler/write/family/written.ts"
import type { WriteContext } from "#compiler/write/insert/statement.ts"
import { bound, probeGroup } from "#compiler/write/probe.ts"

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

/**
 * The CTE `names` of `head`'s stamps at each child `children` holds, one row a child, its columns in the head's child
 * order (see the module's header): a clock's `greatest(c, h + 1)`, a place's `coalesce(h + 1, 0)`, h the head's
 * greatest value at the child, read by one probe of the head's primary key backwards from the child. `children` holds
 * each child once, so its one materialized evaluation probes each child once.
 */
export const headStampsCte = (
	w: WriteContext,
	supply: NameSupply,
	head: Head,
	names: HeadStamps,
	children: OperandSelect
): Cte => {
	const distinct = supply.relation(internal("stamped children"))
	const childAt = (i: number): Expr =>
		col(distinct, defined(names.child[i], "a stamped child column"))
	const probed = probeGroup(
		w,
		supply,
		head.relation,
		"last",
		mapNonEmpty(head.child, (f, i) => bound(w, head.relation, f, childAt(i))),
		[w.names.column(head.relation, head.field.name)],
		{ read: [w.names.column(head.relation, head.field.name)], filter: () => [] }
	)
	const latest = probed.at(w.names.column(head.relation, head.field.name))
	/** One past the head, read as the bigint it is, none where the child holds none. */
	const next: Expr = {
		kind: "subquery",
		query: simpleSelect(
			[target(binary("+", cast(latest, types.bigint), lit.int(1, types.bigint)))],
			[probed.source],
			undefined
		)
	}
	/** A clock's stamp is the greater of the clock and one past the head; a place's is one past the head, 0 where
	 * there is none. Each is written at its field's type. */
	const stamp: Expr = ((): Expr => {
		switch (head.kind) {
			case "clock":
				return {
					kind: "greatest",
					args: [w.cx.clockReading({ kind: "stamp" }, "micros", types.bigint), next]
				}
			case "place":
				return { kind: "coalesce", args: [next, lit.int(0, types.bigint)] }
		}
	})()
	return {
		name: names.name,
		columns: [...names.child, names.at],
		materialized: "MATERIALIZED",
		query: select(
			provedCore(
				"keyed",
				[
					...mapNonEmpty(names.child, (_, i) => target(childAt(i))),
					target(written(w, stamp, head.field.type))
				],
				[derived(children, distinct, names.child, false)],
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
