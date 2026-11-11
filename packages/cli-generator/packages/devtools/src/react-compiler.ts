#!/usr/bin/env -S node

import { type TransformOptions, transformSync } from "@babel/core"
import type {
	Logger,
	LoggerEvent,
	PluginOptions,
	SourceLocation
} from "babel-plugin-react-compiler"
import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	Result,
	String as Str
} from "effect"
import { REACT_COMPILER_OPTIONS } from "#react-compiler/options.ts"
import { invocationOf } from "#shared/arguments.ts"
import { DevtoolFailure } from "#shared/devtool.ts"
import { type Finding, renderFindings, statusOf } from "#shared/finding.ts"
import { fixtureMismatchesOf, renderFixtureMismatches } from "#shared/fixtures.ts"
import { openProgram } from "#shared/native-api.ts"
import { isGeneratedPath, isTypeScriptPath, Repository } from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"
import { selectFiles } from "#shared/selection.ts"

/**
 * The React Compiler check: every TypeScript source of a Next app's program, the files its tsconfig.json includes
 * and the workspace sources they import, compiled by babel-plugin-react-compiler with REACT_COMPILER_OPTIONS, the
 * options the app's next.config.ts builds with. Each failure the compiler logs is a finding at its location with the
 * compiler's message, so a component or hook the compiler refuses fails here as it fails `next build`; a file Babel
 * cannot parse or compile fails the run. It runs in the package whose tsconfig.json it reads; explicit paths narrow
 * the files; `--fixtures` compiles the fixtures instead.
 */

const TOOL = "react-compiler"

/** The one rule: every component and hook compiles. */
const RULE = "compile"

const RULES: ReadonlyArray<string> = [RULE]

/** A file's place in the compiler's terms, its generated code aside. */
type Located = Exclude<SourceLocation, symbol>

/** What one file compiled to: its text and the compiler's findings in it. */
type Compiled = Readonly<{ file: string; text: string; findings: ReadonlyArray<Finding> }>

const inspectionFailure = (subject: string) => (cause: unknown) =>
	DevtoolFailure.make({ detail: `${subject} could not be read`, cause })

/** The compiler plugin's module, resolved from the dev tools as Node resolves their own imports, for Babel to load. */
const compilerPlugin = Effect.gen(function* () {
	const path = yield* Path.Path
	const unresolved = (cause: unknown) =>
		DevtoolFailure.make({
			detail: "babel-plugin-react-compiler does not resolve from the dev tools",
			cause
		})
	const url = yield* Effect.try({
		try: () => new URL(import.meta.resolve("babel-plugin-react-compiler")),
		catch: unresolved
	})
	return yield* path.fromFileUrl(url).pipe(Effect.mapError(unresolved))
})

const isLocated = (location: SourceLocation | null): location is Located =>
	location !== null && typeof location !== "symbol"

/** The first of the locations the compiler gave, 1-based as an editor shows it; the file's start when it gave none. */
const positionOf = (
	locations: ReadonlyArray<SourceLocation | null>
): Readonly<{ line: number; column: number }> =>
	Option.match(Arr.findFirst(locations, isLocated), {
		onNone: () => ({ line: 1, column: 1 }),
		onSome: (location) => ({ line: location.start.line, column: location.start.column + 1 })
	})

/** A failure the compiler logged, as a finding: a function it could not compile, or the compiler throwing. */
const findingOf =
	(file: string) =>
	(event: LoggerEvent): Result.Result<Finding, void> => {
		switch (event.kind) {
			case "CompileError": {
				const { category, reason, description } = event.detail
				const summary = `${category}: ${reason}`
				return Result.succeed({
					file,
					...positionOf([event.detail.primaryLocation(), event.fnLoc]),
					rule: RULE,
					message: typeof description === "string" ? `${summary}. ${description}` : summary
				})
			}
			case "PipelineError":
				return Result.succeed({
					file,
					...positionOf([event.fnLoc]),
					rule: RULE,
					message: `The compiler threw: ${Arr.headNonEmpty(Str.split("\n")(event.data))}`
				})
			case "CompileSuccess":
			case "CompileDiagnostic":
			case "CompileSkip":
			case "Timing":
			case "AutoDepsDecorations":
			case "AutoDepsEligible":
				return Result.failVoid
		}
	}

/** Babel's options for one file: no configuration file is read, nothing is generated, the parser reads TypeScript,
 * and JSX exactly in a .tsx file as TypeScript does, and the compiler is the one plugin. */
const transformOptionsOf = (
	input: Readonly<{ compiler: string; file: string; logger: Logger }>
): TransformOptions => ({
	filename: input.file,
	babelrc: false,
	configFile: false,
	code: false,
	ast: false,
	parserOpts: {
		plugins: Str.endsWith(".tsx")(input.file) ? ["jsx", "typescript"] : ["typescript"]
	},
	plugins: [
		[input.compiler, { ...REACT_COMPILER_OPTIONS, logger: input.logger } satisfies PluginOptions]
	]
})

/** One file through the compiler. At `all_errors` the compiler throws once it logs a failure, so a throw with
 * findings is those findings; a throw without any, or no result, fails the run. */
const compile = (
	input: Readonly<{ compiler: string; file: string; text: string }>
): Effect.Effect<ReadonlyArray<Finding>, DevtoolFailure> =>
	Effect.suspend((): Effect.Effect<ReadonlyArray<Finding>, DevtoolFailure> => {
		const events: Array<LoggerEvent> = []
		const logger: Logger = {
			logEvent: (_filename, event) => {
				events.push(event)
			}
		}
		const outcome = Result.try({
			try: () =>
				transformSync(
					input.text,
					transformOptionsOf({ compiler: input.compiler, file: input.file, logger })
				),
			catch: (cause) => cause
		})
		const findings = Arr.filterMap(events, findingOf(input.file))
		if (Arr.isReadonlyArrayNonEmpty(findings)) {
			return Effect.succeed(findings)
		}
		if (Result.isFailure(outcome)) {
			return Effect.fail(
				DevtoolFailure.make({
					detail: `Babel could not compile ${input.file}`,
					cause: outcome.failure
				})
			)
		}
		if (outcome.success === null) {
			return Effect.fail(DevtoolFailure.make({ detail: `Babel compiled nothing of ${input.file}` }))
		}
		return Effect.succeed([])
	})

/** Every file read and compiled, in order. */
const compileAll = (
	input: Readonly<{ compiler: string; files: ReadonlyArray<string> }>
): Effect.Effect<ReadonlyArray<Compiled>, DevtoolFailure, FileSystem.FileSystem> =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.forEach(input.files, (file) =>
			Effect.gen(function* () {
				const text = yield* fs.readFileString(file).pipe(Effect.mapError(inspectionFailure(file)))
				const findings = yield* compile({ compiler: input.compiler, file, text })
				return { file, text, findings } satisfies Compiled
			})
		)
	)

/** The TypeScript sources of the package's program, installed and generated code and declaration files aside, in
 * name order. */
const programSources = Effect.fn("programSources")(function* (packageRoot: string) {
	const project = yield* openProgram({ config: `${packageRoot}/tsconfig.json`, extraFiles: [] })
	const unreadable = (cause: unknown) =>
		DevtoolFailure.make({ detail: "The program's source files could not be read", cause })
	const candidates = yield* Effect.try({
		try: () =>
			Arr.filter(
				Arr.sort(project.program.getSourceFileNames(), Order.String),
				(file) => isTypeScriptPath(file) && !isGeneratedPath(file)
			),
		catch: unreadable
	})
	return yield* Effect.filter(candidates, (file) =>
		Effect.try({
			try: () => Option.fromUndefinedOr(project.program.getSourceFile(file)),
			catch: unreadable
		}).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () =>
						Effect.fail(
							DevtoolFailure.make({
								detail: `The program names ${file} but holds no source for it`
							})
						),
					onSome: (sourceFile) => Effect.succeed(!sourceFile.isDeclarationFile)
				})
			)
		)
	)
})

/** The fixtures compile alone, outside every program; no other tool reads them. */
const FIXTURES_ROOT = `${import.meta.dirname}/react-compiler/fixtures`

const checkFixtures = (compiler: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const { root } = yield* Repository
		const entries = yield* fs
			.readDirectory(FIXTURES_ROOT, { recursive: true })
			.pipe(Effect.mapError(inspectionFailure(FIXTURES_ROOT)))
		const files = Arr.sort(
			Arr.map(Arr.filter(entries, isTypeScriptPath), (relative) => `${FIXTURES_ROOT}/${relative}`),
			Order.String
		)
		const compiled = yield* compileAll({ compiler, files })
		const mismatches = fixtureMismatchesOf({
			root: FIXTURES_ROOT,
			extensionOf: () => ".tsx",
			rules: RULES,
			runOf: ({ file }) =>
				Option.map(
					Arr.findFirst(compiled, (entry) => entry.file === file),
					(entry) => ({
						text: entry.text,
						reported: Arr.map(entry.findings, (finding) => finding.line)
					})
				)
		})
		yield* Console.log(
			renderFixtureMismatches({ tool: TOOL, root, rules: RULES.length, mismatches })
		)
		return statusOf(mismatches)
	})

const main = Effect.gen(function* () {
	const invocation = yield* invocationOf(["--fixtures"])
	const compiler = yield* compilerPlugin
	if (invocation.flags.has("--fixtures")) {
		return yield* checkFixtures(compiler)
	}
	const packageRoot = yield* Effect.sync(() => process.cwd())
	const { root } = yield* Repository
	const available = yield* Effect.scoped(programSources(packageRoot))
	const files = yield* selectFiles({ available, paths: invocation.paths })
	const compiled = yield* compileAll({ compiler, files })
	const findings = Arr.flatMap(compiled, (entry) => entry.findings)
	yield* Console.log(renderFindings({ tool: TOOL, root, findings }))
	return statusOf(findings)
})

runDevtool(main)
