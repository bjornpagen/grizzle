/**
 * The kernel's verification of a lowering (test/support/oracle/verify): every required set boundary discharged, no
 * sensitive consumer seeing unproved multiplicity, every certificate the one its rewrite's proof gives, and codecs and
 * result channels aligned. That the plans and programs the compiler builds pass is dedup/soundness's over generated
 * cases, and every compiled template's (test/support/compile.ts checkedLowering). Here each rule is held to its break,
 * as planted faults: a population of plans and programs, the oracle generator's query cases and its rooted
 * counterexample cases for what it seldom builds at a root (folds over projections, unions told apart by their tags and
 * not, bounds under an existence, closures), each broken at one drawn site of one drawn break, picked by kind first and
 * aimed at a break no case has reached yet, is reported under the break's rule (exactly that rule where the break
 * touches nothing else), and passes unbroken. That a fused attachment decodes as its pipelined statement does is the
 * optimized differential's, which requires one and holds both artifacts to the rows PostgreSQL delivers
 * (test/pg/oracle/optimized/variants.test.ts).
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { placeDeduplication } from "#compiler/lower/optimize/dedup/place.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { artifactProblems, channelProblems } from "#test/support/oracle/verify/channels.ts"
import { verifyMultiplicity } from "#test/support/oracle/verify/multiplicity.ts"
import { pickFrom } from "#test/support/pick.ts"
import {
	aimedOptions,
	type ArtifactBreak,
	artifactBreakNames,
	artifactBreaks,
	brokenSpace,
	type ChannelBreak,
	channelBreakNames,
	channelBreaks,
	planBreakNames,
	planBreaks,
	type PlanFeature,
	planFeatures,
	planSubjectGen,
	programSubjectGen,
	reported,
	rulesOf
} from "#test/unit/lower/dedup/verify.fixtures.ts"

/** Structural obligation verification reports each break of a placed plan under its rule, and passes the plan unbroken. */
export const structuralObligationVerificationReportsEachBreakOfAPlacedPlanUnderItsRuleAndPassesThePlanUnbroken =
	property.explore(brokenSpace(planSubjectGen, planFeatures), {
		needs: {},
		situations: planFeatures satisfies ReadonlyArray<Reached<PlanFeature>>,
		check:
			(_, c: Case<PlanFeature>) =>
			([subject, kindPick, sitePick, aims]) =>
				Effect.sync(() => {
					const env = {
						context: "snapshot" as const,
						catalog: subject.catalog,
						roots: "result" as const
					}
					const placed = succeeded(placeDeduplication(subject.dag, env))
					assert.deepEqual(
						succeeded(verifyMultiplicity(subject.dag, placed, env)).problems,
						[],
						`the placed plan of ${subject.label}`
					)
					const applicable = nonEmpty(
						Arr.filter(planBreakNames, (b) => planBreaks[b].sites(placed, subject.dag).length > 0),
						"a break that applies: a realization can always be dropped"
					)
					/** A case aimed at a union's certificate drops it where the plan holds one. */
					const unions = Arr.filter(
						planBreaks["a certificate dropped"].sites(placed, subject.dag),
						(s) => s.union
					)
					const aimedAtUnion =
						Arr.isReadonlyArrayNonEmpty(unions) &&
						Arr.contains(aims, "a union's certificate dropped")
					const name = aimedAtUnion
						? "a certificate dropped"
						: pickFrom(aimedOptions(aims, applicable), kindPick)
					const chosen = pickFrom(
						Arr.isReadonlyArrayNonEmpty(unions) && aimedAtUnion
							? unions
							: nonEmpty(planBreaks[name].sites(placed, subject.dag), "a site"),
						sitePick
					)
					const found = succeeded(
						verifyMultiplicity(subject.dag, chosen.plan, {
							context: chosen.context,
							catalog: subject.catalog,
							roots: "result"
						})
					).problems
					reported(found, planBreaks[name].expect, `${name} in ${subject.label}`)
					c.note(name)
					if (chosen.union) {
						c.note("a union's certificate dropped")
					}
				}),
		oracle: {
			kind: "specification",
			name: "each planted break's rule, and no problem in the plan the placement builds"
		},
		kept: [],
		kills: []
	})

/** Codec and result-channel alignment reports each break of a lowered program's statements under its rule, and passes the program unbroken. */
export const codecAndResultChannelAlignmentReportsEachBreakOfALoweredProgramsStatementsUnderItsRuleAndPassesTheProgramUnbroken =
	property.explore(brokenSpace(programSubjectGen, channelBreakNames), {
		needs: {},
		situations: channelBreakNames satisfies ReadonlyArray<Reached<ChannelBreak>>,
		check:
			(_, c: Case<ChannelBreak>) =>
			([subject, kindPick, sitePick, aims]) =>
				Effect.sync(() => {
					assert.deepEqual(channelProblems(subject.program, "statement"), [], subject.label)
					const applicable = nonEmpty(
						Arr.filter(
							channelBreakNames,
							(b) => channelBreaks[b].sites(subject.program).length > 0
						),
						"a break that applies: a text can always be edited"
					)
					const name = pickFrom(aimedOptions(aims, applicable), kindPick)
					const broken = pickFrom(
						nonEmpty(channelBreaks[name].sites(subject.program), "a site"),
						sitePick
					)
					reported(
						channelProblems(broken, "statement"),
						channelBreaks[name].expect,
						`${name} in ${subject.label}`
					)
					c.note(name)
				}),
		oracle: {
			kind: "specification",
			name: "each planted break's rule, and no problem in the program the conservative lowering builds"
		},
		kept: [],
		kills: []
	})

/** Codec and result-channel alignment reports each artifact that delivers other rows channels than its twin, in both directions. */
export const codecAndResultChannelAlignmentReportsEachArtifactThatDeliversOtherRowsChannelsThanItsTwinInBothDirections =
	property.explore(brokenSpace(programSubjectGen, artifactBreakNames), {
		needs: {},
		situations: artifactBreakNames satisfies ReadonlyArray<Reached<ArtifactBreak>>,
		check:
			(_, c: Case<ArtifactBreak>) =>
			([subject, kindPick, sitePick, aims]) =>
				Effect.sync(() => {
					assert.deepEqual(artifactProblems(subject.program, subject.program), [], subject.label)
					const applicable = Arr.filter(
						artifactBreakNames,
						(b) => artifactBreaks[b](subject.program).length > 0
					)
					if (!Arr.isReadonlyArrayNonEmpty(applicable)) {
						return
					}
					const name = pickFrom(aimedOptions(aims, applicable), kindPick)
					const broken = pickFrom(
						nonEmpty(artifactBreaks[name](subject.program), "a site"),
						sitePick
					)
					assert.deepEqual(rulesOf(artifactProblems(broken, subject.program)), ["artifacts"], name)
					assert.deepEqual(rulesOf(artifactProblems(subject.program, broken)), ["artifacts"], name)
					c.note(name)
				}),
		oracle: {
			kind: "specification",
			name: "each planted break is the artifacts rule both ways, and a program is its own twin"
		},
		kept: [],
		kills: []
	})
