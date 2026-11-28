/** What the properties of selection-key.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { Type } from "#compiler/public/compute.ts"
import { Bit, bit } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { selectColumns, type SqlStatement } from "#compiler/sql/ast.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import { Id } from "#test/support/ids.ts"
import { installationOf } from "#test/support/kernel/naming.ts"
import { Note, Plans, Task } from "#test/support/pg/plans/fixture.ts"

type Relation = "Note" | "Task" | "Badge"

type Guard = "held" | "absent" | "other"

const Tier = closed.ordered("Tier", ["bronze", "silver", "gold"])

const Badge = relation("Badge", { id: Id, holder: Id, tiers: bit(Tier) }, ["id"])

/** The badge tiers a guard and a read combine: {bronze}, as a term of the field's type, and {silver}. */
const bronze = () => Type.literal(Badge.fields.tiers, Bit.of(Tier, ["bronze"]))

const silver = Bit.of(Tier, ["silver"])

/** At most one badge of bronze and silver alone per holder: a selection key whose guard computes its value. */
const Badges = schema(
	"Badges",
	[Tier, Badge],
	[
		key(
			on(
				select(Badge, (x) => x.eq(x.tiers, Bit.union(bronze(), silver))),
				"holder"
			)
		)
	]
)

export const schemaOf = (relation: Relation) => (relation === "Badge" ? Badges : Plans)

interface Case {
	readonly relation: Relation
	readonly guard: Guard
	readonly term: boolean
}

export const caseGen: Gen<Case> = (source) => ({
	relation: source.draw(element(["Note", "Task", "Badge"] as const)),
	guard: source.draw(element(["held", "absent", "other"] as const)),
	term: source.draw(element([true, false]))
})

/** Each case's query: its relation matched with the case's constants, its id found. */
export const queryOf = (c: Case) => {
	if (c.relation === "Badge") {
		return query(Badges).rule((r) => {
			const { id } = v(Badge, "badge")
			const fixed = c.term ? { holder: r.param("holder", Badge.fields.holder) } : {}
			switch (c.guard) {
				case "held":
					return r.match(Badge, { id, ...fixed, tiers: Bit.union(bronze(), silver) }).find({ id })
				case "other":
					return r
						.match(Badge, { id, ...fixed, tiers: Bit.intersection(bronze(), silver) })
						.find({ id })
				case "absent":
					return r.match(Badge, { id, ...fixed }).find({ id })
			}
		})
	}
	const q = query(Plans)
	if (c.relation === "Note") {
		const ticket = { ticket: Note.fields.ticket }
		return q.rule((r) => {
			const { id } = v(Note, "note")
			const fixed = c.term ? { ticket: r.param("ticket", ticket.ticket) } : {}
			switch (c.guard) {
				case "held":
					return r.match(Note, { id, ...fixed, open: true }).find({ id })
				case "other":
					return r.match(Note, { id, ...fixed, open: false }).find({ id })
				case "absent":
					return r.match(Note, { id, ...fixed }).find({ id })
			}
		})
	}
	return q.rule((r) => {
		const { id } = v(Task, "task")
		const fixed = c.term ? { account: r.param("account", Task.fields.account) } : {}
		switch (c.guard) {
			case "held":
				return r.match(Task, { id, ...fixed, kind: "Automatic" }).find({ id })
			case "other":
				return r.match(Task, { id, ...fixed, kind: "Manual" }).find({ id })
			case "absent":
				return r.match(Task, { id, ...fixed }).find({ id })
		}
	})
}

/** Each relation's selection key's law column, as its schema's installation names it. */
const installations = Object.freeze({
	Plans: installationOf(Plans, { kind: "declared" }),
	Badges: installationOf(Badges, { kind: "declared" })
})

export const lawColumnOf = (relation: Relation): string => {
	const installation = relation === "Badge" ? installations.Badges : installations.Plans
	const [selection, ...more] = installation.names.selectionKeys(relation)
	assert.equal(more.length, 0, `${relation} has one selection key`)
	return defined(selection, `${relation}'s selection key`).column
}

/**
 * Whether a statement probes the law column `column`: a derived table's scan reads the column among its targets, and
 * an equality compares that derived column with a parameter, as the key's index reads it.
 */
export const probes = (ast: SqlStatement, column: string): boolean => {
	if (ast.kind !== "select") {
		return false
	}
	const law = new Set<string>()
	const equalities: Array<readonly [string, string]> = []
	visitSelect(ast, {
		...inertVisitor,
		fromItem: (item) => {
			if (item.kind !== "derived" || item.query.body.kind !== "core") {
				return
			}
			for (const [i, t] of item.query.body.targets.entries()) {
				const named = selectColumns(item.query)[i]
				if (t.expr.kind === "column" && t.expr.column === column && named !== undefined) {
					law.add(`${item.alias}.${named}`)
				}
			}
		},
		expr: (e) => {
			if (e.kind !== "binary" || e.op !== "=") {
				return
			}
			for (const [a, b] of [
				[e.left, e.right],
				[e.right, e.left]
			] as const) {
				const value = b.kind === "cast" ? b.expr : b
				if (a.kind === "column" && a.table !== undefined && value.kind === "param") {
					equalities.push([a.table, a.column])
				}
			}
		}
	})
	return Arr.some(equalities, ([table, c]) => law.has(`${table}.${c}`))
}

export type Feature = `${Relation} probed` | `${Relation} read by its fields`
