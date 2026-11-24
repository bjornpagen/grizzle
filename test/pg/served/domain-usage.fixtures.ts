/** What domain-usage.test.ts reads: its installation, its box, and each case's calls. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { roleNameOf } from "#adapter/served/served.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic } from "#compiler/public/compute.ts"
import { Bits, bits, closedId, contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	context,
	login,
	mutable,
	relation,
	role,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { readOnce, writeOnce } from "#test/support/calls.ts"
import { noPlaceholders } from "#test/support/install-migrate.ts"
import { migrated, noObservation, type Version } from "#test/support/installed.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * What a case calls: a put of the notes through a carrier of its fields, a contract's, a closed id's and a set's, or
 * a read of them by a refined and a closed id parameter beside the session's claim of a closed id.
 */
export type Call = "a write of every kind of domain" | "a read by refined and closed id parameters"

export const calls: Gen<Call> = element<Call>([
	"a write of every kind of domain",
	"a read by refined and closed id parameters"
])

export type DomainUsageFeature = `${Call} by a role holding USAGE on no domain`

/**
 * The installation under `name`: the notes, `Note(k, n, tier, tags)`, `n` of the contract Words at least 0, `tier` a
 * closed id of the roster Tier and `tags` a set over it, mutable inside the unit of their key; the session's claim of
 * a closed id of Tier, Desk; and the login `desk` of a writer of the notes serving a put of them from a relation
 * parameter, whose deletion and insert read a carrier of every field, and a read of them by Words and Tier parameters
 * and Desk's claim.
 */
const builtOf = (name: string) => {
	const Tier = closed.ordered("Tier", ["Free", "Pro"])
	const Words = contract("Words", pg.integer, (x) => Logic.ge(x, 0))
	const Note = relation(
		"Note",
		{ k: pg.integer, n: Words, tier: closedId(Tier, undefined), tags: bits(Tier) },
		["k"]
	)
	const base = schema(name, [Tier, Note], [unit("Notes", { k: pg.integer }), mutable(Note)])
	const Desk = context("Desk", { tier: closedId(Tier, undefined) })
	const writer = role(base, "writer", { Note }, { write: ["Note"], contexts: [Desk] })
	const put = ChangeSet.empty(writer).put(
		Note,
		query(writer).rule((q) => {
			const rows = q.relation("rows", {
				k: Note.fields.k,
				n: Note.fields.n,
				tier: Note.fields.tier,
				tags: Note.fields.tags
			})
			const { k, n, tier, tags } = v(Note, "note")
			return q.match(rows, { k, n, tier, tags }).find({ k, n, tier, tags })
		})
	)
	const read = query(writer).rule((q) => {
		const { k, tags } = v(Note, "note")
		const n = q.param("n", Words)
		const tier = q.param("tier", closedId(Tier, undefined))
		return q.match(Note, { k, n, tier, tags }).match(Desk, { tier }).find({ k, tags })
	})
	const desk = login(base, "desk", [writer], { workload: [workload(writer, { put, read })] })
	const version: Version = { schema: base, logins: [desk] }
	return { version, desk, writer, put, read, Tier }
}

/**
 * A case: installs the notes through their migration; opens a Db of the writer with Desk's claim of Pro, and asserts
 * the writer holds USAGE on no domain of the installation; then calls as the case says, through the Db's served
 * statements: the put of a note, which stands up its carrier (a temporary table of the session, which PostgreSQL would
 * refuse the writer, 42501, did a column of it name a domain) and casts its values into Words, Tier's domain and the
 * set's bits domain as it writes them; or, after that put, the read by `n` and `tier`, its parameters cast into Words
 * and Tier's domain and Desk's claim judged by Tier's domain. Oracle: PostgreSQL itself: every call succeeds, the read
 * finding the note put.
 */
export const domainUsageCase = (call: Call, c: Case<DomainUsageFeature>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const built: Array<ReturnType<typeof builtOf>> = []
		const m = yield* migrated({
			label: "domain_usage",
			schemaName: { kind: "unique" },
			first: (name) => {
				const b = builtOf(name)
				built.push(b)
				return b.version
			},
			later: [],
			apply: noPlaceholders,
			declared: () => noDeclarations,
			observe: noObservation
		})
		const at = built[0]
		assert.ok(at !== undefined, "the installation was built")
		const [usage] = yield* substrate.admin.queryValues(
			"SELECT count(*)::int4 FROM pg_catalog.pg_type AS t WHERE t.typtype = 'd' AND pg_catalog.has_type_privilege($1::text, t.oid, 'USAGE') AND t.typnamespace = ANY(SELECT n.oid FROM pg_catalog.pg_namespace AS n WHERE n.nspname = ANY($2::text[]))",
			[roleNameOf(at.writer, {}), Arr.map(m.installation.names.levels, identifierOf)]
		)
		assert.equal(Number(usage?.[0]), 0, "the writer holds USAGE on no domain of the installation")
		const db = yield* openServedDb(m, at.desk.roles.writer, { tier: "Pro" })
		const served = yield* db.serve({ put: at.put, read: at.read })
		yield* writeOnce(member(served, "put"))({
			params: { rows: [{ k: 1, n: 5, tier: "Pro", tags: Bits.of(at.Tier, ["Free", "Pro"]) }] },
			facts: {}
		})
		if (call === "a read by refined and closed id parameters") {
			const rows = yield* readOnce(member(served, "read"))({
				params: { n: 5, tier: "Pro" },
				facts: {}
			})
			assert.equal(rows.length, 1, "the read finds the note put")
		}
		c.note(`${call} by a role holding USAGE on no domain`)
	})
