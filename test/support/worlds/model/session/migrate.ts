import { Array as Arr, Option, Record as Rec } from "effect"
import { violations } from "#test/pg/laws/families/model.ts"
import {
	atMostOne,
	evaluateRules,
	hostSchemaOf,
	judgedSchemaOf
} from "#test/support/worlds/model/host.ts"
import {
	changesWorlds,
	driftOf,
	healedBy,
	sameNames,
	sameRole
} from "#test/support/worlds/model/session/catalog.ts"

import { domainLawKey, lawDomainsOf } from "#test/support/worlds/model/session/domains.ts"
import { meetingOf } from "#test/support/worlds/model/session/laws.ts"
import {
	factsIn,
	loginOf,
	loginsCreatedOn,
	roleOf,
	samePlain
} from "#test/support/worlds/model/session/state.ts"
import { keysOf, refusedAtBuild } from "#test/support/worlds/model/session/writes.ts"
import type {
	BaseSpec,
	FieldSpec,
	HostFact,
	HostState,
	InstalledNames,
	InstallSpec,
	LawSpec,
	LedgerStanding,
	MigrationHow,
	ModelState,
	ActionOutcome,
	SqlState,
	Allowed
} from "#test/support/worlds/model/types.ts"

/** Reality as a migrated base holds it: a kept relation's facts, a new relation empty. */
const migratedReality = (reality: HostState, to: BaseSpec): HostState =>
	new Map(
		Arr.map(to.relations, (r): [string, ReadonlyArray<HostFact>] => [
			r.name,
			factsIn(reality, r.name)
		])
	)

/**
 * A state whose installation the compiler has yet to name: every part of a ModelState but its names and the host schema
 * they give, which a landing completes (Landing).
 */
type Unnamed = Omit<ModelState, "names" | "host">

/**
 * Where a run leaves the model: the state it began in, named, when no folder landed; otherwise the state after its last
 * landing, which awaits the compiler's names for the installation it landed.
 */
type Reached =
	| { readonly kind: "named"; readonly state: ModelState }
	| { readonly kind: "landed"; readonly state: Unnamed }

/** A landed state completed under the compiler's names for its installation: its names, and its host schema of them. */
const named = (state: Unnamed, names: InstalledNames): ModelState => ({
	...state,
	names,
	host: hostSchemaOf(state.install.base, names)
})

/** A run's outcome in the state it reaches: a branch where nothing landed, else a landing awaiting the names. */
const allowedAt = (
	observation: ActionOutcome,
	reached: Reached,
	then: <S extends Unnamed>(state: S) => S
): Allowed =>
	reached.kind === "named"
		? { observation, next: then(reached.state) }
		: {
				observation,
				landing: {
					install: reached.state.install,
					complete: (names) => then(named(reached.state, names))
				}
			}

/**
 * The SQLSTATE of each law of an installation the state's data breaks once migrated onto it, each once, judged under
 * the base's host schema before an installation names it (host.ts judgedSchemaOf): only how PostgreSQL meets a law
 * matters here.
 */
const brokenOnto = (state: Pick<Unnamed, "reality">, to: InstallSpec): ReadonlyArray<SqlState> => {
	const host = judgedSchemaOf(to.base)
	const reality = migratedReality(state.reality, to.base)
	return [
		...new Set(
			Arr.flatMap(host.laws, (law): ReadonlyArray<SqlState> =>
				violations({ relations: host.relations, laws: [law] }, reality).length > 0
					? [meetingOf(host, law).sqlstate]
					: []
			)
		)
	]
}

/**
 * The state an installation's folders leave once every one applied: the installation, at the next version when it is
 * another (one that lands the installation it replaces reaches the same snapshot), its dropped relations gone, new ones
 * empty, a new derived relation populated from reality and a kept one keeping its facts until a refresh; every folder
 * applied; every perturbation of the catalog the folder rewrites healed (catalog.ts healedBy). A Db session keeps the
 * snapshot it was opened with, so its calls refuse as `migrated` once the version moved past it.
 */
const landedOn = (state: Unnamed, to: InstallSpec): Unnamed => {
	const reality = migratedReality(state.reality, to.base)
	const derived: Record<string, ReadonlyArray<HostFact>> = {}
	for (const d of to.base.derived) {
		derived[d.name] = state.derived[d.name] ?? evaluateRules(to.base, d.rules, reality, derived, {})
	}
	const version = samePlain(state.install, to) ? state.version : state.version + 1
	return {
		install: to,
		reality,
		derived,
		sessions: state.sessions,
		connections: state.connections,
		tampered: Arr.filter(state.tampered, (p) => !healedBy(state.install, to, p)),
		version,
		loginsCreated: loginsCreatedOn(state, to, version),
		migrations: { kind: "applied" }
	}
}

/**
 * A run stopped at a law statement: one outcome per SQLSTATE the broken laws meet, in the state it reached with `then`
 * applied.
 */
const stopped = (
	sqlstates: Arr.NonEmptyReadonlyArray<SqlState>,
	reached: Reached,
	then: <S extends Unnamed>(state: S) => S
): Arr.NonEmptyReadonlyArray<Allowed> =>
	Arr.map(sqlstates, (sqlstate) => allowedAt({ kind: "refused", sqlstate }, reached, then))

/** A state with folders pending, oldest first, over its installation, the ledger at `ledger` on the first. */
const pendingOn =
	(folders: Arr.NonEmptyReadonlyArray<InstallSpec>, ledger: LedgerStanding) =>
	<S extends Unnamed>(state: S): S => ({
		...state,
		migrations: { kind: "pending", folders, ledger }
	})

/** A state as a run leaves it. */
const asLeft = <S extends Unnamed>(state: S): S => state

/**
 * A file of a folder drafted from one installation to another, as packages/engine/src/deploy/diff/plan.ts runs its slots,
 * one file for each run of slots that holds a statement, in this order: the new enum labels (no transaction); Setup,
 * the new enums and domains; Structure, the world objects of the roles the installation holds that change or go and
 * every new world function, new tables and columns, and constraints NOT VALID; the indexes of new relations; the
 * concurrent indexes of relations that may hold rows; Validate, the constraints validated and the concurrent indexes
 * attached; one file per residual law; Publish, the roles, logins, memberships and grants, the new roles' world objects,
 * what the target no longer has (an index a new key serves instead among it), and last the COMMENT of every object the
 * folder creates under a hashed name.
 */
export type FolderFile =
	| "labels"
	| "setup"
	| "structure"
	| "indexes"
	| "concurrent"
	| "validate"
	| "law"
	| "publish"

/**
 * Whether a law is one PostgreSQL enforces itself, built by a statement of its own that fails over data breaking it: a
 * key's unique index, an at-most-one capacity's (host.ts atMostOne), a check, a containment into a key with no selector,
 * a foreign key. Every other law is residual: its function, triggers and violation query in a file of its own, whose
 * function and triggers would commit with the files before its violation query and keep judging writes.
 */
export const nativeLaw = (base: BaseSpec, law: LawSpec): boolean => {
	switch (law.kind) {
		case "key":
		case "check":
			return true
		case "capacity":
			return atMostOne(law)
		case "contained":
			return (
				Rec.isEmptyRecord(law.source.where) &&
				Rec.isEmptyRecord(law.target.where) &&
				Arr.some(
					keysOf(base, law.target.relation),
					(k) =>
						k.length === law.target.fields.length &&
						Arr.every(k, (f) => law.target.fields.includes(f))
				)
			)
		case "spanKey":
		case "mirrors":
		case "covered":
		case "alternatives":
			return false
	}
}

/** The relation a native law is built on: a key's or a check's, a containment's source, an at-most-one capacity's source. */
const builtOn = (law: LawSpec): string | undefined => {
	switch (law.kind) {
		case "key":
		case "check":
			return law.relation
		case "contained":
			return law.source.relation
		case "capacity":
			return atMostOne(law) ? law.source.relation : undefined
		case "spanKey":
		case "mirrors":
		case "covered":
		case "alternatives":
			return undefined
	}
}

/** Whether a native law is a unique index: a key's, or an at-most-one capacity's. */
const uniqueIndexed = (law: LawSpec): boolean => law.kind === "key" || law.kind === "capacity"

/** Whether a relation both bases hold gains a serial field, whose identity sequence the folder creates. */
const gainsSerial = (was: BaseSpec, now: BaseSpec): boolean =>
	Arr.some(now.relations, (r) => {
		const before = Option.getOrUndefined(Arr.findFirst(was.relations, (x) => x.name === r.name))
		const gained = (f: FieldSpec): boolean =>
			before !== undefined && !Arr.some(before.fields, (g) => g.name === f.name)
		return Arr.some(r.fields, (f) => f.domain.kind === "serial" && gained(f))
	})

/** The files of a folder drafted from one installation to another, in the order the runner runs them (FolderFile). */
export const folderFiles = (from: InstallSpec, to: InstallSpec): ReadonlyArray<FolderFile> => {
	const was = from.base
	const now = to.base
	const held = (relation: string): boolean => Arr.some(was.relations, (r) => r.name === relation)
	const fromDomains = new Set(Arr.map(lawDomainsOf(was), domainLawKey))
	const added = Arr.filter(now.laws, (law) => !Arr.some(was.laws, (old) => samePlain(old, law)))
	const native = Arr.filter(added, (law) => nativeLaw(now, law))
	const residual = Arr.filter(added, (law) => !nativeLaw(now, law))
	const onHeld = (law: LawSpec): boolean => {
		const relation = builtOn(law)
		return relation !== undefined && held(relation)
	}
	const notValid = Arr.filter(native, (law) => !uniqueIndexed(law) && onHeld(law))
	const concurrent = Arr.some(native, (law) => uniqueIndexed(law) && onHeld(law))
	const labels = Arr.some(now.closed, (c) => {
		const before = Option.getOrUndefined(Arr.findFirst(was.closed, (x) => x.name === c.name))
		return before !== undefined && Arr.some(c.members, (m) => !before.members.includes(m))
	})
	const setup =
		Arr.some(now.closed, (c) => !Arr.some(was.closed, (x) => x.name === c.name)) ||
		Arr.some(lawDomainsOf(now), (d) => !fromDomains.has(domainLawKey(d)))
	const gains =
		Arr.some(now.relations, (r) => {
			const before = Option.getOrUndefined(Arr.findFirst(was.relations, (x) => x.name === r.name))
			return (
				before === undefined ||
				Arr.some(r.fields, (f) => !Arr.some(before.fields, (g) => g.name === f.name))
			)
		}) || Arr.some(now.derived, (d) => !Arr.some(was.derived, (x) => x.name === d.name))
	const worlds = changesWorlds(from, to)
	const structure = worlds || gains || notValid.length > 0
	const indexes = Arr.some(native, (law) => uniqueIndexed(law) && !onHeld(law))
	/** An index the installation holds on a containment's source fields, which a new key leading with them serves instead. */
	const servedAnew = Arr.some(
		native,
		(law) =>
			law.kind === "key" &&
			Arr.some(
				was.laws,
				(old) =>
					old.kind === "contained" &&
					old.source.relation === law.relation &&
					samePlain(law.fields.slice(0, old.source.fields.length), old.source.fields)
			)
	)
	const removes =
		servedAnew ||
		Arr.some(was.relations, (r) => !Arr.some(now.relations, (x) => x.name === r.name)) ||
		Arr.some(was.laws, (law) => !Arr.some(now.laws, (x) => samePlain(x, law))) ||
		Arr.some(was.derived, (d) => !Arr.some(now.derived, (x) => x.name === d.name))
	/**
	 * Whether the folder creates an object under a hashed name (core/identity.ts), whose COMMENT the diff's final step
	 * writes in Publish: every added law but a declared check, which keeps its readable name (a key's unique constraint,
	 * a foreign key, a residual law's function and triggers); a held relation's new serial field's identity sequence; a
	 * new refined text's domain. A new relation's primary key is one too, and a new relation publishes regardless.
	 */
	const hashed =
		Arr.some(added, (law) => law.kind !== "check") ||
		gainsSerial(was, now) ||
		Arr.some(lawDomainsOf(now), (d) => d.kind === "text" && !fromDomains.has(domainLawKey(d)))
	const publish =
		worlds ||
		removes ||
		hashed ||
		Arr.some(now.relations, (r) => !held(r.name)) ||
		Arr.some(
			[...Arr.map(from.roles, (r) => r.name), ...Arr.map(to.roles, (r) => r.name)],
			(r) => !sameRole(roleOf(from, r), roleOf(to, r))
		) ||
		Arr.some(
			[...Arr.map(from.logins, (l) => l.name), ...Arr.map(to.logins, (l) => l.name)],
			(l) => {
				const a = loginOf(from, l)
				const b = loginOf(to, l)
				return a === undefined || b === undefined || !sameNames(a.roles, b.roles)
			}
		)
	return [
		...(labels ? ["labels" as const] : []),
		...(setup ? ["setup" as const] : []),
		...(structure ? ["structure" as const] : []),
		...(indexes ? ["indexes" as const] : []),
		...(concurrent ? ["concurrent" as const] : []),
		...(notValid.length > 0 || concurrent ? ["validate" as const] : []),
		...Arr.map(residual, () => "law" as const),
		...(publish ? ["publish" as const] : [])
	]
}

/** Whether a folder's file runs outside a transaction: new enum labels, and indexes built concurrently. */
const noTransaction = (file: FolderFile): boolean => file === "labels" || file === "concurrent"

/**
 * Where the ledger stands on a folder a run stopped in after `committed` of its files committed: unfinished once one
 * did, or when its first file runs outside a transaction, whose folder row the runner records in a transaction of its
 * own before the file's statements; untouched otherwise, nothing of it recorded.
 */
const standingAfter = (files: ReadonlyArray<FolderFile>, committed: number): LedgerStanding => {
	const [first] = files
	return committed > 0 || (first !== undefined && noTransaction(first)) ? "unfinished" : "untouched"
}

/**
 * Where the ledger stands once a run is killed inside a folder (execute/catalog.ts runEndOf): as it sends the
 * transaction holding the row of its file k, k = min(floor(n/2), n-1) of its n files, so k of them committed.
 */
const killedStanding = (from: InstallSpec, to: InstallSpec): LedgerStanding => {
	const files = folderFiles(from, to)
	return standingAfter(files, Math.min(Math.floor(files.length / 2), files.length - 1))
}

/**
 * Where the ledger stands on a folder a run stopped in at a law its data breaks: unfinished. A run stops only at a law a
 * folder adds, and the generators add only laws PostgreSQL enforces itself (nativeLaw), each over a relation that may
 * hold rows: a key's or an at-most-one capacity's unique index, built concurrently outside a transaction, or a
 * constraint validated in Validate, after
 * Structure or the concurrent indexes committed; one over a new, empty relation never breaks. A folder adding a residual
 * law, whose own file may be its first, is no folder the model places a stop in.
 */
const stoppedStanding = (from: InstallSpec, to: InstallSpec): LedgerStanding => {
	const added = Arr.filter(
		to.base.laws,
		(law) => !Arr.some(from.base.laws, (old) => samePlain(old, law))
	)
	if (Arr.some(added, (law) => !nativeLaw(to.base, law))) {
		throw new Error(
			"a run stopped in a folder that adds a residual law, which the model places no stop in"
		)
	}
	return "unfinished"
}

/**
 * Where a run's resumption of pending folders leaves the world: every folder landed, or stopped at the first whose data
 * breaks one of its laws, at that law's statement with its SQLSTATEs, the folders before it landed and it and every
 * later one still pending.
 */
type Resumed =
	| { readonly kind: "landed"; readonly reached: Reached }
	| {
			readonly kind: "stopped"
			readonly reached: Reached
			readonly sqlstates: Arr.NonEmptyReadonlyArray<SqlState>
			readonly pending: Arr.NonEmptyReadonlyArray<InstallSpec>
	  }

/** The pending folders run oldest first, from `reached`: each whose data holds lands, and the first that breaks stops. */
const resume = (reached: Reached, folders: ReadonlyArray<InstallSpec>): Resumed => {
	const [folder, ...later] = folders
	if (folder === undefined) {
		return { kind: "landed", reached }
	}
	const [first, ...rest] = brokenOnto(reached.state, folder)
	return first === undefined
		? resume({ kind: "landed", state: landedOn(reached.state, folder) }, later)
		: { kind: "stopped", reached, sqlstates: [first, ...rest], pending: [folder, ...later] }
}

/** The folders a state's migrations hold pending, oldest first: none when every folder is applied. */
const pendingFolders = (state: ModelState): ReadonlyArray<InstallSpec> =>
	state.migrations.kind === "pending" ? state.migrations.folders : []

/**
 * A migration (README "Migrations"). An installation grizzle refuses to build (refusedAtBuild) is refused as it is
 * built, before any migration is drafted. A folder already applied that a person edited is refused before any file
 * runs; the new folder is discarded, the migrations as they were. Otherwise the new folder is drafted after the
 * directory's, and the runner runs every folder the migrations hold, the pending ones first and oldest first, one
 * transaction per file, so the files of a stopped run before the stop stay committed and recorded:
 * - a pending folder whose data breaks one of its laws stops the run at that law's statement, with its SQLSTATE, the
 *   folders before it landed (landedOn), it, every later one and the new folder pending, the ledger holding it
 *   unfinished (stoppedStanding): while a folder is pending, the installation it would replace, its data and its
 *   sessions stay, and while it is unfinished every Db call and Db.open is refused;
 * - the new folder declaring a law its data breaks stops at that law's statement, with its SQLSTATE, the new folder
 *   pending and unfinished;
 * - a run whose session ends part-way through the new folder (`half-applied`, after k = min(floor(n/2), n-1) of its n
 *   files, folderFiles) is interrupted, the new folder pending, unfinished unless k is 0 and its one file runs in a
 *   transaction (killedStanding); one whose new folder breaks a law may meet that law's statement before the session
 *   ends, and the model leaves open which comes first;
 * - else the installation becomes the new one (landedOn), and the run ends by refusing drift, so a catalog tampered
 *   with beforehand is migrated and then refused, unless the folder rewrote what was tampered with.
 * A direct writer's open transaction would block the migration, which a serial run never does.
 */
export const migrateBranches = (
	state: ModelState,
	to: InstallSpec,
	how: MigrationHow
): Arr.NonEmptyReadonlyArray<Allowed> => {
	const stay = (observation: ActionOutcome): Allowed => ({ observation, next: state })
	if (refusedAtBuild(to)) {
		return [stay({ kind: "compile-refused" })]
	}
	if (how === "hand-edited") {
		return [stay({ kind: "migration-refused", stage: "edited" })]
	}
	const run = resume({ kind: "named", state }, pendingFolders(state))
	if (run.kind === "stopped") {
		return stopped(
			run.sqlstates,
			run.reached,
			pendingOn([...run.pending, to], stoppedStanding(run.reached.state.install, run.pending[0]))
		)
	}
	const from = run.reached
	const lawStopped = pendingOn([to], stoppedStanding(from.state.install, to))
	const [first, ...rest] = brokenOnto(from.state, to)
	switch (how) {
		case "half-applied":
			return [
				allowedAt(
					{ kind: "interrupted" },
					from,
					pendingOn([to], killedStanding(from.state.install, to))
				),
				...(first === undefined ? [] : stopped([first, ...rest], from, lawStopped))
			]
		case "complete": {
			if (first !== undefined) {
				return stopped([first, ...rest], from, lawStopped)
			}
			const landed = landedOn(from.state, to)
			return [
				allowedAt(
					driftOf(to, landed.tampered).length > 0
						? { kind: "migration-refused", stage: "drift" }
						: { kind: "ok" },
					{ kind: "landed", state: landed },
					asLeft
				)
			]
		}
	}
}

/**
 * `grizzle drift` (README "Migrations"): with every folder applied, the catalog's departures from the contract. With
 * folders pending it resumes them first, oldest first: stopped at a law a folder's data breaks, it is refused with that
 * SQLSTATE, the folders before it landed and the rest pending; every one applied, the last one's installation is
 * current (landedOn) and its drift is checked.
 */
export const driftBranches = (state: ModelState): Arr.NonEmptyReadonlyArray<Allowed> => {
	const run = resume({ kind: "named", state }, pendingFolders(state))
	switch (run.kind) {
		case "stopped":
			return stopped(
				run.sqlstates,
				run.reached,
				pendingOn(run.pending, stoppedStanding(run.reached.state.install, run.pending[0]))
			)
		case "landed":
			return [
				allowedAt(
					{
						kind: "drift",
						objects: driftOf(run.reached.state.install, run.reached.state.tampered)
					},
					run.reached,
					asLeft
				)
			]
	}
}
