/**
 * A rule's NEW probe reads the row its write touched from the transaction's net write (analysis/theory/query.ts
 * newProbes, physical/ddl/rules.ts addRules): each occurrence of the touched relation a probe holds to the row is
 * replaced by NEW's values, every field it reads a parameter its region binds, so the probe never reads the row again
 * from its table, where without statistics an index of a strict subset of the key's columns may read every row of the
 * subset; and the probe's index requests come from the same probe with the row read from its table at its key alone
 * (Probe `requested`), so the indexes it asks are the ones it asked when it read the row there.
 *
 * Each case draws a rule over a query: a containment of a derived relation D of T, optionally joined with S, in a
 * stored G. T is keyed by k1, or by (k1, k2); D's match of T binds k1 by a variable, k2 by a variable, a literal or not
 * at all, a by the variable D delivers or by a literal, and b by a literal, by a variable it shares with S's a, or not
 * at all, and may match T a second time by a alone. The schema compiles to its law model (test/support/compile.ts
 * testArtifacts), and every rule trigger's table yields its NEW probes (newProbes, as physical/ddl/rules.ts calls it).
 *
 * Oracle: specification, read over the probe IR before any SQL. A match of the touched relation is held where each of
 * its key fields is bound to the parameter that reads NEW's value of that field (Probe `params`), or equated with it
 * by a condition of its rule. `query` holds none; `requested` holds the occurrence, its key fields held and no other
 * field, and every field it reads is a parameter of the probe. Every probe of a drawn rule holds one occurrence, since
 * no drawn rule negates.
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
 * A rule's NEW probe reads the touched row from the transaction's net write, never from its table, and requests its
 * indexes by the row's key.
 *
 * Budget: 60 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/theory/probe-held.test.ts:247 at 8cad5bce, its runs and its coverage's cases).
 */
export const aRulesNEWProbeReadsTheTouchedRowFromTheTransactionsNetWriteAndRequestsItsIndexesByItsKey =
	property.explore(shapeGen, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (shape) => Effect.sync(() => judged(shape, c.note)),
		oracle: {
			kind: "specification",
			name: "the touched occurrence read over the probe IR: no match of the touched relation held at NEW's key in the probe, every field it reads a parameter of NEW, and its key fields alone held in the probe its indexes are requested by"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\tarm.matches.filter((_, j) => j !== i),",
				replacement: "\t\t\t\tarm.matches,",
				why: "newProbes keeps the touched occurrence among the matches it reads as they stand, its fields held at NEW's values, so the probe reads the row again from its table, by the columns it reads, as 12fa0a94 did, and an index of a strict subset of its key, which without statistics PostgreSQL may take, reads every row of that subset."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\trequested: queryOf([asked(n)], loc),",
				replacement: "\t\t\t\trequested: queryOf([r], loc),",
				why: "The probe's index requests come from the probe that reads the row from its region, which reads the touched relation at no key, so the indexes its other reads ask are requested as joins from no row of it."
			}
		]
	})
