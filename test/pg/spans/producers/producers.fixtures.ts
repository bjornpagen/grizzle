/** What the properties of producers.test.ts read: its spaces, models and helpers. */

import { exact, ordered, set, structuralHash } from "@bjornpagen/testing/oracle"
import { Array as Arr } from "effect"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import {
	decodedQuery,
	type AuthoredExprDesc as ExprDesc,
	type RuleDesc
} from "#test/support/fixtures/ir/desc.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import {
	type RawRow,
	rowSet,
	type SpanCase,
	type SpanEndpointKind,
	type SpanQueryKind,
	spanDifference,
	spanEndpointKinds,
	spanIntersection,
	spanPack,
	spanTextOf,
	tickContract
} from "#test/support/oracle/gen/spans.ts"
import { type RelationSpec, T } from "#test/unit/lower/conservative/fixtures.ts"

/** The scalar type of a span field of the case's endpoint, as the checker types it: the registry's. */
export const spanType = (endpoint: SpanEndpointKind): ScalarType => {
	switch (endpoint) {
		case "integer":
			return scalarOf(
				{ kind: "span", endpoint: { kind: "pg", type: "integer" }, width: undefined },
				{}
			)
		case "bigint":
			return T.range8
		case "contract":
			return scalarOf(
				{
					kind: "span",
					endpoint: {
						kind: "contract",
						name: tickContract.name,
						base: { kind: "pg", type: "bigint" },
						predicate: undefined,
						facts: []
					},
					width: undefined
				},
				{}
			)
		case "date":
			return scalarOf(
				{ kind: "span", endpoint: { kind: "pg", type: "date" }, width: undefined },
				{}
			)
	}
}

export const relationSpec = (c: SpanCase, name: "Left" | "Right"): RelationSpec => {
	const during = spanType(c.schema.endpoint)
	return c.schema.relations[name].spanKeyed
		? {
				name,
				heading: [
					{ name: "group", type: T.int4 },
					{ name: "during", type: during }
				],
				primaryKey: ["group", "during"]
			}
		: {
				name,
				heading: [
					{ name: "id", type: T.int4 },
					{ name: "group", type: T.int4 },
					{ name: "during", type: during }
				],
				primaryKey: ["id"]
			}
}

/** A pair rule's head with a producer, and the query over it. */
const variable = (id: string): ExprDesc => ({ kind: "var", var: id })

const pairQuery = (head: RuleDesc["head"]): QueryDesc =>
	decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: [
					{ id: "g", origin: { relation: "Left", field: "group" } },
					{ id: "a", origin: { relation: "Left", field: "during" } },
					{ id: "b", origin: { relation: "Right", field: "during" } }
				],
				matches: [
					{
						source: { kind: "relation", name: "Left" },
						bindings: { group: variable("g"), during: variable("a") }
					},
					{
						source: { kind: "relation", name: "Right" },
						bindings: { group: variable("g"), during: variable("b") }
					}
				],
				where: [],
				head,
				interiors: [],
				attach: []
			}
		]
	})

/**
 * The pair query whose head carries the complete bound tuple beside the piece: group, left, right and the producer of
 * the case's kind. The pieces of one binding are told apart by the piece, so the produced heading is unique exactly
 * when (group, left, right) is a key of the pair, which holds when both relations are span-keyed.
 */
export const tupleQuery = (kind: "intersection" | "difference"): QueryDesc =>
	pairQuery({
		group: variable("g"),
		left: variable("a"),
		right: variable("b"),
		piece: { kind: "producer", fn: kind, args: [variable("a"), variable("b")] }
	})

/**
 * The bound-tuple query's rows by brute force, in the public heading's code-unit order: group, left, piece, right; and
 * how many binding pieces repeat another, the rows a missing DISTINCT would duplicate.
 */
export const tupleReference = (
	c: SpanCase,
	kind: "intersection" | "difference"
): { readonly expected: ReadonlyArray<RawRow>; readonly duplicates: number } => {
	const produce = kind === "intersection" ? spanIntersection : spanDifference
	const spanText = spanTextOf(c.schema.endpoint)
	const bag: Array<RawRow> = []
	for (const l of c.facts.Left) {
		for (const r of c.facts.Right) {
			if (l.group === r.group) {
				for (const p of produce(l.during, r.during)) {
					bag.push([String(l.group), spanText(l.during), spanText(p), spanText(r.during)])
				}
			}
		}
	}
	const expected = rowSet(bag)
	return { expected, duplicates: bag.length - expected.length }
}

/**
 * An ungrouped pack: the head is the pack term alone, so it groups by no other term and yields the maximal components
 * of every span of the relation, whatever its group; an empty relation yields no row.
 */
export const ungroupedPackQuery = (relation: "Left" | "Right"): QueryDesc =>
	decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: [{ id: "s", origin: { relation, field: "during" } }],
				matches: [
					{ source: { kind: "relation", name: relation }, bindings: { during: variable("s") } }
				],
				where: [],
				head: { piece: { kind: "producer", fn: "pack", args: [variable("s")] } },
				interiors: [],
				attach: []
			}
		]
	})

export const ungroupedPackReference = (
	c: SpanCase,
	relation: "Left" | "Right"
): ReadonlyArray<RawRow> =>
	rowSet(
		Arr.map(spanPack(Arr.map(c.facts[relation], (f) => f.during)), (p) => [
			spanTextOf(c.schema.endpoint)(p)
		])
	)

/**
 * What a generated case reaches: its query kind, the ungrouped pack of a pack case, and a bound-tuple case's uniqueness
 * shape, each with rows or empty.
 */
const outcomes = ["rows", "empty"] as const

const tupleKinds = ["intersection", "difference"] as const

const tupleShapes = ["proved", "duplicates", "unproved"] as const

type Outcome = (typeof outcomes)[number]

type ProducerFeature =
	| `${SpanQueryKind}:${Outcome}`
	| `endpoint:${SpanEndpointKind}`
	| `correlated:${Outcome}`
	| `ungroupedPack:${Outcome}`
	| `tuple:${(typeof tupleKinds)[number]}:${(typeof tupleShapes)[number]}:${Outcome}`

export const outcomeOf = (rows: ReadonlyArray<RawRow>): Outcome =>
	rows.length > 0 ? "rows" : "empty"

/**
 * The correlated producer is built as IR by hand, which no query builder reaches: a planted structure over drawn
 * facts, against the brute-force point-set difference.
 */
export const correlatedCases = 200

export const correlatedRequired: Arr.NonEmptyReadonlyArray<ProducerFeature> = Arr.map(
	outcomes,
	(outcome): ProducerFeature => `correlated:${outcome}`
)

export const kinds = [
	"intersection",
	"difference",
	"pack"
] as const satisfies ReadonlyArray<SpanQueryKind>

export const cases = 1000

export const situations: Arr.NonEmptyReadonlyArray<ProducerFeature> = [
	...Arr.flatMap(kinds, (kind) =>
		Arr.map(outcomes, (outcome): ProducerFeature => `${kind}:${outcome}`)
	),
	...Arr.map(outcomes, (outcome): ProducerFeature => `ungroupedPack:${outcome}`),
	...Arr.map(spanEndpointKinds, (endpoint): ProducerFeature => `endpoint:${endpoint}`),
	...Arr.flatMap(tupleKinds, (kind) =>
		Arr.map(tupleShapes, (shape): ProducerFeature => `tuple:${kind}:${shape}:rows`)
	)
]

export const sameRowSet = set(structuralHash, ordered(exact))
