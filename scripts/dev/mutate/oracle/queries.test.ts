import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Effect, String as Str } from "effect"
import { firstFailure, oracleCases } from "#scripts/dev/mutate/oracle/check.ts"
import {
	agrees,
	baselineIsSet,
	differentialCase,
	plainDifferential,
	printDifferential
} from "#test/pg/oracle/optimized/support.ts"
import { denseQueryCaseGen } from "#test/pg/oracle/support.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import {
	conservative,
	defaultRunOptions,
	printOutcome,
	PropertyFailed,
	reference,
	runOracle
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

layer(Substrate.layer)("mutation stage 2: query oracles", (it) => {
	for (const [label, generator] of [
		["generated", queryCaseGen(defaultGenConfig)],
		["dense", denseQueryCaseGen(defaultGenConfig)]
	] as const) {
		it.effect(
			`the optimized artifact agrees with the conservative lowering on ${label} cases`,
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema({ create: false, label: `mo${Str.slice(0, 1)(label)}` })
						return yield* firstFailure({
							suite: `mutate/queries/${label}/optimized`,
							generator,
							runs: oracleCases,
							property: (c) =>
								Effect.gen(function* () {
									const o = yield* differentialCase(c, {
										...plainDifferential,
										placement: { kind: "named", name: schema }
									})
									if (!baselineIsSet(o) || !agrees(o)) {
										return yield* new PropertyFailed({ report: printDifferential(o) })
									}
								})
						})
					})
				)
		)

		it.effect(
			`the conservative lowering agrees with the reference evaluator on ${label} cases`,
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema({ create: false, label: `mr${Str.slice(0, 1)(label)}` })
						return yield* firstFailure({
							suite: `mutate/queries/${label}/conservative`,
							generator,
							runs: oracleCases,
							property: (c) =>
								Effect.gen(function* () {
									const outcome = yield* runOracle(c, conservative, reference, {
										...defaultRunOptions,
										schema: { kind: "named", name: schema }
									})
									if (!outcome.comparison.equal) {
										return yield* new PropertyFailed({ report: printOutcome(outcome) })
									}
								})
						})
					})
				)
		)
	}
})
