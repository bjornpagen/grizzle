/**
 * A generated field's cast into its own type is the column's own (analysis/schema.ts #generated): PostgreSQL admits a
 * generated column's value into the column's type as the cast does, so `generated(K, Type.cast(e, K))`, its cast
 * proved, and `generated(K, e)` are one field, of one installation script and one snapshot record, the bare one's. A
 * cast into another type stays: its domain is another than the column's. pantry wrote thirteen dead casts of a collapse into its key text, each an explicit CoerceToDomain beside
 * the implicit one PostgreSQL's cookDefault adds, which pg_get_expr prints apart.
 *
 * The oracle is the schema written without the cast, read through the same compile: a specification. The box,
 * exhausted: the cast into the field's own type, or into a wider text.
 *
 * Features: a cast into the field's own type, and one into a wider text.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { Text, Type } from "#compiler/public/compute.ts"
import { generated, int4 } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { succeeded } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import {
	asDrafted,
	compile,
	draftedAt,
	fromEmpty,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"

type Target = "own" | "wider"

const targetGen: Gen<Target> = (source) => source.draw(element(["own", "wider"] as const))

const keyText = str.bytes(64, str.regex("^.*$", "su"))
const wideText = str.bytes(128, str.regex("^.*$", "su"))

/** The schema of one generated field of the key text, its collapse of `x` cast into the key text itself (`own`) or
 * into a wider text (`wider`), which `w` is of, or written as it is. */
const schemaOf = (target: Target, cast: boolean) =>
	schema(
		"Casts",
		[
			relation.generated("T", { id: int4, x: keyText, w: wideText }, ["id"], (r) => ({
				g: generated(
					keyText,
					!cast
						? Text.collapse(r.x)
						: target === "own"
							? Type.cast(Text.collapse(r.x), keyText)
							: Type.cast(Text.collapse(r.x), wideText)
				)
			}))
		],
		[]
	)

/** A schema's install script and its field's snapshot record. */
const readingsOf = (target: Target, cast: boolean) => {
	const installation = compile(schemaOf(target, cast), asDrafted)
	const drafted = succeeded(
		generate({
			installation,
			timestamp: draftedAt(1),
			previous: fromEmpty,
			workload: noWorkload,
			declared: noDeclarations,
			name: "casts"
		})
	)
	const t = drafted.snapshot.theory.relations["T"]
	return {
		sql: installationSql(installation, "casts"),
		writing: t?.kind === "relation" ? Arr.findFirst(t.fields, (f) => f.name === "g") : undefined
	}
}

/** A cast into the field's own type is no cast: one installation and one record, whichever spelling. */
export const aGeneratedFieldsCastIntoItsOwnTypeIsItsOperandOneScriptAndOneRecordAndACastIntoAnotherStays =
	property.exhaust(finite(targetGen), {
		box: "a generated field of a byte-bounded text, its collapse cast into the field's own type or into a wider text",
		needs: {},
		situations: ["own", "wider"] satisfies ReadonlyArray<Reached<Target>>,
		check: (_, c: Case<Target>) => (target) =>
			Effect.sync(() => {
				c.note(target)
				const written = readingsOf(target, true)
				const bare = readingsOf(target, false)
				if (target === "wider") {
					assert.notDeepEqual(written.sql, bare.sql, "a cast into another type stays")
					return
				}
				assert.deepEqual(written.sql, bare.sql, "one installation script")
				assert.deepEqual(written.writing, bare.writing, "one snapshot record")
			}),
		oracle: {
			kind: "specification",
			name: "the schema written without the cast, read through the same compile"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: "\t\t\t\t? lowered(expr.arg)\n",
				replacement: "\t\t\t\t? undefined\n",
				why: "A cast into the field's own type kept: its explicit CoerceToDomain is another SQL and another record than the column's own, so pantry's thirteen dead casts rewrite their tables."
			}
		]
	})
