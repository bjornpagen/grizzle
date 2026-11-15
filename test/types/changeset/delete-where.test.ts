/**
 * ChangeSet#deleteWhere's types (test/types/changeset/delete-where.ts), one program the type batch checks disarmed: over
 * every case of the deleteWhere box (test/support/agreement/delete-where.ts), each relation a key may name with each
 * selection shape, a deleteWhere typechecks exactly when the engine builds and compiles it, and a refused one names the
 * refusal its subject or its selection breaks. Oracle: the engine's build and compile of each case.
 *
 * @plant test/plants/types/changeset/delete-where-any-term.patch A field may equal any term of its type, whatever its
 * origin (types/changeset/changeset.ts EqualedTo), so a variable or a typed constant in place of a parameter is
 * admitted; the program fails.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })("ChangeSet#deleteWhere's types", (it) => {
	it.effect(
		"admits every case the engine builds and compiles, and refuses every other with the refusal its directive names",
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("changeset/delete-where")
				assert.deepEqual(actual, expected)
			})
	)
})
