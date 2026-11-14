/**
 * What a law's full violation query reads, as deploy/snapshot/violation.ts lawChecks lowers it: each stored relation's
 * table plainly, under its primary key's proof (lower/conservative/base/index.ts readsKeyedTable), never through
 * SELECT DISTINCT over it, so PostgreSQL flattens the table into the join that reads it and probes it by its indexes;
 * each derived relation as its definition, live, a query of its own (analysis/theory/query.ts violationQuery), so each
 * join PostgreSQL plans is one definition's own; and a law over closed relations alone no table at all, so the
 * setup-phase checks of a migration (diff.ts migrationChecks), which only such laws hold, print the same whatever a
 * table read prints.
 *
 * edullm's QTI identity migration drafted its check of LomObjectTitle with every stored relation read through SELECT
 * DISTINCT over every column: PostgreSQL planned one HashAggregate per table, no index, every multi-column join
 * estimated at one row, and the check ran past twelve minutes over tables of thousands of rows.
 *
 * The box, exhausted: stored relations A(id, k, a), B(id, k, b) and T(a, b); a rule over a query whose source is A's
 * facts of a nonzero a, the join J = A ⋈ B on k, the facts of a materialized derived relation V = A ⋈ B, or JJ = J ⋈ T
 * or VV = V ⋈ T, a definition reading a definition, and whose target is M, B's (k, b) whose b is a T row's a, with or
 * without a second arm, B's (k, b) whose b is no T row's a, a negation read by NOT EXISTS; beside closed relations
 * TierRank and TierNext and a containment between them alone. The oracle is the installation's own names of the stored
 * tables (PhysicalNames.relation) and the box's own definitions: every table a violation query reads is a stored one,
 * read by a core with no DISTINCT under the proof `keyed`, and never V's view, since a rule judges a derived relation
 * on its definition, live, which the migration that checks it may not have filled; no core of it joins more sources
 * than the widest rule of a definition it reads, each definition a query of its own, so PostgreSQL plans no join of
 * every relation the definitions read together; and a migration check reads no table.
 *
 * Features: a stored table read plainly; a negated arm; a definition reading a definition; a join; a migration check.
 *
 * Where a migration runs a rule's check, every table it reads holds its target primary key, which is why reading it
 * plainly is exact: the check is a Validate step (deploy/diff/diff.ts ruleChecks), after validate.attach in the one
 * Validate transaction (deploy/diff/plan.ts slots, slotFile), where a key over a table that may hold rows is attached
 * to the unique index Indexes built, and before which every other key stands (diff.ts ownConstraint). The second box,
 * exhausted, drafts a migration adding the rule from a version without it, A's key kept, widened from (id) to (id, k),
 * or moved to (k, a), with or without M's negated arm. The oracle is the plan itself: each check is in Validate, and
 * every step that attaches a primary key to a table the check reads runs before it.
 *
 * Plants (~/.cache/grizzle-release/LAWQUERY/plants): violation-distinct-back.patch, the violation probe reading every
 * stored table through SELECT DISTINCT again, as edullm's migration was drafted, fails the first box;
 * violation-check-before-keys.patch, Validate's checks run before its keys are attached, fails the second;
 * violation-fused-definitions.patch, a side read as its arms, every definition inlined into one join, fails the first by
 * its widest join; violation-stale-view.patch, a materialized derived relation read through its view, fails the first by
 * the view it reads.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import type { Step } from "#compiler/deploy/diff/plan.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
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
import { installationsOf, own, rostersOf } from "#compiler/schema/own.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import type { OperandBody, OperandSelect, SelectCore, TableName } from "#compiler/sql/ast.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import type { Relation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { asDrafted, draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"

const A = relation("A", { id: pg.integer, k: pg.integer, a: pg.integer }, ["id"])
const B = relation("B", { id: pg.integer, k: pg.integer, b: pg.integer }, ["id"])
const T = relation("T", { a: pg.integer, b: pg.integer }, ["a", "b"])
const Tier = closed("Tier", ["low", "high"])
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

const caseGen: Gen<Case> = (s) => ({
	source: s.draw(element(sources)),
	negated: s.draw(boolean)
})

/**
 * The case's schema: A, B and T, and the closed relations TierRank and TierNext with a containment between them alone,
 * at the root; J and V over it at a middle level; and M, JJ and VV, which read J and V, with the case's rule above.
 */
const schemaOf = (c: Case): AnySchema => {
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
const tableKey = (t: TableName): string => (typeof t === "string" ? t : `${t.schema}.${t.name}`)

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

/** Every table a query reads, wherever it stands: its body, a derived table, a sublink or a CTE. */
const tableReads = (query: OperandSelect): ReadonlyArray<TableRead> => {
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
	return Arr.flatMap(queries, (q) => Arr.flatMap(bodyCores(q.body), coreReads))
}

/** The NOT EXISTS sublinks of a query: the containment's own, and one for each negated arm. */
const negations = (query: OperandSelect): number => {
	let count = 0
	visitSelect(query, {
		...inertVisitor,
		expr: (e) => {
			if (e.kind === "exists" && e.not) {
				count += 1
			}
		}
	})
	return count
}

const keyChanges = ["kept", "widened", "moved"] as const

interface MigrationCase {
	readonly key: (typeof keyChanges)[number]
	readonly negated: boolean
}

const migrationCaseGen: Gen<MigrationCase> = (s) => ({
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
const versionsOf = (c: MigrationCase): readonly [AnySchema, AnySchema] => {
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
const keyedBy = (step: Step): ReadonlyArray<string> => {
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

/** The most FROM items one core of a query joins, a join chain's each counted, wherever the core stands. */
const widestJoin = (query: OperandSelect): number => {
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
const widestRule = 2

type MigrationFeature = "a key kept" | "a key attached before the check" | "a negated arm"

type Feature =
	| "a stored table read plainly"
	| "a negated arm"
	| "a definition reading a definition"
	| "a join"
	| "a migration check"

describe("a law's full violation query", () => {
	it.effect(
		"reads each stored table plainly under its key, never a view, each definition at a level of its own, and a law over closed relations no table",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/violation-reads",
						generator: caseGen,
						literal: Formatter.format,
						box: "a rule over a query from A's selected facts, J = A ⋈ B, the materialized V = A ⋈ B, JJ = J ⋈ T or VV = V ⋈ T, into M of one arm or of two, one negated, beside a law over closed relations alone",
						oracle: {
							kind: "second-implementation",
							name: "the installation's own names of the stored tables, and the widest rule of the box's definitions"
						},
						coverage: requiredInSpace<Feature>([
							"a stored table read plainly",
							"a negated arm",
							"a definition reading a definition",
							"a join",
							"a migration check"
						]),
						caseHang,
						concurrency: 1
					},
					(c, k) =>
						Effect.sync(() => {
							const owned = succeeded(
								own(defined(schemaDescOf(schemaOf(c)), "the case's description"))
							)
							const installation = succeeded(
								compileInstallation(
									owned,
									completeInstallOptions(
										owned,
										installationsOf(owned),
										[],
										[],
										firstCodebook(rostersOf(owned))
									)
								)
							)
							const stored = new Set(
								Arr.map(["A", "B", "T"], (name) => tableKey(installation.names.relation(name)))
							)
							const checks = lawChecks(installation)
							assert.equal(checks.rules.length, 1, "the case's one rule over a query")
							for (const rule of checks.rules) {
								const reads = tableReads(rule.query)
								for (const r of reads) {
									assert.ok(stored.has(r.table), `${r.table}, a stored table, and no view`)
									assert.equal(r.read, "keyed", `${r.table}, a stored table, read plainly`)
									k.note("a stored table read plainly")
								}
								const names = new Set(Arr.map(reads, (r) => r.table))
								if (
									names.has(tableKey(installation.names.relation("A"))) &&
									names.has(tableKey(installation.names.relation("B")))
								) {
									k.note("a join")
								}
								if (negations(rule.query) > 1) {
									k.note("a negated arm")
								}
								assert.equal(
									widestJoin(rule.query),
									widestRule,
									"the widest join of the check, the widest rule of a definition it reads"
								)
								if (c.source === "nested" || c.source === "nested view") {
									k.note("a definition reading a definition")
								}
							}
							assert.equal(
								checks.migrations.length,
								1,
								"a law over closed relations alone, checked by the migration"
							)
							for (const m of checks.migrations) {
								assert.deepEqual(tableReads(m.query), [], "a migration check reads no table")
								k.note("a migration check")
							}
						})
				)
			)
	)
	it.effect(
		"runs each rule's check in Validate, after every primary key of a table it reads is attached",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/violation-reads/migration",
						generator: migrationCaseGen,
						literal: Formatter.format,
						box: "a migration adding a rule of J = A ⋈ B into M of one arm or of two, A's key kept, widened or moved",
						oracle: {
							kind: "specification",
							name: "the plan's own steps: each check in Validate, after every primary key attached to a table it reads"
						},
						coverage: requiredInSpace<MigrationFeature>([
							"a key kept",
							"a key attached before the check",
							"a negated arm"
						]),
						caseHang,
						concurrency: 1
					},
					(c, k) =>
						Effect.sync(() => {
							const [first, second] = versionsOf(c)
							const drafted = draftChain(
								[
									{ desc: first, options: asDrafted, declared: noDeclarations },
									{ desc: second, options: asDrafted, declared: noDeclarations }
								],
								fromEmpty
							)
							const steps = defined(drafted[1], "the second migration").plan.steps
							const checks = Arr.filter(
								Arr.map(steps, (step, i) => ({ step, i })),
								({ step }) => step.draft.kind === "violation"
							)
							assert.equal(checks.length, 1, "the added rule's one check")
							for (const { step, i } of checks) {
								assert.equal(step.slot, "validate", "a rule's check, in Validate")
								const read =
									step.draft.kind === "violation"
										? new Set(Arr.map(tableReads(step.draft.query), (r) => r.table))
										: new Set<string>()
								const attaching = Arr.filter(
									Arr.map(steps, (s, j) => ({ tables: keyedBy(s), j })),
									({ tables }) => Arr.some(tables, (t) => read.has(t))
								)
								for (const { j } of attaching) {
									assert.ok(j < i, "a primary key of a table the check reads, attached before it")
									if (steps[j]?.slot === "validate.attach") {
										k.note("a key attached before the check")
									}
								}
							}
							if (c.key === "kept") {
								k.note("a key kept")
							}
							if (c.negated) {
								k.note("a negated arm")
							}
						})
				)
			)
	)
})
