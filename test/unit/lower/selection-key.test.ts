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
 */

import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { flight } from "#compiler/lower/conservative/types.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { compileTemplate, programAsts, testCompile } from "#test/support/compile.ts"
import { auditStatementViolations } from "#test/support/oracle/verify/sql.ts"
import {
	caseGen,
	type Feature,
	lawColumnOf,
	probes,
	queryOf,
	schemaOf
} from "#test/unit/lower/selection-key.fixtures.ts"

/** A selection key's probe reads the key's law column exactly when the read holds its selection and fixes its term, in both lowerings. */
export const aSelectionKeysProbeReadsTheKeysLawColumnExactlyWhenTheReadHoldsItsSelectionAndFixesItsTermInBothLowerings =
	property.exhaust(finite(caseGen), {
		needs: {},
		situations: [
			"Note probed",
			"Note read by its fields",
			"Task probed",
			"Task read by its fields",
			"Badge probed",
			"Badge read by its fields"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, seen: CaseOf<Feature>) => (c) =>
			Effect.sync(() => {
				const template = succeeded(
					compileTemplate(queryOf(c), schemaOf(c.relation), testCompile),
					Formatter.format(c)
				)
				const column = lawColumnOf(c.relation)
				const probed = c.guard === "held" && c.term
				for (const [path, statements] of [
					["optimized", programAsts(template.programs.optimized)],
					["conservative", Arr.map(flight(template.programs.conservative.roots), (s) => s.ast)]
				] as const) {
					assert.ok(statements.length > 0, `${path} lowers`)
					for (const ast of statements) {
						assert.deepEqual(auditStatementViolations(ast), [], `${path} ${Formatter.format(c)}`)
					}
					assert.equal(
						Arr.some(statements, (ast) => probes(ast, column)),
						probed,
						`${path} compares ${column} with its parameter exactly when probed: ${Formatter.format(c)}`
					)
				}
				seen.note(probed ? `${c.relation} probed` : `${c.relation} read by its fields`)
			}),
		oracle: {
			kind: "specification",
			name: "the law column is read exactly when every guard conjunct holds and the term is fixed"
		},
		box: "Note's, Task's and Badge's selection keys, the guard held, absent or contradicted, the term fixed or not",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/match-region/index.ts",
				original:
					"\t\t.filter((k) => fixed.has(k.field) && k.guard.every((g) => holdsAsConstant(g, fixed)))",
				replacement: "\t\t.filter((k) => fixed.has(k.field))",
				why: "probeKeys probes a key in every occurrence that fixes its term, whatever its guard; the search fails."
			}
		]
	})
