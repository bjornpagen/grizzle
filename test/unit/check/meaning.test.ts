import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { resolveCase } from "#test/support/oracle/public/generate.ts"
import { type ReferenceObserver, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import type { DeclineReason } from "#test/support/oracle/reference/values.ts"
import {
	type Feature,
	judged,
	judgedMixed,
	situations,
	sketchSpace
} from "#test/unit/check/meaning.fixtures.ts"

/** The builder and the checker give every generated query read the meaning its program states, by the reference. Its budget is its suite's before it was a property (test/unit/check/meaning.test.ts at 4ca3036a): 400 runs and 400 steered cases. */
export const theBuilderAndTheCheckerGiveEveryGeneratedQueryReadTheMeaningItsProgramStatesByTheReference =
	property.explore(sketchSpace, {
		needs: {},
		budget: { runs: 400, steered: 400 },
		situations: situations satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, k: Case<Feature>) => (sketch) =>
			Effect.sync(() => {
				const c = k.draw(resolveCase(sketch))
				const declined = new Set<DeclineReason>()
				const observer: ReferenceObserver = {
					...unobserved,
					decline: (reason) => {
						k.note(`declined ${reason}`)
						declined.add(reason)
					}
				}
				for (const read of c.reads) {
					if (read.kind === "query") {
						judged(c, read, k.note, observer)
					} else if (read.kind === "mixed") {
						judgedMixed(c, read, k.note, observer)
					}
				}
				for (const reason of declined) {
					k.measure(`declined ${reason}`, 1)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the generated program's own meaning against the reference over the checked IR"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/check/meaning.test.ts#theBuilderAndTheCheckerGiveEveryGeneratedQueryReadTheMeaningItsProgramStatesByTheReference:-:2.0.0.0.0.0.0.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.4.0.0.0.0.970.0.0.970.0.0.0.0.0.2.0.0.pa8.0.pa8.0.0.0.0.0.0.0.0.0.pa8.0.pa8.guu.0.0.0.0.0.0.0.0.0.0.2.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0"
				),
				reason:
					"a comparison over a variable bound to two spellings of one value, in a closure's step: R(k int4, f0 numeric, f1 numeric, h handle) holding (0, 1, 1) and (1, 1.0, 0), matched beside its recursive closure from f1 to f0 where f1 < f0, whose step binds one variable to the state's 1.0 and a fact's 1 and compares it with f0, which the reference once read as a comparison over a declined value",
				since: "2026-11-04"
			}
		],
		kills: [
			{
				file: "packages/engine/src/check/checker.ts",
				original: '\t\t\t\t? { kind: "AntiJoin", left, right, on, heading: left.heading }',
				replacement:
					'\t\t\t\t? { kind: "AntiJoin", left, right, on: on.slice(1), heading: left.heading }',
				why: "A negation's join drops its first equated column (check/checker.ts relational); the property fails."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\t\t\t(term, param, at) => this.#bindValue(term, param, at, left.id)",
				replacement: "\t\t\t\t(term, param, at) => this.#bindValue(term, param, at, this.region)",
				why: "A negated import's bind values read the rule's region rather than the node the negation is over, which a filter stands between; the floor stream fails at a negated import bound to an outer variable beside a filter."
			}
		]
	})
