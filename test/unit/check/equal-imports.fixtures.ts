/**
 * What the properties of equal-imports.test.ts read: their schema, their box, a case's three programs, and each
 * program's checked nodes, statements, rows by the reference and digesting.
 */

import { element, finite, type Gen, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, Order, String as Str } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { CheckSession } from "#compiler/check/session.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { InferredQuery } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { queryInput } from "#compiler/program/input.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { everyCallCount } from "#test/support/kernel/calls.ts"
import { canonicallySpelled } from "#test/support/oracle/gen/domain.ts"
import type { GenFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenParam } from "#test/support/oracle/gen/query.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import { checking, checkOptions } from "#test/support/policy.ts"

/** Each child's item sessions, at a stage; each session's attempts; each attempt's values; and pairs of children. */
const Session = relation("Session", { child: int4, item: int4, stage: int4 }, ["child", "item"])
const Attempt = relation("Attempt", { child: int4, item: int4, at: int4 }, ["child", "item", "at"])
const Value = relation("Value", { child: int4, item: int4, at: int4, v: int4 }, [
	"child",
	"item",
	"at",
	"v"
])
const Pair = relation("Pair", { a: int4, b: int4 }, ["a", "b"])

const Ledger = schema("EqualImports", [Session, Attempt, Value, Pair], [])

/** The sittings a chain reads: a child at a stage, the relation parameter every level is bound to. */
const sittingHeading = { child: int4, stage: int4 } as const

/**
 * How a program builds the queries it imports: one object for every import of it; a factory that builds it anew at
 * every import, one Description each time, every one of them alike, as edullm's ledger reads
 * `gradableOf(gradedSitting).bind(bySession(r))` in each argument of its grade; or such a factory whose every import is
 * a Description of its own, apart from every other by a filter that holds of every row (`floorOf`), so no two imports
 * are of one identity: the program whose imports are each a node of their own, the reference the interned program's
 * rows are read against.
 */
export type Copies = "one object" | "a factory per import" | "a factory per import, each apart"

/** How deep a program's imported chain is: the fold alone, or a level above it that imports it. */
export type Depth = 1 | 2

/** How many arguments a program's reader reads, each its own query importing the chain. */
export type Readers = 1 | 2 | 3

/**
 * What each argument's sittings are bound to: a parameter of the reader; one of two parameters, by the argument's
 * parity; a variable of the reader's rule, an outer value; or one of two of them, by the argument's parity, two values
 * of one node read through two of its columns.
 */
export type Binding = "a parameter" | "two parameters" | "an outer value" | "two outer values"

/** A program's shape: its chain's depth, its readers and what each binds its sittings to. */
export interface Shape {
	readonly depth: Depth
	readonly readers: Readers
	readonly binding: Binding
}

const bindings = [
	"a parameter",
	"two parameters",
	"an outer value",
	"two outer values"
] as const satisfies ReadonlyArray<Binding>

export const shapes = Arr.flatMap([1, 2] as const, (depth) =>
	Arr.flatMap([1, 2, 3] as const, (readers) =>
		Arr.map(bindings, (binding): Shape => ({ depth, readers, binding }))
	)
)

const shapeCases: Gen<Shape> = element(shapes)

/** Every shape: each depth, each count of readers and each binding. */
export const shapeGen = finite(shapeCases)

/**
 * Whether two of a shape's arguments bind their sittings to one value, so a factory's imports of them are of one key:
 * any two where one value binds them all, the first and the third where two values alternate.
 */
export const twoArgumentsShareABinding = (shape: Shape): boolean => {
	switch (shape.binding) {
		case "a parameter":
		case "an outer value":
			return shape.readers > 1
		case "two parameters":
		case "two outer values":
			return shape.readers > 2
	}
}

/**
 * The floor an import's filter holds its attempts and stages to: 0, every import's alike, or one of its own below 0 for
 * each site; every attempt and stage the facts hold is at least 1, so every floor admits every row and only the
 * Descriptions differ.
 */
const floorOf = (copies: Copies, site: number): number =>
	copies === "a factory per import, each apart" ? -1 - site : 0

/** The import maker of `copies`: `build`'s query at every site, one object, or a new one at each. */
const maker = <A>(copies: Copies, build: (site: number) => A): ((site: number) => A) => {
	switch (copies) {
		case "one object": {
			const once = build(0)
			return () => once
		}
		case "a factory per import":
		case "a factory per import, each apart":
			return build
	}
}

/** The latest attempt of each session of the sittings, held to `floor`: a fold, the chain's bottom level. */
const bottomOf = (floor: number) =>
	query(Ledger).rule((r) => {
		const sittings = r.relation("sittings", sittingHeading)
		const { child, stage } = v(sittings, "sitting")
		const { item } = v(Session, "session")
		const { at } = v(Attempt, "attempt")
		return r
			.match(sittings, { child, stage })
			.match(Session, { child, item, stage })
			.match(Attempt, { child, item, at })
			.where(r.ge(at, floor))
			.find({ child, item, at: r.max(at) })
	})

/**
 * The level above the fold: the latest attempt, at least 2, of each session `below` holds at the same sittings, which
 * it imports at its own; its heading and type the fold's.
 */
const aboveOf = (floor: number, below: ReturnType<typeof bottomOf>) =>
	query(Ledger).rule((r) => {
		const sittings = r.relation("sittings", sittingHeading)
		const { child, stage } = v(sittings, "sitting")
		const { item } = v(Session, "session")
		const { at } = v(Attempt, "attempt")
		const held = below.bind({ sittings: r.relation("sittings", sittingHeading) })
		const { at: latest } = v(held, "below")
		return r
			.match(sittings, { child, stage })
			.match(Session, { child, item, stage })
			.match(Attempt, { child, item, at })
			.match(held, { child, item, at: latest })
			.where(r.ge(at, floor), r.ge(at, 2))
			.find({ child, item, at: r.max(at) })
	})

/** Every stage of a child's sessions, held to `floor`: what an argument's sittings are, bound to a child. */
const stagesOf = (floor: number) =>
	query(Ledger).rule((r) => {
		const { item, stage } = v(Session, "staged")
		const child = r.param("child", int4)
		return r.match(Session, { child, item, stage }).where(r.ge(stage, floor)).find({ child, stage })
	})

/**
 * A program: its reader, one rule reading each pair and `readers` arguments, the `j`-th the values of at least `j` of
 * the chain's attempts at its sittings, each argument binding the chain to its own sittings, which the reader binds to
 * the stages of a child, every argument read at one item and value, each row with its pair; the chain and the stages
 * built as `copies` says, at each argument.
 */
const programOf = (shape: Shape, copies: Copies) => {
	const bottom = maker(copies, (site) => bottomOf(floorOf(copies, site)))
	const top = maker(copies, (site) => aboveOf(floorOf(copies, site), bottom(site)))
	const chainAt = (site: number) => (shape.depth === 1 ? bottom(site) : top(site))
	const stages = maker(copies, (site) => stagesOf(floorOf(copies, site)))
	const argumentOf = (j: number) =>
		query(Ledger).rule((r) => {
			const chain = chainAt(j).bind({ sittings: r.relation("sittings", sittingHeading) })
			const { child, item, at } = v(chain, "top")
			const { v: x } = v(Value, "value")
			return r
				.match(chain, { child, item, at })
				.match(Value, { child, item, at, v: x })
				.where(r.ge(x, j))
				.find({ item, v: x })
		})
	return query(Ledger).rule((r) => {
		const { a, b } = v(Pair, "pair")
		const p = r.param("p", int4)
		const q = r.param("q", int4)
		const childOf = (j: number) => {
			const second = j % 2 === 1
			switch (shape.binding) {
				case "a parameter":
					return p
				case "two parameters":
					return second ? q : p
				case "an outer value":
					return a
				case "two outer values":
					return second ? b : a
			}
		}
		const read = (j: number) =>
			argumentOf(j).bind({ sittings: stages(j).bind({ child: childOf(j) }) })
		const first = read(0)
		const { item, v: x } = v(first, "arg")
		const rest = Array.from({ length: shape.readers - 1 }, (_, j) => j + 1)
		return Arr.reduce(rest, r.match(Pair, { a, b }).match(first, { item, v: x }), (rule, j) =>
			rule.match(read(j), { item, v: x })
		).find({ a, b, item, v: x })
	})
}

/** A program's Description, as a compile reads it, built anew at each call. */
export const descOf = (shape: Shape, copies: Copies): InferredQuery =>
	succeeded(queryInput(programOf(shape, copies)), "a query value").desc

/** A program's Description checked by one of `session`'s checks, as a query read checks it: its DAG and parameters. */
export const checkedBy = (desc: InferredQuery, session: CheckSession): LogicalQuery =>
	succeeded(checkQuery(checking(Ledger), desc, { ...checkOptions("equal imports"), session }))

/** A program checked as a query read checks it, by a compile of its own. */
export const checkedOf = (shape: Shape, copies: Copies): LogicalQuery =>
	checkedBy(descOf(shape, copies), CheckSession.own())

/** The identity digests' module (core/fingerprint.ts), whose calls are the work of digesting what a check reads. */
const isDigesting = (file: string): boolean => Str.endsWith("core/fingerprint.ts")(file)

/** The calls of the identity digests' functions while `check` runs: its digesting, counted, never timed. */
export const digestingOf = (check: () => LogicalQuery): Effect.Effect<number> =>
	Effect.map(everyCallCount(Effect.sync(check), isDigesting), ([, counts]) =>
		Arr.reduce([...counts.values()], 0, (sum, n) => sum + n)
	)

/** The nodes of a checked program's DAG. */
export const nodesOf = (checked: LogicalQuery): number => topoOrder(checked.dag).length

/** A program's statements as its compile's optimized lowering prints them, in order. */
export const statementsOf = (shape: Shape, copies: Copies): ReadonlyArray<string> =>
	Arr.map(
		succeeded(compileTemplate(programOf(shape, copies), undefined, testCompile), "compiles")
			.optimized,
		(s) => s.sql
	)

/** A program's stored facts and its parameters' values, each a small number, so facts meet often. */
export interface Facts {
	readonly sessions: ReadonlyArray<readonly [number, number, number]>
	readonly attempts: ReadonlyArray<readonly [number, number, number]>
	readonly values: ReadonlyArray<readonly [number, number, number, number]>
	readonly pairs: ReadonlyArray<readonly [number, number]>
	readonly p: number
	readonly q: number
}

const small = [1, 2] as const

const cells = Arr.flatMap(small, (child) => Arr.map(small, (item) => [child, item] as const))

const attemptRows = Arr.flatMap(cells, ([child, item]) =>
	Arr.map([1, 2, 3] as const, (at) => [child, item, at] as const)
)

const valueRows = Arr.flatMap(attemptRows, ([child, item, at]) =>
	Arr.map([0, 1, 2] as const, (x) => [child, item, at, x] as const)
)

/** Facts: each session at a stage or absent, any attempts, values and pairs of the small domain, p and q of it. */
export const factsGen: Gen<Facts> = (source) => {
	const sessions = Arr.flatMap(cells, ([child, item]) => {
		const stage = element([0, 1, 2] as const)(source)
		return stage === 0 ? [] : [[child, item, stage] as const]
	})
	return {
		sessions,
		attempts: subarray(attemptRows)(source),
		values: subarray(valueRows)(source),
		pairs: subarray(cells)(source),
		p: element(small)(source),
		q: element(small)(source)
	}
}

const intLiteral = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/** The relations a checked DAG reads, as the reference reads them: each Base's relation, its heading and keys. */
const genSchemaOf = (checked: LogicalQuery): GenSchema => {
	const bases = new Map<string, RelNode>()
	for (const node of topoOrder(checked.dag)) {
		if (node.kind === "Base" && !bases.has(node.relation)) {
			bases.set(node.relation, node)
		}
	}
	return {
		name: "EqualImports",
		relations: Arr.flatMap([...bases.values()], (node) =>
			node.kind === "Base"
				? [
						{
							name: node.relation,
							columns: Arr.map(node.heading, (c) => ({ name: c.name, type: c.type })),
							primaryKey: node.primaryKey,
							keys: node.keys,
							mutable: false
						}
					]
				: []
		),
		closed: [],
		containments: []
	}
}

/** The facts of `facts` by relation, each row's values in its relation's column order. */
const genFactsOf = (facts: Facts): GenFacts => {
	const rows = (values: ReadonlyArray<ReadonlyArray<number>>) =>
		Arr.map(values, (row) => Arr.map(row, (n) => canonicallySpelled(intLiteral(n))))
	return {
		Session: rows(facts.sessions),
		Attempt: rows(facts.attempts),
		Value: rows(facts.values),
		Pair: rows(facts.pairs)
	}
}

/**
 * The rows a checked program reads over `facts` by the reference evaluator, each row one text of its cells by column
 * name, sorted.
 */
export const rowsOf = (checked: LogicalQuery, facts: Facts): ReadonlyArray<string> => {
	const params: Record<string, GenParam> = {}
	for (const decl of checked.params) {
		if (decl.kind === "scalar") {
			params[decl.id] = {
				kind: "scalar",
				type: decl.type,
				value: intLiteral(decl.name === "q" ? facts.q : facts.p)
			}
		}
	}
	const root = checked.dag.roots[0]
	const reference = Reference.of(checked.dag, {
		schema: genSchemaOf(checked),
		facts: genFactsOf(facts),
		params,
		functions: noFunctions,
		observer: unobserved
	})
	const names = Arr.map(root.heading, (c) => c.name)
	return Arr.sort(
		Arr.map(reference.eval(root, noBindings).rows, (row) =>
			Arr.join(
				Arr.sort(
					Arr.map(names, (name, i) => `${name}=${Formatter.format(row[i])}`),
					Order.String
				),
				" "
			)
		),
		Order.String
	)
}
