/**
 * The SQL kernel's test vocabulary: the query and statement generators (test/support/kernel/sqlgen.ts), the shape
 * (test/support/kernel/shape.ts) and the one-hole walker, each over generated SQL.
 *
 * - Every generated query passes the statement audit, and every generated statement passes the statement audit over
 *   its AST and the text audit over its print. Oracle: the audits (test/support/oracle/verify/sql.ts), the SQL rules
 *   grizzle's statements keep, a specification turned into a checker.
 * - A query's shape is the same under a renaming of every alias. Oracle: the metamorphic relation itself.
 * - The root hole's rewrites come first, of kind "statement" at site 0, exactly the variant, and no other site is of
 *   that kind; every other rewrite changes exactly one site, rebuilding only the path to it and sharing every other
 *   node. Oracle: the walker's contract, checked by counting the marker and the fresh objects.
 *
 * Features: the clauses the query generator has; every statement kind and every construct an audit rule watches; a
 * relation alias renamed; each statement kind the root hole sees.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { aimedSteered } from "#test/support/aims.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	featureCount,
	type ShapeFeature,
	shapeFeatures,
	shapeOf
} from "#test/support/kernel/shape.ts"
import {
	cteInsertGen,
	selectGen,
	statementGen,
	unframedWindowGen
} from "#test/support/kernel/sqlgen.ts"
import { auditStatement } from "#test/support/oracle/verify/sql.ts"
import {
	admitted,
	catalog,
	marker,
	oneSiteEach,
	renamed,
	requiredStatementFeatures,
	rootHoleFirst,
	type AuditedStatementFeature,
	statementCatalog
} from "#test/unit/kernel/sql.fixtures.ts"

/**
 * Generated queries pass every rule of the statement audit and reach every clause the generator has.
 *
 * Budget: its suite's count before the conversion (unit/kernel/sqlgen-audit: 400 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const generatedQueriesPassEveryRuleOfTheStatementAuditAndReachEveryClauseTheGeneratorHas =
	property.explore(selectGen(catalog), {
		needs: {},
		situations: [
			"from table",
			"join",
			"union all",
			"distinct",
			"order by",
			"limit param",
			"count(*)"
		] satisfies ReadonlyArray<Reached<ShapeFeature>>,
		check: (_, c: Case<ShapeFeature>) => (query) =>
			Effect.sync(() => {
				succeeded(auditStatement(query), printStatement(query))
				c.noteAll(shapeFeatures(shapeOf(query)))
			}),
		oracle: { kind: "specification", name: "the statement audit" },
		budget: { runs: 400, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/ast.ts",
				original: '\t\t\treturn body.op !== "UNION ALL" || body.rows !== "operand"',
				replacement: '\t\t\treturn body.op !== "UNION ALL"',
				why: 'Operator mutant (disjunct) at packages/engine/src/sql/ast.ts:959 in isSetBody: `body.op !== "UNION ALL" || body.rows !== "operand"` becomes `body.op !== "UNION ALL"`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})

/**
 * Generated queries keep their shape under a renaming of every alias.
 *
 * Budget: its suite's count before the conversion (unit/kernel/shape-renaming: 200 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const generatedQueriesKeepTheirShapeUnderARenamingOfEveryAlias = property.explore(
	selectGen(catalog),
	{
		needs: {},
		situations: ["a relation alias renamed"] satisfies ReadonlyArray<
			Reached<"a relation alias renamed">
		>,
		check: (_, c: Case<"a relation alias renamed">) => (query) =>
			Effect.sync(() => {
				if (featureCount(shapeOf(query), "from table") > 0) {
					c.note("a relation alias renamed")
				}
				assert.deepEqual(shapeOf(renamed(query)), shapeOf(query))
			}),
		oracle: { kind: "universal", name: "a shape is invariant under renaming every alias" },
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/transform.ts",
				original: "\t\t\tif (isSetBody(rebuilt)) {\n\t\t\t\treturn rebuilt\n\t\t\t}",
				replacement: "\t\t\t{}",
				why: "Operator mutant (guard) at packages/engine/src/sql/transform.ts:594 in <module>: `if (isSetBody(rebuilt)) {\n\t\t\t\treturn rebuilt\n\t\t\t}` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	}
)

/**
 * Generated statements pass both audits and reach every statement kind and every construct an audit rule watches.
 *
 * Budget: its suite's count before the conversion (unit/kernel/statement-audit: 400 independent cases and 48 steered,
 * Vitest at grizzle 4ca3036a). At those counts its required situations went unreached at TEST_SEED=1 (window
 * row_number; toolchain-test run of 2026-11-16 08:21Z), so its steered phase keeps the runner's cap of 200, which it
 * stops short of once every situation is reached. Two situations its stream draws seldom are aimed: a window's ranking
 * call, which needs frames off, and a data-modifying CTE's INSERT (sqlgen.ts unframedWindowGen, cteInsertGen).
 */
export const generatedStatementsPassBothAuditsAndReachEveryStatementKindAndEveryConstructAnAuditRuleWatches =
	property.explore(
		aimedSteered(
			steered<SqlStatement, AuditedStatementFeature>(() => statementGen(statementCatalog)),
			[
				["window row_number", unframedWindowGen(statementCatalog)],
				["cte insert", cteInsertGen(statementCatalog)]
			]
		),
		{
			needs: {},
			situations: requiredStatementFeatures,
			check: (_, c: Case<AuditedStatementFeature>) => (statement) =>
				Effect.sync(() => {
					admitted(statement)
					const shape = shapeOf(statement)
					c.note(`statement ${shape.statement}`)
					c.noteAll(shapeFeatures(shape))
				}),
			oracle: { kind: "specification", name: "the statement audit and the text audit" },
			budget: { runs: 400, steered: 200 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/text.ts",
					original: `export const quoteIdent = (name: string): string => \`"\${name.replaceAll('"', '""')}"\``,
					replacement: `export const quoteIdent = (name: string): string => \`"\${name}"\``,
					why: "A quote inside an identifier is printed bare; the generated statements' audit property fails."
				}
			]
		}
	)

/**
 * The one-hole walker lists the root statement's rewrites first.
 *
 * Budget: its suite's count before the conversion (unit/kernel/root-hole: 100 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theOneHoleWalkerListsTheRootStatementsRewritesFirst = property.explore(
	statementGen(statementCatalog),
	{
		needs: {},
		situations: [
			"statement select",
			"statement insert",
			"statement update",
			"statement delete",
			"statement merge"
		] satisfies ReadonlyArray<Reached<AuditedStatementFeature>>,
		check: (_, c: Case<AuditedStatementFeature>) => (statement) =>
			Effect.sync(() => {
				rootHoleFirst(statement)
				c.note(`statement ${shapeOf(statement).statement}`)
			}),
		oracle: { kind: "specification", name: "the root hole's contract" },
		budget: { runs: 100, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/ast.ts",
				original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
				replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
				why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	}
)

/**
 * The one-hole walker changes exactly one site per rewrite, rebuilding only the path to it and sharing every other
 * node.
 *
 * Budget: its suite's count before the conversion (unit/kernel/one-hole: 200 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const theOneHoleWalkerChangesExactlyOneSitePerRewriteRebuildingOnlyThePathToItAndSharingEveryOtherNode =
	property.explore(selectGen(catalog), {
		needs: {},
		situations: ["a literal rewritten"] satisfies ReadonlyArray<Reached<"a literal rewritten">>,
		check: (_, c: Case<"a literal rewritten">) => (query) =>
			Effect.sync(() => {
				if (oneSiteEach(query, marker) > 0) {
					c.note("a literal rewritten")
				}
			}),
		oracle: {
			kind: "specification",
			name: "the marker at one site, and the fresh objects along one path"
		},
		budget: { runs: 200, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/transform.ts",
				original:
					"\t\t\treturn source === step.source && on === step.on ? step : { ...step, source, on }",
				replacement: "\t\t\treturn source === step.source ? step : { ...step, source, on }",
				why: "Operator mutant (conjunct) at packages/engine/src/sql/transform.ts:418 in <module>: `source === step.source && on === step.on` becomes `source === step.source`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
