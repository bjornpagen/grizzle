/**
 * The public-boundary differential (suite.ts): programs generated as calls to grizzle's public builders, installed
 * through their migration, read through Db as the schema's full role in every public form, every decoded nested result
 * against the reference evaluator's per-parent delivery, every cell text's trusting conversion against its strict
 * reading, and every read read again, exactly as it first answered, over its facts stored otherwise.
 *
 * Oracle: the reference evaluator's per-parent delivery, the kernel's strict reader of each cell, and the read itself
 * under another storage order and spelling.
 *
 * Features: suite.ts's situations, every program form and identifier kind, and each decline of the reference.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	type PublicFeature,
	publicCase,
	publicCases,
	publicSituations
} from "#test/pg/oracle/public/suite.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Agrees with the reference on generated programs, read through every public form, each case installing its program's
 * schema through its migration on the worker's clone, as each case of the search installed its own.
 *
 * Its pre-conversion budget: runs 80, coverage cases 80 (test/pg/oracle/public/suite.ts cases at 7301d9ad2).
 */
export const agreesWithTheReferenceOnGeneratedProgramsReadThroughEveryPublicForm = property.explore(
	publicCases,
	{
		needs: { substrate: Substrate.installing },
		situations: publicSituations satisfies ReadonlyArray<Reached<PublicFeature>>,
		check:
			({ substrate }, c: Case<PublicFeature>) =>
			(sketch) =>
				Effect.provideServiceEffect(Effect.scoped(publicCase(sketch, c)), Substrate, substrate),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's per-parent delivery, and the read itself under another storage"
		},
		show: Formatter.format,
		budget: { runs: 80, steered: 80 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/oracle/public/public.test.ts#agreesWithTheReferenceOnGeneratedProgramsReadThroughEveryPublicForm:-:1"
				),
				reason: "issue #3's shrunk case: Task's 0 in two spellings, collapsed under its plan",
				since: "2026-11-04"
			},
			{
				token: ReplayToken(
					"test/pg/oracle/public/public.test.ts#agreesWithTheReferenceOnGeneratedProgramsReadThroughEveryPublicForm:-:2"
				),
				reason: "issue #3's mean over 0 at display scale 24, 0, 1 and 3, under every setting",
				since: "2026-11-04"
			}
		],
		kills: []
	}
)
