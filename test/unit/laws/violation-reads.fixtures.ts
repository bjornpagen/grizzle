/** What the properties of violation-reads.test.ts read: its spaces, models and helpers. */

import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { Step } from "#compiler/deploy/diff/plan.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	contained,
	derived,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import type { OperandBody, OperandSelect, SelectCore, TableName } from "#compiler/sql/ast.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import type { Relation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"

const A = relation("A", { id: pg.integer, k: pg.integer, a: pg.integer }, ["id"])

const B = relation("B", { id: pg.integer, k: pg.integer, b: pg.integer }, ["id"])

const T = relation("T", { a: pg.integer, b: pg.integer }, ["a", "b"])

const Tier = closed.ordered("Tier", ["low", "high"])

const TierRank = closed.relation(
	"TierRank",
	{ tier: closedId(Tier), rank: pg.integer },
	["tier"],
	[
		{ tier: "low", rank: 1 },
		{ tier: "high", rank: 2 }
	]
)

const TierNext = closed.relation(
	"TierNext",
	{ tier: closedId(Tier), next: closedId(Tier) },
	["tier"],
	[{ tier: "low", next: "high" }]
)

const sources = ["selected", "joined", "view", "nested", "nested view"] as const

interface Case {
	readonly source: (typeof sources)[number]
	readonly negated: boolean
}

export const caseGen: Gen<Case> = (s) => ({
	source: s.draw(element(sources)),
	negated: s.draw(boolean)
})

/**
 * The case's schema: A, B and T, and the closed relations TierRank and TierNext with a containment between them alone,
 * at the root; J and V over it at a middle level; and M, JJ and VV, which read J and V, with the case's rule above.
 */
export const schemaOf = (c: Case): AnySchema => {
	const Base = schema(
		"Base",
		[A, B, T, Tier, TierRank, TierNext],
		[contained(on(TierNext, "next"), on(TierRank, "tier"))]
	)
	const definition = query(Base).rule((r) => {
		const { k, a } = v(A, "a")
		const { b } = v(B, "b")
		return r.match(A, { k, a }).match(B, { k, b }).find({ k, a, b })
	})
	const J = derived("J", definition)
	const V = derived.materialized("V", definition)
	const Mid = schema.extend(Base, "Mid", [J, V], [])
	const JJ = derived(
		"JJ",
		query(Mid).rule((r) => {
			const { k, a, b } = v(J, "j")
			return r.match(J, { k, a, b }).match(T, { a, b }).find({ k, a, b })
		})
	)
	const VV = derived(
		"VV",
		query(Mid).rule((r) => {
			const { k, a, b } = v(V, "v")
			return r.match(V, { k, a, b }).match(T, { a, b }).find({ k, a, b })
		})
	)
	const paired = query(Base).rule((r) => {
		const { k, b } = v(B, "b")
		return r.match(B, { k, b }).match(T, { a: b }).find({ k, b })
	})
	const M = derived(
		"M",
		c.negated
			? paired.rule((r) => {
					const { k, b } = v(B, "b")
					return r
						.match(B, { k, b })
						.where(r.not(T, { a: b }))
						.find({ k, b })
				})
			: paired
	)
	switch (c.source) {
		case "selected":
			return schema.extend(
				Mid,
				"Upper",
				[M],
				[
					contained(
						on(
							select(A, (x) => x.ne(x.a, 0)),
							"k",
							"a"
						),
						on(M, "k", "b")
					)
				]
			)
		case "joined":
			return schema.extend(Mid, "Upper", [M], [contained(on(J, "k", "b"), on(M, "k", "b"))])
		case "view":
			return schema.extend(Mid, "Upper", [M], [contained(on(V, "k", "b"), on(M, "k", "b"))])
		case "nested":
			return schema.extend(Mid, "Upper", [JJ, M], [contained(on(JJ, "k", "b"), on(M, "k", "b"))])
		case "nested view":
			return schema.extend(Mid, "Upper", [VV, M], [contained(on(VV, "k", "b"), on(M, "k", "b"))])
	}
}

/** A table a core reads, and how that core delivers its rows: plainly under its proof, or through DISTINCT. */
interface TableRead {
	readonly table: string
	readonly read: "keyed" | "distinct" | "other"
}

/** A table's name as one text: a stored table's or a view's schema and name, or a carrier's name. */
export const tableKey = (t: TableName): string =>
	typeof t === "string" ? t : `${t.schema}.${t.name}`

/** How a core delivers the rows of the tables it reads. */
const readOf = (core: SelectCore): TableRead["read"] =>
	core.distinct === true
		? "distinct"
		: core.distinct === false && core.rows === "keyed"
			? "keyed"
			: "other"

/** The tables a core's FROM names, each with how the core reads it. */
const coreReads = (core: SelectCore): ReadonlyArray<TableRead> =>
	Arr.flatMap(core.from, (item) =>
		Arr.flatMap(
			item.kind === "joins" ? [item.first, ...Arr.map(item.steps, (s) => s.source)] : [item],
			(source): ReadonlyArray<TableRead> =>
				source.kind === "table" ? [{ table: tableKey(source.table), read: readOf(core) }] : []
		)
	)

/** Every core of a body: itself, a set operation's arms, a parenthesized query's body. */
const bodyCores = (body: OperandBody): ReadonlyArray<SelectCore> => {
	switch (body.kind) {
		case "core":
			return [body]
		case "setOp":
			return Arr.flatMap(body.arms, (arm) => bodyCores(arm.kind === "core" ? arm : arm.body))
		case "select":
			return bodyCores(body.body)
	}
}

/** A query and every query it holds, wherever it stands: a derived table, a sublink or a CTE. */
const queriesOf = (query: OperandSelect): ReadonlyArray<OperandSelect> => {
	const queries: Array<OperandSelect> = [query]
	visitSelect(query, {
		...inertVisitor,
		fromItem: (item) => {
			if (item.kind === "derived") {
				queries.push(item.query)
			}
		},
		expr: (e) => {
			if (e.kind === "exists" || e.kind === "subquery") {
				queries.push(e.query)
			}
		},
		with: (w) => {
			for (const cte of w.ctes) {
				if (cte.query.kind === "select") {
					queries.push(cte.query)
				}
			}
		}
	})
	return queries
}

/** Every table a query reads, wherever it stands: its body, a derived table, a sublink or a CTE. */
export const tableReads = (query: OperandSelect): ReadonlyArray<TableRead> =>
	Arr.flatMap(queriesOf(query), (q) => Arr.flatMap(bodyCores(q.body), coreReads))

/**
 * The negations of a query: each EXCEPT, the containment's own set difference (lower/conservative/anti-join
 * exceptOf), and each NOT EXISTS sublink, one for each negated arm.
 */
export const negations = (query: OperandSelect): number => {
	let sublinks = 0
	visitSelect(query, {
		...inertVisitor,
		expr: (e) => {
			if (e.kind === "exists" && e.not) {
				sublinks += 1
			}
		}
	})
	return (
		sublinks +
		Arr.filter(queriesOf(query), (q) => q.body.kind === "setOp" && q.body.op === "EXCEPT").length
	)
}

const keyChanges = ["kept", "widened", "moved"] as const

interface MigrationCase {
	readonly key: (typeof keyChanges)[number]
	readonly negated: boolean
}

export const migrationCaseGen: Gen<MigrationCase> = (s) => ({
	key: s.draw(element(keyChanges)),
	negated: s.draw(boolean)
})

/** The migration case's two versions: A, B and T without a rule; then `target`, A over the case's key, and the rule of
 * J into M. */
const versionsOver = <K extends ReadonlyArray<"id" | "k" | "a">>(
	target: Relation<"A", typeof A.fields, K>,
	negated: boolean
): readonly [AnySchema, AnySchema] => {
	const Base = schema("Base", [target, B, T], [])
	const J = derived(
		"J",
		query(Base).rule((r) => {
			const { k, a } = v(target, "a")
			const { b } = v(B, "b")
			return r.match(target, { k, a }).match(B, { k, b }).find({ k, a, b })
		})
	)
	const paired = query(Base).rule((r) => {
		const { k, b } = v(B, "b")
		return r.match(B, { k, b }).match(T, { a: b }).find({ k, b })
	})
	const M = derived(
		"M",
		negated
			? paired.rule((r) => {
					const { k, b } = v(B, "b")
					return r
						.match(B, { k, b })
						.where(r.not(T, { a: b }))
						.find({ k, b })
				})
			: paired
	)
	return [
		schema("Base", [A, B, T], []),
		schema.extend(Base, "Upper", [J, M], [contained(on(J, "k", "b"), on(M, "k", "b"))])
	]
}

/** The migration case's two versions, A's key kept, widened from (id) to (id, k), or moved to (k, a). */
export const versionsOf = (c: MigrationCase): readonly [AnySchema, AnySchema] => {
	switch (c.key) {
		case "kept":
			return versionsOver(A, c.negated)
		case "widened":
			return versionsOver(
				relation("A", { id: pg.integer, k: pg.integer, a: pg.integer }, ["id", "k"]),
				c.negated
			)
		case "moved":
			return versionsOver(
				relation("A", { id: pg.integer, k: pg.integer, a: pg.integer }, ["k", "a"]),
				c.negated
			)
	}
}

/** The tables a step attaches a primary key to: its CREATE TABLE's, or an ALTER TABLE adding one or attaching one to an
 * index. */
export const keyedBy = (step: Step): ReadonlyArray<string> => {
	const d = step.draft
	if (d.kind !== "statement") {
		return []
	}
	const st = d.statement
	if (st.kind === "createTable") {
		return [tableKey(st.table)]
	}
	if (st.kind !== "alterTable") {
		return []
	}
	return Arr.some(
		st.actions,
		(a) =>
			(a.kind === "addConstraintUsingIndex" && a.constraint === "PRIMARY KEY") ||
			(a.kind === "addConstraint" && a.constraint.kind === "primaryKey")
	)
		? [tableKey(st.table)]
		: []
}

/**
 * Whether a step's statement takes a lock that blocks a read of the table it names, ACCESS EXCLUSIVE, as PostgreSQL
 * documents each command's lock (the SQL reference's ALTER TABLE, DROP, CREATE and LOCK): every ALTER TABLE action but
 * VALIDATE CONSTRAINT (SHARE UPDATE EXCLUSIVE) and ADD FOREIGN KEY (SHARE ROW EXCLUSIVE); a DROP INDEX not
 * CONCURRENTLY; a DROP TRIGGER; a rename but an index's (SHARE UPDATE EXCLUSIVE); any DROP of a relation; a view
 * created or replaced; and a LOCK TABLE in ACCESS EXCLUSIVE MODE. A trigger's creation (SHARE ROW EXCLUSIVE), an index's
 * (SHARE, or SHARE UPDATE EXCLUSIVE concurrently), a function's and a grant take none that does.
 */
export const blocksReads = (d: Step["draft"]): boolean => {
	if (d.kind !== "statement") {
		return false
	}
	const st = d.statement
	if (st.kind === "alterTable") {
		return Arr.some(
			st.actions,
			(a) =>
				a.kind !== "validateConstraint" &&
				!(a.kind === "addConstraint" && a.constraint.kind === "foreignKey")
		)
	}
	if (st.kind === "dropIndex") {
		return !st.concurrently
	}
	if (st.kind === "rename") {
		return st.object !== "INDEX"
	}
	if (st.kind === "lockTable") {
		return st.mode === "ACCESS EXCLUSIVE"
	}
	return (
		st.kind === "dropTrigger" ||
		st.kind === "drop" ||
		st.kind === "renameColumn" ||
		st.kind === "renameConstraint" ||
		st.kind === "createView" ||
		st.kind === "createMaterializedView"
	)
}

/** The tables a step builds a unique index on, which a key attaches to (deploy/diff/diff.ts buildConcurrently): its
 * CREATE UNIQUE INDEX's. */
export const uniquelyIndexedBy = (step: Step): ReadonlyArray<string> => {
	const d = step.draft
	return d.kind === "statement" && d.statement.kind === "createIndex" && d.statement.unique
		? [tableKey(d.statement.table)]
		: []
}

/** The most FROM items one core of a query joins, a join chain's each counted, wherever the core stands. */
export const widestJoin = (query: OperandSelect): number => {
	const queries: Array<OperandSelect> = [query]
	visitSelect(query, {
		...inertVisitor,
		fromItem: (item) => {
			if (item.kind === "derived") {
				queries.push(item.query)
			}
		},
		expr: (e) => {
			if (e.kind === "exists" || e.kind === "subquery") {
				queries.push(e.query)
			}
		}
	})
	return Arr.reduce(
		Arr.flatMap(queries, (q) =>
			Arr.map(bodyCores(q.body), (core) =>
				Arr.reduce(
					core.from,
					0,
					(n, item) => n + (item.kind === "joins" ? 1 + item.steps.length : 1)
				)
			)
		),
		0,
		(most, width) => (width > most ? width : most)
	)
}

/** The most matches one rule of the box's definitions joins: J's and V's A ⋈ B, JJ's and VV's J ⋈ T, M's B ⋈ T. */
export const widestRule = 2

export type MigrationFeature =
	| "a key kept"
	| "a key's index built before the check, attached after it"
	| "a check in a transaction no lock blocking a read precedes"
	| "a negated arm"

export type Feature =
	| "a stored table read plainly"
	| "a negated arm"
	| "a definition reading a definition"
	| "a join"
	| "a migration check"
