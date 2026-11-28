/** What session-domains.test.ts reads: its versions, its box, and each case's write, migration and checks. */

import { assert } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic } from "#compiler/public/compute.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	login,
	mutable,
	on,
	relation,
	role,
	schema,
	select,
	unit
} from "#compiler/public/schema.ts"
import { writeOnce } from "#test/support/calls.ts"
import {
	generatedHistory,
	noPlaceholders,
	type Review,
	type Version
} from "#test/support/install-migrate.ts"
import { migrated, noObservation } from "#test/support/installed.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { apply, noFurther, openMigrator, refusal } from "#test/support/pg/migrate/support.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * How the second version changes Words, the contract the notes' count `n` is typed by: its least value raised, its
 * base widened from integer to bigint, or the field dropped with it.
 */
export type Change = "tightened" | "retyped" | "dropped"

/**
 * A case: the change, and whether another client's session, the owner's direct one, holds a temporary table of its own
 * typed by Words, as no grizzle session does.
 */
export interface DomainCase {
	readonly change: Change
	readonly foreign: boolean
}

export const domainCases: Gen<DomainCase> = (s) => ({
	change: s.draw(element<Change>(["tightened", "retyped", "dropped"])),
	foreign: s.draw(boolean)
})

export type SessionDomainFeature =
	| `a migration that ${Change} a domain a live judge delta holds`
	| "a migration refused for another client's temporary table, naming it"

/** The writer of the notes and its put of them from a relation parameter. */
const writerOf = (base: ReturnType<typeof firstBase>) => {
	const Note = base.relations.Note
	const writer = role(base, "writer", { Note }, { write: ["Note"] })
	const put = ChangeSet.empty(writer).put(
		Note,
		query(writer).rule((q) => {
			const rows = q.relation("rows", { k: Note.fields.k, n: Note.fields.n })
			const { k, n } = v(Note, "note")
			return q.match(rows, { k, n }).find({ k, n })
		})
	)
	return { writer, put }
}

/** The marks, keyed by `k`, mutable inside the notes' unit: what a note of a negative key is held to. */
const Mark = relation("Mark", { k: pg.integer }, ["k"])

const wordsKey = Symbol("Words")
/**
 * The first version's base: the notes, keyed by `k`, mutable inside the unit of their key, `n` of Words, at least 0; the
 * marks; and Marked, each note of a negative key at a mark of its key, a containment of a selected side, which the rule
 * judge holds whole at every COMMIT (laws/model/plan.ts containmentDischarge), so a session's first write of the notes
 * stands up its deltas of them, temporary tables of the session whose columns are the notes' heading, `n` among them
 * (physical/ddl/deltas.ts sessionDeltaOf).
 */
const firstBase = (name: string) => {
	const Words = contract<typeof wordsKey>()("Words", pg.integer, (x) => Logic.ge(x, 0))
	const Note = relation("Note", { k: pg.integer, n: Words }, ["k"])
	return schema(
		name,
		[Note, Mark],
		[
			unit("Notes", { k: pg.integer }),
			mutable(Note),
			mutable(Mark),
			contained(
				on(
					select(Note, (x) => x.lt(x.k, 0)),
					"k"
				),
				on(Mark, "k")
			)
		]
	)
}

/** The first version: the login `desk` of the writer, serving its put. */
const firstOf = (name: string) => {
	const base = firstBase(name)
	const { writer, put } = writerOf(base)
	const desk = login(base, "desk", [writer], { workload: [workload(writer, { put })] })
	const version: Version = { schema: base, logins: [desk] }
	return { version, desk, put }
}

const wordsKey2 = Symbol("Words")
const wordsKey3 = Symbol("Words")
/**
 * The second version, Words changed as `change` says, the marks kept and Marked gone with the judge's objects, the login
 * of a writer of the notes with no workload.
 */
const secondOf =
	(change: Change) =>
	(name: string): Version => {
		switch (change) {
			case "tightened": {
				const Words = contract<typeof wordsKey2>()("Words", pg.integer, (x) => Logic.ge(x, 1))
				const Note = relation("Note", { k: pg.integer, n: Words }, ["k"])
				const base = schema(
					name,
					[Note, Mark],
					[unit("Notes", { k: pg.integer }), mutable(Note), mutable(Mark)]
				)
				return {
					schema: base,
					logins: [login(base, "desk", [role(base, "writer", { Note }, { write: ["Note"] })])]
				}
			}
			case "retyped": {
				const Words = contract<typeof wordsKey3>()("Words", pg.bigint, (x) => Logic.ge(x, 0n))
				const Note = relation("Note", { k: pg.integer, n: Words }, ["k"])
				const base = schema(
					name,
					[Note, Mark],
					[unit("Notes", { k: pg.integer }), mutable(Note), mutable(Mark)]
				)
				return {
					schema: base,
					logins: [login(base, "desk", [role(base, "writer", { Note }, { write: ["Note"] })])]
				}
			}
			case "dropped": {
				const Note = relation("Note", { k: pg.integer }, ["k"])
				const base = schema(
					name,
					[Note, Mark],
					[unit("Notes", { k: pg.integer }), mutable(Note), mutable(Mark)]
				)
				return {
					schema: base,
					logins: [login(base, "desk", [role(base, "writer", { Note }, { write: ["Note"] })])]
				}
			}
		}
	}

/** What the second version declares: the dropped field `n`, where it drops it. */
const declaredOf =
	(change: Change) =>
	(version: number): Declarations =>
		version === 1 && change === "dropped"
			? {
					renames: [],
					drops: [{ kind: "field", relation: parsedName("Note"), field: parsedName("n") }]
				}
			: noDeclarations

/** The reviewer's value of the one placeholder a version drafts: the retyped count's conversion, from its own value. */
const reviewOf = (change: Change): Review =>
	change === "retyped"
		? {
				kind: "values",
				value: () => `${quoteIdent(identifierOf(identity.column(parsedName("n"))))}::bigint`
			}
		: noPlaceholders

/**
 * A case: installs the first version through its migration; opens a Db of the writer and puts a note through it, which
 * stands up the rule judge's deltas of the notes in the Db's pooled session, temporary tables of the session that stand
 * until the session ends, `n` a column of them; then, with that session resting in the pool, migrates to the second
 * version by the real runner, which changes Words as the case says. The oracle: the migration commits, PostgreSQL
 * refusing none of its statements: no column of a delta is typed by Words, so no drop of Words (2BP01, "column n of
 * table pg_temp_N.__delta_... depends on type") meets the session, nor a constraint added to it ("cannot access
 * temporary tables of other sessions"). Where another client's session holds a temporary table typed by Words, the migration is refused
 * at that drop, 2BP01, and the refusal names the session's temporary object as its cause, never drift
 * (adapter/migrate/errors.ts StatementFailed `drifted`).
 */
export const sessionDomainCase = ({ change, foreign }: DomainCase, c: Case<SessionDomainFeature>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const built: Array<ReturnType<typeof firstOf>> = []
		const first = (name: string): Version => {
			const drawn = firstOf(name)
			built.push(drawn)
			return drawn.version
		}
		const m = yield* migrated({
			label: "session_domains",
			schemaName: { kind: "unique" },
			first,
			later: [],
			apply: noPlaceholders,
			declared: () => noDeclarations,
			observe: noObservation
		})
		const at = built[0]
		assert.ok(at !== undefined, "the first version was built")
		const db = yield* openServedDb(m, at.desk.roles.writer, {})
		const served = yield* db.serve({ put: at.put })
		yield* writeOnce(member(served, "put"))({ params: { rows: [{ k: 1, n: 5 }] }, facts: {} })
		const [held] = yield* substrate.admin.queryValues(
			"SELECT count(*)::int4 FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid WHERE n.nspname ~ '^pg_temp_[0-9]+$' AND c.relname LIKE '\\_\\_delta\\_%' AND c.relkind = 'r' AND a.attname = $1 AND NOT a.attisdropped",
			[m.installation.names.column("Note", "n")]
		)
		assert.ok(
			Number(held?.[0]) > 0,
			"the put stood the judge's deltas of the notes up in its session, n among their columns"
		)
		const versions = [at.version, secondOf(change)(m.declared)] as const
		const steps = yield* Effect.orDie(
			generatedHistory(
				Arr.map(versions, (version, i) => () => ({
					schema: version.schema,
					logins: version.logins,
					declarations: declaredOf(change)(i)
				})),
				m.declared,
				reviewOf(change)
			)
		)
		const migrator = yield* openMigrator(substrate, m.ambientOwner.credentials)
		const [, second] = steps
		assert.ok(second !== undefined, "the second version was drafted")
		const migration = apply(
			migrator,
			{ snapshot: second.snapshot, folders: Arr.map(steps, (s) => s.folder) },
			noFurther
		)
		if (!foreign) {
			yield* migration
			c.note(`a migration that ${change} a domain a live judge delta holds`)
			return
		}
		const table = m.installation.names.relation("Note")
		const owner = yield* substrate.session({ ...ownerSession(), label: "a client of its own" })
		yield* owner.query(
			`CREATE TEMPORARY TABLE pg_temp.held AS SELECT ${quoteIdent(m.installation.names.column("Note", "n"))} FROM ${quoteIdent(table.schema)}.${quoteIdent(table.name)} WITH NO DATA`,
			[]
		)
		const refused = yield* refusal(migration)
		assert.ok(
			refused.reason._tag === "StatementFailed" && !refused.reason.drifted,
			`the migration is refused at a statement, as no drift: ${refused.message}`
		)
		assert.ok(
			Str.includes("another session's temporary object")(refused.message),
			`the refusal names another session's temporary object: ${refused.message}`
		)
		c.note("a migration refused for another client's temporary table, naming it")
	})
