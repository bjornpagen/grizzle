/**
 * A level's contracts and variants are facts of its content, read once where schema(...) or schema.extend(...) builds
 * it (schema/levels.ts SchemaContent contracts and variants): every contract and every variant a relation of the level
 * or of a level below declares a field by, natural's among the contracts, each with the descriptor ownership holds for
 * it (own.ts Owned contracts and variants), a variant's with its arms' checks, so records(...) types a contract column
 * and a variant column by its level's content and owns no level (program/records.ts declarationsOf). Exhausted over a
 * contract and a variant at each place a field holds one: a root relation's field, a base's under an extension that
 * declares none, an extension's, both levels' alike, another contract's base, a span's endpoint and a variant's arm's
 * field.
 *
 * Oracle: ownership's contracts and variants, read off each level's Owned.
 */

import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { declarationsOf, places } from "#test/unit/schema/level-contracts.fixtures.ts"

/** Each level's content holds exactly its ownership's contracts and variants, each by name with the descriptor ownership holds. */
export const aLevelsContentHoldsItsOwnedSchemasContractsAndVariants = property.exhaust(places, {
	box: "a contract and a variant on a root relation's field, a base's under an extension, an extension's, both levels' alike, another contract's base, a span's endpoint or a variant's arm's field",
	needs: {},
	situations: [],
	check: () => (place) =>
		Effect.sync(() => {
			for (const [at, level] of declarationsOf(place).entries()) {
				assert.deepEqual(level.held, level.owned, `${place}: schema ${String(at)}`)
			}
		}),
	oracle: {
		kind: "specification",
		name: "ownership's contracts and variants (own.ts Owned contracts and variants), level by level"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/schema/levels.ts",
			original: "visitDeclaredFields(r.desc, (_field, nested) => {",
			replacement: "visitDeclaredFields(r.desc, (_field, _nested, nested) => {",
			why: "A level collects its fields' own descriptors alone, not the contracts inside them: a contract that is another's base, a span's endpoint or a variant's arm's field is missing from its content."
		},
		{
			file: "packages/engine/src/schema/levels.ts",
			original:
				"const contracts = below?.contracts ?? new Map([[naturalContract.name, naturalContract]])",
			replacement: "const contracts = new Map([[naturalContract.name, naturalContract]])",
			why: "A level holds its own relations' contracts and none of the levels below it: an extension's content is missing its base's contracts."
		},
		{
			file: "packages/engine/src/schema/levels.ts",
			original: "const variants = below?.variants ?? new Map<string, VariantFieldDesc>()",
			replacement: "const variants = new Map<string, VariantFieldDesc>()",
			why: "A level holds its own relations' variants and none of the levels below it: an extension's content is missing its base's Mark, which records of a read over it then refuse as a variant the schema does not declare."
		},
		{
			file: "packages/engine/src/schema/levels.ts",
			original: "\t\t\t\taddFirst(variants, addedVariants, nested)",
			replacement: "\t\t\t\taddFirst(variants, new Map(), nested)",
			why: "A level's content holds no variant at all: every place's Mark and Scored are missing from it, and records of a read of a variant column are refused."
		}
	]
})
