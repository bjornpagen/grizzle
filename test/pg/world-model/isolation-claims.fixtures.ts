/** What the properties of isolation-claims.test.ts read: its focus, its requirements and its leads. */
import type { Situations } from "@bjornpagen/testing/features"
import {
	invalidFeatures,
	invalidKindsWith,
	opIn,
	requiredWhere
} from "#test/support/worlds/drive/suite.ts"
import type { WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Tenant and login isolation over the documents base, judged by the worlds model, as a Db's claims decode: a Db's
 * contexts hold exactly the facts its verified token decodes to, a claim of every type a context field takes read
 * through a rule (the Profile context of docsProfileInstall: a uuid, a text whose pattern needs PostgreSQL to read it as
 * ECMAScript does, an integer of each width, a boolean, a closed id and a contract), a refined claim at its bounds or
 * past them judged by PostgreSQL (invalid:token:refinement-edge).
 *
 * The isolation suites are four files, isolation-reads, isolation-writes, isolation-claims and isolation-hand-set, each
 * a worker of its own, so they run at once. Realities hold facts outside every world (the owner loads them), so the
 * model's answers over them are docs/access.md "Security model"'s promise: a role reads exactly its own view, whatever lies
 * outside it.
 */
export const claimsRequired: Situations<WorldFeature> = [
	...requiredWhere(
		(f) =>
			opIn({ kinds: ["open-db"], writers: ["db"], observations: ["opened", "open-refused"] })(f) ||
			opIn({ kinds: ["read"], writers: ["db"], observations: ["rows"] })(f)
	),
	...invalidFeatures(invalidKindsWith("token:")),
	"claim:uuid",
	"claim:text",
	"claim:integer",
	"claim:boolean",
	"claim:handle",
	"claim:contract"
]
