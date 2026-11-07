import { NodeServices } from "@effect/platform-node"
import { describe, it, layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Order,
	pipe,
	type PlatformError,
	String as Str
} from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { assert, defined, like, matchers, nonEmpty } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { caseHang } from "#test/support/limits.ts"
import { hardenedNode, run, runOptions, sourceCondition } from "#test/support/process.ts"
import {
	auditSource,
	entriesOf,
	type Finding,
	modulesIn,
	type PackageJson,
	packageDirectories,
	packageOf
} from "#test/unit/deps/audit.ts"
import {
	expectedOf,
	moduleText,
	type PlantedFeature,
	plantedFeatures,
	plantedModule
} from "#test/unit/deps/planted.ts"

/**
 * The production dependency audit: no RegExp construction, .test or .exec, no arkregex runtime import, and no eval or
 * Function constructor under src/.
 *
 * 1. The audit itself is checked first, on generated planted modules (planted.ts): every RegExp construction, match
 *    and code generation the generator plants, in every place an expression or a statement begins, is found on its
 *    line, and nothing in strings, templates, comments, divisions, types or an effect module's match is; every import
 *    is read as Node runs it, type-only ones erased. So an empty finding list below means a clean tree.
 * 2. Every module under src/, read as the JavaScript Node runs (audit.ts), has no RegExp construction, no regex
 *    matching member, no runtime import of arkregex or its @ark packages, and no eval or Function constructor: an
 *    exhaustion of the real tree, module by module.
 * 3. At runtime, in a child Node process: no module but a test's or ark's own resolves an arkregex or @ark module
 *    while every entry point loads and the text pipeline runs over every family pattern of the regex differential
 *    tests, and src/ calls no RegExp.
 *
 * The layering (which areas a module may import) is fallow's boundaries (.fallowrc.json), and the packages an area may
 * load are oxlint's no-restricted-imports (oxlint.config.ts).
 */
const root = repoRoot

/** Every TypeScript module under dir, as paths relative to root (which ends in a slash), sorted (audit.ts modulesIn). */
const modulesUnder = (
	dir: string
): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const entries = yield* fs.readDirectory(`${root}${dir}`, { recursive: true })
		return modulesIn(entries, dir)
	})

/** The packages' entry points (audit.ts entriesOf), read from each package.json under root, sorted, each once. */
const entryPoints: Effect.Effect<
	ReadonlyArray<string>,
	PlatformError.PlatformError,
	FileSystem.FileSystem
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const targets: Array<string> = []
	for (const directory of packageDirectories) {
		const text = yield* fs.readFileString(`${root}packages/${directory}/package.json`)
		appendAll(targets, entriesOf(directory, trustedJson<PackageJson>(text)))
	}
	return Arr.sort(Arr.dedupe(targets), Order.String)
})

/** arkregex and the @ark packages it loads at runtime (@ark/util). */
const isArk = (specifier: string): boolean =>
	packageOf(specifier) === "arkregex" || Str.startsWith("@ark/")(specifier)

/** A resolved module URL of arkregex or an @ark package. */
const isArkUrl = (url: string): boolean =>
	Str.includes("/node_modules/arkregex/")(url) || Str.includes("/@ark/")(url)

const show = (findings: ReadonlyArray<Finding>): Array<string> =>
	Arr.map(findings, (f) => `${f.file}:${f.line}: ${f.rule} ${Formatter.format(f.text)}`)

describe("the audit finds what it must", () => {
	it.effect(
		"finds exactly what a generated module plants, on its line, and reads its imports as Node runs them",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/deps/planted",
						draw: drawn(plantedModule),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the findings each planted piece states, line by line in the order the module states them"
						},
						coverage: required<PlantedFeature>(plantedFeatures, { cases: 2000, sense: notesOnly }),
						kept: [],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(pieces, c) =>
						Effect.sync(() => {
							const text = moduleText(pieces)
							const expected = expectedOf(pieces)
							const audit = auditSource("planted.ts", text)
							const regexFound: ReadonlyArray<readonly [number, string]> = Arr.map(
								audit.regex,
								(f) => [f.line, f.rule] as const
							)
							const codeFound: ReadonlyArray<readonly [number, string]> = Arr.map(
								audit.dynamicCode,
								(f) => [f.line, f.rule] as const
							)
							const importsFound: ReadonlyArray<readonly [number, string, string]> = Arr.map(
								audit.imports,
								(i) => [i.line, i.kind, i.specifier] as const
							)
							const opaqueFound: ReadonlyArray<readonly [number, string]> = Arr.map(
								audit.opaque,
								(f) => [f.line, f.text] as const
							)
							assert.deepEqual(regexFound, expected.regex, text)
							assert.deepEqual(codeFound, expected.code, text)
							assert.deepEqual(importsFound, expected.imports, text)
							assert.deepEqual(opaqueFound, expected.opaque, text)
							for (const piece of pieces) {
								c.noteAll(piece.features)
							}
						})
				)
			)
	)
})

/** A module under a package's src, by its path from the root, with its source text. */
interface SourceModule {
	readonly file: string
	readonly source: string
}

/** Every module under both packages' src with its source text. */
const sources = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const modules = yield* Effect.forEach(["packages/engine/src", "packages/grizzle/src"], (dir) =>
		modulesUnder(dir)
	)
	return yield* Effect.forEach(Arr.flatten(modules), (file) =>
		Effect.map(fs.readFileString(`${root}${file}`), (source): SourceModule => ({ file, source }))
	)
})

layer(NodeServices.layer, { excludeTestServices: true })(
	"src/ has no RegExp and no arkregex runtime",
	(it) => {
		it.effect(
			"audits every src/ module: no RegExp construction or match, no eval or Function constructor, no arkregex or @ark at runtime",
			(ctx) =>
				Effect.gen(function* () {
					const read = yield* sources
					const files = nonEmpty(read, "the src/ modules")
					return yield* searched(
						ctx,
						exhaust(
							{
								suite: "unit/deps/src",
								generator: element(files),
								literal: (f: SourceModule) => f.file,
								limit: files.length,
								coverage: noCoverage,
								box: "every TypeScript module under packages/engine/src and packages/grizzle/src",
								oracle: {
									kind: "specification",
									name: "the audit's rules, checked on planted modules above"
								},
								caseHang
							},
							({ file, source }: SourceModule) =>
								Effect.sync(() => {
									const audit = auditSource(file, source)
									assert.deepEqual(show(audit.regex), [], file)
									assert.deepEqual(show(audit.dynamicCode), [], file)
									assert.deepEqual(show(audit.opaque), [], file)
									assert.deepEqual(
										Arr.map(
											Arr.filter(audit.imports, (imp) => isArk(imp.specifier)),
											(imp) => `${imp.line}: ${imp.kind} import of ${imp.specifier}`
										),
										[],
										file
									)
								})
						)
					)
				})
		)
	}
)

layer(NodeServices.layer, { excludeTestServices: true })("runtime", (it) => {
	/** A module URL Node resolved, and the module whose import asked for it. */
	type Resolved = { readonly importer: string; readonly url: string }
	/** A trapped call and the frame that made it. */
	type Trapped = { readonly kind: string; readonly frame: string }
	/** The probe's one JSON line, which runtime-probe.ts, the test's own child process, prints. */
	type ProbeOutput = {
		readonly control: boolean
		readonly controlLine: number
		readonly protoAccessor: boolean
		readonly resolved: ReadonlyArray<Resolved>
		readonly trapped: ReadonlyArray<Trapped>
		readonly loads: ReadonlyArray<{
			readonly module: string
			readonly resolved: ReadonlyArray<Resolved>
			readonly trapped: ReadonlyArray<Trapped>
		}>
		readonly loadedTrapped: number
		readonly admitted: number
		readonly checked: number
		readonly refused: number
		readonly decoded: number
	}

	/** The negative control: a module that builds and runs RegExps at load, on lines 5, 6 and 8. */
	const planted = "test/unit/deps/fixtures/planted-regex.ts"

	/** The probe is a child of the test: it is killed if the test is interrupted, and ends only once it has exited. */
	const probe = (modules: ReadonlyArray<string>) =>
		Effect.gen(function* () {
			const result = yield* run(
				process.execPath,
				[
					sourceCondition,
					...hardenedNode,
					`${root}test/unit/deps/runtime-probe.ts`,
					root,
					...modules
				],
				{ ...runOptions, cwd: root }
			)
			assert.equal(result.status, 0, `runtime probe failed:\n${result.stderr}`)
			const last = Option.getOrThrowWith(
				Arr.last(Str.split(Str.trim(result.stdout), "\n")),
				() => new Error("the runtime probe printed nothing")
			)
			return trustedJson<ProbeOutput>(last)
		})

	/**
	 * The trapped calls made from modules under a directory of the repository: the one filter every check below uses.
	 */
	const trappedUnder = (trapped: ReadonlyArray<Trapped>, dir: string): Array<string> =>
		Arr.map(
			Arr.filter(trapped, (t) => pipe(t.frame, Str.includes(`${root}${dir}/`))),
			(t) => `${t.kind} ${t.frame}`
		)

	/**
	 * The arkregex and @ark modules loaded from neither a test module nor arkregex's own: arkregex is the tests' regex
	 * door (no-raw-regexp), so a test module may load it, and its own modules load @ark; src, and every dependency src
	 * loads, never does.
	 */
	const arkBeyondTests = (resolved: ReadonlyArray<Resolved>): ReadonlyArray<Resolved> =>
		Arr.filter(
			resolved,
			(r) => isArkUrl(r.url) && !isArkUrl(r.importer) && !Str.includes(`${root}test/`)(r.importer)
		)

	it.effect(
		"runs under hardened Node, and loads every entry point, each reaching no arkregex module and no RegExp from src/, and drives every text parser so",
		(ctx) =>
			Effect.gen(function* () {
				assert.equal(
					Object.getOwnPropertyDescriptor(Object.prototype, "__proto__"),
					undefined,
					"this test process has Object.prototype.__proto__: the runner did not apply --disable-proto=delete"
				)
				const entries = yield* entryPoints
				const out = yield* probe([...entries, planted])
				assert.equal(
					out.protoAccessor,
					false,
					"the probe ran with Object.prototype.__proto__ (--disable-proto=delete)"
				)
				assert.equal(out.control, true)
				const control = `test/unit/deps/runtime-probe.ts:${out.controlLine}:`
				like(
					Arr.map(
						Arr.filter(out.trapped, (t) => Str.includes(control)(t.frame)),
						(t) => t.kind
					),
					matchers.arrayContaining(["new RegExp", "exec"])
				)
				assert.deepEqual(
					Arr.filter(out.trapped, (t) =>
						regex(" at (?:RegExp\\.exec|Object\\.(?:construct|apply)) ").test(` ${t.frame} `)
					),
					[]
				)
				/**
				 * The filter can fire: the planted module's construction, its literal's match and its String.prototype.match
				 * are each found under its directory, on their own lines.
				 */
				const fromPlanted = trappedUnder(out.trapped, "test/unit/deps/fixtures")
				assert.equal(
					Arr.filter(
						fromPlanted,
						(t) => Str.startsWith("new RegExp at ")(t) && Str.includes("planted-regex.ts:5:")(t)
					).length,
					1
				)
				assert.deepEqual(
					Arr.map(
						[5, 6, 8],
						(line) =>
							Arr.filter(
								fromPlanted,
								(t) => Str.startsWith("exec at ")(t) && Str.includes(`planted-regex.ts:${line}:`)(t)
							).length
					),
					[1, 1, 1],
					"one exec on each of lines 5, 6 and 8"
				)
				assert.ok(out.admitted > 50)
				assert.ok(out.checked > 500)
				assert.equal(out.refused, 9)
				assert.ok(out.decoded > 70)
				assert.deepEqual(
					Arr.filter(
						[
							"text/field.ts",
							"codec/scalar.ts",
							"scalar/values/float.ts",
							"lower/shapes/aggregate/index.ts"
						],
						(module) =>
							!Arr.some(out.resolved, (r) => Str.includes(`/packages/engine/src/${module}`)(r.url))
					),
					[]
				)
				assert.deepEqual(arkBeyondTests(out.resolved), [], "the probe's whole run")
				assert.deepEqual(trappedUnder(out.trapped, "packages"), [], "the probe's whole run")
				const loads = new Map(Arr.map(out.loads, (load) => [load.module, load] as const))
				return yield* searched(
					ctx,
					exhaust(
						{
							suite: "unit/deps/entry points",
							generator: element(nonEmpty(entries, "the packages' entry points")),
							literal: Formatter.format,
							limit: entries.length,
							coverage: noCoverage,
							box: "every entry point the packages' package.json exports and bins name",
							oracle: {
								kind: "specification",
								name: "what the entry's load resolved and trapped, in a child Node under the RegExp trap"
							},
							caseHang
						},
						(entry) =>
							Effect.sync(() => {
								const load = defined(loads.get(entry), `the probe loaded ${entry}`)
								assert.deepEqual(arkBeyondTests(load.resolved), [], `${entry}: arkregex or @ark`)
								assert.deepEqual(trappedUnder(load.trapped, "packages"), [], `${entry}: a RegExp`)
							})
					)
				)
			})
	)
})
