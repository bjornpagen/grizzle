/** What the property of row-functions.test.ts reads: its space of installations, each aimed at what a row function
 * takes from a table's CHECKs and generations. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { array, boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { inlineLiteralMaxBytes } from "#compiler/physical/ddl/row-functions.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { closedId, natural, pg } from "#compiler/public/fields.ts"
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
import { compiled } from "#test/unit/physical/fin.fixtures.ts"
import { regex } from "#test/unit/schema/support.ts"

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
	const T = relation("T", { id: pg.integer, k: closedId(K), n: natural }, ["id"])
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
		{ id: pg.integer, w: Numeral, t: Letters, u: Letters },
		["id"],
		(r: Readonly<Record<string, unknown>>) =>
			generated ? { v: generatedField(pg.bigint, computeCore.cast(r["w"], pg.bigint), []) } : {},
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

/** A case's installation. */
export const installationOf = (c: RowCase): Installation =>
	succeeded(
		c.kind === "contained"
			? compiled(containedSchema(c.rows))
			: compiled(patternedSchema(c.length, c.generated)),
		"the installation compiles"
	)
