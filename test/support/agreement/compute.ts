import { floorPopulation, type Reached } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample, type Source } from "@grizzle/testing/source"
import { keep, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { Array as Arr, Option, Record as Rec, Result, String as Str } from "effect"
import { CompileError, type CompileReason } from "#compiler/core/errors.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { Compute } from "#compiler/public/compute.ts"
import { Decimal, Money } from "#compiler/public/fields.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { typedTermOf } from "#compiler/scalar/compute/term.ts"
import { carrierSql } from "#compiler/scalar/registry.ts"
import { Cell, Cells } from "#test/support/agreement/compute-schema.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { messageOf } from "#test/support/message.ts"

/**
 * The Compute population: terms, predicates, aggregates and host values drawn over one relation of every carrier
 * (Cell, ./compute-schema.ts), each read twice, as TypeScript source for one program the type tier checks and through
 * the engine's JavaScript view (computeCore, the query builder, compileTemplate), which builds and compiles it as the
 * runtime does.
 * The engine is the oracle:
 *
 * - a case typechecks exactly when the engine builds and compiles it: a refused case stands under a directive, which the
 *   type-test batch disarms, so a type the engine refuses is a directive whose diagnostic never comes and a type the
 *   engine admits but the types refuse a diagnostic no directive names;
 * - a refusal the types name by a Refusal names the engine's reason: a partial operation's precondition, a cast
 *   PostgreSQL does not define, a literal standing first (claimOf); every other refusal is a structural directive,
 *   whose diagnostic must print no Refusal;
 * - an admitted term's TypeOfTerm and SqlOfTerm are the engine's typed term's, its query's head the engine's heading and
 *   its parameters the engine's, each through a generated exact-equality assertion.
 *
 * A case is drawn under a swarm over its constructs (@grizzle/testing/swarm), so the forms that crowd others out are
 * left out of some cases. Each operation's first operand is drawn from the families it is defined over four times in
 * five, and its other operands like the first, so both verdicts are common; a literal stands first where the swarm keeps
 * it. The floor's witnesses (computeWitnesses), the same in every run, reach every construct both admitted and refused
 * where it can be, and every Refusal the types name, so the program is never vacuous on any seed.
 */

type FieldName = keyof typeof Cell.fields

/** The fields of each family the catalogue's operations are defined over. */
const families = {
	integer: ["small", "int", "big", "cents", "epoch", "divisor"],
	numeric: ["dec", "rate"],
	float: ["real", "dbl"],
	money: ["money"],
	text: ["text", "word", "body"],
	boolean: ["flag"],
	uuid: ["id"],
	date: ["day"],
	span: ["centsSpan", "intSpan"],
	vector: ["vec", "wide"],
	set: ["tones", "shades"],
	code: ["tone"]
} as const satisfies Readonly<Record<string, Arr.NonEmptyReadonlyArray<FieldName>>>

type Family = keyof typeof families

const allFields: Arr.NonEmptyReadonlyArray<FieldName> = [
	"id",
	...Arr.flatMap(Rec.values(families), (fields): ReadonlyArray<FieldName> => fields)
]

/** A JavaScript value a case writes: its source and the value the engine's reading builds. */
interface Lit {
	readonly text: string
	readonly value: unknown
}

/**
 * The JavaScript values a case draws, the values the catalogue's literal typing branches on: numbers whole and not,
 * zero and negative; bigints; exact decimal strings and other text, patterns well formed and not; a boolean; a uuid; a
 * Decimal and a Money.
 */
const lits: Arr.NonEmptyReadonlyArray<Lit> = [
	{ text: "0", value: 0 },
	{ text: "1", value: 1 },
	{ text: "7", value: 7 },
	{ text: "-1", value: -1 },
	{ text: "0.5", value: 0.5 },
	{ text: "0n", value: 0n },
	{ text: "1n", value: 1n },
	{ text: "2n", value: 2n },
	{ text: "-1n", value: -1n },
	{ text: '"2.50"', value: "2.50" },
	{ text: '"0"', value: "0" },
	{ text: '"x"', value: "x" },
	{ text: '"^[0-9]+$"', value: "^[0-9]+$" },
	{ text: '"a("', value: "a(" },
	{ text: "true", value: true },
	{ text: '"00000000-0000-4000-8000-000000000001"', value: "00000000-0000-4000-8000-000000000001" },
	{ text: 'Decimal.of("0.25")', value: Decimal.of("0.25") },
	{ text: "Money.of(5n)", value: Money.of(5n) }
]

/** The catalogue's operations of one, two and three operands, each a Compute member called on its operands. */
const unaryFns = [
	"neg",
	"abs",
	"sign",
	"sqrt",
	"ceil",
	"floor",
	"round",
	"trunc",
	"minScale",
	"numeric",
	"base",
	"charLength",
	"octetLength",
	"lowerAscii",
	"replaceWhitespace",
	"collapse",
	"cardinality"
] as const
const binaryFns = [
	"add",
	"sub",
	"mul",
	"div",
	"mod",
	"quot",
	"rem",
	"gcd",
	"lcm",
	"power",
	"least",
	"greatest",
	"concat",
	"startsWith",
	"endsWith",
	"cosineDistance",
	"union",
	"intersection",
	"difference",
	"subset",
	"disjoint"
] as const
const ternaryFns = ["translate", "widthBucket"] as const
type UnaryFn = (typeof unaryFns)[number]
type BinaryFn = (typeof binaryFns)[number]
type TernaryFn = (typeof ternaryFns)[number]
type Fn = UnaryFn | BinaryFn | TernaryFn

const tests = ["nonzero", "nonnegative", "positive", "isFinite"] as const
type Test = (typeof tests)[number]
const compares = ["eq", "ne", "lt", "le", "gt", "ge"] as const
type Compare = (typeof compares)[number]
const aggregates = ["sum", "mean", "min", "max"] as const
type AggregateFn = (typeof aggregates)[number]
const values = ["Decimal.of", "Money.of"] as const
type ValueCtor = (typeof values)[number]

/** The constructs a case may use, each a swarm feature. */
const computeFeatures = [
	...unaryFns,
	...binaryFns,
	...ternaryFns,
	"cast",
	"lower",
	"upper",
	"width",
	"cond",
	"when",
	...tests,
	"within",
	"matches",
	...compares,
	"between",
	"in",
	...aggregates,
	...values,
	"Compute member",
	"Decimal member",
	"parts member",
	"literal first",
	"param operand",
	"literal operand",
	"typed operand",
	"computed operand"
] as const
type ComputeFeature = (typeof computeFeatures)[number]

/** The Refusals of the Compute catalogue the types name, by the engine's reason (claimOf). */
const refusalNotes = {
	"a divisor proved nonzero: guard it with Compute.when(Compute.nonzero(x), (x) => …, otherwise)":
		"refused: a divisor",
	"a radicand proved nonnegative: guard it with Compute.when(Compute.nonnegative(x), (x) => …, otherwise)":
		"refused: a radicand",
	"a value proved finite: guard it with Compute.when(Compute.isFinite(x), (x) => …, otherwise)":
		"refused: a finite value",
	"a power's base proved nonnegative, and nonzero or its exponent nonnegative: guard it with Compute.when(Compute.positive(x), (x) => …, otherwise)":
		"refused: a power",
	"PostgreSQL has no cast between these types that Compute admits": "refused: a cast",
	"a term first: a literal takes its place opposite a term, never first": "refused: a literal first"
} as const
type ComputeRefusal = keyof typeof refusalNotes
type RefusalNote = (typeof refusalNotes)[ComputeRefusal]
export const computeRefusals: Arr.NonEmptyReadonlyArray<RefusalNote> = [
	"refused: a divisor",
	"refused: a radicand",
	"refused: a finite value",
	"refused: a power",
	"refused: a cast",
	"refused: a literal first"
]

/** The inferences the program asserts of an admitted case, by what the engine typed it. */
export const computeInferences = [
	"an exact integer",
	"exact money",
	"a contract kept",
	"a contract dropped",
	"a guarded partial operation",
	"a guarded parameter",
	"a contract's proved fact",
	"a parameter typed"
] as const
type Inference = (typeof computeInferences)[number]

/** What a case reached: its constructs, the engine's verdict, the Refusal it names and what its types infer. */
export type ComputeNote =
	| ComputeFeature
	| "admitted"
	| "refused"
	| "refused: structurally"
	| RefusalNote
	| DecidedNote
	| Inference

type Operand =
	| { readonly kind: "field"; readonly field: FieldName }
	| { readonly kind: "param"; readonly name: string; readonly field: FieldName }
	| { readonly kind: "literal"; readonly lit: Lit }
	| { readonly kind: "typed"; readonly field: FieldName; readonly lit: Lit }
	| { readonly kind: "guarded" }
	| { readonly kind: "term"; readonly term: TermSpec }

type TermSpec =
	| { readonly kind: "apply"; readonly fn: Fn; readonly args: Arr.NonEmptyReadonlyArray<Operand> }
	| { readonly kind: "cast"; readonly x: Operand; readonly to: FieldName }
	| {
			readonly kind: "endpoint"
			readonly fn: "lower" | "upper" | "width"
			readonly s: Operand
			readonly to: FieldName
	  }
	| {
			readonly kind: "cond"
			readonly p: PredSpec
			readonly whenTrue: Operand
			readonly otherwise: Operand
	  }
	| {
			readonly kind: "when"
			readonly guard: GuardSpec
			readonly body: TermSpec
			readonly otherwise: Operand
	  }

type GuardSpec =
	| { readonly kind: "test"; readonly test: Test; readonly x: Operand }
	| { readonly kind: "within"; readonly x: Operand; readonly low: Lit; readonly high: Lit }
	| { readonly kind: "matches"; readonly x: Operand; readonly pattern: Operand }

type PredSpec =
	| { readonly kind: "compare"; readonly op: Compare; readonly a: Operand; readonly b: Operand }
	| { readonly kind: "between"; readonly a: Operand; readonly low: Operand; readonly high: Operand }
	| { readonly kind: "in"; readonly a: Operand; readonly values: Arr.NonEmptyReadonlyArray<Lit> }
	| { readonly kind: "guard"; readonly guard: GuardSpec }

/**
 * A member read off a host value: a Compute member, a Decimal's or its parts', each named from the runtime's own
 * members and the names a reader may reach for that it lacks.
 */
type Holder = "Compute" | "Decimal" | "parts"

type CaseSpec =
	| { readonly kind: "term"; readonly term: TermSpec }
	| { readonly kind: "predicate"; readonly pred: PredSpec }
	| { readonly kind: "aggregate"; readonly fn: AggregateFn; readonly of: Operand }
	| { readonly kind: "value"; readonly ctor: ValueCtor; readonly lit: Lit }
	| { readonly kind: "member"; readonly holder: Holder; readonly name: string }

/** The operations each family is the home of: a first operand is drawn from them four times in five. */
const homes: { readonly [F in Fn]: Arr.NonEmptyReadonlyArray<Family> } = {
	neg: ["integer", "numeric", "float", "money"],
	abs: ["integer", "numeric", "float", "money"],
	sign: ["integer", "numeric", "float"],
	sqrt: ["numeric", "float", "integer"],
	ceil: ["numeric", "integer"],
	floor: ["numeric", "float"],
	round: ["numeric", "integer"],
	trunc: ["numeric", "integer"],
	minScale: ["numeric", "integer"],
	numeric: ["integer", "money", "numeric", "float"],
	base: ["integer", "numeric", "text"],
	charLength: ["text", "uuid"],
	octetLength: ["text", "integer"],
	lowerAscii: ["text", "uuid"],
	replaceWhitespace: ["text"],
	collapse: ["text", "integer"],
	cardinality: ["set", "text"],
	add: ["integer", "numeric", "float", "money"],
	sub: ["integer", "numeric", "float", "money"],
	mul: ["integer", "numeric", "float", "money"],
	div: ["integer", "numeric", "float", "money"],
	mod: ["integer", "numeric", "float", "money"],
	quot: ["numeric", "integer"],
	rem: ["numeric", "integer"],
	gcd: ["integer", "numeric", "float"],
	lcm: ["integer", "numeric"],
	power: ["numeric", "float", "integer"],
	least: ["integer", "numeric", "float", "money", "text", "date"],
	greatest: ["integer", "numeric", "float", "money", "text", "date"],
	concat: ["text", "uuid"],
	startsWith: ["text", "integer"],
	endsWith: ["text", "integer"],
	cosineDistance: ["vector"],
	union: ["set"],
	intersection: ["set"],
	difference: ["set"],
	subset: ["set"],
	disjoint: ["set", "integer"],
	translate: ["text", "uuid"],
	widthBucket: ["numeric", "float", "integer"]
}

const numericHomes: Arr.NonEmptyReadonlyArray<Family> = ["integer", "numeric", "float", "money"]

/** One case's drawing: its swarm, the source its decisions come from, the constructs it reached and its parameters. */
class Drawing {
	readonly #source: Source
	readonly #swarm: Swarm<ComputeFeature>
	#params = 0
	readonly reached = new Set<ComputeFeature>()

	constructor(source: Source, drawn: Swarm<ComputeFeature>) {
		this.#source = source
		this.#swarm = drawn
	}

	keep(feature: ComputeFeature): boolean {
		const kept = this.#source.draw(keep(this.#swarm, feature))
		if (kept) {
			this.reached.add(feature)
		}
		return kept
	}

	note(feature: ComputeFeature): void {
		this.reached.add(feature)
	}

	choose<O extends ComputeFeature>(options: Arr.NonEmptyReadonlyArray<O>): O {
		const chosen = this.#source.draw(swarmChoice(this.#swarm, options))
		this.reached.add(chosen)
		return chosen
	}

	from<A>(options: Arr.NonEmptyReadonlyArray<A>): A {
		return this.#source.draw(element(options))
	}

	param(field: FieldName): Operand {
		const name = `p${this.#params}`
		this.#params += 1
		this.note("param operand")
		return { kind: "param", name, field }
	}
}

/** A field of one of `homes` four times in five, and of any family otherwise. */
const homeField = (d: Drawing, home: Arr.NonEmptyReadonlyArray<Family>): FieldName =>
	d.from([0, 1, 2, 3, 4]) < 4 ? d.from(families[d.from(home)]) : d.from(allFields)

/** The field an operand reads, where it reads one directly. */
const fieldOf = (o: Operand): FieldName | undefined =>
	o.kind === "field" || o.kind === "param" || o.kind === "typed" ? o.field : undefined

/** A first operand: a field, a parameter of one, a computed term, or, where the swarm keeps it, a literal. */
const firstOperand = (
	d: Drawing,
	home: Arr.NonEmptyReadonlyArray<Family>,
	depth: number
): Operand => {
	if (d.keep("literal first") && d.from([0, 1, 2, 3]) === 0) {
		return { kind: "literal", lit: d.from(lits) }
	}
	switch (d.from(["field", "field", "field", "param", "computed"] as const)) {
		case "field":
			return { kind: "field", field: homeField(d, home) }
		case "param":
			return d.param(homeField(d, home))
		case "computed":
			return depth > 0 && d.keep("computed operand")
				? { kind: "term", term: applyOver(d, d.from(unaryAndBinary), depth - 1) }
				: { kind: "field", field: homeField(d, home) }
	}
}

const unaryAndBinary: Arr.NonEmptyReadonlyArray<UnaryFn | BinaryFn> = [...unaryFns, ...binaryFns]

/**
 * An operand opposite `first`: the same field, a parameter of it, a JavaScript value, a typed literal of it, another
 * field, or a computed term over it.
 */
const otherOperand = (d: Drawing, first: Operand, depth: number): Operand => {
	const field = fieldOf(first) ?? d.from(allFields)
	switch (
		d.from([
			"same",
			"same",
			"same",
			"param",
			"literal",
			"literal",
			"typed",
			"other",
			"computed"
		] as const)
	) {
		case "same":
			return { kind: "field", field }
		case "param":
			return d.param(field)
		case "literal":
			d.note("literal operand")
			return { kind: "literal", lit: d.from(lits) }
		case "typed":
			d.note("typed operand")
			return { kind: "typed", field, lit: d.from(lits) }
		case "other":
			return { kind: "field", field: d.from(allFields) }
		case "computed":
			return depth > 0 && d.keep("computed operand")
				? {
						kind: "term",
						term: { kind: "apply", fn: d.from(unaryAndBinary), args: [{ kind: "field", field }] }
					}
				: { kind: "field", field }
	}
}

/** An application of `fn` to operands drawn for it. */
const applyOver = (d: Drawing, fn: Fn, depth: number): TermSpec => {
	d.note(fn)
	const first = firstOperand(d, homes[fn], depth)
	if (Arr.contains(unaryFns, fn)) {
		const scaled =
			(fn === "round" || fn === "trunc") && d.from([0, 1]) === 1
				? [{ kind: "literal", lit: d.from(lits) } as const]
				: []
		return { kind: "apply", fn, args: [first, ...scaled] }
	}
	if (fn === "translate") {
		return {
			kind: "apply",
			fn,
			args: [first, { kind: "literal", lit: d.from(lits) }, { kind: "literal", lit: d.from(lits) }]
		}
	}
	if (fn === "widthBucket") {
		return {
			kind: "apply",
			fn,
			args: [first, otherOperand(d, first, 0), otherOperand(d, first, 0), d.param("int")]
		}
	}
	return { kind: "apply", fn, args: [first, otherOperand(d, first, depth)] }
}

/** A guard over a subject drawn from the numeric families, or a text's match. */
const guardOver = (d: Drawing): GuardSpec => {
	const kind = d.choose([...tests, "within", "matches"] as const)
	switch (kind) {
		case "within": {
			const x = firstOperand(d, numericHomes, 0)
			return { kind: "within", x, low: d.from(lits), high: d.from(lits) }
		}
		case "matches": {
			const x = firstOperand(d, ["text"], 0)
			return { kind: "matches", x, pattern: otherOperand(d, x, 0) }
		}
		case "nonzero":
		case "nonnegative":
		case "positive":
		case "isFinite":
			return { kind: "test", test: kind, x: firstOperand(d, numericHomes, 0) }
	}
}

const subjectOf = (g: GuardSpec): Operand => g.x

/**
 * A when's branch over the guarded subject: a partial operation of it (a division by it, its remainder, square root,
 * power, least scale or cast), or another operation with it first.
 */
const guardedBody = (d: Drawing, subject: Operand): TermSpec => {
	const guarded: Operand = { kind: "guarded" }
	const field = fieldOf(subject) ?? d.from(allFields)
	switch (d.from(["div", "mod", "sqrt", "power", "minScale", "cast", "concat", "other"] as const)) {
		case "div":
		case "mod": {
			const fn = d.from(["div", "mod"] as const)
			d.note(fn)
			return {
				kind: "apply",
				fn,
				args: [{ kind: "field", field: homeField(d, homes[fn]) }, guarded]
			}
		}
		case "sqrt":
			d.note("sqrt")
			return { kind: "apply", fn: "sqrt", args: [guarded] }
		case "power":
			d.note("power")
			return { kind: "apply", fn: "power", args: [guarded, { kind: "literal", lit: d.from(lits) }] }
		case "minScale":
			d.note("minScale")
			return { kind: "apply", fn: "minScale", args: [guarded] }
		case "cast":
			d.note("cast")
			return { kind: "cast", x: guarded, to: d.from(allFields) }
		case "concat":
			d.note("concat")
			return {
				kind: "apply",
				fn: "concat",
				args: [guarded, { kind: "literal", lit: d.from(lits) }]
			}
		case "other": {
			const fn = d.from(binaryFns)
			d.note(fn)
			return { kind: "apply", fn, args: [guarded, otherOperand(d, { kind: "field", field }, 0)] }
		}
	}
}

/** A predicate: a comparison, a range, a list, or a guard used as one. */
const predOver = (d: Drawing): PredSpec => {
	const kind = d.choose([...compares, "between", "in", ...tests, "within", "matches"] as const)
	switch (kind) {
		case "between": {
			const a = firstOperand(d, homes.least, 1)
			return { kind: "between", a, low: otherOperand(d, a, 0), high: otherOperand(d, a, 0) }
		}
		case "in":
			return {
				kind: "in",
				a: firstOperand(d, homes.least, 1),
				values: [d.from(lits), ...(d.from([0, 1]) === 1 ? [d.from(lits)] : [])]
			}
		case "nonzero":
		case "nonnegative":
		case "positive":
		case "isFinite":
			return {
				kind: "guard",
				guard: { kind: "test", test: kind, x: firstOperand(d, numericHomes, 0) }
			}
		case "within":
			return {
				kind: "guard",
				guard: {
					kind: "within",
					x: firstOperand(d, numericHomes, 0),
					low: d.from(lits),
					high: d.from(lits)
				}
			}
		case "matches": {
			const x = firstOperand(d, ["text"], 0)
			return { kind: "guard", guard: { kind: "matches", x, pattern: otherOperand(d, x, 0) } }
		}
		case "eq":
		case "ne":
		case "lt":
		case "le":
		case "gt":
		case "ge": {
			const a = firstOperand(d, homes.least, 1)
			return { kind: "compare", op: kind, a, b: otherOperand(d, a, 1) }
		}
	}
}

/** A term: an operation, a cast, a span's endpoint, a conditional or a guarded branch. */
const termOver = (d: Drawing): TermSpec => {
	const kind = d.choose([
		...unaryFns,
		...binaryFns,
		...ternaryFns,
		"cast",
		"lower",
		"upper",
		"width",
		"cond",
		"when"
	] as const)
	if (kind === "cast") {
		return { kind: "cast", x: firstOperand(d, numericHomes, 1), to: d.from(allFields) }
	}
	if (kind === "lower" || kind === "upper" || kind === "width") {
		return {
			kind: "endpoint",
			fn: kind,
			s: firstOperand(d, ["span"], 0),
			to: d.from([...families.span, ...families.integer])
		}
	}
	if (kind === "cond") {
		const p = predOver(d)
		const whenTrue = firstOperand(d, homes.least, 1)
		return { kind: "cond", p, whenTrue, otherwise: otherOperand(d, whenTrue, 1) }
	}
	if (kind === "when") {
		const guard = guardOver(d)
		return {
			kind: "when",
			guard,
			body: guardedBody(d, subjectOf(guard)),
			otherwise: otherOperand(d, subjectOf(guard), 0)
		}
	}
	return applyOver(d, kind, 1)
}

/** The names a member case reads: the holder's own, and names a reader may reach for that it lacks. */
const memberNames: { readonly [H in Holder]: Arr.NonEmptyReadonlyArray<string> } = {
	Compute: ["scale", "trimScale", "displayScale", ...Rec.keys(Compute)],
	Decimal: ["text", "parts", "isFinite", "equals", "scale", "identityText", "displayScale"],
	parts: ["kind", "coefficient", "minScale", "exponent"]
}

/** One case: its kind under the swarm, then its parts. */
const caseOver = (d: Drawing): CaseSpec => {
	switch (
		d.from(["term", "term", "term", "term", "predicate", "aggregate", "value", "member"] as const)
	) {
		case "term":
			return { kind: "term", term: termOver(d) }
		case "predicate":
			return { kind: "predicate", pred: predOver(d) }
		case "aggregate":
			return { kind: "aggregate", fn: d.choose(aggregates), of: firstOperand(d, numericHomes, 1) }
		case "value":
			return { kind: "value", ctor: d.choose(values), lit: d.from(lits) }
		case "member": {
			const feature = d.choose(["Compute member", "Decimal member", "parts member"] as const)
			const holder: Holder =
				feature === "Compute member"
					? "Compute"
					: feature === "Decimal member"
						? "Decimal"
						: "parts"
			return { kind: "member", holder, name: d.from(memberNames[holder]) }
		}
	}
}

/** The source of a case's parts, and whether it reads the rule (a parameter, an aggregate) and the cell. */
class Rendering {
	usesRule = false
	usesCell = false
	readonly fields = new Set<FieldName>()

	operand(o: Operand): string {
		switch (o.kind) {
			case "field":
				this.usesCell = true
				this.fields.add(o.field)
				return `cell.${o.field}`
			case "param":
				this.usesRule = true
				return `r.param(${jsonText(o.name)}, Cell.fields.${o.field})`
			case "literal":
				return o.lit.text
			case "typed":
				return `Compute.literal(Cell.fields.${o.field}, ${o.lit.text})`
			case "guarded":
				return "g"
			case "term":
				return this.term(o.term)
		}
	}

	term(t: TermSpec): string {
		switch (t.kind) {
			case "apply":
				return `Compute.${t.fn}(${Arr.join(
					Arr.map(t.args, (a) => this.operand(a)),
					", "
				)})`
			case "cast":
				return `Compute.cast(${this.operand(t.x)}, Cell.fields.${t.to})`
			case "endpoint":
				return `Compute.${t.fn}(${this.operand(t.s)}, Cell.fields.${t.to})`
			case "cond":
				return `Compute.cond(${this.pred(t.p)}, ${this.operand(t.whenTrue)}, ${this.operand(t.otherwise)})`
			case "when":
				return `Compute.when(${this.guard(t.guard)}, (g) => ${this.term(t.body)}, ${this.operand(t.otherwise)})`
		}
	}

	guard(g: GuardSpec): string {
		switch (g.kind) {
			case "test":
				return `Compute.${g.test}(${this.operand(g.x)})`
			case "within":
				return `Compute.within(${this.operand(g.x)}, ${g.low.text}, ${g.high.text})`
			case "matches":
				return `Compute.matches(${this.operand(g.x)}, ${this.operand(g.pattern)})`
		}
	}

	pred(p: PredSpec): string {
		switch (p.kind) {
			case "compare":
				return `Compute.${p.op}(${this.operand(p.a)}, ${this.operand(p.b)})`
			case "between":
				return `Compute.between(${this.operand(p.a)}, ${this.operand(p.low)}, ${this.operand(p.high)})`
			case "in":
				return `Compute.in(${this.operand(p.a)}, [${Arr.join(
					Arr.map(p.values, (l) => l.text),
					", "
				)}])`
			case "guard":
				return this.guard(p.guard)
		}
	}

	aggregate(fn: AggregateFn, of: Operand): string {
		this.usesRule = true
		return `r.${fn}(${this.operand(of)})`
	}
}

/** A Compute member called on its operands, through the core a JavaScript caller reaches. */
const applied = (fn: Fn, args: ReadonlyArray<unknown>): unknown => {
	const [a, b, c, e] = args
	switch (fn) {
		case "least":
			return b === undefined ? computeCore.least(a) : computeCore.least(a, b)
		case "greatest":
			return b === undefined ? computeCore.greatest(a) : computeCore.greatest(a, b)
		case "round":
			return b === undefined ? computeCore.round(a) : computeCore.round(a, b)
		case "trunc":
			return b === undefined ? computeCore.trunc(a) : computeCore.trunc(a, b)
		case "translate":
			return computeCore.translate(a, b, c)
		case "widthBucket":
			return computeCore.widthBucket(a, b, c, e)
		case "neg":
		case "abs":
		case "sign":
		case "sqrt":
		case "ceil":
		case "floor":
		case "minScale":
		case "numeric":
		case "base":
		case "charLength":
		case "octetLength":
		case "lowerAscii":
		case "replaceWhitespace":
		case "collapse":
		case "cardinality":
			return computeCore[fn](a)
		case "add":
		case "sub":
		case "mul":
		case "div":
		case "mod":
		case "quot":
		case "rem":
		case "gcd":
		case "lcm":
		case "power":
		case "concat":
		case "startsWith":
		case "endsWith":
		case "cosineDistance":
		case "union":
		case "intersection":
		case "difference":
		case "subset":
		case "disjoint":
			return computeCore[fn](a, b)
	}
}

/** The engine's reading of a case inside its rule: the same construct, built by the cores over `cell` and `r`. */
class Building {
	readonly #r: RuleValue
	readonly #cell: Readonly<Record<string, unknown>>
	readonly #guarded: unknown

	constructor(r: RuleValue, cell: Readonly<Record<string, unknown>>, guarded: unknown) {
		this.#r = r
		this.#cell = cell
		this.#guarded = guarded
	}

	operand(o: Operand): unknown {
		switch (o.kind) {
			case "field":
				return this.#cell[o.field]
			case "param":
				return this.#r.param(o.name, Cell.fields[o.field])
			case "literal":
				return o.lit.value
			case "typed":
				return computeCore.literal(Cell.fields[o.field], o.lit.value)
			case "guarded":
				return this.#guarded
			case "term":
				return this.term(o.term)
		}
	}

	term(t: TermSpec): unknown {
		switch (t.kind) {
			case "apply":
				return applied(
					t.fn,
					Arr.map(t.args, (a) => this.operand(a))
				)
			case "cast":
				return computeCore.cast(this.operand(t.x), Cell.fields[t.to])
			case "endpoint":
				return computeCore[t.fn](this.operand(t.s), Cell.fields[t.to])
			case "cond":
				return computeCore.cond(this.pred(t.p), this.operand(t.whenTrue), this.operand(t.otherwise))
			case "when":
				return computeCore.when(
					this.guard(t.guard),
					(g: unknown) => new Building(this.#r, this.#cell, g).term(t.body),
					this.operand(t.otherwise)
				)
		}
	}

	guard(g: GuardSpec): unknown {
		switch (g.kind) {
			case "test":
				return computeCore[g.test](this.operand(g.x))
			case "within":
				return computeCore.within(this.operand(g.x), g.low.value, g.high.value)
			case "matches":
				return computeCore.matches(this.operand(g.x), this.operand(g.pattern))
		}
	}

	pred(p: PredSpec): unknown {
		switch (p.kind) {
			case "compare":
				return computeCore[p.op](this.operand(p.a), this.operand(p.b))
			case "between":
				return computeCore.between(this.operand(p.a), this.operand(p.low), this.operand(p.high))
			case "in":
				return computeCore.in(
					this.operand(p.a),
					Arr.map(p.values, (l) => l.value)
				)
			case "guard":
				return this.guard(p.guard)
		}
	}

	aggregate(fn: AggregateFn, of: Operand): unknown {
		return this.#r[fn](this.operand(of))
	}
}

/** What a refused case's directive claims: a Refusal the types name, or a structural refusal in the engine's words. */
type Claim =
	| { readonly kind: "refusal"; readonly refusal: ComputeRefusal }
	| { readonly kind: "prose"; readonly why: string }

/** The Refusal the types name for a partial operation, by the precondition the engine found unproved. */
const partialRefusals: Readonly<Record<string, ComputeRefusal>> = {
	nonzero:
		"a divisor proved nonzero: guard it with Compute.when(Compute.nonzero(x), (x) => …, otherwise)",
	nonnegative:
		"a radicand proved nonnegative: guard it with Compute.when(Compute.nonnegative(x), (x) => …, otherwise)",
	finite:
		"a value proved finite: guard it with Compute.when(Compute.isFinite(x), (x) => …, otherwise)",
	powerDomain:
		"a power's base proved nonnegative, and nonzero or its exponent nonnegative: guard it with Compute.when(Compute.positive(x), (x) => …, otherwise)"
}

/** The engine's words for a refusal, on one line. */
const oneLine = (text: string): string => Arr.join(Str.split(text, "\n"), " ")

/** What a case's directive claims of the engine's refusal. */
const claimOf = (reason: CompileReason): Claim => {
	if (reason._tag === "PartialOperation") {
		const refusal = partialRefusals[reason.precondition]
		return refusal === undefined
			? { kind: "prose", why: `the engine: ${reason.operation} needs ${reason.precondition}` }
			: { kind: "refusal", refusal }
	}
	if (reason._tag === "MalformedDescription") {
		return Str.includes("a literal never stands first")(reason.what)
			? {
					kind: "refusal",
					refusal: "a term first: a literal takes its place opposite a term, never first"
				}
			: { kind: "prose", why: `the engine: ${oneLine(reason.what)}` }
	}
	if (reason._tag === "UnsupportedOperation") {
		return Str.startsWith("cast:")(reason.capability)
			? {
					kind: "refusal",
					refusal: "PostgreSQL has no cast between these types that Compute admits"
				}
			: { kind: "prose", why: `the engine: ${oneLine(reason.capability)}` }
	}
	return { kind: "prose", why: `the engine: ${reason._tag}` }
}

/** The names a program's type texts and values import beside the schema's, as they are used. */
type Imported =
	| "Decimal"
	| "Money"
	| "Uuid"
	| "CalendarDate"
	| "Span"
	| "Vector"
	| "Infer"
	| "Rostered"

/**
 * The field of Cell each contract is the type of, a calendar date's among them, through which the program names the
 * contract's host type.
 */
const contractFields: Readonly<Record<string, FieldName>> = {
	Cents: "cents",
	EpochDay: "epoch",
	Rate: "rate",
	Divisor: "divisor",
	Body: "body",
	date: "day"
}

/**
 * The host type a value of the engine's type `t` has, as the program spells it, with the names it imports: a term's
 * identity, where a closed id's handles carry their roster's brand, or the values a column delivers, its bare handles.
 */
const hostText = (t: ScalarType, uses: Set<Imported>, position: "term" | "delivered"): string => {
	const named = contractOf(t)
	if (named !== undefined) {
		const field = contractFields[named.name]
		if (field === undefined) {
			throw new Error(`a contract no field of Cell is the type of: ${named.name}`)
		}
		uses.add("Infer")
		return `Infer<typeof Cell.fields.${field}>`
	}
	switch (t.carrier) {
		case "int2":
		case "int4":
		case "float4":
		case "float8":
			return "number"
		case "int8":
		case "exactInteger":
			return "bigint"
		case "numeric":
			uses.add("Decimal")
			return "Decimal"
		case "money":
		case "exactMoney":
			uses.add("Money")
			return "Money"
		case "bool":
			return "boolean"
		case "uuid":
			uses.add("Uuid")
			return "Uuid"
		case "date":
			uses.add("CalendarDate")
			return "CalendarDate"
		case "text":
			return "string"
		case "range4":
		case "range8":
			uses.add("Span")
			return `Span<${hostText(t.span.endpoint, uses, position)}>`
		case "vector":
			uses.add("Vector")
			return `Vector<${t.typmod.dims}>`
		case "code": {
			const roster = jsonText(t.roster.closed)
			if (position === "delivered") {
				return Arr.join(
					Arr.map(t.roster.handles, (h) => jsonText(h)),
					" | "
				)
			}
			uses.add("Rostered")
			return Arr.join(
				Arr.map(t.roster.handles, (h) => `(${jsonText(h)} & Rostered<${roster}>)`),
				" | "
			)
		}
		case "bits":
			uses.add("Rostered")
			return `ReadonlySet<${Arr.join(
				Arr.map(t.roster.handles, (h) => jsonText(h)),
				" | "
			)}> & Rostered<${jsonText(t.roster.closed)}>`
	}
}

/** What the engine admitted of a case, which the program asserts of its types. */
interface Admitted {
	/** A term's TypeOfTerm and SqlOfTerm. */
	readonly term: { readonly type: string; readonly sql: string } | undefined
	/** The host type of the query's one output column, `out`, where it has one. */
	readonly out: string | undefined
	/** Each parameter's name and ParamType. */
	readonly params: ReadonlyArray<readonly [string, string]>
}

/**
 * What the engine decides that no type states, so the types admit a case the engine refuses for it: a precondition
 * compilation alone proves (a value fitting its target's range, a contract holding of a value, a text inside a
 * pattern's language or a lexical form, a value inside width_bucket's domain), a text function's place in a query
 * (a concatenation beside an equation, a translation of a long text, a length outside a predicate), the digits of an
 * exact decimal's text, and the values of a pattern term the build must see.
 */
const engineDecides = {
	fits: "decided: a fit",
	contract: "decided: a contract",
	language: "decided: a language",
	lexical: "decided: a lexical form",
	bucketDomain: "decided: a bucket's domain",
	placement: "decided: a text function's place",
	digits: "decided: a decimal's digits",
	pattern: "decided: a pattern's values"
} as const
type DecidedNote = (typeof engineDecides)[keyof typeof engineDecides]
const computeDecided: Arr.NonEmptyReadonlyArray<DecidedNote> = [
	"decided: a fit",
	"decided: a contract",
	"decided: a lexical form",
	"decided: a text function's place",
	"decided: a decimal's digits",
	"decided: a pattern's values"
]

/** Which of the engine's decisions no type states a refusal is, where it is one. */
const decidedBy = (thrown: unknown): DecidedNote | undefined => {
	if (!(thrown instanceof CompileError)) {
		return undefined
	}
	const reason = thrown.reason
	if (reason._tag === "PartialOperation") {
		return reason.precondition === "fits" ||
			reason.precondition === "contract" ||
			reason.precondition === "language" ||
			reason.precondition === "lexical" ||
			reason.precondition === "bucketDomain"
			? engineDecides[reason.precondition]
			: undefined
	}
	if (reason._tag === "MalformedDescription") {
		return Str.startsWith("an exact decimal literal")(reason.what)
			? engineDecides.digits
			: Str.startsWith("a pattern whose every value is seen")(reason.what)
				? engineDecides.pattern
				: Str.includes(" in a query")(reason.what)
					? engineDecides.placement
					: undefined
	}
	if (reason._tag === "UnsupportedOperation") {
		return Str.includes(" in a query")(reason.capability) ? engineDecides.placement : undefined
	}
	return undefined
}

/**
 * The engine's verdict: admitted; refused for what no type states, which the types admit; or refused where the types
 * refuse, with the diagnostic and claim its directive states.
 */
type Verdict =
	| { readonly kind: "admitted"; readonly admitted: Admitted }
	| {
			readonly kind: "decided"
			readonly note: DecidedNote
			readonly term: Admitted["term"]
	  }
	| { readonly kind: "refused"; readonly claim: Claim; readonly code: string }

const refusedBy = (thrown: unknown, code: string): Verdict => ({
	kind: "refused",
	claim:
		thrown instanceof CompileError
			? claimOf(thrown.reason)
			: { kind: "prose", why: `the host: ${oneLine(messageOf(thrown))}` },
	code
})

/** The engine's refusal of a case: one of its decisions no type states, or a refusal the types share. */
const decidedOr = (thrown: unknown, term: Admitted["term"], code: string): Verdict => {
	const note = decidedBy(thrown)
	return note === undefined ? refusedBy(thrown, code) : { kind: "decided", note, term }
}

const paramsOf = (
	params: ReadonlyArray<ParamDecl>,
	uses: Set<Imported>
): ReadonlyArray<readonly [string, string]> =>
	Arr.flatMap(params, (p) =>
		p.kind === "scalar"
			? [
					[
						p.name,
						`ParamType<${hostText(p.type, uses, "term")}, ${jsonText(carrierSql[p.type.carrier])}>`
					] as const
				]
			: []
	)

const outOf = (heading: Heading, uses: Set<Imported>): string | undefined =>
	Option.getOrUndefined(
		Option.map(
			Arr.findFirst(heading, (c) => c.name === "out"),
			(c) => hostText(c.type, uses, "delivered")
		)
	)

/** The diagnostic a refused construct raises: an IN list's member is an element of an array, every other an argument. */
const codeOf = (spec: CaseSpec): string =>
	spec.kind === "predicate" && spec.pred.kind === "in"
		? "TS2322"
		: spec.kind === "member"
			? "TS2339"
			: "TS2345"

/** A query of Cells over the case, built by the engine's reading, with the term it built where it built one. */
const engineQuery = (
	spec: CaseSpec & { readonly kind: "term" | "predicate" | "aggregate" },
	fields: ReadonlySet<FieldName>
): { readonly query: unknown; readonly term: () => unknown } => {
	const holder: Array<unknown> = []
	const query = queryOver(Cells).rule((r: RuleValue) => {
		const cell = varsOver(Cell, "cell")
		const building = new Building(r, cell, undefined)
		const matched = r.match(
			Cell,
			Rec.fromEntries(Arr.map(["id", ...fields], (f) => [f, cell[f]] as const))
		)
		switch (spec.kind) {
			case "term": {
				const term = building.term(spec.term)
				holder.push(term)
				return matched.find({ out: term })
			}
			case "predicate":
				return matched.where(building.pred(spec.pred)).find({ id: cell["id"] })
			case "aggregate":
				return matched.find({ out: building.aggregate(spec.fn, spec.of) })
		}
	})
	return { query, term: () => holder[0] }
}

/**
 * The host constructors as a JavaScript caller reaches them, with whatever value it passes: their own answer to a value
 * their signature refuses is the oracle the types are held to.
 */
const hostDecimal: { of(input: unknown): Decimal } = Decimal
const hostMoney: { of(input: unknown): Money } = Money

/** The values a parts member is read off: a finite Decimal and the specials its parts may be. */
const decimals: Arr.NonEmptyReadonlyArray<Decimal> = [
	Decimal.of("1.5"),
	Decimal.of("NaN"),
	Decimal.of("Infinity")
]

/** Whether every value a member's holder may be has the member: the runtime's answer the types must give. */
const hasMember = (holder: Holder, name: string): boolean => {
	switch (holder) {
		case "Compute":
			return name in Compute
		case "Decimal":
			return Arr.every(decimals, (x) => name in x)
		case "parts":
			return Arr.every(decimals, (x) => name in x.parts)
	}
}

/** The engine's verdict on a case, with the names its expected types import. */
const verdictOf = (
	spec: CaseSpec,
	fields: ReadonlySet<FieldName>,
	uses: Set<Imported>
): Verdict => {
	const code = codeOf(spec)
	switch (spec.kind) {
		case "value": {
			const made = Result.try(() =>
				spec.ctor === "Decimal.of" ? hostDecimal.of(spec.lit.value) : hostMoney.of(spec.lit.value)
			)
			return Result.isFailure(made)
				? decidedOr(made.failure, undefined, code)
				: { kind: "admitted", admitted: { term: undefined, out: undefined, params: [] } }
		}
		case "member":
			return hasMember(spec.holder, spec.name)
				? { kind: "admitted", admitted: { term: undefined, out: undefined, params: [] } }
				: {
						kind: "refused",
						claim: { kind: "prose", why: `${spec.holder} has no ${spec.name}` },
						code
					}
		case "term":
		case "predicate":
		case "aggregate": {
			const built = Result.try(() => engineQuery(spec, fields))
			if (Result.isFailure(built)) {
				return decidedOr(built.failure, undefined, code)
			}
			const typed = spec.kind === "term" ? typedTermOf(built.success.term()) : undefined
			const term =
				typed === undefined
					? undefined
					: { type: hostText(typed.type, uses, "term"), sql: typed.carrier.sql }
			const template = compileTemplate(built.success.query, undefined, testCompile)
			if (!template.ok) {
				return decidedOr(template.error, term, code)
			}
			return {
				kind: "admitted",
				admitted: {
					term,
					out: spec.kind === "predicate" ? undefined : outOf(template.value.heading, uses),
					params: paramsOf(template.value.params, uses)
				}
			}
		}
	}
}

/** One drawn case: its source lines, the engine's verdict, the names it imports and what it reached. */
interface ComputeCase {
	readonly spec: CaseSpec
	readonly expression: string
	readonly usesRule: boolean
	readonly usesCell: boolean
	readonly fields: ReadonlySet<FieldName>
	readonly verdict: Verdict
	readonly uses: ReadonlySet<Imported>
	readonly notes: ReadonlySet<ComputeNote>
}

/** A drawn case and the constructs its drawing reached. */
interface Drawn {
	readonly spec: CaseSpec
	readonly reached: ReadonlySet<ComputeFeature>
}

const drawnGen: Gen<Drawn> = (source) => {
	const d = new Drawing(source, source.draw(swarm(computeFeatures)))
	return { spec: caseOver(d), reached: d.reached }
}

/** The operands a case reads, at every depth. */
const operandsOf = (spec: CaseSpec): ReadonlyArray<Operand> => {
	const ofTerm = (t: TermSpec): ReadonlyArray<Operand> => {
		switch (t.kind) {
			case "apply":
				return Arr.flatMap(t.args, ofOperand)
			case "cast":
				return ofOperand(t.x)
			case "endpoint":
				return ofOperand(t.s)
			case "cond":
				return [...ofPred(t.p), ...ofOperand(t.whenTrue), ...ofOperand(t.otherwise)]
			case "when":
				return [...ofGuard(t.guard), ...ofTerm(t.body), ...ofOperand(t.otherwise)]
		}
	}
	const ofOperand = (o: Operand): ReadonlyArray<Operand> =>
		o.kind === "term" ? [o, ...ofTerm(o.term)] : [o]
	const ofGuard = (g: GuardSpec): ReadonlyArray<Operand> =>
		g.kind === "matches" ? [...ofOperand(g.x), ...ofOperand(g.pattern)] : ofOperand(g.x)
	const ofPred = (p: PredSpec): ReadonlyArray<Operand> => {
		switch (p.kind) {
			case "compare":
				return [...ofOperand(p.a), ...ofOperand(p.b)]
			case "between":
				return [...ofOperand(p.a), ...ofOperand(p.low), ...ofOperand(p.high)]
			case "in":
				return ofOperand(p.a)
			case "guard":
				return ofGuard(p.guard)
		}
	}
	switch (spec.kind) {
		case "term":
			return ofTerm(spec.term)
		case "predicate":
			return ofPred(spec.pred)
		case "aggregate":
			return ofOperand(spec.of)
		case "value":
		case "member":
			return []
	}
}

/** The fields of Cell whose type is a contract. */
const contractTyped: ReadonlySet<FieldName> = new Set(Rec.values(contractFields))

const partialFns: ReadonlySet<string> = new Set(["div", "mod", "sqrt", "power", "minScale"])

/** What the program infers of an admitted case, as the engine typed it. */
const inferencesOf = (spec: CaseSpec, admitted: Admitted): ReadonlyArray<Inference> => {
	const operands = operandsOf(spec)
	const contractOperand = Arr.some(operands, (o) => {
		const field = fieldOf(o)
		return field !== undefined && contractTyped.has(field)
	})
	const term = admitted.term
	const guardedBody =
		spec.kind === "term" && spec.term.kind === "when"
			? spec.term.body.kind === "cast" ||
				(spec.term.body.kind === "apply" && partialFns.has(spec.term.body.fn))
			: false
	const guardedParam =
		spec.kind === "term" && spec.term.kind === "when" && spec.term.guard.x.kind === "param"
	const provedFact =
		spec.kind === "term" &&
		spec.term.kind === "apply" &&
		spec.term.fn === "div" &&
		Arr.some(operandsOf(spec), (o) => fieldOf(o) === "divisor")
	return [
		...(term?.sql === "exact integer" ? ["an exact integer" as const] : []),
		...(term?.sql === "exact money" ? ["exact money" as const] : []),
		...(term !== undefined && Str.startsWith("Infer<")(term.type)
			? ["a contract kept" as const]
			: []),
		...(term !== undefined && contractOperand && !Str.startsWith("Infer<")(term.type)
			? ["a contract dropped" as const]
			: []),
		...(guardedBody ? ["a guarded partial operation" as const] : []),
		...(guardedParam ? ["a guarded parameter" as const] : []),
		...(provedFact ? ["a contract's proved fact" as const] : []),
		...(Arr.isReadonlyArrayNonEmpty(admitted.params) ? ["a parameter typed" as const] : [])
	]
}

const caseOf = ({ spec, reached }: Drawn): ComputeCase => {
	const rendering = new Rendering()
	const expression = expressionOf(rendering, spec)
	const uses = new Set<Imported>()
	const verdict = verdictOf(spec, rendering.fields, uses)
	const notes = new Set<ComputeNote>(reached)
	switch (verdict.kind) {
		case "admitted":
			notes.add("admitted")
			for (const inference of inferencesOf(spec, verdict.admitted)) {
				notes.add(inference)
			}
			break
		case "decided":
			notes.add("admitted")
			notes.add(verdict.note)
			break
		case "refused":
			notes.add("refused")
			notes.add(
				verdict.claim.kind === "refusal"
					? refusalNotes[verdict.claim.refusal]
					: "refused: structurally"
			)
			break
	}
	if (Str.includes("Decimal.")(expression)) {
		uses.add("Decimal")
	}
	if (Str.includes("Money.")(expression)) {
		uses.add("Money")
	}
	return {
		spec,
		expression,
		usesRule: rendering.usesRule,
		usesCell: rendering.usesCell,
		fields: rendering.fields,
		verdict,
		uses,
		notes
	}
}

/** A case's one expression, which its directive, where it is refused, stands above. */
const expressionOf = (rendering: Rendering, spec: CaseSpec): string => {
	switch (spec.kind) {
		case "term":
			return rendering.term(spec.term)
		case "predicate":
			return rendering.pred(spec.pred)
		case "aggregate":
			return rendering.aggregate(spec.fn, spec.of)
		case "value":
			return `${spec.ctor}(${spec.lit.text})`
		case "member":
			return spec.holder === "Compute"
				? `Compute.${spec.name}`
				: spec.holder === "Decimal"
					? `x.${spec.name}`
					: `x.parts.${spec.name}`
	}
}

/**
 * The situations the floor's witnesses reach beside the verdicts, Refusals, decisions and inferences: every construct,
 * each admitted but a literal standing first, and each refused.
 */
export const computeRequired: ReadonlyArray<Reached<ComputeNote>> = [
	...computeFeatures,
	...computeDecided,
	...Arr.map(
		Arr.filter(computeFeatures, (f) => f !== "literal first"),
		(f) => [f, "admitted"] as const
	),
	...Arr.map(computeFeatures, (f) => [f, "refused"] as const)
]

/** The cases the run's own stream draws. */
export const computeCount = 400

const computeLabel = "types/compute agreement"

const caseGen: Gen<ComputeCase> = (source) => caseOf(drawnGen(source))

/** The required pairs: every construct an admitted case and a refused case reach. */
const reachedBy = (c: ComputeCase): ReadonlyArray<Reached<ComputeNote>> => [
	...c.notes,
	...Arr.flatMap([...c.notes], (n): ReadonlyArray<Reached<ComputeNote>> =>
		Arr.contains(computeFeatures, n)
			? [[n, c.verdict.kind === "refused" ? "refused" : "admitted"]]
			: []
	)
]

/**
 * The floor's witnesses: a quarter of the run's count, drawn under the label alone, the same in every run, and the
 * only cases whose constructs and verdicts meet the required situations (test/types/compute/compute.test.ts).
 */
export const computeWitnesses = () =>
	floorPopulation(computeLabel, caseGen, computeCount, reachedBy)

/** Every case the program holds: the floor's witnesses, then the label's stream under the run's seed. */
const computeCases = (seed: number): ReadonlyArray<ComputeCase> => [
	...computeWitnesses().values,
	...sample(caseGen, rotatingSeed(seed, floorSeed(computeLabel)), computeCount)
]

/** The modules the program imports, each spelled as an import specifier relative to the program's directory. */
interface ComputeEntries {
	readonly compute: string
	readonly fields: string
	readonly query: string
	readonly phantom: string
	readonly field: string
	readonly terms: string
	readonly agreement: string
}

export const computeEntriesFrom = (entry: (path: string) => string): ComputeEntries => ({
	compute: entry("packages/engine/src/public/compute.ts"),
	fields: entry("packages/engine/src/public/fields.ts"),
	query: entry("packages/engine/src/public/query.ts"),
	phantom: entry("packages/engine/src/types/core/phantom.ts"),
	field: entry("packages/engine/src/types/fields/field.ts"),
	terms: entry("packages/engine/src/types/query/terms.ts"),
	agreement: entry("test/support/agreement/compute-schema.ts")
})

/** The directive above a refused case's expression, which the type-test batch disarms. */
const directiveOf = (verdict: Verdict): ReadonlyArray<string> => {
	if (verdict.kind !== "refused") {
		return []
	}
	const claim = verdict.claim
	return [
		claim.kind === "refusal"
			? `\t// @ts-expect-error -- ${verdict.code} refusal: ${claim.refusal}`
			: `\t// @ts-expect-error -- ${verdict.code}: ${claim.why}`
	]
}

/** The parameter assertions of a query the engine admitted: its parameters' names, and each one's ParamType. */
const paramsAssertion = (q: string, params: ReadonlyArray<readonly [string, string]>): string => {
	const names = Arr.isReadonlyArrayNonEmpty(params)
		? Arr.join(
				Arr.map(params, ([n]) => jsonText(n)),
				" | "
			)
		: "never"
	const each = Arr.map(
		params,
		([n, t]) => `Expect<Equals<ParamsOf<typeof ${q}>[${jsonText(n)}], ${t}>>`
	)
	return `[${Arr.join([`Expect<Equals<keyof ParamsOf<typeof ${q}>, ${names}>>`, ...each], ", ")}]`
}

/**
 * One case's block: its expression under its directive, and, where the types admit it, its query and the assertions
 * of what the engine typed: the term's type and SQL type, and, where the engine compiled it, the head and parameters.
 */
const blockOf = (c: ComputeCase, i: number): string => {
	const directive = directiveOf(c.verdict)
	const verdict = c.verdict
	switch (c.spec.kind) {
		case "value":
			return Arr.join(
				[
					`export const t${i} =`,
					...directive,
					`\t${c.expression}`,
					...(verdict.kind === "refused"
						? []
						: [
								`export type T${i} = Expect<Equals<typeof t${i}, ${c.spec.ctor === "Decimal.of" ? "Decimal" : "Money"}>>`
							]),
					""
				],
				"\n"
			)
		case "member":
			return Arr.join(
				[
					c.spec.holder === "Compute"
						? `export const t${i} =`
						: `export const t${i} = (x: Decimal) =>`,
					...directive,
					`\t${c.expression}`,
					""
				],
				"\n"
			)
		case "term":
		case "predicate":
		case "aggregate": {
			const signature = `(${c.usesRule ? "r" : "_r"}: R, ${c.usesCell ? "cell" : "_cell"}: CellVars)`
			const used = `t${i}(r, cell)`
			const bindings = Arr.join(
				Arr.map(["id", ...c.fields], (f) => `${f}: cell.${f}`),
				", "
			)
			const query =
				c.spec.kind === "predicate"
					? `export const q${i} = query(Cells).rule((r) => {\n\tconst cell = v(Cell, "cell")\n\treturn r.match(Cell, { ${bindings} }).where(${used}).find({ id: cell.id })\n})`
					: `export const q${i} = query(Cells).rule((r) => {\n\tconst cell = v(Cell, "cell")\n\treturn r.match(Cell, { ${bindings} }).find({ out: ${used} })\n})`
			const term =
				verdict.kind === "admitted"
					? verdict.admitted.term
					: verdict.kind === "decided"
						? verdict.term
						: undefined
			const termAssertion =
				term === undefined
					? []
					: [
							`export type T${i} = [Expect<Equals<TypeOfTerm<ReturnType<typeof t${i}>>, ${term.type}>>, Expect<Equals<SqlOfTerm<ReturnType<typeof t${i}>>, ${jsonText(term.sql)}>>]`
						]
			const compiled =
				verdict.kind !== "admitted"
					? []
					: [
							...(verdict.admitted.out === undefined
								? []
								: [
										`export type H${i} = Expect<Equals<HeadOf<typeof q${i}>, { readonly out: ${verdict.admitted.out} }>>`
									]),
							...(c.spec.kind === "aggregate" && verdict.admitted.out !== undefined
								? [
										`export type A${i} = Expect<Equals<AggregateHost<ReturnType<typeof t${i}>>, ${verdict.admitted.out}>>`
									]
								: []),
							`export type P${i} = ${paramsAssertion(`q${i}`, verdict.admitted.params)}`
						]
			return Arr.join(
				[
					`export const t${i} = ${signature} =>`,
					...directive,
					`\t${c.expression}`,
					...(verdict.kind === "refused" ? [] : [...termAssertion, query, ...compiled]),
					""
				],
				"\n"
			)
		}
	}
}

/** The program over the run's cases: one module, each case a block. */
export const computeModules = (
	entries: ComputeEntries,
	seed: number
): Arr.NonEmptyReadonlyArray<{ readonly file: string; readonly source: string }> => {
	const cases = computeCases(seed)
	const uses = new Set(Arr.flatMap(cases, (c) => [...c.uses]))
	const fieldTypes = Arr.filter(
		["Decimal", "Money", "Uuid", "CalendarDate", "Span", "Vector"] as const,
		(n) => uses.has(n)
	)
	return [
		{
			file: "index.ts",
			source: Arr.join(
				[
					"// Generated by test/support/agreement/compute.ts: the Compute type/engine agreement.",
					`import { Compute } from ${jsonText(entries.compute)}`,
					...(Arr.isReadonlyArrayNonEmpty(fieldTypes)
						? [
								`import { ${Arr.join(
									Arr.map(fieldTypes, (n) => (n === "Decimal" || n === "Money" ? n : `type ${n}`)),
									", "
								)} } from ${jsonText(entries.fields)}`
							]
						: []),
					`import { type HeadOf, type ParamsOf, type ParamType, query, type Rule, v } from ${jsonText(entries.query)}`,
					`import type { ${uses.has("Rostered") ? "Rostered, " : ""}SqlOfTerm, TypeOfTerm } from ${jsonText(entries.phantom)}`,
					...(uses.has("Infer") ? [`import type { Infer } from ${jsonText(entries.field)}`] : []),
					`import type { Aggregate } from ${jsonText(entries.terms)}`,
					`import { Cell, Cells } from ${jsonText(entries.agreement)}`,
					"",
					"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
					"type Expect<T extends true> = T",
					"type R = Rule<typeof Cells>",
					'const cellVars = () => v(Cell, "cell")',
					"type CellVars = ReturnType<typeof cellVars>",
					"export type AggregateHost<X> = X extends Aggregate<infer T> ? T : never",
					"",
					...Arr.map(cases, blockOf)
				],
				"\n"
			)
		}
	]
}
