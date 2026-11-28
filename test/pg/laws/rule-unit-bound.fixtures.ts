/** What the property of rule-unit-bound.test.ts reads: its schema and template, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { planNodes, rowsTouched } from "#bench/harness/explain.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, derived, relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, seededTemplate } from "#test/support/install-migrate.ts"
import { judgedPlans, judgedStatementsOf, raisedRule } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { storedSeed } from "#test/support/stored.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

/**
 * pantry's catalog statements in their smallest shape (scope_duration_read_check_e_1_derived): a document's nodes and
 * references, each keyed by its unit (pkg, path) and its start, immutable, so the check over Typed is judged whole over
 * the units a transaction wrote. Typed reads Read, a one-rule import of Ref beside Placed, a union import of the nodes of
 * two kinds, at (pkg, path, start): Placed's unit variables reach the outer rule's only through Read's head equalities,
 * which inlining Read states.
 */
const Node = relation("Node", { pkg: int4, path: int4, start: int4, kind: int4 }, [
	"pkg",
	"path",
	"start"
])
const Ref = relation("Ref", { pkg: int4, path: int4, start: int4, name: int4 }, [
	"pkg",
	"path",
	"start"
])
const Base = schema("UnitBound", [Node, Ref], [])
const Placed = query(Base)
	.rule((r) => {
		const { pkg, path, start } = v(Node, "n")
		return r.match(Node, { pkg, path, start, kind: 1 }).find({ pkg, path, start })
	})
	.rule((r) => {
		const { pkg, path, start } = v(Node, "n")
		return r.match(Node, { pkg, path, start, kind: 2 }).find({ pkg, path, start })
	})
const Read = query(Base).rule((r) => {
	const { pkg, path, start, name } = v(Ref, "ref")
	return r
		.match(Ref, { pkg, path, start, name })
		.match(Placed, { pkg, path, start })
		.find({ pkg, path, start, name })
})
const Typed = derived(
	"Typed",
	query(Base).rule((r) => {
		const { pkg, path, start, name } = v(Read, "read")
		const { kind } = v(Node, "scope")
		return r
			.match(Read, { pkg, path, start, name })
			.match(Node, { kind, pkg, path, start: name })
			.where(r.in(kind, [3, 4]))
			.find({ pkg, path, start, kind })
	})
)
const UnitBound = schema.extend(
	[Base],
	"UnitBound_1",
	[Typed],
	[check("Three", Typed, (t) => t.le(t.kind, 3))]
)

/** UnitBound installed through its first migration, with no login: the template every case rolls back over. */
/** The nodes of a document, each size twice the one before. */
const sizes = [64, 128, 256] as const

/**
 * The documents stored beside the written one, each in a package of its own and as large as it: units a read of the
 * written unit's alone never touches.
 */
const stored = 40

/**
 * UnitBound installed, and, at each written document's size, `stored` documents of that size, packages 2 to
 * stored + 1, committed through the captures once per member and judged at their COMMIT (stored.ts storedSeed): the
 * template a case of that size writes beside.
 */
const unitBoundTemplate = (nodes: (typeof sizes)[number]): SubstrateTemplate<Installed> =>
	seededTemplate({
		declaredIn: import.meta,
		name: `unit bound ${nodes}`,
		schema: UnitBound,
		options: { ambient: ordinarySession, extensions: [], label: "unit_bound" },
		seed: storedSeed((installed) =>
			Arr.flatMap(
				Array.from({ length: stored }, (_, i) => i + 2),
				(pkg) => documentRows(installed, pkg, nodes)
			)
		)
	})

export const unitBoundTemplates: {
	readonly [N in (typeof sizes)[number] as `${N}`]: SubstrateTemplate<Installed>
} = {
	"64": unitBoundTemplate(64),
	"128": unitBoundTemplate(128),
	"256": unitBoundTemplate(256)
}

/** A case: the written document's nodes, and the statistics PostgreSQL holds when the judge's statements are planned. */
export interface Unit {
	readonly nodes: (typeof sizes)[number]
	readonly statistics: "none" | "analyzed"
}

export const unitGen: Gen<Unit> = (s) => ({
	nodes: s.draw(element(sizes)),
	statistics: s.draw(element(["none", "analyzed"] as const))
})

export type UnitFeature = "planned with no statistics" | "planned analyzed"

/**
 * The rows of document 1 of package `pkg`, of `nodes` nodes: its root of kind 0, a node of kind 1 or 2 and a reference
 * at each odd start, naming the node at the next start, of kind 3. Typed holds a fact at each reference, of kind 3,
 * which the check admits.
 */
const documentRows = (installed: Installed, pkg: number, nodes: number): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const starts = `generate_series(1, ${nodes - 1}) AS s(start)`
	return [
		`INSERT INTO ${names.table(Node)} (pkg, path, start, kind) SELECT ${pkg}, 1, start, CASE WHEN start % 2 = 1 THEN 1 + start % 4 / 2 ELSE 3 END FROM ${starts}`,
		`INSERT INTO ${names.table(Node)} (pkg, path, start, kind) VALUES (${pkg}, 1, 0, 0)`,
		`INSERT INTO ${names.table(Ref)} (pkg, path, start, name) SELECT ${pkg}, 1, start, start + 1 FROM ${starts} WHERE start % 2 = 1 AND start + 1 < ${nodes}`
	]
}

/** The rows a case writes through the captures: its document's nodes and references. */
const writtenRows = (u: Unit): number => u.nodes + Math.floor((u.nodes - 1) / 2)

/**
 * One case in its one transaction over a clone of its size's template (unitBoundTemplates), which the case's end rolls
 * back: the case's document of package 1 written through the captures beside the template's `stored` committed ones,
 * and ANALYZE where the case draws it; then every statement the judge runs of the check, explained with ANALYZE as PL/pgSQL plans it over the
 * deltas that hold the rows (test/support/judge.ts judgedPlans), and the judge run, which accepts them. The check is
 * judged whole over the written unit, so each statement reads the written unit alone: its rows touched, every row each
 * node of its plan handled over all of its loops, at most its plan's nodes times the rows written. A read of Placed at
 * no unit, its union of every package's nodes of kinds 1 and 2, touches every stored document's.
 */
export const runUnit = (
	installed: Installed,
	connection: PgConnection,
	u: Unit,
	c: Case<UnitFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const tables = Arr.map([Node, Ref], (t) => names.table(t))
		for (const sql of [
			...documentRows(installed, 1, u.nodes),
			...(u.statistics === "analyzed" ? Arr.map(tables, (t) => `ANALYZE ${t}`) : [])
		]) {
			yield* connection.query(sql, [])
		}
		const rows = writtenRows(u)
		const statements = judgedStatementsOf(installed.installation)
		const judged = yield* judgedPlans(
			(sql, params) => connection.queryValues(sql, params),
			installed.installation,
			statements
		)
		const [rule] = installed.installation.laws.rules
		assert.ok(rule?.rule.kind === "whole", "the check is judged whole over its units")
		const identity = identifierOf(rule.named)
		const ran = Arr.filter(judged, (p) => Option.contains(raisedRule(p.statement), identity))
		assert.ok(ran.length > 0, "the judge runs a statement of the check over the unit written")
		for (const { plan } of ran) {
			const nodes = Arr.fromIterable(planNodes(plan)).length
			const touched = rowsTouched(plan)
			assert.ok(
				touched <= nodes * rows,
				`${Formatter.format(u)}: the check's statement touches ${touched} rows, past its ${nodes} nodes times the ${rows} rows the transaction wrote`
			)
		}
		yield* connection.query("SET CONSTRAINTS ALL IMMEDIATE", [])
		c.note(u.statistics === "none" ? "planned with no statistics" : "planned analyzed")
	})
