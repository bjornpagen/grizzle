import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { contract, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { clocked, deferrable, paged, workload } from "#compiler/public/workload.ts"

/**
 * The decoder agreement's box (test/types/api/decoder.ts): one login over Shelf for each kind of member the decision of
 * a login's live reads (adapter/types/layer.ts ReadsOf) reads, each login of its own role, which writes Item:
 *
 * - none: no workload (Bare), a ChangeSet alone (Writes), two workloads of ChangeSets alone (WritesTwice), and a clocked
 *   read alone (Clocked), answered at its call's instant and never watched;
 * - one: a query (Reads), a paged ordered query (Pages), a relation's key (Keys), a deferrable(...) read (Defers), and a
 *   workload of a ChangeSet beside one of a query (Mixed).
 */

/**
 * A clocked read's instant: a checked contract over bigint, milliseconds, never negative, whose domain the clocked
 * read's statement casts the clock's reading to; a field of Due types by it, so Shelf installs that domain.
 */
const Instant = contract("Instant", pg.bigint, (m) => m.ge(0n))

const Item = relation("Item", { id: uuid }, ["id"])
const Due = relation("Due", { id: uuid, at: Instant }, ["id"])
const Shelf = schema("Shelf", [Item, Due], [])

/** The login `name`'s role: every relation of Shelf whole, writing Item. */
const clerk = (name: string) =>
	role(Shelf, `${name}Clerk`, wholeEntriesOf(Shelf), { write: ["Item"] })

const items = query(Shelf).rule((r) => {
	const { id } = v(Item, "item")
	return r.match(Item, { id }).find({ id })
})

const addItem = ChangeSet.empty(Shelf).insert(Item, [])

const BareClerk = clerk("bare")
export const Bare = login(Shelf, "bare", [BareClerk])

const WritesClerk = clerk("writes")
export const Writes = login(Shelf, "writes", [WritesClerk], {
	workload: [workload(Shelf, { addItem })]
})

const WritesTwiceClerk = clerk("writesTwice")
export const WritesTwice = login(Shelf, "writesTwice", [WritesTwiceClerk], {
	workload: [workload(Shelf, { addItem }), workload(Shelf, { addAgain: addItem })]
})

const ClockedClerk = clerk("clocked")
export const Clocked = login(Shelf, "clocked", [ClockedClerk], {
	workload: [
		workload(Shelf, {
			due: clocked(
				query(Shelf).rule((r) => {
					const { id } = v(Item, "item")
					return r
						.match(Item, { id })
						.where(r.ge(r.param("now", Instant), Compute.literal(Instant, 0n)))
						.find({ id })
				}),
				{ now: "millis" }
			)
		})
	]
})

const ReadsClerk = clerk("reads")
export const Reads = login(Shelf, "reads", [ReadsClerk], { workload: [workload(Shelf, { items })] })

const PagesClerk = clerk("pages")
export const Pages = login(Shelf, "pages", [PagesClerk], {
	workload: [workload(Shelf, { page: paged(items.orderBy(["id", "asc"])) })]
})

const KeysClerk = clerk("keys")
export const Keys = login(Shelf, "keys", [KeysClerk], {
	workload: [workload(Shelf, { item: Item })]
})

const DefersClerk = clerk("defers")
export const Defers = login(Shelf, "defers", [DefersClerk], {
	workload: [workload(Shelf, { later: deferrable(items) })]
})

const MixedClerk = clerk("mixed")
export const Mixed = login(Shelf, "mixed", [MixedClerk], {
	workload: [workload(Shelf, { addItem }), workload(Shelf, { items })]
})
