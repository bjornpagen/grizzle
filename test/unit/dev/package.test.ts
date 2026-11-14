/**
 * The published packages, installed as a consumer installs them (published.ts), used as a consumer uses them:
 *
 * - Node loads every entry point from node_modules, where it strips no types, so every module resolves to dist without
 *   a `#…ts` specifier, with only the declared dependencies installed: an exhaustion of every export and bin the
 *   installed package.json files name. Each export's module exports exactly the names its source does, the oracle being
 *   the same specifier resolved in the repository under the grizzle-source condition, a second build of the same
 *   module; each bin runs from node_modules and answers `--help` exactly as its source does, run from the repository
 *   under the same condition: its exit code and its output.
 * - The README's and SKILL.md's programs, mirrored line for line in test/types/examples/fixtures, typecheck as a
 *   consumer's against the published declarations alone, with no access to src's `#` imports: so the declarations are
 *   self-contained, and never `any`, since a refusal the README states by `@ts-expect-error` would leave its directive
 *   unused.
 *
 * That the built package opens a role against the cluster and reads is test/pg/package/consumer.test.ts's.
 *
 * Oracles: second implementations, the source of each entry point and bin; and TypeScript's own checker for the
 * README's programs. Features, required in the space: an export and a bin.
 *
 * Plant: ~/.cache/grizzle-release/BR07/plants/package-extra-export.patch (the build emitting a name its source does
 * not export) turns the entry-point property red.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Path,
	Record,
	Result,
	String as Str
} from "effect"
import { trustedJson } from "#compiler/core/trusted.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { sourceCondition } from "#test/support/process.ts"
import {
	exitedCleanly,
	type PublishedProject,
	publishedProject,
	runChild
} from "#test/unit/dev/published.ts"

/**
 * The compiler options a consumer of the README's programs checks them under: the repository's own strictness, Node's
 * types, and nothing of src's: no `#` imports, no grizzle-source condition, no paths.
 */
const mirrorTsconfig = `{
	"compilerOptions": {
		"target": "esnext",
		"lib": ["esnext"],
		"module": "nodenext",
		"moduleResolution": "nodenext",
		"moduleDetection": "force",
		"strict": true,
		"exactOptionalPropertyTypes": true,
		"noUncheckedIndexedAccess": true,
		"allowImportingTsExtensions": true,
		"noEmit": true,
		"skipLibCheck": true,
		"types": ["node"]
	},
	"include": ["readme.ts", "skill.ts"]
}
`

/** The README's and SKILL.md's mirrored programs, which the type batch holds to their blocks, by their paths. */
const mirrors = {
	readme: "test/types/examples/fixtures/readme.ts",
	skill: "test/types/examples/fixtures/skill.ts"
} as const

/** A published entry point: an export of a package, by the specifier a consumer imports, or a bin, by its path. */
type Entry =
	| Readonly<{ kind: "export"; specifier: string }>
	| Readonly<{ kind: "bin"; name: string; path: string; source: string }>

/** The fields of an installed package.json its entry points come from, a file the build copied from the repository. */
type InstalledManifest = {
	readonly name: string
	readonly exports: Record.ReadonlyRecord<string, unknown>
	readonly bin?: Record.ReadonlyRecord<string, string>
}

/** A child's program: imports every specifier named on its command line and prints each one's export names, sorted. */
const exportNames =
	"const names = {}; for (const specifier of process.argv.slice(1)) { names[specifier] = Object.keys(await import(specifier)).sort() } console.log(JSON.stringify(names))"

/** The published packages, built once for the file into a scratch project that lives as long as the layer. */
class Published extends Context.Service<Published, PublishedProject>()(
	"grizzle-workspace/test/unit/dev/package.test/Published"
) {
	static readonly layer = Layer.provideMerge(
		Layer.effect(Published, publishedProject),
		NodeServices.layer
	)
}

layer(Published.layer, { excludeTestServices: true })("the published package", (it) => {
	it.effect(
		"loads every entry point from node_modules, each exporting what its source does, and runs every bin",
		(ctx) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const { root, project } = yield* Published
				const manifests = yield* Effect.forEach(["engine", "grizzle"], (directory) =>
					Effect.gen(function* () {
						const repositoryText = yield* fs.readFileString(
							path.join(root, "packages", directory, "package.json")
						)
						const repository = trustedJson<InstalledManifest>(repositoryText)
						const installed = path.join(project, "node_modules", repository.name)
						const installedText = yield* fs.readFileString(path.join(installed, "package.json"))
						return {
							installed,
							repository: path.join(root, "packages", directory),
							manifest: trustedJson<InstalledManifest>(installedText)
						}
					})
				)
				const entries: ReadonlyArray<Entry> = Arr.flatMap(
					manifests,
					({ installed, repository, manifest }) => [
						...Arr.filterMap(Record.keys(manifest.exports), (subpath) =>
							subpath === "./package.json"
								? Result.failVoid
								: Result.succeed({
										kind: "export" as const,
										specifier: `${manifest.name}${Str.slice(1)(subpath)}`
									})
						),
						...Arr.map(Record.toEntries(manifest.bin ?? {}), ([name, bin]) => ({
							kind: "bin" as const,
							name,
							path: path.join(installed, bin),
							source: path.join(
								repository,
								Str.replace(".js", ".ts")(Str.replace("./dist/", "./src/")(bin))
							)
						}))
					]
				)
				const specifiers = Arr.flatMap(entries, (entry) =>
					entry.kind === "export" ? [entry.specifier] : []
				)
				/** Every export's names, as a child Node run in `cwd` with `conditions` imports it. */
				const namesIn = (cwd: string, conditions: ReadonlyArray<string>) =>
					Effect.gen(function* () {
						const imported = yield* runChild(
							process.execPath,
							[...conditions, "--input-type=module", "-e", exportNames, ...specifiers],
							cwd
						)
						assert.equal(
							imported.exitCode,
							exitedCleanly,
							`the imports in ${cwd}: ${imported.stderr}`
						)
						return trustedJson<Record.ReadonlyRecord<string, ReadonlyArray<string>>>(
							Str.trim(imported.stdout)
						)
					})
				const published = yield* namesIn(project, [])
				const source = yield* namesIn(path.join(root, "packages", "grizzle"), [sourceCondition])
				return yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/dev/published entry points",
							generator: element(nonEmpty(entries, "the published entry points")),
							literal: Formatter.format,
							coverage: requiredInSpace<Entry["kind"]>(["export", "bin"]),
							box: "every export and bin the published packages' package.json files name",
							oracle: {
								kind: "second-implementation",
								name: "the same entry point or bin, resolved and run from the repository under the grizzle-source condition"
							},
							caseHang,
							concurrency: 1
						},
						(entry, c) =>
							Effect.gen(function* () {
								c.note(entry.kind)
								switch (entry.kind) {
									case "export":
										assert.deepEqual(
											Record.get(published, entry.specifier),
											Record.get(source, entry.specifier),
											`${entry.specifier}: its published names are its source's`
										)
										return
									case "bin": {
										const help = yield* runChild(process.execPath, [entry.path, "--help"], project)
										const own = yield* runChild(
											process.execPath,
											[sourceCondition, entry.source, "--help"],
											project
										)
										assert.equal(
											help.exitCode,
											exitedCleanly,
											`${entry.name} --help: ${help.stderr}`
										)
										assert.deepEqual(
											{ exitCode: help.exitCode, stdout: help.stdout },
											{ exitCode: own.exitCode, stdout: own.stdout },
											`${entry.name} --help answers as its source does`
										)
										return
									}
								}
							})
					)
				)
			})
	)

	it.effect("typechecks the README's and SKILL.md's programs against its declarations alone", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const { root, project } = yield* Published
			const readme = yield* fs.readFileString(path.join(root, mirrors.readme))
			const skill = yield* fs.readFileString(path.join(root, mirrors.skill))
			yield* fs.writeFileString(path.join(project, "readme.ts"), readme)
			yield* fs.writeFileString(
				path.join(project, "skill.ts"),
				Str.replaceAll(`#${mirrors.readme}`, "./readme.ts")(skill)
			)
			yield* fs.writeFileString(path.join(project, "tsconfig.json"), mirrorTsconfig)
			const checked = yield* runChild(
				process.execPath,
				[
					path.join(root, "node_modules", "typescript", "bin", "tsc"),
					"-p",
					path.join(project, "tsconfig.json")
				],
				project
			)
			assert.equal(
				checked.exitCode,
				exitedCleanly,
				`the README's programs, typechecked as a consumer's:\n${checked.stdout}${checked.stderr}`
			)
		})
	)
})
