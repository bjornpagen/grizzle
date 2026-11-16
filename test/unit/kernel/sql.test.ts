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
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { printStatement } from "#compiler/sql/print.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import {
	featureCount,
	type ShapeFeature,
	shapeFeatures,
	shapeOf
} from "#test/support/kernel/shape.ts"
import { selectGen, statementGen } from "#test/support/kernel/sqlgen.ts"
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

/** Generated queries pass every rule of the statement audit and reach every clause the generator has. */
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
		kept: [],
		kills: []
	})

/** Generated queries keep their shape under a renaming of every alias. */
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
		kept: [],
		kills: []
	}
)

/** Generated statements pass both audits and reach every statement kind and every construct an audit rule watches. */
export const generatedStatementsPassBothAuditsAndReachEveryStatementKindAndEveryConstructAnAuditRuleWatches =
	property.explore(statementGen(statementCatalog), {
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
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: `export const quoteIdent = (name: string): string => \`"\${name.replaceAll('"', '""')}"\``,
				replacement: `export const quoteIdent = (name: string): string => \`"\${name}"\``,
				why: "A quote inside an identifier is printed bare; the generated statements' audit property fails."
			}
		]
	})

/** The one-hole walker lists the root statement's rewrites first. */
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
		kept: [],
		kills: []
	}
)

/** The one-hole walker changes exactly one site per rewrite, rebuilding only the path to it and sharing every other node. */
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
		kept: [],
		kills: []
	})
