/**
 * A step that binds a column to a term computed from the channels it passes in asks an index of that column beside
 * the others it binds (sql/bind.ts, the judge's bound plan of its statements, the one source of its equality
 * requests): a term of a region's correlated variables, each fixed per evaluation, fixes the column it binds
 * as a channel does. PUBLISH2 found qti's placed variable
 * reference read beside its declaration by (package, resolution, assembly) alone, its identifier bound to the bounded
 * text of the declaration's attribute value, every unresolved reference of the assembly filtered per declaration.
 *
 * Property: over every case, the installation plans an index of U whose keys are exactly package and g, the columns
 * the step reading U binds, a whole rule's led by package.
 *
 * The box: T(package, id, x) and U(package, id, g, w), keyed by package first, and S(pack, w), immutable, so the
 * containment of D in S is unit-local and judged whole, or mutable, S in a unit of its own, so its probes judge it; D
 * the w of each U row of a T row's package whose g is a term of the T row's x: a sum, a conditional, or a bounded
 * text's guarded cast into another bounded text than g's, the CASE the lowering prints for it.
 *
 * Oracle: specification, the planned indexes against the columns the step binds.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { caseGen, type Feature, judged } from "#test/unit/physical/computed-binding.fixtures.ts"

/** A column a step binds to a term of its channels is a key column of the index the step asks. */
export const aColumnAStepBindsToATermOfItsChannelsIsAKeyOfTheIndexTheStepAsks = property.exhaust(
	finite(caseGen),
	{
		needs: {},
		situations: [
			"a sum",
			"a conditional",
			"a bounded text's guarded cast",
			"judged by whole",
			"judged by probes"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c) => (drawn) => Effect.sync(() => judged(drawn, (f) => c.note(f))),
		oracle: {
			kind: "specification",
			name: "the planned indexes: one of U of exactly package and g, the columns the step binds, a whole rule's led by package"
		},
		box: "U read by the step at package and g, g bound to a sum, a conditional or a bounded text's guarded cast of T's x, the containment judged whole or by its probes",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/bind.ts",
				original: "\t\t\t\treturn d !== undefined && d.depth < here.depth\n",
				replacement: "\t\t\t\treturn false\n",
				why: "A term of the step's channels, an enclosing level's columns, fixes nothing, so the judge's plan binds U at package alone and asks an index of package alone, and PostgreSQL reads every U row of the package at each T row; the property fails."
			}
		]
	}
)
