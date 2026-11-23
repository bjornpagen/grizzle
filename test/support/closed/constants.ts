/**
 * A roster's installed constants as the pg suites read them back from PostgreSQL's catalog: the live-codes constant its
 * domain's CHECK depends on, the names constant a view's decoded column depends on, each checked to be an IMMUTABLE
 * function of no argument and no SET clause, and the live codes a live-codes constant holds, beside the model's.
 */
import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { setText } from "#test/support/closed/bit-text.ts"
import { type RosterState, sizeOf } from "#test/support/closed/generate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** The facts every roster constant must have: an IMMUTABLE function of no argument and no SET clause, returning
 * `returns`. */
const constantFacts = (returns: string) => ({
	args: "0",
	volatility: "i",
	kind: "f",
	definer: "false",
	unset: "true",
	returns
})

/** The one function rows of pg_depend name, by its schema and name, each row its facts, checked to be a constant
 * returning `returns`: what `what` names. */
const oneConstant = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>,
	returns: string,
	what: string
): { readonly call: string; readonly schema: string; readonly name: string } => {
	assert.equal(rows.length, 1, `${what} is one function`)
	const [schemaName, name, args, volatility, kind, definer, unset, returned] = trusted<
		readonly [string, string, string, string, string, string, string, string]
	>(defined(rows[0]))
	assert.deepEqual(
		{ args, volatility, kind, definer, unset, returns: returned },
		constantFacts(returns),
		what
	)
	return { call: `${quoteIdent(schemaName)}.${quoteIdent(name)}()`, schema: schemaName, name }
}

/** The facts of a function by its pg_proc row, from its schema and name on: what oneConstant reads. */
const procFacts =
	"n.nspname::text, p.proname::text, p.pronargs::text, p.provolatile::text, p.prokind::text, p.prosecdef::text, (p.proconfig IS NULL)::text, p.prorettype::regtype::text"

/**
 * The function a domain's CHECK depends on, by pg_depend: its roster's live-codes constant, which a CHECK that depends
 * on other than one function fails.
 */
export const liveConstantOf = (
	session: RawSession,
	domain: { readonly schema: string; readonly name: string }
) =>
	Effect.map(
		session.values(
			`SELECT ${procFacts} FROM pg_catalog.pg_constraint AS c JOIN pg_catalog.pg_depend AS d ON d.classid = 'pg_catalog.pg_constraint'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_catalog.pg_proc'::regclass JOIN pg_catalog.pg_proc AS p ON p.oid = d.refobjid JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE c.contypid = $1::text::regtype`,
			[printObjectName(domain)]
		),
		(rows) =>
			oneConstant(rows, "bit varying", `the live-codes constant the CHECK of ${domain.name} reads`)
	)

/** A live-codes constant's bits as their text, and the model's: a set of the live codes at a set's width (setText). */
export const liveHeld = (session: RawSession, call: string) =>
	Effect.map(session.values(`SELECT ${call}::text`, []), (rows) => String(defined(rows[0])[0]))

/** The live codes of a model's state as a set's text, its live-codes constant's bits. */
export const modelLive = (state: RosterState): string =>
	setText(
		sizeOf(state),
		Arr.flatMap(state.slots, (slot, code) => (slot.kind === "live" ? [code] : []))
	)
