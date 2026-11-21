import { dictionary } from "@bjornpagen/testing/dictionary"

/** Where a set's members live: beside the entry's retrieval URI, or beside the `$self` it may declare. */
export type Home = "retrieval" | "self"

/** Where an unreached member declares the URI the entry's one schema references: an `$id` or an `$anchor`. */
export type Declaration =
	| "a fragment's $id"
	| "an OpenAPI document's component $id"
	| "an $anchor under its root $id"

/** Which document a 3.2 member's `$self` names: the entry, a member before it, or a member after it. */
export type CollisionFeature = "the entry" | "a member before it" | "a member after it"

/** The lines that have `$id`. */
export const idLines = dictionary<"3.1" | "3.2">(["3.1", "3.2"])

/** Both homes a set's members may live in. */
export const homes = dictionary<Home>(["retrieval", "self"])

/** Every declaration an unreached member may make. */
export const declarations = dictionary<Declaration>([
	"a fragment's $id",
	"an OpenAPI document's component $id",
	"an $anchor under its root $id"
])

/** Every document a 3.2 member's `$self` may name. */
export const collisionFeatures = dictionary<CollisionFeature>([
	"the entry",
	"a member before it",
	"a member after it"
])
