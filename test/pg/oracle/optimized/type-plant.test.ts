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
 * Plants: oracle-compare-types-ignored (a column type that differs between two sides is no difference).
 *
 * Features: an attachment's part planted, and each part passed.
 */
import { layer } from "@effect/vitest"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { flight } from "#compiler/lower/conservative/types.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { builtinType, cast, types } from "#compiler/sql/build.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { optimizedShrink, resolved } from "#test/pg/oracle/optimized/suite.ts"
import { type TypePlant, typedPlants } from "#test/pg/oracle/optimized/support.ts"
import { assert } from "#test/support/assert.ts"
import { optimizerGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { namedPlacement, oracleCheck, PropertyFailed } from "#test/support/oracle/runner.ts"
import { programJudged } from "#test/support/oracle/verify/types.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const cases = 150

type PlantFeature = "a part planted" | "no attachment's part to plant"

/** The type the plant casts to: a pg_catalog type no delivered column is claimed as. */
const planted = builtinType("name")

/**
 * Each plant of a program: for each attachment's part of a statement of tagged parts whose query as lowered ends in a
 * core, which has a target, that query with its first output column cast through text to `planted`, beside every other
 * part as lowered.
 */
const plantsOf = (program: OptimizedProgram): ReadonlyArray<TypePlant> => {
	const parts = program.parts
	if (parts.kind !== "tagged") {
		return []
	}
	const judged = programJudged(program, "optimized statement")
	const relations = flight(program.roots)
	return Arr.flatMap(parts.parts, (part, tag): ReadonlyArray<TypePlant> => {
		const body = part.delivered.body
		if (
			body.kind !== "core" ||
			!Arr.some(relations, (r) => r.answer === tag && r.role.kind === "attachment")
		) {
			return []
		}
		const [first, ...rest] = body.targets
		const text = printStatement({
			...part.delivered,
			body: {
				...body,
				targets: [{ ...first, expr: cast(cast(first.expr, types.text), planted) }, ...rest]
			}
		})
		const where = `optimized statement part ${tag}`
		return [
			{
				where,
				judged: Arr.map(judged, (j) =>
					j.where === where ? { ...j, statement: { ...j.statement, sql: { text } } } : j
				)
			}
		]
	})
}

layer(Substrate.layer)("the type oracle over a statement's tagged parts", (it) => {
	it.effect(
		"passes every part as lowered, and reports an attachment's part planted another column type there alone",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const placement = yield* namedPlacement("typeplant")
					return yield* oracleCheck(
						resolved(queryCaseGen(optimizerGenConfig)),
						{
							suite: "optimized/type-plant",
							oracle: {
								kind: "specification",
								name: "the type oracle (test/support/oracle/verify/types.ts) over each part as lowered"
							},
							literal: Formatter.format,
							coverage: required<PlantFeature>(["a part planted"], { cases, sense: notesOnly }),
							kept: [],
							runs: cases,
							shrink: optimizedShrink,
							perturb: "none"
						},
						(population, k) =>
							Effect.gen(function* () {
								const typed = yield* typedPlants(k.draw(population), { placement }, plantsOf).pipe(
									Effect.mapError(
										(e) =>
											new PropertyFailed({ report: `${e.stage} failed on ${e.side}: ${e.message}` })
									)
								)
								assert.deepEqual(typed.clean, [], "every part as lowered is of its heading's types")
								for (const plant of typed.planted) {
									assert.ok(
										plant.problems.length > 0,
										`${plant.where}: the planted column reported`
									)
									assert.deepEqual(
										Arr.filter(
											plant.problems,
											(line) => !Str.startsWith(`${plant.where} column `)(line)
										),
										[],
										`${plant.where}: every problem at the planted part`
									)
								}
								k.note(
									typed.planted.length > 0 ? "a part planted" : "no attachment's part to plant"
								)
							})
					)
				})
			)
	)
})
