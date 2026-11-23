/** What the properties of generated-keys.test.ts read: the drawn relations of generated fields, their schemas, and the oracle. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/testing/assert"
import { array, constant, element, type Gen, int, subset, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import type { ExprDesc, FieldDesc } from "#compiler/ir/desc.ts"
import { keyFactors, type KeyProof } from "#compiler/ir/keys.ts"
import {
	decodedSchema,
	f,
	field,
	key,
	on,
	type QueryDesc,
	relation,
	type SchemaDesc,
	unit
} from "#test/support/fixtures/ir/desc.ts"
import { match, queryDesc, ref, relationSource, rule, varsAt } from "#test/unit/check/dsl.ts"

/** The written texts a generation may read, unbounded, as a QTI string is. */
const texts = ["a", "b", "c"] as const
/** The written floats a generation may read: -0 and +0 are one key value of each and two values. */
const floats = ["x", "y"] as const
type TextField = (typeof texts)[number]
type FloatField = (typeof floats)[number]

/** The written fields of every drawn relation, in declaration order: its primary key `id`, the texts, an integer, the floats. */
const written = ["id", ...texts, "n", ...floats] as const

/**
 * A generated field's generation, by what it reads:
 * - `digest`: the SHA-256 of its texts concatenated in order, the 32-byte SHA-256 carrier, the digest a QTI schema keys by;
 * - `float`: the negation of one float, or of the greater of two (a CHECK holds no float arithmetic but a negation);
 * - `mixed`: a digest of its texts or of their reverse, by the sign of a float, which it reads too;
 * - `money`: the integer converted to money, a stable conversion (lc_monetary), which PostgreSQL never generates a
 *   column by, so the schema is refused.
 */
export type Generation =
	| { readonly kind: "digest"; readonly texts: Arr.NonEmptyReadonlyArray<TextField> }
	| { readonly kind: "float"; readonly floats: Arr.NonEmptyReadonlyArray<FloatField> }
	| {
			readonly kind: "mixed"
			readonly float: FloatField
			readonly texts: Arr.NonEmptyReadonlyArray<TextField>
	  }
	| { readonly kind: "money" }

/** A drawn relation: its generated fields g0, g1, ... in order, and its candidate keys over them and its integer `n`. */
export interface GeneratedCase {
	readonly generations: Arr.NonEmptyReadonlyArray<Generation>
	readonly keys: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<string>>
}

export type GeneratedFeature =
	| "a key over a digest of one text"
	| "a key over a digest of several texts"
	| "a key over two digests"
	| "a key over a digest and a written field"
	| "a key over a generation reading a float"
	| "a key over a mixed generation"
	| "a stable generation refused"

/** The name of the generated field at `i`. */
export const generatedName = (i: number): string => `g${i}`

/** The fields a generation reads, each once, in its expression's order. */
export const readsOf = (g: Generation): ReadonlyArray<string> => {
	switch (g.kind) {
		case "digest":
			return g.texts
		case "float":
			return g.floats
		case "mixed":
			return [g.float, ...g.texts]
		case "money":
			return ["n"]
	}
}

/** Whether a generation reads a float, which a key compares -0 and +0 of as one value it may tell apart. */
export const readsFloat = (g: Generation): boolean =>
	Arr.some(readsOf(g), (r) => Arr.some(floats, (x) => x === r))

const nonEmpty = <A>(values: ReadonlyArray<A>): Arr.NonEmptyReadonlyArray<A> => {
	const [first, ...rest] = values
	return [defined(first, "a nonempty draw"), ...rest]
}

const textsGen: Gen<Arr.NonEmptyReadonlyArray<TextField>> = (source) =>
	nonEmpty(source.draw(subset(texts, { min: 1, max: texts.length })))

const generationGen: Gen<Generation> = (source) => {
	switch (
		source.draw(
			weighted<Generation["kind"]>([
				[2, constant("digest")],
				[1, constant("float")],
				[1, constant("mixed")],
				[1, constant("money")]
			])
		)
	) {
		case "digest":
			return { kind: "digest", texts: source.draw(textsGen) }
		case "float":
			return {
				kind: "float",
				floats: nonEmpty(source.draw(subset(floats, { min: 1, max: floats.length })))
			}
		case "mixed":
			return { kind: "mixed", float: source.draw(element(floats)), texts: source.draw(textsGen) }
		case "money":
			return { kind: "money" }
	}
}

/** A relation of one to three generated fields and one or two candidate keys, each over them and `n`. */
export const generatedCaseGen: Gen<GeneratedCase> = (source) => {
	const generations = nonEmpty(source.draw(array(generationGen, { min: 1, max: 3 })))
	const keyable = [...Arr.map(indices(generations.length), generatedName), "n"]
	const keys = nonEmpty(
		source.draw(
			array(
				(s) => {
					const generated = generatedName(s.draw(int(0, generations.length - 1)))
					const others = Arr.filter(keyable, (k) => k !== generated)
					return nonEmpty([
						generated,
						...s.draw(subset(others, { min: 0, max: Math.min(2, others.length) }))
					])
				},
				{ min: 1, max: 2 }
			)
		)
	)
	return { generations, keys: leastKeys(keys) }
}

/**
 * The keys of `drawn` no other one holds the fields of, each set once, the first of two alike: a schema states each key
 * once and no key over a superset of another's fields, which holds apart the same rows.
 */
const leastKeys = (
	drawn: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<string>>
): Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<string>> => {
	const within = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
		Arr.every(a, (f) => b.includes(f))
	return nonEmpty(
		Arr.filter(drawn, (k, i) =>
			Arr.every(drawn, (other, j) => j === i || !within(other, k) || (within(k, other) && j > i))
		)
	)
}

/** Each generated field of a case: its generation, its name and its place. */
export const generatedOf = (
	c: GeneratedCase
): ReadonlyArray<{ readonly g: Generation; readonly name: string; readonly at: number }> =>
	Arr.map(c.generations, (g, at) => ({ g, name: generatedName(at), at }))

/** The features a case's keys reach. */
export const featuresOf = (c: GeneratedCase): ReadonlyArray<GeneratedFeature> => {
	const named = generatedOf(c)
	return Arr.flatMap(c.keys, (k): ReadonlyArray<GeneratedFeature> => {
		const held = Arr.flatMap(named, ({ g, name }) => (k.includes(name) ? [g] : []))
		const digests = Arr.filter(held, (g) => g.kind === "digest")
		return [
			...(Arr.some(digests, (g) => g.texts.length === 1)
				? ["a key over a digest of one text" as const]
				: []),
			...(Arr.some(digests, (g) => g.texts.length > 1)
				? ["a key over a digest of several texts" as const]
				: []),
			...(digests.length > 1 ? ["a key over two digests" as const] : []),
			...(digests.length > 0 && k.includes("n")
				? ["a key over a digest and a written field" as const]
				: []),
			...(Arr.some(held, (g) => g.kind === "float")
				? ["a key over a generation reading a float" as const]
				: []),
			...(Arr.some(held, (g) => g.kind === "mixed")
				? ["a key over a mixed generation" as const]
				: [])
		]
	})
}

/** A SHA-256 digest, the 32-byte carrier Crypto.sha256 yields. */
const digest: FieldDesc = { kind: "sha256" }
const doublePrecision: FieldDesc = f.pg("double precision")

const compute = (fn: "sha256" | "concat" | "neg", args: ReadonlyArray<ExprDesc>): ExprDesc => ({
	kind: "compute",
	fn,
	args
})

/** The SHA-256 of `parts` concatenated in order. */
const digestOf = (parts: Arr.NonEmptyReadonlyArray<string>): ExprDesc => {
	const [first, ...rest] = parts
	return compute("sha256", [
		Arr.reduce(rest, field(first), (joined, part) => compute("concat", [joined, field(part)]))
	])
}

/** A generation's field declaration: its type and its expression. */
const generatedDecl = (g: Generation) => {
	switch (g.kind) {
		case "digest":
			return f.generated(digest, digestOf(g.texts))
		case "float": {
			const [x, y] = g.floats
			return f.generated(
				doublePrecision,
				y === undefined
					? compute("neg", [field(x)])
					: {
							kind: "cond",
							pred: { kind: "compare", op: "gt", left: field(x), right: field(y) },
							onTrue: compute("neg", [field(x)]),
							onFalse: compute("neg", [field(y)])
						}
			)
		}
		case "mixed":
			return f.generated(digest, {
				kind: "cond",
				pred: {
					kind: "compare",
					op: "gt",
					left: field(g.float),
					right: { kind: "literal", value: 0 }
				},
				onTrue: digestOf(g.texts),
				onFalse: digestOf(Arr.reverse(g.texts))
			})
		case "money":
			return f.generated(f.pg("money"), { kind: "cast", to: f.pg("money"), arg: field("n") })
	}
}

/** The relation's name in every case. */
export const relationName = "R"

/** The schema of a case: R keyed by `id`, its written fields, its generated ones, and its candidate keys. */
export const schemaOf = (c: GeneratedCase): SchemaDesc => ({
	name: "generated_keys",
	relations: [
		relation(
			relationName,
			{
				id: f.integer,
				a: f.wildcard,
				b: f.wildcard,
				c: f.wildcard,
				n: f.integer,
				x: doublePrecision,
				y: doublePrecision,
				...Rec.fromEntries(Arr.map(c.generations, (g, i) => [generatedName(i), generatedDecl(g)]))
			},
			["id"]
		)
	],
	statements: Arr.map(c.keys, (k) => key(on(relationName, k))),
	bases: []
})

/** Every column of a case's relation, written then generated. */
const columnsOf = (c: GeneratedCase): ReadonlyArray<string> => [
	...written,
	...Arr.map(indices(c.generations.length), generatedName)
]

/** The derived relation of every case, on the level above R, reading R whole: R's rows, stored. */
export const viewName = "D"

/** The query reading every column of a case's relation from `source`, R or its view, its one match binding each. */
export const scanOf = (c: GeneratedCase, source: string): QueryDesc => {
	const columns = columnsOf(c)
	const each = Rec.fromEntries(Arr.map(columns, (col) => [col, ref(source, col)]))
	return queryDesc(
		rule({
			vars: varsAt(source, columns),
			matches: [match(relationSource(source), each)],
			where: [],
			head: each,
			interiors: [],
			attach: []
		})
	)
}

/**
 * The schema of a case with its view: the case's schema, R in a unit of its id, and on the level above it D, stored,
 * reading R whole, so D inherits every key R's rows have: each indexed, but one over the unbounded texts, which another
 * key's index holds as its alternative (analysis/derived/analyze.ts).
 */
export const viewSchemaOf = (c: GeneratedCase): SchemaDesc => ({
	name: "generated_keys_view",
	bases: [
		decodedSchema({
			...schemaOf(c),
			statements: [...schemaOf(c).statements, unit("Row", { id: f.integer })]
		})
	],
	relations: [
		{
			kind: "derived",
			name: viewName,
			level: 1,
			storage: "stored",
			query: scanOf(c, relationName)
		}
	],
	statements: []
})

/** A key as a sorted list of its columns, so two spellings of one key compare equal. */
const sortedKey = (k: Iterable<string>): ReadonlyArray<string> => Arr.sort(k, Order.String)

const keyOrder = Order.combine(
	Order.mapInput(Order.Number, (k: ReadonlyArray<string>) => k.length),
	Arr.makeOrder(Order.String)
)

/**
 * The minimal keys of a case's relation by brute force: every set of its columns whose closure under the relation's
 * dependencies is every column, with no proper subset that is: the primary key and each candidate key determine every
 * column, and each generation reading no float is determined by what it reads, a function of their values, each of
 * which its key value is. Sorted by size, then by its sorted columns.
 */
export const oracleKeys = (c: GeneratedCase): ReadonlyArray<ReadonlyArray<string>> => {
	const columns = columnsOf(c)
	const dependencies: ReadonlyArray<{
		readonly from: ReadonlyArray<string>
		readonly to: ReadonlyArray<string>
	}> = [
		{ from: ["id"], to: columns },
		...Arr.map(c.keys, (k) => ({ from: k, to: columns })),
		...Arr.flatMap(c.generations, (g, i) =>
			readsFloat(g) ? [] : [{ from: readsOf(g), to: [generatedName(i)] }]
		)
	]
	const closure = (start: ReadonlyArray<string>): ReadonlySet<string> => {
		const known = new Set(start)
		let changed = true
		while (changed) {
			changed = false
			for (const d of dependencies) {
				if (Arr.every(d.from, (x) => known.has(x)) && !Arr.every(d.to, (x) => known.has(x))) {
					for (const x of d.to) {
						known.add(x)
					}
					changed = true
				}
			}
		}
		return known
	}
	const of = (mask: number) => Arr.filter(columns, (_, i) => (mask & (1 << i)) !== 0)
	const keyMasks = Arr.filter(
		indices(2 ** columns.length),
		(mask) => closure(of(mask)).size === columns.length
	)
	const minimal = Arr.filter(
		keyMasks,
		(mask) => !Arr.some(keyMasks, (other) => other !== mask && (other & mask) === other)
	)
	return Arr.sort(
		Arr.map(minimal, (mask) => sortedKey(of(mask))),
		keyOrder
	)
}

/**
 * Every key a node's proofs state, each once, as a sorted list: of each proof, one minimal key of each of its choices,
 * each column any column of its class (ir/keys.ts keyFactors). Sorted as oracleKeys sorts.
 */
export const statedKeys = (
	proofs: ReadonlyArray<KeyProof>
): ReadonlyArray<ReadonlyArray<string>> => {
	const out = new Map<string, ReadonlyArray<string>>()
	for (const proof of proofs) {
		/** Each column of every class, one per class, beside each prefix. */
		const widened = (
			prefixes: ReadonlyArray<ReadonlyArray<string>>,
			classes: ReadonlyArray<ReadonlyArray<string>>
		): ReadonlyArray<ReadonlyArray<string>> =>
			Arr.reduce(classes, prefixes, (keys, members) =>
				Arr.flatMap(keys, (k) => Arr.map(members, (m) => [...k, m]))
			)
		const empty: ReadonlyArray<ReadonlyArray<string>> = [[]]
		const partial = Arr.reduce(keyFactors(proof), empty, (prefixes, choice) =>
			Arr.flatMap(choice, (classes) => widened(prefixes, classes))
		)
		for (const k of partial) {
			const sorted = sortedKey(k)
			out.set(Arr.join(sorted, "\u0000"), sorted)
		}
	}
	return Arr.sort([...out.values()], keyOrder)
}
