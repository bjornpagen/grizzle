/** What the properties of gist.test.ts read: its spaces, models and helpers. */

import { boolean, constant, element, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, pipe, Record as Rec, String as Str } from "effect"
import { allenFormula } from "#compiler/allen/lower.ts"
import { fullAllenMask, parseAllenMask } from "#compiler/allen/mask.ts"
import { allenRelations } from "#compiler/core/allen.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { FieldDesc, QueryDesc } from "#compiler/ir/desc.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { pg, span, uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { compileSpans } from "#test/pg/spans/allen/support.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import { decodedQuery, type AuthoredExprDesc as ExprDesc } from "#test/support/fixtures/ir/desc.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import { type ScriptInstall, filledScriptTemplate } from "#test/support/script-template.ts"
import { volumeFill } from "#test/support/substrate/fill.ts"
import { Substrate, type SubstrateCase, worldSession } from "#test/support/substrate/substrate.ts"

const Booking = relation("Booking", { room: uuid, during: span(pg.bigint), guest: uuid }, [
	"room",
	"during"
])

const Visit = relation(
	"Visit",
	{ id: pg.integer, room: uuid, during: span(pg.bigint), note: pg.integer },
	["id"]
)

export const Rooms = schema("Rooms", [Booking, Visit], [])

/** The workload program whose span predicate requests Visit's GiST (room, during): one room's visits meeting a window. */
const visitsInWindow = query(Rooms).rule((r) => {
	const { id, during } = v(Visit, "visit")
	return r
		.match(Visit, { id, room: r.param("room", Visit.fields.room), during })
		.where(r.allen(during, ALLEN.intersects, r.param("w", Visit.fields.during)))
		.find({ id })
})

export const relationNames = ["Booking", "Visit"] as const

type RelationName = (typeof relationNames)[number]

/** A field of each relation that no index holds, so no index scan of a whole index can produce the head. */
const outsideField: Readonly<Record<RelationName, string>> = { Booking: "guest", Visit: "note" }

/**
 * Booking holds `perRoom` spans [10k, 10k + 5) per room, so its spans lie in [0, 10·perRoom); Visit holds
 * rooms·perRoom spans [i, i + 1 + i mod 7), across the rooms in turn, so its spans lie in [0, rooms·perRoom + 7).
 */
const sizes = [
	{ name: "100 rows", rooms: 4, perRoom: 25 },
	{ name: "4000 rows", rooms: 20, perRoom: 200 }
] as const

type Size = (typeof sizes)[number]

export const spanTop = (size: Size, relationName: RelationName): number =>
	relationName === "Booking" ? size.perRoom * 10 : size.rooms * size.perRoom

export const roomId = (r: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(r.toString(16), Str.padStart(12, "0"))}`

/**
 * A rule over `relationName` with its span bound to `s`, filtered by `where`, and, by room, its room bound to the
 * parameter `room`; its head is the span and the field the GiST does not hold.
 */
export const roomRule = (
	relationName: RelationName,
	where: ExprDesc,
	prefix: Prefix
): QueryDesc => {
	const outside = outsideField[relationName]
	return decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: [
					{ id: "s", origin: { relation: relationName, field: "during" } },
					{ id: "o", origin: { relation: relationName, field: outside } }
				],
				matches: [
					{
						source: { kind: "relation", name: relationName },
						bindings:
							prefix === "by room"
								? {
										room: { kind: "param", name: "room", type: { kind: "uuid" } },
										during: { kind: "var", var: "s" },
										[outside]: { kind: "var", var: "o" }
									}
								: { during: { kind: "var", var: "s" }, [outside]: { kind: "var", var: "o" } }
					}
				],
				where: [where],
				head: { s: { kind: "var", var: "s" }, o: { kind: "var", var: "o" } },
				interiors: [],
				attach: []
			}
		]
	})
}

/** The declared type of the window parameter w: a span over bigint, as Visit's and Booking's during. */
const bigintSpan: FieldDesc = {
	kind: "span",
	endpoint: { kind: "pg", type: "bigint" },
	width: undefined
}

export const allenWhere = (mask: number): ExprDesc => ({
	kind: "allen",
	left: { kind: "var", var: "s" },
	mask,
	right: { kind: "param", name: "w", type: bigintSpan }
})

export const pointWhere: ExprDesc = {
	kind: "pointIn",
	point: { kind: "param", name: "t", type: { kind: "pg", type: "bigint" } },
	span: { kind: "var", var: "s" }
}

/** r.pointIn(Compute.lower(s), w) or r.pointIn(Compute.upper(s), w). */
export const endpointWhere = (upper: boolean): ExprDesc => ({
	kind: "pointIn",
	point: { kind: "compute", fn: upper ? "upper" : "lower", args: [{ kind: "var", var: "s" }] },
	span: { kind: "param", name: "w", type: bigintSpan }
})

/** The masks planted beside any other: each basic relation and each named mask. */
const plantedMasks: Arr.NonEmptyReadonlyArray<number> = Arr.appendAll(
	Arr.map(allenRelations, (r) => ALLEN[r]),
	[ALLEN.intersects, ALLEN.covers, ALLEN.within, ALLEN.precedes]
)

/**
 * One drawn plan: a data size, a predicate (a mask other than the full one, pointIn, or the span's lower or upper
 * endpoint in the window), and the room, window and point picks its parameters take. A case reads each relation under
 * the predicate, with the room prefix bound and without, so every case reaches every relation and prefix.
 */
interface PlanSketch {
	readonly size: Size
	readonly predicate:
		| { readonly kind: "allen"; readonly mask: number }
		| { readonly kind: "pointIn" }
		| { readonly kind: "endpointIn"; readonly upper: boolean }
	readonly room: number
	readonly start: number
	readonly length: number
}

const predicateGen: Gen<PlanSketch["predicate"]> = oneOf<PlanSketch["predicate"]>([
	map(oneOf([element(plantedMasks), int(1, fullAllenMask - 1)]), (mask) => ({
		kind: "allen",
		mask
	})),
	constant({ kind: "pointIn" }),
	map(boolean, (upper) => ({ kind: "endpointIn", upper }))
])

export const planSketchGen: Gen<PlanSketch> = (source) => ({
	size: source.draw(element<Size>(sizes)),
	predicate: source.draw(predicateGen),
	room: source.draw(int(0, 2 ** 31 - 1)),
	start: source.draw(int(0, 2 ** 31 - 1)),
	length: source.draw(int(1, 40))
})

/** What a plan's predicate is: a formula of one disjunct, a union of several, pointIn, or an endpoint in the window. */
type PredicateKind = "one disjunct" | "a union" | "pointIn" | "an endpoint in the window"

/** Whether a read binds the room prefix of the GiST's key. */
type Prefix = "by room" | "unprefixed"

export const prefixes = ["by room", "unprefixed"] as const satisfies ReadonlyArray<Prefix>

export type PlanFeature = `${RelationName} ${PredicateKind} ${Prefix}` | `size ${Size["name"]}`

const predicateKinds: Arr.NonEmptyReadonlyArray<PredicateKind> = [
	"one disjunct",
	"a union",
	"pointIn",
	"an endpoint in the window"
]

export const predicateKind = (predicate: PlanSketch["predicate"]): PredicateKind => {
	if (predicate.kind === "pointIn") {
		return "pointIn"
	}
	if (predicate.kind === "endpointIn") {
		return "an endpoint in the window"
	}
	const mask = defined(parseAllenMask(predicate.mask), `the mask ${predicate.mask}`)
	return allenFormula(mask).length === 1 ? "one disjunct" : "a union"
}

export const requiredFeatures: Arr.NonEmptyReadonlyArray<PlanFeature> = [
	...Arr.flatMap(relationNames, (r) =>
		Arr.flatMap(predicateKinds, (k) => Arr.map(prefixes, (p): PlanFeature => `${r} ${k} ${p}`))
	),
	...Arr.map(sizes, (s): PlanFeature => `size ${s.name}`)
]

/** One installation per data size, filled and analyzed, with its reader. */
/** Every size's Rooms, its spans' GiST requests and its rows filled once per member (gistTemplate), by its name. */
export const gistTemplates = Rec.fromEntries(
	Arr.map(sizes, (size) => [size.name, gistTemplate(size)] as const)
)

/**
 * Rooms installed through the fresh-install compiler with its workload's GiST requests, its Booking and Visit filled to
 * `size` and vacuumed and analyzed, once per member (script-template.ts filledScriptTemplate), where the search
 * installed and filled every size once before its cases: each case only plans and reads.
 */
const gistTemplate = (size: Size) =>
	filledScriptTemplate({
		declaredIn: import.meta,
		name: `gist ${size.name}`,
		label: "gist",
		compile: (schema) =>
			compileSpans(Rooms, schema, {
				label: "gist",
				extensions: [
					workloadExtension(
						succeeded(
							compileTestWorkload(
								[{ login: "server", workloads: [workload(Rooms, { visitsInWindow })] }],
								Rooms,
								testCompile
							),
							"the workload compiles"
						)
					)
				]
			}),
		fill: (installed) =>
			Effect.gen(function* () {
				const s = yield* Substrate
				const schemaName = quoteIdent(installed.schema)
				yield* volumeFill(s.admin, [
					{
						tables: [
							{
								table: `${schemaName}."booking"`,
								columns: [
									[
										'"room"',
										`('00000000-0000-4000-8000-' || lpad(to_hex(g / ${size.perRoom}), 12, '0'))::uuid`
									],
									[
										'"during"',
										`int8range((g % ${size.perRoom}) * 10, (g % ${size.perRoom}) * 10 + 5)`
									],
									[
										'"guest"',
										`md5((g / ${size.perRoom})::text || ':' || (g % ${size.perRoom})::text)::uuid`
									]
								]
							}
						],
						rows: size.rooms * size.perRoom,
						conflicts: "refused"
					},
					{
						tables: [
							{
								table: `${schemaName}."visit"`,
								columns: [
									['"id"', "g"],
									[
										'"room"',
										`('00000000-0000-4000-8000-' || lpad(to_hex(g % ${size.rooms}), 12, '0'))::uuid`
									],
									['"during"', "int8range(g, g + 1 + g % 7)"],
									['"note"', "g % 13"]
								]
							}
						],
						rows: size.rooms * size.perRoom,
						conflicts: "refused"
					}
				])
				yield* s.admin.queryValues(`VACUUM ANALYZE ${schemaName}."booking"`, [])
				yield* s.admin.queryValues(`VACUUM ANALYZE ${schemaName}."visit"`, [])
			})
	})

/**
 * A case's installation of a size over its clone of the size's template (gistTemplates): a reader session of its world,
 * and each relation's GiST, Booking's span key, a primary WITHOUT OVERLAPS over its span, and the access index the
 * engine created over Visit's (room, during).
 */
export const gistIn = (taken: SubstrateCase<ScriptInstall>) =>
	Effect.gen(function* () {
		const installed = taken.value
		const reader = yield* taken.substrate.session({
			...worldSession(installed.world),
			label: "reader"
		})
		const names = installationNamesOf(installed.installation)
		const gist: Readonly<Record<RelationName, string>> = {
			Booking: names.fieldConstraint(Booking, "pk", ["room", "during"]),
			Visit: names.accessIndex(Visit, ["room", "during"])
		}
		return { installed, reader, gist }
	})
