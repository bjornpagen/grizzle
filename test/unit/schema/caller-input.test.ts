import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { constantColumn } from "#compiler/core/decoder.ts"
import { bits, closedId, pg, uuid } from "#compiler/public/fields.ts"
import { str } from "#compiler/public/text.ts"
import { closed } from "#compiler/schema/api.ts"
import { carrierUnion } from "#compiler/schema/record.ts"
import { admitContext } from "#compiler/schema/world.ts"
import type { Carrier } from "#compiler/types/core/phantom.ts"
import { throwsRefused } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * Caller input a builder refuses as such, never as an internal defect.
 *
 * Union carriers. Oracle: the column rule stated as a checker over the carrier kinds alone, a second statement of
 * schema/record.ts columnsMeet: a set meets only a set of its roster, since no head literal is a set; a closed id meets
 * only a closed id of its roster or a head literal; and any other two carriers meet here (the checker judges their SQL
 * types). The space is
 * every ordered pair of seven carriers, exhausted: two rosters' closed ids and sets, an integer, a text and a head
 * literal's.
 *
 * Context claims. Oracle: a claim is a value the caller's token states, so a field its sequence writes is none; every
 * serial spelling is refused (ContextRefused) and its plain integer admitted, exhausted over the six spellings.
 */
const Kind = closed("Kind", ["a", "b"])
const Mode = closed("Mode", ["a", "b"])

type CarrierKind =
	| { readonly kind: "code"; readonly roster: string }
	| { readonly kind: "bits"; readonly roster: string }
	| { readonly kind: "plain" }
	| { readonly kind: "literal" }

interface Arm {
	readonly label: string
	readonly carrier: Carrier
	readonly kind: CarrierKind
}

/** A head literal's carrier: the constant column a union's literal arm delivers. */
const literalCarrier: Carrier = Object.freeze({
	column: constantColumn(
		"a",
		(text: string) => text,
		(literal: unknown, host: unknown) => literal === host
	),
	sql: "text"
})

const arms: Arr.NonEmptyReadonlyArray<Arm> = [
	{ label: "closedId(Kind)", carrier: closedId(Kind), kind: { kind: "code", roster: "Kind" } },
	{ label: "closedId(Mode)", carrier: closedId(Mode), kind: { kind: "code", roster: "Mode" } },
	{ label: "bits(Kind)", carrier: bits(Kind), kind: { kind: "bits", roster: "Kind" } },
	{ label: "bits(Mode)", carrier: bits(Mode), kind: { kind: "bits", roster: "Mode" } },
	{ label: "integer", carrier: pg.integer, kind: { kind: "plain" } },
	{ label: "text", carrier: str.regex("^[a-z]{1,8}$"), kind: { kind: "plain" } },
	{ label: "a head literal", carrier: literalCarrier, kind: { kind: "literal" } }
]

/** The rule as a checker: whether two carrier kinds meet in one union field. */
const meet = (x: CarrierKind, y: CarrierKind): boolean => {
	if (x.kind === "bits" || y.kind === "bits") {
		return x.kind === "bits" && y.kind === "bits" && x.roster === y.roster
	}
	if (x.kind === "literal" || y.kind === "literal") {
		return true
	}
	if (x.kind === "code" || y.kind === "code") {
		return x.kind === "code" && y.kind === "code" && x.roster === y.roster
	}
	return true
}

const pairs: Arr.NonEmptyReadonlyArray<readonly [Arm, Arm]> = Arr.flatMap(arms, (x) =>
	Arr.map(arms, (y) => [x, y] as const)
)

const serials = [
	["smallserial", pg.smallserial],
	["serial2", pg.serial2],
	["serial", pg.serial],
	["serial4", pg.serial4],
	["bigserial", pg.bigserial],
	["serial8", pg.serial8]
] as const

describe("caller input", () => {
	it.effect("refuses a union of carriers that meet no column, and unites every other pair", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/schema/caller-input-union",
					generator: element(pairs),
					literal: ([x, y]: readonly [Arm, Arm]) => Formatter.format([x.label, y.label]),
					limit: pairs.length,
					box: "every ordered pair of seven carriers: two rosters' closed ids and sets, an integer, a text and a head literal",
					oracle: {
						kind: "specification",
						name: "a set meets only a set of its roster, a closed id only one of its roster or a head literal, any other pair here"
					},
					coverage: requiredInSpace<"united" | "refused">(["united", "refused"]),
					caseHang
				},
				([x, y], c) =>
					Effect.sync(() => {
						const united = () => carrierUnion({ v: x.carrier }, { v: y.carrier })
						if (meet(x.kind, y.kind)) {
							c.note("united")
							united()
							return
						}
						c.note("refused")
						throwsRefused(united, "MalformedDescription", `${x.label} and ${y.label}`)
					})
			)
		)
	)

	it.effect("refuses a serial as a context claim, and admits its integer", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/schema/caller-input-claims",
					generator: element(serials),
					literal: ([label]: (typeof serials)[number]) => label,
					limit: serials.length,
					box: "every serial spelling of pg, beside its bigint",
					oracle: {
						kind: "specification",
						name: "a claim is a value the caller's token states, which no field its sequence writes is"
					},
					coverage: requiredInSpace<"refused">(["refused"]),
					caseHang
				},
				([label, serial], c) =>
					Effect.sync(() => {
						c.note("refused")
						throwsRefused(
							() => admitContext("Claims", { id: uuid, n: serial }, undefined, []),
							"ContextRefused",
							label
						)
						admitContext("Claims", { id: uuid, n: pg.bigint }, undefined, [])
					})
			)
		)
	)
})
