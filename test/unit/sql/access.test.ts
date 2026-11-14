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
 *
 * Plants, each failing its search: an ANALYZE writing none of its carriers (access-analyze-writes); a traversal copying
 * an ANALYZE it changes nothing in (transform-analyze-copied).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, increasing, int, map, oneOf } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { json } from "@bjornpagen/testing/values"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { relationAccess } from "#compiler/sql/access.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { objectName, types } from "#compiler/sql/build.ts"
import { type CarrierDeclaration, type CarrierName, carrierName } from "#compiler/sql/naming.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { assert, unorderedEqual } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { isCarrierName, unitCarrier, unitCarrierName } from "#test/support/sql.ts"

const task = objectName("w", "task")

/** CREATE TABLE "w"."task" ("id" uuid NOT NULL, PRIMARY KEY ("id")). */
const taskTable: SqlStatement = {
	kind: "createTable",
	table: task,
	columns: [{ name: "id", type: types.uuid, collation: undefined, generated: undefined }],
	primaryKey: {
		kind: "primaryKey",
		name: "task_key",
		columns: [{ column: "id", withoutOverlaps: false }]
	},
	secondary: []
}

/**
 * relationAccess once ended in `default: return none`, so a statement kind added to the AST accessed nothing unless
 * someone remembered it; the carrier's own statement kind is the case that would have slipped through.
 */
type AccessCase =
	| { readonly kind: "a carrier created"; readonly n: number }
	| { readonly kind: "carriers analyzed"; readonly ns: Arr.NonEmptyReadonlyArray<number> }
	| { readonly kind: "a definition or a transaction"; readonly statement: "createTable" | "commit" }

const carrier = int(1, 1000)

const accessCaseGen: Gen<AccessCase> = oneOf<AccessCase>([
	map(carrier, (n): AccessCase => ({ kind: "a carrier created", n })),
	(source): AccessCase => {
		/** The others drawn distinct below the top ordinal, then shifted past the first: distinct by construction. */
		const first = source.draw(carrier)
		const more = source.draw(increasing(1, 999, { min: 0, max: 3 }))
		return {
			kind: "carriers analyzed",
			ns: [first, ...Arr.map(more, (n) => (n >= first ? n + 1 : n))]
		}
	},
	map(element(["createTable", "commit"] as const), (statement): AccessCase => ({
		kind: "a definition or a transaction",
		statement
	}))
])

/** A carrier's declaration: one uuid column, c1, its key. */
const uuidKeyed: CarrierDeclaration = {
	columns: [{ name: "c1", type: types.uuid, collation: undefined, generated: undefined }],
	primaryKey: ["c1"]
}

describe("the relations a statement reads and writes (sql/access.ts)", () => {
	it.effect(
		"creates a carrier, and reads and writes the carriers an ANALYZE names; other statements touch none",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "sql/access.ts: a carrier created is written, an ANALYZE reads and writes its carriers, a definition or a transaction touches none"
						},
						suite: "unit/sql/access",
						draw: drawn(accessCaseGen),
						literal: Formatter.format,
						coverage: required<AccessCase["kind"]>(
							["a carrier created", "carriers analyzed", "a definition or a transaction"],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
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
						})
				)
			)
	)
})

/**
 * The ANALYZE statement names carriers only: a name read from outside (a persisted snapshot) is a carrier exactly when
 * it spells carrierName(n, declaration) for some n from 1 and some declaration, whatever else a snapshot file can hold, and no rewrite of schema-qualified
 * names touches one.
 */
const nearMisses = [
	"__carrier_1",
	"__carrier_0_abcdefghij",
	"__carrier_01_abcdefghij",
	"__carrier_1_abcdefghi",
	"__carrier_1_abcdefghijk",
	"__carrier_1_abcdefghi1",
	"__carrier_1_ABCDEFGHIJ",
	"__carrier__abcdefghij",
	"__carrier_0",
	"__carrier_01",
	"__carrier_",
	"__carrier_x",
	"__carrier_-1",
	"__carrier_+1",
	"__carrier_1 ",
	" __carrier_1",
	"__Carrier_1",
	"__carrier_1.0",
	"__carrier_1e3",
	`__carrier_${2 ** 53}`,
	"__carrier__1",
	"carrier_1",
	"task",
	""
] as const
/** What an ANALYZE case drew: a carrier name, a string that misses one, or any JSON value. */
type AnalyzeFeature = "live" | "near miss" | "json"

/** A name an ANALYZE may be handed, and whether it is a carrier's. */
const namedGen: Gen<readonly [unknown, boolean]> = oneOf<readonly [unknown, boolean]>([
	(source): readonly [unknown, boolean] => [
		carrierName(source.draw(int(1, 0x7fff_ffff)), source.draw(element([unitCarrier, uuidKeyed]))),
		true
	],
	map(element(nearMisses), (name): readonly [unknown, boolean] => [name, false]),
	map(json(3), (value): readonly [unknown, boolean] => [value, false])
])

describe("the ANALYZE statement", () => {
	it.effect(
		"admits exactly the carrier names, and no name rewrite touches an ANALYZE of them",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the carrier spelling (isCarrierName), and an ANALYZE untouched by a name rewrite"
						},
						suite: "unit/sql/analyze-carriers",
						draw: drawn(array(namedGen, { min: 1, max: 3 })),
						literal: Formatter.format,
						coverage: required<AnalyzeFeature>(["live", "near miss", "json"], {
							cases: 300,
							sense: notesOnly
						}),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(names, c) =>
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
						})
				)
			)
	)
})
