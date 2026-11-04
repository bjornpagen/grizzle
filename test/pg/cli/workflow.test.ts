import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import {
	type Command,
	type Machine,
	type Program,
	program,
	type Real,
	runProgram
} from "@grizzle/testing/commands"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, constant, element } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Order,
	type PlatformError,
	pipe,
	Redacted,
	Result,
	Schema,
	Scope,
	String as Str
} from "effect"
import { decodeMeta } from "#adapter/boundary/meta.ts"
import { OpenError } from "#adapter/errors/execution.ts"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import { Db } from "#adapter/public/db.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import { writeMeta } from "#compiler/deploy/render/folder.ts"
import { findMarkers, placeholderMarker } from "#compiler/deploy/render/markers.ts"
import type { Uuid } from "#compiler/public/fields.ts"
import type { AnyLogin } from "#compiler/public/schema.ts"
import { placeholderToken, quoteIdent } from "#compiler/sql/print.ts"
import { shopV1, shopV2 } from "#test/pg/cli/fixture.ts"
import {
	type CliRun,
	cli,
	databaseUrl,
	migrationIdentity,
	cliClock,
	viaDatabaseUrl,
	workspace,
	writeConfig,
	wrongPassword
} from "#test/pg/cli/support.ts"
import { openMigrator } from "#test/pg/migrate/support.ts"
import { assert, defined, lacksText, succeeded } from "#test/support/assert.ts"
import type { InitializedClusterShape } from "#test/support/cluster.ts"
import { pgPin } from "#test/support/env.ts"
import { loginRoleOf } from "#test/support/installed.ts"
import { readLedger } from "#test/support/migrate/ledger.ts"
import type { SqlError } from "#test/support/pg.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify } from "#test/support/worlds.ts"

/** The clock the in-process command lines of this file read. */
const nextNow = cliClock()

/**
 * The migration workflow a user runs, as a state machine over the command line, on PostgreSQL 19.
 *
 * The model is the documented loop (README "Migrations", packages/grizzle/skills/grizzle/SKILL.md "The loop" and "Refusals"): a
 * workspace whose grizzle.config.ts names the shop (test/pg/cli/fixture.ts) at version 1 or 2 with its full workload or
 * without its customer lookup, a migrations directory, and a database. Its state: the configuration, what the committed
 * snapshot was generated from, the folders written and the folders applied, the folders whose markers the reviewer has
 * not resolved, and a custom folder whose data step fails.
 * Each command is a step of the loop, run through `runCli` in process exactly as the bin runs it:
 *
 * - configure: a new grizzle.config.ts; `grizzle check` then refuses exactly when the configuration differs from what
 *   the snapshot was generated from;
 * - `grizzle generate`: writes a folder exactly when the configuration changed, its added field's value a placeholder
 *   when the table existed before;
 * - review: the placeholders resolved, the marker lines deleted;
 * - `grizzle check`: passes exactly when everything is generated and resolved;
 * - `grizzle migrate` with DATABASE_URL: refuses before connecting, with nothing run, exactly when check would; else
 *   applies the pending folders, stopping at a custom data step that fails, which a rerun resumes once fixed, and
 *   refuses at its drift check after applying them while a stray table stands in the schema;
 * - `grizzle drift`: applies nothing, and passes exactly when the latest complete folder's target is the committed
 *   snapshot's configuration, with no partial folder, and the catalog is the snapshot's; a stray table, created behind grizzle's back and dropped after,
 *   is the drift it names;
 * - `grizzle generate --custom` with a data step, failing or not, and the fix of a failing one;
 * - tampering, undone after: snapshot.json or meta.json made unreadable or off the chain (check, migrate and generate
 *   all refuse, nothing written or run), or an applied file edited (migrate refuses, nothing run);
 * - Db.open against the committed snapshot: admitted exactly when every folder up to the last generated one is applied,
 *   a custom folder after it keeping the snapshot's target;
 * - `grizzle migrate` with a wrong password: refused at its connection, nothing run;
 * - scenarios, each a step drawn with the steps that make it reachable: a workload program removed, a placeholder
 *   reviewed, a folder resumed after its failing data step was fixed, Db.open admitting a database fully applied, and
 *   Db.open refusing one a new snapshot is generated over.
 *
 * After every command the real workspace and database are read back and must be what the model claims: the exit code,
 * the folders on disk, the folders the ledger records complete, and after every refusal that runs nothing, the ledger
 * unchanged. Universal: no command ever prints the migration identity's password or a wrong one it was given. What
 * the commands reach is noted through the case the exploration hands the property.
 *
 * The model's commands are pure: whether each applies, what it draws and the state it leaves are judged by the model
 * alone, so a workflow is generated, printed and shrunk as data, and each command's run on the workspace checks the
 * real state against the model's states before and after it.
 *
 * The workloads a workflow configures the shop with: both programs, or ordersOf alone.
 */
type Workload = "full" | "withoutByName"

interface Configured {
	readonly version: 1 | 2
	readonly workload: Workload
}

interface Model {
	readonly config: Configured
	/** What the committed snapshot was generated from; undefined before the first generate. */
	readonly generated: Configured | undefined
	readonly folders: number
	/**
	 * The configuration each folder's target was generated from, in folder order: a custom folder keeps the target
	 * before it. Two folders may share one, as when a change and its undoing are generated in turn.
	 */
	readonly targets: ReadonlyArray<Configured>
	readonly applied: number
	/** Folders not yet applied whose markers are unresolved. */
	readonly unresolved: number
	/** The position of a custom folder whose data step fails, not yet fixed. */
	readonly failing: number | undefined
	/** Whether the failing custom folder recorded its first file: the folder is partial. */
	readonly partial: boolean
	/** Custom data steps written, for unique row ids. */
	readonly steps: number
	/** Whether a table created behind grizzle's back stands in the schema: the catalog drifts from the snapshot. */
	readonly stray: boolean
}

/** What a workflow's steps run on: the substrate, and Node's FileSystem, Path and child processes. */
type Services = Substrate | NodeServices.NodeServices

/** What a workflow's step fails with: a workspace file it reads or writes, the ledger, or a statement it runs. */
type StepError = PlatformError.PlatformError | MigrateError | SqlError

/** The workspace and database one workflow runs on. */
interface Workspace {
	readonly dir: string
	readonly schema: string
	readonly database: string
	/** The initialised cluster the substrate was built from: the migration identity's password and the CA. */
	readonly cluster: InitializedClusterShape
	readonly env: Readonly<Record<string, string>>
	/** The case the exploration hands the property: every step a command reaches is noted through it. */
	readonly c: Case<CommandKind>
	/** The folders the ledger records complete. */
	readonly applied: Effect.Effect<ReadonlyArray<string>, MigrateError, Services>
	/**
	 * A login's role given a password once, for the rest of the workflow: the substrate's login finalizer drops the role
	 * (substrate.ts login), so one in a command's own scope would drop the installed login when the command ended, and
	 * every later migrate would meet a catalog without it.
	 */
	readonly login: (login: AnyLogin) => Effect.Effect<Credentials, SqlError, Services>
}

const commandKinds = [
	"configure",
	"generate a change",
	"generate no change",
	"review",
	"check passes",
	"check refuses",
	"migrate applies",
	"migrate refuses before connecting",
	"migrate stops at a failing data step",
	"migrate resumes a partial folder",
	"migrate refuses at drift",
	"drift passes",
	"drift refuses",
	"plant a stray table",
	"remove the stray table",
	"custom data step",
	"fix the data step",
	"tamper with snapshot.json",
	"tamper with meta.json",
	"tamper with an applied file",
	"Db.open admits",
	"Db.open refuses",
	"wrong password"
] as const
type CommandKind = (typeof commandKinds)[number]

const same = (a: Configured | undefined, b: Configured): boolean =>
	a !== undefined && a.version === b.version && a.workload === b.workload

/**
 * Whether the latest complete folder's target is the committed snapshot: the configuration the last applied folder
 * was generated from is the one the snapshot was. A fingerprint is the configuration's, so pending folders that come
 * back to it leave the database at the snapshot.
 */
const atSnapshot = (model: Readonly<Model>): boolean =>
	model.generated !== undefined && same(model.targets[model.applied - 1], model.generated)

/** Whether `grizzle check` passes: everything generated and resolved. */
const checks = (model: Readonly<Model>): boolean =>
	same(model.generated, model.config) && model.unresolved === 0

const id = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

const schemaDir = (r: Workspace) => `${r.dir}/migrations/${r.schema}`

/** The migration folders on disk, in name order: none before the schema's directory exists. */
const foldersOnDisk = (r: Workspace) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		if (!(yield* fs.exists(schemaDir(r)))) {
			return []
		}
		const entries = yield* fs.readDirectory(schemaDir(r))
		return Arr.sort(
			Arr.filter(entries, (n) => n !== "snapshot.json" && !Str.startsWith(".")(n)),
			Order.String
		)
	})

/** The text of a file of the workspace. */
const readText = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.readFileString(path)
	})

/** Writes a file of the workspace. */
const writeText = (path: string, text: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.writeFileString(path, text)
	})

/** The SQL files of a folder, in the order the directory lists them. */
const sqlFiles = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return Arr.filter(yield* fs.readDirectory(dir), (f) => Str.endsWith(".sql")(f))
	})

/** Runs a command line in the workspace, and holds the universal property: no password in its output. */
const command = (
	r: Workspace,
	argv: ReadonlyArray<string>,
	env: Readonly<Record<string, string>>
) =>
	Effect.map(cli(r.dir, argv, nextNow(), env), (ran: CliRun) => {
		for (const secret of [Redacted.value(r.cluster.devPassword), wrongPassword]) {
			lacksText(
				`${ran.stdout}${ran.stderr}`,
				secret,
				`grizzle ${Arr.join(argv, " ")} printed a password`
			)
		}
		return ran
	})

/** The real state the model claims: the folders on disk and the folders the ledger records complete. */
const confirm = (model: Readonly<Model>, r: Workspace) =>
	Effect.gen(function* () {
		assert.equal((yield* foldersOnDisk(r)).length, model.folders, "the folders on disk")
		assert.equal(
			(yield* r.applied).length,
			model.applied,
			"the folders the ledger records complete"
		)
	})

/** `grizzle check`, passing exactly when the model says it does. */
const expectCheck = (model: Readonly<Model>, r: Workspace) =>
	Effect.gen(function* () {
		const passes = checks(model)
		r.c.note(passes ? "check passes" : "check refuses")
		const ran = yield* command(r, ["check"], r.env)
		assert.equal(ran.code, passes ? 0 : 1, `grizzle check: ${ran.stdout}${ran.stderr}`)
	})

/** The table a drift step creates in the schema behind grizzle's back. */
const strayTable = "stray_by_hand"

const tamperKinds = ["snapshot.json", "meta.json", "an applied file"] as const
type TamperKind = (typeof tamperKinds)[number]

/**
 * The text of a file tampered with: a comment above an applied file, snapshot.json made unreadable, or
 * meta.json taken off the chain (its source and target another snapshot's).
 */
const tampered = (kind: TamperKind, original: string): string => {
	switch (kind) {
		case "an applied file":
			return `-- tuned\n${original}`
		case "snapshot.json":
			return "{ not json\n"
		case "meta.json": {
			const read = succeeded(decodeMeta(original))
			const elsewhere = SchemaFingerprint(Str.repeat(64)("0"))
			return succeeded(writeMeta({ ...read, source: elsewhere, target: elsewhere }))
		}
	}
}

/** The first SQL file of the first applied folder that has one, none when no applied folder has one. */
const appliedFile = (model: Readonly<Model>, r: Workspace, folders: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		for (const folder of folders.slice(0, model.applied)) {
			const file = Arr.head(yield* sqlFiles(`${schemaDir(r)}/${folder}`))
			if (Option.isSome(file)) {
				return Option.some(`${schemaDir(r)}/${folder}/${file.value}`)
			}
		}
		return Option.none<string>()
	})

/** The file a tampering of `kind` edits, none when there is none to edit. */
const tamperedFile = (kind: TamperKind, model: Readonly<Model>, r: Workspace) =>
	Effect.gen(function* () {
		const folders = yield* foldersOnDisk(r)
		switch (kind) {
			case "snapshot.json":
				return Option.some(`${schemaDir(r)}/snapshot.json`)
			case "meta.json":
				return Option.map(Arr.last(folders), (folder) => `${schemaDir(r)}/${folder}/meta.json`)
			case "an applied file":
				return yield* appliedFile(model, r, folders)
		}
	})

/** The commands a tampering of `kind` makes refuse, running nothing and writing nothing. */
const refusedWhileTampered = (kind: TamperKind, r: Workspace) =>
	Effect.gen(function* () {
		const before = yield* r.applied
		const migrated = yield* command(r, ["migrate"], r.env)
		assert.equal(migrated.code, 1, `migrate with ${kind} tampered: ${migrated.stdout}`)
		assert.deepEqual(yield* r.applied, before, "nothing ran")
		if (kind === "an applied file") {
			return
		}
		const checked = yield* command(r, ["check"], r.env)
		assert.equal(checked.code, 1, `check with ${kind} tampered`)
		const listing = yield* foldersOnDisk(r)
		const generated = yield* command(r, ["generate"], r.env)
		assert.equal(generated.code, 1, `generate with ${kind} tampered`)
		assert.deepEqual(yield* foldersOnDisk(r), listing, "generate wrote nothing")
	})

/** A plain step of the loop: one command, with what it was drawn with. */
type Plain =
	| { readonly kind: "configure"; readonly config: Configured }
	| { readonly kind: "generate" }
	| { readonly kind: "review" }
	| { readonly kind: "check" }
	| { readonly kind: "migrate" }
	| { readonly kind: "drift" }
	| { readonly kind: "stray"; readonly plant: boolean }
	| { readonly kind: "custom"; readonly failing: boolean }
	| { readonly kind: "fix" }
	| { readonly kind: "tamper"; readonly tamper: TamperKind }
	| { readonly kind: "open" }
	| { readonly kind: "wrong password" }

/**
 * Whether a plain step applies in a state of the model:
 * - configure: versions only advance, since removing the field again is a rename story of its own;
 * - review: some folder's markers are unresolved;
 * - drift, a custom data step and Db.open: a snapshot is committed, and for the last two no failing data step or
 *   partial folder is pending;
 * - a stray table: the first migration created the schema, and the table is not already as the step leaves it;
 * - fix: a failing data step is pending;
 * - tampering with an applied file: some folder is applied and none is partial; with snapshot.json or meta.json: some
 *   folder is written;
 * - a wrong password: check passes and some folder is pending.
 */
const appliesTo = (model: Model, step: Plain): boolean => {
	switch (step.kind) {
		case "configure":
			return step.config.version >= model.config.version
		case "generate":
		case "check":
		case "migrate":
			return true
		case "review":
			return model.unresolved > 0
		case "drift":
			return model.generated !== undefined
		case "stray":
			return model.applied > 0 && model.stray !== step.plant
		case "custom":
			return model.generated !== undefined && model.failing === undefined
		case "fix":
			return model.failing !== undefined
		case "tamper":
			return step.tamper === "an applied file"
				? model.applied > 0 && !model.partial
				: model.folders > 0
		case "open":
			return model.generated !== undefined && model.failing === undefined && !model.partial
		case "wrong password":
			return checks(model) && model.folders > model.applied
	}
}

/**
 * The state of the model after a plain step:
 * - configure: the new configuration;
 * - generate: a folder exactly when the configuration changed, its target the configuration, a placeholder to review
 *   when version 2 is generated over version 1;
 * - review: every marker resolved;
 * - migrate: nothing when check refuses; up to a failing data step, its folder partial; otherwise every folder, a
 *   stray table refused only after them;
 * - a stray table: planted or dropped;
 * - a custom data step: a folder whose target is the committed snapshot's, failing at its position or not;
 * - fix: the failing data step fixed;
 * - check, drift, a tampering (undone after), Db.open and a wrong password: nothing.
 */
const advance = (model: Model, step: Plain): Model => {
	switch (step.kind) {
		case "configure":
			return { ...model, config: step.config }
		case "generate":
			return same(model.generated, model.config)
				? model
				: {
						...model,
						folders: model.folders + 1,
						targets: [...model.targets, model.config],
						unresolved:
							model.generated?.version === 1 && model.config.version === 2
								? model.unresolved + 1
								: model.unresolved,
						generated: model.config
					}
		case "review":
			return { ...model, unresolved: 0 }
		case "migrate":
			return !checks(model)
				? model
				: model.failing !== undefined
					? { ...model, applied: model.failing, partial: true }
					: { ...model, applied: model.folders, partial: false }
		case "stray":
			return { ...model, stray: step.plant }
		case "custom":
			return {
				...model,
				steps: model.steps + 1,
				failing: step.failing ? model.folders : model.failing,
				targets: [
					...model.targets,
					defined(model.generated, "a custom folder keeps the committed snapshot's target")
				],
				folders: model.folders + 1
			}
		case "fix":
			return { ...model, failing: undefined }
		case "check":
		case "drift":
		case "tamper":
		case "open":
		case "wrong password":
			return model
	}
}

/** A plain step as a failure report names it. */
const describeStep = (step: Plain): string => {
	switch (step.kind) {
		case "configure":
			return `configure version ${step.config.version}, workload ${step.config.workload}`
		case "generate":
			return "grizzle generate"
		case "review":
			return "review the placeholders"
		case "check":
			return "grizzle check"
		case "migrate":
			return "grizzle migrate"
		case "drift":
			return "grizzle drift"
		case "stray":
			return step.plant ? "a table created by hand in the schema" : "the hand-made table dropped"
		case "custom":
			return `grizzle generate --custom with a ${step.failing ? "failing" : "passing"} data step`
		case "fix":
			return "fix the failing data step"
		case "tamper":
			return `tamper with ${step.tamper}`
		case "open":
			return "Db.open against the committed snapshot"
		case "wrong password":
			return "grizzle migrate with a wrong password"
	}
}

/** A new grizzle.config.ts; `grizzle check` then refuses exactly when the configuration differs from the snapshot's. */
const runConfigure = (r: Workspace, config: Configured, after: Model) =>
	Effect.gen(function* () {
		r.c.note("configure")
		yield* writeConfig(r.dir, {
			schemas: [
				{ name: r.schema, fixture: "shop", version: config.version, workload: config.workload }
			],
			connection: viaDatabaseUrl
		})
		yield* expectCheck(after, r)
	})

/** `grizzle generate`: the snapshot changes exactly when the draft does. */
const runGenerate = (r: Workspace, before: Model, after: Model) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const changed = !same(before.generated, before.config)
		r.c.note(changed ? "generate a change" : "generate no change")
		const snapshotFile = `${schemaDir(r)}/snapshot.json`
		const previous = (yield* fs.exists(snapshotFile))
			? Option.some(yield* fs.readFileString(snapshotFile))
			: Option.none()
		const ran = yield* command(r, ["generate"], r.env)
		assert.equal(ran.code, 0, ran.stderr)
		const written = yield* fs.readFileString(snapshotFile)
		assert.equal(
			!Option.contains(previous, written),
			changed,
			"the snapshot changes exactly when the draft does"
		)
		yield* confirm(after, r)
	})

/** The reviewer resolves every placeholder of the folders not yet applied and deletes the marker lines. */
const runReview = (r: Workspace, before: Model, after: Model) =>
	Effect.gen(function* () {
		r.c.note("review")
		for (const folder of (yield* foldersOnDisk(r)).slice(before.applied)) {
			const dir = `${schemaDir(r)}/${folder}`
			for (const file of yield* sqlFiles(dir)) {
				const text = yield* readText(`${dir}/${file}`)
				yield* writeText(
					`${dir}/${file}`,
					pipe(
						Arr.join(
							Arr.filter(Str.split(text, "\n"), (l) => !Str.startsWith(placeholderMarker)(l)),
							"\n"
						),
						Str.replaceAll(placeholderToken, "3")
					)
				)
				assert.deepEqual(
					findMarkers(yield* readText(`${dir}/${file}`)),
					[],
					`${folder}/${file} reviewed`
				)
			}
		}
		yield* confirm(after, r)
	})

/**
 * `grizzle migrate`: refuses before connecting, with nothing run, exactly when check would; else applies the pending
 * folders, stopping at a failing data step, which a rerun resumes once fixed, and refuses at its drift check after
 * applying them while a stray table stands in the schema.
 */
const runMigrate = (r: Workspace, before: Model, after: Model) =>
	Effect.gen(function* () {
		const applied = yield* r.applied
		const ran = yield* command(r, ["migrate"], r.env)
		if (!checks(before)) {
			r.c.note("migrate refuses before connecting")
			assert.equal(ran.code, 1, ran.stdout)
			assert.deepEqual(yield* r.applied, applied, "nothing ran")
		} else if (before.failing !== undefined) {
			r.c.note("migrate stops at a failing data step")
			assert.equal(ran.code, 1, ran.stdout)
		} else if (before.stray) {
			r.c.note("migrate refuses at drift")
			assert.equal(ran.code, 1, ran.stdout)
			assert.ok(
				Str.includes("refused at stage drift")(ran.stderr) && Str.includes(strayTable)(ran.stderr),
				ran.stderr
			)
		} else {
			r.c.note(before.partial ? "migrate resumes a partial folder" : "migrate applies")
			assert.equal(ran.code, 0, ran.stderr)
		}
		yield* confirm(after, r)
	})

/**
 * `grizzle drift`: applies nothing, and passes exactly when the database is at the committed snapshot. The ledger
 * reaches the snapshot once every folder up to the last generated one is applied, with no partial folder; a stray
 * table is drift of the catalog itself.
 */
const runDrift = (r: Workspace, model: Model) =>
	Effect.gen(function* () {
		const matches = atSnapshot(model) && !model.partial && !model.stray
		r.c.note(matches ? "drift passes" : "drift refuses")
		const applied = yield* r.applied
		const ran = yield* command(r, ["drift"], r.env)
		assert.equal(ran.code, matches ? 0 : 1, `grizzle drift: ${ran.stdout}${ran.stderr}`)
		if (model.stray) {
			assert.ok(
				Str.includes(strayTable)(ran.stderr),
				`the drift names the stray table: ${ran.stderr}`
			)
		}
		assert.deepEqual(yield* r.applied, applied, "drift applies nothing")
		yield* confirm(model, r)
	})

/** A table created in the schema by hand, outside every migration, or dropped again. */
const runStray = (r: Workspace, plant: boolean, after: Model) =>
	Effect.gen(function* () {
		r.c.note(plant ? "plant a stray table" : "remove the stray table")
		const table = `${quoteIdent(r.schema)}.${quoteIdent(strayTable)}`
		const sql = plant ? `CREATE TABLE ${table} (a int4)` : `DROP TABLE ${table}`
		const substrate = yield* Substrate
		yield* substrate.admin.query(sql, [])
		yield* confirm(after, r)
	})

/** `grizzle generate --custom` with a data step, failing or not: the newest folder, keeping the snapshot's target. */
const runCustom = (r: Workspace, failing: boolean, before: Model, after: Model) =>
	Effect.gen(function* () {
		r.c.note("custom data step")
		const ran = yield* command(r, ["generate", "--custom", "--name", "step"], r.env)
		assert.equal(ran.code, 0, ran.stderr)
		const folder = Arr.last(yield* foldersOnDisk(r))
		assert.ok(Option.exists(folder, Str.endsWith("_step")), "the custom folder is the newest")
		const dir = `${schemaDir(r)}/${Option.getOrThrow(folder)}`
		const tier = before.generated?.version === 2 ? `, "tier"` : ""
		const tierValue = before.generated?.version === 2 ? ", 1" : ""
		yield* writeText(
			`${dir}/01-customers.sql`,
			`INSERT INTO "${r.schema}"."customer" ("id", "name"${tier}) VALUES ('${id(after.steps)}'::uuid, 'ada'${tierValue});\n`
		)
		yield* writeText(`${dir}/02-check.sql`, failing ? "SELECT 1 / 0;\n" : "SELECT 1;\n")
		yield* confirm(after, r)
	})

/** The failing data step fixed. */
const runFix = (r: Workspace, before: Model, after: Model) =>
	Effect.gen(function* () {
		r.c.note("fix the data step")
		const failing = defined(before.failing, "a failing custom folder")
		const folder = defined((yield* foldersOnDisk(r))[failing], "the failing custom folder")
		yield* writeText(`${schemaDir(r)}/${folder}/02-check.sql`, "SELECT 2;\n")
		yield* confirm(after, r)
	})

/**
 * A tampering, undone after the commands it must make refuse. A reviewer's comment edits an applied file; any other
 * edit of snapshot.json or meta.json changes its content, written back through its own codec.
 */
const runTamper = (r: Workspace, kind: TamperKind, model: Model) =>
	Effect.gen(function* () {
		r.c.note(`tamper with ${kind}`)
		const file = yield* tamperedFile(kind, model, r)
		if (Option.isNone(file)) {
			return
		}
		const path = file.value
		const original = yield* readText(path)
		yield* writeText(path, tampered(kind, original))
		yield* Effect.ensuring(refusedWhileTampered(kind, r), Effect.orDie(writeText(path, original)))
		yield* confirm(model, r)
	})

/**
 * Db.open against the committed snapshot: admits once the ledger's latest complete target is the snapshot, whichever
 * folders are still pending. The first migration creates the login's role: before it there is no role to log in as,
 * and any password is refused. Both versions' login is one login, `server`. Nothing applied leaves no reader to
 * authenticate; a pending folder leaves the ledger behind.
 */
const runOpen = (r: Workspace, model: Model) =>
	Effect.gen(function* () {
		const admits = atSnapshot(model)
		r.c.note(admits ? "Db.open admits" : "Db.open refuses")
		const snapshot = yield* readText(`${schemaDir(r)}/snapshot.json`)
		/** The configuration the committed snapshot was generated from: its schema value, its login's workload. */
		const generated = defined(
			model.generated,
			"the configuration the committed snapshot was generated from"
		)
		const v2 = shopV2(r.schema, generated.workload)
		const v1 = shopV1(r.schema, generated.workload)
		const password =
			model.applied === 0 ? Redacted.make(wrongPassword) : (yield* r.login(v1.server)).password
		const substrate = yield* Substrate
		const connection = {
			snapshot: snapshotJson(snapshot),
			host: pgPin.host,
			port: pgPin.port,
			database: substrate.database,
			password,
			tls: { ca: substrate.cluster.caPem },
			verify: testVerify
		}
		/** Opened as the reader of that schema value, through its login's layer given the committed snapshot. */
		const open: Effect.Effect<unknown, OpenError> =
			generated.version === 2
				? withLayer(
						Effect.scoped(Db.open(v2.server.roles.reader, {})),
						DbLayer.make({ ...connection, login: v2.server })
					)
				: withLayer(
						Effect.scoped(Db.open(v1.server.roles.reader, {})),
						DbLayer.make({ ...connection, login: v1.server })
					)
		const opened = yield* Effect.result(Effect.as(open, "admitted"))
		if (admits) {
			assert.ok(
				Result.isSuccess(opened),
				"Db.open admits the database once every folder is applied"
			)
		} else {
			assert.ok(
				Result.isFailure(opened),
				"Db.open refuses a database short of the committed snapshot"
			)
			assert.ok(Schema.is(OpenError)(opened.failure), `an OpenError, not ${String(opened.failure)}`)
			assert.equal(opened.failure.stage, model.applied === 0 ? "authentication" : "ledger")
		}
		yield* confirm(model, r)
	})

/** `grizzle migrate` with a wrong password: refused at its connection, nothing run. */
const runWrongPassword = (r: Workspace, model: Model) =>
	Effect.gen(function* () {
		r.c.note("wrong password")
		const applied = yield* r.applied
		const ran = yield* command(r, ["migrate"], {
			DATABASE_URL: databaseUrl(r.database, {
				...migrationIdentity(r.cluster),
				password: wrongPassword
			})
		})
		assert.equal(ran.code, 1, ran.stdout)
		assert.deepEqual(yield* r.applied, applied, "nothing ran")
		yield* confirm(model, r)
	})

/** Runs a plain step on the workspace, from the model's state before it to the state after it. */
const runStep = (
	r: Workspace,
	step: Plain,
	before: Model,
	after: Model
): Effect.Effect<void, StepError, Services> => {
	switch (step.kind) {
		case "configure":
			return runConfigure(r, step.config, after)
		case "generate":
			return runGenerate(r, before, after)
		case "review":
			return runReview(r, before, after)
		case "check":
			return Effect.andThen(expectCheck(before, r), confirm(before, r))
		case "migrate":
			return runMigrate(r, before, after)
		case "drift":
			return runDrift(r, before)
		case "stray":
			return runStray(r, step.plant, after)
		case "custom":
			return runCustom(r, step.failing, before, after)
		case "fix":
			return runFix(r, before, after)
		case "tamper":
			return runTamper(r, step.tamper, before)
		case "open":
			return runOpen(r, before)
		case "wrong password":
			return runWrongPassword(r, before)
	}
}

/** How a scenario plans its steps: each added in the state the ones before it leave, which `state` reads. */
type Plan = (state: () => Model, add: (step: Plain) => void) => void

/** The steps a plan takes from a state of the model. */
const planned = (model: Model, plan: Plan): ReadonlyArray<Plain> => {
	let state = model
	const steps: Array<Plain> = []
	plan(
		() => state,
		(step) => {
			steps.push(step)
			state = advance(state, step)
		}
	)
	return steps
}

/** Generates until the committed snapshot is the configuration's, and resolves the markers it leaves. */
const settle: Plan = (state, add) => {
	if (!same(state().generated, state().config)) {
		add({ kind: "generate" })
	}
	if (state().unresolved > 0) {
		add({ kind: "review" })
	}
}

/** A failing data step migrated into and fixed, when one is pending. */
const fixFailing: Plan = (state, add) => {
	if (state().failing !== undefined) {
		add({ kind: "migrate" })
		add({ kind: "fix" })
	}
}

/** A scenario: a step drawn with the steps that make it reachable, when it applies. */
interface Scenario {
	readonly applies: (model: Model) => boolean
	readonly plan: Plan
}

const always = (): boolean => true

/**
 * The scenarios:
 * - a workload program removed: the workload generated with its customer lookup, then without it, then generated once
 *   more; the removal drops the lookup's index in the folder that removes it, and the next generate drafts nothing;
 * - a placeholder reviewed: version 1 generated, then version 2, whose added field on the existing table is a
 *   placeholder; migrate refuses before connecting until the reviewer resolves it. Versions only advance: once version
 *   2 is generated, no later generate adds the field again;
 * - a folder resumed: a failing custom data step over a settled workspace; migrate stops at it, the step is fixed, and
 *   migrate resumes the partial folder;
 * - Db.open admitting: every folder applied over a settled workspace, a failing data step fixed on the way; generate
 *   drafts nothing, check passes, Db.open admits the database, and each tampering makes the commands refuse;
 * - a new workload pending: a settled, fully applied workspace whose workload then changes; migrate refuses before
 *   connecting until it is generated, then Db.open refuses the database short of the new snapshot, and migrate with a
 *   wrong password is refused at its connection, until migrate applies it;
 * - a stray table: a settled, fully applied workspace that drifts; drift passes, a table created by hand makes drift
 *   and migrate refuse it, and once it is dropped drift passes again.
 */
const scenarios = {
	"scenario: a workload program removed, its index dropped": {
		applies: always,
		plan: (state, add) => {
			const version = state().config.version
			if (state().config.workload !== "full") {
				add({ kind: "configure", config: { version, workload: "full" } })
			}
			if (!same(state().generated, state().config)) {
				add({ kind: "generate" })
			}
			add({ kind: "configure", config: { version, workload: "withoutByName" } })
			add({ kind: "generate" })
			add({ kind: "generate" })
		}
	},
	"scenario: version 2 generated over version 1, its placeholder reviewed": {
		applies: (model) =>
			model.generated === undefined ? model.config.version === 1 : model.generated.version === 1,
		plan: (state, add) => {
			if (state().config.version === 1 && !same(state().generated, state().config)) {
				add({ kind: "generate" })
			}
			if (state().config.version === 1) {
				add({ kind: "configure", config: { version: 2, workload: state().config.workload } })
			}
			add({ kind: "generate" })
			add({ kind: "migrate" })
			add({ kind: "review" })
		}
	},
	"scenario: a failing data step stops migrate, is fixed, and migrate resumes": {
		applies: always,
		plan: (state, add) => {
			settle(state, add)
			if (state().failing === undefined) {
				add({ kind: "custom", failing: true })
			}
			add({ kind: "migrate" })
			add({ kind: "fix" })
			add({ kind: "migrate" })
		}
	},
	"scenario: generated again, every folder applied, check passes, Db.open admits, each file tampered with":
		{
			applies: always,
			plan: (state, add) => {
				settle(state, add)
				add({ kind: "generate" })
				add({ kind: "check" })
				fixFailing(state, add)
				add({ kind: "migrate" })
				add({ kind: "open" })
				for (const tamper of tamperKinds) {
					add({ kind: "tamper", tamper })
				}
			}
		},
	"scenario: a new workload configured over an applied workspace: migrate refuses until it is generated, then Db.open refuses and a wrong password is refused until migrate":
		{
			applies: always,
			plan: (state, add) => {
				settle(state, add)
				fixFailing(state, add)
				add({ kind: "migrate" })
				const workload = state().config.workload === "full" ? "withoutByName" : "full"
				add({ kind: "configure", config: { version: state().config.version, workload } })
				add({ kind: "migrate" })
				add({ kind: "generate" })
				add({ kind: "open" })
				add({ kind: "wrong password" })
				add({ kind: "migrate" })
			}
		},
	"scenario: a table created by hand: drift and migrate refuse it until it is dropped": {
		applies: always,
		plan: (state, add) => {
			settle(state, add)
			fixFailing(state, add)
			if (state().stray) {
				add({ kind: "stray", plant: false })
			}
			add({ kind: "migrate" })
			add({ kind: "drift" })
			add({ kind: "stray", plant: true })
			add({ kind: "drift" })
			add({ kind: "migrate" })
			add({ kind: "stray", plant: false })
			add({ kind: "drift" })
		}
	}
} as const satisfies Readonly<Record<string, Scenario>>

type ScenarioName = keyof typeof scenarios

/**
 * Runs a scenario's steps in turn from the state before it, each from the state the ones before it leave: a step that
 * does not apply where the scenario puts it is a defect of the scenario.
 */
const runScenario = (r: Workspace, name: ScenarioName, before: Model) =>
	Effect.gen(function* () {
		let state = before
		for (const step of planned(before, scenarios[name].plan)) {
			assert.ok(appliesTo(state, step), `the scenario's step ${describeStep(step)} applies`)
			const after = advance(state, step)
			yield* runStep(r, step, state, after)
			state = after
		}
	})

/** The parameters each command of the workflow draws. */
type WorkflowParameters = {
	readonly configure: Configured
	readonly "grizzle generate": undefined
	readonly "review the placeholders": undefined
	readonly "grizzle check": undefined
	readonly "grizzle migrate": undefined
	readonly "grizzle generate --custom": boolean
	readonly "fix the failing data step": undefined
	readonly "tamper with snapshot.json": undefined
	readonly "tamper with meta.json": undefined
	readonly "tamper with an applied file": undefined
	readonly "Db.open against the committed snapshot": undefined
	readonly "grizzle migrate with a wrong password": undefined
	readonly "grizzle drift": undefined
	readonly "a table created by hand or dropped": undefined
	readonly "scenario: a workload program removed, its index dropped": undefined
	readonly "scenario: version 2 generated over version 1, its placeholder reviewed": undefined
	readonly "scenario: version 2 generated over version 1, its placeholder reviewed, drawn twice as often": undefined
	readonly "scenario: a failing data step stops migrate, is fixed, and migrate resumes": undefined
	readonly "scenario: generated again, every folder applied, check passes, Db.open admits, each file tampered with": undefined
	readonly "scenario: a new workload configured over an applied workspace: migrate refuses until it is generated, then Db.open refuses and a wrong password is refused until migrate": undefined
	readonly "scenario: a table created by hand: drift and migrate refuse it until it is dropped": undefined
}

/** A command of one plain step, which draws nothing. */
const plainCommand = (step: Plain): Command<Model, undefined> => ({
	applies: (model) => appliesTo(model, step),
	parameters: () => constant(undefined),
	next: (model) => advance(model, step)
})

/** A command of a scenario, which draws nothing. */
const scenarioCommand = (name: ScenarioName): Command<Model, undefined> => ({
	applies: scenarios[name].applies,
	parameters: () => constant(undefined),
	next: (model) => Arr.reduce(planned(model, scenarios[name].plan), model, advance)
})

/** The tampering each command of one kind makes. */
const tamperCommand = (tamper: TamperKind): Command<Model, undefined> =>
	plainCommand({ kind: "tamper", tamper })

const initialConfig: Configured = { version: 1, workload: "full" }

/**
 * The workflow as a state machine, its commands in the order a step's pick names them, each as likely as the others:
 * configure draws a version at least the configured one and a workload; a custom data step draws whether it fails; a
 * stray table is planted when none stands and dropped when one does. The review scenario is listed twice: review
 * applies only until version 2 is generated, so it reaches its step less often per draw.
 */
const workflow: Machine<Model, WorkflowParameters> = {
	initial: {
		config: initialConfig,
		generated: undefined,
		folders: 0,
		targets: [],
		applied: 0,
		unresolved: 0,
		failing: undefined,
		partial: false,
		steps: 0,
		stray: false
	},
	commands: {
		configure: {
			applies: always,
			parameters: (model) => (source) => ({
				version: source.draw(element<1 | 2>(model.config.version === 1 ? [1, 2] : [2])),
				workload: source.draw(element<Workload>(["full", "withoutByName"]))
			}),
			next: (model, config) => advance(model, { kind: "configure", config })
		},
		"grizzle generate": plainCommand({ kind: "generate" }),
		"review the placeholders": plainCommand({ kind: "review" }),
		"grizzle check": plainCommand({ kind: "check" }),
		"grizzle migrate": plainCommand({ kind: "migrate" }),
		"grizzle generate --custom": {
			applies: (model) => appliesTo(model, { kind: "custom", failing: false }),
			parameters: () => boolean,
			next: (model, failing) => advance(model, { kind: "custom", failing })
		},
		"fix the failing data step": plainCommand({ kind: "fix" }),
		"tamper with snapshot.json": tamperCommand("snapshot.json"),
		"tamper with meta.json": tamperCommand("meta.json"),
		"tamper with an applied file": tamperCommand("an applied file"),
		"Db.open against the committed snapshot": plainCommand({ kind: "open" }),
		"grizzle migrate with a wrong password": plainCommand({ kind: "wrong password" }),
		"grizzle drift": plainCommand({ kind: "drift" }),
		"a table created by hand or dropped": {
			applies: (model) => model.applied > 0,
			parameters: () => constant(undefined),
			next: (model) => advance(model, { kind: "stray", plant: !model.stray })
		},
		"scenario: a workload program removed, its index dropped": scenarioCommand(
			"scenario: a workload program removed, its index dropped"
		),
		"scenario: version 2 generated over version 1, its placeholder reviewed": scenarioCommand(
			"scenario: version 2 generated over version 1, its placeholder reviewed"
		),
		"scenario: version 2 generated over version 1, its placeholder reviewed, drawn twice as often":
			scenarioCommand("scenario: version 2 generated over version 1, its placeholder reviewed"),
		"scenario: a failing data step stops migrate, is fixed, and migrate resumes": scenarioCommand(
			"scenario: a failing data step stops migrate, is fixed, and migrate resumes"
		),
		"scenario: generated again, every folder applied, check passes, Db.open admits, each file tampered with":
			scenarioCommand(
				"scenario: generated again, every folder applied, check passes, Db.open admits, each file tampered with"
			),
		"scenario: a new workload configured over an applied workspace: migrate refuses until it is generated, then Db.open refuses and a wrong password is refused until migrate":
			scenarioCommand(
				"scenario: a new workload configured over an applied workspace: migrate refuses until it is generated, then Db.open refuses and a wrong password is refused until migrate"
			),
		"scenario: a table created by hand: drift and migrate refuse it until it is dropped":
			scenarioCommand(
				"scenario: a table created by hand: drift and migrate refuse it until it is dropped"
			)
	}
}

/** How each command runs on the workspace. */
const realOf = (r: Workspace): Real<Model, WorkflowParameters, StepError, Services> => {
	const plain = (step: Plain) => (_parameters: undefined, before: Model, after: Model) =>
		runStep(r, step, before, after)
	const scenario = (name: ScenarioName) => (_parameters: undefined, before: Model) =>
		runScenario(r, name, before)
	return {
		configure: (config, before, after) => runStep(r, { kind: "configure", config }, before, after),
		"grizzle generate": plain({ kind: "generate" }),
		"review the placeholders": plain({ kind: "review" }),
		"grizzle check": plain({ kind: "check" }),
		"grizzle migrate": plain({ kind: "migrate" }),
		"grizzle generate --custom": (failing, before, after) =>
			runStep(r, { kind: "custom", failing }, before, after),
		"fix the failing data step": plain({ kind: "fix" }),
		"tamper with snapshot.json": plain({ kind: "tamper", tamper: "snapshot.json" }),
		"tamper with meta.json": plain({ kind: "tamper", tamper: "meta.json" }),
		"tamper with an applied file": plain({ kind: "tamper", tamper: "an applied file" }),
		"Db.open against the committed snapshot": plain({ kind: "open" }),
		"grizzle migrate with a wrong password": plain({ kind: "wrong password" }),
		"grizzle drift": plain({ kind: "drift" }),
		"a table created by hand or dropped": (_parameters, before, after) =>
			runStep(r, { kind: "stray", plant: !before.stray }, before, after),
		"scenario: a workload program removed, its index dropped": scenario(
			"scenario: a workload program removed, its index dropped"
		),
		"scenario: version 2 generated over version 1, its placeholder reviewed": scenario(
			"scenario: version 2 generated over version 1, its placeholder reviewed"
		),
		"scenario: version 2 generated over version 1, its placeholder reviewed, drawn twice as often":
			scenario("scenario: version 2 generated over version 1, its placeholder reviewed"),
		"scenario: a failing data step stops migrate, is fixed, and migrate resumes": scenario(
			"scenario: a failing data step stops migrate, is fixed, and migrate resumes"
		),
		"scenario: generated again, every folder applied, check passes, Db.open admits, each file tampered with":
			scenario(
				"scenario: generated again, every folder applied, check passes, Db.open admits, each file tampered with"
			),
		"scenario: a new workload configured over an applied workspace: migrate refuses until it is generated, then Db.open refuses and a wrong password is refused until migrate":
			scenario(
				"scenario: a new workload configured over an applied workspace: migrate refuses until it is generated, then Db.open refuses and a wrong password is refused until migrate"
			),
		"scenario: a table created by hand: drift and migrate refuse it until it is dropped": scenario(
			"scenario: a table created by hand: drift and migrate refuse it until it is dropped"
		)
	}
}

/** One run of the workflow: a schema name and a workspace of its own, configured at version 1 with the full workload. */
const runCommands = (c: Case<CommandKind>, steps: Program<WorkflowParameters>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const schema = yield* substrate.schema({ create: false, label: "workflow" })
			const ws = yield* workspace("workflow")
			const m = yield* openMigrator(substrate, substrate.owner)
			const scope = yield* Effect.scope
			const logins = new Map<string, Credentials>()
			const login = (value: AnyLogin): Effect.Effect<Credentials, SqlError, Services> =>
				Effect.suspend(() => {
					const role = loginRoleOf(value)
					const known = logins.get(role)
					if (known !== undefined) {
						return Effect.succeed(known)
					}
					return Effect.tap(Scope.provide(substrate.login(role), scope), (given) =>
						Effect.sync(() => {
							logins.set(role, given)
						})
					)
				})
			yield* writeConfig(ws, {
				schemas: [
					{
						name: schema,
						fixture: "shop",
						version: initialConfig.version,
						workload: initialConfig.workload
					}
				],
				connection: viaDatabaseUrl
			})
			const r: Workspace = {
				dir: ws,
				schema,
				database: substrate.database,
				cluster: substrate.cluster,
				env: {
					DATABASE_URL: databaseUrl(substrate.database, migrationIdentity(substrate.cluster))
				},
				c,
				login,
				applied: Effect.map(readLedger(m, schema, succeeded(statementsFor(schema))), (state) =>
					Arr.map(state.complete, (f) => f.folder)
				)
			}
			yield* runProgram(workflow, realOf(r), steps)
		})
	)

/** The rotating stream's workflows; the steered phase mutates up to ten times as many until every step is reached. */
const runs = 3

layer(Layer.merge(Substrate.layer, NodeServices.layer))(
	"the migration workflow through the command line",
	(it) => {
		it.effect(
			`${runs} workflows of the rotating stream, steered until every step is reached: every step's exit code, folders and ledger are the model's, and no password is printed`,
			(ctx) =>
				searched(
					ctx,
					explore(
						{
							suite: "cli/workflow",
							draw: drawn(program(workflow, { min: 0, max: 14 })),
							literal: Formatter.format,
							coverage: required<CommandKind>(commandKinds, { cases: 10 * runs, sense: notesOnly }),
							kept: [],
							runs,
							/**
							 * Shrinking stops after 150 candidates, never by wall time: each candidate replays its commands
							 * through the command line against PostgreSQL, and 150 still cut a workflow of at most 14 commands
							 * to its few steps.
							 */
							shrink: { kind: "bounded", candidates: 150 },
							concurrency: 1,
							steerEvery: 16,
							/**
							 * One case runs up to 14 command lines, each a generate, check or migrate against PostgreSQL:
							 * the existing 20-minute hang guard, kept.
							 */
							caseHang: Duration.minutes(20)
						},
						(steps, c) => runCommands(c, steps)
					)
				)
		)
	}
)
