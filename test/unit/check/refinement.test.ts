/**
 * Refinements (check/refinement): which types guarantee which, what a union's column takes from its arms, and which
 * closed constants PostgreSQL must validate.
 *
 * - **Guarantees:** over every ordered pair of the named types, `guarantees(a, b)` holds exactly when the two are
 *   one carrier and one identity: a contract guarantees only itself, a numeric only its own typmod, and text the
 *   wildcard or its own language, two spellings of one language being one.
 * - **Union propagation:** over every ordered pair of deliverers, a union's column is the meet of its arms' types: one
 *   type, the type itself; two languages, the wildcard; two typmods, numeric of no typmod whose bound holds both;
 *   anything else refused as MalformedDescription; and each arm guarantees the common type.
 * - **Refined constants:** over drawn closed relations, refinedConstants lists exactly the payload cells of a type
 *   whose domain carries a CHECK, each at its field's type and at its site, the relation, the field and its row's key
 *   (RefinedSite), in row then heading order, as it documents.
 *
 * Oracles: each type's token (its carrier, identity, typmod and language), from which the guarantees rule and the meet
 * are restated; which payload kinds carry a CHECK.
 *
 * Features: one language, two languages, the wildcard, a contract, one or two typmods and another carrier; each union
 * shape; a refined cell, an unrefined one and no row.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { guarantees, refinedConstants, refinement } from "#compiler/check/refinement/index.ts"
import {
	contractOf,
	numericBoundOf,
	numericTypmodOf,
	sameScalarType,
	textOf
} from "#compiler/ir/scalar.ts"
import { sameRegex } from "#compiler/scalar/compute/types.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import { queryDesc } from "#test/unit/check/dsl.ts"
import {
	armOf,
	closedCaseGen,
	closedSchema,
	columnType,
	type ConstantFeature,
	deliverers,
	featureOf,
	guaranteed,
	isWildcard,
	judged,
	type LatticeFeature,
	latticeFeature,
	meet,
	schemaChecked,
	type UnionFeature
} from "#test/unit/check/refinement.fixtures.ts"

/** Languages and guarantees guarantee exactly one carrier's one identity: a contract itself, one typmod, the wildcard or one language. */
export const languagesAndGuaranteesGuaranteeExactlyOneCarriersOneIdentityAContractItselfOneTypmodTheWildcardOrOneLanguage =
	property.exhaust(
		finite((source) => [source.draw(element(judged)), source.draw(element(judged))] as const),
		{
			needs: {},
			situations: [
				"one language",
				"two languages",
				"the wildcard",
				"a contract",
				"one typmod",
				"two typmods",
				"another carrier"
			] satisfies ReadonlyArray<Reached<LatticeFeature>>,
			check:
				(_, c: Case<LatticeFeature>) =>
				([a, b]) =>
					Effect.sync(() => {
						c.note(latticeFeature(a.token, b.token))
						assert.equal(
							guarantees(a.type, b.type),
							guaranteed(a.token, b.token),
							`${a.name} and ${b.name}`
						)
					}),
			oracle: {
				kind: "specification",
				name: "the guarantees rule restated over each type's token: carrier, identity, typmod and language"
			},
			box: "every ordered pair of the deliverers' types, the canonical wildcard and a plain bigint",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/check/refinement/index.ts",
					original:
						'\t\treturn bb.text.regex === "wildcard" || sameRegex(ba.text.regex, bb.text.regex)',
					replacement:
						'\t\treturn (\n\t\t\tba.text.regex === "wildcard" ||\n\t\t\tbb.text.regex === "wildcard" ||\n\t\t\tsameRegex(ba.text.regex, bb.text.regex)\n\t\t)',
					why: "The wildcard guarantees every language (check/refinement guarantees); the guarantees property fails."
				}
			]
		}
	)

/** Union propagation types a union's column as the common guarantees of its arms, which each arm's type guarantees, and refuses incompatible arms. */
export const unionPropagationTypesAUnionsColumnAsTheCommonGuaranteesOfItsArmsWhichEachArmsTypeGuaranteesAndRefusesIncompatibleArms =
	property.exhaust(
		finite(
			(source) => [source.draw(element(deliverers)), source.draw(element(deliverers))] as const
		),
		{
			needs: {},
			situations: [
				"one type",
				"one language spelled twice",
				"two languages",
				"two typmods",
				"incompatible"
			] satisfies ReadonlyArray<Reached<UnionFeature>>,
			check:
				(_, c: Case<UnionFeature>) =>
				([a, b]) =>
					Effect.sync(() => {
						const met = meet(a.token, b.token)
						const why = `${a.name} and ${b.name}`
						c.note(featureOf(a, b, met))
						const result = checkAuthored(
							schemaChecked,
							queryDesc(armOf(a), armOf(b)),
							checkOptions("union propagation")
						)
						if (met === undefined) {
							refused(result, "MalformedDescription", why)
							return
						}
						const delivered = columnType(
							succeeded(result, why).dag.roots[0].heading,
							"value",
							"the union's value"
						)
						const common = refinement.common([a.type, b.type])
						assert.ok(
							guarantees(a.type, common) && guarantees(b.type, common),
							`${why}: each arm guarantees it`
						)
						switch (met.kind) {
							case "language":
								assert.ok(
									delivered.carrier === "text" &&
										sameRegex(delivered.text.regex, textOf(a.type)?.regex),
									`${why}: the one language`
								)
								break
							case "wildcard":
								assert.ok(isWildcard(delivered), `${why}: the wildcard`)
								break
							case "numeric": {
								const typmod = numericTypmodOf(delivered)
								const same = sameScalarType(a.type, b.type)
								assert.deepEqual(
									same
										? [delivered.carrier, typmod?.precision, typmod?.scale]
										: [
												delivered.carrier,
												numericBoundOf(delivered)?.digits,
												numericBoundOf(delivered)?.scale
											],
									same
										? ["numeric", met.digits + met.scale, met.scale]
										: ["numeric", met.digits, met.scale],
									`${why}: the numeric holding both`
								)
								break
							}
							case "contract":
								assert.equal(
									contractOf(delivered)?.name,
									contractOf(a.type)?.name,
									`${why}: the contract ${met.name}`
								)
								break
							case "bigint":
								assert.ok(sameScalarType(delivered, a.type), `${why}: bigint`)
								break
						}
					}),
			oracle: {
				kind: "specification",
				name: "the documented meet of two arms' types, and each arm guaranteeing the common type"
			},
			box: "every ordered pair of the deliverers: the slug and state languages, each spelled twice, the wildcard, three numeric typmods, three contracts and a plain bigint",
			kept: [],
			kills: []
		}
	)

/** Refined constants list exactly the closed payload cells of a type whose domain carries a CHECK, each at its field's type. Its budget is its suite's before it was a property (test/unit/check/refinement.test.ts at 4ca3036a): 100 runs and 100 steered cases. */
export const refinedConstantsListExactlyTheClosedPayloadCellsOfATypeWhoseDomainCarriesACHECKEachAtItsFieldsType =
	property.explore(closedCaseGen, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: ["a refined cell", "an unrefined cell", "no row"] satisfies ReadonlyArray<
			Reached<ConstantFeature>
		>,
		check: (_, k: Case<ConstantFeature>) => (c) =>
			Effect.sync(() => {
				const checked = checking(closedSchema(c))
				const heading = defined(checked.closed.get("Payloads"), "Payloads").heading
				/** Each refined cell by its site, its row's key and its field, in row then heading order. */
				const expected = Arr.flatMap(c.rows, (row) =>
					Arr.flatMap(c.fields, (x, i) => {
						const cell = defined(row.values[i], "a row's value")
						return x.payload.checked
							? [
									{
										literal: cell.literal,
										type: columnType(heading, x.name, x.name),
										site: {
											relation: "Payloads",
											field: x.name,
											key: [{ kind: "handle" as const, handle: row.key }]
										}
									}
								]
							: []
					})
				)
				assert.deepEqual(refinedConstants(checked), expected)
				if (c.rows.length === 0) {
					k.note("no row")
				}
				if (expected.length > 0) {
					k.note("a refined cell")
				}
				if (Arr.some(c.fields, (x) => !x.payload.checked) && c.rows.length > 0) {
					k.note("an unrefined cell")
				}
			}),
		oracle: {
			kind: "specification",
			name: "which payload kinds carry a CHECK: a pattern, a contract's predicate, or its base's"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/refinement/index.ts",
				original: "\t\t\tconst key = row.slice(0, keyed)",
				replacement: "\t\t\tconst key = row.slice(0, keyed + 1)",
				why: "A site's key holds its row's first payload cell (check/refinement refinedConstants); the refined constants property fails."
			},
			{
				file: "packages/engine/src/check/refinement/index.ts",
				original: "\t\treturn contract.predicate !== undefined || hasConstraint(contract.base)",
				replacement: "\t\treturn true",
				why: "A brand-only contract's cells are listed (check/refinement hasConstraint); the refined constants property fails."
			}
		]
	})
