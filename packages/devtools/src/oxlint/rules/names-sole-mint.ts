import { Array as Arr, Schema } from "effect"
import { configured, isFileAt, type TypeNode } from "#oxlint/rule.ts"
import { hasSoleTypeArgument, isMember, isStringLiteral } from "#oxlint/syntax.ts"

/** Each module that mints name brands, with the brands it alone mints. */
const Options = Schema.Struct({
	mints: Schema.Array(Schema.Struct({ module: Schema.String, brands: Schema.Array(Schema.String) }))
})

/** `Brand.nominal<B>()` and `Schema.brand("B")` for a name brand B, outside the module that mints it. */
export const namesSoleMint = configured(Options, (context, options) => {
	const guarded = Arr.filter(options.mints, (mint) => !isFileAt(context.filename, mint.module))
	return {
		CallExpression: (node) => {
			for (const mint of guarded) {
				const isNameBrand = (type: TypeNode): boolean =>
					type.type === "TSTypeReference" &&
					type.typeName.type === "Identifier" &&
					type.typeArguments === null &&
					Arr.contains(mint.brands, type.typeName.name)
				const nominal =
					isMember(node.callee, "Brand", "nominal") &&
					node.arguments.length === 0 &&
					hasSoleTypeArgument(node, isNameBrand)
				const branded =
					isMember(node.callee, "Schema", "brand") &&
					node.arguments.length === 1 &&
					Arr.every(node.arguments, (argument) =>
						isStringLiteral(argument, (value) => Arr.contains(mint.brands, value))
					)
				if (nominal || branded) {
					context.report({
						node,
						message: `A name brand is minted only by its naming door, ${mint.module}.`
					})
				}
			}
		}
	}
})
