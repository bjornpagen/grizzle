import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Option } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	context,
	derived,
	login,
	mutable,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, defined } from "#test/support/assert.ts"
import { checkInstalled, installedScope } from "#test/support/catalog/installed.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import {
	migrated,
	type Version,
	withDb,
	withDbClaims,
	worldRoleOf
} from "#test/support/installed.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"

/** What a version holds, each a knob a case turns.
 *
 * Worlds across migrations on PostgreSQL 19: each case migrates one version of a schema with worlds to a next that
 * changes one thing a world rests on, through its generated, reviewed folders (`migrated`: every candidate rename kept, each folder applied by the real runner, which drift-checks the catalog it reaches).
 *
 * The schema: documents of organizations on a tier (a closed relation, an enum), each with a word count and a cap (a
 * contract), their shares and their notes (a serial field), and a derived relation over the documents' word counts.
 * Two contexts are read: the session's subject, and a quota whose cap is the contract. `editor` holds the documents and
 * the derived relation whole, refreshes it, reads Capped (the documents at the quota's cap) and writes Mine, its notes
 * under row security; `viewer` holds the organizations, the tier and the derived relation whole. Both are of one login.
 *
 * The changes, one per case:
 * - a read query entry's head;
 * - a written entry's policy filter, which reads no relation besides the one it writes (its filter function goes);
 * - a filter function's relation (documents owned, then documents shared);
 * - a context's contract, the cap's least value;
 * - the login's name;
 * - the tier's handles reordered, an enum rebuilt under the viewer's view of the organizations;
 * - the word count retyped from integer to bigint, a column under the derived relation, whose materialized view goes and
 *   comes back, and under the editor's view of the documents.
 *
 * Properties, for every case:
 * - each folder applies and the drift check admits the catalog it reaches: every world object reading what changed was
 *   dropped before the change and created after it, in the same transaction;
 * - Db.open admits every role at the last snapshot;
 * - the installed-catalog checker finds nothing;
 * - no migration recreates a login or a role: each keeps its OID across the versions, so a password and what other
 *   roles were granted survive, a renamed login included. */
interface Knobs {
	readonly tiers: readonly ["Free", "Pro"] | readonly ["Pro", "Free"]
	readonly words: "integer" | "bigint"
	readonly capLeast: 0 | 1
	/** Mine's filter: the notes of documents the session's subject owns, of documents shared with it, or its own. */
	readonly mine: "owned" | "shared" | "authored"
	readonly capped: "id" | "id and cap"
	readonly login: "desk" | "counter"
}

const start: Knobs = {
	tiers: ["Free", "Pro"],
	words: "integer",
	capLeast: 0,
	mine: "owned",
	capped: "id",
	login: "desk"
}

const Sub = str.regex("^u_[a-z]{1,8}$")
const Session = context("Session", { sub: Sub })

/** The version `k` under the declared name `name`. */
const versionOf = (name: string, k: Knobs) => {
	const Cap = contract("Cap", pg.integer, (x) => x.ge(k.capLeast))
	const Quota = context("Quota", { cap: Cap }, { claim: "q" })
	const Tier = closed("Tier", k.tiers)
	const Org = relation("Org", { id: uuid, tier: closedId(Tier) }, ["id"])
	const Doc = relation(
		"Doc",
		{
			id: uuid,
			org: uuid,
			owner: Sub,
			words: k.words === "integer" ? pg.integer : pg.bigint,
			cap: Cap
		},
		["id"]
	)
	const Share = relation("Share", { doc: uuid, user: Sub }, ["doc", "user"])
	const Note = relation("Note", { no: pg.bigserial, doc: uuid, author: Sub }, ["no"])
	const base = schema(name, { Tier, Org, Doc, Share, Note }, [mutable(Doc)])
	const Busy = derived(
		"Busy",
		query(base).rule((r) => {
			const { id, words } = v(Doc, "doc")
			return r.match(Doc, { id, words }).find({ id, words })
		})
	)
	const ext = schema.extend(base, { Busy }, [])
	const mine = () => {
		switch (k.mine) {
			case "owned":
				return query(ext).rule((r) => {
					const { no, doc, author } = v(Note, "note")
					const { owner } = v(Doc, "doc")
					return r
						.match(Note, { no, doc, author })
						.match(Doc, { id: doc, owner })
						.match(Session, { sub: owner })
						.find({ no, doc, author })
				})
			case "shared":
				return query(ext).rule((r) => {
					const { no, doc, author } = v(Note, "note")
					return r
						.match(Note, { no, doc, author })
						.match(Share, { doc, user: author })
						.match(Session, { sub: author })
						.find({ no, doc, author })
				})
			case "authored":
				return query(ext).rule((r) => {
					const { no, doc, author } = v(Note, "note")
					return r
						.match(Note, { no, doc, author })
						.match(Session, { sub: author })
						.find({ no, doc, author })
				})
		}
	}
	const capped =
		k.capped === "id"
			? query(ext).rule((r) => {
					const { id, cap } = v(Doc, "doc")
					return r.match(Doc, { id, cap }).match(Quota, { cap }).find({ id })
				})
			: query(ext).rule((r) => {
					const { id, cap } = v(Doc, "doc")
					return r.match(Doc, { id, cap }).match(Quota, { cap }).find({ id, cap })
				})
	const editor = role(
		ext,
		"editor",
		{ Doc, Busy: ext.relations.Busy, Mine: mine(), Capped: capped },
		{ write: ["Mine"], refresh: ["Busy"] }
	)
	const viewer = role(ext, "viewer", { Tier, Org, Busy: ext.relations.Busy })
	return { schema: ext, editor, viewer, login: login(ext, k.login, [editor, viewer]) }
}

type Built = ReturnType<typeof versionOf>

/** The changes a case makes to the starting version, each named. */
const cases = [
	{ name: "a read query entry's head changes", to: { ...start, capped: "id and cap" } },
	{
		name: "a written entry's policy filter stops reading another relation",
		to: { ...start, mine: "authored" }
	},
	{ name: "a filter function reads another relation", to: { ...start, mine: "shared" } },
	{ name: "a context's contract changes", to: { ...start, capLeast: 1 } },
	{ name: "the login is renamed", to: { ...start, login: "counter" } },
	{ name: "an enum under a world view is rebuilt", to: { ...start, tiers: ["Pro", "Free"] } },
	{
		name: "a column under a derived relation and a world view is retyped",
		to: { ...start, words: "bigint" }
	}
] as const satisfies Arr.NonEmptyReadonlyArray<{ readonly name: string; readonly to: Knobs }>

type WorldsCase = (typeof cases)[number]

/** A case reached: the change it made. */
type WorldsFeature = WorldsCase["name"]

const caseGen: Gen<WorldsCase> = element<WorldsCase>(cases)

/** A role's OID, as the owner reads it. */
const oidQuery = "SELECT r.oid::text FROM pg_catalog.pg_roles AS r WHERE r.rolname = $1::text"

layer(Substrate.layer)("worlds across migrations", (it) => {
	it.effect(
		"each change a world rests on migrates with its roles kept and its catalog admitted",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						/**
						 * Every case, the first version migrated to the case's next: each login and its roles keep their OIDs, the migration
						 * applies again with nothing pending, Db.open admits the last version's roles, and the installed-catalog checker finds
						 * nothing. A case migrates twice and opens two Dbs, so it may run five minutes before it counts as hung.
						 */
						suite: "pg/migrate/worlds",
						generator: caseGen,
						literal: (c: WorldsCase) => c.name,
						limit: cases.length,
						coverage: requiredInSpace<WorldsFeature>(Arr.map(cases, (c) => c.name)),
						caseHang
					},
					(c, reached) =>
						Effect.gen(function* () {
							reached.note(c.name)
							const substrate = yield* Substrate
							const built: Array<Built> = []
							const version =
								(k: Knobs) =>
								(name: string): Version => {
									const b = versionOf(name, k)
									built.push(b)
									return { schema: b.schema, logins: [b.login] }
								}
							const oids: Array<ReadonlyArray<string>> = []
							const m = yield* migrated({
								label: "worlds_mig",
								schemaName: { kind: "unique" },
								first: version(start),
								later: [version(c.to)],
								/** The one placeholder these versions draft: the word count's conversion, from its own value. */
								apply: {
									kind: "values",
									value: () =>
										`${quoteIdent(identifierOf(identity.column(parsedName("words"))))}::bigint`
								},
								register: true,
								declared: () => noDeclarations,
								observe: Option.some((i: number, owner: RawSession) =>
									Effect.gen(function* () {
										const b = defined(built[i], `version ${i}`)
										const found: Array<string> = []
										for (const world of [b.login, b.editor, b.viewer]) {
											const rows = yield* owner.values(oidQuery, [worldRoleOf(world)])
											for (const row of rows) {
												found.push(String(row[0]))
											}
										}
										oids.push(found)
									})
								)
							})
							/** Each version's login and roles are the same PostgreSQL roles. */
							const first = defined(oids[0], "the first version's roles")
							assert.equal(first.length, 3, "the first version's login and roles exist")
							for (const later of oids.slice(1)) {
								assert.deepEqual(later, first, "a login and its roles keep their OIDs")
							}
							yield* m.reapply
							const last = defined(built[built.length - 1], "the last version")
							yield* withDbClaims(m, last.login.roles.editor, { sub: "u_ann" }, () => Effect.void)
							yield* withDb(m, last.login.roles.viewer, () => Effect.void)
							const read = yield* readCatalog(substrate.admin, m.schema)
							assert.ok(read.kind === "present", `the migrated schema ${m.schema} is absent`)
							assert.deepEqual(
								checkInstalled(read.catalog, installedScope(m.installation, m.snapshot)),
								[]
							)
						})
				)
			)
	)
})
