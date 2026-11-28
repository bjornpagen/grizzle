/**
 * A law whose author declares no entry is named, and its source spelled, with each conjunct of its selection as the
 * author's predicate (runtime/law-entry.ts derivedEntry): `key Member(id) where Logic.eq(captain, true)`, its source
 * `key(on(select(Member, (r) => Logic.eq(r.captain, true)), "id"))`, where both spelled each conjunct as its canonical
 * JSON (`where {"kind":"compare",…}`), which no author wrote and every refusal naming the law showed. A connective is
 * spelled over the one list its builder takes, `Logic.or([p, q])`, where it was spelled over its operands one by one,
 * `Logic.or(p, q)`, the variadic form the connectives no longer take, so a source no author could run.
 *
 * - **Property:** over drawn row predicates of Member's fields, each built through the public builders from a drawn
 *   shape (a comparison of each operator, a conjunction and a disjunction of two or three operands, a negation,
 *   membership among texts, a range, a text test, arithmetic over a bigint, a conditional and a float's zero of either
 *   sign), the key over the side it selects is named `key Member(id) where` its selection's conjuncts, each as the
 *   shape's own printer writes it over the bare fields, its source selects with their conjunction as the printer writes
 *   it over the row `r`, and that source, run through the public API, builds the key the schema states again.
 * - **Oracle:** second-implementation: the shape's own printer, which writes the builder calls it made, and the public
 *   API, which builds the statement a source spells.
 * - **Features:** each kind of node and literal a shape draws, and a connective of three operands.
 */

import { compileFunction } from "node:vm"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { type CompareOp, compareOps } from "#compiler/ir/desc.ts"
import { lawsByStatement, lawsOf } from "#compiler/program/laws.ts"
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
	| { readonly kind: "and" | "or"; readonly operands: ReadonlyArray<Shape> }
	| { readonly kind: "not"; readonly arg: Shape }
	| { readonly kind: "in"; readonly first: string; readonly second: string }
	| { readonly kind: "between"; readonly low: number; readonly high: number }
	| { readonly kind: "startsWith"; readonly prefix: string }
	| { readonly kind: "sum"; readonly add: bigint; readonly atLeast: bigint }
	| { readonly kind: "cond"; readonly otherwise: number; readonly equals: number }
	| { readonly kind: "weight"; readonly negativeZero: boolean }

type NameFeature = Shape["kind"] | "a connective of three operands"

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

/** A shape of at most `depth` connectives over leaves, a conjunction's and a disjunction's of two or three operands. */
const shapeGen = (depth: number): Gen<Shape> =>
	depth === 0
		? leafGen
		: oneOf<Shape>([
				leafGen,
				(s) => ({ kind: "not", arg: s.draw(shapeGen(depth - 1)) }),
				(s) => ({ kind: "and", operands: s.draw(array(shapeGen(depth - 1), { min: 2, max: 3 })) }),
				(s) => ({ kind: "or", operands: s.draw(array(shapeGen(depth - 1), { min: 2, max: 3 })) })
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
				case "and":
					return Logic.and(Arr.map(x.operands, build))
				case "or":
					return Logic.or(Arr.map(x.operands, build))
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

/** The schema keying Member over the side a shape selects. */
const Named = (shape: Shape) => schema("Named", [Member], [key(on(selected(shape), "id"))])

/** Every order of `items`. */
const orderings = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
	items.length === 0
		? [[]]
		: Arr.flatMap(items, (item, at) =>
				Arr.map(orderings(Arr.remove(items, at)), (rest) => [item, ...rest])
			)

/** No text chosen, the one choice from no options. */
const noChoice: ReadonlyArray<ReadonlyArray<string>> = [[]]

/** Every choice of one text from each of `options`, in their order. */
const choices = (
	options: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.reduceRight(options, noChoice, (tails, option) =>
		Arr.flatMap(option, (text) => Arr.map(tails, (tail) => [text, ...tail]))
	)

/**
 * The texts a shape's builder calls may be written as, each field read as `field` spells it: one, but a connective's,
 * over the one list of its operands, which ownership holds in its own canonical order (schema/own.ts), in any order,
 * and a membership's values, which it holds in code point order.
 */
const written = (shape: Shape, field: (name: string) => string): ReadonlyArray<string> => {
	const w = (s: Shape): ReadonlyArray<string> => written(s, field)
	switch (shape.kind) {
		case "captain":
			return [`Logic.eq(${field("captain")}, ${String(shape.is)})`]
		case "compare":
			return [`Logic.${shape.op}(${field("number")}, ${String(shape.value)})`]
		case "and":
		case "or":
			return Arr.flatMap(orderings(shape.operands), (ordered) =>
				Arr.map(
					choices(Arr.map(ordered, w)),
					(operands) => `Logic.${shape.kind}([${Arr.join(operands, ", ")}])`
				)
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

/** Each kind a shape holds, and a connective of three operands where it holds one. */
const kindsOf = (shape: Shape): ReadonlyArray<NameFeature> =>
	shape.kind === "and" || shape.kind === "or"
		? [
				shape.kind,
				...(shape.operands.length === 3 ? ["a connective of three operands" as const] : []),
				...Arr.flatMap(shape.operands, kindsOf)
			]
		: shape.kind === "not"
			? [shape.kind, ...kindsOf(shape.arg)]
			: [shape.kind]

/** A selection's conjuncts: a conjunction's operands, through every conjunction among them (ir/desc.ts conjunctsOf). */
const conjunctsOf = (shape: Shape): ReadonlyArray<Shape> =>
	shape.kind === "and" ? Arr.flatMap(shape.operands, conjunctsOf) : [shape]

/** What a key's name reads before its selection's conjuncts, which it joins by `and`, each once. */
const where = "key Member(id) where "

/**
 * A conjunct as a key's source spells it over the row `r`, where its name spells it `name`: the printer's text over the
 * row of the conjunct among `conjuncts` whose text over the bare fields `name` is, or none.
 */
const sourceOf = (conjuncts: ReadonlyArray<Shape>, name: string): Option.Option<string> =>
	Arr.findFirst(conjuncts, (conjunct) =>
		Option.flatMap(
			Arr.findFirstIndex(
				written(conjunct, (f) => f),
				(n) => n === name
			),
			(at) =>
				Arr.get(
					written(conjunct, (f) => `r.${f}`),
					at
				)
		)
	)

/** A statement's source run through the public API, as an author would write it: the laws the schema `s` states of it. */
const restated = (s: ReturnType<typeof Named>, source: string): unknown =>
	Reflect.apply(
		compileFunction(`return lookup(${source})`, [
			"lookup",
			"key",
			"on",
			"select",
			"Member",
			"Logic",
			"Num",
			"Text"
		]),
		undefined,
		[lawsByStatement(s), key, on, select, Member, Logic, Num, Text]
	)

const features: Arr.NonEmptyReadonlyArray<NameFeature> = [
	"captain",
	"compare",
	"and",
	"or",
	"a connective of three operands",
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
				const s = Named(shape)
				const keys = Arr.filter(lawsOf(s), (l) => l.law.kind === "key")
				assert.equal(keys.length, 1, "the schema states one key")
				const law = defined(keys[0], "the schema's key").law
				const entry = law.entry
				assert.ok(entry.kind === "derived", "the key's entry is derived")
				assert.deepEqual(
					restated(s, entry.source),
					[law],
					"the key's source, run through the public API, states the key again"
				)
				assert.ok(
					Str.startsWith(where)(entry.name),
					`the key's name, ${entry.name}, reads its selection`
				)
				const conjuncts = conjunctsOf(shape)
				const named = Str.split(Str.slice(where.length)(entry.name), " and ")
				const sources = Arr.map(named, (name) => sourceOf(conjuncts, name))
				assert.ok(
					Arr.every(sources, Option.isSome),
					`each conjunct the key's name reads, ${Arr.join(named, " | ")}, is one its author wrote`
				)
				assert.ok(
					Arr.every(conjuncts, (conjunct) =>
						Arr.some(
							written(conjunct, (f) => f),
							(n) => Arr.contains(named, n)
						)
					),
					`each conjunct its author wrote is one the key's name, ${entry.name}, reads`
				)
				const over = Arr.getSomes(sources)
				assert.equal(
					entry.source,
					`key(on(select(Member, (r) => ${over.length === 1 ? Arr.join(over, "") : `Logic.and([${Arr.join(over, ", ")}])`}), "id"))`,
					"the key's source, its name's conjuncts over the row"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the shape's own printer of the builder calls it made, and the public API, which builds the statement a source spells"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/predicate-source.ts",
				original: "\t\t\treturn call(spelling[e.op], [go(e.left), go(e.right)])",
				replacement: "\t\t\treturn ownedText(e, withoutSourceLocs)",
				why: "A comparison is spelled as its canonical JSON again, as every derived name spelled a selection; every case holding one names its key otherwise than its author wrote it."
			},
			{
				file: "packages/engine/src/scalar/compute/predicate-source.ts",
				original: "\t\t\treturn call(spelling.or, [listed(e.args.map(go))])",
				replacement: "\t\t\treturn call(spelling.or, e.args.map(go))",
				why: "A disjunction is spelled over its operands one by one again, Logic.or(p, q), the variadic form Logic.or no longer takes: the key's source, run through the public API, is refused (one list of predicates), and its name reads no call its author wrote."
			},
			{
				file: "packages/engine/src/scalar/compute/predicate-source.ts",
				original: "\t\t\treturn call(spelling.and, [listed(e.args.map(go))])",
				replacement: "\t\t\treturn call(spelling.and, e.args.map(go))",
				why: "A conjunction, a selection's of several conjuncts or one under a disjunction or a negation, is spelled over its operands one by one again, Logic.and(p, q): the key's source, run through the public API, is refused (one list of predicates)."
			},
			{
				file: "packages/engine/src/ir/desc.ts",
				original: "\treturn args.length === 1 ? headNonEmpty(args) : { kind, args }",
				replacement:
					"\treturn args.length === 1\n\t\t? headNonEmpty(args)\n\t\t: { kind, args: [headNonEmpty(args), connectiveExpr(kind, args.slice(1))] }",
				why: "A connective's list is nested into binary connectives, or([p, or([q, r])]), where grizzle stores the one flat connective its list states and flattens no nested one: a connective of three operands is stored, and its law named, as a nesting its author never wrote."
			}
		]
	}
)
