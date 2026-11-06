import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { flight } from "#compiler/lower/conservative/types.ts"
import { query, v } from "#compiler/public/query.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import { Note, Plans, Task } from "#test/pg/plans/fixture.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { installationOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { auditStatementViolations } from "#test/support/oracle/verify/sql.ts"

/**
 * A read of a selection key's relation probes the key's law column (lower/conservative/match-region probeKeys): a key
 * over `select(R, φ)` on f installs `CASE WHEN φ THEN f END` under a UNIQUE NULLS DISTINCT, and a match of R that holds
 * every conjunct of φ as a constant and fixes f compares f's value with that column, which the UNIQUE's index serves,
 * in the optimized statement and the conservative one alike. A match that fixes f under any other selection, or
 * holds φ without fixing f, reads R by its fields, as before.
 *
 * The box: the plans fixture's two selection keys, Note's (open = true, on ticket) and Task's (kind = Automatic, on
 * account), each read with its guard held, absent or contradicted by the other literal, and its term fixed by a
 * parameter or not, under both lowerings. The oracle is the rule restated over the case: the law column is read
 * exactly when the guard is held and the term fixed; its name is read off the installation's natives.
 */
type Relation = "Note" | "Task"
type Guard = "held" | "absent" | "other"

interface Case {
	readonly relation: Relation
	readonly guard: Guard
	readonly term: boolean
}

const caseGen: Gen<Case> = (source) => ({
	relation: source.draw(element(["Note", "Task"] as const)),
	guard: source.draw(element(["held", "absent", "other"] as const)),
	term: source.draw(element([true, false]))
})

/** Each case's query: its relation matched with the case's constants, its id found. */
const queryOf = (c: Case) => {
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

/** Each relation's selection key's law column, as the installation names it. */
const installation = installationOf(Plans, { kind: "declared" })
const lawColumnOf = (relation: Relation): string => {
	const [key, ...more] = installation.names.selectionKeys(relation)
	assert.equal(more.length, 0, `${relation} has one selection key`)
	return defined(key, `${relation}'s selection key`).column
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
						limit: 12,
						box: "Note's and Task's selection keys, the guard held, absent or contradicted, the term fixed or not",
						oracle: {
							kind: "specification",
							name: "the law column is read exactly when every guard conjunct holds and the term is fixed"
						},
						coverage: requiredInSpace<Feature>([
							"Note probed",
							"Note read by its fields",
							"Task probed",
							"Task read by its fields"
						]),
						caseHang
					},
					(c, seen) =>
						Effect.sync(() => {
							const template = succeeded(
								compileTemplate(queryOf(c), Plans, testCompile),
								Formatter.format(c)
							)
							const column = lawColumnOf(c.relation)
							const probed = c.guard === "held" && c.term
							for (const [path, statements] of [
								["optimized", Arr.map(flight(template.programs.optimized.roots), (s) => s.ast)],
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
							for (const spec of [...template.optimized, ...template.conservative]) {
								assert.equal(
									Str.includes(`"${column}"`)(spec.sql),
									probed,
									`the emitted text reads ${column} exactly when probed: ${Formatter.format(c)}`
								)
							}
							seen.note(probed ? `${c.relation} probed` : `${c.relation} read by its fields`)
						})
				)
			)
	)
})
