import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	aims,
	reachesMovedBeside,
	renamed,
	renameGen,
	type Situation,
	situations,
	written
} from "#test/pg/write/rename/rename.fixtures.ts"
import { plainName } from "#test/pg/write/swarm/spec.ts"
import { assert, defined, unorderedEqual } from "#test/support/assert.ts"
import { relationName } from "#test/support/families/fill.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The family writer under renamed relations writes every case alike as drawn and with its relations renamed: each step compiles, is accepted or is refused alike, and every relation stores the same rows.
 *
 * Its pre-conversion budget: runs 12, coverage cases 40 (test/pg/write/rename/rename.test.ts at d8eed1786).
 */
export const theFamilyWriterUnderRenamedRelationsWritesEveryCaseAlikeAsDrawnAndWithItsRelationsRenamedEachStepCompilesIsAcceptedOrIsRefusedAlikeAndEveryRelationStoresTheSameRows =
	property.explore(aimed(renameGen, aims), {
		needs: { substrate: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ substrate }, c: Case<Situation>) =>
			(rc) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const as = yield* written(rc.drawn, "as drawn")
						const other = renamed(rc.drawn, rc.order)
						const renamedRuns = yield* written(other, "renamed")
						assert.equal(
							renamedRuns.length,
							as.length,
							`the renamed run writes as many steps as the drawn one: ${Formatter.format(rc.order)}`
						)
						for (const [i, run] of as.entries()) {
							const twin = defined(renamedRuns[i], "the renamed run's step")
							assert.equal(
								twin.kind,
								run.kind,
								`step ${String(i)}: ${run.kind} as drawn, ${twin.kind} renamed by ${Formatter.format(rc.order)}`
							)
							if (run.kind === "uncompiled" || run.kind === "refused") {
								continue
							}
							if (twin.kind === "uncompiled" || twin.kind === "refused") {
								return
							}
							/** Each relation's name as drawn and as renamed: a family relation's by its new place, a plain
							 * relation's its own. */
							const pairs = [
								...Arr.map(rc.drawn.spec.fill.relations, (_, r): readonly [string, string] => [
									relationName(r),
									relationName(defined(rc.order[r], "a place"))
								]),
								...Arr.map(rc.drawn.spec.plains, (_, j): readonly [string, string] => [
									plainName(j),
									plainName(j)
								])
							]
							for (const [name, at] of pairs) {
								unorderedEqual(
									defined(twin.stored.get(at), `the renamed run's ${at}`),
									defined(run.stored.get(name), `the drawn run's ${name}`),
									`step ${String(i)}: ${name}'s rows as drawn are ${at}'s renamed`
								)
							}
						}
						if (
							as.length > 0 &&
							Arr.every(as, (r) => r.kind !== "uncompiled" && r.kind !== "refused")
						) {
							c.note("a case written alike step by step")
						}
						if (Arr.some(as, (r) => r.kind === "refused")) {
							c.note("a refusal alike")
						}
						if (reachesMovedBeside(rc)) {
							c.note("a moved member and its own member's insert, renamed to sort the other way")
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "a relation's name is no part of what a write does: the same case with its relations renamed by a permutation of their names"
		},
		budget: { runs: 12, steered: 40 },
		kept: [],
		kills: []
	})
