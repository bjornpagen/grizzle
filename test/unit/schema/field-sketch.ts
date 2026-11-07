import { boolean, type Gen, int, map, oneOf, option, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Option, Predicate, Record as Rec } from "effect"
import { bits, pg, uuid } from "#compiler/public/fields.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyRoster } from "#compiler/types/schema/relation.ts"
import { nonEmpty } from "#test/support/assert.ts"
import { bareContract, rawClosedId, rawSpan, regex } from "#test/unit/schema/support.ts"

/**
 * A field type as a caller declares it, drawn over a box its bounds define: every member of `pg` that is a descriptor by
 * itself, numeric over the whole typmod box, uuid, a refined text of a drawn character class and length or the
 * wildcard, a contract over a drawn base, a span over an integer type with or without a width, a closed id or a set
 * over one of the caller's rosters, and a vector of any admitted dimension count. A suite builds the descriptor with
 * `fieldOf` and states its own model of the sketch.
 */

/** A roster a closed id or a set is over, its handles at hand. */
export type DrawnRoster = AnyRoster & { readonly handles: Arr.NonEmptyReadonlyArray<string> }

/** The constructors of `pg` that take a typmod, which are no descriptor until called. */
type PgConstructor = "numeric" | "decimal" | "vector"

/** A member of `pg` that is a field descriptor by itself, every PostgreSQL spelling and serial form included. */
export type PgMember = Exclude<keyof typeof pg, PgConstructor>

const isPgMember = (key: keyof typeof pg): key is PgMember =>
	key !== "numeric" && key !== "decimal" && key !== "vector"

/** Every member of `pg` that is a field descriptor by itself, in the namespace's order. */
const pgMembers: Arr.NonEmptyReadonlyArray<PgMember> = nonEmpty(
	Arr.filter(Rec.keys(pg), isPgMember),
	"pg's descriptor members"
)

/** A member's descriptor. */
export const pgField = (member: PgMember): FieldBase => pg[member]

/** Whether a member is a serial form, a field its sequence writes: its descriptor's own writing. */
export const serialMember = (member: PgMember): boolean =>
	Predicate.hasProperty(pg[member], "writing")

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

/** A contract's base: any field type but a contract, a set, a span and a serial form, which no contract is over. */
export type BaseSketch =
	| { readonly kind: "pg"; readonly member: PgMember }
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
export const patternSketchGen: Gen<PatternSketch> = weighted<PatternSketch>([
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
export const patternOf = (
	p: PatternSketch
): { readonly source: string; readonly flags: "u" | "su" } => {
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

const memberGen: Gen<PgMember> = (source) =>
	Arr.getUnsafe(pgMembers, source.draw(int(0, pgMembers.length - 1)))

/** A contract base's member: any but a serial form. */
const plainMembers: Arr.NonEmptyReadonlyArray<PgMember> = nonEmpty(
	Arr.filter(pgMembers, (m) => !serialMember(m)),
	"pg's members no sequence writes"
)

/** The base arms over `rosters` rosters, `member` drawing a `pg` member: one per kind a contract may be over. */
const baseArms = (
	rosters: number,
	member: Gen<PgMember>
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
			base: source.draw(
				oneOf(
					baseArms(rosters, (s) =>
						Arr.getUnsafe(plainMembers, s.draw(int(0, plainMembers.length - 1)))
					)
				)
			)
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
			return pgField(s.member)
		case "numeric":
			return pg.numeric(s.precision, s.scale)
		case "uuid":
			return uuid
		case "text": {
			const p = patternOf(s.pattern)
			return regex(p.source, p.flags)
		}
		case "closedId":
			return rawClosedId(Arr.getUnsafe(rosters, s.roster))
		case "vector":
			return pg.vector(s.dimensions)
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
				onNone: () => rawSpan(s.endpoint === "bigint" ? pg.bigint : pg.integer),
				onSome: (width) =>
					s.endpoint === "bigint" ? rawSpan(pg.bigint, BigInt(width)) : rawSpan(pg.integer, width)
			})
		case "bits":
			return bits(Arr.getUnsafe(rosters, s.roster))
		case "pg":
		case "numeric":
		case "uuid":
		case "text":
		case "closedId":
		case "vector":
			return baseOf(s, rosters)
	}
}
