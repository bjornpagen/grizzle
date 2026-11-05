#!/usr/bin/env -S node

import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Option,
	Path,
	Record,
	Result,
	Schema,
	String as Str
} from "effect"
import type * as ts from "typescript/ast"
import type { Checker, Project } from "typescript/sync"
import { FIXTURE_OPTIONS, SuperlintOptions } from "#lint/options.ts"
import { isAtAny } from "#lint/paths.ts"
import { RULES, type Rule } from "#lint/rules/index.ts"
import { surfaceOf } from "#lint/surface.ts"
import type { Visit } from "#lint/types.ts"
import { isTestFile, REJECTED_DIAGNOSTICS } from "#preset.ts"
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
	relativeTo,
	Repository
} from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"
import { selectFiles } from "#shared/selection.ts"
import { prepareSemantics } from "#shared/semantic.ts"
import { workspaceConfigs } from "#shared/workspace.ts"

/**
 * Superlint: the repository's opinionated type-aware rules that oxlint has no rule for. It lints the package in the
 * working directory: each workspace package's `superlint` task runs it in the package, and the repository root's runs
 * it at the root, where it also holds every tsconfig to REJECTED_DIAGNOSTICS, the shared base to the installed
 * @effect/tsgo's diagnostics, and refuses a JavaScript file. The repository's own names come from
 * the `superlint` field of its root package.json. Explicit paths lint the files at or under them (a file
 * the tsconfig excludes is added to the program); `--fixtures` runs every rule against its fixtures instead, and
 * `--pending` runs the pending rules beside the rest (rules/index.ts). Exit status 1 means findings, 2 that the linter
 * itself failed.
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

/** The Effect language-service plugins a tsconfig declares, with the severity each sets per diagnostic. */
const LanguageServiceConfig = Schema.fromJsonString(
	Schema.Struct({
		compilerOptions: Schema.optionalKey(
			Schema.Struct({
				plugins: Schema.optionalKey(
					Schema.Array(
						Schema.Struct({
							name: Schema.String,
							diagnosticSeverity: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
						})
					)
				)
			})
		)
	})
)

const decodeLanguageServiceConfig = Schema.decodeUnknownEffect(LanguageServiceConfig)

/** The severities each Effect language-service plugin a tsconfig declares sets, by diagnostic. */
const severitiesIn = (
	config: typeof LanguageServiceConfig.Type
): ReadonlyArray<Readonly<Record<string, string>>> => {
	const plugins = config.compilerOptions?.plugins ?? []
	return Arr.filterMap(plugins, (plugin) =>
		plugin.name === "@effect/language-service"
			? Result.succeed(plugin.diagnosticSeverity ?? {})
			: Result.failVoid
	)
}

/** The tsconfig base the dev tools ship, which the repository's tsconfigs extend. */
const TSCONFIG_BASE = `${import.meta.dirname}/../tsconfig.base.json`

const readLanguageServiceConfig = (config: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const text = yield* fs.readFileString(config).pipe(Effect.mapError(inspectionFailure(config)))
		return yield* decodeLanguageServiceConfig(text).pipe(
			Effect.mapError((cause) =>
				DevtoolFailure.make({ detail: `${config} is not a tsconfig this lint reads`, cause })
			)
		)
	})

/**
 * Every Effect diagnostic the shared base lists is set the same way in every tsconfig that declares the plugin: off
 * exactly when `REJECTED_DIAGNOSTICS` rejects it, with its reason, and error otherwise. The base itself is held to
 * the same, so a diagnostic is rejected with its reason or not at all, and a tsconfig that restates the plugin (to add
 * a per-file exception) cannot drift from the standard.
 */
const rejectedDiagnosticFindings = Effect.gen(function* () {
	const path = yield* Path.Path
	const { root } = yield* Repository
	const shown = relativeTo(root)
	const base = path.resolve(TSCONFIG_BASE)
	const baseConfig = yield* readLanguageServiceConfig(base)
	const listed = Arr.flatMap(severitiesIn(baseConfig), Record.keys)
	const rejected: ReadonlyArray<string> = Record.keys(REJECTED_DIAGNOSTICS)
	const expected = (diagnostic: string): string =>
		Arr.contains(rejected, diagnostic) ? "off" : "error"
	const configs = [base, ...(yield* workspaceConfigs)]
	const findings = yield* Effect.forEach(configs, (config) =>
		Effect.map(readLanguageServiceConfig(config), (decoded) =>
			Arr.flatMap(severitiesIn(decoded), (severities) => [
				...Arr.filterMap(
					Arr.dedupe([...listed, ...rejected]),
					(diagnostic): Result.Result<Finding, void> => {
						const set = Record.get(severities, diagnostic)
						if (Option.contains(set, expected(diagnostic))) {
							return Result.failVoid
						}
						return Result.succeed({
							file: config,
							line: 1,
							column: 1,
							rule: "rejected-diagnostics",
							message: `${shown(config)} ${Option.match(set, {
								onNone: () => "does not list",
								onSome: (severity) => `sets ${severity} for`
							})} the Effect diagnostic ${diagnostic}, which the standard sets to ${expected(diagnostic)}.`,
							suggestion: Arr.contains(rejected, diagnostic)
								? "REJECTED_DIAGNOSTICS rejects it: set it to off."
								: "Set it to error, or reject it in REJECTED_DIAGNOSTICS with its reason, which needs the owner."
						})
					}
				),
				...Arr.map(Arr.difference(Record.keys(severities), listed), (diagnostic): Finding => ({
					file: config,
					line: 1,
					column: 1,
					rule: "rejected-diagnostics",
					message: `${shown(config)} lists the Effect diagnostic ${diagnostic}, which the shared base does not.`,
					suggestion: "List every diagnostic in the shared base, and only those."
				}))
			])
		)
	)
	return Arr.flatten(findings)
})

/** The rules of one of @effect/tsgo's oxlint presets, keyed `effecttsgo/<kebab-name>`. */
const TsgoPreset = Schema.fromJsonString(
	Schema.Struct({ rules: Schema.Record(Schema.String, Schema.Unknown) })
)

const decodeTsgoPreset = Schema.decodeUnknownEffect(TsgoPreset)

/** The prefix of every rule an @effect/tsgo oxlint preset names. */
const TSGO_RULE_PREFIX = "effecttsgo/"

/** A diagnostic's name as both spellings agree on it: a tsconfig's camelCase and a preset's kebab-case. */
const comparableName = (name: string): string => Str.replaceAll("-", "")(Str.toLowerCase(name))

/**
 * The diagnostics of the installed @effect/tsgo, by kebab-case name: every rule its oxlint presets name. A preset
 * directory that cannot be found or read, that holds no preset, or whose presets this lint cannot read fails the lint:
 * an unknown roster is never a pass.
 */
const tsgoRoster = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const manifestUrl = yield* Effect.try({
		try: () => new URL(import.meta.resolve("@effect/tsgo/package.json")),
		catch: inspectionFailure("@effect/tsgo")
	})
	const manifest = yield* path
		.fromFileUrl(manifestUrl)
		.pipe(Effect.mapError(inspectionFailure(manifestUrl.href)))
	const presets = path.join(path.dirname(manifest), "oxlint-presets")
	const entries = yield* fs.readDirectory(presets).pipe(Effect.mapError(inspectionFailure(presets)))
	const files = Arr.filter(entries, (entry) => Str.endsWith(".json")(entry))
	if (!Arr.isReadonlyArrayNonEmpty(files)) {
		return yield* DevtoolFailure.make({ detail: `${presets} holds no @effect/tsgo oxlint preset` })
	}
	const named = yield* Effect.forEach(files, (file) =>
		Effect.gen(function* () {
			const location = path.join(presets, file)
			const text = yield* fs
				.readFileString(location)
				.pipe(Effect.mapError(inspectionFailure(location)))
			const preset = yield* decodeTsgoPreset(text).pipe(
				Effect.mapError((cause) =>
					DevtoolFailure.make({
						detail: `${location} is not an oxlint preset this lint reads`,
						cause
					})
				)
			)
			return Record.keys(preset.rules)
		})
	)
	const rules = Arr.dedupe(Arr.flatten(named))
	const foreign = Arr.filter(rules, (rule) => !Str.startsWith(TSGO_RULE_PREFIX)(rule))
	if (Arr.isReadonlyArrayNonEmpty(foreign)) {
		return yield* DevtoolFailure.make({
			detail: `${presets} names rules outside ${TSGO_RULE_PREFIX}: ${Arr.join(foreign, ", ")}`
		})
	}
	if (!Arr.isReadonlyArrayNonEmpty(rules)) {
		return yield* DevtoolFailure.make({ detail: `${presets} names no @effect/tsgo rule` })
	}
	return Arr.map(rules, (rule) => Str.slice(TSGO_RULE_PREFIX.length)(rule))
})

/**
 * The shared base lists exactly the diagnostics of the installed @effect/tsgo: a release that adds one fails the lint
 * until the base sets it, instead of leaving it at its default, and one that drops a diagnostic fails it until the base
 * stops listing it.
 */
const diagnosticRosterFindings = Effect.gen(function* () {
	const path = yield* Path.Path
	const { root } = yield* Repository
	const base = path.resolve(TSCONFIG_BASE)
	const baseConfig = yield* readLanguageServiceConfig(base)
	const listed = Arr.flatMap(severitiesIn(baseConfig), Record.keys)
	const roster = yield* tsgoRoster
	const comparableListed = Arr.map(listed, comparableName)
	const comparableRoster = Arr.map(roster, comparableName)
	const finding = (message: string, suggestion: string): Finding => ({
		file: base,
		line: 1,
		column: 1,
		rule: "diagnostic-roster",
		message: `${relativeTo(root)(base)} ${message}`,
		suggestion
	})
	return [
		...Arr.filterMap(roster, (diagnostic): Result.Result<Finding, void> =>
			Arr.contains(comparableListed, comparableName(diagnostic))
				? Result.failVoid
				: Result.succeed(
						finding(
							`does not list the Effect diagnostic ${diagnostic}, which the installed @effect/tsgo has.`,
							"Set it to error, or reject it in REJECTED_DIAGNOSTICS with its reason, which needs the owner."
						)
					)
		),
		...Arr.filterMap(listed, (diagnostic): Result.Result<Finding, void> =>
			Arr.contains(comparableRoster, comparableName(diagnostic))
				? Result.failVoid
				: Result.succeed(
						finding(
							`lists the Effect diagnostic ${diagnostic}, which the installed @effect/tsgo does not have.`,
							"Delete it from the shared base and from every tsconfig that restates the plugin."
						)
					)
		)
	]
})

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
		const { project } = input
		const fileNames = yield* Effect.try({
			try: () => project.program.getSourceFileNames(),
			catch: (cause) =>
				DevtoolFailure.make({ detail: "The lint program's source files could not be read", cause })
		})
		const leafOf = yield* leafResolver
		const owned = yield* Effect.filter(
			Arr.filter(fileNames, (file) => !isGeneratedPath(file)),
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

/** A rule started on the program a run lints: the Visit each of its files gets. */
type StartedRule = Readonly<{ rule: Rule; visit: Visit }>

/**
 * Starts the rules on a program, with its public surface: the source modules of the public exports the manifests
 * declare (lint/surface.ts). A module the surface names that the program does not hold fails the lint, since its
 * inputs could not be checked: an unread surface is never a pass.
 */
const startRules = (
	input: Readonly<{
		project: Project
		rules: ReadonlyArray<Rule>
		manifests: ReadonlyArray<string>
	}>
) =>
	Effect.gen(function* () {
		const { root } = yield* Repository
		const surfaces = yield* Effect.forEach(input.manifests, surfaceOf)
		const surface = Arr.flatten(surfaces)
		const held = yield* Effect.try({
			try: () => input.project.program.getSourceFileNames(),
			catch: (cause) =>
				DevtoolFailure.make({ detail: "The lint program's source files could not be read", cause })
		})
		const unheld = Arr.filter(surface, (module) => !Arr.contains(held, module))
		if (Arr.isReadonlyArrayNonEmpty(unheld)) {
			return yield* DevtoolFailure.make({
				detail: `The public exports of ${Arr.join(Arr.map(input.manifests, relativeTo(root)), ", ")} name modules the package's program does not hold: ${Arr.join(Arr.map(unheld, relativeTo(root)), ", ")}`
			})
		}
		const program = { checker: input.project.checker, surface }
		return yield* Effect.try({
			try: () =>
				Arr.map(input.rules, (rule): StartedRule => ({ rule, visit: rule.start(program) })),
			catch: (cause) =>
				DevtoolFailure.make({ detail: "superlint failed while starting its rules", cause })
		})
	})

/** Every started rule over one file in a single traversal; the engine stamps each report with its rule's id. */
const findingsOf = (
	source: LintSource,
	input: Readonly<{ rules: ReadonlyArray<StartedRule>; options: SuperlintOptions; root: string }>
): ReadonlyArray<Finding> => {
	const { options, root } = input
	const context = { ...source, semantics: prepareSemantics(source), options, root }
	const excepted = Arr.filterMap(options.exceptions, (exception) =>
		isAtAny(root, exception.files, source.sourceFile.fileName)
			? Result.succeed(exception.rule)
			: Result.failVoid
	)
	const test = isTestFile(source.sourceFile.fileName)
	const visitors = Arr.map(
		Arr.filter(
			input.rules,
			({ rule }) => !Arr.contains(excepted, rule.id) && !(test && rule.scope === "outside tests")
		),
		({ rule, visit }) => ({ rule: rule.id, visit: visit(context) })
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

const VIOLATING_FIXTURE = "/violating.ts"

/**
 * The fixture sets the rules run against, by their directory under the fixtures root: each rule's own directory, and
 * every directory beneath it that holds a violating fixture of its own, where the rule runs under the options that
 * name that directory (a second scope, a sanctioned reader). A set's first segment is its rule.
 */
const fixtureSetsOf = (files: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.flatMap(RULES, (rule) => {
		const directory = `${FIXTURES_ROOT}/${rule.id}/`
		const nested = Arr.filterMap(files, (file): Result.Result<string, void> =>
			Str.startsWith(directory)(file) &&
			Str.endsWith(VIOLATING_FIXTURE)(file) &&
			file !== `${directory}violating.ts`
				? Result.succeed(
						Str.slice(FIXTURES_ROOT.length + 1, file.length - VIOLATING_FIXTURE.length)(file)
					)
				: Result.failVoid
		)
		return [rule.id, ...nested]
	})

/** The rule a fixture set proves: its directory's first segment. */
const ruleOfSet = (set: string): string => Arr.headNonEmpty(Str.split("/")(set))

/** A rule's fixtures may declare a public surface: a package.json beside them whose exports name fixture modules. */
const fixtureManifests: ReadonlyArray<string> = Arr.map(
	RULES,
	(rule) => `${FIXTURES_ROOT}/${rule.id}/package.json`
)

const checkFixtures = Effect.gen(function* () {
	const { root } = yield* Repository
	const mismatches = yield* withProgram(
		{ config: `${FIXTURES_ROOT}/tsconfig.json`, extraFiles: [] },
		(project) =>
			Effect.gen(function* () {
				const rules = yield* startRules({ project, rules: RULES, manifests: fixtureManifests })
				return yield* Effect.try({
					try: () =>
						fixtureMismatchesOf({
							root: FIXTURES_ROOT,
							extensionOf: () => ".ts",
							rules: fixtureSetsOf(project.program.getSourceFileNames()),
							runOf: ({ rule: set, file }) =>
								Option.map(
									Option.fromUndefinedOr(project.program.getSourceFile(file)),
									(sourceFile) => ({
										text: sourceFile.text,
										reported: Arr.filterMap(
											findingsOf(
												{ sourceFile, checker: project.checker },
												{ rules, options: FIXTURE_OPTIONS, root: FIXTURES_ROOT }
											),
											(finding) =>
												finding.rule === ruleOfSet(set)
													? Result.succeed(finding.line)
													: Result.failVoid
										)
									})
								)
						}),
					catch: (cause) =>
						DevtoolFailure.make({ detail: "superlint fixtures failed to run", cause })
				})
			})
	)
	yield* Console.log(
		renderFixtureMismatches({ tool: "superlint", root, rules: RULES.length, mismatches })
	)
	return statusOf(mismatches)
})

const main = Effect.gen(function* () {
	const invocation = yield* invocationOf(["--fixtures", "--pending"])
	if (invocation.flags.has("--fixtures")) {
		return yield* checkFixtures
	}
	const packageRoot = yield* Effect.sync(() => process.cwd())
	const { root } = yield* Repository
	const options = yield* projectOptions
	const config = yield* configOf(packageRoot)
	const pending = invocation.flags.has("--pending")
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
				const rules = yield* startRules({
					project,
					rules: Arr.filter(RULES, (rule) => pending || rule.gate === "on"),
					manifests: [`${packageRoot}/package.json`]
				})
				return yield* Effect.try({
					try: () => Arr.flatMap(sources, (source) => findingsOf(source, { rules, options, root })),
					catch: (cause) =>
						DevtoolFailure.make({ detail: "superlint failed while collecting findings", cause })
				})
			})
	)
	const repository =
		packageRoot === root
			? [
					...(yield* rejectedDiagnosticFindings),
					...(yield* diagnosticRosterFindings),
					...(yield* tsOnlyExtensionFindings)
				]
			: []
	const reported = [...findings, ...repository]
	yield* Console.log(renderFindings({ tool: "superlint", root, findings: reported }))
	return statusOf(reported)
})

runDevtool(main)
