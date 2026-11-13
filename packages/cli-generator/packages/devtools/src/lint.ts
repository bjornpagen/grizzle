#!/usr/bin/env -S node

import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Option,
	Path,
	Result,
	Schema,
	String as Str
} from "effect"
import type * as ts from "typescript/ast"
import type { Checker, Project } from "typescript/sync"
import { FIXTURE_OPTIONS, SuperlintOptions } from "#lint/options.ts"
import { isAtAny } from "#lint/paths.ts"
import { RULES } from "#lint/rules/index.ts"
import { tsconfigFindings, workspaceFixtureMismatches } from "#lint/tsconfigs.ts"
import { invocationOf } from "#shared/arguments.ts"
import { DevtoolFailure } from "#shared/devtool.ts"
import { type Finding, findingAt, renderFindings, statusOf } from "#shared/finding.ts"
import { fixtureMismatchesOf, renderFixtureMismatches } from "#shared/fixtures.ts"
import { gitFilesUnder } from "#shared/git.ts"
import { withProgram } from "#shared/native-api.ts"
import {
	covers,
	isGeneratedPath,
	isTypeScriptPath,
	isVendoredPath,
	relativeTo,
	Repository
} from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"
import { selectFiles } from "#shared/selection.ts"
import { prepareSemantics } from "#shared/semantic.ts"
import { isTestFile } from "#shared/tests.ts"

/**
 * Superlint: the repository's opinionated type-aware rules that oxlint has no rule for. It lints the package in the
 * working directory: each workspace package's `superlint` task runs it in the package, and the repository root's runs
 * it at the root, where it also runs the tsconfig gate (`#lint/tsconfigs.ts`) and refuses a JavaScript file. The
 * repository's own names come from the `superlint` field of its root package.json. Explicit paths lint the files at or under them (a file
 * the tsconfig excludes is added to the program); `--fixtures` runs every rule against its fixtures instead. Exit
 * status 1 means findings, 2 that the linter itself failed.
 */

/**
 * One lint run is one package's program: the nearest tsconfig.json at or above the package root, and only the
 * files whose nearest package.json is that package's. A workspace dependency's source the program loads is that
 * dependency's to lint, so no file is reported twice.
 */

const inspectionFailure = (subject: string) => (cause: unknown) =>
	DevtoolFailure.make({ detail: `${subject} could not be inspected`, cause })

/** The repository's options, the `superlint` field of its root package.json. */
const RootManifest = Schema.fromJsonString(Schema.Struct({ superlint: SuperlintOptions }))

const decodeRootManifest = Schema.decodeUnknownEffect(RootManifest)

const projectOptions = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const { root } = yield* Repository
	const manifest = `${root}/package.json`
	const text = yield* fs.readFileString(manifest).pipe(Effect.mapError(inspectionFailure(manifest)))
	const decoded = yield* decodeRootManifest(text).pipe(
		Effect.mapError((cause) =>
			DevtoolFailure.make({
				detail: `${manifest} needs a superlint field holding the repository's superlint options`,
				cause
			})
		)
	)
	const unknown = Arr.filter(
		decoded.superlint.exceptions,
		(exception) => !Arr.some(RULES, (rule) => rule.id === exception.rule)
	)
	if (Arr.isReadonlyArrayNonEmpty(unknown)) {
		return yield* DevtoolFailure.make({
			detail: `${manifest} lists exceptions for rules superlint does not have: ${Arr.join(
				Arr.map(unknown, (exception) => exception.rule),
				", "
			)}`
		})
	}
	const { support, vocabularies } = decoded.superlint.uncheckedVocabularyLiteral
	const absent = yield* Effect.filter(
		[...support, ...Arr.map(vocabularies, (vocabulary) => vocabulary.module)],
		(path) =>
			fs
				.exists(`${root}/${path}`)
				.pipe(
					Effect.mapBoth({ onFailure: inspectionFailure(path), onSuccess: (exists) => !exists })
				)
	)
	if (Arr.isReadonlyArrayNonEmpty(absent)) {
		return yield* DevtoolFailure.make({
			detail: `${manifest}'s superlint.uncheckedVocabularyLiteral names paths the repository does not have: ${Arr.join(absent, ", ")}`
		})
	}
	return decoded.superlint
})

/** A source file the linter reports on, with the checker of the package's program. */
type LintSource = Readonly<{
	sourceFile: ts.SourceFile
	checker: Checker
}>

/** The nearest ancestor directory holding a package.json, no higher than the repository root: the workspace leaf
 * that owns a file. Group folders (packages/data, packages/product, …) hold no package.json and own nothing. */
const leafResolver = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const { root } = yield* Repository
	const known = new Map<string, Option.Option<string>>()
	const lookup = (directory: string): Effect.Effect<Option.Option<string>, DevtoolFailure> =>
		Effect.gen(function* () {
			if (!covers({ selected: root, file: directory })) {
				return Option.none()
			}
			const manifest = yield* fs
				.exists(path.join(directory, "package.json"))
				.pipe(Effect.mapError(inspectionFailure(directory)))
			if (manifest) {
				return Option.some(directory)
			}
			const parent = path.dirname(directory)
			if (directory === root || parent === directory) {
				return Option.none()
			}
			return yield* leafOf(parent)
		})
	const leafOf = (directory: string): Effect.Effect<Option.Option<string>, DevtoolFailure> =>
		Effect.gen(function* () {
			const cached = known.get(directory)
			if (cached !== undefined) {
				return cached
			}
			const found = yield* lookup(directory)
			known.set(directory, found)
			return found
		})
	return leafOf
})

/** The nearest tsconfig.json at or above `directory`. */
const configOf = (
	directory: string
): Effect.Effect<string, DevtoolFailure, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const candidate = path.join(directory, "tsconfig.json")
		const exists = yield* fs.exists(candidate).pipe(Effect.mapError(inspectionFailure(candidate)))
		if (exists) {
			return candidate
		}
		const parent = path.dirname(directory)
		if (parent === directory) {
			return yield* DevtoolFailure.make({ detail: "tsconfig.json not found" })
		}
		return yield* configOf(parent)
	})

/** JavaScript's own extensions. */
const JAVASCRIPT_EXTENSIONS: ReadonlyArray<string> = [".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]

/** Every file git shows that holds code is TypeScript: a JavaScript extension is refused. */
const tsOnlyExtensionFindings = Effect.gen(function* () {
	const { root } = yield* Repository
	const files = yield* gitFilesUnder(root)
	return Arr.filterMap(files, (file): Result.Result<Finding, void> =>
		Arr.some(JAVASCRIPT_EXTENSIONS, (extension) => Str.endsWith(extension)(file))
			? Result.succeed({
					file,
					line: 1,
					column: 1,
					rule: "ts-only-extensions",
					message: "Source files are TypeScript: give this file a .ts or .tsx extension."
				})
			: Result.failVoid
	)
})

/** The source files of the package's program that the package owns. */
const ownedSourcesOf = (input: Readonly<{ project: Project; packageRoot: string }>) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const { app } = yield* Repository
		const { project } = input
		const fileNames = yield* Effect.try({
			try: () => project.program.getSourceFileNames(),
			catch: (cause) =>
				DevtoolFailure.make({ detail: "The lint program's source files could not be read", cause })
		})
		const leafOf = yield* leafResolver
		const owned = yield* Effect.filter(
			Arr.filter(fileNames, (file) => !isGeneratedPath(file) && !isVendoredPath(app)(file)),
			(file) =>
				Effect.map(leafOf(path.dirname(file)), (leaf) => Option.contains(leaf, input.packageRoot))
		)
		const sources = yield* Effect.try({
			try: () =>
				Arr.filterMap(owned, (file): Result.Result<LintSource, void> => {
					const sourceFile = project.program.getSourceFile(file)
					if (sourceFile === undefined || sourceFile.isDeclarationFile) {
						return Result.failVoid
					}
					return Result.succeed({ sourceFile, checker: project.checker })
				}),
			catch: (cause) =>
				DevtoolFailure.make({ detail: "The lint program's source files could not be read", cause })
		})
		return sources
	})

/** Every rule over one file in a single traversal; the engine stamps each report with its rule's id. */
const findingsOf = (source: LintSource, options: SuperlintOptions): ReadonlyArray<Finding> => {
	const context = { ...source, semantics: prepareSemantics(source), options }
	const excepted = Arr.filterMap(options.exceptions, (exception) =>
		isAtAny(exception.files, source.sourceFile.fileName)
			? Result.succeed(exception.rule)
			: Result.failVoid
	)
	const test = isTestFile(source.sourceFile.fileName)
	const visitors = Arr.map(
		Arr.filter(
			RULES,
			(rule) =>
				!Arr.contains(excepted, rule.id) &&
				!(test && rule.scope === "outside tests") &&
				(rule.family === "every repository" || options.appDatabase === "owned")
		),
		(rule) => ({ rule: rule.id, visit: rule.visit(context) })
	)
	const findings: Array<Finding> = []
	const walk = (node: ts.Node): void => {
		for (const { rule, visit } of visitors) {
			for (const report of visit(node)) {
				findings.push(findingAt({ sourceFile: source.sourceFile, rule, report }))
			}
		}
		node.forEachChild(walk)
	}
	walk(source.sourceFile)
	return findings
}

/** Each rule's fixtures compile in their own program; no other tool reads them. */
const FIXTURES_ROOT = `${import.meta.dirname}/lint/fixtures`

const checkFixtures = Effect.gen(function* () {
	const { root } = yield* Repository
	const mismatches = yield* withProgram(
		{ config: `${FIXTURES_ROOT}/tsconfig.json`, extraFiles: [] },
		(project) =>
			Effect.try({
				try: () =>
					fixtureMismatchesOf({
						root: FIXTURES_ROOT,
						extensionOf: () => ".ts",
						rules: Arr.map(RULES, (rule) => rule.id),
						runOf: ({ rule, file }) =>
							Option.map(
								Option.fromUndefinedOr(project.program.getSourceFile(file)),
								(sourceFile) => ({
									text: sourceFile.text,
									reported: Arr.filterMap(
										findingsOf({ sourceFile, checker: project.checker }, FIXTURE_OPTIONS),
										(finding) =>
											finding.rule === rule ? Result.succeed(finding.line) : Result.failVoid
									)
								})
							)
					}),
				catch: (cause) => DevtoolFailure.make({ detail: "superlint fixtures failed to run", cause })
			})
	)
	yield* Console.log(
		renderFixtureMismatches({ tool: "superlint", root, rules: RULES.length, mismatches })
	)
	const workspaces = yield* workspaceFixtureMismatches
	const shown = relativeTo(root)
	yield* Console.log(
		Arr.isReadonlyArrayNonEmpty(workspaces.mismatches)
			? Arr.join(
					[
						...Arr.map(
							workspaces.mismatches,
							(mismatch) =>
								`${shown(mismatch.workspace)}: missing [${Arr.join(Arr.map(mismatch.missing, shown), ", ")}] unexpected [${Arr.join(Arr.map(mismatch.unexpected, shown), ", ")}]`
						),
						`superlint fixtures: ${String(workspaces.mismatches.length)} workspace(s) disagree with the tsconfig gate`
					],
					"\n"
				)
			: `superlint fixtures: the tsconfig gate agrees with its ${String(workspaces.workspaces)} workspaces`
	)
	return statusOf([...mismatches, ...workspaces.mismatches])
})

const main = Effect.gen(function* () {
	const invocation = yield* invocationOf(["--fixtures"])
	if (invocation.flags.has("--fixtures")) {
		return yield* checkFixtures
	}
	const packageRoot = yield* Effect.sync(() => process.cwd())
	const { root } = yield* Repository
	const options = yield* projectOptions
	const config = yield* configOf(packageRoot)
	const findings = yield* withProgram(
		{ config, extraFiles: Arr.filter(invocation.paths, isTypeScriptPath) },
		(project) =>
			Effect.gen(function* () {
				const owned = yield* ownedSourcesOf({ project, packageRoot })
				const selected = yield* selectFiles({
					available: Arr.map(owned, (source) => source.sourceFile.fileName),
					paths: invocation.paths
				})
				const sources = Arr.filter(owned, (source) =>
					Arr.contains(selected, source.sourceFile.fileName)
				)
				return yield* Effect.try({
					try: () => Arr.flatMap(sources, (source) => findingsOf(source, options)),
					catch: (cause) =>
						DevtoolFailure.make({ detail: "superlint failed while collecting findings", cause })
				})
			})
	)
	const repository =
		packageRoot === root
			? yield* Effect.map(
					Effect.all([tsconfigFindings(options), tsOnlyExtensionFindings]),
					Arr.flatten
				)
			: []
	const reported = [...findings, ...repository]
	yield* Console.log(renderFindings({ tool: "superlint", root, findings: reported }))
	return statusOf(reported)
})

runDevtool(main)
