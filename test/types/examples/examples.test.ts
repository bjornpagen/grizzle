/**
 * The README's and SKILL.md's program at the public API (test/types/examples/fixtures), the one sanctioned example
 * code: its blocks are the documentation, mirrored line for line (blocks.test.ts). The type batch checks the fixtures
 * twice: as they stand they typecheck, and disarmed each refusal the documentation states fails with the claim its
 * directive names, and nothing else does.
 *
 * @plant test/plants/types/examples/fragment-member-by-depth.patch A fragment ChangeSet's array member is addressed by
 * depth, as a schema's, so in the README's feeJob, a union over Shop, JobDone's facts read as no relation's and
 * finishWithFee is refused: the fixtures fail, armed and disarmed.
 * @plant test/plants/types/api/api-open-token-optional.patch Db.open takes no token for a role that reads a context,
 * so the README's refusal "MemberBlog reads a context, so Db.open requires a token" compiles: armed, its directive is
 * unused, and disarmed, the refusal is missing.
 * @plant test/plants/types/examples/changeset-writable-world.patch A ChangeSet writes a world relation its role's
 * write list does not name (types/changeset/changeset.ts WritableCheck admits it), so the README's writePost, an
 * insert into MemberBlog's read-only MemberPost, compiles: armed, its directive is unused, and disarmed, the refusal
 * is missing.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import { checked } from "#test/types/batch/batch.ts"

layer(NodeServices.layer, { excludeTestServices: true })(
	"the worked example's program at the public API",
	(it) => {
		it.effect("typechecks the program and its refusals under tsgo with Effect diagnostics", () =>
			Effect.gen(function* () {
				const diagnostics = yield* checked("examples/fixtures")
				assert.equal(diagnostics.output, "")
			})
		)

		it.effect("fails each refusal with the diagnostic it names, and nothing else", () =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("examples/disarmed")
				assert.deepEqual(actual, expected)
			})
		)
	}
)
