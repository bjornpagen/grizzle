import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect } from "effect"
import { assertClean, assertLinear, measuredSizes } from "#test/types/batch/measured.ts"
import { schemaDimensions, schemaScaleSource } from "#test/types/schema/budget/scaling.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the schema-scale programs", (it) => {
	for (const dimension of schemaDimensions) {
		it.effect(
			`typechecks ${Arr.join(
				Arr.map(dimension.sizes, (n) => `${n}`),
				", "
			)} ${dimension.name} with no diagnostic, linear in types and instantiations`,
			() =>
				Effect.gen(function* () {
					const sizes = yield* measuredSizes(
						"test/types/schema",
						dimension.sizes,
						(size, entries) => schemaScaleSource(dimension.shape(size), entries)
					)
					for (const s of sizes) {
						assertClean(s, dimension.name)
					}
					assertLinear(dimension.name, sizes)
				})
		)
	}
})
