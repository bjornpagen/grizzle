import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { FamilyPlugin, FamilyVariable, KeyValue } from "#compiler/laws/families/plugin.ts"
import { raiseViolation, readAnchor, recordField, selectedBy } from "#compiler/laws/residual/sql.ts"
import type { Expr, PlStatement, Select } from "#compiler/sql/ast.ts"
import {
	and,
	asc,
	col,
	core,
	eq,
	lit,
	objectName,
	select,
	targetAs,
	types
} from "#compiler/sql/build.ts"

/** The record the violation probe binds. */
const witnessVariable: FamilyVariable = "w"

const output = (i: number): string => `c${i + 1}`

/** The selected-source containment family. `contained(on(select(A, { k: v }), f...), on(B, g...))`: every selected A fact's projection f is a B fact's
 * projection g, where g is a key of B or contains one. Its anchor is the B row at the source's projection,
 * g = f, and an absent B row is a violation while a selected A row remains there. For one affected key,
 * the anchor key being g's values in g's order:
 *
 *   PERFORM 1 FROM <B> AS r1 WHERE r1.<g1> = <key1> AND ...;
 *   IF NOT FOUND THEN
 *     FOR w IN SELECT r1.<d1> AS c1, ... FROM <A> AS r1
 *       WHERE r1.<f1> = <key1> AND ... AND r1.<k> = <v> ORDER BY r1.<d1>, ... LIMIT 1 LOOP
 *       RAISE EXCEPTION 'law <id> violated' USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = '<id>',
 *         DETAIL = <DetailCodec of w.c1, ...>;
 *     END LOOP;
 *   END IF;
 *
 * Step 2 reads the anchor (`readAnchor`), an absent anchor's obligation: the anchor is a key of B, so
 * the key holds one row at most, and a B row there satisfies the law for this key. When the snapshot holds none, step
 * 3 looks for a selected A fact at the key; each one is a violation, and the first in key order is the witness, its
 * DETAIL the violating fact's key (the projection when it is a key of A, otherwise A's primary key).
 *
 * The event table: A INSERT checks the inserted row's target, B DELETE the deleted row's key; a `mutable`
 * A's UPDATE OF its selector or projected fields checks the old and the new targets, and a `mutable` B's UPDATE OF g
 * the old and the new keys, both in key order. The skeleton skips an A row outside the
 * selection, which cannot threaten the law. The probe is served by the law's index on A (f...), partial with the
 * selection, which its WHERE implies, unless an index of every row of A already serves it. */
export const selectedSourceFamily: FamilyPlugin<"selectedSourceContainment"> = ({
	law,
	schema,
	shown
}) => {
	const { anchor, source, detail } = law
	const read = (field: LawField): Expr => col("r1", field.column)
	const selected = selectedBy(law.lawId, schema, source.selection, read)
	const raise = raiseViolation(
		law.lawId,
		detail,
		(...[, i]) => recordField(witnessVariable, output(i)),
		shown(detail.relation.name)
	)
	/** Steps 2 and 3 for one affected key (see `selectedSourceFamily`). */
	const check = (key: NonEmptyReadonlyArray<KeyValue>): ReadonlyArray<PlStatement> => {
		const probe: Select = {
			...select(
				core(
					detail.keys.map((k, i) => targetAs(read(k), output(i))),
					[{ kind: "table", table: objectName(schema, source.relation.ident), alias: "r1" }],
					and(...key.map((k) => eq(read(k.pair.field), k.value)), selected)
				)
			),
			orderBy: detail.keys.map((k) => asc(read(k))),
			limit: lit.int(1, types.integer)
		}
		return readAnchor({
			schema,
			relation: anchor.relation,
			key,
			obligation: {
				when: "absent",
				body: [{ kind: "forQuery", variable: witnessVariable, query: probe, body: [raise] }]
			}
		})
	}
	return { declare: [{ name: witnessVariable, type: types.record }], check }
}
