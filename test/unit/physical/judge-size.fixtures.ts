/** What the properties of judge-size.test.ts read: their spaces, their schemas and the judge's reads of Node. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, derived, relation, schema } from "#compiler/public/schema.ts"
import type { FromItem, FromSource, OperandSelect } from "#compiler/sql/ast.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import { succeeded } from "#test/support/assert.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import { judgedStatementsOf } from "#test/support/judge.ts"
import { owning } from "#test/support/policy.ts"

/**
 * One case: a chain of `depth` queries over Node, each the join of `uses` matches of the one before it, every match
 * within one document, each by the field the one before it binds; and a whole rule over the last, a check of its kind.
 * Each level's `uses` matches of the one below read the first at the row's own `a` and each later one at the `b` of the
 * one before, delivering the first's `a` and `k` and the last's `b`: the walk `uses` steps up the parent links, which
 * unfolded is the level below's rule `uses` times over. Each level is its own value (once1 to thrice3), its heading
 * typed by the level it reads.
 */
export interface Chain {
	readonly depth: 1 | 2 | 3
	readonly uses: 1 | 2 | 3
}

export const chainGen: Gen<Chain> = (s) => ({
	depth: s.draw(element<Chain["depth"]>([1, 2, 3])),
	uses: s.draw(element<Chain["uses"]>([1, 2, 3]))
})

export type Reached =
	| "a definition read once"
	| "a definition read twice"
	| "a definition read three times"
	| "a chain three deep"

const Node = relation(
	"Node",
	{ doc: pg.integer, start: pg.integer, parent: pg.integer, kind: pg.integer },
	["doc", "start"]
)
const Base = schema("judge_size", [Node], [])

/** Q0, each node with its parent and kind under its own names, and its first field `a`. */
const leaf = query(Base).rule((r) => {
	const { doc, start, parent, kind } = v(Node, "n")
	return r.match(Node, { doc, start, parent, kind }).find({ doc, a: start, b: parent, k: kind })
})

const once1 = query(Base).rule((r) => {
	const { doc, a, b, k } = v(leaf, "x0")
	return r.match(leaf, { doc, a, b, k }).find({ doc, a, b, k })
})
const once2 = query(Base).rule((r) => {
	const { doc, a, b, k } = v(once1, "x0")
	return r.match(once1, { doc, a, b, k }).find({ doc, a, b, k })
})
const once3 = query(Base).rule((r) => {
	const { doc, a, b, k } = v(once2, "x0")
	return r.match(once2, { doc, a, b, k }).find({ doc, a, b, k })
})
const twice1 = query(Base).rule((r) => {
	const { doc, a, b, k } = v(leaf, "x0")
	const { b: b1 } = v(leaf, "x1")
	return r
		.match(leaf, { doc, a, b, k })
		.match(leaf, { doc, a: b, b: b1 })
		.find({ doc, a, b: b1, k })
})
const twice2 = query(Base).rule((r) => {
	const { doc, a, b, k } = v(twice1, "x0")
	const { b: b1 } = v(twice1, "x1")
	return r
		.match(twice1, { doc, a, b, k })
		.match(twice1, { doc, a: b, b: b1 })
		.find({ doc, a, b: b1, k })
})
const twice3 = query(Base).rule((r) => {
	const { doc, a, b, k } = v(twice2, "x0")
	const { b: b1 } = v(twice2, "x1")
	return r
		.match(twice2, { doc, a, b, k })
		.match(twice2, { doc, a: b, b: b1 })
		.find({ doc, a, b: b1, k })
})
const thrice1 = query(Base).rule((r) => {
	const { doc, a, b, k } = v(leaf, "x0")
	const { b: b1 } = v(leaf, "x1")
	const { b: b2 } = v(leaf, "x2")
	return r
		.match(leaf, { doc, a, b, k })
		.match(leaf, { doc, a: b, b: b1 })
		.match(leaf, { doc, a: b1, b: b2 })
		.find({ doc, a, b: b2, k })
})
const thrice2 = query(Base).rule((r) => {
	const { doc, a, b, k } = v(thrice1, "x0")
	const { b: b1 } = v(thrice1, "x1")
	const { b: b2 } = v(thrice1, "x2")
	return r
		.match(thrice1, { doc, a, b, k })
		.match(thrice1, { doc, a: b, b: b1 })
		.match(thrice1, { doc, a: b1, b: b2 })
		.find({ doc, a, b: b2, k })
})
const thrice3 = query(Base).rule((r) => {
	const { doc, a, b, k } = v(thrice2, "x0")
	const { b: b1 } = v(thrice2, "x1")
	const { b: b2 } = v(thrice2, "x2")
	return r
		.match(thrice2, { doc, a, b, k })
		.match(thrice2, { doc, a: b, b: b1 })
		.match(thrice2, { doc, a: b1, b: b2 })
		.find({ doc, a, b: b2, k })
})

/** The chain's schema: Base, and the derived relation of its last query with a check of its kind beside it. */
const schemaOf = (c: Chain): FixtureSchema => {
	switch (`${c.uses} ${c.depth}` as const) {
		case "1 1": {
			const Top = derived("Top", once1)
			return schema.extend(
				[Base],
				"judge_size_1",
				[Top],
				[check("Small", Top, (t) => t.le(t.k, 100))]
			)
		}
		case "1 2": {
			const Top = derived("Top", once2)
			return schema.extend(
				[Base],
				"judge_size_1",
				[Top],
				[check("Small", Top, (t) => t.le(t.k, 100))]
			)
		}
		case "1 3": {
			const Top = derived("Top", once3)
			return schema.extend(
				[Base],
				"judge_size_1",
				[Top],
				[check("Small", Top, (t) => t.le(t.k, 100))]
			)
		}
		case "2 1": {
			const Top = derived("Top", twice1)
			return schema.extend(
				[Base],
				"judge_size_1",
				[Top],
				[check("Small", Top, (t) => t.le(t.k, 100))]
			)
		}
		case "2 2": {
			const Top = derived("Top", twice2)
			return schema.extend(
				[Base],
				"judge_size_1",
				[Top],
				[check("Small", Top, (t) => t.le(t.k, 100))]
			)
		}
		case "2 3": {
			const Top = derived("Top", twice3)
			return schema.extend(
				[Base],
				"judge_size_1",
				[Top],
				[check("Small", Top, (t) => t.le(t.k, 100))]
			)
		}
		case "3 1": {
			const Top = derived("Top", thrice1)
			return schema.extend(
				[Base],
				"judge_size_1",
				[Top],
				[check("Small", Top, (t) => t.le(t.k, 100))]
			)
		}
		case "3 2": {
			const Top = derived("Top", thrice2)
			return schema.extend(
				[Base],
				"judge_size_1",
				[Top],
				[check("Small", Top, (t) => t.le(t.k, 100))]
			)
		}
		case "3 3": {
			const Top = derived("Top", thrice3)
			return schema.extend(
				[Base],
				"judge_size_1",
				[Top],
				[check("Small", Top, (t) => t.le(t.k, 100))]
			)
		}
	}
}

/** The reads of Node's table in `statement`, at any depth: each FROM source that names it. */
const nodeReadsOf = (statement: OperandSelect): number => {
	let reads = 0
	const source = (s: FromSource): void => {
		if (s.kind === "table" && typeof s.table !== "string" && s.table.name === "node") {
			reads += 1
		}
	}
	const item = (i: FromItem): void => {
		if (i.kind === "joins") {
			source(i.first)
			for (const step of i.steps) {
				source(step.source)
			}
			return
		}
		source(i)
	}
	visitSelect(statement, { ...inertVisitor, fromItem: item })
	return reads
}

/**
 * Judges each statement of the chain's whole rule: it reads Node's table as often as the definitions it reads read it,
 * where each join of a definition read more than once is computed once per unit: the leaf, a scan of Node alone, read
 * where each of its readers' `uses` matches stands, by the keys the reads before it bound (cte-policy rule 4), and every
 * level above it once, so `uses` reads of Node whatever the chain's depth; unfolded, a definition read `uses` times at
 * each of `depth` levels reads Node `uses` to the `depth` times.
 */
export const judged = (c: Chain, note: (r: Reached) => void): void => {
	const owned = owning(schemaOf(c))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const statements = judgedStatementsOf(installation)
	assert.ok(statements.length > 0, "the check is judged")
	note(
		c.uses === 1
			? "a definition read once"
			: c.uses === 2
				? "a definition read twice"
				: "a definition read three times"
	)
	if (c.depth >= 3) {
		note("a chain three deep")
	}
	for (const { query: statement } of statements) {
		const reads = nodeReadsOf(statement)
		assert.ok(
			reads <= c.uses,
			`a statement of the chain ${c.depth} deep, each level reading the one below ${c.uses} times, reads Node ${reads} times, where its leaf's readers read it ${c.uses} times`
		)
	}
}

/**
 * One case of the union box: a definition over `width` reads of one union of `arms` rules over Node, each rule the
 * nodes of one kind, every read within one document, the first at the row's own `a` and each later one at the `b` of
 * the one before; and a whole rule over it, a check of its kind. Distributed into its conjunctions, the rule is one
 * conjunction for each choice of a rule at every read, `arms` to the `width`, each reading Node `width` times.
 */
export interface Unions {
	readonly width: 1 | 2 | 3
	readonly arms: 2 | 3
}

export const unionsGen: Gen<Unions> = (s) => ({
	width: s.draw(element<Unions["width"]>([1, 2, 3])),
	arms: s.draw(element<Unions["arms"]>([2, 3]))
})

export type UnionReached =
	| "a union read once"
	| "a union read twice"
	| "a union read three times"
	| "a union of three rules"

/** The nodes of kinds 0 and 1, each with its parent and kind under its own names. */
const either = query(Base)
	.rule((r) => {
		const { doc, start, parent } = v(Node, "n")
		return r.match(Node, { doc, start, parent, kind: 0 }).find({ doc, a: start, b: parent, k: 0 })
	})
	.rule((r) => {
		const { doc, start, parent } = v(Node, "n")
		return r.match(Node, { doc, start, parent, kind: 1 }).find({ doc, a: start, b: parent, k: 1 })
	})

/** The nodes of kinds 0, 1 and 2, each with its parent and kind under its own names. */
const any3 = either.rule((r) => {
	const { doc, start, parent } = v(Node, "n")
	return r.match(Node, { doc, start, parent, kind: 2 }).find({ doc, a: start, b: parent, k: 2 })
})

/** The union box's schema: Base, and the derived relation of `width` reads of the union with a check beside it. */
const unionSchemaOf = (u: Unions): FixtureSchema => {
	const union = u.arms === 2 ? either : any3
	const top = (() => {
		switch (u.width) {
			case 1:
				return query(Base).rule((r) => {
					const { doc, a, b, k } = v(union, "x0")
					return r.match(union, { doc, a, b, k }).find({ doc, a, b, k })
				})
			case 2:
				return query(Base).rule((r) => {
					const { doc, a, b, k } = v(union, "x0")
					const { b: b1 } = v(union, "x1")
					return r
						.match(union, { doc, a, b, k })
						.match(union, { doc, a: b, b: b1 })
						.find({ doc, a, b: b1, k })
				})
			case 3:
				return query(Base).rule((r) => {
					const { doc, a, b, k } = v(union, "x0")
					const { b: b1 } = v(union, "x1")
					const { b: b2 } = v(union, "x2")
					return r
						.match(union, { doc, a, b, k })
						.match(union, { doc, a: b, b: b1 })
						.match(union, { doc, a: b1, b: b2 })
						.find({ doc, a, b: b2, k })
				})
		}
	})()
	const Top = derived("Top", top)
	return schema.extend([Base], "judge_size_1", [Top], [check("Small", Top, (t) => t.le(t.k, 100))])
}

/**
 * Judges each statement of the union box's whole rule: it reads Node `arms` times, once in each rule of the union,
 * which navigation reads whole, one node per unit every read of which joins its rows; distributed into its
 * conjunctions, it read Node `width` times in each of `arms` to the `width` conjunctions.
 */
export const judgedUnions = (u: Unions, note: (r: UnionReached) => void): void => {
	const owned = owning(unionSchemaOf(u))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const statements = judgedStatementsOf(installation)
	assert.ok(statements.length > 0, "the check is judged")
	note(
		u.width === 1
			? "a union read once"
			: u.width === 2
				? "a union read twice"
				: "a union read three times"
	)
	if (u.arms === 3) {
		note("a union of three rules")
	}
	for (const { query: statement } of statements) {
		const reads = nodeReadsOf(statement)
		assert.ok(
			reads <= u.arms,
			`a statement over ${u.width} reads of a union of ${u.arms} rules over Node reads Node ${reads} times, where the union's rules read it ${u.arms} times`
		)
	}
}
