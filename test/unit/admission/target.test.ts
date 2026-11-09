import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { servedLevel } from "#adapter/admission/snapshots.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { snapshotMismatch } from "#compiler/deploy/admission/target.ts"
import { assert, defined } from "#test/support/assert.ts"
import { firstCodes } from "#test/support/compile.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { draftChain, fromEmpty, noDeclarations, unowned } from "#test/support/migrate/kit.ts"
import { owning } from "#test/support/policy.ts"
import { withB } from "#test/unit/deploy/schemas.ts"

/**
 * Admission's reading of the registered snapshot (deploy/admission/target.ts snapshotMismatch and
 * adapter/admission/snapshots.ts servedLevel): it is the application's exactly when it was installed under the
 * application's PostgreSQL schema and serves the application's schema at its level, whatever it was drafted from.
 *
 * The box, exhausted: a registered snapshot drafted of one of two schemas, installed under one of two PostgreSQL
 * schemas, against an application of one of the same two schemas expecting one of the same two PostgreSQL schemas. The
 * oracle is the rule itself: a mismatch exactly when the schemas or the PostgreSQL schemas differ. Two schemas that differ
 * only in their name are two schemas, and one schema installed under two PostgreSQL schemas is one schema.
 */
type Content = "the schema" | "the schema renamed"
type Placement = "app_one" | "app_two"

const contents: Readonly<Record<Content, typeof withB>> = {
	"the schema": withB,
	"the schema renamed": { ...withB, name: "Other" }
}

/** The snapshot of `content` drafted as its first migration under the PostgreSQL schema `placement`. */
const drafted = (content: Content, placement: Placement) =>
	defined(
		draftChain(
			[
				{
					desc: contents[content],
					options: { schema: atName(placement), owner: unowned, extensions: [], codes: firstCodes },
					declared: noDeclarations
				}
			],
			fromEmpty
		)[0],
		"the first migration's draft"
	).snapshot

const placements: ReadonlyArray<Placement> = ["app_one", "app_two"]

/** Every snapshot of the box, drafted once. */
const snapshots = new Map(
	Arr.flatMap(["the schema", "the schema renamed"] as const, (content) =>
		Arr.map(
			placements,
			(placement) => [`${content} ${placement}`, drafted(content, placement)] as const
		)
	)
)

const draftOf = (content: Content, placement: Placement) =>
	defined(snapshots.get(`${content} ${placement}`), "a snapshot of the box")

interface Side {
	readonly content: Content
	readonly placement: Placement
}

const sideGen: Gen<Side> = (source) => ({
	content: source.draw(element<Content>(["the schema", "the schema renamed"])),
	placement: source.draw(element<Placement>(["app_one", "app_two"]))
})

type TargetFeature = "the application's" | "another schema" | "another placement" | "both other"

describe("the registered snapshot", () => {
	it.effect(
		"is the application's exactly when installed under its PostgreSQL schema and of its schema",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/admission/target",
						generator: (source) =>
							({ registered: source.draw(sideGen), application: source.draw(sideGen) }) as const,
						literal: Formatter.format,
						limit: 16,
						coverage: requiredInSpace<TargetFeature>([
							"the application's",
							"another schema",
							"another placement",
							"both other"
						]),
						box: "a registered snapshot of two schemas under two PostgreSQL schemas, against an application of the same",
						oracle: {
							kind: "specification",
							name: "a mismatch exactly when the schemas or the PostgreSQL schemas differ"
						},
						caseHang
					},
					({ registered, application }, c) =>
						Effect.sync(() => {
							const expected = {
								fingerprint: draftOf(application.content, application.placement).theory.schema,
								schema: identifierOf(identity.schema(parsedSchemaName(application.placement)))
							}
							const otherSchema = registered.content !== application.content
							const otherPlacement = registered.placement !== application.placement
							const snapshot = draftOf(registered.content, registered.placement)
							const mismatch =
								snapshotMismatch(snapshot, expected) !== undefined ||
								Option.isNone(servedLevel(snapshot, owning(contents[application.content])))
							assert.equal(mismatch, otherSchema || otherPlacement)
							c.note(
								otherSchema
									? otherPlacement
										? "both other"
										: "another schema"
									: otherPlacement
										? "another placement"
										: "the application's"
							)
						})
				)
			)
	)
})
