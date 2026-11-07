import { floorPopulation, type Reached } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample, type Source } from "@grizzle/testing/source"
import { keep, type Swarm, swarm, swarmChoice } from "@grizzle/testing/swarm"
import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Record as Rec, Result, String as Str } from "effect"
import { CompileError, type CompileReason } from "#compiler/core/errors.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { toCalendarDate } from "#compiler/ir/date.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { Compute } from "#compiler/public/compute.ts"
import { Bits, Decimal, Money, uuid } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { lexicalForm, str } from "#compiler/public/text.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { guarded, typedTermOf } from "#compiler/scalar/compute/term.ts"
import { meets } from "#compiler/scalar/compute/types.ts"
import { carrierSql } from "#compiler/scalar/registry.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import {
	AsTyped,
	Cell,
	Cells,
	Heads,
	Tone,
	Tuning
} from "#test/support/agreement/compute-schema.ts"
import { compileTemplate, testArtifacts, testCompile } from "#test/support/compile.ts"
import { messageOf } from "#test/support/message.ts"
import { preludeAt, type PreludeAt, preludeFrom, preludeProgram } from "#test/support/prelude.ts"

/**
 * The Compute population: terms, predicates, aggregates and host values drawn over one relation of every carrier
 * (Cell, ./compute-schema.ts), each read twice, as TypeScript source for one program the type tier checks and through
 * the engine's JavaScript view (computeCore, the query builder, compileTemplate), which builds and compiles it as the
 * runtime does. A byte guard's case and a closed read's case stand in a generated field of a schema of their own, a
 * closed read under arithmetic, Compute.within and a cast where it stands (a query's head delivers none).
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
	span: ["centsSpan", "intSpan", "daySpan", "divisorSpan"],
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
 * A string TypeScript types as string, never its literal: what a value computed at run time is, which the program
 * declares under this name, and whose value the engine reads.
 */
const widened: Lit = { text: "widened", value: "^[a-z]+$" }

/**
 * The JavaScript values a case draws, the values the catalogue's literal typing branches on: numbers whole and not,
 * zero and negative; bigints; exact decimal strings and other text, patterns well formed and not; a boolean; a uuid; a
 * Decimal, a Money, a set of Tone's handles, and a string TypeScript types as string (widened).
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
	{ text: "Money.of(5n)", value: Money.of(5n) },
	{ text: 'Bits.of(Tone, ["low"])', value: Bits.of(Tone, ["low"]) },
	widened
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
	"cardinality",
	"singleton"
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

/**
 * What stands opposite a first operand: its own field, a parameter of it, a JavaScript value, a typed literal of it,
 * another field, a computed term over it, or the base of a contract over its type.
 */
const otherKinds = [
	"same operand",
	"param operand",
	"literal operand",
	"typed operand",
	"other operand",
	"computed operand",
	"based operand"
] as const

/** What stands opposite a first operand at the depth where no computed term is drawn. */
const leafKinds = [
	"same operand",
	"param operand",
	"literal operand",
	"typed operand",
	"other operand",
	"based operand"
] as const

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
	"byte guard",
	"closed read",
	"lexical form",
	"foreign operand",
	...otherKinds
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
	"a term first: a literal takes its place opposite a term, never first":
		"refused: a literal first",
	"the span's own endpoint descriptor: a descriptor of another type is no endpoint of the span":
		"refused: an endpoint",
	"a value its contract refuses: it lacks a fact the contract declares":
		"refused: a contract's value",
	"operands of one type: an exact value beside a plain value of its family; Compute.cast the exact one into the plain one's type":
		"refused: an exact value beside a plain one"
} as const
type ComputeRefusal = keyof typeof refusalNotes
type RefusalNote = (typeof refusalNotes)[ComputeRefusal]
export const computeRefusals: Arr.NonEmptyReadonlyArray<RefusalNote> = [
	"refused: a divisor",
	"refused: a radicand",
	"refused: a finite value",
	"refused: a power",
	"refused: a cast",
	"refused: a literal first",
	"refused: an endpoint"
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

/**
 * A case that reads a column of Heads through a query's heading (a heading operand), whose facts are its column type's:
 * admitted where the type declares the fact an operation needs, refused where it is a plain integer's.
 */
const headingNote = "a column read through a heading"
type HeadingNote = typeof headingNote

/**
 * A CASE (Compute.when, Compute.cond) or a LEAST or GREATEST over an exact value and a plain value of its family, in
 * either order: they share no type, which both sides refuse, naming the cast that makes them one.
 */
const familyNotes = [
	"a CASE of an exact branch first beside a plain one",
	"a CASE of a plain branch first beside an exact one",
	"LEAST or GREATEST of an exact operand first beside a plain one",
	"LEAST or GREATEST of a plain operand first beside an exact one"
] as const

/**
 * A CASE whose other branch is a bigint literal beside an exact branch, which takes the exact branch's type: admitted
 * where its digits fit it, and the engine's alone where they do not, a literal's value the types cannot see.
 */
const exactLiteralNotes = [
	"a literal beside an exact branch, which fits it",
	"a literal beside an exact branch, wider than it"
] as const
type FamilyNote = (typeof familyNotes)[number] | (typeof exactLiteralNotes)[number]

/**
 * What a byte guard case reached, by the engine's verdict on its check: its cast admitted within the guard's high bound,
 * the guard reaching past the target's bytes, and the cast with no guard, each of the last two a decided language,
 * which the types admit since a byte bound is no type.
 */
const byteNotes = [
	"a cast within its byte guard",
	"a byte guard past its target",
	"a byte cast unguarded"
] as const
type ByteNote = (typeof byteNotes)[number]

/** What a byte guard case reached (byteNotes): none for any other case. */
const byteNotesOf = (spec: CaseSpec, verdict: Verdict): ReadonlyArray<ByteNote> => {
	if (spec.kind !== "bytes") {
		return []
	}
	const language = verdict.kind === "decided" && verdict.note === engineDecides.language
	return spec.guard.kind === "within"
		? verdict.kind === "admitted"
			? ["a cast within its byte guard"]
			: language
				? ["a byte guard past its target"]
				: []
		: language
			? ["a byte cast unguarded"]
			: []
}

/**
 * What a case over a constant of a contract reached where its contract refuses the value (ContractLiteral): a radicand,
 * a power's operand and a dividend, which the types read as values its contract judges, so the case's claim is that
 * refusal alone.
 */
const contractNotes = [
	"a radicand its contract refuses",
	"a power's operand its contract refuses",
	"a dividend its contract refuses"
] as const
type ContractNote = (typeof contractNotes)[number]

/** What a square root, a power or a quotient over a constant of a contract reached (contractNotes): none for others. */
const contractNotesOf = (spec: CaseSpec, verdict: Verdict): ReadonlyArray<ContractNote> => {
	if (
		spec.kind !== "term" ||
		spec.term.kind !== "apply" ||
		!byContract(verdict) ||
		!Arr.some(spec.term.args, (o) => o.kind === "typed" && contractTyped.has(o.field))
	) {
		return []
	}
	const note = contractNoteOf[spec.term.fn]
	return note === undefined ? [] : [note]
}

/**
 * Whether the engine refuses a case for a contract's predicate (ContractLiteral), as its verdict reads: the types
 * decide it, both sides refuse it for different reasons (contested), or the types admit it, a literal's value.
 */
const byContract = (verdict: Verdict): boolean => {
	switch (verdict.kind) {
		case "admitted":
			return false
		case "decided":
			return verdict.note === engineDecides.literal
		case "refused":
			return verdict.claim.kind === "refusal" && verdict.claim.refusal === contractRefusal
		case "contested":
			return true
	}
}

/** The note of each partial operation over a constant its contract refuses that a case reaches (contractNotes). */
const contractNoteOf: { readonly [F in Fn]?: ContractNote } = {
	sqrt: "a radicand its contract refuses",
	power: "a power's operand its contract refuses",
	quot: "a dividend its contract refuses"
}

/** The exact carriers' SQL types and the plain SQL types of their families. */
const exactSql: ReadonlyArray<string> = ["exact integer", "exact money"]
const familySql: Readonly<Record<string, string>> = {
	smallint: "exact integer",
	integer: "exact integer",
	bigint: "exact integer",
	"exact integer": "exact integer",
	money: "exact money",
	"exact money": "exact money"
}

/**
 * What a CASE or a LEAST or GREATEST at a case's root reached (familyNotes): its first operand and another of its
 * family, the one exact and the other plain, built as the engine builds each, or an exact branch beside a bigint literal
 * (exactLiteralNotes), by its verdict; none for any other case, or where a build refuses.
 */
const familyNotesOf = (spec: CaseSpec, verdict: Verdict): ReadonlyArray<FamilyNote> => {
	if (spec.kind !== "term") {
		return []
	}
	const t = spec.term
	const sqls: Array<string> = []
	const built = Result.try(() =>
		queryOver(Cells).rule((r: RuleValue) => {
			const cell = varsOver(Cell, "cell")
			const head = varsOver(Heads, "head")
			const building = new Building(r, written, cell, head, undefined)
			const operands: ReadonlyArray<unknown> =
				t.kind === "when"
					? [
							new Building(r, written, cell, head, guardSubject(building.guard(t.guard))).term(
								t.body
							),
							building.operand(t.otherwise)
						]
					: t.kind === "cond"
						? [building.operand(t.whenTrue), building.operand(t.otherwise)]
						: t.kind === "apply" && (t.fn === "least" || t.fn === "greatest")
							? Arr.map(t.args, (o) => building.operand(o))
							: []
			for (const operand of operands) {
				sqls.push(typedTermOf(operand)?.carrier.sql ?? "a value")
			}
			return r.match(Cell, { id: cell["id"] }).find({ id: cell["id"] })
		})
	)
	const [first, ...rest] = sqls
	if (Result.isFailure(built) || first === undefined) {
		return []
	}
	if (
		Arr.contains(exactSql, first) &&
		(t.kind === "when" || t.kind === "cond") &&
		t.otherwise.kind === "literal" &&
		typeof t.otherwise.lit.value === "bigint"
	) {
		return verdict.kind === "admitted"
			? ["a literal beside an exact branch, which fits it"]
			: verdict.kind === "decided" && verdict.note === engineDecides.literal
				? ["a literal beside an exact branch, wider than it"]
				: []
	}
	const family = familySql[first]
	const mixed = Arr.some(
		rest,
		(q) => q !== first && family !== undefined && familySql[q] === family
	)
	if (!mixed) {
		return []
	}
	const exactFirst = Arr.contains(exactSql, first)
	return t.kind === "when" || t.kind === "cond"
		? [
				exactFirst
					? "a CASE of an exact branch first beside a plain one"
					: "a CASE of a plain branch first beside an exact one"
			]
		: [
				exactFirst
					? "LEAST or GREATEST of an exact operand first beside a plain one"
					: "LEAST or GREATEST of a plain operand first beside an exact one"
			]
}

/** What a case reached: its constructs, the engine's verdict, the Refusal it names and what its types infer. */
export type ComputeNote =
	| ComputeFeature
	| HeadingNote
	| ByteNote
	| ContractNote
	| ContestedNote
	| FamilyNote
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
	| { readonly kind: "lexical"; readonly field: FieldName }
	| { readonly kind: "term"; readonly term: TermSpec }
	| { readonly kind: "heading"; readonly column: HeadColumn }

/**
 * A column of Heads (./compute-schema.ts), Cell's divisor read back through a query's heading, by the kind of head term
 * that delivers it, and the field of Cell of its column's type, which a division by it divides.
 */
const headColumns = [
	"divisor",
	"base",
	"cast",
	"cond",
	"least",
	"greatest",
	"min",
	"max",
	"sum"
] as const
type HeadColumn = (typeof headColumns)[number]
const headFields: { readonly [C in HeadColumn]: FieldName } = {
	divisor: "divisor",
	base: "int",
	cast: "int",
	cond: "divisor",
	least: "divisor",
	greatest: "divisor",
	min: "divisor",
	max: "divisor",
	sum: "big"
}

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
	| { readonly kind: "lexical"; readonly field: FieldName }
	| {
			readonly kind: "bytes"
			readonly text: TextField
			readonly target: number
			readonly guard: ByteGuard
	  }
	| {
			readonly kind: "closed"
			readonly value: TunedValue
			readonly to: TunedTarget
			readonly guard: TunedGuard
	  }

/** A text field of Cell a byte guard's case reads. */
type TextField = (typeof families.text)[number]

/**
 * The fields of Cell Tuning (./compute-schema.ts) holds a payload of at each tone, of one type each: its integers, its
 * numeric and the contracts over an integer, one that declares nonnegative and one nonzero, each of a predicate that is
 * its declared fact alone, so a guard's bound one refuses lacks a fact the types read (contractRefusal).
 */
const tunedFields = ["small", "int", "big", "dec", "cents", "divisor"] as const
type TunedField = (typeof tunedFields)[number]

/** The fields a closed read's case casts into: the integers, which narrow, and the numeric, which bounds digits. */
const tunedTargets = ["small", "int", "big", "dec"] as const
type TunedTarget = (typeof tunedTargets)[number]

/** An operand of a closed read's case: a field of the row, or Tuning's payload of that field at the row's tone. */
interface TunedOperand {
	readonly read: "field" | "closed"
	readonly field: TunedField
}

/**
 * The value a closed read's case casts, which reads Tuning once at least: an operand, its negation or magnitude, or
 * two operands' sum, difference, product or quotient.
 */
type TunedValue =
	| { readonly kind: "operand"; readonly x: TunedOperand }
	| { readonly kind: "unary"; readonly fn: "neg" | "abs"; readonly x: TunedOperand }
	| {
			readonly kind: "binary"
			readonly fn: "add" | "sub" | "mul" | "div"
			readonly a: TunedOperand
			readonly b: TunedOperand
	  }

/**
 * What stands around a closed read's cast: Compute.within over its value, whose branch casts the guarded value, or
 * nothing.
 */
type TunedGuard =
	| { readonly kind: "within"; readonly low: bigint; readonly high: bigint }
	| { readonly kind: "none" }

/**
 * What stands around a byte guard case's cast into a str.bytes target: the one byte guard,
 * Compute.within(Compute.octetLength(x), low, high), whose branch carries x's byte bound narrowed to high, or nothing.
 */
type ByteGuard =
	| { readonly kind: "within"; readonly low: number; readonly high: number }
	| { readonly kind: "none" }

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
	singleton: ["code", "set"],
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

/** The families an aggregate's operand is drawn from: the numeric family's, money's, and an ordered and unordered other. */
const aggregateHomes: Arr.NonEmptyReadonlyArray<Family> = [
	...numericHomes,
	"text",
	"date",
	"boolean",
	"vector"
]

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

/**
 * A field of one of `homes`, its first, the family the operation is defined over, half the time; and, where the swarm
 * keeps foreign operands, of any family a quarter of the time.
 */
const homeField = (d: Drawing, home: Arr.NonEmptyReadonlyArray<Family>): FieldName =>
	d.keep("foreign operand") && d.from([0, 1, 2, 3]) === 0
		? d.from(allFields)
		: d.from(families[d.from([0, 1]) === 0 ? home[0] : d.from(home)])

/** The field an operand reads, where it reads one directly. */
const fieldOf = (o: Operand): FieldName | undefined =>
	o.kind === "field" || o.kind === "param" || o.kind === "typed" ? o.field : undefined

/**
 * The JavaScript values of the dictionary a field's language holds, as their host types read them: numbers for the
 * number fields, bigints for the bigint fields, a decimal's for numeric, Money for money, strings for a text, a uuid, a
 * date or a closed id, a boolean for a flag, a set for a set; the dictionary itself for a span or a vector, which none
 * of it is.
 */
const languageLits = (field: FieldName): Arr.NonEmptyReadonlyArray<Lit> => {
	const host = (l: Lit): string =>
		l.value instanceof Decimal
			? "decimal"
			: l.value instanceof Money
				? "money"
				: l.value instanceof Set
					? "set"
					: typeof l.value
	const of = (kinds: ReadonlyArray<string>): Arr.NonEmptyReadonlyArray<Lit> => {
		const held = Arr.filter(lits, (l) => Arr.contains(kinds, host(l)))
		return Arr.isReadonlyArrayNonEmpty(held) ? held : lits
	}
	switch (Cell.fields[field].sql) {
		case "smallint":
		case "integer":
		case "real":
		case "double precision":
			return of(["number"])
		case "bigint":
			return of(["bigint"])
		case "numeric":
			return of(["bigint", "string", "decimal"])
		case "money":
			return of(["money", "bigint"])
		case "text":
		case "uuid":
		case "date":
		case "code":
			return of(["string"])
		case "boolean":
			return of(["boolean"])
		case "bits":
			return of(["set"])
		case "range":
		case "vector":
			return lits
	}
}

/** A JavaScript value opposite a field: of the field's language half the time, and any of the dictionary otherwise. */
const litOf = (d: Drawing, field: FieldName): Lit =>
	d.from([0, 1]) === 0 ? d.from(languageLits(field)) : d.from(lits)

/**
 * A first operand: a field, a parameter of one, a typed constant of one, a computed term, or, where the swarm keeps it,
 * a literal.
 */
const firstOperand = (
	d: Drawing,
	home: Arr.NonEmptyReadonlyArray<Family>,
	depth: number
): Operand => {
	if (depth > 0 && d.keep("literal first") && d.from([0, 1, 2, 3]) === 0) {
		return { kind: "literal", lit: d.from(lits) }
	}
	switch (d.from(["field", "field", "field", "param", "typed", "computed"] as const)) {
		case "field":
			return { kind: "field", field: homeField(d, home) }
		case "param":
			return d.param(homeField(d, home))
		case "typed": {
			const field = homeField(d, home)
			d.note("typed operand")
			return { kind: "typed", field, lit: litOf(d, field) }
		}
		case "computed":
			return depth > 0 && d.keep("computed operand")
				? { kind: "term", term: applyOver(d, d.from(unaryAndBinary), depth - 1) }
				: { kind: "field", field: homeField(d, home) }
	}
}

/**
 * The partial operations, whose precondition compilation judges: one stands at a case's root or as a when's branch,
 * never inside another call, where the engine refuses the enclosing call's operand types before it judges the
 * precondition and the types, which judge each call, would name the precondition too.
 */
const partialFns = ["div", "mod", "quot", "rem", "sqrt", "power", "minScale"] as const

/** The operations of one or two operands a computed operand applies: every one but a partial operation (partialFns). */
const unaryAndBinary: Arr.NonEmptyReadonlyArray<
	Exclude<UnaryFn | BinaryFn, (typeof partialFns)[number]>
> = [
	"neg",
	"abs",
	"sign",
	"ceil",
	"floor",
	"round",
	"trunc",
	"numeric",
	"base",
	"charLength",
	"octetLength",
	"lowerAscii",
	"replaceWhitespace",
	"collapse",
	"cardinality",
	"singleton",
	"add",
	"sub",
	"mul",
	"gcd",
	"lcm",
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
]

/**
 * The fields of a field's family (families), itself among them: the fields nearest it, of one family and mostly of
 * another type, where an operation over both is refused, and itself, where it is admitted.
 */
const kinOf = (field: FieldName): Arr.NonEmptyReadonlyArray<FieldName> =>
	Arr.dedupe(
		Arr.prepend(
			Arr.flatMap(Rec.values(families), (fields): ReadonlyArray<FieldName> =>
				Arr.contains<FieldName>(fields, field) ? fields : []
			),
			field
		)
	)

/**
 * An operand opposite `first`: the same field, a parameter of it, a JavaScript value, a typed literal of it, another
 * field, of its family half the time (kinOf), so both verdicts are common, a computed term over it, or the base of a
 * contract over its type, which keeps the facts the contract declares.
 */
const otherOperand = (d: Drawing, first: Operand, depth: number): Operand => {
	const field = fieldOf(first) ?? d.from(allFields)
	switch (d.choose(depth > 0 ? otherKinds : leafKinds)) {
		case "same operand":
			return { kind: "field", field }
		case "param operand":
			return d.param(field)
		case "literal operand":
			return { kind: "literal", lit: litOf(d, field) }
		case "typed operand":
			return { kind: "typed", field, lit: litOf(d, field) }
		case "other operand":
			return { kind: "field", field: d.from(d.from([0, 1]) === 0 ? kinOf(field) : allFields) }
		case "computed operand":
			return { kind: "term", term: computedOver(d, field) }
		case "based operand": {
			d.note("base")
			const contracts = contractsOver[field]
			return {
				kind: "term",
				term: {
					kind: "apply",
					fn: "base",
					args: [{ kind: "field", field: contracts === undefined ? field : d.from(contracts) }]
				}
			}
		}
	}
}

/**
 * The contract fields of Cell over each field's type, whose base meets the field: a contract's base opposite its base's
 * values.
 */
const contractsOver: { readonly [F in FieldName]?: Arr.NonEmptyReadonlyArray<FieldName> } = {
	int: ["divisor"],
	big: ["cents", "epoch"],
	dec: ["rate"],
	text: ["body"]
}

/**
 * A computed operand over a field: an operation of one or two operands with the field first, the second drawn opposite
 * it, as every operation is called with its own arity.
 */
const computedOver = (d: Drawing, field: FieldName): TermSpec => {
	const fn = d.from(unaryAndBinary)
	d.note(fn)
	const first: Operand = { kind: "field", field }
	return Arr.contains(unaryFns, fn)
		? { kind: "apply", fn, args: [first, ...scaleOf(d, fn)] }
		: { kind: "apply", fn, args: [first, otherOperand(d, first, 0)] }
}

/** A round's or a trunc's scale, half the time, a JavaScript value; no other operation takes one. */
const scaleOf = (d: Drawing, fn: Fn): ReadonlyArray<Operand> =>
	(fn === "round" || fn === "trunc") && d.from([0, 1]) === 1
		? [{ kind: "literal", lit: d.from(lits) }]
		: []

/**
 * The strings a translate's map is drawn from, the values its checks branch on: one length or another, every character
 * once or one repeated.
 */
const maps: Arr.NonEmptyReadonlyArray<Lit> = [
	{ text: '"a"', value: "a" },
	{ text: '"x"', value: "x" },
	{ text: '"ab"', value: "ab" },
	{ text: '"ba"', value: "ba" },
	{ text: '"aa"', value: "aa" },
	{ text: '"abc"', value: "abc" }
]

/** translate's to opposite its from: a map string of the from's length half the time, and any side otherwise. */
const mapOpposite = (d: Drawing, from: Operand): Operand => {
	const sameLength =
		from.kind === "literal" && typeof from.lit.value === "string"
			? Arr.filter(
					maps,
					(m) => typeof m.value === "string" && m.value.length === String(from.lit.value).length
				)
			: []
	return Arr.isReadonlyArrayNonEmpty(sameLength) && d.from([0, 1]) === 0
		? { kind: "literal", lit: d.from(sameLength) }
		: mapOperand(d)
}

/** One side of translate's map: a map string half the time, and any value of the dictionary otherwise. */
const mapOperand = (d: Drawing): Operand => ({
	kind: "literal",
	lit: d.from([0, 1]) === 0 ? d.from(maps) : d.from(lits)
})

/**
 * A conditional aimed at admission: a comparison of its first branch's own field with itself as its test, and that
 * field as its other branch, so the conditional's own typing is what the case checks.
 */
const alignedCond = (whenTrue: Operand): TermSpec => {
	const field: FieldName = fieldOf(whenTrue) ?? "int"
	const own: Operand = { kind: "field", field }
	return {
		kind: "cond",
		p: { kind: "compare", op: "eq", a: own, b: own },
		whenTrue,
		otherwise: own
	}
}

/**
 * An operation's operands aimed at its precondition or at the type its result infers, half the time: an integer, or the
 * contract itself, divided by the base or the value of a contract that declares nonzero; a numeric divided by a typed
 * constant of it; a double precision constant, whose value proves its facts, or a Rate constant, whose value its
 * contract judges first, raised to a power or a Rate constant's square root, of a value in Rate or out of it; money
 * minus money, an exact money; LEAST and GREATEST of an exact integer and an integer, in either order.
 */
const aimedOperands: {
	readonly [F in Fn]?: (d: Drawing) => Arr.NonEmptyReadonlyArray<Operand>
} = {
	div: (d) => provedDivisor(d),
	mod: (d) => provedDivisor(d),
	quot: (d) => [
		{ kind: "field", field: "dec" },
		{ kind: "typed", field: "dec", lit: d.from(languageLits("dec")) }
	],
	rem: (d) => [
		{ kind: "field", field: "dec" },
		{ kind: "typed", field: "dec", lit: d.from(languageLits("dec")) }
	],
	sub: (d) => [
		{ kind: "field", field: "money" },
		otherOperand(d, { kind: "field", field: "money" }, 0)
	],
	power: (d) => {
		const field = d.from(["dbl", "rate"] as const)
		return [
			{
				kind: "typed",
				field,
				lit: d.from(field === "rate" ? baseDecimals() : languageLits(field))
			},
			otherOperand(d, { kind: "field", field }, 0)
		]
	},
	sqrt: (d) => [{ kind: "typed", field: "rate", lit: d.from(baseDecimals()) }],
	least: (d) => exactBeside(d),
	greatest: (d) => exactBeside(d)
}

/** The exact integer of a smallint's or an integer's sum with itself: of 6 or 11 digits. */
const exactSum = (d: Drawing): Operand => {
	const plain: Operand = { kind: "field", field: d.from(["small", "int"] as const) }
	return { kind: "term", term: { kind: "apply", fn: "add", args: [plain, plain] } }
}

/**
 * The bigint literals a CASE draws beside an exact integer branch (exactSum): one every exact integer holds, and one of
 * 16 digits, within a bigint and wider than the branch.
 */
const exactLiterals: Arr.NonEmptyReadonlyArray<Lit> = [
	{ text: "1n", value: 1n },
	{ text: "1000000000000000n", value: 10n ** 15n }
]

/**
 * An integer field and the exact integer of its sum with itself, in either order: an exact value beside a plain value
 * of its family, which share no type (familyNotes).
 */
const exactBeside = (d: Drawing): readonly [Operand, Operand] => {
	const plain: Operand = { kind: "field", field: d.from(["small", "int", "big"] as const) }
	const exact: Operand = { kind: "term", term: { kind: "apply", fn: "add", args: [plain, plain] } }
	return d.from([0, 1]) === 0 ? [exact, plain] : [plain, exact]
}

/**
 * The values of the dictionary that spell a decimal, a numeric's base reads each: those a contract over it judges, in
 * the contract and out of it.
 */
const baseDecimals = (): Arr.NonEmptyReadonlyArray<Lit> => {
	const held = Arr.filter(
		lits,
		(l) =>
			typeof l.value === "bigint" ||
			l.value instanceof Decimal ||
			(typeof l.value === "string" && decimalText.test(l.value))
	)
	if (!Arr.isReadonlyArrayNonEmpty(held)) {
		throw new Error("the dictionary holds no decimal")
	}
	return held
}

/**
 * Whether a field's refinements refuse a value of its base as a constant, in a world (World), as compilation judges it
 * (ContractLiteral): a contract's predicate, or a text's regex refinement.
 */
const literalRefused = (world: World, field: FieldName, value: unknown): boolean => {
	const built = Result.try(() =>
		queryOver(world.Cells).rule((r: RuleValue) => {
			const cell = varsOver(world.Cell, "cell")
			return r
				.match(world.Cell, { id: cell["id"] })
				.find({ out: computeCore.literal(world.Cell.fields[field], value) })
		})
	)
	if (Result.isFailure(built)) {
		return false
	}
	const compiled = compileTemplate(built.success, undefined, testCompile)
	return (
		!compiled.ok &&
		compiled.error instanceof CompileError &&
		compiled.error.reason._tag === "ContractLiteral"
	)
}

/**
 * An integer, or the contract itself, divided by the base or the value of a contract that declares nonzero, or a field
 * of a column's type divided by that column of Heads read back through a query's heading, whose facts are its type's.
 */
const provedDivisor = (d: Drawing): Arr.NonEmptyReadonlyArray<Operand> => {
	switch (d.from([0, 1, 2])) {
		case 0:
			return [
				{ kind: "field", field: "int" },
				{
					kind: "term",
					term: { kind: "apply", fn: "base", args: [{ kind: "field", field: "divisor" }] }
				}
			]
		case 1:
			return [
				{ kind: "field", field: "divisor" },
				{ kind: "field", field: "divisor" }
			]
		default: {
			const column = d.from(headColumns)
			return [
				{ kind: "field", field: headFields[column] },
				{ kind: "heading", column }
			]
		}
	}
}

/**
 * A numeric operand proved finite: a typed constant of a numeric field, or the numeric of an integer, whose value is
 * finite by its type.
 */
const finiteOperand = (d: Drawing): Operand =>
	d.from([0, 1]) === 0
		? { kind: "typed", field: "dec", lit: d.from(languageLits("dec")) }
		: {
				kind: "term",
				term: {
					kind: "apply",
					fn: "numeric",
					args: [{ kind: "field", field: d.from(families.integer) }]
				}
			}

/** An application of `fn` to operands drawn for it. */
const applyOver = (d: Drawing, fn: Fn, depth: number): TermSpec => {
	d.note(fn)
	const aim = aimedOperands[fn]
	if (aim !== undefined && d.from([0, 1]) === 0) {
		return { kind: "apply", fn, args: aim(d) }
	}
	const first = firstOperand(d, homes[fn], depth)
	if (Arr.contains(unaryFns, fn)) {
		return { kind: "apply", fn, args: [first, ...scaleOf(d, fn)] }
	}
	if (fn === "translate") {
		const from = mapOperand(d)
		return { kind: "apply", fn, args: [first, from, mapOpposite(d, from)] }
	}
	if (fn === "widthBucket") {
		return {
			kind: "apply",
			fn,
			args:
				d.from([0, 1]) === 0
					? [finiteOperand(d), finiteOperand(d), finiteOperand(d), d.param("int")]
					: [first, otherOperand(d, first, 0), otherOperand(d, first, 0), d.param("int")]
		}
	}
	return {
		kind: "apply",
		fn,
		args: [
			first,
			first.kind === "literal"
				? { kind: "field", field: homeField(d, homes[fn]) }
				: otherOperand(d, first, depth)
		]
	}
}

/**
 * A guard of one kind over a subject drawn from `subjects`, or a text's match; a parameter a third of the time where
 * `parameters` says, as a when's subject is.
 */
const guardOf = (
	d: Drawing,
	kind: Test | "within" | "matches",
	subjects: Arr.NonEmptyReadonlyArray<Family>,
	parameters: boolean
): GuardSpec => {
	const subject = (home: Arr.NonEmptyReadonlyArray<Family>): Operand =>
		parameters && d.from([0, 1, 2]) === 0 ? d.param(homeField(d, home)) : firstOperand(d, home, 0)
	switch (kind) {
		case "within": {
			const x = subject(subjects)
			const field = fieldOf(x) ?? d.from(allFields)
			const bound = (): Lit =>
				d.from([0, 1, 2, 3]) < 3 ? d.from(languageLits(field)) : d.from(lits)
			return { kind: "within", x, low: bound(), high: bound() }
		}
		case "matches": {
			const x = subject(["text"])
			return {
				kind: "matches",
				x,
				pattern:
					d.from([0, 1, 2]) === 0
						? { kind: "lexical", field: d.from(lexicalFields) }
						: otherOperand(d, x, 0)
			}
		}
		case "nonzero":
		case "nonnegative":
		case "positive":
		case "isFinite":
			return { kind: "test", test: kind, x: subject(subjects) }
	}
}

const guardKinds = [...tests, "within", "matches"] as const
type GuardKind = (typeof guardKinds)[number]

/**
 * The operations a when's branch applies to the guarded subject: a partial operation of it (a division by it, its
 * remainder, square root, power, least scale or cast), a concatenation, or another operation with it first; or a
 * partial operation aside from it, a branch that never reads its subject, whose precondition its guard proves nothing
 * of.
 */
const branches = [
	"div",
	"mod",
	"sqrt",
	"power",
	"minScale",
	"cast",
	"parse",
	"concat",
	"other",
	"aside"
] as const
type Branch = (typeof branches)[number]

/**
 * The guard a branch's partial operation needs: nonzero for a divisor, nonnegative for a radicand, positive or a range
 * for a power's base, finite or a range for a least scale or a narrowing, and a match for a text.
 */
const neededGuards: { readonly [B in Branch]: Arr.NonEmptyReadonlyArray<GuardKind> } = {
	div: ["nonzero"],
	mod: ["nonzero"],
	sqrt: ["nonnegative"],
	power: ["positive", "within"],
	minScale: ["isFinite", "within"],
	cast: ["isFinite", "within"],
	parse: ["matches"],
	concat: ["matches"],
	other: guardKinds,
	aside: guardKinds
}

/** The families a branch's subject is drawn from: those its operation is defined over. */
const branchHomes: { readonly [B in Branch]: Arr.NonEmptyReadonlyArray<Family> } = {
	div: homes.div,
	mod: homes.mod,
	sqrt: homes.sqrt,
	power: homes.power,
	minScale: homes.minScale,
	cast: numericHomes,
	parse: ["text"],
	concat: ["text"],
	other: numericHomes,
	aside: numericHomes
}

/**
 * A when's branch over the guarded subject: the branch's operation, whose other operand is drawn opposite the subject,
 * a divisor's dividend its own field three times in four, so the operation meets the subject, and a cast's target
 * related to it half the time.
 */
const guardedBody = (d: Drawing, guard: GuardSpec, branch: Branch): TermSpec => {
	const subject = guard.x
	const guarded: Operand = { kind: "guarded" }
	const own = fieldOf(subject)
	const field = own ?? d.from(allFields)
	const opposite = (fn: Fn): FieldName =>
		own !== undefined && d.from([0, 1, 2, 3]) < 3 ? own : homeField(d, homes[fn])
	switch (branch) {
		case "div":
		case "mod":
			d.note(branch)
			return {
				kind: "apply",
				fn: branch,
				args: [{ kind: "field", field: opposite(branch) }, guarded]
			}
		case "sqrt":
			d.note("sqrt")
			return { kind: "apply", fn: "sqrt", args: [guarded] }
		case "power":
			d.note("power")
			return { kind: "apply", fn: "power", args: [guarded, otherOperand(d, subject, 0)] }
		case "minScale":
			d.note("minScale")
			return { kind: "apply", fn: "minScale", args: [guarded] }
		case "cast":
			d.note("cast")
			return { kind: "cast", x: guarded, to: castTarget(d, field) }
		case "parse":
			d.note("cast")
			return { kind: "cast", x: guarded, to: parseTarget(d, guard) }
		case "concat":
			d.note("concat")
			return { kind: "apply", fn: "concat", args: [guarded, otherOperand(d, subject, 0)] }
		case "other": {
			const fn = d.from(binaryFns)
			d.note(fn)
			return { kind: "apply", fn, args: [guarded, otherOperand(d, { kind: "field", field }, 0)] }
		}
		case "aside":
			return applyOver(d, d.from(asideFns), 0)
	}
}

/** Whether a when's branch reads its guarded subject: an operand of it, at any depth but a nested when's own branch. */
const readsSubject = (t: TermSpec): boolean => {
	const reads = (o: Operand): boolean =>
		o.kind === "guarded" || (o.kind === "term" && readsSubject(o.term))
	const guardReads = (g: GuardSpec): boolean =>
		reads(g.x) || (g.kind === "matches" && reads(g.pattern))
	switch (t.kind) {
		case "apply":
			return Arr.some(t.args, reads)
		case "cast":
			return reads(t.x)
		case "endpoint":
			return reads(t.s)
		case "cond":
			return predReads(t.p, reads, guardReads) || reads(t.whenTrue) || reads(t.otherwise)
		case "when":
			return guardReads(t.guard) || reads(t.otherwise)
	}
}

/** Whether a predicate reads an operand `reads` holds, a guard's through `guardReads`. */
const predReads = (
	p: PredSpec,
	reads: (o: Operand) => boolean,
	guardReads: (g: GuardSpec) => boolean
): boolean => {
	switch (p.kind) {
		case "compare":
			return reads(p.a) || reads(p.b)
		case "between":
			return reads(p.a) || reads(p.low) || reads(p.high)
		case "in":
			return reads(p.a)
		case "guard":
			return guardReads(p.guard)
	}
}

/** The partial operations a branch aside from its subject applies. */
const asideFns = ["div", "mod", "quot", "rem", "sqrt", "power"] as const

/**
 * An operand of the type a branch over `subject` returns, which its otherwise branch is, half the time, or is drawn
 * opposite: a cast's target, an integer for a least scale, and otherwise the branch's first operand, the subject where
 * it stands first, beside which a quotient's exact integer shares no type (familyNotes).
 */
const branchOperand = (body: TermSpec, subject: Operand): Operand => {
	switch (body.kind) {
		case "cast":
			return { kind: "field", field: body.to }
		case "apply": {
			if (body.fn === "minScale") {
				return { kind: "field", field: "int" }
			}
			const [first] = body.args
			return first.kind === "guarded" ? subject : first
		}
		case "endpoint":
		case "cond":
		case "when":
			return { kind: "field", field: "int" }
	}
}

/** A parse's guard: a match, half the time against the lexical form of a type a text parses into. */
const lexicalGuard = (d: Drawing, guard: GuardSpec, branch: Branch): GuardSpec =>
	branch === "parse" && guard.kind === "matches" && d.from([0, 1]) === 0
		? { kind: "matches", x: guard.x, pattern: { kind: "lexical", field: d.from(lexicalFields) } }
		: guard

/** A parse's target: the type whose lexical form its guard matched, or a type a text parses into or does not. */
const parseTarget = (d: Drawing, guard: GuardSpec): FieldName =>
	guard.kind === "matches" && guard.pattern.kind === "lexical"
		? guard.pattern.field
		: d.from(parseTargets)

/** The fields of the types a text parses into, and a type with no lexical form. */
/**
 * The fields of a type with a lexical form, whose lexicalForm a match's pattern reads: a lexical form of any other type
 * is refused where it is written (a lexical form case), never inside a guard, whose refusal no Compute call's result
 * carries on.
 */
const lexicalFields: Arr.NonEmptyReadonlyArray<FieldName> = [
	"small",
	"int",
	"big",
	"dec",
	"dbl",
	"flag",
	"day"
]

const parseTargets: Arr.NonEmptyReadonlyArray<FieldName> = [
	"small",
	"int",
	"big",
	"dec",
	"dbl",
	"flag",
	"day",
	"id"
]

/** A list of one value, or of it twice, so a list is refused for one reason at most. */
const inValues = (lit: Lit, count: number): Arr.NonEmptyReadonlyArray<Lit> =>
	count === 1 ? [lit] : [lit, lit]

const predKinds = [...compares, "between", "in", ...guardKinds] as const
type PredKind = (typeof predKinds)[number]

/** A predicate of one kind: a comparison, a range, a list, or a guard used as one. */
const predOf = (d: Drawing, kind: PredKind): PredSpec => {
	switch (kind) {
		case "between": {
			const a = firstOperand(d, homes.least, 1)
			return { kind: "between", a, low: otherOperand(d, a, 0), high: otherOperand(d, a, 0) }
		}
		case "in": {
			const a = firstOperand(d, homes.least, 1)
			return {
				kind: "in",
				a,
				values: inValues(litOf(d, fieldOf(a) ?? d.from(allFields)), d.from([1, 2]))
			}
		}
		case "nonzero":
		case "nonnegative":
		case "positive":
		case "isFinite":
		case "within":
		case "matches":
			return { kind: "guard", guard: guardOf(d, kind, numericHomes, false) }
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

/**
 * The fields a cast over a field's values converts into where PostgreSQL may have the cast: the numeric family's
 * among themselves, money and the contracts over them; a text's into the types with a lexical form and its contract;
 * and any other into the field itself.
 */
const castTargets = (field: FieldName): Arr.NonEmptyReadonlyArray<FieldName> =>
	Arr.contains(families.text, field)
		? ["small", "int", "big", "dec", "dbl", "flag", "day", "body", "money", "id"]
		: Arr.contains(
					[...families.integer, ...families.numeric, ...families.float, ...families.money],
					field
			  )
			? [...families.integer, ...families.numeric, ...families.float, ...families.money]
			: [field]

/** A cast's target: a field related to the operand's half the time, and any field otherwise. */
const castTarget = (d: Drawing, field: FieldName): FieldName =>
	d.from([0, 1]) === 0 ? d.from(castTargets(field)) : d.from(allFields)

/**
 * The endpoint field of a span field an operand reads: Cents for centsSpan, an integer for intSpan, a date for daySpan,
 * Divisor, which declares nonzero, for divisorSpan.
 */
const endpointOf = (s: Operand): Option.Option<FieldName> => {
	const field = fieldOf(s)
	return field === "centsSpan"
		? Option.some("cents")
		: field === "intSpan"
			? Option.some("int")
			: field === "daySpan"
				? Option.some("day")
				: field === "divisorSpan"
					? Option.some("divisor")
					: Option.none()
}

/**
 * A cast under its aim: a narrowing into an integer, a value into a contract over its base, a text parsed into a type
 * with a lexical form, or an operand of the families casts read into a target related to it.
 */
const castOf = (d: Drawing, aim: CastAim): TermSpec => {
	switch (aim) {
		case "narrowing":
			return {
				kind: "cast",
				x: firstOperand(d, ["integer", "integer", "numeric", "float"], 1),
				to: d.from(["small", "int", "big"] as const)
			}
		case "contract": {
			const base = d.from(["int", "big", "dec", "text"] as const)
			const contracts = contractsOver[base]
			return {
				kind: "cast",
				x: d.from([0, 1, 2]) === 0 ? d.param(base) : { kind: "field", field: base },
				to: contracts === undefined ? base : d.from(contracts)
			}
		}
		case "parse":
			return {
				kind: "cast",
				x: firstOperand(d, ["text"], 1),
				to: d.from(["small", "int", "big", "dec", "dbl", "flag", "day"] as const)
			}
		case "related": {
			const x = firstOperand(d, castHomes, 1)
			return { kind: "cast", x, to: castTarget(d, fieldOf(x) ?? d.from(allFields)) }
		}
	}
}

/** The families a cast's operand is drawn from: the numeric family's, money's and a text's, which parses. */
const castHomes: Arr.NonEmptyReadonlyArray<Family> = [...numericHomes, "text"]

const termKinds = [
	...unaryFns,
	...binaryFns,
	...ternaryFns,
	"cast",
	"lower",
	"upper",
	"width",
	"cond",
	"when"
] as const
type TermKind = (typeof termKinds)[number]

/** What a cast aims at: a narrowing into an integer, a contract over its base, a parse, or a target related to it. */
const castAims = ["narrowing", "contract", "parse", "related"] as const
type CastAim = (typeof castAims)[number]

/**
 * A term's root: a cast under its aim, a when of one branch, a division by a column read through a heading (its facts
 * its column type's, so admitted or refused as the type declares nonzero), a partial operation over a constant its
 * contract refuses, a CASE of an exact branch beside a bigint literal, which fits it or not, or any other term
 * construct. Each aim and branch is a root of its own, so the floor draws each often enough to meet what it aims at.
 */
type TermRoot =
	| { readonly kind: "cast"; readonly aim: CastAim }
	| { readonly kind: "when"; readonly branch: Branch }
	| { readonly kind: "heading" }
	| { readonly kind: "contract" }
	| { readonly kind: "exact literal" }
	| { readonly kind: "term"; readonly root: Exclude<TermKind, "cast" | "when"> }

/** A term's root of a construct the swarm chose: a cast's aim and a when's branch drawn. */
const termRootOf = (d: Drawing, kind: TermKind): TermRoot =>
	kind === "cast"
		? { kind: "cast", aim: d.from(castAims) }
		: kind === "when"
			? { kind: "when", branch: d.from(branches) }
			: { kind: "term", root: kind }

/** Every term's root. */
const termRoots: Arr.NonEmptyReadonlyArray<TermRoot> = [
	...Arr.map(castAims, (aim): TermRoot => ({ kind: "cast", aim })),
	...Arr.map(branches, (branch): TermRoot => ({ kind: "when", branch })),
	{ kind: "heading" },
	{ kind: "contract" },
	{ kind: "exact literal" },
	...Arr.flatMap(termKinds, (root): ReadonlyArray<TermRoot> =>
		root === "cast" || root === "when" ? [] : [{ kind: "term", root }]
	)
]

/** The construct a term's root is, which its case reaches, and the name of its stratum. */
const termRootName = (root: TermRoot): { readonly feature: TermKind; readonly name: string } => {
	switch (root.kind) {
		case "cast":
			return { feature: "cast", name: `cast: ${root.aim}` }
		case "when":
			return { feature: "when", name: `when: ${root.branch}` }
		case "heading":
			return { feature: "div", name: headingNote }
		case "contract":
			return { feature: "sqrt", name: "a partial operation over a value its contract refuses" }
		case "exact literal":
			return { feature: "cond", name: "a literal beside an exact branch" }
		case "term":
			return { feature: root.root, name: root.root }
	}
}

/**
 * A term of one kind: an operation, a cast under its aim, a span's endpoint, a conditional or a guarded branch of one
 * kind, whose guard is the one the branch needs half the time.
 */
const termOf = (d: Drawing, root: TermRoot): TermSpec => {
	switch (root.kind) {
		case "cast":
			return castOf(d, root.aim)
		case "heading": {
			const fn = d.from(["div", "mod"] as const)
			const column = d.from(headColumns)
			d.note(fn)
			return {
				kind: "apply",
				fn,
				args: [
					{ kind: "field", field: headFields[column] },
					{ kind: "heading", column }
				]
			}
		}
		case "exact literal": {
			const exact = exactSum(d)
			const own: Operand = { kind: "field", field: "int" }
			return {
				kind: "cond",
				p: { kind: "compare", op: "eq", a: own, b: own },
				whenTrue: exact,
				otherwise: { kind: "literal", lit: d.from(exactLiterals) }
			}
		}
		case "contract": {
			const fn = d.from(["sqrt", "power", "quot"] as const)
			d.note(fn)
			const refused = Arr.filter(baseDecimals(), (l) => literalRefused(written, "rate", l.value))
			if (!Arr.isReadonlyArrayNonEmpty(refused)) {
				throw new Error("the dictionary holds no decimal Rate's contract refuses")
			}
			const value: Operand = { kind: "typed", field: "rate", lit: d.from(refused) }
			return {
				kind: "apply",
				fn,
				args:
					fn === "sqrt" ? [value] : [value, otherOperand(d, { kind: "field", field: "rate" }, 0)]
			}
		}
		case "when": {
			const guard = lexicalGuard(
				d,
				guardOf(
					d,
					d.choose(d.from([0, 1]) === 0 ? neededGuards[root.branch] : guardKinds),
					branchHomes[root.branch],
					true
				),
				root.branch
			)
			const body = guardedBody(d, guard, root.branch)
			const own = branchOperand(body, guard.x)
			return {
				kind: "when",
				guard,
				body,
				otherwise: d.from([0, 1]) === 0 ? own : otherOperand(d, own, 0)
			}
		}
		case "term": {
			const kind = root.root
			if (kind === "lower" || kind === "upper" || kind === "width") {
				const s = firstOperand(d, ["span"], 0)
				const own = endpointOf(s)
				return {
					kind: "endpoint",
					fn: kind,
					s,
					to:
						Option.isSome(own) && d.from([0, 1]) === 0
							? own.value
							: d.from([...families.span, ...families.integer, "day"])
				}
			}
			if (kind === "cond") {
				const whenTrue = firstOperand(d, homes.least, 1)
				switch (d.from([0, 1, 2])) {
					case 0:
						return alignedCond(whenTrue)
					case 1: {
						const [first, other] = exactBeside(d)
						return {
							kind: "cond",
							p: predOf(d, d.choose(predKinds)),
							whenTrue: first,
							otherwise: other
						}
					}
					default:
						return {
							kind: "cond",
							p: predOf(d, d.choose(predKinds)),
							whenTrue,
							otherwise: otherOperand(d, whenTrue, 1)
						}
				}
			}
			return applyOver(d, kind, 1)
		}
	}
}

/** The names a member case reads: the holder's own, and names a reader may reach for that it lacks (computeMembers). */
const memberNames: { readonly [H in Holder]: Arr.NonEmptyReadonlyArray<string> } = {
	Compute: ["scale", "trimScale", "displayScale"],
	Decimal: ["text", "parts", "isFinite", "equals", "scale", "identityText", "displayScale"],
	parts: ["kind", "coefficient", "minScale", "exponent"]
}

/** Compute's own members. */
const computeMembers: Arr.NonEmptyReadonlyArray<string> = ["literal", ...Rec.keys(Compute)]

const memberFeatures = ["Compute member", "Decimal member", "parts member"] as const
type MemberFeature = (typeof memberFeatures)[number]

const holderOf: { readonly [M in MemberFeature]: Holder } = {
	"Compute member": "Compute",
	"Decimal member": "Decimal",
	"parts member": "parts"
}

/**
 * A construct a case is rooted at: an operation, a cast, an endpoint, a conditional or a guarded branch; a guard,
 * comparison, range or list; an aggregate; a host value; or a member read.
 */
type Root =
	| { readonly kind: "term"; readonly root: TermRoot }
	| { readonly kind: "predicate"; readonly root: PredKind }
	| { readonly kind: "aggregate"; readonly root: AggregateFn }
	| { readonly kind: "value"; readonly root: ValueCtor }
	| { readonly kind: "member"; readonly root: MemberFeature }
	| { readonly kind: "bytes"; readonly root: "byte guard" }
	| { readonly kind: "closed"; readonly root: "closed read" }
	| { readonly kind: "lexical"; readonly root: "lexical form" }

/**
 * Every construct, each a root. The floor draws its witnesses root by root (computeWitnesses), so each construct is
 * drawn often enough to meet both verdicts.
 */
const roots: Arr.NonEmptyReadonlyArray<Root> = [
	...Arr.map(termRoots, (root): Root => ({ kind: "term", root })),
	...Arr.map(predKinds, (root): Root => ({ kind: "predicate", root })),
	...Arr.map(aggregates, (root): Root => ({ kind: "aggregate", root })),
	...Arr.map(values, (root): Root => ({ kind: "value", root })),
	...Arr.map(memberFeatures, (root): Root => ({ kind: "member", root })),
	{ kind: "bytes", root: "byte guard" },
	{ kind: "closed", root: "closed read" },
	{ kind: "lexical", root: "lexical form" }
]

/** The name of a root's stratum. */
const rootName = (root: Root): string =>
	root.kind === "term" ? termRootName(root.root).name : root.root

/** A case rooted at one construct. */
const caseAt = (d: Drawing, root: Root): CaseSpec => {
	d.note(root.kind === "term" ? termRootName(root.root).feature : root.root)
	switch (root.kind) {
		case "term":
			return { kind: "term", term: termOf(d, root.root) }
		case "predicate":
			return { kind: "predicate", pred: predOf(d, root.root) }
		case "aggregate":
			return { kind: "aggregate", fn: root.root, of: firstOperand(d, aggregateHomes, 1) }
		case "value":
			return { kind: "value", ctor: root.root, lit: d.from(lits) }
		case "bytes":
			return bytesOf(d)
		case "closed":
			return closedOf(d)
		case "lexical":
			return { kind: "lexical", field: d.from(allFields) }
		case "member": {
			const holder = holderOf[root.root]
			return {
				kind: "member",
				holder,
				name:
					holder === "Compute" && d.from([0, 1]) === 0
						? d.from(computeMembers)
						: d.from(memberNames[holder])
			}
		}
	}
}

/**
 * A cast of a text field into a str.bytes target of n bytes, a generated field's term, which a check compiles: under the
 * byte guard three times in four, its high bound drawn about n, or unguarded. The bounds and targets are a dictionary
 * of the byte counts the narrowing branches on: none, one, and a short and a longer text's.
 */
const bytesOf = (d: Drawing): CaseSpec => ({
	kind: "bytes",
	text: d.from(families.text),
	target: d.from([0, 1, 4, 8]),
	guard:
		d.from([0, 1, 2, 3]) < 3
			? { kind: "within", low: d.from([0, 1]), high: d.from([0, 1, 2, 4, 5, 8, 9, 12]) }
			: { kind: "none" }
})

/** The target a byte guard case casts into, as the program and the engine spell it. */
const bytesTargetText = (n: number): string => `str.bytes(${n}, str.regex("^.*$", "su"))`

/** A byte guard case's schema: Texts, whose generated field is the case's cast, under its guard or not. */
const bytesSchemaText = (spec: Extract<CaseSpec, { readonly kind: "bytes" }>): string => {
	const target = bytesTargetText(spec.target)
	const cast = `Compute.cast(r.text, ${target})`
	const term =
		spec.guard.kind === "within"
			? `Compute.when(Compute.within(Compute.octetLength(r.text), ${spec.guard.low}, ${spec.guard.high}), () => ${cast}, "")`
			: cast
	return `schema("Bytes", { Texts: relation.generated("Texts", { id: uuid, text: Cell.fields.${spec.text} }, ["id"], (r) => ({ stored: generated(${target}, ${term}) })) }, [])`
}

/** The engine's reading of a byte guard case: the same schema, built by the public constructors and Compute's core. */
const bytesSchema = (spec: Extract<CaseSpec, { readonly kind: "bytes" }>): unknown => {
	const target = str.bytes(spec.target, str.regex("^.*$", "su"))
	const guard = spec.guard
	return schema(
		"Bytes",
		{
			Texts: relation.generated(
				"Texts",
				{ id: uuid, text: Cell.fields[spec.text] },
				["id"],
				(r) => ({
					stored: generatedField(
						target,
						guard.kind === "within"
							? computeCore.when(
									computeCore.within(computeCore.octetLength(r.text), guard.low, guard.high),
									() => computeCore.cast(r.text, target),
									""
								)
							: computeCore.cast(r.text, target),
						[]
					)
				})
			)
		},
		[]
	)
}

/**
 * A cast of a value over Tuning's payload at the row's tone into an integer or the numeric, a generated field's term,
 * where a closed read stands, under Compute.within half the time. The value reads Tuning once at least, the other
 * operand of a sum, difference, product or quotient its own field three times in four, read off the row or Tuning; the
 * bounds are a dictionary of ranges an integer's and a product's values meet or pass.
 */
const closedOf = (d: Drawing): CaseSpec => {
	const field = d.from(tunedFields)
	const read: TunedOperand = { read: "closed", field }
	const other = (): TunedOperand => ({
		read: d.from(["field", "closed"] as const),
		field: d.from([0, 1, 2, 3]) < 3 ? field : d.from(tunedFields)
	})
	const value = ((): TunedValue => {
		switch (d.from(["operand", "unary", "binary", "binary", "binary"] as const)) {
			case "operand":
				return { kind: "operand", x: read }
			case "unary":
				return { kind: "unary", fn: d.from(["neg", "abs"] as const), x: read }
			case "binary": {
				const b = other()
				const [x, y] = d.from([0, 1]) === 0 ? [read, b] : [b, read]
				return { kind: "binary", fn: d.from(["add", "sub", "mul", "div"] as const), a: x, b: y }
			}
		}
	})()
	const [low, high] = d.from(
		plainInteger(value) ? integerRanges : [...integerRanges, [-(10n ** 15n), 10n ** 15n] as const]
	)
	return {
		kind: "closed",
		value,
		to: d.from(tunedTargets),
		guard: d.from([0, 1]) === 0 ? { kind: "within", low, high } : { kind: "none" }
	}
}

/** The ranges a closed read's guard bounds its value by that a smallint's values meet or pass. */
const integerRanges: Arr.NonEmptyReadonlyArray<readonly [bigint, bigint]> = [
	[-1000n, 1000n],
	[0n, 9n],
	[-32768n, 32767n]
]

/**
 * Whether a closed read's value is a smallint's or an integer's own, which a JavaScript number bounds; every other
 * value, a bigint, an exact integer or a numeric, a bigint bounds.
 */
const plainInteger = (v: TunedValue): boolean =>
	v.kind === "operand" && (v.x.field === "small" || v.x.field === "int" || v.x.field === "divisor")

/** A bound of a closed read's guard, as the program spells it and as the engine reads it, of its value's host type. */
const tunedBound = (v: TunedValue, n: bigint): Lit =>
	plainInteger(v) ? { text: `${n}`, value: Number(n) } : { text: `${n}n`, value: n }

/**
 * The programs that a closed read standing without bounds refused, a product within a range cast into an integer and
 * a sum cast into a bigint: every run holds them.
 */
const closedKept: ReadonlyArray<Extract<CaseSpec, { readonly kind: "closed" }>> = [
	{
		kind: "closed",
		value: {
			kind: "binary",
			fn: "mul",
			a: { read: "field", field: "int" },
			b: { read: "closed", field: "int" }
		},
		to: "int",
		guard: { kind: "within", low: -1000n, high: 1000n }
	},
	{
		kind: "closed",
		value: {
			kind: "binary",
			fn: "add",
			a: { read: "field", field: "int" },
			b: { read: "closed", field: "int" }
		},
		to: "big",
		guard: { kind: "none" }
	}
]

/**
 * The fields of the relation a closed read's case generates over: an id, the tone Tuning is keyed by, and each tuned
 * field.
 */
const tunedRelationText = `{ id: uuid, tone: Cell.fields.tone${Arr.join(
	Arr.map(tunedFields, (f) => `, ${f}: Cell.fields.${f}`),
	""
)} }`

/** An operand of a closed read's case as the program spells it, over the row `cell`. */
const tunedOperandText = (o: TunedOperand): string =>
	o.read === "closed" ? `Tuning.at(${jsonText(o.field)}, cell.tone)` : `cell.${o.field}`

/** A closed read's case's value as the program spells it. */
const tunedValueText = (v: TunedValue): string => {
	switch (v.kind) {
		case "operand":
			return tunedOperandText(v.x)
		case "unary":
			return `Compute.${v.fn}(${tunedOperandText(v.x)})`
		case "binary":
			return `Compute.${v.fn}(${tunedOperandText(v.a)}, ${tunedOperandText(v.b)})`
	}
}

/** A closed read's case's schema: Rows, whose generated field casts its value, under its guard or not. */
const closedSchemaText = (spec: Extract<CaseSpec, { readonly kind: "closed" }>): string => {
	const cast = (x: string): string => `Compute.cast(${x}, Cell.fields.${spec.to})`
	const value = tunedValueText(spec.value)
	const term =
		spec.guard.kind === "within"
			? `Compute.when(Compute.within(${value}, ${tunedBound(spec.value, spec.guard.low).text}, ${tunedBound(spec.value, spec.guard.high).text}), (g) => ${cast("g")}, cell.${spec.to})`
			: cast(value)
	return `schema("Tuned", { Tone, Tuning, Rows: relation.generated("Rows", ${tunedRelationText}, ["id"], (cell) => ({ out: generated(Cell.fields.${spec.to}, ${term}) })) }, [])`
}

/**
 * The engine's reading of a closed read's case: the same schema, built by the public constructors and Compute's core.
 */
const closedSchema = (spec: Extract<CaseSpec, { readonly kind: "closed" }>): unknown => {
	const guard = spec.guard
	const target = Cell.fields[spec.to]
	return schema(
		"Tuned",
		{
			Tone,
			Tuning,
			Rows: relation.generated(
				"Rows",
				{
					id: uuid,
					tone: Cell.fields.tone,
					small: Cell.fields.small,
					int: Cell.fields.int,
					big: Cell.fields.big,
					dec: Cell.fields.dec,
					cents: Cell.fields.cents,
					divisor: Cell.fields.divisor
				},
				["id"],
				(cell) => {
					const operand = (o: TunedOperand): unknown =>
						o.read === "closed" ? Tuning.at(o.field, cell.tone) : cell[o.field]
					const v = spec.value
					const value =
						v.kind === "operand"
							? operand(v.x)
							: v.kind === "unary"
								? applied(v.fn, [operand(v.x)])
								: applied(v.fn, [operand(v.a), operand(v.b)])
					return {
						out: generatedField(
							target,
							guard.kind === "within"
								? computeCore.when(
										computeCore.within(
											value,
											tunedBound(v, guard.low).value,
											tunedBound(v, guard.high).value
										),
										(g: unknown) => computeCore.cast(g, target),
										cell[spec.to]
									)
								: computeCore.cast(value, target),
							[]
						)
					}
				}
			)
		},
		[]
	)
}

/** One case: its kind under the swarm, then its parts. */
const caseOver = (d: Drawing): CaseSpec => {
	switch (
		d.from([
			"term",
			"term",
			"term",
			"term",
			"predicate",
			"aggregate",
			"value",
			"member",
			"bytes",
			"closed",
			"lexical"
		] as const)
	) {
		case "term":
			return caseAt(d, { kind: "term", root: termRootOf(d, d.choose(termKinds)) })
		case "predicate":
			return caseAt(d, { kind: "predicate", root: d.choose(predKinds) })
		case "aggregate":
			return caseAt(d, { kind: "aggregate", root: d.choose(aggregates) })
		case "value":
			return caseAt(d, { kind: "value", root: d.choose(values) })
		case "member":
			return caseAt(d, { kind: "member", root: d.choose(memberFeatures) })
		case "bytes":
			return caseAt(d, { kind: "bytes", root: "byte guard" })
		case "closed":
			return caseAt(d, { kind: "closed", root: "closed read" })
		case "lexical":
			return caseAt(d, { kind: "lexical", root: "lexical form" })
	}
}

/** The source of a case's parts, and whether it reads the rule (a parameter, an aggregate) and the cell. */
class Rendering {
	usesRule = false
	lexical = false
	usesCell = false
	usesHead = false
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
			case "lexical":
				this.lexical = true
				return `lexicalForm(Cell.fields.${o.field})`
			case "term":
				return this.term(o.term)
			case "heading":
				this.usesHead = true
				return `head.${o.column}`
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
				return `Compute.when(${this.guard(t.guard)}, (${readsSubject(t.body) ? "g" : "_g"}) => ${this.term(t.body)}, ${this.operand(t.otherwise)})`
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
		case "singleton":
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

/**
 * The engine's reading of a case inside its rule: the same construct, built by the cores over `cell` and `r` in a world
 * (World).
 */
class Building {
	readonly #r: RuleValue
	readonly #world: World
	readonly #cell: Readonly<Record<string, unknown>>
	readonly #head: Readonly<Record<string, unknown>>
	readonly #guarded: unknown

	constructor(
		r: RuleValue,
		world: World,
		cell: Readonly<Record<string, unknown>>,
		head: Readonly<Record<string, unknown>>,
		guarded: unknown
	) {
		this.#r = r
		this.#world = world
		this.#cell = cell
		this.#head = head
		this.#guarded = guarded
	}

	operand(o: Operand): unknown {
		switch (o.kind) {
			case "field":
				return this.#cell[o.field]
			case "param":
				return this.#r.param(o.name, this.#world.Cell.fields[o.field])
			case "literal":
				return o.lit.value
			case "typed":
				return computeCore.literal(this.#world.Cell.fields[o.field], o.lit.value)
			case "guarded":
				return this.#guarded
			case "lexical":
				return hostLexical.lexicalForm(this.#world.Cell.fields[o.field])
			case "term":
				return this.term(o.term)
			case "heading":
				return this.#head[o.column]
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
				return computeCore.cast(this.operand(t.x), this.#world.Cell.fields[t.to])
			case "endpoint":
				return computeCore[t.fn](this.operand(t.s), this.#world.Cell.fields[t.to])
			case "cond":
				return computeCore.cond(this.pred(t.p), this.operand(t.whenTrue), this.operand(t.otherwise))
			case "when":
				return computeCore.when(
					this.guard(t.guard),
					(g: unknown) =>
						new Building(this.#r, this.#world, this.#cell, this.#head, g).term(t.body),
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

/**
 * The relation, schema and heading query a case is built over: the population's, as its programs write them, or the
 * same as the types read their contracts (compute-schema.ts AsTyped), each contract its declared facts alone.
 */
interface World {
	readonly Cell: typeof Cell
	readonly Cells: typeof Cells
	readonly Heads: typeof Heads
}

/** The world the programs write. */
const written: World = Object.freeze({ Cell, Cells, Heads })

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

/** The Refusal of an exact value beside a plain value of its family, which share no type (familyNotes). */
const familyRefusal: ComputeRefusal =
	"operands of one type: an exact value beside a plain value of its family; Compute.cast the exact one into the plain one's type"

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
		return Str.startsWith(familyRefusal)(reason.what)
			? { kind: "refusal", refusal: familyRefusal }
			: Str.includes("a literal never stands first")(reason.what)
				? {
						kind: "refusal",
						refusal: "a term first: a literal takes its place opposite a term, never first"
					}
				: Str.startsWith("the span's own endpoint descriptor")(reason.what)
					? {
							kind: "refusal",
							refusal:
								"the span's own endpoint descriptor: a descriptor of another type is no endpoint of the span"
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
	| "DomainOf"
	| "lexicalForm"
	| "bytes"
	| "closed"
	| "widened"
	| "Bits"
	| "Decimal"
	| "Money"
	| "Uuid"
	| "CalendarDate"
	| "Span"
	| "Vector"
	| "Infer"
	| "Rostered"

/** The field of Cell each contract is the type of, through which the program names the contract's host type. */
const contractFields: Readonly<Record<string, FieldName>> = {
	Cents: "cents",
	EpochDay: "epoch",
	Rate: "rate",
	Divisor: "divisor",
	Body: "body"
}

/** The fields of Cell whose type is a contract. */
const contractTyped: ReadonlySet<FieldName> = new Set(Rec.values(contractFields))

/**
 * The host type a value of the engine's type `t` has, as the program spells it, with the names it imports: a term's
 * identity, a contract's domain with the facts it declares and a closed id's handles with their roster's brand, or the
 * values a column delivers, a contract's host value and bare handles.
 */
const hostText = (t: ScalarType, uses: Set<Imported>, position: "term" | "delivered"): string => {
	const named = contractOf(t)
	if (named !== undefined) {
		const field = contractFields[named.name]
		if (field === undefined) {
			throw new Error(`a contract no field of Cell is the type of: ${named.name}`)
		}
		if (position === "term") {
			uses.add("DomainOf")
			return `DomainOf<typeof Cell.fields.${field}>`
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
		case "rangeDate":
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
 * pattern's language or a lexical form, a value inside width_bucket's domain, a power's result inside its type's
 * range), a text function's place in a query
 * (a concatenation beside an equation, a translation of a long text, a length outside a predicate), the digits of an
 * exact decimal's text, and the values of a pattern term the build must see.
 */
const engineDecides = {
	fits: "decided: a fit",
	contract: "decided: a contract",
	language: "decided: a language",
	lexical: "decided: a lexical form",
	bucketDomain: "decided: a bucket's domain",
	powerRange: "decided: a power's range",
	placement: "decided: a text function's place",
	digits: "decided: a decimal's digits",
	pattern: "decided: a pattern's values",
	literal: "decided: a literal's value",
	integral: "decided: a number's integrality"
} as const
type DecidedNote = (typeof engineDecides)[keyof typeof engineDecides]
const computeDecided: Arr.NonEmptyReadonlyArray<DecidedNote> = [
	"decided: a fit",
	"decided: a contract",
	"decided: a lexical form",
	"decided: a language",
	"decided: a power's range",
	"decided: a text function's place",
	"decided: a decimal's digits",
	"decided: a pattern's values",
	"decided: a literal's value",
	"decided: a number's integrality"
]

/**
 * A case both sides refuse, the engine for a contract's predicate, which no type reads, and the types for what the case
 * is refused for once the predicate is read as the facts the contract declares (contractVerdict): a declared class,
 * whose two messages differ.
 */
const contestedNote = "decided: a contract's value"
type ContestedNote = typeof contestedNote

/**
 * Which of the engine's decisions no type states a refusal is, where it is one: a precondition compilation alone
 * proves, a literal's value against its contract or pattern, and, by the engine's words, a decimal's digits, a pattern
 * term's values, a translate's map and a text function's place. A JavaScript number's integrality is the whole case's
 * (verdictOf).
 */
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
			reason.precondition === "bucketDomain" ||
			reason.precondition === "powerRange"
			? engineDecides[reason.precondition]
			: undefined
	}
	if (reason._tag === "ContractLiteral") {
		return engineDecides.literal
	}
	const text =
		reason._tag === "MalformedDescription"
			? reason.what
			: reason._tag === "UnsupportedOperation"
				? reason.capability
				: undefined
	if (text === undefined) {
		return undefined
	}
	return Str.startsWith("a literal beside an exact value of ")(text)
		? engineDecides.literal
		: Str.startsWith("an exact decimal literal")(text)
			? engineDecides.digits
			: Str.startsWith("a pattern whose every value is seen")(text)
				? engineDecides.pattern
				: Str.startsWith("from and to of")(text) ||
					  Str.startsWith("from holding each character once")(text)
					? engineDecides.literal
					: Str.includes(" in a query")(text)
						? engineDecides.placement
						: undefined
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
	| { readonly kind: "contested"; readonly claim: Claim; readonly code: string }

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

/**
 * Whether a refusal is a contract's predicate refusing a value (ContractLiteral), and not a text's regex refinement,
 * whose membership the types do not read of a value: the engine's alone, a literal's value.
 */
const isContractLiteral = (thrown: unknown): boolean =>
	thrown instanceof CompileError &&
	thrown.reason._tag === "ContractLiteral" &&
	Str.endsWith("violates its contract")(thrown.reason.capability)

/** The Refusal the types state of a value its contract refuses where they decide it (scalar.ts Refutes). */
const contractRefusal: ComputeRefusal =
	"a value its contract refuses: it lacks a fact the contract declares"

/**
 * The verdict on a case the engine refuses for a contract's predicate (ContractLiteral), by the engine's verdict on the
 * case as the types read its contracts (AsTyped), each its declared facts alone. Refused there for a contract too, the
 * value lacks a declared fact, which the types decide, and both sides refuse it alike. Refused there for anything else,
 * both sides refuse, the types for that, whose message the engine does not reach (contested). Admitted or decided there,
 * only a predicate the types cannot read refuses it: a literal's value, the engine's alone.
 */
const contractVerdict = (
	spec: CaseSpec & { readonly kind: "term" | "predicate" | "aggregate" },
	fields: ReadonlySet<FieldName>,
	term: Admitted["term"],
	code: string
): Verdict => {
	const typed = compileTemplate(engineQuery(spec, fields, AsTyped).query, undefined, testCompile)
	if (typed.ok) {
		return { kind: "decided", note: engineDecides.literal, term }
	}
	if (isContractLiteral(typed.error)) {
		return { kind: "refused", claim: { kind: "refusal", refusal: contractRefusal }, code }
	}
	const read = decidedOr(typed.error, term, code)
	return read.kind === "refused"
		? { kind: "contested", claim: read.claim, code }
		: { kind: "decided", note: engineDecides.literal, term }
}

/**
 * A scalar parameter's ParamType: its domain and SQL type, and its host value where they differ, as for a contract
 * that declares facts, whose domain carries them, and a closed id, whose domain brands its handles by its roster while
 * a caller binds them bare.
 */
const paramTypeText = (t: ScalarType, uses: Set<Imported>): string => {
	const sql = jsonText(carrierSql[t.carrier])
	return declaresFacts(t) || t.carrier === "code"
		? `ParamType<${hostText(t, uses, "term")}, ${sql}, ${hostText(t, uses, "delivered")}>`
		: `ParamType<${hostText(t, uses, "term")}, ${sql}>`
}

/** Whether a type's values carry facts its contract declares, a span's through its endpoint's, which its host drops. */
const declaresFacts = (t: ScalarType): boolean => {
	if (t.carrier === "range4" || t.carrier === "range8" || t.carrier === "rangeDate") {
		return declaresFacts(t.span.endpoint)
	}
	const declares = contractOf(t)
	return declares !== undefined && Arr.isReadonlyArrayNonEmpty(declares.facts)
}

const paramsOf = (
	params: ReadonlyArray<ParamDecl>,
	uses: Set<Imported>
): ReadonlyArray<readonly [string, string]> =>
	Arr.flatMap(params, (p) =>
		p.kind === "scalar" ? [[p.name, paramTypeText(p.type, uses)] as const] : []
	)

const outOf = (heading: Heading, uses: Set<Imported>): string | undefined =>
	Option.getOrUndefined(
		Option.map(
			Arr.findFirst(heading, (c) => c.name === "out"),
			(c) => hostText(c.type, uses, "delivered")
		)
	)

/** The diagnostic a refused construct raises: a member read's TS2339, and every other an argument's, a list's included. */
const codeOf = (spec: CaseSpec): string => (spec.kind === "member" ? "TS2339" : "TS2345")

/** A query of Cells over the case, built by the engine's reading, with the term it built where it built one. */
const engineQuery = (
	spec: CaseSpec & { readonly kind: "term" | "predicate" | "aggregate" },
	fields: ReadonlySet<FieldName>,
	world: World
): { readonly query: unknown; readonly term: () => unknown } => {
	const holder: Array<unknown> = []
	const columns = headColumnsOf(spec)
	const query = queryOver(world.Cells).rule((r: RuleValue) => {
		const cell = varsOver(world.Cell, "cell")
		const head = varsOver(world.Heads, "head")
		const building = new Building(r, world, cell, head, undefined)
		const cells = r.match(
			world.Cell,
			Rec.fromEntries(
				Arr.map(["id", ...Arr.filter([...fields], (f) => f !== "id")], (f) => [f, cell[f]] as const)
			)
		)
		const matched = Arr.isReadonlyArrayNonEmpty(columns)
			? cells.match(
					world.Heads,
					Rec.fromEntries([
						["id", cell["id"]] as const,
						...Arr.map(columns, (c) => [c, head[c]] as const)
					])
				)
			: cells
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
const hostLexical: { lexicalForm(type: unknown): string } = { lexicalForm }

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

/** The engine's verdict on a case as written, with the names its expected types import. */
const engineVerdict = (
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
		case "lexical": {
			const form = Result.try(() => hostLexical.lexicalForm(Cell.fields[spec.field]))
			return Result.isFailure(form)
				? decidedOr(form.failure, undefined, code)
				: { kind: "admitted", admitted: { term: undefined, out: undefined, params: [] } }
		}
		case "bytes": {
			const compiled = Result.try(() => testArtifacts(bytesSchema(spec), testCompile))
			if (Result.isFailure(compiled)) {
				return decidedOr(compiled.failure, undefined, code)
			}
			return compiled.success.ok
				? { kind: "admitted", admitted: { term: undefined, out: undefined, params: [] } }
				: decidedOr(compiled.success.error, undefined, code)
		}
		case "closed": {
			const compiled = Result.try(() => testArtifacts(closedSchema(spec), testCompile))
			if (Result.isFailure(compiled)) {
				return decidedOr(compiled.failure, undefined, code)
			}
			return compiled.success.ok
				? { kind: "admitted", admitted: { term: undefined, out: undefined, params: [] } }
				: isContractLiteral(compiled.success.error)
					? { kind: "refused", claim: { kind: "refusal", refusal: contractRefusal }, code }
					: decidedOr(compiled.success.error, undefined, code)
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
			const built = Result.try(() => engineQuery(spec, fields, written))
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
				return isContractLiteral(template.error)
					? contractVerdict(spec, fields, term, code)
					: decidedOr(template.error, term, code)
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

/**
 * The verdict the types are held to. The engine builds a whole case before it judges any value or precondition, so it
 * names a case's first refusal; the types judge each call, a when's branch (branchedVerdict), a constant
 * (refutesConstant) and a range's bound (refutesBound) among them, whose refusals are the case's where the engine names
 * another first.
 */
const verdictOf = (
	spec: CaseSpec,
	fields: ReadonlySet<FieldName>,
	uses: Set<Imported>
): Verdict => {
	const judged = branchedVerdict(spec, fields, uses)
	return (refutesConstant(spec) || refutesBound(spec, fields)) &&
		!(
			judged.kind === "refused" &&
			judged.claim.kind === "refusal" &&
			judged.claim.refusal === contractRefusal
		)
		? {
				kind: "contested",
				claim: { kind: "refusal", refusal: contractRefusal },
				code: codeOf(spec)
			}
		: judged
}

/**
 * Whether a case holds a constant its contract refuses where the types decide it (scalar.ts Refutes): Compute.literal
 * refuses it as its own call, before any call over it, where the engine reaches it only once it has built every call
 * and taken their operands' types. So the constant's refusal is the case's whatever the engine names first.
 */
const refutesConstant = (spec: CaseSpec): boolean =>
	Arr.some(
		operandsOf(spec),
		(o) =>
			o.kind === "typed" &&
			contractTyped.has(o.field) &&
			literalRefused(AsTyped, o.field, o.lit.value)
	)

/**
 * Whether a case holds a range guard whose bound its subject's contract refuses where the types decide it
 * (ContractAdmits): the guard, judged as a case of its own, is refused for that alone. Compute.within refuses the bound
 * as its own call, and every call over it, a when's branch reading its subject among them, takes a refused call's
 * result, which states no refusal of its own; the engine reaches the bound only once it has built every call. So the
 * bound's refusal is the case's whatever the engine names first.
 */
const refutesBound = (spec: CaseSpec, fields: ReadonlySet<FieldName>): boolean =>
	Arr.some(guardsOf(spec), (guard) => {
		if (guard.kind !== "within") {
			return false
		}
		const own = valueVerdict(
			{ kind: "predicate", pred: { kind: "guard", guard } },
			fields,
			new Set()
		)
		return (
			(own.kind === "refused" || own.kind === "contested") &&
			own.claim.kind === "refusal" &&
			own.claim.refusal === contractRefusal
		)
	})

/** The guards a case holds, at every depth. */
const guardsOf = (spec: CaseSpec): ReadonlyArray<GuardSpec> => {
	const ofTerm = (t: TermSpec): ReadonlyArray<GuardSpec> => {
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
	const ofOperand = (o: Operand): ReadonlyArray<GuardSpec> =>
		o.kind === "term" ? ofTerm(o.term) : []
	const ofGuard = (g: GuardSpec): ReadonlyArray<GuardSpec> => [
		g,
		...ofOperand(g.x),
		...(g.kind === "matches" ? ofOperand(g.pattern) : [])
	]
	const ofPred = (p: PredSpec): ReadonlyArray<GuardSpec> => {
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
		case "bytes":
		case "closed":
		case "lexical":
			return []
	}
}

/**
 * A case's verdict before its constants (verdictOf), a when's read as the types read each call: the types judge each
 * call by its own operands, so a when's branch states its precondition whatever its otherwise is, and whatever its
 * guard is where it never reads its subject. Where the engine refuses a when for what names no Refusal, a Refusal the
 * branch states of its own (branchRefusal) is the case's.
 */
const branchedVerdict = (
	spec: CaseSpec,
	fields: ReadonlySet<FieldName>,
	uses: Set<Imported>
): Verdict => {
	const judged = valueVerdict(spec, fields, uses)
	if (
		spec.kind !== "term" ||
		spec.term.kind !== "when" ||
		judged.kind === "admitted" ||
		(judged.kind !== "decided" && judged.claim.kind === "refusal")
	) {
		return judged
	}
	return Option.match(branchRefusal(spec.term, fields, uses), {
		onNone: () => judged,
		onSome: (branch) => ({ kind: branch.kind, claim: branch.claim, code: codeOf(spec) })
	})
}

/** A refusal a case's branch states of its own: refused alike on both sides, or contested (contractVerdict). */
interface BranchRefusal {
	readonly kind: "refused" | "contested"
	readonly claim: Claim
}

/** The subject a guard hands its when's branch: the term under `guarded`. */
const guardSubject = (guard: unknown): unknown =>
	typeof guard === "object" && guard !== null && guarded in guard ? guard[guarded] : undefined

/**
 * The Refusal a when's branch states of its own, where it states one: the branch built over its guard's subject, the
 * case's values read as the types read them (standInsOf), refused for a Refusal where it is built, or else judged as
 * the when with a parameter of the branch's type as its otherwise (a field of Cell of the branch's SQL type, which an
 * exact value and a plain one of its family do not share). None
 * where the guard itself is refused, whose refusal is the case's, but for a branch that never reads its subject, which
 * the types judge apart from the guard: its own verdict as a case of its own.
 */
const branchRefusal = (
	when: Extract<TermSpec, { readonly kind: "when" }>,
	fields: ReadonlySet<FieldName>,
	uses: Set<Imported>
): Option.Option<BranchRefusal> => {
	if (!readsSubject(when.body)) {
		const own = branchedVerdict({ kind: "term", term: when.body }, fields, uses)
		return own.kind !== "admitted" && own.kind !== "decided" && own.claim.kind === "refusal"
			? Option.some({ kind: own.kind, claim: own.claim })
			: Option.none()
	}
	const read = Option.match(standInsOf({ kind: "term", term: when }), {
		onNone: () => when,
		onSome: (standing) =>
			standing.spec.kind === "term" && standing.spec.term.kind === "when"
				? standing.spec.term
				: when
	})
	const met: Array<FieldName> = []
	const built = Result.try(() =>
		queryOver(Cells).rule((r: RuleValue) => {
			const cell = varsOver(Cell, "cell")
			const head = varsOver(Heads, "head")
			const guard = Result.try(() =>
				new Building(r, written, cell, head, undefined).guard(read.guard)
			)
			if (Result.isSuccess(guard)) {
				const typed = typedTermOf(
					new Building(r, written, cell, head, guardSubject(guard.success)).term(read.body)
				)
				if (typed !== undefined) {
					for (const field of allFields) {
						const own = typedTermOf(cell[field])
						if (
							own !== undefined &&
							meets(own.type, typed.type) &&
							own.carrier.sql === typed.carrier.sql
						) {
							met.push(field)
						}
					}
				}
			}
			return r.match(Cell, { id: cell["id"] }).find({ id: cell["id"] })
		})
	)
	if (Result.isFailure(built)) {
		const thrown = built.failure
		return thrown instanceof CompileError
			? Option.map(
					Option.filter(Option.some(claimOf(thrown.reason)), (claim) => claim.kind === "refusal"),
					(claim): BranchRefusal => ({ kind: "refused", claim })
				)
			: Option.none()
	}
	return Option.flatMap(Arr.head(met), (field) => {
		const branch = valueVerdict(
			{ kind: "term", term: { ...read, otherwise: { kind: "param", name: "q", field } } },
			fields,
			uses
		)
		return (branch.kind === "refused" || branch.kind === "contested") &&
			branch.claim.kind === "refusal"
			? Option.some({ kind: branch.kind, claim: branch.claim })
			: Option.none()
	})
}

/**
 * The engine's verdict on a case as the types read its JavaScript values. A value's type shows the types its class,
 * and a number's or a decimal text's facts, never whether the engine reads the value where it stands: a fractional
 * number where an integer does, a string that spells no exact decimal where a numeric does, a string of a date's shape
 * that is no date. Where the engine refuses a case that writes such a value, the types are held to its verdict on the
 * case with each a stand-in the engine reads, of the facts the types read (standInsOf): admitted, the refusal is the
 * value's, which the engine alone decides; refused, it is the refusal the types see. A range guard's bound the types
 * cannot see is read by them as no value the engine reads (neutralBound), so a case that writes one is judged by its
 * stand-ins whatever the engine says of it as written.
 */
const valueVerdict = (
	spec: CaseSpec,
	fields: ReadonlySet<FieldName>,
	uses: Set<Imported>
): Verdict => {
	const written = engineVerdict(spec, fields, uses)
	return Option.match(standInsOf(spec), {
		onNone: () => written,
		onSome: (read) => {
			if (
				!read.strict &&
				(written.kind === "admitted" ||
					((written.kind === "refused" || written.kind === "contested") &&
						written.claim.kind === "refusal"))
			) {
				return written
			}
			const standing = engineVerdict(read.spec, fields, uses)
			if (standing.kind !== "admitted") {
				return standing
			}
			return written.kind === "admitted"
				? written
				: {
						kind: "decided",
						note: written.kind === "decided" ? written.note : read.note,
						term: standing.admitted.term
					}
		}
	})
}

/**
 * A value the engine may refuse where the types admit its type, at a field of Cell the value stands opposite, and the
 * stand-in the engine reads there, of the facts the types read: 1 for a fractional number at an integer, which the
 * types read as finite, nonzero and nonnegative; Decimal.of("1") for a string that spells no exact decimal at a
 * numeric, a value TypeScript sees no more than it sees that string; a date for a date's shape; and "x" for a string a
 * text's regex refinement refuses, whose membership the types do not read of a value.
 */
const standInAt = (
	l: Lit,
	anchor: FieldName | undefined
): Option.Option<{ readonly lit: Lit; readonly note: DecidedNote }> => {
	if (anchor === undefined) {
		return Option.none()
	}
	const value = l.value
	const sql = Cell.fields[anchor].sql
	if (
		(sql === "smallint" || sql === "integer") &&
		typeof value === "number" &&
		!Number.isInteger(value)
	) {
		return Option.some({ lit: { text: "1", value: 1 }, note: engineDecides.integral })
	}
	if (sql === "numeric" && typeof value === "string" && !Decimal.fromString(value).ok) {
		return Option.some({
			lit: { text: 'Decimal.of("1")', value: Decimal.of("1") },
			note: engineDecides.digits
		})
	}
	if (
		sql === "date" &&
		typeof value === "string" &&
		Arr.length(Str.split(value, "-")) >= 3 &&
		!toCalendarDate(value).ok
	) {
		return Option.some({
			lit: { text: '"2024-01-31"', value: "2024-01-31" },
			note: engineDecides.literal
		})
	}
	if (
		sql === "text" &&
		typeof value === "string" &&
		!contractTyped.has(anchor) &&
		literalRefused(written, anchor, value)
	) {
		return Option.some({ lit: { text: '"x"', value: "x" }, note: engineDecides.literal })
	}
	return Option.none()
}

/** An exact decimal's text as the types read one (scalar.ts DecimalSign): a sign, digits, and a point with digits. */
const decimalText = regex("^[+-]?[0-9]+(\\.[0-9]+)?$")

/**
 * A range guard's bound the types cannot see, read as the types read it: a string that spells no decimal the types
 * read, a Decimal or a string-typed value at a numeric subject, a Money at a money subject. A low bound of them is a
 * residue (WithinFacts), every fact admitted, and a high one proves nothing, though the engine reads each value, so the
 * case is judged with a low end that proves every fact and a high end above zero, both inside every numeric field's
 * domain, Rate's included.
 */
const neutralBound = (
	l: Lit,
	anchor: FieldName | undefined,
	end: "low" | "high"
): Option.Option<Lit> => {
	if (anchor === undefined) {
		return Option.none()
	}
	const value = l.value
	const sql = Cell.fields[anchor].sql
	if (
		sql === "numeric" &&
		(l === widened ||
			(typeof value === "string" && !decimalText.test(value)) ||
			value instanceof Decimal)
	) {
		return Option.some(
			end === "low"
				? { text: 'Decimal.of("0.5")', value: Decimal.of("0.5") }
				: { text: 'Decimal.of("1")', value: Decimal.of("1") }
		)
	}
	return sql === "money" && value instanceof Money
		? Option.some(
				end === "low"
					? { text: "Money.of(1n)", value: Money.of(1n) }
					: { text: "Money.of(100n)", value: Money.of(100n) }
			)
		: Option.none()
}

/**
 * A case with every value the engine may refuse where the types admit its type read as its stand-in (standInAt), each
 * at the field it stands opposite: an operation's first operand's, a comparison's, a range's subject's, a typed
 * constant's own and a conditional's first branch's; a match's pattern constant of a string, which the types read as a
 * text term whatever the string, as "x", a pattern in the grammar; and a match's pattern, a lexical form among them,
 * opposite a subject of no text, which the engine reads as a value of the subject's type before it refuses the subject,
 * the refusal the types state whatever the pattern. None where nothing is replaced. A value a contract's predicate
 * refuses stands as written, whatever its sign: the case is read over the contracts as the types read them instead
 * (contractVerdict).
 */
const standInsOf = (
	spec: CaseSpec
): Option.Option<{
	readonly spec: CaseSpec
	readonly note: DecidedNote
	readonly strict: boolean
}> => {
	const notes: Array<DecidedNote> = []
	const strict: Array<Lit> = []
	const lit = (l: Lit, anchor: FieldName | undefined): Lit =>
		Option.match(standInAt(l, anchor), {
			onNone: () => l,
			onSome: (standIn) => {
				notes.push(standIn.note)
				return standIn.lit
			}
		})
	const bound = (l: Lit, anchor: FieldName | undefined, end: "low" | "high"): Lit =>
		Option.match(neutralBound(l, anchor, end), {
			onNone: () => lit(l, anchor),
			onSome: (neutral) => {
				strict.push(neutral)
				return neutral
			}
		})
	const patternLit = (l: Lit): Lit => {
		if (typeof l.value !== "string" || l.value === "x") {
			return l
		}
		notes.push(engineDecides.pattern)
		return { text: '"x"', value: "x" }
	}
	const operand = (o: Operand, anchor: FieldName | undefined): Operand => {
		switch (o.kind) {
			case "literal":
				return { kind: "literal", lit: lit(o.lit, anchor) }
			case "typed":
				return { kind: "typed", field: o.field, lit: lit(o.lit, o.field) }
			case "term":
				return { kind: "term", term: term(o.term) }
			case "lexical": {
				const form: Lit = {
					text: `lexicalForm(Cell.fields.${o.field})`,
					value: hostLexical.lexicalForm(Cell.fields[o.field])
				}
				return Option.match(standInAt(form, anchor), {
					onNone: () => o,
					onSome: (standIn): Operand => {
						notes.push(standIn.note)
						return { kind: "literal", lit: standIn.lit }
					}
				})
			}
			case "field":
			case "param":
			case "guarded":
			case "heading":
				return o
		}
	}
	const guard = (g: GuardSpec): GuardSpec => {
		switch (g.kind) {
			case "test":
				return { kind: "test", test: g.test, x: operand(g.x, undefined) }
			case "within": {
				const at = fieldOf(g.x)
				return {
					kind: "within",
					x: operand(g.x, undefined),
					low: bound(g.low, at, "low"),
					high: bound(g.high, at, "high")
				}
			}
			case "matches": {
				const at = fieldOf(g.x)
				return {
					kind: "matches",
					x: operand(g.x, undefined),
					pattern:
						g.pattern.kind === "typed"
							? { kind: "typed", field: g.pattern.field, lit: patternLit(g.pattern.lit) }
							: operand(
									g.pattern,
									at !== undefined && Cell.fields[at].sql !== "text" ? at : undefined
								)
				}
			}
		}
	}
	const pred = (p: PredSpec): PredSpec => {
		const at = p.kind === "guard" ? undefined : fieldOf(p.a)
		switch (p.kind) {
			case "compare":
				return { kind: "compare", op: p.op, a: operand(p.a, undefined), b: operand(p.b, at) }
			case "between":
				return {
					kind: "between",
					a: operand(p.a, undefined),
					low: operand(p.low, at),
					high: operand(p.high, at)
				}
			case "in":
				return {
					kind: "in",
					a: operand(p.a, undefined),
					values: Arr.map(p.values, (v) => lit(v, at))
				}
			case "guard":
				return { kind: "guard", guard: guard(p.guard) }
		}
	}
	const term = (t: TermSpec): TermSpec => {
		switch (t.kind) {
			case "apply": {
				const [first, ...rest] = t.args
				const at = t.fn === "round" || t.fn === "trunc" ? "int" : fieldOf(first)
				return {
					kind: "apply",
					fn: t.fn,
					args: [
						operand(first, undefined),
						...Arr.map(rest, (o) => (t.fn === "translate" ? o : operand(o, at)))
					]
				}
			}
			case "cast":
				return { kind: "cast", x: operand(t.x, undefined), to: t.to }
			case "endpoint":
				return { kind: "endpoint", fn: t.fn, s: operand(t.s, undefined), to: t.to }
			case "cond":
				return {
					kind: "cond",
					p: pred(t.p),
					whenTrue: operand(t.whenTrue, undefined),
					otherwise: operand(t.otherwise, fieldOf(t.whenTrue))
				}
			case "when":
				return {
					kind: "when",
					guard: guard(t.guard),
					body: term(t.body),
					otherwise: operand(t.otherwise, undefined)
				}
		}
	}
	const read = ((): CaseSpec => {
		switch (spec.kind) {
			case "term":
				return { kind: "term", term: term(spec.term) }
			case "predicate":
				return { kind: "predicate", pred: pred(spec.pred) }
			case "aggregate":
				return { kind: "aggregate", fn: spec.fn, of: operand(spec.of, undefined) }
			case "value":
			case "member":
			case "bytes":
			case "closed":
			case "lexical":
				return spec
		}
	})()
	return Arr.isReadonlyArrayNonEmpty(notes) || Arr.isReadonlyArrayNonEmpty(strict)
		? Option.some({
				spec: read,
				note: Option.getOrElse(Arr.head(notes), () => engineDecides.literal),
				strict: Arr.isReadonlyArrayNonEmpty(strict)
			})
		: Option.none()
}

/** One drawn case: its source lines, the engine's verdict, the names it imports and what it reached. */
interface ComputeCase {
	readonly spec: CaseSpec
	readonly expression: string
	readonly usesRule: boolean
	readonly usesCell: boolean
	readonly fields: ReadonlySet<FieldName>
	/** The columns of Heads it reads through a query's heading, which its rule matches. */
	readonly columns: ReadonlyArray<HeadColumn>
	readonly verdict: Verdict
	readonly uses: ReadonlySet<Imported>
	readonly notes: ReadonlySet<ComputeNote>
}

/** A drawn case and the constructs its drawing reached. */
interface Drawn {
	readonly spec: CaseSpec
	readonly reached: ReadonlySet<ComputeFeature>
}

/** A case drawn under a swarm over the constructs: rooted where `root` says, or at a construct the swarm chooses. */
const drawnGen =
	(root: Option.Option<Root>): Gen<Drawn> =>
	(source) => {
		const d = new Drawing(source, source.draw(swarm(computeFeatures)))
		const spec = Option.isSome(root) ? caseAt(d, root.value) : caseOver(d)
		return { spec, reached: d.reached }
	}

/** The columns of Heads a case reads through a query's heading, each once. */
const headColumnsOf = (spec: CaseSpec): ReadonlyArray<HeadColumn> =>
	Arr.dedupe(Arr.flatMap(operandsOf(spec), (o) => (o.kind === "heading" ? [o.column] : [])))

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
		case "bytes":
		case "closed":
		case "lexical":
			return []
	}
}

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
				(spec.term.body.kind === "apply" && Arr.contains(partialFns, spec.term.body.fn))
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
		...(term !== undefined && Str.startsWith("DomainOf<")(term.type)
			? ["a contract kept" as const]
			: []),
		...(term !== undefined && contractOperand && !Str.startsWith("DomainOf<")(term.type)
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
	if (Arr.isReadonlyArrayNonEmpty(headColumnsOf(spec))) {
		notes.add(headingNote)
	}
	for (const note of byteNotesOf(spec, verdict)) {
		notes.add(note)
	}
	for (const note of contractNotesOf(spec, verdict)) {
		notes.add(note)
	}
	for (const note of familyNotesOf(spec, verdict)) {
		notes.add(note)
	}
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
		case "contested":
			notes.add(contestedNote)
			notes.add("refused")
			notes.add(
				verdict.claim.kind === "refusal"
					? refusalNotes[verdict.claim.refusal]
					: "refused: structurally"
			)
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
	if (Str.includes("Bits.of(")(expression)) {
		uses.add("Bits")
	}
	if (rendering.lexical || spec.kind === "lexical") {
		uses.add("lexicalForm")
	}
	if (spec.kind === "bytes") {
		uses.add("bytes")
	}
	if (spec.kind === "closed") {
		uses.add("closed")
	}
	if (Str.includes(widened.text)(expression)) {
		uses.add("widened")
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
		columns: headColumnsOf(spec),
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
		case "bytes":
			return bytesSchemaText(spec)
		case "closed":
			return closedSchemaText(spec)
		case "lexical":
			return `lexicalForm(Cell.fields.${spec.field})`
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
 * each admitted but a literal standing first, and each refused but the byte guard, whose casts the types always admit;
 * a column read through a heading both ways; and each byte guard situation (byteNotes).
 */
export const computeRequired: ReadonlyArray<Reached<ComputeNote>> = [
	...computeFeatures,
	...computeDecided,
	[headingNote, "admitted"],
	[headingNote, "refused"],
	...Arr.map(familyNotes, (n) => [n, "refused"] as const),
	...exactLiteralNotes,
	...byteNotes,
	...contractNotes,
	contestedNote,
	...Arr.map(
		Arr.filter(computeFeatures, (f) => f !== "literal first"),
		(f) => [f, "admitted"] as const
	),
	...Arr.map(
		Arr.filter(computeFeatures, (f) => f !== "byte guard"),
		(f) => [f, "refused"] as const
	)
]

/** The cases the run's own stream draws. */
export const computeCount = 400

const computeLabel = "types/compute agreement"

const caseGen =
	(root: Option.Option<Root>): Gen<ComputeCase> =>
	(source) =>
		caseOf(drawnGen(root)(source))

/** The required pairs: every construct an admitted case and a refused case reach. */
const reachedBy = (c: ComputeCase): ReadonlyArray<Reached<ComputeNote>> => [
	...c.notes,
	...Arr.flatMap([...c.notes], (n): ReadonlyArray<Reached<ComputeNote>> =>
		Arr.contains(computeFeatures, n) ||
		n === headingNote ||
		Arr.contains<ComputeNote>(familyNotes, n)
			? [
					[
						n,
						c.verdict.kind === "refused" || c.verdict.kind === "contested" ? "refused" : "admitted"
					]
				]
			: []
	)
]

/** The cases each root's stratum of the floor draws. */
const rootCount = 12

/**
 * The floor's witnesses: one stratum per construct, each drawn under its own label alone with the construct at its
 * root, so the floor is the same in every run and every construct is drawn often enough to meet both verdicts; they are
 * the only cases whose constructs and verdicts meet the required situations (test/types/compute/compute.test.ts).
 */
export const computeWitnesses = () =>
	Arr.map(roots, (root) =>
		floorPopulation(
			`${computeLabel}: ${rootName(root)}`,
			caseGen(Option.some(root)),
			rootCount,
			reachedBy
		)
	)

/** Every case the program holds: the floor's witnesses, then the label's stream under the run's seed. */
const computeCases = (seed: number): ReadonlyArray<ComputeCase> => [
	...Arr.map(closedKept, (spec) => caseOf({ spec, reached: new Set(["closed read"]) })),
	...Arr.flatMap(computeWitnesses(), (stratum) => stratum.values),
	...sample(caseGen(Option.none()), rotatingSeed(seed, floorSeed(computeLabel)), computeCount)
]

/** The Compute program's prelude (test/support/programs/compute.ts), every name it reads. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/compute.ts"))

export const computeEntriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

/** The directive above a refused case's expression, which the type-test batch disarms. */
const directiveOf = (verdict: Verdict): ReadonlyArray<string> => {
	if (verdict.kind === "admitted" || verdict.kind === "decided") {
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
					...(verdict.kind === "refused" || verdict.kind === "contested"
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
		case "bytes":
		case "closed":
		case "lexical":
			return Arr.join([`export const t${i} = () =>`, ...directive, `\t${c.expression}`, ""], "\n")
		case "term":
		case "predicate":
		case "aggregate": {
			const reads = Arr.isReadonlyArrayNonEmpty(c.columns)
			const signature = `(${c.usesRule ? "r" : "_r"}: R, ${c.usesCell ? "cell" : "_cell"}: CellVars${reads ? ", head: HeadVars" : ""})`
			const used = reads ? `t${i}(r, cell, head)` : `t${i}(r, cell)`
			const bindings = Arr.join(
				Arr.map(["id", ...Arr.filter([...c.fields], (f) => f !== "id")], (f) => `${f}: cell.${f}`),
				", "
			)
			const minted = reads
				? `const cell = v(Cell, "cell")\n\tconst head = v(Heads, "head")`
				: `const cell = v(Cell, "cell")`
			const matched = reads
				? `r.match(Cell, { ${bindings} }).match(Heads, { id: cell.id, ${Arr.join(
						Arr.map(c.columns, (col) => `${col}: head.${col}`),
						", "
					)} })`
				: `r.match(Cell, { ${bindings} })`
			const query =
				c.spec.kind === "predicate"
					? `export const q${i} = query(Cells).rule((r) => {\n\t${minted}\n\treturn ${matched}.where(${used}).find({ id: cell.id })\n})`
					: `export const q${i} = query(Cells).rule((r) => {\n\t${minted}\n\treturn ${matched}.find({ out: ${used} })\n})`
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
					...(verdict.kind === "refused" || verdict.kind === "contested"
						? []
						: [...termAssertion, query, ...compiled]),
					""
				],
				"\n"
			)
		}
	}
}

/** The program over the run's cases: one module, each case a block. */
export const computeModules = (
	entries: PreludeAt,
	seed: number
): Arr.NonEmptyReadonlyArray<{ readonly file: string; readonly source: string }> => {
	const cases = computeCases(seed)
	const uses = new Set(Arr.flatMap(cases, (c) => [...c.uses]))
	const text = Arr.join(
		[
			"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
			"type Expect<T extends true> = T",
			...(uses.has("widened") ? [`declare const ${widened.text}: string`] : []),
			"type R = Rule<typeof Cells>",
			'const cellVars = () => v(Cell, "cell")',
			"type CellVars = ReturnType<typeof cellVars>",
			'const headVars = () => v(Heads, "head")',
			"type HeadVars = ReturnType<typeof headVars>",
			"export type AggregateHost<X> = X extends Aggregate<infer T, never> ? T : never",
			"",
			...Arr.map(cases, blockOf)
		],
		"\n"
	)
	return [
		{
			file: "index.ts",
			source: preludeProgram(
				"// Generated by test/support/agreement/compute.ts: the Compute type/engine agreement.",
				entries,
				text
			)
		}
	]
}
