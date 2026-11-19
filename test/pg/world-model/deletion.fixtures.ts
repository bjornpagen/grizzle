/** What the properties of deletion.test.ts read: its focus, its requirements and its leads. */
import type { Situations } from "@bjornpagen/testing/features"
import {
	everyWriter,
	type Focus,
	invalidFeatures,
	opIn,
	requiredWhere
} from "#test/support/worlds/drive/suite.ts"
import type { WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Deletion really deletes, over the documents base: programs delete facts through Db entries (whole and query) and as
 * direct writers, read every world relation from sessions of every role, and refresh the derived relation OrgDocs. The
 * worlds model predicts each read, and the driver reads every base table and the derived relation as the owner after
 * each action: a deleted fact leaves its base relation and every world relation at once, and a derived relation keeps
 * it only until a refresh by a role whose refresh list names it, after which no world relation shows it.
 */
export const deleting: Focus = [
	"apply",
	"read",
	"open-db",
	"refresh",
	"close",
	"direct-begin",
	"direct",
	"direct-end"
]

/** A delete accepted, through a Db or as a direct writer. */
const deleted = (f: WorldFeature): boolean =>
	opIn({ kinds: ["apply"], writers: ["db"], observations: ["applied"] })(f) ||
	opIn({ kinds: ["direct", "direct-end"], writers: everyWriter, observations: ["ok"] })(f)

export const required: Situations<WorldFeature> = [
	"deletion:base-gone",
	"deletion:world-gone",
	"deletion:derived-kept",
	"deletion:derived-refreshed",
	...requiredWhere(
		(f) =>
			deleted(f) ||
			opIn({
				kinds: ["refresh"],
				writers: ["db"],
				observations: ["ok", "refused", "handle-refused"]
			})(f)
	),
	...invalidFeatures(["fact:deleted-reference"])
]
