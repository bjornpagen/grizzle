/**
 * The query facade's type cost by dimension (query/budget/scaling.ts): rules with attachments, ChangeSet members of
 * each kind, an insertAll over every relation, contexts, and relations with their rules and members, each program
 * checked alone at three sizes an equal step apart, each step a whole number of its generator's periods.
 *
 * Properties: every program typechecks with no diagnostic; each step adds types and instantiations; and its
 * instantiations grow no faster than linearly, exactly (test/support/growth.ts incrementsDoNotGrow): the second step adds
 * no more than the first, so no unit costs more for the units before it. Its types, which the checker interns, are not
 * judged by the law (test/types/batch/measured.ts). Oracle: the compiler's own counts, compared step against step.
 *
 * Plants (~/.cache/grizzle-release/QUERYBUDGET/plants): attach-schema-method.patch types an attachment's method over the
 * whole schema rather than its own source; once-over-program.patch gives each member's calls a once over the whole
 * program; phantom-params-exclude.patch reads a bundle's parameters through an Exclude over its phantom's union; and
 * workload-kinds-tuple.patch checks a member by its workload's kinds rather than its own. (~/.cache/grizzle-release/
 * TYPEREGRESS/plants) heldby-deferred-tuple.patch reads a relation's declared keys through a tuple the checker defers.
 * Each turns relations with their rules and members superlinear in instantiations, by second differences of 11,200,
 * 16,000, 1,600, 3,200 and 640 at 46356a00, where the tree's is 0 (~/.cache/grizzle-release/GREENTRUNK/out/
 * plant-scales.txt, from GREENTRUNK/tools/plant-scales.sh).
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
			)} ${dimension.name} with no diagnostic, its instantiations growing no faster than linearly`,
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
