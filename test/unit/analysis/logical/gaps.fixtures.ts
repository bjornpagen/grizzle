/** What the properties of gaps.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { array, boolean, constant, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record as Rec } from "effect"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { type TypedLiteral, storedColumn } from "#compiler/ir/expr.ts"
import { keyFactors, type KeyProof } from "#compiler/ir/keys.ts"
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
	everyNode,
	type LogicalAnalysis
} from "#compiler/logical/annotate.ts"
import type { Props } from "#compiler/logical/props.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { succeeded } from "#test/support/assert.ts"
import { canonicalFacts, type GenFacts, type LiteralRow } from "#test/support/oracle/gen/facts.ts"
import type { GenRelation, GenSchema } from "#test/support/oracle/gen/schema.ts"
import { unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import { logicalUnsound } from "#test/unit/analysis/logical/support.ts"

export const int4 = plainType("int4")

export const int8 = plainType("int8")

export const intLiteral = (value: number): TypedLiteral => ({ kind: "int", value: BigInt(value) })

/** Whether position `at` is in `mask`. */
export const holds = (mask: number, at: number): boolean => (mask & (1 << at)) !== 0

/** A key as the sorted names of its columns, the one spelling two keys are compared by. */
const spelled = (key: Iterable<string>): string => Arr.join(Arr.sort([...key], Order.String), ",")

/**
 * Every key a proof states: one minimal key of each factor (ir/keys.ts keyFactors), then one column of each class of
 * its columns, each spelled. A product, small over the cases' few columns.
 */
export const statedKeys = (proof: KeyProof): ReadonlyArray<string> => {
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
export interface Dep {
	readonly from: ReadonlyArray<string>
	readonly to: ReadonlyArray<string>
}

/** The columns `start` determines under `deps`, by brute force. */
export const closedUnder = (
	deps: ReadonlyArray<Dep>,
	start: Iterable<string>
): ReadonlySet<string> => {
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
export const subsetsOf = (columns: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.map(indices(2 ** columns.length), (mask) => Arr.filter(columns, (_, i) => holds(mask, i)))

/** The minimal sets of `heading` whose closure under `deps` holds it, each spelled, in name order. */
export const minimalKeysOf = (
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
export const analyzedSoundly = (
	dag: ValidDag,
	schema: GenSchema,
	facts: GenFacts
): LogicalAnalysis => {
	const analysis = succeeded(analyzeLogical(dag, checkerEvidence, everyNode))
	const soundness = logicalUnsound(
		analysis.dag,
		{ schema, facts, params: {}, functions: noFunctions, observer: unobserved },
		() => undefined,
		{ keyedViews: false }
	)
	assert.ok(soundness.kind === "sound", soundness.kind === "unsound" ? soundness.why : "")
	return analysis
}

/** The one proof of a node of one heading group. */
export const onlyProof = (props: Props): KeyProof => {
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

export const columnName = (c: number): string => `c${c}`

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
export const genRelation = (name: string, m: Matched): GenRelation => {
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
export const admitted = (
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
export const baseOf = (b: DagBuilder, r: GenRelation): RelNode =>
	b.node({
		kind: "Base",
		relation: r.name,
		occurrence: b.ids.occurrence(),
		primaryKey: nonEmpty(r.primaryKey, "a primary key"),
		keys: Arr.map(r.keys, (k) => nonEmpty(k, "a candidate key")),
		relationKind: "relation",
		generated: [],
		unit: [],
		determined: [],
		heading: Arr.map(r.columns, (c) => ({ name: c.name, type: c.type })),
		loc: undefined,
		meta: conservativeMeta
	})

/** Each relation's key determines every variable it binds: a match's dependencies, as the model states them. */
export const matchDeps = (m: Matched, extra: ReadonlyArray<string>): ReadonlyArray<Dep> =>
	Arr.map(m.keys, (key) => ({
		from: [...extra, ...Arr.filter(m.bindings, (_, c) => holds(key, c))],
		to: m.bindings
	}))

export const schemaOf = (relations: ReadonlyArray<GenRelation>): GenSchema => ({
	name: "Gaps",
	relations,
	closed: [],
	containments: []
})

/** A region's variables, declared once each, in the order they are first bound. */
export class Variables {
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
export const headingOf = (vars: ReadonlyArray<VarDecl>): Heading =>
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

export const closedCaseGen: Gen<ClosedCase> = (source) => {
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

export type ClosedFeature =
	| "two columns of identical values"
	| "identical values under two types"
	| "a distinct column of a class of several"
	| "a class of three columns"

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

export const lateralCaseGen: Gen<LateralCase> = (source) => {
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

export type LateralFeature =
	| Target
	| "through a projection"
	| "a key of the source holding its fixed column"
	| "a key holding the fixed column's variable"
	| "a take of one row"

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
export const joinCaseGen =
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

/**
 * Two keys of a relation of `width` columns, neither holding the other, by construction: a column only the primary key
 * holds and another only the candidate holds, and every other column in the primary, the candidate, both or neither.
 */
const incomparableKeysGen =
	(width: number): Gen<Arr.NonEmptyReadonlyArray<number>> =>
	(source) => {
		const primaryOnly = source.draw(int(0, width - 1))
		const candidateOnly = (primaryOnly + 1 + source.draw(int(0, width - 2))) % width
		const shared = Arr.filter(indices(width), (c) => c !== primaryOnly && c !== candidateOnly)
		const [primary, candidate] = Arr.reduce(
			shared,
			[1 << primaryOnly, 1 << candidateOnly] as const,
			([p, k], c): readonly [number, number] => [
				source.draw(boolean) ? p | (1 << c) : p,
				source.draw(boolean) ? k | (1 << c) : k
			]
		)
		return [primary, candidate]
	}

/**
 * A join case of independent factors of two minimal keys each, what "two factors of two minimal keys each" needs and the
 * plain draw reaches only by the chance that two relations each declare two incomparable keys and share no variable: two
 * to `most` relations, each over variables of its own (a product, so no relation's key determines another's columns),
 * each declaring two keys neither of which holds the other.
 */
export const independentFactorsGen =
	(most: number): Gen<JoinCase> =>
	(source) => {
		const k = source.draw(int(2, most))
		const matched = nonEmpty(
			Arr.map(indices(k), (i): Matched => {
				const width = source.draw(int(2, 3))
				return {
					width,
					keys: source.draw(incomparableKeysGen(width)),
					bindings: Arr.map(indices(width), (c) => `v${3 * i + c}`)
				}
			}),
			"the matched relations"
		)
		const variables = 3 * k
		return {
			matched,
			rows: Arr.map(matched, (m) => source.draw(rowsGen(m))),
			keep: [source.draw(int(0, 2 ** variables - 1)), source.draw(int(0, 2 ** variables - 1))]
		}
	}

const relationName = (i: number): string => `R${i}`

/** The region over a join case's relations, each matched once, delivering every variable. */
export const joinRegion = (b: DagBuilder, j: JoinCase): RelNode => {
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

export const joinSchema = (j: JoinCase): GenSchema =>
	schemaOf(Arr.map(j.matched, (m, i) => genRelation(relationName(i), m)))

export const joinFacts = (j: JoinCase): GenFacts =>
	canonicalFacts(
		Rec.fromEntries(
			Arr.map(j.matched, (m, i) => [relationName(i), admitted(m, j.rows[i] ?? [])] as const)
		)
	)

export const joinDeps = (j: JoinCase): ReadonlyArray<Dep> =>
	Arr.flatMap(j.matched, (m) => matchDeps(m, []))

/** A projection of `input` copying the columns `keep` holds, at least the first. */
export const projected = (b: DagBuilder, input: RelNode, keep: number): RelNode => {
	const kept = Arr.filter(input.heading, (_, i) => i === 0 || holds(keep, i))
	return b.node({
		kind: "ProjectSet",
		input,
		out: Arr.map(kept, (h) => ({
			name: h.name,
			expr: b.expr(storedColumn(input.id, h.name, h.type))
		})),
		heading: kept,
		loc: undefined,
		meta: conservativeMeta
	})
}

export type JoinFeature =
	| "a factor of two minimal keys"
	| "two factors of two minimal keys each"
	| "relations joined on a variable"
	| "a minimal key of several columns"

export type ProjectionFeature =
	| "a dependency only a dropped column carries, from no key"
	| "two stacked projections dropping columns"
	| "a key of the projection narrower than its heading"
