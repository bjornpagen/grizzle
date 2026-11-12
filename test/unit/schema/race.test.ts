/**
 * race(R) at the schema door (schema/own.ts): a race over an ordinary relation's primary key owns exactly where an
 * insertion at that key can meet a row that differs from it and deliver that row, and is refused with
 * MalformedDescription everywhere else. The box is every race of a space: over an ordinary relation whose primary key
 * has a payload beside it, is its whole heading, holds a span or holds a field the database draws, mutable or not; over
 * a family's member or owner, mutable or not; and over a roster. The oracle restates the rule per case: it owns iff the
 * relation is ordinary, its key has a payload, holds no span and no drawn field, the relation is not mutable and no
 * family holds it; an owned race makes the raced relation's insertions race and leaves every other relation's
 * repeatable.
 *
 * Plant (~/.cache/grizzle-release/LEASE/plants/race-span-key-admitted): the span key's refusal dropped.
 *
 * Features: each case of the space.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Record as Rec } from "effect"
import * as Result from "#compiler/core/result.ts"
import { parseSchemaInput } from "#compiler/program/schema.ts"
import { drawn, natural, pg, span, uuid } from "#compiler/public/fields.ts"
import {
	closed,
	counted,
	fin,
	mutable,
	on,
	race,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { raceBuilder } from "#compiler/schema/statements.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownInput } from "#test/support/policy.ts"

/** How a plainly keyed R's primary key stands: beside a payload, as its whole heading, over a span, or drawn. */
const keys = ["payload", "whole", "span", "drawn"] as const
type KeyShape = (typeof keys)[number]

/** A race of the space: over a plainly keyed R, a family's member or owner, or a roster. */
type RaceCase =
	| { readonly kind: "plain"; readonly key: KeyShape; readonly mutable: boolean }
	| { readonly kind: "family"; readonly part: "member" | "owner"; readonly mutable: boolean }
	| { readonly kind: "roster" }

const raceCaseGen: Gen<RaceCase> = (source) => {
	const kind = source.draw(element(["plain", "family", "roster"] as const))
	switch (kind) {
		case "plain":
			return { kind, key: source.draw(element(keys)), mutable: source.draw(boolean) }
		case "family":
			return {
				kind,
				part: source.draw(element(["member", "owner"] as const)),
				mutable: source.draw(boolean)
			}
		case "roster":
			return { kind }
	}
}

/** How each key shape reads in a case's text. */
const keyText = {
	payload: "keyed beside a payload",
	whole: "keyed by its whole heading",
	span: "keyed over a span",
	drawn: "keyed by a drawn field"
} as const

/** What a mutable case adds to its text. */
const mutableText = (mutable: boolean) => (mutable ? (", mutable" as const) : ("" as const))

/** A case's text, each case's its own: the features of the space. */
type RaceFeature =
	| `race over a relation ${(typeof keyText)[KeyShape]}${ReturnType<typeof mutableText>}`
	| `race over a family's ${"member" | "owner"}${ReturnType<typeof mutableText>}`
	| "race over a roster"

const caseText = (c: RaceCase): RaceFeature => {
	switch (c.kind) {
		case "plain":
			return `race over a relation ${keyText[c.key]}${mutableText(c.mutable)}` as const
		case "family":
			return `race over a family's ${c.part}${mutableText(c.mutable)}` as const
		case "roster":
			return "race over a roster"
	}
}

/** R keyed as `key` says. */
const plainR = (key: KeyShape) => {
	switch (key) {
		case "payload":
			return relation("R", { k: uuid, holder: uuid }, ["k"])
		case "whole":
			return relation("R", { k: uuid, holder: uuid }, ["k", "holder"])
		case "span":
			return relation("R", { k: uuid, during: span(pg.bigint), holder: uuid }, ["k", "during"])
		case "drawn":
			return relation("R", { k: pg.uuidv7, holder: uuid }, ["k"])
	}
}

/** The schema a case states: R and the race over it, mutable where the case is, and the family that holds it. */
const schemaOf = (c: RaceCase): unknown => {
	switch (c.kind) {
		case "plain": {
			const R = plainR(c.key)
			return schema("Races", [R], c.mutable ? [race(R), mutable(R)] : [race(R)])
		}
		case "family": {
			if (c.part === "member") {
				const R = relation("R", { o: uuid, n: pg.integer, holder: uuid }, ["o", "n"])
				const O = relation("O", { id: uuid, n: drawn(natural) }, ["id"])
				const family = counted(on(R, "o"), fin(O, "n"))
				return schema(
					"Races",
					[R, O],
					c.mutable ? [family, race(R), mutable(R)] : [family, race(R)]
				)
			}
			const R = relation("R", { id: uuid, holder: uuid, n: drawn(natural) }, ["id"])
			const M = relation("M", { o: uuid, n: pg.integer }, ["o", "n"])
			const family = counted(on(M, "o"), fin(R, "n"))
			return schema("Races", [R, M], c.mutable ? [family, race(R), mutable(R)] : [family, race(R)])
		}
		case "roster": {
			const R = closed("R", ["a", "b"])
			return schema("Races", [R], [raceBuilder(R)])
		}
	}
}

/** The oracle: whether a case's race owns. */
const owns = (c: RaceCase): boolean => c.kind === "plain" && c.key === "payload" && !c.mutable

describe("race(R)", () => {
	it.effect(
		"owns over an ordinary relation whose primary key has a payload, holds no span and no drawn field, neither mutable nor a family's, raced alone, and is refused as MalformedDescription over every other",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/schema/race",
						generator: raceCaseGen,
						literal: caseText,
						box: "a race over a relation keyed beside a payload, by its whole heading, over a span or by a drawn field, mutable or not; over a family's member or owner, mutable or not; and over a roster",
						oracle: {
							kind: "specification",
							name: "the race's rule restated per case: an ordinary relation, its key with a payload, of no span or drawn field, neither mutable nor a family's"
						},
						coverage: requiredInSpace<RaceFeature>([
							caseText({ kind: "roster" }),
							...Arr.flatMap(keys, (key) =>
								Arr.map([false, true], (m) => caseText({ kind: "plain", key, mutable: m }))
							),
							...Arr.flatMap(["member", "owner"] as const, (part) =>
								Arr.map([false, true], (m) => caseText({ kind: "family", part, mutable: m }))
							)
						]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							k.note(caseText(c))
							const owned = Result.flatMap(parseSchemaInput(schemaOf(c)), ownInput)
							if (!owns(c)) {
								refused(owned, "MalformedDescription", caseText(c))
								return
							}
							const relations = succeeded(owned, caseText(c)).relations
							for (const [name, r] of Rec.toEntries(relations)) {
								if (r.kind === "relation") {
									assert.equal(
										r.inserts,
										name === "R" ? "race" : "repeatable",
										`${name}'s insertions`
									)
								}
							}
						})
				)
			)
	)
})
