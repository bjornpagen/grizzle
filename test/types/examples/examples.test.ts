/**
 * The README's refusals at the public API (test/types/examples/fixtures/readme.ts and readme.app.ts), the one sanctioned
 * example code: its blocks are the documentation, mirrored line for line (blocks.test.ts), and `pnpm typecheck` checks
 * the fixtures as they stand. Here the README's fixtures are checked disarmed, whole: each refusal they state fails with
 * the claim its directive names, and nothing else fails. Oracle: the refusals the documentation states.
 */
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { statedRefusals } from "#test/types/examples/examples.dictionary.ts"
import { readmeProgram } from "#test/types/examples/examples.fixtures.ts"

/** Fails each refusal the README states with the diagnostic it names, and nothing else. */
export const readme = boxAgreement(statedRefusals, {
	box: "every refusal the README's fixtures state",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: readmeProgram,
	oracle: { kind: "specification", name: "the refusals the README states" },
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/types/db.ts",
			original:
				"\tReadsToken<R> extends true ? { readonly token: string } : { readonly token?: string }",
			replacement:
				"\tReadsToken<R> extends true ? { readonly token?: string } : { readonly token?: string }",
			why: "Db.open takes no token for a role that reads a token's context, so the README's tokenless open of the tracker's teammate compiles: armed, its directive is unused, and disarmed, the error is missing."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				'\t\t\t\t: Refusal<"a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes">',
			replacement: "\t\t\t\t: unknown",
			why: "A ChangeSet writes a world relation its role's write list does not name (types/changeset/changeset.ts WritableCheck admits it), so the README's insert through the member's read-only Post compiles: armed, its directive is unused, and disarmed, the refusal is missing."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original: "\t\t? Refusal<(typeof closedChangeRefusals)[Op]>",
			replacement: "\t\t? unknown",
			why: "A put or a delete of a closed relation is admitted (types/changeset/changeset.ts EditOf), so the README's delete of an Order compiles: armed, its directive is unused, and disarmed, the refusal is missing."
		},
		{
			file: "packages/engine/src/types/query/query.ts",
			original: "\t\t\t\t: [DomainOf<Hc[K]>] extends [Unordered]\n\t\t\t\t\t? readonly [",
			replacement: "\t\t\t\t: [DomainOf<Hc[K]>] extends [never]\n\t\t\t\t\t? readonly [",
			why: "An order names a closed id of an unordered roster (types/query/query.ts OrderedKeys requires nothing of it), so the README's orderBy of an invoice's status compiles: armed, its directive is unused, and disarmed, the refusal is missing."
		},
		{
			file: "packages/engine/src/types/compute/compute.ts",
			original:
				'\t\t\tHasOrder<A>,\n\t\t\t"a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles"',
			replacement:
				'\t\t\ttrue,\n\t\t\t"a closed id of a closed.unordered roster has no order: declare its roster closed.ordered to compare or order by its handles"',
			why: "A row check's comparison of a field of an unordered roster compares by its codes (types/compute/compute.ts Ordered requires nothing of it), so PaidOrLater, the README's row check, compiles: armed, its directive is unused, and disarmed, the refusal is missing."
		}
	]
})
