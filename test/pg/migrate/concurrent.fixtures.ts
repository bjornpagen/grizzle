/** What the properties of concurrent.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { constant, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Cause, Effect, Exit, Fiber, Formatter } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { bool, int4, vector } from "#compiler/public/fields.ts"
import { login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { type AmbientOwner, ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import { checkInstallation } from "#test/support/catalog/installed.ts"
import { filledSql } from "#test/support/compile.ts"
import {
	expectFreshCatalog,
	type GeneratedDraft,
	type GeneratedVersion,
	generatedDraft,
	installedOf,
	installedSchemas,
	loginCredentials,
	migrateFolders,
	noPlaceholders
} from "#test/support/install-migrate.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import type { Aim } from "#test/support/pg/migrate/support.ts"
import { connect } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** An installation's relation: a Boolean field, or a vector field, whose reader's installation grants on the vector
 * extension's schema. */
type Shape = "plain" | "vector"

/** The door an installation's statements reach PostgreSQL by: the real apply runner, or the harness's script door. */
type Door = "runner" | "script"

interface Drawn {
	readonly shape: Shape
	readonly door: Door
}

/** A case: two or three installations, sent at once. */
interface ConcurrentCase {
	readonly installations: readonly [Drawn, Drawn, ...Array<Drawn>]
}

export type Feature =
	| "two installations waiting on the gate at once, each inside its publish statements"
	| "two installations granting USAGE on the vector extension's schema at once"
	| "an installation sent by the real runner beside one sent by the harness's script door"
	| "three installations at once"

const Note = relation("Note", { id: int4, done: bool }, ["id"])

const Embedding = relation("Embedding", { id: int4, at: vector(3) }, ["id"])

/**
 * Each shape's schema under the allocated name `name` and its one login, `server`, whose role `reader` reads the whole
 * schema: the version `grizzle generate` drafts.
 */
const shapeAt = (shape: Shape, name: string): GeneratedVersion => {
	const base = schema(name, [shape === "plain" ? Note : Embedding], [])
	return {
		schema: base,
		logins: [login(base, "server", [role(base, "reader", wholeEntriesOf(base))])],
		declarations: noDeclarations
	}
}

const drawnGen: Gen<Drawn> = (source) => ({
	shape: source.draw(element<Shape>(["plain", "vector"])),
	door: source.draw(element<Door>(["runner", "script"]))
})

export const caseGen: Gen<ConcurrentCase> = (source) => {
	const first = source.draw(drawnGen)
	const second = source.draw(drawnGen)
	return source.draw(element([false, true]))
		? { installations: [first, second, source.draw(drawnGen)] }
		: { installations: [first, second] }
}

/** Two installations of `shape`, each sent through `door`. */
const pairOf = (a: Drawn, b: Drawn): Gen<ConcurrentCase> => constant({ installations: [a, b] })

export const aims: ReadonlyArray<Aim<ConcurrentCase, Feature>> = [
	[
		"two installations waiting on the gate at once, each inside its publish statements",
		pairOf({ shape: "plain", door: "runner" }, { shape: "plain", door: "runner" })
	],
	[
		"two installations granting USAGE on the vector extension's schema at once",
		pairOf({ shape: "vector", door: "runner" }, { shape: "vector", door: "runner" })
	],
	[
		"an installation sent by the real runner beside one sent by the harness's script door",
		pairOf({ shape: "vector", door: "runner" }, { shape: "plain", door: "script" })
	],
	[
		"three installations at once",
		constant<ConcurrentCase>({
			installations: [
				{ shape: "vector", door: "runner" },
				{ shape: "plain", door: "runner" },
				{ shape: "vector", door: "script" }
			]
		})
	]
]

/** An installation of a case, drafted and given its owner login: what is sent, and as whom. */
interface Prepared {
	readonly drawn: Drawn
	readonly declared: string
	readonly version: GeneratedDraft
	readonly owner: AmbientOwner
	/** The login role its publish statements create, which the gate creates first. */
	readonly gated: string
}

/** `shape` under `name` drafted as `grizzle generate` drafts its first migration (install-migrate.ts generatedDraft). */
const draftedAt = (shape: Shape, name: string) =>
	generatedDraft(
		shapeAt(shape, name),
		{ installation: identity.schema(parsedSchemaName(name)), previous: fromEmpty, step: 0 },
		noPlaceholders
	)

/** `d` drafted as `grizzle generate` drafts its first migration, under a name of its own, with an owner login of its own. */
const prepared = (d: Drawn) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const declared = yield* substrate.schema({ create: false, label: "concurrent" })
		const version = yield* draftedAt(d.shape, declared)
		const owner = yield* ambientOwner(ordinarySession, installedSchemas(version.plan.installation))
		const gated = defined(
			version.plan.logins["server"],
			"the login server of a case's installation"
		).role
		return { drawn: d, declared, version, owner, gated } satisfies Prepared
	})

/** What sending an installation answers: nothing, or the message of what refused it. */
const sent = (p: Prepared) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		switch (p.drawn.door) {
			case "runner":
				return yield* Effect.asVoid(
					Effect.mapError(
						migrateFolders(p.owner, substrate.database, p.version.snapshot, [p.version.folder]),
						(e) => e.message
					)
				)
			case "script": {
				const connection = yield* Effect.mapError(
					connect(substrate.cluster, {
						database: substrate.database,
						credentials: p.owner.credentials,
						label: "script door"
					}),
					(e) => Formatter.format(e)
				)
				return yield* Effect.mapError(
					transaction(connection, filledSql(p.version.plan.drafted, substrate.database)),
					(e) => Formatter.format(e)
				)
			}
		}
	}).pipe(Effect.scoped)

/** How many backends of `roles` wait on a lock, and how many of them on `gate`; read at READ COMMITTED. */
const waitersQuery = `SELECT count(*) FILTER (WHERE cardinality(pg_catalog.pg_blocking_pids(a.pid)) > 0)::int4,
	count(*) FILTER (WHERE $1::int4 = ANY (pg_catalog.pg_blocking_pids(a.pid)))::int4
FROM pg_catalog.pg_stat_activity AS a WHERE a.usename::text = ANY ($2::text[])`

export const walk = (c: ConcurrentCase, note: (feature: Feature) => void) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const installations = yield* Effect.forEach(c.installations, prepared)
		const roles = Arr.map(installations, (p) => p.owner.credentials.role)
		const observer = yield* substrate.session({ ...ownerSession(), label: "observer" })
		yield* observer.query(
			"SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED",
			[]
		)
		const gate = yield* substrate.session({ ...ownerSession(), label: "gate" })
		yield* gate.begin
		for (const p of installations) {
			yield* gate.query(`CREATE ROLE ${quoteIdent(p.gated)}`, [])
		}
		const sending = yield* Effect.forEach(installations, (p) =>
			Effect.forkChild(Effect.exit(sent(p)))
		)
		/**
		 * Every installation waits on a lock at once: none moves until the gate rolls back, since each waits on the gate or
		 * on one that holds the database lock and waits on it. One that ends first never reached the gate: the case's
		 * failure, never a wait without end.
		 */
		const atGate = yield* Effect.raceFirst(
			Effect.gen(function* () {
				for (;;) {
					const [row] = yield* observer.values(waitersQuery, [gate.pid, roles])
					const [waiting, gated] = defined(row, "the waiters query's one row")
					if (Number(waiting) === installations.length) {
						return Number(gated)
					}
					yield* Effect.yieldNow
				}
			}),
			Effect.flatMap(Effect.raceAll(Arr.map(sending, (f) => Fiber.await(f))), (exit) =>
				Effect.die(
					new Error(`an installation ended before every one waited on a lock: ${String(exit)}`)
				)
			)
		)
		yield* gate.rollback
		const exits = yield* Effect.forEach(sending, (f) => Fiber.join(f))
		for (const [i, exit] of exits.entries()) {
			if (Exit.isFailure(exit)) {
				return assert.fail(
					`installation ${i + 1} of ${installations.length} was refused: ${Cause.pretty(exit.cause)}\n${Formatter.format(c)}`
				)
			}
		}
		for (const p of installations) {
			if (p.drawn.door === "runner") {
				yield* expectFreshCatalog(p.version.plan.installation, [p.version.folder], (fresh) =>
					Effect.map(draftedAt(p.drawn.shape, fresh), (again) => again.plan)
				)
			}
			const installed = yield* installedOf({
				plan: p.version.plan,
				declared: p.declared,
				folders: [p.version.folder],
				snapshot: p.version.snapshot,
				ambientOwner: p.owner,
				files: p.version.served,
				credentials: yield* loginCredentials(p.version.plan, p.version.served, new Map())
			})
			yield* checkInstallation(installed)
		}
		const defaults = yield* substrate.admin.queryValues(
			`SELECT d.defaclobjtype::text, count(x.grantee) FILTER (WHERE x.grantee = 0::oid)::int4
FROM pg_catalog.pg_default_acl AS d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) AS x
WHERE d.defaclrole = $1::regrole AND d.defaclnamespace = 0::oid GROUP BY d.defaclobjtype ORDER BY 1`,
			[substrate.owner.role]
		)
		assert.deepEqual(
			Arr.map(defaults, ([kind, publics]) => [String(kind), Number(publics)]),
			[
				["T", 0],
				["f", 0]
			],
			`the owner's global defaults on functions and types grant PUBLIC nothing\n${Formatter.format(c)}`
		)
		const vectors = Arr.filter(installations, (p) => p.drawn.shape === "vector")
		for (const p of vectors) {
			const reader = defined(
				defined(p.version.plan.logins["server"], "the login server").roles["reader"],
				"the role reader"
			).role
			const [held] = yield* substrate.admin.queryValues(
				"SELECT pg_catalog.has_schema_privilege($1::text, $2::text, 'USAGE')::int4",
				[reader, p.version.plan.installation.settings.vectorSchema]
			)
			assert.equal(
				Number(defined(held, "the privilege's one row")[0]),
				1,
				`${reader} holds USAGE on the vector extension's schema\n${Formatter.format(c)}`
			)
		}
		if (atGate >= 2) {
			note("two installations waiting on the gate at once, each inside its publish statements")
		}
		if (vectors.length >= 2) {
			note("two installations granting USAGE on the vector extension's schema at once")
		}
		if (
			Arr.some(installations, (p) => p.drawn.door === "runner") &&
			Arr.some(installations, (p) => p.drawn.door === "script")
		) {
			note("an installation sent by the real runner beside one sent by the harness's script door")
		}
		if (installations.length === 3) {
			note("three installations at once")
		}
	})
