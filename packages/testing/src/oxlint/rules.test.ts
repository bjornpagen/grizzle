/**
 * The library's lint rules (oxlint/rules), each searched over programs drawn from a grammar of its own contract: the
 * names and shapes its module exports (a clock read, a sleep, a projection, an error's name, a seeded call, a table
 * modifier, a test's options), written in every spelling the rule reads (a module path, an import alias, a namespace
 * import, a `const` that holds the value, `assert.` and `expect(…)` chains), beside their neighbours the contract leaves
 * alone (a near name, a call without its arguments, an option set to false, a sorted or a given value). Every site of a
 * program carries the number of reports the rule's stated contract gives it, and oxlint's RuleTester, run in the case
 * itself, must find exactly that many under the rule's one message.
 *
 * Oracle: the specification, each rule's JSDoc read over the lists its module exports, never a list written again
 * here. Features, required for every rule: a site reported, a site left alone, and a program of several sites.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants), each in a rule's logic, never in a list the grammar reads, one a
 * rule in this order: rule-ordered-unordered-wrapped-blind (and rule-ordered-unordered-const-blind, a projection held by
 * a `const` and compared read as no projection), rule-error-prose-suffix-blind,
 * rule-serialized-to-string-blind, rule-example-table-tag-blind, rule-boolean-assert-expect-message-blind,
 * rule-clamped-count-zero-admitted, rule-fixed-seed-negation-blind, rule-sleep-bare-blind, rule-wall-clock-new-blind,
 * rule-retry-false-refused.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Record,
	Result,
	String as Str
} from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import { drawn, explore } from "#explore.ts"
import { required } from "#features.ts"
import { array, boolean, constant, element, type Gen, int, subset, weighted } from "#gen.ts"
import plugin from "#oxlint/plugin.ts"
import { COMPARISONS, PREDICATES, TRUTHS } from "#oxlint/rules/no-boolean-assert.ts"
import { CLAMPED, type Clamp, LENGTH } from "#oxlint/rules/no-clamped-count.ts"
import {
	ERROR_NAMES,
	ERROR_SUFFIXES,
	MATCHES,
	PRETTY_PRINTS,
	PROPERTY_MATCHERS,
	REJECTIONS,
	RENDERINGS,
	THROW_MATCHERS
} from "#oxlint/rules/no-error-prose.ts"
import { TABLES } from "#oxlint/rules/no-example-table.ts"
import { RUNS, SEED_FIELD, SEEDED } from "#oxlint/rules/no-fixed-seed.ts"
import { ARMS, CHOICES } from "#oxlint/rules/no-implicit-weight.ts"
import {
	COLLECTION_CONSTRUCTORS,
	HASH_COLLECTIONS,
	ITERATIONS,
	LISTINGS,
	PROJECTIONS
} from "#oxlint/rules/no-ordered-unordered.ts"
import { CONCURRENT, FLAKY, LAYERS, RETRY } from "#oxlint/rules/no-retry-or-concurrency.ts"
import { EQUALITY_OPERATORS, SERIALIZATIONS } from "#oxlint/rules/no-serialized-comparison.ts"
import { SLEEPS } from "#oxlint/rules/no-sleep-wait.ts"
import { CLOCK_READS, DATE_READS } from "#oxlint/rules/no-wall-clock-verdict.ts"
import { EQUALITIES, ORDERED_EQUALITIES, TEST_ROOTS } from "#oxlint/syntax.ts"
import { notesOnly } from "#sense.ts"
import { completeShrink } from "#shrink.ts"
import { searched } from "#vitest/searched.ts"

/** The imports every program starts from, so each name resolves as it does in a real test file. */
const HEADER = `import { Array as Arr, Cause, Chunk, Clock, DateTime, Duration, Effect, Equal, Exit, Formatter, HashMap, HashSet, Inspectable, Iterable, Option, Order, pipe, Predicate, Random, Record, Result, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { describe, flakyTest, it, layer } from "@effect/vitest"
import { assertEquals, assertExitSuccess, assertFalse, assertInclude, assertMatch, assertNone, assertSome, assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { expect, test } from "vitest"
import assert from "node:assert"
import { boolean, constant, element, int, oneOf, proportional, subset, weighted } from "@grizzle/testing/gen"
`

/** The placeholder of a site's own suffix, so the locals of two sites of one program never share a name. */
const OWN = "§"

/**
 * One statement of a drawn program, or a few that belong together, with the number of times its rule's contract says
 * the rule reports it. `code` names its own locals with OWN.
 */
type Site = Readonly<{ code: string; reports: number }>

const site = (code: string, reports: number): Site => ({ code, reports })

/** A drawn program: its sites, its text and the reports the contract gives it in all. */
type Program = Readonly<{ code: string; reports: number; sites: ReadonlyArray<Site> }>

/** Programs of one to three sites, each site's locals suffixed by its place. */
const programOf =
	(sites: Gen<Site>): Gen<Program> =>
	(source) => {
		const drawnSites = source.draw(array(sites, { min: 1, max: 3 }))
		return {
			code: Arr.join(
				Arr.map(drawnSites, (s, at) => Str.replaceAll(OWN, String(at))(s.code)),
				"\n"
			),
			reports: Arr.reduce(drawnSites, 0, (sum, s) => sum + s.reports),
			sites: drawnSites
		}
	}

/** A path of a list as a program spells it: Effect's Array under the header's `Arr`, every other name as it is. */
const spelled = (path: string): string =>
	Str.startsWith("Array.")(path) ? `Arr.${Str.slice("Array.".length)(path)}` : path

/** A site's second value: its locals under the site's suffix and one more letter, apart from the first value's. */
const second = <A extends Readonly<{ declared: string; written: string }>>(value: A): A => ({
	...value,
	declared: Str.replaceAll(OWN, `${OWN}e`)(value.declared),
	written: Str.replaceAll(OWN, `${OWN}e`)(value.written)
})

/** The last name of a dotted path. */
const lastOf = (path: string): string => Arr.lastNonEmpty(Str.split(path, "."))

/** One name of a list a rule exports. */
const oneOf = (names: ReadonlyArray<string>): Gen<string> =>
	element(Option.getOrThrow(Option.liftPredicate(names, Arr.isReadonlyArrayNonEmpty)))

/** Names no rule reads, for values and receivers: neither an error's name nor one of its endings. */
const PLAIN = ["count", "value", "total", "row", "item"] as const

/** How a call to an assertion is written: a bare function, a method of node's `assert`, or an `expect(…)` matcher. */
type Spelling = "bare" | "assert" | "expect"

const spellings: Gen<Spelling> = element(["bare", "assert", "expect"] as const)

/** An assertion named `name` over `actual` and the rest of its arguments, written as `spelling` writes it. */
const asserted = (
	spelling: Spelling,
	name: string,
	actual: string,
	rest: ReadonlyArray<string>
): string => {
	switch (spelling) {
		case "bare":
			return `${name}(${Arr.join([actual, ...rest], ", ")})`
		case "assert":
			return `assert.${name}(${Arr.join([actual, ...rest], ", ")})`
		case "expect":
			return `expect(${actual}).${name}(${Arr.join(rest, ", ")})`
	}
}

const tester = new RuleTester({
	languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } }
})

RuleTester.describe = (_text, fn) => fn()
RuleTester.it = (_text, fn) => fn()

type RuleName = keyof typeof plugin.rules

/** The one message a rule reports under. */
const messageIdOf = (name: RuleName): string =>
	Option.getOrThrow(Arr.head(Record.keys(plugin.rules[name].meta?.messages ?? {})))

/**
 * What oxlint's RuleTester makes of a program under one rule: none when the rule reports it exactly as many times as
 * its contract says, each under its message, else what the tester threw.
 */
const judged = (name: RuleName, program: Program): Option.Option<string> => {
	const code = `${HEADER}${program.code}\n`
	const ran = Result.try(() =>
		tester.run(
			name,
			plugin.rules[name],
			program.reports === 0
				? { valid: [{ code }], invalid: [] }
				: {
						valid: [],
						invalid: [
							{
								code,
								errors: Array.from({ length: program.reports }, () => ({
									messageId: messageIdOf(name)
								}))
							}
						]
					}
		)
	)
	return Result.match(ran, {
		onSuccess: () => Option.none(),
		onFailure: (failure) => Option.some(Formatter.format(failure))
	})
}

type Side = "a site reported" | "a site left alone" | "a program of several sites"

/** A rule's search: programs of its grammar, each judged by RuleTester against the reports its contract gives. */
const ruleSearch = (name: RuleName, sites: Gen<Site>) =>
	explore(
		{
			suite: `oxlint/${name}`,
			oracle: {
				kind: "specification",
				name: `${name}'s stated contract over the names and shapes its module exports`
			},
			draw: drawn(programOf(sites)),
			literal: Formatter.format,
			coverage: required<Side>(
				["a site reported", "a site left alone", "a program of several sites"],
				{
					cases: 200,
					sense: notesOnly
				}
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
				for (const s of program.sites) {
					c.note(s.reports > 0 ? "a site reported" : "a site left alone")
				}
				if (program.sites.length > 1) {
					c.note("a program of several sites")
				}
				deepStrictEqual(judged(name, program), Option.none())
			})
	)

/** A reference that reads the clock, a Date of now, or a near name of either, which reads nothing. */
const clockSites: Gen<Site> = weighted([
	[4, (s) => site(`const now${OWN} = ${spelled(s.draw(oneOf(CLOCK_READS)))}`, 1)],
	[1, (s) => site(`const now${OWN} = new ${s.draw(oneOf(DATE_READS))}()`, 1)],
	[1, (s) => site(`const now${OWN} = ${s.draw(oneOf(DATE_READS))}()`, 1)],
	[2, (s) => site(`const near${OWN} = ${spelled(s.draw(oneOf(CLOCK_READS)))}Of`, 0)],
	[
		2,
		(s) => {
			const member = lastOf(s.draw(oneOf(CLOCK_READS)))
			return site(
				`const local${OWN} = { ${member}: 0 }\nconst near${OWN} = local${OWN}.${member}`,
				0
			)
		}
	],
	[1, (s) => site(`const day${OWN} = new ${s.draw(oneOf(DATE_READS))}(${s.draw(int(0, 9))})`, 0)]
])

/** The names of a list written bare, with no module before them. */
const bareOf = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.filter(names, (name) => !Str.includes(".")(name))

/** A call that waits for time to pass, under its own name or an import alias, or a near form that waits for nothing. */
const sleepSites: Gen<Site> = weighted([
	[4, (s) => site(`const wait${OWN} = ${spelled(s.draw(oneOf(SLEEPS)))}(1)`, 1)],
	[
		1,
		(s) =>
			site(
				`import { ${s.draw(oneOf(bareOf(SLEEPS)))} as wait${OWN} } from "node:timers/promises"\nawait wait${OWN}(1)`,
				1
			)
	],
	[2, (s) => site(`const held${OWN} = ${spelled(s.draw(oneOf(SLEEPS)))}`, 0)],
	[
		2,
		(s) => {
			const member = lastOf(s.draw(oneOf(SLEEPS)))
			return site(
				`const local${OWN} = { ${member}: (n: number) => n }\nconst near${OWN} = local${OWN}.${member}(1)`,
				0
			)
		}
	]
])

/** The module of a dotted path, its first name. */
const moduleOf = (path: string): string => Arr.headNonEmpty(Str.split(path, "."))

/**
 * How a clamping constructor is named: the header's module (`Arr` for Effect's Array), a namespace import of
 * effect/<Module>, or its own name imported from effect/<Module>.
 */
const clampedCallee = (path: string): Gen<readonly [imports: string, callee: string]> =>
	element([
		["", spelled(path)],
		[`import * as Mod${OWN} from "effect/${moduleOf(path)}"\n`, `Mod${OWN}.${lastOf(path)}`],
		[`import { ${lastOf(path)} as made${OWN} } from "effect/${moduleOf(path)}"\n`, `made${OWN}`]
	] as const)

/** A count or a range's end as written: a literal or a `const` holding one, an expression, a parameter. */
type Count =
	| Readonly<{ kind: "literal" | "const"; value: number }>
	| Readonly<{ kind: "expression" | "parameter" }>

const countGen: Gen<Count> = weighted<Count>([
	[3, (s) => ({ kind: "literal", value: s.draw(element([-1, 0, 1, 2, 3, 1.5] as const)) })],
	[2, (s) => ({ kind: "const", value: s.draw(element([-1, 0, 1, 2, 3, 1.5] as const)) })],
	[1, constant<Count>({ kind: "expression" })],
	[1, constant<Count>({ kind: "parameter" })]
])

/** The integer a count writes, as the contract reads one: a literal or a `const` of a whole number. */
const integerOf = (count: Count): Option.Option<number> =>
	(count.kind === "literal" || count.kind === "const") && Number.isInteger(count.value)
		? Option.some(count.value)
		: Option.none()

/** Whether a count states a positive whole number: the contract's one count no clamping constructor normalizes. */
const statesPositive = (count: Count): boolean => Option.exists(integerOf(count), (n) => n >= 1)

/** A count as a site writes it under `tag`: what it declares, what it writes, and the parameter it needs, if any. */
type WrittenCount = Readonly<{
	declared: string
	written: string
	parameters: ReadonlyArray<string>
}>

const writtenCount = (count: Count, tag: string): WrittenCount => {
	const name = `${tag}${OWN}`
	switch (count.kind) {
		case "literal":
			return { declared: "", written: String(count.value), parameters: [] }
		case "const":
			return { declared: `const ${name} = ${count.value}\n`, written: name, parameters: [] }
		case "expression":
			return { declared: `const ${name} = 3\n`, written: `${name} - 1`, parameters: [] }
		case "parameter":
			return { declared: "", written: name, parameters: [`${name}: number`] }
	}
}

/** A site of a call made inside a function of the counts' parameters, after the counts' declarations. */
const callSite = (
	imports: string,
	counts: ReadonlyArray<WrittenCount>,
	call: string,
	reports: number
): Site =>
	site(
		`${imports}${Arr.join(
			Arr.map(counts, (count) => count.declared),
			""
		)}const rows${OWN} = (${Arr.join(
			Arr.flatMap(counts, (count) => count.parameters),
			", "
		)}) => ${call}`,
		reports
	)

/** The function a clamping constructor's data-first call takes beside its count, at the other place. */
const besideCount = (at: number): string => (at === 0 ? "(i: number) => i" : `"x"`)

/** A call to a clamping constructor as its clamp reads it, with the reports its contract gives it. */
const clampedCall =
	(callee: string, clamp: Clamp, imports: string): Gen<Site> =>
	(source) => {
		switch (clamp.kind) {
			case "count": {
				const count = source.draw(countGen)
				const written = writtenCount(count, "count")
				if (source.draw(boolean)) {
					const args =
						clamp.dataFirst === 0
							? [written.written, besideCount(0)]
							: [besideCount(1), written.written]
					return callSite(
						imports,
						[written],
						`${callee}(${Arr.join(args, ", ")})`,
						statesPositive(count) ? 0 : 1
					)
				}
				return clamp.dataLast === "piped"
					? callSite(imports, [], `pipe(3, ${callee}((i: number) => i))`, 1)
					: callSite(
							imports,
							[written],
							`${callee}(${written.written})`,
							statesPositive(count) ? 0 : 1
						)
			}
			case "ends": {
				const start = source.draw(countGen)
				const startWritten = writtenCount(start, "start")
				if (source.draw(boolean)) {
					return callSite(
						imports,
						[startWritten],
						`${callee}(${startWritten.written})`,
						clamp.endless ? 0 : 1
					)
				}
				const end = source.draw(countGen)
				const endWritten = writtenCount(end, "end")
				const states = Option.exists(
					Option.all([integerOf(start), integerOf(end)]),
					([from, to]) => from <= to
				)
				return callSite(
					imports,
					[startWritten, endWritten],
					`${callee}(${startWritten.written}, ${endWritten.written})`,
					states ? 0 : 1
				)
			}
			case "length": {
				const made = `${callee}((i: number) => i`
				return source.draw(
					weighted<Site>([
						[1, constant(callSite(imports, [], `${made})`, 0))],
						[1, constant(callSite(imports, [], `${made}, {})`, 0))],
						[
							3,
							(s) => {
								const count = s.draw(countGen)
								const written = writtenCount(count, "count")
								return callSite(
									imports,
									[written],
									`${made}, { ${LENGTH}: ${written.written} })`,
									statesPositive(count) ? 0 : 1
								)
							}
						],
						[
							1,
							constant(
								callSite(
									imports,
									[writtenCount({ kind: "parameter" }, "options")],
									`${made}, options${OWN})`,
									1
								)
							)
						]
					])
				)
			}
		}
	}

/** One clamping constructor of the rule's list, with its clamp. */
const clampedOf = element(
	Option.getOrThrow(Option.liftPredicate(CLAMPED, Arr.isReadonlyArrayNonEmpty))
)

/** A call to a drawn clamping constructor, a near name of one, and a method of that name on a local value. */
const clampedSites: Gen<Site> = weighted([
	[
		6,
		(s) => {
			const [path, clamp] = s.draw(clampedOf)
			const [imports, callee] = s.draw(clampedCallee(path))
			return s.draw(clampedCall(callee, clamp, imports))
		}
	],
	[1, (s) => site(`const rows${OWN} = ${spelled(s.draw(clampedOf)[0])}Of(0, -1)`, 0)],
	[
		1,
		(s) => {
			const member = lastOf(s.draw(clampedOf)[0])
			return site(
				`const local${OWN} = { ${member}: (a: number, b: number) => [a, b] }\nconst near${OWN} = local${OWN}.${member}(0, -1)`,
				0
			)
		}
	]
])

/** Options a choice lists, each as a program writes it: literals and generators alike, since the rule reads their text. */
const OPTION_TEXTS = [
	`"a"`,
	`"b"`,
	`""`,
	"0",
	"1",
	"true",
	"constant(1)",
	"int(0, 3)",
	"boolean"
] as const

/** One to four distinct options, and, when `repeated`, one of them written a second time at a drawn place. */
const listedGen =
	(repeated: boolean): Gen<ReadonlyArray<string>> =>
	(source) => {
		const distinct = source.draw(subset(OPTION_TEXTS, { min: 1, max: 4 }))
		if (!repeated) {
			return distinct
		}
		const again = source.draw(
			element(Option.getOrThrow(Option.liftPredicate(distinct, Arr.isReadonlyArrayNonEmpty)))
		)
		const at = source.draw(int(0, distinct.length))
		return [...Arr.take(distinct, at), again, ...Arr.drop(distinct, at)]
	}

/** A written list as a site passes it: inline, held by a `const`, with `as const` or not, after a spread or not. */
const listSite =
	(items: ReadonlyArray<string>): Gen<readonly [declared: string, written: string]> =>
	(source) => {
		const spread = source.draw(boolean) ? ["...more"] : []
		const list = `[${Arr.join([...spread, ...items], ", ")}]${source.draw(boolean) ? " as const" : ""}`
		return source.draw(boolean) ? [`const options${OWN} = ${list}\n`, `options${OWN}`] : ["", list]
	}

/** A choice over a written list, a choice whose arms pair drawn weights with options, and the neighbours left alone. */
const weightSites: Gen<Site> = weighted([
	[
		4,
		(s) => {
			const repeated = s.draw(boolean)
			const [declared, written] = s.draw(listSite(s.draw(listedGen(repeated))))
			return site(
				`${declared}const choice${OWN} = ${s.draw(oneOf(CHOICES))}(${written})`,
				repeated ? 1 : 0
			)
		}
	],
	[
		3,
		(s) => {
			const repeated = s.draw(boolean)
			const arms = Arr.map(
				s.draw(listedGen(repeated)),
				(option) => `[${s.draw(int(1, 3))}, ${option}]`
			)
			const [declared, written] = s.draw(listSite(arms))
			return site(
				`${declared}const choice${OWN} = ${s.draw(oneOf(ARMS))}(${written})`,
				repeated ? 1 : 0
			)
		}
	],
	[
		1,
		(s) => {
			const weight = s.draw(int(1, 3))
			const arms = Arr.map(s.draw(listedGen(false)), (option) => `[${weight}, ${option}]`)
			return site(`const choice${OWN} = ${s.draw(oneOf(ARMS))}([${Arr.join(arms, ", ")}])`, 0)
		}
	],
	[
		1,
		(s) =>
			site(
				`const choice${OWN} = ${s.draw(oneOf(CHOICES))}Of([${Arr.join(s.draw(listedGen(true)), ", ")}])`,
				0
			)
	],
	[
		1,
		(s) =>
			site(
				`const picked${OWN} = subset([${Arr.join(s.draw(listedGen(true)), ", ")}], { min: 0, max: 2 })`,
				0
			)
	],
	[
		1,
		(s) =>
			site(
				`const choose${OWN} = (options: ReadonlyArray<number>) => ${s.draw(oneOf(CHOICES))}(options)`,
				0
			)
	]
])

/** A seed as a site writes it: the declaration it needs, if any, and the seed itself. */
type Written = readonly [declared: string, written: string]

/** A seed a test writes: a literal, negated or not, of a number, a bigint or a string, or a `const` holding one. */
const fixedSeeds: Gen<Written> = weighted<Written>([
	[2, (s) => ["", String(s.draw(int(0, 99)))]],
	[1, (s) => ["", `-${s.draw(int(1, 99))}`]],
	[1, (s) => ["", `"seed${s.draw(int(0, 9))}"`]],
	[1, (s) => ["", `${s.draw(int(0, 99))}n`]],
	[1, (s) => [`const SEED${OWN} = ${s.draw(int(0, 99))}\n`, `SEED${OWN}`]]
])

/** A seed that comes from the run: a field of it, or what a stream gives. */
const runSeeds: Gen<string> = element(["run.seed", "caseSeed(stream, 0)"] as const)

/** A seed of either kind, and whether the contract counts it fixed. */
type Seed = readonly [declared: string, written: string, fixed: boolean]

const seedGen: Gen<Seed> = weighted<Seed>([
	[3, (s) => [...s.draw(fixedSeeds), true]],
	[2, (s) => ["", s.draw(runSeeds), false]]
])

/** The arguments of a seeded call: the seed at the place its callee takes one, others from the run. */
const seededCall = (callee: string, at: number | "any", seed: string): string => {
	if (at === "any") {
		return `${spelled(callee)}(program, ${seed})`
	}
	const others = Arr.map(
		Array.from({ length: at + 1 }, (_, i) => i),
		(place) => (place === at ? seed : "run.seed")
	)
	return `${spelled(callee)}(${Arr.join([...others, "run.seed"], ", ")})`
}

/** A run or a seeded call given a drawn seed, a fixed seed at a place no callee reads one, and a `seed` field of data. */
const seedSites: Gen<Site> = weighted([
	[
		3,
		(s) => {
			const [declared, written, fixed] = s.draw(seedGen)
			return site(
				`${declared}const run${OWN} = ${spelled(s.draw(oneOf(RUNS)))}({ ${SEED_FIELD}: ${written}, source: "environment" })`,
				fixed ? 1 : 0
			)
		}
	],
	[
		3,
		(s) => {
			const [callee, at] = s.draw(
				element(Option.getOrThrow(Option.liftPredicate(SEEDED, Arr.isReadonlyArrayNonEmpty)))
			)
			const [declared, written, fixed] = s.draw(seedGen)
			return site(
				`${declared}const words${OWN} = ${seededCall(callee, at, written)}`,
				fixed ? 1 : 0
			)
		}
	],
	[
		1,
		(s) => {
			const [callee, at] = s.draw(
				element(Option.getOrThrow(Option.liftPredicate(SEEDED, Arr.isReadonlyArrayNonEmpty)))
			)
			return typeof at === "number"
				? site(
						`const words${OWN} = ${spelled(callee)}(${Arr.join([...Array.from({ length: at + 1 }, () => "run.seed"), "41"], ", ")})`,
						0
					)
				: site(`const words${OWN} = ${spelled(callee)}(program)`, 0)
		}
	],
	[1, (s) => site(`const sketch${OWN} = { ${SEED_FIELD}: ${s.draw(int(0, 99))}, moves: 3 }`, 0)]
])

/** A subject an assertion checks, and whether a narrower assertion states it. */
type Subject = Readonly<{ declared: string; written: string; narrowable: boolean }>

/** A predicate call, data first or data last, a comparison by an operator a narrower equality states, and their negation. */
const narrowableGen: Gen<Subject> = weighted<Subject>([
	[
		3,
		(s) => {
			const predicate = spelled(s.draw(oneOf(PREDICATES)))
			return {
				declared: "",
				written: s.draw(element([`${predicate}(x, y)`, `${predicate}("T")(x)`] as const)),
				narrowable: true
			}
		}
	],
	[2, (s) => ({ declared: "", written: `x ${s.draw(oneOf(COMPARISONS))} y`, narrowable: true })]
])

/** A value no narrower assertion states: a plain flag, an ordering, a call of no predicate, a predicate's near name. */
const plainSubjectGen: Gen<Subject> = weighted<Subject>([
	[1, constant<Subject>({ declared: "", written: "flag", narrowable: false })],
	[
		1,
		(s) => ({
			declared: "",
			written: `x ${s.draw(element(["<", "<=", ">", ">="] as const))} y`,
			narrowable: false
		})
	],
	[1, constant<Subject>({ declared: "", written: "isPrime(x)", narrowable: false })],
	[
		1,
		(s) => ({
			declared: "",
			written: `${spelled(s.draw(oneOf(PREDICATES)))}Of(x)`,
			narrowable: false
		})
	]
])

/** A subject as written, negated, or held by a `const`: each keeps whether it is narrowable. */
const subjectGen: Gen<Subject> = (source) => {
	const inner = source.draw(
		weighted([
			[1, narrowableGen],
			[1, plainSubjectGen]
		])
	)
	switch (source.draw(element(["as written", "negated", "held"] as const))) {
		case "as written":
			return inner
		case "negated":
			return { ...inner, written: `!(${inner.written})` }
		case "held":
			return {
				declared: `const fact${OWN} = ${inner.written}\n`,
				written: `fact${OWN}`,
				narrowable: inner.narrowable
			}
	}
}

/** A truth assertion or an equality with a boolean over a drawn subject, with a message or none. */
const booleanSites: Gen<Site> = weighted([
	[
		3,
		(s) => {
			const subject = s.draw(subjectGen)
			const spelling = s.draw(spellings)
			const name = s.draw(oneOf(TRUTHS))
			const message = s.draw(element([false, true] as const))
			const call =
				spelling === "expect"
					? `expect(${subject.written}${message ? `, "states the fact"` : ""}).${name}()`
					: asserted(spelling, name, subject.written, message ? [`"states the fact"`] : [])
			return site(`${subject.declared}${call}`, subject.narrowable && !message ? 1 : 0)
		}
	],
	[
		3,
		(s) => {
			const subject = s.draw(subjectGen)
			const spelling = s.draw(spellings)
			const name = s.draw(oneOf(EQUALITIES))
			const literal = s.draw(element(["true", "false"] as const))
			const message = s.draw(element([false, true] as const))
			const flipped = spelling !== "expect" && s.draw(element([false, true] as const))
			const call =
				spelling === "expect"
					? `expect(${subject.written}${message ? `, "states the fact"` : ""}).${name}(${literal})`
					: flipped
						? asserted(spelling, name, literal, [
								subject.written,
								...(message ? [`"states the fact"`] : [])
							])
						: asserted(spelling, name, subject.written, [
								literal,
								...(message ? [`"states the fact"`] : [])
							])
			return site(`${subject.declared}${call}`, subject.narrowable && !message ? 1 : 0)
		}
	],
	[
		1,
		(s) =>
			site(
				asserted(s.draw(spellings), s.draw(oneOf(EQUALITIES)), s.draw(narrowableGen).written, [
					"1"
				]),
				0
			)
	]
])

/** An error's name: one the rule names whole, or a word with one of its endings. */
const errorNameGen: Gen<string> = weighted([
	[1, oneOf(ERROR_NAMES)],
	[1, (s) => `parse${s.draw(oneOf(ERROR_SUFFIXES))}`]
])

/** A text an assertion checks, and whether the contract reads it as an error's text. */
type Text = Readonly<{ declared: string; written: string; errorText: boolean }>

const textGen: Gen<Text> = (source) => {
	const plain = source.draw(element(PLAIN))
	const inner = source.draw(
		weighted<Readonly<{ written: string; errorText: boolean }>>([
			[
				2,
				(s) => ({
					written: `${s.draw(
						weighted([
							[1, errorNameGen],
							[1, element(PLAIN)]
						])
					)}.message`,
					errorText: true
				})
			],
			[1, (s) => ({ written: `${spelled(s.draw(oneOf(PRETTY_PRINTS)))}(cause)`, errorText: true })],
			[1, (s) => ({ written: `${s.draw(errorNameGen)}.toString()`, errorText: true })],
			[
				1,
				(s) => ({
					written: `${spelled(s.draw(oneOf(RENDERINGS)))}(${s.draw(errorNameGen)})`,
					errorText: true
				})
			],
			[1, constant({ written: `${plain}.toString()`, errorText: false })],
			[
				1,
				(s) => ({ written: `${spelled(s.draw(oneOf(RENDERINGS)))}(${plain})`, errorText: false })
			],
			[1, constant({ written: plain, errorText: false })]
		])
	)
	return source.draw(element([false, true] as const))
		? {
				declared: `const text${OWN} = ${inner.written}\n`,
				written: `text${OWN}`,
				errorText: inner.errorText
			}
		: { declared: "", ...inner }
}

/** A matcher of a thrown error, and whether it is written text or an object holding a `message`. */
const throwMatcherGen: Gen<readonly [written: string, prose: boolean]> = element([
	[`"empty input"`, true],
	["/empty/", true],
	["`empty input`", true],
	[`{ message: "empty input" }`, true],
	["ParseFailure", false],
	[`{ name: "ParseFailure" }`, false]
] as const)

/** A matcher of a rejection, and whether it is a pattern or an object holding a `message`: written text is its message. */
const rejectionMatcherGen: Gen<readonly [written: string, prose: boolean]> = element([
	["/empty/", true],
	[`{ message: "empty input" }`, true],
	[`"why it must throw"`, false],
	["ParseFailure", false]
] as const)

/** Each family of assertion over error text, each judged as the contract judges it. */
const proseSites: Gen<Site> = weighted([
	[
		3,
		(s) => {
			const actual = s.draw(textGen)
			const expected = second(
				s.draw(
					weighted<Text>([
						[1, textGen],
						[1, constant<Text>({ declared: "", written: `"todo not found"`, errorText: false })]
					])
				)
			)
			const call = asserted(s.draw(spellings), s.draw(oneOf(EQUALITIES)), actual.written, [
				expected.written
			])
			return site(
				`${actual.declared}${expected.declared}${call}`,
				actual.errorText !== expected.errorText ? 1 : 0
			)
		}
	],
	[
		2,
		(s) => {
			const actual = s.draw(textGen)
			const call = asserted(s.draw(spellings), s.draw(oneOf(MATCHES)), actual.written, ["/found/"])
			return site(`${actual.declared}${call}`, actual.errorText ? 1 : 0)
		}
	],
	[
		2,
		(s) => {
			const [matcher, prose] = s.draw(throwMatcherGen)
			const name = s.draw(oneOf(THROW_MATCHERS))
			return site(
				s.draw(element([false, true] as const))
					? `await expect(promise).rejects.${name}(${matcher})`
					: asserted(s.draw(spellings), name, `() => parse("")`, [matcher]),
				prose ? 1 : 0
			)
		}
	],
	[
		1,
		(s) => {
			const [matcher, prose] = s.draw(rejectionMatcherGen)
			return site(
				asserted(s.draw(spellings), s.draw(oneOf(REJECTIONS)), `() => parse("")`, [matcher]),
				prose ? 1 : 0
			)
		}
	],
	[
		1,
		(s) => {
			const property = s.draw(element(["message", "code"] as const))
			return site(
				asserted(s.draw(spellings), s.draw(oneOf(PROPERTY_MATCHERS)), "failure", [
					`"${property}"`,
					`"boom"`
				]),
				property === "message" ? 1 : 0
			)
		}
	]
])

/** A compared value, and whether the contract counts it serialized or a rendered template. */
type Compared = Readonly<{
	declared: string
	written: string
	serialized: boolean
	rendered: boolean
}>

const comparedGen: Gen<Compared> = (source) => {
	const plain = source.draw(element(PLAIN))
	const inner = source.draw(
		weighted<Readonly<{ written: string; serialized: boolean; rendered: boolean }>>([
			[
				3,
				(s) => ({
					written: `${spelled(s.draw(oneOf(SERIALIZATIONS)))}(${plain})`,
					serialized: true,
					rendered: false
				})
			],
			[1, constant({ written: `${plain}.toString()`, serialized: true, rendered: false })],
			[1, constant({ written: `${plain}.toString(16)`, serialized: false, rendered: false })],
			[
				1,
				(s) => ({
					written: `${spelled(s.draw(oneOf(RENDERINGS)))}(${s.draw(errorNameGen)})`,
					serialized: false,
					rendered: false
				})
			],
			[1, constant({ written: `\`\${${plain}}-\${other}\``, serialized: false, rendered: true })],
			[1, constant({ written: "`plain`", serialized: false, rendered: false })],
			[1, constant({ written: `"42"`, serialized: false, rendered: false })],
			[1, constant({ written: plain, serialized: false, rendered: false })]
		])
	)
	return source.draw(element([false, true] as const))
		? {
				declared: `const shown${OWN} = ${inner.written}\n`,
				written: `shown${OWN}`,
				serialized: inner.serialized,
				rendered: inner.rendered
			}
		: { declared: "", ...inner }
}

/** An equality assertion or an equality operator over drawn values, and an operator that compares nothing. */
const serializedSites: Gen<Site> = weighted([
	[
		3,
		(s) => {
			const actual = s.draw(comparedGen)
			const expected = second(s.draw(comparedGen))
			const call = asserted(s.draw(spellings), s.draw(oneOf(EQUALITIES)), actual.written, [
				expected.written
			])
			return site(
				`${actual.declared}${expected.declared}${call}`,
				actual.serialized || expected.serialized || actual.rendered ? 1 : 0
			)
		}
	],
	[
		2,
		(s) => {
			const left = s.draw(comparedGen)
			const right = second(s.draw(comparedGen))
			return site(
				`${left.declared}${right.declared}const same${OWN} = ${left.written} ${s.draw(oneOf(EQUALITY_OPERATORS))} ${right.written}`,
				left.serialized || right.serialized ? 1 : 0
			)
		}
	],
	[
		1,
		(s) => {
			const joined = s.draw(comparedGen)
			return site(`${joined.declared}const joined${OWN} = ${joined.written} + unit`, 0)
		}
	]
])

/** Sources whose own order a listing keeps: an array, a typed array, a string, an array-like literal, a value. */
const orderedSources: Gen<string> = element([
	"[3, 1, 2]",
	"new Uint8Array(4)",
	"bytes",
	`"text"`,
	"{ length: 3 }",
	"chunk"
] as const)

/** An unordered collection, spelled by its constructor or its hash module, as written or held by a `const`. */
const collectionGen: Gen<readonly [declared: string, written: string]> = (source) => {
	const built = source.draw(
		weighted<string>([
			[1, (s) => `new ${s.draw(oneOf(COLLECTION_CONSTRUCTORS))}(ids)`],
			[1, (s) => `${s.draw(oneOf(HASH_COLLECTIONS))}.make(1, 2)`]
		])
	)
	return source.draw(element([false, true] as const))
		? [`const seen${OWN} = ${built}\n`, `seen${OWN}`]
		: ["", built]
}

/** A compared side, and whether it holds a projection of an unordered collection, as the contract reads one. */
type Projected = Readonly<{ declared: string; written: string; projection: boolean }>

const projectedGen: Gen<Projected> = weighted<Projected>([
	[
		3,
		(s) => ({
			declared: "",
			written: `${spelled(s.draw(oneOf(PROJECTIONS)))}(record)`,
			projection: true
		})
	],
	[
		2,
		(s) => ({
			declared: `const keys${OWN} = ${spelled(s.draw(oneOf(PROJECTIONS)))}(record)\n`,
			written: `keys${OWN}`,
			projection: true
		})
	],
	[
		1,
		(s) => ({
			declared: `const keys${OWN} = Arr.sort(${spelled(s.draw(oneOf(PROJECTIONS)))}(record), Order.String)\n`,
			written: `keys${OWN}`,
			projection: false
		})
	],
	[2, (s) => ({ declared: "", written: `index.${s.draw(oneOf(ITERATIONS))}()`, projection: true })],
	[
		1,
		(s) => ({ declared: "", written: `index.${s.draw(oneOf(ITERATIONS))}(1)`, projection: false })
	],
	[
		2,
		(s) => {
			const [declared, written] = s.draw(collectionGen)
			return s.draw(element([false, true] as const))
				? { declared, written: `[...${written}]`, projection: true }
				: { declared, written: `${spelled(s.draw(oneOf(LISTINGS)))}(${written})`, projection: true }
		}
	],
	[
		2,
		(s) => ({
			declared: "",
			written: `${spelled(s.draw(oneOf(LISTINGS)))}(${s.draw(orderedSources)})`,
			projection: false
		})
	],
	[1, constant<Projected>({ declared: "", written: "[...items, 1]", projection: false })],
	[1, constant<Projected>({ declared: "", written: "[1, 2]", projection: false })]
])

/** A side as it is, or held in an object literal's field or an array literal's item: a holder holds what it holds. */
const sideGen: Gen<Projected> = (source) => {
	const inner = source.draw(projectedGen)
	switch (source.draw(element(["as it is", "in a field", "in an item"] as const))) {
		case "as it is":
			return inner
		case "in a field":
			return { ...inner, written: `{ names: ${inner.written} }` }
		case "in an item":
			return { ...inner, written: `[${inner.written}, 0]` }
	}
}

/** An ordered equality over drawn sides, and an equality that compares by identity, which no order reaches. */
const orderedSites: Gen<Site> = weighted([
	[
		4,
		(s) => {
			const actual = s.draw(sideGen)
			const expected = second(s.draw(sideGen))
			const call = asserted(s.draw(spellings), s.draw(oneOf(ORDERED_EQUALITIES)), actual.written, [
				expected.written
			])
			return site(
				`${actual.declared}${expected.declared}${call}`,
				actual.projection || expected.projection ? 1 : 0
			)
		}
	],
	[
		1,
		(s) => {
			const unordered = Arr.filter(EQUALITIES, (name) => !Arr.contains(ORDERED_EQUALITIES, name))
			const side = s.draw(sideGen)
			return site(
				`${side.declared}${asserted(s.draw(spellings), s.draw(oneOf(unordered)), side.written, ["[1, 2]"])}`,
				0
			)
		}
	]
])

/** Rows a test takes, and whether they are written out: an array literal or a `const` holding one, or rows made. */
const rowsGen: Gen<readonly [declared: string, written: string, writtenOut: boolean]> = element([
	["", "[1, 2]", true],
	["", "[]", true],
	[`const rows${OWN} = [{ input: 1, output: 2 }]\n`, `rows${OWN}`, true],
	["", "rowsOf(3)", false]
] as const)

/** A test's path: a root the contract reads, and a modifier between the root and the rest, or none. */
const testPathGen: Gen<string> = (source) =>
	`${source.draw(oneOf(TEST_ROOTS))}${source.draw(element(["", ".effect"] as const))}`

/** A table test over drawn rows, a tagged-template table, a near modifier, and a for…of over rows in or out of a test. */
const tableSites: Gen<Site> = weighted([
	[
		3,
		(s) => {
			const [declared, rows, writtenOut] = s.draw(rowsGen)
			return site(
				`${declared}${s.draw(testPathGen)}.${s.draw(oneOf(TABLES))}(${rows})("case ${OWN}", (row) => check(row))`,
				writtenOut ? 1 : 0
			)
		}
	],
	[
		1,
		(s) =>
			site(
				`${s.draw(testPathGen)}.${s.draw(oneOf(TABLES))}\`\n\ta | b\n\t\${1} | \${2}\n\`("case ${OWN}", ({ a, b }) => check(a, b))`,
				1
			)
	],
	[
		1,
		(s) =>
			site(
				`${s.draw(testPathGen)}.${s.draw(oneOf(TABLES))}Of([1, 2])("case ${OWN}", (row) => check(row))`,
				0
			)
	],
	[
		3,
		(s) => {
			const [declared, rows, writtenOut] = s.draw(rowsGen)
			const root = s.draw(oneOf(TEST_ROOTS))
			return s.draw(element([false, true] as const))
				? site(
						`${declared}${root}("case ${OWN}", () => {\n\tfor (const v of ${rows}) {\n\t\tcheck(v)\n\t}\n})`,
						writtenOut ? 1 : 0
					)
				: site(
						`${declared}${root}.effect("case ${OWN}", () =>\n\tEffect.gen(function* () {\n\t\tfor (const v of ${rows}) {\n\t\t\tyield* check(v)\n\t\t}\n\t})\n)`,
						writtenOut ? 1 : 0
					)
		}
	],
	[
		1,
		constant(
			site(`const helper${OWN} = () => {\n\tfor (const v of [1, 2]) {\n\t\tcheck(v)\n\t}\n}`, 0)
		)
	],
	[
		1,
		(s) =>
			site(
				`${s.draw(oneOf(TEST_ROOTS))}("case ${OWN}", () => {\n\tconst run = () => {\n\t\tfor (const v of [1, 2]) {\n\t\t\tcheck(v)\n\t\t}\n\t}\n\trun()\n})`,
				0
			)
	]
])

/** A test's options: a retry, a concurrency that is not false, one that is, and a timeout, each kept or left by a draw. */
const optionsGen: Gen<readonly [written: string, refused: number]> = (source) => {
	const kept = source.draw(
		subset(
			[
				[`${RETRY}: 3`, 1],
				[`${CONCURRENT}: true`, 1],
				[`${CONCURRENT}: sometimes`, 1],
				[`${CONCURRENT}: false`, 0],
				["timeout: 1000", 0]
			] as const,
			{ min: 1, max: 3 }
		)
	)
	return [
		`{ ${Arr.join(
			Arr.map(kept, ([option]) => option),
			", "
		)} }`,
		Arr.reduce(kept, 0, (sum, [, refused]) => sum + refused)
	]
}

/** A flaky test, a test or a layer given drawn options, a concurrent modifier, and options of a call that runs no test. */
const retrySites: Gen<Site> = weighted([
	[
		1,
		(s) =>
			site(
				`const checked${OWN} = ${s.draw(element(["", "it."] as const))}${FLAKY}(check, "5 seconds")`,
				1
			)
	],
	[
		3,
		(s) => {
			const [options, refused] = s.draw(optionsGen)
			const held = s.draw(element([false, true] as const))
			const passed = held ? `options${OWN}` : options
			const declared = held ? `const options${OWN} = ${options}\n` : ""
			return site(
				s.draw(element([false, true] as const))
					? `${declared}${s.draw(testPathGen)}("case ${OWN}", ${passed}, () => Effect.void)`
					: `${declared}${s.draw(testPathGen)}("case ${OWN}", () => Effect.void, ${passed})`,
				refused
			)
		}
	],
	[
		2,
		(s) => {
			const [options, refused] = s.draw(optionsGen)
			const layered = s.draw(oneOf(["it.layer", ...LAYERS]))
			return site(`${layered}(TodoLayer, ${options})("todos ${OWN}", (it) => {})`, refused)
		}
	],
	[
		1,
		(s) =>
			site(
				s.draw(element([false, true] as const))
					? `${s.draw(oneOf(TEST_ROOTS))}.${CONCURRENT}("case ${OWN}", () => {})`
					: `${s.draw(oneOf(TEST_ROOTS))}.${CONCURRENT}.each([1])("case ${OWN}", () => {})`,
				1
			)
	],
	[1, (s) => site(`const fibers${OWN} = Effect.forEach(tasks, run, ${s.draw(optionsGen)[0]})`, 0)]
])

describe("the testing plugin's rules", () => {
	it.effect("no-wall-clock-verdict reports exactly the reads of the clock", (ctx) =>
		searched(ctx, ruleSearch("no-wall-clock-verdict", clockSites))
	)
	it.effect("no-sleep-wait reports exactly the calls that wait for time to pass", (ctx) =>
		searched(ctx, ruleSearch("no-sleep-wait", sleepSites))
	)
	it.effect(
		"no-clamped-count reports exactly the clamping calls no count they never normalize states",
		(ctx) => searched(ctx, ruleSearch("no-clamped-count", clampedSites))
	)
	it.effect(
		"no-implicit-weight reports exactly the choices that write an option more than once",
		(ctx) => searched(ctx, ruleSearch("no-implicit-weight", weightSites))
	)
	it.effect(
		"no-fixed-seed reports exactly the seeds written where a run or a stream takes one",
		(ctx) => searched(ctx, ruleSearch("no-fixed-seed", seedSites))
	)
	it.effect(
		"no-boolean-assert reports exactly the boolean assertions a narrower one states, with no message",
		(ctx) => searched(ctx, ruleSearch("no-boolean-assert", booleanSites))
	)
	it.effect("no-error-prose reports exactly the assertions of an error's text", (ctx) =>
		searched(ctx, ruleSearch("no-error-prose", proseSites))
	)
	it.effect("no-serialized-comparison reports exactly the comparisons through text", (ctx) =>
		searched(ctx, ruleSearch("no-serialized-comparison", serializedSites))
	)
	it.effect(
		"no-ordered-unordered reports exactly the ordered equalities over an unordered collection's order",
		(ctx) => searched(ctx, ruleSearch("no-ordered-unordered", orderedSites))
	)
	it.effect("no-example-table reports exactly the tables of written-out rows", (ctx) =>
		searched(ctx, ruleSearch("no-example-table", tableSites))
	)
	it.effect(
		"no-retry-or-concurrency reports exactly each retry and each concurrency of a test",
		(ctx) => searched(ctx, ruleSearch("no-retry-or-concurrency", retrySites))
	)
})
