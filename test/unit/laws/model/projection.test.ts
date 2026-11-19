/**
 * Sides are partial projections, and fin.md §5.1 lowers every law over them by one set of rules, each read here from
 * the installation's DDL by structure, never by its text:
 *
 * - every term of a selected side, and every pred term, is a law column of its own, `GENERATED ALWAYS AS (CASE WHEN φ
 *   THEN t END) STORED`: its WHEN reads exactly the selection's fields, and for pred(x) x as well (x > 0), and its THEN
 *   reads exactly the term's field (x - 1 for pred). A field term of a side over every fact is its field's own column;
 * - a law column is typed by its field's base type, never a domain;
 * - a key is one UNIQUE over exactly its side's columns;
 * - a containment is one FOREIGN KEY from its left side's columns to its right side's, in term order, into a key over
 *   exactly the referenced columns, and an index leads with its referencing columns;
 * - a target selection that fixes a field to a constant is a constant law column on the source, NOT NULL and reading no
 *   field, which the reference carries after its terms into the target's superkey over its terms and that field: one
 *   such UNIQUE however many constants reference it, so the target needs no index per constant; but where the target's
 *   own columns, its terms under its selection, cost the schema fewer indexes and columns, the reference meets those,
 *   under a UNIQUE the target's key implies too, with no constant (laws/model/plan.ts takingShared): two containments
 *   into one constant selection share its one law column and UNIQUE, where the superkey would cost a constant on each
 *   source;
 * - a foreign key is DEFERRABLE INITIALLY DEFERRED exactly when it lies on a cycle of the references or its target
 *   holds a field beside the referenced ones, which a write can replace at the key; otherwise it is NOT DEFERRABLE;
 * - mirrors(a, b) is sugar: it installs exactly what contained(a, b) and contained(b, a) install.
 *
 * The search draws one law over five relations: a key over Item's owner and its code or pred(at), a containment of
 * Item's owner, and its code into a superkey, into Owner's id and rank, a set of references among three relations of
 * their keys and fields, or mirrors of Owner or Item with Profile. Every Item side is over every fact or a drawn
 * selection, a boolean field fixed, a code compared, or both; every Owner side over every fact, a drawn comparison or
 * range of rank, or a fixed live, beside a second constant selection from Note or none. The oracle is §5.1 turned into
 * a checker of the drawn law's DDL.
 *
 * `NULLS DISTINCT` and `MATCH SIMPLE` are the printer's spelling of every UNIQUE and FOREIGN KEY node, so no structure
 * here holds them. A containment whose target a cascade feeds is deferred too, which no law of this box does.
 *
 * Features: a key over fields, a selected side, a pred term or a selected pred term; a containment, into a superkey,
 * from or into a selected side, into a constant selection; two constant selections of one target, and two
 * containments into one constant selection at its own column; a reference on a
 * cycle, into a replaceable target, or off every cycle into a key no write replaces; mirrors over whole relations or a
 * selected side; and each Item selection.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	checkContainment,
	checkKey,
	checkReferences,
	containmentsOf,
	type Feature,
	installed,
	lawSpace,
	Reading,
	situations,
	statementsOf
} from "#test/unit/laws/model/projection.fixtures.ts"

/** Partial projections lower by §5.1's rules every drawn law installs its DDL: generated CASE columns, keys and references over them, constant columns, deferral, and mirrors as its containments. Its budget is its suite's before it was a property (test/unit/laws/model/projection.test.ts at 4ca3036a): 32 runs and 96 steered cases. */
export const partialProjectionsLowerBy51sRulesEveryDrawnLawInstallsItsDDLGeneratedCASEColumnsKeysAndReferencesOverThemConstantColumnsDeferralAndMirrorsAsItsContainments =
	property.explore(lawSpace, {
		needs: {},
		budget: { runs: 32, steered: 96 },
		situations: situations satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (law) =>
			Effect.sync(() => {
				const installation = installed(statementsOf(law))
				const at = new Reading(installation)
				switch (law.kind) {
					case "key":
						return checkKey(law, at, c)
					case "containment":
						return checkContainment(law, at, c)
					case "references":
						return checkReferences(law, at, c)
					case "mirrors":
						if (law.left.kind === "Item" && law.left.selection.kind !== "every") {
							c.note("mirrors over a selected side")
							c.note(`selection: ${law.left.selection.kind}`)
						} else {
							c.note("mirrors over whole relations")
						}
						assert.deepEqual(
							installation.statements,
							installed(containmentsOf(law.left)).statements,
							"mirrors installs exactly its two containments"
						)
				}
			}),
		oracle: {
			kind: "specification",
			name: "fin.md §5.1's lowering rules as a checker of the installation's DDL"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/model.ts",
				original:
					"\t\t\t\tonCycle(fk.relation.name, fk.target.name) ||\n\t\t\t\tfk.target.fields.some((c) => !fk.targetFields.includes(c))",
				replacement: "\t\t\t\tonCycle(fk.relation.name, fk.target.name)",
				why: "A foreign key the schema-wide rule decides is never deferred though its target holds a field beside the referenced ones (laws/model/model.ts deferral)."
			}
		]
	})
