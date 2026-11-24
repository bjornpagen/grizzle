/**
 * A node a whole rule's statement reads more than once, every reader of which keeps it at the unit, is read at the
 * units' keys, never once for the statement over every unit's rows (lower/shapes/share/keys.ts: each read keyed by the
 * unit's row it is correlated to, read by the occurrence that binds it; inline at each read where every read is at
 * values fixed where it stands, KeyAnalysis readsAtValues, else one CTE at a key set, share/keyed.ts KeyedLowering): the
 * roots a recursion is seeded from, a union the rule's target reads again beside the recursion, once or twice. Read so,
 * each judge reads the units its transaction wrote alone, and two transactions writing units of their own share no row
 * of any stored table and commit together; computed once over every unit, every judge read every unit's roots, and
 * metis's concurrent pantry imports, each of its own package, failed each other with 40001 (2026-11-21).
 *
 * Oracle: a specification, read off the statements: no stored table read through a CTE of a statement's own WITH
 * computed whole: the roots read at the units' keys, inline at each reader or one CTE at a key set.
 *
 * Features: roots of two rules and of three; read again once and twice.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	judgedOverUnits,
	type Reached,
	rootsGen
} from "#test/unit/physical/judge-units.fixtures.ts"

/** A whole rule's statement reads a node every reader keeps at the unit once per unit, never once over every unit. */
export const aNodeEveryReaderKeepsAtTheUnitIsComputedOncePerUnitNeverOnceOverEveryUnit =
	property.exhaust(finite(rootsGen), {
		needs: {},
		situations: [
			"roots of two rules",
			"roots of three rules",
			"read again once",
			"read again twice"
		] satisfies ReadonlyArray<ReachedOf<Reached>>,
		check: (_, c: Case<Reached>) => (roots) => Effect.sync(() => judgedOverUnits(roots, c.note)),
		oracle: {
			kind: "specification",
			name: "the statements: no stored table read through a CTE of a statement's own WITH computed whole: the roots read at the units' keys, inline at each reader or one CTE at a key set"
		},
		box: "roots of two or three rules, read by a recursion's seed and again by the containment's target, once or twice, under a whole rule's containment",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: "\t\t\t\tif (b !== undefined && outerOf(q.source).length === 0) {\n",
				replacement: "\t\t\t\t\tif (false) {\n",
				why: "An enclosing region's variable is read by no occurrence that binds it: the unit's row each read of the roots is correlated to keys nothing, and the roots, read by the walk's seed and again beside it, are a union MATERIALIZED in the statement's own WITH over every document's nodes; the property fails."
			}
		]
	})
