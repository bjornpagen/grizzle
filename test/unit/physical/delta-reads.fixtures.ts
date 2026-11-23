/** What the property of delta-reads.test.ts reads: its space, its schemas and the judge's calls of the deltas' readers. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import type { OperandSelect } from "#compiler/sql/ast.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import { judgedStatementsOf } from "#test/support/judge.ts"
import { owning } from "#test/support/policy.ts"

/** A rule's law over D: a check over its facts, a containment of S into it, or a key over a projection of them. */
type Law = "check" | "contained" | "key"

/**
 * One case: its law; D's arms, each T's facts of one literal of `a`; and its judge: whole, T and S immutable, so the
 * rule is unit-local and one statement reads every arm of D over a delta of T, or probed, both mutable in their
 * document's unit and each arm joining W, mutable in a unit of its own, so the rule reads two units, a probe of each
 * arm reading the delta once.
 */
interface Shape {
	readonly law: Law
	readonly arms: 1 | 2 | 3 | 4
	readonly judge: "whole" | "probed"
}

export const shapeGen: Gen<Shape> = (s) => ({
	law: s.draw(element<Law>(["check", "contained", "key"])),
	arms: s.draw(element<Shape["arms"]>([1, 2, 3, 4])),
	judge: s.draw(element<Shape["judge"]>(["whole", "probed"]))
})

export type Reached =
	| "a delta read once"
	| "a delta read twice"
	| "a delta read three times or more"
	| "a statement reading two deltas"
	| "a whole rule's statement"
	| "a probe's statement"

/**
 * T and S, each keyed by its document first; D, the union of `arms` rules over T, the k-th T's facts whose `a` is k, by
 * document and place with their `b`. The rule judges D: its `b` at least 0, S's references among its `b`s by document,
 * or its `b` once per document.
 */
const schemaOf = (shape: Shape) => {
	const T = relation("T", { doc: pg.integer, at: pg.integer, a: pg.integer, b: pg.integer }, [
		"doc",
		"at"
	])
	const S = relation("S", { doc: pg.integer, at: pg.integer, ref: pg.integer }, ["doc", "at"])
	const W = relation("W", { wdoc: pg.integer }, ["wdoc"])
	const probed = shape.judge === "probed"
	const Base = schema(
		"delta_reads",
		[T, S, W],
		probed
			? [
					unit("Document", { doc: pg.integer }),
					unit("Ws", { wdoc: pg.integer }),
					mutable(T),
					mutable(S),
					mutable(W)
				]
			: []
	)
	/** The k-th arm: T's facts whose `a` is k, at a document W holds where the judge probes. */
	const arm = (k: number) => (r: Rule<typeof Base>) => {
		const { doc, at, b } = v(T, "t")
		const matched = r.match(T, { doc, at, a: k, b })
		return probed
			? matched.match(W, { wdoc: doc }).find({ doc, at, b })
			: matched.find({ doc, at, b })
	}
	const first = query(Base).rule(arm(1))
	const second = first.rule(arm(2))
	const third = second.rule(arm(3))
	const fourth = third.rule(arm(4))
	const D = derived(
		"D",
		shape.arms === 1 ? first : shape.arms === 2 ? second : shape.arms === 3 ? third : fourth
	)
	const law = (() => {
		switch (shape.law) {
			case "check":
				return check("Positive", D, (d) => d.ge(d.b, 0))
			case "contained":
				return contained(on(S, "doc", "ref"), on(D, "doc", "b"))
			case "key":
				return key(on(D, "doc", "b"))
		}
	})()
	return schema.extend([Base], "delta_reads_1", [D], [law])
}

/** How often a statement calls one function it reads rows of, and how many FROM sources read the rows of its calls. */
interface Calls {
	readonly calls: number
	readonly reads: number
}

/** The functions a query reads rows of, at any depth, a name for each FROM source that calls one. */
const calledIn = (query: OperandSelect): ReadonlyArray<string> => {
	const names: Array<string> = []
	visitSelect(query, {
		...inertVisitor,
		fromItem: (item) => {
			if (item.kind === "function" && item.call.fn.kind === "qualified") {
				names.push(item.call.fn.name)
			}
		}
	})
	return names
}

/**
 * How often `statement` calls each function it reads rows of, by the function's name, as PostgreSQL evaluates it, and
 * the reads of the rows of those calls: a call in the statement's body, its WITH aside, is made where it stands, once,
 * and read there; a call in a CTE of its WITH, once for each FROM that reads the CTE where the CTE is NOT MATERIALIZED,
 * which PostgreSQL spells at each such read (subselect.c inline_cte), once for the statement where any FROM reads one
 * that is not (a MATERIALIZED CTE, computed once, or one PostgreSQL decides, computed once where read twice or more and
 * spelled at its one read otherwise), and never for a CTE no FROM reads, its rows read by each FROM that reads the CTE.
 */
const callsOf = (statement: OperandSelect): ReadonlyMap<string, Calls> => {
	const out = new Map<string, Calls>()
	const add = (name: string, calls: number, reads: number): void => {
		const held = out.get(name)
		out.set(
			name,
			held === undefined
				? { calls, reads }
				: { calls: held.calls + calls, reads: held.reads + reads }
		)
	}
	const readsOf = new Map<string, number>()
	visitSelect(statement, {
		...inertVisitor,
		fromItem: (item) => {
			if (item.kind === "cte") {
				readsOf.set(item.name, (readsOf.get(item.name) ?? 0) + 1)
			}
		}
	})
	for (const name of calledIn({ ...statement, with: undefined })) {
		add(name, 1, 1)
	}
	for (const cte of statement.with === undefined ? [] : statement.with.ctes) {
		const body = cte.query
		if (body.kind !== "select") {
			assert.fail(`the judged statement's CTE ${cte.name} writes`)
		}
		const reads = readsOf.get(cte.name) ?? 0
		const calls = reads === 0 ? 0 : cte.materialized === "NOT MATERIALIZED" ? reads : 1
		for (const name of calledIn(body)) {
			add(name, calls, reads)
		}
	}
	return out
}

/**
 * Judges the calls of each statement of the judge of `shape`'s installation, the judge's and its parts', where its rules
 * stand (support/judge.ts judgedStatementsOf): it calls a function, a delta's reader, the only function any of them
 * reads rows of, and each one it calls it calls once, however many of its FROM sources read the rows of the call.
 */
export const judged = (shape: Shape, note: (r: Reached) => void): void => {
	const owned = owning(schemaOf(shape))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const statements = judgedStatementsOf(installation)
	assert.ok(statements.length > 0, "the rule is judged")
	for (const { query: statement } of statements) {
		note(shape.judge === "whole" ? "a whole rule's statement" : "a probe's statement")
		const calls = callsOf(statement)
		assert.ok(calls.size > 0, "a judged statement reads a delta through its reader")
		if (calls.size >= 2) {
			note("a statement reading two deltas")
		}
		for (const [name, c] of calls) {
			assert.equal(
				c.calls,
				1,
				`a judged statement calls the reader ${name} ${c.calls} times, its rows read by ${c.reads} FROM sources`
			)
			note(
				c.reads === 1
					? "a delta read once"
					: c.reads === 2
						? "a delta read twice"
						: "a delta read three times or more"
			)
		}
	}
}
