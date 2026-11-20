/**
 * The production dependency audit: no RegExp construction, .test or .exec, no arkregex runtime import, and no eval or
 * Function constructor under src/.
 *
 * 1. Every module under src/, read as the JavaScript Node runs (audit.ts), has no RegExp construction, no regex
 *    matching member, no runtime import of arkregex or its @ark packages, and no eval or Function constructor: an
 *    exhaustion of the real tree, module by module.
 * 2. At runtime, in a child Node process of each entry point: no module but a test's or ark's own resolves an arkregex
 *    or @ark module while the entry point loads and the text pipeline runs over every family pattern of the regex
 *    differential tests, and src/ calls no RegExp. The trap is held to two controls: the probe's own construction, on the line it
 *    reports, and the planted module's (fixtures/planted-regex.ts), each RegExp it builds or runs found once on the
 *    line its text puts it on.
 *
 * Oracles: the audit's rules (1) and the trap's controls (2). Both read the repository's files and run its code from the
 * checkout's directory (Checkout.dir), so a mutant of a src/ module is what they read and load. Features: the real tree
 * and the real entry points are boxes of their own, which every module and entry point is a case of (1, 2).
 *
 * The layering (which areas a module may import) is fallow's boundaries (.fallowrc.json), and the packages an area may
 * load are oxlint's no-restricted-imports (oxlint.config.ts).
 */
import { assert, defined, like, matchers } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, FileSystem, String as Str } from "effect"
import { auditSource } from "#test/unit/deps/audit.ts"
import { entryPoints, srcModules } from "#test/unit/deps/deps.dictionary.ts"
import {
	arkBeyondTests,
	isArk,
	planted,
	plantedLines,
	probedEntries,
	show,
	trappedUnder
} from "#test/unit/deps/deps.fixtures.ts"

/** Src/ has no RegExp and no arkregex runtime: the audit of every src/ module finds no RegExp construction or match, no eval or Function constructor, no arkregex or @ark at runtime. */
export const srcHasNoRegExpAndNoArkregexRuntimeAuditsEverySrcModuleNoRegExpConstructionOrMatchNoEvalOrFunctionConstructorNoArkregexOrArkAtRuntime =
	property.exhaust(finite(word(srcModules)), {
		box: "every TypeScript module under packages/engine/src and packages/grizzle/src",
		needs: { checkout: Checkout.dir },
		situations: [],
		check: (resources) => (file) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const checkout = yield* resources.checkout
				const source = yield* fs.readFileString(`${checkout}/${file}`)
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
			}),
		oracle: {
			kind: "specification",
			name: "the audit's rules"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/sqlstate.ts",
				original:
					"/** The code a server reported, as a SQLSTATE, or undefined for any other text. */",
				replacement: `/** The body, checked once as the module loads against the code of success. */\nexport const sqlstateBodyHolds = new RegExp(\`^\${sqlstateBody}$\`).test("00000")\n\n/** The code a server reported, as a SQLSTATE, or undefined for any other text. */`,
				why: "A src module (core/sqlstate.ts) builds and runs a RegExp as it loads; the tree's audit and the runtime property fail."
			}
		]
	})

/** Runtime: it runs under hardened Node, and loads every entry point, each reaching no arkregex module and no RegExp from src/, and drives every text parser so. */
export const runtimeRunsUnderHardenedNodeAndLoadsEveryEntryPointEachReachingNoArkregexModuleAndNoRegExpFromSrcAndDrivesEveryTextParserSo =
	property.exhaust(finite(word(entryPoints)), {
		box: "every entry point the packages' package.json exports and bins name",
		needs: { checkout: Checkout.dir, probed: probedEntries },
		situations: [],
		check: (resources) => (entry) =>
			Effect.gen(function* () {
				const { root, out } = yield* resources.probed
				assert.equal(
					Object.getOwnPropertyDescriptor(Object.prototype, "__proto__"),
					undefined,
					"this test process has Object.prototype.__proto__: the runner did not apply --disable-proto=delete"
				)
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
				const fromPlanted = Arr.filter(out.trapped, (t) =>
					Str.includes(`${root}${planted}:`)(t.frame)
				)
				const trappedAt = (kind: string, line: number) =>
					Arr.filter(
						fromPlanted,
						(t) => t.kind === kind && Str.includes(`${root}${planted}:${line}:`)(t.frame)
					).length
				const { construction, matches } = yield* plantedLines(root)
				assert.deepEqual(
					{
						construction: Arr.map(construction, (line) => trappedAt("new RegExp", line)),
						matches: Arr.map(matches, (line) => trappedAt("exec", line))
					},
					{ construction: Arr.map(construction, () => 1), matches: Arr.map(matches, () => 1) },
					"the planted module's construction and each of its matches, once each, on its own line"
				)
				assert.ok(
					Arr.isReadonlyArrayNonEmpty(construction) && Arr.isReadonlyArrayNonEmpty(matches),
					"the planted module builds and runs a RegExp"
				)
				assert.deepEqual(arkBeyondTests(root, out.resolved), [], "the probe's whole run")
				assert.deepEqual(trappedUnder(root, out.trapped, "packages"), [], "the probe's whole run")
				const loads = new Map(Arr.map(out.loads, (load) => [load.module, load] as const))
				const load = defined(loads.get(entry), `the probe loaded ${entry}`)
				assert.deepEqual(arkBeyondTests(root, load.resolved), [], `${entry}: arkregex or @ark`)
				assert.deepEqual(trappedUnder(root, load.trapped, "packages"), [], `${entry}: a RegExp`)
			}),
		oracle: {
			kind: "specification",
			name: "what the entry's load resolved and trapped, in a child Node under the RegExp trap"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/sqlstate.ts",
				original:
					"/** The code a server reported, as a SQLSTATE, or undefined for any other text. */",
				replacement: `/** The body, checked once as the module loads against the code of success. */\nexport const sqlstateBodyHolds = new RegExp(\`^\${sqlstateBody}$\`).test("00000")\n\n/** The code a server reported, as a SQLSTATE, or undefined for any other text. */`,
				why: "A src module (core/sqlstate.ts) builds and runs a RegExp as it loads; the tree's audit and the runtime property fail."
			},
			{
				file: "packages/text/src/base/array.ts",
				original: "\tfor (let i = 0; i < n; i++) {",
				replacement: "\tfor (let i = 0; i >= n; i++) {",
				why: "Operator mutant (comparison) at packages/engine/src/core/array.ts:25 in indices: `<` becomes `>=`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
