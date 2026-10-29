import { describe, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import {
	findMarkers,
	isNoTransaction,
	noTransactionMarker,
	placeholderMarker,
	placeholderToken,
	renameMarker
} from "#compiler/deploy/render/markers.ts"
import { assert } from "#test/support/assert.ts"

describe("markers", () => {
	it("a file runs statement by statement exactly when its first line is the no-transaction marker", () => {
		assert.equal(
			isNoTransaction(`${noTransactionMarker}\nCREATE INDEX CONCURRENTLY x ON t (a);`),
			true
		)
		assert.equal(isNoTransaction(`${noTransactionMarker}  \r\nSELECT 1;`), true)
		assert.equal(isNoTransaction(`\n${noTransactionMarker}\nSELECT 1;`), false)
		assert.equal(isNoTransaction(`SELECT 1; ${noTransactionMarker}`), false)
	})

	it("finds every unresolved placeholder and candidate rename, by line", () => {
		const text = Arr.join(
			[
				`${placeholderMarker}: supply the value`,
				`ALTER TABLE "s"."t" ADD COLUMN "c" integer DEFAULT ${placeholderToken} NOT NULL;`,
				`  ${renameMarker}: maybe`,
				"SELECT 1;"
			],
			"\n"
		)
		assert.deepEqual(findMarkers(text), [
			{ kind: "placeholder", line: 1 },
			{ kind: "placeholder", line: 2 },
			{ kind: "rename", line: 3 }
		])
		assert.deepEqual(
			findMarkers(`ALTER TABLE "s"."t" ADD COLUMN "c" integer DEFAULT 0 NOT NULL;`),
			[]
		)
	})
})
