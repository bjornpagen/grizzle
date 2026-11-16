/**
 * A rule's NEW probe re-reads the row its write touched by everything it knows of it (analysis/theory/query.ts
 * newProbes): each occurrence of the touched relation a probe holds to the row, at NEW's primary key, is held at NEW's
 * value in every column it reads, so no index PostgreSQL takes reads more of the relation than rows that agree with the
 * touched one on every such column; and the probe's index requests come from the same probe held by its key alone
 * (Probe `requested`), so holding the row by its values asks for no index.
 *
 * Each case draws a rule over a query: a containment of a derived relation D of T, optionally joined with S, in a
 * stored G. T is keyed by k1, or by (k1, k2); D's match of T binds k1 by a variable, k2 by a variable, a literal or not
 * at all, a by the variable D delivers or by a literal, and b by a literal, by a variable it shares with S's a, or not
 * at all, and may match T a second time by a alone. The schema compiles to its law model (test/support/compile.ts
 * testArtifacts), and every rule trigger's table yields its NEW probes (newProbes, as physical/ddl/rules.ts calls it).
 *
 * Oracle: specification, read over the probe IR before any SQL. A match of the touched relation is held where each of
 * its key fields is bound to the parameter that reads NEW's value of that field (Probe `params`), or equated with it
 * by a condition of its rule. In `query` every field a held match binds is so held; in `requested` its key fields are
 * and no other field is. Every probe of a drawn rule holds one match, since no drawn rule negates.
 *
 * Features: a composite key, a key field bound by a literal, a non-key field held by a literal binding, one held by a
 * variable another match binds, and a second occurrence of the touched relation.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type Feature,
	features,
	judged,
	shapeGen
} from "#test/unit/analysis/theory/probe-held.fixtures.ts"

/**
 * A rule's NEW probe holds the touched row at NEW's value in every column it reads, and requests its indexes by the
 * key alone.
 *
 * Budget: 60 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/theory/probe-held.test.ts:247 at 8cad5bce, its runs and its coverage's cases).
 */
export const aRulesNEWProbeHoldsTheTouchedRowAtNEWsValueInEveryColumnItReadsAndRequestsItsIndexesByTheKeyAlone =
	property.explore(shapeGen, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (shape) => Effect.sync(() => judged(shape, c.note)),
		oracle: {
			kind: "specification",
			name: "a held match of the touched relation, read over the probe IR: every field it binds held at NEW's value in the probe, its key fields alone in the probe its indexes are requested by"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					"\t\t\tconst byValues = violating(rule, restricted([...keyPins, ...valuePins]), loc)",
				replacement: "\t\t\tconst byValues = violating(rule, restricted(keyPins), loc)",
				why: "newProbes holds the touched row by its key alone, as before 12fa0a94, so a held match's other bound fields are read at whatever the row holds and an index of a prefix of the key, which without statistics PostgreSQL may take, reads every row of that prefix."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\tconst keyed = violating(rule, restricted(keyPins), loc)",
				replacement:
					"\t\t\tconst keyed = violating(rule, restricted([...keyPins, ...valuePins]), loc)",
				why: "The probe's index requests come from the probe held by its values, so holding the row by them asks for indexes of their own."
			}
		]
	})
