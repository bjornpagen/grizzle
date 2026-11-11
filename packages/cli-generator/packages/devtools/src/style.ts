#!/usr/bin/env -S node

import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	Result,
	Schema,
	String as Str
} from "effect"
import type * as ts from "typescript/ast"
import type { Project } from "typescript/sync"
import { type Invocation, invocationOf } from "#shared/arguments.ts"
import { DevtoolFailure } from "#shared/devtool.ts"
import { type Finding, findingAt, type Report, renderFindings, statusOf } from "#shared/finding.ts"
import { fixtureMismatchesOf, renderFixtureMismatches } from "#shared/fixtures.ts"
import { gitFilesUnder } from "#shared/git.ts"
import { nativeSession, openProgram, openProject } from "#shared/native-api.ts"
import {
	covers,
	isGeneratedPath,
	isTypeScriptPath,
	isVendoredPath,
	Repository,
	type TailwindApp
} from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"
import { selectFiles } from "#shared/selection.ts"
import { prepareSemantics } from "#shared/semantic.ts"
import { classExtractor } from "#style/class-extractor.ts"
import { type DesignSystem, loadDesignSystem } from "#style/design-system.ts"
import { FIXTURE_OPTIONS, isNamedBy, isNamedByAny, pathsOf, StyleOptions } from "#style/options.ts"
import { noConflictingClasses } from "#style/rules/class-lists.ts"
import { noInvalidColor } from "#style/rules/colors.ts"
import { markup, STANDALONE_HTML } from "#style/rules/markup.ts"
import { noArbitraryValue } from "#style/rules/no-arbitrary-value.ts"
import { noSvgPaint } from "#style/rules/no-svg-paint.ts"
import { noUnresolvedClass } from "#style/rules/no-unresolved-class.ts"
import {
	SECOND_STYLESHEET,
	type SheetRole,
	sheetRolesOf,
	stylesheet
} from "#style/rules/stylesheet.ts"
import { type ClassRule, STYLE_RULES, type StyleRule } from "#style/types.ts"

/**
 * The style linter: design-token and presentation enforcement over the repository's Tailwind app (the workspace
 * package holding components.json), read with the app's own checker, against the full Tailwind v4 design system the
 * stylesheet components.json names defines. Every class must be readable and compile; colors are theme tokens; an
 * arbitrary value is a theme token's var() or nothing; one class list never sets a property twice; presentation is
 * fixed JSX; and the stylesheets hold the theme and nothing else, each the one home of its tokens. The repository's
 * own names come from the `superstyle` field of its root package.json; a repository without a Tailwind app has
 * nothing to check. Explicit paths narrow the files (a file the tsconfig excludes is added); `--fixtures` runs every
 * rule against its fixtures instead.
 */

const CLASS_RULES: ReadonlyArray<Readonly<{ id: StyleRule; check: ClassRule }>> = [
	{ id: "no-unresolved-class", check: noUnresolvedClass },
	{ id: "no-conflicting-classes", check: noConflictingClasses },
	{ id: "no-invalid-color", check: noInvalidColor },
	{ id: "no-arbitrary-value", check: noArbitraryValue }
]

const inspectionFailure = (subject: string) => (cause: unknown) =>
	DevtoolFailure.make({ detail: `${subject} could not be read`, cause })

/** The repository's options, the `superstyle` field of its root package.json. */
const RootManifest = Schema.fromJsonString(Schema.Struct({ superstyle: StyleOptions }))

const decodeRootManifest = Schema.decodeUnknownEffect(RootManifest)

const projectOptions = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const { root } = yield* Repository
	const manifest = `${root}/package.json`
	const text = yield* fs.readFileString(manifest).pipe(Effect.mapError(inspectionFailure(manifest)))
	const decoded = yield* decodeRootManifest(text).pipe(
		Effect.mapError((cause) =>
			DevtoolFailure.make({
				detail: `${manifest} needs a superstyle field holding the repository's style options`,
				cause
			})
		)
	)
	return decoded.superstyle
})

/** The design system a stylesheet defines, compiled from its text with imports resolved from its directory. */
const designSystemAt = Effect.fn("designSystemAt")(function* (entry: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const css = yield* fs.readFileString(entry).pipe(Effect.mapError(inspectionFailure(entry)))
	if (!Str.isNonEmpty(Str.trim(css))) {
		return yield* DevtoolFailure.make({
			detail: `${entry}, the stylesheet the design system compiles from, is empty`
		})
	}
	return yield* loadDesignSystem({ css, base: path.dirname(entry), path: entry })
})

const readText = (file: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.readFileString(file).pipe(Effect.mapError(inspectionFailure(file)))
	)

const readTexts = (files: ReadonlyArray<string>) =>
	Effect.forEach(files, (file) => Effect.map(readText(file), (text) => ({ file, text })))

const isStylesheetPath = Str.endsWith(".css")

const isHtmlPath = (file: string): boolean =>
	Str.endsWith(".html")(file) || Str.endsWith(".htm")(file)

/** The program's own source files that `keep` admits, in name order, generated and declaration files aside. */
const programSourcesOf = (project: Project, keep: (file: string) => boolean) =>
	Effect.try({
		try: () =>
			Arr.filterMap(
				Arr.sort(project.program.getSourceFileNames(), Order.String),
				(file): Result.Result<ts.SourceFile, void> => {
					const sourceFile =
						!isGeneratedPath(file) && keep(file) ? project.program.getSourceFile(file) : undefined
					return sourceFile === undefined || sourceFile.isDeclarationFile
						? Result.failVoid
						: Result.succeed(sourceFile)
				}
			),
		catch: (cause) =>
			DevtoolFailure.make({ detail: "The program's source files could not be read", cause })
	})

/** What one run reads: the program and the sources it reports on, the stylesheets and HTML files it reports on and
 * the stylesheets it reads as an app's own, every file the options may name, the app's class helper, the design
 * system and the options. */
type StyleRun = Readonly<{
	project: Project
	files: ReadonlyArray<ts.SourceFile>
	stylesheets: ReadonlyArray<string>
	appStylesheets: ReadonlyArray<string>
	html: ReadonlyArray<string>
	known: ReadonlyArray<string>
	classHelper: string
	system: DesignSystem
	options: StyleOptions
}>

const stamped =
	(rule: StyleRule) =>
	(report: Report): Finding =>
		findingAt({ sourceFile: report.node.getSourceFile(), rule, report })

/** A finding about a whole file, which is not one the app maintains. */
const fileFinding =
	(rule: StyleRule, message: string) =>
	(file: string): Finding => ({ file, line: 1, column: 1, rule, message })

/** A stylesheet with the one role the options give it, none when they name it nowhere. A sheet they give two roles
 * is a failure, never a guess. */
const roleOf =
	(run: StyleRun) =>
	(
		file: string
	): Effect.Effect<Readonly<{ file: string; role: Option.Option<SheetRole> }>, DevtoolFailure> => {
		const [role, ...others] = sheetRolesOf({
			file,
			isApp: Arr.contains(run.appStylesheets, file),
			options: run.options.stylesheet
		})
		return Arr.isReadonlyArrayNonEmpty(others)
			? Effect.fail(
					DevtoolFailure.make({
						detail: `${file} has more than one role among the app's stylesheet and the superstyle options' scoped and passthrough sheets`
					})
				)
			: Effect.succeed({ file, role: Option.fromUndefinedOr(role) })
	}

/** The stylesheet contract over one sheet the options give a role. */
const sheetFindingsOf = (run: StyleRun, sheet: Readonly<{ file: string; role: SheetRole }>) =>
	Effect.map(readText(sheet.file), (text) =>
		Arr.map(
			stylesheet({ text, role: sheet.role, options: run.options.stylesheet }),
			(said): Finding => ({
				file: sheet.file,
				line: said.at.line,
				column: said.at.column,
				rule: "stylesheet",
				message: said.message
			})
		)
	)

/** Every rule over a run: what the extractor found unreadable, the markup and paint rules over every source, every
 * class rule over every class list, the stylesheet contract over every stylesheet the options give a role, and
 * every other stylesheet and HTML file. */
const styleFindingsOf = Effect.fn("styleFindingsOf")(function* (run: StyleRun) {
	const unmatched = Arr.filter(
		pathsOf(run.options),
		(path) => !Arr.some(run.known, isNamedBy(path))
	)
	if (Arr.isReadonlyArrayNonEmpty(unmatched)) {
		return yield* DevtoolFailure.make({
			detail: `The superstyle options name ${Arr.join(unmatched, ", ")}, which no file the style linter reads matches`
		})
	}
	const { checker } = run.project
	const read = yield* Effect.try({
		try: () => {
			const extract = classExtractor({
				checker,
				classHelper: run.classHelper,
				bridges: run.options.markup.styleBridges
			})
			return Arr.map(run.files, (sourceFile) => {
				const semantics = prepareSemantics({ sourceFile, checker })
				const classes = extract({ sourceFile, semantics })
				return {
					lists: classes.lists,
					findings: [
						...classes.findings,
						...Arr.map(markup({ sourceFile, options: run.options.markup }), stamped("markup")),
						...Arr.map(noSvgPaint({ sourceFile, semantics }), stamped("no-svg-paint"))
					]
				}
			})
		},
		catch: (cause) =>
			DevtoolFailure.make({ detail: "The style rules failed to read the sources", cause })
	})
	const lists = yield* Effect.forEach(
		Arr.flatMap(read, (file) => file.lists),
		run.system.explain
	)
	const classFindings = Arr.flatMap(lists, (list) =>
		Arr.flatMap(CLASS_RULES, (rule) =>
			Arr.map(rule.check({ list, theme: run.system.theme }), (verdict): Finding => {
				const located = {
					file: verdict.token.file,
					line: verdict.token.line,
					column: verdict.token.column,
					rule: rule.id,
					message: verdict.message
				}
				return verdict.suggestion === undefined
					? located
					: { ...located, suggestion: verdict.suggestion }
			})
		)
	)
	const sheets = yield* Effect.forEach(run.stylesheets, roleOf(run))
	const unnamed = Arr.filterMap(sheets, (sheet) =>
		Option.isNone(sheet.role) ? Result.succeed(sheet.file) : Result.failVoid
	)
	const sheetFindings = yield* Effect.forEach(
		Arr.filterMap(sheets, (sheet) =>
			Option.match(sheet.role, {
				onNone: () => Result.failVoid,
				onSome: (role) => Result.succeed({ file: sheet.file, role })
			})
		),
		(sheet) => sheetFindingsOf(run, sheet)
	)
	return [
		...Arr.flatMap(read, (file) => file.findings),
		...classFindings,
		...Arr.flatten(sheetFindings),
		...Arr.map(unnamed, fileFinding("stylesheet", SECOND_STYLESHEET)),
		...Arr.map(run.html, fileFinding("markup", STANDALONE_HTML))
	]
})

/** The app's run: its program's sources under the app, its stylesheets and HTML files as git lists them, vendored
 * and generated files aside, narrowed to the paths the command line names. */
const lintApp = Effect.fn("lintApp")(function* (
	input: Readonly<{ app: TailwindApp; invocation: Invocation; options: StyleOptions }>
) {
	const { app, invocation, options } = input
	const isVendored = isVendoredPath(Option.some(app))
	const system = yield* designSystemAt(app.stylesheet)
	const tracked = yield* gitFilesUnder(app.root)
	const listed = Arr.filter(tracked, (file) => !isVendored(file) && !isGeneratedPath(file))
	const css = Arr.filter(listed, isStylesheetPath)
	const html = Arr.filter(listed, isHtmlPath)
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const project = yield* openProgram({
				config: `${app.root}/tsconfig.json`,
				extraFiles: Arr.filter(invocation.paths, isTypeScriptPath)
			})
			const programSources = yield* programSourcesOf(project, (file) => !isVendored(file))
			const sources = Arr.filter(programSources, (sourceFile) =>
				covers({ selected: app.root, file: sourceFile.fileName })
			)
			const selected = yield* selectFiles({
				available: [...Arr.map(sources, (sourceFile) => sourceFile.fileName), ...css, ...html],
				paths: invocation.paths
			})
			const isSelected = (file: string): boolean => Arr.contains(selected, file)
			return yield* styleFindingsOf({
				project,
				files: Arr.filter(sources, (sourceFile) => isSelected(sourceFile.fileName)),
				stylesheets: Arr.filter(css, isSelected),
				appStylesheets: [app.stylesheet],
				html: Arr.filter(html, isSelected),
				known: [...Arr.map(programSources, (sourceFile) => sourceFile.fileName), ...css, ...html],
				classHelper: app.classHelper,
				system,
				options
			})
		})
	)
})

/** Each rule's fixtures compile in their own program against their own stylesheet and class helper in support/;
 * no other tool reads them. */
const FIXTURES_ROOT = `${import.meta.dirname}/style/fixtures`

const FIXTURE_SUPPORT = `${FIXTURES_ROOT}/support`

/** One fixture case: a directory holding a clean fixture and a violating one, and the rule they prove. The
 * stylesheet rule has a case per role a sheet can have: the app's own, a scoped sheet, a passthrough, and none. */
type FixtureCase = Readonly<{ directory: string; rule: StyleRule }>

const FIXTURE_CASES: ReadonlyArray<FixtureCase> = [
	...Arr.filterMap(STYLE_RULES, (rule): Result.Result<FixtureCase, void> =>
		rule === "stylesheet" ? Result.failVoid : Result.succeed({ directory: rule, rule })
	),
	...Arr.map(["app", "scoped", "passthrough", "unnamed"], (role): FixtureCase => ({
		directory: `stylesheet/${role}`,
		rule: "stylesheet"
	}))
]

/** The fixture stylesheets the run reads as an app's own: the app case's. */
const FIXTURE_APP_STYLESHEETS: ReadonlyArray<string> = [
	`${FIXTURES_ROOT}/stylesheet/app/clean.css`,
	`${FIXTURES_ROOT}/stylesheet/app/violating.css`
]

const checkFixtures = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const { root } = yield* Repository
	const system = yield* designSystemAt(`${FIXTURE_SUPPORT}/theme.css`)
	const entries = yield* fs
		.readDirectory(FIXTURES_ROOT, { recursive: true })
		.pipe(Effect.mapError(inspectionFailure(FIXTURES_ROOT)))
	const cssFiles = Arr.sort(
		Arr.filterMap(entries, (relative) =>
			isStylesheetPath(relative) && !Str.startsWith("support/")(relative)
				? Result.succeed(`${FIXTURES_ROOT}/${relative}`)
				: Result.failVoid
		),
		Order.String
	)
	const sheetTexts = yield* readTexts(cssFiles)
	const mismatches = yield* Effect.scoped(
		Effect.gen(function* () {
			const api = yield* nativeSession({ cwd: FIXTURES_ROOT })
			const project = yield* openProject({ api, config: `${FIXTURES_ROOT}/tsconfig.json` })
			const files = yield* programSourcesOf(project, (file) =>
				covers({ selected: FIXTURES_ROOT, file })
			)
			const findings = yield* styleFindingsOf({
				project,
				files,
				stylesheets: cssFiles,
				appStylesheets: FIXTURE_APP_STYLESHEETS,
				html: [],
				known: [...Arr.map(files, (sourceFile) => sourceFile.fileName), ...cssFiles],
				classHelper: `${FIXTURE_SUPPORT}/cn.ts`,
				system,
				options: FIXTURE_OPTIONS
			})
			const texts = new Map([
				...Arr.map(files, (sourceFile) => [sourceFile.fileName, sourceFile.text] as const),
				...Arr.map(sheetTexts, (sheet) => [sheet.file, sheet.text] as const)
			])
			return Arr.flatMap(FIXTURE_CASES, (fixtureCase) =>
				fixtureMismatchesOf({
					root: FIXTURES_ROOT,
					extensionOf: () => (fixtureCase.rule === "stylesheet" ? ".css" : ".tsx"),
					rules: [fixtureCase.directory],
					runOf: ({ file }) =>
						Option.map(Option.fromUndefinedOr(texts.get(file)), (text) => ({
							text,
							reported: Arr.filterMap(findings, (finding) =>
								finding.file === file && finding.rule === fixtureCase.rule
									? Result.succeed(finding.line)
									: Result.failVoid
							)
						}))
				})
			)
		})
	)
	yield* Console.log(
		renderFixtureMismatches({ tool: "style", root, rules: STYLE_RULES.length, mismatches })
	)
	return statusOf(mismatches)
})

const main = Effect.gen(function* () {
	const invocation = yield* invocationOf(["--fixtures"])
	if (invocation.flags.has("--fixtures")) {
		return yield* checkFixtures
	}
	const { root, app } = yield* Repository
	if (Option.isNone(app)) {
		yield* Console.log(
			"style: the repository has no Tailwind app (no workspace package holds components.json)"
		)
		return 0
	}
	const options = yield* projectOptions
	const linted = yield* lintApp({ app: app.value, invocation, options })
	const findings = Arr.filter(
		linted,
		(finding) =>
			!Arr.some(
				options.exceptions,
				(exception) =>
					exception.rule === finding.rule && isNamedByAny(exception.files)(finding.file)
			)
	)
	yield* Console.log(renderFindings({ tool: "style", root, findings }))
	return statusOf(findings)
})

runDevtool(main)
