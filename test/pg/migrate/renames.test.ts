import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { array, constant, element, type Gen, shuffled, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	ConfigProvider,
	DateTime,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Path,
	pipe,
	type PlatformError,
	Record as Rec,
	Result,
	type Scope,
	String as Str
} from "effect"
import { defineConfig } from "#adapter/config/define.ts"
import { Db } from "#adapter/public/db.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import { check, findingText } from "#cli/check.ts"
import { formatTimestamp } from "#cli/clock.ts"
import { committedSnapshot } from "#cli/committed.ts"
import { type ConfiguredSchema, type ResolvedConfig, resolveConfig } from "#cli/config.ts"
import type { CliError } from "#cli/errors.ts"
import { readSchemaTree, writeFolder, writeSnapshotFile } from "#cli/files.ts"
import { draftSchema, generate } from "#cli/generate.ts"
import { migrate } from "#cli/migrate.ts"
import type { refusalText } from "#cli/refusals.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { Choice, Offer } from "#compiler/deploy/diff/plan.ts"
import type { GenerateResult } from "#compiler/deploy/render/generate.ts"
import { findMarkers } from "#compiler/deploy/render/markers.ts"
import { snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import {
	type AnyClosed,
	type AnyDerived,
	type AnyLogin,
	type AnyLoginRole,
	type AnyRelation,
	type AnySchema,
	alternatives,
	capacity,
	closed,
	contained,
	login,
	on,
	relation,
	role,
	schema,
	select,
	within
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { ColumnDef, RenameColumn, RenameObject } from "#compiler/sql/ast.ts"
import { printStatement, printType, quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { urlEnv } from "#test/pg/cli/support.ts"
import { id, type Reviewer, reviewedSource } from "#test/pg/migrate/support.ts"
import { assert, defined, nonEmpty, unorderedEqual } from "#test/support/assert.ts"
import { pgPin } from "#test/support/env.ts"
import { loginRoleOf } from "#test/support/installed.ts"
import { contractCheckAt, lawNamesOf, parsedName } from "#test/support/kernel/naming.ts"
import {
	type Decisions,
	draftFiles,
	offerActions,
	placeholdersOf,
	review as reviewFolder,
	reviewWritten
} from "#test/support/migrate/review.ts"
import type { SqlError } from "#test/support/pg.ts"
import { pickFrom, pickGen, pickSpan } from "#test/support/pick.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"
import { expectConstraint, expectSqlstate } from "#test/support/substrate/expect.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { testVerify, tokenOf } from "#test/support/worlds.ts"

/** Renames on PostgreSQL 19, through the command line's own entry points, over drawn rename chains and compositions.
 *
 * A schema is edited in code the way a user renames, over and over. A case draws one to three moves: renames of one to
 * three drawn things, or a composition drawn as such so it is reached routinely (an arm and the handle that selects it;
 * a closed relation and a contract; a referenced relation and the one referencing it; the law's parent and both its
 * arms; the parent, an arm and its handle; a closed relation, a contract and a capacity's target; a capacity's target
 * and source; a selected source and its target; a field or a relation onto the name another left a step before; a
 * closed relation onto the name a table leaves in the same step, across catalog namespaces; a handle renamed while a
 * field is retyped; a closed relation renamed with one of its handles, a new roster no candidate renames). A
 * thing is a relation (an arm the alternatives law reads, the relation a containment references, the referencing one),
 * a field, a closed relation, a closed handle renamed in place (the one the law selects an arm by among them) or a
 * contract, each renamed to a free name of its own pool, so a name is renamed again or back across moves. Each step
 * drafts the next folder as `grizzle generate` does (`draftSchema`, written by the command line's own
 * writers), is reviewed by the one reviewer (the candidates of the renames the step
 * made chosen, every other kept, or a drawn step's closed relation's and contract's renames kept as their drop and add;
 * a handle renamed in place confirmed; a field of a closed relation converted in place computed by the reviewer's
 * placeholder from its text, a renamed handle mapped, where a field changing between the contract and its base, or two
 * contracts, is converted by the draft's cast), runs `grizzle check` and `grizzle migrate`, which admits the catalog against snapshot.json
 * and refuses drift, and opens the schema with Db.open against the committed snapshot. Properties, for every step:
 *
 * - check refuses the folder as drafted exactly when it leaves the reviewer a decision (a marker, or a loss of stored
 *   data), and only for such undecided findings, and migrate refuses it before running it; check passes once they are
 *   decided;
 * - migrate applies the folder and admits the catalog, and Db.open admits it;
 * - every row survives under the new names, each value as it was, a renamed handle's values renamed with it (the
 *   host's model of the rows, by where each name came from);
 * - the laws still hold under the new names: the alternatives law refuses a task without its arm, the capacity a
 *   fourth note of an account and the selected source a billable item of no account (23000, each law's identity by the
 *   naming door), the containment a referenced row's delete (23503), the contract a negative amount by the CHECK of its
 *   domain (23514);
 * - a second generate drafts nothing;
 * - a drawn reviewer's mistake, a chosen rename spelt otherwise than drafted or a candidate chosen in one file and kept
 *   in another, is refused by check before anything runs (Db.open of the new snapshot is then refused at the stage
 *   ledger), and the folder decided as drafted then migrates.
 *
 * A swap of two names in one step is not a rename by name identity (each name keeps its relation); the hops are the
 * swaps a migration can express. Every relation, column, law and constraint the SQL below names is read off the
 * drafted snapshot or plan. */
interface Workspace {
	readonly name: string
	readonly dir: string
	/** The schema's migrations directory. */
	readonly directory: string
	readonly env: Readonly<Record<string, string>>
	readonly snapshotText: Effect.Effect<string, PlatformError.PlatformError>
	readonly sql: (text: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>
}

let seconds = 0
/** The clock the drafts read: 2026-10-14T12:00:00Z, a second later at every read, so every folder name is distinct. */
const now = (): DateTime.Utc => DateTime.makeUnsafe(1_791_979_200_000 + 1000 * seconds++)

/** A schema value with the world every step writes in: the full role `writer`, holding every relation whole and writing
 * every ordinary one, reached through the login `server`. A step builds it once from its schema value, so the
 * configuration and Db.open name one login. */
interface Version {
	readonly schema: AnySchema
	readonly writer: AnyLoginRole
	readonly server: AnyLogin
}

const versionOf = (value: AnySchema): Version => {
	/** Each relation under its own name, which a whole entry is held by, whatever key the schema value files it under. */
	const relations: Readonly<Record<string, AnyRelation | AnyClosed | AnyDerived>> = Rec.fromEntries(
		Arr.flatMap(Rec.values(value.relations), (r) =>
			r.kind === "world" ? [] : [[r.name, r] as const]
		)
	)
	const writer = role(value, "writer", relations, {
		write: Arr.filter(Rec.keys(relations), (name) => relations[name]?.kind === "relation")
	})
	const server = login(value, "server", [writer])
	return { schema: value, writer: server.roles.writer, server }
}

const configOf = (
	ws: Workspace,
	version: Version
): Effect.Effect<ResolvedConfig, CliError, Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		return yield* resolveConfig(
			defineConfig({ schemas: [version.schema], logins: [version.server] }),
			path.join(ws.dir, "grizzle.config.ts")
		)
	})

const scopedDir = (
	label: string
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		return yield* fs.makeTempDirectoryScoped({ prefix: `grizzle-renames-${label}-` })
	})

/** A schema name of the test's own, an application directory, and an owner session with `$S` for the quoted schema. */
const workspace = (label: string) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const name = yield* substrate.schema({ create: false, label })
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const dir = yield* scopedDir(label)
		const s = yield* substrate.session({ ...ownerSession(), label: `renames ${label}` })
		const directory = path.join(dir, "migrations", name)
		const ws: Workspace = {
			name,
			dir,
			directory,
			env: urlEnv(substrate.cluster, substrate.database),
			snapshotText: fs.readFileString(path.join(directory, snapshotFileName)),
			sql: (text) => s.values(pipe(text, Str.replaceAll("$S", quoteIdent(name))), [])
		}
		return ws
	})

/** The workspace's one configured schema. */
const configuredOf = (
	ws: Workspace,
	version: Version
): Effect.Effect<ConfiguredSchema, CliError, Path.Path> =>
	Effect.map(configOf(ws, version), (config) => {
		const [configured] = config.schemas
		assert.ok(configured !== undefined, "the configuration declares the schema")
		return configured
	})

/** The next folder of the workspace's schema as `grizzle generate` drafts it, from the committed snapshot and folders,
 * nothing written. */
const planned = (
	ws: Workspace,
	version: Version
): Effect.Effect<GenerateResult, CliError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const configured = yield* configuredOf(ws, version)
		const tree = yield* readSchemaTree(configured.declared, configured.directory)
		const previous = yield* committedSnapshot(configured, tree)
		return yield* draftSchema(configured, previous, { kind: "derived" }, formatTimestamp(now()), [])
	})

/** The one way this file drafts a folder: as `grizzle generate` drafts it, its folder written unreviewed and its
 * snapshot.json written by the command line's own writers. */
const drafted = (
	ws: Workspace,
	version: Version
): Effect.Effect<GenerateResult, CliError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const configured = yield* configuredOf(ws, version)
		const g = yield* planned(ws, version)
		assert.notEqual(g.change, "none", "the schema's change drafts a folder")
		yield* writeFolder(configured.declared, configured.directory, g.folder)
		yield* writeSnapshotFile(configured.declared, configured.directory, g.snapshotText)
		return g
	})

/** Writes a folder's files as a reviewer leaves them over the drafted folder. */
const writeOver = (
	ws: Workspace,
	folder: string,
	files: ReadonlyArray<{ readonly name: string; readonly text: string }>
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		for (const f of files) {
			yield* fs.writeFileString(path.join(ws.directory, folder, f.name), f.text)
		}
	})

const findings = (ws: Workspace, version: Version) =>
	Effect.gen(function* () {
		const checks = yield* check(yield* configOf(ws, version), ws.dir)
		return Arr.flatMap(checks, (c) => c.findings)
	})

/** `grizzle migrate` in the workspace, reading its connection from the workspace's environment. */
const migrated = (ws: Workspace, version: Version) =>
	Effect.gen(function* () {
		const config = yield* configOf(ws, version)
		return yield* Effect.provideService(
			migrate(config, ws.dir),
			ConfigProvider.ConfigProvider,
			ConfigProvider.fromUnknown(ws.env)
		)
	})

/**
 * Db.open of the version's writer through its login's layer given the committed snapshot: "admitted", or the stage of its
 * refusal.
 */
const open = (ws: Workspace, version: Version) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const { writer, server } = version
		const credentials = yield* substrate.login(loginRoleOf(server))
		const dbLayer = DbLayer.make({
			login: server,
			snapshot: snapshotJson(yield* ws.snapshotText),
			host: pgPin.host,
			port: pgPin.port,
			database: substrate.database,
			password: credentials.password,
			tls: { ca: substrate.cluster.caPem },
			verify: testVerify
		})
		const opened = yield* Effect.result(
			Effect.scoped(
				Effect.flatMap(Layer.build(dbLayer), (context) =>
					Effect.provideContext(Db.open(writer, { token: tokenOf({}) }), context)
				)
			)
		)
		return Result.isSuccess(opened) ? "admitted" : opened.failure.stage
	})

/** A second generate drafts nothing. */
const settled = (ws: Workspace, version: Version) =>
	Effect.gen(function* () {
		const [again] = yield* generate(yield* configOf(ws, version), {
			mode: { kind: "draft", naming: { kind: "derived" } },
			schema: Option.none(),
			now: now()
		})
		assert.ok(again !== undefined, "a second generate reports its schema")
		assert.equal(again.kind, "unchanged", "a second generate drafts nothing")
		assert.deepEqual(yield* findings(ws, version), [], "check sees no ungenerated change")
	})

/** A reviewer's mistake the step makes before deciding the folder as drafted: none, a chosen rename spelt otherwise than
 * drafted, or a candidate chosen in one file and kept in another. */
type Mistake =
	| "none"
	| "a rename misspelt"
	| "a candidate split across files"
	| "an orphan nested choice"

/** The folder decided with `mistake` made, or nothing to make it in: no rename statement to misspell, or no candidate
 * that decides a statement outside Structure to split. */
const mistaken = (
	g: GenerateResult,
	decisions: Decisions,
	mistake: Exclude<Mistake, "none">
): Files | "not makeable" => {
	if (mistake === "a rename misspelt") {
		const found = renameIn(g, decisions.chosen)
		if (Option.isNone(found)) {
			return "not makeable"
		}
		const rename = found.value
		const right = printStatement(rename)
		const wrong = printStatement({ ...rename, to: `${rename.to}_q` })
		return reviewedSource(g, {
			decisions: () => decisions,
			edit: (f) => Str.replaceAll(right, wrong)(f.text)
		}).files
	}
	if (mistake === "an orphan nested choice") {
		/** A member's rename chosen inside its container's rename kept: the kept container's alternative leaves the file,
		 * and the reviewer writes the member's rename into the file that drafts it. */
		const [nested] = Arr.flatMap(nestedChoices(g, decisions.chosen), ({ holder, choice }) =>
			Arr.flatMap(choice.offers, (o) => {
				if (o.kind !== "rename" || !decisions.chosen.has(o.candidate)) {
					return []
				}
				const [first] = o.alternative
				return first.kind === "statement" && first.statement.kind === "renameColumn"
					? [{ holder, candidate: o.candidate, rename: first.statement }]
					: []
			})
		)
		if (nested === undefined) {
			return "not makeable"
		}
		const kept = new Set(
			Arr.filter([...decisions.chosen], (c) => c !== nested.holder && c !== nested.candidate)
		)
		const spelled = `${printStatement(nested.rename)};`
		const drafting = Arr.findFirst(g.folder.files, (f) => Str.includes(spelled)(f.text))
		if (Option.isNone(drafting)) {
			return "not makeable"
		}
		return reviewedSource(g, {
			decisions: () => ({ ...decisions, chosen: kept }),
			edit: (f) => (f.name === drafting.value.name ? `${f.text}\n${spelled}\n` : f.text)
		}).files
	}
	/** A chosen candidate's offer taken at one statement it decides outside Structure and kept at another. */
	const files = draftFiles(g)
	const records = g.folder.meta.decisions.choices
	const split = Arr.findFirstIndex(
		records,
		(c) =>
			Arr.some(c.offers, (o) => decisions.chosen.has(o.candidate)) &&
			Arr.some(files, (f) => f.name === c.file && f.phase !== "structure")
	)
	if (Option.isNone(split)) {
		return "not makeable"
	}
	const choice = split.value
	const offer = defined(
		Option.getOrUndefined(
			Arr.findFirstIndex(defined(records[choice], "the split choice").offers, (o) =>
				decisions.chosen.has(o.candidate)
			)
		),
		"the split choice's chosen offer"
	)
	const written = reviewWritten(g, decisions, { kind: "split", choice, offer })
	return Result.isFailure(written) ? "not makeable" : written.success.files
}

type Files = ReadonlyArray<{ readonly name: string; readonly text: string }>

/** What each kind of `grizzle check` finding (`refusalText`) says of the migrations directory, every
 * kind classified, so a new kind is a compile error here: a decision the draft leaves to the reviewer, not yet made (a
 * marker, or a loss of stored data left commented); a decision made otherwise than the draft offers it; a change not
 * drafted, or a schema that does not compile; or an entry, file or text grizzle never writes so. */
type FindingClass = "undecided" | "misdecided" | "ungenerated" | "malformed"
const findingClass: { readonly [K in keyof typeof refusalText]: FindingClass } = {
	placeholder: "undecided",
	renameCandidate: "undecided",
	unresolvedLoss: "undecided",
	splitRename: "misdecided",
	ungenerated: "ungenerated",
	workloadAccess: "ungenerated",
	compile: "ungenerated",
	unreadableSnapshot: "malformed",
	unreadableMeta: "malformed",
	brokenChain: "malformed",
	chainEnd: "malformed",
	folderName: "malformed",
	fileName: "malformed",
	transactionControl: "malformed",
	misplacedNoTransaction: "malformed",
	strayEntry: "malformed"
}

/** One turn of the loop: draft, check refusing the folder as drafted for exactly its undecided decisions, the reviewer's
 * mistake refused before anything runs, review, check, migrate, Db.open, and a second generate that drafts nothing.
 * Whether the mistake was made.
 *
 * A misspelt rename writes the candidate's statement otherwise than drafted: a split rename, as a split and an
 * orphan nested choice are.
 *
 * Nothing ran: the database is at the previous version. */
const step = (
	ws: Workspace,
	value: AnySchema,
	reviewerOf: (g: GenerateResult) => Reviewer,
	mistake: Mistake
) =>
	Effect.gen(function* () {
		const version = versionOf(value)
		const g = yield* drafted(ws, version)
		const refused = yield* findings(ws, version)
		for (const f of refused) {
			assert.equal(findingClass[f.kind], "undecided", `the folder as drafted: ${findingText(f)}`)
		}
		/** A folder leaves the reviewer a decision when it holds a marker or a loss of stored data (one in a candidate's
		 * alternative comes with that candidate's marker). */
		const undecided =
			Arr.some(g.folder.files, (f) => findMarkers(f.text).length > 0) ||
			g.folder.meta.decisions.losses.length > 0
		assert.equal(
			refused.length > 0,
			undecided,
			"check refuses the folder as drafted exactly when it is undecided"
		)
		if (undecided) {
			const stopped = yield* Effect.flip(migrated(ws, version))
			assert.ok(
				stopped._tag === "MigrateError",
				"migrate refuses the undecided folder before running it"
			)
		}
		const wrong =
			mistake === "none" ? "not makeable" : mistaken(g, reviewerOf(g).decisions(g), mistake)
		if (wrong !== "not makeable") {
			yield* writeOver(ws, g.folder.name, wrong)
			const refused = yield* findings(ws, version)
			assert.ok(
				Arr.some(refused, (f) => f.kind === "splitRename"),
				Arr.join(Arr.map(refused, findingText), "\n")
			)
			assert.equal(yield* open(ws, version), "ledger")
		}
		yield* writeOver(ws, g.folder.name, reviewedSource(g, reviewerOf(g)).files)
		assert.deepEqual(yield* findings(ws, version), [], "check passes once every marker is decided")
		const [applied] = yield* migrated(ws, version)
		assert.ok(applied?.applied.length === 1, "migrate applies the folder")
		assert.equal(yield* open(ws, version), "admitted")
		yield* settled(ws, version)
		return { g, mistaken: wrong !== "not makeable" }
	})

const texts = (ws: Workspace, sql: string) =>
	Effect.map(ws.sql(sql), (rows) =>
		Arr.map(rows, (row) =>
			Arr.join(
				Arr.map(row, (v) => String(v)),
				" "
			)
		)
	)

/** A relation of a drafted snapshot by its declared name, with its heading. */
const relationOf = (g: GenerateResult, name: string) => {
	const r = g.snapshot.theory.relations[name]
	assert.ok(
		r !== undefined && r.kind !== "derived",
		`the snapshot holds the stored or closed relation ${name}`
	)
	return r
}

/** A relation's table as ws.sql names it, `$S."<table>"`. */
const table = (g: GenerateResult, name: string): string =>
	`$S.${quoteIdent(relationOf(g, name).ident)}`

/** A field's installed column. */
const columnOf = (g: GenerateResult, relationName: string, field: string): string => {
	const f = Arr.findFirst(relationOf(g, relationName).fields, (x) => x.name === field)
	assert.ok(Option.isSome(f), `relation ${relationName} has field ${field}`)
	return f.value.column
}

const column = (g: GenerateResult, relationName: string, field: string): string =>
	quoteIdent(columnOf(g, relationName, field))

/** Every offer of a draft, in the folder's order. */
const offersOf = (g: GenerateResult): ReadonlyArray<Offer> =>
	Arr.flatMap(draftFiles(g), (f) =>
		Arr.flatMap(f.drafts, (d) => (d.kind === "choice" ? choiceOffers(d) : []))
	)

/** A choice's offers, and the offers of every choice nested in a rename's alternative, a member's rename within its
 * container's. */
const choiceOffers = (c: Choice): ReadonlyArray<Offer> =>
	Arr.flatMap(c.offers, (o) => [
		o,
		...(o.kind === "rename"
			? Arr.flatMap(o.alternative, (x) => (x.kind === "choice" ? choiceOffers(x) : []))
			: [])
	])

/** Each choice nested in a chosen rename's alternative, with the candidate of the rename holding it. */
const nestedChoices = (g: GenerateResult, chosen: ReadonlySet<number>) =>
	Arr.flatMap(offersOf(g), (o) =>
		o.kind === "rename" && chosen.has(o.candidate)
			? Arr.flatMap(o.alternative, (x) =>
					x.kind === "choice" ? [{ holder: o.candidate, choice: x }] : []
				)
			: []
	)

/** The first rename a chosen candidate's offer spells, a relation's or a field's: the one the reviewer writes. */
const renameIn = (
	g: GenerateResult,
	chosen: ReadonlySet<number>
): Option.Option<RenameObject | RenameColumn> => {
	const actions = Arr.flatMap(offersOf(g), (o) =>
		o.kind === "rename" && chosen.has(o.candidate) ? offerActions(o) : []
	)
	return Arr.findFirst(actions, (a): Option.Option<RenameObject | RenameColumn> => {
		if (a.kind !== "statement") {
			return Option.none()
		}
		const s = a.statement
		return (s.kind === "rename" && s.object === "TABLE") || s.kind === "renameColumn"
			? Option.some(s)
			: Option.none()
	})
}

/** The things a case renames, each with the pool of names it takes, its name before any rename first. Relations,
 * closed relations and the contract take names of disjoint pools (migrate-gen's paths draw hops across kinds); a
 * handle is renamed in place; a hop takes the name another slot of its kind left a step before. */
const pools = {
	Account: ["Account", "Client", "Customer"],
	Note: ["Note", "Remark", "Memo"],
	Comment: ["Comment", "Reply", "Response"],
	Task: ["Task", "Job", "Chore"],
	AutomaticTask: ["AutomaticTask", "RobotTask", "AutoJob"],
	ManualTask: ["ManualTask", "HumanTask", "PersonTask"],
	Item: ["Item", "Article", "Product"],
	Kind: ["Kind", "Sort", "Category"],
	Rank: ["Rank", "Grade", "Level"],
	Cents: ["Cents", "Money", "Amount"],
	body: ["body", "text", "content"],
	title: ["title", "heading", "caption"],
	operator: ["operator", "worker", "agent"],
	amount: ["amount", "price", "total"],
	selector: ["kind", "variety", "flavor"],
	manual: ["Manual", "Human", "Person"],
	high: ["High", "Top", "Peak"]
} as const
type Slot = keyof typeof pools
const slotList: ReadonlyArray<Slot> = [
	"Account",
	"Note",
	"Comment",
	"Task",
	"AutomaticTask",
	"ManualTask",
	"Item",
	"Kind",
	"Rank",
	"Cents",
	"body",
	"title",
	"operator",
	"amount",
	"selector",
	"manual",
	"high"
]
type SlotKind = "relation" | "field" | "closed relation" | "handle" | "contract"
const kindOf = (slot: Slot): SlotKind => {
	switch (slot) {
		case "Account":
		case "Note":
		case "Comment":
		case "Task":
		case "AutomaticTask":
		case "ManualTask":
		case "Item":
			return "relation"
		case "Kind":
		case "Rank":
			return "closed relation"
		case "Cents":
			return "contract"
		case "body":
		case "title":
		case "operator":
		case "amount":
		case "selector":
			return "field"
		case "manual":
		case "high":
			return "handle"
	}
}

/** The name the catalog knows a slot's object by, as the naming door gives it: a relation's table, a closed relation's
 * enum, the contract's domain and a field's column; a handle is its enum's label. */
const catalogName = (slot: Slot, name: string): string => {
	switch (kindOf(slot)) {
		case "relation":
			return identifierOf(identity.table(parsedName(name)))
		case "closed relation":
			return identifierOf(identity.enumType(parsedName(name)))
		case "contract":
			return identifierOf(identity.contractDomain(parsedName(name)))
		case "field":
			return identifierOf(identity.column(parsedName(name)))
		case "handle":
			return name
	}
}

/** The slot a field, a handle or a contract belongs to, whose namespace it shares: a field its relation's, a handle its
 * closed relation's; a relation, a closed relation and the contract the schema's. */
const ownerOf = (slot: Slot): Slot | "the schema" => {
	switch (slot) {
		case "body":
		case "title":
			return "Note"
		case "operator":
			return "ManualTask"
		case "amount":
			return "Item"
		case "selector":
			return "Task"
		case "manual":
			return "Kind"
		case "high":
			return "Rank"
		case "Account":
		case "Note":
		case "Comment":
		case "Task":
		case "AutomaticTask":
		case "ManualTask":
		case "Item":
		case "Kind":
		case "Rank":
		case "Cents":
			return "the schema"
	}
}

/** What the schema is at a step: every slot's name, and whether Item's amount is of the contract or its plain base. */
interface Shape {
	readonly names: ReadonlyMap<Slot, string>
	readonly amount: "the contract" | "plain bigint"
}

const originalShape: Shape = {
	names: new Map(Arr.map(slotList, (slot) => [slot, pools[slot][0]])),
	amount: "the contract"
}

const nameOf = (shape: Shape, slot: Slot): string =>
	defined(shape.names.get(slot), `the name of ${slot}`)

/** The contract under one of its names: a contract's name is one literal, the brand of its values. */
type CentsName = (typeof pools)["Cents"][number]
const isCentsName = (name: string): name is CentsName => Arr.some(pools.Cents, (x) => x === name)
const centsNamed = (name: string) => {
	if (!isCentsName(name)) {
		throw new Error(`${name} is not one of the contract's names`)
	}
	switch (name) {
		case "Cents":
			return contract("Cents", pg.bigint, (v) => v.ge(0n))
		case "Money":
			return contract("Money", pg.bigint, (v) => v.ge(0n))
		case "Amount":
			return contract("Amount", pg.bigint, (v) => v.ge(0n))
	}
}

/** The schema of a shape, built by the public builders: Note references Account and Comment Note (a containment each);
 * Task's selector field selects its arm, AutomaticTask or ManualTask, by the alternatives law; Item holds a handle of
 * Rank and an amount of the Cents contract or of plain bigint. */
const shopOf = (name: string, shape: Shape) => {
	const n = (slot: Slot) => nameOf(shape, slot)
	const text = str.regex("^.*$", "su")
	const Account = relation(n("Account"), { id: uuid }, ["id"])
	const Note = relation(
		n("Note"),
		{ id: pg.bigserial, account: uuid, [n("body")]: text, [n("title")]: text },
		["id"]
	)
	const Comment = relation(n("Comment"), { id: uuid, note: pg.bigint }, ["id"])
	const Kind = closed(n("Kind"), ["Automatic", n("manual")])
	const Task = relation(n("Task"), { id: uuid, [n("selector")]: closedId(Kind) }, ["id"])
	const AutomaticTask = relation(n("AutomaticTask"), { task: uuid, budget: pg.bigint }, ["task"])
	const ManualTask = relation(n("ManualTask"), { task: uuid, [n("operator")]: text }, ["task"])
	const Rank = closed(n("Rank"), ["Low", n("high")])
	const amount = shape.amount === "the contract" ? centsNamed(n("Cents")) : pg.bigint
	const Item = relation(
		n("Item"),
		{ id: uuid, rank: closedId(Rank), [n("amount")]: amount, account: uuid, billable: pg.boolean },
		["id"]
	)
	const arms = alternatives(Task, n("selector"), Kind, {
		Automatic: AutomaticTask,
		[n("manual")]: ManualTask
	})
	/** At most three notes per account: a residual capacity over the containment of Note into Account. */
	const notes = capacity(on(Account, "id"), { from: on(Note, "account"), within: within(0n, 3n) })
	/** A billable item's account exists: a selected source, which no foreign key can enforce. */
	const billed = contained(on(select(Item, { billable: true }), "account"), on(Account, "id"))
	const value = schema(
		name,
		{ Account, Note, Comment, Kind, Task, AutomaticTask, ManualTask, Rank, Item },
		[
			contained(on(Note, "account"), on(Account, "id")),
			contained(on(Comment, "note"), on(Note, "id")),
			arms,
			notes,
			billed
		]
	)
	/** Each residual law's identity, through the naming door from the statement that declares it. */
	const laws = lawNamesOf(value)
	return {
		value,
		alternatives: laws.constraintOf(laws.alternativesOf(arms).reverse, "ResidualLaw"),
		capacity: laws.constraintOf(laws.lawOf(notes), "ResidualLaw"),
		selected: laws.constraintOf(laws.lawOf(billed), "ResidualLaw")
	}
}

/** Compositions: several renames across kinds in one step, a hop over two steps, or a rename followed a step later by a
 * rename of what it references or what references it, drawn as such so they are reached routinely. */
const compositions = [
	"an arm and the handle that selects it",
	"an arm and its selector field",
	"a relation and one of its fields",
	"a relation, then the relation it references, a step later",
	"a relation, then the relation referencing it, a step later",
	"an arm, then the parent it references, a step later",
	"a contract, then the field it types, a step later",
	"a relation, then one of its fields, a step later",
	"a closed relation and a contract",
	"a referenced relation and the relation referencing it",
	"the law's parent and both its arms",
	"the law's parent, an arm and the handle that selects it",
	"a closed relation, a contract and a capacity's target",
	"a capacity's target and source",
	"a selected source and its target",
	"a field onto the name another field left",
	"a relation onto the name another relation left",
	"a closed relation onto the name a table left in the same step",
	"a handle renamed with a field retyped",
	"a closed relation and one of its handles"
] as const
type Composition = (typeof compositions)[number]

/** How the reviewer decides a step's candidates: every candidate of a rename the step made chosen; or each closed
 * relation's or contract's rename kept as its drop and add, but one a chosen candidate requires, so each field the type
 * types is converted in place, a closed relation's by the reviewer's placeholder and a contract's by its cast, the
 * conversion the type's candidate offers to delete. */
type Review = "the renames chosen" | "a type's rename kept"
const reviewGen = weighted<Review>([
	[3, constant("the renames chosen")],
	[1, constant("a type's rename kept")]
])

/** One move of a case: renames of drawn slots, or a composition, each pick choosing a slot's next name, with the
 * reviewer's mistake and review of each step it makes. */
type Move =
	| {
			readonly kind: "renames"
			readonly slots: ReadonlyArray<Slot>
			readonly pick: number
			readonly mistake: Mistake
			readonly review: Review
	  }
	| {
			readonly kind: "composition"
			readonly composition: Composition
			readonly pick: number
			readonly mistake: Mistake
			readonly review: Review
	  }

interface RenameSketch {
	readonly moves: ReadonlyArray<Move>
}

/** A mistake one step in four. */
const mistakeGen = weighted<Mistake>([
	[6, constant("none")],
	[1, constant("a rename misspelt")],
	[1, constant("a candidate split across files")],
	[1, constant("an orphan nested choice")]
])

/** Each field with the relation that holds it: renamed in one step, the draft offers the field's rename nested in the
 * relation's. */
const nestings = nonEmpty(
	Arr.flatMap(slotList, (slot): ReadonlyArray<readonly [Slot, Slot]> => {
		const owner = ownerOf(slot)
		return kindOf(slot) === "field" && owner !== "the schema" ? [[owner, slot]] : []
	}),
	"the fields of the relations"
)

/** Renames of one to three distinct slots, each drawn among those not yet drawn, or, three times as often, a composition:
 * a run must compose every one of the twenty; or, one move in nine, a relation and one of its fields renamed with the
 * reviewer's orphan nested choice, a mistake only a nested choice makes possible. */
const moveGen: Gen<Move> = weighted<Move>([
	[
		2,
		(source) => ({
			kind: "renames",
			slots: source.draw(shuffled(slotList, { min: 1, max: 3 })),
			pick: source.draw(pickGen),
			mistake: source.draw(mistakeGen),
			review: source.draw(reviewGen)
		})
	],
	[
		6,
		(source) => ({
			kind: "composition",
			composition: source.draw(element(compositions)),
			pick: source.draw(pickGen),
			mistake: source.draw(mistakeGen),
			review: source.draw(reviewGen)
		})
	],
	[
		1,
		(source) => ({
			kind: "renames",
			slots: source.draw(element(nestings)),
			pick: source.draw(pickGen),
			mistake: "an orphan nested choice",
			review: source.draw(reviewGen)
		})
	]
])

const sketchGen: Gen<RenameSketch> = (source) => ({
	moves: source.draw(array(moveGen, { min: 1, max: 3 }))
})

/**
 * A steered case's lead: after its sketch's moves, one more composing a composition no generated case has composed,
 * drawn among those, so the steered phase composes every one of the twenty by construction instead of by mutating
 * toward them. None where the case may not steer.
 */
const leadOf = (c: Pick<Case<RenameFeature>, "steering" | "draw">): ReadonlyArray<Move> =>
	Option.match(c.steering, {
		onNone: () => [],
		onSome: (pending): ReadonlyArray<Move> => {
			const open = Arr.filter(compositions, (composition) => pending.has(`${composition} composed`))
			return Arr.isReadonlyArrayNonEmpty(open)
				? [
						{
							kind: "composition",
							composition: c.draw(element(open)),
							pick: c.draw(pickGen),
							mistake: "none",
							review: c.draw(reviewGen)
						}
					]
				: []
		}
	})

/** The next name of a slot: a name of its pool other than its current one that no slot of its namespace holds, by the
 * pick; none when every name is taken. */
const nextName = (shape: Shape, slot: Slot, pick: number): Option.Option<string> => {
	const owner = ownerOf(slot)
	const taken = new Set(
		Arr.map(
			Arr.filter(slotList, (s) => ownerOf(s) === owner),
			(s) => nameOf(shape, s)
		)
	)
	const free = Arr.filter(pools[slot], (name) => !taken.has(name))
	return Arr.isReadonlyArrayNonEmpty(free) ? Option.some(pickFrom(free, pick)) : Option.none()
}

/** A step of a case: the shape it migrates to, its mistake, its review, and the composition it composes, if it does. */
interface Step {
	readonly shape: Shape
	readonly mistake: Mistake
	readonly review: Review
	readonly composes: Composition | "no composition"
}

/** Whether the schema of a shape holds a slot's object: every slot's, but the contract's only while Item's amount is of
 * it, since a plain bigint amount declares no contract. */
const holds = (shape: Shape, slot: Slot): boolean =>
	kindOf(slot) !== "contract" || shape.amount === "the contract"

/** The shape with each slot renamed to its next name, in order; a slot whose names are all taken keeps its own, and so
 * does a slot whose object the schema does not hold, which no rename can reach. */
const renamed = (shape: Shape, slots: ReadonlyArray<Slot>, pick: number): Shape => {
	const names = new Map(shape.names)
	for (const slot of slots) {
		const at = { ...shape, names }
		const next = nextName(at, slot, pick)
		if (holds(shape, slot) && Option.isSome(next)) {
			names.set(slot, next.value)
		}
	}
	return { ...shape, names }
}

/** Whether every slot of `slots` has another name after than before. */
const renamesEvery = (before: Shape, after: Shape, slots: ReadonlyArray<Slot>): boolean =>
	Arr.every(slots, (slot) => nameOf(before, slot) !== nameOf(after, slot))

/** Whether two slots renamed in one step are a closed relation and its handle, which renamed together are a new roster
 * the type change rule converts, not a rename. */
const heldBack = (slots: ReadonlyArray<Slot>): boolean =>
	Arr.some(slots, (a) => Arr.some(slots, (b) => ownerOf(b) === a && kindOf(b) === "handle"))

/** The steps of a move from a shape.
 *
 * Renamed with a handle, the closed relation is a new roster, offered as no candidate: each field it types is
 * converted in place by the reviewer's placeholder, which maps the renamed handle. */
const stepsOf = (shape: Shape, move: Move): ReadonlyArray<Step> => {
	if (move.kind === "renames") {
		/** The drawn slots, less the members of a pair held back. */
		const slots = Arr.filter(move.slots, (slot, i) => !heldBack([...move.slots.slice(0, i), slot]))
		return [
			{
				shape: renamed(shape, slots, move.pick),
				mistake: move.mistake,
				review: move.review,
				composes: "no composition"
			}
		]
	}
	/** The move's composition, where it renamed every slot it composes. */
	const composed = (renamesAll: boolean): Composition | "no composition" =>
		renamesAll ? move.composition : "no composition"
	const one = (slots: ReadonlyArray<Slot>): ReadonlyArray<Step> => {
		const next = renamed(shape, slots, move.pick)
		return [
			{
				shape: next,
				mistake: move.mistake,
				review: move.review,
				composes: composed(renamesEvery(shape, next, slots))
			}
		]
	}
	/** A rename, then a rename of what it references or what references it in the next migration. */
	const later = (first: ReadonlyArray<Slot>, then: ReadonlyArray<Slot>): ReadonlyArray<Step> => {
		const before = renamed(shape, first, move.pick)
		const after = renamed(before, then, move.pick)
		return [
			{ shape: before, mistake: move.mistake, review: move.review, composes: "no composition" },
			{
				shape: after,
				mistake: "none",
				review: move.review,
				composes: composed(renamesEvery(shape, before, first) && renamesEvery(before, after, then))
			}
		]
	}
	switch (move.composition) {
		case "an arm and the handle that selects it":
			return one(["ManualTask", "manual"])
		case "a closed relation and a contract":
			return one(["Rank", "Cents"])
		case "an arm and its selector field":
			return one(["ManualTask", "selector"])
		case "a relation and one of its fields":
			return one(["Note", "body"])
		case "a relation, then the relation it references, a step later":
			return later(["Comment"], ["Note"])
		case "a relation, then the relation referencing it, a step later":
			return later(["Note"], ["Comment"])
		case "an arm, then the parent it references, a step later":
			return later(["ManualTask"], ["Task"])
		case "a contract, then the field it types, a step later":
			return later(["Cents"], ["amount"])
		case "a relation, then one of its fields, a step later":
			return later(["Note"], ["title"])
		case "a referenced relation and the relation referencing it":
			return one(["Note", "Comment"])
		case "the law's parent and both its arms":
			return one(["Task", "AutomaticTask", "ManualTask"])
		case "the law's parent, an arm and the handle that selects it":
			return one(["Task", "ManualTask", "manual"])
		case "a closed relation, a contract and a capacity's target":
			return one(["Rank", "Cents", "Account"])
		case "a capacity's target and source":
			return one(["Account", "Note"])
		case "a selected source and its target":
			return one(["Item", "Account"])
		case "a closed relation onto the name a table left in the same step": {
			/** Account gives its name up and Rank takes it in one migration: the enum takes the name the table's row type
			 * held, across catalog namespaces. */
			const left = renamed(shape, ["Account"], move.pick)
			const names = new Map(left.names)
			names.set("Rank", nameOf(shape, "Account"))
			return [
				{
					shape: { ...left, names },
					mistake: move.mistake,
					review: move.review,
					composes: move.composition
				}
			]
		}
		case "a field onto the name another field left":
		case "a relation onto the name another relation left": {
			const [moved, onto]: readonly [Slot, Slot] =
				move.composition === "a field onto the name another field left"
					? ["body", "title"]
					: ["Note", "Comment"]
			const left = renamed(shape, [onto], move.pick)
			const names = new Map(left.names)
			names.set(moved, nameOf(shape, onto))
			return [
				{ shape: left, mistake: move.mistake, review: move.review, composes: "no composition" },
				{
					shape: { ...left, names },
					mistake: "none",
					review: move.review,
					composes: move.composition
				}
			]
		}
		case "a closed relation and one of its handles":
			return one(["Kind", "manual"])
		case "a handle renamed with a field retyped": {
			const next = renamed(shape, ["high"], move.pick)
			return [
				{
					shape: {
						...next,
						amount: shape.amount === "the contract" ? "plain bigint" : "the contract"
					},
					mistake: move.mistake,
					review: move.review,
					composes: move.composition
				}
			]
		}
	}
}

type RenameFeature =
	| `a ${SlotKind} renamed`
	| "a name renamed again"
	| "a name renamed back"
	| "several renames in one step"
	| `${Composition} composed`
	| `${Exclude<Mistake, "none">} refused`
	| "a closed relation's field converted by the reviewer's placeholder"
	| "a type's rename kept"

/** What a composition's chained case caught in its first step, where it did, and what that step reaches. */
interface Caught {
	readonly note: string
	readonly reaches: ReadonlyArray<RenameFeature>
}

const caught: ReadonlyMap<Composition, Caught> = new Map<Composition, Caught>([
	[
		"an arm and the handle that selects it",
		{
			note: "the arm's tagged reference must be installed under the renamed handle",
			reaches: ["a relation renamed", "a handle renamed", "several renames in one step"]
		}
	],
	[
		"a relation and one of its fields",
		{
			note: "the field's rename is offered nested in the relation's, or the field's values are lost",
			reaches: ["a relation renamed", "a field renamed", "several renames in one step"]
		}
	],
	[
		"a closed relation onto the name a table left in the same step",
		{
			note: "the rename map must rewrite only the renamed type's references, and the table's row type must free the name before the type takes it (42710)",
			reaches: ["a closed relation renamed", "a relation renamed"]
		}
	]
])

/** Every composition chained, and the cases no composition's chain begins with.
 *
 * The last name free, never the first: renamed again, not back. */
const planted: ReadonlyArray<Kept<RenameSketch, RenameFeature>> = [
	...Arr.map(compositions, (composition): Kept<RenameSketch, RenameFeature> => {
		const first = caught.get(composition)
		const chained = `${composition}, then chained`
		return {
			note: first === undefined ? chained : `${chained}: ${first.note}`,
			sketch: {
				moves: [
					{
						kind: "composition",
						composition,
						pick: 0,
						mistake: "none",
						review: "the renames chosen"
					},
					{
						kind: "composition",
						composition,
						pick: pickSpan - 1,
						mistake: "none",
						review: "the renames chosen"
					}
				]
			},
			draws: "",
			reaches: [
				`${composition} composed`,
				"a name renamed again",
				...(first === undefined ? [] : first.reaches)
			]
		}
	}),
	{
		note: "the law's arm renamed, then the handle that selects it, then the arm back; a misspelt rename refused",
		sketch: {
			moves: [
				{
					kind: "renames",
					slots: ["ManualTask"],
					pick: 0,
					mistake: "a rename misspelt",
					review: "the renames chosen"
				},
				{
					kind: "renames",
					slots: ["manual"],
					pick: 0,
					mistake: "none",
					review: "the renames chosen"
				},
				{
					kind: "renames",
					slots: ["ManualTask"],
					pick: 0,
					mistake: "none",
					review: "the renames chosen"
				}
			]
		},
		draws: "",
		reaches: ["a relation renamed", "a handle renamed", "a rename misspelt refused"]
	},
	{
		note: "the law's parent and both its arms renamed, then the closed relation that tags them: its rename must be offered, though the law function's body names the type",
		sketch: {
			moves: [
				{
					kind: "composition",
					composition: "the law's parent and both its arms",
					pick: 0,
					mistake: "none",
					review: "the renames chosen"
				},
				{
					kind: "renames",
					slots: ["Kind"],
					pick: 39837,
					mistake: "none",
					review: "the renames chosen"
				}
			]
		},
		draws: "",
		reaches: ["the law's parent and both its arms composed", "a closed relation renamed"]
	},
	{
		note: "a contract and a field it types renamed in one step: the field's candidate requires the contract's, or its values are lost",
		sketch: {
			moves: [
				{
					kind: "renames",
					slots: ["Cents", "amount"],
					pick: 0,
					mistake: "none",
					review: "the renames chosen"
				}
			]
		},
		draws: "",
		reaches: ["a contract renamed", "a field renamed"]
	},
	{
		note: "the alternatives law's selector field renamed: its keys are carried across, or Publish drops the old key index under the new tagged references (2BP01)",
		sketch: {
			moves: [
				{
					kind: "renames",
					slots: ["selector"],
					pick: 0,
					mistake: "none",
					review: "the renames chosen"
				}
			]
		},
		draws: "",
		reaches: ["a field renamed"]
	},
	{
		note: "the closed relation and the selector field it types renamed in one step",
		sketch: {
			moves: [
				{
					kind: "renames",
					slots: ["Kind", "selector"],
					pick: 0,
					mistake: "none",
					review: "the renames chosen"
				}
			]
		},
		draws: "",
		reaches: ["a closed relation renamed", "a field renamed", "several renames in one step"]
	},
	{
		note: "a field's rename nested in its relation's, chosen while the relation's is kept, refused",
		sketch: {
			moves: [
				{
					kind: "renames",
					slots: ["Note", "body"],
					pick: 0,
					mistake: "an orphan nested choice",
					review: "the renames chosen"
				}
			]
		},
		draws: "",
		reaches: ["an orphan nested choice refused"]
	},
	{
		note: "a referenced relation renamed; a candidate split across files refused",
		sketch: {
			moves: [
				{
					kind: "renames",
					slots: ["Note"],
					pick: 0,
					mistake: "a candidate split across files",
					review: "the renames chosen"
				}
			]
		},
		draws: "",
		reaches: ["a relation renamed", "a candidate split across files refused"]
	},
	{
		note: "an arm and its selector field renamed, then Kind renamed with its handle a step after the law over its arms changed, a new roster no candidate renames: the selector Kind types keeps its rows (a conversion by the reviewer's placeholders once failed with 42804)",
		sketch: {
			moves: [
				{
					kind: "composition",
					composition: "an arm and its selector field",
					pick: 0,
					mistake: "none",
					review: "the renames chosen"
				},
				{
					kind: "composition",
					composition: "a closed relation and one of its handles",
					pick: 0,
					mistake: "none",
					review: "the renames chosen"
				}
			]
		},
		draws: "",
		reaches: [
			"a closed relation renamed",
			"a handle renamed",
			"a closed relation's field converted by the reviewer's placeholder"
		]
	},
	{
		note: "an arm and its selector field renamed, then Kind renamed a step after the law over its arms changed, its candidate kept: the selector's conversion the candidate offers to delete runs, and the selector keeps its rows",
		sketch: {
			moves: [
				{
					kind: "composition",
					composition: "an arm and its selector field",
					pick: 0,
					mistake: "none",
					review: "the renames chosen"
				},
				{
					kind: "renames",
					slots: ["Kind"],
					pick: 0,
					mistake: "none",
					review: "a type's rename kept"
				}
			]
		},
		draws: "",
		reaches: [
			"a closed relation renamed",
			"a type's rename kept",
			"a closed relation's field converted by the reviewer's placeholder"
		]
	}
]

/** The candidates of a step's draft for the renames it made, as `how` decides them: a rename offer whose first
 * statement renames an object (a table, a type, a domain) or a column from a name the step left to the name it took.
 * Every other candidate, such as one pairing two renamed arms crosswise by their equal keys, is kept; and with a type's
 * rename kept, each candidate of a closed relation's or a contract's rename that no other chosen candidate requires. */
const intended = (
	g: GenerateResult,
	before: Shape,
	after: Shape,
	how: Review
): ReadonlySet<number> => {
	const changed = Arr.filter(slotList, (slot) => nameOf(before, slot) !== nameOf(after, slot))
	const pair = (slot: Slot) =>
		`${catalogName(slot, nameOf(before, slot))} ${catalogName(slot, nameOf(after, slot))}`
	/** A moved relation is renamed from the name the naming door sets it aside under. */
	const asidePair = (slot: Slot) =>
		`${identifierOf(identity.aside(catalogName(slot, nameOf(before, slot))))} ${catalogName(slot, nameOf(after, slot))}`
	const objectSlots = Arr.filter(
		changed,
		(slot) => kindOf(slot) !== "field" && kindOf(slot) !== "handle"
	)
	const objects = new Set([...Arr.map(objectSlots, pair), ...Arr.map(objectSlots, asidePair)])
	const columns = new Set(
		Arr.map(
			Arr.filter(changed, (slot) => kindOf(slot) === "field"),
			pair
		)
	)
	const chosen = new Set<number>()
	/** The candidates among them of a type's rename, a closed relation's or a contract's. */
	const types = new Set<number>()
	for (const o of offersOf(g)) {
		if (o.kind !== "rename") {
			continue
		}
		const [first] = o.alternative
		if (first.kind !== "statement") {
			continue
		}
		const st = first.statement
		if (
			st.kind === "rename" &&
			st.object !== "ROLE" &&
			st.object !== "SCHEMA" &&
			objects.has(`${st.name.name} ${st.to}`)
		) {
			chosen.add(o.candidate)
			if (st.object === "TYPE" || st.object === "DOMAIN") {
				types.add(o.candidate)
			}
		}
		if (st.kind === "renameColumn" && columns.has(`${st.from} ${st.to}`)) {
			chosen.add(o.candidate)
		}
	}
	switch (how) {
		case "the renames chosen":
			return chosen
		case "a type's rename kept": {
			const required = new Set(
				Arr.flatMap([...chosen], (k) =>
					types.has(k) ? [] : defined(g.plan.candidates[k], `the candidate ${k}`).requires
				)
			)
			return new Set(Arr.filter([...chosen], (k) => !types.has(k) || required.has(k)))
		}
	}
}

/** The closed relation whose handle the field `column` of `table` holds in `shape`: Kind for the selector, Rank for the
 * rank, or none. */
const rosterOfField = (shape: Shape, table: string, column: string): "Kind" | "Rank" | "none" => {
	const at = (relation: Slot, field: string) =>
		table === catalogName(relation, nameOf(shape, relation)) &&
		column === identifierOf(identity.column(parsedName(field)))
	return at("Task", nameOf(shape, "selector")) ? "Kind" : at("Item", "rank") ? "Rank" : "none"
}

/** The value a reviewer writes for a placeholder of the field `column` of `table`, in `shape`: a handle every name of
 * its closed relation holds (Kind's Automatic, Rank's Low) for a field of one, and 0 for every other field, whose types
 * all take it. */
const placeholderValue = (shape: Shape, table: string, column: string): string => {
	const roster = rosterOfField(shape, table, column)
	switch (roster) {
		case "Kind":
			return quoteString("Automatic")
		case "Rank":
			return quoteString("Low")
		case "none":
			return "0"
	}
}

/** The reviewer's conversion of a field converted in place, from its value before by its text, as `after` declares it: a
 * field of a closed relation whose handle the step renamed with it, a new roster, maps the handle's old name to its new. */
const conversionValue = (before: Shape, after: Shape, table: string, column: ColumnDef): string => {
	const text = `${quoteIdent(column.name)}::text`
	const roster = rosterOfField(after, table, column.name)
	const handle = roster === "Kind" ? "manual" : roster === "Rank" ? "high" : undefined
	const from = handle === undefined ? undefined : nameOf(before, handle)
	const to = handle === undefined ? undefined : nameOf(after, handle)
	const mapped =
		from === undefined || to === undefined || from === to
			? text
			: `CASE ${text} WHEN ${quoteString(from)} THEN ${quoteString(to)} ELSE ${text} END`
	return `${mapped}::${printType(column.type)}`
}

/** The reviewer of a step from `before` to `after`: the candidates of the renames it made decided as `how` says, each
 * new column's placeholder given the value of its field in `after` (placeholderValue), and a field converted in place
 * computed from its value before (conversionValue): the reviewer's conversion. */
const reviewing =
	(before: Shape, after: Shape, how: Review) =>
	(g: GenerateResult): Reviewer => ({
		decisions: () => ({
			chosen: intended(g, before, after, how),
			losses: "written",
			value: (p) => {
				switch (p.kind) {
					case "placeholderColumn":
						return placeholderValue(after, p.table.name, p.column.name)
					case "placeholderRetype":
						return conversionValue(before, after, p.table.name, p.column)
					case "placeholderHandles":
						throw new Error("a renamed handle is renamed in place; no roster is rebuilt here")
				}
			}
		}),
		edit: (f) => f.text
	})

const accounts = [id(1), id(2)] as const

/** The first version's rows: two accounts, a note of the first, a comment on it, an automatic and a
 * manual task with their arms, and an item.
 *
 * A fourth note of the first account is past its capacity.
 *
 * Each case is bounded by the hang guard, so a test needs no timeout of its own beyond the config's: about thirty kept
 * cases run about a hundred migrations, each drafted, checked, applied, admitted and opened, which a loaded machine
 * slows many times over. */
const renames = explore(
	{
		suite: "migrate/renames",
		draw: drawn(sketchGen),
		literal: Formatter.format,
		kept: planted,
		runs: 3,
		shrink: { kind: "bounded", candidates: 10 },
		concurrency: 1,
		steerEvery: 16,
		steering: { kind: "mutate", cases: 160, sense: notesOnly },
		features: features<RenameFeature>([
			"a relation renamed",
			"a field renamed",
			"a closed relation renamed",
			"a handle renamed",
			"a contract renamed",
			"a name renamed again",
			"a name renamed back",
			"several renames in one step",
			...Arr.map(compositions, (composition): RenameFeature => `${composition} composed`),
			"a rename misspelt refused",
			"a candidate split across files refused",
			"an orphan nested choice refused",
			"a closed relation's field converted by the reviewer's placeholder",
			"a type's rename kept"
		]),
		caseHang: Duration.minutes(2)
	},
	(sketch, c) =>
		Effect.scoped(
			Effect.gen(function* () {
				const ws = yield* workspace("chain")
				let shape = originalShape
				const g0 = (yield* step(
					ws,
					shopOf(ws.name, shape).value,
					reviewing(shape, shape, "the renames chosen"),
					"none"
				)).g
				const tbl = (g: GenerateResult, slot: Slot) => table(g, nameOf(shape, slot))
				const col = (g: GenerateResult, slot: Slot, field: string) =>
					column(g, nameOf(shape, slot), field)
				const n = (slot: Slot) => nameOf(shape, slot)
				yield* ws.sql(
					`INSERT INTO ${tbl(g0, "Account")} VALUES ('${accounts[0]}'), ('${accounts[1]}')`
				)
				yield* ws.sql(
					`INSERT INTO ${tbl(g0, "Note")} (${col(g0, "Note", "account")}, ${col(g0, "Note", n("body"))}, ${col(g0, "Note", n("title"))}) VALUES ('${accounts[0]}', 'hello', 'subject')`
				)
				yield* ws.sql(`INSERT INTO ${tbl(g0, "Comment")} VALUES ('${id(21)}', 1)`)
				yield* ws.sql(
					`WITH t AS (INSERT INTO ${tbl(g0, "Task")} VALUES ('${id(11)}', 'Automatic'), ('${id(12)}', ${quoteString(n("manual"))})), m AS (INSERT INTO ${tbl(g0, "ManualTask")} VALUES ('${id(12)}', 'ops')) INSERT INTO ${tbl(g0, "AutomaticTask")} VALUES ('${id(11)}', 10)`
				)
				yield* ws.sql(
					`INSERT INTO ${tbl(g0, "Item")} VALUES ('${id(31)}', ${quoteString(n("high"))}, 5, '${accounts[1]}', true)`
				)
				/** Every name each slot has had, for the features. */
				const history = new Map<Slot, ReadonlyArray<string>>(
					Arr.map(slotList, (slot) => [slot, [pools[slot][0]]])
				)
				for (const move of [...sketch.moves, ...leadOf(c)]) {
					for (const next of stepsOf(shape, move)) {
						const changed = Arr.filter(slotList, (slot) => nameOf(next.shape, slot) !== n(slot))
						if (changed.length === 0 && next.shape.amount === shape.amount) {
							continue
						}
						for (const slot of changed) {
							c.note(`a ${kindOf(slot)} renamed`)
							const had = defined(history.get(slot), `the names ${slot} had`)
							const to = nameOf(next.shape, slot)
							if (to === pools[slot][0] && had.length > 1) {
								c.note("a name renamed back")
							} else if (had.length > 1) {
								c.note("a name renamed again")
							}
							history.set(slot, [...had, to])
						}
						if (changed.length > 1) {
							c.note("several renames in one step")
						}
						if (next.composes !== "no composition") {
							c.note(`${next.composes} composed`)
						}
						const reviewer = reviewing(shape, next.shape, next.review)
						const turn = yield* step(ws, shopOf(ws.name, next.shape).value, reviewer, next.mistake)
						if (turn.mistaken && next.mistake !== "none") {
							c.note(`${next.mistake} refused`)
						}
						/** What the reviewed folder runs: a field of a closed relation converted in place by the reviewer's
						 * placeholder, as drafted or as the conversion a type's candidate offers to delete, kept (the 42804
						 * class is the conversion running); and a type's candidate the review keeps. */
						const decisions = reviewer(turn.g).decisions(turn.g)
						const ran = reviewFolder(turn.g, decisions)
						if (Result.isFailure(ran)) {
							return assert.fail("the step's review is inexpressible")
						}
						if (
							Arr.some(ran.success.plan, (f) =>
								Arr.some(
									placeholdersOf(f),
									(p) =>
										p.kind === "placeholderRetype" &&
										rosterOfField(next.shape, p.table.name, p.column.name) !== "none"
								)
							)
						) {
							c.note("a closed relation's field converted by the reviewer's placeholder")
						}
						if (
							next.review === "a type's rename kept" &&
							Arr.some(
								turn.g.plan.candidates,
								(x, k) => x.renames.kind === "type" && !decisions.chosen.has(k)
							)
						) {
							c.note("a type's rename kept")
						}
						shape = next.shape
						const g = turn.g
						unorderedEqual(
							yield* texts(ws, `SELECT ${col(g, "Account", "id")} FROM ${tbl(g, "Account")}`),
							[accounts[0], accounts[1]]
						)
						assert.deepEqual(
							yield* texts(
								ws,
								`SELECT ${col(g, "Note", "id")}, ${col(g, "Note", "account")}, ${col(g, "Note", n("body"))}, ${col(g, "Note", n("title"))} FROM ${tbl(g, "Note")}`
							),
							[`1 ${accounts[0]} hello subject`]
						)
						assert.deepEqual(
							yield* texts(
								ws,
								`SELECT ${col(g, "Comment", "id")}, ${col(g, "Comment", "note")} FROM ${tbl(g, "Comment")}`
							),
							[`${id(21)} 1`]
						)
						unorderedEqual(
							yield* texts(
								ws,
								`SELECT ${col(g, "Task", "id")}, ${col(g, "Task", n("selector"))} FROM ${tbl(g, "Task")}`
							),
							[`${id(11)} Automatic`, `${id(12)} ${n("manual")}`]
						)
						assert.deepEqual(
							yield* texts(
								ws,
								`SELECT ${col(g, "ManualTask", "task")}, ${col(g, "ManualTask", n("operator"))} FROM ${tbl(g, "ManualTask")}`
							),
							[`${id(12)} ops`]
						)
						assert.deepEqual(
							yield* texts(
								ws,
								`SELECT ${col(g, "AutomaticTask", "task")}, ${col(g, "AutomaticTask", "budget")} FROM ${tbl(g, "AutomaticTask")}`
							),
							[`${id(11)} 10`]
						)
						assert.deepEqual(
							yield* texts(
								ws,
								`SELECT ${col(g, "Item", "id")}, ${col(g, "Item", "rank")}, ${col(g, "Item", n("amount"))} FROM ${tbl(g, "Item")}`
							),
							[`${id(31)} ${n("high")} 5`]
						)
						yield* expectConstraint(
							ws.sql(`DELETE FROM ${tbl(g, "ManualTask")}`),
							shopOf(ws.name, shape).alternatives,
							"23000"
						)
						yield* expectSqlstate(ws.sql(`DELETE FROM ${tbl(g, "Note")}`), "23503")
						yield* expectConstraint(
							ws.sql(
								`INSERT INTO ${tbl(g, "Note")} (${col(g, "Note", "account")}, ${col(g, "Note", n("body"))}, ${col(g, "Note", n("title"))}) VALUES ('${accounts[0]}', 'b', 't'), ('${accounts[0]}', 'c', 't'), ('${accounts[0]}', 'd', 't')`
							),
							shopOf(ws.name, shape).capacity,
							"23000"
						)
						/** A billable item of no account is refused; an unbilled one is not the law's. */
						const item = (n2: number, billable: boolean) =>
							ws.sql(
								`INSERT INTO ${tbl(g, "Item")} (${col(g, "Item", "id")}, ${col(g, "Item", "rank")}, ${col(g, "Item", n("amount"))}, ${col(g, "Item", "account")}, ${col(g, "Item", "billable")}) VALUES ('${id(n2)}', 'Low', 1, '${id(99)}', ${billable})`
							)
						yield* expectConstraint(item(33, true), shopOf(ws.name, shape).selected, "23000")
						yield* item(34, false)
						yield* ws.sql(
							`DELETE FROM ${tbl(g, "Item")} WHERE ${col(g, "Item", "id")} = '${id(34)}'`
						)
						if (shape.amount === "the contract") {
							yield* expectConstraint(
								ws.sql(
									`INSERT INTO ${tbl(g, "Item")} (${col(g, "Item", "id")}, ${col(g, "Item", "rank")}, ${col(g, "Item", n("amount"))}, ${col(g, "Item", "account")}, ${col(g, "Item", "billable")}) VALUES ('${id(32)}', 'Low', -1, '${accounts[0]}', false)`
								),
								contractCheckAt(n("Cents")),
								"23514"
							)
						}
					}
				}
			})
		)
)

layer(Layer.mergeAll(Substrate.layer, NodeServices.layer))(
	"renames through generate, check, migrate and Db.open",
	(it) => {
		it.effect(
			"drawn rename chains and compositions across relations, fields, closed relations, handles and contracts carry every row and keep every law",
			(ctx) => searched(ctx, renames)
		)
	}
)
