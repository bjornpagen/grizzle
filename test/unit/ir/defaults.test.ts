/**
 * The Description boundary's one default (ir/desc.ts): an import's empty bind map, which a query may omit.
 *
 * - A generated query written with each import's bind map as drawn, omitted, stated empty or stated with entries,
 *   decodes to the canonical text of the same query with every bind map stated.
 *
 * Oracle: universal, an omitted default and its stated value decode to one canonical text.
 *
 * Features: a bind omitted, a bind stated, a bind with entries.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import {
	decodedText,
	type Feature,
	queryGen,
	situations,
	Writer
} from "#test/unit/ir/defaults.fixtures.ts"

/**
 * The Description boundary's defaults a query omitting an import's empty bind map and one stating it decode to one
 * canonical text.
 *
 * Budget: 400 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/ir/defaults.test.ts:180 at 8cad5bce, its runs and its coverage's cases).
 */
export const theDescriptionBoundarysDefaultsAQueryOmittingAnImportsEmptyBindMapAndOneStatingItDecodeToOneCanonicalText =
	property.explore((source) => source.draw(queryGen(2)), {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: situations satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (query) =>
			Effect.sync(() => {
				const asDrawn = new Writer({ kind: "drawn", note: c.note })
				const canonical = new Writer({ kind: "canonical" })
				assert.equal(
					decodedText("query", asDrawn.query(query), "drawn"),
					decodedText("query", canonical.query(query), "canonical")
				)
			}),
		oracle: {
			kind: "universal",
			name: "an omitted default and its stated value decode to one canonical text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original: "\t\t(q) => ({ query: q.query, bind: q.bind ?? {} })",
				replacement: "\t\t(q) => q",
				why: "An omitted bind map is left absent rather than filled as the empty map; the omitted and stated defaults decode to different texts."
			}
		]
	})
