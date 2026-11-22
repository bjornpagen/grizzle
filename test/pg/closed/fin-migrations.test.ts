/**
 * Dependent-sum keys through grizzle's migrations on PostgreSQL 19, generated: a change to a dependent space is a
 * constant replacement, and the codes its slots are stay stable under declared renames.
 *
 * A case draws a history of versions of a slotted closed relation Last, keyed by (version, parent, at) with `at` a slot
 * of fin(Model, "positions"), and of its product twin LastProduct, keyed by the same fields as closed ids, each read by
 * the containment CHECK of a stored probe relation (Step into Last, StepProduct into LastProduct). The first version
 * draws Model's counts for (v0, k0) and (v0, k1) and Last's rows, each a slot below its parent's count; each later
 * version makes one change: a count grows, Last gains a row, a Position handle is renamed (declared), or Position
 * appends a handle. Every version is migrated through grizzle's generated folders, and after it each probe draws
 * (parent, position) pairs to insert into both probes.
 *
 * Oracle, against PostgreSQL's catalog and verdicts:
 * - content addressing: the functions Step's CHECK reads, its row function and the constants the row function's body
 *   calls (physical/ddl/row-functions.ts), stand exactly when Last's rows, as codes, and Model's counts stand, and a
 *   function that keeps its name keeps its definition, since a constant is named by its content, a row function by its
 *   definition, and neither is redefined in place (two contents may spell one body: a body's hex pads its cells to whole
 *   digits). So a changed count replaces at least its counts' constant and its rows', and the owners' bases only where
 *   they move; a rename keeps every code, so it replaces none of them.
 *   Beside a rename, StepProduct's stand exactly when the rows and Position's size stand: a grown roster replaces the
 *   product's and no dependent space's.
 * - verdicts: a probe is admitted into both exactly when its pair is a row of Last, refused with 23514 otherwise.
 * - stored rows: every admitted probe is kept by every later migration.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	finCase,
	type FinFeature,
	historyGen,
	renamedHistoryGen
} from "#test/pg/closed/fin-migrations.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Dependent keys through grizzle's migrations on PostgreSQL 19 a changed count replaces its counts' and its rows' constants, a kept constant keeps its body, a rename or a grown slot roster replaces none of it, and every probe is admitted exactly into Last's rows. */
export const finMigrations = property.explore(
	aimed(historyGen, [["a position renamed", renamedHistoryGen]]),
	{
		needs: { substrate: Substrate.installing },
		situations: [
			"a count grows",
			"Last gains a row",
			"a position renamed",
			"a position appended",
			"a probe admitted",
			"a probe refused",
			"a count grown under stored probes"
		] satisfies ReadonlyArray<Reached<FinFeature>>,
		/** Its pre-conversion budget: runs 3, coverage cases 16 (fin-migrations.test.ts at bf4f43bb). */
		budget: { runs: 3, steered: 16 },
		check:
			({ substrate }, c: Case<FinFeature>) =>
			(value) =>
				Effect.provideServiceEffect(finCase(value, c), Substrate, substrate),
		oracle: {
			kind: "postgresql",
			name: "content addressing of constants and the codes a rename keeps, against PostgreSQL's catalog and verdicts"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/render/sql.ts",
				original: '\tconst lines = s.text.split("\\n")',
				replacement: "\tconst lines: Array<string> = []",
				why: "A drafted statement's command written as no lines (deploy/render/sql.ts spelledLines), so the folder misses it; the property fails (lane CATCH's sql/print.ts terminated kill of grizzle 0baff5d6, re-pointed where 1fc5a519 moved the drafted file's terminator, and again where PERF-CANON's 5f4199b4f moved an action statement's lines to spelledLines, terminated writing a confirm's and a loss's alone, which no case drafts)."
			}
		]
	}
)
