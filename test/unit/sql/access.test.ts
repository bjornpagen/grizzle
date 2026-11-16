/**
 * The relations a statement reads and writes (sql/access.ts) beyond DML: a CREATE TEMPORARY TABLE creates its carrier,
 * an ANALYZE reads and writes the carriers it names, and a definition or a transaction statement touches none. And the
 * ANALYZE statement's schema (sql/ast.ts Analyze): it admits exactly the carrier names, and no rewrite of
 * schema-qualified names touches one.
 *
 * Oracle: each statement kind's access as its module states it (a specification); the carrier spelling as
 * test/support/sql.ts isCarrierName states it, the predicate the audit suites classify names by, held to every
 * carrierName and to named near misses, each a single edit of a carrier's spelling, beside arbitrary JSON values.
 *
 * Features: each access case; a live carrier name, a near miss, a JSON value.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { array } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { relationAccess } from "#compiler/sql/access.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { type CarrierName, carrierName } from "#compiler/sql/naming.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { assert, unorderedEqual } from "#test/support/assert.ts"
import { isCarrierName, unitCarrierName } from "#test/support/sql.ts"
import {
	type AccessCase,
	accessCaseGen,
	type AnalyzeFeature,
	namedGen,
	taskTable,
	uuidKeyed
} from "#test/unit/sql/access.fixtures.ts"

/** The relations a statement reads and writes (sql/access.ts) creates a carrier, and reads and writes the carriers an ANALYZE names; other statements touch none. */
export const theRelationsAStatementReadsAndWritesSqlAccessTsCreatesACarrierAndReadsAndWritesTheCarriersAnANALYZENamesOtherStatementsTouchNone =
	property.explore(accessCaseGen, {
		needs: {},
		situations: [
			"a carrier created",
			"carriers analyzed",
			"a definition or a transaction"
		] satisfies ReadonlyArray<Reached<AccessCase["kind"]>>,
		check: (_, c: Case<AccessCase["kind"]>) => (sketch) =>
			Effect.sync(() => {
				c.note(sketch.kind)
				switch (sketch.kind) {
					case "a carrier created": {
						const a = relationAccess({
							kind: "createCarrier",
							name: carrierName(sketch.n, uuidKeyed),
							...uuidKeyed
						})
						unorderedEqual([...a.reads], [])
						unorderedEqual([...a.writes], [carrierName(sketch.n, uuidKeyed)])
						assert.equal(a.stored, false)
						return
					}
					case "carriers analyzed": {
						const names = Arr.map(sketch.ns, unitCarrierName)
						const a = relationAccess({ kind: "analyze", carriers: names })
						unorderedEqual([...a.reads], names)
						unorderedEqual([...a.writes], names)
						assert.equal(a.stored, false)
						return
					}
					case "a definition or a transaction": {
						const a = relationAccess(
							sketch.statement === "createTable" ? taskTable : { kind: "commit" }
						)
						unorderedEqual([...a.reads], [])
						unorderedEqual([...a.writes], [])
						assert.equal(a.stored, false)
						return
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "sql/access.ts: a carrier created is written, an ANALYZE reads and writes its carriers, a definition or a transaction touches none"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/access.ts",
				original: "\t\t\t\twrites: new Set(statement.carriers),",
				replacement: "\t\t\t\twrites: new Set(),",
				why: "An ANALYZE writes none of its carriers (sql/access.ts); the access search fails."
			}
		]
	})

/** The ANALYZE statement admits exactly the carrier names, and no name rewrite touches an ANALYZE of them. */
export const theANALYZEStatementAdmitsExactlyTheCarrierNamesAndNoNameRewriteTouchesAnANALYZEOfThem =
	property.explore(array(namedGen, { min: 1, max: 3 }), {
		needs: {},
		situations: ["live", "near miss", "json"] satisfies ReadonlyArray<Reached<AnalyzeFeature>>,
		check: (_, c: Case<AnalyzeFeature>) => (names) =>
			Effect.sync(() => {
				for (const [name, carrier] of names) {
					assert.equal(isCarrierName(name), carrier, Formatter.format(name))
					c.note(carrier ? "live" : typeof name === "string" ? "near miss" : "json")
				}
				const carriers = Arr.filter(
					Arr.map(names, ([n]) => n),
					(n): n is CarrierName => isCarrierName(n)
				)
				if (!Arr.isReadonlyArrayNonEmpty(carriers)) {
					return
				}
				const analyze: SqlStatement = { kind: "analyze", carriers }
				assert.equal(
					transformStatement(analyze, {
						...identityHooks,
						objectName: (n) => ({ ...n, schema: "elsewhere" })
					}),
					analyze
				)
			}),
		oracle: {
			kind: "specification",
			name: "the carrier spelling (isCarrierName), and an ANALYZE untouched by a name rewrite"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/transform.ts",
				original: '\t\t\tcase "analyze":\n\t\t\t\treturn s',
				replacement: '\t\t\tcase "analyze":\n\t\t\t\treturn { ...s }',
				why: "A traversal copies an ANALYZE it changes nothing in (sql/transform.ts); the ANALYZE statement's search fails."
			}
		]
	})
