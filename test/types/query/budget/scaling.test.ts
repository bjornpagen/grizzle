/**
 * The query facade's type cost by dimension (query/budget/scaling.ts): rules with attachments, ChangeSet members of
 * each kind, an insertAll over every relation, contexts, and relations with their rules and members, each program
 * checked alone at three sizes an equal step apart, each step a whole number of its generator's periods.
 *
 * Properties: every program typechecks with no diagnostic; and its types and instantiations grow no faster than
 * linearly, exactly (test/support/growth.ts incrementsDoNotGrow): the second step adds no more than the first, so no
 * unit costs more for the units before it. Oracle: the compiler's own counts, compared step against step.
 *
 * Plants (~/.cache/grizzle-release/BR14/plants): query-scale-quadratic.patch finds a match's relation among its
 * schema's by mapping over every relation of the schema for each relation matched, a cost per rule that grows with the
 * relations. (~/.cache/grizzle-release/TYPECOST/plants): match-schema-union.patch holds a matched relation against the
 * union of every relation of its schema, which the source's intersection distributes over; arrays-relation-held.patch
 * holds a ChangeSet's array member by its relation rather than its name, and arrays-member-deferred.patch builds the
 * member as a type reference the checker defers, each of which every later call of the chain instantiates again.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { assertClean, assertGrowthLaw, measuredSizes } from "#test/types/batch/measured.ts"
import { queryDimensions, queryScaleSource } from "#test/types/query/budget/scaling.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the query-scale programs", (it) => {
	for (const dimension of queryDimensions) {
		it.effect(
			`typechecks ${Arr.join(
				Arr.map(dimension.steps.sizes, (n) => `${n}`),
				", "
			)} ${dimension.name} with no diagnostic, its types and instantiations growing no faster than linearly`,
			() =>
				Effect.gen(function* () {
					const sizes = yield* measuredSizes("test/types/query", dimension.steps, (size, entries) =>
						queryScaleSource(dimension.shape(size), entries)
					)
					for (const s of sizes) {
						assertClean(s, dimension.name)
					}
					assertGrowthLaw(dimension.name, dimension.steps, sizes)
				})
		)
	}
})
