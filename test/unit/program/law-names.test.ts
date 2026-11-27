/**
 * A law whose author declares no entry is named, and its source spelled, with each conjunct of its selection as the
 * author's predicate (runtime/law-entry.ts derivedEntry): `key Member(id) where Logic.eq(captain, true)`, its source
 * `key(on(select(Member, (r) => Logic.eq(r.captain, true)), "id"))`, where both spelled each conjunct as its canonical
 * JSON (`where {"kind":"compare",…}`), which no author wrote and every refusal naming the law showed.
 *
 * - **Property:** over drawn row predicates of Member's fields, each built through the public builders from a drawn
 *   shape (a comparison of each operator, a disjunction, a negation, membership among texts, a range, a text test,
 *   arithmetic over a bigint, a conditional and a float's zero of either sign), the key over the side it selects is
 *   named `key Member(id) where` the predicate as the shape's own printer writes it over the bare fields, and its
 *   source selects with the predicate as the printer writes it over the row `r`.
 * - **Oracle:** second-implementation: the shape's own printer, which writes the builder calls it made.
 * - **Features:** each kind of node and literal a shape draws.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { boolean, element, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { type CompareOp, compareOps } from "#compiler/ir/desc.ts"
import { lawsOf } from "#compiler/program/laws.ts"
import { Logic, Num, Text } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { PredicateBase } from "#compiler/types/core/phantom.ts"
import { Id } from "#test/support/ids.ts"

const Member = relation(
	"Member",
	{
		id: Id,
		captain: pg.boolean,
		number: pg.integer,
		total: pg.bigint,
		code: str.regex("^[a-z]{1,8}$", "u"),
		weight: pg["double precision"]
	},
	["id"]
)

/** A row predicate's shape: what the property builds through the public builders and prints on its own. */
type Shape =
	| { readonly kind: "captain"; readonly is: boolean }
	| { readonly kind: "compare"; readonly op: CompareOp; readonly value: number }
	| { readonly kind: "or"; readonly left: Shape; readonly right: Shape }
	| { readonly kind: "not"; readonly arg: Shape }
	| { readonly kind: "in"; readonly first: string; readonly second: string }
	| { readonly kind: "between"; readonly low: number; readonly high: number }
	| { readonly kind: "startsWith"; readonly prefix: string }
	| { readonly kind: "sum"; readonly add: bigint; readonly atLeast: bigint }
	| { readonly kind: "cond"; readonly otherwise: number; readonly equals: number }
	| { readonly kind: "weight"; readonly negativeZero: boolean }

type NameFeature = Shape["kind"]

const texts = ["ab", "cd", "x"] as const

const leafGen: Gen<Shape> = oneOf<Shape>([
	(s) => ({ kind: "captain", is: s.draw(boolean) }),
	(s) => ({ kind: "compare", op: s.draw(element(compareOps)), value: s.draw(int(-3, 3)) }),
	(s) => {
		const at = s.draw(int(0, texts.length - 1))
		const past = s.draw(int(1, texts.length - 1))
		return {
			kind: "in",
			first: texts[at] ?? "ab",
			second: texts[(at + past) % texts.length] ?? "cd"
		}
	},
	(s) => ({ kind: "between", low: s.draw(int(-3, 0)), high: s.draw(int(1, 9)) }),
	(s) => ({ kind: "startsWith", prefix: s.draw(element(texts)) }),
	(s) => ({ kind: "sum", add: BigInt(s.draw(int(1, 3))), atLeast: BigInt(s.draw(int(0, 9))) }),
	(s) => ({ kind: "cond", otherwise: s.draw(int(0, 2)), equals: s.draw(int(0, 2)) }),
	(s) => ({ kind: "weight", negativeZero: s.draw(boolean) })
])

/** A shape of at most `depth` connectives over leaves. */
const shapeGen = (depth: number): Gen<Shape> =>
	depth === 0
		? leafGen
		: oneOf<Shape>([
				leafGen,
				(s) => ({ kind: "not", arg: s.draw(shapeGen(depth - 1)) }),
				(s) => ({
					kind: "or",
					left: s.draw(shapeGen(depth - 1)),
					right: s.draw(shapeGen(depth - 1))
				})
			])

/** The selection a shape builds through the public builders. */
const selected = (shape: Shape) =>
	select(Member, (m) => {
		const build = (x: Shape): PredicateBase => {
			switch (x.kind) {
				case "captain":
					return Logic.eq(m.captain, x.is)
				case "compare":
					return Logic[x.op](m.number, x.value)
				case "or":
					return Logic.or([build(x.left), build(x.right)])
				case "not":
					return Logic.not(build(x.arg))
				case "in":
					return Logic.in(m.code, [x.first, x.second])
				case "between":
					return Logic.between(m.number, x.low, x.high)
				case "startsWith":
					return Logic.eq(Text.startsWith(m.code, x.prefix), true)
				case "sum":
					return Logic.ge(Num.add(m.total, x.add), x.atLeast)
				case "cond":
					return Logic.eq(Logic.cond(m.captain, m.number, x.otherwise), x.equals)
				case "weight":
					return Logic.eq(m.weight, x.negativeZero ? -0 : 0)
			}
		}
		return build(shape)
	})

/**
 * The texts a shape's builder calls may be written as, each field read as `field` spells it: one, but a disjunction's,
 * whose operands ownership holds in its own canonical order (schema/own.ts), either way round, and a membership's
 * values, which it holds in code point order.
 */
const written = (shape: Shape, field: (name: string) => string): ReadonlyArray<string> => {
	const w = (s: Shape): ReadonlyArray<string> => written(s, field)
	switch (shape.kind) {
		case "captain":
			return [`Logic.eq(${field("captain")}, ${String(shape.is)})`]
		case "compare":
			return [`Logic.${shape.op}(${field("number")}, ${String(shape.value)})`]
		case "or":
			return Arr.flatMap(w(shape.left), (l) =>
				Arr.flatMap(w(shape.right), (r) => [`Logic.or(${l}, ${r})`, `Logic.or(${r}, ${l})`])
			)
		case "not":
			return Arr.map(w(shape.arg), (a) => `Logic.not(${a})`)
		case "in":
			return [
				`Logic.in(${field("code")}, [${Arr.join(
					Arr.map(Arr.sort([shape.first, shape.second], Order.String), (v) => `"${v}"`),
					", "
				)}])`
			]
		case "between":
			return [`Logic.between(${field("number")}, ${String(shape.low)}, ${String(shape.high)})`]
		case "startsWith":
			return [`Logic.eq(Text.startsWith(${field("code")}, "${shape.prefix}"), true)`]
		case "sum":
			return [
				`Logic.ge(Num.add(${field("total")}, ${String(shape.add)}n), ${String(shape.atLeast)}n)`
			]
		case "cond":
			return [
				`Logic.eq(Logic.cond(${field("captain")}, ${field("number")}, ${String(shape.otherwise)}), ${String(shape.equals)})`
			]
		case "weight":
			return [`Logic.eq(${field("weight")}, ${shape.negativeZero ? "-0" : "0"})`]
	}
}

/** Each kind a shape holds. */
const kindsOf = (shape: Shape): ReadonlyArray<NameFeature> =>
	shape.kind === "or"
		? [shape.kind, ...kindsOf(shape.left), ...kindsOf(shape.right)]
		: shape.kind === "not"
			? [shape.kind, ...kindsOf(shape.arg)]
			: [shape.kind]

const features: Arr.NonEmptyReadonlyArray<NameFeature> = [
	"captain",
	"compare",
	"or",
	"not",
	"in",
	"between",
	"startsWith",
	"sum",
	"cond",
	"weight"
]

/**
 * A key over a selected side whose author declares no entry is named and sourced with its selection as its author's
 * predicate.
 */
export const aDerivedLawNameSpellsItsSelectionAsTheAuthorsPredicate = property.explore(
	shapeGen(2),
	{
		needs: {},
		situations: features satisfies ReadonlyArray<Reached<NameFeature>>,
		budget: { runs: 200, steered: 100 },
		check: (_, c: Case<NameFeature>) => (shape) =>
			Effect.sync(() => {
				for (const kind of kindsOf(shape)) {
					c.note(kind)
				}
				const s = schema("Named", [Member], [key(on(selected(shape), "id"))])
				const keys = Arr.filter(lawsOf(s), (l) => l.law.kind === "key")
				assert.equal(keys.length, 1, "the schema states one key")
				const entry = keys[0]?.law.entry
				assert.ok(entry?.kind === "derived", "the key's entry is derived")
				const names = written(shape, (f) => f)
				const sources = written(shape, (f) => `r.${f}`)
				const at = Arr.findFirstIndex(names, (n) => entry.name === `key Member(id) where ${n}`)
				assert.ok(
					at._tag === "Some",
					`the key's name, ${entry.name}, is its author's predicate, one of ${Arr.join(names, " | ")}`
				)
				assert.equal(
					entry.source,
					`key(on(select(Member, (r) => ${sources[at.value] ?? ""}), "id"))`,
					"the key's source, its name's predicate over the row"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the shape's own printer of the builder calls it made"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/predicate-source.ts",
				original: "\t\t\treturn call(spelling[e.op], [go(e.left), go(e.right)])",
				replacement: "\t\t\treturn ownedText(e, withoutSourceLocs)",
				why: "A comparison is spelled as its canonical JSON again, as every derived name spelled a selection; every case holding one names its key otherwise than its author wrote it."
			}
		]
	}
)
