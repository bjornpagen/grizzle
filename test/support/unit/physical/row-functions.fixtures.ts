/** What the property of row-functions.test.ts reads: its space of installations, each aimed at what a row function
 * takes from a table's CHECKs and generations. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { inlineLiteralMaxBytes } from "#compiler/physical/ddl/row-functions.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { closedId, natural, int4, int8 } from "#compiler/public/fields.ts"
import { closed, relation } from "#compiler/public/schema.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { generatedField, generatedRelation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import {
	checkBuilder,
	containedBuilder,
	keyBuilder,
	onBuilder,
	selectBuilder
} from "#compiler/schema/statements.ts"
import { rowHelpers } from "#compiler/schema/terms.ts"
import { succeeded } from "#test/support/assert.ts"
import { compiled } from "#test/support/unit/physical/fin.fixtures.ts"
import { regex } from "#test/support/unit/schema/support.ts"

/**
 * A case: a relation contained in a closed relation holding a drawn subset of its roster's handles, whose CHECK reads
 * the closed relation's constant; or a relation of two
 * texts of letters whose CHECK and whose key's selection each match one of them to a pattern of `length` letters,
 * drawn across inlineLiteralMaxBytes, a CHECK that the second differs from a text of as many letters, and a CHECK that
 * its id is not negative and a generated field that casts a written numeral, both holding no literal data.
 */
export type RowCase =
	| { readonly kind: "contained"; readonly rows: ReadonlyArray<boolean> }
	| { readonly kind: "patterned"; readonly length: number; readonly generated: boolean }

export const rowCaseGen: Gen<RowCase> = (s) =>
	s.draw(boolean)
		? { kind: "contained", rows: s.draw(array(boolean, { min: 1, max: handles.length })) }
		: {
				kind: "patterned",
				length: s.draw(int(0, 2 * inlineLiteralMaxBytes)),
				generated: s.draw(boolean)
			}

const handles = ["k0", "k1", "k2", "k3"] as const

const K = closed.ordered("K", handles)

/** The contained relation's schema: T's (k, n) contained in the closed relation Pairs, which holds (k, its code) for
 * each handle k whose drawn flag is set, so T's CHECK reads Pairs' constant. */
const containedSchema = (rows: ReadonlyArray<boolean>) => {
	const Pairs = closed.relation(
		"Pairs",
		{ k: closedId(K), n: natural },
		["k"],
		Arr.flatMap(rows, (held, code) => {
			const k = handles[code]
			return held && k !== undefined ? [{ k, n: BigInt(code) }] : []
		})
	)
	const T = relation("T", { id: int4, k: closedId(K), n: natural }, ["id"])
	return schema(
		"Contained",
		[K, Pairs, T],
		[containedBuilder(onBuilder(T, ["k", "n"]), onBuilder(Pairs, ["k", "n"]))],
		[]
	)
}

const Numeral = regex("^[0-9]{1,6}$", "u")

/** A text the pattern may match or not, whatever its length: lowercase letters, up to 64. */
const Letters = regex("^[a-z]{0,64}$", "u")

/** The patterned relation's schema: R's CHECK matches t, and its key's selection u, to `^a…a`, `length` letters a. */
const patternedSchema = (length: number, generated: boolean) => {
	const pattern = computeCore.pattern(`^${Str.repeat(length)("a")}`)
	const R = generatedRelation(
		"R",
		{ id: int4, w: Numeral, t: Letters, u: Letters },
		["id"],
		(r: Readonly<Record<string, unknown>>) =>
			generated ? { v: generatedField(int8, computeCore.cast(r["w"], int8), []) } : {},
		[]
	)
	const selected = selectBuilder(R, (r: Readonly<Record<string, unknown>>) =>
		computeCore.matches(r["u"], pattern)
	)
	return schema(
		"Rowed",
		[R],
		[
			checkBuilder("Shaped", R, (r: Readonly<Record<string, unknown>>) =>
				computeCore.matches(r["t"], pattern)
			),
			checkBuilder("Counted", R, (r: Readonly<Record<string, unknown>>) =>
				rowHelpers.ge(r["id"], 0)
			),
			checkBuilder("Unlike", R, (r: Readonly<Record<string, unknown>>) =>
				rowHelpers.ne(r["u"], Str.repeat(length)("a"))
			),
			keyBuilder(onBuilder(selected, nonEmpty(["w"], "the key's term")))
		],
		[]
	)
}

/** A case's schema. */
export const rowSchemaOf = (c: RowCase) =>
	c.kind === "contained" ? containedSchema(c.rows) : patternedSchema(c.length, c.generated)

/** A case's installation. */
export const installationOf = (c: RowCase): Installation =>
	succeeded(compiled(rowSchemaOf(c)), "the installation compiles")

/**
 * A case of the call count: R's rows of a drawn kind, under a selection or a CHECK whose first operand is R's kind
 * among `members`, a selector, whose second tests a text of R's length, a function's call, and whose last matches
 * that text to a pattern, which hoists the expression: the key's selection `kind IN members AND char_length(u) > 0 AND
 * u ~ p`, or the CHECK `NOT kind IN members OR char_length(t) > 3 OR t ~ p`. A row of `kind` the selector decides,
 * outside `members`, calls no row function, any other row one, and no statement evaluates the length outside it.
 */
export interface LeadCase {
	readonly shape: "selection" | "check"
	readonly members: Arr.NonEmptyReadonlyArray<number>
	readonly kind: number
}

/** The kinds R's rows hold: members are drawn among the first four, a row's among all five. */
const kinds = [0, 1, 2, 3, 4] as const

export const leadCaseGen: Gen<LeadCase> = (s) => ({
	shape: s.draw(element(["selection", "check"] as const)),
	members: nonEmpty(s.draw(subset([0, 1, 2, 3], { min: 1, max: 4 })), "the selection's kinds"),
	kind: s.draw(element(kinds))
})

/** The lead case's schema: R(id, kind, t, u, w), with the key over the selected side or the CHECK its shape draws. */
const leadSchemaOf = (c: LeadCase) => {
	const pattern = computeCore.pattern("^a")
	const R = relation("R", { id: int4, kind: int4, t: Letters, u: Letters, w: Numeral }, ["id"])
	const among = (r: Readonly<Record<string, unknown>>) =>
		c.members.length === 1
			? rowHelpers.eq(r["kind"], c.members[0])
			: rowHelpers.in(r["kind"], c.members)
	return schema(
		"Lead",
		[R],
		c.shape === "selection"
			? [
					keyBuilder(
						onBuilder(
							selectBuilder(R, (r: Readonly<Record<string, unknown>>) =>
								rowHelpers.and([
									among(r),
									rowHelpers.gt(rowHelpers.charLength(r["u"]), 0),
									computeCore.matches(r["u"], pattern)
								])
							),
							nonEmpty(["w"], "the key's term")
						)
					)
				]
			: [
					checkBuilder("Led", R, (r: Readonly<Record<string, unknown>>) =>
						rowHelpers.or([
							rowHelpers.not(among(r)),
							rowHelpers.gt(rowHelpers.charLength(r["t"]), 3),
							computeCore.matches(r["t"], pattern)
						])
					)
				],
		[]
	)
}

/** The lead case's installation. */
export const leadInstallationOf = (c: LeadCase): Installation =>
	succeeded(compiled(leadSchemaOf(c)), "the installation compiles")
