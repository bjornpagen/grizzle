/**
 * A contract's values are Effect Schema's brand of its name (test/types/api/contract-brand.ts): over every kind of base
 * a contract is over, `Infer<typeof contract(name, base)>` and the type of `Schema.brand(name)` over a schema of the
 * base's host type are one type, each written where the other stands, and the contract's mint returns it, so a value
 * flows between grizzle and Effect Schema code with no cast. Each base is a cell of the box; a batch's cells are one
 * program, checked armed. Oracle: Effect Schema's brand, a second implementation of the branded type.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { contractBrandBox } from "#test/types/api/contract-brand.dictionary.ts"
import { contractBrandProgram } from "#test/types/api/contract-brand.ts"
import { boxAgreement } from "#test/types/batch/agreement.ts"

/** A contract's value type is its base's host type and Effect's Brand.Brand of its name, as Schema.brand types it. */
export const contractBrand = boxAgreement(finite(word(contractBrandBox)), {
	box: "every kind of base a contract is over: each pg type, numeric at scale 0 and at another, uuid, natural, date, a pattern of infinite language, of finite language and of a fixed prefix, a pattern held to its bytes, two patterns intersected, a closed id of an ordered roster, of an unordered one and of a subset, a span, a vector, another contract, and a contract that checks and proves",
	situations: [],
	notes: () => [],
	checking: "armed",
	program: contractBrandProgram,
	oracle: {
		kind: "second-implementation",
		name: "Effect Schema's brand of the contract's name over a schema of its base's host type"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/fields/field.ts",
			original: '> extends Field<\n\tInfer<B> & Brand.Brand<Name>,\n\tB["sql"],',
			replacement:
				'> extends Field<\n\tInfer<B> & { readonly "~grizzle/Brand": { readonly [K in Name]: Name } },\n\tB["sql"],',
			why: "A contract's values are branded with a brand of grizzle's own, its base's host type and a member of grizzle's key, where Effect's Brand.Brand of the contract's name stood: Schema.brand's type is no longer the contract's, so neither is written where the other stands and the program fails at every cell."
		}
	]
})
