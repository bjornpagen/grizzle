import { describe, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import { refusalText } from "#cli/refusals.ts"
import { markerLine } from "#cli/run.ts"
import { confirmMarker, findMarkers, placeholderMarker } from "#compiler/deploy/render/markers.ts"
import { placeholderToken } from "#compiler/sql/print.ts"
import { assert } from "#test/support/assert.ts"

/**
 * A drafted folder's markers as generate prints them: every marker kind, placeholder and confirm, is printed under its
 * own kind with its own kind's fix, never another's.
 *
 * The oracle is the refusal table (cli/refusals.ts), which the skill documents word for word: each kind's line is its
 * file, line, kind and that kind's fix, and the kinds' fixes differ, so a confirm told to fill a placeholder fails.
 */
describe("a drafted folder's markers", () => {
	it("are printed under their own kind with their own kind's fix", () => {
		const text = Arr.join(
			[
				placeholderMarker,
				`UPDATE "s"."t" SET "c" = ${placeholderToken};`,
				`${confirmMarker}: a holder set aside`,
				"-- keep every statement below as drafted",
				'ALTER TABLE "s"."t" RENAME TO "t__aside";'
			],
			"\n"
		)
		const markers = Arr.map(findMarkers(text), (m) => ({ file: "01-structure.sql", ...m }))
		assert.deepEqual(
			Arr.map(markers, (m) => m.kind),
			["placeholder", "placeholder", "confirm"],
			"a placeholder's marker line and its token's line, and a confirm's marker line"
		)
		assert.deepEqual(
			Arr.map(markers, (m) => markerLine("migrations/s/f", m)),
			[
				`migrations/s/f/01-structure.sql:1: placeholder: ${refusalText.placeholder.fix}`,
				`migrations/s/f/01-structure.sql:2: placeholder: ${refusalText.placeholder.fix}`,
				`migrations/s/f/01-structure.sql:3: confirm: ${refusalText.confirm.fix}`
			]
		)
		assert.notEqual(
			refusalText.confirm.fix,
			refusalText.placeholder.fix,
			"each kind has a fix of its own"
		)
	})
})
