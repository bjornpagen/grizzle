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
	notExists,
	nullOf,
	param,
	query,
	text
} from "#compiler/sql/catalog.ts"
import { emitCatalog } from "#compiler/sql/emit.ts"

/** The output plugin of the installation's slot, PostgreSQL's own, which logical replication's subscribers read. */
const outputPlugin = "pgoutput"

/**
 * The version of pgoutput's protocol the leader reads: 1, whose messages every later version keeps, with no streaming
 * of a transaction in progress and no two-phase commit, so each decoded transaction arrives whole at its commit.
 *
 * @formatConstant pgoutput's logical replication protocol, version 1
 */
const protocolVersion = "1"

/** A prepared catalog read. */
const preparedRead = (read: CatalogSelect) => prepared(emitCatalog(read))

/**
 * The slot of `$1::name` in the current database, not invalidated: the one read `create` and `check` make of
 * pg_replication_slots, which PUBLIC reads, as every catalog view.
 */
const slotStands = (invalidated: boolean): CatalogSelect => {
	const slot = from("pg_replication_slots", "r")
	const named = and([
		eq(slot.col("slot_name"), param(1, "name")),
		eq(slot.col("database"), call("current_database", []))
	])
	return query(
		[bool(true)],
		[slot.item],
		invalidated
			? named
			: and([named, eq(coalesce([slot.col("invalidation_reason"), text("")]), text(""))])
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
	const changes = fromFunction(
		call("pg_logical_slot_peek_binary_changes", [
			param(1, "name"),
			nullOf("pg_lsn"),
			nullOf("integer"),
			text("proto_version"),
			text(protocolVersion),
			text("publication_names"),
			text(publication),
			text("messages"),
			text("true")
		]),
		"c",
		["lsn", "xid", "data"],
		false
	)
	const ids = fromFunction(call("unnest", [arrayParam(1, "text")]), "t", ["x"], false)
	const running = fromFunction(
		call("pg_snapshot_xip", [call("pg_current_snapshot", [])]),
		"v",
		["v"],
		false
	)
	const payloads = fromFunction(call("unnest", [arrayParam(1, "text")]), "p", ["p"], false)
	const advanced = fromFunction(
		call("pg_replication_slot_advance", [param(1, "name"), param(2, "pg_lsn")]),
		"a",
		["slot_name", "end_lsn"],
		false
	)
	return {
		kind: "source",
		publication,
		stem: publication,
		tables: source.tables,
		listen: emitCatalog({ kind: "listen", channel: publication }),
		secret: preparedRead(
			query([call("encode", [secret.col("secret"), text("hex")])], [secret.item], undefined)
		),
		lock: preparedRead(
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
		create: preparedRead(
			query(
				[
					call("pg_create_logical_replication_slot", [
						param(1, "name"),
						literal(outputPlugin, "name")
					])
				],
				[],
				notExists(slotStands(true))
			)
		),
		check: preparedRead(query([exists(slotStands(false))], [], undefined)),
		peek: preparedRead(
			query([call("encode", [changes.col("data"), text("hex")])], [changes.item], undefined)
		),
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
		advance: preparedRead(
			query(
				[{ kind: "cast", expr: advanced.col("end_lsn"), type: { name: "text", array: false } }],
				[advanced.item],
				undefined
			)
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
