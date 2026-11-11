/**
 * The schema builders' type cost by dimension (schema/budget/scaling.ts): relations, a full role's entries, a write
 * list's names, a roster's and a set's handles, laws per relation, roles per schema and fields per relation, each
 * program checked alone at three sizes an equal step apart, each step a whole number of its generator's periods.
 *
 * Properties: every program typechecks with no diagnostic; and its types and instantiations grow no faster than
 * linearly, exactly (test/support/growth.ts incrementsDoNotGrow): the second step adds no more than the first, so no
 * unit costs more for the units before it. Oracle: the compiler's own counts, compared step against step.
 *
 * Plants (~/.cache/grizzle-release/BR14/plants): schema-scale-quadratic.patch finds a statement's relations among the
 * schema's by relating each to every relation of the schema, a union against a union, a cost per statement that grows
 * with the relations. (~/.cache/grizzle-release/TYPECOST/plants): key-index-keyof.patch asks whether a relation's name
 * is among the key index's keys, which the checker computes over every key side of the schema at each read of a
 * relation's keys; closure-per-candidate.patch closes each candidate key of a rule's head from its own fields over
 * every dependency of the rule's matches, a closure of its own for each key of the matched relation, each over every
 * key, a cost per key that grows with the relation's laws.
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
			)} ${dimension.name} with no diagnostic, its types and instantiations growing no faster than linearly`,
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
