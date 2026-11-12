import { Array as Arr, Data, Option, Result } from "effect"
import type { Column, Message, OldImage, Tuple } from "#adapter/live/pgoutput.ts"
import {
	admittedIdentifier,
	batchNotifications,
	type Notification,
	notificationText,
	type RouteColumn,
	type RouteTable
} from "#compiler/plan/runtime.ts"

/**
 * What the installation's decoded changes route to (live/leader.ts): each committed transaction's notifications, from
 * the pgoutput messages its replication stream carries (live/pgoutput.ts), under the installation's live tables, each
 * table its live programs read with the columns some program routes it by.
 *
 * A change of a table no program reads routes nowhere, and a change of a table read with no route is its table's key.
 * A change of a routed table is decided by one predicate, coverage: for each routed column, on each side the change
 * carries (the row it left, for an insert and an update; the row it replaced, for an update and a delete), the side's
 * value of the column is its keyed key, so a subscription at either value hears it, and a side that does not say the
 * value makes the change its table's key, which every program of the table hears: a missing image costs re-runs, never
 * a missed change. Each side is first read into one representation, each column's text or absent (sidesOf), so the
 * predicate reads no image's kind. A TRUNCATE is each read table's key.
 *
 * A change of the installation's migrations ledger, which the publication holds beside the live tables, is a migration:
 * its transaction's notification is `migrated` (engine live/notify.ts), whatever row it wrote, and every live read of
 * the installation ends `stale` once it is fanned out (live/listen.ts).
 *
 * A logical message under the installation's prefix is a refresh's announcement, its text a batch's plaintext
 * (engine live/notify.ts batchNotifications), and untrusted input: pg_logical_emit_message is PUBLIC, so any role of the
 * database can emit one under the prefix. Of a message the reader takes only the table keys of the installation's
 * materialized views, a refresh's whole vocabulary, and drops every other notification, a table's key or a keyed key of
 * a stored relation, `invalidated`, a view the installation does not hold, and a text that parts from the grammar. So a
 * forged announcement causes no more than a refresh's own does, a re-run of that view's reads that diffs empty: it
 * never changes a value, never routes a stored relation's change, and never ends a read.
 *
 * The routed columns of each installed table its live programs read, by its installed name (served/forms.ts ServedLive
 * tables): the publication holds these tables alone, so a Relation message's table is named by its name.
 */
export type LiveTables = ReadonlyMap<string, ReadonlyArray<string>>

/** One committed transaction: its xid, its commit's end LSN, and the notifications of its changes, each once. */
export interface DecodedTransaction {
	readonly xid: number
	readonly endLsn: bigint
	readonly notifications: ReadonlyArray<Notification>
}

/**
 * A stream's messages are no committed transactions the leader can route: a change or a commit outside a transaction,
 * a transaction begun inside another, or a change of a relation no Relation message named. `at` says which.
 */
export class ChangesUnroutable extends Data.TaggedError("ChangesUnroutable")<{
	readonly at: string
}> {
	override get message(): string {
		return `the installation's decoded changes cannot be routed: ${this.at}`
	}
}

/**
 * A relation as a round's Relation message named it: the installation's migrations ledger, read by no program, read
 * whole, or routed by its columns.
 */
type RelationRoutes =
	| { readonly kind: "ledger" }
	| { readonly kind: "unread" }
	| { readonly kind: "whole"; readonly table: RouteTable }
	| {
			readonly kind: "routed"
			readonly table: RouteTable
			readonly columns: ReadonlyArray<Column>
			readonly routes: ReadonlyArray<{ readonly column: RouteColumn; readonly position: number }>
	  }

const unread: RelationRoutes = { kind: "unread" }

const ledgerRoutes: RelationRoutes = { kind: "ledger" }

const migrated: Notification = { kind: "migrated" }

/**
 * A Relation message's routes under `tables`: a routed column the relation does not hold leaves the table routed by
 * none of its columns, read whole, so its every change is its table's key.
 */
const relationRoutes = (
	tables: LiveTables,
	name: string,
	columns: ReadonlyArray<Column>
): RelationRoutes => {
	const routed = tables.get(name)
	if (routed === undefined) {
		return unread
	}
	const table = admittedIdentifier<"table">(name)
	const routes: Array<{ readonly column: RouteColumn; readonly position: number }> = []
	for (const column of routed) {
		const position = Arr.findFirstIndex(columns, (c) => c.name === column)
		if (Option.isNone(position)) {
			return { kind: "whole", table }
		}
		routes.push({ column: admittedIdentifier<"column">(column), position: position.value })
	}
	return routes.length === 0 ? { kind: "whole", table } : { kind: "routed", table, columns, routes }
}

/** The notifications of one transaction, each once, by its text. */
type Keys = Map<string, Notification>

const add = (keys: Keys, notification: Notification): void => {
	keys.set(notificationText(notification), notification)
}

/** One side of a row change as coverage reads it: each column's text, by position, or absent where the side does not say it. */
type Side = ReadonlyArray<string | undefined>

/** A tuple's texts; a NULL and an unchanged TOASTed value say nothing, and are absent. */
const textsOf = (tuple: Tuple): Side =>
	Arr.map(tuple, (cell) => (cell.kind === "text" ? cell.text : undefined))

/**
 * The row an update or a delete replaced, from its old image: a whole one says every column; one of the replica
 * identity's key columns says those alone, every other absent though sent as NULL.
 */
const replacedOf = (columns: ReadonlyArray<Column>, previous: OldImage): Side => {
	const texts = textsOf(previous.tuple)
	return previous.whole
		? texts
		: Arr.map(columns, (column, at) => (column.key ? texts[at] : undefined))
}

/**
 * The row an update that sent no old image replaced: it kept its replica identity's key, so its key columns say what
 * the row it left says, and every other is absent.
 */
const keptKeyOf = (columns: ReadonlyArray<Column>, left: Side): Side =>
	Arr.map(columns, (column, at) => (column.key ? left[at] : undefined))

/** The sides a row change carries, by its kind (see the header). */
const sidesOf = (
	columns: ReadonlyArray<Column>,
	message: Extract<Message, { readonly kind: "insert" | "update" | "delete" }>
): ReadonlyArray<Side> => {
	switch (message.kind) {
		case "insert":
			return [textsOf(message.next)]
		case "update": {
			const left = textsOf(message.next)
			return [
				left,
				message.previous === undefined
					? keptKeyOf(columns, left)
					: replacedOf(columns, message.previous)
			]
		}
		case "delete":
			return [replacedOf(columns, message.previous)]
	}
}

/** The keys of one row change of `relation` (see the header). */
const changeKeys = (
	keys: Keys,
	relation: RelationRoutes,
	message: Extract<Message, { readonly kind: "insert" | "update" | "delete" }>
): void => {
	switch (relation.kind) {
		case "ledger":
			add(keys, migrated)
			return
		case "unread":
			return
		case "whole":
			add(keys, { kind: "table", table: relation.table })
			return
		case "routed": {
			const table = relation.table
			for (const side of sidesOf(relation.columns, message)) {
				for (const { column, position } of relation.routes) {
					const value = side[position]
					add(
						keys,
						value === undefined ? { kind: "table", table } : { kind: "keyed", table, column, value }
					)
				}
			}
			return
		}
	}
}

/**
 * Reads a replication stream's pgoutput messages, one at a time, in order, into its committed transactions (see the
 * header): each Relation message names a relation under `tables`, or the ledger, `ledger`, until another names it again,
 * a logical message under `prefix` is an announcement, of which only the table keys of `views` are taken, and each
 * Commit answers the transaction it ends.
 */
export interface TransactionReader {
	readonly read: (
		message: Message
	) => Result.Result<DecodedTransaction | undefined, ChangesUnroutable>
}

/** A reader of one stream's messages (TransactionReader), from the stream's first message. */
export const transactionReader = (
	tables: LiveTables,
	views: ReadonlySet<string>,
	prefix: string,
	ledger: string
): TransactionReader => {
	const relations = new Map<number, RelationRoutes>()
	const stream: { open: { readonly xid: number; readonly keys: Keys } | undefined } = {
		open: undefined
	}
	const unroutable = (at: string) => Result.fail(new ChangesUnroutable({ at }))
	return {
		read: (message) => {
			if (message.kind === "relation") {
				relations.set(
					message.relation,
					message.name === ledger
						? ledgerRoutes
						: relationRoutes(tables, message.name, message.columns)
				)
				return Result.succeed(undefined)
			}
			if (message.kind === "skipped") {
				return Result.succeed(undefined)
			}
			const open = stream.open
			if (message.kind === "begin") {
				if (open !== undefined) {
					return unroutable("a transaction begun inside another")
				}
				stream.open = { xid: message.xid, keys: new Map() }
				return Result.succeed(undefined)
			}
			if (open === undefined) {
				return unroutable(`a ${message.kind} outside a transaction`)
			}
			switch (message.kind) {
				case "commit":
					stream.open = undefined
					return Result.succeed({
						xid: open.xid,
						endLsn: message.endLsn,
						notifications: [...open.keys.values()]
					})
				case "insert":
				case "update":
				case "delete": {
					const relation = relations.get(message.relation)
					if (relation === undefined) {
						return unroutable("a change of a relation never named")
					}
					changeKeys(open.keys, relation, message)
					return Result.succeed(undefined)
				}
				case "truncate":
					for (const id of message.relations) {
						const relation = relations.get(id)
						if (relation === undefined) {
							return unroutable("a truncate of a relation never named")
						}
						switch (relation.kind) {
							case "ledger":
								add(open.keys, migrated)
								break
							case "unread":
								break
							case "whole":
							case "routed":
								add(open.keys, { kind: "table", table: relation.table })
						}
					}
					return Result.succeed(undefined)
				case "message": {
					if (message.prefix !== prefix) {
						return Result.succeed(undefined)
					}
					const announced = batchNotifications(message.content)
					if (announced.ok) {
						for (const notification of announced.value) {
							if (notification.kind === "table" && views.has(notification.table)) {
								add(open.keys, notification)
							}
						}
					}
					return Result.succeed(undefined)
				}
			}
		}
	}
}
