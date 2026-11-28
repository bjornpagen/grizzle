/**
 * A write's outcome counts a relation only insertions return rows of from its rows alone (runtime/write/outcome.ts
 * interpretRows, insertedCounts): each row is a fact its INSERT made present, so no row repeats another's fact and none
 * is made absent, and its counts are its rows' count under their insertions' tags, none of their cells read. A relation
 * any other statement returns rows of is netted by its facts' identities across the strata, as before.
 *
 * The box: Note(id, n, m), keyed by id or by (id, n), inserted alone by one ChangeSet, its insert one plain write
 * step, and every count of returned rows from none to 257. Each row the step returns is a row of the statement's width
 * whose every cell read is counted. The oracle is the rule: the counts are the rows' count, added, and no cell of a row
 * is read.
 *
 * Features: each key, no row returned, one row, many rows.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { StoredRelationName } from "#compiler/core/ids.ts"
import type { OutputText } from "#compiler/core/wire.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { interpretRows } from "#compiler/runtime/write/outcome.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/support/unit/write/changeset/fixtures.ts"
import { outputText } from "#test/support/wire.ts"

/** The keys a case declares Note by, the id first in each, so a returned row's first cell is its id. */
const keys = { "id alone": ["id"], "id and n": ["id", "n"] } as const

type KeyName = keyof typeof keys

/** A case of the box: Note's key, and how many rows its insert returns. */
interface Box {
	readonly key: KeyName
	readonly rows: number
}

type Situation = `keyed by ${KeyName}` | "no row returned" | "one row" | "many rows"

const boxGen: Gen<Box> = (source) => ({
	key: source.draw(element(["id alone", "id and n"] as const)),
	rows: source.draw(element([0, 1, 2, 17, 257] as const))
})

/** A row as Note's insert returns it, its id's text then its integers', its every cell's read counted into `reads`. */
const countedRow = (reads: { count: number }): ReadonlyArray<OutputText> =>
	new Proxy(Arr.map(["00000000-0000-7000-8000-000000000001", "1", "1"], outputText), {
		get: (target, property, receiver): unknown => {
			if (typeof property === "string" && Number.isInteger(Number(property))) {
				reads.count += 1
			}
			const value: unknown = Reflect.get(target, property, receiver)
			return value
		}
	})

/** An insertion-only relation's counts are its rows counted under their insertion's tag, and no cell of a row is read. */
export const anInsertionOnlyRelationsCountsAreItsRowsCountedUnderTheirInsertionsTagReadingNoCellOfARow =
	property.exhaust(finite(boxGen), {
		box: "Note keyed by id or by id and n, inserted alone, its insert returning none to 257 rows",
		needs: {},
		situations: [
			"keyed by id alone",
			"keyed by id and n",
			"no row returned",
			"one row",
			"many rows"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (box) =>
			Effect.sync(() => {
				const Note = relation("Note", { id: Id, n: pg.bigint, m: pg.bigint }, keys[box.key])
				const Notes = schema("Notes", [Note], [])
				const value = ChangeSet.empty(Notes).insert(Note, [
					{ id: "00000000-0000-7000-8000-000000000001", n: 1n, m: 1n }
				])
				const program = succeeded(
					compileWrite(
						checking(Notes),
						descOf(value),
						realityWrite(succeeded(testArtifacts(Notes, testCompile)))
					),
					"an insert of Note compiles"
				)
				const flight = flightOf(servableWrite(program), program.frontend.codes, noAdvice)
				const reads = { count: 0 }
				const counts = interpretRows(flight.outcome, flight.statements, (i) => {
					const statement = Arr.findFirst(flight.statements, (s) => s.index === i)
					return Option.isSome(statement) &&
						statement.value.step.kind === "write" &&
						statement.value.step.relation === StoredRelationName("Note")
						? Array.from({ length: box.rows }, () => countedRow(reads))
						: []
				}).counts
				c.note(`keyed by ${box.key}`)
				c.note(box.rows === 0 ? "no row returned" : box.rows === 1 ? "one row" : "many rows")
				assert.deepEqual(
					Arr.map(counts, (x) => ({ ...x })),
					[{ relation: StoredRelationName("Note"), added: BigInt(box.rows), deleted: 0n, put: 0n }],
					"the counts are the rows' count, added"
				)
				assert.equal(reads.count, 0, "no cell of an insertion's row is read")
			}),
		oracle: {
			kind: "specification",
			name: "an INSERT returns each fact it made present once, so its rows' count is its relation's count"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/outcome.ts",
				original:
					'\t\tsteps.every((w) => w.step.relation !== relation || w.step.result.kind === "insert")',
				replacement: "\t\tsteps.length < 0",
				why: "Every relation is netted by its facts' identities, each returned row decoded and its every cell read, where an insertion-only relation's counts need its rows' count alone."
			}
		]
	})
