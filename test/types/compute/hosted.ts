import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, String as Str } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import type { ComputeFn } from "#compiler/ir/desc.ts"
import { computeSpecs } from "#compiler/scalar/compute/registry.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The hosted-operation program: the box of every scalar function the host does not evaluate (computeSpecs, check
 * false) and one it does, abs, at every position a term stands in a schema, exhausted and printed as one program the
 * type batch checks.
 *
 * The oracle is the roster the compiler refuses by (scalar/compute/typing.ts compute reads computeSpecs[fn].check): a
 * domain predicate, a row check of a stored relation and a generated field are evaluated on the host, so a term
 * computed by a function marked check false is refused there, under the types' Refusal (types/core/phantom.ts
 * Hosted); a row check of a derived relation and a selection are read in SQL, and admit it. Each function's term is
 * written as its own typing admits it, a precondition guarded where it has one, so a refused cell is refused for the
 * position alone. widthBucket is the one function of the roster left out: no term of it typechecks over a field.
 */

/** The scalar functions of the box: every one computeSpecs marks check false but widthBucket, then abs. */
const computeFunctions = [
	"quot",
	"rem",
	"round",
	"trunc",
	"ceil",
	"floor",
	"gcd",
	"lcm",
	"power",
	"sqrt",
	"minScale",
	"numeric",
	"cosineDistance",
	"abs"
] as const satisfies ReadonlyArray<ComputeFn>

/** The operations of the box: its scalar functions, then a call of a declared function, scale, which PostgreSQL alone
 * evaluates (Fn.call). */
const functions = [...computeFunctions, "call"] as const

type Fn = (typeof functions)[number]

/** Where a term stands: the three positions the host evaluates, and two read in SQL. */
const positions = ["check", "contract", "generated", "derivedCheck", "select"] as const

type Position = (typeof positions)[number]

/** Whether the host evaluates a position's term (Hosted). */
const hostEvaluated: { readonly [P in Position]: boolean } = {
	check: true,
	contract: true,
	generated: true,
	derivedCheck: false,
	select: false
}

/** The family a function's operand is of: a field of Cell, a contract's base, and a generated field's type. */
type Family = "int" | "dec" | "dbl" | "vec"

const familyField: { readonly [F in Family]: string } = { int: "n", dec: "d", dbl: "x", vec: "w" }

const familyBase: { readonly [F in Family]: string } = {
	int: "int8",
	dec: "numeric(10, 2)",
	dbl: "float8",
	vec: "vector(2)"
}

/** Each function's term over an operand `a`, its family, and the type of the generated field that stores it. */
const termOf: {
	readonly [F in Fn]: {
		readonly family: Family
		readonly term: (a: string) => string
		readonly stored: string
	}
} = {
	quot: {
		family: "dec",
		term: (a) => `Logic.when(Num.nonzero(${a}), (k) => Num.quot(${a}, k), ${a})`,
		stored: "numeric(10, 2)"
	},
	rem: {
		family: "dec",
		term: (a) => `Logic.when(Num.nonzero(${a}), (k) => Num.rem(${a}, k), ${a})`,
		stored: "numeric(10, 2)"
	},
	round: {
		family: "dec",
		term: (a) => `Logic.when(Num.isFinite(${a}), (k) => Num.round(k), ${a})`,
		stored: "numeric(10, 2)"
	},
	trunc: {
		family: "dec",
		term: (a) => `Logic.when(Num.isFinite(${a}), (k) => Num.trunc(k), ${a})`,
		stored: "numeric(10, 2)"
	},
	ceil: {
		family: "dec",
		term: (a) => `Logic.when(Num.isFinite(${a}), (k) => Num.ceil(k), ${a})`,
		stored: "numeric(10, 2)"
	},
	floor: {
		family: "dec",
		term: (a) => `Logic.when(Num.isFinite(${a}), (k) => Num.floor(k), ${a})`,
		stored: "numeric(10, 2)"
	},
	gcd: {
		family: "int",
		term: (a) =>
			`Logic.when(Num.within(Num.gcd(${a}, ${a}), 0n, 1000n), (k) => Type.cast(k, int8), 0n)`,
		stored: "int8"
	},
	lcm: {
		family: "int",
		term: (a) =>
			`Logic.when(Num.within(Num.lcm(${a}, ${a}), 0n, 1000n), (k) => Type.cast(k, int8), 0n)`,
		stored: "int8"
	},
	power: {
		family: "dbl",
		term: (a) => `Logic.when(Num.positive(${a}), (k) => Num.power(k, 2), 0)`,
		stored: "float8"
	},
	sqrt: {
		family: "dbl",
		term: (a) => `Num.sqrt(Num.abs(${a}))`,
		stored: "float8"
	},
	minScale: {
		family: "dec",
		term: (a) => `Logic.when(Num.isFinite(${a}), (k) => Num.minScale(k), 0)`,
		stored: "int4"
	},
	numeric: { family: "int", term: (a) => `Num.numeric(${a})`, stored: "numeric(10, 2)" },
	cosineDistance: {
		family: "vec",
		term: (a) => `Distance.cosine(${a}, ${a})`,
		stored: "float8"
	},
	abs: {
		family: "int",
		term: (a) => `Logic.when(Num.within(Num.abs(${a}), 0n, 1000n), (k) => Type.cast(k, int8), 0n)`,
		stored: "int8"
	},
	call: {
		family: "int",
		term: (a) => `Fn.call(scale, { x: ${a}, k: 2n })`,
		stored: "int8"
	}
}

/** One case: a function, and the position its term stands at. */
interface HostedCase {
	readonly fn: Fn
	readonly position: Position
}

const boxCases: ReadonlyArray<HostedCase> = Arr.flatMap(functions, (fn) =>
	Arr.map(positions, (position): HostedCase => ({ fn, position }))
)

/** The cells of hostedBox, minted as a dictionary in its door (test/types/compute/hosted.dictionary.ts). */
export const hostedBoxItems: Arr.NonEmptyReadonlyArray<HostedCase> = [
	defined(boxCases[0], "a case of the hosted box"),
	...Arr.drop(boxCases, 1)
]

const hostedRefusal: Refused =
	"an operation the host evaluates: a domain predicate, a row check and a generated field compute no quot, rem, round, trunc, ceil, floor, gcd, lcm, power, sqrt, widthBucket, minScale, numeric, cosineDistance, textMatches, textRank or textRankCd, and call no declared function"

/**
 * The roster's verdict on a cell: refused where the host evaluates the position and computeSpecs marks the function,
 * or the cell calls a declared function, which PostgreSQL alone evaluates.
 */
const refusedCell = (c: HostedCase): boolean =>
	hostEvaluated[c.position] && (c.fn === "call" || !computeSpecs[c.fn].check)

/** A cell's statement, the predicate its term stands in comparing the term with itself. */
const statementOf = (c: HostedCase, index: number): string => {
	const { family, term, stored } = termOf[c.fn]
	const field = familyField[family]
	const compared = (a: string) => `Logic.eq(${term(a)}, ${term(a)})`
	switch (c.position) {
		case "check":
			return `check("C${index}", Cell, (r) => ${compared(`r.${field}`)})`
		case "contract":
			return `domain<typeof probeKey>()("K${index}", ${familyBase[family]}, (c) => ${compared("c")}, undefined)`
		case "generated":
			return `relation.generated("G${index}", { id: Id, ${field}: ${familyBase[family]} }, ["id"], (r) => ({ g: generated(${stored}, ${term(`r.${field}`)}) }))`
		case "derivedCheck":
			return `check("D${index}", Cells, (r) => ${compared(`r.${field}`)})`
		case "select":
			return `select(Cell, (r) => ${compared(`r.${field}`)})`
	}
}

const caseBlock = (c: HostedCase, index: number): ReadonlyArray<string> => [
	`// ${c.fn} in a ${c.position}`,
	...(refusedCell(c) ? [`// @ts-expect-error -- refusal: ${hostedRefusal}`] : []),
	`export const c${index} = ${statementOf(c, index)}`,
	""
]

/** The program's prelude (test/support/programs/hosted.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/hosted.ts"))

/** Cell, a field of each family, its schema, and Cells, a derived relation of its rows. */
const hostedHeader = `export const probeKey = Symbol("Probe")
export const Cell = relation("Cell", { id: Id, n: int8, d: numeric(10, 2), x: float8, w: vector(2) }, ["id"])
export const scale = fn("scale", { calls: [], args: { x: int8, k: int8 }, returns: int8, volatility: "immutable", nullInput: "called", language: "sql", body: fn.body\`SELECT x * k\` })
export const Root = schema("Root", [Cell, scale], [])
export const Cells = derived("Cells", query(Root).rule((r) => {
	const { id, n, d, x, w } = v(Cell, "cell")
	return r.match(Cell, { id, n, d, x, w }).find({ id, n, d, x, w })
}))
`

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const hostedProgram = (
	cells: Arr.NonEmptyReadonlyArray<HostedCase>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/compute/hosted.ts: each scalar function at each position a term stands in a schema.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(hostedHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: caseBlock(c, at) }))
		]
	)
]
