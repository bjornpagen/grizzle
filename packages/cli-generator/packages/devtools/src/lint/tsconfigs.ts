import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Path,
	Record,
	Result,
	Schema,
	String as Str
} from "effect"
import { SuperlintOptions } from "#lint/options.ts"
import { REJECTED_DIAGNOSTICS } from "#preset.ts"
import { DevtoolFailure } from "#shared/devtool.ts"
import type { Finding } from "#shared/finding.ts"
import { relativeTo, Repository } from "#shared/repository.ts"

/**
 * The repository's tsconfig gate, run by superlint at the repository root: the Effect diagnostics every tsconfig
 * sets, the shared base's list held to the installed @effect/tsgo's roster, the one plugin block the root tsconfig
 * declares, and the Effect-free packages `superlint.effectFree` lists.
 */

const inspectionFailure = (subject: string) => (cause: unknown) =>
	DevtoolFailure.make({ detail: `${subject} could not be inspected`, cause })

/** The Effect language service's plugin name in a tsconfig's `compilerOptions.plugins`. */
const EFFECT_PLUGIN = "@effect/language-service"

/** What the gate reads of a tsconfig: the config it extends, and the plugins it declares with the severity each sets
 * per diagnostic. */
const Tsconfig = Schema.fromJsonString(
	Schema.Struct({
		extends: Schema.optionalKey(Schema.String),
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

const decodeTsconfig = Schema.decodeUnknownEffect(Tsconfig)

/** The severities each Effect language-service plugin a tsconfig declares sets, by diagnostic. */
const severitiesIn = (
	config: typeof Tsconfig.Type
): ReadonlyArray<Readonly<Record<string, string>>> => {
	const plugins = config.compilerOptions?.plugins ?? []
	return Arr.filterMap(plugins, (plugin) =>
		plugin.name === EFFECT_PLUGIN
			? Result.succeed(plugin.diagnosticSeverity ?? {})
			: Result.failVoid
	)
}

/** The tsconfig base the dev tools ship: the standard every tsconfig that declares the plugin is held to. */
const TSCONFIG_BASE = `${import.meta.dirname}/../../tsconfig.base.json`

const readTsconfig = (config: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const text = yield* fs.readFileString(config).pipe(Effect.mapError(inspectionFailure(config)))
		return yield* decodeTsconfig(text).pipe(
			Effect.mapError((cause) =>
				DevtoolFailure.make({ detail: `${config} is not a tsconfig this lint reads`, cause })
			)
		)
	})

/** The diagnostics the shared base lists, by name. */
const listedDiagnostics = Effect.gen(function* () {
	const path = yield* Path.Path
	const base = path.resolve(TSCONFIG_BASE)
	const config = yield* readTsconfig(base)
	return { base, listed: Arr.flatMap(severitiesIn(config), Record.keys) }
})

/** The root tsconfig and every workspace package's tsconfig.json that exists. */
const workspaceTsconfigs = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const { root, packages } = yield* Repository
	const configs = Arr.map(packages, (leaf) => `${leaf}/tsconfig.json`)
	const present = yield* Effect.filter(configs, (config) =>
		fs.exists(config).pipe(Effect.mapError(inspectionFailure(config)))
	)
	return [`${root}/tsconfig.json`, ...present]
})

/**
 * Every Effect diagnostic the shared base lists is set the same way in every tsconfig that declares the plugin: off
 * exactly when `REJECTED_DIAGNOSTICS` rejects it, with its reason, and error otherwise. The base itself is held to
 * the same, so a diagnostic is rejected with its reason or not at all, and the root tsconfig, which restates the
 * plugin to add its per-file overrides, cannot drift from the standard.
 */
const standardFindings = Effect.gen(function* () {
	const { root } = yield* Repository
	const shown = relativeTo(root)
	const { base, listed } = yield* listedDiagnostics
	const rejected: ReadonlyArray<string> = Record.keys(REJECTED_DIAGNOSTICS)
	const expected = (diagnostic: string): string =>
		Arr.contains(rejected, diagnostic) ? "off" : "error"
	const workspace = yield* workspaceTsconfigs
	const findings = yield* Effect.forEach([base, ...workspace], (config) =>
		Effect.map(readTsconfig(config), (decoded) =>
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

/** Where the installed @effect/tsgo ships its oxlint presets, whose rules together are every diagnostic it has. */
const ROSTER_DIRECTORY = "node_modules/@effect/tsgo/oxlint-presets"

/** The oxlint plugin namespace every preset rule sits in, as `effecttsgo/<kebab-case diagnostic>`. */
const ROSTER_NAMESPACE = "effecttsgo/"

/** One oxlint preset of @effect/tsgo: its rules by name. */
const RosterPreset = Schema.fromJsonString(
	Schema.Struct({ rules: Schema.Record(Schema.String, Schema.Unknown) })
)

const decodeRosterPreset = Schema.decodeUnknownEffect(RosterPreset)

/** A diagnostic's name as the roster and the tsconfig spell it alike: lowercase, hyphens removed. */
const comparable = (name: string): string => Str.replaceAll("-", "")(Str.toLowerCase(name))

/** Every diagnostic the installed @effect/tsgo ships, in its presets' kebab case. A missing or empty roster, or a
 * preset rule outside its namespace, fails the run: the gate never passes on a roster it could not read. */
const installedRoster = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const { root } = yield* Repository
	const directory = `${root}/${ROSTER_DIRECTORY}`
	const entries = yield* fs.readDirectory(directory).pipe(
		Effect.mapError((cause) =>
			DevtoolFailure.make({
				detail: `${directory} is missing: the gate reads the installed @effect/tsgo's diagnostic roster there`,
				cause
			})
		)
	)
	const presets = Arr.filter(entries, Str.endsWith(".json"))
	if (!Arr.isReadonlyArrayNonEmpty(presets)) {
		return yield* DevtoolFailure.make({
			detail: `${directory} holds no preset: the gate reads the installed @effect/tsgo's diagnostic roster there`
		})
	}
	const rulesByPreset = yield* Effect.forEach(presets, (preset) =>
		Effect.gen(function* () {
			const file = `${directory}/${preset}`
			const text = yield* fs.readFileString(file).pipe(Effect.mapError(inspectionFailure(file)))
			const decoded = yield* decodeRosterPreset(text).pipe(
				Effect.mapError((cause) =>
					DevtoolFailure.make({ detail: `${file} is not an oxlint preset this gate reads`, cause })
				)
			)
			return Record.keys(decoded.rules)
		})
	)
	const rules = Arr.dedupe(Arr.flatten(rulesByPreset))
	const foreign = Arr.filter(rules, (rule) => !Str.startsWith(ROSTER_NAMESPACE)(rule))
	if (Arr.isReadonlyArrayNonEmpty(foreign)) {
		return yield* DevtoolFailure.make({
			detail: `${directory} names rules outside ${ROSTER_NAMESPACE}: ${Arr.join(foreign, ", ")}`
		})
	}
	return Arr.map(rules, (rule) => Str.slice(ROSTER_NAMESPACE.length)(rule))
})

/**
 * The shared base lists exactly the diagnostics the installed @effect/tsgo ships, compared by name with case and
 * hyphens set aside: a diagnostic a new release adds is listed, at error or rejected with its reason, and one it
 * drops goes.
 */
const rosterFindings = Effect.gen(function* () {
	const { root } = yield* Repository
	const { base, listed } = yield* listedDiagnostics
	const roster = yield* installedRoster
	const listedComparable = Arr.map(listed, comparable)
	const rosterComparable = Arr.map(roster, comparable)
	const at = (message: string, suggestion: string): Finding => ({
		file: base,
		line: 1,
		column: 1,
		rule: "rejected-diagnostics",
		message,
		suggestion
	})
	return [
		...Arr.filterMap(roster, (diagnostic) =>
			Arr.contains(listedComparable, comparable(diagnostic))
				? Result.failVoid
				: Result.succeed(
						at(
							`${relativeTo(root)(base)} does not list the Effect diagnostic ${diagnostic}, which the installed @effect/tsgo ships.`,
							"List it at error, or reject it in REJECTED_DIAGNOSTICS with its reason, which needs the owner."
						)
					)
		),
		...Arr.filterMap(listed, (diagnostic) =>
			Arr.contains(rosterComparable, comparable(diagnostic))
				? Result.failVoid
				: Result.succeed(
						at(
							`${relativeTo(root)(base)} lists the Effect diagnostic ${diagnostic}, which the installed @effect/tsgo does not ship.`,
							"Remove it from the shared base and every tsconfig that restates the plugin."
						)
					)
		)
	]
})

/** The tsconfig an Effect-free package extends, by the specifier it writes: the dev tools' base with no plugin. */
const EFFECT_FREE_BASE = "@superstarter/devtools/tsconfig.effect-free.json"

/** The dependency fields of a package.json, each by package name. */
const Dependencies = Schema.optionalKey(Schema.Record(Schema.String, Schema.String))

/** What the gate reads of a package's package.json: every package it depends on, by field. */
const PackageManifest = Schema.fromJsonString(
	Schema.Struct({
		dependencies: Dependencies,
		devDependencies: Dependencies,
		peerDependencies: Dependencies,
		optionalDependencies: Dependencies
	})
)

const decodePackageManifest = Schema.decodeUnknownEffect(PackageManifest)

/** The packages a package.json names in any dependency field. */
const dependenciesOf = (manifest: typeof PackageManifest.Type): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.flatMap(
			[
				manifest.dependencies,
				manifest.devDependencies,
				manifest.peerDependencies,
				manifest.optionalDependencies
			],
			(field) => (field === undefined ? [] : Record.keys(field))
		)
	)

/** Effect itself, or a package of its `@effect` scope. */
const isEffectPackage = (name: string): boolean =>
	name === "effect" || Str.startsWith("@effect/")(name)

/** A workspace as the gate reads it: its root, its packages' roots, and the package directories, relative to the
 * root, that `superlint.effectFree` lists. */
type Workspace = Readonly<{
	root: string
	packages: ReadonlyArray<string>
	effectFree: ReadonlyArray<string>
}>

/** A finding the workspace gate reports at the top of a file. */
const workspaceFinding = (
	input: Readonly<{ file: string; rule: string; message: string; suggestion: string }>
): Finding => ({ ...input, line: 1, column: 1 })

/** The root tsconfig declares the Effect plugin exactly once: it is the one plugin block every package inherits. */
const rootBlockFindings = (workspace: Workspace) =>
	Effect.gen(function* () {
		const config = `${workspace.root}/tsconfig.json`
		const decoded = yield* readTsconfig(config)
		const declared = severitiesIn(decoded).length
		if (declared === 1) {
			return []
		}
		return [
			workspaceFinding({
				file: config,
				rule: "effect-plugin-block",
				message: `The root tsconfig.json declares the Effect plugin ${String(declared)} times; it declares it exactly once, for every package to inherit.`,
				suggestion:
					"Declare the plugin once in the root tsconfig.json, its per-file overrides as root-relative includes."
			})
		]
	})

/** Every directory `superlint.effectFree` lists is a workspace package. */
const listedFindings = (workspace: Workspace): ReadonlyArray<Finding> =>
	Arr.filterMap(workspace.effectFree, (directory) =>
		Arr.contains(workspace.packages, `${workspace.root}/${directory}`)
			? Result.failVoid
			: Result.succeed(
					workspaceFinding({
						file: `${workspace.root}/package.json`,
						rule: "effect-free-packages",
						message: `superlint.effectFree lists ${directory}, which is no workspace package.`,
						suggestion:
							"List workspace package directories, relative to the root and without a trailing /."
					})
				)
	)

/**
 * One package's tsconfig and manifest against the one plugin block and the Effect-free list. Every package has a
 * tsconfig.json that declares no plugin of its own. A listed package's extends the dev tools' Effect-free base and its
 * package.json depends on nothing of Effect's; any other package's extends the root tsconfig.json, which carries the
 * Effect plugin.
 */
const packageFindings = (workspace: Workspace, leaf: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const shown = relativeTo(workspace.root)(leaf)
		const listed = Arr.contains(workspace.effectFree, shown)
		const config = `${leaf}/tsconfig.json`
		const present = yield* fs.exists(config).pipe(Effect.mapError(inspectionFailure(config)))
		if (!present) {
			return [
				workspaceFinding({
					file: `${leaf}/package.json`,
					rule: "effect-plugin-block",
					message: `${shown} has no tsconfig.json, so nothing type-checks it.`,
					suggestion: listed
						? `Give it a tsconfig.json that extends ${EFFECT_FREE_BASE}.`
						: "Give it a tsconfig.json that extends the root tsconfig.json."
				})
			]
		}
		const decoded = yield* readTsconfig(config)
		const declaresPlugins = decoded.compilerOptions?.plugins !== undefined
		const extended = Option.fromUndefinedOr(decoded.extends)
		const extendsRoot = Option.exists(
			extended,
			(target) => path.resolve(leaf, target) === `${workspace.root}/tsconfig.json`
		)
		const extendsEffectFree = Option.contains(extended, EFFECT_FREE_BASE)
		const plugins = declaresPlugins
			? [
					workspaceFinding({
						file: config,
						rule: "effect-plugin-block",
						message: `${shown}/tsconfig.json declares compiler plugins; the root tsconfig.json holds the one Effect plugin block.`,
						suggestion: listed
							? `Drop the plugins: ${EFFECT_FREE_BASE} sets none.`
							: "Drop the plugins and move any per-file override into the root tsconfig.json, its include relative to the root."
					})
				]
			: []
		const base = listed
			? extendsEffectFree
				? []
				: [
						workspaceFinding({
							file: config,
							rule: "effect-free-packages",
							message: `${shown} is Effect-free, but its tsconfig.json does not extend ${EFFECT_FREE_BASE}.`,
							suggestion: `Extend ${EFFECT_FREE_BASE}, or take it off superlint.effectFree if it uses Effect.`
						})
					]
			: extendsRoot
				? []
				: [
						workspaceFinding({
							file: config,
							rule: "effect-free-packages",
							message: `${shown}/tsconfig.json does not extend the root tsconfig.json, so it does not carry the Effect plugin.`,
							suggestion:
								"Extend the root tsconfig.json, or list the package in superlint.effectFree if it uses no Effect."
						})
					]
		if (!listed) {
			return [...plugins, ...base]
		}
		const manifestFile = `${leaf}/package.json`
		const text = yield* fs
			.readFileString(manifestFile)
			.pipe(Effect.mapError(inspectionFailure(manifestFile)))
		const manifest = yield* decodePackageManifest(text).pipe(
			Effect.mapError((cause) =>
				DevtoolFailure.make({
					detail: `${manifestFile} is not a package.json this lint reads`,
					cause
				})
			)
		)
		const effectDependencies = Arr.filter(dependenciesOf(manifest), isEffectPackage)
		const dependencies = Arr.isReadonlyArrayNonEmpty(effectDependencies)
			? [
					workspaceFinding({
						file: manifestFile,
						rule: "effect-free-packages",
						message: `${shown} is Effect-free, but its package.json depends on ${Arr.join(effectDependencies, ", ")}.`,
						suggestion: "Drop the dependency, or take the package off superlint.effectFree."
					})
				]
			: []
		return [...plugins, ...base, ...dependencies]
	})

/** Every finding of the one plugin block and the Effect-free list over a workspace. */
const workspaceFindings = (workspace: Workspace) =>
	Effect.gen(function* () {
		const root = yield* rootBlockFindings(workspace)
		const packages = yield* Effect.forEach(workspace.packages, (leaf) =>
			packageFindings(workspace, leaf)
		)
		return [...root, ...listedFindings(workspace), ...Arr.flatten(packages)]
	})

/** Every finding of the tsconfig gate over the repository. */
export const tsconfigFindings = (options: SuperlintOptions) =>
	Effect.gen(function* () {
		const { root, packages } = yield* Repository
		const standard = yield* standardFindings
		const roster = yield* rosterFindings
		const workspace = yield* workspaceFindings({ root, packages, effectFree: options.effectFree })
		return [...standard, ...roster, ...workspace]
	})

/** The workspaces that prove the workspace gate: in each `violating-*` one the root and every package draw a finding,
 * and in each `clean-*` one nothing does. */
const WORKSPACE_FIXTURES = `${import.meta.dirname}/fixtures/workspaces`

/** A fixture workspace's root package.json: the Effect-free list, as the repository's names it. */
const FixtureManifest = Schema.fromJsonString(
	Schema.Struct({
		superlint: Schema.Struct({ effectFree: SuperlintOptions.fields.effectFree })
	})
)

const decodeFixtureManifest = Schema.decodeUnknownEffect(FixtureManifest)

/** How one fixture workspace disagrees with the gate: the directories that should draw a finding and drew none, and
 * those that drew one and should not. */
type WorkspaceMismatch = Readonly<{
	workspace: string
	missing: ReadonlyArray<string>
	unexpected: ReadonlyArray<string>
}>

/** One fixture workspace's roots, read as the gate reads the repository: its packages are the directories under its
 * `packages/` that hold a package.json. */
const fixtureWorkspaceOf = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const manifestFile = `${root}/package.json`
		const text = yield* fs
			.readFileString(manifestFile)
			.pipe(Effect.mapError(inspectionFailure(manifestFile)))
		const manifest = yield* decodeFixtureManifest(text).pipe(
			Effect.mapError((cause) =>
				DevtoolFailure.make({ detail: `${manifestFile} needs a superlint.effectFree list`, cause })
			)
		)
		const directory = `${root}/packages`
		const holdsPackages = yield* fs
			.exists(directory)
			.pipe(Effect.mapError(inspectionFailure(directory)))
		const names = holdsPackages
			? yield* fs.readDirectory(directory).pipe(Effect.mapError(inspectionFailure(directory)))
			: []
		const packages = yield* Effect.filter(
			Arr.map(Arr.sort(names, Str.Order), (name) => `${directory}/${name}`),
			(leaf) => fs.exists(`${leaf}/package.json`).pipe(Effect.mapError(inspectionFailure(leaf)))
		)
		return { root, packages, effectFree: manifest.superlint.effectFree }
	})

/** Every fixture workspace against the gate, directory for directory. No fixture workspace of either kind is a
 * mismatch too: the gate is never proven by nothing. */
export const workspaceFixtureMismatches = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const names = yield* fs
		.readDirectory(WORKSPACE_FIXTURES)
		.pipe(Effect.mapError(inspectionFailure(WORKSPACE_FIXTURES)))
	const sorted = Arr.sort(names, Str.Order)
	const violating = Arr.filter(sorted, Str.startsWith("violating-"))
	const clean = Arr.filter(sorted, Str.startsWith("clean-"))
	if (!Arr.isReadonlyArrayNonEmpty(violating) || !Arr.isReadonlyArrayNonEmpty(clean)) {
		return yield* DevtoolFailure.make({
			detail: `${WORKSPACE_FIXTURES} needs a violating-* and a clean-* workspace`
		})
	}
	const mismatches = yield* Effect.forEach([...violating, ...clean], (name) =>
		Effect.gen(function* () {
			const workspace = yield* fixtureWorkspaceOf(`${WORKSPACE_FIXTURES}/${name}`)
			const findings = yield* workspaceFindings(workspace)
			const reported = Arr.dedupe(Arr.map(findings, (finding) => path.dirname(finding.file)))
			const expected = Str.startsWith("violating-")(name)
				? [workspace.root, ...workspace.packages]
				: []
			const missing = Arr.difference(expected, reported)
			const unexpected = Arr.difference(reported, expected)
			return Arr.isReadonlyArrayNonEmpty(missing) || Arr.isReadonlyArrayNonEmpty(unexpected)
				? Option.some({ workspace: workspace.root, missing, unexpected })
				: Option.none<WorkspaceMismatch>()
		})
	)
	return { workspaces: violating.length + clean.length, mismatches: Arr.getSomes(mismatches) }
})
