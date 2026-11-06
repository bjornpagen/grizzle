import { Array as Arr, Option, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import {
	type Checker,
	type NodeHandle,
	type Symbol as NativeSymbol,
	SymbolFlags
} from "typescript/sync"
import { declaredValuesOf, missingValueMessage } from "#lint/declared.ts"
import type { SuperlintOptions } from "#lint/options.ts"
import { isAtAny, isOwnSourcePath, isPackagePath } from "#lint/paths.ts"
import type { Start } from "#lint/types.ts"
import type { Report } from "#shared/finding.ts"

type Registrar = SuperlintOptions["testCaseIsSearch"]["registrars"][number]

/** A value that is there, as a filterMap keeps it. */
const present = <A>(value: A | undefined): Result.Result<A, void> =>
	value === undefined ? Result.failVoid : Result.succeed(value)

/** What one symbol's declarations name: whether one of them names a search, and the other symbols they name. */
type Edges = Readonly<{ search: boolean; next: ReadonlyArray<NativeSymbol> }>

/** The searches the options name, as the program holds them: their symbols, the modules that declare them, by their
 * paths in lower case, the scaffolds' symbols, and the reports for what the program does not hold. */
type Searches = Readonly<{
	ids: ReadonlySet<number>
	modules: ReadonlySet<string>
	scaffolds: ReadonlySet<number>
	misconfigured: ReadonlyArray<string>
}>

/** The declarations whose body or value runs when the name they declare is used: a function's, a method's or an
 * accessor's body, a variable's, a property's or an export's value, a class, and a destructured name's source. */
const RUNNING_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
	ts.SyntaxKind.FunctionDeclaration,
	ts.SyntaxKind.FunctionExpression,
	ts.SyntaxKind.ArrowFunction,
	ts.SyntaxKind.MethodDeclaration,
	ts.SyntaxKind.Constructor,
	ts.SyntaxKind.GetAccessor,
	ts.SyntaxKind.SetAccessor,
	ts.SyntaxKind.VariableDeclaration,
	ts.SyntaxKind.PropertyDeclaration,
	ts.SyntaxKind.PropertyAssignment,
	ts.SyntaxKind.ShorthandPropertyAssignment,
	ts.SyntaxKind.BindingElement,
	ts.SyntaxKind.ClassDeclaration,
	ts.SyntaxKind.ClassExpression,
	ts.SyntaxKind.ExportAssignment
])

/** Whether a declaration runs code the checker can read: its kind is one that runs, and it is the program's own. */
const isRunning = (handle: NodeHandle): boolean =>
	RUNNING_KINDS.has(handle.kind) && isOwnSourcePath(handle.path)

/** The variable a destructured name is bound by: the nearest variable declaration above it. */
const bindingSourceOf = (element: ts.Node): ReadonlyArray<ts.Node> => {
	for (let at: ts.Node = element.parent; !ts.isSourceFile(at); at = at.parent) {
		if (ts.isVariableDeclaration(at)) {
			return at.initializer === undefined ? [] : [at.initializer]
		}
		if (ts.isParameterDeclaration(at)) {
			return []
		}
	}
	return []
}

/** The code a declaration runs: a function's body, the value a variable, a property or an export holds, a class's
 * members, the value a destructured name is read from. */
const codeOf = (declaration: ts.Node): ReadonlyArray<ts.Node> => {
	if (ts.isFunctionLikeDeclaration(declaration)) {
		return declaration.body === undefined ? [] : [declaration.body]
	}
	if (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) {
		return declaration.initializer === undefined ? [] : [declaration.initializer]
	}
	if (ts.isPropertyAssignment(declaration)) {
		return [declaration.initializer]
	}
	if (ts.isExportAssignment(declaration)) {
		return [declaration.expression]
	}
	if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
		return [declaration]
	}
	return ts.isBindingElement(declaration) ? bindingSourceOf(declaration) : []
}

/** Every identifier in the code, outside the types it writes, where a name is no use of a value. */
const identifiersIn = (code: ReadonlyArray<ts.Node>): ReadonlyArray<ts.Identifier> => {
	const found: Array<ts.Identifier> = []
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) {
			found.push(node)
			return
		}
		if (ts.isTypeNode(node)) {
			return
		}
		node.forEachChild(visit)
	}
	for (const node of code) {
		visit(node)
	}
	return found
}

/** The name a declaration that may hold a signature declares: an interface's, a type alias's, a property's, a
 * method's, a variable's or a function's, when it is an identifier. */
const declaredNameOf = (node: ts.Node): Option.Option<string> => {
	if (
		(ts.isInterfaceDeclaration(node) ||
			ts.isTypeAliasDeclaration(node) ||
			ts.isPropertySignatureDeclaration(node) ||
			ts.isMethodSignatureDeclaration(node) ||
			ts.isVariableDeclaration(node) ||
			ts.isFunctionDeclaration(node)) &&
		node.name !== undefined &&
		ts.isIdentifier(node.name)
	) {
		return Option.some(node.name.text)
	}
	return Option.none()
}

/** The name of the nearest declaration that holds a signature: the signature's own, or the one it is written in. */
const holderNameOf = (signature: ts.Node): Option.Option<string> => {
	for (let at: ts.Node = signature; !ts.isSourceFile(at); at = at.parent) {
		const name = declaredNameOf(at)
		if (Option.isSome(name)) {
			return name
		}
	}
	return Option.none()
}

/** Whether a call's value is dropped: a statement's whole expression, or an arrow function's whole body. A test
 * registrar answers nothing, so it is called this way. */
const isDropped = (call: ts.CallExpression): boolean =>
	ts.isExpressionStatement(call.parent) ||
	(ts.isArrowFunction(call.parent) && call.parent.body === call)

/**
 * Which symbols reach a search, for one program: a symbol reaches one when the code a declaration of it runs names a
 * search, or names a symbol that reaches one, in any module of the program's own source. A declaration of an installed
 * package or a declaration file runs no code the checker can read, and a parameter's value is its caller's. Code names
 * what its module imports, so a declaration whose module imports no module of a search, directly or through the
 * modules it imports, never reaches one and is not read: the code under test, which never imports the testing
 * library, costs one checker call per module. Each symbol's names are read once per run, with one checker call for its
 * code, and a symbol whose reach is settled is never read again: a breadth-first walk that finds no search has read
 * every symbol it met to the end, so each is settled as reaching none, and one that finds a search settles the symbols
 * on the path that led to it.
 */
const reachOf = (checker: Checker) => {
	const targets = new Map<number, NativeSymbol>()
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
	/**
	 * The symbols code uses, from its identifiers and the symbols the checker binds at them, aliases resolved. The
	 * receiver of a member that is the program's own code (`suites.example`) is left out, since the member alone runs;
	 * the receiver of any other member (`search.pipe`) is a value whose code runs.
	 */
	const used = (
		identifiers: ReadonlyArray<ts.Identifier>,
		symbols: ReadonlyArray<NativeSymbol | undefined>
	): ReadonlyArray<NativeSymbol> => {
		const bound = new Map<ts.Node, NativeSymbol | undefined>(Arr.zip(identifiers, symbols))
		const isOwnMember = (member: ts.Node): boolean => {
			const symbol = bound.get(member)
			return symbol !== undefined && Arr.some(aliasTarget(symbol).declarations, isRunning)
		}
		return Arr.dedupeWith(
			Arr.filterMap(Arr.zip(identifiers, symbols), ([identifier, symbol]) => {
				const { parent } = identifier
				if (
					symbol === undefined ||
					(ts.isPropertyAccessExpression(parent) &&
						parent.expression === identifier &&
						isOwnMember(parent.name))
				) {
					return Result.failVoid
				}
				return Result.succeed(aliasTarget(symbol))
			}),
			(a, b) => a.id === b.id
		)
	}
	const usedIn = (code: ReadonlyArray<ts.Node>): ReadonlyArray<NativeSymbol> => {
		const identifiers = identifiersIn(code)
		return Arr.isReadonlyArrayNonEmpty(identifiers)
			? used(identifiers, checker.getSymbolAtLocation(identifiers))
			: []
	}
	const imported = new Map<string, ReadonlyArray<ts.SourceFile>>()
	/** The modules of the program's own source a module imports or re-exports from, as the checker resolves them. */
	const importsOf = (file: ts.SourceFile): ReadonlyArray<ts.SourceFile> => {
		const known = imported.get(file.fileName)
		if (known !== undefined) {
			return known
		}
		const specifiers = Arr.filterMap(file.statements, (statement) =>
			(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
			statement.moduleSpecifier !== undefined
				? Result.succeed(statement.moduleSpecifier)
				: Result.failVoid
		)
		const modules = Arr.isReadonlyArrayNonEmpty(specifiers)
			? checker.getSymbolAtLocation(specifiers)
			: []
		const files = Arr.filterMap(modules, (module) =>
			Option.match(
				Arr.findFirst(
					module?.declarations ?? [],
					(declaration) =>
						declaration.kind === ts.SyntaxKind.SourceFile && isOwnSourcePath(declaration.path)
				),
				{
					onNone: () => Result.failVoid,
					onSome: (declaration) => {
						const node = declaration.resolve()
						return node !== undefined && ts.isSourceFile(node)
							? Result.succeed(node)
							: Result.failVoid
					}
				}
			)
		)
		imported.set(file.fileName, files)
		return files
	}
	const importing = new Map<string, boolean>()
	/** Whether a module is a search's, or imports one through the modules it imports. A walk that finds none has read
	 * every module it met to the end, so each is settled as importing none. */
	const importsSearch = (file: ts.SourceFile, modules: ReadonlySet<string>): boolean => {
		const known = importing.get(file.fileName)
		if (known !== undefined) {
			return known
		}
		const met = new Set<string>([file.fileName])
		const queue: Array<ts.SourceFile> = [file]
		for (const at of queue) {
			if (modules.has(Str.toLowerCase(at.fileName)) || importing.get(at.fileName) === true) {
				importing.set(file.fileName, true)
				return true
			}
			if (importing.get(at.fileName) === false) {
				continue
			}
			for (const next of importsOf(at)) {
				if (!met.has(next.fileName)) {
					met.add(next.fileName)
					queue.push(next)
				}
			}
		}
		for (const name of met) {
			importing.set(name, false)
		}
		return false
	}
	const edges = new Map<number, Edges>()
	const edgesOf = (symbol: NativeSymbol, searches: Searches): Edges => {
		const known = edges.get(symbol.id)
		if (known !== undefined) {
			return known
		}
		const declarations = Arr.filter(
			Arr.filterMap(Arr.filter(symbol.declarations, isRunning), (handle) =>
				present(handle.resolve())
			),
			(declaration) => importsSearch(declaration.getSourceFile(), searches.modules)
		)
		const shorthands = Arr.filterMap(declarations, (declaration) =>
			ts.isShorthandPropertyAssignment(declaration)
				? present(checker.getShorthandAssignmentValueSymbol(declaration))
				: Result.failVoid
		)
		const next = [...usedIn(Arr.flatMap(declarations, codeOf)), ...Arr.map(shorthands, aliasTarget)]
		const found: Edges = {
			search: Arr.some(next, (reached) => searches.ids.has(reached.id)),
			next: Arr.filter(
				next,
				(reached) =>
					!searches.ids.has(reached.id) &&
					!searches.scaffolds.has(reached.id) &&
					reached.id !== symbol.id
			)
		}
		edges.set(symbol.id, found)
		return found
	}
	const settled = new Map<number, boolean>()
	const settlePath = (parents: ReadonlyMap<number, number | undefined>, from: number): void => {
		for (let at: number | undefined = from; at !== undefined; at = parents.get(at)) {
			settled.set(at, true)
		}
	}
	/** Whether code whose names are `named` reaches a search, never through a scaffold. */
	const reaches = (named: ReadonlyArray<NativeSymbol>, searches: Searches): boolean => {
		if (Arr.some(named, (symbol) => searches.ids.has(symbol.id))) {
			return true
		}
		const start = Arr.filter(named, (symbol) => !searches.scaffolds.has(symbol.id))
		const parents = new Map<number, number | undefined>()
		const queue: Array<NativeSymbol> = []
		for (const symbol of start) {
			if (!parents.has(symbol.id)) {
				parents.set(symbol.id, undefined)
				queue.push(symbol)
			}
		}
		for (const symbol of queue) {
			const known = settled.get(symbol.id)
			if (known === true) {
				settlePath(parents, symbol.id)
				return true
			}
			if (known === false) {
				continue
			}
			const { search, next } = edgesOf(symbol, searches)
			if (search) {
				settlePath(parents, symbol.id)
				return true
			}
			for (const reached of next) {
				if (!parents.has(reached.id)) {
					parents.set(reached.id, symbol.id)
					queue.push(reached)
				}
			}
		}
		for (const id of parents.keys()) {
			settled.set(id, false)
		}
		return false
	}
	return { aliasTarget, used, reaches }
}

/**
 * test-case-is-search: every test case runs a search. A test is an example when a person chose its inputs and wrote
 * its verdict, and examples are banned: a case's body must run one of the searches the options name (`explore`,
 * `exhaust`, `interleave`, whose kept cases, floor and streams, or enumeration, choose the inputs and whose oracle gives
 * the verdict), directly or through any function, in any module of the program's own source, whose code does,
 * transitively. A scaffold the options name, with its reason, is no way to one: it runs a search around a scenario a
 * person wrote, over draws that are not the case's inputs (planted schedules draw the keys a hand-written race runs
 * on), so a case that reaches a search only through a scaffold is an example.
 *
 * A test case is a call the checker resolves to a signature of an installed package's declaration the options name as
 * a registrar (`@effect/vitest`'s `Test`, the signature `it.effect`, `it.live` and a layer's `it.effect` share;
 * vitest's `TestCollectorCallable`, the signature of `it` and `test`), whose value is dropped, as a registration's is.
 * Its body is every argument after its title. Names are resolved through the checker, import aliases followed, never
 * by their spelling, and a search is the very symbol a configured module exports. A name's code is what its declaration
 * runs: a function's body, a constant's or a property's value. A parameter's value is its caller's, so a case whose
 * search arrives as an argument is read where the caller writes it, never here. The files the options exempt (the
 * README mirror, the bench gates, the type batch runners) are not read; each exemption states its reason.
 */
export const testCaseIsSearch: Start = ({ checker }) => {
	const reach = reachOf(checker)
	let searches = Option.none<Searches>()
	const searchesOf = (
		fileName: string,
		declared: SuperlintOptions["testCaseIsSearch"]
	): Searches => {
		if (Option.isSome(searches)) {
			return searches.value
		}
		const values = declaredValuesOf({
			checker,
			fileName,
			declared: Arr.flatMap(declared.searches, ({ module, names }) =>
				Arr.map(names, (name) => ({ module, name }))
			)
		})
		const scaffolds = declaredValuesOf({
			checker,
			fileName,
			declared: Arr.flatMap(declared.scaffolds, ({ module, names }) =>
				Arr.map(names, (name) => ({ module, name }))
			)
		})
		const resolved: Searches = {
			ids: new Set(Arr.map(values.found, ({ symbol }) => symbol.id)),
			modules: new Set(
				Arr.flatMap(values.found, ({ symbol }) =>
					Arr.map(symbol.declarations, (declaration) => Str.toLowerCase(declaration.path))
				)
			),
			scaffolds: new Set(Arr.map(scaffolds.found, ({ symbol }) => symbol.id)),
			misconfigured: [
				...Arr.map(values.missing, (missing) =>
					missingValueMessage("testCaseIsSearch.searches", missing)
				),
				...Arr.map(scaffolds.missing, (missing) =>
					missingValueMessage("testCaseIsSearch.scaffolds", missing)
				)
			]
		}
		searches = Option.some(resolved)
		return resolved
	}
	return ({ sourceFile, semantics, options, root }) => {
		const { files, registrars, exempt } = options.testCaseIsSearch
		const { fileName } = sourceFile
		if (
			!isAtAny(root, files, fileName) ||
			isAtAny(
				root,
				Arr.flatMap(exempt, (exemption) => exemption.files),
				fileName
			)
		) {
			return () => []
		}
		const registrarOf = (handle: NodeHandle): ReadonlyArray<Registrar> =>
			Arr.filter(registrars, (registrar) => isPackagePath(handle.path, registrar.package))
		/** Whether a callee may be a registrar, before its signature is resolved: a name an installed registrar
		 * declares, a parameter (the `it` a layer hands its suite), or a member the checker gives no declaration (a
		 * chained modifier of a mapped type). */
		const mayRegister = (call: ts.CallExpression): boolean => {
			const callee = semantics.symbolAt(call.expression)
			if (callee === undefined) {
				return true
			}
			const { declarations } = reach.aliasTarget(callee)
			return (
				!Arr.isReadonlyArrayNonEmpty(declarations) ||
				Arr.some(
					declarations,
					(declaration) =>
						declaration.kind === ts.SyntaxKind.Parameter ||
						Arr.isReadonlyArrayNonEmpty(registrarOf(declaration))
				)
			)
		}
		const isCase = (call: ts.CallExpression): boolean => {
			if (!isDropped(call) || !mayRegister(call)) {
				return false
			}
			const handle = checker.getResolvedSignature(call).declaration
			if (handle === undefined) {
				return false
			}
			const candidates = registrarOf(handle)
			if (!Arr.isReadonlyArrayNonEmpty(candidates)) {
				return false
			}
			const signature = handle.resolve()
			return (
				signature !== undefined &&
				Option.exists(holderNameOf(signature), (name) =>
					Arr.some(candidates, (registrar) => Arr.contains(registrar.declarations, name))
				)
			)
		}
		let reported = false
		return (node) => {
			if (!ts.isCallExpression(node) || !isCase(node)) {
				return []
			}
			const found = searchesOf(fileName, options.testCaseIsSearch)
			const { misconfigured } = found
			const misconfiguration = reported
				? []
				: Arr.map(misconfigured, (message): Report => ({ node, message }))
			reported = true
			const body = identifiersIn(Arr.drop(node.arguments, 1))
			const start = reach.used(body, Arr.map(body, semantics.symbolAt))
			if (reach.reaches(start, found)) {
				return misconfiguration
			}
			return [
				...misconfiguration,
				{
					node,
					message:
						"This test case runs no search: a person chose its inputs and wrote its verdict, so it is an example, and examples are banned.",
					suggestion:
						"State the property against an oracle and search it with explore, exhaust, commands or interleave from @grizzle/testing, or delete the case if a search already catches what it catches."
				}
			]
		}
	}
}
