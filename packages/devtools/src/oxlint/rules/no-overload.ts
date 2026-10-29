import { Array as Arr, Option, Record, Result } from "effect"
import { type AnyNode, type Context, problem } from "#oxlint/rule.ts"

/**
 * One declaration of a callable member of a scope: the key its overloads share, the node a report points at, and its
 * form: an implementation with a body, or a bodiless signature.
 */
type Signature = Readonly<{ key: string; node: AnyNode; form: "implementation" | "signature" }>

/** An exported declaration is its declaration. */
const declared = (node: AnyNode): AnyNode => {
	if (
		(node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") &&
		node.declaration !== null
	) {
		return node.declaration
	}
	return node
}

const memberName = (context: Context, key: AnyNode, computed: boolean): string => {
	if (computed) {
		return `[${context.sourceCode.getText(key)}]`
	}
	if (key.type === "Identifier") {
		return key.name
	}
	if (key.type === "PrivateIdentifier") {
		return `#${key.name}`
	}
	return context.sourceCode.getText(key)
}

const signatureOf = (context: Context, member: AnyNode): Option.Option<Signature> => {
	const node = declared(member)
	if (node.type === "FunctionDeclaration" || node.type === "TSDeclareFunction") {
		const form =
			node.type === "TSDeclareFunction" || node.body === null ? "signature" : "implementation"
		return Option.some(
			node.id === null
				? { key: "function default", node, form }
				: { key: `function ${node.id.name}`, node: node.id, form }
		)
	}
	if (node.type === "MethodDefinition" || node.type === "TSAbstractMethodDefinition") {
		const form =
			node.type === "TSAbstractMethodDefinition" ||
			node.value.type === "TSEmptyBodyFunctionExpression"
				? "signature"
				: "implementation"
		if (node.kind === "constructor") {
			return Option.some({ key: "constructor", node, form })
		}
		const kind = node.kind === "method" ? "method" : node.kind
		return Option.some({
			key: `${node.static ? "static " : ""}${kind} ${memberName(context, node.key, node.computed)}`,
			node: node.key,
			form
		})
	}
	if (node.type === "TSMethodSignature") {
		return Option.some({
			key: `${node.kind} ${memberName(context, node.key, node.computed)}`,
			node: node.key,
			form: "signature"
		})
	}
	if (node.type === "TSCallSignatureDeclaration") {
		return Option.some({ key: "call", node, form: "signature" })
	}
	if (node.type === "TSConstructSignatureDeclaration") {
		return Option.some({ key: "new", node, form: "signature" })
	}
	return Option.none()
}

const MESSAGE =
	"Overload signatures are banned. Give the function one signature: a generic, a union, or separately named functions."

/**
 * Overload signatures. A scope is a statement list, a class body, a type literal, or the members of every declaration
 * of one interface in one statement list, which TypeScript merges. Where one name is declared more than once in a
 * scope, every bodiless declaration of it is an overload signature, and so is every repeated method, call or construct
 * signature of an interface or a type literal. A Function.dual's type, two call signatures, is an overload too.
 */
export const noOverload = problem((context) => {
	const scope = (members: ReadonlyArray<AnyNode>): void => {
		const signatures = Arr.getSomes(Arr.map(members, (member) => signatureOf(context, member)))
		const byKey = Arr.groupBy(signatures, (signature) => signature.key)
		for (const same of Record.values(byKey)) {
			if (same.length > 1) {
				for (const signature of Arr.filter(same, (each) => each.form === "signature")) {
					context.report({ node: signature.node, message: MESSAGE })
				}
			}
		}
	}
	const statements = (list: ReadonlyArray<AnyNode>): void => {
		scope(list)
		const interfaces = Arr.filterMap(list, (statement) => {
			const node = declared(statement)
			return node.type === "TSInterfaceDeclaration" ? Result.succeed(node) : Result.failVoid
		})
		for (const declarations of Record.values(Arr.groupBy(interfaces, (each) => each.id.name))) {
			scope(Arr.flatMap(declarations, (declaration) => declaration.body.body))
		}
	}
	return {
		Program: (node) => {
			statements(node.body)
		},
		BlockStatement: (node) => {
			statements(node.body)
		},
		TSModuleBlock: (node) => {
			statements(node.body)
		},
		SwitchCase: (node) => {
			statements(node.consequent)
		},
		ClassBody: (node) => {
			scope(node.body)
		},
		TSTypeLiteral: (node) => {
			scope(node.members)
		}
	}
})
