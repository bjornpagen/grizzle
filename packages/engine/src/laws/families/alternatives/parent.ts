import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { FamilyLaw, LawField, PairedSide } from "#compiler/ir/law.ts"
import type { FamilyVariable, KeyValue } from "#compiler/laws/families/plugin.ts"
import { anchorRow, raiseViolation, readAnchor } from "#compiler/laws/residual/sql.ts"
import type { Expr, PlStatement } from "#compiler/sql/ast.ts"
import { and, col, core, eq, lit, objectName, select, target, types } from "#compiler/sql/build.ts"

/** The record the parent read binds (`p record`). */
export const parentVariable: FamilyVariable = "p"

/** The parent row a family builds its steps 2 and 3 over: the value of a field of the row as the parent read returns it,
 * and step 3's refusal for the parent, its key as the DETAIL. */
export interface ParentRow {
	readonly field: (f: LawField) => Expr
	readonly raise: PlStatement
}

/** The read of the law's anchor, the parent row, reading `fields` besides its key and the DETAIL's key columns, with the
 * family's statements `body` builds over that row; its refusal reports the keys when `shown` holds (`raiseViolation`).
 * The result is steps 2 and 3 for one affected key.
 *
 * The parent read that the alternatives reverse family and the conditional mirrors family share. Both families anchor on the parent row, the selected side, at the affected key, and an absent parent is no
 * obligation. Their steps 2 and 3 for one affected key are therefore one shape:
 *
 *   FOR p IN SELECT r1.<f1> AS c1, ... FROM <parent> AS r1 WHERE r1.<k1> = <key1> AND ... LOOP
 *     <dispatch on the parent row's own fields, then one selected child probe:>
 *     PERFORM 1 FROM <child> AS r1 WHERE r1.<g1> = p.<c of k1> AND ...;
 *     IF NOT FOUND THEN RAISE ... CONSTRAINT = '<law-id>', DETAIL = <DetailCodec of the parent's key>; END IF;
 *   END LOOP;
 *
 * The FOR's query is the anchor read (`readAnchor`), a present anchor's obligation: it reads the
 * parent's fields the dispatch needs, its discriminator or its selector fields, beside its key, in that order and then
 * the DETAIL's key, each once (`anchorRow`), so every field `body` reads is one the read returns. The anchor key is a
 * key of the parent, or a superkey of one, so the FOR runs its body at most once. A parent that is gone reads no row
 * and the body never runs, which is the family's absent-anchor rule, no obligation. A zero/one-row FOR binding never
 * represents an absent parent as a NULL-bearing record.
 *
 * The probe is a PERFORM, an existence witness that sets FOUND, over the child's key, never a probe per arm. The
 * native composite foreign keys enforce the child-to-parent direction, so nothing here looks at a child's own parent
 * again.
 *
 * The DETAIL is the parent's key: the law's projection when it is exactly a key of the parent, otherwise the parent's
 * primary key, read from the parent row, never a payload column. */
export const parentRead = (
	law: FamilyLaw<"alternativesReverse" | "conditionalMirrors">,
	schema: string,
	fields: ReadonlyArray<LawField>,
	shown: Expr,
	body: (parent: ParentRow) => ReadonlyArray<PlStatement>
): ((key: NonEmptyReadonlyArray<KeyValue>) => ReadonlyArray<PlStatement>) => {
	const { relation, key } = law.anchor
	const row = anchorRow(parentVariable, [...key, ...fields, ...law.detail.keys], (field) =>
		body({ field, raise: raiseViolation(law.lawId, law.detail, field, shown) })
	)
	return (values) =>
		readAnchor({ schema, relation, key: values, obligation: { when: "present", row } })
}

/** The selected child probe: `PERFORM 1 FROM <child> AS r1 WHERE r1.<g1> = <v1> AND ...`, each child field compared with
 * the parent row's value of the anchor key field it meets (`parent`). */
export const childProbe = (
	schema: string,
	child: PairedSide,
	parent: (f: LawField) => Expr
): PlStatement => ({
	kind: "perform",
	query: select(
		core(
			[target(lit.int(1, types.integer))],
			[{ kind: "table", table: objectName(schema, child.relation.ident), alias: "r1" }],
			and(...child.pairs.map((p) => eq(col("r1", p.field.column), parent(p.anchor))))
		)
	)
})

/** IF NOT FOUND THEN <raise> END IF: after a probe, the selected child is missing. */
export const unlessFound = (raise: PlStatement): PlStatement => ({
	kind: "if",
	branches: [
		{ condition: { kind: "not", expr: { kind: "plSpecial", name: "FOUND" } }, body: [raise] }
	],
	else: []
})
