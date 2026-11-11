import { Array as Arr, Option, Record, String as Str } from "effect"
import * as ts from "typescript/ast"
import type { Report } from "#shared/finding.ts"
import { isWhitespace } from "#style/css.ts"
import { isNamedBy, isNamedByAny, type MarkupOption, type OperandOption } from "#style/options.ts"

/** The native elements that are widgets: the app composes its ui primitives instead. */
const RAW_WIDGETS: ReadonlyArray<string> = [
	"button",
	"input",
	"select",
	"textarea",
	"label",
	"fieldset",
	"legend",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"th",
	"td",
	"caption",
	"details",
	"summary",
	"dialog"
]

/** The members that construct HTML or CSS from strings. */
const HTML_MEMBERS: ReadonlyArray<string> = [
	"innerHTML",
	"outerHTML",
	"insertAdjacentHTML",
	"writeHTML",
	"srcdoc",
	"srcDoc",
	"insertRule",
	"addRule",
	"replaceSync",
	"parseFromString",
	"renderToString",
	"renderToStaticMarkup"
]

const ELEMENT_FACTORIES: ReadonlyArray<string> = ["createElement", "createElementNS"]

const HANDLERS: ReadonlyArray<string> = ["onClick", "onPointerDown", "onKeyDown"]

const LAYOUT_ELEMENTS: ReadonlyArray<string> = ["div", "span"]

/** The attributes `setAttribute` may not write, in lower case. */
const UNSAFE_ATTRIBUTES: ReadonlyArray<string> = ["style", "srcdoc", "innerhtml", "outerhtml"]

/** Text without any whitespace: how an operand is compared, so formatting never matters. */
const squeezed = (text: string): string =>
	Arr.join(
		Arr.filter(Arr.fromIterable(text), (character) => !isWhitespace(character)),
		""
	)

const isTagNameCharacter = (character: string): boolean =>
	(character >= "a" && character <= "z") ||
	(character >= "A" && character <= "Z") ||
	(character >= "0" && character <= "9") ||
	character === "-"

const isLetter = (character: string): boolean =>
	(character >= "a" && character <= "z") || (character >= "A" && character <= "Z")

/** Whether text holds an HTML tag: `<`, an optional `!` or `/`, a letter, name characters, then whitespace or `>`. */
const holdsHtmlTag = (text: string): boolean => {
	const characters = Arr.fromIterable(text)
	return Arr.some(characters, (character, index) => {
		if (character !== "<") {
			return false
		}
		const rest = Arr.drop(characters, index + 1)
		const name = Option.exists(Arr.head(rest), (first) => first === "!" || first === "/")
			? Arr.drop(rest, 1)
			: rest
		const tag = Arr.takeWhile(name, isTagNameCharacter)
		return (
			Option.exists(Arr.head(name), isLetter) &&
			Option.exists(Arr.get(name, tag.length), (after) => after === ">" || isWhitespace(after))
		)
	})
}

type StyleBridge = MarkupOption["styleBridges"][number]

/** What one file's checks read: its tree, the variables it declares and the names it imports, and the doors the
 * options open at it: the operands each measured style property may hold, its style bridges, and whether it may
 * write HTML templates and construct stylesheets. */
type MarkupFile = Readonly<{
	sourceFile: ts.SourceFile
	definitions: ReadonlyMap<string, ts.Expression>
	imported: ReadonlyMap<string, string>
	measured: Readonly<Record<string, ReadonlyArray<OperandOption>>>
	bridges: ReadonlyArray<StyleBridge>
	htmlTemplates: boolean
	stylesheetConstructors: boolean
	reports: Array<Report>
}>

const report = (file: MarkupFile, node: ts.Node, message: string): void => {
	file.reports.push({ node, message })
}

/** Every variable a file declares with its initializer, and every name it imports: `module` for a default or
 * namespace import, `module:export` for a named one. */
const inventoryOf = (
	sourceFile: ts.SourceFile
): Readonly<{ definitions: Map<string, ts.Expression>; imported: Map<string, string> }> => {
	const definitions = new Map<string, ts.Expression>()
	const imported = new Map<string, string>()
	const walk = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined
		) {
			definitions.set(node.name.text, node.initializer)
		}
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const specifier = node.moduleSpecifier.text
			const clause = node.importClause
			const bindings = clause?.namedBindings
			if (clause?.name !== undefined) {
				imported.set(clause.name.text, specifier)
			}
			if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
				imported.set(bindings.name.text, specifier)
			}
			if (bindings !== undefined && ts.isNamedImports(bindings)) {
				for (const binding of bindings.elements) {
					const exported =
						binding.propertyName === undefined ? binding.name.text : binding.propertyName.text
					imported.set(binding.name.text, `${specifier}:${exported}`)
				}
			}
		}
		node.forEachChild(walk)
	}
	walk(sourceFile)
	return { definitions, imported }
}

/** The string an expression always holds, followed through the file's variables and `+`. */
const literalOf = (
	file: MarkupFile,
	node: ts.Expression,
	seen: ReadonlySet<string>
): Option.Option<string> => {
	if (ts.isStringLiteralLikeNode(node)) {
		return Option.some(node.text)
	}
	if (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isSatisfiesExpression(node)
	) {
		return literalOf(file, node.expression, seen)
	}
	if (ts.isIdentifier(node) && !seen.has(node.text)) {
		return Option.flatMap(Option.fromUndefinedOr(file.definitions.get(node.text)), (definition) =>
			literalOf(file, definition, new Set([...seen, node.text]))
		)
	}
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		return Option.flatMap(literalOf(file, node.left, seen), (left) =>
			Option.map(literalOf(file, node.right, seen), (right) => `${left}${right}`)
		)
	}
	return Option.none()
}

const literal = (file: MarkupFile, node: ts.Expression): Option.Option<string> =>
	literalOf(file, node, new Set<string>())

const argumentLiteral = (
	file: MarkupFile,
	call: ts.CallExpression,
	index: number
): Option.Option<string> =>
	Option.flatMap(Arr.get(call.arguments, index), (argument) => literal(file, argument))

/** The member an access reads: a property's name, or an element access's literal key. */
const memberOf = (file: MarkupFile, node: ts.Node): Option.Option<string> => {
	if (ts.isPropertyAccessExpression(node)) {
		return Option.some(node.name.text)
	}
	return ts.isElementAccessExpression(node) ? literal(file, node.argumentExpression) : Option.none()
}

const isAccess = (
	node: ts.Node
): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
	ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)

const isStyleAccess = (file: MarkupFile, node: ts.Node): boolean =>
	isAccess(node) && Option.contains(memberOf(file, node), "style")

/** `owner.style`, read off a binding of that name. */
const isStyleOf = (node: ts.Node, owner: string): boolean =>
	ts.isPropertyAccessExpression(node) &&
	node.name.text === "style" &&
	ts.isIdentifier(node.expression) &&
	node.expression.text === owner

/** The function declaration a node sits in, the nearest one. */
const enclosingFunctionOf = (node: ts.Node): Option.Option<ts.FunctionDeclaration> => {
	if (ts.isSourceFile(node.parent)) {
		return Option.none()
	}
	return ts.isFunctionDeclaration(node.parent)
		? Option.some(node.parent)
		: enclosingFunctionOf(node.parent)
}

/** A style bridge's one merge: `style: { ...base.style, ...overlay.style }` inside the bridge function. */
const isBridgeStyle = (file: MarkupFile, node: ts.Node): boolean => {
	if (
		!ts.isPropertyAssignment(node) ||
		!ts.isIdentifier(node.name) ||
		node.name.text !== "style" ||
		!ts.isObjectLiteralExpression(node.initializer)
	) {
		return false
	}
	const [base, overlay, ...rest] = node.initializer.properties
	return Arr.some(
		file.bridges,
		(bridge) =>
			base !== undefined &&
			overlay !== undefined &&
			!Arr.isReadonlyArrayNonEmpty(rest) &&
			ts.isSpreadAssignment(base) &&
			ts.isSpreadAssignment(overlay) &&
			isStyleOf(base.expression, bridge.base) &&
			isStyleOf(overlay.expression, bridge.overlay) &&
			Option.exists(enclosingFunctionOf(node), (owner) =>
				Option.exists(Option.fromUndefinedOr(owner.name), (name) => name.text === bridge.function)
			)
	)
}

const isBridgeStyleRead = (file: MarkupFile, node: ts.Node): boolean =>
	ts.isSpreadAssignment(node.parent) &&
	ts.isObjectLiteralExpression(node.parent.parent) &&
	isBridgeStyle(file, node.parent.parent.parent)

/** An operand that is a member of a module's named export: a property chain rooted at its import. */
const isExportOperand = (file: MarkupFile, value: ts.Node, operand: OperandOption): boolean => {
	if (operand.kind !== "export") {
		return false
	}
	const rootOf = (node: ts.Node): ts.Node =>
		ts.isPropertyAccessExpression(node) ? rootOf(node.expression) : node
	const root = rootOf(value)
	return (
		ts.isIdentifier(root) && file.imported.get(root.text) === `${operand.module}:${operand.name}`
	)
}

const isExpressionOperand = (file: MarkupFile, value: ts.Node, operand: OperandOption): boolean =>
	operand.kind === "expression" &&
	squeezed(operand.text) === squeezed(value.getText(file.sourceFile))

/** A percentage of an expression operand, `${share}%`. */
const isPercentOperand = (
	file: MarkupFile,
	value: ts.Node,
	operands: ReadonlyArray<OperandOption>
): boolean => {
	if (!ts.isTemplateExpression(value)) {
		return false
	}
	const [span, ...others] = value.templateSpans
	return (
		span !== undefined &&
		!Arr.isReadonlyArrayNonEmpty(others) &&
		value.head.text === "" &&
		span.literal.text === "%" &&
		Arr.some(operands, (operand) => isExpressionOperand(file, span.expression, operand))
	)
}

/** A style property's written name, an identifier's or a string's; a computed name is never measured. */
const stylePropertyNameOf = (name: ts.PropertyName): Option.Option<string> =>
	ts.isIdentifier(name) || ts.isStringLiteral(name) ? Option.some(name.text) : Option.none()

/** A measured style property: one of the operands its file admits for it, or a percentage of one. */
const isMeasuredProperty = (file: MarkupFile, property: ts.ObjectLiteralElementLike): boolean => {
	if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
		return false
	}
	const value = ts.isPropertyAssignment(property) ? property.initializer : property.name
	return Option.exists(
		Option.flatMap(stylePropertyNameOf(property.name), (name) => Record.get(file.measured, name)),
		(operands) =>
			Arr.some(
				operands,
				(operand) =>
					isExpressionOperand(file, value, operand) || isExportOperand(file, value, operand)
			) || isPercentOperand(file, value, operands)
	)
}

/** A style attribute the options admit: an object literal of measured operands at a file that owns them. */
const isMeasuredStyle = (file: MarkupFile, attribute: ts.JsxAttribute): boolean => {
	const initializer = attribute.initializer
	if (
		initializer === undefined ||
		!ts.isJsxExpression(initializer) ||
		initializer.expression === undefined ||
		!ts.isObjectLiteralExpression(initializer.expression)
	) {
		return false
	}
	const properties = initializer.expression.properties
	return (
		Arr.isReadonlyArrayNonEmpty(properties) &&
		Arr.every(properties, (property) => isMeasuredProperty(file, property))
	)
}

const checkAttribute = (file: MarkupFile, attribute: ts.JsxAttribute, tag: string): void => {
	const name = attribute.name.getText(file.sourceFile)
	if (
		(name === "style" && !isMeasuredStyle(file, attribute)) ||
		name === "dangerouslySetInnerHTML" ||
		name === "srcDoc"
	) {
		report(file, attribute, `JSX ${name} bypasses the shadcn styling and content boundary.`)
	}
	if (Arr.contains(HANDLERS, name) && Arr.contains(LAYOUT_ELEMENTS, tag)) {
		report(file, attribute, "Clickable layout elements must become shadcn controls.")
	}
}

const checkJsx = (
	file: MarkupFile,
	node: ts.JsxOpeningElement | ts.JsxSelfClosingElement
): void => {
	const tag = node.tagName.getText(file.sourceFile)
	if (Arr.contains(RAW_WIDGETS, tag)) {
		report(file, node, `Raw <${tag}> is a widget; compose the app's ui primitive.`)
	}
	if (tag === "style") {
		report(file, node, "A <style> element is a second stylesheet owner.")
	}
	if (tag === "svg") {
		report(file, node, "Application icons come from the icon library, not handwritten SVG.")
	}
	const selected = Option.flatMap(Option.fromUndefinedOr(file.definitions.get(tag)), (definition) =>
		literal(file, definition)
	)
	if (ts.isIdentifier(node.tagName) && Option.isSome(selected)) {
		report(file, node, "String-selected JSX tags are forbidden; use fixed declarative renderers.")
	}
	for (const attribute of node.attributes.properties) {
		if (ts.isJsxAttribute(attribute)) {
			checkAttribute(file, attribute, tag)
		}
	}
}

const checkAccess = (
	file: MarkupFile,
	node: ts.PropertyAccessExpression | ts.ElementAccessExpression
): void => {
	const name = memberOf(file, node)
	const isCalled = ts.isCallExpression(node.parent) && node.parent.expression === node
	if (Option.exists(name, (found) => Arr.contains(ELEMENT_FACTORIES, found)) && !isCalled) {
		report(
			file,
			node,
			"Element factory methods may not escape into aliases; only direct calls are a rendering door."
		)
	}
	if (
		Option.isNone(name) &&
		ts.isElementAccessExpression(node) &&
		Arr.contains(["document", "window.document"], node.expression.getText(file.sourceFile))
	) {
		report(
			file,
			node,
			"Dynamic document method acquisition cannot establish content-renderer authority."
		)
	}
	const door = Option.filter(
		name,
		(found) =>
			Arr.contains(HTML_MEMBERS, found) && !(found === "replaceSync" && file.stylesheetConstructors)
	)
	if (Option.isSome(door)) {
		report(file, node, `${door.value} is an unauthorized HTML or CSS construction door.`)
	}
	if (
		Option.contains(name, "write") &&
		Str.includes("document")(node.expression.getText(file.sourceFile))
	) {
		report(file, node, "Document writes cannot construct application HTML.")
	}
	if (isStyleAccess(file, node.expression)) {
		report(file, node, "Runtime styles may not be written.")
	}
	if (Option.contains(name, "style") && !isBridgeStyleRead(file, node) && !isAccess(node.parent)) {
		report(file, node, "Style objects may not escape into aliases, merges or setters.")
	}
}

const checkCall = (file: MarkupFile, node: ts.CallExpression): void => {
	const callee = node.expression
	const name = Option.orElse(memberOf(file, callee), () =>
		ts.isIdentifier(callee) ? Option.some(callee.text) : Option.none()
	)
	const importName = ts.isIdentifier(callee)
		? Option.fromUndefinedOr(file.imported.get(callee.text))
		: Option.none()
	if (
		Option.exists(name, (found) => Arr.contains(ELEMENT_FACTORIES, found)) ||
		Option.exists(importName, Str.endsWith(":createElement"))
	) {
		report(file, node, "Application rendering uses fixed JSX, never element creation.")
	}
	if (Option.exists(name, (found) => found === "setAttribute" || found === "setAttributeNS")) {
		const attribute = argumentLiteral(file, node, Option.contains(name, "setAttributeNS") ? 1 : 0)
		if (
			!Option.exists(attribute, (found) => !Arr.contains(UNSAFE_ATTRIBUTES, Str.toLowerCase(found)))
		) {
			report(
				file,
				node,
				"Dynamic, styling or HTML DOM attributes are not an admitted rendering door."
			)
		}
	}
	if (Option.exists(name, (found) => found === "defineProperty" || found === "set")) {
		const property = argumentLiteral(file, node, 1)
		if (
			Option.exists(property, (found) => found === "style" || Arr.contains(HTML_MEMBERS, found))
		) {
			report(file, node, "Reflective HTML and style writes are forbidden.")
		}
	}
}

/** A font loader's own option (next/font's `style` names the faces it loads), not a prop: in the loader's options,
 * or on one face of next/font/local's `src`. */
const isFontLoaderOption = (file: MarkupFile, node: ts.PropertyAssignment): boolean => {
	const faces = node.parent.parent
	const options =
		ts.isArrayLiteralExpression(faces) &&
		ts.isPropertyAssignment(faces.parent) &&
		ts.isIdentifier(faces.parent.name) &&
		faces.parent.name.text === "src"
			? faces.parent.parent
			: node.parent
	const call = options.parent
	return (
		ts.isCallExpression(call) &&
		Arr.some(call.arguments, (argument) => argument === options) &&
		ts.isIdentifier(call.expression) &&
		Option.exists(
			Option.fromUndefinedOr(file.imported.get(call.expression.text)),
			Str.startsWith("next/font/")
		)
	)
}

const checkProperty = (file: MarkupFile, node: ts.PropertyAssignment): void => {
	const name = ts.isComputedPropertyName(node.name)
		? literal(file, node.name.expression)
		: ts.isIdentifier(node.name) || ts.isStringLiteralLikeNode(node.name)
			? Option.some(node.name.text)
			: Option.none()
	if (
		Option.exists(name, (found) => found === "dangerouslySetInnerHTML" || found === "srcDoc") ||
		(Option.contains(name, "style") &&
			!isBridgeStyle(file, node) &&
			!isFontLoaderOption(file, node))
	) {
		report(file, node, "Spreadable props may not carry inline styles or HTML injection.")
	}
}

const checkConstruction = (file: MarkupFile, node: ts.NewExpression): void => {
	const constructed = node.expression.getText(file.sourceFile)
	if (
		(constructed === "CSSStyleSheet" && !file.stylesheetConstructors) ||
		constructed === "DOMParser"
	) {
		report(
			file,
			node,
			"Application HTML and CSS may not acquire another parser or stylesheet owner."
		)
	}
}

const checkTemplate = (file: MarkupFile, node: ts.TemplateExpression): void => {
	const segments = [node.head.text, ...Arr.map(node.templateSpans, (span) => span.literal.text)]
	if (!file.htmlTemplates && Arr.some(segments, holdsHtmlTag)) {
		report(file, node, "Interpolated HTML construction must become fixed JSX.")
	}
}

const checkBinding = (file: MarkupFile, node: ts.BindingElement): void => {
	const binding = Option.fromUndefinedOr(node.propertyName ?? node.name)
	const name = Option.flatMap(binding, (found) =>
		ts.isIdentifier(found) || ts.isStringLiteralLikeNode(found)
			? Option.some(found.text)
			: Option.none()
	)
	if (
		Option.exists(
			name,
			(found) => Arr.contains(HTML_MEMBERS, found) || Arr.contains(ELEMENT_FACTORIES, found)
		)
	) {
		report(file, node, "Destructuring cannot acquire HTML renderer or element-factory authority.")
	}
}

const check = (file: MarkupFile, node: ts.Node): void => {
	if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
		checkJsx(file, node)
	}
	if (isAccess(node)) {
		checkAccess(file, node)
	}
	if (ts.isCallExpression(node)) {
		checkCall(file, node)
	}
	if (ts.isNewExpression(node)) {
		checkConstruction(file, node)
	}
	if (ts.isPropertyAssignment(node)) {
		checkProperty(file, node)
	}
	if (ts.isTemplateExpression(node)) {
		checkTemplate(file, node)
	}
	if (ts.isBindingElement(node)) {
		checkBinding(file, node)
	}
}

/** The operands a file's measured style properties may hold, by property, from every entry that names the file. */
const measuredOf = (
	options: MarkupOption,
	fileName: string
): Readonly<Record<string, ReadonlyArray<OperandOption>>> => {
	const entries = Arr.filter(options.measuredStyles, (entry) => isNamedBy(entry.path)(fileName))
	const properties = Arr.flatMap(entries, (entry) => Record.toEntries(entry.properties))
	const byProperty = Arr.groupBy(properties, ([property]) => property)
	return Record.map(byProperty, (group) => Arr.flatMap(group, ([, operands]) => operands))
}

/**
 * Presentation is fixed JSX styled by classes: no inline styles but the measured operands the options give a file,
 * no HTML from strings (innerHTML and its kin, document.write, DOMParser, HTML templates, setAttribute of style or
 * HTML), no element factories, no raw widgets or handwritten SVG where the app's primitives and icon library serve,
 * no clickable layout elements, and no `<style>` or constructed stylesheets beside the one theme. A file the options
 * name may merge styles in its style bridge, write HTML templates, or construct stylesheets.
 */
export const markup = (
	input: Readonly<{ sourceFile: ts.SourceFile; options: MarkupOption }>
): ReadonlyArray<Report> => {
	const { sourceFile, options } = input
	const fileName = sourceFile.fileName
	const { definitions, imported } = inventoryOf(sourceFile)
	const file: MarkupFile = {
		sourceFile,
		definitions,
		imported,
		measured: measuredOf(options, fileName),
		bridges: Arr.filter(options.styleBridges, (bridge) => isNamedBy(bridge.path)(fileName)),
		htmlTemplates: isNamedByAny(options.htmlTemplates)(fileName),
		stylesheetConstructors: isNamedByAny(options.stylesheetConstructors)(fileName),
		reports: []
	}
	const walk = (node: ts.Node): void => {
		check(file, node)
		node.forEachChild(walk)
	}
	walk(sourceFile)
	return file.reports
}

/** Standalone HTML is not a maintained application surface: the app renders JSX. */
export const STANDALONE_HTML = "Standalone HTML is not a maintained application surface; use JSX."
