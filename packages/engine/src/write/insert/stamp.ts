import { defined } from "@bjornpagen/grizzle-text/base/invariant"
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
 * clock is the call's transaction_timestamp(), one value in every statement of the call (sql/print.ts clockReading).
 * Under SERIALIZABLE, two calls that stamp one group's place each read the other's head or are refused, so no two
 * commit one place.
 */
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { sameStamp, type Stamped, type StampSource } from "#compiler/ir/instant.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { Cte, Expr, FromItem, Select } from "#compiler/sql/ast.ts"
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
interface StampGroup {
	readonly stamp: StampSource
	readonly fields: NonEmptyReadonlyArray<LawField>
	readonly name: string
	readonly child: NonEmptyReadonlyArray<string>
	readonly at: string
}

/**
 * The CTEs of an insert's stamped input (see the module's header): `read`, the input's read of the fields it carries,
 * `carried`, as the CTE `input`; each head's stamps; then the input whole as `out`, every field of `fields` under its
 * column of `columns`, a stamped field's from its head's stamps.
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
	const groups: Array<StampGroup> = []
	for (const s of stamps) {
		const known = groups.findIndex((g) => sameStamp(g.stamp, s.stamp))
		const group = groups[known]
		if (group !== undefined) {
			groups[known] = { ...group, fields: [...group.fields, s.field] }
			continue
		}
		groups.push({
			stamp: s.stamp,
			fields: [s.field],
			name: supply.relation(internal(`stamps of ${s.stamp.head.relation}`)),
			child: mapNonEmpty(s.stamp.child, () => supply.column(internal("stamped child"))),
			at: supply.column(internal("stamp"))
		})
	}
	const inCol = (f: LawField): Expr => col(input, out.columns.of(f))
	const stampCtes = groups.map((g): Cte => {
		const counted = g.stamp.head
		const distinct = supply.relation(internal("stamped children"))
		const childAt = (i: number): Expr =>
			col(distinct, defined(g.child[i], "a stamped child column"))
		const head = probeGroup(
			w,
			supply,
			counted.relation,
			"last",
			mapNonEmpty(counted.child, (f, i) => bound(w, counted.relation, f, childAt(i))),
			[w.names.column(counted.relation, counted.field.name)],
			{ read: [w.names.column(counted.relation, counted.field.name)], filter: () => [] }
		)
		const latest = head.at(w.names.column(counted.relation, counted.field.name))
		/** One past the head, read as the bigint it is, none where the child holds none. */
		const next: Expr = {
			kind: "subquery",
			query: simpleSelect(
				[target(binary("+", cast(latest, types.bigint), lit.int(1, types.bigint)))],
				[head.source],
				undefined
			)
		}
		/** A clock's stamp is the greater of the clock and one past the head; a place's is one past the head, 0 where
		 * there is none. Each is written at its field's type. */
		const stamp: Expr = ((): Expr => {
			switch (counted.kind) {
				case "clock":
					return {
						kind: "greatest",
						args: [
							{ kind: "clock", of: { kind: "stamp" }, unit: "micros", type: types.bigint },
							next
						]
					}
				case "place":
					return { kind: "coalesce", args: [next, lit.int(0, types.bigint)] }
			}
		})()
		const children = select(
			distinctCore(
				mapNonEmpty(g.stamp.child, (f) => target(inCol(f))),
				[cteRef(input)],
				undefined
			)
		)
		return {
			name: g.name,
			columns: [...g.child, g.at],
			materialized: "MATERIALIZED",
			query: select(
				provedCore(
					"keyed",
					[
						...mapNonEmpty(g.child, (_, i) => target(childAt(i))),
						target(written(w, stamp, counted.field.type))
					],
					[derived(children, distinct, g.child, false)],
					undefined
				)
			)
		}
	})
	const groupOf = (f: LawField): StampGroup | undefined =>
		groups.find((g) => g.fields.some((s) => s.name === f.name))
	const [first, ...more] = groups
	const from: FromItem =
		first === undefined
			? cteRef(input)
			: {
					kind: "joins",
					first: cteRef(input),
					steps: mapNonEmpty([first, ...more], (g) => ({
						kind: "on",
						source: cteRef(g.name),
						on: and(
							mapNonEmpty(g.stamp.child, (f, i) =>
								eq(inCol(f), col(g.name, defined(g.child[i], "a stamped child column")))
							)
						)
					}))
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
		...stampCtes,
		{ name: out.name, columns: out.columns.columns, materialized: undefined, query: whole }
	]
}
