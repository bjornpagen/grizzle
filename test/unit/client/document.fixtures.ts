import { Effect } from "effect"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { jsonOf } from "#test/support/chunked.ts"
import { Id } from "#test/support/ids.ts"
import { compiledLogin } from "#test/support/served-login.ts"
import { firstCodes } from "#test/support/unit/live/openapi.fixtures.ts"

/** The login whose OpenAPI document the client is opened over: one role reading one query of one relation. */
const Item = relation("Item", { id: Id, n: pg.integer }, ["id"])
const Shop = schema("Shop", [Item], [])
const items = query(Shop).rule((r) => {
	const { id, n } = v(Item, "item")
	return r.match(Item, { id, n }).find({ id, n })
})
const clerk = role(Shop, "clerk", wholeEntriesOf(Shop))
export const Desk = login(Shop, "desk", [clerk], { workload: [workload(Shop, { items })] })

/** Desk's OpenAPI document, as `grizzle generate` writes it, read as data. */
export const deskDocument: unknown = await Effect.runPromise(
	Effect.scoped(
		Effect.map(compiledLogin(Desk, firstCodes), (compiled) => jsonOf(compiled.entry.openapi))
	)
)
