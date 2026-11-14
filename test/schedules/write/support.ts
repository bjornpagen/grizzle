import { boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { Array as Arr, type Context, Effect, Option, Record as Rec, type Scope } from "effect"
import { openServed } from "#adapter/db/served.ts"
import { fromEngine } from "#adapter/engine.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import { type ServedRefusal, servedEntryOf, snapshotCompiled } from "#adapter/served/compile.ts"
import { type LoadedChange, type LoadedMember, loadServed } from "#adapter/served/load.ts"
import { builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import type { DbLayerOf } from "#adapter/types/layer.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { ownBuilt, trustedJson } from "#compiler/plan/common.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, span } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	key,
	login,
	mutable,
	on,
	race,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { servedFile } from "#compiler/served/json.ts"
import type { DeltaSource } from "#compiler/types/changeset/changeset.ts"
import type { ChangeSetValue } from "#compiler/write/changeset/value.ts"
import type { PutChoice } from "#compiler/write/put/choose.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import { openRig, type Rig } from "#test/support/schedules/rig.ts"
import { snapshotValue } from "#test/support/snapshot-json.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { Substrate } from "#test/support/substrate/substrate.ts"

const label = str.regex("^[a-z]{0,8}$")

/** A key of an integer key field, from 1 to 999. */
export const keyGen: Gen<number> = int(1, 999)

/** Two keys, distinct by construction: a key and a positive step past it, in either order. */
export const twoKeys: Gen<readonly [number, number]> = (source) => {
	const low = source.draw(int(1, 499))
	const step = source.draw(int(1, 500))
	return source.draw(boolean) ? [low + step, low] : [low, low + step]
}

type Three = readonly [number, number, number]

/** The six orders of three keys. */
const orders: Arr.NonEmptyReadonlyArray<(keys: Three) => Three> = [
	([x, y, z]) => [x, y, z],
	([x, y, z]) => [x, z, y],
	([x, y, z]) => [y, x, z],
	([x, y, z]) => [y, z, x],
	([x, y, z]) => [z, x, y],
	([x, y, z]) => [z, y, x]
]

/** Three keys, distinct by construction: a key and two positive steps past it, in any order. */
export const threeKeys: Gen<Three> = (source) => {
	const low = source.draw(int(1, 333))
	const first = source.draw(int(1, 333))
	const second = source.draw(int(1, 333))
	return source.draw(element(orders))([low, low + first, low + first + second])
}

export const Item = relation("Item", { id: pg.integer, label }, ["id"])
export const Note = relation("Note", { id: pg.integer, label }, ["id"])
export const Code = relation("Code", { id: pg.integer, code: pg.integer }, ["id"])
export const Ticket = relation("Ticket", { no: pg.bigserial, label }, ["no"])
export const Room = relation("Room", { room: pg.integer, during: span(pg.bigint), label }, [
	"room",
	"during"
])
export const Ref = relation("Ref", { id: pg.integer, item: pg.integer }, ["id"])
export const Zed = relation("Zed", { id: pg.integer }, ["id"])
export const Badge = relation("Badge", { id: pg.integer, code: pg.integer }, ["id"])
export const Gate = relation("Gate", { id: pg.integer }, ["id"])
export const Claim = relation("Claim", { id: pg.integer, holder: pg.integer }, ["id"])
export const Seat = relation("Seat", { id: pg.integer, holder: pg.integer }, ["id"])

/** Code's and Ticket's candidate keys, and Ref's foreign key into Item: the laws a race names by these declarations. */
export const codeKey = key(on(Code, "code"))
export const ticketLabel = key(on(Ticket, "label"))
export const refItem = contained(on(Ref, "item"), on(Item, "id"))
/** Badge's candidate key: the unique object beside its arbiter that two certified READ COMMITTED inserts race at. */
export const badgeCode = key(on(Badge, "code"))

const shared = { Item, Note, Code, Ticket, Room, Ref, Zed } as const
const relations = { ...shared, Badge, Gate, Claim, Seat } as const
const written = ["Item", "Note", "Code", "Ticket", "Room", "Ref", "Zed"] as const
const statements = [
	mutable(Note),
	mutable(Code),
	mutable(Room),
	mutable(Zed),
	codeKey,
	ticketLabel,
	refItem,
	badgeCode,
	race(Claim),
	race(Seat)
] as const

/**
 * The role `inserter`'s one change: Badge's facts its call states, then Gate's, each an array member the call supplies.
 * A call that states a Gate fact inserts it last, so an owner holding Gate in SHARE mode holds the call there with its
 * Badge rows written and uncommitted; a call that states none skips that statement.
 */
const addBadges = (inserter: Inserter) =>
	ChangeSet.sequence(
		ChangeSet.empty(inserter).insert(Badge, []),
		ChangeSet.empty(inserter).insert(Gate, [])
	)

/** The role `inserter` of the schedule schema `base`: Badge and Gate whole, inserting only. */
const inserterOf = (base: ReturnType<typeof schedSchema>) =>
	role(base, "inserter", { Badge, Gate }, { insert: ["Badge", "Gate"] })
type Inserter = ReturnType<typeof inserterOf>

/** The role `claimer` of the schedule schema `base`: Claim, Seat and Gate whole, inserting only. */
const claimerOf = (base: ReturnType<typeof schedSchema>) =>
	role(base, "claimer", { Claim, Seat, Gate }, { insert: ["Claim", "Seat", "Gate"] })
type Claimer = ReturnType<typeof claimerOf>

/** A delta side of Claim, read back whole. */
const claimRows = (claimer: Claimer, side: DeltaSource<typeof Claim>) =>
	query(claimer).rule((r) => {
		const { id, holder } = v(side, "row")
		return r.match(side, { id, holder }).find({ id, holder })
	})

/** A delta side of Seat, read back whole. */
const seatRows = (claimer: Claimer, side: DeltaSource<typeof Seat>) =>
	query(claimer).rule((r) => {
		const { id, holder } = v(side, "row")
		return r.match(side, { id, holder }).find({ id, holder })
	})

/**
 * The role `claimer`'s one change: the Claim facts its call states, raced, then the Seat facts, raced, each in a
 * statement of its own with what it added and what it met read back, then Gate's facts, the blocker, as `inserter`'s.
 */
const claimSeat = (claimer: Claimer) =>
	ChangeSet.sequence(
		ChangeSet.sequence(
			ChangeSet.empty(claimer)
				.insert(Claim, [])
				.read("claimAdded", (d) => claimRows(claimer, d.added(Claim)))
				.read("claimMet", (d) => claimRows(claimer, d.met(Claim))),
			ChangeSet.empty(claimer)
				.insert(Seat, [])
				.read("seatAdded", (d) => seatRows(claimer, d.added(Seat)))
				.read("seatMet", (d) => seatRows(claimer, d.met(Seat)))
		),
		ChangeSet.empty(claimer).insert(Gate, [])
	)

/** The schedule schema under `name`, over the relations and laws above. */
const schedSchema = (name: string) => schema(name, Rec.values(relations), statements)

/**
 * Shared setup for the grizzle write schedules.
 *
 * A small schema installs under a fresh schema name as generate drafts and serves it (openRig), with two full roles over
 * its first seven relations, each writing every one of them: `app`, which the grizzle writers open through Db.open and
 * a DbLayer of the served login `server` exactly as an application does (the rig's `servedWriter`), its workload's
 * `noop`, the empty ChangeSet, a writer's first call, and `direct`, which raw pinned sessions take on through the login
 * `psql` to play the concurrent direct SQL writer. Both are certified SERIALIZABLE, and every table they write keeps its
 * guard. A third role of `server`, `inserter`, holds only Badge and Gate and inserts only (`insert`), its one change
 * `addBadges`; a fourth, `claimer`, holds only Claim, Seat and Gate and inserts only, its one change `claimSeat`; no
 * other role writes any of them, so generate certifies both READ COMMITTED and none of those tables keeps a guard.
 * Every table, column and law a schedule names comes from the installation (`names`).
 *
 * The relations, each the shape of a put target or a transient reason:
 * - Item: immutable (the pinned default), keyed by id: the insert protocol, and a put's DELETE-then-insert pair;
 * - Note: `mutable`, keyed by id: a put in place, ON CONFLICT DO UPDATE, UPDATE ... FROM or MERGE by its member;
 * - Code: `mutable`, keyed by id, with the candidate key code: a unique object beside the arbiter (UnseenOccupant), and
 *   a put that stays the pair for its candidate key;
 * - Ticket: a bigserial key, for generated and explicit serial values (GeneratedSerialUnique), with the candidate key
 *   label: a unique object a generated addition, which has no arbiter, is probed at (UnseenOccupant);
 * - Room: `mutable`, a span key (room, during): WITHOUT OVERLAPS (SpanKeyChange), a put that stays the pair;
 * - Ref: an immutable relation whose foreign key into Item is deferred (Item holds a payload, so it is no pure set): a
 *   law at COMMIT beside the writes;
 * - Zed: a `mutable` pure set, the blocker: an apply whose later stratum inserts a Zed fact a direct writer holds waits
 *   there, holding everything its earlier statements did, so a race can act between two statements of one grizzle
 *   transaction; and a put of it is the pair for a pure set;
 * - Badge: immutable, keyed by id, with the candidate key code (badgeCode): what two `inserter` calls race at;
 * - Gate: immutable, keyed by id, the `inserter`'s and the `claimer`'s blocker: the owner's SHARE lock on it holds a call
 *   that inserts a Gate fact after its other rows, while writing nothing itself, so each role stays certified;
 * - Claim and Seat: immutable, keyed by id, each raced (race): what two `claimer` calls race at, each in a statement of
 *   its own, so a call can win one and meet the other.
 *
 * The schedule schema under the name its installation gives it, over the same relation values, with its worlds.
 */
const renamedSched = (name: string) => {
	const base = schedSchema(name)
	const app = role(base, "app", shared, { write: written })
	const direct = role(base, "direct", shared, { write: written })
	const inserter = inserterOf(base)
	const claimer = claimerOf(base)
	return {
		schema: base,
		app,
		direct,
		inserter,
		claimer,
		server: login(base, "server", [app, inserter, claimer], {
			workload: [
				workload(app, { noop: ChangeSet.empty(app) }),
				workload(inserter, { addBadges: addBadges(inserter) }),
				workload(claimer, { claimSeat: claimSeat(claimer) })
			]
		}),
		psql: login(base, "psql", [direct])
	}
}
type SchedWorlds = ReturnType<typeof renamedSched>

export interface Opened {
	readonly rig: Rig<SchedWorlds>
	/** The installation's names of the relations and laws above. */
	readonly names: Names
}

export const open: Effect.Effect<
	Opened,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> = Effect.gen(function* () {
	const rig = yield* openRig(renamedSched)
	return { rig, names: namesOf(rig.installed) }
})

/** The rig's served writer `open`: the role `app`'s Db over the writer's DbLayer of the served login. */
export const openApp =
	(rig: Rig<SchedWorlds>) => (context: Context.Context<DbLayerOf<SchedWorlds["server"]>>) =>
		openServed(rig.served.roles.app, {}).pipe(Effect.provideContext(context))

/** The rig's served writer `open`: the role `inserter`'s Db over the writer's DbLayer of the served login. */
export const openInserter =
	(rig: Rig<SchedWorlds>) => (context: Context.Context<DbLayerOf<SchedWorlds["server"]>>) =>
		openServed(rig.served.roles.inserter, {}).pipe(Effect.provideContext(context))

/** The rig's served writer `open`: the role `claimer`'s Db over the writer's DbLayer of the served login. */
export const openClaimer =
	(rig: Rig<SchedWorlds>) => (context: Context.Context<DbLayerOf<SchedWorlds["server"]>>) =>
		openServed(rig.served.roles.claimer, {}).pipe(Effect.provideContext(context))

/** A role of the login `server` that runs ChangeSets. */
export type Writing = "app" | "inserter" | "claimer"

/** A ChangeSet as a role of `server` serves it: its member, whose operations a writer runs, and its loaded change. */
export interface RoleChange {
	readonly member: LoadedMember
	readonly change: LoadedChange
}

/**
 * ChangeSets of a race as a role serves them: each one by its name (`RoleChange`), and the put choices its compile made
 * for it (write/put/choose.ts PutChoice).
 */
export interface ServedChanges {
	readonly changes: ReadonlyMap<string, RoleChange>
	readonly choices: ReadonlyMap<string, ReadonlyArray<PutChoice>>
}

/** The one of `roles` that is the role `name`, by `nameOf`. */
const roleNamed = <T>(roles: ReadonlyArray<T>, nameOf: (role: T) => string, name: Writing): T =>
	defined(
		Option.getOrUndefined(Arr.findFirst(roles, (r) => nameOf(r) === name)),
		`the role ${name} of the served login`
	)

/** Each change member of `members` with its loaded change, by the member's name. */
const changesOf = (members: ReadonlyArray<LoadedMember>): ReadonlyMap<string, RoleChange> =>
	new Map(
		Arr.flatMap(members, (member) =>
			member.kind === "change" && member.variants.kind === "change"
				? [[member.name, { member, change: member.variants.change }] as const]
				: []
		)
	)

/**
 * `programs` compiled into members of `role`'s workload of the login `server` under the snapshot the installation
 * reached, as an application's test compiles them (adapter/served/compile.ts snapshotCompiled), which projects every
 * role's writes at SERIALIZABLE, since no certificate covers programs outside the committed workload, and loaded as a
 * layer loads its file: each ChangeSet's loaded change, which a writer runs over its served Db's context, and its put
 * choices, read from the compile that made the file. A ChangeSet the compile refuses is its ServedRefusal.
 */
export const servedChanges = (
	o: Opened,
	role: Writing,
	programs: Readonly<Record<string, ChangeSetValue>>
): Effect.Effect<ServedChanges, ServedRefusal | CompileError | OpenError> =>
	Effect.gen(function* () {
		const built = defined(builtLogin(o.rig.worlds.server), "the login server, built by login(...)")
		const base = yield* fromEngine(ownBuilt(built.base))
		const owned = yield* fromEngine(ownLoginOver(built, base))
		const compiled = yield* snapshotCompiled(
			{ login: { ...built, workload: [workload(o.rig.worlds[role], programs)] }, owned },
			snapshotValue(o.rig.installed.snapshot, o.rig.installed.installation)
		)
		const entry = yield* servedEntryOf(compiled)
		const loaded = yield* Effect.fromResult(
			loadServed(
				succeeded(servedFile(trustedJson<unknown>(entry.text)), "the served file"),
				entry.login
			)
		)
		return {
			changes: changesOf(roleNamed(loaded.roles, (r) => r.name, role).members),
			choices: new Map(
				Arr.flatMap(roleNamed(compiled.roles, (r) => r.role.name, role).workload, (form) =>
					form.kind === "change" && form.variants.kind === "form"
						? [[form.name, form.variants.form.entry.compiled.choices] as const]
						: []
				)
			)
		}
	})

/**
 * `role`'s changes as the rig's served file holds them, projected by generate at the level it certified the role, and
 * that level: what every writer of the role runs, and the level each of its calls begins at.
 */
export const committedChanges = (
	o: Opened,
	role: Writing
): Effect.Effect<
	{ readonly isolation: Isolation; readonly changes: ReadonlyMap<string, RoleChange> },
	OpenError
> =>
	Effect.map(Effect.fromResult(loadServed(o.rig.served.file, o.rig.served.name)), (loaded) => {
		const served = roleNamed(loaded.roles, (r) => r.name, role)
		return { isolation: served.isolation, changes: changesOf(served.members) }
	})
