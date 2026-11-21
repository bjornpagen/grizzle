/** What judge-size.test.ts reads: its spaces, its schemas, and the reads of Node of the judge and the full checks. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Formatter } from "effect"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, type Rule, v } from "#compiler/public/query.ts"
import { check, contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
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

/**
 * How `statement` reads the session's deltas, at any depth: the FROM sources that name a table of pg_temp, and those that
 * call a function, a delta's reader (physical/ddl/rules.ts readers) where the judge's statement reads one.
 */
const deltaReadsOf = (
	statement: OperandSelect
): { readonly tables: number; readonly calls: number } => {
	let tables = 0
	let calls = 0
	const source = (s: FromSource): void => {
		if (s.kind === "table" && typeof s.table !== "string" && s.table.schema === "pg_temp") {
			tables += 1
		}
		if (s.kind === "function" && s.call.fn.kind === "qualified") {
			calls += 1
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
	return { tables, calls }
}

/**
 * Every statement of the chain's whole rule reads the session's deltas through their readers, never a table of pg_temp:
 * a plan that reads a delta through its reader depends on the function, so the TRUNCATE the judge empties the delta with
 * once it has read it leaves the plan standing for the next run, where a plan that read the table was made again at
 * every COMMIT after one.
 */
export const readsDeltasThroughReaders = (c: Chain, note: (r: Reached) => void): void => {
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
		const reads = deltaReadsOf(statement)
		assert.equal(
			reads.tables,
			0,
			`a statement of the chain ${c.depth} deep reads a table of pg_temp`
		)
		assert.ok(
			reads.calls > 0,
			`a statement of the chain ${c.depth} deep reads no delta through its reader`
		)
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
export type Unions =
	| { readonly form: "side by side"; readonly width: 1 | 2 | 3; readonly arms: 2 | 3 }
	| { readonly form: "chain"; readonly reads: 1; readonly depth: 1 | 2 | 3 | 4 }
	| { readonly form: "chain"; readonly reads: 2; readonly depth: 1 | 2 | 3 | 4 }

export const unionsGen: Gen<Unions> = (s) =>
	s.draw(element<Unions["form"]>(["side by side", "chain"])) === "side by side"
		? {
				form: "side by side",
				width: s.draw(element<1 | 2 | 3>([1, 2, 3])),
				arms: s.draw(element<2 | 3>([2, 3]))
			}
		: s.draw(element<1 | 2>([1, 2])) === 1
			? { form: "chain", reads: 1, depth: s.draw(element<1 | 2 | 3 | 4>([1, 2, 3, 4])) }
			: { form: "chain", reads: 2, depth: s.draw(element<1 | 2 | 3 | 4>([1, 2, 3, 4])) }

export type UnionReached =
	| "a union read once"
	| "a union read twice"
	| "a union read three times"
	| "a union of three rules"
	| "a chain of unions four deep"
	| "a chain of unions each rule reading the level below twice"

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

/**
 * The chains of unions, each level over the one below (union1 over leaf, union2 over union1, and on): two rules, the
 * nodes of kind 0 and of any other kind, each one read of the level below at the row's own `a`, or, in the chain each
 * rule of which reads the level below twice (twiceUnion1 to twiceUnion4), the first read at the row's own `a` and the
 * second at its `b`, delivering the first's `a` and `k` and the second's `b`. Distributed, each level is two
 * conjunctions over the level below's, or four each reading it twice, so a chain `depth` deep reads Node two to the
 * `depth` times, or four to the `depth`. Each level is its own value, its heading typed by the level it reads.
 */
const union1 = query(Base)
	.rule((r) => {
		const { doc, a, b } = v(leaf, "x0")
		return r.match(leaf, { doc, a, b, k: 0 }).find({ doc, a, b, k: 0 })
	})
	.rule((r) => {
		const { doc, a, b, k } = v(leaf, "x0")
		return r.match(leaf, { doc, a, b, k }).where(r.ne(k, 0)).find({ doc, a, b, k })
	})

const union2 = query(Base)
	.rule((r) => {
		const { doc, a, b } = v(union1, "x0")
		return r.match(union1, { doc, a, b, k: 0 }).find({ doc, a, b, k: 0 })
	})
	.rule((r) => {
		const { doc, a, b, k } = v(union1, "x0")
		return r.match(union1, { doc, a, b, k }).where(r.ne(k, 0)).find({ doc, a, b, k })
	})

const union3 = query(Base)
	.rule((r) => {
		const { doc, a, b } = v(union2, "x0")
		return r.match(union2, { doc, a, b, k: 0 }).find({ doc, a, b, k: 0 })
	})
	.rule((r) => {
		const { doc, a, b, k } = v(union2, "x0")
		return r.match(union2, { doc, a, b, k }).where(r.ne(k, 0)).find({ doc, a, b, k })
	})

const union4 = query(Base)
	.rule((r) => {
		const { doc, a, b } = v(union3, "x0")
		return r.match(union3, { doc, a, b, k: 0 }).find({ doc, a, b, k: 0 })
	})
	.rule((r) => {
		const { doc, a, b, k } = v(union3, "x0")
		return r.match(union3, { doc, a, b, k }).where(r.ne(k, 0)).find({ doc, a, b, k })
	})

const twiceUnion1 = query(Base)
	.rule((r) => {
		const { doc, a, b } = v(leaf, "x0")
		const { b: b1 } = v(leaf, "x1")
		return r
			.match(leaf, { doc, a, b, k: 0 })
			.match(leaf, { doc, a: b, b: b1 })
			.find({ doc, a, b: b1, k: 0 })
	})
	.rule((r) => {
		const { doc, a, b, k } = v(leaf, "x0")
		const { b: b1 } = v(leaf, "x1")
		return r
			.match(leaf, { doc, a, b, k })
			.match(leaf, { doc, a: b, b: b1 })
			.where(r.ne(k, 0))
			.find({ doc, a, b: b1, k })
	})

const twiceUnion2 = query(Base)
	.rule((r) => {
		const { doc, a, b } = v(twiceUnion1, "x0")
		const { b: b1 } = v(twiceUnion1, "x1")
		return r
			.match(twiceUnion1, { doc, a, b, k: 0 })
			.match(twiceUnion1, { doc, a: b, b: b1 })
			.find({ doc, a, b: b1, k: 0 })
	})
	.rule((r) => {
		const { doc, a, b, k } = v(twiceUnion1, "x0")
		const { b: b1 } = v(twiceUnion1, "x1")
		return r
			.match(twiceUnion1, { doc, a, b, k })
			.match(twiceUnion1, { doc, a: b, b: b1 })
			.where(r.ne(k, 0))
			.find({ doc, a, b: b1, k })
	})

const twiceUnion3 = query(Base)
	.rule((r) => {
		const { doc, a, b } = v(twiceUnion2, "x0")
		const { b: b1 } = v(twiceUnion2, "x1")
		return r
			.match(twiceUnion2, { doc, a, b, k: 0 })
			.match(twiceUnion2, { doc, a: b, b: b1 })
			.find({ doc, a, b: b1, k: 0 })
	})
	.rule((r) => {
		const { doc, a, b, k } = v(twiceUnion2, "x0")
		const { b: b1 } = v(twiceUnion2, "x1")
		return r
			.match(twiceUnion2, { doc, a, b, k })
			.match(twiceUnion2, { doc, a: b, b: b1 })
			.where(r.ne(k, 0))
			.find({ doc, a, b: b1, k })
	})

const twiceUnion4 = query(Base)
	.rule((r) => {
		const { doc, a, b } = v(twiceUnion3, "x0")
		const { b: b1 } = v(twiceUnion3, "x1")
		return r
			.match(twiceUnion3, { doc, a, b, k: 0 })
			.match(twiceUnion3, { doc, a: b, b: b1 })
			.find({ doc, a, b: b1, k: 0 })
	})
	.rule((r) => {
		const { doc, a, b, k } = v(twiceUnion3, "x0")
		const { b: b1 } = v(twiceUnion3, "x1")
		return r
			.match(twiceUnion3, { doc, a, b, k })
			.match(twiceUnion3, { doc, a: b, b: b1 })
			.where(r.ne(k, 0))
			.find({ doc, a, b: b1, k })
	})

/** The union box's schema: Base, and the derived relation of the case's union reads with a check beside it. */
const unionSchemaOf = (u: Unions): FixtureSchema => {
	if (u.form === "chain" && u.reads === 2) {
		switch (u.depth) {
			case 1: {
				const Top = derived("Top", twiceUnion1)
				return schema.extend(
					[Base],
					"judge_size_1",
					[Top],
					[check("Small", Top, (t) => t.le(t.k, 100))]
				)
			}
			case 2: {
				const Top = derived("Top", twiceUnion2)
				return schema.extend(
					[Base],
					"judge_size_1",
					[Top],
					[check("Small", Top, (t) => t.le(t.k, 100))]
				)
			}
			case 3: {
				const Top = derived("Top", twiceUnion3)
				return schema.extend(
					[Base],
					"judge_size_1",
					[Top],
					[check("Small", Top, (t) => t.le(t.k, 100))]
				)
			}
			case 4: {
				const Top = derived("Top", twiceUnion4)
				return schema.extend(
					[Base],
					"judge_size_1",
					[Top],
					[check("Small", Top, (t) => t.le(t.k, 100))]
				)
			}
		}
	}
	if (u.form === "chain") {
		switch (u.depth) {
			case 1: {
				const Top = derived("Top", union1)
				return schema.extend(
					[Base],
					"judge_size_1",
					[Top],
					[check("Small", Top, (t) => t.le(t.k, 100))]
				)
			}
			case 2: {
				const Top = derived("Top", union2)
				return schema.extend(
					[Base],
					"judge_size_1",
					[Top],
					[check("Small", Top, (t) => t.le(t.k, 100))]
				)
			}
			case 3: {
				const Top = derived("Top", union3)
				return schema.extend(
					[Base],
					"judge_size_1",
					[Top],
					[check("Small", Top, (t) => t.le(t.k, 100))]
				)
			}
			case 4: {
				const Top = derived("Top", union4)
				return schema.extend(
					[Base],
					"judge_size_1",
					[Top],
					[check("Small", Top, (t) => t.le(t.k, 100))]
				)
			}
		}
	}
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
 * Judges each statement of the union box's whole rule. Over reads side by side, it reads Node `arms` times, once in
 * each rule of the union, which navigation reads whole, one node per unit every read of which joins its rows;
 * distributed into its conjunctions, it read Node `width` times in each of `arms` to the `width` conjunctions. Over a
 * chain, it reads Node at most four times whatever the depth, each of the lowest level's two rules at the two sets of
 * values a level is read at, the unit's channels and the channels with kind 0, which the first rule of the level above
 * fixes: each level is one node per unit at each set of values, which every rule of the level above reads at the
 * unit's channels (check/checker.ts #sharedImport) and the lowering computes once in the unit's region (cte-policy rule
 * 3b); distributed, it read Node two to the depth times, or four to the depth where each rule reads the level below
 * twice.
 */
export const judgedUnions = (u: Unions, note: (r: UnionReached) => void): void => {
	const owned = owning(unionSchemaOf(u))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const statements = judgedStatementsOf(installation)
	assert.ok(statements.length > 0, "the check is judged")
	if (u.form === "chain") {
		if (u.depth === 4) {
			note("a chain of unions four deep")
		}
		if (u.reads === 2) {
			note("a chain of unions each rule reading the level below twice")
		}
		for (const { query: statement } of statements) {
			const reads = nodeReadsOf(statement)
			assert.ok(
				reads <= 4,
				`a statement over a chain of unions ${u.depth} deep, each rule reading the level below ${u.reads} times, reads Node ${reads} times, where the lowest level's two rules read it at two sets of values, four times`
			)
		}
		return
	}
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

/**
 * One case of the box of checks over every row: the chain box's case (`Chain`) or the union box's (`Unions`), its rule
 * the same whole rule over the same definitions.
 */
export type EveryRowCase =
	| { readonly box: "chain"; readonly chain: Chain }
	| { readonly box: "unions"; readonly unions: Unions }

export const everyRowGen: Gen<EveryRowCase> = (s) =>
	s.draw(element<EveryRowCase["box"]>(["chain", "unions"])) === "chain"
		? { box: "chain", chain: chainGen(s) }
		: { box: "unions", unions: unionsGen(s) }

export type EveryRowReached =
	| "a definition read three times"
	| "a chain three deep"
	| "a union read three times"
	| "a union of three rules"
	| "a chain of unions four deep"
	| "a chain of unions each rule reading the level below twice"

/**
 * The reads of Node a statement over `c`'s definitions makes, each definition spelled once: a chain's, the `uses` of
 * its leaf's one reader, whatever its depth; a union read side by side, one in each of its rules, whatever its reads; a
 * chain of unions, four, the lowest level's two rules at the two sets of values a level is read at, whatever its depth
 * (judged, judgedUnions).
 */
const definitionsReadsOf = (c: EveryRowCase): number => {
	if (c.box === "chain") {
		return c.chain.uses
	}
	return c.unions.form === "chain" ? 4 : c.unions.arms
}

/**
 * Checks the full violation query of the case's whole rule, its check over every row (deploy/snapshot/violation.ts
 * lawChecks, physical/ddl/rules.ts everyRowCheck), which the migration that adds the rule runs once: it reads Node as
 * often as the definitions it reads read it, each spelled once (`definitionsReadsOf`), the reads the judge's statements
 * make of them: every rule statement reads each import its unfolding multiplies whole (analysis/theory/navigate.ts
 * ImportSharing `perStatement`), and the check over every row, whose region holds every row, computes one no parameter
 * restricts once (lower/optimize/cte-policy rules 5 and 6). Navigated as a unit's statement once was, before 142269847,
 * each such import was inlined at every read and each union distributed into the rule's conjunctions, the product of
 * the unions' widths at every depth: a chain three deep of three reads per level read Node 27 times, three reads of a
 * union of three rules 81 and a chain of unions three deep each rule reading the level below twice 384 (metis's
 * rehearsal reset: targeted_branch_rule_in_forward_branch_rule's 1.15 MB, 3,571 SELECTs, 157 UNIONs and 1,281 table
 * reads, 20 s planned over empty tables).
 */
export const checkedOverEveryRow = (c: EveryRowCase, note: (r: EveryRowReached) => void): void => {
	const owned = owning(c.box === "chain" ? schemaOf(c.chain) : unionSchemaOf(c.unions))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const checks = lawChecks(installation).rules
	assert.equal(checks.length, 1, "the box's one rule, checked over every row")
	if (c.box === "chain") {
		if (c.chain.uses === 3) {
			note("a definition read three times")
		}
		if (c.chain.depth === 3) {
			note("a chain three deep")
		}
	} else if (c.unions.form === "side by side") {
		if (c.unions.width === 3) {
			note("a union read three times")
		}
		if (c.unions.arms === 3) {
			note("a union of three rules")
		}
	} else {
		if (c.unions.depth === 4) {
			note("a chain of unions four deep")
		}
		if (c.unions.reads === 2) {
			note("a chain of unions each rule reading the level below twice")
		}
	}
	const bound = definitionsReadsOf(c)
	for (const rule of checks) {
		const reads = nodeReadsOf(rule.query)
		assert.ok(
			reads <= bound,
			`${Formatter.format(c)}: the check over every row of ${rule.law} reads Node ${reads} times, where its definitions, each spelled once, read it ${bound} times`
		)
	}
}

/**
 * One case of the containment box: a whole rule From ⊆ To over a union `depth` levels above a union of two rules over
 * Node (`meetLeaf`), From its every fact and To, the side its facts meet, a union of `width` rules each reading it at
 * the fact's terms, and, where `negated`, one rule more that reads it twice and negates a definition over it at the
 * second read's `b`: the shape of the reset line's targeted_branch_rule_in_forward_branch_rule, ForwardBranchRule's
 * two rules each over TargetedBranchRule's definition, one of them negating fixedBackwardRows.
 */
export interface Containment {
	readonly depth: 0 | 1 | 2
	readonly width: 1 | 2 | 3
	readonly negated: boolean
}

export const containmentGen: Gen<Containment> = (s) => ({
	depth: s.draw(element<Containment["depth"]>([0, 1, 2])),
	width: s.draw(element<Containment["width"]>([1, 2, 3])),
	negated: s.draw(element([false, true]))
})

export type ContainmentReached =
	| "a met side of three rules"
	| "a negation inside the met side"
	| "a union two levels above the leaf"

/** The nodes of kind 1, and those whose parent is of kind 2: Node read three times. */
const meetLeaf = query(Base)
	.rule((r) => {
		const { doc, start, parent } = v(Node, "n")
		return r.match(Node, { doc, start, parent, kind: 1 }).find({ doc, a: start, b: parent })
	})
	.rule((r) => {
		const { doc, start, parent, kind } = v(Node, "n")
		return r
			.match(Node, { doc, start, parent, kind })
			.match(Node, { doc, start: parent, kind: 2 })
			.find({ doc, a: start, b: parent })
	})

/**
 * The levels over the leaf (meetAbove1 over meetLeaf, meetAbove2 over meetAbove1): two rules, a walk of two of the level
 * below's rows, the second at the first's `b`, and its rows as they are. Each level is its own value, its heading typed
 * by the level it reads.
 */
const meetAbove1 = query(Base)
	.rule((r) => {
		const { doc, a, b } = v(meetLeaf, "x")
		const { b: b1 } = v(meetLeaf, "y")
		return r
			.match(meetLeaf, { doc, a, b })
			.match(meetLeaf, { doc, a: b, b: b1 })
			.find({ doc, a, b: b1 })
	})
	.rule((r) => {
		const { doc, a, b } = v(meetLeaf, "x")
		return r.match(meetLeaf, { doc, a, b }).find({ doc, a, b })
	})

const meetAbove2 = query(Base)
	.rule((r) => {
		const { doc, a, b } = v(meetAbove1, "x")
		const { b: b1 } = v(meetAbove1, "y")
		return r
			.match(meetAbove1, { doc, a, b })
			.match(meetAbove1, { doc, a: b, b: b1 })
			.find({ doc, a, b: b1 })
	})
	.rule((r) => {
		const { doc, a, b } = v(meetAbove1, "x")
		return r.match(meetAbove1, { doc, a, b }).find({ doc, a, b })
	})

/** A level the containment's sides read: the leaf or a level above it. */
type MeetLevel = typeof meetLeaf | typeof meetAbove1 | typeof meetAbove2

const meetLevels = [meetLeaf, meetAbove1, meetAbove2] as const

/** A rule of To reading the level at the fact's terms where the level's `b` is at least its `a`. */
const metAt = (level: MeetLevel) => (r: Rule<typeof Base>) => {
	const { doc, a, b } = v(level, "t0")
	return r.match(level, { doc, a, b }).where(r.ge(b, a)).find({ doc, a })
}

/** A rule of To reading the level at the fact's terms beside a node of kind `kind` at the level's `b`. */
const metBeside = (level: MeetLevel, kind: number) => (r: Rule<typeof Base>) => {
	const { doc, a, b } = v(level, "t")
	return r.match(level, { doc, a, b }).match(Node, { doc, start: b, kind }).find({ doc, a })
}

/**
 * The rule of To that reads the level twice, the second read at the first's `b`, and negates `lower`, a definition over
 * the level, at the second read's `b`.
 */
const metNegating =
	(level: MeetLevel, lower: ReturnType<typeof lowerOf>) => (r: Rule<typeof Base>) => {
		const { doc, a, b } = v(level, "s0")
		const { b: c1 } = v(level, "s1")
		return r
			.match(level, { doc, a, b })
			.match(level, { doc, a: b, b: c1 })
			.where(r.not(lower, { doc, a: c1 }))
			.find({ doc, a })
	}

/** The level's rows whose `b` is below their `a`, by `doc` and `a`: what the negating rule of To negates. */
const lowerOf = (level: MeetLevel) =>
	query(Base).rule((r) => {
		const { doc, a, b } = v(level, "w")
		return r.match(level, { doc, a, b }).where(r.lt(b, a)).find({ doc, a })
	})

/** To over the case's level: its first rule, `width - 1` rules beside a node, and the negating rule where `negated`. */
const metSideOf = (c: Containment, level: MeetLevel) => {
	const negating = metNegating(level, lowerOf(level))
	const one = query(Base).rule(metAt(level))
	switch (`${c.width} ${c.negated}` as const) {
		case "1 false":
			return one
		case "1 true":
			return one.rule(negating)
		case "2 false":
			return one.rule(metBeside(level, 3))
		case "2 true":
			return one.rule(metBeside(level, 3)).rule(negating)
		case "3 false":
			return one.rule(metBeside(level, 3)).rule(metBeside(level, 4))
		case "3 true":
			return one.rule(metBeside(level, 3)).rule(metBeside(level, 4)).rule(negating)
	}
}

/** The containment box's schema: Base, From and To over the case's level, and the containment From ⊆ To. */
const containmentSchemaOf = (c: Containment): FixtureSchema => {
	const level = meetLevels[c.depth]
	const From = derived(
		"From",
		query(Base).rule((r) => {
			const { doc, a, b } = v(level, "f")
			return r.match(level, { doc, a, b }).find({ doc, a, b })
		})
	)
	const To = derived("To", metSideOf(c, level))
	return schema.extend(
		[Base],
		"judge_size_1",
		[From, To],
		[contained(on(From, "doc", "a"), on(To, "doc", "a"))]
	)
}

/**
 * The reads of Node the containment's statement makes, each restriction of the leaf union spelled once: three, its
 * reads, for each set of values the statement reads the leaf at, the unit's, the fact's (`doc` and `a`, at which every
 * rule of To reads the level), and, with the negation, the negated definition's (the unit's and the second read's
 * `b`); and one for each rule of To past the first, its read of Node beside the level. Whatever the depth: each level
 * reads the one below at its own values or at the unit's alone, both already read.
 */
const containmentReadsOf = (c: Containment): number => 3 * (c.negated ? 3 : 2) + (c.width - 1)

/**
 * Judges each statement of the containment's whole rule: it reads Node as often as the leaf's restrictions read it,
 * each spelled once (`containmentReadsOf`). The definitions both sides read at the unit's channels are one node, bound
 * at the outermost region that re-exposes the channel (check/checker.ts #outermost), read under one name at every depth
 * (analysis/theory/navigate.ts `received`), and computed once in that region, whose filters' tests read it in the
 * filter's SELECT (lower/shapes/index.ts filteredRegion); those To's rules read at the fact's terms are one node, every
 * rule of To reading it, a filter passing a term the rule fixes as that term (navigate.ts `pinnedBy`). Before, each read
 * inside the negation of To was a node of its own region, spelled at every read: the reset line's
 * targeted_branch_rule_in_forward_branch_rule, 465 KB with a definition at the package spelled 3, 4, 7 and 18 times,
 * planned in 12.1 s at a fresh backend's first COMMIT.
 */
export const judgedContainment = (c: Containment, note: (r: ContainmentReached) => void): void => {
	const owned = owning(containmentSchemaOf(c))
	const installation = succeeded(compileInstallation(owned, installOptions(owned)))
	const statements = judgedStatementsOf(installation)
	assert.ok(statements.length > 0, "the containment is judged")
	if (c.width === 3) {
		note("a met side of three rules")
	}
	if (c.negated) {
		note("a negation inside the met side")
	}
	if (c.depth === 2) {
		note("a union two levels above the leaf")
	}
	const bound = containmentReadsOf(c)
	for (const { query: statement } of statements) {
		const reads = nodeReadsOf(statement)
		assert.ok(
			reads <= bound,
			`${Formatter.format(c)}: a statement of the containment reads Node ${reads} times, where the leaf's restrictions, each spelled once, read it ${bound} times`
		)
	}
}
