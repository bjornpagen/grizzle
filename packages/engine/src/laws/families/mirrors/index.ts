import { owed, parentRead, parentVariable } from "#compiler/laws/families/alternatives/parent.ts"
import type { FamilyPlugin, FamilyUnit } from "#compiler/laws/families/plugin.ts"
import { selectedBy } from "#compiler/laws/residual/sql.ts"
import type { PlStatement } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"

/** The conditional mirrors family: the residual half of a direct selected `mirrors`.
 *
 * `mirrors(on(select(P, { k: v }), f...), on(C, g...))`, written outside `alternatives`, is one arm of the alternatives
 * plan: the selected side P is the parent, its literal selector becomes C's constant STORED tag `__k = v`,
 * and the deferred composite foreign key `(g..., __k)` into P's generated UNIQUE `(f..., k)` enforces C's membership.
 * What remains is the residual half, every selected P fact has its C fact, checked here. Nothing depends on the
 * selector being a closed handle: a boolean, a text, an integer or any literal-comparable scalar is compared the same
 * way, as a typed literal of the field's base type (`literalExpr`). For one affected parent
 * key, in the order of P's projection f:
 *
 *   FOR p IN SELECT r1.<f1> AS c1, ..., r1.<k> AS cn FROM <P> AS r1 WHERE r1.<f1> = <key1> ... LOOP
 *     IF p.cn = <v> THEN
 *       PERFORM 1 FROM <C> AS r1 WHERE r1.<g1> = p.c1 AND ...;
 *       IF NOT FOUND THEN RAISE ... END IF;
 *     END IF;
 *   END LOOP;
 *
 * Step 2 reads P's row with its selector fields (`parentRead`). A P row that is gone reads no row, which is
 * no obligation. The selector is rechecked on the row read, because the event's image is not final truth: a `mutable`
 * P may have been deselected since, and then nothing is required, while the tagged foreign key refuses a deselection
 * that leaves a C fact behind. The probe is over C's projection g, which the tagged foreign key's reverse index
 * serves; it never looks at C's own membership again, which that foreign key decides.
 *
 * The event table is the alternatives one for a single arm: a P INSERT checks NEW's key, a C DELETE
 * OLD's g; a `mutable` P's UPDATE OF f or its selector fields checks NEW's key, and a `mutable` C's UPDATE OF g checks
 * the OLD P row, the one the moved C fact left. A P image outside the selection carries no obligation, and its trigger
 * does not fire for it; a C image always threatens, because C's side is unselected. The one term reads both relations,
 * so every participant's units run the whole check. */
export const mirrorsFamily: FamilyPlugin<"conditionalMirrors"> = ({
	law,
	schema,
	names,
	shown
}) => {
	const check = parentRead(
		law,
		schema,
		law.selection.map((s) => s.field),
		shown(law.detail.relation.name),
		(parent): ReadonlyArray<PlStatement> => [
			{
				kind: "if",
				branches: [
					{
						condition: selectedBy(law.lawId, names, law.selection, parent.field),
						body: [owed(schema, law.child, parent)]
					}
				],
				else: []
			}
		]
	)
	const unit: FamilyUnit = { declare: [{ name: parentVariable, type: types.record }], check }
	return () => unit
}
