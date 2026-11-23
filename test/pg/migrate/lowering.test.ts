/**
 * A containment over Use, migrated with stored rows on PostgreSQL 19 between the forms that hold it: a native foreign key,
 * or the deferred constraint triggers of a rule over a query (physical/ddl/rules.ts), whichever the law model installs.
 * A rule into a derived relation that is a selection of one stored relation by constants, keyed within it, is lowered
 * to foreign keys (analysis/theory/laws.ts lowering): a constant column on Use per constant, a UNIQUE over Doc's
 * columns and constants, and a deferred foreign key, under the rule's one law. An edit of D's definition alone flips the
 * rule between its two forms under that law.
 *
 * A case draws three versions of one schema, each a shape of what Use(doc) is contained in: a selection of Doc by a kind
 * (`selection`, lowered), the same with Extra's nodes as a second arm (`union`) or without them (`negated`), each kept
 * by triggers, each a derived relation D; Doc itself (`doc`), a stored containment; or nothing (`none`), each version's
 * kind drawn apart; and rows of Doc, Extra and Use, stored after the first version, those of Use its law refuses left
 * out. Each later version is drafted from the snapshot before, as a history drafts it (install-migrate.ts
 * draftVersion), and applied by the real runner as `grizzle migrate` applies it, the drift check and the installed-catalog checker admitting every apply; or the last two together, as one
 * apply of two pending folders, Use renamed to Usage in the last, so the constraints of the first of them are named
 * otherwise in the target. The steered phase aims at each flip both ways under one law, applied and refused, at a
 * lowered rule's constant changed, and at each form added over rows that break it.
 *
 * The oracle is the law restated over the stored rows. A migration applies exactly when the rows keep the law of every
 * version it reaches. A refused one names the folder of the first version whose law the rows break, and that version's
 * law: a foreign key's validation names it through the refused folder's own laws (its meta.json's FolderLaws), as a
 * refused write names it (migrate's StatementFailed or FileCommitRefused `law`), and a rule's violation check by the
 * law's own identity. An earlier folder of two pending names its law by its own map though the last folder renames Use,
 * so no constraint of Use stands in the target's. After every apply:
 *
 * - the migrated catalog is a fresh install's of the version (install-migrate.ts expectFreshCatalog);
 * - a Use row naming a doc no Doc row holds is refused at COMMIT with 23503 by a constraint the target's
 *   constraint-to-law map reads as the law, a foreign key's or a trigger's, whichever holds it.
 *
 * Features: each flip both ways under one law, applied and refused, a lowered rule's constant changed, each form added
 * over rows that break it, an intermediate folder refused, and a refused write naming its law by a foreign key and by a
 * trigger, each pending one constructed.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { aims, caseGen, type Feature, walk } from "#test/pg/migrate/lowering.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Rules held by foreign keys or by triggers, migrated with stored rows migrate between a rule's foreign keys and its triggers exactly when the stored rows keep it, naming its law when they do not. */
export const lowering = property.explore(aimed(caseGen, aims), {
	needs: { substrate: Substrate.fresh },
	situations: [
		"triggers to foreign keys applied over stored rows",
		"foreign keys to triggers applied over stored rows",
		"a lowered rule's constant changed over stored rows",
		"a lowered rule's constant changed over stored rows that break it, refused naming its law",
		"triggers to foreign keys over stored rows that break them, refused naming the law",
		"a lowered rule added over stored rows that break it, refused naming its law",
		"a stored containment added over stored rows that break it, refused naming its law",
		"a triggered rule added over stored rows that break it, refused naming its law",
		"an intermediate folder refused, two pending",
		"an intermediate folder's foreign key refused, two pending, named by its own laws",
		"a refused write names the law by its foreign key",
		"a refused write names the law by its trigger"
	] satisfies ReadonlyArray<Reached<Feature>>,
	/** Its pre-conversion budget: runs 24, coverage cases 60 (lowering.test.ts at bf4f43bb). */
	budget: { runs: 24, steered: 60 },
	check:
		({ substrate }, cx: Case<Feature>) =>
		(c) =>
			Effect.provideServiceEffect(Effect.scoped(walk(c, cx.note)), Substrate, substrate),
	oracle: {
		kind: "specification",
		name: "the rule restated over the stored rows: a migration applies exactly when they keep every rule it reaches, and a refused one names the rule's law"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/diff.ts",
			original:
				'\t\t\tcase "lawTrigger":\n\t\t\t\tdrop(\n\t\t\t\t\tv.kind,\n\t\t\t\t\tstatement({\n\t\t\t\t\t\tkind: "dropTrigger",\n\t\t\t\t\t\tname: v.create.name,\n\t\t\t\t\t\ttable: v.create.table,\n\t\t\t\t\t\tifExists: false\n\t\t\t\t\t})\n\t\t\t\t)',
			replacement: '\t\t\tcase "lawTrigger":',
			why: "A migration keeps a rule's law triggers when the rule leaves them for foreign keys."
		}
	]
})
