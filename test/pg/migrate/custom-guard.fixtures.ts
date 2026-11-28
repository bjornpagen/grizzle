/** What the properties of custom-guard.test.ts read: the installation each case migrates and its data step. */

import { assert } from "@bjornpagen/testing/assert"

import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { type FolderTexts } from "#adapter/migrate/input.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { login } from "#compiler/program/workload/login.ts"
import { bit, int4 } from "#compiler/public/fields.ts"
import { type AnyClosed, type AnyRelation, relation, schema } from "#compiler/public/schema.ts"
import { closedBuilder } from "#compiler/schema/relation.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import type { dataSteps } from "#test/pg/migrate/custom-guard.dictionary.ts"
import { chunked, joined } from "#test/support/chunked.ts"
import { type RosterState } from "#test/support/closed/generate.ts"
import { type Version } from "#test/support/install-migrate.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { customDataStep, noDeclarations } from "#test/support/migrate/kit.ts"
import { draftNext, installFirst, setsOf } from "#test/support/pg/closed/codes.fixtures.ts"
import { apply, noFurther, openMigrator } from "#test/support/pg/migrate/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

export type DataStep = (typeof dataSteps)[number]

/** The first line of a file whose statements run alone, each in autocommit (migrate/input.ts). */
const noTransaction = "-- grizzle: no-transaction"

/**
 * An installation of Sets, an immutable relation holding a set over a roster of two handles, with one row holding
 * both: its owner's session, the table's and the set column's names, and the custom migration of `step` that rewrites
 * the row's set to the empty one, its UPDATE alone, or followed by a statement that fails (division by zero), or in a
 * no-transaction file.
 */
export const guardedInstall = (
	step: Exclude<DataStep, "at a draft's slot" | "before a roster shrink">
) =>
	Effect.gen(function* () {
		const { m } = yield* installFirst("custom_guard", (name) =>
			setsOf(name, {
				closed: parsedName("Pair"),
				slots: [
					{ kind: "live", handle: "Left" },
					{ kind: "live", handle: "Right" }
				],
				spellings: { plain: 1 }
			})
		)
		const table = printObjectName(m.names.relation("Sets"))
		const id = quoteIdent(m.names.column("Sets", "id"))
		const members = quoteIdent(m.names.column("Sets", "members"))
		yield* m.owner.query(`INSERT INTO ${table} (${id}, ${members}) VALUES (1, X'C0'::bit(8))`, [])
		const emptied = `UPDATE ${table} SET ${members} = X'00'::bit(8) WHERE ${id} = 1;`
		const written = customDataStep(
			m.snapshot,
			m.folders.length,
			step === "fails" ? [emptied, "SELECT 1 / 0;"] : [emptied]
		)
		const folder: FolderTexts =
			step === "alone"
				? {
						...written,
						files: Arr.map(written.files, (f) => ({
							...f,
							text: chunked(`${noTransaction}\n${joined(f.text)}`)
						}))
					}
				: written
		/** The set the row holds, as PostgreSQL's text. */
		const held = Effect.map(
			m.owner.values(`SELECT ${members}::text FROM ${table} WHERE ${id} = 1`, []),
			(rows) => Arr.map(rows, (r) => String(r[0]))
		)
		/** The owner's UPDATE of the row outside any migration, which the guard refuses. */
		const ownerUpdate = m.owner.query(
			`UPDATE ${table} SET ${members} = X'80'::bit(8) WHERE ${id} = 1`,
			[]
		)
		/** The data step migrated through the runner, as the installation's owner. */
		const migrate = Effect.gen(function* () {
			const substrate = yield* Substrate
			const migrator = yield* openMigrator(substrate, m.ambientOwner.credentials)
			return yield* apply(
				migrator,
				{ snapshot: m.snapshot, folders: [...m.folders, folder] },
				noFurther
			)
		})
		return { table: m.names.relation("Sets"), held, ownerUpdate, migrate }
	})

/**
 * A draft whose Structure holds a data-step slot for a table other than the one the reviewer's data step writes: Sets,
 * an immutable relation holding a set over a roster of two handles, one row holding both, beside Other, an immutable
 * relation the next version adds a field to, which the draft fills by its placeholder after SET CONSTRAINTS ALL
 * IMMEDIATE, the slot (deploy/diff/diff.ts unguard). The reviewer's data step, written at that slot, rewrites Sets'
 * row's set to the empty one: the draft brackets every table the installation guards and the next version keeps, never
 * only the ones its own steps write, so Sets' guard is disabled there and enabled again after it.
 */
export const draftedSlot = Effect.gen(function* () {
	const pair = closedBuilder(parsedName("Pair"), ["Left", "Right"], "ordered", [])
	const versionOf = (name: string, grown: boolean): Version => {
		const Sets = relation("Sets", { id: int4, members: bit(pair) }, ["id"])
		const Other = grown
			? relation("Other", { id: int4, n: int4 }, ["id"])
			: relation("Other", { id: int4 }, ["id"])
		const declared: Record<string, AnyRelation | AnyClosed> = { Pair: pair, Sets, Other }
		const base = schema(name, Rec.values(declared), [])
		const writer = role(base, "writer", { Sets, Other }, { insert: ["Sets", "Other"] })
		return { schema: base, logins: [login(base, "desk", [writer])] }
	}
	const { m } = yield* installFirst("drafted_guard", (name) => ({
		version: versionOf(name, false)
	}))
	const table = printObjectName(m.names.relation("Sets"))
	const id = quoteIdent(m.names.column("Sets", "id"))
	const members = quoteIdent(m.names.column("Sets", "members"))
	yield* m.owner.query(`INSERT INTO ${table} (${id}, ${members}) VALUES (1, X'C0'::bit(8))`, [])
	yield* m.owner.query(
		`INSERT INTO ${printObjectName(m.names.relation("Other"))} (${quoteIdent(m.names.column("Other", "id"))}) VALUES (1)`,
		[]
	)
	const next = yield* draftNext(
		m,
		m.snapshot,
		versionOf(m.declared, true),
		m.folders.length + 1,
		noDeclarations
	)
	const step = `UPDATE ${table} SET ${members} = X'00'::bit(8) WHERE ${id} = 1;`
	const immediate = "SET CONSTRAINTS ALL IMMEDIATE;"
	const slotted = Arr.findFirstIndex(next.folder.files, (f) =>
		Str.includes(immediate)(joined(f.text))
	)
	assert.ok(Option.isSome(slotted), "the draft holds a data-step slot")
	const folder: FolderTexts = {
		...next.folder,
		files: Arr.map(next.folder.files, (f) =>
			Str.includes(immediate)(joined(f.text))
				? { ...f, text: chunked(Str.replace(immediate, `${immediate}\n${step}`)(joined(f.text))) }
				: f
		)
	}
	const held = Effect.map(
		m.owner.values(`SELECT ${members}::text FROM ${table} WHERE ${id} = 1`, []),
		(rows) => Arr.map(rows, (r) => String(r[0]))
	)
	const ownerUpdate = m.owner.query(
		`UPDATE ${table} SET ${members} = X'80'::bit(8) WHERE ${id} = 1`,
		[]
	)
	const migrate = Effect.gen(function* () {
		const substrate = yield* Substrate
		const migrator = yield* openMigrator(substrate, m.ambientOwner.credentials)
		return yield* apply(
			migrator,
			{ snapshot: next.snapshot, folders: [...m.folders, folder] },
			noFurther
		)
	})
	return { held, ownerUpdate, migrate }
})

/**
 * A roster shrink under an immutable relation holding a set over it, its data step first: Sets holding one row of both
 * Left and Right, a custom migration whose data step clears Left's bit, then the migration that removes Left, applied
 * together, where the removal's VALIDATE refuses a set still holding Left. The data step rewrites Sets' row inside its
 * bracket, so the removal finds no row holding the removed code.
 */
export const shrinkAfterDataStep = Effect.gen(function* () {
	const stateOf = (left: "live" | "hole"): RosterState => ({
		closed: parsedName("Pair"),
		slots: [
			left === "live" ? { kind: "live", handle: "Left" } : { kind: "hole", was: "Left" },
			{ kind: "live", handle: "Right" }
		],
		spellings: { plain: 1 }
	})
	const { m } = yield* installFirst("shrink_guard", (name) => setsOf(name, stateOf("live")))
	const table = printObjectName(m.names.relation("Sets"))
	const id = quoteIdent(m.names.column("Sets", "id"))
	const members = quoteIdent(m.names.column("Sets", "members"))
	yield* m.owner.query(`INSERT INTO ${table} (${id}, ${members}) VALUES (1, X'C0'::bit(8))`, [])
	const step = customDataStep(m.snapshot, m.folders.length, [
		`UPDATE ${table} SET ${members} = ${members} & X'40'::bit(8);`
	])
	const removal = yield* draftNext(
		m,
		m.snapshot,
		setsOf(m.declared, stateOf("hole")).version,
		m.folders.length + 2,
		{ renames: [], drops: [{ kind: "handle", roster: parsedName("Pair"), handle: "Left" }] }
	)
	const held = Effect.map(
		m.owner.values(`SELECT ${members}::text FROM ${table} WHERE ${id} = 1`, []),
		(rows) => Arr.map(rows, (r) => String(r[0]))
	)
	const ownerUpdate = m.owner.query(
		`UPDATE ${table} SET ${members} = X'00'::bit(8) WHERE ${id} = 1`,
		[]
	)
	const migrate = Effect.gen(function* () {
		const substrate = yield* Substrate
		const migrator = yield* openMigrator(substrate, m.ambientOwner.credentials)
		return yield* apply(
			migrator,
			{ snapshot: removal.snapshot, folders: [...m.folders, step, removal.folder] },
			noFurther
		)
	})
	return { held, ownerUpdate, migrate }
})
