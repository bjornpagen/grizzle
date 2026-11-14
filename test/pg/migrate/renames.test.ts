/**
 * Declared renames through grizzle's migrations, on PostgreSQL 19rc2, generated: every rename and drop a migration
 * makes is declared (`--rename R=S`, `--rename R.f=S.g`, `--rename Roster#old=new`, `--drop`), and a declared rename is
 * drafted as a rename, so the stored data migrates with it.
 *
 * A case draws one or two relations, keyed by an integer and holding integer fields and a roster's codes, the rows
 * stored in them, and what the next version does to each name: a relation renamed or kept, each field renamed, dropped
 * or kept, a roster's handle renamed or none, and another of its handles removed or none, whose code no stored row
 * holds. The model of declared identities is the oracle, PostgreSQL the judge: a relation keeps its table (its OID) and
 * every row; a field renamed or kept keeps its column (its attribute number) and every value; a field dropped is gone
 * from the table's live columns; a renamed handle keeps its code, so a stored row of the old handle reads as the new
 * one, the old handle gone from the snapshot's codes; a removed handle's code is a hole, and every other handle keeps
 * its own. An undeclared drop is refused at the draft: the declared-identity model of test/unit/deploy/renames.test.ts
 * and the command line's project suite (test/unit/cli/project.test.ts) hold that.
 *
 * The next version serves a login whose one role holds every relation whole and reads each, every field it keeps, and
 * every stored row is read back through the login's served file (test/support/served-db.ts withServedDb), its codes
 * decoded by the codes the file holds (served/json.ts RosterWire): each row is the model's, its codes the handles the
 * next version names them by. Where a handle was removed below a code a stored row holds ("a served roster with a
 * hole"), a code after a hole is decoded end to end, so a file whose codes shift past a hole reads another handle.
 *
 * - **Property:** after the declared migration each relation keeps its table and every row, each field renamed or kept
 *   its attribute number and values, exactly the fields the schema keeps stand, every handle kept keeps its code (a
 *   renamed one its old one's), the renamed and removed handles are gone from the snapshot's codes, and every stored
 *   row reads back through the next version's served file as the model's.
 * - **Oracle:** the model of declared identities, judged by PostgreSQL's OIDs, attribute numbers and stored values, and
 *   by the served read of the stored rows.
 * - **Features:** a relation renamed, a field renamed, a field of a renamed relation renamed, a field dropped, a handle
 *   renamed, a stored code under its renamed handle, a handle removed, a served roster with a hole, and two relations.
 *   Swaps and chains of relations, fields and handles are family-renames' and histories' (test/pg/migrate), a field
 *   renamed with its type changed histories' and paths'.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): renames-handle-forgotten (the codebook draft ignores a declared handle
 * rename, so the renamed handle takes a new code).
 */
import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, int, option } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { isRecord } from "#compiler/core/record.ts"
import type { Declarations, Named, Rename } from "#compiler/deploy/diff/plan.ts"
import { codebookOf } from "#compiler/deploy/snapshot/build.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import {
	closed,
	login,
	type Relation,
	relation,
	role,
	schema,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { assert, bareRecord, defined, nonEmpty } from "#test/support/assert.ts"
import { readOnce } from "#test/support/calls.ts"
import { migrated } from "#test/support/installed.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** What the next version does to a field: keeps it, renames it, or drops it, declared. */
type Fate = "kept" | "renamed" | "dropped"

interface FieldPlan {
	readonly kind: "int4" | "code"
	readonly fate: Fate
}

interface RelationPlan {
	readonly renamed: boolean
	readonly fields: ReadonlyArray<FieldPlan>
	/** Each stored row's field values, in field order: an integer, or a handle's index for a code. */
	readonly rows: ReadonlyArray<ReadonlyArray<number>>
}

interface Plan {
	readonly relations: Arr.NonEmptyReadonlyArray<RelationPlan>
	/** The handle of Kind the next version renames, by index, or none. */
	readonly handle: Option.Option<number>
	/** The handle of Kind the next version removes, declared dropped, by index, or none: no stored row holds it. */
	readonly removed: Option.Option<number>
}

/** Kind's handles before the migration: each one's code is its index. */
const handles: readonly [string, ...Array<string>] = ["h0", "h1", "h2"]

/** A relation whose rows hold Kind's codes among `stored` alone. */
const relationGen =
	(stored: Arr.NonEmptyReadonlyArray<number>): Gen<RelationPlan> =>
	(source) => {
		const fields = source.draw(
			array(
				(inner): FieldPlan => ({
					kind: inner.draw(element(["int4", "code"] as const)),
					fate: inner.draw(element<Fate>(["kept", "renamed", "dropped"]))
				}),
				{ min: 1, max: 3 }
			)
		)
		return {
			renamed: source.draw(boolean),
			fields,
			rows: source.draw(
				array(
					(inner) =>
						Arr.map(fields, (f) =>
							f.kind === "code" ? inner.draw(element(stored)) : inner.draw(int(-9, 99))
						),
					{ min: 1, max: 3 }
				)
			)
		}
	}

/** Kind's codes before the migration, each its handle's index. */
const kindCodes = nonEmpty(
	Arr.map(handles, (_, k) => k),
	"Kind's codes"
)

const planGen: Gen<Plan> = (source) => {
	const removed = source.draw(option(element(kindCodes)))
	const kept = nonEmpty(
		Arr.filter(kindCodes, (k) => !Option.contains(removed, k)),
		"the codes the next version keeps"
	)
	const [first, ...rest] = source.draw(array(relationGen(kept), { min: 1, max: 2 }))
	return {
		relations: [defined(first, "a relation"), ...rest],
		handle: source.draw(option(element(kept))),
		removed
	}
}

/** A relation's name before the migration and after it. */
const relationName = (i: number, after: boolean, r: RelationPlan): string =>
	after && r.renamed ? `S${i}` : `R${i}`

/** A field's name before the migration and after it. */
const fieldName = (j: number, after: boolean, f: FieldPlan): string =>
	after && f.fate === "renamed" ? `b${j}` : `a${j}`

/** The handle of Kind's code `k` at a version: a renamed one under its new name after the migration, a removed one none. */
const handleAt = (p: Plan, after: boolean, k: number): Option.Option<string> =>
	after && Option.contains(p.removed, k)
		? Option.none()
		: Option.some(after && Option.contains(p.handle, k) ? `g${k}` : defined(handles[k], "a handle"))

/** Kind's handles at a version, in code order. */
const handlesAt = (p: Plan, after: boolean): readonly [string, ...Array<string>] =>
	nonEmpty(
		Arr.flatMap(kindCodes, (k) => Option.toArray(handleAt(p, after, k))),
		"Kind's handles at a version"
	)

/** The codes the next version keeps, each its handle's: every one but a removed handle's. */
const keptCodes = (p: Plan): ReadonlyArray<number> =>
	Arr.filter(kindCodes, (k) => !Option.contains(p.removed, k))

/** A relation of a version: its integer key and its fields, a code field reading the version's roster. */
type VersionRelation = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

/** Kind at a version. */
const rosterAt = (p: Plan, after: boolean) => closed("Kind", handlesAt(p, after))

const schemaOf = (
	name: string,
	relations: Readonly<Record<string, ReturnType<typeof rosterAt> | VersionRelation>>
) => schema(name, Rec.values(relations), [])

/** The schema of a version under the declared name `name`: before the migration, or after it. */
const schemaAt = (name: string, p: Plan, after: boolean) => {
	const Kind = rosterAt(p, after)
	const relations: Record<string, ReturnType<typeof rosterAt> | VersionRelation> = { Kind }
	for (const [i, r] of p.relations.entries()) {
		const fields: Record<string, FieldBase> = { id: pg.int4 }
		for (const [j, f] of r.fields.entries()) {
			if (after && f.fate === "dropped") {
				continue
			}
			fields[fieldName(j, after, f)] = f.kind === "code" ? closedId(Kind) : pg.int4
		}
		relations[relationName(i, after, r)] = relation(relationName(i, after, r), fields, ["id"])
	}
	return schemaOf(name, relations)
}

/**
 * The version after the migration under the declared name `name`, with its login `readers`, whose one role `reader`
 * holds every relation whole: what reads the stored rows back through a served file.
 */
const nextVersion = (name: string, p: Plan) => {
	const value = schemaAt(name, p, true)
	const reader = role(value, "reader", wholeEntriesOf(value))
	return { schema: value, login: login(value, "readers", [reader]) }
}

type Next = ReturnType<typeof nextVersion>

/** The query of every field the next version keeps of the relation at `i`, over the next version's schema. */
const readOf = (next: Next, r: RelationPlan, i: number) => {
	const target = defined(
		next.schema.relations[relationName(i, true, r)],
		`relation ${relationName(i, true, r)}`
	)
	return queryOver(next.schema).rule((q: RuleValue) => {
		const fact = varsOver(target, "fact")
		return q.match(target, fact).find(fact)
	})
}

/**
 * The rows the next version holds of `r`, in key order, as a served read decodes them: each a record with no prototype
 * (assert.ts bareRecord), the key, then every field it keeps under its next name, an integer as itself and a code as
 * the handle the next version names it by.
 */
const rowsAfter = (p: Plan, r: RelationPlan): ReadonlyArray<Readonly<Record<string, unknown>>> =>
	Arr.map(r.rows, (row, k) =>
		bareRecord(
			Rec.fromEntries([
				["id", k + 1] as const,
				...Arr.flatMap(r.fields, (f, j): ReadonlyArray<readonly [string, unknown]> => {
					const value = defined(row[j], `field ${j} of a row`)
					return f.fate === "dropped"
						? []
						: [
								[
									fieldName(j, true, f),
									f.kind === "code" ? Option.getOrUndefined(handleAt(p, true, value)) : value
								]
							]
				})
			])
		)
	)

/** A decoded row's key: what orders a relation's rows read back. */
const keyOfRow = (row: unknown): number => (isRecord(row) ? Number(row["id"]) : Number.NaN)

/** What the migration declares: every relation, field and handle renamed, and every field dropped. */
const declarationsOf = (p: Plan): Declarations => {
	const renames: Array<Rename> = []
	const drops: Array<Named> = []
	for (const [i, r] of p.relations.entries()) {
		const from = parsedName(relationName(i, false, r))
		const to = parsedName(relationName(i, true, r))
		if (r.renamed) {
			renames.push({
				from: { kind: "relation", relation: from },
				to: { kind: "relation", relation: to }
			})
		}
		for (const [j, f] of r.fields.entries()) {
			const field = parsedName(fieldName(j, false, f))
			if (f.fate === "dropped") {
				drops.push({ kind: "field", relation: from, field })
			}
			if (f.fate === "renamed") {
				renames.push({
					from: { kind: "field", relation: from, field },
					to: { kind: "field", relation: to, field: parsedName(fieldName(j, true, f)) }
				})
			}
		}
	}
	if (Option.isSome(p.handle)) {
		const k = p.handle.value
		renames.push({
			from: { kind: "handle", roster: parsedName("Kind"), handle: defined(handles[k], "a handle") },
			to: { kind: "handle", roster: parsedName("Kind"), handle: `g${k}` }
		})
	}
	if (Option.isSome(p.removed)) {
		drops.push({
			kind: "handle",
			roster: parsedName("Kind"),
			handle: defined(handles[p.removed.value], "a handle")
		})
	}
	return { renames, drops }
}

/** What a version reads of one relation: its table's OID, and each live field's attribute number and values. */
interface Read {
	readonly oid: string
	readonly columns: ReadonlyArray<string>
	readonly fields: ReadonlyArray<{
		readonly attnum: string
		readonly values: ReadonlyArray<string>
	}>
}

const tableOf = (schemaIdent: string, relationName: string): string =>
	`${quoteIdent(schemaIdent)}.${quoteIdent(identifierOf(identity.table(parsedName(relationName))))}`

const columnOf = (field: string): string => identifierOf(identity.column(parsedName(field)))

const texts = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<string> =>
	Arr.map(rows, (row) => String(row[0]))

/** What a version holds of the relations, read by the version's names, the dropped fields left out after it. */
const readAt = (owner: RawSession, schemaIdent: string, p: Plan, after: boolean) =>
	Effect.forEach(p.relations, (r, i) =>
		Effect.gen(function* () {
			const table = tableOf(schemaIdent, relationName(i, after, r))
			const values = (sql: string) => Effect.map(Effect.orDie(owner.values(sql, [])), texts)
			const oid = yield* values(`SELECT '${table}'::regclass::oid::int8::text`)
			const columns = yield* values(
				`SELECT a.attname::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = '${table}'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`
			)
			const standing = Arr.filter(
				Arr.map(r.fields, (f, j) => ({ f, j })),
				({ f }) => !(after && f.fate === "dropped")
			)
			const fields = yield* Effect.forEach(standing, ({ f, j }) =>
				Effect.gen(function* () {
					const column = columnOf(fieldName(j, after, f))
					const attnum = yield* values(
						`SELECT a.attnum::int4::text FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = '${table}'::regclass AND a.attname = '${column}'`
					)
					const stored = yield* values(
						`SELECT ${quoteIdent(column)}::int4::text FROM ${table} ORDER BY ${quoteIdent(columnOf("id"))}`
					)
					return { attnum: defined(attnum[0], `${column}'s attribute number`), values: stored }
				})
			)
			const read: Read = { oid: defined(oid[0], `${table}'s OID`), columns, fields }
			return read
		})
	)

/** Writes each relation's rows, as the owner, at SERIALIZABLE. */
const store = (owner: RawSession, schemaIdent: string, p: Plan) =>
	Effect.gen(function* () {
		yield* owner.query("BEGIN ISOLATION LEVEL SERIALIZABLE", [])
		for (const [i, r] of p.relations.entries()) {
			const table = tableOf(schemaIdent, relationName(i, false, r))
			const names = [
				columnOf("id"),
				...Arr.map(r.fields, (f, j) => columnOf(fieldName(j, false, f)))
			]
			for (const [k, row] of r.rows.entries()) {
				yield* owner.query(
					`INSERT INTO ${table} (${Arr.join(Arr.map(names, quoteIdent), ", ")}) VALUES (${Arr.join(
						Arr.map([k + 1, ...row], String),
						", "
					)})`,
					[]
				)
			}
		}
		yield* owner.query("COMMIT", [])
	}).pipe(Effect.orDie)

type RenameFeature =
	| "a relation renamed"
	| "a field renamed"
	| "a field of a renamed relation renamed"
	| "a field dropped"
	| "a handle renamed"
	| "a stored code under its renamed handle"
	| "a handle removed"
	| "a served roster with a hole"
	| "two relations"

const notesOf = (p: Plan): ReadonlyArray<RenameFeature> => {
	const fields = Arr.flatMap(p.relations, (r) => Arr.map(r.fields, (f) => ({ r, f })))
	return [
		...(Arr.some(p.relations, (r) => r.renamed) ? (["a relation renamed"] as const) : []),
		...(Arr.some(fields, ({ f }) => f.fate === "renamed") ? (["a field renamed"] as const) : []),
		...(Arr.some(fields, ({ r, f }) => r.renamed && f.fate === "renamed")
			? (["a field of a renamed relation renamed"] as const)
			: []),
		...(Arr.some(fields, ({ f }) => f.fate === "dropped") ? (["a field dropped"] as const) : []),
		...(Option.isSome(p.handle) ? (["a handle renamed"] as const) : []),
		...(Option.exists(p.handle, (k) =>
			Arr.some(p.relations, (r) =>
				Arr.some(r.rows, (row) =>
					Arr.some(
						row,
						(value, j) =>
							value === k &&
							Option.exists(Arr.get(r.fields, j), (f) => f.kind === "code" && f.fate !== "dropped")
					)
				)
			)
		)
			? (["a stored code under its renamed handle"] as const)
			: []),
		...(Option.isSome(p.removed) ? (["a handle removed"] as const) : []),
		...(Option.exists(p.removed, (hole) =>
			Arr.some(p.relations, (r) =>
				Arr.some(r.rows, (row) =>
					Arr.some(
						row,
						(value, j) =>
							value > hole &&
							Option.exists(Arr.get(r.fields, j), (f) => f.kind === "code" && f.fate !== "dropped")
					)
				)
			)
		)
			? (["a served roster with a hole"] as const)
			: []),
		...(p.relations.length > 1 ? (["two relations"] as const) : [])
	]
}

const renamesCase = (p: Plan, c: Case<RenameFeature>) =>
	Effect.gen(function* () {
		c.noteAll(notesOf(p))
		const reads: Array<ReadonlyArray<Read>> = []
		let schemaName = ""
		let readers: Option.Option<Next> = Option.none()
		const m = yield* migrated({
			label: "renames",
			schemaName: { kind: "unique" },
			first: (name) => {
				schemaName = name
				return { schema: schemaAt(name, p, false), logins: [] }
			},
			later: [
				(name) => {
					const next = nextVersion(name, p)
					readers = Option.some(next)
					return { schema: next.schema, logins: [next.login] }
				}
			],
			apply: { kind: "noPlaceholders" },
			declared: (v) => (v === 1 ? declarationsOf(p) : noDeclarations),
			observe: Option.some((v: number, owner: RawSession) =>
				Effect.gen(function* () {
					const ident = identifierOf(identity.schema(parsedSchemaName(schemaName)))
					if (v === 0) {
						yield* store(owner, ident, p)
					}
					const read = yield* readAt(owner, ident, p, v === 1)
					reads.push(read)
				})
			)
		})
		const before = defined(reads[0], "the first version's read")
		const after = defined(reads[1], "the second version's read")
		for (const [i, r] of p.relations.entries()) {
			const was = defined(before[i], "a relation before")
			const now = defined(after[i], "a relation after")
			assert.equal(now.oid, was.oid, "a relation keeps its table")
			const kept = Arr.filter(
				Arr.map(r.fields, (f, j) => ({ f, field: defined(was.fields[j], "a field before") })),
				({ f }) => f.fate !== "dropped"
			)
			assert.deepEqual(
				now.fields,
				Arr.map(kept, ({ field }) => field),
				"a field renamed or kept keeps its column and every value"
			)
			assert.deepEqual(
				now.columns,
				Arr.sort(
					[
						columnOf("id"),
						...Arr.flatMap(r.fields, (f, j) =>
							f.fate === "dropped" ? [] : [columnOf(fieldName(j, true, f))]
						)
					],
					Order.String
				),
				"exactly the fields the schema keeps stand, a dropped one gone"
			)
		}
		const codes = defined(
			codebookOf(m.snapshot).rosters.get(parsedName("Kind")),
			"the snapshot's codes of Kind"
		)
		assert.deepEqual<ReadonlyArray<number | undefined>>(
			Arr.map(handlesAt(p, true), (h) => codes.codeOf.get(h)),
			keptCodes(p),
			"every handle kept keeps its code, a renamed one its old one's"
		)
		if (Option.isSome(p.handle)) {
			const old = defined(handles[p.handle.value], "the renamed handle")
			assert.equal(codes.codeOf.get(old), undefined, "the old handle is gone")
		}
		if (Option.isSome(p.removed)) {
			const hole = p.removed.value
			assert.equal(
				codes.codeOf.get(defined(handles[hole], "the removed handle")),
				undefined,
				"the removed handle is gone"
			)
		}
		const next = defined(Option.getOrUndefined(readers), "the next version")
		const decoded = yield* withServedDb(m, next.login.roles.reader, {}, (db) =>
			Effect.gen(function* () {
				const served = yield* db.serve(
					Rec.fromEntries(Arr.map(p.relations, (r, i) => [`read${i}`, readOf(next, r, i)] as const))
				)
				return yield* Effect.forEach(p.relations, (_, i) =>
					readOnce(member(served, `read${i}`))({ params: {}, facts: {} })
				)
			})
		).pipe(Effect.scoped, Effect.orDie)
		for (const [i, r] of p.relations.entries()) {
			assert.deepEqual<ReadonlyArray<unknown>>(
				Arr.sortWith(defined(decoded[i], `relation ${i}'s rows`), keyOfRow, Order.Number),
				rowsAfter(p, r),
				"every stored row reads back through the served file, each code as the handle the next version names it by"
			)
		}
	})

layer(Substrate.layer)(
	"declared renames through grizzle's migrations on PostgreSQL 19rc2",
	(it) => {
		it.effect(
			"a declared rename keeps the table, the column and the code it renames, with every stored value, and a declared drop leaves exactly the fields that stand",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "pg/migrate/renames",
							draw: drawn(planGen),
							literal: Formatter.format,
							oracle: {
								kind: "postgresql",
								name: "a model of declared identities, judged by PostgreSQL's OIDs, attribute numbers and stored values"
							},
							coverage: required<RenameFeature>(
								[
									"a relation renamed",
									"a field renamed",
									"a field of a renamed relation renamed",
									"a field dropped",
									"a handle renamed",
									"a stored code under its renamed handle",
									"a handle removed",
									"a served roster with a hole",
									"two relations"
								],
								{ cases: 16, sense: notesOnly }
							),
							kept: [],
							runs: 4,
							shrink: { kind: "bounded", candidates: 30 },
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						renamesCase
					)
				)
		)
	}
)
