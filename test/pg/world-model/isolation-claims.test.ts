import { constant, oneOf } from "@bjornpagen/testing/gen"
import { claimsRequired } from "#test/pg/world-model/isolation-claims.fixtures.ts"
import {
	dbSession,
	docsInstalls,
	docsTenantRealities,
	noCheck,
	programProperty
} from "#test/support/worlds/drive/suite.ts"
import { docsProfileInstall } from "#test/support/worlds/model/bases/docs.ts"

/** The worlds model: isolation, claims: a Db's contexts hold exactly the facts its verified claims decode to. */
export const isolationClaims = programProperty({
	installs: oneOf([docsInstalls, constant(docsProfileInstall)]),
	focus: ["open-db", "read", "close", "wild"],
	steps: 8,
	cases: 32,
	required: claimsRequired,
	realities: docsTenantRealities,
	lead: dbSession(claimsRequired),
	check: noCheck,
	kept: []
})
