import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { drawn, explore } from "#explore.ts"
import { required } from "#features.ts"
import { array, element, type Gen, int, shuffled } from "#gen.ts"
import {
	applied,
	type Family,
	type KeptMutant,
	keptApplied,
	mutantsOf,
	noFamilies,
	type Operator
} from "#mutants.ts"
import { notesOnly } from "#sense.ts"
import { searched } from "#vitest/searched.ts"

/**
 * The operators against programs built from statements whose mutants are known: each statement shape names exactly the
 * operators it must yield and how many of each, its identifiers distinct so no mutant is the statement unchanged. Every
 * mutant must replace the text it names, sit at the line and column it names, carry an id no other mutant carries, and
 * name the function it sits in; and the program's operators must be exactly the sum of its statements'.
 */
const SHAPES = [
	"guard",
	"conjunct",
	"disjunct",
	"negation",
	"boolean",
	"conditional",
	"if-else",
	"switch",
	"call",
	"fallback",
	"difference",
	"quantifier",
	"array",
	"pipe",
	"effect-fn",
	"option-some",
	"loose",
	"negative"
] as const

type Shape = (typeof SHAPES)[number]

type Statement = Readonly<{
	shape: Shape
	names: ReadonlyArray<string>
	bound: number
	flag: boolean
	quantifier: "some" | "every"
	fn: "fn" | "fnUntraced"
}>

const statementGen: Gen<Statement> = (source) => ({
	shape: source.draw(element(SHAPES)),
	names: source.draw(shuffled(["a", "b", "c"], { min: 3, max: 3 })),
	bound: source.draw(int(0, 9)),
	flag: source.draw(element([true, false])),
	quantifier: source.draw(element(["some", "every"])),
	fn: source.draw(element(["fn", "fnUntraced"]))
})

const programGen: Gen<ReadonlyArray<Statement>> = array(statementGen, { min: 1, max: 6 })

/** The statement's text, its value bound to `v<index>` where it has one. */
const textOf = (statement: Statement, index: number): string => {
	const [x = "", y = "", z = ""] = statement.names
	const v = `v${String(index)}`
	const n = String(statement.bound)
	switch (statement.shape) {
		case "guard":
			return `if (${x} < ${n}) { return ${y} }`
		case "conjunct":
			return `const ${v} = ${x} && ${y}`
		case "disjunct":
			return `const ${v} = ${x} || ${y}`
		case "negation":
			return `const ${v} = !${x}`
		case "boolean":
			return `const ${v} = ${String(statement.flag)}`
		case "conditional":
			return `const ${v} = ${x} ? ${y} : ${z}`
		case "if-else":
			return `if (${x}) { ${y}() } else { ${z}() }`
		case "switch":
			return `switch (${x}) { case 0: ${y}(); break; case 1: ${z}(); break }`
		case "call":
			return `${x}()`
		case "fallback":
			return `const ${v} = ${x} ?? ${y}`
		case "difference":
			return `const ${v} = ${x} - ${y}`
		case "quantifier":
			return `const ${v} = ${x}.${statement.quantifier}((e) => e > ${n})`
		case "array":
			return `const ${v} = [${x}, ${y}]`
		case "pipe":
			return `const ${v} = ${x}.pipe(${y}, ${z})`
		case "effect-fn":
			return `const ${v} = Effect.${statement.fn}(function* () {}, ${y}, ${z})`
		case "option-some":
			return `const ${v} = Option.some(${x})`
		case "loose":
			return `const ${v} = ${x} == ${y}`
		case "negative":
			return `if (${x} < -${n}) { return ${y} }`
	}
}

/** Operators, each with a count. */
type Counts = ReadonlyArray<readonly [Operator, number]>

/** The operators a statement must yield, each with its count. */
const expectedOf = (shape: Shape): Counts => {
	switch (shape) {
		case "guard":
			return [
				["comparison", 1],
				["guard", 1],
				["bound", 2]
			]
		case "conjunct":
			return [["conjunct", 2]]
		case "disjunct":
			return [["disjunct", 2]]
		case "negation":
			return [["negation", 1]]
		case "boolean":
			return [["boolean", 1]]
		case "conditional":
			return [["arm-swap", 1]]
		case "if-else":
			return [
				["arm-swap", 1],
				["statement", 2]
			]
		case "switch":
			return [
				["arm-swap", 1],
				["statement", 4]
			]
		case "call":
			return [["statement", 1]]
		case "fallback":
			return [["fallback", 1]]
		case "difference":
			return [["operand-swap", 1]]
		case "quantifier":
			return [
				["quantifier", 1],
				["comparison", 1],
				["bound", 2],
				["boolean-return", 2]
			]
		case "array":
			return [["element", 2]]
		case "pipe":
			return [["pipe-stage", 2]]
		case "effect-fn":
			return [["pipe-stage", 2]]
		case "option-some":
			return []
		case "loose":
			return [["comparison", 1]]
		case "negative":
			return [
				["comparison", 1],
				["guard", 1],
				["bound", 2]
			]
	}
}

/** Each operator's total over several counts. */
const counted = (counts: ReadonlyArray<Counts>) =>
	Arr.reduce(Arr.flatten(counts), Rec.empty<string, number>(), (sum, [operator, n]) =>
		Rec.set(sum, operator, (sum[operator] ?? 0) + n)
	)

const programOf = (statements: ReadonlyArray<Statement>) =>
	`const run = () => {\n${Arr.join(
		Arr.map(statements, (statement, index) => `\t${textOf(statement, index)}`),
		"\n"
	)}\n}\n`

/** The files a family case lists, some under sql/, which the family applies to, and some elsewhere. */
const FAMILY_FILES = ["sql/print.ts", "sql/plan.ts", "src/other.ts", "lib/text.ts"] as const

/**
 * A family case: files of distinct names, each declaring a few string literals, "a" (a site the family's rule finds) or
 * "c" (none), and how many copies of the one rule the family holds.
 */
const familyCase = (source: Parameters<Gen<unknown>>[0]) => ({
	files: Arr.map(source.draw(shuffled(FAMILY_FILES, { min: 1, max: 3 })), (name) => ({
		name,
		literals: source.draw(array(element(["a", "c"] as const), { min: 0, max: 3 }))
	})),
	rules: source.draw(int(1, 3))
})

/** A file declaring each literal in order, one declaration a line. */
const literalsText = (literals: ReadonlyArray<string>): string =>
	Arr.join(
		Arr.map(literals, (literal, at) => `export const name${at} = "${literal}"\n`),
		""
	)

/** A family whose `copies` rules each propose the same edit: every "a" literal becomes "b", in the files `applies` names. */
const renamingFamily = (applies: (file: string) => boolean, copies: number): Family<"rename"> => {
	const rule: Family<"rename">["rules"][number] = (node, site) => {
		if (site.source.kind !== node.kind && site.slice(node) === `"a"`) {
			site.add("rename", site.span(node), `"b"`)
		}
	}
	return {
		operators: ["rename"],
		applies,
		rules: Arr.makeBy(copies, () => rule)
	}
}

layer(NodeServices.layer)("source mutation", (it) => {
	it.effect(
		"yields exactly the mutants each statement names, each at its own text, place, id and function",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "mutants",
						oracle: {
							kind: "specification",
							name: "a table of the mutants each statement shape must yield"
						},
						draw: drawn(programGen),
						literal: Formatter.format,
						coverage: required<Shape>(SHAPES, { cases: 60, sense: notesOnly }),
						kept: [],
						runs: 60,
						shrink: { kind: "bounded", candidates: 100 },
						concurrency: 1,
						steerEvery: 60,
						caseHang: Duration.seconds(30)
					},
					(statements, c) =>
						Effect.gen(function* () {
							c.noteAll(Arr.map(statements, (statement) => statement.shape))
							const text = programOf(statements)
							const mutants = yield* mutantsOf([{ file: "program.ts", text }], noFamilies)
							for (const mutant of mutants) {
								strictEqual(mutant.source, text)
								strictEqual(mutant.file, "program.ts")
								strictEqual(mutant.fn, "run")
								strictEqual(Str.slice(mutant.start, mutant.end)(text), mutant.original)
								strictEqual(
									applied(mutant),
									`${Str.slice(0, mutant.start)(text)}${mutant.replacement}${Str.slice(mutant.end)(text)}`
								)
								const before = Str.split(Str.slice(0, mutant.start)(text), "\n")
								deepStrictEqual(
									{ line: mutant.line, column: mutant.column },
									{
										line: before.length,
										column: Option.getOrElse(Arr.last(before), () => "").length + 1
									}
								)
							}
							strictEqual(
								Arr.dedupe(Arr.map(mutants, (mutant) => mutant.id)).length,
								mutants.length,
								"every mutant's id is its own"
							)
							deepStrictEqual(
								counted(Arr.map(mutants, (mutant): Counts => [[mutant.operator, 1]])),
								counted(Arr.map(statements, (statement) => expectedOf(statement.shape))),
								"the program's operators are its statements'"
							)
						})
				)
			)
	)

	it.effect(
		"adds a family's mutants at each of its sites in the files it applies to, each edit once however many rules propose it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "family mutants",
						oracle: {
							kind: "second-implementation",
							name: 'each "a" literal of each file the family applies to, replaced by "b" alone'
						},
						draw: drawn(familyCase),
						literal: Formatter.format,
						coverage: required<
							| "a file the family skips"
							| "a site in a file it applies to"
							| "several sites in one file"
							| "a rule proposed twice"
						>(
							[
								"a file the family skips",
								"a site in a file it applies to",
								"several sites in one file",
								"a rule proposed twice"
							],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: { kind: "bounded", candidates: 40 },
						concurrency: 1,
						steerEvery: 10,
						caseHang: Duration.minutes(1)
					},
					({ files, rules }, c) =>
						Effect.gen(function* () {
							const applies = (file: string) => Str.startsWith("sql/")(file)
							const sources = Arr.map(files, (file) => ({
								file: file.name,
								text: literalsText(file.literals)
							}))
							const expected = Arr.flatMap(files, (file) =>
								applies(file.name)
									? Arr.flatMap(file.literals, (literal, at) =>
											literal === "a"
												? [
														[
															file.name,
															literalsText(
																Arr.map(file.literals, (other, place) =>
																	place === at ? "b" : other
																)
															)
														] as const
													]
												: []
										)
									: []
							)
							if (Arr.some(files, (file) => !applies(file.name))) {
								c.note("a file the family skips")
							}
							if (Arr.isReadonlyArrayNonEmpty(expected)) {
								c.note("a site in a file it applies to")
							}
							if (
								Arr.some(
									files,
									(file) =>
										applies(file.name) && Arr.filter(file.literals, (l) => l === "a").length > 1
								)
							) {
								c.note("several sites in one file")
							}
							if (rules > 1) {
								c.note("a rule proposed twice")
							}
							const mutants = yield* mutantsOf(sources, [renamingFamily(applies, rules)])
							const byPlace = Order.combine(
								Order.mapInput(Order.String, (entry: readonly [string, string]) => entry[0]),
								Order.mapInput(Order.String, (entry: readonly [string, string]) => entry[1])
							)
							deepStrictEqual(
								Arr.sort(
									Arr.map(
										Arr.filter(mutants, (mutant) => mutant.operator === "rename"),
										(mutant) => [mutant.file, applied(mutant)] as const
									),
									byPlace
								),
								Arr.sort(expected, byPlace)
							)
						})
				)
			)
	)

	it.effect(
		"applies a kept mutant at the one place its original stands, and finds it stale wherever it stands otherwise",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "kept mutants",
						oracle: {
							kind: "second-implementation",
							name: "the text split at every place the original stands"
						},
						draw: drawn((source) => ({
							parts: source.draw(array(element(["x", "y", "xy", " "]), { min: 0, max: 6 })),
							original: source.draw(element(["x", "xy", "yx"]))
						})),
						literal: Formatter.format,
						coverage: required<"applied" | "nowhere" | "repeated">(
							["applied", "nowhere", "repeated"],
							{
								cases: 200,
								sense: notesOnly
							}
						),
						kept: [],
						runs: 200,
						shrink: { kind: "complete" },
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.seconds(30)
					},
					({ parts, original }, c) =>
						Effect.sync(() => {
							const text = Arr.join(parts, "")
							const kept: KeptMutant = {
								name: "the fix",
								file: "a.ts",
								original,
								replacement: "<reverted>",
								killers: ["a.test.ts"]
							}
							const places = Arr.filter(
								Arr.range(0, text.length),
								(at) => Str.slice(at, at + original.length)(text) === original
							)
							const result = keptApplied(kept, text)
							if (places.length === 1) {
								c.note("applied")
								const [at = 0] = places
								deepStrictEqual(
									result,
									Result.succeed(
										`${Str.slice(0, at)(text)}<reverted>${Str.slice(at + original.length)(text)}`
									)
								)
							} else {
								c.note(places.length === 0 ? "nowhere" : "repeated")
								deepStrictEqual(
									Result.isFailure(result) ? Option.some(result.failure.found) : Option.none(),
									Option.some(places.length)
								)
							}
						})
				)
			)
	)
})
