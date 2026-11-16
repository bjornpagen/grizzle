import { boxAgreement } from "#test/types/batch/agreement.ts"
/**
 * The README's refusals at the public API (test/types/examples/fixtures/readme.ts), the one sanctioned example code: its
 * blocks are the documentation, mirrored line for line (blocks.test.ts), and `pnpm typecheck` checks the fixtures as
 * they stand. Here the README's fixture is checked disarmed, whole: each refusal it states fails with the claim its
 * directive names, and nothing else fails. Oracle: the refusals the documentation states.
 */
import { statedRefusals } from "#test/types/examples/examples.dictionary.ts"
import { readmeProgram } from "#test/types/examples/examples.fixtures.ts"

/** Fails each refusal the README states with the diagnostic it names, and nothing else. */
export const readme = boxAgreement(statedRefusals, {
	box: "every refusal the README's fixture states",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: readmeProgram,
	oracle: { kind: "specification", name: "the refusals the README states" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original: 'type LevelAddress<S> = S extends AnyFragment ? "fragment" : DepthOf<S>["length"]',
			replacement: 'type LevelAddress<S> = DepthOf<S>["length"]',
			why: "A fragment ChangeSet's array member is addressed by depth, as a schema's, so in the README's feeJob, a union over Shop, JobDone's facts read as no relation's and finishWithFee is refused: the fixtures fail, armed and disarmed."
		},
		{
			file: "packages/grizzle/src/adapter/types/db.ts",
			original: "\tReadsContext<R> extends true ? TokenOptions : TokenOptions | NoTokenOptions",
			replacement:
				"\tReadsContext<R> extends true ? TokenOptions | NoTokenOptions : TokenOptions | NoTokenOptions",
			why: 'Db.open takes no token for a role that reads a context, so the README\'s refusal "MemberBlog reads a context, so Db.open requires a token" compiles: armed, its directive is unused, and disarmed, the refusal is missing.'
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				'\t\t\t\t: Refusal<"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes">',
			replacement: "\t\t\t\t: unknown",
			why: "A ChangeSet writes a world relation its role's write list does not name (types/changeset/changeset.ts WritableCheck admits it), so the README's writePost, an insert into MemberBlog's read-only MemberPost, compiles: armed, its directive is unused, and disarmed, the refusal is missing."
		}
	]
})
