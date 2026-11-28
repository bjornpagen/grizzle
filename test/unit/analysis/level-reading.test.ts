/**
 * A level read within its installation reads each relation as it reads it alone, and holds the installation's reading of
 * it by reference (analysis/schema.ts RealityReading `within`): a level reads only the levels below it, so the
 * installation's info, holding, canonical relation, definition and analysis of each relation of a level's closure are
 * the level's own, and a generate that compiles each level's logins over the level's own artifacts holds them once, for
 * every level, where each level analyzed its whole chain again (metis at PIN 2: nine levels of logins over one base,
 * about 60 MB of analysis each, the base's, which held its live heap at 1.4 to 1.85 GB against Node's default heap).
 *
 * The box: every storage case (test/support/unit/derived/storage.fixtures.ts: a base, the derived relation of a shape over it,
 * every unit and mutability), its level and one to three levels over it, one over another, each declaring nothing of its
 * own, the highest the installation: each level a prefix of the installation's chain (schema.extend takes one base), as
 * each of metis's logins' levels is of its schema's.
 *
 * Property, per case and level: the level's reading within the installation holds the relations, the canonical
 * relations (digest, subject, placement and holding, in admission order), the holdings and the stored analyses (in
 * creation order) its reading alone holds; and every stored analysis it holds is the installation's own object, so the
 * analyses held across every level of the case are the installation's, as many however many levels share them: the
 * retained analysis is flat in the number of levels (the budget).
 *
 * Oracle: the level's own reading, analyzed alone, as every level was read before (a second implementation).
 *
 * Features: a stored derived relation read within, a live one, and a sibling level sharing the base.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	type LevelCase,
	levelCaseGen,
	readingOf,
	readingsOf
} from "#test/unit/analysis/level-reading.fixtures.ts"

type LevelFeature =
	| "a stored derived relation read within"
	| "a live derived relation read within"
	| "levels sharing their base"

/** A level read within its installation reads each relation as it reads it alone, the installation's reading of it held by reference. */
export const aLevelReadWithinItsInstallationReadsEachRelationAsItReadsItAloneTheInstallationsReadingHeldByReference =
	property.explore(levelCaseGen, {
		needs: {},
		situations: [
			"a stored derived relation read within",
			"a live derived relation read within",
			"levels sharing their base"
		] satisfies ReadonlyArray<Reached<LevelFeature>>,
		check: (_, k: Case<LevelFeature>) => (c: LevelCase) =>
			Effect.sync(() => {
				const { installation, levels } = readingsOf(c)
				const held = new Set(installation.derived)
				const sharedAnalyses = new Set<unknown>()
				for (const [at, { analyzed, within }] of levels.entries()) {
					assert.deepEqual(
						readingOf(within),
						readingOf(analyzed),
						`level ${at} of ${Formatter.format(c)} read within its installation as alone`
					)
					for (const analysis of within.derived) {
						assert.ok(
							held.has(analysis),
							`level ${at}'s analysis of ${analysis.name} is the installation's, by reference`
						)
						sharedAnalyses.add(analysis)
					}
					for (const h of within.holdings.values()) {
						k.note(
							h.kind === "stored"
								? "a stored derived relation read within"
								: "a live derived relation read within"
						)
					}
				}
				assert.ok(
					sharedAnalyses.size <= installation.derived.length,
					"the analyses every level holds are the installation's, as many however many levels"
				)
				if (Arr.length(levels) > 2) {
					k.note("levels sharing their base")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the level's own reading, analyzed alone"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/schema.ts",
				original:
					'\tcatchRefusal(() => new CheckedSchema(owned, { kind: "reality", served, reading }))',
				replacement:
					'\tcatchRefusal(() => new CheckedSchema(owned, { kind: "reality", served, reading: { kind: "analyzed" } }))',
				why: "Every level analyzes its whole chain again whatever its reading, as each did before: its analyses are its own objects, none the installation's, and the analyses held grow with the levels, so the property fails."
			}
		]
	})
