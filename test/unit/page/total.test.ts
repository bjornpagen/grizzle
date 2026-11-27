/**
 * The page compiler and the page runtime template are total on generated ordered queries, without a database.
 *
 * Each oracle case (test/support/oracle/gen: plain, attached and heterogeneous-union roots) is ordered by a drawn prefix
 * of its result heading, rotated, each direction drawn, as the pg page suite orders it (test/pg/page/generated.ts). Its
 * page either compiles or is refused with a typed CompileError that is no MalformedDescription: the compiler built the
 * query itself, so a refusal of its own structure is a defect, and so is a throw. The page runtime template over the
 * compiled page is total, with one anchor codec per comparator, which writes a window's Key (adapter/page/window.ts).
 * The population must reach a page of heading groups, a page with attachments and a
 * page whose attachment takes its other form per execution. Every plain or wildcard-text column of every statement a
 * page compiles is the one type of its carrier the registry builds, never one built by hand, as
 * test/unit/lower/registry-types.test.ts states of the lowerings.
 *
 * Oracle: totality, a universal law: the compiler built the query, so every refusal is typed and none is of malformed
 * structure, and the runtime template refuses nothing; the registry's own types for the columns. A case whose lowerings refuse it is no case of this property and
 * is given up.
 *
 * Features: a page of heading groups, a page with attachments, and a page whose attachment takes its other form per
 * execution.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { compiledPageRuntime } from "#adapter/served/forms.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { callerParams } from "#compiler/ir/products.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { annotatedInput, lowerOptimized } from "#compiler/lower/optimize/pipeline.ts"
import { compilePage } from "#compiler/lower/shapes/page/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { admitGenerated } from "#test/support/compile.ts"
import { conservativePage } from "#test/support/conservative.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import { checkedLowering } from "#test/support/oracle/verify/index.ts"
import { everyColumnCarried } from "#test/support/spine.ts"
import {
	orderedQuery,
	orderedSketchGen,
	registryTypes,
	resolveOrdered,
	type TotalFeature
} from "#test/unit/page/total.fixtures.ts"

/**
 * The page compiler and the page runtime template compile every generated ordered query, or refuse it with a typed
 * CompileError of no malformed structure.
 *
 * Budget: its suite's count before the conversion (unit/page/runtime-total: 200 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const thePageCompilerAndThePageRuntimeTemplateCompileEveryGeneratedOrderedQueryOrRefuseItWithATypedCompileErrorOfNoMalformedStructure =
	property.explore(orderedSketchGen, {
		needs: {},
		situations: ["heading groups", "attachments"] satisfies ReadonlyArray<Reached<TotalFeature>>,
		check: (_, c: Case<TotalFeature>) => (sketch) =>
			Effect.sync(() => {
				const o = c.draw(resolveOrdered(sketch))
				const orderedRead = orderedQuery(o)
				if (orderedRead === undefined) {
					c.note("a case no ordered read stands for")
					return
				}
				const query = orderedRead.query
				/** The case's names, under the codes its schema's installation holds. */
				const codes = schemaCodes(o.c.schema)
				const names = standInNames("Oracle", codes)
				/** The lowerings are not this property's subject: a case either of them refuses is noted as such. */
				const conservative = lowerConservative(conservativeInput(query), {
					names,
					params: query.params,
					subject: { kind: "query" }
				})
				if (!conservative.ok) {
					c.note("a query a lowering refuses")
					return
				}
				const catalog = genCatalog(o.c.schema)
				const admission = admitGenerated(query)
				const optimized = admission.ok
					? lowerOptimized(succeeded(annotatedInput(admission.value, queryEvidence)), {
							names,
							context: "snapshot",
							catalog,
							subject: { kind: "query" }
						})
					: admission
				if (!optimized.ok) {
					c.note("a query a lowering refuses")
					return
				}
				checkedLowering({
					optimized: optimized.value,
					alignment: { kind: "aligned", conservative: conservative.value },
					context: "snapshot",
					catalog
				})
				const pageInput = {
					checked: query,
					optimized: optimized.value,
					names,
					stated: { keys: orderedRead.stated, at: SourceLoc("generated orderBy", []) }
				}
				const page = compilePage(pageInput)
				if (!page.ok) {
					assert.ok(page.error.reason._tag !== "MalformedDescription", page.error.message)
					return
				}
				const template = page.value
				const baseline = succeeded(conservativePage(pageInput, template))
				registryTypes([template.artifact, baseline])
				if (baseline.requests.first.delivery.kind === "headingGroups") {
					c.note("heading groups")
				}
				const first = template.artifact.requests.first.program
				if (Arr.some(flight(first.roots), (s) => s.role.kind === "attachment")) {
					c.note("attachments")
				}
				const runtime = compiledPageRuntime({
					page: template,
					params: callerParams(query.params),
					spine: everyColumnCarried(query.dag),
					codes
				})
				assert.equal(
					runtime.anchors.length,
					template.comparators.length,
					"one anchor codec per comparator"
				)
			}),
		oracle: {
			kind: "universal",
			name: "totality: a page or a typed refusal of no malformed structure"
		},
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/page/compile.ts",
				original:
					'\t\t\t\treturn {\n\t\t\t\t\tkind: "groups",\n\t\t\t\t\torder: pagedGroupsOrder(plan.union, root.orders),\n\t\t\t\t\theading: plan.union.heading,\n\t\t\t\t\tplan\n\t\t\t\t}',
				replacement:
					'\t\t\t\treturn refuse(\n\t\t\t\t\t"MalformedDescription",\n\t\t\t\t\tnodeLabel(plan.union),\n\t\t\t\t\t"a page over a heterogeneous union delivered per heading group"\n\t\t\t\t)',
				why: "A page of heading groups is refused as MalformedDescription; the totality property fails."
			}
		]
	})
