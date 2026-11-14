import { DevtoolFailure, failureFrom } from "@bjornpagen/devtools/devtool"
import { nativeSession, openProject } from "@bjornpagen/devtools/native-api"
import { Array as Arr, Effect, type Scope, String as Str } from "effect"
import type { SourceFile } from "typescript/ast"
import { createFileSystem } from "typescript/fs"
import type { Diagnostic } from "typescript/sync"
import { jsonText } from "#compiler/core/trusted.ts"

/**
 * The repository root, three directories above this module, wherever a tool is started from. The dev tools assume
 * POSIX paths: every path they build joins segments with "/".
 */
export const packageRoot: string = Str.slice(
	0,
	-1
)(decodeURIComponent(new URL("../../../", import.meta.url).pathname))

/** A text to parse, and the file a caller reports it by. */
export type SyntaxInput = Readonly<{ file: string; text: string }>

/**
 * An input with its tree, keeping whatever else its caller attached to the input, and its parse errors, none when it
 * parses.
 */
export type SyntaxSource<I extends SyntaxInput> = I &
	Readonly<{ sourceFile: SourceFile; diagnostics: ReadonlyArray<Diagnostic> }>

/** Only parsing happens here: no library, no module resolution, no checking. */
const syntaxConfigText = (files: ReadonlyArray<string>): string =>
	jsonText({
		compilerOptions: { target: "esnext", noLib: true, noResolve: true, types: [] },
		files
	})

/** The native decoder drops a leading byte order mark but keeps it in offsets; a space in its place keeps every one. */
const nativeText = (text: string): string =>
	Str.startsWith("\uFEFF")(text) ? ` ${Str.slice(1)(text)}` : text

/**
 * Parses texts with the native compiler: one virtual project holds every input, so a batch costs one compiler
 * process. The project's file system is full, so it reads nothing from the host. Each tree is the input's syntax
 * alone, under a virtual file name, so a caller reports by the input's own file. The trees belong to the scope's
 * compiler session.
 */
const parseSyntax = Effect.fn("parseSyntax")(function* <I extends SyntaxInput>(
	inputs: ReadonlyArray<I>
): Effect.fn.Return<ReadonlyArray<SyntaxSource<I>>, DevtoolFailure, Scope.Scope> {
	const directory = `${packageRoot}/.grizzle-native-syntax`
	const config = `${directory}/tsconfig.json`
	const entries = Arr.map(inputs, (input, index) => ({
		input,
		virtual: `${directory}/source-${index}.ts`
	}))
	const configText = syntaxConfigText(Arr.map(entries, (entry) => entry.virtual))
	const files = createFileSystem([
		[config, configText],
		...Arr.map(entries, (entry) => [entry.virtual, nativeText(entry.input.text)] as const)
	])
	const api = yield* nativeSession({ cwd: directory })
	const project = yield* openProject({ api, config, fileSystem: files })
	const diagnostics = yield* Effect.try({
		try: () => project.program.getSyntacticDiagnostics(),
		catch: failureFrom("The native parser failed")
	})
	return yield* Effect.forEach(entries, (entry) =>
		Effect.gen(function* () {
			const sourceFile = yield* Effect.try({
				try: () => project.program.getSourceFile(entry.virtual),
				catch: failureFrom(`${entry.input.file} could not be parsed`)
			})
			if (sourceFile === undefined) {
				return yield* DevtoolFailure.make({
					detail: `The native parser did not admit ${entry.input.file}`
				})
			}
			return {
				...entry.input,
				sourceFile,
				diagnostics: Arr.filter(diagnostics, (diagnostic) => diagnostic.fileName === entry.virtual)
			}
		})
	)
})

/** Parses the inputs and hands their sources to `analyze` while the compiler session is open, synchronously. */
export const withNativeSyntax = <I extends SyntaxInput, R>(
	inputs: ReadonlyArray<I>,
	analyze: (sources: ReadonlyArray<SyntaxSource<I>>) => R
): R => Effect.runSync(Effect.scoped(Effect.map(parseSyntax(inputs), analyze)))
