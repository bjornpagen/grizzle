import { boolean, element, type Gen, int } from "@grizzle/testing/gen"
import { type Array as Arr, type Context, Effect, type Scope } from "effect"
import { type OpenedDb, openDbContext } from "#adapter/db/open.ts"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { DbLayerOf } from "#adapter/types/layer.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { pg, span } from "#compiler/public/fields.ts"
import {
	contained,
	key,
	login,
	mutable,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import { openRig, type Rig } from "#test/support/schedules/rig.ts"
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

/** Code's and Ticket's candidate keys, and Ref's foreign key into Item: the laws a race names by these declarations. */
export const codeKey = key(on(Code, "code"))
export const ticketLabel = key(on(Ticket, "label"))
export const refItem = contained(on(Ref, "item"), on(Item, "id"))

const relations = { Item, Note, Code, Ticket, Room, Ref, Zed } as const
const written = ["Item", "Note", "Code", "Ticket", "Room", "Ref", "Zed"] as const
const statements = [
	mutable(Note),
	mutable(Code),
	mutable(Room),
	mutable(Zed),
	codeKey,
	ticketLabel,
	refItem
] as const

/**
 * Shared setup for the grizzle write schedules.
 *
 * A small schema installs under a fresh schema name with two full roles, each writing every relation: `app`, which the
 * grizzle writers open through Db.open and a DbLayer of the login `server` exactly as an application does (the rig's
 * `writer`), and `direct`, which raw pinned sessions take on through the login `psql` to play the concurrent direct SQL
 * writer. Every table, column and law a schedule names comes from the installation (`names`).
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
 *   transaction; and a put of it is the pair for a pure set.
 *
 * The schedule schema under the name its installation gives it, over the same relation values, with its worlds.
 */
const renamedSched = (name: string) => {
	const base = schema(name, relations, statements)
	const app = role(base, "app", relations, { write: written })
	const direct = role(base, "direct", relations, { write: written })
	return {
		schema: base,
		app,
		direct,
		server: login(base, "server", [app]),
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
	const rig = yield* openRig("Sched", renamedSched)
	return { rig, names: namesOf(rig.installed) }
})

/** The rig's writer `open`: the role `app`'s Db over the writer's DbLayer. */
export const openApp =
	(rig: Rig<SchedWorlds>) =>
	(
		context: Context.Context<DbLayerOf<SchedWorlds["server"]>>
	): Effect.Effect<OpenedDb<SchedWorlds["app"], unknown>, OpenError> =>
		openDbContext(rig.worlds.server.roles.app, {}).pipe(Effect.provideContext(context))
