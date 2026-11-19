import { assert } from "@bjornpagen/testing/assert"
/**
 * The type oracle (test/support/oracle/verify/types.ts) judges each part of a statement of tagged parts as lowered,
 * before its executable form casts its columns to texts, and not only through the rows the differential compares: over
 * the optimizer's population (gen/case.ts optimizerGenConfig), every optimized program's parts pass as lowered, and an
 * attachment's part whose outermost core's first output column is planted another type is reported at that part, and
 * only there. The plant casts the column through text to PostgreSQL's `name`, which no heading claims and which spells
 * a short value as its text does, so the differential's text comparison would not tell the part from the one lowered.
 *
 * Oracle: the type oracle (test/support/oracle/verify/types.ts) over each part as lowered.
 *
 * Features: an attachment's part planted, and each part passed.
 */
import type { Reached } from "@bjornpagen/testing/features"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { typedPlants } from "#test/pg/oracle/optimized/support.ts"
import { type PlantFeature, plantsOf } from "#test/pg/oracle/optimized/type-plant.fixtures.ts"
import { optimizerGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { namedPlacement, oracleProperty, PropertyFailed } from "#test/support/oracle/runner.ts"

/** Every part as lowered passes the type oracle, and an attachment's part planted another column type is reported there alone. */
export const typePlant = oracleProperty(queryCaseGen(optimizerGenConfig), {
	situations: ["a part planted"] satisfies ReadonlyArray<Reached<PlantFeature>>,
	perturb: "none",
	oracle: {
		kind: "specification",
		name: "the type oracle (test/support/oracle/verify/types.ts) over each part as lowered"
	},
	kept: [],
	/** Its pre-conversion budget: runs 150, coverage cases 150 (type-plant.test.ts `cases` at 4fbc3e95). */
	budget: { runs: 150, steered: 150 },
	kills: [
		{
			file: "packages/engine/src/ir/decimal.ts",
			original: '\t\tif (text[i] === ".") {\n\t\t\ti++\n\t\t\tfracStart = i',
			replacement: '\t\tif (text[i] === ".") {\n\t\t\t{}\n\t\t\tfracStart = i',
			why: "Operator mutant (statement) at packages/engine/src/ir/decimal.ts:80 in <module>: `i++` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
		}
	],
	show: Formatter.format,
	check: (k: Case<PlantFeature>) => (queryCase) =>
		Effect.gen(function* () {
			const placement = yield* namedPlacement("typeplant")
			const typed = yield* typedPlants(queryCase, { placement }, plantsOf).pipe(
				Effect.mapError(
					(e) => new PropertyFailed({ report: `${e.stage} failed on ${e.side}: ${e.message}` })
				)
			)
			assert.deepEqual(typed.clean, [], "every part as lowered is of its heading's types")
			for (const plant of typed.planted) {
				assert.ok(plant.problems.length > 0, `${plant.where}: the planted column reported`)
				assert.deepEqual(
					Arr.filter(plant.problems, (line) => !Str.startsWith(`${plant.where} column `)(line)),
					[],
					`${plant.where}: every problem at the planted part`
				)
			}
			k.note(typed.planted.length > 0 ? "a part planted" : "no attachment's part to plant")
		})
})
