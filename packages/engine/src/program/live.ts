import { identifierOf, identity } from "#compiler/core/identity.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { prepared } from "#compiler/core/prepared.ts"
import type { LiveSource } from "#compiler/live/notify.ts"
import { createSlotTemplate, startTemplate } from "#compiler/live/replication.ts"
import type { LiveGap, ServedFootprint, ServedLive } from "#compiler/served/forms.ts"
import type { CatalogSelect } from "#compiler/sql/catalog.ts"
import {
	advisoryKey,
	and,
	arrayParam,
	bool,
	call,
	coalesce,
	eq,
	exists,
	from,
	fromFunction,
	fromObject,
	literal,
	not,
	param,
	query,
	text
} from "#compiler/sql/catalog.ts"
import { emitCatalog } from "#compiler/sql/emit.ts"

/** A prepared catalog read. */
const preparedRead = (read: CatalogSelect) => prepared(emitCatalog(read))

/**
 * Whether the slot of `$1::name` stands in the current database, not invalidated: a read of pg_replication_slots,
 * which PUBLIC reads, as every catalog view.
 */
const slotStands = (): CatalogSelect => {
	const slot = from("pg_replication_slots", "r")
	return query(
		[bool(true)],
		[slot.item],
		and([
			eq(slot.col("slot_name"), param(1, "name")),
			eq(slot.col("database"), call("current_database", [])),
			eq(coalesce([slot.col("invalidation_reason"), text("")]), text(""))
		])
	)
}

/**
 * What of a read's footprint `footprint` the installation's live source `source` does not decode (served/forms.ts
 * LiveGap): each table it reads that is neither a published table nor a view of the source, in code point order, then
 * each column of a published table the read routes it by that the source does not route it by, by table and column. A
 * view's footprint has no routes, since a refresh replaces its rows at once.
 */
export const readGaps = (
	source: Extract<LiveSource, { readonly kind: "source" }>,
	footprint: ServedFootprint
): ReadonlyArray<LiveGap> => {
	const tables: Array<LiveGap> = []
	const columns: Array<LiveGap> = []
	for (const table of Object.keys(footprint).toSorted(compareStrings)) {
		if (source.views.includes(table)) {
			continue
		}
		const published = source.tables[table]
		if (published === undefined) {
			tables.push({ kind: "table", table })
			continue
		}
		for (const column of Object.keys(footprint[table] ?? {}).toSorted(compareStrings)) {
			if (published.includes(column)) {
				continue
			}
			columns.push({ kind: "column", table, column })
		}
	}
	return [...tables, ...columns]
}

/**
 * The installation's live source as its served files hold it (served/forms.ts ServedLive), for the installation whose
 * root level's PostgreSQL schema is `root`: none where `source` is none; otherwise its publication and its slot's and
 * decoder login's stem, both identity.liveSource of the root, the migrations ledger's table (identity.ledger), its
 * published tables, and each text its leader and its listeners send, emitted now.
 */
export const servedLiveOf = (root: string, source: LiveSource): ServedLive => {
	if (source.kind === "none") {
		return { kind: "none" }
	}
	const publication = identifierOf(identity.liveSource(root))
	const secret = fromObject({ schema: root, name: identifierOf(identity.liveSecret()) }, "s")
	const ids = fromFunction(call("unnest", [arrayParam(1, "text")]), "t", ["x"], false)
	const running = fromFunction(
		call("pg_snapshot_xip", [call("pg_current_snapshot", [])]),
		"v",
		["v"],
		false
	)
	const payloads = fromFunction(call("unnest", [arrayParam(1, "text")]), "p", ["p"], false)
	const settings = from("pg_settings", "s")
	return {
		kind: "source",
		publication,
		ledger: identifierOf(identity.ledger()),
		stem: publication,
		tables: source.tables,
		views: source.views,
		listen: prepared(emitCatalog({ kind: "listen", channel: publication })),
		secret: preparedRead(
			query([call("encode", [secret.col("secret"), text("hex")])], [secret.item], undefined)
		),
		lock: emitCatalog(
			query(
				[
					call("pg_advisory_lock", [
						literal(advisoryKey({ kind: "live", source: publication }), "bigint")
					])
				],
				[],
				undefined
			)
		),
		senderTimeout: emitCatalog(
			query(
				[settings.col("setting")],
				[settings.item],
				and([
					eq(settings.col("name"), text("wal_sender_timeout")),
					eq(settings.col("unit"), text("ms"))
				])
			)
		),
		createSlot: createSlotTemplate,
		start: startTemplate(publication),
		check: preparedRead(query([exists(slotStands())], [], undefined)),
		visible: preparedRead(
			query(
				[
					ids.col("x"),
					not(
						exists(
							query(
								[bool(true)],
								[running.item],
								eq(call("xid", [running.col("v")]), {
									kind: "cast",
									expr: ids.col("x"),
									type: { name: "xid", array: false }
								})
							)
						)
					)
				],
				[ids.item],
				undefined
			)
		),
		fanout: preparedRead(
			query([call("pg_notify", [text(publication), payloads.col("p")])], [payloads.item], undefined)
		),
		announce: preparedRead(
			query(
				[call("pg_logical_emit_message", [bool(true), text(publication), param(1, "text")])],
				[],
				undefined
			)
		)
	}
}
