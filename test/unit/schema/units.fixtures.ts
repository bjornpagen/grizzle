/** What the property of units.test.ts reads: its space, the schema each case states and the rules it restates. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { SideDesc } from "#compiler/ir/desc.ts"
import { Logic } from "#compiler/public/compute.ts"
import { contract, natural, pg, uuid } from "#compiler/public/fields.ts"
import { mutable, relation, schema, series, unit } from "#compiler/public/schema.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { Id } from "#test/support/ids.ts"

/**
 * How R's primary key stands against the unit U, keyed { k: Id }: leading with k of U's type, with a k of another
 * type, with k second, or with a field of another name.
 */
export const leads = ["leads", "otherType", "second", "otherName"] as const

/** Two units of one schema, R keyed (k, j): nested headings, one heading under two names, one name over two headings, or apart. */
export const pairs = ["nested", "sameHeading", "sameName", "apart"] as const

/** Where U is stated beside R: at R's level, or at a level above it. */
export const levels = ["same", "above"] as const

/**
 * How a series' relation S is keyed: by one natural; by one contract over an integer, an int4 number bounded as an int4
 * serial is (TestNumber); by a natural beside another field; by a bare bigint; or by a contract over no integer.
 */
export const seriesKeys = ["natural", "integerContract", "wide", "bigint", "uuidContract"] as const

/** A case of the space: one of the four groups of the units' and the series' rules. */
export type UnitCase =
	| { readonly kind: "member"; readonly key: (typeof leads)[number] }
	| { readonly kind: "pair"; readonly pair: (typeof pairs)[number] }
	| { readonly kind: "level"; readonly at: (typeof levels)[number] }
	| {
			readonly kind: "series"
			readonly key: (typeof seriesKeys)[number]
			readonly mutable: boolean
	  }

export const unitCaseGen: Gen<UnitCase> = (source) => {
	const kind = source.draw(element(["member", "pair", "level", "series"] as const))
	switch (kind) {
		case "member":
			return { kind, key: source.draw(element(leads)) }
		case "pair":
			return { kind, pair: source.draw(element(pairs)) }
		case "level":
			return { kind, at: source.draw(element(levels)) }
		case "series":
			return {
				kind,
				key: source.draw(element(seriesKeys)),
				mutable: source.draw(element([false, true] as const))
			}
	}
}

/** A case's text, each case's its own: the features of the space. */
export type UnitFeature =
	| `R keyed ${(typeof leads)[number]}`
	| `two units ${(typeof pairs)[number]}`
	| `unit stated ${(typeof levels)[number]}`
	| `series keyed ${(typeof seriesKeys)[number]}${"" | ", mutable"}`

export const caseText = (c: UnitCase): UnitFeature => {
	switch (c.kind) {
		case "member":
			return `R keyed ${c.key}`
		case "pair":
			return `two units ${c.pair}`
		case "level":
			return `unit stated ${c.at}`
		case "series":
			return `series keyed ${c.key}${c.mutable ? ", mutable" : ""}`
	}
}

/** An id of another type than Id, by its own contract over the same base. */
const OtherId = contract("OtherId", uuid)

/** A number kept in an int4, bounded below the int4 serial's greatest value, as a test's number is. */
const TestNumber = contract("TestNumber", pg.integer, (n) =>
	Logic.and(Logic.ge(n, 0), Logic.le(n, 2147483646))
)

/** R keyed as a member case says. */
const memberR = (key: (typeof leads)[number]) => {
	switch (key) {
		case "leads":
			return relation("R", { k: Id, n: pg.integer }, ["k", "n"])
		case "otherType":
			return relation("R", { k: OtherId, n: pg.integer }, ["k", "n"])
		case "second":
			return relation("R", { n: pg.integer, k: Id }, ["n", "k"])
		case "otherName":
			return relation("R", { other: Id, n: pg.integer }, ["other", "n"])
	}
}

/** The units a pair case states, over R keyed (k, j). */
const unitsOf = (pair: (typeof pairs)[number]) => {
	switch (pair) {
		case "nested":
			return [unit("U", { k: Id }), unit("V", { k: Id, j: pg.integer })]
		case "sameHeading":
			return [unit("U", { k: Id }), unit("V", { k: Id })]
		case "sameName":
			return [unit("U", { k: Id }), unit("U", { j: pg.integer })]
		case "apart":
			return [unit("U", { k: Id }), unit("V", { j: pg.integer })]
	}
}

/** The type of S's number under each series key. */
const numberTypes = {
	natural,
	integerContract: TestNumber,
	wide: natural,
	bigint: pg.bigint,
	uuidContract: OtherId
} as const

/** S keyed as a series case says. */
const seriesS = (key: (typeof seriesKeys)[number]) =>
	relation(
		"S",
		{ number: numberTypes[key], held: pg.boolean },
		key === "wide" ? ["number", "held"] : ["number"]
	)

/** The schema a case states, and the series statement of a series case, whose laws its check reads. */
export const schemaOf = (
	c: UnitCase
): { readonly schema: AnySchema; readonly series: ReturnType<typeof series> | undefined } => {
	switch (c.kind) {
		case "member":
			return {
				schema: schema("Units", [memberR(c.key)], [unit("U", { k: Id })]),
				series: undefined
			}
		case "pair": {
			const R = relation("R", { k: Id, j: pg.integer }, ["k", "j"])
			return { schema: schema("Units", [R], unitsOf(c.pair)), series: undefined }
		}
		case "level": {
			const R = relation("R", { k: Id, n: pg.integer }, ["k", "n"])
			const T = relation("T", { t: pg.integer }, ["t"])
			if (c.at === "same") {
				const base = schema("Units", [R], [unit("U", { k: Id })])
				return { schema: schema.extend([base], "Above", [T], []), series: undefined }
			}
			const base = schema("Units", [R], [])
			return {
				schema: schema.extend([base], "Above", [T], [unit("U", { k: Id })]),
				series: undefined
			}
		}
		case "series": {
			const S = seriesS(c.key)
			const stated = series(S)
			return {
				schema: schema(
					"Units",
					[S],
					c.mutable
						? [stated, unit("Numbers", { number: numberTypes[c.key] }), mutable(S)]
						: [stated]
				),
				series: stated
			}
		}
	}
}

/**
 * The oracle: whether a case's statements build, series(S) refusing at once a relation keyed by no one field of a type
 * grizzle draws, natural or a contract over an integer.
 */
export const builds = (c: UnitCase): boolean => c.kind !== "series" || drawnKey(c.key)

/** Whether a series key is one field of a type grizzle draws, as drawn(c) takes it: natural or a contract over an integer. */
const drawnKey = (key: (typeof seriesKeys)[number]): boolean => {
	switch (key) {
		case "natural":
		case "integerContract":
			return true
		case "wide":
		case "bigint":
		case "uuidContract":
			return false
	}
}

/** The oracle: whether a case's schema owns, by the rules of README "Units" restated. */
export const owns = (c: UnitCase): boolean => {
	switch (c.kind) {
		case "member":
			return true
		case "pair":
			return c.pair === "apart"
		case "level":
			return c.at === "same"
		case "series":
			return drawnKey(c.key) && !c.mutable
	}
}

/** The oracle: R's unit and the fields holding its key, where the case's schema owns: none where R leads with no unit's heading. */
export const unitOfR = (
	c: UnitCase
): { readonly unit: string; readonly fields: ReadonlyArray<string> } | undefined => {
	switch (c.kind) {
		case "member":
			return c.key === "leads" ? { unit: "U", fields: ["k"] } : undefined
		case "pair":
		case "level":
			return { unit: "U", fields: ["k"] }
		case "series":
			return undefined
	}
}

/** The law a series over S states: each number's predecessor is a number of S. */
export const seriesLaw: {
	readonly kind: "contained"
	readonly from: SideDesc
	readonly to: SideDesc
} = {
	kind: "contained",
	from: { relation: "S", terms: [{ kind: "pred", field: "number" }], selection: { conjuncts: [] } },
	to: { relation: "S", terms: [{ kind: "field", field: "number" }], selection: { conjuncts: [] } }
}
