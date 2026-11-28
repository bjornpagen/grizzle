import { indices } from "@bjornpagen/grizzle-text/base/array"
import { regex } from "arkregex"
import { Array as Arr, Effect, FileSystem, Path, Result, String as Str } from "effect"
import * as ts from "typescript/ast"
import { type SyntaxSource, withNativeSyntax } from "#scripts/dev/shared/native-syntax.ts"
import { blocksOf, type DocumentedBlock } from "#test/types/examples/documents.ts"

/**
 * A documented ts block against its document's fixtures (blocks.test.ts): the block's rules, each a mismatch printed
 * with its document's line.
 * - every non-blank line of a block that is no import occurs as a line of exactly one of the fixtures, the block's own,
 *   after the line the previous block line matched there, the blocks before it in document order matched first, each
 *   in its own fixture: a block found in none, or in two, is mirrored nowhere;
 * - a block imports nothing through a # subpath, which resolves only inside grizzle's own package: a reader imports
 *   grizzle's public names from @bjornpagen/grizzle;
 * - every name a block imports from a package is imported by its fixture from that package, by its exported name;
 * - a served file a block imports (a relative .json module) is declared in its fixture, `declare const <binding>`;
 * - every name a block imports from the reader's own modules is bound at its fixture's top level.
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
	file: string,
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
					: [`${at}: ${file} does not import ${exported} from "${specifier}"`]
			)
		}
		if (Str.endsWith(".json")(specifier)) {
			return Arr.flatMap(bindings, ({ local }) =>
				fixture.declared.has(local) ? [] : [`${at}: ${file} does not declare const ${local}`]
			)
		}
		return Arr.flatMap(bindings, ({ local }) =>
			fixture.bound.has(local) ? [] : [`${at}: ${file} binds no ${local} at its top level`]
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
 * A block's lines against a fixture's, from the fixture line after `cursor`: the non-blank lines that are no import found
 * in order, the fixture line the last of them matched, and the block lines found nowhere after it.
 */
const linesMatched = (
	block: SyntaxSource<BlockInput>,
	fixtureLines: ReadonlyArray<string>,
	cursor: number
): Readonly<{ missing: ReadonlyArray<string>; cursor: number }> => {
	const imports = importLines(block)
	let at = cursor
	const missing = Arr.flatMap(Str.split(block.text, "\n"), (text, n): ReadonlyArray<string> => {
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
	return { missing, cursor: at }
}

/** A fixture as the blocks are matched against it: its file, its lines, its top level and its cursor. */
interface Placed {
	readonly file: string
	readonly lines: ReadonlyArray<string>
	readonly top: TopLevel
	readonly cursor: number
}

/**
 * Where a block is mirrored: the one fixture that holds every line of it in order after its cursor, with its cursor moved
 * past the block, or the mismatch of a block found in none (its lines missing from the fixture that holds most of them)
 * or in more than one.
 */
const placeOf = (
	block: SyntaxSource<BlockInput>,
	fixtures: ReadonlyArray<Placed>
): Result.Result<Readonly<{ at: number; cursor: number }>, ReadonlyArray<string>> => {
	const tried = Arr.map(fixtures, (fixture) => linesMatched(block, fixture.lines, fixture.cursor))
	const holding = Arr.filter(
		indices(fixtures.length),
		(i) => Arr.getUnsafe(tried, i).missing.length === 0
	)
	if (holding.length === 1) {
		const at = Arr.getUnsafe(holding, 0)
		return Result.succeed({ at, cursor: Arr.getUnsafe(tried, at).cursor })
	}
	if (holding.length > 1) {
		return Result.fail([
			`${block.where}: found in ${Arr.join(
				Arr.map(holding, (i) => Arr.getUnsafe(fixtures, i).file),
				" and "
			)}, where a block is mirrored in exactly one fixture`
		])
	}
	const nearest = Arr.reduce(tried, Arr.getUnsafe(tried, 0), (best, next) =>
		next.missing.length < best.missing.length ? next : best
	)
	return Result.fail(nearest.missing)
}

/**
 * The mismatches of the documented block `block` against its document's fixtures, all read from the checkout at
 * `checkout`: its parse errors, its lines, found in one fixture after the line the blocks before it in its document
 * matched last there, and its imports against that fixture.
 */
export const blockMismatches = (checkout: string, block: DocumentedBlock) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const { mirror, at } = block
		const doc = yield* fs.readFileString(path.join(checkout, mirror.doc))
		const fixtureTexts = yield* Effect.forEach(mirror.fixtures, (file) =>
			Effect.map(fs.readFileString(path.join(checkout, file)), (text) => ({ file, text }))
		)
		const read = blocksOf(mirror.doc, doc, "ts")
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
			...Arr.map(fixtureTexts, ({ file, text }): Input => ({ kind: "fixture", file, text }))
		]
		return withNativeSyntax(inputs, (sources) => {
			const blocks = Arr.flatMap(sources, (s) => (s.kind === "block" ? [s] : []))
			const fixtures = Arr.flatMap(sources, (s): ReadonlyArray<Placed> =>
				s.kind === "fixture"
					? [
							{
								file: s.file,
								lines: Arr.map(Str.split(s.text, "\n"), trimmedEnd),
								top: topLevelOf(s.sourceFile),
								cursor: -1
							}
						]
					: []
			)
			if (fixtures.length !== mirror.fixtures.length) {
				return [`${Arr.join(mirror.fixtures, ", ")}: not parsed`]
			}
			const placed = Arr.reduce(Arr.take(blocks, at), fixtures, (state, earlier) =>
				Result.match(placeOf(earlier, state), {
					onFailure: () => state,
					onSuccess: ({ at: i, cursor }) =>
						Arr.map(state, (fixture, j) => (j === i ? { ...fixture, cursor } : fixture))
				})
			)
			return Arr.flatMap(Arr.drop(blocks, at), (own) => [
				...Arr.map(own.diagnostics, (d) => `${own.where}: ${d.text}`),
				...Result.match(placeOf(own, placed), {
					onFailure: (mismatches) => mismatches,
					onSuccess: ({ at: i }) => {
						const fixture = Arr.getUnsafe(placed, i)
						return importMismatches(own, fixture.file, fixture.top)
					}
				})
			])
		})
	})
