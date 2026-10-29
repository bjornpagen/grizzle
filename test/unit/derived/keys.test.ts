import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	String as Str
} from "effect"
import { derivedKeyLayout } from "#compiler/analysis/derived/keys.ts"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import type { DerivedRefusal } from "#compiler/core/causes.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, key, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { derived as runtimeDerived } from "#compiler/schema/relation.ts"
import { schema as runtimeSchema } from "#compiler/schema/schema.ts"
import type { DefinitionQuery } from "#compiler/types/derived/derived.ts"
import { buildSchema, caseSketchGen } from "#test/pg/derived/oracle/gen.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { indices } from "#test/support/oracle/pick.ts"
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
const Base = schema("Base", { Org }, [key(Org, ["code"])])
/** A composite primary key beside a one-column candidate key. */
const Pair = relation("Pair", { a: uuid, b: uuid, c: uuid }, ["a", "b"])
const PairBase = schema("PairBase", { Pair }, [key(Pair, ["c"])])
/** Through the builders themselves, which take any definition query: some definitions below are ones derived's public
 * signature refuses (`DefinitionCheck`), which a JavaScript caller can still pass. */
const analyzedOver = (q: DefinitionQuery) =>
	Result.map(
		checkedIn(runtimeSchema.extend(Base, { D: runtimeDerived("D", q) }, [])),
		derivedAnalysis
	)

const Line = relation("Line", { id: uuid, amount: pg.bigint, embedding: pg.vector(1000) }, ["id"])
const L = schema("L", { Line }, [])
const analyzedOverLines = (q: DefinitionQuery) =>
	Result.map(checkedIn(runtimeSchema.extend(L, { T: runtimeDerived("T", q) }, [])), derivedAnalysis)

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
	const vars = v(Wide)
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
						const { note } = v(Org)
						return r.match(Org, { note }).find({ note })
					})
				),
				cause: {
					kind: "wholeHeading",
					relation: "D",
					key: ["note"],
					fault: { kind: "unbounded", field: "note", datum: "textBytes" }
				}
			}
		case "unbounded inherited key":
			return {
				analyzed: analyzedOver(
					query(Base).rule((r) => {
						const { id, note } = v(Org)
						return r.match(Org, { id, note }).find({ note, n: r.count() })
					})
				),
				cause: {
					kind: "inheritedKey",
					relation: "D",
					key: ["note"],
					fault: { kind: "unbounded", field: "note", datum: "textBytes" }
				}
			}
		case "one fact, no representable field":
			return {
				analyzed: analyzedOverLines(
					query(L).rule((r) => {
						const { id, amount } = v(Line)
						return r.match(Line, { id, amount }).find({ total: r.sum(amount) })
					})
				),
				cause: {
					kind: "oneFact",
					relation: "T",
					fields: ["total"],
					fault: { kind: "unbounded", field: "total", datum: "numericPrecision" }
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
						const { embedding } = v(Line)
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
						const { id } = v(Org)
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
							const { id } = v(Org)
							return r.match(Org, { id }).find({ id })
						})
						.attach(
							"same",
							(o) =>
								query(Base).rule((r) => {
									const { owner } = v(Org)
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
							const { id } = v(Org)
							return r.match(Org, { id }).find({ id, tag: r.literal("a") })
						})
						.rule((r) => {
							const { id, owner } = v(Org)
							return r.match(Org, { id, owner }).find({ id, tag: r.literal("b"), owner })
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
						features: features<KeyFeature>([
							"the whole heading",
							"at most one fact",
							"a level over a derived relation"
						]),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
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
								assert.equal(r.level, 1 + Math.max(0, ...below), `${name}'s level`)
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
						features: features<"several keys">(["several keys"]),
						caseHang: Duration.minutes(2)
					},
					(order, c) =>
						Effect.sync(() => {
							const q = query(Base).rule((r) => {
								const vars = v(Org)
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
								const vars = v(Pair)
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
											runtimeSchema.extend(PairBase, { P: runtimeDerived("P", pairs) }, [])
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

	it("keep a key through a projection of a join, its unique index resting on the key's constraint", () => {
		const Tag = relation("Tag", { org: uuid, tag: uuid }, ["org", "tag"])
		const JoinBase = schema("JoinBase", { Org, Tag }, [])
		const q = query(JoinBase).rule((r) => {
			const { id, owner } = v(Org)
			const { tag } = v(Tag)
			return r.match(Org, { id, owner }).match(Tag, { org: id, tag }).find({ id, owner })
		})
		const j = defined(
			succeeded(
				Result.map(
					checkedIn(runtimeSchema.extend(JoinBase, { J: runtimeDerived("J", q) }, [])),
					derivedAnalysis
				)
			).relations["J"]
		)
		keyRules(j)
		assert.deepEqual(
			Arr.map(j.keys, (k) => k.fields),
			[["id"]]
		)
		const [premise] = defined(j.keys[0]).proof.premises
		assert.ok(
			premise?.kind === "constraint" && premise.constraintKind === "primaryKey",
			"the key rests on Org's primary key"
		)
	})

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
					features: features<Unstorable>([
						"wildcard whole heading",
						"unbounded inherited key",
						"one fact, no representable field",
						"33 columns",
						"an entry above BTMaxItemSize",
						"an empty head",
						"an attachment",
						"several heading groups"
					]),
					caseHang: Duration.minutes(2)
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
