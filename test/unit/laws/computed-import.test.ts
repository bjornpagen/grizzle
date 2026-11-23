/**
 * A rule over a query that matches an import read whole, a union of rules, at a term computed from another match's
 * variable compiles (analysis/theory/navigate.ts Navigator #chain `hiddenFor`): the import binds its column to a hidden
 * variable of its own, equated with the term once the term's variables are bound, as a step binds a computed term. It
 * took the term's variables for its own, so the chain read the other match's variable through a channel no match
 * bound, and the checker refused the judge grizzle built (check/checker.ts #matches, "a bind map reading variables
 * some match binds"), a schema the builders admit.
 *
 * Property: over every case, the schema compiles to its installation.
 *
 * The box: T(package, id, x) and U(package, id, g, w), keyed by package first, and S(pack, w), immutable, so the
 * containment of D in S is unit-local and judged whole, or mutable, S in a unit of its own, so its probes judge it;
 * Low, a union of two rules over U, read whole; D the w of each Low row of a T row's package whose g is a sum or a
 * conditional of the T row's x.
 *
 * Oracle: the builders' admission, a schema schema.extend builds compiles to its installation.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { caseGen, type Feature, judged } from "#test/unit/laws/computed-import.fixtures.ts"

/** An import read whole and matched at a term of another match's variable compiles. */
export const anImportReadWholeAndMatchedAtATermOfAnotherMatchsVariableCompiles = property.exhaust(
	finite(caseGen),
	{
		needs: {},
		situations: [
			"a sum",
			"a conditional",
			"judged by whole",
			"judged by probes"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c) => (drawn) => Effect.sync(() => judged(drawn, (f) => c.note(f))),
		oracle: {
			kind: "specification",
			name: "the builders' admission: a schema schema.extend builds compiles to its installation"
		},
		box: "a union of two rules over U matched at a sum or a conditional of T's x, the containment judged whole or by its probes",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					'\t\t\t\te.kind === "var" || readsOf(e).size === 0 ? e : varRef(hiddenFor(read, column, e))\n',
				replacement: "\t\t\t\te\n",
				why: "An import read whole takes the variables of a term it is matched at for its own, as before: T's x is read through a channel no match binds, and the checker refuses the judge; the property fails."
			}
		]
	}
)
