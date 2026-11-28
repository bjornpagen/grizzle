import { nonEmpty } from "@bjornpagen/testing/assert"
import { boolean, type Gen, int, map, oneOf, option, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Record as Rec } from "effect"
import { bit, int4, int8, numeric, vector } from "#compiler/public/fields.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyRoster } from "#compiler/types/schema/relation.ts"
import { Id } from "#test/support/ids.ts"
import { plainDescriptors } from "#test/support/unit/scalar/support.ts"
import { bareContract, rawClosedId, rawSpan, regex } from "#test/support/unit/schema/support.ts"

/**
 * A field type as a caller declares it, drawn over a box its bounds define: every one of PostgreSQL's plain types that is a
 * descriptor by itself, numeric over the whole typmod box, uuid, a refined text of a drawn character class and length or the
 * wildcard, a contract over a drawn base, a span over an integer type with or without a width, a closed id or a set
 * over one of the caller's rosters, and a vector of any admitted dimension count. A suite builds the descriptor with
 * `fieldOf` and states its own model of the sketch.
 */

/** A roster a closed id or a set is over, its handles at hand. */
export type DrawnRoster = AnyRoster & { readonly handles: Arr.NonEmptyReadonlyArray<string> }

/** The plain types that take a typmod or a configuration, which are no descriptor until called. */
type PlainConstructor = "numeric" | "vector" | "tsvector"

/** The plain names that spell the serial family: no descriptor, but grizzle's refusal of one (scalar/minted.ts). */
type MintedMember = "smallserial" | "serial" | "bigserial" | "uuidv7"

const mintedMembers: ReadonlySet<string> = new Set<MintedMember>([
	"smallserial",
	"serial",
	"bigserial",
	"uuidv7"
])

/** One of PostgreSQL's plain types that is a field descriptor by itself. */
export type PlainMember = Exclude<keyof typeof plainDescriptors, PlainConstructor | MintedMember>

const isPlainMember = (key: keyof typeof plainDescriptors): key is PlainMember =>
	key !== "numeric" && key !== "vector" && key !== "tsvector" && !mintedMembers.has(key)

/** Every plain type that is a field descriptor by itself, in their order. */
const plainMembers: Arr.NonEmptyReadonlyArray<PlainMember> = nonEmpty(
	Arr.filter(Rec.keys(plainDescriptors), isPlainMember),
	"the plain descriptors"
)

/** A member's descriptor. */
export const plainField = (member: PlainMember): FieldBase => plainDescriptors[member]

/**
 * A refined text's pattern: the wildcard, or one character class of `width` letters from the `first`-th letter, between
 * `min` and `min + more` characters long.
 */
export type PatternSketch =
	| { readonly kind: "wildcard" }
	| {
			readonly kind: "class"
			readonly first: number
			readonly width: number
			readonly min: number
			readonly more: number
	  }

/** A contract's base: any field type but a contract, a set and a span, which no contract is over. */
export type BaseSketch =
	| { readonly kind: "pg"; readonly member: PlainMember }
	| { readonly kind: "numeric"; readonly precision: number; readonly scale: number }
	| { readonly kind: "uuid" }
	| { readonly kind: "text"; readonly pattern: PatternSketch }
	| { readonly kind: "closedId"; readonly roster: number }
	| { readonly kind: "vector"; readonly dimensions: number }

export type SketchedField =
	| BaseSketch
	| { readonly kind: "contract"; readonly name: string; readonly base: BaseSketch }
	| {
			readonly kind: "span"
			readonly endpoint: "integer" | "bigint"
			readonly width: Option.Option<number>
	  }
	| { readonly kind: "bits"; readonly roster: number }

/** The letters a character class spans: a to z. */
const letters = 26

/** A refined text's pattern, the wildcard one draw in five. */
const patternSketchGen: Gen<PatternSketch> = weighted<PatternSketch>([
	[1, (): PatternSketch => ({ kind: "wildcard" })],
	[
		4,
		(source) => {
			const first = source.draw(int(0, letters - 1))
			return {
				kind: "class",
				first,
				width: source.draw(int(1, letters - first)),
				min: source.draw(int(0, 4)),
				more: source.draw(int(0, 4))
			}
		}
	]
])

/** The pattern's source and flags. */
const patternOf = (p: PatternSketch): { readonly source: string; readonly flags: "u" | "su" } => {
	if (p.kind === "wildcard") {
		return { source: "^.*$", flags: "su" }
	}
	const low = String.fromCharCode(0x61 + p.first)
	const high = String.fromCharCode(0x61 + p.first + p.width - 1)
	return { source: `^[${low}-${high}]{${p.min},${p.min + p.more}}$`, flags: "u" }
}

/** A numeric over the whole typmod box: precision 1 to 1000, scale -1000 to 1000. */
const numericSketchGen: Gen<Extract<BaseSketch, { readonly kind: "numeric" }>> = (source) => ({
	kind: "numeric",
	precision: source.draw(int(1, 1000)),
	scale: source.draw(int(-1000, 1000))
})

const memberGen: Gen<PlainMember> = (source) =>
	Arr.getUnsafe(plainMembers, source.draw(int(0, plainMembers.length - 1)))

/** The base arms over `rosters` rosters, `member` drawing a `pg` member: one per kind a contract may be over. */
const baseArms = (
	rosters: number,
	member: Gen<PlainMember>
): Arr.NonEmptyReadonlyArray<Gen<BaseSketch>> => [
	map(member, (m): BaseSketch => ({ kind: "pg", member: m })),
	numericSketchGen,
	(): BaseSketch => ({ kind: "uuid" }),
	map(patternSketchGen, (pattern): BaseSketch => ({ kind: "text", pattern })),
	map(int(0, rosters - 1), (roster): BaseSketch => ({ kind: "closedId", roster })),
	map(int(1, 16_000), (dimensions): BaseSketch => ({ kind: "vector", dimensions }))
]

/** A field sketch over `rosters` rosters (at least one), each kind equally often, contracts named by `contractName`. */
export const fieldSketchGen = (rosters: number, contractName: Gen<string>): Gen<SketchedField> =>
	oneOf<SketchedField>([
		...baseArms(rosters, memberGen),
		(source) => ({
			kind: "contract",
			name: source.draw(contractName),
			base: source.draw(oneOf(baseArms(rosters, memberGen)))
		}),
		(source) => ({
			kind: "span",
			endpoint: source.draw(boolean) ? "bigint" : "integer",
			width: source.draw(option(int(1, 1000)))
		}),
		map(int(0, rosters - 1), (roster): SketchedField => ({ kind: "bits", roster }))
	])

const baseOf = (s: BaseSketch, rosters: Arr.NonEmptyReadonlyArray<DrawnRoster>): FieldBase => {
	switch (s.kind) {
		case "pg":
			return plainField(s.member)
		case "numeric":
			return numeric(s.precision, s.scale)
		case "uuid":
			return Id
		case "text": {
			const p = patternOf(s.pattern)
			return regex(p.source, p.flags)
		}
		case "closedId":
			return rawClosedId(Arr.getUnsafe(rosters, s.roster))
		case "vector":
			return vector(s.dimensions)
	}
}

/** The descriptor a sketch declares, its closed ids and sets over `rosters`. */
export const fieldOf = (
	s: SketchedField,
	rosters: Arr.NonEmptyReadonlyArray<DrawnRoster>
): FieldBase => {
	switch (s.kind) {
		case "contract":
			return bareContract(s.name, baseOf(s.base, rosters))
		case "span":
			return Option.match(s.width, {
				onNone: () => rawSpan(s.endpoint === "bigint" ? int8 : int4),
				onSome: (width) =>
					s.endpoint === "bigint" ? rawSpan(int8, BigInt(width)) : rawSpan(int4, width)
			})
		case "bits":
			return bit(Arr.getUnsafe(rosters, s.roster))
		case "pg":
		case "numeric":
		case "uuid":
		case "text":
		case "closedId":
		case "vector":
			return baseOf(s, rosters)
	}
}
