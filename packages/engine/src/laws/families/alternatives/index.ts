import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { RosterHandle } from "#compiler/ir/law.ts"
import {
	owed,
	type ParentRow,
	parentRead,
	parentVariable
} from "#compiler/laws/families/alternatives/parent.ts"
import type { FamilyPlugin } from "#compiler/laws/families/plugin.ts"
import { literalExpr } from "#compiler/laws/residual/sql.ts"
import type { Expr, PlStatement } from "#compiler/sql/ast.ts"
import { eq, types } from "#compiler/sql/build.ts"

/** One WHEN of a PL/pgSQL CASE. */
type CaseWhen = Extract<PlStatement, { readonly kind: "case" }>["whens"][number]

/** The alternatives reverse family. `alternatives(Parent, "kind", Roster, { Handle: Arm, ... })` lowers to native
 * objects and one residual law: the parent's STORED arm tag, each fact's kind mapped to the first handle of its arm
 * relation, and its UNIQUE (key, arm tag); each arm relation's constant STORED tag, its first handle, and its deferred
 * composite foreign key into that unique, which reject orphan and wrong-arm payloads, a relation armed at several
 * handles taking the payloads of each; and the family's reverse law, every parent has the payload of its selected arm.
 * Only that reverse obligation is checked here; no function repeats the child-to-parent checks the arm foreign keys
 * already make.
 *
 * The reverse law's violation is a union of one term per armed handle, each reading the parent and that handle's arm
 * relation, so each participant re-checks exactly the terms its writes can break (`AlternativesCheck`). The parent's
 * units dispatch its final kind over the whole roster, in roster order, for one affected parent key:
 *
 *   FOR p IN SELECT r1.<k1> AS c1, ..., r1.<kind> AS cn FROM <parent> AS r1 WHERE r1.<k1> = <key1> ... LOOP
 *     CASE p.cn
 *       WHEN '<unarmed handle>'::<roster> THEN
 *       WHEN '<armed handle>'::<roster> THEN
 *         PERFORM 1 FROM <arm> AS r1 WHERE r1.<armkey1> = p.c1 AND ...;
 *         IF NOT FOUND THEN RAISE ... END IF;
 *       ...
 *     END CASE;
 *   END LOOP;
 *
 * An unarmed handle owes nothing, and its WHEN is empty; the CASE has no ELSE, so a kind outside the roster, which the
 * enum type already refuses, raises CASE_NOT_FOUND. An arm relation's units check only its own arms, the parent at its
 * OLD key judged by its final kind:
 *
 *   FOR p IN ... WHERE r1.<k1> = OLD.<armkey1> ... LOOP
 *     IF p.cn = '<handle>'::<roster> THEN
 *       PERFORM 1 FROM <arm> AS r1 WHERE ...;
 *       IF NOT FOUND THEN RAISE ... END IF;
 *     ELSIF ... END IF;
 *   END LOOP;
 *
 * Step 2 reads the parent row with its current discriminator (`parentRead`). A parent that is gone reads no row, which
 * is no obligation. A parent whose kind changed again since the event is judged by its final kind, the one the read
 * returns: one parent key read and one selected child probe. The branches of an arm relation two handles share compare
 * one field with distinct literals, so they are disjoint.
 *
 * The event table: a parent INSERT checks NEW's key, an arm DELETE OLD's parent key; for a `mutable` parent an UPDATE OF
 * its key or discriminator checks NEW's key, and for a `mutable` arm an UPDATE OF its key checks the OLD parent, which
 * is the parent the moved payload left. A parent deletion and an arm insertion cannot break the reverse obligation, so
 * neither fires. */
export const alternativesFamily: FamilyPlugin<"alternativesReverse"> =
	({ law, schema, names, shown }) =>
	(participant) => {
		const handle = (h: string): Expr =>
			literalExpr({ kind: "enum", handle: h }, law.discriminator.type, names, law.lawId)
		const rosterWhen = (h: RosterHandle, parent: ParentRow): CaseWhen => {
			switch (h.kind) {
				case "armed":
					return { values: [handle(h.arm.handle)], body: [owed(schema, h.arm, parent)] }
				case "unarmed":
					return { values: [handle(h.handle)], body: [] }
			}
		}
		const body = (parent: ParentRow): ReadonlyArray<PlStatement> => {
			const check = participant.check
			switch (check.kind) {
				case "roster":
					return [
						{
							kind: "case",
							operand: parent.field(law.discriminator),
							whens: mapNonEmpty(check.handles, (h) => rosterWhen(h, parent))
						}
					]
				case "arms":
					return [
						{
							kind: "if",
							branches: mapNonEmpty(check.arms, (arm) => ({
								condition: eq(parent.field(law.discriminator), handle(arm.handle)),
								body: [owed(schema, arm, parent)]
							})),
							else: []
						}
					]
			}
		}
		return {
			declare: [{ name: parentVariable, type: types.record }],
			check: parentRead(law, schema, [law.discriminator], shown(law.detail.relation.name), body)
		}
	}
