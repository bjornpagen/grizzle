/**
 * What generate and check keep of a draft past the draft phase holds neither the draft's plan nor its decision record
 * (cli/generate.ts keptOf, Drafted): the plan, every step's statement as its tree, and the record, every statement's
 * tokens, are the draft's own, which nothing after the draft reads, so the served files' compile and the write run
 * without them, where the CLI kept the whole draft (edullm's qti App at hub 5374a0575: the plan alone 217 MB of the
 * 2.2 GB live as the served phase starts).
 *
 * Property, per case: a drawn schema's first migration drafted from nothing (whole-tables.fixtures.ts), the objects
 * reachable from what the CLI keeps of it (each object's own properties, a list's elements, a map's keys and values, a
 * set's members) include its folder and its snapshot and neither its plan nor its record. Oracle: specification, what
 * the CLI reads of a draft. Kill: the CLI keeps the draft whole beside its fields, as it did.
 *
 * Features: none required.
 */

import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { keptOf } from "#cli/generate.ts"
import { noDeclarations } from "#compiler/deploy/diff/plan.ts"
import { draftMigration } from "#compiler/deploy/render/generate.ts"
import { emptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { succeeded } from "#test/support/assert.ts"
import { installationOf, wholeCaseGen } from "#test/support/unit/deploy/whole-tables.fixtures.ts"

/** Every object reachable from `root`: its own properties' values, a list's elements, a map's entries, a set's members. */
const reachable = (root: unknown): ReadonlySet<object> => {
	const seen = new Set<object>()
	const pending: Array<unknown> = [root]
	while (pending.length > 0) {
		const next = pending.pop()
		if (
			(typeof next !== "object" && typeof next !== "function") ||
			next === null ||
			seen.has(next)
		) {
			continue
		}
		seen.add(next)
		if (next instanceof Map) {
			for (const [key, value] of next) {
				pending.push(key, value)
			}
		} else if (next instanceof Set) {
			for (const member of next) {
				pending.push(member)
			}
		}
		for (const key of Reflect.ownKeys(next)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(next, key)
			if (descriptor !== undefined && "value" in descriptor) {
				pending.push(descriptor.value)
			}
		}
	}
	return seen
}

/** What the CLI keeps of a draft holds its folder and snapshot, and neither its plan nor its decision record. */
export const whatTheCliKeepsOfADraftHoldsItsFolderAndSnapshotAndNeitherItsPlanNorItsDecisionRecord =
	property.explore(wholeCaseGen, {
		needs: {},
		situations: [],
		check: () => (spec) =>
			Effect.sync(() => {
				const draft = succeeded(
					draftMigration({
						previous: emptySnapshot({ schemaName: "Whole", schema: "whole" }),
						installation: installationOf(spec),
						workload: noWorkload,
						declared: noDeclarations,
						abandoned: []
					})
				)
				const reached = reachable(keptOf(draft))
				assert.ok(
					reached.has(draft.folder) && reached.has(draft.snapshot),
					"the kept draft holds its folder and its snapshot"
				)
				assert.ok(!reached.has(draft.plan), "the kept draft holds no plan")
				assert.ok(!reached.has(draft.record), "the kept draft holds no decision record")
			}),
		oracle: { kind: "specification", name: "what the CLI reads of a draft past the draft phase" },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/cli/generate.ts",
				original: "\tchange: draft.change,\n\tfolder: draft.folder,",
				replacement: "\t...draft,\n\tchange: draft.change,\n\tfolder: draft.folder,",
				why: "The CLI keeps the draft whole beside the fields it reads, as it did, so its plan and its decision record live through the served files' compile and the write."
			}
		]
	})
