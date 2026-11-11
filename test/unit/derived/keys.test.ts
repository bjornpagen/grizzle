/**
 * Key inheritance for derived relations: a derived relation needs no declared key and admits none. Its keys are the
 * keys its definition proves, each in heading order, narrowest first and then by heading position, none implied by a
 * narrower one; the whole heading when nothing narrower is proven; and for a definition of at most one fact its first
 * representable column. Each becomes a unique index, so each must fit PostgreSQL's B-tree entry and column limits, and
 * a definition a materialized view cannot store is refused.
 *
 * - Key rules: over the derived oracle's generated schemas (drawn levels, aggregates, take forms), every relation's
 *   keys keep those rules, a level is one above the derived relations it reads, and queries over a relation see its
 *   keys. Oracle: the rules as a checker (keyRules). Plant: derived-one-fact-last-column (a definition of one fact is
 *   keyed by its last representable column). Features: the whole heading, at most one fact, a level over a derived
 *   relation.
 * - Join keys: over generated joins of relations keyed by primary and candidate keys, each matched once, their heads
 *   in a drawn order, every key the view indexes is a minimal set of head columns whose closure, under each relation's
 *   keys bound whole, holds the head, and the keys the view states, each key's factors chosen among its alternatives,
 *   are exactly those minimal sets. Oracle: the closure of the head's variables, a second implementation. Plant:
 *   derived-keys-no-alternatives (no factor's alternatives are listed). Features: JoinFeature, and two pairs of them.
 * - Product keys: over products of relations keyed by either of two fields, through projections, joins, several rules
 *   and a level above, the view indexes one unique index per alternative of a factor and states exactly its minimal
 *   keys. Oracle: the minimal sets by closure and their finest product partition, found by brute force. Plant:
 *   derived-keys-first-factor-alternatives (only the first factor's alternatives are listed). Features:
 *   ProductFeature, and two pairs of them.
 * - Storable: over generated definitions of one relation of drawn field types (uuid, integer, bounded and wildcard
 *   text, vectors of drawn dimensions): a plain head in a drawn order, possibly empty; a grouped count; a global
 *   aggregate; a head with an attachment; a union of two heading groups; and a head of a drawn number of integer
 *   columns around INDEX_MAX_KEYS. The model: the spine's obstacle, then the empty heading, then the key the
 *   definition proves (the primary key when the head or the group holds it, the group, the head, or the first
 *   representable column of one fact) refused at the first whose unique index layout faults, as wholeHeading,
 *   inheritedKey or oneFact with that fault, and admitted with exactly those keys otherwise. Oracle: that model, a
 *   specification. Plant: derived-key-fault-kind-swapped (a faulting key refused under the other kind). Features:
 *   each refusal kind and fault, admitted, and one fact keyed past its first column. The faults themselves (unbounded
 *   text, B-tree entry bytes, column count) are the representability suite's, against PostgreSQL's own sizes.
 * - Named key: every view of a relation keyed by its id that names the id one to three times, beside its other field
 *   or not, and a level reading the view whole, state each name as a key alone. Oracle: every name of the key is one
 *   column of every row, each a key alone. Plant: derived-keys-no-alternatives. Features: one, two and three names.
 *
 * That the keys are sound, a refreshed view never holding two facts under one, is the refresh oracle's, whose views
 * are refreshed concurrently over their unique indexes.
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, exhaust, explore, sketched } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import { derivedKeyLayout } from "#compiler/analysis/derived/keys.ts"
import { derivedAnalysis } from "#compiler/analysis/schema.ts"
import { indices, maxOf } from "#compiler/core/array.ts"
import type { DerivedRefusal, KeyFault } from "#compiler/core/causes.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import * as Result from "#compiler/core/result.ts"
import type { InferredFieldDesc } from "#compiler/ir/desc.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { key, on, type Relation, relation, schema } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { materializedDerived as runtimeDerived } from "#compiler/schema/relation.ts"
import { schema as runtimeSchema } from "#compiler/schema/schema.ts"
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
import { upTo } from "#test/support/up-to.ts"
import { descOf, regex, wildcard } from "#test/unit/schema/support.ts"

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

const joinSketchGen: Gen<JoinSketch> = (source) => ({
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
const twoFactorSketchGen: Gen<JoinSketch> = (source) => {
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
const headName = (variable: number): string => `v${variable}`

type JoinRelationValue = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

/** The base schema of a join's relations: R0, R1, ... of uuid fields, each keyed by its keys. */
const joinBase = (relations: Arr.NonEmptyReadonlyArray<JoinRelation>) => {
	const keyed = Arr.map(relations, (r, i) => {
		const value: JoinRelationValue = relation(
			`R${i}`,
			Rec.fromEntries(Arr.map(indices(r.width), (f) => [fieldName(f), uuid] as const)),
			nonEmpty(Arr.map(bitsOf(r.keys[0], r.width), fieldName), "a primary key")
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
			Rec.fromEntries(Arr.map(values, (value, i) => [`R${i}`, value] as const)),
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
const joinOf = (sketch: JoinSketch): Join => {
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
const minimalKeys = (
	j: Join,
	keysOf: (r: JoinRelation) => ReadonlyArray<number>
): ReadonlyArray<ReadonlyArray<number>> => minimalHeadSets(j, determinesHead(j, keysOf))

/**
 * Every key a view states (ir/keys.ts ViewKey): of each of its keys, one minimal key of each factor, its alternatives
 * grouped by the fields they stand for, the key's own fields among them, and each column of it or a member of its
 * class in its place, each in heading order.
 */
const viewStated = (
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

type JoinFeature =
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
const joinFeatures = (
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

/**
 * The join a witness checks: its drawn one, or, while a key of two factors each with an alternative is pending, a
 * planted one (twoFactorSketchGen), whose factors' alternatives the analysis lists after the proof, out of heading order
 * until inheritedKeys sorts them.
 */
const aimedJoin = (drawnJoin: Join, c: Case<JoinFeature>): Join =>
	Option.exists(c.steering, (pending) =>
		pending.has("a key of two factors, each with an alternative")
	)
		? joinOf(c.draw(twoFactorSketchGen))
		: drawnJoin

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

const productSketchGen: Gen<ProductSketch> = productGen(
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

const productOf = (sketch: ProductSketch): Product => {
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
const productMinimal = (p: Product): ReadonlyArray<ReadonlyArray<string>> => {
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
const productLaws = (
	r: Parameters<typeof keyRules>[0] & {
		readonly read: { readonly keys: Parameters<typeof viewStated>[0] }
	},
	minimal: ReadonlyArray<ReadonlyArray<string>>
): void => {
	keyRules(r)
	assert.ok(
		Arr.every(r.keys, (k) =>
			Arr.some(minimal, (m) => deepEquals<ReadonlyArray<string>>(m, k.fields))
		),
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

type ProductFeature =
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
const productFeatures = (
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
const aboveOf = (
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
 * The product a witness checks: its drawn one, or, while a requirement naming several rules is pending, a planted one of
 * two rules of four factors of two keys keyed alike, and while one naming four factors is, a planted one of one rule.
 */
const aimedProduct = (drawnProduct: Product, c: Case<ProductFeature>): Product =>
	Option.match(c.steering, {
		onNone: () => drawnProduct,
		onSome: (pending) =>
			pending.names("a key no rule's keys hold alone")
				? productOf(c.draw(crosswiseSketchGen))
				: pending.names("several rules of four factors of two minimal keys each") ||
					  pending.names("several rules")
					? productOf(c.draw(fourFactorSketchGen(constant(1))))
					: pending.names("four factors of two minimal keys each")
						? productOf(c.draw(fourFactorSketchGen(constant(0))))
						: drawnProduct
	})

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

const storableCaseGen: Gen<StorableCase> = (source) => {
	const stored = nonEmpty(
		source.draw(array(storedTypeGen, { min: 1, max: 4 })),
		"the stored fields"
	)
	return { stored, shape: source.draw(shapeGen(stored)) }
}

const storedField = (t: StoredType): FieldBase => {
	switch (t.kind) {
		case "uuid":
			return uuid
		case "integer":
			return pg.integer
		case "text":
			return regex(`^[a-z]{0,${t.max}}$`, "u")
		case "wildcard":
			return wildcard
		case "vector":
			return pg.vector(t.dimensions)
	}
}

const columnName = (column: number): string => (column === 0 ? "id" : `f${column - 1}`)
const wideName = (column: number): string => `c${column}`

/** The base schema and the definition a case draws, built as a JavaScript caller builds them. */
const storableOf = (c: StorableCase) => {
	const Org: JoinRelationValue = relation(
		"Org",
		{
			id: uuid,
			...Rec.fromEntries(Arr.map(c.stored, (t, i) => [columnName(i + 1), storedField(t)] as const))
		},
		["id"]
	)
	const width = c.shape.kind === "wide" ? c.shape.width : 0
	const Wide: JoinRelationValue = relation(
		"Wide",
		{
			id: uuid,
			...Rec.fromEntries(Arr.map(indices(width), (i) => [wideName(i), pg.integer] as const))
		},
		["id"]
	)
	const base = schema("Base", { Org, Wide }, [])
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
	readonly desc: InferredFieldDesc
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
const storableModel = (c: StorableCase): Expected => {
	const column = (i: number): ModelColumn => ({
		name: columnName(i),
		desc: i === 0 ? descOf(uuid) : descOf(storedField(storedAt(c, i)))
	})
	const count = descOf(pg.bigint)
	const shape = c.shape
	switch (shape.kind) {
		case "attached":
			return { kind: "refused", cause: { kind: "attachment", relation: "D" } }
		case "groups":
			return {
				kind: "named",
				feature: "headingGroups",
				refusal:
					"a derived definition has one heading: a materialized view stores one heading group"
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
						desc: descOf(pg.integer)
					})),
					"the wide heading"
				)
			)
			return keyed(heading, [heading])
		}
	}
}

type StorableFeature =
	| DerivedRefusal["kind"]
	| NamedObstacle
	| "admitted"
	| `fault ${KeyFault["kind"]}`
	| "one fact keyed past its first column"

/** A relation keyed by its id, with another field beside it, which a view names under several names. */
const Keyed = relation("Keyed", { id: uuid, other: uuid }, ["id"])
const keyedBase = schema("Named", { Keyed }, [])

/** A view of Keyed: how many names its head gives Keyed's id, and whether it delivers Keyed's other field too. */
interface NamedKey {
	readonly names: number
	readonly other: boolean
}

const keyName = (n: number): string => `n${n}`

describe("derived relation keys", () => {
	it.effect(
		"are proven keys in heading order, narrowest first, none implied by another, the whole heading only alone",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "proven keys in heading order, narrowest first, none implied by another, the whole heading only alone, one fact by its first representable column, a level one above what it reads"
						},
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

	it.effect(
		"state exactly the minimal sets of head columns a join's keys determine the head by, through every relation it matches",
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
								"a key of two factors, each with an alternative",
								"a candidate key determines",
								"a join of several relations",
								"a head out of its variables' order",
								["a join of several relations", "a key narrower than the heading"],
								["a head out of its variables' order", "several keys"]
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
					(drawnJoin, c) =>
						Effect.sync(() => {
							const j = aimedJoin(drawnJoin, c)
							const expected = minimalKeys(j, (r) => r.keys)
							const d = defined(
								succeeded(
									Result.map(
										checkedIn(
											runtimeSchema.extend(
												j.base.schema,
												"Level5",
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
							const minimal = Arr.map(expected, (k) => Arr.map(k, headName))
							assert.ok(
								Arr.every(d.keys, (k) =>
									Arr.some(minimal, (m) => deepEquals<ReadonlyArray<string>>(m, k.fields))
								),
								"every key the view indexes is a minimal key of the join"
							)
							unorderedEqual(
								viewStated(d.read.keys),
								Arr.map(minimal, (k) => Arr.sort(k, Order.String))
							)
							const reached = joinFeatures(j, expected)
							c.noteAll(reached)
							if (
								Arr.contains(reached, "a join of several relations") &&
								Arr.contains(reached, "a key narrower than the heading")
							) {
								c.pair("a join of several relations", "a key narrower than the heading")
							}
							if (
								Arr.contains(reached, "a head out of its variables' order") &&
								Arr.contains(reached, "several keys")
							) {
								c.pair("a head out of its variables' order", "several keys")
							}
						})
				)
			)
	)

	it.effect(
		"index a product of relations keyed by either of two fields once per alternative of a factor, through projections, joins, several rules and a level above, stating exactly its minimal keys",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/derived/product-keys",
						draw: sketched(productSketchGen, productOf),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the head's minimal sets whose closure under each matched relation's keys holds it in every rule, beside the rules' tag when there are several, a level above's those with each key of the relation beside the view, and the finest partition of their columns they are the product of, found over every part"
						},
						coverage: required<ProductFeature>(
							[
								"four factors of two minimal keys each",
								"a factor's minimal key of several columns",
								"a projection dropping a column",
								"relations joined on a variable",
								"a level reading the view whole",
								"a level reading the view beside one of its relations",
								"several rules",
								"several rules of four factors of two minimal keys each",
								"rules keying a relation apart",
								"a key no rule's keys hold alone",
								["four factors of two minimal keys each", "a level reading the view whole"],
								["several rules", "a level reading the view whole"]
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
					(drawnProduct, c) =>
						Effect.sync(() => {
							const p = aimedProduct(drawnProduct, c)
							const minimal = productMinimal(p)
							const view = runtimeDerived("D", p.definition, [])
							const level = runtimeSchema.extend(p.base.schema, "Level1", { D: view }, [], [])
							const above = aboveOf(p, minimal, view, level)
							const analysis = succeeded(
								Result.map(
									checkedIn(
										above === undefined
											? level
											: runtimeSchema.extend(
													level,
													"Level6",
													{ E: runtimeDerived("E", above.definition, []) },
													[],
													[]
												)
									),
									derivedAnalysis
								)
							)
							productLaws(defined(analysis.relations["D"]), minimal)
							if (above !== undefined) {
								productLaws(defined(analysis.relations["E"]), above.minimal)
							}
							const reached = productFeatures(p, minimal)
							c.noteAll(reached)
							for (const first of [
								"four factors of two minimal keys each",
								"several rules"
							] as const) {
								if (
									Arr.contains(reached, first) &&
									Arr.contains(reached, "a level reading the view whole")
								) {
									c.pair(first, "a level reading the view whole")
								}
							}
						})
				)
			)
	)

	it.effect(
		"refuse a definition no view can store or index with its typed cause, and key every other as it proves",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/derived/unstorable",
						draw: drawn(storableCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the spine's obstacle, the empty heading, then the proven key refused at its first faulting layout"
						},
						coverage: required<StorableFeature>(
							[
								"attachment",
								"headingGroups",
								"emptyHeading",
								"wholeHeading",
								"inheritedKey",
								"oneFact",
								"admitted",
								"fault unboundedText",
								"fault btreeEntry",
								"fault columns",
								"one fact keyed past its first column"
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
					(c, k) =>
						Effect.sync(() => {
							const { base, definition } = storableOf(c)
							const analyzed = Result.map(
								checkedIn(
									runtimeSchema.extend(
										base,
										"Level2",
										{ D: runtimeDerived("D", definition, []) },
										[],
										[]
									)
								),
								derivedAnalysis
							)
							const expected = storableModel(c)
							if (expected.kind === "named") {
								k.note(expected.feature)
								assert.ok(!analyzed.ok, "a definition no view stores is refused")
								const reason = analyzed.error.reason
								assert.ok(reason._tag === "Refused", analyzed.error.message)
								assert.equal(reason.refusal, expected.refusal)
								return
							}
							if (expected.kind === "refused") {
								k.note(expected.cause.kind)
								if (
									expected.cause.kind === "wholeHeading" ||
									expected.cause.kind === "inheritedKey" ||
									expected.cause.kind === "oneFact"
								) {
									k.note(`fault ${expected.cause.fault.kind}`)
								}
								assert.ok(!analyzed.ok, "a definition no view stores is refused")
								const reason = analyzed.error.reason
								assert.ok(reason._tag === "DerivedRefused", analyzed.error.message)
								assert.deepEqual(reason.cause, expected.cause)
								return
							}
							k.note("admitted")
							const d = defined(succeeded(analyzed).relations["D"])
							keyRules(d)
							assert.deepEqual<ReadonlyArray<ReadonlyArray<string>>>(
								Arr.map(d.keys, (key) => key.fields),
								expected.keys
							)
							assert.equal(d.wholeHeading, expected.wholeHeading)
							if (
								c.shape.kind === "global" &&
								Arr.headNonEmpty(Arr.headNonEmpty(expected.keys)) !== "a0"
							) {
								k.note("one fact keyed past its first column")
							}
						})
				)
			)
	)

	it.effect(
		"state each name a view's head gives its key's variable as a key, and so does a level reading the view whole",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/derived/named-key",
						generator: (source): NamedKey => ({
							names: source.draw(int(1, 3)),
							other: source.draw(boolean)
						}),
						literal: Formatter.format,
						limit: 6,
						box: "a view of Keyed naming its key one to three times, beside its other field or not, and a level above reading the view whole",
						oracle: {
							kind: "specification",
							name: "every name of Keyed's key is one column of every row, each a key alone, and the other field none"
						},
						coverage: requiredInSpace<"one name" | "two names" | "three names">([
							"one name",
							"two names",
							"three names"
						]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const names = Arr.map(indices(c.names), keyName)
							const heading = [...names, ...(c.other ? ["other"] : [])]
							const view = runtimeDerived(
								"D",
								queryOver(keyedBase).rule((r: RuleValue) => {
									const keyed = varsOver(Keyed, "keyed")
									return r.match(Keyed, { id: keyed["id"], other: keyed["other"] }).find({
										...Rec.fromEntries(Arr.map(names, (n) => [n, keyed["id"]] as const)),
										...(c.other ? { other: keyed["other"] } : {})
									})
								}),
								[]
							)
							const level = runtimeSchema.extend(keyedBase, "Level3", { D: view }, [], [])
							const above = runtimeDerived(
								"E",
								queryOver(level).rule((r: RuleValue) => {
									const d = varsOver(view, "d")
									const terms = Rec.fromEntries(Arr.map(heading, (n) => [n, d[n]] as const))
									return r.match(view, terms).find(terms)
								}),
								[]
							)
							const analysis = succeeded(
								Result.map(
									checkedIn(runtimeSchema.extend(level, "Level4", { E: above }, [], [])),
									derivedAnalysis
								)
							)
							for (const name of ["D", "E"]) {
								const r = defined(analysis.relations[name], name)
								keyRules(r)
								unorderedEqual(
									viewStated(r.read.keys),
									Arr.map(names, (n) => [n])
								)
							}
							k.note(c.names === 1 ? "one name" : c.names === 2 ? "two names" : "three names")
						})
				)
			)
	)
})
