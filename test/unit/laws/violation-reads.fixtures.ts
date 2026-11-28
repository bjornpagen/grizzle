/** What the properties of violation-reads.test.ts read: its spaces, models and helpers. */

import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { Step } from "#compiler/deploy/diff/plan.ts"
import { closedId, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	closed,
	contained,
	derived,
	key,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import type {
	FromSource,
	ObjectName,
	OperandBody,
	OperandSelect,
	SelectCore
} from "#compiler/sql/ast.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import type { Relation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"

const A = relation("A", { id: int4, k: int4, a: int4 }, ["id"])

const B = relation("B", { id: int4, k: int4, b: int4 }, ["id"])

const T = relation("T", { a: int4, b: int4 }, ["a", "b"])

const Tier = closed.ordered("Tier", ["low", "high"])

const TierRank = closed.relation(
	"TierRank",
	{ tier: closedId(Tier), rank: int4 },
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

const sources = ["selected", "joined", "nested"] as const

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
 * at the root; J over it at a middle level; and M and JJ, which reads J, with the case's rule above.
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
	const Mid = schema.extend([Base], "Mid", [J], [])
	const JJ = derived(
		"JJ",
		query(Mid).rule((r) => {
			const { k, a, b } = v(J, "j")
			return r.match(J, { k, a, b }).match(T, { a, b }).find({ k, a, b })
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
				[Mid],
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
			return schema.extend([Mid], "Upper", [M], [contained(on(J, "k", "b"), on(M, "k", "b"))])
		case "nested":
			return schema.extend([Mid], "Upper", [JJ, M], [contained(on(JJ, "k", "b"), on(M, "k", "b"))])
	}
}

/** A table's name as one text: a stored table's schema and name, or a carrier's name. */
export const tableKey = (t: ObjectName): string =>
	typeof t === "string" ? t : `${t.schema}.${t.name}`

/** The sources of a core's FROM, in order, a join chain's each in its place. */
const sourcesOf = (core: SelectCore): ReadonlyArray<FromSource> =>
	Arr.flatMap(core.from, (item) =>
		item.kind === "joins" ? [item.first, ...Arr.map(item.steps, (s) => s.source)] : [item]
	)

/** The tables a core's FROM names. */
const coreReads = (core: SelectCore): ReadonlyArray<string> =>
	Arr.flatMap(sourcesOf(core), (source) =>
		source.kind === "table" ? [tableKey(source.table)] : []
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
export const tableReads = (query: OperandSelect): ReadonlyArray<string> =>
	Arr.flatMap(queriesOf(query), (q) => Arr.flatMap(bodyCores(q.body), coreReads))

/** The negations of a query: each NOT EXISTS sublink, one for each negated arm it reads. */
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
	return sublinks
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
		schema.extend([Base], "Upper", [J, M], [contained(on(J, "k", "b"), on(M, "k", "b"))])
	]
}

/** The migration case's two versions, A's key kept, widened from (id) to (id, k), or moved to (k, a). */
export const versionsOf = (c: MigrationCase): readonly [AnySchema, AnySchema] => {
	switch (c.key) {
		case "kept":
			return versionsOver(A, c.negated)
		case "widened":
			return versionsOver(relation("A", { id: int4, k: int4, a: int4 }, ["id", "k"]), c.negated)
		case "moved":
			return versionsOver(relation("A", { id: int4, k: int4, a: int4 }, ["k", "a"]), c.negated)
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
		st.kind === "createStoredTable"
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

/**
 * Whether a FROM source reads only relations the statement computes itself, its CTEs: a CTE's name, or a derived table
 * every core of which reads CTEs alone.
 */
const readsComputed = (source: FromSource): boolean =>
	source.kind === "cte" ||
	(source.kind === "derived" &&
		Arr.every(bodyCores(source.query.body), (core) => Arr.every(sourcesOf(core), readsComputed)))

/**
 * The cores of a query, wherever they stand, that join a source to the ones before it uncorrelated: a FROM source after
 * the first that is no LATERAL derived table or function and reads a stored table, whose rows PostgreSQL joins to the
 * others' by its estimates of both. A chain of steps (analysis/theory/navigate.ts) joins none: every step after the
 * first reads LATERAL, a lookup by what the steps before it bound. A read of a relation the statement computes once
 * per unit, a CTE (lower/optimize/cte-policy rule 3b), is no lookup by key, which no index of it serves: PostgreSQL
 * joins its rows to the others' by a hash or a loop alike, the unit's rows alone.
 */
export const looseJoins = (query: OperandSelect): number =>
	Arr.filter(
		Arr.flatMap(queriesOf(query), (q) => bodyCores(q.body)),
		(core) =>
			Arr.some(
				sourcesOf(core).slice(1),
				(source) =>
					!((source.kind === "derived" || source.kind === "function") && source.lateral) &&
					!readsComputed(source)
			)
	).length

/** Every FROM alias a query defines, at any depth: its cores', its derived tables', its sublinks' and its CTEs'. */
const aliasesOf = (query: OperandSelect): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(queriesOf(query), (q) =>
			Arr.flatMap(bodyCores(q.body), (core) =>
				Arr.flatMap(sourcesOf(core), (source) =>
					"alias" in source && typeof source.alias === "string" ? [source.alias] : []
				)
			)
		)
	)

/** The tables of every column a query reads, at any depth. */
const columnTables = (query: OperandSelect): ReadonlySet<string> => {
	const tables = new Set<string>()
	visitSelect(query, {
		...inertVisitor,
		expr: (e) => {
			if (e.kind === "column" && e.table !== undefined) {
				tables.add(e.table)
			}
		}
	})
	return tables
}

/** Whether a query is a step of a chain (analysis/theory/navigate.ts): a subquery fenced by OFFSET 0. */
const isStep = (query: OperandSelect): boolean =>
	query.offset?.kind === "literal" &&
	query.offset.value.kind === "int" &&
	query.offset.value.value === 0n

/**
 * The steps of a query read once for each row of a source outside them: every step inside a LATERAL derived table or a
 * sublink, which PostgreSQL evaluates again for each row the query around it holds.
 */
const perRowSteps = (query: OperandSelect): ReadonlySet<OperandSelect> => {
	const roots: Array<OperandSelect> = []
	visitSelect(query, {
		...inertVisitor,
		fromItem: (item) => {
			if (item.kind === "derived" && item.lateral) {
				roots.push(item.query)
			}
		},
		expr: (e) => {
			if (e.kind === "exists" || e.kind === "subquery") {
				roots.push(e.query)
			}
		}
	})
	const steps = new Set<OperandSelect>()
	for (const root of roots) {
		if (isStep(root)) {
			steps.add(root)
		}
		visitSelect(root, {
			...inertVisitor,
			fromItem: (item) => {
				if (item.kind === "derived" && isStep(item.query)) {
					steps.add(item.query)
				}
			}
		})
	}
	return steps
}

/**
 * The steps of a query read once per row of a source outside them (`perRowSteps`) that read a stored table of `stored`
 * yet no column of a source outside them: a lookup no value before it bounds, which reads every row of its table once
 * for each row around it, as known_operand_base_key's aggregate read every expression once per unit where its groups
 * were bound to the unit outside the aggregate's chain.
 */
export const unboundSteps = (query: OperandSelect, stored: ReadonlySet<string>): number =>
	Arr.filter(
		Arr.fromIterable(perRowSteps(query)),
		(step) =>
			Arr.some(tableReads(step), (t) => stored.has(t)) &&
			!Arr.some(Arr.fromIterable(columnTables(step)), (t) => !aliasesOf(step).has(t))
	).length

/** Whether `query` holds a core that groups its rows (GROUP BY), at any depth: an aggregate. */
const aggregates = (query: OperandSelect): boolean =>
	Arr.some(queriesOf(query), (q) => Arr.some(bodyCores(q.body), (core) => core.groupBy.length > 0))

/**
 * The cores of a query read once per row of a source outside them (inside a LATERAL derived table or a sublink, as
 * `perRowSteps` finds them) that read an aggregate (`aggregates`) beside a source before it in their FROM: each row of
 * that source computes the aggregate's import again, at each row around the core. Navigated at the bindings of the
 * match that reads it (analysis/theory/navigate.ts boundInside), an aggregate's import is read at the unit of its
 * region's row, its groups that unit's alone; navigated apart from them, a judged statement computed it over the key
 * set of every unit the transaction wrote at each row of its region, then kept the row's unit: U units' imports at each
 * of U rows where one each suffices, its every step still a lookup by what the steps before it bound.
 */
export const aggregatesBeside = (query: OperandSelect): number => {
	const roots: Array<OperandSelect> = []
	visitSelect(query, {
		...inertVisitor,
		fromItem: (item) => {
			if (item.kind === "derived" && item.lateral) {
				roots.push(item.query)
			}
		},
		expr: (e) => {
			if (e.kind === "exists" || e.kind === "subquery") {
				roots.push(e.query)
			}
		}
	})
	const cores = new Set(
		Arr.flatMap(roots, (root) => Arr.flatMap(queriesOf(root), (q) => bodyCores(q.body)))
	)
	return Arr.filter([...cores], (core) =>
		Arr.some(
			sourcesOf(core).slice(1),
			(source) => source.kind === "derived" && aggregates(source.query)
		)
	).length
}

export type MigrationFeature =
	| "a key kept"
	| "a key's index built before the check, attached after it"
	| "a check in a transaction no lock blocking a read precedes"
	| "a negated arm"

export type Feature =
	| "a stored table read"
	| "a negated arm"
	| "a definition reading a definition"
	| "a join"
	| "a migration check"

/**
 * The unit-local box: Op(doc, at, base) and Item(doc, at, kind, parent), immutable and keyed by their document first,
 * so every rule over them is whole, judged and checked per document; Known, each op beside its item's kind and its
 * parent's, a join of three reads of the two; and over it, a key of its document, kind and base, a count of Known's
 * facts per key, an aggregate whose import is that join, or a check of its base, a rule over the join itself.
 */
const Op = relation("Op", { doc: int4, at: int4, base: int4 }, ["doc", "at"])

const Item = relation("Item", { doc: int4, at: int4, kind: int4, parent: int4 }, ["doc", "at"])

const unitLaws = ["key", "check", "contained", "union contained", "contained once"] as const

export interface UnitCase {
	readonly law: (typeof unitLaws)[number]
}

export const unitCaseGen: Gen<UnitCase> = (s) => ({ law: s.draw(element(unitLaws)) })

export type UnitFeature =
	| "a key's count over a join"
	| "a check over a join"
	| "a join contained in a union of joins"
	| "a union contained in a union of joins"
	| "a join contained in a join read once"
	| "a judged statement"

/** The situation a case of the unit-local box reaches by its law alone. */
export const unitFeatureOf = (c: UnitCase): UnitFeature => {
	switch (c.law) {
		case "key":
			return "a key's count over a join"
		case "check":
			return "a check over a join"
		case "contained":
			return "a join contained in a union of joins"
		case "union contained":
			return "a union contained in a union of joins"
		case "contained once":
			return "a join contained in a join read once"
	}
}

/** The unit-local box's schema for `c`. */
export const unitSchemaOf = (c: UnitCase): AnySchema => {
	const Base = schema("UnitBox", [Op, Item], [])
	const Known = derived(
		"Known",
		query(Base).rule((r) => {
			const { doc, at, base } = v(Op, "o")
			const { kind, parent } = v(Item, "i")
			const { kind: parentKind } = v(Item, "p")
			return r
				.match(Op, { doc, at, base })
				.match(Item, { doc, at, kind, parent })
				.match(Item, { doc, at: parent, kind: parentKind })
				.find({ doc, at, base, kind, parentKind })
		})
	)
	switch (c.law) {
		case "key":
			return schema.extend([Base], "UnitBox_1", [Known], [key(on(Known, "doc", "kind", "base"))])
		case "check":
			return schema.extend(
				[Base],
				"UnitBox_1",
				[Known],
				[check("C", Known, (k) => k.ne(k.base, 9))]
			)
		case "contained":
		case "union contained":
		case "contained once": {
			const ops = query(Base).rule((r) => {
				const { doc, at, base } = v(Op, "o")
				const { parent } = v(Item, "i")
				const { kind } = v(Item, "p")
				return r
					.match(Op, { doc, at, base })
					.match(Item, { doc, at, parent })
					.match(Item, { doc, at: parent, kind })
					.find({ doc, at, base, parent, kind })
			})
			const Two = derived(
				"Two",
				query(Base)
					.rule((r) => {
						const { doc, at, base, parent, kind } = v(ops, "first")
						const { at: other, base: otherBase } = v(ops, "second")
						return r
							.match(ops, { doc, at, base, parent, kind })
							.match(ops, { doc, at: other, base: otherBase, parent })
							.where(r.ne(base, otherBase), r.eq(kind, 1))
							.find({ doc, at: parent, kind })
					})
					.rule((r) => {
						const { doc, parent, kind } = v(ops, "o")
						return r
							.match(ops, { doc, base: 0, parent, kind })
							.where(r.in(kind, [1, 2]))
							.find({ doc, at: parent, kind })
					})
			)
			const either = query(Base)
				.rule((r) => {
					const { doc, at } = v(Op, "o")
					return r.match(Op, { doc, at, base: 7 }).find({ doc, at })
				})
				.rule((r) => {
					const { doc, at } = v(Item, "i")
					return r.match(Item, { doc, at, kind: 3 }).find({ doc, at })
				})
			const Either = derived(
				"Either",
				query(Base).rule((r) => {
					const { doc, at } = v(either, "e")
					return r.match(either, { doc, at }).find({ doc, at })
				})
			)
			const target = on(
				select(Two, (t) => t.eq(t.kind, 1)),
				"doc",
				"at"
			)
			if (c.law === "contained once") {
				/**
				 * One, ops read once at kind 1: navigation inlines it at the selection's one read of One, so the selection's
				 * `kind = 1` meets One's own, where Two's first rule reads ops twice and holds its rows whole, its kind the
				 * read's own.
				 */
				const One = derived(
					"One",
					query(Base).rule((r) => {
						const { doc, at, base, parent, kind } = v(ops, "o")
						return r
							.match(ops, { doc, at, base, parent, kind })
							.where(r.eq(kind, 1))
							.find({ doc, at: parent, kind })
					})
				)
				return schema.extend(
					[Base],
					"UnitBox_1",
					[Known, One],
					[
						contained(
							on(
								select(Known, (k) => k.and([k.eq(k.base, 7), k.ne(k.kind, 3)])),
								"doc",
								"at"
							),
							on(
								select(One, (t) => t.eq(t.kind, 1)),
								"doc",
								"at"
							)
						)
					]
				)
			}
			return c.law === "contained"
				? schema.extend(
						[Base],
						"UnitBox_1",
						[Known, Two],
						[
							contained(
								on(
									select(Known, (k) => k.and([k.eq(k.base, 7), k.ne(k.kind, 3)])),
									"doc",
									"at"
								),
								target
							)
						]
					)
				: schema.extend(
						[Base],
						"UnitBox_1",
						[Two, Either],
						[contained(on(Either, "doc", "at"), target)]
					)
		}
	}
}

/** A rare mark at an item: a few of the items, keyed as they are. */
const Rare = relation("Rare", { doc: int4, at: int4, mark: int4, note: int4 }, ["doc", "at"])

const orderFirsts = ["Item", "Rare"] as const

/**
 * What the ordering box's schema states of Rare into Item: nothing; Rare at (doc, at) contained in Item at its key,
 * over every row; the same over the rows of a selection of Rare alone; or Rare at (doc, mark), fields the rule binds to
 * no variable of Item's.
 */
const orderContainments = ["none", "every row", "a selection", "other fields"] as const

/**
 * How Marked's rule reads Item: every row of it, by fresh variables; at a parent literal, beside Rare at a note
 * literal, so both reads stay alike; or every row beside a condition of its kind alone.
 */
const orderItems = ["every row", "a literal", "a condition"] as const

/**
 * The ordering box: which of Item and Rare Marked's rule matches first, what the schema states of Rare into Item, and
 * how the rule reads Item.
 */
export interface OrderCase {
	readonly first: (typeof orderFirsts)[number]
	readonly containment: (typeof orderContainments)[number]
	readonly item: (typeof orderItems)[number]
}

export const orderCaseGen: Gen<OrderCase> = (s) => ({
	first: s.draw(element(orderFirsts)),
	containment: s.draw(element(orderContainments)),
	item: s.draw(element(orderItems))
})

export type OrderFeature =
	| "a read contained in another, declared after it, first"
	| "a read contained in another, declared first, first"
	| "a containment into a read a literal restricts, the first declared first"
	| "a containment into a read a condition restricts, the first declared first"
	| "no containment, the first declared first"
	| "a containment over a selection, the first declared first"
	| "a containment at other fields, the first declared first"

/** The situation a case of the ordering box whose schema states Rare contained in Item over every row reaches. */
const containedFeatureOf = (c: OrderCase): OrderFeature => {
	switch (c.item) {
		case "every row":
			return c.first === "Item"
				? "a read contained in another, declared after it, first"
				: "a read contained in another, declared first, first"
		case "a literal":
			return "a containment into a read a literal restricts, the first declared first"
		case "a condition":
			return "a containment into a read a condition restricts, the first declared first"
	}
}

/** The situation a case of the ordering box reaches by its schema alone. */
export const orderFeatureOf = (c: OrderCase): OrderFeature => {
	switch (c.containment) {
		case "every row":
			return containedFeatureOf(c)
		case "none":
			return "no containment, the first declared first"
		case "a selection":
			return "a containment over a selection, the first declared first"
		case "other fields":
			return "a containment at other fields, the first declared first"
	}
}

/**
 * The relation the chain of a check over every row of Marked starts at, by the box's specification: Rare where the
 * schema states it contained in Item over every row at the variables both reads bind and the rule reads every row of
 * Item, each rare mark then beside an item the chain reads, and the first declared otherwise.
 */
export const orderExpected = (c: OrderCase): (typeof orderFirsts)[number] =>
	c.containment === "every row" && c.item === "every row" ? "Rare" : c.first

/**
 * The ordering box's schema: Item (the unit box's) and Rare, a containment of Rare into Item as the case states, and a
 * check over Marked, Item joined to Rare at (doc, at), matched in the case's order and read as the case reads Item.
 */
export const orderSchemaOf = (c: OrderCase): AnySchema => {
	const statements = (() => {
		switch (c.containment) {
			case "none":
				return []
			case "every row":
				return [contained(on(Rare, "doc", "at"), on(Item, "doc", "at"))]
			case "a selection":
				return [
					contained(
						on(
							select(Rare, (r) => r.ne(r.mark, 0)),
							"doc",
							"at"
						),
						on(Item, "doc", "at")
					)
				]
			case "other fields":
				return [contained(on(Rare, "doc", "mark"), on(Item, "doc", "at"))]
		}
	})()
	const Base = schema("OrderBox", [Item, Rare], statements)
	const Marked = derived(
		"Marked",
		query(Base).rule((r) => {
			const { doc, at, kind } = v(Item, "i")
			const { mark } = v(Rare, "r")
			const item = c.item === "a literal" ? { doc, at, kind, parent: 1 } : { doc, at, kind }
			const rare = c.item === "a literal" ? { doc, at, mark, note: 2 } : { doc, at, mark }
			const matched =
				c.first === "Item"
					? r.match(Item, item).match(Rare, rare)
					: r.match(Rare, rare).match(Item, item)
			const kept = c.item === "a condition" ? matched.where(r.ne(kind, 0)) : matched
			return kept.find({ doc, at, kind, mark })
		})
	)
	return schema.extend(
		[Base],
		"OrderBox_1",
		[Marked],
		[check("M", Marked, (m) => m.ne(m.mark, m.kind))]
	)
}

/** The table a query's chain reads first: the table its first core's first source ends at, a derived table's first. */
export const firstRead = (query: OperandSelect): string | undefined => {
	const core = bodyCores(query.body)[0]
	const first = core === undefined ? undefined : sourcesOf(core)[0]
	return first === undefined
		? undefined
		: first.kind === "table"
			? tableKey(first.table)
			: first.kind === "derived"
				? firstRead(first.query)
				: undefined
}

/**
 * The tables a query's chain reads, in its order: the first table of each source of the first core that reads more
 * than one source, a lone derived table read through to its own first core, and a step's derived table its own first
 * (`firstRead`).
 */
export const chainReads = (query: OperandSelect): ReadonlyArray<string> => {
	const core = bodyCores(query.body)[0]
	if (core === undefined) {
		return []
	}
	const sources = sourcesOf(core)
	const [only] = sources
	if (sources.length === 1 && only?.kind === "derived") {
		return chainReads(only.query)
	}
	return Arr.flatMap(sources, (source) => {
		const read =
			source.kind === "table"
				? tableKey(source.table)
				: source.kind === "derived"
					? firstRead(source.query)
					: undefined
		return read === undefined ? [] : [read]
	})
}

/**
 * The image box's relations, qti's placed references and expressions beside their nodes, keyed as qti keys them: Ref
 * and Expr, a document's references and expressions under each placement of it (asm, inst), keyed by the placement and
 * the element's place; Element, a document's elements by place, each with its parent.
 */
const Ref = relation("Ref", { doc: int4, asm: int4, inst: int4, at: int4, kind: int4 }, [
	"doc",
	"asm",
	"inst",
	"at"
])

const Expr = relation("Expr", { doc: int4, asm: int4, inst: int4, at: int4, base: int4 }, [
	"doc",
	"asm",
	"inst",
	"at"
])

const Element = relation("Element", { doc: int4, at: int4, parent: int4 }, ["doc", "at"])

/**
 * How Placed's rule walks from a reference: down to its expression child, Element at (doc, at: the expression's,
 * parent: the reference's), as qti's held type checks walk; or up to the expression it stands under, Element at (doc,
 * at: the reference's, parent: the expression's), Element's key the reference's own place, as qti's known operand keys
 * walk from an operand to its operator.
 */
const imageWalks = ["child", "parent"] as const

/**
 * What the image box's schema states of Expr into Element: nothing; Expr at (doc, at) contained in Element at its key,
 * over every row; the same over the rows of a selection of Expr alone; Expr at (doc, inst), fields the rule binds to no
 * variable of Element's; or Expr at (doc) alone, over every row, a containment that leaves Expr's place apart, so two
 * of its rows a lookup reads may stand beside one row of Element.
 */
const imageContainments = [
	"none",
	"every row",
	"a selection",
	"other fields",
	"its document alone"
] as const

/** Which of Expr and Element Placed's rule matches first, after Ref. */
const imageFirsts = ["Expr", "Element"] as const

/** The image box: how the rule walks, what the schema states of Expr into Element, and the declared order. */
export interface ImageCase {
	readonly walk: (typeof imageWalks)[number]
	readonly containment: (typeof imageContainments)[number]
	readonly first: (typeof imageFirsts)[number]
}

export const imageCaseGen: Gen<ImageCase> = (s) => ({
	walk: s.draw(element(imageWalks)),
	containment: s.draw(element(imageContainments)),
	first: s.draw(element(imageFirsts))
})

export type ImageFeature =
	| "an expression's children before its item's expressions, by the containment's image, declared after"
	| "an expression's children before its item's expressions, by the containment's image, declared first"
	| "an operand's element by its key before its item's expressions, declared after"
	| "an operand's element by its key before its item's expressions, declared first"
	| "the item's expressions first, more columns keyed, with no containment"
	| "the item's expressions first, more columns keyed, beside a containment over a selection"
	| "the item's expressions first, more columns keyed, beside a containment at other fields"
	| "the item's expressions first, more columns keyed, beside a containment whose image leaves a key field apart"

/** The situation a case of the image box reaches by its schema alone. */
export const imageFeatureOf = (c: ImageCase): ImageFeature => {
	if (c.walk === "parent") {
		return c.first === "Expr"
			? "an operand's element by its key before its item's expressions, declared after"
			: "an operand's element by its key before its item's expressions, declared first"
	}
	switch (c.containment) {
		case "none":
			return "the item's expressions first, more columns keyed, with no containment"
		case "a selection":
			return "the item's expressions first, more columns keyed, beside a containment over a selection"
		case "other fields":
			return "the item's expressions first, more columns keyed, beside a containment at other fields"
		case "its document alone":
			return "the item's expressions first, more columns keyed, beside a containment whose image leaves a key field apart"
		case "every row":
			return c.first === "Expr"
				? "an expression's children before its item's expressions, by the containment's image, declared after"
				: "an expression's children before its item's expressions, by the containment's image, declared first"
	}
}

/**
 * The relation the chain of the check over every row of Placed reads after Ref, by the box's specification: Element
 * where its bound columns hold its key (the walk up, at the reference's own place), or where the schema states Expr
 * contained in Element at (doc, at) over every row, the variables both reads bind, and Expr's key is among its bound
 * columns (doc, asm, inst) and the containment's fields (doc, at), so Element's bound (doc, parent) holds more than
 * Expr's image (doc); else Expr, three columns keyed against Element's two.
 */
export const imageExpected = (c: ImageCase): (typeof imageFirsts)[number] =>
	c.walk === "parent" || c.containment === "every row" ? "Element" : "Expr"

/**
 * The image box's schema: Ref, Expr and Element, Expr's containment into Element as the case states, and a check over
 * Placed, a reference at kind 1 beside an expression of its placement and the element that links them, as the case
 * walks, Expr and Element matched in the case's order after Ref.
 */
export const imageSchemaOf = (c: ImageCase): AnySchema => {
	const statements = (() => {
		switch (c.containment) {
			case "none":
				return []
			case "every row":
				return [contained(on(Expr, "doc", "at"), on(Element, "doc", "at"))]
			case "a selection":
				return [
					contained(
						on(
							select(Expr, (e) => e.ne(e.base, 0)),
							"doc",
							"at"
						),
						on(Element, "doc", "at")
					)
				]
			case "other fields":
				return [contained(on(Expr, "doc", "inst"), on(Element, "doc", "at"))]
			case "its document alone":
				return [contained(on(Expr, "doc"), on(Element, "doc"))]
		}
	})()
	const Base = schema("ImageBox", [Ref, Expr, Element], statements)
	const Placed = derived(
		"Placed",
		query(Base).rule((r) => {
			const { doc, asm, inst, at } = v(Ref, "r")
			const { at: expression, base } = v(Expr, "e")
			const element =
				c.walk === "child" ? { doc, at: expression, parent: at } : { doc, at, parent: expression }
			const reference = r.match(Ref, { doc, asm, inst, at, kind: 1 })
			const placed = { doc, asm, inst, at: expression, base }
			const matched =
				c.first === "Expr"
					? reference.match(Expr, placed).match(Element, element)
					: reference.match(Element, element).match(Expr, placed)
			return matched.find({ doc, asm, inst, at, expression, base })
		})
	)
	return schema.extend(
		[Base],
		"ImageBox_1",
		[Placed],
		[check("P", Placed, (p) => p.ne(p.base, p.at))]
	)
}
