/** What the properties of keys.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, deepEquals, defined, nonEmpty, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec, String as Str } from "effect"
import { derivedKeyLayout } from "#compiler/analysis/derived/keys.ts"
import { keyCarried } from "#compiler/analysis/logical/derived.ts"
import type { DerivedRefusal, KeyFault } from "#compiler/core/causes.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { Fn, Type } from "#compiler/public/compute.ts"
import { natural, int4, vector } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	derived,
	fn,
	key,
	on,
	type Relation,
	relation,
	rows,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { derivedBuilder as runtimeDerived, relationBuilder } from "#compiler/schema/relation.ts"
import { schemaBuilder as runtimeSchema } from "#compiler/schema/schema.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { Id } from "#test/support/ids.ts"
import { nonEmptyArgumentsOf } from "#test/support/list.ts"
import { descOf, regex, wildcard } from "#test/support/unit/schema/support.ts"
import { upTo } from "#test/support/up-to.ts"

export type KeyFeature =
	| "several keys"
	| "the whole heading"
	| "at most one fact"
	| "a level over a derived relation"
	| "a negation over a level whose conditional count is numeric"

/**
 * A derived relation's heading in key order, its columns' names: those its definition carries from a declared key first
 * (analysis/logical/derived.ts keyCarried), every other after, each part in heading order.
 */
export const keyOrder = (r: {
	readonly name: string
	readonly heading: ReadonlyArray<{ readonly name: string }>
	readonly query: LogicalQuery
}): ReadonlyArray<string> => {
	const [root] = r.query.dag.roots
	const carried = keyCarried(defined(root, `${r.name}: a definition's root`))
	return [
		...Arr.flatMap(r.heading, (c) => (carried.has(c.name) ? [c.name] : [])),
		...Arr.flatMap(r.heading, (c) => (carried.has(c.name) ? [] : [c.name]))
	]
}

/** Whether two keys hold the same columns, whatever their order. */
export const sameColumns = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	deepEquals<ReadonlyArray<string>>(Arr.sort(a, Order.String), Arr.sort(b, Order.String))

/**
 * The rules every derived relation's keys keep (see the header). Key order is the heading's with the columns the
 * definition carries from a declared key first (analysis/logical/derived.ts keyCarried), every other after, each part
 * in heading order; one fact's one key is a single column, which no order moves.
 */
export const keyRules = (r: {
	readonly name: string
	readonly heading: ReadonlyArray<{ readonly name: string }>
	readonly keys: ReadonlyArray<{ readonly fields: ReadonlyArray<string> }>
	readonly query: LogicalQuery
}): void => {
	const position = new Map(Arr.map(keyOrder(r), (name, i) => [name, i]))
	const at = (field: string) => defined(position.get(field), `${r.name}.${field} in the heading`)
	const keys = Arr.map(r.keys, (k) => k.fields)
	assert.ok(keys.length > 0, `${r.name} has a key`)
	for (const k of keys) {
		assert.deepEqual(
			Arr.sort(k, Order.mapInput(Order.Number, at)),
			[...k],
			`${r.name}: a key in key order`
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
		assert.ok(before, `${r.name}: narrowest first, then by key-order position`)
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

/** A relation a join matches, and how the join binds each of its fields, in field order. */
interface Matched {
	readonly relation: JoinRelation
	readonly bindings: ReadonlyArray<Binding>
}

/**
 * A definition joining each of one to three relations once, each field bound to one of four variables or left free,
 * and the variables its head finds, as a mask. No relation is matched twice, so no two of its facts meet under one key
 * and the closure of the head's variables under each relation's keys is every dependency the definition holds.
 */
interface JoinSketch {
	readonly matched: Arr.NonEmptyReadonlyArray<Matched>
	readonly head: number
	/** The order the head names the variables in: a permutation of them. */
	readonly order: ReadonlyArray<number>
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

const matchedGen: Gen<Matched> = (source) => {
	const relation = source.draw(joinRelationGen)
	return {
		relation,
		bindings: source.draw(array(bindingGen, { min: relation.width, max: relation.width }))
	}
}

export const joinSketchGen: Gen<JoinSketch> = (source) => ({
	matched: nonEmpty(source.draw(array(matchedGen, { min: 1, max: 3 })), "the relations"),
	head: source.draw(int(0, 2 ** joinVariables - 1)),
	order: source.draw(shuffled(indices(joinVariables), { min: joinVariables, max: joinVariables }))
})

/** A relation keyed by either of its two fields, so the variables bound to them are alternatives of each other. */
const eitherKeyed: JoinRelation = { width: 2, keys: [1, 2] }

/**
 * A join of two relations keyed by either of their two fields, each field bound to a variable of its own and every
 * variable in the head: its keys are two factors, each with an alternative, which joinSketchGen draws too rarely to rely
 * on.
 */
export const twoFactorSketchGen: Gen<JoinSketch> = (source) => {
	const variables = source.draw(
		shuffled(indices(joinVariables), { min: joinVariables, max: joinVariables })
	)
	return {
		matched: Arr.map(Arr.chunksOf(nonEmpty(variables, "the variables"), 2), (pair) => ({
			relation: eitherKeyed,
			bindings: Arr.map(pair, (variable): Binding => ({ kind: "bound", variable }))
		})),
		head: 2 ** joinVariables - 1,
		order: source.draw(shuffled(indices(joinVariables), { min: joinVariables, max: joinVariables }))
	}
}

/** Whether position `at` is in `mask`. */
const holds = (mask: number, at: number): boolean => (mask & (1 << at)) !== 0

/** The positions of a mask's set bits below `width`, in increasing order. */
const bitsOf = (mask: number, width: number): ReadonlyArray<number> =>
	Arr.filter(indices(width), (i) => holds(mask, i))

const fieldName = (i: number): string => `f${i}`

export const headName = (variable: number): string => `v${variable}`

type JoinRelationValue = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

/** The base schema of a join's relations: R0, R1, ... of uuid fields, each keyed by its keys. */
const joinBase = (relations: Arr.NonEmptyReadonlyArray<JoinRelation>) => {
	const keyed = Arr.map(relations, (r, i) => {
		const value: JoinRelationValue = relationBuilder(
			`R${i}`,
			Rec.fromEntries(Arr.map(indices(r.width), (f) => [fieldName(f), Id] as const)),
			nonEmpty(Arr.map(bitsOf(r.keys[0], r.width), fieldName), "a primary key"),
			[]
		)
		const candidates = Arr.map(r.keys.slice(1), (candidate) =>
			key(
				on(
					value,
					...nonEmptyArgumentsOf(
						nonEmpty(Arr.map(bitsOf(candidate, r.width), fieldName), "a candidate key")
					)
				)
			)
		)
		return { value, candidates }
	})
	const values = Arr.map(keyed, (k) => k.value)
	return {
		values,
		schema: schema(
			"Joined",
			Rec.values(Rec.fromEntries(Arr.map(values, (value, i) => [`R${i}`, value] as const))),
			Arr.flatMap(keyed, (k) => k.candidates)
		)
	}
}

/** A join resolved: each relation with its bindings, every relation binding a field, its head, and its values built. */
interface Join {
	readonly matched: Arr.NonEmptyReadonlyArray<Matched>
	/** The variables the head finds, in the heading's order: their names' code-unit order. */
	readonly head: Arr.NonEmptyReadonlyArray<number>
	/** The same variables, in the order the head names them. */
	readonly named: Arr.NonEmptyReadonlyArray<number>
	readonly base: ReturnType<typeof joinBase>
	readonly definition: QueryValue
}

/** A sketch resolved: a relation that binds no field binds its first to a variable of its own. */
export const joinOf = (sketch: JoinSketch): Join => {
	const matched = Arr.map(sketch.matched, (m, i): Matched =>
		Arr.some(m.bindings, (b) => b.kind === "bound")
			? m
			: {
					...m,
					bindings: Arr.map(m.bindings, (b, f): Binding =>
						f === 0 ? { kind: "bound", variable: i } : b
					)
				}
	)
	const used = Arr.sort(
		Arr.dedupe(Arr.flatMap(matched, (m) => Arr.flatMap(m.bindings, variableOf))),
		Order.Number
	)
	const found = Arr.filter(sketch.order, (x) => holds(sketch.head, x) && Arr.contains(used, x))
	const named = nonEmpty(found.length > 0 ? found : used.slice(0, 1), "the head")
	const head = Arr.sort(named, Order.mapInput(Order.String, headName))
	const base = joinBase(Arr.map(matched, (m) => m.relation))
	const definition = queryOver(base.schema).rule(joinRule(base.values, matched, named, {}))
	return { matched, head, named, base, definition }
}

/**
 * The rule matching `values`, the relations of a join in order, each bound as `matched` binds the join's, and finding
 * the variables `named` under their head names beside the columns `beside` holds.
 */
const joinRule =
	(
		values: ReadonlyArray<JoinRelationValue>,
		matched: ReadonlyArray<Matched>,
		named: ReadonlyArray<number>,
		beside: Readonly<Record<string, unknown>>
	) =>
	(r: RuleValue) => {
		const terms = new Map<number, unknown>()
		let ruled = r
		for (const [i, [value, m]] of Arr.zip(values, matched).entries()) {
			const vars = varsOver(value, `m${i}`)
			const bindings: Record<string, unknown> = {}
			for (const [f, b] of m.bindings.entries()) {
				for (const variable of variableOf(b)) {
					if (!terms.has(variable)) {
						terms.set(variable, vars[fieldName(f)])
					}
					bindings[fieldName(f)] = terms.get(variable)
				}
			}
			ruled = ruled.match(value, bindings)
		}
		return ruled.find({
			...Rec.fromEntries(Arr.map(named, (x) => [headName(x), terms.get(x)] as const)),
			...beside
		})
	}

/**
 * The closure model: each relation's key among `keysOf`, every field of it bound, determines every variable the
 * relation binds; whether the head variables `set` determine the whole head under those dependencies.
 */
const determinesHead = (
	j: Pick<Join, "matched" | "head">,
	keysOf: (r: JoinRelation) => ReadonlyArray<number>
): ((set: ReadonlyArray<number>) => boolean) => {
	const dependencies = Arr.flatMap(j.matched, (m) => {
		const to = Arr.flatMap(m.bindings, variableOf)
		return Arr.flatMap(keysOf(m.relation), (k) => {
			const fields = Arr.filter(m.bindings, (_, f) => holds(k, f))
			return Arr.every(fields, (b) => b.kind === "bound")
				? [{ from: Arr.flatMap(fields, variableOf), to }]
				: []
		})
	})
	return (set) => {
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
		return Arr.every(j.head, (x) => known.has(x))
	}
}

/** The minimal sets of a join's head variables that `determine` the head, each in heading order. */
const minimalHeadSets = (
	j: Pick<Join, "head">,
	determine: (set: ReadonlyArray<number>) => boolean
): ReadonlyArray<ReadonlyArray<number>> => {
	const keys = Arr.filter(
		Arr.map(
			upTo(2 ** j.head.length - 1, (i) => i + 1),
			(mask) => Arr.filter(j.head, (_, p) => holds(mask, p))
		),
		determine
	)
	return Arr.filter(
		keys,
		(k) =>
			!Arr.some(keys, (other) => other.length < k.length && Arr.every(other, (x) => k.includes(x)))
	)
}

/**
 * The oracle: the minimal sets of head variables whose closure under each relation's keys among `keysOf` holds the
 * head (determinesHead), each in heading order.
 */
export const minimalKeys = (
	j: Join,
	keysOf: (r: JoinRelation) => ReadonlyArray<number>
): ReadonlyArray<ReadonlyArray<number>> => minimalHeadSets(j, determinesHead(j, keysOf))

/**
 * Every key a view states (ir/keys.ts ViewKey): of each of its keys, one minimal key of each factor, its alternatives
 * grouped by the fields they stand for, the key's own fields among them, and each column of it or a member of its
 * class in its place, each in heading order.
 */
export const viewStated = (
	keys: ReadonlyArray<{
		readonly fields: ReadonlyArray<string>
		readonly members: ReadonlyArray<{ readonly of: string; readonly column: string }>
		readonly alternatives: ReadonlyArray<{
			readonly of: ReadonlyArray<string>
			readonly columns: ReadonlyArray<string>
		}>
	}>
): ReadonlyArray<ReadonlyArray<string>> => {
	const stated = Arr.flatMap(keys, (k) => {
		const factors = Arr.map(
			Arr.dedupeWith(
				Arr.map(k.alternatives, (a) => a.of),
				(x, y) => deepEquals(x, y)
			),
			(of) => [of, ...Arr.flatMap(k.alternatives, (a) => (deepEquals(a.of, of) ? [a.columns] : []))]
		)
		const rest = Arr.filter(k.fields, (f) => !Arr.some(k.alternatives, (a) => a.of.includes(f)))
		const chosen = Arr.reduce(
			factors,
			[rest],
			(keysSoFar: ReadonlyArray<ReadonlyArray<string>>, factor) =>
				Arr.flatMap(keysSoFar, (key) => Arr.map(factor, (alternative) => [...key, ...alternative]))
		)
		return Arr.flatMap(chosen, (key) =>
			Arr.reduce(key, [[]], (named: ReadonlyArray<ReadonlyArray<string>>, column) =>
				Arr.flatMap(named, (prefix) =>
					Arr.map(
						[column, ...Arr.flatMap(k.members, (m) => (m.of === column ? [m.column] : []))],
						(name) => [...prefix, name]
					)
				)
			)
		)
	})
	return Arr.dedupeWith(
		Arr.map(stated, (k) => Arr.sort(k, Order.String)),
		(x, y) => deepEquals(x, y)
	)
}

export type JoinFeature =
	| "a head out of its variables' order"
	| "the whole heading"
	| "a key narrower than the heading"
	| "several keys"
	| "a key of two factors, each with an alternative"
	| "a candidate key determines"
	| "a join of several relations"

/** The column of `k` that `other`, a key of its width, stands in place of: none unless they differ in exactly one. */
const swappedColumn = (
	k: ReadonlyArray<number>,
	other: ReadonlyArray<number>
): Option.Option<number> => {
	const lacked = Arr.filter(k, (x) => !other.includes(x))
	return other.length === k.length && lacked.length === 1 ? Arr.head(lacked) : Option.none()
}

/** Whether a key has alternatives for two of its columns: two other keys, each in place of a different one. */
const twoFactors = (keys: ReadonlyArray<ReadonlyArray<number>>): boolean =>
	Arr.some(
		keys,
		(k) => Arr.dedupe(Arr.getSomes(Arr.map(keys, (other) => swappedColumn(k, other)))).length > 1
	)

/**
 * What a join's keys reached: several, one narrower than its heading or the whole heading alone, a key of two factors
 * each with an alternative, a candidate key whose dependency the keys need, and a join of several relations.
 */
export const joinFeatures = (
	j: Join,
	keys: ReadonlyArray<ReadonlyArray<number>>
): ReadonlyArray<JoinFeature> => [
	...(keys.length > 1 ? ["several keys" as const] : []),
	...(twoFactors(keys) ? ["a key of two factors, each with an alternative" as const] : []),
	Arr.some(keys, (k) => k.length < j.head.length)
		? "a key narrower than the heading"
		: "the whole heading",
	...(deepEquals(
		minimalKeys(j, (r) => [r.keys[0]]),
		keys
	)
		? []
		: ["a candidate key determines" as const]),
	...(j.matched.length > 1 ? ["a join of several relations" as const] : []),
	...(deepEquals(j.named, j.head) ? [] : ["a head out of its variables' order" as const])
]

/** What reads a product's view a level above: nothing, the view whole, or the view whole beside a relation of its base. */
type Above =
	| { readonly kind: "none" }
	| { readonly kind: "whole" }
	| { readonly kind: "beside"; readonly relation: number }

/**
 * A product: a join of one to four relations, most keyed by either of their first two fields, each field bound to a
 * variable of its own, to an earlier field's variable (a join on it) or left free, every relation binding one; its head
 * a drawn subset of the variables in a drawn order (a projection); the further rules beside it, each matching
 * relations of the same fields bound alike but keyed by a drawn part of their keys, every rule's head telling it apart
 * by a literal; and what reads its view a level above.
 */
interface ProductSketch {
	readonly join: JoinSketch
	/** Each further rule's keys of each relation, in the join's relation order. */
	readonly rules: ReadonlyArray<ReadonlyArray<Arr.NonEmptyReadonlyArray<number>>>
	readonly above: Above
}

/** How a product binds a field: to a variable of its own, to an earlier field's, or not at all. */
type ProductBinding = "own" | "shared" | "free"

/** A relation of a product: most keyed by either of their first two fields, the rest as a join's relations are. */
const productRelationGen: Gen<JoinRelation> = weighted([
	[3, map(int(2, 3), (width): JoinRelation => ({ width, keys: [1, 2] }))],
	[1, joinRelationGen]
])

const productBindingGen: Gen<ProductBinding> = weighted([
	[6, constant<ProductBinding>("own")],
	[1, constant<ProductBinding>("shared")],
	[1, constant<ProductBinding>("free")]
])

const aboveGen =
	(relations: number): Gen<Above> =>
	(source) =>
		source.draw(
			weighted<Above>([
				[2, constant<Above>({ kind: "none" })],
				[1, constant<Above>({ kind: "whole" })],
				[1, map(int(0, relations - 1), (relation): Above => ({ kind: "beside", relation }))]
			])
		)

/** The keys a further rule keys a relation by: all of the first rule's, most often, or one of them. */
const ruleKeysGen = (relation: JoinRelation): Gen<Arr.NonEmptyReadonlyArray<number>> =>
	weighted<Arr.NonEmptyReadonlyArray<number>>([
		[2, constant(relation.keys)],
		...Arr.map(relation.keys, (k) => [1, constant<Arr.NonEmptyReadonlyArray<number>>([k])] as const)
	])

/**
 * A product over `relations`, each field bound by `binding`: a variable of its own is the next one minted, a shared
 * field takes a drawn earlier one, and a relation that bound none binds its first field to one of its own. Each
 * variable is in the head as `inHead` draws, and `rules` draws how many further rules there are.
 */
const productGen =
	(
		relations: Gen<Arr.NonEmptyReadonlyArray<JoinRelation>>,
		binding: Gen<ProductBinding>,
		inHead: Gen<boolean>,
		rules: Gen<number>
	): Gen<ProductSketch> =>
	(source) => {
		const drawn = source.draw(relations)
		let minted = 0
		const mint = (): Binding => {
			minted += 1
			return { kind: "bound", variable: minted - 1 }
		}
		const bindingOf = (kind: ProductBinding): Binding =>
			kind === "free"
				? { kind: "free" }
				: kind === "shared" && minted > 0
					? { kind: "bound", variable: source.draw(int(0, minted - 1)) }
					: mint()
		const matched = Arr.map(drawn, (relation): Matched => {
			const bindings = Arr.map(indices(relation.width), () => bindingOf(source.draw(binding)))
			return {
				relation,
				bindings: Arr.some(bindings, (b) => b.kind === "bound")
					? bindings
					: [mint(), ...bindings.slice(1)]
			}
		})
		const variables = indices(minted)
		return {
			join: {
				matched,
				head: Arr.reduce(variables, 0, (mask, x) => (source.draw(inHead) ? mask | (1 << x) : mask)),
				order: source.draw(shuffled(variables, { min: minted, max: minted }))
			},
			rules: Arr.map(indices(source.draw(rules)), () =>
				Arr.map(drawn, (relation) => source.draw(ruleKeysGen(relation)))
			),
			above: source.draw(aboveGen(drawn.length))
		}
	}

export const productSketchGen: Gen<ProductSketch> = productGen(
	map(array(productRelationGen, { min: 1, max: 4 }), (relations) =>
		nonEmpty(relations, "the relations")
	),
	productBindingGen,
	weighted([
		[3, constant(true)],
		[1, constant(false)]
	]),
	weighted([
		[2, constant(0)],
		[1, constant(1)],
		[1, constant(2)]
	])
)

/**
 * Four relations keyed by either of their two fields, each field a variable of its own in the head: four factors, in
 * `rules` further rules as many as drawn.
 */
const fourFactorSketchGen = (rules: Gen<number>): Gen<ProductSketch> =>
	productGen(
		constant<Arr.NonEmptyReadonlyArray<JoinRelation>>([
			eitherKeyed,
			eitherKeyed,
			eitherKeyed,
			eitherKeyed
		]),
		constant<ProductBinding>("own"),
		constant(true),
		rules
	)

/**
 * Two rules keying apart two relations that share a variable, beside up to two more relations keyed by either of their
 * first two fields: the first rule keys R0 by either of f0 and f1 and R1 by either of its fields, the second R0 by f1
 * alone, the third R1 by f0 alone. R0's f1 is R1's f0, so the union's keys over them are that variable, or R0's f0 with
 * R1's f1: a key no rule's keys hold alone.
 */
const crosswiseSketchGen: Gen<ProductSketch> = (source) => {
	const more = source.draw(
		array(
			map(int(2, 3), (width): JoinRelation => ({ width, keys: [1, 2] })),
			{ min: 0, max: 2 }
		)
	)
	const bound = (variable: number): Binding => ({ kind: "bound", variable })
	const starts = Arr.scan(more, 4, (start, r) => start + r.width)
	const matched: Arr.NonEmptyReadonlyArray<Matched> = [
		{ relation: { width: 3, keys: [1, 2] }, bindings: [bound(0), bound(1), bound(2)] },
		{ relation: eitherKeyed, bindings: [bound(1), bound(3)] },
		...Arr.map(more, (relation, i): Matched => ({
			relation,
			bindings: Arr.map(indices(relation.width), (f) =>
				bound(defined(starts[i], "each relation's first variable") + f)
			)
		}))
	]
	const minted = Arr.lastNonEmpty(starts)
	const variables = indices(minted)
	const alike = Arr.map(more, (r) => r.keys)
	return {
		join: {
			matched,
			head: 2 ** minted - 1,
			order: source.draw(shuffled(variables, { min: minted, max: minted }))
		},
		rules: [
			[[2], [1, 2], ...alike],
			[[1, 2], [1], ...alike]
		],
		above: source.draw(aboveGen(matched.length))
	}
}

/** The head column whose literal tells a product's rules apart. */
const tagName = "t"

/**
 * A product resolved: its first rule's join, every rule's relations, the base of all of them, the definition (one rule,
 * or a union of the rules, each finding its index as the tag), and what reads its view a level above.
 */
interface Product {
	readonly join: Join
	readonly rules: Arr.NonEmptyReadonlyArray<ReadonlyArray<JoinRelation>>
	readonly base: ReturnType<typeof joinBase>
	readonly definition: QueryValue
	readonly above: Above
}

export const productOf = (sketch: ProductSketch): Product => {
	const join = joinOf(sketch.join)
	const first = Arr.map(join.matched, (m) => m.relation)
	if (sketch.rules.length === 0) {
		return {
			join,
			rules: [first],
			base: join.base,
			definition: join.definition,
			above: sketch.above
		}
	}
	const rules: Arr.NonEmptyReadonlyArray<ReadonlyArray<JoinRelation>> = [
		first,
		...Arr.map(sketch.rules, (keys) =>
			Arr.map(first, (r, i): JoinRelation => ({
				width: r.width,
				keys: defined(keys[i], "a further rule keys every relation")
			}))
		)
	]
	const base = joinBase(nonEmpty(Arr.flatten(rules), "the relations"))
	const ruleAt = (at: number) =>
		joinRule(
			base.values.slice(at * first.length, (at + 1) * first.length),
			join.matched,
			join.named,
			{ [tagName]: at }
		)
	return {
		join,
		rules,
		base,
		definition: Arr.reduce(
			indices(sketch.rules.length),
			queryOver(base.schema).rule(ruleAt(0)),
			(query, at) => query.rule(ruleAt(at + 1))
		),
		above: sketch.above
	}
}

/**
 * The oracle over a product's rules: the minimal sets of head variables whose closure holds the head under every rule's
 * relations' keys, each in heading order; beside the tag, which tells every two rules apart, when there are several.
 */
export const productMinimal = (p: Product): ReadonlyArray<ReadonlyArray<string>> => {
	const j = p.join
	const keyed = Arr.map(p.rules, (relations) =>
		determinesHead(
			{
				head: j.head,
				matched: Arr.map(j.matched, (m, i) => ({
					...m,
					relation: defined(relations[i], "a rule keys every relation")
				}))
			},
			(r) => r.keys
		)
	)
	const tag = p.rules.length > 1 ? [tagName] : []
	return Arr.map(
		minimalHeadSets(j, (set) => Arr.every(keyed, (determine) => determine(set))),
		(k) => [...tag, ...Arr.map(k, headName)]
	)
}

/** The name a level above gives a field of the relation it reads beside the view. */
const besideName = (field: number): string => `w${field}`

/** Every set of `size` of `columns`, each in their order. */
const subsetsOfSize = (
	columns: ReadonlyArray<string>,
	size: number
): ReadonlyArray<ReadonlyArray<string>> => {
	const [first, ...rest] = columns
	if (size === 0) {
		return [[]]
	}
	return first === undefined
		? []
		: [
				...Arr.map(subsetsOfSize(rest, size - 1), (s) => [first, ...s]),
				...subsetsOfSize(rest, size)
			]
}

/** The distinct parts on `side` of a family of keys, each spelled by its sorted columns. */
const partsOn = (
	family: ReadonlyArray<ReadonlyArray<string>>,
	side: ReadonlyArray<string>
): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.map(family, (k) => Arr.join(Arr.sort(Arr.intersection(k, side), Order.String), ","))
	)

/**
 * The finest partition of a family of minimal keys' columns that the family is the product of, each part with the
 * family's distinct parts on it, by brute force. A part splits off the columns left when the family's parts on it, times
 * its parts on the rest, are as many as its parts on all of them; the finest part holding a column is the least such
 * part holding it, since two parts that split off meet in one that does.
 */
const finestFactors = (
	keys: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<ReadonlyArray<string>> => {
	const factors: Array<ReadonlyArray<string>> = []
	let left = Arr.dedupe(Arr.flatten(keys))
	for (let [column] = left; column !== undefined; [column] = left) {
		const held = column
		const others = Arr.filter(left, (c) => c !== held)
		const splits = (part: ReadonlyArray<string>): boolean =>
			partsOn(keys, part).length * partsOn(keys, Arr.difference(left, part)).length ===
			partsOn(keys, left).length
		const part = Arr.findFirst(
			Arr.flatMap(indices(others.length + 1), (size) =>
				Arr.map(subsetsOfSize(others, size), (s) => [held, ...s])
			),
			splits
		)
		const factor = Option.getOrElse(part, () => left)
		factors.push(partsOn(keys, factor))
		left = Arr.difference(left, factor)
	}
	return factors
}

/** The unique indexes a view of minimal keys `keys` states: the key, and one per alternative of each finest factor. */
const productIndexes = (keys: ReadonlyArray<ReadonlyArray<string>>): number =>
	1 + Arr.reduce(finestFactors(keys), 0, (n, parts) => n + parts.length - 1)

/**
 * The laws a product's view keeps: the derived relation keys' rules; every key it indexes a minimal key; the keys it
 * states, each key's factors chosen among their alternatives, exactly the minimal keys; and one unique index for the key
 * and each alternative of each factor of their finest product, k + 1 for k factors of two keys each.
 */
export const productLaws = (
	r: Parameters<typeof keyRules>[0] & {
		readonly read: { readonly keys: Parameters<typeof viewStated>[0] }
	},
	minimal: ReadonlyArray<ReadonlyArray<string>>
): void => {
	keyRules(r)
	assert.ok(
		Arr.every(r.keys, (k) => Arr.some(minimal, (m) => sameColumns(m, k.fields))),
		`every key ${r.name} indexes is a minimal key`
	)
	unorderedEqual(
		viewStated(r.read.keys),
		Arr.map(minimal, (k) => Arr.sort(k, Order.String))
	)
	assert.equal(
		r.keys.length,
		productIndexes(minimal),
		`${r.name}: one index per alternative of a factor`
	)
}

export type ProductFeature =
	| "four factors of two minimal keys each"
	| "several rules"
	| "several rules of four factors of two minimal keys each"
	| "rules keying a relation apart"
	| "a key no rule's keys hold alone"
	| "a factor's minimal key of several columns"
	| "a projection dropping a column"
	| "relations joined on a variable"
	| "a level reading the view whole"
	| "a level reading the view beside one of its relations"

/** Whether a key of a product's view, beside its tag, is a minimal key of the rule over `relations` alone. */
const ruleMinimal = (
	p: Product,
	relations: ReadonlyArray<JoinRelation>,
	key: ReadonlyArray<string>
): boolean =>
	Arr.some(
		minimalHeadSets(
			p.join,
			determinesHead(
				{
					head: p.join.head,
					matched: Arr.map(p.join.matched, (m, i) => ({
						...m,
						relation: defined(relations[i], "a rule keys every relation")
					}))
				},
				(r) => r.keys
			)
		),
		(set) =>
			deepEquals(
				Arr.sort(Arr.map(set, headName), Order.String),
				Arr.sort(
					Arr.filter(key, (c) => c !== tagName),
					Order.String
				)
			)
	)

/** What a product and its view's minimal keys reached. */
export const productFeatures = (
	p: Product,
	keys: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<ProductFeature> => {
	const bound = Arr.flatMap(p.join.matched, (m) => Arr.flatMap(m.bindings, variableOf))
	const alternated = Arr.filter(finestFactors(keys), (parts) => parts.length > 1)
	const several = p.rules.length > 1
	return [
		...(alternated.length >= 4 ? ["four factors of two minimal keys each" as const] : []),
		...(several ? ["several rules" as const] : []),
		...(several && alternated.length >= 4
			? ["several rules of four factors of two minimal keys each" as const]
			: []),
		...(Arr.some(
			p.rules,
			(relations) =>
				!deepEquals<ReadonlyArray<ReadonlyArray<number>>>(
					Arr.map(relations, (r) => r.keys),
					Arr.map(p.rules[0], (r) => r.keys)
				)
		)
			? ["rules keying a relation apart" as const]
			: []),
		...(several &&
		Arr.some(keys, (k) => !Arr.some(p.rules, (relations) => ruleMinimal(p, relations, k)))
			? ["a key no rule's keys hold alone" as const]
			: []),
		...(Arr.some(alternated, (parts) => Arr.some(parts, Str.includes(",")))
			? ["a factor's minimal key of several columns" as const]
			: []),
		...(p.join.head.length < Arr.dedupe(bound).length
			? ["a projection dropping a column" as const]
			: []),
		...(Arr.dedupe(bound).length < bound.length ? ["relations joined on a variable" as const] : []),
		...(p.above.kind === "whole" ? ["a level reading the view whole" as const] : []),
		...(p.above.kind === "beside"
			? ["a level reading the view beside one of its relations" as const]
			: [])
	]
}

/**
 * The definition a level above a product's view reads it by, and its minimal keys: the view whole, each column bound to
 * a variable of the head under its own name, whose keys are the view's; or beside a relation of the base, each of its
 * fields in the head, whose keys are each of the view's with each of the relation's, its keys apart from each other.
 */
export const aboveOf = (
	p: Product,
	minimal: ReadonlyArray<ReadonlyArray<string>>,
	view: ReturnType<typeof runtimeDerived>,
	level: ReturnType<typeof runtimeSchema.extend>
):
	| { readonly definition: QueryValue; readonly minimal: ReadonlyArray<ReadonlyArray<string>> }
	| undefined => {
	const columns = [...(p.rules.length > 1 ? [tagName] : []), ...Arr.map(p.join.head, headName)]
	const viewTerms = (r: RuleValue) => {
		const d = varsOver(view, "d")
		const terms = Rec.fromEntries(Arr.map(columns, (c) => [c, d[c]] as const))
		return { ruled: r.match(view, terms), terms }
	}
	switch (p.above.kind) {
		case "none":
			return undefined
		case "whole":
			return {
				definition: queryOver(level).rule((r: RuleValue) => {
					const { ruled, terms } = viewTerms(r)
					return ruled.find(terms)
				}),
				minimal
			}
		case "beside": {
			const at = p.above.relation
			const value = defined(p.base.values[at], "the relation beside the view")
			const relation = defined(p.rules[0][at], "the relation beside the view")
			const fields = indices(relation.width)
			return {
				definition: queryOver(level).rule((r: RuleValue) => {
					const { ruled, terms } = viewTerms(r)
					const e = varsOver(value, "e")
					return ruled
						.match(
							value,
							Rec.fromEntries(Arr.map(fields, (f) => [fieldName(f), e[fieldName(f)]] as const))
						)
						.find({
							...terms,
							...Rec.fromEntries(Arr.map(fields, (f) => [besideName(f), e[fieldName(f)]] as const))
						})
				}),
				minimal: Arr.flatMap(minimal, (k) =>
					Arr.map(relation.keys, (mask) => [
						...k,
						...Arr.map(bitsOf(mask, relation.width), besideName)
					])
				)
			}
		}
	}
}

/**
 * The planted product each requirement a drawn product seldom meets is aimed at: a key no rule's keys hold alone, the
 * crosswise one; one naming several rules, two rules of four factors of two keys keyed alike; one naming four factors,
 * one rule of them.
 */
export const productAims: ReadonlyArray<readonly [Reached<ProductFeature>, Gen<ProductSketch>]> = [
	["a key no rule's keys hold alone", crosswiseSketchGen],
	["several rules of four factors of two minimal keys each", fourFactorSketchGen(constant(1))],
	["several rules", fourFactorSketchGen(constant(1))],
	[["several rules", "a level reading the view whole"], fourFactorSketchGen(constant(1))],
	["four factors of two minimal keys each", fourFactorSketchGen(constant(0))],
	[
		["four factors of two minimal keys each", "a level reading the view whole"],
		fourFactorSketchGen(constant(0))
	]
]

/**
 * A field of the stored relation beside its uuid key `id`: a text of up to 255 characters, PostgreSQL's repetition
 * limit, and a vector of a dimension count drawn around the B-tree item limit's.
 */
type StoredType =
	| { readonly kind: "uuid" }
	| { readonly kind: "integer" }
	| { readonly kind: "text"; readonly max: number }
	| { readonly kind: "wildcard" }
	| { readonly kind: "vector"; readonly dimensions: number }

/** An aggregate of a global head: a count, or the least or greatest of an ordered column. */
type Aggregate =
	| { readonly kind: "count" }
	| { readonly kind: "min" | "max"; readonly column: number }

/**
 * A definition's shape over Org's columns, column 0 its key `id` and column i + 1 its i-th stored field: a plain head,
 * a group and its count, a global head of aggregates, a head (holding id) with an attachment, two arms of different
 * headings, or the whole of a relation of `width` integer columns, drawn around INDEX_MAX_KEYS.
 */
type Shape =
	| { readonly kind: "plain"; readonly head: ReadonlyArray<number> }
	| { readonly kind: "grouped"; readonly group: Arr.NonEmptyReadonlyArray<number> }
	| { readonly kind: "global"; readonly aggregates: Arr.NonEmptyReadonlyArray<Aggregate> }
	| { readonly kind: "attached"; readonly head: ReadonlyArray<number> }
	| {
			readonly kind: "groups"
			readonly head: Arr.NonEmptyReadonlyArray<number>
			readonly extra: number
	  }
	| { readonly kind: "wide"; readonly width: number }

interface StorableCase {
	readonly stored: Arr.NonEmptyReadonlyArray<StoredType>
	readonly shape: Shape
}

const storedTypeGen: Gen<StoredType> = oneOf<StoredType>([
	(): StoredType => ({ kind: "uuid" }),
	(): StoredType => ({ kind: "integer" }),
	map(int(1, 255), (max): StoredType => ({ kind: "text", max })),
	(): StoredType => ({ kind: "wildcard" }),
	map(int(600, 760), (dimensions): StoredType => ({ kind: "vector", dimensions }))
])

/** Whether min and max take a stored type: integers and text. */
const ordered = (t: StoredType): boolean =>
	t.kind === "integer" || t.kind === "text" || t.kind === "wildcard"

const storedAt = (c: StorableCase, column: number): StoredType =>
	defined(c.stored[column - 1], `stored field ${column - 1}`)

const aggregateGen =
	(columns: ReadonlyArray<number>): Gen<Aggregate> =>
	(source) => {
		if (columns.length === 0 || source.draw(int(0, 2)) === 0) {
			return { kind: "count" }
		}
		const column = Arr.getUnsafe(columns, source.draw(int(0, columns.length - 1)))
		return { kind: source.draw(int(0, 1)) === 0 ? "min" : "max", column }
	}

const shapeGen =
	(stored: Arr.NonEmptyReadonlyArray<StoredType>): Gen<Shape> =>
	(source) => {
		const columns = upTo(stored.length + 1, (i) => i)
		const nonEmptyHead = (s: typeof source) =>
			nonEmpty(s.draw(shuffled(columns, { min: 1, max: columns.length })), "a head")
		const aggregated = Arr.filter(
			upTo(stored.length, (i) => i + 1),
			(i) => ordered(defined(stored[i - 1]))
		)
		return source.draw(
			weighted<Shape>([
				[
					3,
					(s) => ({
						kind: "plain",
						head: s.draw(shuffled(columns, { min: 0, max: columns.length }))
					})
				],
				[2, (s) => ({ kind: "grouped", group: nonEmptyHead(s) })],
				[
					2,
					(s) => ({
						kind: "global",
						aggregates: nonEmpty(
							s.draw(array(aggregateGen(aggregated), { min: 1, max: 3 })),
							"the aggregates"
						)
					})
				],
				[
					1,
					(s) => ({
						kind: "attached",
						head: s.draw(
							shuffled(
								upTo(stored.length, (i) => i + 1),
								{ min: 0, max: stored.length }
							)
						)
					})
				],
				[
					1,
					(s) => {
						const head = nonEmpty(
							s.draw(shuffled(columns, { min: 1, max: columns.length - 1 })),
							"the first arm's head"
						)
						const rest = Arr.difference(columns, head)
						return {
							kind: "groups",
							head,
							extra: Arr.getUnsafe(rest, s.draw(int(0, rest.length - 1)))
						}
					}
				],
				[1, (s) => ({ kind: "wide", width: s.draw(int(30, 36)) })]
			])
		)
	}

export const storableCaseGen: Gen<StorableCase> = (source) => {
	const stored = nonEmpty(
		source.draw(array(storedTypeGen, { min: 1, max: 4 })),
		"the stored fields"
	)
	return { stored, shape: source.draw(shapeGen(stored)) }
}

/**
 * A global head whose first aggregate is the least or greatest of an unbounded text, which no unique index takes, beside
 * a count and an aggregate drawn as storableCaseGen draws it, or none: one fact keyed past its first column, its count,
 * which storableCaseGen seldom draws.
 */
export const pastFirstColumnCaseGen: Gen<StorableCase> = (source) => {
	const stored: Arr.NonEmptyReadonlyArray<StoredType> = [
		{ kind: "wildcard" },
		...source.draw(array(storedTypeGen, { min: 0, max: 3 }))
	]
	const aggregated = Arr.filter(
		upTo(stored.length, (i) => i + 1),
		(i) => ordered(defined(stored[i - 1]))
	)
	return {
		stored,
		shape: {
			kind: "global",
			aggregates: [
				{ kind: source.draw(boolean) ? "max" : "min", column: 1 },
				{ kind: "count" },
				...source.draw(array(aggregateGen(aggregated), { min: 0, max: 1 }))
			]
		}
	}
}

const storedField = (t: StoredType): FieldBase => {
	switch (t.kind) {
		case "uuid":
			return Id
		case "integer":
			return int4
		case "text":
			return regex(`^[a-z]{0,${t.max}}$`, "u")
		case "wildcard":
			return wildcard
		case "vector":
			return vector(t.dimensions)
	}
}

const columnName = (column: number): string => (column === 0 ? "id" : `f${column - 1}`)

const wideName = (column: number): string => `c${column}`

/** The base schema and the definition a case draws, built as a JavaScript caller builds them. */
export const storableOf = (c: StorableCase) => {
	const Org: JoinRelationValue = relation(
		"Org",
		{
			id: Id,
			...Rec.fromEntries(Arr.map(c.stored, (t, i) => [columnName(i + 1), storedField(t)] as const))
		},
		["id"]
	)
	const width = c.shape.kind === "wide" ? c.shape.width : 0
	const Wide: JoinRelationValue = relation(
		"Wide",
		{
			id: Id,
			...Rec.fromEntries(Arr.map(indices(width), (i) => [wideName(i), int4] as const))
		},
		["id"]
	)
	const base = schema("Base", [Org, Wide], [])
	const everyColumn = upTo(c.stored.length + 1, (i) => i)
	const terms = (vars: Readonly<Record<string, unknown>>, columns: ReadonlyArray<number>) =>
		Rec.fromEntries(Arr.map(columns, (i) => [columnName(i), vars[columnName(i)]] as const))
	const rule =
		(find: (r: RuleValue, vars: Readonly<Record<string, unknown>>) => unknown) =>
		(r: RuleValue) => {
			const vars = varsOver(Org, "org")
			return r.match(Org, terms(vars, everyColumn)).find(find(r, vars))
		}
	const shape = c.shape
	switch (shape.kind) {
		case "plain":
			return { base, definition: queryOver(base).rule(rule((_, vars) => terms(vars, shape.head))) }
		case "grouped":
			return {
				base,
				definition: queryOver(base).rule(
					rule((r, vars) => ({ ...terms(vars, shape.group), n: r.count() }))
				)
			}
		case "global":
			return {
				base,
				definition: queryOver(base).rule(
					rule((r, vars) =>
						Rec.fromEntries(
							Arr.map(shape.aggregates, (a, i) => {
								switch (a.kind) {
									case "count":
										return [`a${i}`, r.count()] as const
									case "min":
										return [`a${i}`, r.min(vars[columnName(a.column)])] as const
									case "max":
										return [`a${i}`, r.max(vars[columnName(a.column)])] as const
								}
							})
						)
					)
				)
			}
		case "attached":
			return {
				base,
				definition: queryOver(base)
					.rule(rule((_, vars) => terms(vars, [0, ...shape.head])))
					.attach(
						"same",
						(parent: Readonly<Record<string, unknown>>) =>
							queryOver(base).rule((r: RuleValue) => {
								const vars = varsOver(Org, "child")
								return r.match(Org, { id: parent["id"], f0: vars["f0"] }).find({ f0: vars["f0"] })
							}),
						"option"
					)
			}
		case "groups":
			return {
				base,
				definition: queryOver(base)
					.rule(rule((_, vars) => ({ ...terms(vars, shape.head), tag: "a" })))
					.rule(rule((_, vars) => ({ ...terms(vars, [...shape.head, shape.extra]), tag: "b" })))
			}
		case "wide":
			return {
				base,
				definition: queryOver(base).rule((r: RuleValue) => {
					const vars = varsOver(Wide, "wide")
					const all = Rec.fromEntries(
						Arr.map(indices(shape.width), (i) => [wideName(i), vars[wideName(i)]] as const)
					)
					return r.match(Wide, all).find(all)
				})
			}
	}
}

/** A column of D's heading as the model reads it: its name and the descriptor its field or aggregate gives it. */
interface ModelColumn {
	readonly name: string
	readonly desc: FieldDesc
}

/** A definition no view stores for a rule the types name too: a union of several heading groups, or no field. */
type NamedObstacle = "headingGroups" | "emptyHeading"

type Expected =
	| { readonly kind: "refused"; readonly cause: DerivedRefusal }
	| { readonly kind: "named"; readonly feature: NamedObstacle; readonly refusal: Refused }
	| {
			readonly kind: "admitted"
			readonly keys: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<string>>
			readonly wholeHeading: boolean
	  }

/** A heading's columns in its order: their names' code-unit order. */
const inHeadingOrder = (
	columns: Arr.NonEmptyReadonlyArray<ModelColumn>
): Arr.NonEmptyReadonlyArray<ModelColumn> =>
	Arr.sort(
		columns,
		Order.mapInput(Order.String, (col: ModelColumn) => col.name)
	)

const namesOf = (
	columns: Arr.NonEmptyReadonlyArray<ModelColumn>
): Arr.NonEmptyReadonlyArray<string> => Arr.map(columns, (col) => col.name)

/** The keys a definition proves, refused at the first whose unique index layout faults. */
const keyed = (
	heading: Arr.NonEmptyReadonlyArray<ModelColumn>,
	keys: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<ModelColumn>>
): Expected => {
	const whole = keys.length === 1 && Arr.headNonEmpty(keys).length === heading.length
	for (const key of keys) {
		const layout = derivedKeyLayout(key)
		if (!layout.ok) {
			return {
				kind: "refused",
				cause: {
					kind: whole ? "wholeHeading" : "inheritedKey",
					relation: "D",
					key: namesOf(key),
					fault: layout.error
				}
			}
		}
	}
	return { kind: "admitted", keys: Arr.map(keys, namesOf), wholeHeading: whole }
}

/** The model of what the analysis answers a case. */
export const storableModel = (c: StorableCase): Expected => {
	const column = (i: number): ModelColumn => ({
		name: columnName(i),
		desc: i === 0 ? descOf(Id) : descOf(storedField(storedAt(c, i)))
	})
	const count = descOf(natural)
	const shape = c.shape
	switch (shape.kind) {
		case "attached":
			return { kind: "refused", cause: { kind: "attachment", relation: "D" } }
		case "groups":
			return {
				kind: "named",
				feature: "headingGroups",
				refusal: "a derived definition has one heading: a stored table holds one heading group"
			}
		case "plain": {
			if (!Arr.isReadonlyArrayNonEmpty(shape.head)) {
				return {
					kind: "named",
					feature: "emptyHeading",
					refusal: "a derived definition has at least one field"
				}
			}
			const heading = inHeadingOrder(Arr.map(shape.head, column))
			return keyed(heading, Arr.contains(shape.head, 0) ? [[column(0)]] : [heading])
		}
		case "grouped": {
			const group = inHeadingOrder(Arr.map(shape.group, column))
			return keyed(
				inHeadingOrder(Arr.append(group, { name: "n", desc: count })),
				Arr.contains(shape.group, 0) ? [[column(0)]] : [group]
			)
		}
		case "global": {
			const heading = inHeadingOrder(
				Arr.map(shape.aggregates, (a, i): ModelColumn => ({
					name: `a${i}`,
					desc: a.kind === "count" ? count : column(a.column).desc
				}))
			)
			const first = Arr.findFirst(heading, (col) => derivedKeyLayout([col]).ok)
			if (Option.isSome(first)) {
				return { kind: "admitted", keys: [[first.value.name]], wholeHeading: false }
			}
			const fault = derivedKeyLayout([Arr.headNonEmpty(heading)])
			return fault.ok
				? assert.fail("the first column's layout faults")
				: {
						kind: "refused",
						cause: { kind: "oneFact", relation: "D", fields: namesOf(heading), fault: fault.error }
					}
		}
		case "wide": {
			const heading = inHeadingOrder(
				nonEmpty(
					Arr.map(indices(shape.width), (i): ModelColumn => ({
						name: wideName(i),
						desc: descOf(int4)
					})),
					"the wide heading"
				)
			)
			return keyed(heading, [heading])
		}
	}
}

export type StorableFeature =
	| DerivedRefusal["kind"]
	| NamedObstacle
	| "admitted"
	| `fault ${KeyFault["kind"]}`
	| "one fact keyed past its first column"

/** A relation keyed by its id, with another field beside it, which a view names under several names. */
export const Keyed = relation("Keyed", { id: Id, other: Id }, ["id"])

export const keyedBase = schema("Named", [Keyed], [])

/** A view of Keyed: how many names its head gives Keyed's id, and whether it delivers Keyed's other field too. */
export interface NamedKey {
	readonly names: number
	readonly other: boolean
}

export const keyName = (n: number): string => `n${n}`

/**
 * A source of rows a call returns, which a derived relation matches beside the row its arguments are read from: a
 * token split of the row's list (r.tokens), a separator split of it at a comma (r.split), a series from its low to its
 * high (r.series), a declared function's rows at its list (Fn.rows), each row of which has a place `at` beside its
 * piece where it has one, or the list's rest after a prefix (r.rest), or its split at its last comma (r.splitLast), one
 * row or none, which has no place; or the text after the last comma of the row's bounded text alone, which keys itself
 * within that text's byte bound.
 */
export const callSources = [
	"a token split",
	"a separator split",
	"a series",
	"a declared function's rows",
	"a rest",
	"a split at the last separator",
	"the text after a bounded text's last separator alone"
] as const
export type CallSource = (typeof callSources)[number]

/** How the definition reads a call's place: delivered in its head, fixed to a literal, or read and dropped. */
export const ordinalUses = [
	"the place in the head",
	"the place fixed to a literal",
	"the place dropped"
] as const
export type OrdinalUse = (typeof ordinalUses)[number]

export interface CallKeyCase {
	readonly call: CallSource
	readonly ordinal: OrdinalUse
}

/**
 * The uses of a call's place a case draws: every one, but a series' place fixed to a literal, since a rule binds no
 * bare literal to an exact integer (scalar/compute/literal.ts).
 */
const seriesUses = [
	"the place in the head",
	"the place dropped"
] as const satisfies ReadonlyArray<OrdinalUse>

/**
 * The use of a rest's place, or a split at the last separator's, a case draws: none, either having no place, so its
 * definition drops none.
 */
const restUses = ["the place dropped"] as const satisfies ReadonlyArray<OrdinalUse>

export const callKeyCase: Gen<CallKeyCase> = (source) => {
	const call = source.draw(element(callSources))
	return {
		call,
		ordinal: source.draw(
			element<OrdinalUse>(
				call === "a series"
					? seriesUses
					: call === "a rest" ||
						  call === "a split at the last separator" ||
						  call === "the text after a bounded text's last separator alone"
						? restUses
						: ordinalUses
			)
		)
	}
}

/** A piece a declared function returns: a text of a bound, so its whole heading is a key a B-tree entry holds. */
const Piece = str.bytes(64, str.regex("^.*$", "su"))

/**
 * A row of lists, keyed by its id: a list of any text, whose tokens are texts of no byte bound, as edullm's walks read a
 * pantry attribute's value (WalkCategory, WalkLiteralPair), the two ends of a series, and a path of any text within 64
 * bytes, whose texts split from it are within them too.
 */
const Listed = relation(
	"Listed",
	{ id: Id, list: str.regex("^.*$", "su"), lo: int4, hi: int4, path: Piece },
	["id"]
)

/** A declared function's rows of a list: each piece at its place, the rows PostgreSQL alone evaluates. */
const pieces = fn("pieces", {
	calls: [],
	args: { t: str.regex("^.*$", "su") },
	returns: rows({ at: int4, piece: Piece }),
	volatility: "immutable",
	nullInput: "strict",
	language: "sql",
	body: fn.body`SELECT o::integer, left(p, 64) FROM unnest(string_to_array(t, ' ')) WITH ORDINALITY AS u(p, o)`
})

const callBase = schema("CallKeys", [Listed, pieces], [])

/** Whether a case's definition reads its call's place at the literal 0, where it neither delivers nor drops it. */
const fixed = (c: CallKeyCase): boolean => c.ordinal === "the place fixed to a literal"

/** The stored relation of a token split's case: each row's tokens, at their places where its head delivers them. */
const tokensStored = (c: CallKeyCase) =>
	c.ordinal === "the place in the head"
		? derived(
				"D",
				query(callBase).rule((r) => {
					const { id, list } = v(Listed, "row")
					const split = r.tokens(list)
					const { at, token } = v(split, "token")
					return r
						.match(Listed, { id, list })
						.match(split, { at, token })
						.find({ id, at, piece: token })
				})
			)
		: derived(
				"D",
				query(callBase).rule((r) => {
					const { id, list } = v(Listed, "row")
					const split = r.tokens(list)
					const { at, token } = v(split, "token")
					return r
						.match(Listed, { id, list })
						.match(split, { at: fixed(c) ? 0n : at, token })
						.find({ id, piece: token })
				})
			)

/** The stored relation of a separator split's case: each row's pieces at a comma, at their places where delivered. */
const separatedStored = (c: CallKeyCase) =>
	c.ordinal === "the place in the head"
		? derived(
				"D",
				query(callBase).rule((r) => {
					const { id, list } = v(Listed, "row")
					const split = r.split(list, ",")
					const { at, piece } = v(split, "piece")
					return r.match(Listed, { id, list }).match(split, { at, piece }).find({ id, at, piece })
				})
			)
		: derived(
				"D",
				query(callBase).rule((r) => {
					const { id, list } = v(Listed, "row")
					const split = r.split(list, ",")
					const { at, piece } = v(split, "piece")
					return r
						.match(Listed, { id, list })
						.match(split, { at: fixed(c) ? 0n : at, piece })
						.find({ id, piece })
				})
			)

/** The stored relation of a rest's case: each row's list after the prefix `a`, where the list starts with it. */
const restStored = derived(
	"D",
	query(callBase).rule((r) => {
		const { id, list } = v(Listed, "row")
		const after = r.rest(list, "a")
		const { rest } = v(after, "rest")
		return r.match(Listed, { id, list }).match(after, { rest }).find({ id, piece: rest })
	})
)

/**
 * The stored relation of a split at the last separator's case: each row's list after its last comma, where the list
 * holds one.
 */
const splitLastStored = derived(
	"D",
	query(callBase).rule((r) => {
		const { id, list } = v(Listed, "row")
		const split = r.splitLast(list, ",")
		const { after } = v(split, "split")
		return r.match(Listed, { id, list }).match(split, { after }).find({ id, piece: after })
	})
)

/**
 * The stored relation of the bounded text's case: the text after each row's path's last comma, where the path holds
 * one, alone, so its whole heading, that text within the path's 64 bytes, is its only key.
 */
const boundedAfterStored = derived(
	"D",
	query(callBase).rule((r) => {
		const { id, path } = v(Listed, "row")
		const split = r.splitLast(path, ",")
		const { after } = v(split, "split")
		return r.match(Listed, { id, path }).match(split, { after }).find({ piece: after })
	})
)

/**
 * The stored relation of a series' case: each row's elements from its low to its high, each an exact integer between
 * the row's ends, delivered as the integer its ends are where its head delivers them.
 */
const seriesStored = (c: CallKeyCase) =>
	c.ordinal === "the place in the head"
		? derived(
				"D",
				query(callBase).rule((r) => {
					const { id, lo, hi } = v(Listed, "row")
					const series = r.series(lo, hi)
					const { at } = v(series, "element")
					return r
						.match(Listed, { id, lo, hi })
						.match(series, { at })
						.find({ id, at: Type.cast(at, int4) })
				})
			)
		: derived(
				"D",
				query(callBase).rule((r) => {
					const { id, lo, hi } = v(Listed, "row")
					const series = r.series(lo, hi)
					const { at } = v(series, "element")
					return r.match(Listed, { id, lo, hi }).match(series, { at }).find({ id })
				})
			)

/** The stored relation of a declared function's case: each row's pieces, at their places where its head delivers them. */
const piecesStored = (c: CallKeyCase) =>
	c.ordinal === "the place in the head"
		? derived(
				"D",
				query(callBase).rule((r) => {
					const { id, list } = v(Listed, "row")
					const run = Fn.rows(pieces, { t: list })
					const { at, piece } = v(run, "piece")
					return r.match(Listed, { id, list }).match(run, { at, piece }).find({ id, at, piece })
				})
			)
		: derived(
				"D",
				query(callBase).rule((r) => {
					const { id, list } = v(Listed, "row")
					const run = Fn.rows(pieces, { t: list })
					const { at, piece } = v(run, "piece")
					return r
						.match(Listed, { id, list })
						.match(run, { at: fixed(c) ? 0 : at, piece })
						.find({ id, piece })
				})
			)

/** A case's schema: the base, and above it the stored relation D over the case's call. */
export const callKeySchema = (c: CallKeyCase) => {
	switch (c.call) {
		case "a token split":
			return schema.extend([callBase], "CallKeysTop", [tokensStored(c)], [])
		case "a separator split":
			return schema.extend([callBase], "CallKeysTop", [separatedStored(c)], [])
		case "a rest":
			return schema.extend([callBase], "CallKeysTop", [restStored], [])
		case "a split at the last separator":
			return schema.extend([callBase], "CallKeysTop", [splitLastStored], [])
		case "the text after a bounded text's last separator alone":
			return schema.extend([callBase], "CallKeysTop", [boundedAfterStored], [])
		case "a series":
			return schema.extend([callBase], "CallKeysTop", [seriesStored(c)], [])
		case "a declared function's rows":
			return schema.extend([callBase], "CallKeysTop", [piecesStored(c)], [])
	}
}

/**
 * What a case's stored relation is keyed by, as the call's rows are (ir/rel.ts callNumbering): a split's and a series' rows
 * at their argument are keyed by their place, which numbers them, so a row of lists and a place key D, and the row
 * alone where a literal fixes the place; a rest and a split at the last separator are one row or none at their
 * arguments, so the row alone keys D, and the text after a bounded path's last comma delivered alone keys D by itself,
 * within the path's byte bound; a declared
 * function's rows are a set nothing numbers, keyed by their whole heading, so D by the row and every field of the call
 * it delivers. A token and a piece are texts of no byte bound, which no B-tree entry holds, so a key of either is
 * refused, its whole heading the definition's only key where the place is dropped.
 */
export const callKeyModel = (
	c: CallKeyCase
):
	| { readonly kind: "keyed"; readonly keys: ReadonlyArray<ReadonlyArray<string>> }
	| { readonly kind: "refused" } => {
	switch (c.call) {
		case "a token split":
		case "a separator split":
			return c.ordinal === "the place in the head"
				? { kind: "keyed", keys: [["at", "id"]] }
				: c.ordinal === "the place fixed to a literal"
					? { kind: "keyed", keys: [["id"]] }
					: { kind: "refused" }
		case "a series":
			return {
				kind: "keyed",
				keys: [c.ordinal === "the place in the head" ? ["at", "id"] : ["id"]]
			}
		case "a rest":
		case "a split at the last separator":
			return { kind: "keyed", keys: [["id"]] }
		case "the text after a bounded text's last separator alone":
			return { kind: "keyed", keys: [["piece"]] }
		case "a declared function's rows":
			return {
				kind: "keyed",
				keys: [c.ordinal === "the place in the head" ? ["at", "id", "piece"] : ["id", "piece"]]
			}
	}
}
