/**
 * Refinements (check/refinement): which types guarantee which, what a union's column takes from its arms, and which
 * closed constants PostgreSQL must validate.
 *
 * - **Guarantees:** over every ordered pair of the named types, `guarantees(a, b)` holds exactly when the two are
 *   one carrier and one identity: a contract guarantees only itself, a numeric only its own typmod, and text the
 *   wildcard or a language holding its own, two spellings of one language being one and a state's draft and published
 *   being slugs, which their automata prove (scalar/regex/inclusion.ts languageIncludes).
 * - **Union propagation:** over every ordered pair of deliverers, a union's column is the meet of its arms' types: one
 *   type, the type itself; two languages, the one holding the other's, else the wildcard; two typmods, numeric of no
 *   typmod whose bound holds both; anything else refused as MalformedDescription; and each arm guarantees the common
 *   type.
 * - **The join of two texts:** over every ordered pair of text deliverers, their union's column type holds both and is
 *   held by every common upper bound grizzle can state of them, either arm's type or the wildcard: the least one.
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

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { guarantees, refinedConstants, refinement } from "#compiler/check/refinement/index.ts"
import { numericBoundOf, numericTypmodOf, sameScalarType, textOf } from "#compiler/ir/scalar.ts"
import { sameRegex, wildcardText } from "#compiler/scalar/compute/types.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import { queryDesc } from "#test/support/unit/check/dsl.ts"
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
	textDeliverers,
	type UnionFeature
} from "#test/unit/check/refinement.fixtures.ts"

/** The pattern table every guarantee reads its automata from, one for the module. */
const patterns = new CompilePatterns()

/** Languages and guarantees guarantee exactly one carrier's one identity: a contract itself, one typmod, the wildcard or a language holding its own. */
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
							guarantees(a.type, b.type, patterns),
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
					original: '\t\tif (bb.text === "wildcard" || sameRegex(ba.text, bb.text)) {\n',
					replacement:
						'\t\tif (ba.text === "wildcard" || bb.text === "wildcard" || sameRegex(ba.text, bb.text)) {\n',
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
				"a language holding the other",
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
						const common = refinement.common([a.type, b.type], patterns)
						assert.ok(
							guarantees(a.type, common, patterns) && guarantees(b.type, common, patterns),
							`${why}: each arm guarantees it`
						)
						switch (met.kind) {
							case "language": {
								const outer =
									a.token.kind === "language" && a.token.language === met.language ? a : b
								assert.ok(
									delivered.carrier === "text" && sameRegex(textOf(delivered), textOf(outer.type)),
									`${why}: the language ${met.language}, which holds both`
								)
								break
							}
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
									delivered.contract?.name,
									a.type.contract?.name,
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
			kills: [
				{
					file: "packages/engine/src/ir/expr.ts",
					original: `if (carrier !== "code") {\n\t\t\t\treturn \`a handle literal is not a \${carrier} value\`\n\t\t\t}\n\t\t\treturn !type.roster.handles.includes(literal.handle)\n\t\t\t\t? \`\${JSON.stringify(literal.handle)} is not a handle of \${type.roster.closed}\`\n\t\t\t\t: type.only !== undefined && !type.only.includes(literal.handle)\n\t\t\t\t\t? \`\${JSON.stringify(literal.handle)} is not a handle of the subset of \${type.roster.closed} its type holds (\${type.only.join(", ")})\`\n\t\t\t\t\t: undefined\n\t\tcase "handles":\n\t\t\tif (carrier !== "bits") {\n\t\t\t\treturn \`a set literal is not a \${carrier} value\`\n\t\t\t}\n\t\t\treturn handlesProblem(literal.handles, type.roster.handles, type.roster.closed)`,
					replacement: `if (carrier !== "bits") {\n\t\t\t\treturn \`a set literal is not a \${carrier} value\`\n\t\t\t}\n\t\t\treturn handlesProblem(literal.handles, type.roster.handles, type.roster.closed)\n\t\tcase "handles":\n\t\t\tif (carrier !== "code") {\n\t\t\t\treturn \`a handle literal is not a \${carrier} value\`\n\t\t\t}\n\t\t\treturn !type.roster.handles.includes(literal.handle)\n\t\t\t\t? \`\${JSON.stringify(literal.handle)} is not a handle of \${type.roster.closed}\`\n\t\t\t\t: type.only !== undefined && !type.only.includes(literal.handle)\n\t\t\t\t\t? \`\${JSON.stringify(literal.handle)} is not a handle of the subset of \${type.roster.closed} its type holds (\${type.only.join(", ")})\`\n\t\t\t\t\t: undefined`,
					why: "Operator mutant 2f364c397a at packages/engine/src/ir/expr.ts in literalProblem: the handle literal's arm and the set literal's arm swapped, each literal judged by the other's carrier; the property fails (the census, lane TESTPOLICY2)."
				}
			]
		}
	)

/**
 * The join of two texts' types is the least type grizzle can state that holds both: it holds each arm's values, and is
 * held by each of the arms' types and the wildcard that holds both.
 */
export const theJoinOfTwoTextsIsTheLeastTypeGrizzleCanStateThatHoldsBoth = property.exhaust(
	finite(
		(source) =>
			[source.draw(element(textDeliverers)), source.draw(element(textDeliverers))] as const
	),
	{
		needs: {},
		situations: [
			"one type",
			"one language spelled twice",
			"a language holding the other",
			"two languages"
		] satisfies ReadonlyArray<Reached<UnionFeature>>,
		check:
			(_, c: Case<UnionFeature>) =>
			([a, b]) =>
				Effect.sync(() => {
					c.note(featureOf(a, b, meet(a.token, b.token)))
					const join = refinement.common([a.type, b.type], patterns)
					const why = `${a.name} and ${b.name}`
					assert.ok(
						guarantees(a.type, join, patterns) && guarantees(b.type, join, patterns),
						`${why}: the join holds both`
					)
					for (const upper of [a.type, b.type, wildcardText]) {
						if (guarantees(a.type, upper, patterns) && guarantees(b.type, upper, patterns)) {
							assert.ok(
								guarantees(join, upper, patterns),
								`${why}: every common upper bound grizzle can state holds the join`
							)
						}
					}
				}),
		oracle: {
			kind: "specification",
			name: "the join holds both arms and is held by every common upper bound among the arms' types and the wildcard"
		},
		box: "every ordered pair of text deliverers: the slugs spelled two ways, the state names, the codes and the wildcard",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/refinement/index.ts",
				original: "\t\t\t: guarantees(x, y, patterns)\n\t\t\t\t? y\n\t\t\t\t: wildcardText\n",
				replacement:
					"\t\t\t: guarantees(x, y, patterns) && false\n\t\t\t\t? y\n\t\t\t\t: wildcardText\n",
				why: "A union of a language and one that holds it joins at the wildcard, not the outer language: the state names and the slugs join at every text, which the slugs, a common upper bound, do not hold."
			},
			{
				file: "packages/engine/src/check/refinement/index.ts",
				original: "\t\t\t: guarantees(x, y, patterns)\n\t\t\t\t? y\n\t\t\t\t: wildcardText\n",
				replacement: "\t\t\t: x\n",
				why: "A union's column keeps its first arm's language: the join of two languages holds the first alone."
			}
		]
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
