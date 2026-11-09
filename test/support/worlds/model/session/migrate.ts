import { Array as Arr, Option, Record as Rec } from "effect"
import { violations } from "#test/support/laws/model.ts"
import { evaluateRules, hostSchemaOf, judgedSchemaOf } from "#test/support/worlds/model/host.ts"
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
	draftedFrom,
	factsIn,
	loginOf,
	loginsCreatedOn,
	roleOf,
	samePlain
} from "#test/support/worlds/model/session/state.ts"
import { installedRoles, refusedAtBuild } from "#test/support/worlds/model/session/writes.ts"
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

/**
 * The handles a migration to `to` leaves a stored fact holding that no roster of `to` holds live: each a removed
 * handle's code, which the re-pointed roster domain's VALIDATE refuses, naming the table and the column (23514).
 */
const removedHandlesHeld = (reality: HostState, to: BaseSpec): boolean =>
	Arr.some(to.relations, (r) =>
		Arr.some(r.fields, (f) => {
			const domain = f.domain
			if (domain.kind !== "handle") {
				return false
			}
			const live = Option.match(
				Arr.findFirst(to.closed, (c) => c.name === domain.closed),
				{ onNone: (): ReadonlyArray<string> => [], onSome: (c) => c.members }
			)
			return Arr.some(factsIn(reality, r.name), (fact) => {
				const value = fact[f.name]
				return typeof value === "string" && !live.includes(value)
			})
		})
	)

/**
 * The first roster `to` declares out of its codes' order against `from` (D1): a handle `from` holds live keeps its
 * code, which orders it as `from` does, and every other one takes a code past every one minted, in declared order, so
 * a declaration that puts a kept handle after a new one, or two kept handles out of `from`'s order, is refused before
 * anything is drafted ("append new handles; a roster's order is its codes' order").
 */
export const reorderedRoster = (from: BaseSpec, to: BaseSpec): string | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(to.closed, (c) => {
			const before = Option.match(
				Arr.findFirst(from.closed, (x) => x.name === c.name),
				{ onNone: (): ReadonlyArray<string> => [], onSome: (x) => x.members }
			)
			const codes = Arr.map(c.members, (m, i) => {
				const kept = before.indexOf(m)
				return kept >= 0 ? kept : before.length + i
			})
			return Arr.some(codes, (code, i) => i > 0 && code < (codes[i - 1] ?? code))
				? Option.some(c.name)
				: Option.none()
		})
	)

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
		...new Set([
			...Arr.flatMap(host.laws, (law): ReadonlyArray<SqlState> =>
				violations({ relations: host.relations, laws: [law] }, reality).length > 0
					? [meetingOf(host, law).sqlstate]
					: []
			),
			...(removedHandlesHeld(reality, to.base) ? ["23514" as const] : [])
		])
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
		roles: installedRoles(to),
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
 * one file for each run of slots that holds a statement, in this order: Setup, the new constants and domains (a changed
 * roster's new names constant among them); Structure, a changed roster domain's CHECK re-pointed NOT VALID, the world objects of the roles the installation holds that change or go and
 * every new world function, new tables and columns, and constraints NOT VALID; the indexes of new relations; the
 * concurrent indexes of relations that may hold rows; Validate, the constraints validated (a re-pointed roster domain's
 * CHECK among them) and the concurrent indexes attached; Publish, the roles, logins, memberships and grants, the new
 * roles' world objects, what the target no longer has (an index a new key serves instead, a roster's old constant,
 * dropped RESTRICT, among it), and last the COMMENT of every object the folder creates under a hashed name.
 */
export type FolderFile = "setup" | "structure" | "indexes" | "concurrent" | "validate" | "publish"

/**
 * The relations the native objects of a law are built on, each by a statement of its own that fails over data breaking
 * it: a key's or a span key's, a check's, a containment's or a coverage's source; none for a containment into a closed
 * roster, which its field's type enforces; and for alternatives, the source of each of its containments (fin.md §7),
 * the parent and every arm. Every law is native.
 */
const builtOn = (base: BaseSpec, law: LawSpec): ReadonlyArray<string> => {
	switch (law.kind) {
		case "key":
		case "spanKey":
		case "check":
			return [law.relation]
		case "contained":
			return Arr.some(base.closed, (c) => c.name === law.target.relation)
				? []
				: [law.source.relation]
		case "covered":
			return [law.source.relation]
		case "alternatives":
			return [law.relation, ...Arr.dedupe(Rec.values(law.arms))]
	}
}

/** Whether a native law is built as a unique index: a key's or a span key's. */
const uniqueIndexed = (law: LawSpec): boolean => law.kind === "key" || law.kind === "spanKey"

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
	const native = added
	const onHeld = (law: LawSpec): boolean => Arr.some(builtOn(now, law), held)
	const notValid = Arr.filter(native, (law) => !uniqueIndexed(law) && onHeld(law))
	const concurrent = Arr.some(native, (law) => uniqueIndexed(law) && onHeld(law))
	/** A roster both bases hold whose handles differ: a new names constant in Setup, its domain's CHECK re-pointed in
	 * Structure and VALIDATEd in Validate, the old constant dropped and the new one's COMMENT in Publish. */
	const rosterChanged = Arr.some(now.closed, (c) => {
		const before = Option.getOrUndefined(Arr.findFirst(was.closed, (x) => x.name === c.name))
		return before !== undefined && !samePlain(before.members, c.members)
	})
	const setup =
		rosterChanged ||
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
	const structure = worlds || gains || notValid.length > 0 || rosterChanged
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
	 * a foreign key); a held relation's new serial field's identity sequence; a
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
		rosterChanged ||
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
		...(setup ? ["setup" as const] : []),
		...(structure ? ["structure" as const] : []),
		...(indexes ? ["indexes" as const] : []),
		...(concurrent ? ["concurrent" as const] : []),
		...(notValid.length > 0 || concurrent || rosterChanged ? ["validate" as const] : []),
		...(publish ? ["publish" as const] : [])
	]
}

/** Whether a folder's file runs outside a transaction: indexes built concurrently. */
const noTransaction = (file: FolderFile): boolean => file === "concurrent"

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
 * folder adds, or a roster domain's CHECK it re-points, and every one is a statement PostgreSQL runs itself (fin.md
 * §7), each over a relation that may hold rows: a key's unique index, built concurrently outside a transaction, or a
 * constraint validated in Validate, after Structure or the concurrent indexes committed; one over a new, empty
 * relation never breaks.
 */
const stoppedStanding = (): LedgerStanding => "unfinished"

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
 * A migration (README "Migrations"). An installation grizzle refuses to build (refusedAtBuild), or one that declares a
 * roster out of its codes' order against the installation its folder is drafted from (reorderedRoster), is refused as
 * it is built, before any migration is drafted. A folder already applied that a person edited is refused before any file
 * runs; the new folder is discarded, the migrations as they were. Otherwise the new folder is drafted after the
 * directory's, and the runner runs every folder the migrations hold, the pending ones first and oldest first, one
 * transaction per file, so the files of a stopped run before the stop stay committed and recorded:
 * - a pending folder whose data breaks one of its laws, or holds a handle it removes from a roster (the re-pointed
 *   domain's VALIDATE, 23514), stops the run at that statement, with its SQLSTATE, the
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
	if (refusedAtBuild(to) || reorderedRoster(draftedFrom(state).base, to.base) !== undefined) {
		return [stay({ kind: "compile-refused" })]
	}
	if (how === "hand-edited") {
		return [stay({ kind: "migration-refused", stage: "edited" })]
	}
	const run = resume({ kind: "named", state }, pendingFolders(state))
	if (run.kind === "stopped") {
		return stopped(run.sqlstates, run.reached, pendingOn([...run.pending, to], stoppedStanding()))
	}
	const from = run.reached
	const lawStopped = pendingOn([to], stoppedStanding())
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
			return stopped(run.sqlstates, run.reached, pendingOn(run.pending, stoppedStanding()))
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
