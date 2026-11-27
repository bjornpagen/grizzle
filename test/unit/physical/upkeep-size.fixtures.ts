/**
 * What upkeep-size.test.ts reads: stacks of stored derivations under a stored relation and a law, the size of the
 * relation's upkeep and of the law's judge.
 *
 * A stack is forward_branch_rule's shape cut to its bones (qti-pie pantry src/qti/overlay-queries/tests.ts
 * ForwardBranchRule over targetedBranchRuleRows, commonSectionRows and fixedBackwardRows, each over the queries below
 * it, each reading qti.node): N, written, keyed by its document then its place, the document a declared unit; the
 * derivations of the first level over N, and each of a level above over every derivation of the one below, joined to N
 * at its place, each a derivation of one document read at its key, so admission stores each in a table of its own
 * (analysis/derived/storage.ts); D, stored, joining the written T to the top at its place; and Linked, live, reading the
 * top at each link's target across documents, under the check Small. Every derivation is a derived relation of its own
 * name, or a query its readers import, as qti's derivations beneath ForwardBranchRule are, the top computing a program of
 * its value where the case says, as test/pg/derived/stored's compiles do. D's definition and Small's are the same at
 * every depth, fan and naming; spelled in place, the top's would hold the fan to the depth's power of copies of N, and
 * its call.
 */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Fn } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { v as typedVars } from "#compiler/public/query.ts"
import { fn } from "#compiler/public/schema.ts"
import { type QueryValue, queryOver as query, varsOver as v } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { derivedBuilder, relationBuilder as relation } from "#compiler/schema/relation.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { checkBuilder, unitBuilder } from "#compiler/schema/statements.ts"
import type { RowTerm, rowHelpers } from "#compiler/schema/terms.ts"
import type { Expr, OperandSelect } from "#compiler/sql/ast.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { judgedStatementsOf, upkeepReadsOf } from "#test/support/judge.ts"
import { owning } from "#test/support/policy.ts"

/** How the derivations beneath D and Linked are declared: each a derived relation of its own name, or a query the level
 * above imports, which admission stores alike, by its canonical form (analysis/derived/canonical.ts). */
export type Naming = "named" | "imported"

const namings = ["named", "imported"] as const satisfies ReadonlyArray<Naming>

/** What the top derivation's head computes beside its fields: nothing, or a program, a declared function's value of its
 * value, as test/pg/derived/stored's compiles are (edullm's WalkPattern). */
export type Computes = "nothing" | "a call"

const computings = ["nothing", "a call"] as const satisfies ReadonlyArray<Computes>

/** A stack: how many levels of stored derivations stand beneath D and Linked, one to four; how many derivations each
 * level below the top holds, every one read by each derivation of the level above, one or two; how they are declared;
 * and what the top computes. */
export interface Stack {
	readonly depth: number
	readonly fan: number
	readonly naming: Naming
	readonly computes: Computes
}

export const stackGen: Gen<Stack> = (s) => ({
	depth: s.draw(int(1, 4)),
	fan: s.draw(int(1, 2)),
	naming: s.draw(element(namings)),
	computes: s.draw(element(computings))
})

/** A value's program, immutable, which the top computes where the case says. */
const compile = fn("compile", {
	calls: [],
	args: { x: pg.integer },
	returns: pg.integer,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT x * 7 + 1`
})

const N = relation("N", { doc: pg.integer, at: pg.integer, v: pg.integer }, ["doc", "at"], [])
/** T, written, which D joins to the top, and Link, written, which Linked reads the top across documents at: what
 * stand-size.fixtures.ts reads beside the stack too. */
export const T = relation(
	"T",
	{ doc: pg.integer, at: pg.integer, w: pg.integer },
	["doc", "at"],
	[]
)
export const Link = relation(
	"Link",
	{ doc: pg.integer, at: pg.integer, toDoc: pg.integer, toAt: pg.integer },
	["doc", "at"],
	[]
)
const base = schema(
	"upkeep_size",
	[N, T, Link, compile],
	[unitBuilder("Document", { doc: pg.integer }, [])],
	[]
)

/** The variables of a match of N, typed by its fields, so the top's program is a call of `compile` at its value. */
const placeOf = () => typedVars(N, "n")

/** A row of Linked as Small reads it. */
type LinkedRow = { readonly v: RowTerm } & typeof rowHelpers

/**
 * The stack's schema (stand-size.fixtures.ts reads it too): P1, a document's places of a positive value, and, beside each P below the top where the fan is
 * two, Q1, those above one; each P and Q above, its places whose value is above the one below's at the place, P(i-1)'s
 * and, at fan two, Q(i-1)'s too, a Q's below the latter's, so each level reads every derivation of the one below it at
 * its place; D and Linked over the top P. Each derivation is named, its level holding it, or a query its readers import,
 * over the base.
 */
export const stackSchemaOf = (stack: Stack) => {
	/** The head of a derivation of a place `doc` and `at` of value `value`: the top's computes its program too, where the
	 * case says. */
	const headOf = (doc: unknown, at: unknown, n: ReturnType<typeof placeOf>, top: boolean) =>
		top && stack.computes === "a call"
			? { doc, at, v: n.v, program: Fn.call(compile, { x: n.v }) }
			: { doc, at, v: n.v }
	/** A first level's derivation, of the places whose value is above `floor`. */
	const leafOf = (floor: number, top: boolean): QueryValue =>
		query(base).rule((r: RuleValue) => {
			const n = placeOf()
			return r
				.match(N, { doc: n.doc, at: n.at, v: n.v })
				.where(r.gt(n.v, floor))
				.find(headOf(n.doc, n.at, n, top))
		})
	/** A derivation over `p` and, where the fan is two, `q`, the level below's, at the place: its value above p's, and
	 * below q's for a Q, above it for a P. */
	const levelOf = (
		p: unknown,
		q: unknown,
		over: unknown,
		kind: "P" | "Q",
		top: boolean
	): QueryValue =>
		query(over).rule((r: RuleValue) => {
			const first = v(p, "p")
			const n = placeOf()
			const read = r
				.match(p, { doc: first["doc"], at: first["at"], v: first["v"] })
				.match(N, { doc: first["doc"], at: first["at"], v: n.v })
			const head = headOf(first["doc"], first["at"], n, top)
			if (q === undefined) {
				return read.where(r.gt(n.v, first["v"])).find(head)
			}
			const second = v(q, "q")
			return read
				.match(q, { doc: first["doc"], at: first["at"], v: second["v"] })
				.where(
					r.gt(n.v, first["v"]),
					kind === "P" ? r.gt(n.v, second["v"]) : r.lt(n.v, second["v"])
				)
				.find(head)
		})
	let p: unknown = undefined
	let q: unknown = undefined
	let reader: AnySchema = base
	for (let i = 1; i <= stack.depth; i++) {
		const beside = stack.fan === 2 && i < stack.depth
		const top = i === stack.depth
		const atP = i === 1 ? leafOf(0, top) : levelOf(p, q, reader, "P", top)
		const atQ = beside
			? i === 1
				? leafOf(1, false)
				: levelOf(p, q, reader, "Q", false)
			: undefined
		if (stack.naming === "named") {
			const named = [
				derivedBuilder(`P${i}`, atP, []),
				...(atQ === undefined ? [] : [derivedBuilder(`Q${i}`, atQ, [])])
			]
			reader = schema.extend([reader], `upkeep_size_${i}`, named, [], [])
			p = named[0]
			q = named[1]
		} else {
			p = atP
			q = atQ
		}
	}
	const top = p
	/** The top's fields D and Linked read: its program too, where it computes one. */
	const fieldsOf = (row: Readonly<Record<string, unknown>>, at: unknown, doc: unknown) =>
		stack.computes === "a call"
			? { doc, at, v: row["v"], program: row["program"] }
			: { doc, at, v: row["v"] }
	const D = derivedBuilder(
		"D",
		query(reader).rule((r: RuleValue) => {
			const t = v(T, "t")
			const at = v(top, "top")
			return r
				.match(T, { doc: t["doc"], at: t["at"], w: t["w"] })
				.match(top, fieldsOf(at, t["at"], t["doc"]))
				.find({ ...fieldsOf(at, t["at"], t["doc"]), w: t["w"] })
		}),
		[]
	)
	const Linked = derivedBuilder(
		"Linked",
		query(reader).rule((r: RuleValue) => {
			const link = v(Link, "link")
			const target = v(top, "target")
			return r
				.match(Link, {
					doc: link["doc"],
					at: link["at"],
					toDoc: link["toDoc"],
					toAt: link["toAt"]
				})
				.match(top, fieldsOf(target, link["toAt"], link["toDoc"]))
				.find(fieldsOf(target, link["at"], link["doc"]))
		}),
		[]
	)
	return schema.extend(
		[reader],
		"upkeep_size_top",
		[D, Linked],
		[checkBuilder("Small", Linked, (t: LinkedRow) => t.le(t.v, 100))],
		[]
	)
}

/** How many nodes a query holds: its expressions, FROM items, WITH clauses and set operations, at every depth. */
const nodesOf = (statement: OperandSelect): number => {
	let nodes = 0
	const count = (): void => {
		nodes += 1
	}
	visitSelect(statement, {
		...inertVisitor,
		expr: count,
		fromItem: count,
		with: count,
		setOp: count
	})
	return nodes
}

/** How many calls of the installed function `name` a query holds, at every depth. */
const callsOf = (statement: OperandSelect, name: string): number => {
	let calls = 0
	const call = (e: Expr): void => {
		if (e.kind === "call" && e.fn.kind === "qualified" && e.fn.name === name) {
			calls += 1
		}
	}
	visitSelect(statement, { ...inertVisitor, expr: call })
	return calls
}

/**
 * The sizes of a stack's statements over the top, in nodes: each statement of D's upkeep (support/judge.ts
 * upkeepReadsOf), in its body's order, and each statement the judge tests Small by, smallest first, since their order
 * is their parts' names'; how many stored relations are upkept; and the calls of `compile` D's upkeep and Small's
 * judge hold, and the top's own upkeep.
 */
export interface Sizes {
	readonly upkeep: ReadonlyArray<number>
	readonly judge: ReadonlyArray<number>
	readonly upkept: number
	readonly calls: { readonly upkeep: number; readonly judge: number; readonly top: number }
}

export const sizesOf = (stack: Stack): Sizes => {
	const owned = owning(stackSchemaOf(stack))
	const installation = succeeded(
		compileInstallation(owned, installOptions(owned)),
		"every stack compiles"
	)
	const compiled = installation.names.declaredFunction("compile").ref.name
	const upkeep = upkeepReadsOf(installation, "D")
	const judged = Arr.map(judgedStatementsOf(installation), (s) => s.query)
	/** The top, the stored relation D's upkeep reads beside T. */
	const top = Arr.flatMap(installation.laws.theory.upkeeps, (u) =>
		u.relation === "D"
			? Arr.filter(
					Arr.map(u.reads, (r) => r.relation),
					(r) => r !== "T"
				)
			: []
	)
	const sum = (statements: ReadonlyArray<OperandSelect>): number =>
		Arr.reduce(statements, 0, (n, statement) => n + callsOf(statement, compiled))
	return {
		upkeep: Arr.map(upkeep, nodesOf),
		judge: Arr.sort(Arr.map(judged, nodesOf), Order.Number),
		upkept: installation.laws.theory.upkeeps.length,
		calls: {
			upkeep: sum(upkeep),
			judge: sum(judged),
			top: sum(Arr.flatMap(top, (relation) => upkeepReadsOf(installation, relation)))
		}
	}
}
