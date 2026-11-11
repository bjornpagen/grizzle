import { Array as Arr, Schema } from "effect"
import { configured, isFileAt, type TypeNode } from "#oxlint/rule.ts"
import { hasSoleTypeArgument, isMember, isMemberOf, isStringLiteral } from "#oxlint/syntax.ts"

/** Each brand group, with the modules that alone mint it: its doors. */
const Options = Schema.Struct({
	mints: Schema.Array(
		Schema.Struct({
			doors: Schema.NonEmptyArray(Schema.String),
			brands: Schema.Array(Schema.String)
		})
	)
})

/** Effect's Brand constructors that mint the brand their one type argument names. */
const BRAND_CONSTRUCTORS: ReadonlyArray<string> = ["nominal", "make", "check"]

/** A mint of a guarded brand B outside its doors: `Brand.nominal<B>()`, `Brand.make<B>(…)`, `Brand.check<B>(…)`
 * or `Schema.brand("B")`. */
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
				const brandConstructor =
					isMemberOf(node.callee, "Brand", BRAND_CONSTRUCTORS) && hasSoleTypeArgument(node, isBrand)
				const schemaBrand =
					isMember(node.callee, "Schema", "brand") &&
					node.arguments.length === 1 &&
					Arr.every(node.arguments, (argument) =>
						isStringLiteral(argument, (value) => Arr.contains(mint.brands, value))
					)
				if (brandConstructor || schemaBrand) {
					context.report({
						node,
						message: `A brand is minted only by its door, ${Arr.join(mint.doors, " or ")}.`
					})
				}
			}
		}
	}
})
