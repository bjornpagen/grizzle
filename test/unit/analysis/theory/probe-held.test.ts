/**
 * A rule's probe of the rows a transaction adds reads them from its net write (analysis/theory/query.ts probes,
 * physical/ddl/rules.ts addRules): each probe is one rule whose first match is the touched relation's delta.added,
 * binding each field the occurrence it holds reads to a variable of its own, and that occurrence is replaced by the
 * region, so the probe never reads the row again from its table, where without statistics an index of a strict subset
 * of the key's columns may read every row of the subset.
 *
 * Each case draws a rule over a query: a containment of a derived relation D of T, optionally joined with S, in a
 * stored G. T is keyed by k1, or by (k1, k2); D's match of T binds k1 by a variable, k2 by a variable, a literal or not
 * at all, a by the variable D delivers or by a literal, and b by a literal, by a variable it shares with S's a, or not
 * at all, and may match T a second time by a alone. The schema compiles to its law model (test/support/compile.ts
 * testArtifacts), and every rule trigger's table yields its probes of the added side (probes, as physical/ddl/rules.ts
 * calls it).
 *
 * Oracle: specification, read over the probe IR before any SQL. A probe's first match is the touched relation's
 * delta.added, each field it binds a variable of its own, T's k1 among them. No match of the touched relation in the
 * probe is held at the region's value of every key field, bound to the region's variable of that field or equated with
 * it by a condition of its rule. Every probe of a drawn rule holds one occurrence, since no drawn rule negates.
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
 * A rule's probe of the rows a transaction adds reads them from its net write, never from its table.
 *
 * Budget: 60 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/theory/probe-held.test.ts:247 at 8cad5bce, its runs and its coverage's cases).
 */
export const aRulesProbeOfTheRowsATransactionAddsReadsThemFromItsNetWriteNeverFromItsTable =
	property.explore(shapeGen, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: features satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (shape) => Effect.sync(() => judged(shape, c.note)),
		oracle: {
			kind: "specification",
			name: "the probe IR: its first match the touched relation's delta.added, each field a variable of its own, T's k1 among them, and no match of the touched relation held at the region's key"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\tarm.matches.filter((_, j) => j !== i),",
				replacement: "\t\t\t\tarm.matches,",
				why: "The probe keeps the touched occurrence among the matches it reads as they stand, held at the region's values, so it reads the row again from its table, by the columns it reads, as 12fa0a94 did, and an index of a strict subset of its key, which without statistics PostgreSQL may take, reads every row of that subset."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: '\t\t\t\tsource: { kind: "delta", side, relation: touched.relation },',
				replacement:
					'\t\t\t\tsource: { kind: "delta", side: "removed", relation: touched.relation },',
				why: "A probe of the rows a transaction adds reads the rows it removes as its region, so it judges the facts no added row derives and misses every one an added row breaks."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					"\t\t\t\tbindings: Object.fromEntries(fields.map((f) => [f, varRef(regionId(f))] as const)),",
				replacement:
					"\t\t\t\tbindings: Object.fromEntries(fields.slice(1).map((f) => [f, varRef(regionId(f))] as const)),",
				why: "The region binds no variable to the first field its occurrence reads, so the probe reads that field of no row: the variable the occurrence's binding was replaced by stands unbound, and the probe reads T's key from nowhere."
			}
		]
	})
