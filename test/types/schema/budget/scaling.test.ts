/**
 * The schema builders' type cost by dimension (schema/budget/scaling.ts): relations, a full role's entries, a write
 * list's names, a roster's and a set's handles, laws per relation, roles per schema and fields per relation, each
 * program checked alone at three sizes an equal step apart, each step a whole number of its generator's periods.
 *
 * Properties: every program typechecks with no diagnostic; each step adds types and instantiations; and its
 * instantiations grow no faster than linearly, exactly (test/support/growth.ts incrementsDoNotGrow; its types, which the
 * checker interns, are not judged by the law: test/types/batch/measured.ts): the second step adds no more than the first, so no
 * unit costs more for the units before it. Oracle: the compiler's own counts, compared step against step.
 *
 * Plants (~/.cache/grizzle-release/GREENTRUNK/plants): key-index-keyof.patch asks whether a relation's name is among the
 * key index's keys (HoldersOf's `N extends keyof I`), which the checker computes over every key side of the schema at
 * each read of a relation's keys; closure-per-candidate.patch closes each candidate key of a rule's head from its own
 * fields over every dependency of the rule's matches, a closure of its own for each key of the matched relation, each
 * over every key. Each turns laws per relation superlinear in instantiations, by second differences of 19,200 and 184 at
 * b3f355ef, whose unplanted run passes. schema-scale-quadratic.patch finds a statement's relations among the schema's by
 * relating each to every relation of the schema (Undeclared's SameAs over the record's every relation, not the one
 * under its name), a cost per statement that grows with the relations: the schema(...) call raises TS2589 from 668
 * relations, 760 full-role entries and 420 write-list names, so the programs fail before the law reads their counts.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { assertClean, assertGrowthLaw, measuredSizes } from "#test/types/batch/measured.ts"
import { schemaDimensions, schemaScaleSource } from "#test/types/schema/budget/scaling.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the schema-scale programs", (it) => {
	for (const dimension of schemaDimensions) {
		it.effect(
			`typechecks ${Arr.join(
				Arr.map(dimension.steps.sizes, (n) => `${n}`),
				", "
			)} ${dimension.name} with no diagnostic, its instantiations growing no faster than linearly`,
			() =>
				Effect.gen(function* () {
					const sizes = yield* measuredSizes(
						"test/types/schema",
						dimension.steps,
						(size, entries) => schemaScaleSource(dimension.shape(size), entries)
					)
					for (const s of sizes) {
						assertClean(s, dimension.name)
					}
					assertGrowthLaw(dimension.name, dimension.steps, sizes)
				})
		)
	}
})
