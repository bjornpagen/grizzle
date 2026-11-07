/**
 * Key inferences the logical analysis makes over four shapes, each searched against an oracle written apart from it: a
 * closure brute-forced over the shape's own dependencies, which each inference must reach exactly, and the reference
 * evaluator over generated facts, on which every key and dependency the analysis claims must hold (support.ts
 * logicalUnsound, which also holds every proof to the key kernel).
 *
 * - Closed columns of identical values: two columns of one type a closed relation holds one value in, fact by fact,
 *   are one class, and a column whose values are distinct is a key.
 * - A lateral source's fixed column: a region's variable bound to a column its lateral source fixes to a region
 *   column's value equals that column's variable, each determining the other, so the region's keys are exactly the
 *   minimal sets its matches and that equality determine its heading by.
 * - Projections of a join: a node keeps every attribute of its input it does not deliver as a hidden one, so whether
 *   some columns of two stacked projections determine others is exactly their closure in the join, a dependency whose
 *   determinants hold a dropped column included.
 * - Keys of joined relations of two declared keys each: one proof over independent factors, the keys its factors'
 *   choices state exactly the join's minimal keys (the work it takes is join-cost.test.ts's).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, constant, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Record as Rec, String as Str } from "effect"
import { indices } from "#compiler/core/array.ts"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { type KeyProof, keyFactors, keyIn } from "#compiler/ir/keys.ts"
import {
	conservativeMeta,
	type Heading,
	type RelNode,
	type ValidDag,
	type VarDecl
} from "#compiler/ir/rel.ts"
import {
	analyzeLogical,
	checkerEvidence,
	type LogicalAnalysis
} from "#compiler/logical/annotate.ts"
import { closure } from "#compiler/logical/closure.ts"
import type { Props } from "#compiler/logical/props.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"
import { assert, deepEquals, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { canonicalFacts, type GenFacts, type LiteralRow } from "#test/support/oracle/gen/facts.ts"
import type { GenRelation, GenSchema } from "#test/support/oracle/gen/schema.ts"
import { unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { logicalUnsound } from "#test/unit/analysis/logical/support.ts"

const int4 = plainType("int4")
const int8 = plainType("int8")

const intLiteral = (value: number): TypedLiteral => ({ kind: "int", value: BigInt(value) })

/** Whether position `at` is in `mask`. */
const holds = (mask: number, at: number): boolean => (mask & (1 << at)) !== 0

/** A key as the sorted names of its columns, the one spelling two keys are compared by. */
const spelled = (key: Iterable<string>): string => Arr.join(Arr.sort([...key], Order.String), ",")

/**
 * Every key a proof states: one minimal key of each factor (ir/keys.ts keyFactors), then one column of each class of
 * its columns, each spelled. A product, small over the cases' few columns.
 */
const statedKeys = (proof: KeyProof): ReadonlyArray<string> => {
	const keys = Arr.reduce(
		keyFactors(proof),
		[[]],
		(chosen: ReadonlyArray<ReadonlyArray<string>>, alternatives) =>
			Arr.flatMap(alternatives, (classes) =>
				Arr.flatMap(
					Arr.reduce(classes, [[]], (within: ReadonlyArray<ReadonlyArray<string>>, members) =>
						Arr.flatMap(within, (k) => Arr.map(members, (m) => [...k, m]))
					),
					(w) => Arr.map(chosen, (k) => [...k, ...w])
				)
			)
	)
	return Arr.sort(Arr.dedupe(Arr.map(keys, spelled)), Order.String)
}

/** A dependency of a shape's own model: `from` determines `to`. */
interface Dep {
	readonly from: ReadonlyArray<string>
	readonly to: ReadonlyArray<string>
}

/** The columns `start` determines under `deps`, by brute force. */
const closedUnder = (deps: ReadonlyArray<Dep>, start: Iterable<string>): ReadonlySet<string> => {
	const known = new Set(start)
	for (let grew = true; grew;) {
		grew = false
		for (const d of deps) {
			if (Arr.every(d.from, (c) => known.has(c)) && Arr.some(d.to, (c) => !known.has(c))) {
				for (const c of d.to) {
					known.add(c)
				}
				grew = true
			}
		}
	}
	return known
}

/** Every subset of `columns`, in mask order. */
const subsetsOf = (columns: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.map(indices(2 ** columns.length), (mask) => Arr.filter(columns, (_, i) => holds(mask, i)))

/** The minimal sets of `heading` whose closure under `deps` holds it, each spelled, in name order. */
const minimalKeysOf = (
	heading: ReadonlyArray<string>,
	deps: ReadonlyArray<Dep>
): ReadonlyArray<string> => {
	const keys = Arr.filter(subsetsOf(heading), (set) => {
		const known = closedUnder(deps, set)
		return Arr.every(heading, (c) => known.has(c))
	})
	return Arr.sort(
		Arr.map(
			Arr.filter(
				keys,
				(k) => !Arr.some(keys, (o) => o.length < k.length && Arr.every(o, (c) => k.includes(c)))
			),
			spelled
		),
		Order.String
	)
}

/** The analysis of a DAG under the checker's evidence, every claim held to the facts by the reference. */
const analyzedSoundly = (dag: ValidDag, schema: GenSchema, facts: GenFacts): LogicalAnalysis => {
	const analysis = succeeded(analyzeLogical(dag, checkerEvidence))
	const soundness = logicalUnsound(
		analysis.dag,
		{ schema, facts, params: {}, observer: unobserved },
		() => undefined,
		{ keyedViews: false }
	)
	assert.ok(soundness.kind === "sound", soundness.kind === "unsound" ? soundness.why : "")
	return analysis
}

/** The one proof of a node of one heading group. */
const onlyProof = (props: Props): KeyProof => {
	const [proof, ...more] = props.keys
	assert.equal(more.length, 0, "one proof states every key of one heading group")
	return defined(proof, "the node's proof")
}

/** A relation a region matches: its width, its declared keys as column masks (the first its primary key), and the
 * variable each of its columns is bound to. */
interface Matched {
	readonly width: number
	readonly keys: Arr.NonEmptyReadonlyArray<number>
	readonly bindings: ReadonlyArray<string>
}

/** Two keys when neither holds the other, so neither is implied; one otherwise. */
const keysOf = (primary: number, candidate: number): Arr.NonEmptyReadonlyArray<number> =>
	(candidate & primary) !== candidate && (candidate & primary) !== primary
		? [primary, candidate]
		: [primary]

const columnName = (c: number): string => `c${c}`

/** A relation of two or three columns, each bound to the variable `variable` names it. */
const matchedGen =
	(variable: (c: number) => Gen<string>): Gen<Matched> =>
	(source) => {
		const width = source.draw(int(2, 3))
		const full = 2 ** width - 1
		return {
			width,
			keys: keysOf(source.draw(int(1, full)), source.draw(int(1, full))),
			bindings: Arr.map(indices(width), (c) => source.draw(variable(c)))
		}
	}

/** Drawn rows of a relation, few and over a small domain, so its keys collide and filter them. */
const rowsGen = (m: Matched): Gen<ReadonlyArray<ReadonlyArray<number>>> =>
	array(array(int(0, 2), { min: m.width, max: m.width }), { min: 0, max: 5 })

/** The stored relation of a matched one: int4 columns, its keys. */
const genRelation = (name: string, m: Matched): GenRelation => {
	const keyColumns = (mask: number) =>
		nonEmpty(
			Arr.filter(Arr.map(indices(m.width), columnName), (_, c) => holds(mask, c)),
			"a key's columns"
		)
	const [primary, ...candidates] = m.keys
	return {
		name,
		columns: Arr.map(indices(m.width), (c) => ({ name: columnName(c), type: int4 })),
		primaryKey: keyColumns(primary),
		keys: Arr.map(candidates, keyColumns),
		mutable: false
	}
}

/** The drawn rows a relation's keys admit, each kept only when it meets no earlier one on a key. */
const admitted = (
	m: Matched,
	rows: ReadonlyArray<ReadonlyArray<number>>
): ReadonlyArray<LiteralRow> => {
	const kept: Array<ReadonlyArray<number>> = []
	for (const row of rows) {
		const clashes = Arr.some(kept, (other) =>
			Arr.some(m.keys, (key) =>
				Arr.every(indices(m.width), (c) => !holds(key, c) || row[c] === other[c])
			)
		)
		if (!clashes) {
			kept.push(row)
		}
	}
	return Arr.map(kept, (row) => Arr.map(row, intLiteral))
}

/** A Base over a generated relation, every key it declares stated. */
const baseOf = (b: DagBuilder, r: GenRelation): RelNode =>
	b.node({
		kind: "Base",
		relation: r.name,
		occurrence: b.ids.occurrence(),
		primaryKey: nonEmpty(r.primaryKey, "a primary key"),
		keys: Arr.map(r.keys, (k) => nonEmpty(k, "a candidate key")),
		relationKind: "relation",
		heading: Arr.map(r.columns, (c) => ({ name: c.name, type: c.type })),
		loc: undefined,
		meta: conservativeMeta
	})

/** Each relation's key determines every variable it binds: a match's dependencies, as the model states them. */
const matchDeps = (m: Matched, extra: ReadonlyArray<string>): ReadonlyArray<Dep> =>
	Arr.map(m.keys, (key) => ({
		from: [...extra, ...Arr.filter(m.bindings, (_, c) => holds(key, c))],
		to: m.bindings
	}))

const schemaOf = (relations: ReadonlyArray<GenRelation>): GenSchema => ({
	name: "Gaps",
	relations,
	closed: [],
	containments: []
})

/** A region's variables, declared once each, in the order they are first bound. */
class Variables {
	readonly #b: DagBuilder
	readonly #declared = new Map<string, VarDecl>()

	constructor(b: DagBuilder) {
		this.#b = b
	}

	of(name: string): VarDecl {
		const known = this.#declared.get(name)
		if (known !== undefined) {
			return known
		}
		const decl: VarDecl = { id: this.#b.ids.var(), name, type: int4 }
		this.#declared.set(name, decl)
		return decl
	}

	get all(): ReadonlyArray<VarDecl> {
		return [...this.#declared.values()]
	}
}

/** The heading of a region delivering every variable. */
const headingOf = (vars: ReadonlyArray<VarDecl>): Heading =>
	Arr.map(vars, (v) => ({ name: v.name, type: v.type }))

/** A closed relation's column: fresh values, or a copy of an earlier column's, at int4 or int8. */
interface ClosedColumn {
	readonly copies: number
	readonly copied: boolean
	readonly wide: boolean
	readonly values: ReadonlyArray<number>
}

interface ClosedCase {
	readonly facts: number
	readonly columns: Arr.NonEmptyReadonlyArray<ClosedColumn>
}

const closedCaseGen: Gen<ClosedCase> = (source) => {
	const facts = source.draw(int(0, 4))
	const column = (i: number): ClosedColumn => ({
		copies: source.draw(int(0, Math.max(0, i - 1))),
		copied: i > 0 && source.draw(boolean),
		wide: source.draw(boolean),
		values: source.draw(array(int(0, 2), { min: facts, max: facts }))
	})
	return {
		facts,
		columns: [column(0), ...Arr.map(indices(source.draw(int(0, 4))), (i) => column(i + 1))]
	}
}

type ClosedFeature =
	| "two columns of identical values"
	| "identical values under two types"
	| "a distinct column of a class of several"
	| "a class of three columns"

describe("a closed relation's columns of identical values", () => {
	it.effect(
		"are one class of one type, a column of distinct values is a key, and every claim holds on the facts",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/logical/gaps-closed-classes",
						draw: drawn(closedCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the columns partitioned by type and by their values fact by fact, and the reference evaluator"
						},
						coverage: required<ClosedFeature>(
							[
								"two columns of identical values",
								"identical values under two types",
								"a distinct column of a class of several",
								"a class of three columns"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(cs, c) =>
						Effect.sync(() => {
							/** Each column's values: its own, or those of the column it copies. */
							const valuesOf = (i: number): ReadonlyArray<number> => {
								const col = defined(cs.columns[i], "a column")
								return col.copied ? valuesOf(col.copies) : col.values
							}
							const heading: Heading = Arr.map(cs.columns, (col, i) => ({
								name: columnName(i),
								type: col.wide ? int8 : int4
							}))
							const b = new DagBuilder(makeIdSupply())
							const closed = b.node({
								kind: "Closed",
								closed: "Facts",
								rows: Arr.map(indices(cs.facts), (r) =>
									Arr.map(indices(heading.length), (i) =>
										intLiteral(defined(valuesOf(i)[r], "a fact's value"))
									)
								),
								heading,
								loc: undefined,
								meta: conservativeMeta
							})
							const analysis = analyzedSoundly(b.build([closed]), schemaOf([]), {})
							const { props } = analysis.of(closed)
							const proof = onlyProof(props)
							/** The oracle's class of a column: the columns of its type holding its values fact by fact. */
							const classOf = (i: number) =>
								Arr.flatMap(heading, (h, j) =>
									h.type.carrier === defined(heading[i], "a column").type.carrier &&
									deepEquals(valuesOf(j), valuesOf(i))
										? [h.name]
										: []
								)
							for (const [i, h] of heading.entries()) {
								const expected = classOf(i)
								assert.deepEqual(
									Arr.fromIterable(defined(props.classes.get(h.name), `${h.name}'s class`)),
									expected,
									`${h.name}'s class`
								)
								const values = valuesOf(i)
								if (new Set(values).size === values.length) {
									assert.ok(
										keyIn(proof, (x) => x === h.name) !== undefined,
										`${h.name}, of distinct values, is a key`
									)
									if (expected.length > 1) {
										c.note("a distinct column of a class of several")
									}
								}
								if (expected.length > 1) {
									c.note("two columns of identical values")
								}
								if (expected.length > 2) {
									c.note("a class of three columns")
								}
								if (
									cs.facts > 0 &&
									Arr.some(
										heading,
										(o, j) => o.type.carrier !== h.type.carrier && deepEquals(valuesOf(j), values)
									)
								) {
									c.note("identical values under two types")
								}
							}
						})
				)
			)
	)
})

/** Where a lateral source's fixed column reads its value: the region's column, or the earlier occurrence's source's. */
type Target = "the region's column" | "the earlier occurrence's column"

/**
 * A region of two occurrences: R's facts bound to r0.., and S's bound to s0.., under a take correlated on S's column
 * `fixed` with R's column `to`, read laterally, possibly through a projection copying S's columns.
 */
interface LateralCase {
	readonly r: Matched
	readonly s: Matched
	readonly fixed: number
	readonly to: number
	readonly target: Target
	/** The take's bound: one row per evaluation, or more. */
	readonly take: number
	readonly projected: boolean
	readonly rows: readonly [
		ReadonlyArray<ReadonlyArray<number>>,
		ReadonlyArray<ReadonlyArray<number>>
	]
}

const lateralCaseGen: Gen<LateralCase> = (source) => {
	const r = source.draw(matchedGen((c) => constant(`r${c}`)))
	const s = source.draw(matchedGen((c) => constant(`s${c}`)))
	return {
		r,
		s,
		fixed: source.draw(int(0, s.width - 1)),
		to: source.draw(int(0, r.width - 1)),
		target: source.draw(
			weighted<Target>([
				[1, constant("the region's column")],
				[1, constant("the earlier occurrence's column")]
			])
		),
		take: source.draw(int(1, 3)),
		projected: source.draw(boolean),
		rows: [source.draw(rowsGen(r)), source.draw(rowsGen(s))]
	}
}

type LateralFeature =
	| Target
	| "through a projection"
	| "a key of the source holding its fixed column"
	| "a key holding the fixed column's variable"
	| "a take of one row"

describe("a lateral source's column fixed to a region column", () => {
	it.effect(
		"equals that column's variable both ways, the region's keys exactly its minimal keys, every claim holding on the facts",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/logical/gaps-lateral-fixed",
						draw: drawn(lateralCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "every subset of the region's variables closed under its matches and the fixed column's equality, and the reference evaluator"
						},
						coverage: required<LateralFeature>(
							[
								"the region's column",
								"the earlier occurrence's column",
								"through a projection",
								"a key of the source holding its fixed column",
								"a key holding the fixed column's variable",
								"a take of one row"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(lc, c) =>
						Effect.sync(() => {
							c.note(lc.target)
							const R = genRelation("R", lc.r)
							const S = genRelation("S", lc.s)
							const b = new DagBuilder(makeIdSupply())
							const vars = new Variables(b)
							const rBase = baseOf(b, R)
							const region = b.reserve()
							const t = defined(lc.r.bindings[lc.to], "R's fixed-to variable")
							const w = defined(lc.s.bindings[lc.fixed], "S's fixed variable")
							const sBase = baseOf(b, S)
							const outer = b.expr({
								kind: "column",
								column:
									lc.target === "the region's column"
										? { node: region, name: t }
										: { node: rBase.id, name: columnName(lc.to) },
								args: [],
								type: int4,
								nonNull: "storage"
							})
							const filtered = b.node({
								kind: "Take",
								input: sBase,
								order: {
									keys: Arr.map(sBase.heading, (h) => ({ column: h.name, dir: "asc" as const }))
								},
								bound: { kind: "literal", k: BigInt(lc.take) },
								correlation: [{ column: columnName(lc.fixed), expr: outer }],
								heading: sBase.heading,
								loc: undefined,
								meta: conservativeMeta
							})
							const lateral = lc.projected
								? b.node({
										kind: "ProjectSet",
										input: filtered,
										out: Arr.map(filtered.heading, (h) => ({
											name: h.name,
											expr: b.expr({
												kind: "column",
												column: { node: filtered.id, name: h.name },
												args: [],
												type: h.type,
												nonNull: "storage"
											})
										})),
										heading: filtered.heading,
										loc: undefined,
										meta: conservativeMeta
									})
								: filtered
							if (lc.projected) {
								c.note("through a projection")
							}
							const occurrences = [
								{
									id: b.ids.occurrence(),
									source: rBase,
									bindings: Arr.map(lc.r.bindings, (v, i) => ({
										column: columnName(i),
										var: vars.of(v)
									})),
									constants: []
								},
								{
									id: b.ids.occurrence(),
									source: lateral,
									bindings: Arr.map(lc.s.bindings, (v, i) => ({
										column: columnName(i),
										var: vars.of(v)
									})),
									constants: []
								}
							]
							const root = b.define(region, {
								kind: "MatchRegion",
								scope: b.ids.scope(),
								vars: vars.all,
								occurrences,
								equalities: [],
								correlated: [],
								heading: headingOf(vars.all),
								loc: undefined,
								meta: conservativeMeta
							})
							const analysis = analyzedSoundly(
								b.build([root]),
								schemaOf([R, S]),
								canonicalFacts({
									R: admitted(lc.r, lc.rows[0]),
									S: admitted(lc.s, lc.rows[1])
								})
							)
							const { props } = analysis.of(root)
							assert.ok(
								defined(props.classes.get(w), "the fixed column's variable's class").includes(t),
								`${w} and ${t} are one class`
							)
							const deps: ReadonlyArray<Dep> = [
								...matchDeps(lc.r, []),
								{ from: [t], to: [w] },
								{ from: [w], to: [t] },
								...Arr.map(lc.s.keys, (key) => ({
									from: [
										t,
										...Arr.filter(lc.s.bindings, (_, i) => i !== lc.fixed && holds(key, i))
									],
									to: lc.s.bindings
								})),
								...(lc.take === 1 ? [{ from: [t], to: lc.s.bindings }] : [])
							]
							const expected = minimalKeysOf(
								Arr.map(vars.all, (v) => v.name),
								deps
							)
							assert.deepEqual(statedKeys(onlyProof(props)), expected)
							if (lc.take === 1) {
								c.note("a take of one row")
							}
							if (Arr.some(lc.s.keys, (key) => holds(key, lc.fixed))) {
								c.note("a key of the source holding its fixed column")
							}
							if (Arr.some(expected, (k) => Arr.contains(Str.split(k, ","), w))) {
								c.note("a key holding the fixed column's variable")
							}
						})
				)
			)
	)
})

/** k relations matched in one region, their facts as drawn rows, and the variables two stacked projections keep. */
interface JoinCase {
	readonly matched: Arr.NonEmptyReadonlyArray<Matched>
	readonly rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>
	readonly keep: readonly [number, number]
}

/** Variables v0.. shared at random: few join the relations, many leave them a product. */
/**
 * Variables shared at random, few joining the relations and many leaving them a product; or a chain, each relation's
 * first column bound to the variable its predecessor binds its last column to, every other variable its own, so a
 * relation's key can hold a column another relation determines.
 */
const joinCaseGen =
	(most: number): Gen<JoinCase> =>
	(source) => {
		const k = source.draw(int(1, most))
		const chained = source.draw(boolean)
		const variables = chained ? 3 * k : source.draw(int(2, 3 * k))
		const random = (): Gen<string> => (drawing) => `v${drawing.draw(int(0, variables - 1))}`
		const own =
			(i: number) =>
			(c: number): Gen<string> =>
				constant(`v${3 * i + c}`)
		const relations: Array<Matched> = []
		for (const i of indices(k)) {
			const previous = relations.at(-1)
			const link = previous?.bindings.at(-1)
			const drawn = source.draw(matchedGen(chained ? own(i) : () => random()))
			relations.push(
				link === undefined || !chained
					? drawn
					: { ...drawn, bindings: [link, ...drawn.bindings.slice(1)] }
			)
		}
		const matched = nonEmpty(relations, "the matched relations")
		return {
			matched,
			rows: Arr.map(matched, (m) => source.draw(rowsGen(m))),
			keep: [source.draw(int(0, 2 ** variables - 1)), source.draw(int(0, 2 ** variables - 1))]
		}
	}

const relationName = (i: number): string => `R${i}`

/** The region over a join case's relations, each matched once, delivering every variable. */
const joinRegion = (b: DagBuilder, j: JoinCase): RelNode => {
	const vars = new Variables(b)
	const occurrences = Arr.map(j.matched, (m, i) => ({
		id: b.ids.occurrence(),
		source: baseOf(b, genRelation(relationName(i), m)),
		bindings: Arr.map(m.bindings, (v, c) => ({ column: columnName(c), var: vars.of(v) })),
		constants: []
	}))
	return b.node({
		kind: "MatchRegion",
		scope: b.ids.scope(),
		vars: vars.all,
		occurrences,
		equalities: [],
		correlated: [],
		heading: headingOf(vars.all),
		loc: undefined,
		meta: conservativeMeta
	})
}

const joinSchema = (j: JoinCase): GenSchema =>
	schemaOf(Arr.map(j.matched, (m, i) => genRelation(relationName(i), m)))

const joinFacts = (j: JoinCase): GenFacts =>
	canonicalFacts(
		Rec.fromEntries(
			Arr.map(j.matched, (m, i) => [relationName(i), admitted(m, j.rows[i] ?? [])] as const)
		)
	)

const joinDeps = (j: JoinCase): ReadonlyArray<Dep> =>
	Arr.flatMap(j.matched, (m) => matchDeps(m, []))

/** A projection of `input` copying the columns `keep` holds, at least the first. */
const projected = (b: DagBuilder, input: RelNode, keep: number): RelNode => {
	const kept = Arr.filter(input.heading, (_, i) => i === 0 || holds(keep, i))
	return b.node({
		kind: "ProjectSet",
		input,
		out: Arr.map(kept, (h) => ({
			name: h.name,
			expr: b.expr({
				kind: "column",
				column: { node: input.id, name: h.name },
				args: [],
				type: h.type,
				nonNull: "storage"
			})
		})),
		heading: kept,
		loc: undefined,
		meta: conservativeMeta
	})
}

type JoinFeature =
	| "a factor of two minimal keys"
	| "two factors of two minimal keys each"
	| "relations joined on a variable"
	| "a minimal key of several columns"

describe("keys of joined relations", () => {
	it.effect(
		"are one proof over independent factors whose choices are exactly the join's minimal keys, each holding on the facts",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/logical/gaps-join-keys",
						draw: drawn(joinCaseGen(3)),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "every subset of the region's variables closed under each relation's keys, and the reference evaluator"
						},
						coverage: required<JoinFeature>(
							[
								"a factor of two minimal keys",
								"two factors of two minimal keys each",
								"relations joined on a variable",
								"a minimal key of several columns"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(j, c) =>
						Effect.sync(() => {
							const b = new DagBuilder(makeIdSupply())
							const region = joinRegion(b, j)
							const analysis = analyzedSoundly(b.build([region]), joinSchema(j), joinFacts(j))
							const proof = onlyProof(analysis.of(region).props)
							const expected = minimalKeysOf(
								Arr.map(region.heading, (h) => h.name),
								joinDeps(j)
							)
							assert.deepEqual(statedKeys(proof), expected)
							const factors = Arr.map(keyFactors(proof), (f) => f.length)
							if (Arr.some(factors, (n) => n > 1)) {
								c.note("a factor of two minimal keys")
							}
							if (Arr.filter(factors, (n) => n > 1).length > 1) {
								c.note("two factors of two minimal keys each")
							}
							if (
								new Set(Arr.flatMap(j.matched, (m) => m.bindings)).size <
								Arr.reduce(j.matched, 0, (n, m) => n + m.width)
							) {
								c.note("relations joined on a variable")
							}
							if (Arr.some(expected, Str.includes(","))) {
								c.note("a minimal key of several columns")
							}
						})
				)
			)
	)
})

type ProjectionFeature =
	| "a dependency only a dropped column carries, from no key"
	| "two stacked projections dropping columns"
	| "a key of the projection narrower than its heading"

describe("projections of a join", () => {
	it.effect(
		"determine exactly what the join determines among their columns, a dependency through a dropped column included",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/logical/gaps-projection-closure",
						draw: drawn(joinCaseGen(3)),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the closure in the join of every subset of the projection's columns, and the reference evaluator"
						},
						coverage: required<ProjectionFeature>(
							[
								"a dependency only a dropped column carries, from no key",
								"two stacked projections dropping columns",
								"a key of the projection narrower than its heading"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(j, c) =>
						Effect.sync(() => {
							const b = new DagBuilder(makeIdSupply())
							const region = joinRegion(b, j)
							const first = projected(b, region, j.keep[0])
							const second = projected(b, first, j.keep[1])
							const analysis = analyzedSoundly(b.build([second]), joinSchema(j), joinFacts(j))
							const deps = joinDeps(j)
							const all = Arr.map(region.heading, (h) => h.name)
							for (const node of [first, second]) {
								const { props } = analysis.of(node)
								const heading = Arr.map(node.heading, (h) => h.name)
								const attributes = new Set([...heading, ...props.hidden])
								/** Only the dependencies whose determinants the node delivers: what a projection that drops would keep. */
								const delivered = Arr.filter(deps, (d) =>
									Arr.every(d.from, (x) => heading.includes(x))
								)
								for (const set of subsetsOf(heading)) {
									const reached = closure<never>(
										node.id,
										attributes,
										props.dependencies,
										set,
										() => undefined
									)
									const got = Arr.filter(heading, (h) => reached.columns.has(h))
									const known = closedUnder(deps, set)
									assert.deepEqual(
										got,
										Arr.filter(heading, (h) => known.has(h)),
										`[${Arr.join(set, ", ")}] at ${node.id}`
									)
									const without = closedUnder(delivered, set)
									if (
										!Arr.every(all, (v) => known.has(v)) &&
										Arr.some(heading, (h) => known.has(h) && !without.has(h))
									) {
										c.note("a dependency only a dropped column carries, from no key")
									}
								}
								if (Arr.some(analysis.of(node).props.keys, (k) => k.key.length < heading.length)) {
									c.note("a key of the projection narrower than its heading")
								}
							}
							if (
								second.heading.length < first.heading.length &&
								first.heading.length < all.length
							) {
								c.note("two stacked projections dropping columns")
							}
						})
				)
			)
	)
})
