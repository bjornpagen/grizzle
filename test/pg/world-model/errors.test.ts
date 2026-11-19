import { required } from "#test/pg/world-model/errors.fixtures.ts"
import {
	breakingAtCommit,
	dbSession,
	directTransaction,
	docsAtBoundRealities,
	docsInstalls,
	everyAction,
	leadsOf,
	noCheck,
	programProperty
} from "#test/support/worlds/drive/suite.ts"

/** The worlds model: errors: every refusal is the typed outcome the README names, and none carries a value from outside the world. */
export const errors = programProperty({
	installs: docsInstalls,
	focus: everyAction,
	steps: 10,
	cases: 32,
	required,
	realities: docsAtBoundRealities,
	lead: leadsOf(directTransaction(required), dbSession(required), breakingAtCommit(required)),
	check: noCheck,
	kept: []
})
