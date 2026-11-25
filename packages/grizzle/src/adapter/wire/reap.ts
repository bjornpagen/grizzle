/**
 * A pooled session's reap window: how long its server lets the session's connection go silent before it may end it
 * unseen by the client, read from the server by the statement every served file's session carries (engine
 * served/forms.ts ServedSession reapWindow), which is also the probe a pool sends a session idle that long before a
 * lease runs anything on it (wire/pool.ts makePool).
 *
 * A server ends an idle session's connection itself in two ways. Its TCP keepalive sends a probe after
 * tcp_keepalives_idle seconds of silence, again every tcp_keepalives_interval seconds, and ends the connection after
 * tcp_keepalives_count go unanswered; and idle_session_timeout, when set, ends a session idle outside a transaction for
 * that many milliseconds. A live client answers every keepalive probe and reads the end idle_session_timeout sends, so
 * neither leaves it a session it believes open. A client that cannot answer, its process or its machine frozen as a
 * serverless platform freezes an instance between requests, answers none and misses the end its server sends while it
 * is frozen: once it runs again, the first statement it sends on the session is answered by a reset, its COMMIT already
 * written. So a session silent for less than its window is still open on its server, as far as either way goes, and
 * one silent for longer may not be.
 */
import { Brand } from "effect"
import type { OutputText } from "#compiler/plan/common.ts"

/** A reap window, in milliseconds of silence. */
export type ReapWindow = number & Brand.Brand<"ReapWindow">

const reapWindow = Brand.nominal<ReapWindow>()

const millisPerSecond = 1000

/** A cell that holds a whole number at least 0, or none. */
const wholeOf = (cell: OutputText | undefined): number | undefined => {
	const value = Number(cell)
	return cell !== undefined && cell !== "" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined
}

/**
 * The window of a server's settings: the keepalive's, its idle time and every probe it waits for, and
 * idle_session_timeout's where it is set and shorter.
 */
const reapWindowOf = (
	keepalivesIdle: number,
	keepalivesInterval: number,
	keepalivesCount: number,
	idleSessionTimeout: number
): ReapWindow => {
	const keepalive = (keepalivesIdle + keepalivesCount * keepalivesInterval) * millisPerSecond
	return reapWindow(idleSessionTimeout > 0 ? Math.min(keepalive, idleSessionTimeout) : keepalive)
}

/**
 * The window the read's one row states, its cells tcp_keepalives_idle, tcp_keepalives_interval, tcp_keepalives_count
 * and idle_session_timeout, each a whole number in its unit; none for a row that states no such four.
 */
export const reapWindowRow = (cells: ReadonlyArray<OutputText>): ReapWindow | undefined => {
	const [idleCell, intervalCell, countCell, timeoutCell, ...rest] = cells
	const idle = wholeOf(idleCell)
	const interval = wholeOf(intervalCell)
	const count = wholeOf(countCell)
	const timeout = wholeOf(timeoutCell)
	return rest.length > 0 ||
		idle === undefined ||
		interval === undefined ||
		count === undefined ||
		timeout === undefined
		? undefined
		: reapWindowOf(idle, interval, count, timeout)
}
