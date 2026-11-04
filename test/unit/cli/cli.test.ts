import { inspect } from "node:util"
import { NodeServices } from "@effect/platform-node"
import { describe, it, layer } from "@effect/vitest"
import { assertNone } from "@effect/vitest/utils"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	DateTime,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Order,
	pipe,
	Redacted,
	String as Str
} from "effect"
import { readMeta } from "#adapter/boundary/meta.ts"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import { parseArgs } from "#cli/args.ts"
import { formatTimestamp, nextTimestamp, parseTimestamp } from "#cli/clock.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import { isFolderName, metaFileName } from "#compiler/deploy/render/folder.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { uuid } from "#compiler/public/fields.ts"
import { closed, login, relation, role, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ownLogin } from "#compiler/schema/own.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import { defineConfig } from "#index.ts"
import { ledger, shop } from "#test/pg/cli/fixture.ts"
import {
	bin,
	cli,
	cliClock,
	cliOver,
	resolvedConfig,
	viaDatabaseUrl,
	workspace,
	writeConfig,
	writeConfigText
} from "#test/pg/cli/support.ts"
import { assert, contains, defined, lacksText, refusedAt, succeeded } from "#test/support/assert.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import { repoRoot } from "#test/support/files.ts"
import { atDeclaredName } from "#test/support/kernel/naming.ts"
import { compile, fromEmpty, generate, unowned } from "#test/support/migrate/kit.ts"
import { validationFile } from "#test/support/migrate/review.ts"
import { owning } from "#test/support/policy.ts"

/** The clock the in-process command lines of this file read. */
const nextNow = cliClock()

/**
 * The `grizzle` command line without a database: argument
 * parsing, folder timestamps, the lean grizzle.config.ts, where migrate connects, and `generate` writing the migrations
 * directory.
 *
 * - The commands generate, check, migrate, drift and skill and nothing else, with drizzle's flags: --name, --custom, and
 *   --schema, which is accepted only when the configuration declares several schemas.
 * - Folder names are `<YYYYMMDDHHMMSS>_<name>` in UTC and always sort after the schema's existing folders.
 * - The configuration is always defineConfig({ schemas, logins, workload?, migrations?, connection? }); a plain object is
 *   refused with the fix, and anything malformed before any command runs: among them a login over a schema it does not
 *   list and a login named as a role of its schema. Its connection is checked only by migrate.
 * - migrate connects with DATABASE_URL unless the configuration names a connection, whose password may be an Effect;
 *   connection.test.ts generates both forms and their refusals.
 * - generate writes exactly what the pure generator drafts, byte for byte, in `migrations/<schema>/`, named by --name
 *   or after its change; a schema that did not change drafts nothing and prints `no changes`; a folder drafted in the
 *   same second sorts after the last; --custom writes an empty folder of the committed snapshot.
 * - A draft continues the committed chain, and nothing is written for any schema when one schema fails; every
 *   tampering with the committed directory is generated in tamper.test.ts. Hidden entries are ignored.
 */
const at = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
	DateTime.makeUnsafe({
		year: y,
		month: mo,
		day: d,
		hour: h,
		minute: mi,
		second: s,
		millisecond: 0
	})

/** The entries of `dir` in name order, none when it does not exist. */
const ls = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return (yield* fs.exists(dir))
			? yield* Effect.map(fs.readDirectory(dir), (entries) => Arr.sort(entries, Order.String))
			: []
	})

/** The text of the file at `path`. */
const read = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.readFileString(path)
	})

/** Writes `text` to the file at `path`. */
const write = (path: string, text: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.writeFileString(path, text)
	})

/** The path of `parts` joined by slashes. */
const join = (...parts: Array<string>): string => Arr.join(parts, "/")

/** The installation identifier of the shop fixture's schema declared `name`, as the naming door spells it. */
const shopIdent = (name: string): string =>
	owning(shop(name, 1, "none").schema).installation.identifier

/** The migrations directory of the shop fixture's schema declared `name`, below a workspace. */
const shopDirectory = (name: string): string => join("migrations", shopIdent(name))

describe("the command line", () => {
	it("parses generate, check, migrate, drift and skill with drizzle's flags", () => {
		assert.deepEqual(succeeded(parseArgs(["generate"])), {
			kind: "generate",
			mode: { kind: "draft", naming: { kind: "derived" } },
			schema: Option.none()
		})
		assert.deepEqual(succeeded(parseArgs(["generate", "--name", "add_note"])), {
			kind: "generate",
			mode: { kind: "draft", naming: { kind: "named", name: "add_note" } },
			schema: Option.none()
		})
		assert.deepEqual(
			succeeded(parseArgs(["generate", "--custom", "--schema=work", "--name=backfill"])),
			{
				kind: "generate",
				mode: { kind: "custom", name: "backfill" },
				schema: Option.some("work")
			}
		)
		assert.deepEqual(succeeded(parseArgs(["generate", "--custom"])), {
			kind: "generate",
			mode: { kind: "custom", name: "custom" },
			schema: Option.none()
		})
		assert.deepEqual(succeeded(parseArgs(["check"])), { kind: "check" })
		assert.deepEqual(succeeded(parseArgs(["migrate"])), { kind: "migrate" })
		assert.deepEqual(succeeded(parseArgs(["drift"])), { kind: "drift" })
		assert.deepEqual(succeeded(parseArgs(["skill"])), { kind: "skill" })
		assert.deepEqual(succeeded(parseArgs([])), { kind: "help" })
		assert.deepEqual(succeeded(parseArgs(["migrate", "--help"])), { kind: "help" })
	})

	it.effect("refuses anything else as a usage error", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/cli/usage-refusals",
					generator: element<ReadonlyArray<string>>([
						["push"],
						["migrate", "apply"],
						["migrate", "now"],
						["check", "--fix"],
						["drift", "now"],
						["skill", "extra"],
						["generate", "init"],
						["generate", "--force"],
						["generate", "--name"],
						["generate", "--name", "--custom"],
						["generate", "--custom", "--custom"],
						["generate", "--schema", "a", "--schema", "b"],
						["generate", "--name=a", "--name=b"]
					]),
					literal: Formatter.format,
					limit: 13,
					coverage: noCoverage,
					caseHang: Duration.minutes(2)
				},
				(argv) =>
					Effect.sync(() => {
						refusedAt(parseArgs(argv), "stage", "usage", Arr.join(argv, " "))
					})
			)
		)
	)
})

describe("folder timestamps", () => {
	it("are the UTC second as fourteen digits", () => {
		assert.equal(formatTimestamp(at(2026, 10, 12, 9, 5, 7)), "20261012090507")
		assert.deepEqual(
			Option.map(parseTimestamp("20261012090507"), DateTime.toEpochMillis),
			Option.some(DateTime.toEpochMillis(at(2026, 10, 12, 9, 5, 7)))
		)
		assertNone(parseTimestamp("20261332090507"))
		assertNone(parseTimestamp("2026101209050"))
	})

	it("sort after every existing folder of the schema, whatever the clock says", () => {
		const now = at(2026, 10, 12, 9, 5, 7)
		assert.equal(nextTimestamp(now, []), "20261012090507")
		assert.equal(nextTimestamp(now, ["20261012090506"]), "20261012090507")
		assert.equal(nextTimestamp(now, ["20261012090507"]), "20261012090508")
		assert.equal(nextTimestamp(now, ["20250101000000", "20261231235959"]), "20270101000000")
		assert.equal(nextTimestamp(now, ["20269999999999"]), "20270000000000")
	})
})

const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"
const connection = {
	host: "localhost",
	port: 5433,
	database: "app",
	role: "app_owner",
	password: Redacted.make("secret"),
	tls: { ca }
}

layer(NodeServices.layer, { excludeTestServices: true })(
	"grizzle.config.ts, the lean config",
	(it) => {
		const s = shop("CfgShop", 1, "full")
		const other = shop("CfgOther", 1, "none")
		const file = `${repoRoot}app/grizzle.config.ts`

		it.effect(
			"resolves schemas, their logins' workloads and the migrations directory, and keeps the connection unread",
			() =>
				Effect.gen(function* () {
					const config = yield* resolvedConfig(
						defineConfig({
							schemas: [s.schema, other.schema],
							logins: [s.server, other.server],
							migrations: "db"
						}),
						file
					)
					const c = succeeded(config)
					assert.equal(c.migrations, `${repoRoot}app/db`)
					const o = owning(s.schema)
					const p = owning(other.schema)
					assert.deepEqual(
						Arr.map(c.schemas, (x) => [
							x.declared,
							x.ident,
							x.directory,
							Arr.some(x.workloads, (w) => w.workloads.length > 0)
						]),
						[
							[
								o.name,
								identifierOf(o.installation),
								`${repoRoot}app/db/${identifierOf(o.installation)}`,
								true
							],
							[
								p.name,
								identifierOf(p.installation),
								`${repoRoot}app/db/${identifierOf(p.installation)}`,
								false
							]
						]
					)
					assert.ok(Option.isNone(c.connection), "no connection given")
					const resolved = yield* resolvedConfig(
						defineConfig({ schemas: [s.schema], logins: [] }),
						file
					)
					assert.equal(succeeded(resolved).migrations, `${repoRoot}app/migrations`)
					/** A connection is kept as given: only migrate checks it, so generate and check run with a broken one. */
					const broken = { ...connection, port: 70000 }
					const resolvedBroken = yield* resolvedConfig(
						defineConfig({ schemas: [s.schema], logins: [], connection: broken }),
						file
					)
					const kept = succeeded(resolvedBroken).connection
					assert.ok(Option.isSome(kept) && kept.value === broken, "the connection kept as given")
				})
		)

		it.effect(
			"refuses a plain object with the fix, and anything that is not a configuration, never naming a credential",
			() =>
				Effect.gen(function* () {
					const config = yield* resolvedConfig({ schemas: [s.schema], logins: [] }, file)
					refusedAt(config, "stage", "config")
					/** Refused at the configuration, no credential in its message or anywhere in the error. */
					const named = (value: unknown) =>
						Effect.map(resolvedConfig(value, file), (r) => {
							const refusal = refusedAt(r, "stage", "config")
							lacksText(`${refusal.message}\n${inspect(refusal, { depth: 12 })}`, "secret")
						})
					const configured = (value: Parameters<typeof defineConfig>[0]) =>
						named(defineConfig(value))
					yield* named(undefined)
					/** A key the type does not know, given through a variable, as JavaScript would. */
					const extra = { schemas: [s.schema] as const, logins: [], poolSize: 4 }
					yield* named(defineConfig(extra))
					yield* configured({ schemas: [s.schema], logins: [], migrations: "" })
					yield* configured({ schemas: [s.schema, shop("CfgShop", 2, "full").schema], logins: [] })
					yield* configured({ schemas: [s.schema], logins: [other.server] })
					/** A login named alike to a role of its schema: logins and roles of one schema have names that convert apart. */
					const clashing = login(s.schema, "Reader", [
						role(s.schema, "auditor", s.schema.relations)
					])
					yield* configured({ schemas: [s.schema], logins: [s.server, clashing] })
				})
		)
	}
)

/**
 * The installation and draft the pure compiler gives for a schema and its login's workload, as generate composes them:
 * the shop's, or the ledger's, whose residual law and derived relation only the two installer extensions install. Its
 * login is the fixture's, as the configuration names it (test/pg/cli/support.ts configOf), which owns the workload.
 */
const directDraft = (name: string, timestamp: string, fixture: "shop" | "ledger") => {
	const built = fixture === "ledger" ? ledger(name) : shop(name, 1, "full")
	const value = built.schema
	const server = built.server
	const plan = succeeded(
		compileTestWorkload([{ login: server.name, workloads: server.workload }], value, testCompile)
	)
	const owned = owning(value)
	const logins = [succeeded(ownLogin(defined(loginDescOf(server), "a login value")))]
	const installation = succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, owned.installation, logins, [workloadExtension(plan)])
		)
	)
	assert.deepEqual(installation.deferred, { residualLaws: [], derivedRelations: [] })
	return succeeded(
		generate({
			installation,
			name: "init",
			timestamp,
			workload: { access: plan.access, accessPaths: plan.requests },
			previous: fromEmpty
		})
	)
}

/** A schema whose closed relation carries a refined text payload: a slug. */
const tierSchema = (name: string) => {
	const Slug = str.regex("^[a-z][a-z0-9-]*$")
	const Tier = closed("Tier", ["Free", "Pro"]).with(
		{ label: Slug },
		{ Free: { label: "free" }, Pro: { label: "pro-plan" } }
	)
	const Article = relation("Article", { id: uuid, slug: Slug }, ["id"])
	return schema(name, { Tier, Article }, [])
}

layer(NodeServices.layer, { excludeTestServices: true })("grizzle generate", (it) => {
	it.effect(
		"writes exactly the generator's draft into migrations/<schema>/, then nothing when nothing changed",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("gen")
				yield* writeConfig(ws, {
					schemas: [{ name: "GenShop", fixture: "shop", version: 1, workload: "full" }],
					connection: viaDatabaseUrl
				})
				const now = at(2026, 10, 12, 12, 0, 0)
				const first = yield* cli(ws, ["generate", "--name", "init"], now, {})
				assert.equal(first.code, 0, first.stderr)
				const expected = directDraft("GenShop", formatTimestamp(now), "shop")
				const schemaDirectory = join(
					"migrations",
					owning(shop("GenShop", 1, "full").schema).installation.identifier
				)
				const dir = join(ws, schemaDirectory)
				const dirEntries = yield* ls(dir)
				assert.deepEqual(
					dirEntries,
					Arr.sort([expected.folder.name, snapshotFileName], Order.String)
				)
				const folder = join(dir, expected.folder.name)
				const folderEntries = yield* ls(folder)
				assert.deepEqual(
					folderEntries,
					Arr.sort([metaFileName, ...Arr.map(expected.folder.files, (f) => f.name)], Order.String)
				)
				const metaText = yield* read(join(folder, metaFileName))
				assert.equal(metaText, expected.folder.metaText)
				for (const f of expected.folder.files) {
					const fileText = yield* read(join(folder, f.name))
					assert.equal(fileText, f.text)
				}
				const snapshotText = yield* read(join(dir, snapshotFileName))
				assert.equal(snapshotText, expected.snapshotText)

				const again = yield* cli(ws, ["generate"], now, {})
				assert.equal(again.code, 0, again.stderr)
				const dirEntriesAfter = yield* ls(dir)
				assert.deepEqual(
					dirEntriesAfter,
					Arr.sort([expected.folder.name, snapshotFileName], Order.String)
				)
				const snapshotTextAfter = yield* read(join(dir, snapshotFileName))
				assert.equal(snapshotTextAfter, expected.snapshotText)
			})
	)

	it.effect("names a folder after its change when no --name is given", () =>
		Effect.gen(function* () {
			const ws = yield* workspace("names")
			const times = [
				at(2026, 10, 12, 12, 0, 0),
				at(2026, 10, 12, 12, 0, 1),
				at(2026, 10, 12, 12, 0, 2),
				at(2026, 10, 12, 12, 0, 3)
			] as const
			const [t0, t1, t2, t3] = times
			yield* writeConfig(ws, {
				schemas: [{ name: "NameShop", fixture: "shop", version: 1, workload: "full" }],
				connection: viaDatabaseUrl
			})
			const first = yield* cli(ws, ["generate"], t0, {})
			assert.equal(first.code, 0)
			yield* writeConfig(ws, {
				schemas: [{ name: "NameShop", fixture: "shop", version: 1, workload: "withoutByName" }],
				connection: viaDatabaseUrl
			})
			const rewired = yield* cli(ws, ["generate"], t1, {})
			assert.equal(rewired.code, 0)
			yield* writeConfig(ws, {
				schemas: [{ name: "NameShop", fixture: "shop", version: 2, workload: "withoutByName" }],
				connection: viaDatabaseUrl
			})
			const widened = yield* cli(ws, ["generate"], t2, {})
			assert.equal(widened.code, 0)
			const custom = yield* cli(ws, ["generate", "--custom"], t3, {})
			assert.equal(custom.code, 0)
			const entries = yield* ls(join(ws, shopDirectory("NameShop")))
			const folders = Arr.filter(entries, (n) => n !== snapshotFileName)
			assert.equal(folders.length, times.length)
			for (const [i, time] of times.entries()) {
				const name = folders[i]
				assert.ok(name !== undefined && isFolderName(name), Arr.join(folders, ", "))
				assert.ok(pipe(name, Str.startsWith(formatTimestamp(time))), name)
			}
		})
	)

	it.effect("drafts a schema's residual laws and derived relations", () =>
		Effect.gen(function* () {
			const ws = yield* workspace("ledger")
			yield* writeConfig(ws, {
				schemas: [{ name: "GenLedger", fixture: "ledger" }],
				connection: viaDatabaseUrl
			})
			const r = yield* cli(ws, ["generate", "--name", "init"], at(2026, 10, 12, 12, 0, 0), {})
			assert.equal(r.code, 0, r.stderr)
			const expected = directDraft(
				"GenLedger",
				formatTimestamp(at(2026, 10, 12, 12, 0, 0)),
				"ledger"
			)
			const dir = join(ws, "migrations", expected.snapshot.schema)
			const folder = join(dir, expected.folder.name)
			const folderEntries = yield* ls(folder)
			assert.deepEqual(
				folderEntries,
				Arr.sort([metaFileName, ...Arr.map(expected.folder.files, (f) => f.name)], Order.String)
			)
			for (const f of expected.folder.files) {
				const fileText = yield* read(join(folder, f.name))
				assert.equal(fileText, f.text)
			}
			const snapshotText = yield* read(join(dir, snapshotFileName))
			assert.equal(snapshotText, expected.snapshotText)
			/** The residual law's function and the derived relation's view are drafted with the rest. */
			const kinds = Arr.map(expected.snapshot.manifest.objects, (o) => o.kind)
			contains(kinds, "lawFunction")
			contains(kinds, "materializedView")
		})
	)

	it.effect(
		"drafts the validation of a closed payload's refinement in Publish, the snapshot the schema alone determines",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("closed")
				const r = yield* cliOver(
					ws,
					defineConfig({ schemas: [tierSchema("GenTier")], logins: [] }),
					["generate", "--name", "init"],
					at(2026, 10, 12, 12, 0, 0)
				)
				assert.equal(r.code, 0, r.stderr)
				const owned = owning(tierSchema("GenTier"))
				const dir = join(ws, "migrations", owned.installation.identifier)
				const folder = join(dir, "20261012120000_init")
				const expected = succeeded(
					generate({
						installation: succeeded(compileInstallation(owned, installOptions(owned, undefined))),
						name: "init",
						timestamp: "20261012120000",
						previous: fromEmpty,
						workload: noWorkload
					})
				)
				const folderEntries = yield* ls(folder)
				assert.deepEqual(
					folderEntries,
					Arr.sort([metaFileName, ...Arr.map(expected.folder.files, (f) => f.name)], Order.String)
				)
				for (const f of expected.folder.files) {
					const fileText = yield* read(join(folder, f.name))
					assert.equal(fileText, f.text)
				}
				assert.equal(
					validationFile(expected).phase,
					"publish",
					"the draft validates the payload's refinement in Publish"
				)
				const snapshotText = yield* read(join(dir, "snapshot.json"))
				const snapshot = succeeded(readSnapshot(snapshotText))
				/** The first migration's target from the empty snapshot, drafted from the schema alone. */
				const derived = succeeded(
					generate({
						installation: compile(tierSchema("GenTier"), {
							schema: atDeclaredName,
							owner: unowned,
							extensions: []
						}),
						name: "admission",
						timestamp: "20000101000000",
						previous: fromEmpty,
						workload: noWorkload
					})
				)
				assert.equal(derived.snapshot.fingerprint, snapshot.fingerprint)
			})
	)

	it.effect(
		"reports each marker with what to do, and a folder in the same second sorts after the last",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("marker")
				yield* writeConfig(ws, {
					schemas: [{ name: "MarkShop", fixture: "shop", version: 1, workload: "none" }],
					connection: viaDatabaseUrl
				})
				const now = at(2026, 10, 12, 12, 0, 0)
				const first = yield* cli(ws, ["generate", "--name", "init"], now, {})
				assert.equal(first.code, 0)
				yield* writeConfig(ws, {
					schemas: [{ name: "MarkShop", fixture: "shop", version: 2, workload: "none" }],
					connection: viaDatabaseUrl
				})
				const tier = yield* cli(ws, ["generate", "--name", "tier"], now, {})
				assert.equal(tier.code, 0, tier.stderr)
				const dir = join(ws, shopDirectory("MarkShop"))
				const entries = yield* ls(dir)
				const folders = Arr.filter(entries, (n) => n !== snapshotFileName)
				const [init, second] = folders
				assert.equal(folders.length, 2)
				assert.ok(init !== undefined && second !== undefined, "two drafted folders")
				assert.ok(isFolderName(init) && isFolderName(second), Arr.join(folders, ", "))
				assert.ok(second > init, "the folder drafted in the same second sorts after the last")
				const snapshotText = yield* read(join(dir, snapshotFileName))
				const snapshot = succeeded(readSnapshot(snapshotText))
				const metaText = yield* read(join(dir, second, metaFileName))
				const meta = succeeded(readMeta(metaText))
				assert.equal(meta.target, snapshot.fingerprint)
				assert.equal(meta.kind, "drafted")
			})
	)

	it.effect(
		"--custom writes an empty folder of the committed snapshot and leaves snapshot.json alone",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("custom")
				yield* writeConfig(ws, {
					schemas: [{ name: "CustShop", fixture: "shop", version: 1, workload: "none" }],
					connection: viaDatabaseUrl
				})
				const first = yield* cli(ws, ["generate"], at(2026, 10, 12, 12, 0, 1), {})
				assert.equal(first.code, 0)
				const dir = join(ws, shopDirectory("CustShop"))
				const before = yield* read(join(dir, "snapshot.json"))
				const custom = yield* cli(
					ws,
					["generate", "--custom", "--name", "backfill"],
					at(2026, 10, 12, 12, 0, 2),
					{}
				)
				assert.equal(custom.code, 0, custom.stderr)
				const backfillEntries = yield* ls(join(dir, "20261012120002_backfill"))
				assert.deepEqual(backfillEntries, [metaFileName])
				const metaText = yield* read(join(dir, "20261012120002_backfill/meta.json"))
				const meta = succeeded(readMeta(metaText))
				const snapshot = succeeded(readSnapshot(before))
				assert.deepEqual(
					[meta.source, meta.target, meta.kind],
					[snapshot.fingerprint, snapshot.fingerprint, "custom"]
				)
				const snapshotText = yield* read(join(dir, "snapshot.json"))
				assert.equal(snapshotText, before)
			})
	)

	it.effect(
		"drafts every configured schema; --schema chooses one when there are several, and --custom needs it there",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("two")
				yield* writeConfig(ws, {
					schemas: [
						{ name: "TwoA", fixture: "shop", version: 1, workload: "none" },
						{ name: "TwoB", fixture: "shop", version: 1, workload: "none" }
					],
					connection: viaDatabaseUrl
				})
				const both = yield* cli(ws, ["generate"], nextNow(), {})
				assert.equal(both.code, 0, both.stderr)
				const draftedA = yield* ls(join(ws, shopDirectory("TwoA")))
				assert.equal(draftedA.length, 2)
				const draftedB = yield* ls(join(ws, shopDirectory("TwoB")))
				assert.equal(draftedB.length, 2)

				const custom = yield* cli(ws, ["generate", "--custom"], nextNow(), {})
				assert.equal(custom.code, 2)
				const unknown = yield* cli(ws, ["generate", "--schema", "Nope"], nextNow(), {})
				assert.equal(unknown.code, 2)
				const chosen = yield* cli(
					ws,
					["generate", "--custom", "--schema", shopIdent("TwoB"), "--name", "data"],
					nextNow(),
					{}
				)
				assert.equal(chosen.code, 0, chosen.stderr)
				const keptA = yield* ls(join(ws, shopDirectory("TwoA")))
				assert.equal(keptA.length, 2)
				const customB = yield* ls(join(ws, shopDirectory("TwoB")))
				assert.equal(customB.length, 3)

				yield* writeConfig(ws, {
					schemas: [{ name: "TwoA", fixture: "shop", version: 1, workload: "none" }],
					connection: viaDatabaseUrl
				})
				const single = yield* cli(ws, ["generate", "--schema", shopIdent("TwoA")], nextNow(), {})
				assert.equal(single.code, 2)
			})
	)

	it.effect(
		"ignores hidden entries, an editor's or the system's, beside the migration folders",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("hidden")
				yield* writeConfig(ws, {
					schemas: [{ name: "HiddenShop", fixture: "shop", version: 1, workload: "none" }],
					connection: viaDatabaseUrl
				})
				const first = yield* cli(ws, ["generate"], nextNow(), {})
				assert.equal(first.code, 0)
				const dir = join(ws, shopDirectory("HiddenShop"))
				yield* write(join(dir, ".DS_Store"), "")
				yield* writeConfig(ws, {
					schemas: [{ name: "HiddenShop", fixture: "shop", version: 2, workload: "none" }],
					connection: viaDatabaseUrl
				})
				const beside = yield* cli(ws, ["generate"], nextNow(), {})
				assert.equal(beside.code, 0)
			})
	)

	it.effect(
		"drafts every schema before writing any: a refused schema leaves the others untouched",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("atomic")
				yield* writeConfig(ws, {
					schemas: [
						{ name: "AtomA", fixture: "shop", version: 1, workload: "none" },
						{ name: "AtomB", fixture: "shop", version: 1, workload: "none" }
					],
					connection: viaDatabaseUrl
				})
				const fs = yield* FileSystem.FileSystem
				yield* fs.makeDirectory(join(ws, "migrations"))
				yield* write(join(ws, shopDirectory("AtomB")), "not a directory\n")
				const r = yield* cli(ws, ["generate"], nextNow(), {})
				assert.equal(r.code, 1)
				const schemaFolders = yield* ls(join(ws, "migrations"))
				assert.deepEqual(schemaFolders, [shopIdent("AtomB")])
			})
	)

	it.effect(
		"refuses another schema's snapshot, writing nothing; a role change needs no new snapshot",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("foreign")
				yield* writeConfig(ws, {
					schemas: [
						{ name: "OwnA", fixture: "shop", version: 1, workload: "none" },
						{ name: "OwnB", fixture: "shop", version: 1, workload: "none" }
					],
					connection: viaDatabaseUrl
				})
				const first = yield* cli(ws, ["generate"], nextNow(), {})
				assert.equal(first.code, 0)
				const dirA = join(ws, shopDirectory("OwnA"))
				const dirB = join(ws, shopDirectory("OwnB"))
				const listing = Effect.all([ls(dirA), ls(dirB)])
				const before = yield* listing
				yield* writeConfig(ws, {
					schemas: [
						{ name: "OwnA", fixture: "shop", version: 2, workload: "none" },
						{ name: "OwnB", fixture: "shop", version: 1, workload: "none" }
					],
					connection: viaDatabaseUrl
				})
				const ownSnapshot = yield* read(join(dirA, "snapshot.json"))
				const snapshotB = yield* read(join(dirB, "snapshot.json"))
				yield* write(join(dirA, "snapshot.json"), snapshotB)
				const foreign = yield* cli(ws, ["generate"], nextNow(), {})
				assert.equal(foreign.code, 1)
				const after = yield* listing
				assert.deepEqual(after, before)
				yield* write(join(dirA, "snapshot.json"), ownSnapshot)
				const restored = yield* cli(ws, ["generate"], nextNow(), {})
				assert.equal(restored.code, 0)
			})
	)

	it.effect(
		"refuses a malformed name or configuration with the fix, never touching a connection, and prints the usage",
		() =>
			Effect.gen(function* () {
				const ws = yield* workspace("config")
				const missing = yield* bin(ws, ["generate"], {})
				assert.equal(missing.status, 1)
				const plain = yield* cliOver(ws, { schemas: [] }, ["check"], nextNow())
				assert.equal(plain.code, 1)
				const configured = (text: string) => writeConfigText(ws, text)
				const define = `import { defineConfig } from "@bjornpagen/grizzle"\n`
				yield* configured(`${define}export default defineConfig({ schemas: [] })\n`)
				const empty = yield* bin(ws, ["migrate"], {})
				assert.equal(empty.status, 1)
				yield* configured(`${define}export default defineConfig({ schemas: [{ name: "Shop" }] })\n`)
				const malformed = yield* bin(ws, ["generate"], {})
				assert.equal(malformed.status, 1)
				yield* configured(`throw new Error("broken config")\n`)
				const broken = yield* bin(ws, ["generate"], {})
				assert.equal(broken.status, 1)

				yield* writeConfig(ws, {
					schemas: [{ name: "NameShop", fixture: "shop", version: 1, workload: "none" }],
					connection: { kind: "typed", database: "unused", password: "owner", port: 70000 }
				})
				const generated = yield* cli(ws, ["generate"], nextNow(), {})
				assert.equal(generated.code, 0)
				const checked = yield* cli(ws, ["check"], nextNow(), {})
				assert.equal(checked.code, 0)
				const refused = yield* cli(ws, ["migrate"], nextNow(), {})
				assert.equal(refused.code, 1)
				yield* writeConfig(ws, {
					schemas: [{ name: "NameShop", fixture: "shop", version: 1, workload: "none" }],
					connection: viaDatabaseUrl
				})
				const unset = yield* cli(ws, ["migrate"], nextNow(), {})
				assert.equal(unset.code, 1)

				const bad = yield* cli(ws, ["generate", "--name", "Add Tier"], nextNow(), {})
				assert.equal(bad.code, 2)
				const help = yield* cli(ws, ["--help"], nextNow(), {})
				assert.equal(help.code, 0)
				const unknown = yield* cli(ws, ["migrate", "status"], nextNow(), {})
				assert.equal(unknown.code, 2)
			})
	)
})
