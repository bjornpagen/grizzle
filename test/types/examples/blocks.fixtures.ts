import { regex } from "arkregex"
import { Array as Arr, Effect, FileSystem, Path, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import { indices } from "#compiler/core/array.ts"
import { type SyntaxSource, withNativeSyntax } from "#scripts/dev/shared/native-syntax.ts"
import { blocksOf, type DocumentedBlock, type Mirror } from "#test/types/examples/documents.ts"

/**
 * A documented ts block against its fixture (blocks.test.ts): the block's rules, each a mismatch printed with its
 * document's line.
 * - a block imports nothing through a # subpath, which resolves only inside grizzle's own package: a reader imports
 *   grizzle's public names from @bjornpagen/grizzle;
 * - every name a block imports from a package is imported by the fixture from that package, by its exported name;
 * - a snapshot a block imports (a relative .json module) is declared in the fixture, `declare const <binding>`;
 * - every name a block imports from the reader's own modules is bound at the fixture's top level;
 * - every other non-blank line of a block occurs as a line of the fixture, after the line the previous block line
 *   matched, the blocks before it in document order matched first.
 */

/** A block or a fixture, as the native parser reads it. */
type Input =
	| Readonly<{ kind: "block"; file: string; text: string; where: string; firstLine: number }>
	| Readonly<{ kind: "fixture"; file: string; text: string }>

type BlockInput = Extract<Input, { kind: "block" }>

/** The names a binding pattern binds; an element the parser gave no name binds none. */
const boundNames = (name: ts.BindingName): ReadonlyArray<string> => {
	if (ts.isIdentifier(name)) {
		return [name.text]
	}
	return Arr.flatMap(name.elements, (element) =>
		ts.isOmittedExpression(element) || element.name === undefined ? [] : boundNames(element.name)
	)
}

const isDeclared = (statement: ts.VariableStatement): boolean =>
	statement.modifiers !== undefined &&
	Arr.some(statement.modifiers, (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)

/**
 * An import declaration's specifier and its bindings: each binding's exported name (default for a default import, *
 * for a namespace) and its local name.
 */
interface Imported {
	readonly specifier: string
	readonly bindings: ReadonlyArray<{ readonly exported: string; readonly local: string }>
}

const importOf = (statement: ts.ImportDeclaration): Imported => {
	if (!ts.isStringLiteral(statement.moduleSpecifier)) {
		throw new Error("an import declaration's module specifier is a string literal")
	}
	const specifier = statement.moduleSpecifier.text
	const clause = statement.importClause
	if (clause === undefined) {
		return { specifier, bindings: [] }
	}
	const named = clause.namedBindings
	const namedBindings =
		named === undefined
			? []
			: ts.isNamespaceImport(named)
				? [{ exported: "*", local: named.name.text }]
				: Arr.map(named.elements, (element) => ({
						exported: (element.propertyName ?? element.name).text,
						local: element.name.text
					}))
	return {
		specifier,
		bindings: [
			...(clause.name === undefined ? [] : [{ exported: "default", local: clause.name.text }]),
			...namedBindings
		]
	}
}

/**
 * What a file's top level binds: its import bindings and its declarations, which of them `declare const` binds, and,
 * by module specifier, the exported names it imports.
 */
interface TopLevel {
	readonly bound: ReadonlySet<string>
	readonly declared: ReadonlySet<string>
	readonly imported: ReadonlyMap<string, ReadonlySet<string>>
}

const topLevelOf = (sourceFile: ts.SourceFile): TopLevel => {
	const bound = new Set<string>()
	const declared = new Set<string>()
	const imported = new Map<string, Set<string>>()
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			const { specifier, bindings } = importOf(statement)
			const names = imported.get(specifier) ?? new Set<string>()
			for (const { exported, local } of bindings) {
				names.add(exported)
				bound.add(local)
			}
			imported.set(specifier, names)
		} else if (ts.isVariableStatement(statement)) {
			const names = Arr.flatMap(statement.declarationList.declarations, (d) => boundNames(d.name))
			for (const name of names) {
				bound.add(name)
			}
			if (isDeclared(statement)) {
				for (const name of names) {
					declared.add(name)
				}
			}
		} else if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isEnumDeclaration(statement)) &&
			statement.name !== undefined
		) {
			bound.add(statement.name.text)
		}
	}
	return { bound, declared, imported }
}

/** The 0-based line a position is on. */
const lineOf = (sourceFile: ts.SourceFile, position: number): number =>
	sourceFile.getLineAndCharacterOfPosition(position).line

/** A block's import declarations. */
const importsOf = (block: SyntaxSource<BlockInput>): ReadonlyArray<ts.ImportDeclaration> =>
	Arr.filter(block.sourceFile.statements, ts.isImportDeclaration)

/** A block's import declarations against its fixture's top level, by the kind of module each names. */
const importMismatches = (
	block: SyntaxSource<BlockInput>,
	mirror: Mirror,
	fixture: TopLevel
): ReadonlyArray<string> =>
	Arr.flatMap(importsOf(block), (statement) => {
		const { specifier, bindings } = importOf(statement)
		const at = `${block.where} line ${block.firstLine + lineOf(block.sourceFile, statement.getStart(block.sourceFile))}`
		if (Str.startsWith("#")(specifier)) {
			return [
				`${at}: "${specifier}" is a subpath import of grizzle's own, which no reader resolves`
			]
		}
		if (!Str.startsWith(".")(specifier)) {
			return Arr.flatMap(bindings, ({ exported }) =>
				fixture.imported.get(specifier)?.has(exported) === true
					? []
					: [`${at}: ${mirror.fixture} does not import ${exported} from "${specifier}"`]
			)
		}
		if (Str.endsWith(".json")(specifier)) {
			return Arr.flatMap(bindings, ({ local }) =>
				fixture.declared.has(local)
					? []
					: [`${at}: ${mirror.fixture} does not declare const ${local}`]
			)
		}
		return Arr.flatMap(bindings, ({ local }) =>
			fixture.bound.has(local)
				? []
				: [`${at}: ${mirror.fixture} binds no ${local} at its top level`]
		)
	})

/** The 0-based block lines its import declarations span, which the line rule leaves to the import rules. */
const importLines = (block: SyntaxSource<BlockInput>): ReadonlySet<number> =>
	new Set(
		Arr.flatMap(importsOf(block), (statement) => {
			const first = lineOf(block.sourceFile, statement.getStart(block.sourceFile))
			const last = lineOf(block.sourceFile, statement.getEnd())
			return Arr.map(indices(last - first + 1), (i) => first + i)
		})
	)

const trimmedEnd = (line: string): string => Str.replace(regex("\\s+$"), "")(line)

/**
 * A block's lines against the fixture's, from the fixture line after `cursor`: each non-blank line that is no import
 * found in order, or a mismatch; and the fixture line the block's last found line matched.
 */
const linesMatched = (
	block: SyntaxSource<BlockInput>,
	fixtureLines: ReadonlyArray<string>,
	cursor: number
): Readonly<{ mismatches: ReadonlyArray<string>; cursor: number }> => {
	const imports = importLines(block)
	let at = cursor
	const mismatches = Arr.flatMap(Str.split(block.text, "\n"), (text, n): ReadonlyArray<string> => {
		const line = trimmedEnd(text)
		if (Str.trim(line) === "" || imports.has(n)) {
			return []
		}
		const found = fixtureLines.indexOf(line, at + 1)
		if (found === -1) {
			return [`${block.where} line ${block.firstLine + n}: ${line}`]
		}
		at = found
		return []
	})
	return { mismatches, cursor: at }
}

/**
 * The mismatches of the documented block `block` against its fixture, both read from the checkout at `checkout`: its
 * parse errors, its imports, and its lines, found after the fixture line the blocks before it in its document matched
 * last.
 */
export const blockMismatches = (checkout: string, block: DocumentedBlock) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const { mirror, at } = block
		const doc = yield* fs.readFileString(path.join(checkout, mirror.doc))
		const fixtureText = yield* fs.readFileString(path.join(checkout, mirror.fixture))
		const read = blocksOf(mirror.doc, doc)
		if (Result.isFailure(read)) {
			return [read.failure]
		}
		const before = Arr.take(read.success, at + 1)
		if (before.length <= at) {
			return [`${mirror.doc} holds no ts block ${at + 1}`]
		}
		const inputs: ReadonlyArray<Input> = [
			...Arr.map(before, (b, n): BlockInput => ({
				kind: "block",
				file: `${mirror.doc} block ${n + 1}`,
				text: b.text,
				where: `${mirror.doc} block ${n + 1}`,
				firstLine: b.firstLine
			})),
			{ kind: "fixture", file: mirror.fixture, text: fixtureText }
		]
		return withNativeSyntax(inputs, (sources) => {
			const blocks = Arr.flatMap(sources, (s) => (s.kind === "block" ? [s] : []))
			const fixtures = Arr.flatMap(sources, (s) => (s.kind === "fixture" ? [s] : []))
			return Arr.match(fixtures, {
				onEmpty: () => [`${mirror.fixture}: not parsed`],
				onNonEmpty: ([fixture]) => {
					const fixtureLines = Arr.map(Str.split(fixture.text, "\n"), trimmedEnd)
					const cursor = Arr.reduce(
						Arr.take(blocks, at),
						-1,
						(from, earlier) => linesMatched(earlier, fixtureLines, from).cursor
					)
					return Arr.flatMap(Arr.drop(blocks, at), (own) => [
						...Arr.map(own.diagnostics, (d) => `${own.where}: ${d.text}`),
						...importMismatches(own, mirror, topLevelOf(fixture.sourceFile)),
						...linesMatched(own, fixtureLines, cursor).mismatches
					])
				}
			})
		})
	})
