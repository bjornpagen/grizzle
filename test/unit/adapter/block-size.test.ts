/**
 * A server's admission by its block size (adapter/admission/expectation.ts blockSizeColumn, blockSizeRefusal), which
 * migrate's survey reads in its one query before any statement runs: every bound grizzle holds a key, a row and an index
 * entry to is derived from PostgreSQL's default block size (core/page.ts blockSize), so a server built with other pages
 * is refused, by BlockSizeMismatched naming its size and the one required, at stage `blocks`, before anything ran; a
 * server of the default size is admitted.
 *
 * Box, exhausted: every block size PostgreSQL 19 builds with, as current_setting prints it, and texts no server answers.
 * Oracle: PostgreSQL 19's build options and its block_size setting, as a table (block-size.fixtures.ts specified).
 *
 * Features: each verdict, by its size.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Option } from "effect"
import { blockSizeRefusal } from "#adapter/admission/expectation.ts"
import { MigrateError, stageOutcome } from "#adapter/migrate/errors.ts"
import {
	type BlockSizeFeature,
	blockSizeTextGen,
	featureOf,
	features,
	specified
} from "#test/unit/adapter/block-size.fixtures.ts"

/** A server whose block size is not PostgreSQL's default is refused before anything runs, naming its size; one of the default is admitted. */
export const aServerOfAnotherBlockSizeIsRefusedBeforeAnythingRunsAndOneOfTheDefaultIsAdmitted =
	property.exhaust(finite(blockSizeTextGen), {
		needs: {},
		situations: features satisfies ReadonlyArray<Reached<BlockSizeFeature>>,
		check: (_, c: Case<BlockSizeFeature>) => (text) =>
			Effect.sync(() => {
				c.note(featureOf(text))
				const refusal = blockSizeRefusal(text)
				switch (specified(text)) {
					case "admitted":
						assert.ok(Option.isNone(refusal), `a server whose block_size reads ${text} is admitted`)
						break
					case "refused": {
						assert.deepEqual(
							Option.map(refusal, (r) => [r._tag, r.observed, r.required] as const),
							Option.some(["BlockSizeMismatched", text, 8192] as const),
							`a server whose block_size reads ${Formatter.format(text)} is refused, naming it and 8192`
						)
						const stopped = new MigrateError({ reason: Option.getOrThrow(refusal) })
						assert.equal(stopped.stage, "blocks", "it stops at stage blocks")
						assert.equal(stageOutcome[stopped.stage], "nothingRan", "before anything ran")
						break
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL 19's block sizes (meson_options.txt blocksize) as current_setting prints block_size, and the default grizzle's page bounds rest on"
		},
		box: "every block size PostgreSQL 19 builds with, 1 to 32 kB, and three texts no server answers",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/admission/expectation.ts",
				original: "\treported === String(blockSize)\n",
				replacement: '\treported !== ""\n',
				why: "Every block size a server reports admitted: a server built with 4 kB pages passes the survey, and then refuses keys and rows grizzle admits; the property fails at 1024."
			},
			{
				file: "packages/grizzle/src/adapter/admission/expectation.ts",
				original: "\treported === String(blockSize)\n",
				replacement: "\treported === String(blockSize * 2)\n",
				why: "The survey holds a server to twice the default block size: a server of the default is refused and one of 16 kB admitted; the property fails at 8192."
			}
		]
	})
