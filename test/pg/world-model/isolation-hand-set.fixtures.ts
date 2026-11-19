/** What the properties of isolation-hand-set.test.ts read: its focus, its requirements and its leads. */
import type { Situations } from "@bjornpagen/testing/features"
import type { WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Tenant and login isolation over the documents base, judged by the worlds model, as a direct writer sets claims by
 * hand: a hand-set claim its field's type refuses, of every type, meets README's SQLSTATE where a statement reads it:
 * 22P02 for no uuid, no integer, no boolean or a handle's name where its code belongs, 22003 for an integer past its
 * range, 23514 for a value its contract, pattern or roster refuses.
 *
 * The isolation suites are four files, isolation-reads, isolation-writes, isolation-claims and isolation-hand-set, each
 * a worker of its own, so they run at once. Realities hold facts outside every world (the owner loads them), so the
 * model's answers over them are README "Security model"'s promise: a role reads exactly its own view, whatever lies
 * outside it.
 *
 * What the hand-set claims suite must reach: each way a hand-set claim's cast refuses it, of every type a context field
 * takes, met where a direct writer's statement reads the context; and a contract's, a pattern's and a roster's
 * refusal met both where a view delivers the claim into an output column and where it reads the claim only in its
 * filter, which no cast to the field's domain in the view's own columns reaches.
 */
export const handSetRequired: Situations<WorldFeature> = [
	"claim-refused:uuid:22P02",
	"claim-refused:text:23514",
	"claim-refused:integer:22P02",
	"claim-refused:integer:22003",
	"claim-refused:boolean:22P02",
	"claim-refused:handle:22P02",
	"claim-refused:handle:22003",
	"claim-refused:handle:23514",
	"claim-refused:contract:22P02",
	"claim-refused:contract:22003",
	"claim-refused:contract:23514",
	"claim-refused-read:contract:filter",
	"claim-refused-read:contract:output",
	"claim-refused-read:text:filter",
	"claim-refused-read:text:output",
	"claim-refused-read:handle:filter",
	"claim-refused-read:handle:output"
]
