/** What the property of units.test.ts reads: its space, the schema each case states and the rules it restates. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { SideDesc } from "#compiler/ir/desc.ts"
import { Logic } from "#compiler/public/compute.ts"
import { contract, natural, pg, uuid } from "#compiler/public/fields.ts"
import { mutable, relation, schema, sealed, series, unit } from "#compiler/public/schema.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { Statement } from "#compiler/types/schema/statements.ts"
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

/**
 * A sealed unit U over { k: Id }: founded, over R keyed (k) and two closed members S and T keyed (k, n); R, S and T with
 * S mutable; R and Q, two relations keyed (k) alone, and S; or R, S and T with U stated both sealed and not.
 */
export const seals = ["founded", "openMember", "twoKeyed", "bothWays"] as const

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
	| { readonly kind: "sealed"; readonly seal: (typeof seals)[number] }

export const unitCaseGen: Gen<UnitCase> = (source) => {
	const kind = source.draw(element(["member", "pair", "level", "series", "sealed"] as const))
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
		case "sealed":
			return { kind, seal: source.draw(element(seals)) }
	}
}

/** A case's text, each case's its own: the features of the space. */
export type UnitFeature =
	| `R keyed ${(typeof leads)[number]}`
	| `two units ${(typeof pairs)[number]}`
	| `unit stated ${(typeof levels)[number]}`
	| `series keyed ${(typeof seriesKeys)[number]}${"" | ", mutable"}`
	| `sealed unit ${(typeof seals)[number]}`

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
		case "sealed":
			return `sealed unit ${c.seal}`
	}
}

const otherIdKey = Symbol("OtherId")
/** An id of another type than Id, by its own contract over the same base. */
const OtherId = contract<typeof otherIdKey>()("OtherId", uuid)

const testNumberKey = Symbol("TestNumber")
/** A number kept in an int4, bounded below the int4 serial's greatest value, as a test's number is. */
const TestNumber = contract<typeof testNumberKey>()("TestNumber", pg.integer, (n) =>
	Logic.and([Logic.ge(n, 0), Logic.le(n, 2147483646)])
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

/** The sealed unit every sealed case states, over { k: Id }. */
const sealedU = sealed(unit("U", { k: Id }))

/** The relations of a sealed case: R and Q, each keyed (k) alone; S and T, keyed (k, n). */
const sealedRelations = {
	R: relation("R", { k: Id, title: pg.integer }, ["k"]),
	S: relation("S", { k: Id, n: pg.integer }, ["k", "n"]),
	T: relation("T", { k: Id, n: pg.integer }, ["k", "n"]),
	Q: relation("Q", { k: Id, other: pg.integer }, ["k"])
} as const

/**
 * A sealed unit beside a mutable statement over one of its members, as a list of no fixed length: the types refuse the
 * pair as the run time does (types/schema/schema.ts MutablesUnder), so the list holds what the run time judges alone.
 */
const openMember: ReadonlyArray<Statement> = [sealedU, mutable(sealedRelations.S)]

/** The schema a sealed case states (`seals`). */
const sealedSchema = (seal: (typeof seals)[number]): AnySchema => {
	const { R, S, T, Q } = sealedRelations
	switch (seal) {
		case "founded":
			return schema("Units", [R, S, T], [sealedU])
		case "openMember":
			return schema("Units", [R, S, T], openMember)
		case "twoKeyed":
			return schema("Units", [R, S, Q], [sealedU])
		case "bothWays":
			return schema("Units", [R, S, T], [sealedU, unit("U", { k: Id })])
	}
}

/**
 * The schema a case states, the series statement of a series case and the unit statement of a sealed one, whose laws
 * its check reads.
 */
export const schemaOf = (
	c: UnitCase
): {
	readonly schema: AnySchema
	readonly series: ReturnType<typeof series> | undefined
	readonly sealed: typeof sealedU | undefined
} => {
	switch (c.kind) {
		case "member":
			return {
				schema: schema("Units", [memberR(c.key)], [unit("U", { k: Id })]),
				series: undefined,
				sealed: undefined
			}
		case "pair": {
			const R = relation("R", { k: Id, j: pg.integer }, ["k", "j"])
			return { schema: schema("Units", [R], unitsOf(c.pair)), series: undefined, sealed: undefined }
		}
		case "level": {
			const R = relation("R", { k: Id, n: pg.integer }, ["k", "n"])
			const T = relation("T", { t: pg.integer }, ["t"])
			if (c.at === "same") {
				const base = schema("Units", [R], [unit("U", { k: Id })])
				return {
					schema: schema.extend([base], "Above", [T], []),
					series: undefined,
					sealed: undefined
				}
			}
			const base = schema("Units", [R], [])
			return {
				schema: schema.extend([base], "Above", [T], [unit("U", { k: Id })]),
				series: undefined,
				sealed: undefined
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
				series: stated,
				sealed: undefined
			}
		}
		case "sealed":
			return { schema: sealedSchema(c.seal), series: undefined, sealed: sealedU }
	}
}

/**
 * The oracle: whether a case's statements build, series(S) refusing at once a relation keyed by no one field of a type
 * grizzle draws, natural or a contract over an integer.
 */
export const builds = (c: UnitCase): boolean => c.kind !== "series" || drawnKey(c.key)

/**
 * The oracle: how a sealed case's schema owns, by the rules of docs/schema.md "Units" restated: owned, its unit sealed over the
 * relations its key leads; refused (Refused) for a relation mutable under a sealed unit; or MalformedDescription for one
 * unit stated both sealed and not.
 */
export const sealedOwns = (
	seal: (typeof seals)[number]
):
	| { readonly kind: "owns"; readonly members: ReadonlyArray<string> }
	| { readonly kind: "refused"; readonly tag: "Refused" | "MalformedDescription" } => {
	switch (seal) {
		case "founded":
			return { kind: "owns", members: ["R", "S", "T"] }
		case "twoKeyed":
			return { kind: "owns", members: ["Q", "R", "S"] }
		case "openMember":
			return { kind: "refused", tag: "Refused" }
		case "bothWays":
			return { kind: "refused", tag: "MalformedDescription" }
	}
}

/** The refusal of a relation mutable under a sealed unit, as ownership states it. */
export const mutableSealedRefusal =
	"mutable over a relation under a sealed unit, whose every row is inserted by the transaction that founds its unit: a sealed unit's relations are closed, so keep it closed and record each change as an inserted fact, or declare its unit unsealed"

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

/** The oracle: whether a case's schema owns, by the rules of docs/schema.md "Units" restated. */
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
		case "sealed":
			return sealedOwns(c.seal).kind === "owns"
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
		case "sealed":
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
