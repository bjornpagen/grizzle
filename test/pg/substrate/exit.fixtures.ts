/** What the property of exit.test.ts reads: its space, the child it runs, and the kinds of resource a leak holds. */

import { boolean, element, type Gen } from "@bjornpagen/testing/gen"

/** The child's case (exit.child.ts ExitCase). */
interface ExitCase {
	readonly dbs: 0 | 1 | 2
	readonly read: boolean
}

const dbCounts = [0, 1, 2] as const

export const caseGen: Gen<ExitCase> = (source) => {
	const dbs = source.draw(element(dbCounts))
	return { dbs, read: dbs > 0 && source.draw(boolean) }
}

/** The kinds of resource that hold a process open and that a closed scope must have ended. */
export const leaked = Object.freeze([
	"TCPSocketWrap",
	"TCPWrap",
	"TCPConnectWrap",
	"ConnectWrap",
	"Timeout",
	"Immediate"
])

/**
 * The child, by its path from the checkout's root: a case runs it from the checkout its worker runs in (Checkout.dir),
 * so under a kill the child loads the mutant from the worker tree that holds it on disk.
 */
export const childModule = "test/support/substrate/exit.child.ts"

export type Feature = `${0 | 1 | 2} Dbs${"" | ", read"}`
