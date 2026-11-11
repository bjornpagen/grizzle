import { Array as Arr, Predicate } from "effect"
import * as ts from "typescript/ast"
import {
	type Checker,
	type Symbol as NativeSymbol,
	type NodeHandle,
	SymbolFlags,
	type Type
} from "typescript/sync"

/**
 * One source file's checker lookups. Every checker call is a synchronous IPC round trip, so the symbols the rules
 * need most are fetched for the whole file in one batched call, on the first symbol lookup in the file, and answered
 * from memory afterwards; a file no rule looks a symbol up in makes no call. A lookup outside the batch falls back to
 * a single call and is remembered too.
 */
export type Semantics = Readonly<{
	/** The symbol the checker binds at a node, exactly as getSymbolAtLocation returns it (aliases unresolved). */
	symbolAt: (node: ts.Node) => NativeSymbol | undefined
	/** The symbol an import alias finally refers to; a symbol that is no alias is its own target. */
	aliasTarget: (symbol: NativeSymbol) => NativeSymbol
	/** The type the checker gives an expression, or undefined when the native checker has none. */
	typeAt: (node: ts.Node) => Type | undefined
	/** A symbol's declarations as nodes; a handle the compiler cannot resolve is left out. */
	declarationsOf: (symbol: NativeSymbol) => ReadonlyArray<ts.Node>
	/** The declaration of the signature the checker resolves a call, construction or tagged template to, or undefined
	 * when the resolved signature has none (an unresolved call) or its handle does not resolve. */
	signatureDeclarationAt: (node: ts.Node) => ts.Node | undefined
}>

/** The nodes whose symbols the rules read at `node`: identifiers, member names and callees. */
const isNamed = Predicate.or(ts.isIdentifier, ts.isPropertyAccessExpression)

const isInvocation = Predicate.or(ts.isCallExpression, ts.isNewExpression)

const symbolNodesAt = (node: ts.Node): ReadonlyArray<ts.Node> => {
	const named = isNamed(node) ? [node] : []
	const called = isInvocation(node) ? [node.expression] : []
	return [...named, ...called]
}

export const prepareSemantics = (
	input: Readonly<{ sourceFile: ts.SourceFile; checker: Checker }>
): Semantics => {
	const { checker } = input
	const batched = (): Map<ts.Node, NativeSymbol | undefined> => {
		const symbolNodes: Array<ts.Node> = []
		const collect = (node: ts.Node): void => {
			for (const at of symbolNodesAt(node)) {
				symbolNodes.push(at)
			}
			node.forEachChild(collect)
		}
		collect(input.sourceFile)
		return new Map(Arr.zip(symbolNodes, checker.getSymbolAtLocation(symbolNodes)))
	}
	let fetched: Map<ts.Node, NativeSymbol | undefined> | undefined
	const types = new Map<ts.Node, Type | undefined>()
	const targets = new Map<number, NativeSymbol>()
	const resolved = new Map<NodeHandle, ts.Node | undefined>()

	const symbolAt = (node: ts.Node): NativeSymbol | undefined => {
		fetched ??= batched()
		const symbols = fetched
		if (symbols.has(node)) {
			return symbols.get(node)
		}
		const symbol = checker.getSymbolAtLocation(node)
		symbols.set(node, symbol)
		return symbol
	}
	const aliasTarget = (symbol: NativeSymbol): NativeSymbol => {
		if ((symbol.flags & SymbolFlags.Alias) === 0) {
			return symbol
		}
		const known = targets.get(symbol.id)
		if (known !== undefined) {
			return known
		}
		const target = checker.getAliasedSymbol(symbol)
		targets.set(symbol.id, target)
		return target
	}
	const typeAt = (node: ts.Node): Type | undefined => {
		if (types.has(node)) {
			return types.get(node)
		}
		const type = checker.getTypeAtLocation(node)
		types.set(node, type)
		return type
	}
	const resolve = (handle: NodeHandle): ts.Node | undefined => {
		if (resolved.has(handle)) {
			return resolved.get(handle)
		}
		const node = handle.resolve()
		resolved.set(handle, node)
		return node
	}
	const declarationsOf = (symbol: NativeSymbol): ReadonlyArray<ts.Node> => {
		const nodes: Array<ts.Node> = []
		for (const handle of symbol.declarations) {
			const node = resolve(handle)
			if (node !== undefined) {
				nodes.push(node)
			}
		}
		return nodes
	}
	const signatures = new Map<ts.Node, ts.Node | undefined>()
	const signatureDeclarationAt = (node: ts.Node): ts.Node | undefined => {
		if (signatures.has(node)) {
			return signatures.get(node)
		}
		const handle = checker.getResolvedSignature(node).declaration
		const declaration = handle === undefined ? undefined : resolve(handle)
		signatures.set(node, declaration)
		return declaration
	}
	return { symbolAt, aliasTarget, typeAt, declarationsOf, signatureDeclarationAt }
}
