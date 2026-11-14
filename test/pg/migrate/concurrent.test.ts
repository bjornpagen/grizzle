/**
 * Installations migrating into one database at once (DEFACL). Each is a schema of its own, but they write catalog rows
 * they share: the owner's global default privileges (one pg_default_acl row per owner and object kind), the vector
 * extension's schema's ACL, the database's own default and ACL. Every statement that writes one is the database lock's
 * command and its own (packages/engine/src/sql/print.ts databaseWide); without the lock two of them at once fail with
 * XX000 (tuple concurrently updated), as installations did when test seats installed at once (2484d498), and a lock
 * printed into the same text as its statement fails every door that sends one command a message (42601, 2f3f4a14).
 *
 * A case draws two or three installations, each the first migration of one of two shapes, a relation keyed by id with
 * a Boolean field or with a vector field, which one role of one login reads, so a vector installation grants USAGE on
 * the vector extension's schema; and each sent through one of the two doors a drafted statement reaches PostgreSQL by:
 * the real apply runner over its drafted folder (install-migrate.ts migrateFolders, as `grizzle migrate` and every
 * migrated or served test installation send it, a file split into its commands), or the harness's script door (one
 * transaction of filledSql over the fresh-install script, as installRealSchema and installationSql send it, one
 * command a message). Each is drafted as `grizzle generate` drafts it (draftVersion), under a name of its own and the
 * case's one owner, and sent as an owner login of its own (ambientOwner), all of them at once into the file's database.
 *
 * The construction: before any is sent, a gate session opens a transaction and creates each installation's login role,
 * uncommitted. An installation creates that role among its publish statements, before its grants and its default
 * privileges, so it waits there on the gate (pg_authid's unique name). Once every installation's backend waits on a
 * lock, on the gate or on an installation that holds the database lock and waits on the gate, the gate rolls back and
 * they run on together into their grants and default privileges.
 *
 * The oracle is PostgreSQL. Fresh installations hold no row, so no law refuses a statement of theirs: every
 * installation is sent whole; each holds the installed-catalog posture (checkInstallation) and a migrated one the
 * catalog of its fresh install (expectFreshCatalog); and the rows they share hold what each of them wrote: the owner's
 * global default privileges on functions and types grant PUBLIC nothing, and each vector reader holds USAGE on the
 * vector extension's schema.
 *
 * Features: two installations waiting on the gate at once, each inside its publish statements; two installations of a
 * case granting on the vector extension's schema; the two doors in one case; three installations at once. Each is
 * aimed at while pending.
 *
 * Plants (~/.cache/grizzle-release/DEFACL/plants): database-lock-dropped (databaseWide emits a statement's own command
 * alone: a setup refused, XX000 on the database default); guards-before-732aa5b2 (the database default and a grant on
 * the database alone behind the lock: a publish refused, XX000 on ALTER DEFAULT PRIVILEGES ... ON FUNCTIONS, the
 * defect 2484d498 met); lock-glued-into-one-command (the lock and its statement one command, as 732aa5b2 printed
 * them: the script door refused, 42601).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { constant, element, type Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Cause, Effect, Exit, Fiber, Formatter, Layer } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { type Aim, aimedAt } from "#test/pg/migrate/support.ts"
import { type AmbientOwner, ambientOwner, ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { checkInstallation } from "#test/support/catalog/installed.ts"
import { filledSql } from "#test/support/compile.ts"
import {
	type DraftedVersion,
	draftVersion,
	expectFreshCatalog,
	installedOf,
	installedSchemas,
	loginCredentials,
	migrateFolders
} from "#test/support/install-migrate.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
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

type Feature =
	| "two installations waiting on the gate at once, each inside its publish statements"
	| "two installations granting USAGE on the vector extension's schema at once"
	| "an installation sent by the real runner beside one sent by the harness's script door"
	| "three installations at once"

const Note = relation("Note", { id: pg.int4, done: pg.boolean }, ["id"])
const Embedding = relation("Embedding", { id: pg.int4, at: pg.vector(3) }, ["id"])

const plainSchema = schema("concurrent_plain", [Note], [])
const vectorSchema = schema("concurrent_vector", [Embedding], [])

/** Each shape's schema and its one login, `server`, whose role `reader` reads the whole schema. */
const shapes = {
	plain: {
		schema: plainSchema,
		login: login(plainSchema, "server", [role(plainSchema, "reader", wholeEntriesOf(plainSchema))])
	},
	vector: {
		schema: vectorSchema,
		login: login(vectorSchema, "server", [
			role(vectorSchema, "reader", wholeEntriesOf(vectorSchema))
		])
	}
} as const

const drawnGen: Gen<Drawn> = (source) => ({
	shape: source.draw(element<Shape>(["plain", "vector"])),
	door: source.draw(element<Door>(["runner", "script"]))
})

const caseGen: Gen<ConcurrentCase> = (source) => {
	const first = source.draw(drawnGen)
	const second = source.draw(drawnGen)
	return source.draw(element([false, true]))
		? { installations: [first, second, source.draw(drawnGen)] }
		: { installations: [first, second] }
}

/** Two installations of `shape`, each sent through `door`. */
const pairOf = (a: Drawn, b: Drawn): Gen<ConcurrentCase> => constant({ installations: [a, b] })

const aims: ReadonlyArray<Aim<ConcurrentCase, Feature>> = [
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

const aimed = aimedAt(aims)

/** An installation of a case, drafted and given its owner login: what is sent, and as whom. */
interface Prepared {
	readonly drawn: Drawn
	readonly declared: string
	readonly version: DraftedVersion
	readonly owner: AmbientOwner
	/** The login role its publish statements create, which the gate creates first. */
	readonly gated: string
}

/** `d` drafted as `grizzle generate` drafts its first migration, under a name of its own, with an owner login of its own. */
const prepared = (d: Drawn) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const declared = yield* substrate.schema({ create: false, label: "concurrent" })
		const shape = shapes[d.shape]
		const version = yield* draftVersion(
			{ schema: shape.schema, logins: [shape.login], declarations: noDeclarations },
			{
				installation: identity.schema(parsedSchemaName(declared)),
				owner: substrate.owner.role,
				previous: fromEmpty,
				step: 0
			},
			{ extensions: [], compile: compileInstallation }
		)
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

const walk = (c: ConcurrentCase, note: (feature: Feature) => void) =>
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
				yield* expectFreshCatalog(
					p.version.plan.installation,
					[p.version.folder],
					p.version.planned
				)
			}
			const installed = yield* installedOf({
				plan: p.version.plan,
				declared: p.declared,
				folders: [p.version.folder],
				snapshot: p.version.snapshot,
				ambientOwner: p.owner,
				files: new Map(),
				credentials: yield* loginCredentials(p.version.plan, new Map(), new Map())
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

layer(Layer.merge(Substrate.layer, NodeServices.layer))(
	"installations migrating into one database at once",
	(it) => {
		it.effect(
			"every installation sent at once, by either door, installs whole, and the rows they share hold what each wrote",
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "migrate/concurrent",
							draw: drawn(caseGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "PostgreSQL: every installation sent whole, each at its fresh install's catalog and posture, and the owner's global defaults and the vector schema's grants as each installation wrote them"
							},
							coverage: required<Feature>(
								[
									"two installations waiting on the gate at once, each inside its publish statements",
									"two installations granting USAGE on the vector extension's schema at once",
									"an installation sent by the real runner beside one sent by the harness's script door",
									"three installations at once"
								],
								{ cases: 8, sense: notesOnly }
							),
							kept: [],
							runs: 6,
							shrink: { kind: "bounded", candidates: 8 },
							concurrency: 1,
							steerEvery: 4,
							caseHang
						},
						(c, cx) => Effect.scoped(walk(aimed(c, cx), cx.note))
					)
				)
		)
	}
)
