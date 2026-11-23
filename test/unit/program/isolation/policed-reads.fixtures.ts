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
import { ownBuilt, rostersOf } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import { succeeded } from "#test/support/assert.ts"

/**
 * What the writer's entry over T holds: T's rows while the session's user holds the program `act`, a filter reading
 * Account and Grant (`others`, its policy a filter function's call); T's rows while the session's claim stands, a
 * filter reading no relation (`session`, its policy the membership itself); or every row of T (`none`, no policy).
 */
export type Filter = "others" | "session" | "none"

/** How the writer writes T through its entry: an insert, a put, or a delete by its key, which reads the entry's view. */
export type Write = "insert" | "put" | "delete"

/** A case: the entry's filter and the write through it. */
export interface Drawn {
	readonly filter: Filter
	readonly write: Write
}

const filters = ["others", "session", "none"] as const satisfies ReadonlyArray<Filter>

const writes = ["insert", "put", "delete"] as const satisfies ReadonlyArray<Write>

export const drawnGen: Gen<Drawn> = (source) => ({
	filter: source.draw(element(filters)),
	write: source.draw(element(writes))
})

/** The relations each filter reads besides T's row, the ones its policy and its filter function read. */
export const filterReads: { readonly [F in Filter]: ReadonlyArray<string> } = {
	others: ["Account", "Grant"],
	session: [],
	none: []
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
	const Policed = schema(
		"PolicedReads",
		[Account, Grant, Item, T],
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
	const relations = { Account, Grant, Item, T }
	const admin = role(Policed, "admin", relations, { insert: ["Account", "Grant", "Item"] })
	const writer = role(
		Policed,
		"writer",
		{ ...relations, Mine: mine },
		write === "insert"
			? { insert: ["Mine"], contexts: [Session] }
			: { write: ["Mine"], contexts: [Session] }
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
				: ChangeSet.empty(writer).deleteWhere({ Mine: { number: param("number", natural) } })
	const value = login(Policed, "app", [admin, writer], { workload: [workload(writer, { act })] })
	const built = defined(builtLogin(value), "a login built by login(...)")
	const owned = succeeded(ownBuilt(built.base), "the login's base")
	const basis = succeeded(
		installBasis(owned, firstCodebook(rostersOf(owned)), everySlice(owned)),
		"the base's basis"
	)
	const checking = succeeded(artifactsOver(basis, unserved), "the base's artifacts")
	const ownedLogin = succeeded(ownLoginOver(built, owned), "the login over its base")
	const planned = succeeded(
		planWorkload(
			[{ login: ownedLogin.name, workloads: built.workload }],
			built.base,
			{ artifacts: checking, roles: ownedLogin.roles },
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
