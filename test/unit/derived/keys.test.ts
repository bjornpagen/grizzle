import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore, sketched } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	Record as Rec,
	String as Str
} from "effect"
import { derivedKeyLayout } from "#compiler/analysis/derived/keys.ts"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import { indices, maxOf } from "#compiler/core/array.ts"
import type { DerivedRefusal } from "#compiler/core/causes.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, key, on, type Relation, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { derived as runtimeDerived } from "#compiler/schema/relation.ts"
import { schema as runtimeSchema } from "#compiler/schema/schema.ts"
import type { DefinitionQuery } from "#compiler/types/derived/derived.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { buildSchema, caseSketchGen } from "#test/pg/derived/oracle/gen.ts"
import {
	assert,
	deepEquals,
	defined,
	nonEmpty,
	succeeded,
	unorderedEqual
} from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { nonEmptyArgumentsOf } from "#test/support/list.ts"
import { checkedIn } from "#test/support/policy.ts"

/** The derived refusal an analysis ends with, narrowed so its cause reads.
 *
 * Key inheritance for derived relations: a derived relation needs no declared key and admits none.
 * Its keys are the keys its definition proves, each in heading order, narrowest first and then by heading position,
 * none implied by a narrower one; the whole heading when nothing narrower is proven; and for a definition of at most one
 * fact its first representable column. Each becomes a unique index, so each must fit PostgreSQL's B-tree entry and
 * column limits, and a definition a materialized view cannot store is refused.
 *
 * - Over the derived oracle's generated schemas (drawn levels, aggregates, take forms): every relation's keys keep
 *   those rules, a level is one above the derived relations it reads, and queries over a relation see its keys.
 * - Over generated joins of relations keyed by primary and candidate keys, each matched once: the keys are exactly the
 *   minimal sets of head columns whose closure, under each relation's keys bound whole, holds the head.
 * - Each refusal is planted, since a generated definition is always one a view stores: the full-heading fallback over
 *   wildcard text, an unbounded inherited key, a one-fact definition with no representable field, more than
 *   INDEX_MAX_KEYS columns, an entry above BTMaxItemSize, an empty head, an attachment, several heading groups.
 *
 * That the keys are sound, a refreshed view never holding two facts under one, is the refresh oracle's, whose views
 * are refreshed concurrently over their unique indexes. */
const causeOf = (r: Result.Result<unknown, CompileError>): DerivedRefusal => {
	if (r.ok) {
		throw new Error("expected a refusal")
	}
	const reason = r.error.reason
	assert.ok(reason._tag === "DerivedRefused", r.error.message)
	return reason.cause
}

const Org = relation("Org", { id: uuid, code: uuid, owner: uuid, note: str.regex("^.*$", "su") }, [
	"id"
])
const Base = schema("Base", { Org }, [key(on(Org, "code"))])
/** A composite primary key beside a one-column candidate key. */
const Pair = relation("Pair", { a: uuid, b: uuid, c: uuid }, ["a", "b"])
const PairBase = schema("PairBase", { Pair }, [key(on(Pair, "c"))])
/** Through the builders themselves, which take any definition query: some definitions below are ones derived's public
 * signature refuses (`DefinitionCheck`), which a JavaScript caller can still pass. */
const analyzedOver = (q: DefinitionQuery) =>
	Result.map(
		checkedIn(runtimeSchema.extend(Base, { D: runtimeDerived("D", q, []) }, [], [])),
		derivedAnalysis
	)

const Line = relation("Line", { id: uuid, amount: pg.bigint, embedding: pg.vector(1000) }, ["id"])
const L = schema("L", { Line }, [])
const analyzedOverLines = (q: DefinitionQuery) =>
	Result.map(
		checkedIn(runtimeSchema.extend(L, { T: runtimeDerived("T", q, []) }, [], [])),
		derivedAnalysis
	)

const Wide = relation(
	"Wide",
	{
		id: uuid,
		c00: pg.integer,
		c01: pg.integer,
		c02: pg.integer,
		c03: pg.integer,
		c04: pg.integer,
		c05: pg.integer,
		c06: pg.integer,
		c07: pg.integer,
		c08: pg.integer,
		c09: pg.integer,
		c10: pg.integer,
		c11: pg.integer,
		c12: pg.integer,
		c13: pg.integer,
		c14: pg.integer,
		c15: pg.integer,
		c16: pg.integer,
		c17: pg.integer,
		c18: pg.integer,
		c19: pg.integer,
		c20: pg.integer,
		c21: pg.integer,
		c22: pg.integer,
		c23: pg.integer,
		c24: pg.integer,
		c25: pg.integer,
		c26: pg.integer,
		c27: pg.integer,
		c28: pg.integer,
		c29: pg.integer,
		c30: pg.integer,
		c31: pg.integer,
		c32: pg.integer
	},
	["id"]
)
const WideSchema = schema("WideSchema", { Wide }, [])
const wideQuery = query(WideSchema).rule((r) => {
	const vars = v(Wide, "wide")
	const picked = {
		c00: vars.c00,
		c01: vars.c01,
		c02: vars.c02,
		c03: vars.c03,
		c04: vars.c04,
		c05: vars.c05,
		c06: vars.c06,
		c07: vars.c07,
		c08: vars.c08,
		c09: vars.c09,
		c10: vars.c10,
		c11: vars.c11,
		c12: vars.c12,
		c13: vars.c13,
		c14: vars.c14,
		c15: vars.c15,
		c16: vars.c16,
		c17: vars.c17,
		c18: vars.c18,
		c19: vars.c19,
		c20: vars.c20,
		c21: vars.c21,
		c22: vars.c22,
		c23: vars.c23,
		c24: vars.c24,
		c25: vars.c25,
		c26: vars.c26,
		c27: vars.c27,
		c28: vars.c28,
		c29: vars.c29,
		c30: vars.c30,
		c31: vars.c31,
		c32: vars.c32
	}
	return r.match(Wide, picked).find(picked)
})

/** A definition no view can store or index, planted, and the refusal it meets. */
type Unstorable =
	| "wildcard whole heading"
	| "unbounded inherited key"
	| "one fact, no representable field"
	| "33 columns"
	| "an entry above BTMaxItemSize"
	| "an empty head"
	| "an attachment"
	| "several heading groups"

const unstorable = (
	shape: Unstorable
): { readonly analyzed: Result.Result<unknown, CompileError>; readonly cause: DerivedRefusal } => {
	switch (shape) {
		case "wildcard whole heading":
			return {
				analyzed: analyzedOver(
					query(Base).rule((r) => {
						const { note } = v(Org, "org")
						return r.match(Org, { note }).find({ note })
					})
				),
				cause: {
					kind: "wholeHeading",
					relation: "D",
					key: ["note"],
					fault: { kind: "unboundedText", field: "note" }
				}
			}
		case "unbounded inherited key":
			return {
				analyzed: analyzedOver(
					query(Base).rule((r) => {
						const { id, note } = v(Org, "org")
						return r.match(Org, { id, note }).find({ note, n: r.count() })
					})
				),
				cause: {
					kind: "inheritedKey",
					relation: "D",
					key: ["note"],
					fault: { kind: "unboundedText", field: "note" }
				}
			}
		case "one fact, no representable field":
			return {
				analyzed: analyzedOver(
					query(Base).rule((r) => {
						const { id, note } = v(Org, "org")
						return r.match(Org, { id, note }).find({ least: r.min(note) })
					})
				),
				cause: {
					kind: "oneFact",
					relation: "D",
					fields: ["least"],
					fault: { kind: "unboundedText", field: "least" }
				}
			}
		case "33 columns":
			return {
				analyzed: Result.map(
					checkedIn(schema.extend(WideSchema, { WideCopy: derived("WideCopy", wideQuery) }, [])),
					derivedAnalysis
				),
				cause: {
					kind: "wholeHeading",
					relation: "WideCopy",
					key: Arr.map(indices(33), (i) => `c${pipe(String(i), Str.padStart(2, "0"))}`),
					fault: { kind: "columns", limit: 32 }
				}
			}
		case "an entry above BTMaxItemSize":
			return {
				analyzed: analyzedOverLines(
					query(L).rule((r) => {
						const { embedding } = v(Line, "line")
						return r.match(Line, { embedding }).find({ embedding })
					})
				),
				cause: {
					kind: "wholeHeading",
					relation: "T",
					key: ["embedding"],
					fault: { kind: "btreeEntry", bytes: 4024, limit: 2704 }
				}
			}
		case "an empty head":
			return {
				analyzed: analyzedOver(
					query(Base).rule((r) => {
						const { id } = v(Org, "org")
						return r.match(Org, { id }).find({})
					})
				),
				cause: { kind: "emptyHeading", relation: "D" }
			}
		case "an attachment":
			return {
				analyzed: analyzedOver(
					query(Base)
						.rule((r) => {
							const { id } = v(Org, "org")
							return r.match(Org, { id }).find({ id })
						})
						.attach(
							"same",
							(o) =>
								query(Base).rule((r) => {
									const { owner } = v(Org, "org")
									return r.match(Org, { id: o.id, owner }).find({ owner })
								}),
							"option"
						)
				),
				cause: { kind: "attachment", relation: "D" }
			}
		case "several heading groups":
			return {
				analyzed: analyzedOver(
					query(Base)
						.rule((r) => {
							const { id } = v(Org, "org")
							return r.match(Org, { id }).find({ id, tag: "a" })
						})
						.rule((r) => {
							const { id, owner } = v(Org, "org")
							return r.match(Org, { id, owner }).find({ id, tag: "b", owner })
						})
				),
				cause: { kind: "headingGroups", relation: "D" }
			}
	}
}

type KeyFeature =
	| "several keys"
	| "the whole heading"
	| "at most one fact"
	| "a level over a derived relation"

/** The rules every derived relation's keys keep (see the header). */
const keyRules = (r: {
	readonly name: string
	readonly heading: ReadonlyArray<{ readonly name: string }>
	readonly keys: ReadonlyArray<{ readonly fields: ReadonlyArray<string> }>
}): void => {
	const position = new Map(Arr.map(r.heading, (col, i) => [col.name, i]))
	const at = (field: string) => defined(position.get(field), `${r.name}.${field} in the heading`)
	const keys = Arr.map(r.keys, (k) => k.fields)
	assert.ok(keys.length > 0, `${r.name} has a key`)
	for (const k of keys) {
		assert.deepEqual(
			Arr.sort(k, Order.mapInput(Order.Number, at)),
			[...k],
			`${r.name}: a key in heading order`
		)
	}
	for (const [i, k] of keys.entries()) {
		for (const other of Arr.remove(keys, i)) {
			assert.ok(
				!Arr.every(other, (f) => k.includes(f)),
				`${r.name}: ${Arr.join(k, ",")} implies no other key`
			)
		}
	}
	for (const [i, k] of keys.entries()) {
		const next = keys[i + 1]
		if (next === undefined) {
			continue
		}
		const before =
			k.length < next.length ||
			(k.length === next.length &&
				(() => {
					for (const [n, f] of k.entries()) {
						const d = at(f) - at(defined(next[n]))
						if (d !== 0) {
							return d < 0
						}
					}
					return false
				})())
		assert.ok(before, `${r.name}: narrowest first, then by heading position`)
	}
}

/** How a definition binds one field of a relation it matches: left free, or to one of its variables. */
type Binding = { readonly kind: "free" } | { readonly kind: "bound"; readonly variable: number }

/** The variable a binding binds: none, or one. */
const variableOf = (b: Binding): ReadonlyArray<number> => (b.kind === "bound" ? [b.variable] : [])

/** A base relation of a join: its uuid fields, and its keys, the primary first, each a set of its fields as a mask. */
interface JoinRelation {
	readonly width: number
	readonly keys: Arr.NonEmptyReadonlyArray<number>
}

/**
 * A definition joining each of one to three relations once, each field bound to one of four variables or left free,
 * and the variables its head finds, as a mask. No relation is matched twice, so no two of its facts meet under one key
 * and the closure of the head's variables under each relation's keys is every dependency the definition holds.
 */
interface JoinSketch {
	readonly relations: Arr.NonEmptyReadonlyArray<JoinRelation>
	readonly bindings: ReadonlyArray<ReadonlyArray<Binding>>
	readonly head: number
}

/** The variables a definition may share between its matches. */
const joinVariables = 4

const joinRelationGen: Gen<JoinRelation> = (source) => {
	const width = source.draw(int(2, 3))
	const full = 2 ** width - 1
	const primary = source.draw(int(1, full))
	const candidate = source.draw(int(0, full))
	/** A candidate key is declared only when neither key holds the other, so neither is implied. */
	const apart = (candidate & primary) !== candidate && (candidate & primary) !== primary
	return { width, keys: apart ? [primary, candidate] : [primary] }
}

const bindingGen: Gen<Binding> = weighted([
	[1, constant<Binding>({ kind: "free" })],
	[3, map(int(0, joinVariables - 1), (variable): Binding => ({ kind: "bound", variable }))]
])

const joinSketchGen: Gen<JoinSketch> = (source) => {
	const relations = nonEmpty(
		source.draw(array(joinRelationGen, { min: 1, max: 3 })),
		"the relations"
	)
	return {
		relations,
		bindings: Arr.map(relations, (r) =>
			source.draw(array(bindingGen, { min: r.width, max: r.width }))
		),
		head: source.draw(int(0, 2 ** joinVariables - 1))
	}
}

/** The positions of a mask's set bits below `width`, in increasing order. */
const bitsOf = (mask: number, width: number): ReadonlyArray<number> =>
	Arr.filter(indices(width), (i) => (mask & (1 << i)) !== 0)

const fieldName = (i: number): string => `f${i}`
const headName = (variable: number): string => `v${variable}`

type JoinRelationValue = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

/** The base schema of a join's relations: R0, R1, ... of uuid fields, each keyed by its keys. */
const joinBase = (relations: Arr.NonEmptyReadonlyArray<JoinRelation>) => {
	const values = Arr.map(relations, (r, i): JoinRelationValue =>
		relation(
			`R${i}`,
			Rec.fromEntries(Arr.map(indices(r.width), (f) => [fieldName(f), uuid] as const)),
			nonEmpty(Arr.map(bitsOf(r.keys[0], r.width), fieldName), "a primary key")
		)
	)
	const statements = Arr.flatMap(relations, (r, i) =>
		Arr.map(r.keys.slice(1), (candidate) =>
			key(
				on(
					defined(values[i]),
					...nonEmptyArgumentsOf(
						nonEmpty(Arr.map(bitsOf(candidate, r.width), fieldName), "a candidate key")
					)
				)
			)
		)
	)
	return {
		values,
		schema: schema(
			"Joined",
			Rec.fromEntries(Arr.map(values, (value, i) => [`R${i}`, value] as const)),
			statements
		)
	}
}

/** A join resolved: each relation's bindings, every relation binding a field, its head, and its values built. */
interface Join {
	readonly relations: Arr.NonEmptyReadonlyArray<JoinRelation>
	/** Per relation, per field, how the definition binds it. */
	readonly bound: ReadonlyArray<ReadonlyArray<Binding>>
	/** The variables the head finds, in increasing order, which is the heading's order. */
	readonly head: Arr.NonEmptyReadonlyArray<number>
	readonly base: ReturnType<typeof joinBase>
	readonly definition: QueryValue
}

/** A sketch resolved: a relation that binds no field binds its first to a variable of its own. */
const joinOf = (sketch: JoinSketch): Join => {
	const bound = Arr.map(sketch.relations, (r, i): ReadonlyArray<Binding> => {
		const drawn = Arr.map(
			indices(r.width),
			(f): Binding => sketch.bindings[i]?.[f] ?? { kind: "free" }
		)
		return Arr.some(drawn, (b) => b.kind === "bound")
			? drawn
			: Arr.map(drawn, (b, f): Binding => (f === 0 ? { kind: "bound", variable: i } : b))
	})
	const used = Arr.sort(
		Arr.dedupe(Arr.flatMap(bound, (row) => Arr.flatMap(row, variableOf))),
		Order.Number
	)
	const found = Arr.filter(used, (x) => (sketch.head & (1 << x)) !== 0)
	const head = nonEmpty(found.length > 0 ? found : used.slice(0, 1), "the head")
	const base = joinBase(sketch.relations)
	const definition = queryOver(base.schema).rule((r: RuleValue) => {
		const terms = new Map<number, unknown>()
		let ruled = r
		for (const [i, value] of base.values.entries()) {
			const vars = varsOver(value, `m${i}`)
			const bindings: Record<string, unknown> = {}
			for (const [f, b] of defined(bound[i]).entries()) {
				for (const variable of variableOf(b)) {
					if (!terms.has(variable)) {
						terms.set(variable, vars[fieldName(f)])
					}
					bindings[fieldName(f)] = terms.get(variable)
				}
			}
			ruled = ruled.match(value, bindings)
		}
		return ruled.find(Rec.fromEntries(Arr.map(head, (x) => [headName(x), terms.get(x)] as const)))
	})
	return { relations: sketch.relations, bound, head, base, definition }
}

/**
 * The oracle: each relation's key among `keysOf`, every field of it bound, determines every variable the relation
 * binds; the keys are the minimal sets of head variables whose closure under those dependencies holds the head, each in
 * heading order.
 */
const minimalKeys = (
	j: Join,
	keysOf: (r: JoinRelation) => ReadonlyArray<number>
): ReadonlyArray<ReadonlyArray<number>> => {
	const dependencies = Arr.flatMap(j.relations, (r, i) => {
		const row = defined(j.bound[i])
		const to = Arr.flatMap(row, variableOf)
		return Arr.flatMap(keysOf(r), (k) => {
			const fields = bitsOf(k, r.width)
			const from = Arr.flatMap(fields, (f) => variableOf(defined(row[f])))
			return from.length === fields.length ? [{ from, to }] : []
		})
	})
	const closure = (set: ReadonlyArray<number>): ReadonlySet<number> => {
		const known = new Set(set)
		let grew = true
		while (grew) {
			grew = false
			for (const d of dependencies) {
				if (Arr.every(d.from, (x) => known.has(x)) && Arr.some(d.to, (x) => !known.has(x))) {
					for (const x of d.to) {
						known.add(x)
					}
					grew = true
				}
			}
		}
		return known
	}
	const sets = Arr.map(Arr.range(1, 2 ** j.head.length - 1), (mask) =>
		Arr.map(bitsOf(mask, j.head.length), (p) => defined(j.head[p]))
	)
	const keys = Arr.filter(sets, (set) => {
		const known = closure(set)
		return Arr.every(j.head, (x) => known.has(x))
	})
	return Arr.filter(
		keys,
		(k) =>
			!Arr.some(keys, (other) => other.length < k.length && Arr.every(other, (x) => k.includes(x)))
	)
}

type JoinFeature =
	| "the whole heading"
	| "a key narrower than the heading"
	| "several keys"
	| "a candidate key determines"
	| "a join of several relations"

/**
 * What a join's keys reached: several, one narrower than its heading or the whole heading alone, a candidate key whose
 * dependency the keys need, and a join of several relations.
 */
const joinFeatures = (
	j: Join,
	keys: ReadonlyArray<ReadonlyArray<number>>
): ReadonlyArray<JoinFeature> => [
	...(keys.length > 1 ? ["several keys" as const] : []),
	Arr.some(keys, (k) => k.length < j.head.length)
		? "a key narrower than the heading"
		: "the whole heading",
	...(deepEquals(
		minimalKeys(j, (r) => [r.keys[0]]),
		keys
	)
		? []
		: ["a candidate key determines" as const]),
	...(j.relations.length > 1 ? ["a join of several relations" as const] : [])
]

describe("derived relation keys", () => {
	it.effect(
		"are proven keys in heading order, narrowest first, none implied by another, the whole heading only alone",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/derived/keys",
						draw: drawn(caseSketchGen),
						literal: Formatter.format,
						coverage: required<KeyFeature>(
							["the whole heading", "at most one fact", "a level over a derived relation"],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
						Effect.sync(() => {
							const analysis = succeeded(
								Result.map(checkedIn(buildSchema(sketch, { name: "Gen" }).value), derivedAnalysis)
							)
							for (const r of analysis.order) {
								const name = r.name
								keyRules(r)
								const keys = Arr.map(r.keys, (k) => k.fields)
								if (keys.length > 1) {
									c.note("several keys")
								}
								if (r.wholeHeading) {
									c.note("the whole heading")
									assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(keys, [
										Arr.map(r.heading, (col) => col.name)
									])
								}
								if (r.card === "atMostOne") {
									c.note("at most one fact")
									const first = Arr.findFirst(r.heading, (col) => derivedKeyLayout([col]).ok)
									assert.ok(Option.isSome(first), `${name}'s first representable column`)
									assert.deepEqual(keys, [[first.value.name]])
									assert.equal(r.wholeHeading, false)
								}
								assert.deepEqual(
									Arr.map(r.read.keys, (k) => k.fields),
									keys
								)
								const below = Arr.flatMap(r.reads, (read) => {
									const lower = analysis.relations[read]
									return lower === undefined ? [] : [lower.level]
								})
								if (below.length > 0) {
									c.note("a level over a derived relation")
								}
								assert.equal(r.level, 1 + maxOf(below, 0), `${name}'s level`)
							}
						})
				)
			)
	)

	it.effect("inherit every retained candidate key, whatever order the head names them in", (ctx) =>
		Effect.gen(function* () {
			const heads = element<
				readonly ["owner" | "id" | "code", "owner" | "id" | "code", "owner" | "id" | "code"]
			>([
				["owner", "id", "code"],
				["owner", "code", "id"],
				["id", "owner", "code"],
				["id", "code", "owner"],
				["code", "owner", "id"],
				["code", "id", "owner"]
			])
			yield* searched(
				ctx,
				exhaust(
					{
						suite: "unit/derived/candidate-keys",
						generator: heads,
						literal: Formatter.format,
						limit: 6,
						coverage: requiredInSpace<"several keys">(["several keys"]),
						caseHang
					},
					(order, c) =>
						Effect.sync(() => {
							const q = query(Base).rule((r) => {
								const vars = v(Org, "org")
								return r.match(Org, { id: vars.id, code: vars.code, owner: vars.owner }).find({
									[order[0]]: vars[order[0]],
									[order[1]]: vars[order[1]],
									[order[2]]: vars[order[2]]
								})
							})
							const r = defined(succeeded(analyzedOver(q)).relations["D"])
							keyRules(r)
							assert.deepEqual(
								Arr.sort(
									Arr.map(r.keys, (k) => k.fields),
									Order.mapInput(Order.String, (fields: ReadonlyArray<string>) =>
										Arr.join(fields, ",")
									)
								),
								[["code"], ["id"]]
							)
							/** The composite key and the one-column key, the narrower first whatever the head's order. */
							const names = { owner: "a", id: "b", code: "c" } as const
							const pairs = query(PairBase).rule((rule) => {
								const vars = v(Pair, "pair")
								return rule.match(Pair, { a: vars.a, b: vars.b, c: vars.c }).find({
									[names[order[0]]]: vars[names[order[0]]],
									[names[order[1]]]: vars[names[order[1]]],
									[names[order[2]]]: vars[names[order[2]]]
								})
							})
							const p = defined(
								succeeded(
									Result.map(
										checkedIn(
											runtimeSchema.extend(PairBase, { P: runtimeDerived("P", pairs, []) }, [], [])
										),
										derivedAnalysis
									)
								).relations["P"]
							)
							keyRules(p)
							assert.deepEqual(defined(p.keys[0]).fields, ["c"])
							c.note("several keys")
						})
				)
			)
		})
	)

	it.effect(
		"are exactly the minimal sets of head columns a join's keys determine the head by, through every relation it matches",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/derived/join-keys",
						draw: sketched(joinSketchGen, joinOf),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the closure of the head's variables under each matched relation's keys bound whole, the head's minimal sets whose closure holds it"
						},
						coverage: required<JoinFeature>(
							[
								"the whole heading",
								"a key narrower than the heading",
								"several keys",
								"a candidate key determines",
								"a join of several relations",
								["a join of several relations", "a key narrower than the heading"]
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(j, c) =>
						Effect.sync(() => {
							const expected = minimalKeys(j, (r) => r.keys)
							const d = defined(
								succeeded(
									Result.map(
										checkedIn(
											runtimeSchema.extend(
												j.base.schema,
												{ D: runtimeDerived("D", j.definition, []) },
												[],
												[]
											)
										),
										derivedAnalysis
									)
								).relations["D"]
							)
							keyRules(d)
							unorderedEqual(
								Arr.map(d.keys, (k): ReadonlyArray<string> => k.fields),
								Arr.map(expected, (k) => Arr.map(k, headName))
							)
							const reached = joinFeatures(j, expected)
							c.noteAll(reached)
							if (
								Arr.contains(reached, "a join of several relations") &&
								Arr.contains(reached, "a key narrower than the heading")
							) {
								c.pair("a join of several relations", "a key narrower than the heading")
							}
						})
				)
			)
	)

	it.effect("refuse a definition no view can store or index, with its typed cause", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/derived/unstorable",
					generator: element<Unstorable>([
						"wildcard whole heading",
						"unbounded inherited key",
						"one fact, no representable field",
						"33 columns",
						"an entry above BTMaxItemSize",
						"an empty head",
						"an attachment",
						"several heading groups"
					]),
					literal: Formatter.format,
					limit: 8,
					coverage: requiredInSpace<Unstorable>([
						"wildcard whole heading",
						"unbounded inherited key",
						"one fact, no representable field",
						"33 columns",
						"an entry above BTMaxItemSize",
						"an empty head",
						"an attachment",
						"several heading groups"
					]),
					caseHang
				},
				(shape, c) =>
					Effect.sync(() => {
						c.note(shape)
						const { analyzed, cause } = unstorable(shape)
						assert.deepEqual(causeOf(analyzed), cause)
					})
			)
		)
	)
})
