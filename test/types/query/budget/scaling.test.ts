import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { assertClean, assertLinear, measuredSizes } from "#test/types/batch/measured.ts"
import { queryDimensions, queryScaleSource } from "#test/types/query/budget/scaling.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the query-scale programs", (it) => {
	for (const dimension of queryDimensions) {
		it.effect(
			`typechecks ${Arr.join(
				Arr.map(dimension.sizes, (n) => `${n}`),
				", "
			)} ${dimension.name} with no diagnostic, linear in types and instantiations`,
			() =>
				Effect.gen(function* () {
					const sizes = yield* measuredSizes("test/types/query", dimension.sizes, (size, entries) =>
						queryScaleSource(dimension.shape(size), entries)
					)
					for (const s of sizes) {
						assertClean(s, dimension.name)
					}
					assertLinear(dimension.name, sizes)
				})
		)
	}
})
