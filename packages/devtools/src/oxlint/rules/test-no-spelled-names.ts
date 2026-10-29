import { Array as Arr, Schema, String as Str } from "effect"
import { type AnyNode, configured } from "#oxlint/rule.ts"

/** The markers of the project's minted production identifiers. */
const Options = Schema.Struct({ markers: Schema.Array(Schema.String) })

/** The nodes whose every string literal is a name of the program's own: a module specifier, an import attribute, an
 * import or export name, a literal type, a module reference or a module declaration's name. */
const NAME_PARENTS: ReadonlyArray<string> = [
	"ImportDeclaration",
	"ExportNamedDeclaration",
	"ExportAllDeclaration",
	"ImportAttribute",
	"ImportSpecifier",
	"ExportSpecifier",
	"TSLiteralType",
	"TSExternalModuleReference",
	"TSModuleDeclaration"
]

/**
 * Whether a string literal stands where a name of the program's own goes rather than a value: a module specifier, an
 * import attribute, a property, member or enum key, a literal type, a module declaration's name or a directive.
 */
const isNamePosition = (literal: AnyNode, parent: AnyNode): boolean => {
	if (Arr.contains(NAME_PARENTS, parent.type)) {
		return true
	}
	if ("key" in parent && "computed" in parent) {
		return parent.key === literal && !parent.computed
	}
	if (parent.type === "TSEnumMember") {
		return parent.id === literal
	}
	return (
		parent.type === "ExpressionStatement" &&
		parent.directive !== null &&
		parent.directive !== undefined
	)
}

const MESSAGE =
	"Name a production identifier through the project's naming door, which computes it; a table a test creates by hand names its constraints without the naming rule's markers."

/**
 * A production identifier spelled by hand in a test or a bench: a string literal, or a template literal's text,
 * carrying one of the naming rule's markers. It keeps compiling when the naming rule changes, and it can name an object
 * no installation has; a test names production identifiers through the project's naming door.
 */
export const testNoSpelledNames = configured(Options, (context, options) => {
	const spellsName = (text: string): boolean =>
		Arr.some(options.markers, (marker) => Str.includes(marker)(text))
	return {
		Literal: (node) => {
			if (
				typeof node.value === "string" &&
				spellsName(node.value) &&
				!isNamePosition(node, node.parent)
			) {
				context.report({ node, message: MESSAGE })
			}
		},
		TemplateElement: (node) => {
			if (node.parent.type !== "TSTemplateLiteralType" && spellsName(node.value.raw)) {
				context.report({ node, message: MESSAGE })
			}
		}
	}
})
