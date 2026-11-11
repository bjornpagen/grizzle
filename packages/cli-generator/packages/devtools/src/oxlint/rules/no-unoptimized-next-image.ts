import { Array as Arr } from "effect"
import { type AnyNode, type Context, type NodeOf, problem } from "#oxlint/rule.ts"
import { ancestorsOf } from "#oxlint/syntax.ts"

type Program = Context["sourceCode"]["ast"]

const importsOfNextImage = (program: Program): ReadonlyArray<NodeOf<"ImportDeclaration">> =>
	Arr.filter(
		program.body,
		(statement): statement is NodeOf<"ImportDeclaration"> =>
			statement.type === "ImportDeclaration" && statement.source.value === "next/image"
	)

/** The local names a module gives next/image's default export. */
const nextImageNames = (program: Program): ReadonlyArray<string> =>
	Arr.flatMap(importsOfNextImage(program), (statement) =>
		Arr.flatMap(statement.specifiers, (specifier) => {
			if (specifier.type === "ImportDefaultSpecifier") {
				return [specifier.local.name]
			}
			if (
				specifier.type === "ImportSpecifier" &&
				specifier.imported.type === "Identifier" &&
				specifier.imported.name === "default"
			) {
				return [specifier.local.name]
			}
			return []
		})
	)

const importsImagePropsType = (program: Program): boolean =>
	Arr.some(
		importsOfNextImage(program),
		(statement) =>
			statement.importKind === "type" &&
			Arr.some(
				statement.specifiers,
				(specifier) =>
					specifier.type === "ImportSpecifier" &&
					specifier.imported.type === "Identifier" &&
					specifier.imported.name === "ImageProps"
			)
	)

const satisfiesImageProps = (ancestor: AnyNode): boolean =>
	ancestor.type === "TSSatisfiesExpression" &&
	ancestor.typeAnnotation.type === "TSTypeReference" &&
	ancestor.typeAnnotation.typeName.type === "Identifier" &&
	ancestor.typeAnnotation.typeName.name === "ImageProps"

/** `unoptimized` on next/image's component, or in an object that satisfies next/image's ImageProps. */
export const noUnoptimizedNextImage = problem((context) => {
	const program = context.sourceCode.ast
	return {
		JSXAttribute: (node) => {
			const opening = node.parent
			if (
				node.name.type === "JSXIdentifier" &&
				node.name.name === "unoptimized" &&
				opening.type === "JSXOpeningElement" &&
				opening.name.type === "JSXIdentifier" &&
				Arr.contains(nextImageNames(program), opening.name.name)
			) {
				context.report({
					node,
					message:
						"Do not disable next/image optimization with unoptimized. Use the public image URL and let Next.js own image delivery."
				})
			}
		},
		Property: (node) => {
			if (
				node.key.type === "Identifier" &&
				node.key.name === "unoptimized" &&
				Arr.some(ancestorsOf(node), satisfiesImageProps) &&
				importsImagePropsType(program)
			) {
				context.report({
					node,
					message:
						"Do not disable next/image optimization in ImageProps. Pass the public URL and let Next.js own image delivery."
				})
			}
		}
	}
})
