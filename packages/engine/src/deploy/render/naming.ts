import { appendAll } from "#compiler/core/array.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { conversionOf } from "#compiler/core/identity.ts"
import { isNonEmpty } from "#compiler/core/nonempty.ts"
import {
	type Comparator,
	combineAll,
	compareNumbers,
	compareStrings,
	mapInput
} from "#compiler/core/order.ts"
import { maxMigrationNameLength } from "#compiler/deploy/render/folder.ts"
import type { DeploySnapshot, SnapshotField } from "#compiler/deploy/snapshot/types.ts"
import { targetKey } from "#compiler/physical/install/comments.ts"
import { type GraphIdent, innerIdent, parseIdent } from "#compiler/physical/obligations/graph.ts"
import type { CommentTarget } from "#compiler/sql/ast.ts"

type Verb = "add" | "drop" | "change"

interface Change {
	readonly verb: Verb
	readonly ident: string
}

/** The verbs in naming order: add, drop, change. */
const verbRank: Readonly<Record<Verb, number>> = { add: 0, drop: 1, change: 2 }

/** The rank of each kind of identity among the changes of one verb: a table before its columns, indexes and grants. An
 * identity that names no kind, such as a validation's, comes last. */
const kindRank: Readonly<Record<GraphIdent["kind"], number>> = {
	schema: 0,
	table: 1,
	materializedView: 2,
	enum: 3,
	domain: 4,
	column: 5,
	constraint: 6,
	index: 7,
	function: 8,
	trigger: 9,
	statistics: 10,
	role: 11,
	membership: 12,
	view: 13,
	policy: 14,
	rowSecurity: 15,
	privileges: 16,
	extension: 17,
	other: 18
}

const rank = (ident: string): number => kindRank[parseIdent(ident).kind]

/** The changes in naming order: by verb, then by kind, then by identity. */
const changeOrder: Comparator<Change> = combineAll([
	mapInput(compareNumbers, (c: Change) => verbRank[c.verb]),
	mapInput(compareNumbers, (c: Change) => rank(c.ident)),
	mapInput(compareStrings, (c: Change) => c.ident)
])

/** What an identity names after its kind: `<name>`, `<schema>.<name>` or `<schema>.<relation>.<name>`; the whole text
 * of an identity that names no kind. */
const nameOf = (ident: GraphIdent): string => {
	switch (ident.kind) {
		case "schema":
		case "extension":
		case "role":
		case "membership":
		case "privileges":
			return ident.name
		case "enum":
		case "domain":
		case "table":
		case "materializedView":
		case "view":
		case "index":
		case "statistics":
		case "function":
		case "rowSecurity":
			return `${ident.schema}.${ident.name}`
		case "column":
		case "constraint":
		case "trigger":
		case "policy":
			return `${ident.schema}.${ident.relation}.${ident.name}`
		case "other":
			return ident.text
	}
}

/** Lowercase words joined by single underscores. */
const words = (text: string): string => {
	let out = ""
	for (const ch of text.toLowerCase()) {
		const keep = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")
		if (keep) {
			out += ch
		} else if (out.length > 0 && !out.endsWith("_")) {
			out += "_"
		}
	}
	return out.endsWith("_") ? out.slice(0, -1) : out
}

/** What a COMMENT names for an object identity: its object's target, or none for an identity no comment names (an
 * extension, a membership, a role's privileges, row security, a validation). */
const commentTarget = (ident: GraphIdent): CommentTarget | undefined => {
	switch (ident.kind) {
		case "schema":
			return { kind: "SCHEMA", name: ident.name }
		case "role":
			return { kind: "ROLE", name: ident.name }
		case "table":
			return { kind: "TABLE", name: { schema: ident.schema, name: ident.name } }
		case "materializedView":
			return { kind: "MATERIALIZED VIEW", name: { schema: ident.schema, name: ident.name } }
		case "view":
			return { kind: "VIEW", name: { schema: ident.schema, name: ident.name } }
		case "enum":
			return { kind: "TYPE", name: { schema: ident.schema, name: ident.name } }
		case "domain":
			return { kind: "DOMAIN", name: { schema: ident.schema, name: ident.name } }
		case "index":
			return { kind: "INDEX", name: { schema: ident.schema, name: ident.name } }
		case "statistics":
			return { kind: "STATISTICS", name: { schema: ident.schema, name: ident.name } }
		case "function":
			return { kind: "FUNCTION", name: { schema: ident.schema, name: ident.name, args: [] } }
		case "column":
			return {
				kind: "COLUMN",
				relation: { schema: ident.schema, name: ident.relation },
				column: ident.name
			}
		case "constraint":
		case "trigger":
		case "policy":
			return {
				kind:
					ident.kind === "constraint"
						? "CONSTRAINT"
						: ident.kind === "trigger"
							? "TRIGGER"
							: "POLICY",
				name: ident.name,
				on: { schema: ident.schema, name: ident.relation }
			}
		case "extension":
		case "membership":
		case "privileges":
		case "rowSecurity":
		case "other":
			return undefined
	}
}

/** What an object identity names, as a migration's name reads it: a hashed object's COMMENT's words, what the naming
 * door says it is (`drop_btree_index_account_region`), or its name without its schema, for a readable name, which
 * spells what it is (`add_task_note`), and for an identity no comment names. */
const label = (ident: string, schema: string, comments: ReadonlyMap<string, string>): string => {
	const parsed = parseIdent(ident)
	const target = commentTarget(parsed)
	const text = target === undefined ? undefined : comments.get(targetKey(target))
	if (text !== undefined) {
		return conversionOf(text)
	}
	const rest = nameOf(parsed)
	return words(rest.startsWith(`${schema}.`) ? rest.slice(schema.length + 1) : rest)
}

/** Each comment of a snapshot by its target's key. */
const commentsOf = (snapshot: DeploySnapshot): ReadonlyMap<string, string> =>
	new Map(
		snapshot.manifest.comments.flatMap((c) =>
			c.kind === "comment" ? [[targetKey(c.on), c.text] as const] : []
		)
	)

/** Whether `inner`'s identity lies inside `outer`'s: `column:s.t.c` inside `table:s.t`. */
const inside = (inner: string, outer: string): boolean =>
	nameOf(parseIdent(inner)).startsWith(`${nameOf(parseIdent(outer))}.`)

/** The first migration installs everything.
 *
 * A table's DDL changes with its columns; the theory says which fields came and went, or changed type.
 *
 * The name `grizzle generate` gives a drafted migration when no `--name` is given.
 *
 * Drizzle draws a random name; grizzle names a folder after what it does, read off the two snapshots, so the history
 * says what each migration changed, each object named by its readable name or a hashed one's COMMENT: `add_task_note`,
 * `drop_btree_index_account_region`, `change_shop_writer` (the privileges of the role `shop__writer`). A
 * migration that does several things is named after the first, `<first change>_and_more`. The changes are the
 * manifest objects the target adds, drops or changes (another DDL under the same identity), and the fields the schema's
 * theory adds, drops or retypes (a table's DDL changes with its columns). A change of an object is left out when an
 * object inside it changes as well (a table whose column is added is named by the column), and the first change is the
 * first by verb (add, drop, change), then by kind (a table before its columns, indexes and grants), then by name.
 *
 * A schema's first migration, from the empty snapshot, is `init`. The name is lowercase ASCII words joined by `_`, at most maxMigrationNameLength characters, as any `--name` must be. */
export const derivedMigrationName = (previous: DeploySnapshot, next: DeploySnapshot): string => {
	if (previous.manifest.objects.length === 0) {
		return "init"
	}
	const before = new Map(
		previous.manifest.objects.map((o) => [o.ident, canonicalTextOf(o.ddl)] as const)
	)
	const after = new Map(
		next.manifest.objects.map((o) => [o.ident, canonicalTextOf(o.ddl)] as const)
	)
	const changes: Array<Change> = []
	for (const [ident, ddl] of after) {
		const was = before.get(ident)
		if (was === undefined) {
			changes.push({ verb: "add", ident })
		} else if (was !== ddl) {
			changes.push({ verb: "change", ident })
		}
	}
	for (const ident of before.keys()) {
		if (!after.has(ident)) {
			changes.push({ verb: "drop", ident })
		}
	}
	for (const [name, now] of Object.entries(next.theory.relations)) {
		const was = previous.theory.relations[name]
		if (was === undefined || was.ident !== now.ident || now.kind === "derived") {
			continue
		}
		const column = (c: string) => innerIdent("column", next.schema, now.ident, c)
		/** A derived relation stores no field of its own: a stored relation that took its name adds every field. */
		const wasFields: ReadonlyArray<SnapshotField> = was.kind === "derived" ? [] : was.fields
		appendAll(changes, [
			...now.fields.flatMap((f): ReadonlyArray<Change> => {
				const old = wasFields.find((w) => w.name === f.name)
				if (old === undefined) {
					return [{ verb: "add", ident: column(f.column) }]
				}
				return old.type === f.type ? [] : [{ verb: "change", ident: column(f.column) }]
			}),
			...wasFields.flatMap((w): ReadonlyArray<Change> =>
				now.fields.some((f) => f.name === w.name) ? [] : [{ verb: "drop", ident: column(w.column) }]
			)
		])
	}
	/** Each change once, at its first occurrence. */
	const distinct = changes.filter(
		(c, i) => changes.findIndex((d) => d.verb === c.verb && d.ident === c.ident) === i
	)
	const named = distinct
		.filter((c) => c.verb !== "change" || !changes.some((d) => inside(d.ident, c.ident)))
		.toSorted(changeOrder)
	if (!isNonEmpty(named)) {
		return "update"
	}
	const [first] = named
	/** The verb leads, so the head is never empty. */
	const comments = first.verb === "drop" ? commentsOf(previous) : commentsOf(next)
	const head = words(`${first.verb}_${label(first.ident, next.schema, comments)}`)
	const more = named.length > 1 ? "_and_more" : ""
	const room = maxMigrationNameLength - more.length
	const cut = head.length <= room ? head : head.slice(0, room)
	return `${cut.endsWith("_") ? cut.slice(0, -1) : cut}${more}`
}
