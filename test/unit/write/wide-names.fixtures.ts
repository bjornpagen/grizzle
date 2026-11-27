/** What the properties of wide-names.test.ts read: its spaces, models and helpers. */

import { int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { isList, isRecord } from "#compiler/core/record.ts"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { pg } from "#compiler/public/fields.ts"
import { key, on, schema } from "#compiler/public/schema.ts"
import { relationBuilder } from "#compiler/schema/relation.ts"
import { printedOnce } from "#compiler/sql/print-once.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { type AskedName, plannerNamesOf, unaliasedName } from "#test/support/planner-names.ts"
import { checking, owning } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"

/**
 * A box's step: the write's relations at n, 2n and 3n. A write of one relation is no write of parts alike (its statement
 * holds one part beside nothing it shares), so the smallest step is two.
 */
export const step = int(2, 3)

/** One statement of a compiled write: its AST nodes as it is printed and the names PostgreSQL 19 asks planning it. */
export interface Planned {
	readonly nodes: number
	readonly asked: ReadonlyArray<AskedName>
}

/** The nodes of an AST as plain data: every list, record and value one, a list's and a record's children's beside. */
const nodesOf = (v: unknown): number =>
	v === undefined
		? 0
		: isList(v)
			? Arr.reduce(v, 1, (n, x) => n + nodesOf(x))
			: isRecord(v)
				? Arr.reduce(Rec.values(v), 1, (n, x) => n + nodesOf(x))
				: 1

/**
 * The statements of one insert of a fact into each of `n` relations R0..R(n-1), each keyed by its integer `id` and
 * keyed again by `ref`, so each relation's part of the write's one statement is the guarded insert of new keys
 * (write/insert/protocol.ts): its rows, the unique probe at `ref` and its refusal, the INSERT of new keys and the
 * outcome rows.
 */
export const wideInsert = (n: number): ReadonlyArray<Planned> => {
	const relations = upTo(n, (i) =>
		relationBuilder(`R${i}`, { id: pg.integer, ref: pg.integer, v: pg.integer }, ["id"], [])
	)
	const wide = schema(
		"W",
		relations,
		Arr.map(relations, (r) => key(on(r, "ref")))
	)
	const owned = owning(wide)
	const names = succeeded(
		compileInstallation(owned, {
			...installOptions(owned),
			levels: [identity.schema(parsedSchemaName("w"))]
		})
	).names
	const artifacts = succeeded(testArtifacts(wide, testCompile))
	const facts = Rec.fromEntries(upTo(n, (i) => [`R${i}`, [{ id: 1, ref: 2, v: 3 }]] as const))
	const compiled = succeeded(
		compileWrite(checking(wide), descOf(ChangeSet.empty(wide).insertAll(facts)), {
			names,
			reads: names,
			claims: { kind: "every" },
			world: { kind: "reality" },
			laws: artifacts.laws,
			derived: artifacts.derived,
			level: "serializable",
			clock: noClock,
			source: transactionClock
		})
	)
	return Arr.map(compiled.artifact.statements, (s) => ({
		nodes: nodesOf(printedOnce(s.ast)),
		asked: plannerNamesOf(s.ast)
	}))
}

/** The names `planned` asks under `name`, every statement's. */
export const asking = (planned: ReadonlyArray<Planned>, name: string): number =>
	Arr.reduce(planned, 0, (sum, p) => sum + Arr.filter(p.asked, (a) => a.name === name).length)

/** The names `planned` asks, every statement's. */
export const asked = (planned: ReadonlyArray<Planned>): number =>
	Arr.reduce(planned, 0, (sum, p) => sum + p.asked.length)

/** The AST nodes of `planned` as printed, every statement's. */
export const printedNodes = (planned: ReadonlyArray<Planned>): number =>
	Arr.reduce(planned, 0, (sum, p) => sum + p.nodes)

/**
 * The names `planned` asks under PostgreSQL 19's fixed name for a sub-query without an alias anywhere but at an append
 * relation's leaf: an INSERT's source planned apart, or a sub-query aliased so. None where every INSERT reads its rows
 * under a name of its statement's own.
 */
export const unaliasedOutsideLeaves = (planned: ReadonlyArray<Planned>): ReadonlyArray<AskedName> =>
	Arr.flatMap(planned, (p) =>
		Arr.filter(p.asked, (a) => a.name === unaliasedName && a.site !== "leaf")
	)

/** The families of names PostgreSQL 19 asks again and again: each always numbered, and the unaliased one. */
export const families: ReadonlyArray<string> = [
	unaliasedName,
	"setop",
	"exists",
	"exists_to_any",
	"array",
	"expr",
	"any"
]
