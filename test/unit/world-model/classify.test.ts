/**
 * classifyEntry, the writable-entry rule of README "Writing through a role" restated clause by clause over the model's
 * entries, held to grizzle's own analysis (packages/engine/src/schema/entry.ts writableEntry) over every entry of a
 * small space.
 *
 * The base holds two ordinary relations P(id, v) and Q(id, w), each keyed by id, the roster K, the derived relation
 * D(id, v) over P, and the context C { x }. An entry's rule matches its would-be target T (P, Q, or D, which no write
 * targets), T's two fields each written by a head variable, by the same head variable as the field before, fixed by a
 * literal, a context term or a variable a context match binds, unnamed, or bound to a variable nothing else reads; its
 * head adds nothing, a literal, a context term or a second field naming a head variable; one further member joins
 * another relation, rivals T as a supplier, negates another relation or the context, compares a head variable, matches
 * the context, filters by the roster or by the derived relation; and the entry is that rule or the same rule twice.
 *
 * Every entry is a query grizzle's builder admits, built as the executor builds an installation's entries (execute/describe.ts
 * definitionOf). The rule and the analysis find it writable or not alike; a writable one
 * alike in its target, each head field's target field and standing (keyed, claim-fixed or free), and its fills; a
 * refused one by a clause the analysis's reason allows, since the analysis scans T's fields in its own order and the
 * rule names the first failing clause in the README's.
 *
 * Every shape's head holds a field by construction: a head extra of none or a duplicate is drawn only beside a field
 * use that puts a head variable in the head, and two rules only of such uses. The oracle is a second implementation,
 * grizzle's writable-entry analysis. Features, required in the space: every refusal of the rule, every kind of further
 * member beside a writable entry, every fill and every standing of a head field.
 *
 * Plant: ~/.cache/grizzle-release/BR07/plants/classify-rival-admitted.patch (the model's rule admitting a rival
 * supplier) turns the property red.
 */

import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, oneOf } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec, Result } from "effect"
import type { WritabilityReason } from "#compiler/core/causes.ts"
import type { LiteralDesc } from "#compiler/ir/desc.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { type FixedValue, writableEntry } from "#compiler/schema/entry.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { assert, defined } from "#test/support/assert.ts"
import { decodedSchema } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { buildBase, sourcesOf } from "#test/support/worlds/execute/build.ts"
import { definitionOf } from "#test/support/worlds/execute/describe.ts"
import { classifyEntry } from "#test/support/worlds/model/host.ts"
import type {
	BaseSpec,
	EntryClass,
	EntrySpec,
	Fill,
	HeadField,
	Occurrence,
	Rule,
	Term,
	HostValue,
	WritableRefusal
} from "#test/support/worlds/model/types.ts"

const integer = { kind: "integer", bits: 32 } as const
const id = (name: string): Term => ({ kind: "var", name })

const pairBase: BaseSpec = {
	name: "Pair",
	closed: [{ name: "K", members: ["a", "b"] }],
	relations: [
		{
			name: "P",
			fields: [
				{ name: "id", domain: integer },
				{ name: "v", domain: integer }
			],
			key: ["id"],
			mutability: "immutable"
		},
		{
			name: "Q",
			fields: [
				{ name: "id", domain: integer },
				{ name: "w", domain: integer }
			],
			key: ["id"],
			mutability: "immutable"
		}
	],
	laws: [],
	contexts: [{ name: "C", claim: { kind: "top-level" }, fields: [{ name: "x", domain: integer }] }],
	derived: [
		{
			name: "D",
			rules: [
				{
					matches: [
						{ source: { kind: "ordinary", name: "P" }, fields: { id: id("a"), v: id("b") } }
					],
					negations: [],
					comparisons: [],
					head: { id: id("a"), v: id("b") }
				}
			]
		}
	]
}
/** The pair base built as an application builds it, the values its rules match, and its decoded Description. */
const pairBuilt = Effect.runSync(Effect.orDie(buildBase(pairBase, "Pairs")))

const pairSources = sourcesOf(pairBuilt)

const pairDesc = decodedSchema(defined(schemaDescOf(pairBuilt.base), "the pair base's Description"))

type Target = "P" | "Q" | "D"
type FieldUse = "head" | "head-again" | "literal" | "claim-term" | "claim-var" | "unnamed" | "free"
type HeadExtra = "none" | "literal" | "claim" | "duplicate"
type Member =
	| "none"
	| "join"
	| "rival"
	| "negation"
	| "negated-claim"
	| "comparison"
	| "claim-match"
	| "closed-filter"
	| "derived-filter"

interface Shape {
	readonly target: Target
	readonly uses: readonly [FieldUse, FieldUse]
	readonly extra: HeadExtra
	readonly member: Member
	readonly rules: 1 | 2
}

/** Each target's fields, its source, and the ordinary relation its further members read. */
const targets: Readonly<
	Record<
		Target,
		{
			readonly fields: readonly [string, string]
			readonly source: Occurrence["source"]
			readonly other: "P" | "Q"
		}
	>
> = {
	P: { fields: ["id", "v"], source: { kind: "ordinary", name: "P" }, other: "Q" },
	Q: { fields: ["id", "w"], source: { kind: "ordinary", name: "Q" }, other: "P" },
	D: { fields: ["id", "v"], source: { kind: "derived", name: "D" }, other: "Q" }
}

/** The primary key of either ordinary relation, whichever one supplies an entry. */
const key: ReadonlyArray<string> = ["id"]
const secondOf = { P: "v", Q: "w" } as const

const one: Term = { kind: "literal", value: 1 }
const x: Term = { kind: "context", context: "C", field: "x" }
const cx: Term = { kind: "var", name: "cx" }
const claimMatch = (term: Term): Occurrence => ({
	source: { kind: "context", name: "C" },
	fields: { x: term }
})

/** What a shape's further member adds to its rule. */
interface MemberParts {
	readonly matches: ReadonlyArray<Occurrence>
	readonly negations: Rule["negations"]
	readonly comparisons: Rule["comparisons"]
}

const ruleOfShape = (s: Shape): Rule => {
	const target = targets[s.target]
	const [first, second] = target.fields
	const [u0, u1] = s.uses
	const termFor = (use: FieldUse, field: string): Term | undefined => {
		switch (use) {
			case "head":
				return id(`t_${field}`)
			case "free":
				return id(`f_${field}`)
			case "head-again":
				return u0 === "head" ? id(`t_${first}`) : id(`t_${field}`)
			case "literal":
				return one
			case "claim-term":
				return x
			case "claim-var":
				return cx
			case "unnamed":
				return undefined
		}
	}
	const bindings = [[first, termFor(u0, first)] as const, [second, termFor(u1, second)] as const]
	const headFields = [
		...(u0 === "head" ? [first] : []),
		...(u1 === "head" || (u1 === "head-again" && u0 !== "head") ? [second] : [])
	]
	const [hv0, hv1] = Arr.map(headFields, (f) => id(`t_${f}`))
	const head: Readonly<Record<string, Term>> = Rec.fromEntries(
		Arr.map(headFields, (f) => [f, id(`t_${f}`)] as const)
	)
	const extras: Readonly<Record<HeadExtra, Readonly<Record<string, Term>>>> = {
		none: {},
		literal: { lit: one },
		claim: { cl: x },
		duplicate: hv0 === undefined ? {} : { dup: hv0 }
	}
	const matched: Occurrence = {
		source: target.source,
		fields: Rec.fromEntries(
			Arr.flatMap(bindings, ([f, t]) => (t === undefined ? [] : [[f, t] as const]))
		)
	}
	const anchor = hv0 ?? one
	const other = (fields: Readonly<Record<string, Term>>): Occurrence => ({
		source: { kind: "ordinary", name: target.other },
		fields
	})
	const parts: Readonly<Record<Member, MemberParts>> = {
		none: { matches: [], negations: [], comparisons: [] },
		join: { matches: [other({ id: anchor })], negations: [], comparisons: [] },
		rival: {
			matches: [
				other({
					...(hv0 === undefined ? {} : { id: hv0 }),
					...(hv1 === undefined ? {} : { [secondOf[target.other]]: hv1 })
				})
			],
			negations: [],
			comparisons: []
		},
		negation: { matches: [], negations: [[other({ id: anchor })]], comparisons: [] },
		"negated-claim": { matches: [], negations: [[claimMatch(anchor)]], comparisons: [] },
		comparison: {
			matches: [],
			negations: [],
			comparisons: [{ left: hv0 ?? x, op: "<", right: one }]
		},
		"claim-match": { matches: [claimMatch(anchor)], negations: [], comparisons: [] },
		"closed-filter": {
			matches: [
				{ source: { kind: "closed", name: "K" }, fields: { id: { kind: "literal", value: "a" } } }
			],
			negations: [],
			comparisons: []
		},
		"derived-filter": {
			matches: [{ source: { kind: "derived", name: "D" }, fields: { id: anchor } }],
			negations: [],
			comparisons: []
		}
	}
	const member = parts[s.member]
	return {
		matches: [
			matched,
			...(Arr.contains(s.uses, "claim-var") ? [claimMatch(cx)] : []),
			...member.matches
		],
		negations: member.negations,
		comparisons: member.comparisons,
		head: { ...head, ...extras[s.extra] }
	}
}

const entryOfShape = (s: Shape): Extract<EntrySpec, { readonly kind: "query" }> => {
	const rule = ruleOfShape(s)
	return { kind: "query", rules: s.rules === 1 ? [rule] : [rule, rule] }
}

const firstUses: Arr.NonEmptyReadonlyArray<FieldUse> = [
	"head",
	"literal",
	"claim-term",
	"claim-var",
	"unnamed",
	"free"
]
const allUses: Arr.NonEmptyReadonlyArray<FieldUse> = [...firstUses, "head-again"]
const extras: Arr.NonEmptyReadonlyArray<HeadExtra> = ["none", "literal", "claim", "duplicate"]
/** The head extras that are a head field of their own, the head's only field where no use puts a variable there. */
const headFieldExtras: Arr.NonEmptyReadonlyArray<HeadExtra> = ["literal", "claim"]
/** The second field's uses that put a head variable in the head where the first field's does not. */
const headUses: Arr.NonEmptyReadonlyArray<FieldUse> = ["head", "head-again"]
const members: Arr.NonEmptyReadonlyArray<Member> = [
	"none",
	"join",
	"rival",
	"negation",
	"negated-claim",
	"comparison",
	"claim-match",
	"closed-filter",
	"derived-filter"
]
const targetNames = element<Target>(["P", "Q", "D"])

/** Whether a shape's field uses put a head variable in its head: a head field of T's first or second field. */
const headed = ([u0, u1]: Shape["uses"]): boolean =>
	u0 === "head" || u1 === "head" || u1 === "head-again"

/** One rule's shapes, every combination of target, field uses, head extra and further member whose head holds a field. */
const oneRule: Gen<Shape> = (source) => {
	const target = source.draw(targetNames)
	const uses: Shape["uses"] = [source.draw(element(firstUses)), source.draw(element(allUses))]
	return {
		target,
		uses,
		extra: source.draw(element(headed(uses) ? extras : headFieldExtras)),
		member: source.draw(element(members)),
		rules: 1
	}
}

/** Two rules' shapes, the rule written twice: each target's field uses that put a head variable in the head. */
const twoRules: Gen<Shape> = (source) => {
	const target = source.draw(targetNames)
	const u0 = source.draw(element(firstUses))
	return {
		target,
		uses: [u0, source.draw(element(u0 === "head" ? allUses : headUses))],
		extra: "none",
		member: "none",
		rules: 2
	}
}

/** Every shape whose head holds at least one field: one rule, every combination; two rules, of each target's uses. */
const shapes: Gen<Shape> = oneOf([oneRule, twoRules])

/**
 * What the analysis's refusal allows the rule to name: its own clause; for a field of T it finds unfixed, also a head
 * variable binding two fields of T that it reaches later, and for an unfixed key field also an unfixed field outside
 * the key that it reaches later.
 */
const allowedBy = (
	reason: WritabilityReason,
	keyFields: ReadonlyArray<string>
): ReadonlyArray<WritableRefusal> => {
	switch (reason.kind) {
		case "notOneArm":
			return ["several-rules"]
		case "headNotBareVariable":
		case "headFieldsShareAField":
			return ["head-term-not-own-field"]
		case "noSupplyingOccurrence":
			return ["no-supplier"]
		case "fieldNotFixed":
			return Arr.contains(keyFields, reason.field)
				? ["key-not-determined", "field-not-fixed", "head-term-not-own-field"]
				: ["field-not-fixed", "head-term-not-own-field"]
		case "bindingNotVariableOrLiteral":
		case "filterReadsFamily":
		case "keyHoldsFamily":
			return []
	}
}

/** A fixed literal of the small base as a model value. */
const valueOfLiteral = (v: LiteralDesc): HostValue => {
	if (typeof v === "bigint") {
		return Number(v)
	}
	if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
		return v
	}
	throw new Error("a fixed literal no field of the small base holds")
}

const fillOfFixed = (value: FixedValue): Fill =>
	value.kind === "literal"
		? { kind: "literal", value: valueOfLiteral(value.value) }
		: { kind: "context", context: value.context.name, field: value.field }

type ShapeFeature =
	| `refused: ${WritableRefusal}`
	| `writable over ${"P" | "Q"}`
	| `writable beside ${Member}`
	| "a fill from a literal"
	| "a fill from a claim"
	| `a ${HeadField["kind"]} head field`

/** What a verdict on a shape reaches: its refusal, or its target, fills, head standings and member beside it. */
const verdictFeatures = (s: Shape, c: EntryClass): ReadonlyArray<ShapeFeature> => {
	if (c.kind === "read-only") {
		return [`refused: ${c.reason}`]
	}
	const fills = Rec.values(c.fills)
	return [
		...(c.target === "P" || c.target === "Q" ? [`writable over ${c.target}` as const] : []),
		`writable beside ${s.member}`,
		...(Arr.some(fills, (f) => f.kind === "literal") ? ["a fill from a literal" as const] : []),
		...(Arr.some(fills, (f) => f.kind === "context") ? ["a fill from a claim" as const] : []),
		...Arr.map(Rec.values(c.head), (h): ShapeFeature => `a ${h.kind} head field`)
	]
}

const situations: Arr.NonEmptyReadonlyArray<ShapeFeature> = [
	"refused: several-rules",
	"refused: no-supplier",
	"refused: head-term-not-own-field",
	"refused: field-not-fixed",
	"refused: key-not-determined",
	"writable over P",
	"writable over Q",
	...Arr.map(
		Arr.filter(members, (m) => m !== "rival"),
		(m): ShapeFeature => `writable beside ${m}`
	),
	"a fill from a literal",
	"a fill from a claim",
	"a keyed head field",
	"a claimFixed head field",
	"a free head field"
]

describe("the writable-entry rule", () => {
	it.effect(
		"classifies every entry of the small space as grizzle's writable-entry analysis does",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every entry over P, Q or D of one rule, every field use, head extra and further member, or of the rule written twice, every head holding a field",
						oracle: {
							kind: "second-implementation",
							name: "grizzle's writable-entry analysis (schema/entry.ts writableEntry)"
						},
						suite: "unit/world-model/classify",
						generator: shapes,
						literal: Formatter.format,
						limit: 6000,
						coverage: requiredInSpace(situations),
						caseHang
					},
					(s, c) =>
						Effect.gen(function* () {
							const entry = entryOfShape(s)
							const what = Formatter.format(s)
							const built = yield* Effect.result(
								definitionOf(pairBase, pairSources, entry.rules, pairBuilt.base, what)
							)
							if (Result.isFailure(built)) {
								return assert.fail(
									`the builder refuses the entry, ${built.failure.message}: ${what}`
								)
							}
							const analysed = writableEntry(pairDesc, {
								name: "Entry",
								query: defined(queryValueDesc(built.success), `the Description of ${what}`)
							})
							const actual = classifyEntry(pairBase, entry)
							if (!analysed.ok) {
								assert.equal(
									actual.kind,
									"read-only",
									`the analysis refuses ${analysed.error.reason.kind}: ${what}`
								)
								if (actual.kind === "read-only") {
									assert.ok(
										Arr.contains(allowedBy(analysed.error.reason, key), actual.reason),
										`the rule names ${actual.reason}, the analysis ${analysed.error.reason.kind}: ${what}`
									)
								}
							} else {
								const w = analysed.value
								assert.deepEqual(
									actual,
									{
										kind: "writable",
										target: w.target,
										head: Rec.fromEntries(
											Arr.map(
												[...w.head],
												([name, h]) => [name, { field: h.field, kind: h.kind }] as const
											)
										),
										fills: Rec.fromEntries(
											Arr.map(w.fixed, (f) => [f.field, fillOfFixed(f.value)] as const)
										)
									},
									`the rule writes the entry as the analysis does: ${what}`
								)
							}
							c.noteAll(verdictFeatures(s, actual))
						})
				)
			)
	)
})
