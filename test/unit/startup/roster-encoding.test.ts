/**
 * A predicate's canonical encoding is linear in its own terms, whatever the size of the rosters it reads: a closed id's
 * type names its roster by its name and its handles' digest (ir/scalar.ts Roster), taken once as the roster is made, so
 * no literal, column or closed read of a closed id carries the roster's handles.
 *
 * Each case draws a guard, the selection a key of T is over: up to three atoms joined by and or or, each a closed id
 * `kind` compared with a handle, held to an IN list of one, or read through a closed relation `Weight.at("weight",
 * kind)`, or an integer `n` compared with a number; and two sizes of the roster Kind, from 1 to 5,000 handles, every
 * handle's name four digits wide so no name's own length tells two sizes apart, Weight holding a row for each. The
 * oracle: the canonical text of every guard of T's guarded keys, the encoding every digest, law identity and snapshot
 * of the guard reads, holds the same characters at both sizes.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { compileLaws } from "#compiler/laws/model/model.ts"
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { closed, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"
import { ownedInput } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"

/** An atom of a guard. */
type Atom =
	| { readonly kind: "handle"; readonly op: "eq" | "ne" }
	| { readonly kind: "in" }
	| { readonly kind: "closed read"; readonly op: "eq" | "ge"; readonly value: number }
	| { readonly kind: "integer"; readonly op: "eq" | "lt"; readonly value: number }

/** A guard: its atoms, joined by and or by or. */
interface Guard {
	readonly atoms: Arr.NonEmptyReadonlyArray<Atom>
	readonly join: "and" | "or"
}

interface EncodingCase {
	readonly guard: Guard
	readonly sizes: readonly [number, number]
}

const atomGen: Gen<Atom> = (source) => {
	switch (source.draw(element(["handle", "in", "closed read", "integer"] as const))) {
		case "handle":
			return { kind: "handle", op: source.draw(element(["eq", "ne"] as const)) }
		case "in":
			return { kind: "in" }
		case "closed read":
			return {
				kind: "closed read",
				op: source.draw(element(["eq", "ge"] as const)),
				value: source.draw(int(0, 9))
			}
		case "integer":
			return {
				kind: "integer",
				op: source.draw(element(["eq", "lt"] as const)),
				value: source.draw(int(0, 9))
			}
	}
}

/** A roster's size, from 1 to 5,000 handles. */
const rosterSize = int(1, 5000)

const caseGen: Gen<EncodingCase> = (source) => {
	const [first, ...rest] = source.draw(array(atomGen, { min: 1, max: 3 }))
	return {
		guard: {
			atoms: [defined(first, "a drawn atom"), ...rest],
			join: source.draw(element(["and", "or"] as const))
		},
		sizes: [source.draw(rosterSize), source.draw(rosterSize)]
	}
}

/** The handle at a code: four digits wide, so every handle's name is one length. */
const handleAt = (i: number): string => `h${Str.padStart(4, "0")(String(i))}`

/** The characters of the canonical text of every guard of T's guarded keys, the roster Kind of `size` handles. */
const encodedAt = (guard: Guard, size: number): number => {
	const handles = nonEmptyList(upTo(size, handleAt), "the roster's handles")
	const Kind = closed("Kind", handles)
	const Weight = closed.relation(
		"Weight",
		{ kind: closedId(Kind), weight: pg.integer },
		["kind"],
		Arr.map(handles, (kind, weight) => ({ kind, weight }))
	)
	const T = relation("T", { id: uuid, kind: closedId(Kind), n: pg.integer, a: uuid }, ["id"])
	const first = handleAt(0)
	const S = schema("Encoded", { Kind, Weight, T }, [
		key(
			on(
				select(T, (t) => {
					const atom = (a: Atom) => {
						switch (a.kind) {
							case "handle":
								return a.op === "eq" ? t.eq(t.kind, first) : t.ne(t.kind, first)
							case "in":
								return t.in(t.kind, [first])
							case "closed read":
								return a.op === "eq"
									? t.eq(Weight.at("weight", t.kind), a.value)
									: t.ge(Weight.at("weight", t.kind), a.value)
							case "integer":
								return a.op === "eq" ? t.eq(t.n, a.value) : t.lt(t.n, a.value)
						}
					}
					const [p, q, r] = Arr.map(guard.atoms, atom)
					if (q === undefined) {
						return p
					}
					if (r === undefined) {
						return guard.join === "and" ? t.and(p, q) : t.or(p, q)
					}
					return guard.join === "and" ? t.and(p, q, r) : t.or(p, q, r)
				}),
				"a"
			)
		)
	])
	const owned = succeeded(ownedInput(S))
	const model = succeeded(
		compileLaws(owned, everySlice(owned), { kind: "planned" }),
		"the schema compiles"
	)
	const laws = defined(model.relations.get("T"), "T's laws")
	return Arr.reduce(laws.uniques.others, 0, (n, u) =>
		u.kind === "guarded"
			? Arr.reduce(u.within, n, (m, g) => m + canonicalTextOf(g.predicate).length)
			: n
	)
}

type EncodingFeature =
	| "a handle compared"
	| "an IN list"
	| "a closed read"
	| "an integer compared"
	| "a disjunction"
	| "a roster of one handle"
	| "a roster of thousands"

const featuresOf = (c: EncodingCase): ReadonlyArray<EncodingFeature> => [
	...Arr.map(c.guard.atoms, (a): EncodingFeature => {
		switch (a.kind) {
			case "handle":
				return "a handle compared"
			case "in":
				return "an IN list"
			case "closed read":
				return "a closed read"
			case "integer":
				return "an integer compared"
		}
	}),
	...(c.guard.join === "or" && c.guard.atoms.length > 1 ? ["a disjunction" as const] : []),
	...(Arr.some(c.sizes, (n) => n === 1) ? ["a roster of one handle" as const] : []),
	...(Arr.some(c.sizes, (n) => n >= 1000) ? ["a roster of thousands" as const] : [])
]

describe("a predicate's canonical encoding", () => {
	it.effect("holds the same characters whatever the size of the rosters it reads", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/startup/roster-encoding",
					draw: drawn(caseGen),
					literal: Formatter.format,
					coverage: required<EncodingFeature>(
						[
							"a handle compared",
							"an IN list",
							"a closed read",
							"an integer compared",
							"a disjunction",
							"a roster of one handle",
							"a roster of thousands"
						],
						{ cases: 40, sense: notesOnly }
					),
					kept: [],
					runs: 40,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(c, k) =>
					Effect.sync(() => {
						const [small, large] = c.sizes
						const at = encodedAt(c.guard, small)
						assert.ok(at > 0, "a guard encodes")
						assert.equal(
							encodedAt(c.guard, large),
							at,
							`the guard's encoding at ${small} handles against ${large}`
						)
						k.noteAll(featuresOf(c))
					})
			)
		)
	)
})
