import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect"
import * as ts from "typescript/ast"
import { indices } from "#compiler/core/array.ts"
import {
	packageRoot,
	type SyntaxSource,
	withNativeSyntax
} from "#scripts/dev/shared/native-syntax.ts"
import { assert } from "#test/support/assert.ts"

import { regex } from "arkregex"
/**
 * README.md's and packages/grizzle/skills/grizzle/SKILL.md's ```ts blocks are checked code. Each block is mirrored, line for line and in
 * order, in a fixture of the examples type-test unit: README.md in fixtures/readme.ts, SKILL.md in fixtures/skill.ts.
 * The examples batch unit (examples.test.ts) and `pnpm typecheck` (`tsrs -b`) typecheck the fixtures, and this test
 * holds every block to its fixture:
 * - a block imports nothing through a # subpath, which resolves only inside grizzle's own package: a reader imports
 *   grizzle's public names from @bjornpagen/grizzle;
 * - every name a block imports from a package is imported by the fixture from that package, by its exported name;
 * - a snapshot a block imports (a relative .json module) is declared in the fixture, `declare const <binding>`;
 * - every name a block imports from the reader's own modules is bound at the fixture's top level;
 * - every other non-blank line of a block occurs as a line of the fixture, after the previous block line's match,
 *   blocks in document order.
 * So an edit to a block alone fails here, and an edit that breaks a mirrored line fails the typecheck.
 */
const mirrors = [
	{ doc: "README.md", fixture: "test/types/examples/fixtures/readme.ts" },
	{
		doc: "packages/grizzle/skills/grizzle/SKILL.md",
		fixture: "test/types/examples/fixtures/skill.ts"
	}
] as const

type Mirror = (typeof mirrors)[number]

/**
 * A block: the lines strictly between a line that is exactly "```ts" and the next line that is exactly "```". No other
 * fence is a block. `where` names it in a mismatch, and `firstLine` is the document line its first line is on.
 */
interface BlockInput {
	readonly kind: "block"
	readonly file: string
	readonly text: string
	readonly mirror: Mirror
	readonly where: string
	readonly firstLine: number
}

interface FixtureInput {
	readonly kind: "fixture"
	readonly file: string
	readonly text: string
	readonly mirror: Mirror
}
type Input = BlockInput | FixtureInput

const fence = "```ts"

/** A document's blocks, from its text, and why it has none to check. */
const blocksOf = (
	mirror: Mirror,
	text: string
): { readonly blocks: ReadonlyArray<BlockInput>; readonly mismatches: ReadonlyArray<string> } => {
	const lines = Str.split(text, "\n")
	const blocks: Array<BlockInput> = []
	const mismatches: Array<string> = []
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] !== fence) {
			continue
		}
		const end = lines.indexOf("```", i + 1)
		if (end === -1) {
			mismatches.push(`${mirror.doc} line ${i + 1}: a ts block with no closing fence`)
			break
		}
		const where = `${mirror.doc} block ${blocks.length + 1}`
		blocks.push({
			kind: "block",
			file: where,
			text: Arr.join(lines.slice(i + 1, end), "\n"),
			mirror,
			where,
			firstLine: i + 2
		})
		i = end
	}
	if (blocks.length === 0) {
		mismatches.push(`${mirror.doc}: no ts block`)
	}
	return { blocks, mismatches }
}

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
	fixture: TopLevel
): ReadonlyArray<string> =>
	Arr.flatMap(importsOf(block), (statement) => {
		const { specifier, bindings } = importOf(statement)
		const at = `${block.where} line ${block.firstLine + lineOf(block.sourceFile, statement.getStart(block.sourceFile))}`
		const fixtureFile = block.mirror.fixture
		if (Str.startsWith("#")(specifier)) {
			return [
				`${at}: "${specifier}" is a subpath import of grizzle's own, which no reader resolves`
			]
		}
		if (!Str.startsWith(".")(specifier)) {
			return Arr.flatMap(bindings, ({ exported }) =>
				fixture.imported.get(specifier)?.has(exported) === true
					? []
					: [`${at}: ${fixtureFile} does not import ${exported} from "${specifier}"`]
			)
		}
		if (Str.endsWith(".json")(specifier)) {
			return Arr.flatMap(bindings, ({ local }) =>
				fixture.declared.has(local) ? [] : [`${at}: ${fixtureFile} does not declare const ${local}`]
			)
		}
		return Arr.flatMap(bindings, ({ local }) =>
			fixture.bound.has(local) ? [] : [`${at}: ${fixtureFile} binds no ${local} at its top level`]
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

/** Every block of one document against its fixture, in document order. */
const mirrorMismatches = (
	blocks: ReadonlyArray<SyntaxSource<BlockInput>>,
	fixture: SyntaxSource<FixtureInput>
): ReadonlyArray<string> => {
	const top = topLevelOf(fixture.sourceFile)
	const fixtureLines = Arr.map(Str.split(fixture.text, "\n"), trimmedEnd)
	/** The fixture line the previous block line matched; the next one must match after it. */
	let cursor = -1
	return Arr.flatMap(blocks, (block) => {
		const imports = importLines(block)
		const lines = Arr.flatMap(Str.split(block.text, "\n"), (text, n): ReadonlyArray<string> => {
			const line = trimmedEnd(text)
			if (Str.trim(line) === "" || imports.has(n)) {
				return []
			}
			const found = fixtureLines.indexOf(line, cursor + 1)
			if (found === -1) {
				return [`${block.where} line ${block.firstLine + n}: ${line}`]
			}
			cursor = found
			return []
		})
		return [
			...Arr.map(block.diagnostics, (d) => `${block.where}: ${d.text}`),
			...importMismatches(block, top),
			...lines
		]
	})
}

layer(NodeServices.layer, { excludeTestServices: true })(
	"the README's and the skill's ts blocks",
	(it) => {
		it.effect(
			"are each mirrored, line for line and in order, in the typechecked examples fixtures",
			() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const read = (file: string) => fs.readFileString(path.join(packageRoot, file))
					const documents = yield* Effect.forEach(mirrors, (mirror) =>
						Effect.map(read(mirror.doc), (text) => blocksOf(mirror, text))
					)
					const fixtures = yield* Effect.forEach(mirrors, (mirror) =>
						Effect.map(read(mirror.fixture), (text): FixtureInput => ({
							kind: "fixture",
							file: mirror.fixture,
							text,
							mirror
						}))
					)
					const inputs: ReadonlyArray<Input> = [
						...Arr.flatMap(documents, (d) => d.blocks),
						...fixtures
					]
					const mismatches = withNativeSyntax(inputs, (sources) =>
						Arr.flatMap(mirrors, (mirror) => {
							const blocks = Arr.flatMap(sources, (s) =>
								s.kind === "block" && s.mirror === mirror ? [s] : []
							)
							const [fixture] = Arr.flatMap(sources, (s) =>
								s.kind === "fixture" && s.mirror === mirror ? [s] : []
							)
							return fixture === undefined
								? [`${mirror.fixture}: not parsed`]
								: mirrorMismatches(blocks, fixture)
						})
					)
					assert.deepEqual([...Arr.flatMap(documents, (d) => d.mismatches), ...mismatches], [])
				})
		)
	}
)
