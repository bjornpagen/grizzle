/** What the properties of rules.test.ts read: its focus, its requirements and its leads. */
import type { Situations } from "@bjornpagen/testing/features"
import { constant, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { dbSession, type Focus, type Lead } from "#test/support/worlds/drive/suite.ts"
import { installGen } from "#test/support/worlds/generate/install.ts"
import { roomsBase, roomsInstall } from "#test/support/worlds/model/bases/rooms.ts"
import type { InstallSpec, WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Every law family docs/schema.md "Rules" lists meets a write through a world, over the rooms base (model/bases/rooms.ts): a
 * primary and a candidate key, a no-overlap key, a row check, a contract's domain CHECK, a containment, a selected one
 * between the talks and the events of kind Talk, and a coverage, each refusing a Db's ChangeSet through a query entry
 * of a partial role (the booker's own bookings, events and talks, the keeper's rooms, big rooms' openings and talk
 * rooms), and through whole entries; and every write through an entry over a mutable relation keyed WITHOUT OVERLAPS
 * and over a pure set, mutable and immutable, inserts, deletes and puts what the worlds model says. The model judges
 * each outcome: the refusal's law, its witness (the keys the writer submitted, and those of relations its role holds
 * whole, at most: a key's, a row check's and a domain's at a stated fact the host judges, none of a containment's or a
 * coverage's), and the state every accepted write leaves, read back as the owner. Reads walk a world's span fields, and
 * chain which rooms adjoin which by a recursive query. Beside the model, a shown witness carries only what the writer
 * submitted or holds whole (drive/acting.ts witnessesShowTheirOwn).
 */
export const focus: Focus = [
	"open-db",
	"apply",
	"read",
	"close",
	"direct-begin",
	"direct",
	"direct-end"
]

/**
 * The installations the suite writes under: the rooms base's README-shaped worlds three times in four, whose partial
 * roles write every relation but Adjoins through a query entry, and otherwise a generated installation of the base.
 */
export const installs: Gen<InstallSpec> = weighted([
	[3, constant(roomsInstall)],
	[1, installGen(roomsBase)]
])

/**
 * What the population must reach: each law family refusing a write through a query entry, its witness as the README
 * allows it (a key's, a row check's and a domain's a stated fact's key, every other law's withheld); a key and a
 * no-overlap key refusing a write through whole entries too; an accepted insert, delete and put through a query entry
 * over a mutable relation keyed WITHOUT OVERLAPS, over a mutable pure set and over an immutable one, and a put through
 * a whole entry over a mutable one keyed WITHOUT OVERLAPS; and a span read through a world.
 */
export const required: Situations<WorldFeature> = [
	"law:key:entry:shown",
	"law:span-key:entry:shown",
	"law:check:entry:shown",
	"law:domain:entry:shown",
	"law:contained:entry:withheld",
	"law:covered:entry:withheld",
	"law:key:whole:shown",
	"law:span-key:whole:shown",
	"write:span-key:mutable:entry:insert",
	"write:span-key:mutable:entry:delete",
	"write:span-key:mutable:entry:put",
	"write:span-key:mutable:whole:put",
	"write:pure-set:mutable:entry:insert",
	"write:pure-set:mutable:entry:delete",
	"write:pure-set:mutable:entry:put",
	"write:pure-set:immutable:entry:insert",
	"read:span"
]

/**
 * A lead aiming a Db's applies at a domain's CHECK refusing a write through a query entry: a value its contract or
 * pattern refuses is a wild input, which dbSession's live-only applies never draw, so this lead's applies draw only the
 * wild strata, each still aimed at the feature while it is pending.
 */
export const domainRefusing: Lead = (weights, install, at) =>
	Arr.map(dbSession(["law:domain:entry:shown"])(weights, install, at), (w) =>
		w.actions.apply > 0 ? { ...w, validity: { live: 0, stale: 0, wild: 1 } } : w
	)
