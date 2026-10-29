import {
	childProbe,
	parentRead,
	parentVariable,
	unlessFound
} from "#compiler/laws/families/alternatives/parent.ts"
import type { FamilyPlugin } from "#compiler/laws/families/plugin.ts"
import { literalExpr } from "#compiler/laws/residual/sql.ts"
import type { PlStatement } from "#compiler/sql/ast.ts"
import { types } from "#compiler/sql/build.ts"

/** The alternatives reverse family. `alternatives(Parent, "kind", Roster, { Handle: Arm, ... })` lowers to native objects and one residual law: the parent's generated UNIQUE (key, kind), each arm's constant STORED tag and its deferred composite
 * foreign key into that unique, which reject orphan and wrong-arm payloads, and the family's reverse law, every parent
 * has the payload of its selected arm. Only that reverse obligation is checked here; the function never repeats the
 * child-to-parent checks the tagged foreign keys already make. For one affected parent key, in the parent's
 * key order:
 *
 *   FOR p IN SELECT r1.<k1> AS c1, ..., r1.<kind> AS cn FROM <parent> AS r1 WHERE r1.<k1> = <key1> ... LOOP
 *     CASE p.cn
 *       WHEN '<Handle>'::<roster> THEN
 *         PERFORM 1 FROM <arm> AS r1 WHERE r1.<armkey1> = p.c1 AND ...;
 *       ...
 *     END CASE;
 *     IF NOT FOUND THEN RAISE ... END IF;
 *   END LOOP;
 *
 * Step 2 reads the parent row with its current discriminator (`parentRead`). A parent that is gone reads no
 * row, which is no obligation. A parent whose kind changed again since the event is judged by its final kind, the one
 * the read returns. The loop body dispatches that kind once and probes the selected arm by its key: one parent key
 * read and one selected child probe, not one probe per arm.
 *
 * A handle the arm map omits carries no payload: a parent selecting it requires nothing, and the tagged
 * foreign keys of the other arms already forbid a payload in them. Its dispatch is the CASE's ELSE, which does nothing.
 * A CASE without ELSE raises CASE_NOT_FOUND for an unmatched value, so the ELSE is present exactly when the arm map
 * omits a handle. An empty ELSE leaves FOUND as it was before the CASE, so with an ELSE each armed branch raises after
 * its own probe; with every handle armed the one refusal follows END CASE.
 *
 * The event table: a parent INSERT checks NEW's key, an arm DELETE OLD's parent key; for a `mutable`
 * parent an UPDATE OF its key or discriminator checks NEW's key, and for a `mutable` arm an UPDATE OF its key checks
 * the old and the new parent,, in key order. A parent deletion and an arm
 * insertion cannot break the reverse obligation, so neither fires. */
export const alternativesFamily: FamilyPlugin<"alternativesReverse"> = ({ law, schema, shown }) => {
	const discriminator = law.discriminator
	const armed = law.unarmed.length === 0
	const check = parentRead(
		law,
		schema,
		[discriminator],
		shown(law.detail.relation.name),
		(parent): ReadonlyArray<PlStatement> => {
			const whens = law.arms.map((arm) => {
				const probe = childProbe(schema, arm, parent.field)
				return {
					values: [
						literalExpr({ kind: "enum", handle: arm.handle }, discriminator.type, schema, law.lawId)
					],
					body: armed ? [probe] : [probe, unlessFound(parent.raise)]
				}
			})
			const operand = parent.field(discriminator)
			const dispatch: PlStatement = armed
				? { kind: "case", operand, whens, else: undefined }
				: { kind: "case", operand, whens, else: [] }
			return armed ? [dispatch, unlessFound(parent.raise)] : [dispatch]
		}
	)
	return {
		declare: [{ name: parentVariable, type: types.record }],
		/** Steps 2 and 3 for one affected parent key (see `alternativesFamily`). */
		check
	}
}
