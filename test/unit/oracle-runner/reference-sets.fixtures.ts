/** What reference-sets.test.ts reads: its space, each case's reading by the reference, and the sets its spec gives. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { floatLiteral } from "#compiler/ir/carriers.ts"
import { conservativeMeta, type Heading, type RelNode } from "#compiler/ir/rel.ts"
import { canonicalSpec } from "#compiler/scalar/compute/registry.ts"
import { float4, float8 } from "#test/support/oracle/gen/domain.ts"
import { schemaName } from "#test/support/oracle/gen/schema.ts"
import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import { asNumber, valueAt } from "#test/support/oracle/reference/values.ts"
import { Q } from "#test/support/unit/lower/conservative/fixtures.ts"

/**
 * How a case reads its parameter relation: a region binding every column, each fact one binding, or a region binding
 * its first column alone, a merge of every fact of one value there, read through the canonical zero (check/merge.ts).
 */
type Shape = "whole" | "merged"

/** A float column's carrier. */
type Carrier = "float4" | "float8"

/** A case: its reading, its parameter relation's columns, and the rows drawn for it, a set of facts once deduplicated. */
export interface SetCase {
	readonly shape: Shape
	readonly carriers: Arr.NonEmptyReadonlyArray<Carrier>
	readonly rows: ReadonlyArray<ReadonlyArray<number>>
}

export type SetFeature =
	| "facts apart in a zero's sign alone"
	| "two zeros merged"
	| "every column bound"
	| "one column merged"

/** The values drawn: both zeros, a finite value, NaN and an infinity, each a float4's and a float8's exactly. */
const value = element([0, -0, 1, Number.NaN, Number.POSITIVE_INFINITY])

/** One to three float columns, and up to six rows of them. */
export const setCases: Gen<SetCase> = (source) => {
	const shape = element(["whole", "merged"] as const)(source)
	const first = element(["float4", "float8"] as const)(source)
	const more = Array.from({ length: int(0, 2)(source) }, () =>
		element(["float4", "float8"] as const)(source)
	)
	const carriers = Arr.prepend(more, first)
	const rows = Array.from({ length: int(0, 6)(source) }, () =>
		Arr.map(carriers, () => value(source))
	)
	return { shape, carriers, rows }
}

/** A float's text as a value: -0 apart from 0, NaN one text. */
const valueText = (x: number): string => (Object.is(x, -0) ? "-0" : String(x))

/** A float's text under native equality: -0 and 0 one. */
const nativeText = (x: number): string => String(x)

/** A row's text by `text`, its values' in column order. */
const rowText = (row: ReadonlyArray<number>, text: (x: number) => string): string =>
	Arr.join(Arr.map(row, text), " ")

/** The facts of a case's parameter relation: its rows, each fact once by its values (values/identity.ts factIdentity). */
const factsOf = (c: SetCase): ReadonlyArray<ReadonlyArray<number>> =>
	Arr.dedupeWith(c.rows, (a, b) => rowText(a, valueText) === rowText(b, valueText))

/** A set of texts, sorted. */
const setOf = (texts: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort(Arr.dedupe(texts), Str.Order)

/** The first value of a fact; a drawn row has one per column, and a case at least one column. */
const firstOf = (row: ReadonlyArray<number>): number => {
	const x = row[0]
	if (x === undefined) {
		throw new Error("a fact of no value")
	}
	return x
}

/**
 * The set a case's reading denotes, by its rows' texts as values (identity.ts): read whole, every fact, -0 and +0 at
 * otherwise equal fields two rows; merged, each first value once, its zero the canonical +0.
 */
export const specified = (c: SetCase): ReadonlyArray<string> =>
	c.shape === "whole"
		? setOf(Arr.map(factsOf(c), (row) => rowText(row, valueText)))
		: setOf(Arr.map(factsOf(c), (row) => valueText(firstOf(row) + 0)))

/** The case's reading as the reference evaluates it: its delivered rows' texts as values, sorted. */
export const evaluated = (c: SetCase): ReadonlyArray<string> => {
	const q = new Q()
	const columns: Heading = Arr.map(c.carriers, (carrier, i) => ({
		name: `c${i}`,
		type: carrier === "float4" ? float4 : float8
	}))
	const input = q.input("r", columns)
	const root: RelNode =
		c.shape === "whole"
			? q.region([
					{
						source: input,
						bind: Rec.fromEntries(Arr.map(columns, (col) => [col.name, col.name] as const)),
						constants: {}
					}
				])
			: merged(q, input)
	const query = q.build(root)
	const reference = Reference.of(query.dag, {
		schema: { name: schemaName, relations: [], closed: [], containments: [] },
		facts: {},
		params: {
			r: {
				kind: "relation",
				heading: columns,
				rows: Arr.map(factsOf(c), (row) => Arr.map(row, floatLiteral))
			}
		},
		functions: noFunctions,
		observer: unobserved
	})
	const rel = reference.eval(root, noBindings)
	return Arr.sort(
		Arr.map(rel.rows, (row) =>
			rowText(
				Arr.map(rel.heading, (_, i) => asNumber(valueAt(row, i))),
				valueText
			)
		),
		Str.Order
	)
}

/** A region binding the input's first column alone, read through a projection that delivers its canonical form. */
const merged = (q: Q, input: RelNode): RelNode => {
	const region = q.region([{ source: input, bind: { c0: "c0" }, constants: {} }])
	const read = q.col(region, "c0")
	const spec = canonicalSpec(read)
	if (spec === undefined) {
		throw new Error("no canonical form for a column of an identity type")
	}
	return q.project(region, [["c0", [q.b.expr(spec), read.type]]], conservativeMeta)
}

/** The features a case reaches. */
export const featuresOf = (c: SetCase): ReadonlyArray<SetFeature> => {
	const facts = factsOf(c)
	const apart = Arr.dedupe(Arr.map(facts, (row) => rowText(row, nativeText))).length < facts.length
	const zeros = Arr.map(facts, firstOf)
	return c.shape === "whole"
		? ["every column bound", ...(apart ? (["facts apart in a zero's sign alone"] as const) : [])]
		: [
				"one column merged",
				...(Arr.some(zeros, (x) => Object.is(x, -0)) && Arr.some(zeros, (x) => Object.is(x, 0))
					? (["two zeros merged"] as const)
					: [])
			]
}
