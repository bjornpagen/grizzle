import { constant } from "@bjornpagen/testing/gen"
import { handSetRequired } from "#test/pg/world-model/isolation-hand-set.fixtures.ts"
import {
	handSetTransaction,
	noCheck,
	orgHeldRealities,
	programProperty
} from "#test/support/worlds/drive/suite.ts"
import { docsProfileInstall } from "#test/support/worlds/model/bases/docs.ts"

/** The worlds model: isolation, hand-set claims: a direct writer's hand-set claim its field refuses meets README's SQLSTATE where a statement reads it. */
export const isolationHandSetClaims = programProperty({
	installs: constant(docsProfileInstall),
	focus: ["direct-begin", "direct", "direct-end"],
	steps: 8,
	cases: 16,
	required: handSetRequired,
	realities: orgHeldRealities,
	lead: handSetTransaction(handSetRequired),
	check: noCheck,
	kept: [],
	kills: []
})
