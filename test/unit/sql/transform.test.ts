/**
 * The SQL AST traversals (packages/engine/src/sql/transform.ts), over generated statements of every kind: a traversal that
 * changes nothing keeps the statement's identity, and a rewrite that changes a single leaf, wherever it sits, comes back
 * at that leaf's place and nowhere else, so no node keeps its old form after a child changed. For a query the visitor
 * is the second traversal the rewrite is checked against.
 *
 * Oracle: the identity law of a traversal that changes nothing, and the visitor's leaves in order (a second
 * traversal). Features: every statement kind.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { statementGen } from "#test/support/kernel/sqlgen.ts"
import { sqlCatalog } from "#test/unit/sql/audit/catalog.ts"
import { leaves, marker } from "#test/unit/sql/transform.fixtures.ts"

/**
 * The SQL AST traversals keep an unchanged statement, and rebuild exactly the changed leaf of every generated
 * statement.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/sql/transform.test.ts:55 at 8cad5bce, its runs and its coverage's cases).
 */
export const theSQLASTTraversalsKeepAnUnchangedStatementAndRebuildExactlyTheChangedLeafOfEveryGeneratedStatement =
	property.explore(statementGen(sqlCatalog), {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"statement select",
			"statement insert",
			"statement update",
			"statement delete",
			"statement merge"
		] satisfies ReadonlyArray<Reached<`statement ${SqlStatement["kind"]}`>>,
		check: (_, c: Case<`statement ${SqlStatement["kind"]}`>) => (s) =>
			Effect.sync(() => {
				assert.equal(transformStatement(s, identityHooks), s)
				const before = leaves(s)
				for (const leaf of new Set(before)) {
					const rewritten = transformStatement(s, {
						...identityHooks,
						expr: (rebuilt, original) => (original === leaf ? marker : rebuilt)
					})
					assert.deepEqual(
						Arr.map(leaves(rewritten), (e) => e === marker),
						Arr.map(before, (e) => e === leaf)
					)
				}
				c.note(`statement ${s.kind}`)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the visitor's leaves in traversal order, and identity where nothing changes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/transform.ts",
				original:
					"const kept = <L extends ReadonlyArray<unknown>>(list: L, out: L): L =>\n\tout.every((a, i) => a === list[i]) ? list : out",
				replacement: "const kept = <L extends ReadonlyArray<unknown>>(_list: L, out: L): L => out",
				why: "Every mapped list is rebuilt, changed or not; the identity law fails."
			}
		]
	})
