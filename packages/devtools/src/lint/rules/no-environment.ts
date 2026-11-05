import { Array as Arr, Option, Result } from "effect"
import * as ts from "typescript/ast"
import { type Symbol as NativeSymbol, SymbolFlags } from "typescript/sync"
import type { SuperlintOptions } from "#lint/options.ts"
import { isAtAny, isPackageModule } from "#lint/paths.ts"
import type { RuleContext, Visit } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"

type Source = SuperlintOptions["noEnvironment"]["sources"][number]

/** One read of the environment: the node it is at, the name it reads, and the source whose value that is. */
type Read = Readonly<{ node: ts.Node; name: string; source: Source }>

/** Whether an expression is `import.meta.main`, which holds in the module Node runs as its program. */
const isMainFlag = (expression: ts.Expression): boolean =>
	ts.isPropertyAccessExpression(expression) &&
	ts.isMetaProperty(expression.expression) &&
	expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
	expression.expression.name.text === "meta" &&
	expression.name.text === "main"

/** The statements a module runs only as the program: each top-level `if (import.meta.main)` statement's body. */
const entryGuardsOf = (sourceFile: ts.SourceFile): ReadonlyArray<ts.Node> =>
	Arr.filterMap(sourceFile.statements, (statement): Result.Result<ts.Node, void> =>
		ts.isIfStatement(statement) && isMainFlag(statement.expression)
			? Result.succeed(statement.thenStatement)
			: Result.failVoid
	)

const isExported = (statement: ts.Statement): boolean =>
	(ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement)) &&
	Arr.some(statement.modifiers ?? [], (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)

/** A module's top-level declarations that no `export` modifier exports, by the names they bind. */
const localDeclarationsOf = (
	sourceFile: ts.SourceFile
): ReadonlyArray<Readonly<{ node: ts.Node; name: ts.Identifier }>> =>
	Arr.flatMap(sourceFile.statements, (statement) => {
		if (isExported(statement)) {
			return []
		}
		if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
			return [{ node: statement, name: statement.name }]
		}
		return ts.isVariableStatement(statement)
			? Arr.filterMap(
					statement.declarationList.declarations,
					(declaration): Result.Result<Readonly<{ node: ts.Node; name: ts.Identifier }>, void> =>
						ts.isIdentifier(declaration.name)
							? Result.succeed({ node: declaration, name: declaration.name })
							: Result.failVoid
				)
			: []
	})

const contains = (outer: ts.Node, inner: ts.Node): boolean =>
	outer.pos <= inner.pos && inner.end <= outer.end

/** Whether a node lies in a function inside a declaration, which runs when it is called, never as the module loads. */
const isDeferredIn = (declaration: ts.Node, node: ts.Node): boolean => {
	for (let at: ts.Node = node; at !== declaration && !ts.isSourceFile(at); at = at.parent) {
		if (ts.isFunctionLikeDeclaration(at)) {
			return true
		}
	}
	return ts.isFunctionLikeDeclaration(declaration)
}

/** The code a module runs only as the program: the bodies of its top-level `if (import.meta.main)` statements, and
 * the functions inside the declarations only that code calls. */
type EntryCode = Readonly<{ guards: ReadonlyArray<ts.Node>; deferred: ReadonlyArray<ts.Node> }>

const isInEntryCode = (code: EntryCode, node: ts.Node): boolean =>
	Arr.some(code.guards, (guard) => contains(guard, node)) ||
	Arr.some(
		code.deferred,
		(declaration) => contains(declaration, node) && isDeferredIn(declaration, node)
	)

/** Whether a node sits in a type, an import or an export, where a name is no read of a value. */
const isOutsideValues = (node: ts.Node): boolean => {
	const { parent } = node
	if (ts.isSourceFile(parent)) {
		return false
	}
	return (
		(parent.kind >= ts.SyntaxKind.FirstTypeNode && parent.kind <= ts.SyntaxKind.LastTypeNode) ||
		ts.isImportDeclaration(parent) ||
		ts.isExportDeclaration(parent) ||
		ts.isImportEqualsDeclaration(parent) ||
		isOutsideValues(parent)
	)
}

/** The expression a destructuring reads its properties off, through parentheses. */
const receiverOf = (expression: ts.Expression): ts.Expression =>
	ts.isParenthesizedExpression(expression) ? receiverOf(expression.expression) : expression

/**
 * The library reads no environment: what it needs is its caller's input. In the files the options name, a read of a
 * value of one of the sources (a module of an installed package: every value of it, or the named ones) is refused,
 * however it is spelled: a property read (`process.env`), a bare name an import binds (`env` from node:process,
 * `homedir` from node:os), a destructuring (`const { env } = process`), a shorthand property, an element read by a
 * written key. A name a type, an import or an export spells reads nothing. The sanctioned readers the options name are
 * not read; a program's entry code, what its module runs only under a top-level `if (import.meta.main)`, reads the entry
 * reads (its arguments and its working directory) as its own input.
 */
export const noEnvironment: Visit = (context: RuleContext) => {
	const { sourceFile, semantics, checker, root } = context
	const { files, readers, sources, entryReads } = context.options.noEnvironment
	if (!isAtAny(root, files, sourceFile.fileName) || isAtAny(root, readers, sourceFile.fileName)) {
		return () => []
	}
	const exportNames = Arr.flatMap(sources, (source) =>
		source.reads.kind === "exports" ? source.reads.names : []
	)
	const declares = (source: Source, symbol: NativeSymbol): boolean =>
		Arr.some(symbol.declarations, (declaration) => isPackageModule(declaration.path, source))
	const reads = (source: Source, name: string): boolean =>
		source.reads.kind === "module" || Arr.contains(source.reads.names, name)
	const known = new Map<number, Option.Option<Source>>()
	const sourceOf = (symbol: NativeSymbol): Option.Option<Source> => {
		const seen = known.get(symbol.id)
		if (seen !== undefined) {
			return seen
		}
		const source =
			(symbol.flags & SymbolFlags.Module) === 0
				? Arr.findFirst(
						sources,
						(candidate) => declares(candidate, symbol) && reads(candidate, symbol.name)
					)
				: Option.none<Source>()
		known.set(symbol.id, source)
		return source
	}
	const readOf = (node: ts.Node, symbol: NativeSymbol | undefined): ReadonlyArray<Read> => {
		if (symbol === undefined) {
			return []
		}
		const target = semantics.aliasTarget(symbol)
		return Option.match(sourceOf(target), {
			onNone: () => [],
			onSome: (source) => [{ node, name: target.name, source }]
		})
	}
	const destructured = (element: ts.BindingElement): ReadonlyArray<Read> => {
		const pattern = element.parent
		const declaration = pattern.parent
		if (
			!ts.isObjectBindingPattern(pattern) ||
			!ts.isVariableDeclaration(declaration) ||
			declaration.initializer === undefined
		) {
			return []
		}
		const key = element.propertyName ?? element.name
		const holder = receiverOf(declaration.initializer)
		if (
			key === undefined ||
			!ts.isIdentifier(key) ||
			(!ts.isIdentifier(holder) && !ts.isPropertyAccessExpression(holder))
		) {
			return []
		}
		const receiver = semantics.symbolAt(holder)
		if (receiver === undefined) {
			return []
		}
		const target = semantics.aliasTarget(receiver)
		return Option.match(
			Arr.findFirst(
				sources,
				(candidate) => declares(candidate, target) && reads(candidate, key.text)
			),
			{ onNone: () => [], onSome: (source) => [{ node: element, name: key.text, source }] }
		)
	}
	const candidatesAt = (node: ts.Node): ReadonlyArray<Read> => {
		if (ts.isPropertyAccessExpression(node)) {
			return readOf(node, semantics.symbolAt(node))
		}
		if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
			const receiver = semantics.typeAt(node.expression)
			return receiver === undefined
				? []
				: readOf(node, receiver.getProperty(node.argumentExpression.text))
		}
		if (ts.isBindingElement(node)) {
			return destructured(node)
		}
		if (ts.isShorthandPropertyAssignment(node)) {
			return ts.isIdentifier(node.name) && Arr.contains(exportNames, node.name.text)
				? readOf(node, checker.getShorthandAssignmentValueSymbol(node))
				: []
		}
		const { parent } = node
		if (
			!ts.isIdentifier(node) ||
			(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
			(ts.isShorthandPropertyAssignment(parent) && parent.name === node) ||
			(ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node))
		) {
			return []
		}
		return readOf(node, semantics.symbolAt(node))
	}
	const readsAt = (node: ts.Node): ReadonlyArray<Read> => {
		const candidates = candidatesAt(node)
		return Arr.isReadonlyArrayNonEmpty(candidates) && isOutsideValues(node) ? [] : candidates
	}
	/**
	 * The code a module runs only as the program: its `if (import.meta.main)` bodies, and the functions inside each
	 * top-level declaration it does not export whose every reference lies in that code, until no more join it. A module
	 * that merely tests the flag, reads its arguments as it loads, or reads them in a function another module or an
	 * exported one can call, runs no such code there.
	 */
	const entryCodeOf = (): EntryCode => {
		const guards = entryGuardsOf(sourceFile)
		const deferred: Array<ts.Node> = []
		const code: EntryCode = { guards, deferred }
		if (!Arr.isReadonlyArrayNonEmpty(guards)) {
			return code
		}
		const candidates = Arr.filterMap(
			localDeclarationsOf(sourceFile),
			(
				local
			): Result.Result<Readonly<{ node: ts.Node; name: ts.Identifier; id: number }>, void> => {
				const symbol = semantics.symbolAt(local.name)
				return symbol === undefined
					? Result.failVoid
					: Result.succeed({ ...local, id: semantics.aliasTarget(symbol).id })
			}
		)
		const ids = new Set(Arr.map(candidates, (candidate) => candidate.id))
		const references: Array<Readonly<{ node: ts.Identifier; id: number }>> = []
		const visit = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && !Arr.some(candidates, (candidate) => candidate.name === node)) {
				const symbol = semantics.symbolAt(node)
				const id = symbol === undefined ? undefined : semantics.aliasTarget(symbol).id
				if (id !== undefined && ids.has(id)) {
					references.push({ node, id })
				}
			}
			node.forEachChild(visit)
		}
		visit(sourceFile)
		const joined = new Set<number>()
		let grown = true
		while (grown) {
			grown = false
			for (const candidate of candidates) {
				const reads = Arr.filter(references, (reference) => reference.id === candidate.id)
				if (
					joined.has(candidate.id) ||
					!Arr.isReadonlyArrayNonEmpty(reads) ||
					!Arr.every(reads, (read) => isInEntryCode(code, read.node))
				) {
					continue
				}
				joined.add(candidate.id)
				deferred.push(candidate.node)
				grown = true
			}
		}
		return code
	}
	let entry = Option.none<EntryCode>()
	const isEntryCode = (node: ts.Node): boolean => {
		if (Option.isNone(entry)) {
			entry = Option.some(entryCodeOf())
		}
		return Option.exists(entry, (code) => isInEntryCode(code, node))
	}
	const sanctioned = Arr.join(readers, ", ")
	return (node) =>
		Arr.filterMap(readsAt(node), (read): Result.Result<Report, void> => {
			if (Arr.contains(entryReads, read.name)) {
				return isEntryCode(read.node)
					? Result.failVoid
					: Result.succeed({
							node: read.node,
							message: `${read.node.getText(sourceFile)} reads the process's ${read.name}, which only a program's entry code (what a top-level \`if (import.meta.main)\` runs) takes as its input.`,
							suggestion:
								"Read it in the program's entry code and pass it on as an argument; the library reads no environment."
						})
			}
			return Result.succeed({
				node: read.node,
				message: `${read.node.getText(sourceFile)} reads the environment (${read.source.package}'s ${read.source.module}): the library reads none, and what it needs is its caller's input.`,
				suggestion: `Take it from the caller as a typed input; the sanctioned readers are ${sanctioned}.`
			})
		})
}
