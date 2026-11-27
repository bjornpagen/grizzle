/** What the property of props-oracle.test.ts reads: what a node's properties decide, read off either implementation, and where two decisions first differ. */

import type { Reached } from "@bjornpagen/testing/features"
import {
	type Case,
	type Kept,
	type Kill,
	type Property,
	property
} from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Predicate as Pred, String as Str } from "effect"
import { edgeValues, nodeScopes, topoOrder } from "#compiler/ir/dag.ts"
import { Fold } from "#compiler/ir/fold.ts"
import type { RelDag, RelNode } from "#compiler/ir/rel.ts"
import { logicalPropsOf, type Props, type PropsEnv, propsScratch } from "#compiler/logical/props.ts"
import {
	type GenConfig,
	queryCaseSketchGen,
	resolveQueryCase
} from "#test/support/oracle/gen/case.ts"
import { referencePropsOf } from "#test/support/reference-props/props.ts"

/** What a case of the property reaches: the decisions of the kinds the factor search, the classes and the fixed columns make. */
export type OracleFeature =
	| "a key of several factors"
	| "a factor with another minimal key"
	| "a class of several columns"
	| "a fixed column named"
	| "a node of several heading groups"
	| "a node reading columns from outside it"

/** What the property states beside its draw: the situations its cases must reach, its kept cases and its kills. */
export interface OracleStated {
	readonly situations: ReadonlyArray<Reached<OracleFeature>>
	readonly kept: ReadonlyArray<Kept>
	readonly kills: ReadonlyArray<Kill>
}

/**
 * What a node's properties decide, as their readers read them: all but their representation (their dependencies'
 * table, its naming, the closure of nothing, the view a parent reads), which the readers outside the analysis read only
 * through these. Either implementation's properties are one.
 */
type Decided = Pick<
	Props,
	| "columns"
	| "outer"
	| "keys"
	| "classes"
	| "forest"
	| "distinct"
	| "factFields"
	| "card"
	| "provenance"
	| "context"
	| "discriminant"
	| "groups"
	| "fixed"
	| "prove"
	| "whole"
>

/**
 * The column sets a node's proof of a key is asked of: each column alone, the heading, each key and each key without
 * one of its columns, the sets a key's reader asks of (logical/props.ts identifiesFacts, analysis/derived keyIn).
 */
const asked = (props: Decided): ReadonlyArray<ReadonlyArray<string>> => [
	props.columns,
	...Arr.map(props.columns, (c) => [c]),
	...Arr.flatMap(props.keys, (k) => [
		k.key,
		...Arr.map(k.key, (c) => Arr.filter(k.key, (other) => other !== c))
	])
]

/** A node's decisions, the proofs it gives of the asked sets among them. */
const decisionsOf = (props: Decided): unknown => ({
	columns: props.columns,
	outer: props.outer,
	keys: props.keys,
	classes: props.classes,
	forest: props.forest,
	distinct: props.distinct,
	factFields: props.factFields,
	card: props.card,
	provenance: props.provenance,
	context: props.context,
	discriminant: props.discriminant,
	groups: props.groups,
	fixed: props.fixed,
	whole: props.whole(),
	proofs: Arr.map(asked(props), (columns) => props.prove(columns))
})

/** The first difference `f` finds among `items`, by their order, or undefined where it finds none. */
const firstAmong = <A>(
	items: ReadonlyArray<A>,
	f: (item: A, i: number) => string | undefined
): string | undefined => {
	for (const [i, item] of items.entries()) {
		const found = f(item, i)
		if (found !== undefined) {
			return found
		}
	}
	return undefined
}

/** An object's own fields by name, in code unit order. */
const fieldsOf = (o: object): ReadonlyArray<string> =>
	Arr.sort(Arr.filter(Reflect.ownKeys(o), Pred.isString), Str.Order)

/**
 * Where two values first differ, read structurally, or undefined where they agree: a map's entries and an array's
 * items in their order, an object's fields by name, each pair of objects compared once (a derivation shares its
 * inputs' steps, so a walk of its paths would grow as the paths do).
 */
const differenceOf = (a: unknown, b: unknown): string | undefined => {
	const agreed = new WeakMap<object, WeakSet<object>>()
	const at = (x: unknown, y: unknown, path: string): string | undefined => {
		if (Object.is(x, y)) {
			return undefined
		}
		if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) {
			return path
		}
		const known = agreed.get(x)
		if (known?.has(y) === true) {
			return undefined
		}
		if (known === undefined) {
			agreed.set(x, new WeakSet([y]))
		} else {
			known.add(y)
		}
		if (Object.getPrototypeOf(x) !== Object.getPrototypeOf(y)) {
			return `${path} (of two kinds)`
		}
		if (x instanceof Map && y instanceof Map) {
			const ys = [...y.entries()]
			return x.size !== y.size
				? `${path}.size`
				: firstAmong(
						[...x.entries()],
						([k, v], i) =>
							at(k, ys[i]?.[0], `${path}.key[${i}]`) ??
							at(v, ys[i]?.[1], `${path}.get(${String(k)})`)
					)
		}
		if (x instanceof Set && y instanceof Set) {
			return at([...x], [...y], `${path}.members`)
		}
		if (Arr.isArray(x) && Arr.isArray(y)) {
			return x.length !== y.length
				? `${path}.length`
				: firstAmong(x, (item, i) => at(item, y[i], `${path}[${i}]`))
		}
		const fields = fieldsOf(x)
		return (
			at(fields, fieldsOf(y), `${path} fields`) ??
			firstAmong(fields, (field) =>
				at(Reflect.get(x, field), Reflect.get(y, field), `${path}.${field}`)
			)
		)
	}
	return at(a, b, "props")
}

/** What a case reached at a node, by its decisions. */
const reachedAt = (props: Decided): ReadonlyArray<OracleFeature> => [
	...(Arr.some(props.keys, (k) => k.factors.length > 1)
		? ["a key of several factors" as const]
		: []),
	...(Arr.some(props.keys, (k) => Arr.some(k.factors, (f) => f.alternatives.length > 0))
		? ["a factor with another minimal key" as const]
		: []),
	...(Arr.some([...props.classes.values()], (members) => members.length > 1)
		? ["a class of several columns" as const]
		: []),
	...(Arr.some([...props.fixed.values()], (names) => names.length > 0)
		? ["a fixed column named" as const]
		: []),
	...(props.discriminant.length > 0 ? ["a node of several heading groups" as const] : []),
	...(props.outer.size > 0 ? ["a node reading columns from outside it" as const] : [])
]

/**
 * Each node of `dag`, inputs first, with its properties by the analysis and by the reference, each implementation
 * reading its own properties of the node's inputs under one environment: a difference shows first at the node that
 * makes it.
 */
const agreeOn = (dag: RelDag, keyedViews: boolean, c: Case<OracleFeature>): void => {
	const scopes = nodeScopes()
	const env: PropsEnv = { scope: (node) => scopes.of(node), keyedViews, scratch: propsScratch() }
	const ours = new Fold<RelNode, Props>(function* (node) {
		return logicalPropsOf(node, yield* edgeValues<Props>(node), env)
	})
	const theirs = new Fold<RelNode, ReturnType<typeof referencePropsOf>>(function* (node) {
		return referencePropsOf(node, yield* edgeValues<ReturnType<typeof referencePropsOf>>(node), env)
	})
	for (const node of topoOrder(dag)) {
		const props = ours.of(node)
		const difference = differenceOf(decisionsOf(props), decisionsOf(theirs.of(node)))
		if (difference !== undefined) {
			throw new Error(
				`${node.kind} ${node.id} (keyed views ${String(keyedViews)}) decides apart from the reference at ${difference}`
			)
		}
		for (const feature of reachedAt(props)) {
			c.note(feature)
		}
	}
}

/**
 * Every case of `config`, each node's properties by the analysis deciding as the reference's (test/support/reference-props)
 * do, under both readings of a view's keys.
 */
export const decidesAsTheReferenceOn = (config: GenConfig, stated: OracleStated): Property =>
	property.explore(queryCaseSketchGen(config), {
		needs: {},
		budget: { runs: 1500, steered: 1500 },
		situations: stated.situations,
		check: (_, c: Case<OracleFeature>) => (sketch) =>
			Effect.sync(() => {
				const generated = c.draw(resolveQueryCase(sketch, config))
				agreeOn(generated.query.dag, false, c)
				agreeOn(generated.query.dag, true, c)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the reference props (test/support/reference-props), each node's from its own inputs' properties"
		},
		kept: stated.kept,
		kills: stated.kills
	})
