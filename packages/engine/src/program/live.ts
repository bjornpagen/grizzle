import { identifierOf, identity } from "#compiler/core/identity.ts"
import { prepared } from "#compiler/core/prepared.ts"
import type { LiveSource } from "#compiler/live/notify.ts"
import type { ServedLive } from "#compiler/served/forms.ts"
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
 * The installation's live source as its served files hold it (served/forms.ts ServedLive), for the installation whose
 * root level's PostgreSQL schema is `root`: none where `source` is none; otherwise its publication and its slot's and
 * decoder login's stem, both identity.liveSource of the root, its published tables, and each text its leader and its
 * listeners send, emitted now.
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
	return {
		kind: "source",
		publication,
		stem: publication,
		tables: source.tables,
		views: source.views,
		listen: emitCatalog({ kind: "listen", channel: publication }),
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
