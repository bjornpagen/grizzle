/**
 * A write whose facts may be drawn in shares compiles only where every same-key check its host judges a share's facts
 * by is an object the server holds (write/program/decide.ts sharedChecksBacked): a key or span the host alone compared
 * would let a call drawn in shares commit two facts at one key across two shares, which the whole call refuses, so the
 * compile refuses it as an internal compiler error.
 *
 * - **Property:** the check refuses exactly a write of a drawable shape (binding.ts drawableShape: every member an
 *   array of inserted facts, one stratum, no relation parameter) one of whose host checks, a key's or a span's, names a
 *   law no unique, key or span object of its relation holds; every other write passes, a drawable one whose checks are
 *   its objects', and any shape that is no drawable one, whatever its checks, since it is bound whole.
 * - **Oracle:** the specification, the check's statement.
 * - **Box, exhausted:** the shape (drawable; a put member; two strata; a relation parameter) and the host check (a key
 *   backed by its key object, by a unique object, a span backed by its span object, a key no object holds, a span no
 *   object holds).
 */

import { assert } from "@bjornpagen/testing/assert"
import { element, finite, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, String as Str } from "effect"
import { trusted } from "#compiler/core/trusted.ts"
import type { MemberAt } from "#compiler/runtime/write/binding.ts"
import { sharedChecksBacked } from "#compiler/write/program/decide.ts"

type Shape = "drawable" | "a put member" | "two strata" | "a relation parameter"

type Check =
	| "a backed key"
	| "a backed unique"
	| "a backed span"
	| "an unbacked key"
	| "an unbacked span"

interface Written {
	readonly shape: Shape
	readonly check: Check
}

const writtenBox: Gen<Written> = (source) => ({
	shape: source.draw(
		element<Shape>(["drawable", "a put member", "two strata", "a relation parameter"])
	),
	check: source.draw(
		element<Check>([
			"a backed key",
			"a backed unique",
			"a backed span",
			"an unbacked key",
			"an unbacked span"
		])
	)
})

type Feature = "refused" | "compiled" | Shape | Check

const member = (op: MemberAt["op"], stratum: number): MemberAt => ({
	slot: `slot ${stratum}`,
	stratum,
	op,
	relation: "Entry",
	kind: "array"
})

const membersOf = (shape: Shape): ReadonlyArray<MemberAt> => {
	switch (shape) {
		case "drawable":
		case "a relation parameter":
			return [member("insert", 0), member("insert", 0)]
		case "a put member":
			return [member("insert", 0), member("put", 0)]
		case "two strata":
			return [member("insert", 0), member("insert", 1)]
	}
}

/** The relation's objects: its primary key's law `key`, a unique object's `unique`, and a span object's `span`. */
const uniques = {
	keys: [{ law: "key" }],
	others: [{ law: "unique" }],
	checks: [{ object: { law: "span" }, pairs: "host" }]
} as const

/** The one host check a case's slot is judged by, a key's or a span's, at the law it names. */
const hostOf = (check: Check) => {
	const key = (law: string) => ({ keys: [{ law, described: {}, fields: [] }], spans: [] })
	const span = (law: string) => ({ keys: [], spans: [{ law, described: {}, equal: [], span: {} }] })
	switch (check) {
		case "a backed key":
			return key("key")
		case "a backed unique":
			return key("unique")
		case "a backed span":
			return span("span")
		case "an unbacked key":
			return key("nothing")
		case "an unbacked span":
			return span("nothing")
	}
}

/** The check of a write drawn in shares refuses exactly a drawable write's host check no object of its relation holds. */
export const aWriteDrawnInSharesCompilesOnlyWhereEveryHostCheckIsAnObjectTheServerHolds =
	property.exhaust(finite(writtenBox), {
		needs: {},
		situations: [
			"refused",
			"compiled",
			"drawable",
			"a put member",
			"two strata",
			"a relation parameter",
			"a backed key",
			"a backed unique",
			"a backed span",
			"an unbacked key",
			"an unbacked span"
		],
		check:
			(_, c: Case<Feature>) =>
			({ shape, check }) =>
				Effect.sync(() => {
					const params =
						shape === "a relation parameter" ? [{ kind: "relation" }] : [{ kind: "scalar" }]
					const slots = trusted<Parameters<typeof sharedChecksBacked>[2]>([
						{ relation: { name: "Entry", uniques }, facts: { stated: {}, host: hostOf(check) } }
					])
					const refused = (() => {
						try {
							sharedChecksBacked(membersOf(shape), params, slots)
							return false
						} catch {
							return true
						}
					})()
					const expected = shape === "drawable" && Str.startsWith("an unbacked")(check)
					assert.equal(
						refused,
						expected,
						`${shape} judged by ${check}: ${expected ? "an internal compiler error" : "compiles"}`
					)
					c.note(refused ? "refused" : "compiled")
					c.note(shape)
					c.note(check)
				}),
		oracle: {
			kind: "specification",
			name: "a drawable write's every host check is a unique, key or span object of its relation"
		},
		box: "four shapes, a drawable one and three bound whole, by five host checks, three backed and two not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/program/decide.ts",
				original: "\t\t\tif (!objects.has(check.law)) {\n",
				replacement: "\t\t\tif (false && !objects.has(check.law)) {\n",
				why: "A drawable write whose host alone compares a key compiles: a call drawn in shares commits two facts at one key across two shares."
			},
			{
				file: "packages/engine/src/runtime/write/binding.ts",
				original: '\tmembers.every((m) => m.op === "insert" && m.kind === "array") &&\n',
				replacement: '\tmembers.every((m) => m.kind === "array") &&\n',
				why: "A write that puts is a drawable shape: its puts drawn in shares replace each other at one key, where the whole call's host refuses the pair."
			}
		]
	})
