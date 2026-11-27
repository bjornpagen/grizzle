/** What the properties of boundless-lookups.test.ts read: a stored derived relation of two bytes columns of no byte bound. */

import { Array as Arr } from "effect"
import { defaultOpclass } from "#compiler/ir/law.ts"
import type { AccessIndexRequest } from "#compiler/ir/products.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { bytes, natural } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema, sealed, unit } from "#compiler/public/schema.ts"
import { Id } from "#test/support/ids.ts"
import { owning } from "#test/support/policy.ts"
import { requesting } from "#test/unit/physical/fixtures.ts"

/** Each account's notes, keyed by the account first, sealed at founding, so a relation over them stands in the unit. */
const Note = relation("Note", { account: Id, at: natural, body: bytes, label: bytes }, [
	"account",
	"at"
])
const Book = sealed(unit("Book", { account: Id }))
const Notes = schema("Notes", [Note], [Book])

/** Every note counted, as a derived relation the installation stores (no copy of Note: its count is no field of Note),
 * its body and label bytes of no byte bound. */
const AccountNote = derived(
	"AccountNote",
	query(Notes).rule((r) => {
		const { account, at, body, label } = v(Note, "note")
		return r
			.match(Note, { account, at, body, label })
			.find({ account, at, body, label, notes: r.count() })
	})
)

/** The notes' level, holding AccountNote. */
const Noted = schema.extend([Notes], "Noted", [AccountNote], [])

/** The bytes columns a lookup of AccountNote binds by equality, and nothing else. */
export const boundlessColumns = ["body", "label"] as const

/** A lookup of AccountNote binding `columns` by equality alone, as a workload's read asks it. */
export const boundlessLookup = (columns: ReadonlyArray<string>): AccessIndexRequest => ({
	relation: "AccountNote",
	keys: Arr.map(columns, (expr) => ({ expr, dir: "asc" as const, opclass: defaultOpclass })),
	method: "btree",
	fixed: columns.length,
	role: "access",
	use: "equality lookup"
})

/** The installation of the notes with `requests` asked of the index engine. */
export const installNoted = (requests: ReadonlyArray<AccessIndexRequest>) => {
	const owned = owning(Noted)
	return compileInstallation(owned, {
		...installOptions(owned),
		extensions: [requesting(requests)]
	})
}
