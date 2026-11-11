/**
 * The side-effect-free rule (packages/devtools/src/oxlint/rules/side-effect-free.ts), searched over programs drawn from
 * a grammar of its own contract: functions marked `@__NO_SIDE_EFFECTS__`, and unmarked ones, whose bodies hold sites
 * the contract proves (their own locals read, assigned and called, the language's constants, proven calls, Math's
 * functions and conversions, `toString` on a primitive, a proven constant of the module or a listed one, a marked or
 * listed proven function, what a proven factory returns, a parameter's property called as a callback, a call passing
 * a proven callback) beside sites it refuses (an outer read or write, an unproven constant, a property written,
 * changed or deleted, a parameter or a method of a value called, a global called, Math.random, a value frozen it does
 * not build, a callback no proof covers, the forbidden syntax), marks on no function, and a proof's own module, each
 * claim of the options kept or broken. Every site carries the number of reports the contract gives it inside a marked
 * function, and a call passing a callback the number it gives it anywhere, and oxlint's RuleTester, run in the case,
 * must find exactly that many.
 *
 * Oracle: the specification, the rule's JSDoc read over the lists its module exports (MARKS, BUILTIN_CALLS,
 * MATH_FUNCTIONS, CALLABLE_GLOBALS, PURE_GLOBALS, FORBIDDEN), never a list written again here. Features: a proven
 * site, a refused site, an unmarked function, a misplaced mark, a proof's module, and a program of several functions.
 *
 * Plants (~/.cache/grizzle-release/LIVE-CLIENT/plants): side-effect-free-member-write-blind (a property assigned read
 * as no write), side-effect-free-parameter-call-admitted (a parameter called read as a function literal it declares),
 * side-effect-free-freeze-any (Object.freeze of a value it does not build admitted), side-effect-free-callable-any-global
 * (any global called), side-effect-free-tostring-any-receiver (`toString` of any value), side-effect-free-constant-any-
 * initializer (a module const read whatever its value) and side-effect-free-callback-unproven (a call site's callback
 * left unproven).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import {
	BUILTIN_CALLS,
	CALLABLE_GLOBALS,
	FORBIDDEN,
	MARKS,
	MATH_FUNCTIONS,
	PURE_GLOBALS,
	sideEffectFree
} from "#devtools/oxlint/rules/side-effect-free.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** The placeholder of a site's own suffix, so the locals of two sites of one function never share a name. */
const OWN = "§"

/** The module the drawn programs import proven functions from, and the file that proves them. */
const PROVEN_SPECIFIER = "#proven/module.ts"
const PROVEN_FILE = "proven/module.ts"

/**
 * The options every case runs under: one module of other files, which proves a function, a factory, a function that
 * calls its argument's `compute`, and a constant.
 */
const OPTIONS = Object.freeze({
	modules: [
		{
			file: PROVEN_FILE,
			specifiers: [PROVEN_SPECIFIER],
			functions: [
				{ name: "proven", returns: "values", invokes: [] },
				{ name: "provenFactory", returns: "functions", invokes: [] },
				{
					name: "provenHigher",
					returns: "values",
					invokes: [{ parameter: 0, property: "compute" }]
				}
			],
			constants: ["provenConstant"]
		}
	]
})

/**
 * What every program starts from: the proven module's functions, constant and one it does not list; a module variable;
 * module constants proven (a frozen literal, a primitive, a marked call's result) and one not (a literal unfrozen); and
 * a marked function, factory and function calling its argument's callback, of its own, which the drawn sites call.
 */
const HEADER = `import { proven, provenConstant, provenFactory, provenHigher, unlisted } from "${PROVEN_SPECIFIER}"
let outer = 0
/* @__NO_SIDE_EFFECTS__ */
const helper = (value: number): number => value + 1
/* @__NO_SIDE_EFFECTS__ */
const factory = () => (value: number): number => value * 2
/* @__NO_SIDE_EFFECTS__ */
const higher = (spec: { readonly f: (x: number) => number }): number => spec.f(1)
const frozen = Object.freeze({ n: 1 })
const text = "t"
const made = helper(1)
const loose = { n: 1 }
`

/**
 * One statement of a function's body, with the reports the contract gives it inside a marked function, and the ones
 * it gives it wherever it stands, which a call site of a function that calls a callback draws.
 */
type Site = Readonly<{ code: string; reports: number; always: number }>

const site = (code: string, reports: number): Site => ({ code, reports, always: 0 })

/** A call site of a function that calls a callback: the reports it draws in a marked function and in any other alike. */
const callSite = (code: string, reports: number): Site => ({ code, reports, always: reports })

/** One name of a list the rule exports. */
const oneOf = (names: ReadonlyArray<string>): Gen<string> =>
	element(Option.getOrThrow(Option.liftPredicate(names, Arr.isReadonlyArrayNonEmpty)))

/** A proven call of the language's own: an object of BUILTIN_CALLS and one of its proven properties. */
const builtinCall: Gen<string> = (source) => {
	const objects = Arr.filter([...BUILTIN_CALLS.keys()], (object) => object !== "Object")
	const object = source.draw(oneOf(objects))
	const property = source.draw(oneOf(BUILTIN_CALLS.get(object) ?? []))
	return `${object}.${property}(p${OWN}.n)`
}

/** Each forbidden node type's site, a statement holding exactly one node of that type and nothing else refused. */
const FORBIDDEN_SITES: ReadonlyArray<readonly [string, string]> = [
	["ThisExpression", `const t${OWN} = function () { return this }`],
	["AwaitExpression", `const w${OWN} = async () => await 1`],
	["YieldExpression", `const y${OWN} = function* () { yield 1 }`],
	["ThrowStatement", `if (p${OWN}.n < 0) { throw 0 }`],
	["TaggedTemplateExpression", `const tag${OWN} = (x: TemplateStringsArray) => x\ntag${OWN}\`x\``],
	["ImportExpression", `const i${OWN} = () => import("x")`],
	["NewExpression", `const a${OWN} = new Array(1)`],
	["ClassExpression", `const c${OWN} = class {}`],
	["MetaProperty", `const u${OWN} = import.meta`],
	["DebuggerStatement", "debugger"]
]

/** The sites of the node types FORBIDDEN names that a statement of a module function can hold. */
const forbiddenCodes = Object.freeze(
	Arr.filterMap(FORBIDDEN_SITES, ([type, code]) =>
		FORBIDDEN.has(type) ? Result.succeed(code) : Result.failVoid
	)
)

/** A statement holding one forbidden node, as FORBIDDEN names them: one report. */
const forbiddenSite: Gen<Site> = (source) => site(source.draw(oneOf(forbiddenCodes)), 1)

/** Sites the contract proves: none reports. */
const provenSites: Gen<Site> = weighted([
	[2, () => site(`const l${OWN} = p${OWN}.n + 1`, 0)],
	[2, () => site(`let m${OWN} = 0\nm${OWN} += p${OWN}.n`, 0)],
	[2, () => site(`let [a${OWN}, b${OWN}] = [1, 2]\n;[a${OWN}, b${OWN}] = [b${OWN}, a${OWN}]`, 0)],
	[2, (s) => site(`const g${OWN} = ${s.draw(oneOf(PURE_GLOBALS))}`, 0)],
	[2, (s) => site(`const k${OWN} = ${s.draw(builtinCall)}`, 0)],
	[2, () => site(`const f${OWN} = Object.freeze({ n: p${OWN}.n })`, 0)],
	[2, () => site(`const h${OWN} = (x: number) => x * 2\nh${OWN}(1)`, 0)],
	[1, () => site(`function d${OWN}() { return 1 }\nd${OWN}()`, 0)],
	[2, () => site(`const e${OWN} = helper(p${OWN}.n)`, 0)],
	[2, () => site(`const r${OWN} = factory()(1)`, 0)],
	[2, () => site(`const v${OWN} = proven(1) + provenFactory()(1)`, 0)],
	[1, () => site(`const i${OWN} = ((x: number) => x)(1)`, 0)],
	[1, () => site(`const j${OWN} = p${OWN}.n\nconst o${OWN} = j${OWN}`, 0)],
	[2, (s) => site(`const ma${OWN} = Math.${s.draw(oneOf(MATH_FUNCTIONS))}(p${OWN}.n)`, 0)],
	[2, (s) => site(`const cv${OWN} = ${s.draw(oneOf(CALLABLE_GLOBALS))}(p${OWN}.n)`, 0)],
	[2, () => site(`const ts${OWN} = (p${OWN}.n + 1).toString() + (2n ** 3n).toString(16)`, 0)],
	[2, () => site(`const rc${OWN} = frozen.n + text.length + made + provenConstant`, 0)],
	[1, () => site(`const pc${OWN} = p${OWN}.toString()`, 0)],
	[2, () => callSite(`const hc${OWN} = higher({ f: (x: number) => x + frozen.n })`, 0)],
	[
		2,
		() => callSite(`const ph${OWN} = provenHigher({ compute: (x: number) => Math.max(x, 2) })`, 0)
	],
	[1, () => callSite(`const hp${OWN} = higher({ f: helper })`, 0)]
])

/** Sites the contract refuses, each with its reports. */
const refusedSites: Gen<Site> = weighted([
	[2, () => site("outer += 1", 1)],
	[2, () => site(`const o${OWN} = outer`, 1)],
	[2, () => site(`p${OWN}.n = 1`, 1)],
	[1, () => site(`;[p${OWN}.n] = [1]`, 1)],
	[2, () => site(`p${OWN}.n++`, 1)],
	[1, () => site(`delete p${OWN}.n`, 1)],
	[2, () => site(`const c${OWN} = cb${OWN}()`, 1)],
	[2, () => site(`console.log(1)`, 2)],
	[2, () => site(`const z${OWN} = Object.freeze(p${OWN})`, 1)],
	[1, () => site(`const y${OWN} = Object.assign({}, {})`, 1)],
	[2, () => site(`const x${OWN} = parseInt("1")`, 2)],
	[2, () => site(`const mr${OWN} = Math.random()`, 1)],
	[2, () => site(`const ft${OWN} = frozen.toString()`, 1)],
	[2, () => site(`const lo${OWN} = loose.n`, 1)],
	[2, () => callSite(`const hb${OWN} = higher({ f: (x: number) => x + outer })`, 1)],
	[1, () => callSite(`const hl${OWN} = higher(p${OWN})`, 1)],
	[1, () => callSite(`const hh${OWN} = higher({ f: higher })`, 1)],
	[1, () => callSite(`const hs${OWN} = higher({ ...frozen, f: helper })`, 1)],
	[1, () => callSite(`const pb${OWN} = provenHigher({ compute: () => outer })`, 1)],
	[2, () => site(`const q${OWN} = helper(1)(2)`, 1)],
	[2, () => site(`const w${OWN} = unlisted(1)`, 1)],
	[3, forbiddenSite]
])

/** A function of a program: whether it is marked, by which of MARKS, and its sites. */
type Drawn = Readonly<{ mark: Option.Option<string>; sites: ReadonlyArray<Site> }>

const drawnFunction: Gen<Drawn> = (source) => ({
	mark: source.draw(boolean) ? Option.some(source.draw(oneOf(MARKS))) : Option.none(),
	sites: source.draw(
		array(
			weighted<Site>([
				[1, provenSites],
				[1, refusedSites]
			]),
			{ min: 1, max: 3 }
		)
	)
})

/** A program: its functions, whether it closes with a mark on no function, and its text and reports. */
type Program = Readonly<{
	functions: ReadonlyArray<Drawn>
	stray: boolean
	code: string
	reports: number
}>

/** A function's text: its mark, its parameters and its sites, each site's locals under the function's place. */
const textOf = (drawnOne: Drawn, at: number): string => {
	const mark = Option.match(drawnOne.mark, {
		onNone: () => "",
		onSome: (each) => `/* ${each} */\n`
	})
	const body = Arr.join(
		Arr.map(drawnOne.sites, (each, place) => Str.replaceAll(OWN, `${at}_${place}`)(each.code)),
		"\n"
	)
	const named = Arr.join(
		Arr.map(
			drawnOne.sites,
			(_each, place) => `p${at}_${place}: { n: number }, cb${at}_${place}: () => number`
		),
		", "
	)
	return `${mark}const fn${at} = (${named}): number => {\n${body}\nreturn 0\n}`
}

const programs: Gen<Program> = (source) => {
	const functions = source.draw(array(drawnFunction, { min: 1, max: 3 }))
	const stray = source.draw(boolean)
	const reports =
		Arr.reduce(functions, 0, (sum, each) =>
			Option.isSome(each.mark)
				? sum + Arr.reduce(each.sites, 0, (inner, one) => inner + one.reports)
				: sum + Arr.reduce(each.sites, 0, (inner, one) => inner + one.always)
		) + (stray ? 1 : 0)
	const code = Arr.join(
		[
			HEADER,
			...Arr.map(functions, textOf),
			...(stray ? [`/* ${MARKS[0] ?? ""} */\nexport const stray = 1`] : [])
		],
		"\n"
	)
	return { functions, stray, code, reports }
}

/** A proof's own module: the proven functions and constant as the options claim them, or one claim broken. */
type Home = Readonly<{ code: string; reports: number; broken: boolean }>

/** The proof's module's declarations, each as the options claim it or broken, by name. */
const HOME_PARTS = {
	proven: [
		`/* ${MARKS[0] ?? ""} */\nexport const proven = (value: number): number => value`,
		"export const proven = (value: number): number => value"
	],
	provenFactory: [
		`/* ${MARKS[0] ?? ""} */\nexport const provenFactory = () => (value: number): number => value`,
		`/* ${MARKS[0] ?? ""} */\nexport const provenFactory = (): number => 1`
	],
	provenHigher: [
		`/* ${MARKS[0] ?? ""} */\nexport const provenHigher = (spec: { readonly compute: (x: number) => number }): number => spec.compute(1)`,
		`/* ${MARKS[0] ?? ""} */\nexport const provenHigher = (spec: { readonly other: (x: number) => number }): number => spec.other(1)`
	],
	provenConstant: ["export const provenConstant = 3", "export const provenConstant = [3].length"]
} as const

const homes: Gen<Home> = (source) => {
	const parts = Arr.map(
		[
			HOME_PARTS.proven,
			HOME_PARTS.provenFactory,
			HOME_PARTS.provenHigher,
			HOME_PARTS.provenConstant
		],
		(choices) => {
			const broken = source.draw(
				weighted<boolean>([
					[3, () => false],
					[1, () => true]
				])
			)
			return { code: broken ? choices[1] : choices[0], broken }
		}
	)
	const broken = Arr.filter(parts, (part) => part.broken).length
	return {
		code: Arr.join(
			Arr.map(parts, (part) => part.code),
			"\n"
		),
		reports: broken,
		broken: broken > 0
	}
}

/** How RuleTester parses each program: a TypeScript module. */
const LANGUAGE = { sourceType: "module", parserOptions: { lang: "ts" } } as const

RuleTester.describe = (_text, fn) => fn()
RuleTester.it = (_text, fn) => fn()

/** What RuleTester makes of a text at a file: none when the rule reports it exactly `reports` times, else its failure. */
const judged = (code: string, filename: string, reports: number): Option.Option<string> => {
	const ran = Result.try(() =>
		new RuleTester({ languageOptions: LANGUAGE }).run(
			"side-effect-free",
			sideEffectFree,
			reports === 0
				? { valid: [{ code, filename, options: [OPTIONS] }], invalid: [] }
				: { valid: [], invalid: [{ code, filename, options: [OPTIONS], errors: reports }] }
		)
	)
	return Result.match(ran, {
		onSuccess: () => Option.none(),
		onFailure: (failure) => Option.some(Formatter.format(failure))
	})
}

type Feature =
	| "a proven site"
	| "a refused site"
	| "an unmarked function"
	| "a misplaced mark"
	| "a program of several functions"

describe("side-effect-free", () => {
	it.effect(
		"reports exactly what its contract refuses in a marked function, and nothing else",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/dev/side-effect-free",
						oracle: {
							kind: "specification",
							name: "the rule's stated contract over the lists its module exports"
						},
						draw: drawn(programs),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a proven site",
								"a refused site",
								"an unmarked function",
								"a misplaced mark",
								"a program of several functions"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(program, c) =>
						Effect.sync(() => {
							for (const each of program.functions) {
								if (Option.isNone(each.mark)) {
									c.note("an unmarked function")
								}
								for (const one of each.sites) {
									c.note(one.reports > 0 ? "a refused site" : "a proven site")
								}
							}
							if (program.stray) {
								c.note("a misplaced mark")
							}
							if (program.functions.length > 1) {
								c.note("a program of several functions")
							}
							assert.deepEqual(judged(program.code, "src/drawn.ts", program.reports), Option.none())
						})
				)
			)
	)

	it.effect("holds a proof's own module to the claims the options make of it", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/dev/side-effect-free-home",
					oracle: {
						kind: "specification",
						name: "the rule's stated contract: a listed function is marked, a listed factory returns function literals"
					},
					draw: drawn(homes),
					literal: Formatter.format,
					coverage: required<"a claim kept" | "a claim broken">(
						["a claim kept", "a claim broken"],
						{
							cases: 50,
							sense: notesOnly
						}
					),
					kept: [],
					runs: 50,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(home, c) =>
					Effect.sync(() => {
						c.note(home.broken ? "a claim broken" : "a claim kept")
						assert.deepEqual(judged(home.code, PROVEN_FILE, home.reports), Option.none())
					})
			)
		)
	)
})
