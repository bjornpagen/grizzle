import { constant } from "@bjornpagen/testing/gen"
import { ReplayToken } from "@bjornpagen/testing/property"
import {
	focus,
	installs,
	required,
	domainRefusing,
	drawnKeyRequired,
	ambiguousRequired
} from "#test/pg/world-model/rules.fixtures.ts"
import { witnessesShowTheirOwn } from "#test/support/worlds/drive/acting.ts"
import {
	dbSession,
	drawnRealities,
	leadsOf,
	programProperty
} from "#test/support/worlds/drive/suite.ts"
import { ticketsInstall, ticketsTwoKeysInstall } from "#test/support/worlds/model/bases/tickets.ts"

/** The worlds model: rules: every law family meets writes through partial worlds, and span-keyed and pure-set entries write as the model says. */
export const rules = programProperty({
	installs,
	focus,
	steps: 10,
	cases: 24,
	required,
	realities: drawnRealities,
	lead: leadsOf(dbSession(required), domainRefusing),
	check: witnessesShowTheirOwn,
	kept: []
})

/**
 * The worlds model: rules: a row check refusing a fact whose primary key the database draws names it by the next key it
 * states.
 *
 * Its kept case: a ticket added without its number that repeats a stored ticket at every field it states
 * (TEST_SEED=2026111505, FULLSUITE at fde25114): over stored tickets 1 (t_h) and 2 (t_dnkq), both of no seats, the
 * clerk deletes ticket 1, then adds { code: t_dnkq, seats: 0 }. It meets ticket 2 at its arbiter, the code key, the one
 * declared key holding no field the database draws (README "Writes", Serial columns), and is that ticket: no change. The
 * model that drew a new number for it predicted the code key's refusal. Its token is the old kept sketch's draws by
 * programDraw (ambient, weights, steps and led), then the tape its program drew.
 */
export const rulesDrawnKey = programProperty({
	installs: constant(ticketsInstall),
	focus: ["open-db", "apply", "read", "close"],
	steps: 8,
	cases: 8,
	required: drawnKeyRequired,
	realities: drawnRealities,
	lead: dbSession(drawnKeyRequired),
	check: witnessesShowTheirOwn,
	kept: [
		{
			token: ReplayToken(
				"test/pg/world-model/rules.test.ts#rulesDrawnKey:-:0.0.0.0.0.0.2.0.0.0.0.0.f.0.0.0.0.0.0.0.0.0.0.1.0.2.0.2.0.0.0.1.1.0.0.0.0.0.0.1.1.1.0.0.0.0.0.0.0.0.1.1.0.0.0.1.1.0"
			),
			reason:
				"a ticket added without its number, equal at every field it states to a stored one, is no change",
			since: "2026-11-19"
		}
	]
})

/** The worlds model: rules: an insertion that may leave the drawn number out, beside two keys holding none, is refused when it compiles. */
export const rulesAmbiguousArbiter = programProperty({
	installs: constant(ticketsTwoKeysInstall),
	focus: ["open-db", "apply", "read", "close"],
	steps: 4,
	cases: 4,
	required: ambiguousRequired,
	realities: drawnRealities,
	lead: dbSession(ambiguousRequired),
	check: witnessesShowTheirOwn,
	kept: []
})
