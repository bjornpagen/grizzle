/** What the retired records property of retired.test.ts reads: its space of shapes, owners and facts, and its case. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Data,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { CompileError } from "#compiler/core/errors.ts"
import { pg, retirement } from "#compiler/public/fields.ts"
import {
	login,
	on,
	records,
	recordsFacts,
	recordsQuery,
	relation,
	retirable,
	role,
	schema,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import type { RecordOwner, RecordsRelation } from "#compiler/types/schema/records.ts"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import {
	type AttachedCase,
	attachedCaseGen,
	shelfId,
	shelvesFacts,
	shelvesRelations
} from "#test/pg/records/attached.fixtures.ts"
import { shapeQuery } from "#test/support/agreement/records.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { readOnce, writeOnce } from "#test/support/calls.ts"
import { levelNameAt } from "#test/support/compile.ts"
import { exactValue } from "#test/support/equivalence.ts"
import { shelvesNamed } from "#test/support/fixtures/records/shelves.ts"
import { type Installed, installGenerated } from "#test/support/install-migrate.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The owner of a case's records: the name of its run field, `run`, or `kind`, which a books relation carries as `kind2`,
 * its own column `kind` taking the name, and where its step stands in the owner's key: none, after the run, or before
 * it, so the run is the key's second field.
 */
export interface OwnerLayout {
	readonly run: "run" | "kind"
	readonly step: "none" | "after" | "before"
}

/** A case: the query's shape and the facts it reads (attached.fixtures.ts), and its records' owner. */
export interface RetiredCase {
	readonly attached: AttachedCase
	readonly owner: OwnerLayout
}

export const retiredCaseGen: Gen<RetiredCase> = (source) => ({
	attached: source.draw(attachedCaseGen),
	owner: {
		run: source.draw(element(["run", "kind"])),
		step: source.draw(element(["none", "after", "before"]))
	}
})

/** The owner's fields and key of a layout, each a plain integer, as Run's key is. */
const ownerOf = (
	o: OwnerLayout
): { readonly fields: RecordOwner; readonly key: readonly [string, ...Array<string>] } => {
	switch (o.step) {
		case "none":
			return { fields: { [o.run]: pg.integer }, key: [o.run] }
		case "after":
			return { fields: { [o.run]: pg.integer, step: pg.integer }, key: [o.run, "step"] }
		case "before":
			return { fields: { step: pg.integer, [o.run]: pg.integer }, key: ["step", o.run] }
	}
}

/** The owner's values at the run `run`, its step 1 where the layout has one. */
const ownerAt = (o: OwnerLayout, run: number): Readonly<Record<string, number>> =>
	o.step === "none" ? { [o.run]: run } : { [o.run]: run, step: 1 }

/** The header of the records' unit: one row per run, retired whole with every record of it. */
const Run = relation("Run", { id: pg.integer, retired: retirement }, ["id"])

/**
 * A case's query, its records and the level over Shelves that lists them with Run and their unit, retirable(Run,
 * [on(records, run)]), all under the installation's `name`.
 */
const builtAt = (c: RetiredCase, name: string) => {
	const base = shelvesNamed(name)
	const query = shapeQuery(base, c.attached.shape)
	const owner = ownerOf(c.owner)
	const kept = records("Kept", query, owner.fields, owner.key)
	const unit = retirable(Run, [on(kept, c.owner.run)])
	const level = schema.extend(
		[base],
		levelNameAt(name, 1),
		[Run, ...kept.relations],
		[...kept.rules, unit]
	)
	return { base, query, kept, owner, level }
}

/**
 * The insert of a case's records over its level: the root's relation and every relation an insert states apart, as the
 * runtime records hold them (a query built at run time types none).
 */
const keepOf = (built: ReturnType<typeof builtAt>) => {
	const apart: ReadonlyArray<{ readonly name: string }> = built.kept.apart
	return changeSetOver
		.empty(built.level)
		.insertAll(
			Rec.fromEntries(
				Arr.map([built.kept.row.name, ...Arr.map(apart, (r) => r.name)], (n) => [n, []] as const)
			)
		)
}

/** The retirement of runs over a case's level, ChangeSet.retire of Run's groups, as den's census retires its roots. */
const retireOf = (built: ReturnType<typeof builtAt>) =>
	changeSetOver.empty(built.level).retire(Run, [])

/**
 * The login over a case's level: a writer that inserts and reads every relation, the records' insert in its workload,
 * which the installation grants EXECUTE on the unit's hold for, as every served write into a body of the unit calls
 * it first; and a retirer that retires runs, granted the unit's retirement by its retire list.
 */
const recordsApp = (built: ReturnType<typeof builtAt>) => {
	const writer = role(built.level, "writer", wholeEntriesOf(built.level), {
		insert: writableNamesOf(built.level)
	})
	const retirer = role(built.level, "retirer", wholeEntriesOf(built.level), { retire: ["Run"] })
	return login(built.level, "records_app", [writer, retirer], {
		workload: [
			workload(writer, { keep: keepOf(built) }),
			workload(retirer, { retire: retireOf(built) })
		]
	})
}

/**
 * Whether a case's records hold an arm: an alternatives law over its parent's discriminator, which no retirable unit
 * takes over its bodies (schema/own.ts, "over relations no retirable statement names"), so its records are no body.
 */
export const armed = (c: RetiredCase): boolean =>
	Option.exists(c.attached.shape.books.paper, (a) => a.delivery === "arm") ||
	Option.exists(c.attached.shape.books.digital, (a) => a.delivery === "arm")

/** Whether an install's failure is the refusal of an alternatives law over a retirable unit's bodies. */
const refusesArms = (failure: { readonly message: string }): boolean =>
	failure instanceof CompileError &&
	failure.reason._tag === "MalformedDescription" &&
	Str.endsWith("over relations no retirable statement names")(failure.reason.what)

/** A case's stored rows or its read back differs from what retiring run 1 leaves. */
class RetiredDisagreed extends Data.TaggedError("RetiredDisagreed")<{
	readonly message: string
}> {}

/**
 * Each relation of the records under its name, with its rows of each run, `run:count`, in order: its field carrying the
 * run is its key's at the run's place in the owner's key, the place every relation of records carries it at.
 */
const runsOf = (
	installed: Installed,
	kept: { readonly relations: ReadonlyArray<RecordsRelation> },
	place: number
) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const counted = yield* Effect.forEach(kept.relations, (r) => {
			const field = defined(
				r.primaryKey[place],
				"a relation of records carrying the run at its place"
			)
			const column = installed.names.column(r.name, field)
			return Effect.map(
				substrate.admin.queryValues(
					`SELECT ${column}::text, count(*)::text FROM ${printObjectName(installed.names.relation(r.name))} GROUP BY 1`,
					[]
				),
				(rows) =>
					[
						r.name,
						Arr.sort(
							Arr.map(rows, (row) => Arr.join(Arr.map(row, String), ":")),
							Order.String
						)
					] as const
			)
		})
		return Rec.fromEntries(counted)
	})

/**
 * A case (see retired.test.ts): Shelves, Run and the case's records installed as one installation, its facts inserted,
 * runs 1 and 2 opened, the query's rows stored under each, and run 1 retired by the retirer's ChangeSet.retire: no
 * relation of the records then holds a row of run 1, each holds every row of run 2 it held, Run holds run 1 retired,
 * and run 2's records read back exactly the rows the query delivered.
 */
export const retiredCase = (c: RetiredCase) =>
	Effect.gen(function* () {
		const installing = yield* Effect.result(
			installGenerated(
				(name) => {
					const built = builtAt(c, name)
					return { schema: built.level, logins: [recordsApp(built)] }
				},
				{ label: "records", ambient: ordinarySession }
			)
		)
		if (armed(c)) {
			if (Result.isSuccess(installing) || !refusesArms(installing.failure)) {
				return yield* new RetiredDisagreed({
					message: `records holding an arm, a retirable body, were ${Result.isSuccess(installing) ? "installed" : `refused otherwise: ${installing.failure.message}`}; their alternatives law over the unit's bodies is refused`
				})
			}
			return { found: [], before: {} }
		}
		if (Result.isFailure(installing)) {
			return yield* Effect.fail(installing.failure)
		}
		const installed = installing.success.installed
		const at = builtAt(c, installed.declared)
		const app = recordsApp(at)
		const writer = yield* openServedDb(installed, app.roles.writer, {})
		const served = yield* writer.serve({
			source: changeSetOver
				.empty(at.base)
				.insertAll(Rec.fromEntries(Arr.map(shelvesRelations, (n) => [n, []] as const))),
			runs: changeSetOver.empty(at.level).insertAll({ Run: [] }),
			found: at.query,
			keep: keepOf(at),
			back: recordsQuery(at.level, at.kept)
		})
		const retirer = yield* openServedDb(installed, app.roles.retirer, {})
		const retiring = yield* retirer.serve({ retire: retireOf(at) })
		yield* writeOnce(member(served, "source"))({
			params: {},
			facts: { insert: shelvesFacts(c.attached.facts) }
		})
		yield* writeOnce(member(served, "runs"))({
			params: {},
			facts: { insert: { Run: [{ id: 1 }, { id: 2 }] } }
		})
		const found = yield* readOnce(member(served, "found"))({
			params: { shelf: shelfId },
			facts: {}
		})
		yield* writeOnce(member(served, "keep"))({
			params: {},
			facts: {
				insert: recordsFacts(
					at.level,
					at.kept
				)(
					Arr.flatMap(found, (row) => [
						[ownerAt(c.owner, 1), row] as const,
						[ownerAt(c.owner, 2), row] as const
					])
				)
			}
		})
		const place = at.owner.key.indexOf(c.owner.run)
		const before = yield* runsOf(installed, at.kept, place)
		yield* writeOnce(member(retiring, "retire"))({
			params: {},
			facts: { retire: { Run: [{ id: 1 }] } }
		})
		const after = yield* runsOf(installed, at.kept, place)
		const expected = Rec.map(before, (rows) =>
			Arr.filter(rows, (row) => !Str.startsWith("1:")(row))
		)
		const stored = exactValue(after, expected)
		if (Option.isSome(stored)) {
			return yield* new RetiredDisagreed({
				message: `after run 1's retirement the records hold ${Formatter.format(after)}, where they held ${Formatter.format(before)}: ${stored.value}`
			})
		}
		const substrate = yield* Substrate
		const runs = yield* substrate.admin.queryValues(
			`SELECT ${installed.names.column("Run", "id")}::text, ${installed.names.column("Run", "retired")}::text FROM ${printObjectName(installed.names.relation("Run"))} ORDER BY 1`,
			[]
		)
		const header = exactValue(
			Arr.map(runs, (row) => Arr.join(Arr.map(row, String), ":")),
			["1:true", "2:false"]
		)
		if (Option.isSome(header)) {
			return yield* new RetiredDisagreed({
				message: `after run 1's retirement Run holds ${Formatter.format(runs)}: ${header.value}`
			})
		}
		const back = yield* readOnce(member(served, "back"))({ params: ownerAt(c.owner, 2), facts: {} })
		const read = exactValue(back, found)
		if (Option.isSome(read)) {
			return yield* new RetiredDisagreed({
				message: `run 2's records read back ${Formatter.format(back)} after run 1's retirement, where the query delivered ${Formatter.format(found)}: ${read.value}`
			})
		}
		return { found, before }
	})
