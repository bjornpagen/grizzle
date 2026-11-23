/**
 * A table's isolation guard, migrated as its writers' certified levels change. A table takes the guard trigger
 * (physical/ddl/isolation.ts addIsolationTrigger) unless every role that writes it is certified READ COMMITTED and holds
 * only INSERT there (readCommittedRelations); generate certifies each role once from the statements its writes send
 * (program/isolation/certification.ts), and the installation's guards follow its certificates. A migration between two
 * versions whose certificates differ must create or drop the guard exactly as a fresh install of the target holds it,
 * or a READ COMMITTED writer's every write is refused by a guard left behind, or a SERIALIZABLE one runs unguarded.
 *
 * A case draws three versions of one schema of two relations, Post, closed, and Tag, open (mutable inside the unit of
 * its id), keyed by id, and one login over it with two roles. The writer writes a drawn nonempty set of them under
 * `insert`, or Tag alone under `write`, where it holds UPDATE and DELETE (a closed relation's writer holds INSERT alone
 * whichever list names it), and its workload inserts a drawn subset of those, each row supplied by the call; the other
 * role writes a drawn set of them under `write`, with no change member, so it runs SERIALIZABLE, and a relation it
 * writes stays guarded whoever else writes it. Post may be renamed to Note at the second or the third version, so a
 * guard is dropped or created on a table its migration renames. Each version is drafted by generate's own draft
 * (cli/generate.ts draftSchema), its roles certified in the draft's workload plan, from the snapshot the one before
 * reached, and applied by the real runner, the drift check and the installed-catalog checker admitting every apply; or
 * the last two together, as one apply of two pending folders.
 *
 * The oracle is the guard's rule restated over the case: a relation is guarded unless some role writes it and every
 * role that writes it is certified READ COMMITTED (the draft's certificates) and writes it by `insert`. After every
 * apply:
 *
 * - the migrated catalog is a fresh install's of the version (sameCatalog), the guard triggers included;
 * - a READ COMMITTED write of each table, an INSERT of no row, which fires its statement trigger, is refused with 25000
 *   exactly where the rule guards its relation, and otherwise admitted.
 *
 * Features: a guard dropped and one created on a migration, each on a table it renames, a guard flipped within two
 * pending folders, and a READ COMMITTED write admitted and one refused by its guard, each pending one constructed.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { aims, caseGen, type Feature, walk } from "#test/pg/migrate/isolation-guard.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A table's isolation guard, migrated as its writers' certified levels change a migration creates or drops each guard exactly as a fresh install of its target holds it, and a READ COMMITTED write is refused exactly where a guard stands. */
export const isolationGuard = property.explore(aimed(caseGen, aims), {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"a guard dropped on a migration, every writer of its table certified READ COMMITTED",
		"a guard created on a migration, a writer of its table SERIALIZABLE",
		"a guard dropped on a table its migration renames",
		"a guard created on a table its migration renames",
		"a guard flipped within two pending folders applied together",
		"a READ COMMITTED write admitted after a migration",
		"a READ COMMITTED write refused by its table's guard after a migration"
	] satisfies ReadonlyArray<Reached<Feature>>,
	/** Its pre-conversion budget: runs 24, coverage cases 40 (isolation-guard.test.ts at bf4f43bb). */
	budget: { runs: 24, steered: 40 },
	check:
		({ substrate }, cx: Case<Feature>) =>
		(c) =>
			Effect.provideServiceEffect(
				Effect.scoped(walk(c, cx.note)),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "specification",
		name: "the guard's rule restated over the case: a relation is guarded unless some role writes it and every role that writes it is certified READ COMMITTED and writes it by insert"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				'\t\t\tcase "isolationTrigger":\n\t\t\t\tdrop(\n\t\t\t\t\tv.kind,\n\t\t\t\t\tstatement({\n\t\t\t\t\t\tkind: "dropTrigger",\n\t\t\t\t\t\tname: v.create.name,\n\t\t\t\t\t\ttable: v.create.table,\n\t\t\t\t\t\tifExists: false\n\t\t\t\t\t})\n\t\t\t\t)',
			replacement: '\t\t\tcase "isolationTrigger":',
			why: "A migration never drops a table's isolation guard while the table stands."
		}
	]
})
