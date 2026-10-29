import type { LawId } from "#compiler/core/ids.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { SelectedSide } from "#compiler/ir/law.ts"
import type { FamilyPlugin, FamilyVariable, KeyValue } from "#compiler/laws/families/plugin.ts"
import { raiseViolation, recordField, selectedBy } from "#compiler/laws/residual/sql.ts"
import { covers, coverWith, emptyCover, multirangeTypeOf } from "#compiler/laws/span/cover.ts"
import type { Expr, PlStatement, Select } from "#compiler/sql/ast.ts"
import {
	and,
	asc,
	col,
	core,
	eq,
	lit,
	not,
	objectName,
	select,
	targetAs,
	types
} from "#compiler/sql/build.ts"

/** The record the group listing binds, the record the violation probe binds, and the coverage accumulated from the
 * listed spans. */
const listVariable: FamilyVariable = "t"
const witnessVariable: FamilyVariable = "w"
const coverVariable: FamilyVariable = "cover"

/** The source's selection over the probed source row r1. */
const sourceSelected = (law: LawId, schema: string, source: SelectedSide): Expr =>
	selectedBy(law, schema, source.selection, (f) => col("r1", f.column))

const output = (i: number): string => `c${i + 1}`

/** The selected-source span coverage family. `contained(on(select(A, { k: v }), f..., s), on(B, g..., t))`, where s and t are paired spans and (g..., t) is a span
 * key of B: every point of every selected A fact's span s is covered by the union of the spans t of the B facts whose
 * scalar fields g are the A fact's f. A selected source cannot be a foreign key, because a foreign key
 * applies to every row, so the law is residual. Its anchors are every target row of the source's scalar
 * group, and an absent group is a violation while a selected source remains in it. For one
 * affected key, the anchor key being g's values in g's order:
 *
 *   cover := '{}'::int8multirange;
 *   FOR t IN SELECT r1.<t> AS c1 FROM <B> AS r1 WHERE r1.<g1> = <key1> AND ... LOOP
 *     cover := cover + t.c1::int8multirange;
 *   END LOOP;
 *   FOR w IN SELECT r1.<d1> AS c1, ... FROM <A> AS r1
 *     WHERE r1.<f1> = <key1> AND ... AND r1.<k> = <v> AND NOT (cover @> r1.<s>) ORDER BY r1.<d1>, ... LIMIT 1 LOOP
 *     RAISE EXCEPTION 'law <id> violated' USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = '<id>',
 *       DETAIL = <DetailCodec of w.c1, ...>;
 *   END LOOP;
 *
 * Step 2 reads the group's target rows, served by the span key's GiST index, and accumulates their spans from the
 * empty multirange (`emptyCover`, `coverWith`): the range_agg of the group, never NULL, so an empty group is the empty cover,
 * under which every selected source span is uncovered: the absent-anchor rule needs no branch of its own. A source
 * event and a target event read the group alike.
 *
 * Step 3 looks for a selected A fact in the group whose span the cover does not contain; the first in key order is the
 * witness, its DETAIL the violating fact's key (the projection when it is a key of A, otherwise A's primary key). The probe is served by the law's index on A (f...), partial with the source's selection, which
 * the probe's WHERE implies, unless an index of every row of A already serves it.
 *
 * The event table: an A insertion checks its group; a B deletion checks the deleted
 * row's group; a `mutable` A's UPDATE OF its span, selector or scalar fields, and a `mutable` B's UPDATE OF its span or
 * scalar fields, check the old and the new groups in key order. Every A image is guarded by the source's selection
 * (`ImageGuard`), so an event of an A row outside the selection checks nothing. An A deletion and a B
 * insertion can only repair coverage and fire nothing. */
export const coverageFamily: FamilyPlugin<"selectedSourceCoverage"> = ({ law, schema, shown }) => {
	const lawId: LawId = law.lawId
	const { source, target, detail } = law
	const d = mapNonEmpty(detail.keys, (k) => k.column)
	const targetTable = objectName(schema, target.relation.ident)
	const cover: Expr = { kind: "plVar", name: coverVariable }
	const selected = sourceSelected(lawId, schema, source)
	const raise = raiseViolation(
		lawId,
		detail,
		(...[, i]) => recordField(witnessVariable, output(i)),
		shown(detail.relation.name)
	)
	/** Steps 2 and 3 for one affected key (see `coverageFamily`). */
	const check = (key: NonEmptyReadonlyArray<KeyValue>): ReadonlyArray<PlStatement> => {
		/** The group's target rows, the anchor: its scalar fields are the affected key. */
		const listing: Select = select(
			core(
				[targetAs(col("r1", target.span.column), "c1")],
				[{ kind: "table", table: targetTable, alias: "r1" }],
				and(...key.map((k) => eq(col("r1", k.pair.anchor.column), k.value)))
			)
		)
		const probe: Select = {
			...select(
				core(
					d.map((c, i) => targetAs(col("r1", c), output(i))),
					[{ kind: "table", table: objectName(schema, source.relation.ident), alias: "r1" }],
					and(
						...key.map((k) => eq(col("r1", k.pair.field.column), k.value)),
						selected,
						not(covers(cover, col("r1", source.span.column)))
					)
				)
			),
			orderBy: d.map((c) => asc(col("r1", c))),
			limit: lit.int(1, types.integer)
		}
		return [
			{ kind: "assign", target: coverVariable, value: emptyCover(target.carrier) },
			{
				kind: "forQuery",
				variable: listVariable,
				query: listing,
				body: [
					{
						kind: "assign",
						target: coverVariable,
						value: coverWith(cover, recordField(listVariable, "c1"), target.carrier)
					}
				]
			},
			{ kind: "forQuery", variable: witnessVariable, query: probe, body: [raise] }
		]
	}
	return {
		declare: [
			{ name: listVariable, type: types.record },
			{ name: witnessVariable, type: types.record },
			{ name: coverVariable, type: multirangeTypeOf(target.carrier) }
		],
		check
	}
}
