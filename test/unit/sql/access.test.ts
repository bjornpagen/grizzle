import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, map, oneOf, uniqueArray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { json } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { relationAccess } from "#compiler/sql/access.ts"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { objectName, types } from "#compiler/sql/build.ts"
import { type CarrierName, carrierName } from "#compiler/sql/naming.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import { typesDigest } from "#compiler/write/carriers/carriers.ts"
import { assert, unorderedEqual } from "#test/support/assert.ts"
import { unitCarrier } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { isCarrierName } from "#test/support/sql.ts"

/**
 * The relations a statement reads and writes (sql/access.ts) beyond DML: a CREATE TEMPORARY TABLE creates its carrier,
 * an ANALYZE reads and writes the carriers it names, and a definition or a transaction statement touches none. And the
 * ANALYZE statement's schema (sql/ast.ts Analyze): it admits exactly the carrier names, and no rewrite of
 * schema-qualified names touches one.
 */
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
		const first = source.draw(carrier)
		const more = source.draw(uniqueArray(carrier, (n) => n, { min: 0, max: 3 }, 10))
		return { kind: "carriers analyzed", ns: [first, ...Arr.filter(more, (n) => n !== first)] }
	},
	map(element(["createTable", "commit"] as const), (statement): AccessCase => ({
		kind: "a definition or a transaction",
		statement
	}))
])

describe("the relations a statement reads and writes (sql/access.ts)", () => {
	it.effect(
		"creates a carrier, and reads and writes the carriers an ANALYZE names; other statements touch none",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
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
										name: unitCarrier(sketch.n),
										primaryKey: ["c1"],
										columns: [
											{
												name: "c1",
												type: types.uuid,
												collation: undefined,
												generated: undefined
											}
										]
									})
									unorderedEqual([...a.reads], [])
									unorderedEqual([...a.writes], [unitCarrier(sketch.n)])
									assert.equal(a.stored, false)
									return
								}
								case "carriers analyzed": {
									const names = Arr.map(sketch.ns, unitCarrier)
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
 * it spells carrierName(digest, n) for a types digest and some n from 1, whatever else a snapshot file can hold, and no
 * rewrite of schema-qualified names touches one.
 */
const digest = typesDigest("[]")
const nearMisses = [
	`__carrier_${digest}_0`,
	`__carrier_${digest}_01`,
	`__carrier_${digest}_`,
	`__carrier_${digest}_x`,
	`__carrier_${digest}_-1`,
	`__carrier_${digest}_1 `,
	` __carrier_${digest}_1`,
	`__Carrier_${digest}_1`,
	`__carrier_${digest}_1.0`,
	`__carrier_${digest}_${2 ** 53}`,
	`__carrier_${Str.toUpperCase(digest)}_1`,
	`__carrier_${Str.slice(1)(digest)}_1`,
	`__carrier_${digest}0_1`,
	`__carrier_${digest}1`,
	`carrier_${digest}_1`,
	"__carrier_1",
	"__carrier_",
	"task",
	""
] as const
/** What an ANALYZE case drew: a carrier name, a string that misses one, or any JSON value. */
type AnalyzeFeature = "live" | "near miss" | "json"

/** A name an ANALYZE may be handed, and whether it is a carrier's. */
const namedGen: Gen<readonly [unknown, boolean]> = oneOf<readonly [unknown, boolean]>([
	(source): readonly [unknown, boolean] => [
		carrierName(
			typesDigest(String(source.draw(int(0, 0x7fff_ffff)))),
			source.draw(int(1, 0x7fff_ffff))
		),
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
						oracle: { kind: "unstated" },
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
