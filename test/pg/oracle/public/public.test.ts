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
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Agrees with the reference on generated programs, read through every public form, each case installing its program's
 * schema through its migration on a database of its own, as each case of the search installed its own.
 *
 * It searches with the runner's budget (runner/limits.ts searchRuns, steeredCases): it declares no kill, and its
 * catch, issue #3's, which its two kept cases hold, was cured by a representation, the value-only Numeric
 * (scalar/values/decimal.ts), which no one-line mutant plants again: with the mean's trim_scale dropped
 * (lower/conservative/group/index.ts aggregateExpr scaleFree) every witness passed (lane CULL-ORACLE's pubkill.log,
 * 2026-11-23).
 */
export const agreesWithTheReferenceOnGeneratedProgramsReadThroughEveryPublicForm = property.explore(
	publicCases,
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: publicSituations satisfies ReadonlyArray<Reached<PublicFeature>>,
		check:
			({ substrate }, c: Case<PublicFeature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.scoped(publicCase(sketch, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator's per-parent delivery, and the read itself under another storage"
		},
		show: Formatter.format,
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
			},
			{
				token: ReplayToken(
					"test/pg/oracle/public/public.test.ts#agreesWithTheReferenceOnGeneratedProgramsReadThroughEveryPublicForm:1ffffffffffffff.1:0.2.1.0.1.0.1.0.1.0.0.1.0.1.0.1.0.1.0.1.2.1.0.1.0.0.1.0.1.2.0.1.0.0.1.0.1.0.0.1.0.1.0.1.0.1.2.1.0.1.0.1.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.xpn.0.0.0.1.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"lane REDS11's floor case 1, shrunk: a recursive read's read-back over a relation of closed ids, whose certification walked its recursive CTE's self-reference until the stack overflowed in generate",
				since: "2026-11-28"
			}
		],
		kills: []
	}
)
