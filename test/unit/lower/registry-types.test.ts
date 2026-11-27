/**
 * The scalar types a lowering states are the registry's: a plain or wildcard-text column of a lowered statement's result
 * heading, whatever node or delivery column introduced it, is the one type of its carrier the registry builds
 * (scalar/compute/types.ts plainType and wildcardText), capabilities included. A type built anywhere else carries an
 * identity no field descriptor decodes to, as a hand-built unit column of the conservative delivery would.
 *
 * Each oracle case (test/support/oracle/gen: plain, attached and heterogeneous-union roots) is lowered conservatively
 * and optimized as the page totality suite lowers its cases (test/unit/page/total.test.ts); a case either lowering
 * refuses is no case: the lowerings are not this property's subject.
 *
 * Oracle: the registry's one type per carrier (plainType, wildcardText), a specification. Features: a plain root, an
 * attached root, a heterogeneous union.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { annotatedInput, lowerOptimized } from "#compiler/lower/optimize/pipeline.ts"
import { statementOutput } from "#compiler/runtime/lower/tree.ts"
import { costChosen } from "#compiler/sql/emit.ts"
import { succeeded } from "#test/support/assert.ts"
import { admitGenerated } from "#test/support/compile.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import { checkedLowering } from "#test/support/oracle/verify/index.ts"
import { registryTyped, type RootFeature } from "#test/unit/lower/registry-types.fixtures.ts"

/**
 * The scalar types of lowered statements are the registry's: every plain or wildcard-text result column of both
 * artifacts is its carrier's one type.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/lower/registry-types.test.ts:69 at 8cad5bce, its runs and its coverage's cases).
 */
export const theScalarTypesOfLoweredStatementsAreTheRegistrysEveryPlainOrWildcardTextResultColumnOfBothArtifactsIsItsCarriersOneType =
	property.explore(
		queryCaseGen({
			...defaultGenConfig,
			query: {
				...defaultGenConfig.query,
				roots: {
					...defaultGenConfig.query.roots,
					plain: 2,
					attach: 2,
					hetero: 4
				}
			}
		}),
		{
			needs: {},
			budget: { runs: 200, steered: 200 },
			situations: ["plain root", "attached root", "heterogeneous union"] satisfies ReadonlyArray<
				Reached<RootFeature>
			>,
			check: (_, n: Case<RootFeature>) => (c) =>
				Effect.sync(() => {
					const query: LogicalQuery = { dag: c.query.dag, params: genParamDecls(c.query) }
					const names = standInNames("Oracle", schemaCodes(c.schema))
					const conservative = lowerConservative(conservativeInput(query), {
						names,
						params: query.params,
						subject: { kind: "query" }
					})
					if (!conservative.ok) {
						n.note("a query a lowering refuses")
						return
					}
					const catalog = genCatalog(c.schema)
					const admission = admitGenerated(query)
					const optimized = admission.ok
						? lowerOptimized(succeeded(annotatedInput(admission.value, queryEvidence)), {
								binding: costChosen,
								names,
								context: "snapshot",
								catalog,
								subject: { kind: "query" }
							})
						: admission
					if (!optimized.ok) {
						n.note("a query a lowering refuses")
						return
					}
					checkedLowering({
						optimized: optimized.value,
						alignment: { kind: "aligned", conservative: conservative.value },
						context: "snapshot",
						catalog
					})
					const root = query.dag.roots[0]
					if (root.kind === "Attach") {
						n.note("attached root")
					} else if (root.kind === "Union" && root.groups.length > 1) {
						n.note("heterogeneous union")
					} else {
						n.note("plain root")
					}
					for (const statement of [
						...flight(conservative.value.roots),
						...flight(optimized.value.roots)
					]) {
						for (const column of statementOutput(statement.role, statement.heading, []).heading) {
							registryTyped(column)
						}
					}
				}),
			oracle: {
				kind: "specification",
				name: "the registry's one type of each plain carrier and of wildcard text"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/runtime/lower/tree.ts",
					original: "\theading.length === 0 ? unitHeading : heading",
					replacement:
						"\theading.length === 0\n\t\t? unitHeading\n\t\t: heading.map((c) => ({ ...c, type: { ...c.type, caps: c.type.caps.toReversed() } }))",
					why: "A delivered heading (runtime/lower/tree.ts deliveredHeading) rebuilds each column's type with its capabilities reordered; the search fails."
				}
			]
		}
	)
