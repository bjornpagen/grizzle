/** What the properties of access.test.ts read: its spaces, models and helpers. */

import { element, type Gen, increasing, int, map, oneOf } from "@bjornpagen/testing/gen"
import { json } from "@bjornpagen/testing/values"
import { Array as Arr } from "effect"
import type { SqlStatement } from "#compiler/sql/ast.ts"
import { objectName, types } from "#compiler/sql/build.ts"
import { type CarrierDeclaration, carrierName } from "#compiler/sql/naming.ts"
import { unitCarrier } from "#test/support/sql.ts"

/** The written relation's name: w.task. */
const task = objectName("w", "task")

/** CREATE TABLE "w"."task" ("id" uuid NOT NULL, PRIMARY KEY ("id")). */
export const taskTable: SqlStatement = {
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
export type AccessCase =
	| { readonly kind: "a carrier created"; readonly n: number }
	| { readonly kind: "carriers analyzed"; readonly ns: Arr.NonEmptyReadonlyArray<number> }
	| { readonly kind: "a definition or a transaction"; readonly statement: "createTable" | "commit" }

/** A carrier's ordinal, as its name spells it. */
const carrier = int(1, 1000)

/**
 * A statement of each kind access.ts reads: a carrier created, an ANALYZE of distinct carriers, a definition or a
 * transaction.
 */
export const accessCaseGen: Gen<AccessCase> = oneOf<AccessCase>([
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
export const uuidKeyed: CarrierDeclaration = {
	columns: [{ name: "c1", type: types.uuid, collation: undefined, generated: undefined }],
	primaryKey: ["c1"]
}

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
export type AnalyzeFeature = "live" | "near miss" | "json"

/** A name an ANALYZE may be handed, and whether it is a carrier's. */
export const namedGen: Gen<readonly [unknown, boolean]> = oneOf<readonly [unknown, boolean]>([
	(source): readonly [unknown, boolean] => [
		carrierName(source.draw(int(1, 0x7fff_ffff)), source.draw(element([unitCarrier, uuidKeyed]))),
		true
	],
	map(element(nearMisses), (name): readonly [unknown, boolean] => [name, false]),
	map(json(3), (value): readonly [unknown, boolean] => [value, false])
])
