/**
 * A law's check is keyed by the law, not by its SQL (deploy/snapshot/violation.ts checkOf): its identity is the digest
 * of what its violation DAG asks of the rows it reads, as it reads them (ir/dag.ts meaningDigestWithin), so the
 * migration that changes a law, the rows it reads or a definition it reads checks that law again, and a migration that
 * changes only how a law lowers checks none. Each rule's check runs over every row while the app waits (the ledger
 * fence), and its SQL changes with every improvement of the lowering: keyed by its SQL, the law-reads cutover re-checked
 * all of edullm's 547 laws, 766.8 s, for a change of no law. A closed read (C.at, C.has, C.row) names its closed
 * relation and none of its facts, so the identity holds the facts each reads, its relation's key set and the payload a
 * C.at reads: keyed by the DAG alone, lowering den's Pool from two seats to one re-checked no live hold against the new
 * count, and its migration admitted the hold on seat 1 it should have refused.
 *
 * The schema: T's facts by document and place; D1 and D2, T's facts of `a` one and of `a` two; Positive, D1's `b` at
 * least a bound, and Small, D2's `b` at most 100, each a rule over a query; Tiered, a containment between the closed
 * relations TierNext and TierRank, a law the migration checks once; D3, U's facts, each of a tier; Capped, D3's `b` at
 * most its tier's cap, Listed, its tier one the closed Cap holds, and Covered, its tier among those Cap holds, each a
 * rule over a query reading Cap by a closed read alone (C.at, C.has, C.row). Each law reads what no other does, but W,
 * which every probed rule reads and no change touches.
 *
 * Property 1, one law, one identity: the schema installed in two PostgreSQL schemas, whose checks' SQL names their
 * tables apart, checks each law under one identity in both.
 *
 * Property 2, a changed law alone checked again: a second version that changes nothing, Positive's bound, D1's
 * definition, D2's, a row of TierRank, a cap of Cap, a tier Cap holds or a note of Cap, which no law reads, checks again
 * exactly the laws whose meaning the change changes (fixtures changedBy, the schema's own reads), each once.
 *
 * Oracle: a specification read off the schema, each law reading its own relation. The box, exhausted: every change,
 * with T and U immutable, each rule judged whole, or mutable in their document's unit and each definition joining W, in
 * a unit of its own, each rule probed.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { violationCheck } from "#compiler/deploy/render/sql.ts"
import type { OperandSelect } from "#compiler/sql/ast.ts"
import { sqlText, writeDoBlock } from "#compiler/sql/print.ts"
import {
	type Change,
	changedBy,
	checksIn,
	drafted,
	laws,
	lawOf,
	shapeGen
} from "#test/unit/deploy/check-identity.fixtures.ts"

/** A check as the migration spells it: its violation query's DO block (deploy/render/sql.ts violationCheck). */
const checkText = (law: LawId, query: OperandSelect): string =>
	sqlText(SourceLoc("check-identity", []), (out) => writeDoBlock(out, violationCheck(law, query)))

/** One schema installed in two PostgreSQL schemas checks each law under one identity, though its SQL differs. */
export const oneSchemaInstalledInTwoPostgreSQLSchemasChecksEachLawUnderOneIdentityThoughItsSQLDiffers =
	property.exhaust(finite(shapeGen), {
		needs: {},
		situations: ["a rule's SQL apart", "a closed law's check"] satisfies ReadonlyArray<
			Reached<Installed>
		>,
		check: (_, c: Case<Installed>) => (shape) =>
			Effect.sync(() => {
				const left = checksIn(shape, "check_identity_left")
				const right = checksIn(shape, "check_identity_right")
				const pairs = Arr.zip(
					[...left.migrations, ...left.rules],
					[...right.migrations, ...right.rules]
				)
				assert.deepEqual(
					Arr.sort(
						Arr.map(pairs, ([l]) => lawOf(l.law)),
						Order.String
					),
					Arr.sort(laws, Order.String),
					"each installation checks the schema's six laws"
				)
				for (const [l, r] of pairs) {
					assert.equal(l.law, r.law, "the two installations check their laws in one order")
					assert.equal(l.digest, r.digest, `${lawOf(l.law)}: one identity in both installations`)
				}
				for (const [l, r] of Arr.zip(left.rules, right.rules)) {
					assert.notEqual(
						checkText(l.law, l.query),
						checkText(r.law, r.query),
						`${lawOf(l.law)}: its SQL names the tables of its own installation`
					)
					c.note("a rule's SQL apart")
				}
				if (left.migrations.length > 0) {
					c.note("a closed law's check")
				}
			}),
		oracle: {
			kind: "specification",
			name: "a law's identity is the law's: two installations of one schema hold one identity per law"
		},
		box: "the schema of Positive over D1, Small over D2, Tiered over closed relations and Capped, Listed and Covered over D3 and the closed caps, T and U immutable or mutable, in two PostgreSQL schemas",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/snapshot/violation.ts",
				original:
					'\tconst identity = unwrap(meaningDigestWithin(reads.dag, [reads.root], "law-check", stated))',
				replacement:
					"\tconst identity = JSON.stringify(violationQuery(installation, law, reads), (_, x) => (typeof x === 'bigint' ? String(x) : x))",
				why: "A check is keyed by its SQL again, which names its installation's tables, so one law holds two identities, and every change of the lowering checks every law again."
			}
		]
	})

/**
 * A change of a law's meaning checks that law again, and no other: its bound, the definition it reads, a closed row it
 * reads, or a closed fact a closed read of it reads, a payload its C.at reads or a key set its C.has or C.row reads.
 */
export const aChangeOfALawsMeaningChecksThatLawAgainAndNoOther = property.exhaust(
	finite(shapeGen),
	{
		needs: {},
		situations: [
			"a bound changed",
			"a definition changed",
			"a closed row changed",
			"a payload a C.at reads changed",
			"a closed key set changed",
			"a payload no law reads changed",
			"nothing changed"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (shape) =>
			Effect.sync(() => {
				const { first, second } = drafted(shape)
				assert.deepEqual(
					Arr.sort(first, Order.String),
					Arr.sort(laws, Order.String),
					"the first draft checks every law it adds"
				)
				assert.deepEqual(
					Arr.sort(second, Order.String),
					Arr.sort(changedBy(shape.change), Order.String),
					`${shape.change}: the second draft checks again exactly the laws it changes`
				)
				c.note(featureOf(shape.change))
			}),
		oracle: {
			kind: "specification",
			name: "the schema's own reads: each law reads its own relation, so a change checks exactly the laws over what it changes"
		},
		box: "the schema of Positive over D1, Small over D2, Tiered over closed relations and Capped, Listed and Covered over D3 and the closed caps, its second version changing nothing, Positive's bound, D1's definition, D2's, a row of TierRank, a cap, a capped tier or a cap's note, T and U immutable or mutable",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/dag.ts",
				original: "\t\tObject.entries(normal.exprs).map(([id, e]) => [id, statedExpr(e, stated)])",
				replacement: "\t\t[]",
				why: "A check's identity reads no expression of its law, so Positive's new bound keeps its identity and the draft never checks the rows against it."
			},
			{
				file: "packages/engine/src/ir/dag.ts",
				original: "\t\trows: facts.rows.map((row) => read.map((r) => closedCell(row, r.position)))",
				replacement: "\t\trows: []",
				why: "A check's identity holds no closed fact its closed reads read (60b4a504a's), so a new cap and a new capped tier keep Capped's, Listed's and Covered's identities and the draft never checks the stored rows against them: den's Pool lowered from two seats to one, its migration admitted a live hold on seat 1."
			},
			{
				file: "packages/engine/src/ir/dag.ts",
				original: "key.has(column.name) || payload.includes(column.name)",
				replacement: "true",
				why: "A closed read's facts are its relation's whole rows, so a note no law reads gives Capped, Listed and Covered new identities and the draft checks the stored rows against all three again, under the ledger fence."
			}
		]
	}
)

/** What the first property reaches: a rule whose SQL names its installation's tables, and a closed law's check. */
type Installed = "a rule's SQL apart" | "a closed law's check"

/** What the second property reaches: each kind of change. */
type Feature =
	| "a bound changed"
	| "a definition changed"
	| "a closed row changed"
	| "a payload a C.at reads changed"
	| "a closed key set changed"
	| "a payload no law reads changed"
	| "nothing changed"

const featureOf = (change: Change): Feature => {
	switch (change) {
		case "none":
			return "nothing changed"
		case "bound":
			return "a bound changed"
		case "first definition":
		case "second definition":
			return "a definition changed"
		case "closed row":
			return "a closed row changed"
		case "cap":
			return "a payload a C.at reads changed"
		case "capped tier":
			return "a closed key set changed"
		case "cap note":
			return "a payload no law reads changed"
	}
}
