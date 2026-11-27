import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result } from "effect"
import { decodePlan } from "#adapter/explain/plan.ts"
import type { Plan } from "#adapter/types/db.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import type { ServedTables } from "#compiler/plan/serve.ts"
import {
	all,
	caseGen,
	depthOf,
	installedJson,
	type PlanFeature,
	printed,
	projected
} from "#test/unit/adapter/explain.fixtures.ts"

/**
 * EXPLAIN (FORMAT JSON, VERBOSE) decoding keeps each node's type, estimates and children, names what it reads by the
 * served file, and refuses what the file does not name.
 *
 * Budget: its suite's count before the conversion (unit/adapter/explain-plan: 300 independent cases and 112 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const eXPLAINFORMATJSONVERBOSEDecodingKeepsEachNodesTypeEstimatesAndChildrenNamesWhatItReadsByTheServedFileAndRefusesWhatTheFileDoesNotName =
	property.explore(caseGen, {
		needs: {},
		situations: [
			"a leaf",
			"a node with several children",
			"nested three deep",
			"members dropped",
			"a table read whole",
			"an index scan",
			"a bitmap index scan under its heap",
			"a plan refused",
			"a temporary table refused"
		] satisfies ReadonlyArray<Reached<PlanFeature>>,
		check: (_, k: CaseOf<PlanFeature>) => (c) =>
			Effect.sync(() => {
				const nodes = all(c.root)
				const installed = trustedJson<ServedTables>(jsonText(installedJson(c.tables)))
				const decoded = decodePlan(jsonText([{ Plan: printed(c.root, c.bitmap) }]), installed)
				const expected = projected(c, c.root)
				if (expected === undefined) {
					assert.ok(Result.isFailure(decoded), "a plan the file does not name is refused")
					k.note("a plan refused")
					if (Arr.some(nodes, (n) => n.read.kind === "temporary")) {
						k.note("a temporary table refused")
					}
				} else {
					assert.deepEqual(decoded, Result.succeed(expected))
					const plans = (plan: Plan): ReadonlyArray<Plan> => [
						plan,
						...Arr.flatMap(plan.children, plans)
					]
					const targets = Arr.map(plans(expected), (p) => p.on)
					if (Arr.some(targets, (t) => t.kind === "relation")) {
						k.note("a table read whole")
					}
					if (
						Arr.some(
							plans(expected),
							(p) => p.node !== "Bitmap Index Scan" && p.on.kind === "index"
						)
					) {
						k.note("an index scan")
					}
					if (Arr.some(plans(expected), (p) => p.node === "Bitmap Index Scan")) {
						k.note("a bitmap index scan under its heap")
					}
				}
				if (c.root.children.length === 0) {
					k.note("a leaf")
				}
				if (Arr.some(nodes, (n) => n.children.length > 1)) {
					k.note("a node with several children")
				}
				if (depthOf(c.root) >= 3) {
					k.note("nested three deep")
				}
				if (Arr.some(nodes, (n) => n.dropped.length > 0)) {
					k.note("members dropped")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the plan tree's projection onto the Plan's documented fields, its targets named by the drawn installed tables"
		},
		budget: { runs: 300, steered: 112 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/explain/plan.ts",
				original: "\tfor (const node of nodes ?? []) {",
				replacement: "\tfor (const node of (nodes ?? []).toReversed()) {",
				why: "A node's children are kept in reverse order."
			},
			{
				file: "packages/grizzle/src/adapter/explain/plan.ts",
				original: "\treturn Result.flatMap(namedOf(relation, node.Schema, installed), (named) =>",
				replacement:
					'\tconst first = Object.keys(own(installed, node.Schema ?? "") ?? {})[0] ?? relation\n\treturn Result.flatMap(namedOf(index === undefined ? relation : first, node.Schema, installed), (named) =>',
				why: "An index node is read against the first table of its schema rather than the table it names, so it names the relation of another table of its schema, or is refused."
			},
			{
				file: "packages/grizzle/src/adapter/explain/plan.ts",
				original: "\tif (relation === undefined) {\n\t\treturn Result.map(",
				replacement:
					'\tif (relation === undefined || node.Schema === "pg_temp") {\n\t\treturn Result.map(',
				why: "A node of the session's temporary schema is read as reading nothing, as a format 8 carrier's was, rather than refused as a table the served file does not name."
			}
		]
	})
