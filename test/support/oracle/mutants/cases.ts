import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled
} from "@grizzle/testing/gen"
import { Array as Arr, Order } from "effect"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { OpId, type TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta, type Heading, type RelNode } from "#compiler/ir/rel.ts"
import {
	defaultGenConfig,
	fullCaseSwarms,
	type GenConfig,
	paramNamesSketchGen,
	type QueryCase,
	resolveQueryCase,
	spellingSketchGen
} from "#test/support/oracle/gen/case.ts"
import { int4 } from "#test/support/oracle/gen/domain.ts"
import { type FactsSketch, type LiteralRow, rowSketchGen } from "#test/support/oracle/gen/facts.ts"
import {
	type BindSketch,
	normalQuery,
	type OccurrenceSketch,
	type QuerySketch,
	queryGenerators,
	type RootSketch,
	undrawn
} from "#test/support/oracle/gen/query.ts"

import {
	type GenRelation,
	type GenSchema,
	schemaName,
	schemaSketchGen,
	valueSketchGen
} from "#test/support/oracle/gen/schema.ts"
import { nonEmptyList } from "#test/support/oracle/pick.ts"

/** Facts for every relation slot: three to six sketched rows, so few relations are empty. */
const denseFactsGen = (config: GenConfig): Gen<FactsSketch> =>
	array(array(rowSketchGen, { min: 3, max: Math.max(3, config.facts.maxRows) }), {
		min: config.schema.maxRelations,
		max: config.schema.maxRelations
	})

/**
 * The cases the mutant suite (test/pg/oracle/mutants) runs each mutant on.
 *
 * A rewrite matters only where its node's multiplicity reaches the result: every other conservative node deduplicates
 * on its own, so a repeat a mutant lets through deep inside a query is absorbed by the next DISTINCT. Each mutant
 * therefore runs on generated cases whose root is the construct its rule is about (a projection, a join region, a
 * group, a union, an existence test over a bound, a recursive closure), with denser facts than the default population
 * so that fanout, collapsing projections and equal aggregates occur; the valid mutants also run on the generator's
 * whole population. Every root is a generator sketch resolved by the generator itself (gen/query.ts), so these cases
 * are ordinary generated cases.
 *
 * One check needs what the generator does not draw, so it is hand-built here and its facts generated: I3, a key column
 * projected through a noninjective expression (integer division, modulo, absolute value); the generator projects only
 * columns and literals.
 *
 * Generated cases with the given root, resolved by the generator.
 */
export const rootedCaseGen = (root: Gen<RootSketch>, config: GenConfig): Gen<QueryCase> => {
	const schema = schemaSketchGen(config.schema)
	const facts = denseFactsGen(config)
	return (source) =>
		source.draw(
			resolveQueryCase(
				{
					schema: source.draw(schema),
					facts: source.draw(facts),
					spelling: source.draw(spellingSketchGen),
					root: source.draw(root),
					paramNames: source.draw(paramNamesSketchGen),
					...fullCaseSwarms
				},
				config
			)
		)
}

const sub = queryGenerators(defaultGenConfig.query).query

const binds = (modes: Arr.NonEmptyReadonlyArray<number>): Gen<ReadonlyArray<BindSketch>> =>
	array(
		(source) => ({
			mode: source.draw(element(modes)),
			pick: source.draw(int(0, 7)),
			value: source.draw(valueSketchGen)
		}),
		{ min: 6, max: 6 }
	)

const relationOccurrence = (modes: Arr.NonEmptyReadonlyArray<number>): Gen<OccurrenceSketch> => {
	const columns = binds(modes)
	return (source) => ({
		source: { tag: "relation", pick: source.draw(int(0, 3)) },
		columns: source.draw(columns)
	})
}

const plain = (body: Gen<QuerySketch>): Gen<RootSketch> =>
	map(body, (b): RootSketch => ({ tag: "plain", body: b, order: undrawn }))

/**
 * Bind modes (gen/query.ts): 0-4 a fresh variable, 5-6 a join on a variable of the same type, 7 an existential
 * witness, 8 a literal constant, 9 a parameter constant.
 */
const freshOrJoin = [0, 0, 1, 5, 6] as const
const fanout = [0, 5, 6, 7, 7] as const
const witnessModes = [5, 6, 7, 8] as const

const outGen = array(
	(source) => ({
		literal: false,
		pick: source.draw(int(0, 7)),
		value: source.draw(valueSketchGen),
		term: undrawn
	}),
	{ min: 1, max: 2 }
)

const matchGen = (occurrences: Gen<ReadonlyArray<OccurrenceSketch>>): Gen<QuerySketch> =>
	map(occurrences, (o): QuerySketch => ({
		tag: "match",
		occurrences: o,
		equalities: [],
		lateral: undrawn
	}))

/** A projection over any generated query one operator deep, projecting one or two columns. */
const projectGen: Gen<QuerySketch> = (source) => ({
	tag: "project",
	input: source.draw(sub(1)),
	out: source.draw(outGen)
})

/** A projection at the root, over any generated query: projected-key loss (I1) and key retention (V1). */
export const projectRoot = plain(projectGen)

/** A join region at the root, two or three stored relations: retained join keys (V2) or fanout (I2). */
const joinRoot = (modes: Arr.NonEmptyReadonlyArray<number>) =>
	plain(matchGen(array(relationOccurrence(modes), { min: 2, max: 3 })))

export const keyedJoinRoot = joinRoot(freshOrJoin)
export const fanoutJoinRoot = joinRoot(fanout)

/** A join region whose last occurrence only joins, is existential or is fixed: a witness (V3). */
export const witnessRoot = plain(
	matchGen((source) => [
		...source.draw(array(relationOccurrence(freshOrJoin), { min: 1, max: 2 })),
		source.draw(relationOccurrence(witnessModes))
	])
)

const groupGen = (full: Gen<boolean>): Gen<QuerySketch> => {
	const aggs = array(
		(source) => ({ fn: source.draw(int(0, 15)), column: source.draw(int(0, 7)) }),
		{ min: 1, max: 2 }
	)
	return (source) => ({
		tag: "group",
		input: source.draw(sub(1)),
		full: source.draw(full),
		boundMask: source.draw(int(0, 63)),
		keyMask: source.draw(int(0, 63)),
		aggs: source.draw(aggs)
	})
}

/** A group at the root: complete identity retained (V4) or a bound tuple narrower than any key (I4). */
export const groupRoot = plain(groupGen(boolean))

/** A projection over a group at the root: group keys projected away (I5). */
export const projectGroupRoot = plain((source) => ({
	tag: "project",
	input: source.draw(groupGen(constant(false))),
	out: source.draw(outGen)
}))

const unionGen =
	(tagged: boolean): Gen<QuerySketch> =>
	(source) => ({
		tag: "union",
		arms: source.draw(array(sub(1), { min: 2, max: 3 })),
		width: source.draw(int(1, 2)),
		picks: source.draw(array(int(0, 7), { min: 1, max: 4 })),
		tagged
	})

/** A union at the root: disjoint by its arm tags (V5), or not (I6). */
export const taggedUnionRoot = plain(unionGen(true))
export const untaggedUnionRoot = plain(unionGen(false))

/** An existence test over a bounded projection at the root: the bound observes multiplicity beneath the EXISTS (I7). */
export const existsOverTakeRoot = plain((source) => ({
	tag: "semi",
	left: source.draw(sub(1)),
	right: {
		tag: "take",
		input: source.draw(projectGen),
		rotate: source.draw(int(0, 7)),
		dirs: source.draw(array(boolean, { min: 0, max: 4 })),
		stated: undrawn,
		k: source.draw(element([1, 2] as const)),
		param: source.draw(boolean),
		lateral: undrawn
	},
	on: source.draw(array(int(0, 15), { min: 1, max: 2 })),
	shared: undrawn
}))

/** A recursive closure at the root, over any generated edge query; acyclic edges for the UNION ALL mutant (I8). */
export const closureRoot = (acyclic: boolean) => {
	const edge = oneOf([
		sub(1),
		map(joinRoot(freshOrJoin), (r) => {
			if (r.tag !== "plain") {
				throw new Error("a join root is a plain root")
			}
			return r.body
		})
	])
	return plain((source) => ({
		tag: "closure",
		edge: source.draw(edge),
		pair: source.draw(int(0, 15)),
		acyclic,
		root: undrawn
	}))
}

const intLiteral = (value: bigint): TypedLiteral => ({ kind: "int", value })

const relation = (
	name: string,
	columns: ReadonlyArray<string>,
	primaryKey: ReadonlyArray<string>
): GenRelation => ({
	name,
	columns: Arr.map(columns, (c) => ({ name: c, type: int4 })),
	primaryKey,
	keys: [],
	mutable: false
})

const relationHeadingOf = (r: GenRelation): Heading =>
	Arr.map(r.columns, (c) => ({ name: c.name, type: c.type }))

/** The whole numbers of `lo..hi`, nearest zero first and the positive before the negative: the order a key shrinks in. */
const keysNearZero = (lo: number, hi: number): Arr.NonEmptyReadonlyArray<number> =>
	Arr.sort(
		Arr.range(lo, hi),
		Order.mapInput(Order.Number, (k: number) => 2 * Math.abs(k) - (k > 0 ? 1 : 0))
	)

/**
 * Facts with distinct `k` and small-domain other columns, so other columns repeat: one to six keys of `kRange`, each
 * drawn among those not yet drawn, so the keys are distinct by construction.
 */
const keyedRows = (
	width: number,
	kRange: readonly [number, number]
): Gen<ReadonlyArray<LiteralRow>> => {
	const keys = shuffled(keysNearZero(kRange[0], kRange[1]), { min: 1, max: 6 })
	const rest = array(int(0, 2), { min: width - 1, max: width - 1 })
	return (source) =>
		Arr.map(source.draw(keys), (k) => [
			intLiteral(BigInt(k)),
			...Arr.map(source.draw(rest), (v) => intLiteral(BigInt(v)))
		])
}

const spelling = { mode: "perCase" as const, choices: [], edge: false } as const

const buildDag = (b: DagBuilder, root: RelNode) => normalQuery(b.build(Arr.of(root)))

const baseNode = (b: DagBuilder, r: GenRelation, keys: ReadonlyArray<ReadonlyArray<string>>) =>
	b.node({
		loc: undefined,
		meta: conservativeMeta,
		kind: "Base",
		relation: r.name,
		occurrence: b.ids.occurrence(),
		primaryKey: nonEmptyList(r.primaryKey, "a primary key"),
		keys: Arr.map(keys, (k) => nonEmptyList(k, "a candidate key")),
		relationKind: "relation",
		heading: relationHeadingOf(r)
	})

const columnExpr = (b: DagBuilder, node: RelNode, name: string) =>
	b.expr({
		kind: "column",
		column: { node: node.id, name },
		args: [],
		type: int4,
		nonNull: "storage"
	})

const literalExpr = (b: DagBuilder, value: bigint) =>
	b.expr({
		kind: "literal",
		value: intLiteral(value),
		args: [],
		type: int4,
		nonNull: "literal"
	})

/** The noninjective integer functions I3 maps a key column through: k / 2, k % 3 and abs(k) over a small domain. */
const noninjective = ["int4div", "int4mod", "abs(integer)"] as const

/** I3: R0(k, b) keyed by k, projected to (f(k), b) for a noninjective f. */
export const noninjectiveKeyCaseGen: Gen<QueryCase> = map(
	(source) => ({
		rows: source.draw(keyedRows(2, [-4, 5])),
		fn: source.draw(element(noninjective)),
		keepB: source.draw(boolean)
	}),
	({ rows, fn, keepB }) => {
		const r = relation("R0", ["k", "b"], ["k"])
		const schema: GenSchema = { name: schemaName, relations: [r], closed: [], containments: [] }
		const b = new DagBuilder(makeIdSupply())
		const base = baseNode(b, r, [])
		const k = columnExpr(b, base, "k")
		const args = fn === "abs(integer)" ? [k] : [k, literalExpr(b, fn === "int4div" ? 2n : 3n)]
		const f = b.expr({
			kind: "op",
			op: OpId(fn),
			args,
			type: int4,
			nonNull: "strict",
			volatility: "immutable",
			failure: "total"
		})
		const out = keepB
			? [
					{ name: "h", expr: f },
					{ name: "b", expr: columnExpr(b, base, "b") }
				]
			: [{ name: "h", expr: f }]
		const heading: Heading = Arr.map(out, (o) => ({ name: o.name, type: int4 }))
		const dag = buildDag(
			b,
			b.node({
				loc: undefined,
				meta: conservativeMeta,
				kind: "ProjectSet",
				input: base,
				out,
				heading
			})
		)
		return {
			schema,
			facts: { R0: rows },
			query: { dag, params: {} },
			spelling
		} satisfies QueryCase
	}
)
