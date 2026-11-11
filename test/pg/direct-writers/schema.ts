import { contract, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	login,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"

const Amount = contract("Amount", pg.bigint, (x) => x.ge(0n))

export const Account = relation("Account", { id: pg.integer, name: pg.integer }, ["id"])
export const Entry = relation("Entry", { id: pg.integer, account: pg.integer, amount: Amount }, [
	"id"
])
export const Pair = relation("Pair", { a: pg.integer, b: pg.integer }, ["a", "b"])

/** Pair's declared row check, a statement of Desk: the law a test names by this value. */
export const DistinctPair = check("Distinct", Pair, (x) => x.ne(x.a, x.b))

const Desk = schema("Desk", { Account, Entry, Pair }, [
	contained(on(Entry, "account"), on(Account, "id")),
	DistinctPair
])

const AccountEntries = derived.materialized(
	"AccountEntries",
	query(Desk).rule((r) => {
		const { id, account } = v(Entry, "entry")
		return r.match(Entry, { id, account }).find({ account, entries: r.count() })
	})
)

/**
 * The schema of the direct-writer cases no generator draws (native-errors.test.ts):
 *
 * - Account: an immutable relation keyed by id;
 * - Entry: a deferred foreign key into Account and a contract with a CHECK (`Amount >= 0`);
 * - Pair: a pure set with a declared row check;
 * - AccountEntries: a derived relation over Entry in an extension, which no DML writes.
 *
 * Its worlds, in the login `desk`: `writer` holds every base relation whole and writes them; `auditor` reads the
 * derived relation.
 */
export const DeskReports = schema.extend(Desk, "DeskReports", { AccountEntries }, [])

export const writer = role(
	DeskReports,
	"writer",
	{ Account, Entry, Pair },
	{ write: ["Account", "Entry", "Pair"] }
)
const auditor = role(DeskReports, "auditor", { AccountEntries })
export const desk = login(DeskReports, "desk", [writer, auditor])
