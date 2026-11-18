/** What the properties of race.test.ts read: its spaces, models and helpers. */

import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
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

/** How a plainly keyed R's primary key stands: beside a payload, as its whole heading, over a span, or drawn. */
export const keys = ["payload", "whole", "span", "drawn"] as const

type KeyShape = (typeof keys)[number]

/** A race of the space: over a plainly keyed R, a family's member or owner, or a roster. */
type RaceCase =
	| { readonly kind: "plain"; readonly key: KeyShape; readonly mutable: boolean }
	| { readonly kind: "family"; readonly part: "member" | "owner"; readonly mutable: boolean }
	| { readonly kind: "roster" }

export const raceCaseGen: Gen<RaceCase> = (source) => {
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
export type RaceFeature =
	| `race over a relation ${(typeof keyText)[KeyShape]}${ReturnType<typeof mutableText>}`
	| `race over a family's ${"member" | "owner"}${ReturnType<typeof mutableText>}`
	| "race over a roster"

export const caseText = (c: RaceCase): RaceFeature => {
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
export const schemaOf = (c: RaceCase): unknown => {
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
			const R = closed.ordered("R", ["a", "b"])
			return schema("Races", [R], [raceBuilder(R)])
		}
	}
}

/** The oracle: whether a case's race owns. */
export const owns = (c: RaceCase): boolean =>
	c.kind === "plain" && c.key === "payload" && !c.mutable
