import { Array as Arr, type DateTime, Effect, type FileSystem, type Path, Result } from "effect"
import type { DriftFound } from "#adapter/admission/drift.ts"
import { readHistory } from "#adapter/admission/history.ts"
import { type LiveObjects, liveObjects } from "#adapter/admission/upgrade.ts"
import { fromEngine, toResult } from "#adapter/engine.ts"
import { readCatalogDrift, readLedger } from "#adapter/migrate/apply.ts"
import type { MigrateError } from "#adapter/migrate/errors.ts"
import { statementsFor } from "#adapter/migrate/ledger.ts"
import {
	type MigrationConnection,
	type MigrationSession,
	openMigrationSession
} from "#adapter/migrate/session.ts"
import { nextTimestamp } from "#cli/clock.ts"
import { type WholeChain, wholeChain } from "#cli/committed.ts"
import { type CompiledSchema, compileSchema, type ResolvedConfig } from "#cli/config.ts"
import { type CliError, cliError, UpgradeRefused, type UpgradeFaultOf } from "#cli/errors.ts"
import { readSchemaTree, type SchemaTree } from "#cli/files.ts"
import {
	draftRefused,
	installationUnder,
	type SchemaDraft,
	type SchemaGenerateReport,
	type ServedBasis,
	servedFiles,
	servedWrites,
	snapshotFilesOf,
	writeDraft
} from "#cli/generate.ts"
import { noRenames, type Phases, type PreviousRoster, rostersOf } from "#compiler/plan/common.ts"
import {
	type DraftInput,
	freshSnapshot,
	generateUpgrade,
	identifierOf,
	type Installation,
	type LiveInstallation,
	liveRosters,
	parseIdent,
	spellingReaders,
	spellingsHeld
} from "#compiler/plan/migration.ts"
import { type DeploySnapshot, installationsOf } from "#compiler/plan/serve.ts"

/**
 * `grizzle upgrade`: rebases each configured schema's live installation onto this grizzle's compile of the source it
 * was deployed from, the configuration and schemas at the commit its committed folders were drafted from, whatever
 * format its committed snapshot is. grizzle converts no record of another format: the upgrade compiles the source again
 * and reads the database, the one authority on what it holds.
 *
 * Before connecting it reads every schema's folders' meta.json alone, which records no format, and the chain they reach
 * (committed.ts wholeChain); snapshot.json and manifest.json are never read. Then, on one session as the migration
 * identity, for each schema in configured order:
 *
 * - its history, which no source determines, off the live database (adapter/admission/history.ts): each roster's codes,
 *   read off the names constant its domain's CHECK reads, which its codes name (compiler/deploy/upgrade/history.ts
 *   liveRosters), never assigned by default; each table's attribute numbers used; and each pattern language's
 *   spelling, one of the spellings the schema writes of it, least by code unit first;
 * - the source compiled under that history (generate.ts installationUnder), and the drift check of its fresh snapshot
 *   against the live catalog (adapter/migrate/apply.ts readDrift), which proves each history fact or refuses: a roster
 *   whose names constant the database does not hold as the target's is refused as an object of a kind no draft
 *   changes, and a language no object the database holds as the target's reads in the spelling tried is tried in the
 *   next, refused once none is left (UpgradeRefused spellingUnproven);
 * - the database at the snapshot its committed folders reach, no folder partly applied, or the upgrade is refused
 *   (pending);
 * - how the live catalog holds the target (adapter/admission/upgrade.ts liveObjects): each object held, stale, absent
 *   or departed, or refused;
 * - every fact beside the objects the check found carried by the draft (unexplained): a privilege or a policy of an
 *   object it creates or drops; anything else is refused (undescribed), a role's or a setting's change among it;
 * - the draft (generateUpgrade): where the database holds the target whole under its fingerprint, the snapshot's files
 *   written again in this grizzle's format, with no folder; else the folder `<timestamp>_upgrade`, which rebases the
 *   history onto the target with the safety of any migration (its absent objects created, its stale ones changed by
 *   their kind's rule, its departed ones dropped), holding no SQL file where only the fingerprint moved; and the served
 *   files of the snapshot the directory then commits.
 *
 * Every schema drafts before anything is written, and nothing is written to the database: `grizzle migrate` applies
 * the folder, its drift check judging the database by the new snapshot.
 */
export const upgradeAll = Effect.fn("upgradeAll")(function* (
	config: ResolvedConfig,
	connection: MigrationConnection,
	now: DateTime.Utc,
	phases: Phases
): Effect.fn.Return<
	ReadonlyArray<SchemaGenerateReport>,
	CliError | MigrateError,
	FileSystem.FileSystem | Path.Path
> {
	const committed = yield* Effect.forEach(config.schemas, (schema) =>
		Effect.gen(function* () {
			const tree = yield* readSchemaTree(schema.declared, schema.directory)
			const chain = yield* wholeChain(schema, tree)
			const compiled = yield* Effect.fromResult(compileSchema(schema))
			return { tree, chain, compiled }
		})
	)
	const drafts = yield* Effect.scoped(
		Effect.gen(function* () {
			const session = yield* openMigrationSession(connection)
			return yield* Effect.forEach(committed, (c) =>
				upgradeSchema(session, c.compiled, c.tree, c.chain, now, phases)
			)
		})
	)
	return yield* Effect.forEach(drafts, writeDraft)
})

/** The refusal of the upgrade of `schema`, for `fault`. */
const refused = (schema: CompiledSchema, fault: UpgradeFaultOf): CliError =>
	cliError(new UpgradeRefused({ schema: schema.configured.declared, fault }))

/** The target compiled under a history, with its fresh snapshot and how the live catalog holds it. */
interface Judged {
	readonly installation: Installation
	readonly workload: DraftInput["workload"]
	readonly served: ServedBasis
	readonly target: DeploySnapshot
	readonly objects: LiveObjects
	readonly found: DriftFound
}

/**
 * The upgrade of one schema's live installation (upgradeAll), as the draft generate writes (generate.ts SchemaDraft):
 * the snapshot's files written again, or a folder and the snapshot's files, and the served files.
 */
const upgradeSchema = Effect.fn("upgradeSchema")(function* (
	session: MigrationSession,
	compiled: CompiledSchema,
	tree: SchemaTree,
	chain: WholeChain,
	now: DateTime.Utc,
	phases: Phases
): Effect.fn.Return<SchemaDraft, CliError | MigrateError, FileSystem.FileSystem> {
	const schema = compiled.configured
	const ident = schema.ident
	const levels = Arr.map(installationsOf(compiled.owned), identifierOf)
	const history = yield* readHistory(session, ident, levels)
	const rosters = yield* Effect.fromResult(
		Result.mapError(toResult(liveRosters(rostersOf(compiled.owned), history.constants)), (unread) =>
			refused(compiled, { kind: "rosterUnread", roster: unread.roster, found: unread.found })
		)
	)
	const judged = yield* provenSpellings(session, compiled, rosters, phases)
	const statements = yield* Effect.fromResult(statementsFor(ident))
	const ledger = yield* readLedger(session, ident, statements)
	if (ledger.latest !== chain.reached || ledger.partial !== undefined) {
		return yield* refused(compiled, {
			kind: "pending",
			reached: chain.reached,
			latest: ledger.latest,
			partial: ledger.partial?.folder
		})
	}
	const live: LiveInstallation = {
		fingerprint: ledger.latest,
		kept: keptObjects(judged.target, judged.objects, judged.found.described),
		stale: judged.objects.stale,
		departures: Arr.map(judged.objects.departed, (d) => d.departure),
		attnums: history.attnums
	}
	const input = { installation: judged.installation, workload: judged.workload, live }
	const facts = unexplained(judged.objects, judged.found)
	if (Arr.isReadonlyArrayNonEmpty(facts)) {
		return yield* refused(compiled, { kind: "undescribed", facts })
	}
	const generated = yield* Effect.mapError(
		fromEngine(generateUpgrade({ ...input, timestamp: nextTimestamp(now, chain.timestamps) })),
		draftRefused(schema.declared, "draft")
	)
	const files = yield* servedFiles(compiled, generated, judged.served, phases)
	const served = yield* servedWrites(schema, files, tree.logins)
	const certification = judged.served.kind === "logins" ? judged.served.certification : []
	const fences = judged.served.kind === "logins" ? judged.served.fences : []
	const snapshotFiles = yield* snapshotFilesOf(compiled, generated)
	if (generated.change === "none") {
		const rebased: SchemaDraft = {
			kind: "rederived",
			schema,
			snapshot: generated.snapshot,
			snapshotFiles,
			served,
			certification,
			fences
		}
		return rebased
	}
	const upgraded: SchemaDraft = {
		kind: "drafted",
		schema,
		folder: generated.folder,
		snapshot: generated.snapshot,
		snapshotFiles,
		served,
		certification,
		fences
	}
	return upgraded
})

/**
 * The target compiled under the live history whose every pattern language's spelling is proven, with how the live
 * catalog holds it: each language spelled first by the least spelling the schema writes of it, by code unit; a
 * language some object of the target reads, none of which the database holds as the target's, spelled by its next, the
 * target compiled and judged again; refused once a language has no next (spellingUnproven). A language no object
 * reads has no installed trace. Each drift check reads none of grizzle's bookkeeping, whose representation may be
 * another format's: a ledger or proofs table the database holds otherwise is an object that holds rows (stored).
 */
const provenSpellings = Effect.fn("provenSpellings")(function* (
	session: MigrationSession,
	compiled: CompiledSchema,
	rosters: ReadonlyArray<PreviousRoster>,
	phases: Phases
): Effect.fn.Return<Judged, CliError | MigrateError> {
	const candidates = spellingsHeld(compiled.owned)
	const at = new Map<string, number>(Arr.map([...candidates.keys()], (language) => [language, 0]))
	for (;;) {
		const spellings = new Map(
			Arr.flatMap([...candidates], ([language, spelled]) => {
				const spelling = spelled[at.get(language) ?? 0]
				return spelling === undefined ? [] : [[language, spelling] as const]
			})
		)
		const under = yield* installationUnder(
			compiled,
			{
				previous: rosters,
				renames: noRenames,
				spellings
			},
			phases
		)
		const target = yield* Effect.mapError(
			fromEngine(freshSnapshot({ installation: under.installation, workload: under.workload })),
			draftRefused(compiled.configured.declared, "draft")
		)
		const verdict = yield* readCatalogDrift(session, target)
		const kinds = new Map(Arr.map(target.manifest.objects, (o) => [o.ident, o.kind] as const))
		const objects = yield* Effect.fromResult(
			Result.mapError(liveObjects(kinds, verdict.found), (fault) =>
				refused(compiled, { kind: "object", fault })
			)
		)
		const readers = spellingReaders(
			under.installation.manifest.objects,
			under.installation.names.spellings.table
		)
		const unproven = Arr.filter(
			[...readers],
			([, objectsReading]) =>
				objectsReading.size > 0 && !Arr.some([...objectsReading], (o) => objects.held.has(o))
		)
		if (!Arr.isReadonlyArrayNonEmpty(unproven)) {
			const judged: Judged = {
				installation: under.installation,
				workload: under.workload,
				served: under.served,
				target,
				objects,
				found: verdict.found
			}
			return judged
		}
		for (const [language] of unproven) {
			const next = (at.get(language) ?? 0) + 1
			const spelled = candidates.get(language) ?? []
			if (next >= spelled.length) {
				return yield* refused(compiled, { kind: "spellingUnproven", language, tried: spelled })
			}
			at.set(language, next)
		}
	}
})

/**
 * The objects of `target` the previous installation holds (LiveInstallation kept): each object PostgreSQL describes
 * that the database holds, as the target's or otherwise; and each other, a role, a grant, a membership, a validation,
 * whose every object it is created after (the target's edges) is held, in install order, so a grant on an object the
 * upgrade creates, or a validation of a constant it creates, is drafted with it.
 */
const keptObjects = (
	target: DeploySnapshot,
	objects: LiveObjects,
	described: ReadonlySet<string>
): ReadonlySet<string> => {
	const after = new Map<string, Array<string>>()
	for (const e of target.manifest.edges) {
		after.getOrInsertComputed(e.to, () => []).push(e.from)
	}
	const kept = new Set<string>()
	for (const o of target.manifest.objects) {
		const held = described.has(o.ident)
			? objects.held.has(o.ident) || objects.stale.has(o.ident)
			: Arr.every(after.get(o.ident) ?? [], (from) => kept.has(from))
		if (held) {
			kept.add(o.ident)
		}
	}
	return kept
}

/**
 * The key a privilege or a policy is named by where its object is the target's or the database's: its family, its
 * object's schema and its object's name.
 */
const objectKey = (family: string, schema: string, name: string): string =>
	`${family}\u0000${schema}\u0000${name}`

/**
 * The keys an object's privileges are named by (objectKey), by the families a privilege on it is of (roles.ts
 * privilegesSelect): a function's, a relation's and its columns', a type's or a domain's, a schema's; none for an object
 * of a kind no privilege names. A policy's, by its table and its name, under the family `policy`.
 */
const keysOf = (object: string): ReadonlyArray<string> => {
	const ident = parseIdent(object)
	switch (ident.kind) {
		case "function":
			return [objectKey("function", ident.schema, ident.name)]
		case "table":
		case "view":
			return [
				objectKey("table", ident.schema, ident.name),
				objectKey("column", ident.schema, ident.name)
			]
		case "domain":
		case "type":
			return [objectKey("type", ident.schema, ident.name)]
		case "schema":
			return [objectKey("schema", ident.name, ident.name)]
		case "policy":
			return [objectKey("policy", "", `${ident.relation}\u0000${ident.name}`)]
		case "extension":
		case "role":
		case "membership":
		case "privileges":
		case "publication":
		case "index":
		case "statistics":
		case "rowSecurity":
		case "replicaIdentity":
		case "column":
		case "constraint":
		case "trigger":
		case "other":
			return []
	}
}

/**
 * What the drift check of the target found beside its objects that the upgrade's draft does not carry, a line each:
 * each privilege that differs but one the target grants on an object the draft creates, which it grants with it, and
 * one the database holds on an object the draft drops, which the drop takes; each policy that differs but one the
 * draft creates or drops; and every other fact beside the descriptions, a role's, a membership's, a setting's, a default
 * privilege's, an extension's or a publication's, which no rebase drafts.
 */
const unexplained = (objects: LiveObjects, found: DriftFound): ReadonlyArray<string> => {
	const created = new Set(Arr.flatMap([...objects.absent], keysOf))
	const dropped = new Set(Arr.flatMap(objects.departed, (d) => keysOf(d.object)))
	const carried = (kind: "missing" | "unexpected", key: string): boolean =>
		kind === "missing" ? created.has(key) : dropped.has(key)
	return [
		...Arr.flatMap(found.privileges, (p) =>
			carried(
				p.difference.kind,
				objectKey(p.difference.family, p.difference.schema, p.difference.name)
			)
				? []
				: [
						`${p.difference.kind} role ${p.role} privilege ${p.difference.privilege} on ${p.difference.family} ${p.difference.object}`
					]
		),
		...Arr.flatMap(found.policies, (p) =>
			carried(
				p.difference.kind,
				objectKey("policy", "", `${p.difference.policy.table}\u0000${p.difference.policy.name}`)
			)
				? []
				: [
						`${p.difference.kind} policy ${p.difference.policy.name} on ${p.difference.policy.table} naming role ${p.role}`
					]
		),
		...Arr.map(found.others, (m) => `${m.kind} ${m.fact}`)
	]
}
