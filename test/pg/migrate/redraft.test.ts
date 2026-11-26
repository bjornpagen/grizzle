/**
 * A partial folder resumed under a regeneration, on PostgreSQL 19 (deploy/ledger/decide.ts decideFolder, adapter/migrate
 * apply.ts): the folder drafted again under its name after some of its files committed, the regeneration keeping, or
 * not, the folder's source, its file count and its completed files byte for byte.
 *
 * A case draws a folder of the shop chain (Shop v1 to v3 from the empty snapshot beside an abandoned schema), how many
 * of its files commit before a refused file stops it, a regeneration of it, whether the regeneration holds a file more,
 * and whether the regeneration's next file is refused once. Every regeneration is a real draft, reviewed as the chain's
 * folders are: of the folder's source to a schema that differs from the folder's target by a key, a check, a mutable
 * declaration or an alternative, whose first files grizzle may draft byte for byte alike and whose later files and
 * target differ, or by a contract's name alone, whose every file is alike and whose target differs; to another version, whose first file differs; of another source to the folder's own target; or the
 * folder's own draft again. Which files agree is read off the drafts, never assumed.
 *
 * Oracle: the documented contract, restated over the drafts' texts. A completed file the regeneration does not hold
 * byte for byte at its ordinal refuses the apply at `edited`, naming exactly those files; then another source, another
 * file count, or a regeneration whose meta.json is another that would resume at a no-transaction file, which may have
 * partly run under the started draft, refuses it at `order`, the last naming that file; each refusal runs nothing, the
 * ledger and the catalog read back unchanged. Otherwise the folder resumes at its first file without a row. A next file refused stops it there, and the ledger and
 * the catalog read back unchanged: the re-record of a regeneration rolls back with its file. The rerun completes: every
 * row of the folder records the regeneration's source, target and file count, its folder row the SHA-256 of the
 * regeneration's meta.json and each file row its file's; the ledger's latest target is the regeneration's; the
 * snapshot guard admits the regeneration's target and refuses the started draft's other one; and the schema's catalog
 * is a fresh install's of the chain with the regeneration in the folder's place, drafted under a schema of its own
 * (sameCatalog).
 *
 * Features: each verdict, the regeneration's re-record rolled back with its refused next file, a regeneration of a
 * target alike in files but not in fingerprint, and a resume whose next file runs outside a transaction. A case whose
 * turn aims at one is drawn by the generator as a folder, a regeneration and a point that reach it (aims).
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed, constant } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { aims, caseGen, type Feature, runCase } from "#test/pg/migrate/redraft.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A partial folder resumed under a regeneration cases of the rotating stream, steered until every feature is reached: the regeneration resumes exactly when it keeps the folder's source, file count and completed files, its re-record rides its next file, and the result is a fresh install's. */
export const redraft = property.explore(
	aimed(
		caseGen,
		Arr.map(aims, ([feature, c]) => [feature, constant(c)] as const)
	),
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a regeneration resumed",
			"a regeneration alike in files resumed",
			"the started draft resumed",
			"a resume whose next file runs outside a transaction",
			"a regeneration's next file refused, its re-record rolled back",
			"a completed file the regeneration changes refused",
			"a regeneration of another source refused",
			"a regeneration of another file count refused",
			"a regeneration resuming at a no-transaction file refused"
		] satisfies ReadonlyArray<Reached<Feature>>,
		/** Its pre-conversion budget: runs 12, coverage cases 72 (redraft.test.ts at bf4f43bb). */
		budget: { runs: 12, steered: 72 },
		check:
			({ substrate }, c2: Case<Feature>) =>
			(value) =>
				Effect.provideServiceEffect(
					runCase(value, c2),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the resume's documented contract, restated over the drafts' texts, against the database read back and a fresh install"
		},
		kept: [
			{
				token: ReplayToken("test/pg/migrate/redraft.test.ts#redraft:-:1.29m.0.0.0"),
				reason:
					"Shop v2's folder regenerated toward v2 with Task closed again: the regeneration leaves out openTask whole, its unit and the mutable declaration that needs it, where the removal of v2's statement at index 4, once the mutable declaration and now the unit since openTask became two statements, left Task mutable under no unit and the schema refused at its admission",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "test/pg/migrate/redraft.fixtures.ts",
				original: '\t\tpart === "open" ? openTask.includes(s) : s.kind === part',
				replacement: '\t\tpart === "open" ? s === openTask[0] : s.kind === part',
				why: "Task open is left out by its first statement alone, the unit, as the removal by index left it out: Task stays mutable under no unit, the regeneration toward v2 immutable is refused at its schema's admission, and the kept case fails."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/apply.ts",
				original: "\t\t\t\t: []",
				replacement:
					"\t\t\t\t: []\n\t\tif (redraft.length > 0) {\n\t\t\tyield* Effect.orDie(session.transaction([...fenceOf(statements, ledger), ...redraft]))\n\t\t\tredraft = []\n\t\t}",
				why: "The re-record runs in a transaction of its own before the next file, so a refused next file leaves the regeneration recorded."
			},
			{
				file: "packages/grizzle/src/adapter/migrate/plan.ts",
				original: "\t\t...(state.partial === undefined ? [] : editsOf(state.partial, () => []))",
				replacement:
					"\t\t...(state.partial === undefined ? [] : editsOf({ ...state.partial, completed: [] }, () => []))",
				why: "The partial folder's completed files are not compared with the texts that ran, so a regeneration that changed one resumes where it must be refused at `edited`."
			},
			{
				file: "packages/engine/src/deploy/ledger/decide.ts",
				original: "\treturn next?.noTransaction === true",
				replacement: '\treturn next?.noTransaction === true && next.name === ""',
				why: "A regeneration resumes at a no-transaction file, which may have partly run under the started draft, where it must be refused at `order`."
			},
			{
				file: "packages/engine/src/deploy/render/sql.ts",
				original:
					"\treturn [{ above, write: first }, ...rest.map((write): Spelled => ({ above: [], write }))]",
				replacement:
					"\treturn [\n\t\t{\n\t\t\tabove,\n\t\t\twrite: (out) => {\n\t\t\t\tlet pending = first\n\t\t\t\tfor (const next of rest) {\n\t\t\t\t\tterminated(out, pending)\n\t\t\t\t\tpending = next\n\t\t\t\t}\n\t\t\t\tpending(out)\n\t\t\t}\n\t\t}\n\t]",
				why: "A file's statements are recorded as one text, as before 3e9bbb2c, so a resume under a regeneration is refused: the folder does not record 01-setup.sql as it ran."
			}
		]
	}
)
