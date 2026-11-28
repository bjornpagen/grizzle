import type { Reached } from "@bjornpagen/testing/features"
/**
 * Regex membership across the three engines.
 *
 * For each family of semantic edges (non-ASCII digits, the four line terminators, anchors, negated classes, the empty
 * string, escapes), an exploration draws batches of randomized strings over the family's alphabet and generated
 * patterns, and every batch meets every handwritten and generated admitted pattern of the family; four answers must
 * agree on every pair:
 *
 * 1. ECMAScript's `new RegExp(source, flags).test`, the development-only oracle;
 * 2. the host NFA, which the compiler uses for its own constants;
 * 3. PostgreSQL 19's `~` with the translated ARE, under pg_c_utf8;
 * 4. the installed enforcement itself: the compiler's domain DDL (finite IN, ARE CHECK, or no domain at all for a
 *    tautology), asked through pg_input_is_valid, which evaluates the domain's CHECK constraints.
 *
 * The file also holds that every admitted pattern compiles inside the limits of PostgreSQL's regex compiler: the largest
 * pattern the limits admit along drawn shapes, and generated nested quantifiers. A count whose IR no text matches hands
 * PostgreSQL no ARE (scalar/regex/admit.ts), so a shape's edge stops below it; that the IR is never exactly when no
 * text matches is test/unit/text/emptiness.test.ts's, against its own oracle. The refusal of unadmitted constructs is
 * test/unit/text/parse.test.ts's, and that the limits judge the printed ARE whatever its spelling is
 * test/unit/text/lowering.test.ts's.
 */

import * as RegexIr from "@bjornpagen/grizzle-text/regex/ir"
import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { toAre } from "@bjornpagen/grizzle-text/regex/print"
import { assert } from "@bjornpagen/testing/assert"
import { family, property, ReplayToken } from "@bjornpagen/testing/property"
import type { Case } from "@bjornpagen/testing/property"
import { Effect, Exit, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	agreements,
	compileWithin,
	type EdgeFeature,
	edgeAt,
	edgeLimits,
	growthSpace,
	measureAt,
	type NestedFeature,
	nestedRuns,
	refine,
	showGrowth,
	truth
} from "#test/support/pg/text/differential.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"
import { nestedPattern } from "#test/support/unit/text/generators.ts"

/** Regex membership: ECMAScript, the host NFA, PostgreSQL ARE and the installed domain agree on batches of randomized strings per family. */
export const regexMembershipAgreeOnBatchesOfRandomizedStringsPerFamily = family(agreements)

/**
 * Regex membership: PostgreSQL compiles the largest pattern the limits admit along a drawn shape, at each limit's edge.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/text/differential.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/text/differential.test.ts` at its budget
 *   before, `{ runs: 16, steered: 3 }`, each kill's verdict printed with where its witnesses went red (judgedLine with
 *   the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by
 *   path in run-budgets.log there; the runs 1, 5 and 9 by path in run-budgets.log, probe1.log and probe2.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on the first case of its floor stream; at runs 1 no witness reached arcs and anchors
 *   (run-budgets.log), at runs 5 and 9, floors of two and three cases beside its steered cap of 3, none reached
 *   matchStates (probe1.log, probe2.log)
 * @decision 13, the least runs whose floor stream, four cases, and steered phase reach every required situation, as its
 *   budget before did with the same floor
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const regexMembershipCompilesTheLargestPatternTheLimitsAdmitAlongADrawnShapeAtEachLimitsEdge =
	property.explore(growthSpace, {
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: edgeLimits satisfies ReadonlyArray<Reached<EdgeFeature>>,
		/**
		 * Its steered cap, the steered cases its witnesses need: its floor and 3 steered cases reach every limit's edge, 2 do
		 * not (measured at TEST_SEED=1 on grizzle 01506d52; the witnesses are fixed by the property's identity).
		 */
		budget: { runs: 13, steered: 3 },
		show: showGrowth,
		check:
			({ tx }, k: Case<EdgeFeature>) =>
			(growth) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					const first = measureAt(growth, 1)
					if (first.kind === "refused") {
						k.note("a shape refused at its first count")
						return
					}
					const { greatest, pattern, past } = edgeAt(growth, first.pattern)
					k.note(past)
					const are = toAre(pattern.ir)
					yield* compileWithin(db, are)
					const rows = yield* db.values(
						"SELECT ($1::text COLLATE pg_catalog.pg_c_utf8 ~ $2::text)::text",
						["abcd", are]
					)
					assert.equal(
						truth(rows[0]?.[0]),
						Matcher.of(pattern.nfa).matches("abcd"),
						Str.slice(0, 160)(growth.at(greatest))
					)
				}),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL 19's regex compiler and ~, on the largest pattern the limits admit"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/pattern-space.ts",
				original: "\tfor (let s = 0; s < arcs.length && copies <= cap; s++) {",
				replacement: "\tfor (let s = 0; copies <= cap; s++) {",
				why: "Operator mutant (conjunct) at packages/engine/src/ir/pattern-space.ts:461 in emptyCopies: `s < arcs.length && copies <= cap` becomes `copies <= cap`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Regex membership: PostgreSQL compiles generated admitted nested-quantifier patterns. Its runs are nestedRuns
 * (differential.fixtures.ts, with their evidence); its kept cases are the counterexamples of the compile-space mutants
 * its witnesses do not reach, each the shrunk failure of its mutant, which run first on every seed whatever the budget;
 * the mutants are its kills.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/text/differential.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/text/differential.test.ts` at its budget
 *   before, `{ runs: nestedRuns, steered: nestedRuns }`, each kill's verdict printed with where its witnesses went red
 *   (judgedLine with the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log;
 *   this budget run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its 3 kills went red on its kept case, its kept case and case 265 of its floor stream, in the order it
 *   declares them
 * @decision the least runs whose floor stream, a quarter of them rounded up, holds its first 266 cases: 1061; no
 *   headroom: a kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const regexMembershipCompilesGeneratedAdmittedNestedQuantifierPatterns = property.explore(
	nestedPattern,
	{
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: ["a large pattern"] satisfies ReadonlyArray<Reached<NestedFeature>>,
		budget: { runs: 1061, steered: nestedRuns },
		check:
			({ tx }, k: Case<NestedFeature>) =>
			(source) =>
				Effect.gen(function* () {
					const r = refine(source, "u", SourceLoc("str.regex", []))
					if (r === "bound") {
						k.note("a pattern past PostgreSQL's limits")
						return
					}
					if (r === "empty" || RegexIr.expandedSize(r.members[0].ir) < 64) {
						return
					}
					k.note("a large pattern")
					const { session: db } = yield* tx
					const exit = yield* Effect.exit(compileWithin(db, r.members[0].are))
					assert.equal(
						Exit.isSuccess(exit),
						true,
						`/${source}/u as ${r.members[0].are}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`
					)
				}),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL 19's regex compiler, which compiles every admitted pattern"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/text/differential.test.ts#regexMembershipCompilesGeneratedAdmittedNestedQuantifierPatterns:-:1.1.1.1.1.1.1.1.4.0.0.0.0.1.6.0"
				),
				reason:
					"(?:(?:(?:a?){16})?){100}b, which PostgreSQL refuses as too complex: the compile space admits it when emptyCopies counts no copy of an empty arc a kept state reaches (space.ts:474, CATCH mutant of grizzle 0baff5d6), which no witness of the search reaches; the shrunk failure of that mutant on the rotating stream's case 277 at TEST_SEED=1",
				since: "2026-11-17"
			},
			{
				token: ReplayToken(
					"test/pg/text/differential.test.ts#regexMembershipCompilesGeneratedAdmittedNestedQuantifierPatterns:-:1.3.0.a.1.5.1.1.0.3.0.0.0.0.0.0.0.3.1.0"
				),
				reason:
					"(?:(?:$|a|)){50}(?:(?:^)?)?(?:a){2,}b, which PostgreSQL refuses as too complex: the compile space admits it when rawNfa leaves an unbounded piece's second copy out of its NFA (space.ts piece.min > 2, CATCH mutant fb4323a1e8), which no witness of the search reaches (the old search's kept (?:(?:a)?){2,}(?:(?:.{1,50}|^)){255}b, which the space cannot be shown to draw); the shrunk failure of that mutant on the rotating stream's case 975 at TEST_SEED=1",
				since: "2026-11-17"
			}
		],
		kills: [
			{
				file: "packages/engine/src/ir/pattern-space.ts",
				original: "\t\t\t\tcopies += entry(kept, arc.to) === 1 ? weight : 0",
				replacement: "\t\t\t\t{}",
				why: "Operator mutant (statement) at packages/engine/src/ir/pattern-space.ts:474 in emptyCopies: `copies += entry(kept, arc.to) === 1 ? weight : 0` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
			},
			{
				file: "packages/engine/src/ir/pattern-space.ts",
				original: "\t\t\t\t\tif (piece.min > 1) {",
				replacement: "\t\t\t\t\tif (piece.min > 2) {",
				why: "An unbounded piece of minimum two whose second copy rawNfa leaves out of its NFA (CATCH mutant fb4323a1e8, grizzle 0baff5d6), so the compile space admits a pattern PostgreSQL refuses as too complex: the old search's kept (?:(?:a)?){2,}(?:(?:.{1,50}|^)){255}b."
			},
			{
				file: "packages/engine/src/ir/pattern-space.ts",
				original:
					'\t\t\t\t\tarc.anchor === "start" ? entry(forward, from) === 1 : entry(backward, arc.to) === 1',
				replacement:
					'\t\t\t\t\tarc.anchor === "start" ? entry(forward, from) === 0 : entry(backward, arc.to) === 1',
				why: "A start anchor a path reaches past a consumed character, which PostgreSQL must move, counted as staying by movingAnchors (CATCH mutant 0cb12aaa70, grizzle 0baff5d6), so the compile space admits a pattern past the moving anchors PostgreSQL holds: the old search's kept (?:(?:(?:.{1,50}|^)){0,200})*b."
			}
		]
	}
)
