/**
 * The schema agreement (test/support/agreement/schemas.ts), one program the type batch checks disarmed: over drawn
 * schemas and probes, the types infer what the engine describes, each field's host, fact and keys, and refuse exactly
 * what it refuses, naming its refusal. Oracle: the engine's description of each drawn schema. The floor's witnesses
 * reach every construct, every fault and every refusal it names.
 *
 * @plant test/plants/types/schema/schema-own-names.patch A statement's relation is admitted wherever the schema holds a
 * relation of its name, the relation held under another name among them (types/schema/schema.ts Undeclared); the
 * agreement's program fails.
 * @plant test/plants/types/schema/schema-statements-open.patch A level's statements are an open tuple again, its
 * fragments' statements spread as ReadonlyArray after its own (types/schema/schema.ts), so every drawn schema's
 * StatementsOf is no longer the tuple its calls wrote; the agreement's program fails.
 * @plant test/plants/types/schema/schema-agreement-case-3-broken.patch The generator writes one false assertion into
 * case 3's module (test/support/agreement/schemas.ts schemaModules); the agreement's program fails at case-3.ts.
 * @plant test/plants/types/schema/tree-side-family-check.patch A tree's parent and index go back on the generic
 * family check (analysis/theory/families.ts treeShape), so the engine refuses a caller's parent or index as
 * MalformedDescription where the types name the tree's shape; the treeSideWritten probe fails placement.
 */
import { unreachedOf } from "@bjornpagen/testing/features"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { schemaRequired, schemaWitnesses } from "#test/support/agreement/schemas.ts"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the schema agreement", (it) => {
	it("the floor's witnesses reach every construct, every fault and every refusal it names", () => {
		assert.deepEqual(
			unreachedOf(schemaRequired, [schemaWitnesses().tally]),
			[],
			"constructs, faults or refusals no floor witness reached"
		)
	})

	it.effect(
		"over drawn schemas and probes, the types infer what the engine describes and refuse exactly what it refuses",
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("schema/agreement")
				assert.deepEqual(actual, expected)
			})
	)
})
