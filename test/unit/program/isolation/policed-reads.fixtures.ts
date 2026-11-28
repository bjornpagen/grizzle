/** What policed-reads.test.ts reads: its drawn logins, compiled for READ COMMITTED as generate compiles them. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { artifactsOver, builtLogin, ownLoginOver } from "#adapter/served/login.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { transactionClock } from "#compiler/ir/clock.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { namedLogin } from "#compiler/physical/ddl/names.ts"
import { installBasis, unserved } from "#compiler/physical/install/plan.ts"
import { planWorkload } from "#compiler/program/workload/compile.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { natural } from "#compiler/public/fields.ts"
import { param, query, v } from "#compiler/public/query.ts"
import {
	contained,
	context,
	login,
	mutable,
	on,
	relation,
	role,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { succeeded } from "#test/support/assert.ts"

/**
 * What the writer's entry over T holds: T's rows while the session's user holds the program `act`, a filter reading
 * Account and Grant (`others`, its policy a filter function's call); T's rows while the session's claim stands, a
 * filter reading no relation (`session`, its policy the membership itself); every row of T (`none`, no policy); or
 * every row of T in the writer's world (`scoped`, no policy), its scope binding T's unit at the numbers Holder gives the
 * session's user, so the entry's view reads T at its scope owner's keys, reading Holder (docs/access.md "The scope of a
 * role": every query entry's view is the world's).
 */
export type Filter = "others" | "session" | "none" | "scoped"

/**
 * How the writer writes through its entry: T by an insert, a put, or a delete by its key; or Item by an insert of the
 * numbers the entry's view holds (`copy`), a statement that reads the view, its definition where it stands.
 */
export type Write = "insert" | "put" | "delete" | "copy"

/** A case: the entry's filter and the write through it. */
export interface Drawn {
	readonly filter: Filter
	readonly write: Write
}

const filters = ["others", "session", "none", "scoped"] as const satisfies ReadonlyArray<Filter>

const writes = ["insert", "put", "delete", "copy"] as const satisfies ReadonlyArray<Write>

export const drawnGen: Gen<Drawn> = (source) => ({
	filter: source.draw(element(filters)),
	write: source.draw(element(writes))
})

/** The relations each filter reads besides T's row, the ones its policy and its filter function read. */
export const filterReads: { readonly [F in Filter]: ReadonlyArray<string> } = {
	others: ["Account", "Grant"],
	session: [],
	none: [],
	scoped: []
}

/**
 * The relations the entry's view reads beside T under each filter, its definition as the installation renders it: the
 * filter's own, and a scoped writer's scope owner's, Holder, at whose keys the view reads T in the writer's world.
 */
export const viewReads: { readonly [F in Filter]: ReadonlyArray<string> } = {
	others: ["Account", "Grant"],
	session: [],
	none: [],
	scoped: ["Holder"]
}

const Clerk = str.regex("^user_[0-9A-Za-z]{1,64}$")
const Program = str.regex("^[a-z]{1,16}$")
const Session = context("Session", { sub: Clerk })

/**
 * The login of a case, metis's ops `operator` in small: Account (clerk -> person) and Grant (person, program), which
 * `admin` inserts with Item; T (number, item, origin), contained in Item by its item, mutable inside the unit of its
 * number, which its deletes need, written by `writer` only through its entry `Mine`, filtered as `filter` says, beside
 * its whole entries. The writer's one ChangeSet writes T through
 * `Mine` as `write` says, compiled with no database over the artifacts its served file compiles over.
 */
export const policedLoginOf = ({ filter, write }: Drawn) => {
	const Account = relation("Account", { clerk: Clerk, person: natural }, ["clerk"])
	const Grant = relation("Grant", { person: natural, program: Program }, ["person", "program"])
	const Item = relation("Item", { number: natural }, ["number"])
	const T = relation("T", { number: natural, item: natural, origin: natural }, ["number"])
	/** The numbers each Clerk user holds: the scope owner's table, read at its key's prefix the session's user binds. */
	const Holder = relation("Holder", { clerk: Clerk, number: natural }, ["clerk", "number"])
	const Policed = schema(
		"PolicedReads",
		[Account, Grant, Item, T, Holder],
		[contained(on(T, "item"), on(Item, "number")), unit("Numbers", { number: natural }), mutable(T)]
	)
	const q = query(Policed)
	const mine =
		filter === "others"
			? q.rule((r) => {
					const { number, item, origin } = v(T, "t")
					const { sub } = v(Session, "s")
					const { person } = v(Account, "a")
					return r
						.match(T, { number, item, origin })
						.match(Session, { sub })
						.match(Account, { clerk: sub, person })
						.match(Grant, { person, program: "act" })
						.find({ number, item, origin })
				})
			: filter === "session"
				? q.rule((r) => {
						const { number, item, origin } = v(T, "t")
						const { sub } = v(Session, "s")
						return r
							.match(T, { number, item, origin })
							.match(Session, { sub })
							.find({ number, item, origin })
					})
				: q.rule((r) => {
						const { number, item, origin } = v(T, "t")
						return r.match(T, { number, item, origin }).find({ number, item, origin })
					})
	const relations = { Account, Grant, Item, T, Holder }
	const admin = role(Policed, "admin", relations, {
		insert: ["Account", "Grant", "Item", "Holder"]
	})
	/** The numbers the session's user holds: the writer's scope owner where the filter is `scoped`. */
	const held = q.rule((r) => {
		const { sub } = v(Session, "s")
		const { number } = v(Holder, "h")
		return r.match(Session, { sub }).match(Holder, { clerk: sub, number }).find({ number })
	})
	/** `Mine` under the list `write` names, or Item inserted where the write copies the view's numbers. */
	const lists: {
		readonly insert: ReadonlyArray<"Mine" | "Item">
		readonly write: ReadonlyArray<"Mine">
	} =
		write === "insert"
			? { insert: ["Mine"], write: [] }
			: write === "copy"
				? { insert: ["Item"], write: [] }
				: { insert: [], write: ["Mine"] }
	const writer = role(
		Policed,
		"writer",
		{ ...relations, Mine: mine },
		filter === "scoped"
			? { ...lists, contexts: [Session], scope: [held] }
			: { ...lists, contexts: [Session] }
	)
	const stated = query(writer).rule((r) =>
		r.find({
			number: r.param("number", natural),
			item: r.param("item", natural),
			origin: r.param("origin", natural)
		})
	)
	const act =
		write === "insert"
			? ChangeSet.empty(writer).insert(writer.relations.Mine, stated)
			: write === "put"
				? ChangeSet.empty(writer).put(writer.relations.Mine, stated)
				: write === "copy"
					? ChangeSet.empty(writer).insert(
							writer.relations.Item,
							query(writer).rule((r) => {
								const { number } = v(writer.relations.Mine, "m")
								return r.match(writer.relations.Mine, { number }).find({ number })
							})
						)
					: ChangeSet.empty(writer).deleteWhere({ Mine: { number: param("number", natural) } })
	const value = login(Policed, "app", [admin, writer], { workload: [workload(writer, { act })] })
	const built = defined(builtLogin(value), "a login built by login(...)")
	const owned = succeeded(built.base.content.owned(), "the login's base")
	const basis = succeeded(
		installBasis(owned, firstCodebook(rostersOf(owned)), new Set()),
		"the base's basis"
	)
	const checking = succeeded(artifactsOver(basis, unserved), "the base's artifacts")
	const ownedLogin = succeeded(ownLoginOver(built, owned), "the login over its base")
	const planned = succeeded(
		planWorkload(
			[{ login: ownedLogin.name, workloads: built.workload }],
			built.base,
			{ artifacts: checking },
			silentPhases
		),
		"the login's workload plan"
	)
	const artifacts = succeeded(
		artifactsOver(basis, { kind: "planned", types: planned.plan.params }),
		"the login's artifacts"
	)
	return {
		roles: built.roles,
		workload: built.workload,
		named: succeeded(namedLogin(ownedLogin, artifacts.names.levels), "the login named"),
		artifacts,
		clock: transactionClock,
		planned: planned.frontends
	}
}
