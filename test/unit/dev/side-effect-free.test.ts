/**
 * The side-effect-free rule (packages/devtools/src/oxlint/rules/side-effect-free.ts), searched over programs drawn from
 * a grammar of its own contract: functions marked `@__NO_SIDE_EFFECTS__`, and unmarked ones, whose bodies hold sites
 * the contract proves (their own locals read, assigned and called, the language's constants and proven calls, a marked
 * or listed proven function, what a proven factory returns) beside sites it refuses (an outer read or write, a property
 * written, changed or deleted, a parameter or a method called, a global called, a value frozen it does not build, the
 * forbidden syntax), marks on no function, and a proof's own module that marks it or not. Every site carries the
 * number of reports the contract gives it inside a marked function, none inside an unmarked one, and oxlint's
 * RuleTester, run in the case, must find exactly that many.
 *
 * Oracle: the specification, the rule's JSDoc read over the lists its module exports (MARKS, BUILTIN_CALLS,
 * PURE_GLOBALS, FORBIDDEN), never a list written again here. Features: a proven site, a refused site, an unmarked
 * function, a misplaced mark, a proof's module, and a program of several functions.
 *
 * Plants (~/.cache/grizzle-release/LIVE-CLIENT/plants): side-effect-free-member-write-blind (a property assigned read
 * as no write), side-effect-free-parameter-call-admitted (a parameter called read as a function literal it declares),
 * side-effect-free-freeze-any (Object.freeze of a value it does not build admitted).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Result, String as Str } from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import {
	BUILTIN_CALLS,
	FORBIDDEN,
	MARKS,
	PURE_GLOBALS,
	sideEffectFree
} from "#devtools/oxlint/rules/side-effect-free.ts"
import { assert } from "#test/support/assert.ts"

/** The placeholder of a site's own suffix, so the locals of two sites of one function never share a name. */
const OWN = "§"

/** The module the drawn programs import proven functions from, and the file that proves them. */
const PROVEN_SPECIFIER = "#proven/module.ts"
const PROVEN_FILE = "proven/module.ts"

/** The options every case runs under: one module of other files, which proves a function and a factory. */
const OPTIONS = {
	modules: [
		{
			file: PROVEN_FILE,
			specifiers: [PROVEN_SPECIFIER],
			functions: [
				{ name: "proven", returns: "values" },
				{ name: "provenFactory", returns: "functions" }
			]
		}
	]
}

/**
 * What every program starts from: the proven module's functions and one it does not list, a module variable, and a
 * marked function and factory of its own, which the drawn sites call.
 */
const HEADER = `import { proven, provenFactory, unlisted } from "${PROVEN_SPECIFIER}"
let outer = 0
/* @__NO_SIDE_EFFECTS__ */
const helper = (value: number): number => value + 1
/* @__NO_SIDE_EFFECTS__ */
const factory = () => (value: number): number => value * 2
`

/** One statement of a function's body, with the reports the contract gives it inside a marked function. */
type Site = Readonly<{ code: string; reports: number }>

const site = (code: string, reports: number): Site => ({ code, reports })

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
const forbiddenCodes = Arr.filterMap(FORBIDDEN_SITES, ([type, code]) =>
	FORBIDDEN.has(type) ? Result.succeed(code) : Result.failVoid
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
	[1, () => site(`const j${OWN} = p${OWN}.n\nconst o${OWN} = j${OWN}`, 0)]
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
	[2, () => site(`const s${OWN} = p${OWN}.toString()`, 1)],
	[2, () => site(`console.log(1)`, 2)],
	[2, () => site(`const z${OWN} = Object.freeze(p${OWN})`, 1)],
	[1, () => site(`const y${OWN} = Object.assign({}, {})`, 1)],
	[2, () => site(`const x${OWN} = Number(p${OWN}.n)`, 1)],
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
	return `${mark}export const fn${at} = (${named}): number => {\n${body}\nreturn 0\n}`
}

const programs: Gen<Program> = (source) => {
	const functions = source.draw(array(drawnFunction, { min: 1, max: 3 }))
	const stray = source.draw(boolean)
	const reports =
		Arr.reduce(functions, 0, (sum, each) =>
			Option.isSome(each.mark)
				? sum + Arr.reduce(each.sites, 0, (inner, one) => inner + one.reports)
				: sum
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

/** A proof's own module: the proven functions marked as the options claim them, or one claim broken. */
type Home = Readonly<{ code: string; reports: number; broken: boolean }>

const homes: Gen<Home> = weighted<Home>([
	[
		3,
		() => ({
			code: `/* ${MARKS[0] ?? ""} */\nexport const proven = (value: number): number => value\n/* ${MARKS[0] ?? ""} */\nexport const provenFactory = () => (value: number): number => value`,
			reports: 0,
			broken: false
		})
	],
	[
		1,
		() => ({
			code: `export const proven = (value: number): number => value\n/* ${MARKS[0] ?? ""} */\nexport const provenFactory = () => (value: number): number => value`,
			reports: 1,
			broken: true
		})
	],
	[
		1,
		() => ({
			code: `/* ${MARKS[0] ?? ""} */\nexport const proven = (value: number): number => value\n/* ${MARKS[0] ?? ""} */\nexport const provenFactory = (): number => 1`,
			reports: 1,
			broken: true
		})
	]
])

const tester = new RuleTester({
	languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } }
})

RuleTester.describe = (_text, fn) => fn()
RuleTester.it = (_text, fn) => fn()

/** What RuleTester makes of a text at a file: none when the rule reports it exactly `reports` times, else its failure. */
const judged = (code: string, filename: string, reports: number): Option.Option<string> => {
	const ran = Result.try(() =>
		tester.run(
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
						caseHang: Duration.minutes(1)
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
					caseHang: Duration.minutes(1)
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
