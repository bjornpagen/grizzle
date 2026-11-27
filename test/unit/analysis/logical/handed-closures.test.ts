/**
 * The closures an analysis hands out are made outside Annotator.run's scope (logical/annotate.ts propsEnvOf, scopeOf,
 * annotatedOf, rootOf, revisedOf, annotationStep): V8 holds every variable a closure of a scope captures in that
 * scope's one context, and keeps a closure an analysis made past the analysis through its own metadata (a hidden
 * class's constructor, an allocation site's boilerplate) once the code that made it is optimized, which a unit run never
 * reaches; a closure made in run kept run's context, its fold's memo and its scopes among it. At hub a841fcff1 edullm's
 * qti generate held eleven finished analyses that way, 1.24 GB of its 3.19 GB live. So the property reads what the
 * handed closure is: the analysis's `of`, the one the caller keeps, is the reader `revisedOf` makes, whose source reads
 * the revisions and the fold's reader alone and names neither `fold` nor `scopes`.
 *
 * The box, exhausted: a rule over R whose columns a, b, c and d are chained by one to three equalities, the last a
 * constant and none to two of them parameters too (fixed-names.fixtures.ts), analyzed in a transaction with no
 * containment. Oracle: specification. Kill: run hands out its own `of`, reading `fold`.
 *
 * Features: none beyond the box.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect, String as Str } from "effect"
import { analyzeLogical, everyNode } from "#compiler/logical/annotate.ts"
import { succeeded } from "#test/support/assert.ts"
import { chainDag, chainGen } from "#test/unit/analysis/logical/fixed-names.fixtures.ts"

/** The analysis's `of` is made outside run's scope: it reads the revisions and the fold's reader, never `fold` or `scopes`. */
export const anAnalysissOfIsMadeOutsideRunsScopeReadingTheRevisionsAndTheFoldsReaderNeverFoldOrScopes =
	property.exhaust(finite(chainGen), {
		needs: {},
		situations: [],
		check: () => (chain) =>
			Effect.sync(() => {
				const analysis = succeeded(
					analyzeLogical(
						chainDag(chain),
						{ context: "transaction", containments: [], keyedViews: false },
						everyNode
					)
				)
				const source = analysis.of.toString()
				assert.ok(
					!Str.includes("fold")(source) && !Str.includes("scopes")(source),
					`the analysis's of reads neither the fold nor the scopes: ${source}`
				)
			}),
		oracle: { kind: "specification", name: "a handed closure captures what it reads alone" },
		box: "one to three equalities chaining R's columns, the last a constant, none to two of them parameters too",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/annotate.ts",
				original: "\t\treturn { dag, judged, of: revisedOf(revisions, of), props }",
				replacement:
					"\t\treturn { dag, judged, of: (node) => revisions.get(node) ?? fold.of(node), props }",
				why: "run hands out a closure of its own scope, reading `fold`, so the caller's `of` keeps run's context and every memo in it."
			}
		]
	})
