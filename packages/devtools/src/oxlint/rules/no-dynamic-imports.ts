import { Array as Arr, Schema } from "effect"
import { configured, isFileAt } from "#oxlint/rule.ts"
import { isIdentifierIn, isStringLiteral } from "#oxlint/syntax.ts"

/** The project's one-off dynamic imports: a file, and the literal specifier it may load dynamically. */
const Options = Schema.Struct({
	allowed: Schema.Array(Schema.Struct({ file: Schema.String, specifier: Schema.String }))
})

const MESSAGE =
	"Dynamic loading and CommonJS escapes are banned. Use a static ESM import; a dynamic import a framework requires is on this rule's allowed list."

/** `import(...)`, `require(...)` and `createRequire(...)`, apart from the allowed file and literal specifier pairs. */
export const noDynamicImports = configured(Options, (context, options) => ({
	ImportExpression: (node) => {
		const allowed = Arr.some(
			options.allowed,
			(entry) =>
				isFileAt(context.filename, entry.file) &&
				isStringLiteral(node.source, (value) => value === entry.specifier)
		)
		if (!allowed) {
			context.report({ node, message: MESSAGE })
		}
	},
	CallExpression: (node) => {
		if (isIdentifierIn(node.callee, ["require", "createRequire"])) {
			context.report({ node, message: MESSAGE })
		}
	}
}))
