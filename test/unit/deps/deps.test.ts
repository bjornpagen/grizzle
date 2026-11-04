import { NodeServices } from "@effect/platform-node"
import { describe, it, layer } from "@effect/vitest"
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
	Schema,
	String as Str
} from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { assert, contains, containsText, like, matchers } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { hardenedNode, run, runOptions, sourceCondition } from "#test/support/process.ts"
import {
	auditSource,
	entriesOf,
	erase,
	type Finding,
	modulesIn,
	PackageJson,
	packageDirectories,
	packageOf
} from "#test/unit/deps/audit.ts"
import { tokenize } from "#test/unit/deps/lexer.ts"

/**
 * The planted modules are JavaScript source text, templates included.
 * The production dependency audit: no RegExp construction, .test or .exec, and no arkregex runtime import, under src/.
 *
 * 1. The audit itself is checked first, on planted modules: it must find every planted violation and nothing in
 *    strings, comments, divisions or type-only imports, so an empty finding list below means a clean tree.
 * 2. Every module under src/, read as the JavaScript Node runs (audit.ts), has no RegExp construction, no regex
 *    matching member, no runtime import of arkregex or its @ark packages, and no eval or Function constructor.
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

const decodePackageJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJson))

/** The packages' entry points (audit.ts entriesOf), read from each package.json under root, sorted, each once. */
const entryPoints: Effect.Effect<
	ReadonlyArray<string>,
	PlatformError.PlatformError | Schema.SchemaError,
	FileSystem.FileSystem
> = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const targets: Array<string> = []
	for (const directory of packageDirectories) {
		const pkg = yield* Effect.flatMap(
			fs.readFileString(`${root}packages/${directory}/package.json`),
			decodePackageJson
		)
		appendAll(targets, entriesOf(directory, pkg))
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
	it("tokenizes strings, templates, comments and divisions without inventing a regex", () => {
		/** A `)` that closes no statement header and a `}` that closes no block end a value. */
		const tokens = tokenize(
			Arr.join(
				[
					'const a = "RegExp /x/.test" // new RegExp("b")',
					`/* /c/.exec(d) */ const e = \`RegExp \${f / g} /h/\` / 2`,
					"const i = (j) / k / l, m = [n] / o, p = q++ / r",
					`const s = \`\${\`\${t}\`}\` + u`,
					"const v = (w) / x, y = { z: 1 }.z / 2, aa = f(bb) / cc, dd = [{}][0] / 2, ee = ({}) / 3",
					"if (ff) gg = (hh) / ii; else jj = kk(ll) / mm",
					"for (const nn of oo) pp = { qq: 1 }.qq / rr(ss) / tt"
				],
				"\n"
			)
		)
		assert.deepEqual(
			Arr.filter(tokens, (t) => t.kind === "regex"),
			[]
		)
		assert.deepEqual(
			Arr.filter(tokens, (t) => t.kind === "ident" && t.text === "RegExp"),
			[]
		)
		assert.equal(Option.getOrThrow(Arr.findFirst(tokens, (t) => t.text === "u")).line, 4)
		assert.equal(Option.getOrThrow(Arr.findFirst(tokens, (t) => t.text === "tt")).line, 7)
	})

	it("finds every planted RegExp construction and matching member", () => {
		/**
		 * After a statement header's `)` and after a block's `}` a statement begins, so `/` begins a regex; a
		 * quote or backtick inside one must not open a string that swallows the code after it.
		 */
		const planted = Arr.join(
			[
				"export const a = new RegExp('x')",
				"export const b = RegExp('y')",
				"export const c = /z+/u",
				"export const d = (s: string) => /^w$/.test(s)",
				"export const e = (r: { exec(s: string): unknown }, s: string) => r.exec(s)",
				"export const f = (s: string) => s.match('v')",
				"export const g = (s: string) => s?.search('t')",
				"export const h = (s: string) => [...s.matchAll(globalThis.RegExp('u', 'g'))]",
				"export function k(s: string) { return /q/.source + s }",
				"export const l = (s: string) => { if (s) return; /r/.lastIndex }",
				"export const m = (s: string) => { if (s) /a/g.lastIndex = 0 }",
				"export const n = () => { for (;;) {} /b/.source }",
				"export function o(s: string) { while (s) s = s.slice(1) } /c'`/.source",
				"export const p = () => { { } /d/.flags }",
				"export const q = () => { try { } finally { } /e/.global }",
				"export const r = (s: string) => { switch (s) { } /f/.sticky }",
				"export const t = (s: string) => { while (s) /g\\//.test(s) }"
			],
			"\n"
		)
		const audit = auditSource("planted.ts", planted)
		assert.deepEqual(
			Arr.map(audit.regex, (f) => `${f.line}:${f.rule}`),
			[
				"1:RegExp reference",
				"2:RegExp reference",
				"3:regex literal",
				"4:regex literal",
				"4:.test member",
				"5:.exec member",
				"6:.match member",
				"7:.search member",
				"8:.matchAll member",
				"8:RegExp reference",
				"9:regex literal",
				"10:regex literal",
				"11:regex literal",
				"12:regex literal",
				"13:regex literal",
				"14:regex literal",
				"15:regex literal",
				"16:regex literal",
				"17:regex literal",
				"17:.test member"
			]
		)
	})

	it("ignores RegExp in comments, strings, types, instanceof and division", () => {
		const clean = Arr.join(
			[
				"// RegExp is never constructed; /a/.test is never called",
				"export const a = 'a RegExp object or /x/.exec is refused'",
				"export const b = (x: unknown): x is RegExp => x instanceof RegExp",
				"export const c = (n: number, d: number): number => n / d / 2",
				"export type D = { readonly test: RegExp }",
				"export const e = { test: 1, exec: 2 }",
				"export const f = (when: { match: string }) => when.match === 'NOT MATCHED' ? when.match : ''"
			],
			"\n"
		)
		assert.deepEqual(auditSource("clean.ts", clean).regex, [])
	})

	it("reads runtime imports as Node runs them: type-only imports erased, `{ type X }` kept", () => {
		const source = Arr.join(
			[
				'import type { regex } from "arkregex"',
				'import { type Regex } from "arkregex"',
				'import { Result } from "effect"',
				'import * as text from "../text/index.ts"',
				'import "./side-effect.ts"',
				'export { a } from "./a.ts"',
				'export * from "./b.ts"',
				'export * as c from "./c.ts"',
				'export type { T } from "./t.ts"',
				'export const d = () => import("./d.ts")',
				"export const e = import.meta.url",
				"export const f = (m: string) => import(m)",
				"export { Result, text }"
			],
			"\n"
		)
		const audit = auditSource("imports.ts", source)
		assert.deepEqual(
			Arr.map(audit.imports, (i) => `${i.line}:${i.kind}:${i.specifier}`),
			[
				"2:static:arkregex",
				"3:static:effect",
				"4:static:../text/index.ts",
				"5:static:./side-effect.ts",
				"6:reexport:./a.ts",
				"7:reexport:./b.ts",
				"8:reexport:./c.ts",
				"10:dynamic:./d.ts"
			]
		)
		assert.deepEqual(show(audit.opaque), [
			'imports.ts:12: dynamic import of a computed specifier "import("'
		])
	})

	it("finds eval and the Function constructor", () => {
		const audit = auditSource(
			"code.ts",
			"export const a = eval('1')\nexport const b = new Function('return 1')\nexport const c = Function('x', 'x')\nexport const d = (o: { eval: number }) => o.eval"
		)
		assert.deepEqual(
			Arr.map(audit.dynamicCode, (f) => `${f.line}:${f.rule}`),
			["1:eval", "2:Function constructor", "3:Function constructor"]
		)
	})

	it("keeps erased positions, so a finding's line is the source line", () => {
		const source =
			"import type { A } from 'a'\ninterface B {\n\treadonly c: RegExp\n}\nexport const d = /e/"
		assert.equal(Str.split(erase(source), "\n").length, Str.split(source, "\n").length)
		assert.deepEqual(show(auditSource("lines.ts", source).regex), [
			'lines.ts:5: regex literal "/e/"'
		])
	})
})

/** Every module under both packages' src with its source text. */
const sources = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const modules = yield* Effect.forEach(["packages/engine/src", "packages/grizzle/src"], (dir) =>
		modulesUnder(dir)
	)
	const files = Arr.flatten(modules)
	return yield* Effect.forEach(files, (file) =>
		Effect.map(fs.readFileString(`${root}${file}`), (source) => ({ file, source }))
	)
})

layer(NodeServices.layer, { excludeTestServices: true })(
	"src/ has no RegExp and no arkregex runtime",
	(it) => {
		it.effect(
			"audits a complete src/ tree: no RegExp construction, no .test or .exec, no eval or Function constructor",
			() =>
				Effect.gen(function* () {
					const files = yield* sources
					assert.ok(files.length > 100)
					contains(
						Arr.map(files, (f) => f.file),
						"packages/engine/src/text/field.ts"
					)
					for (const { file, source } of files) {
						const audit = auditSource(file, source)
						assert.deepEqual(show(audit.regex), [], file)
						assert.deepEqual(show(audit.dynamicCode), [], file)
					}
				})
		)

		it.effect("imports arkregex and @ark only as types, never at runtime", () =>
			Effect.gen(function* () {
				const runtime: Array<string> = []
				let typeOnly = 0
				for (const { file, source } of yield* sources) {
					const audit = auditSource(file, source)
					for (const imp of audit.imports) {
						if (isArk(imp.specifier)) {
							runtime.push(`${file}:${imp.line}: ${imp.kind} import of ${imp.specifier}`)
						}
					}
					if (regex('from\\s+"arkregex"').test(source)) {
						typeOnly += 1
					}
					assert.deepEqual(show(audit.opaque), [])
				}
				assert.deepEqual(runtime, [])
				assert.ok(typeOnly >= 1)
				const fs = yield* FileSystem.FileSystem
				const text = yield* fs.readFileString(`${root}packages/engine/src/text/field.ts`)
				containsText(text, 'import type { regex } from "arkregex"')
			})
		)
	}
)

layer(NodeServices.layer, { excludeTestServices: true })("runtime", (it) => {
	it("runs every test file under hardened Node", () => {
		assert.equal(
			Object.getOwnPropertyDescriptor(Object.prototype, "__proto__"),
			undefined,
			"this test process has Object.prototype.__proto__: the runner did not apply --disable-proto=delete"
		)
	})

	/** The probe's one JSON line is the output of another process, admitted by its schema. */
	const ProbeOutput = Schema.Struct({
		control: Schema.Boolean,
		controlLine: Schema.Finite,
		protoAccessor: Schema.Boolean,
		resolved: Schema.Array(Schema.Struct({ importer: Schema.String, url: Schema.String })),
		trapped: Schema.Array(Schema.Struct({ kind: Schema.String, frame: Schema.String })),
		loadedTrapped: Schema.Finite,
		admitted: Schema.Finite,
		checked: Schema.Finite,
		refused: Schema.Finite,
		decoded: Schema.Finite
	})
	type ProbeOutput = typeof ProbeOutput.Type
	const decodeProbeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(ProbeOutput))

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
			return yield* decodeProbeOutput(last)
		})

	/**
	 * The trapped calls made from modules under a directory of the repository: the one filter both checks below use.
	 */
	const trappedUnder = (out: ProbeOutput, dir: string): Array<string> =>
		Arr.map(
			Arr.filter(out.trapped, (t) => pipe(t.frame, Str.includes(`${root}${dir}/`))),
			(t) => `${t.kind} ${t.frame}`
		)

	it.effect(
		"loads every entry point and drives every text parser under hardened Node, with no arkregex module and no RegExp from src/",
		() =>
			Effect.gen(function* () {
				const out = yield* probe([...(yield* entryPoints), planted])
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
				const fromPlanted = trappedUnder(out, "test/unit/deps/fixtures")
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
				/**
				 * The arkregex and @ark modules loaded from neither a test module nor arkregex's own: arkregex is the tests'
				 * regex door (no-raw-regexp), so a test module may load it, and its own modules load @ark; src, and every
				 * dependency src loads, never does.
				 */
				const arkBeyondTests = Arr.filter(
					out.resolved,
					(r) =>
						isArkUrl(r.url) && !isArkUrl(r.importer) && !Str.includes(`${root}test/`)(r.importer)
				)
				assert.deepEqual(arkBeyondTests, [])
				assert.deepEqual(trappedUnder(out, "packages"), [])
			}),
		120_000
	)
})
