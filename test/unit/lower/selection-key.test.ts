/**
 * A read of a selection key's relation probes the key's law column (lower/conservative/match-region probeKeys): a key
 * over `select(R, φ)` on f installs `CASE WHEN φ THEN f END` under a UNIQUE NULLS DISTINCT, and a match of R that holds
 * every conjunct of φ as a constant and fixes f compares f's value with that column, which the UNIQUE's index serves,
 * in the optimized statement and the conservative one alike. A match that fixes f under any other selection, or
 * holds φ without fixing f, reads R by its fields, as before.
 *
 * The box: the plans fixture's two selection keys, Note's (open = true, on ticket) and Task's (kind = Automatic, on
 * account), and Badge's, whose guard's value is an operation over literals (tiers = {bronze} ∪ {silver}, on holder),
 * each read with its guard held, absent or contradicted, by the other literal or, for Badge, by another operation over
 * the same literals, and its term fixed by a parameter or not, under both lowerings. The oracle is the rule restated
 * over the case: the law column is read exactly when the guard is held and the term fixed; its name is read off the
 * installation's natives. The probe is read off each statement's AST, never its printed text.
 *
 * Features: each relation probed, and read by its fields.
 *
 * Plant, failing the search: a key probing an occurrence that fixes its term whatever its guard (selection-key-guard).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { flight } from "#compiler/lower/conservative/types.ts"
import { Compute } from "#compiler/public/compute.ts"
import { Bits, bits, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import { Note, Plans, Task } from "#test/pg/plans/fixture.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { compileTemplate, programAsts, testCompile } from "#test/support/compile.ts"
import { installationOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { auditStatementViolations } from "#test/support/oracle/verify/sql.ts"

type Relation = "Note" | "Task" | "Badge"
type Guard = "held" | "absent" | "other"

const Tier = closed("Tier", ["bronze", "silver", "gold"])
const Badge = relation("Badge", { id: uuid, holder: uuid, tiers: bits(Tier) }, ["id"])

/** The badge tiers a guard and a read combine: {bronze}, as a term of the field's type, and {silver}. */
const bronze = () => Compute.literal(Badge.fields.tiers, Bits.of(Tier, ["bronze"]))
const silver = Bits.of(Tier, ["silver"])

/** At most one badge of bronze and silver alone per holder: a selection key whose guard computes its value. */
const Badges = schema("Badges", { Tier, Badge }, [
	key(
		on(
			select(Badge, (x) => x.eq(x.tiers, Compute.union(bronze(), silver))),
			"holder"
		)
	)
])

const schemaOf = (relation: Relation) => (relation === "Badge" ? Badges : Plans)

interface Case {
	readonly relation: Relation
	readonly guard: Guard
	readonly term: boolean
}

const caseGen: Gen<Case> = (source) => ({
	relation: source.draw(element(["Note", "Task", "Badge"] as const)),
	guard: source.draw(element(["held", "absent", "other"] as const)),
	term: source.draw(element([true, false]))
})

/** Each case's query: its relation matched with the case's constants, its id found. */
const queryOf = (c: Case) => {
	if (c.relation === "Badge") {
		return query(Badges).rule((r) => {
			const { id } = v(Badge, "badge")
			const fixed = c.term ? { holder: r.param("holder", Badge.fields.holder) } : {}
			switch (c.guard) {
				case "held":
					return r
						.match(Badge, { id, ...fixed, tiers: Compute.union(bronze(), silver) })
						.find({ id })
				case "other":
					return r
						.match(Badge, { id, ...fixed, tiers: Compute.intersection(bronze(), silver) })
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
const installations = {
	Plans: installationOf(Plans, { kind: "declared" }),
	Badges: installationOf(Badges, { kind: "declared" })
}
const lawColumnOf = (relation: Relation): string => {
	const installation = relation === "Badge" ? installations.Badges : installations.Plans
	const [selection, ...more] = installation.names.selectionKeys(relation)
	assert.equal(more.length, 0, `${relation} has one selection key`)
	return defined(selection, `${relation}'s selection key`).column
}

/**
 * Whether a statement probes the law column `column`: a derived table's scan reads the column among its targets, and
 * an equality compares that derived column with a parameter, as the key's index reads it.
 */
const probes = (ast: SqlStatement, column: string): boolean => {
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
				const named = item.columns[i]
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

type Feature = `${Relation} probed` | `${Relation} read by its fields`

describe("a selection key's probe", () => {
	it.effect(
		"reads the key's law column exactly when the read holds its selection and fixes its term, in both lowerings",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/selection-key",
						generator: caseGen,
						literal: Formatter.format,
						limit: 18,
						box: "Note's, Task's and Badge's selection keys, the guard held, absent or contradicted, the term fixed or not",
						oracle: {
							kind: "specification",
							name: "the law column is read exactly when every guard conjunct holds and the term is fixed"
						},
						coverage: requiredInSpace<Feature>([
							"Note probed",
							"Note read by its fields",
							"Task probed",
							"Task read by its fields",
							"Badge probed",
							"Badge read by its fields"
						]),
						caseHang
					},
					(c, seen) =>
						Effect.sync(() => {
							const template = succeeded(
								compileTemplate(queryOf(c), schemaOf(c.relation), testCompile),
								Formatter.format(c)
							)
							const column = lawColumnOf(c.relation)
							const probed = c.guard === "held" && c.term
							for (const [path, statements] of [
								["optimized", programAsts(template.programs.optimized)],
								[
									"conservative",
									Arr.map(flight(template.programs.conservative.roots), (s) => s.ast)
								]
							] as const) {
								assert.ok(statements.length > 0, `${path} lowers`)
								for (const ast of statements) {
									assert.deepEqual(
										auditStatementViolations(ast),
										[],
										`${path} ${Formatter.format(c)}`
									)
								}
								assert.equal(
									Arr.some(statements, (ast) => probes(ast, column)),
									probed,
									`${path} compares ${column} with its parameter exactly when probed: ${Formatter.format(c)}`
								)
							}
							seen.note(probed ? `${c.relation} probed` : `${c.relation} read by its fields`)
						})
				)
			)
	)
})
