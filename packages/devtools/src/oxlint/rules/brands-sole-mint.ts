import { Array as Arr, Schema } from "effect"
import { configured, isFileAt, type TypeNode } from "#oxlint/rule.ts"
import { hasSoleTypeArgument, isMember, isStringLiteral, typeArgumentsOf } from "#oxlint/syntax.ts"

/** Each brand group, with the modules that alone mint it: its doors. */
const Options = Schema.Struct({
	mints: Schema.Array(
		Schema.Struct({
			doors: Schema.NonEmptyArray(Schema.String),
			brands: Schema.Array(Schema.String)
		})
	)
})

/**
 * A mint of a guarded brand B outside its doors: `Brand.nominal<B>()`, `Schema.brand("B")`, or the engine's
 * `nominal<From, B>()`.
 */
export const brandsSoleMint = configured(Options, (context, options) => {
	const guarded = Arr.filter(
		options.mints,
		(mint) => !Arr.some(mint.doors, (door) => isFileAt(context.filename, door))
	)
	return {
		CallExpression: (node) => {
			for (const mint of guarded) {
				const isBrand = (type: TypeNode): boolean =>
					type.type === "TSTypeReference" &&
					type.typeName.type === "Identifier" &&
					type.typeArguments === null &&
					Arr.contains(mint.brands, type.typeName.name)
				const effectNominal =
					isMember(node.callee, "Brand", "nominal") &&
					node.arguments.length === 0 &&
					hasSoleTypeArgument(node, isBrand)
				const types = typeArgumentsOf(node)
				const [, branded] = types
				const engineNominal =
					node.callee.type === "Identifier" &&
					node.callee.name === "nominal" &&
					node.arguments.length === 0 &&
					types.length === 2 &&
					branded !== undefined &&
					isBrand(branded)
				const schemaBrand =
					isMember(node.callee, "Schema", "brand") &&
					node.arguments.length === 1 &&
					Arr.every(node.arguments, (argument) =>
						isStringLiteral(argument, (value) => Arr.contains(mint.brands, value))
					)
				if (effectNominal || engineNominal || schemaBrand) {
					context.report({
						node,
						message: `A brand is minted only by its door, ${Arr.join(mint.doors, " or ")}.`
					})
				}
			}
		}
	}
})
