import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic, Type } from "#compiler/public/compute.ts"
import { contract, mintOf, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { answered, clocked, paged, workload } from "#compiler/public/workload.ts"
import { Id } from "#test/support/ids.ts"

/**
 * The decoder agreement's box (test/types/api/decoder.ts): one login over Shelf for each kind of member the decision of
 * a login's live reads (adapter/types/layer.ts ReadsOf) reads, each login of its own role, which writes Item:
 *
 * - none: no workload (Bare), a ChangeSet alone (Writes), two workloads of ChangeSets alone (WritesTwice), a clocked
 *   read alone (Clocked), answered at its call's instant and never watched, and answered(...) reads beside a ChangeSet,
 *   as an operations login serving a serverless route declares them: a query (Answered), a paged ordered query
 *   (AnsweredPages) and a relation's key (AnsweredKeys);
 * - one: a query (Reads), a paged ordered query (Pages), a relation's key (Keys), a
 *   workload of a ChangeSet beside one of a query (Mixed), and an answered query beside a live one (AnsweredBeside).
 */

const instantKey = Symbol("Instant")
/**
 * A clocked read's instant: a checked contract over bigint, milliseconds, never negative, whose domain the clocked
 * read's statement casts the clock's reading to; a field of Due types by it, so Shelf installs that domain.
 */
const Instant = contract<typeof instantKey>()("Instant", pg.bigint, (m) => Logic.ge(m, 0n))
const toInstant = mintOf(instantKey)

const Item = relation("Item", { id: Id }, ["id"])
const Due = relation("Due", { id: Id, at: Instant }, ["id"])
const Shelf = schema("Shelf", [Item, Due], [])

/** The login `name`'s role: every relation of Shelf whole, writing Item. */
const clerk = (name: string) =>
	role(Shelf, `${name}Clerk`, wholeEntriesOf(Shelf), { insert: ["Item"] })

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
						.where(r.ge(r.param("now", Instant), Type.literal(Instant, toInstant(0n))))
						.find({ id })
				}),
				{ now: "millis" },
				{ now: instantKey }
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

const MixedClerk = clerk("mixed")
export const Mixed = login(Shelf, "mixed", [MixedClerk], {
	workload: [workload(Shelf, { addItem }), workload(Shelf, { items })]
})

const AnsweredClerk = clerk("answered")
export const Answered = login(Shelf, "answered", [AnsweredClerk], {
	workload: [workload(Shelf, { addItem, items: answered(items) })]
})

const AnsweredPagesClerk = clerk("answeredPages")
export const AnsweredPages = login(Shelf, "answeredPages", [AnsweredPagesClerk], {
	workload: [workload(Shelf, { addItem, page: answered(paged(items.orderBy(["id", "asc"]))) })]
})

const AnsweredKeysClerk = clerk("answeredKeys")
export const AnsweredKeys = login(Shelf, "answeredKeys", [AnsweredKeysClerk], {
	workload: [workload(Shelf, { addItem, item: answered(Item) })]
})

const AnsweredBesideClerk = clerk("answeredBeside")
export const AnsweredBeside = login(Shelf, "answeredBeside", [AnsweredBesideClerk], {
	workload: [workload(Shelf, { once: answered(items) }), workload(Shelf, { items })]
})
