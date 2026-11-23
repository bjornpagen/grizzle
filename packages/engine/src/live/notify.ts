import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { base64Bytes } from "@bjornpagen/grizzle-text/base64"
/**
 * Liveness's one grammar: what a committed write changed, as the route keys a live program's runtime routes it by,
 * the text that spells each, and the sealed batches of those texts the fan-out channel carries. The side that reads a
 * write's changes gathers a round's notifications into batches, seals each under the installation's live secret
 * (AES-256-GCM, core/seal.ts) and sends it as one payload; every side that waits opens each payload and routes its
 * notifications by their plaintext keys. A session without the secret, which any role of the database can LISTEN as,
 * reads nothing of a payload but its arrival, and makes none that opens.
 */
import { isAsciiDigit } from "@bjornpagen/grizzle-text/text"
import { utf8, utf8Length, utf8Text } from "@bjornpagen/grizzle-text/utf8"
import { nominal } from "#compiler/core/brand.ts"
import { maxIdentifierBytes } from "#compiler/core/identity.ts"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import { namedatalen } from "#compiler/core/identity.ts"
import type { Identifier } from "#compiler/core/ids.ts"
import { blockSize } from "#compiler/core/page.ts"
import { open, seal, sealKeyBytes, sealNonceBytes, sealTagBytes } from "#compiler/core/seal.ts"
import { wellFormed } from "#compiler/core/text.ts"

/**
 * The margin NOTIFY_PAYLOAD_MAX_LENGTH leaves of a page beside a channel's name, which keeps one notification on one
 * SLRU page of the notification queue.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope the part of one notification queue page no channel name and no payload may take
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/commands/async.c#L194-L202
 * @quote #define NOTIFY_PAYLOAD_MAX_LENGTH (BLCKSZ - NAMEDATALEN - 128)
 * @verified 2026-11-20
 */
const notifyPayloadMargin = 128

/**
 * NOTIFY_PAYLOAD_MAX_LENGTH, the bytes a notification's payload must stay under: Async_Notify refuses a payload of
 * this many bytes or more with 22023, which fails the statement that sent it, and with it the write.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope one NOTIFY payload in the server encoding, its terminating zero excluded: sent only while shorter
 * @derivation async.c's "#define NOTIFY_PAYLOAD_MAX_LENGTH (BLCKSZ - NAMEDATALEN - 128)"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/commands/async.c#L202) and Async_Notify's "if
 *   (payload_len >= NOTIFY_PAYLOAD_MAX_LENGTH) ereport(ERROR, (errcode(ERRCODE_INVALID_PARAMETER_VALUE),
 *   errmsg("payload string too long")))"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/commands/async.c#L924-L927, verified 2026-11-20)
 * @from {@link blockSize}, {@link namedatalen}, {@link notifyPayloadMargin}
 */
const notifyPayloadMaxBytes = blockSize - namedatalen - notifyPayloadMargin

/** A stored relation's installed table, by its identifier, as a route key names it. */
export type RouteTable = Identifier<"table">

/** A stored relation's field's installed column, by its identifier, as a route key names it. */
export type RouteColumn = Identifier<"column">

/**
 * What a committed write changed of one table, as the runtime routes it:
 *
 * - `keyed`: the rows of `table` whose `column` holds `value`, PostgreSQL's output text of the column's value, among
 *   the rows the write touched, each by the image it had before the write and the one it left;
 * - `table`: every row of `table`, where no route narrows a change: a TRUNCATE, a change whose routed value the
 *   reader of the changes cannot read, or a keyed key too long to seal alone.
 *
 * A program fixing `column` of `table` to `value` hears its keyed key and its table's; a program that reads `table`
 * by no route hears every key of `table`.
 */
export type RouteKey =
	| { readonly kind: "table"; readonly table: RouteTable }
	| {
			readonly kind: "keyed"
			readonly table: RouteTable
			readonly column: RouteColumn
			readonly value: string
	  }

/**
 * What the fan-out channel carries: a route key; that the installation's change source is lost, `before` the WAL
 * position the leader read where it found no slot standing, so every source opened on a slot that stood at a position
 * at or before it reads no later change of any table and every live program's stream on it ends, while one opened on a
 * slot made since stands past it and is no source this invalidation names; that the installation's slot stands, which
 * each leader sends once it holds the slot, made or found, so a source waiting for the slot checks it again; or that
 * the installation was migrated, a row of a migrations ledger written, so every served file of it is stale and every
 * live program's stream ends `stale`.
 */
export type Notification =
	| RouteKey
	| { readonly kind: "invalidated"; readonly before: WalPosition }
	| { readonly kind: "stands" }
	| { readonly kind: "migrated" }

/**
 * The text of a notification: `<table>:<column>=<value>` for a keyed key, `<table>:` for a table's,
 * `:invalidated=<position>` for the lost source, its WAL position in decimal, `:stands` for the slot standing, and
 * `:migrated` for a migration, led by
 * `:` where every key's text is led by its table's identifier. An installed
 * identifier holds neither `:` nor `=`, so the first of each ends the name before it, the value is the rest, and no two
 * notifications share a text. No text holds NUL: no identifier does, and no PostgreSQL text value can.
 */
export const notificationText = (notification: Notification): string => {
	switch (notification.kind) {
		case "invalidated":
			return `${invalidatedLead}${notification.before}`
		case "stands":
			return ":stands"
		case "migrated":
			return ":migrated"
		case "table":
			return `${notification.table}:`
		case "keyed":
			return `${notification.table}:${notification.column}=${notification.value}`
	}
}

/** The lead of an invalidation's text, before its WAL position. */
const invalidatedLead = ":invalidated="

/** A text of the channel, a batch or the secret table that spells no payload, notification or secret. */
export interface LiveTextRefused {
	readonly text: string
	readonly expected: string
}

const refused = <A>(text: string, expected: string): Result.Result<A, LiveTextRefused> =>
	Result.err({ text, expected })

const underscore = 0x5f

const isLetter = (unit: number): boolean => unit >= 0x61 && unit <= 0x7a

const isHexDigit = (unit: number): boolean => isAsciiDigit(unit) || (unit >= 0x61 && unit <= 0x66)

declare const walPositionBrand: unique symbol

/**
 * A WAL position, its bytes from 0/0 (pg_wal_lsn_diff): what the live source's slot check reads of the slot that
 * stands, its confirmed_flush_lsn, and of the WAL, its insert position, and what an invalidation names. A slot made
 * after a position stands past it: making a logical slot writes its running transactions' record before the slot's
 * consistent point, so a slot's position is the incarnation it is.
 */
export type WalPosition = bigint & { readonly [walPositionBrand]: true }

const walPositionOf = nominal<bigint, WalPosition>()

/** The WAL position a decimal text spells (positionText of program/live.ts), its digits alone, or its refusal. */
export const parseWalPosition = (text: string): Result.Result<WalPosition, LiveTextRefused> => {
	if (text.length === 0 || (text.length > 1 && text.charCodeAt(0) === 0x30)) {
		return refused(text, "a WAL position: decimal digits, no leading zero")
	}
	for (let at = 0; at < text.length; at += 1) {
		if (!isAsciiDigit(text.charCodeAt(at))) {
			return refused(text, "a WAL position: decimal digits, no leading zero")
		}
	}
	return Result.ok(walPositionOf(BigInt(text)))
}

/**
 * Whether `text` spells an identifier grizzle installs: a readable one, a declared name's conversion, lowercase ASCII
 * letters, digits and underscores led by a letter, or a hashed one, led by `__`; within maxIdentifierBytes, each of its
 * characters one byte.
 */
const isInstalledIdentifier = (text: string): boolean => {
	if (
		text.length > maxIdentifierBytes ||
		!(isLetter(text.charCodeAt(0)) || text.startsWith("__"))
	) {
		return false
	}
	for (let at = 1; at < text.length; at += 1) {
		const unit = text.charCodeAt(at)
		if (!(isLetter(unit) || isAsciiDigit(unit) || unit === underscore)) {
			return false
		}
	}
	return true
}

/**
 * The notification a text spells (`notificationText`), or what it parts from the grammar at: `:invalidated=` and a WAL
 * position, `:stands` or `:migrated` whole, or a table's
 * identifier and `:`, then nothing for the table's key, or a column's identifier, `=` and the value.
 */
export const parseNotification = (text: string): Result.Result<Notification, LiveTextRefused> => {
	if (text.startsWith(invalidatedLead)) {
		return Result.map(parseWalPosition(text.slice(invalidatedLead.length)), (before) => ({
			kind: "invalidated",
			before
		}))
	}
	if (text === ":stands") {
		return Result.ok({ kind: "stands" })
	}
	if (text === ":migrated") {
		return Result.ok({ kind: "migrated" })
	}
	const colon = text.indexOf(":")
	const table = text.slice(0, Math.max(0, colon))
	if (colon < 0 || !isInstalledIdentifier(table)) {
		return refused(
			text,
			"':invalidated=' and a WAL position, ':stands', ':migrated', or an installed table's identifier, then ':'"
		)
	}
	const route = text.slice(colon + 1)
	if (route.length === 0) {
		return Result.ok({ kind: "table", table: admittedIdentifier<"table">(table) })
	}
	const equals = route.indexOf("=")
	const column = route.slice(0, Math.max(0, equals))
	if (equals < 0 || !isInstalledIdentifier(column)) {
		return refused(text, "nothing after ':', or an installed column's identifier, then '='")
	}
	return Result.ok({
		kind: "keyed",
		table: admittedIdentifier<"table">(table),
		column: admittedIdentifier<"column">(column),
		value: route.slice(equals + 1)
	})
}

declare const liveSecretBrand: unique symbol

/**
 * An installation's live secret: the AES-256 key migrate draws from PostgreSQL's strong random source into the
 * installation's secret table, which only its decoder login reads. Minted only by parseLiveSecret.
 */
export type LiveSecret = Uint8Array & { readonly [liveSecretBrand]: true }

const liveSecret = nominal<Uint8Array, LiveSecret>()

/** Whether every character of `text` is a lowercase hex digit. */
const isHex = (text: string): boolean => {
	for (let at = 0; at < text.length; at += 1) {
		if (!isHexDigit(text.charCodeAt(at))) {
			return false
		}
	}
	return true
}

/**
 * The secret the secret table's one cell spells, read as encode(secret, 'hex') writes it, whatever the session's
 * bytea_output: two lowercase hex digits for each of an AES-256 key's bytes, or what it parts from that at.
 */
export const parseLiveSecret = (cell: string): Result.Result<LiveSecret, LiveTextRefused> => {
	if (cell.length !== sealKeyBytes * 2 || !isHex(cell)) {
		return refused(cell, `${sealKeyBytes * 2} lowercase hex digits`)
	}
	const bytes = new Uint8Array(sealKeyBytes)
	for (let i = 0; i < sealKeyBytes; i += 1) {
		bytes[i] = Number.parseInt(cell.slice(i * 2, i * 2 + 2), 16)
	}
	return Result.ok(liveSecret(bytes))
}

/**
 * The base64 characters that encode one group of bytes, and the bytes of one group.
 *
 * @formatConstant base64's groups: 3 bytes as 4 characters, the last group padded (RFC 4648)
 */
const base64Group = { characters: 4, bytes: 3 } as const

/**
 * The UTF-8 bytes a batch's text may take: the most whose sealed payload, its nonce, its ciphertext as long as the
 * text and its tag in base64, stays under notifyPayloadMaxBytes. No limit of its own: PostgreSQL's NOTIFY payload
 * bound read against the sealed payload's format. A payload of s sealed bytes is base64Group.characters * ceil(s /
 * base64Group.bytes) characters, which must stay under notifyPayloadMaxBytes; s is the text's bytes, the nonce's and
 * the tag's (core/seal.ts sealNonceBytes, sealTagBytes).
 */
const batchMaxBytes: number =
	Math.floor((notifyPayloadMaxBytes - 1) / base64Group.characters) * base64Group.bytes -
	sealNonceBytes -
	sealTagBytes

declare const liveBatchBrand: unique symbol

/**
 * The text of one batch of a round's notifications: their texts, each once, joined by NUL, which no text holds, its
 * UTF-8 bytes within batchMaxBytes. Minted only by batchesOf.
 */
export type LiveBatch = string & { readonly [liveBatchBrand]: true }

const liveBatch = nominal<string, LiveBatch>()

const separator = "\u0000"

/**
 * A round's notifications as batches, each distinct text once, in the order first given, each batch as many texts as
 * fit batchMaxBytes. A keyed key whose text alone passes it is sent as its table's key, which every program reading
 * the table hears.
 */
export const batchesOf = (notifications: ReadonlyArray<Notification>): ReadonlyArray<LiveBatch> => {
	const seen = new Set<string>()
	const batches: Array<LiveBatch> = []
	let texts: Array<string> = []
	let bytes = 0
	for (const notification of notifications) {
		const own = notificationText(notification)
		const text =
			notification.kind === "keyed" && utf8Length(own) > batchMaxBytes
				? notificationText({ kind: "table", table: notification.table })
				: own
		if (seen.has(text)) {
			continue
		}
		seen.add(text)
		const length = utf8Length(text)
		const together = texts.length === 0 ? length : bytes + 1 + length
		if (together > batchMaxBytes) {
			batches.push(liveBatch(texts.join(separator)))
			texts = [text]
			bytes = length
		} else {
			texts.push(text)
			bytes = together
		}
	}
	return texts.length === 0 ? batches : [...batches, liveBatch(texts.join(separator))]
}

declare const sealNonceBrand: unique symbol

/** A nonce of one sealed payload: sealNonceBytes the sender drew at random. Minted only by sealNonce. */
export type SealNonce = Uint8Array & { readonly [sealNonceBrand]: true }

/** `bytes` as a nonce, or what they part from one at: exactly sealNonceBytes. */
export const sealNonce = (bytes: Uint8Array): Result.Result<SealNonce, LiveTextRefused> =>
	bytes.length === sealNonceBytes
		? Result.ok(nominal<Uint8Array, SealNonce>()(bytes))
		: refused(`${bytes.length} bytes`, `a nonce of ${sealNonceBytes} bytes`)

/**
 * The payload of one batch: the batch sealed under the secret with `nonce`, which no other payload took, in base64,
 * under notifyPayloadMaxBytes since the batch is within batchMaxBytes.
 */
export const sealBatch = (secret: LiveSecret, nonce: SealNonce, batch: LiveBatch): string =>
	seal(secret, nonce, utf8(wellFormed(batch))).toBase64()

/**
 * The notifications a batch's text holds (batchesOf), its texts joined by NUL, each parsed (parseNotification), or the
 * first text that parts from the grammar: a sealed payload's opened text.
 */
const batchNotifications = (
	text: string
): Result.Result<ReadonlyArray<Notification>, LiveTextRefused> =>
	Result.each(text.split(separator), (part) => parseNotification(part))

/**
 * The notifications a payload of the channel holds, or what it parts from a sealed batch at: base64, of a nonce, a
 * ciphertext and a tag that authenticates it under the secret, whose text is notifications joined by NUL. A payload
 * that fails is no sender's of the installation. An opened batch is read as the UTF-8 it is (grizzle-text utf8.ts), never
 * patched with U+FFFD: only a holder of the secret seals one, and the leader seals a batch's text (sealBatch), so one
 * that is no UTF-8 is a defect.
 */
export const openPayload = (
	secret: LiveSecret,
	payload: string
): Result.Result<ReadonlyArray<Notification>, LiveTextRefused> => {
	const sealed = base64Bytes(payload)
	const opened = sealed === undefined ? undefined : open(secret, sealed)
	if (opened === undefined) {
		return refused(payload, "a batch sealed under the installation's live secret, in base64")
	}
	return batchNotifications(
		defined(
			utf8Text(opened),
			"a batch sealed under the live secret is the UTF-8 of its text (sealBatch)"
		)
	)
}

/**
 * A footprint table: a stored relation some served program reads, authored or derived, by its declared name, and the
 * declared fields of it some program fixes to a parameter and routes by, each once, in code point order; none where
 * every change of it routes by its table alone.
 */
export interface LiveTable {
	readonly relation: string
	readonly routes: ReadonlyArray<string>
}

/**
 * What an installation's served read programs read, which a committed change reaches them through: `none` for an
 * installation that serves no read; otherwise each stored relation, authored or derived, as a footprint table, by
 * relation in code point order (LiveTable): a stored derived relation's rows change in the transaction whose writes
 * change them, by the judge's upkeep at its COMMIT. They may be none, for reads of closed relations alone, whose
 * watches still learn of each migration the installation applies (physical/ddl/live.ts).
 */
export type LivePlan =
	| { readonly kind: "none" }
	| {
			readonly kind: "reads"
			readonly tables: ReadonlyArray<LiveTable>
	  }

/** The plan of an installation that serves no read. */
export const noLive: LivePlan = { kind: "none" }

/**
 * An installation's live change source in installed terms, which generate derives from its plan and its names: none
 * where it serves no read, so no publication, decoder login or secret is installed for it; otherwise each published
 * footprint table of a stored relation, authored or derived, by its installed identifier, with the identifiers of the
 * columns it routes by in code point order, which the reader of its changes keys each changed row by.
 */
export type LiveSource =
	| { readonly kind: "none" }
	| {
			readonly kind: "source"
			readonly tables: Readonly<Record<string, ReadonlyArray<string>>>
	  }
