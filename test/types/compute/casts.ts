import * as Result from "@bjornpagen/grizzle-text/base/result"
import { Array as Arr, Effect, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import {
	Numeric,
	exactInteger,
	exactMoney,
	Money,
	float4,
	float8,
	int2,
	int4,
	int8,
	money,
	numeric
} from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The casts program: Type.cast of a value of each SQL type of the numeric family, money and the exact carriers into each
 * of them, each a statement under the directive the type-test batch disarms exactly where the engine refuses the cast.
 * Each value is a typed constant, or for an exact carrier the sum of two, whose bounds prove every precondition a cast
 * it has holds (a narrowing's fit, a float's finiteness), so the engine's verdict is whether it has the cast at all:
 * the registered casts between two SQL types (scalar/compute/registry.ts castOverloads), and within one SQL type a
 * cast into itself. The oracle is the engine: each statement is built through the builder's JavaScript view (queryOver,
 * varsOver, computeCore) and compiled as the runtime compiles it, with no types.
 */

/** A SQL type of the box: its name, its descriptor's source and value, and a value of it, its source and its builder. */
interface CastType {
	readonly sql: string
	readonly descriptor: string
	readonly to: unknown
	readonly value: string
	readonly build: () => unknown
}

/** A typed constant of a descriptor, its source and its builder. */
const constant = (
	descriptor: string,
	to: unknown,
	literal: string,
	host: unknown
): Pick<CastType, "value" | "build"> => ({
	value: `Type.literal(${descriptor}, ${literal})`,
	build: () => computeCore.literal(to, host)
})

/** The exact value of the sum of two typed constants of a descriptor: an exact integer's or an exact amount's. */
const exactSum = (
	descriptor: string,
	to: unknown,
	literal: string,
	host: unknown
): Pick<CastType, "value" | "build"> => ({
	value: `Num.add(Type.literal(${descriptor}, ${literal}), Type.literal(${descriptor}, ${literal}))`,
	build: () => computeCore.add(computeCore.literal(to, host), computeCore.literal(to, host))
})

/** Every SQL type a cast of the numeric family, money and the exact carriers converts from and into. */
const castTypes: Arr.NonEmptyReadonlyArray<CastType> = [
	{
		sql: "smallint",
		descriptor: "int2",
		to: int2,
		...constant("int2", int2, "1", 1)
	},
	{
		sql: "integer",
		descriptor: "int4",
		to: int4,
		...constant("int4", int4, "1", 1)
	},
	{
		sql: "bigint",
		descriptor: "int8",
		to: int8,
		...constant("int8", int8, "1n", 1n)
	},
	{
		sql: "numeric",
		descriptor: "numeric",
		to: numeric,
		...constant("numeric", numeric, 'Numeric.of("1")', Numeric.of("1"))
	},
	{ sql: "real", descriptor: "float4", to: float4, ...constant("float4", float4, "1", 1) },
	{
		sql: "double precision",
		descriptor: "float8",
		to: float8,
		...constant("float8", float8, "1", 1)
	},
	{
		sql: "money",
		descriptor: "money",
		to: money,
		...constant("money", money, "Money.of(100n)", Money.of(100n))
	},
	{
		sql: "exact integer",
		descriptor: "exactInteger",
		to: exactInteger,
		...exactSum("int8", int8, "1n", 1n)
	},
	{
		sql: "exact money",
		descriptor: "exactMoney",
		to: exactMoney,
		...exactSum("money", money, "Money.of(100n)", Money.of(100n))
	}
]

/** A cell: a cast of a value of one SQL type into another, or into its own. */
interface CastCell {
	readonly from: CastType
	readonly to: CastType
}

/** The cells of castsBox, minted as a dictionary in its door (test/types/compute/casts.dictionary.ts). */
export const castsBoxItems: Arr.NonEmptyReadonlyArray<CastCell> = Arr.flatMap(castTypes, (from) =>
	Arr.map(castTypes, (to): CastCell => ({ from, to }))
)

/** The relation every cell's rule matches, and its schema, as the program states them and as the engine builds them. */
const T = relation("T", { id: int4 }, ["id"])
const S = schema("Casts", [T], [])
const castsHeader = `export const T = relation("T", { id: int4 }, ["id"])
export const S = schema("Casts", [T], [])
`

/** How the types refuse a cast the engine has none of. */
const noCast: Refused = "PostgreSQL has no cast between these types that grizzle admits"

/**
 * The engine's verdict on a cell, built and compiled as the runtime does: admitted, or refused as no cast PostgreSQL has
 * that grizzle admits. Any other refusal is the box's defect: its values prove every precondition a cast has.
 */
const engineAdmits = (cell: CastCell): boolean => {
	const compiled = Result.flatMap(
		catchCompileError(() =>
			queryOver(S).rule((r: RuleValue) => {
				const t = varsOver(T, "t")
				return r
					.match(T, { id: t["id"] })
					.find({ id: t["id"], c: computeCore.cast(cell.from.build(), cell.to.to) })
			})
		),
		(built) => compileTemplate(built, undefined, testCompile)
	)
	if (compiled.ok) {
		return true
	}
	const reason = compiled.error.reason
	if (reason._tag === "UnsupportedOperation" && Str.startsWith("cast:")(reason.capability)) {
		return false
	}
	throw new Error(
		`the engine refuses the cast of ${cell.from.sql} into ${cell.to.sql} for no cast's reason: ${compiled.error.message}`
	)
}

/** How a cell prints. */
const castCellName = (cell: CastCell): string => `${cell.from.sql} into ${cell.to.sql}`

const caseBlock = (cell: CastCell, index: number): ReadonlyArray<string> => [
	`// a cast of ${castCellName(cell)}`,
	...(engineAdmits(cell) ? [] : [`// @ts-expect-error -- refusal: ${noCast}`]),
	`export const c${index} = query(S).rule((r) => { const { id } = v(T, "t"); return r.match(T, { id }).find({ id, c: Type.cast(${cell.from.value}, ${cell.to.descriptor}) }) })`,
	""
]

/** The program's prelude (test/support/programs/casts.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/casts.ts"))

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const castsProgram = (cells: Arr.NonEmptyReadonlyArray<CastCell>, entry: Entry): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/compute/casts.ts: Type.cast between the numeric family, money and the exact carriers.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(castsHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: caseBlock(c, at) }))
		]
	)
]
