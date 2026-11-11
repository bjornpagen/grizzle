import { Array as Arr, Option, String as Str } from "effect"
import type { CreateRule, NodeOf } from "#oxlint/rule.ts"

type JsxAttributeItem = NodeOf<"JSXOpeningElement">["attributes"][number]

const attributeNamed = (
	attributes: ReadonlyArray<JsxAttributeItem>,
	name: string
): Option.Option<NodeOf<"JSXAttribute">> =>
	Arr.findFirst(
		attributes,
		(attribute): attribute is NodeOf<"JSXAttribute"> =>
			attribute.type === "JSXAttribute" &&
			attribute.name.type === "JSXIdentifier" &&
			attribute.name.name === name
	)

/** `aria-hidden`, `aria-hidden="true"` or `aria-hidden={true}`. */
const isHidden = (attribute: NodeOf<"JSXAttribute">): boolean => {
	const value = attribute.value
	if (value === null) {
		return true
	}
	if (value.type === "Literal") {
		return value.value === "true"
	}
	return (
		value.type === "JSXExpressionContainer" &&
		value.expression.type === "Literal" &&
		value.expression.value === true
	)
}

const hasAccessibleName = (attributes: ReadonlyArray<JsxAttributeItem>): boolean => {
	if (Option.isSome(attributeNamed(attributes, "aria-label"))) {
		return true
	}
	return Option.isSome(attributeNamed(attributes, "aria-labelledby"))
}

type JsxChild = NodeOf<"JSXElement">["children"][number]

/** Whitespace between tags renders nothing. */
const isBlank = (child: JsxChild): boolean =>
	child.type === "JSXText" && Str.isEmpty(Str.trim(child.value))

/** The svg's first child that renders is a `<title>` with content. */
const hasTitleChild = (element: NodeOf<"JSXElement">): boolean =>
	Option.exists(
		Arr.findFirst(element.children, (child) => !isBlank(child)),
		(first) =>
			first.type === "JSXElement" &&
			first.openingElement.name.type === "JSXIdentifier" &&
			first.openingElement.name.name === "title" &&
			Arr.some(first.children, (child) => !isBlank(child))
	)

export const noSvgWithoutTitle: CreateRule = {
	meta: { type: "problem" },
	create: (context) => ({
		JSXElement: (node) => {
			const opening = node.openingElement
			if (opening.name.type !== "JSXIdentifier" || opening.name.name !== "svg") {
				return
			}
			const attributes = opening.attributes
			const role = attributeNamed(attributes, "role")
			const isImage = Option.exists(
				role,
				(attribute) => attribute.value?.type === "Literal" && attribute.value.value === "img"
			)
			if (
				hasTitleChild(node) ||
				Option.exists(attributeNamed(attributes, "aria-hidden"), isHidden) ||
				(isImage && hasAccessibleName(attributes))
			) {
				return
			}
			context.report({
				node: opening,
				message:
					'An svg needs a <title> child, role="img" with aria-label or aria-labelledby, or aria-hidden="true" when it is decoration.'
			})
		}
	})
}
