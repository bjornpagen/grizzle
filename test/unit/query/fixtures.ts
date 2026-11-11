import { Array as Arr, Formatter, Record as Rec } from "effect"
import { hasProperties, isList } from "#compiler/core/record.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import { pg, span, uuid } from "#compiler/public/fields.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"

/**
 * The example schemas over the real field descriptors, str.regex and the schema builders, for the query builder
 * tests, beside the worked example (test/support/fixtures/api/work.ts), and the reader of what the builder emits: a
 * query value's canonical Description.
 */

export const Preference = relation("Preference", { account: uuid, enabled: pg.boolean }, [
	"account"
])
export const Settings = schema("Settings", [Preference], [])

/** The span example. */
const RoomOpen = relation("RoomOpen", { room: uuid, during: span(pg.bigint) }, ["room", "during"])
export const Booking = relation("Booking", { room: uuid, during: span(pg.bigint), guest: uuid }, [
	"room",
	"during"
])

export const Schedule = schema(
	"Schedule",
	[RoomOpen, Booking],
	[contained(on(Booking, "room", "during"), on(RoomOpen, "room", "during"))]
)

/** The vector example. */
const DocumentVector = pg.vector(4)
export const Document = relation(
	"Document",
	{ id: uuid, account: uuid, title: str.regex("^.+$", "su") },
	["id"]
)

export const DocumentCurrent = relation(
	"DocumentCurrent",
	{ document: uuid, revision: pg.bigint },
	["document"]
)

export const DocumentEmbedding = relation(
	"DocumentEmbedding",
	{ document: uuid, revision: pg.bigint, value: DocumentVector },
	["document", "revision"]
)

export const Search = schema(
	"Search",
	[Document, DocumentCurrent, DocumentEmbedding],
	[
		contained(on(DocumentCurrent, "document"), on(Document, "id")),
		contained(on(DocumentEmbedding, "document"), on(Document, "id"))
	]
)

/** Reading what the builder emits. */

export const descOf = (q: unknown): QueryDesc => {
	const desc = queryValueDesc(q)
	if (desc === undefined) {
		throw new Error("not a query value")
	}
	assertCanonical(desc)
	return desc
}

/**
 * What every Description the builder emits satisfies, checked structurally and independently of the builder's own
 * walks: every rule lists in RuleDesc.vars, once each, every variable its own clauses use. A rule's own clauses are its
 * matches, predicates and head, without the imported queries they read, which are rules of their own.
 */
const assertCanonical = (desc: QueryDesc): void => {
	const leaks: Array<string> = []
	const scan = (value: unknown, path: string): void => {
		if (isList(value)) {
			for (const [i, x] of value.entries()) {
				scan(x, `${path}[${i}]`)
			}
		} else if (typeof value === "object" && hasProperties(value)) {
			if (isList(value["vars"]) && isList(value["matches"]) && isList(value["where"])) {
				checkRule(value, value["vars"], path)
			}
			for (const [k, x] of Rec.toEntries(value)) {
				scan(x, `${path}.${k}`)
			}
		}
	}
	const checkRule = (
		rule: Readonly<Record<string, unknown>>,
		vars: ReadonlyArray<unknown>,
		path: string
	): void => {
		const listed = Arr.map(vars, (x) => (hasProperties(x) ? x["id"] : undefined))
		if (new Set(listed).size !== listed.length) {
			leaks.push(`${path}.vars: repeated ids ${Formatter.format(listed)}`)
		}
		const used = new Set<string>()
		const uses = (value: unknown): void => {
			if (isList(value)) {
				for (const x of value) {
					uses(x)
				}
			} else if (typeof value === "object" && hasProperties(value)) {
				if (value["kind"] === "var" && typeof value["var"] === "string") {
					used.add(value["var"])
				}
				for (const [k, x] of Rec.toEntries(value)) {
					if (k !== "query") {
						uses(x)
					}
				}
			}
		}
		uses([rule["matches"], rule["where"], rule["head"]])
		for (const id of used) {
			if (!listed.includes(id)) {
				leaks.push(`${path}: variable ${Formatter.format(id)} is not in RuleDesc.vars`)
			}
		}
	}
	scan(desc, "desc")
	if (leaks.length > 0) {
		throw new Error(`a Description that is not canonical:\n${Arr.join(leaks, "\n")}`)
	}
}

/** The element at an index, which the test states is there. */
export const at = <A>(list: ReadonlyArray<A>, index: number): A => {
	const item = list[index]
	if (item === undefined) {
		throw new Error(`no element at ${index} of ${list.length}`)
	}
	return item
}
