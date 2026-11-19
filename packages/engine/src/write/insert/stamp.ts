import { defined } from "@bjornpagen/grizzle-text/base/invariant"
/**
 * An insert's stamps (ir/instant.ts): the instant fields its rows leave out, each stamped with the call's instant of its
 * clock at the row's child, `greatest(c, h + 1)`, c the call's reading of the database's clock in microseconds and h the
 * latest instant the child holds, none where it holds none, which `greatest` passes over as it does a NULL.
 *
 * Its input is read once, then each clock's stamps are worked out once per child, each child read once from the input's
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
 * The head is the clock's primary key read backwards from the child, its last row, one index probe per child
 * (write/probe.ts probeGroup `last`), as a counted family's kept count reads its last member (family/additions.ts
 * storedKept). Every part of the statement that stamps a clock reads it at the statement's one snapshot, so the parts
 * of one stratum's single statement that stamp one clock at one child, its own rows and its references' alike, stamp
 * one instant, and none sees another's row. The clock is the call's transaction_timestamp(), one value in every
 * statement of the call (sql/print.ts clockReading).
 */
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Stamped, StampSource } from "#compiler/ir/instant.ts"
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

/** One clock's stamps of an insert: its stamp source, the stamped fields it fills, and its CTE's names. */
interface StampGroup {
	readonly stamp: StampSource
	readonly fields: NonEmptyReadonlyArray<LawField>
	readonly name: string
	readonly child: NonEmptyReadonlyArray<string>
	readonly at: string
}

/** Whether two stamps are one stamp of a row: one clock, read at the same fields of the row. */
const sameSource = (a: StampSource, b: StampSource): boolean =>
	a.clock.relation === b.clock.relation &&
	a.clock.field.name === b.clock.field.name &&
	a.child.length === b.child.length &&
	a.child.every((f, i) => b.child[i]?.name === f.name)

/**
 * The CTEs of an insert's stamped input (see the module's header): `read`, the input's read of the fields it carries,
 * `carried`, as the CTE `input`; each clock's stamps; then the input whole as `out`, every field of `fields` under its
 * column of `columns`, a stamped field's from its clock's stamps.
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
		const known = groups.findIndex((g) => sameSource(g.stamp, s.stamp))
		const group = groups[known]
		if (group !== undefined) {
			groups[known] = { ...group, fields: [...group.fields, s.field] }
			continue
		}
		groups.push({
			stamp: s.stamp,
			fields: [s.field],
			name: supply.relation(internal(`stamps of ${s.stamp.clock.relation}`)),
			child: mapNonEmpty(s.stamp.child, () => supply.column(internal("stamped child"))),
			at: supply.column(internal("stamp"))
		})
	}
	const inCol = (f: LawField): Expr => col(input, out.columns.of(f))
	const stampCtes = groups.map((g): Cte => {
		const clock = g.stamp.clock
		const distinct = supply.relation(internal("stamped children"))
		const childAt = (i: number): Expr =>
			col(distinct, defined(g.child[i], "a stamped child column"))
		const head = probeGroup(
			w,
			supply,
			clock.relation,
			"last",
			mapNonEmpty(clock.child, (f, i) => bound(w, clock.relation, f, childAt(i))),
			[w.names.column(clock.relation, clock.field.name)],
			{ read: [w.names.column(clock.relation, clock.field.name)], filter: () => [] }
		)
		const latest = head.at(w.names.column(clock.relation, clock.field.name))
		/** The clock and the head are read as the bigints they are, and their greater is written at the instant's type. */
		const stamp: Expr = {
			kind: "greatest",
			args: [
				{ kind: "clock", of: { kind: "stamp" }, unit: "micros", type: types.bigint },
				{
					kind: "subquery",
					query: simpleSelect(
						[target(binary("+", cast(latest, types.bigint), lit.int(1, types.bigint)))],
						[head.source],
						undefined
					)
				}
			]
		}
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
						target(written(w, stamp, clock.field.type))
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
