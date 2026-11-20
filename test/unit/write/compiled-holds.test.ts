/**
 * A compiled write holds the nodes its frontend names and none of the analyses its compile read them from
 * (write/frontend/compile.ts restatedIn, WriteFrontend `restate`): the restated form's counterpart of each node the
 * write names is a map of nodes, where a Counterpart closed over the restatement's two analyses held their folds, every
 * node's logical properties with its functional dependencies and their bitsets, for as long as the compiled write
 * lived, which a generate holds for every write of every login to its end.
 *
 * The box, exhausted: a write of one member and of eight reading one call of eight bound imports, a chain of eight
 * levels of bound queries (shared-imports.fixtures.ts), and the worked example's put, delete and insert over Work.
 *
 * Property, per case: the folds alive once the write is compiled, the compiled write held, are those alive before its
 * compile, counted by V8 after a full collection (node:v8 queryObjects over ir/fold.ts Fold). Oracle: specification, a
 * compile's folds are its own. Kill: the frontend holds the counterpart that read the analyses beside its map, as it
 * did, so every compiled write holds its restatement's folds.
 *
 * Features: one member, several members.
 */

import { queryObjects } from "node:v8"
import { assert } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { Fold } from "#compiler/ir/fold.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	type FixtureSchema,
	realityWrite,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import { Work } from "#test/support/fixtures/api/work.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, switchToManual } from "#test/unit/write/changeset/fixtures.ts"
import { chainWriteOf, readersOf, Shared } from "#test/unit/write/shared-imports.fixtures.ts"

type Feature = "one member" | "several members"

/** A case's write: the shared-imports writes over Shared, or the worked example over Work. */
type Shape =
	| "one reader of a call"
	| "eight readers of a call"
	| "a chain of eight levels"
	| "the worked example"

/** A case's schema, its ChangeSet and how many members it writes. */
interface Written {
	readonly schema: FixtureSchema
	readonly change: unknown
	readonly members: number
}

const writtenOf = (shape: Shape): Written => {
	switch (shape) {
		case "one reader of a call":
			return { schema: Shared, change: readersOf(1), members: 1 }
		case "eight readers of a call":
			return { schema: Shared, change: readersOf(8), members: 8 }
		case "a chain of eight levels":
			return { schema: Shared, change: chainWriteOf(8), members: 1 }
		case "the worked example":
			return { schema: Work, change: switchToManual(), members: 3 }
	}
}

/** The folds alive, counted by V8 after a full collection. */
const foldsAlive = (): number => queryObjects(Fold, { format: "count" })

/** A compiled write holds none of its compile's folds: those alive while it is held are those alive before its compile. */
export const aCompiledWriteHoldsNoneOfItsCompilesFoldsThoseAliveWhileItIsHeldAreThoseAliveBeforeItsCompile =
	property.exhaust(
		finite((source) =>
			source.draw(
				element<Shape>([
					"one reader of a call",
					"eight readers of a call",
					"a chain of eight levels",
					"the worked example"
				])
			)
		),
		{
			needs: {},
			situations: ["one member", "several members"],
			check: (_, k: Case<Feature>) => (shape) =>
				Effect.sync(() => {
					const written = writtenOf(shape)
					k.note(written.members === 1 ? "one member" : "several members")
					const reality = realityWrite(succeeded(testArtifacts(written.schema, testCompile)))
					const desc = descOf(written.change)
					const before = foldsAlive()
					const program = succeeded(compileWrite(checking(written.schema), desc, reality))
					assert.equal(foldsAlive(), before, `${shape}: the compiled write holds no fold`)
					assert.ok(program.frontend.restate.size > 0, `${shape}: the write names nodes`)
				}),
			oracle: { kind: "specification", name: "a compile's folds are its own" },
			box: "one and eight readers of one call of eight bound imports, a chain of eight bound levels, and the worked example's put, delete and insert",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/write/frontend/compile.ts",
					original: "\treturn { restated, restate }\n}",
					replacement: "\treturn { restated, restate, at }\n}",
					why: "The frontend holds the counterpart that read the restatement's analyses beside its map, as it held it before, so every compiled write holds two analyses' folds and the folds alive grow by them."
				}
			]
		}
	)
