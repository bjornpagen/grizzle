import { Array as Arr, Option, Schema, String as Str } from "effect"
import { configured, isFileAt } from "#oxlint/rule.ts"

/** The modules that present a bearer credential: each provider's adapter. */
const Options = Schema.Struct({ owners: Schema.Array(Schema.String) })

const isBearerText = (text: string): boolean => Str.startsWith("bearer ")(Str.toLowerCase(text))

const MESSAGE =
	"A bearer credential is presented only by its provider's adapter (this rule's owners list); call that adapter's typed operation."

/**
 * A bearer credential built outside its provider's adapter: a template or a concatenation that starts with
 * `Bearer `, or a `bearerToken(...)` request call.
 */
export const bearerOwners = configured(Options, (context, options) => {
	if (Arr.some(options.owners, (owner) => isFileAt(context.filename, owner))) {
		return {}
	}
	return {
		TemplateLiteral: (node) => {
			const head = Arr.head(node.quasis)
			if (
				Arr.isReadonlyArrayNonEmpty(node.expressions) &&
				Option.exists(head, (quasi) => isBearerText(quasi.value.cooked ?? quasi.value.raw))
			) {
				context.report({ node, message: MESSAGE })
			}
		},
		BinaryExpression: (node) => {
			if (
				node.operator === "+" &&
				node.left.type === "Literal" &&
				typeof node.left.value === "string" &&
				isBearerText(node.left.value)
			) {
				context.report({ node, message: MESSAGE })
			}
		},
		CallExpression: (node) => {
			const callee = node.callee
			const named =
				(callee.type === "Identifier" && callee.name === "bearerToken") ||
				(callee.type === "MemberExpression" &&
					!callee.computed &&
					callee.property.type === "Identifier" &&
					callee.property.name === "bearerToken")
			if (named) {
				context.report({ node, message: MESSAGE })
			}
		}
	}
})
