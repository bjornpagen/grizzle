/**
 * A generated field in a primary key, a key generation (INTERFACE.md of lane GENPK, §1 and §4): grizzle writes it on
 * every insert and PostgreSQL proves it by a row CHECK, so a key generation reads only fields its caller writes, which
 * every write states before grizzle fills anything. A generation that reads a field grizzle draws from the nesting,
 * accumulates along an axis, stamps as a place, or sets as a retirement, reads a value no key head states, and is
 * refused when its schema compiles, GeneratedRefused at the field, naming its least such read by code units and how
 * that read is written.
 *
 * The box: four templates, each a relation built by relation.generated whose fields are written in every way its
 * statements make lawful: an ordered family with a concat fold (drawn `at`, accumulated `before` and `after`), a tree
 * with a concat fold, keyed by its root fields and its start as pantry's Node is (drawn `parent`, `at`, `children`,
 * `start` and `end`, three accumulated texts), a place in its group (`n`), and a retirable header (`retired`); and
 * beside them caller texts, one past every key's bound, and caller integers. Each case draws a nonempty subset of its
 * template's fields, half the time among its caller's alone, and builds the generation `g` over them: their texts
 * concatenated, a field that is no text entering through a conditional over it, so every read is a term's read. It
 * compiles the schema twice: with `g` completing the template's primary key, and, its control, with `g` outside every
 * key and a bounded caller text completing the key in its place.
 *
 * Oracle: the rule restated over the reads the case drew. The control compiles whatever `g` reads, as a generated
 * field no key holds reads any field of its row, so a refusal of the keyed schema is its key's; the keyed schema
 * compiles exactly when every read is its caller's, and is otherwise refused at `g` for its least non-caller read. A
 * retirable header's key holding a generation is refused whatever it reads, UnsupportedOperation, its bodies' copies
 * of the header's key written by no fill (GENPK-A, first cut).
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import {
	admissionOf,
	foreignWritings,
	keyGenerationGen,
	type KeyGenerationCase,
	type KeyGenerationFeature,
	keyedVerdictOf,
	keyReadRule,
	type MemberForm,
	memberGroupAdmission,
	memberGroupAdmitted,
	memberGroupGen,
	type Readable
} from "#test/unit/schema/key-generation.fixtures.ts"

/**
 * That `error` refuses the generated field `g` of its relation for its read `read`, which its caller does not write:
 * GeneratedRefused at `g`, its rule naming the read and how it is written.
 */
const keyReadRefused = (error: CompileError, read: Readable, shown: string): void => {
	const reason = error.reason
	if (reason._tag !== "GeneratedRefused") {
		return assert.fail(`${shown}: GeneratedRefused, not ${reason._tag}`)
	}
	assert.equal(reason.field, "g", `${shown}: refused at the key generation`)
	assert.deepEqual<unknown>(
		reason.rule,
		keyReadRule(read),
		`${shown}: refused for its least read its caller does not write`
	)
}

/** A case's two compiles judged against the rule: the control always compiles, and the key exactly when its caller writes every read. */
const judged = (k: KeyGenerationCase, c: Case<KeyGenerationFeature>): void => {
	const shown = Formatter.format(k)
	succeeded(admissionOf(k, "control"), `${shown}: the generation outside every key compiles`)
	const verdict = keyedVerdictOf(k)
	const keyed = admissionOf(k, "key")
	switch (verdict.kind) {
		case "admitted": {
			succeeded(keyed, `${shown}: a key generation over caller fields alone compiles`)
			c.note(`admitted in the ${verdict.template} template`)
			if (Arr.some(k.reads, (r) => r.field === "body")) {
				c.note("admitted: reads an unbounded text")
			}
			return
		}
		case "refused": {
			keyReadRefused(
				refused(keyed, "GeneratedRefused", `${shown}: refused for its key's read`),
				verdict.read,
				shown
			)
			const [only, ...more] = foreignWritings(k)
			if (only !== undefined && more.length === 0) {
				c.note(`refused: its ${only} read`)
			} else {
				c.note("refused: reads several writings outside its caller's")
			}
			return
		}
		case "retirement over a generated key": {
			if (
				!keyed.ok &&
				keyed.error.reason._tag === "GeneratedRefused" &&
				verdict.read !== undefined
			) {
				keyReadRefused(keyed.error, verdict.read, shown)
			} else {
				refused(keyed, "UnsupportedOperation", `${shown}: a retirable header over a generated key`)
			}
			c.note("refused: a retirable header over a generated key")
			return
		}
	}
}

/**
 * A key generation is admitted exactly when its caller writes every field it reads, and its relation's other writings
 * leave a generation outside the key alone.
 */
export const aKeyGenerationIsAdmittedExactlyWhenItsCallerWritesEveryFieldItReads = property.explore(
	keyGenerationGen,
	{
		needs: {},
		situations: [
			"admitted in the ordered template",
			"admitted in the tree template",
			"admitted in the placed template",
			"admitted: reads an unbounded text",
			"refused: its drawn read",
			"refused: its accumulated read",
			"refused: its place read",
			"refused: reads several writings outside its caller's",
			"refused: a retirable header over a generated key"
		] satisfies ReadonlyArray<Reached<KeyGenerationFeature>>,
		check: (_, c: Case<KeyGenerationFeature>) => (k) => Effect.sync(() => judged(k, c)),
		oracle: {
			kind: "specification",
			name: "INTERFACE.md §4 restated over the drawn reads: a key generation reads caller fields alone, its least other read named; a generation outside every key is admitted"
		},
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/generated.ts",
				original:
					'\t\tif (writing !== undefined) {\n\t\t\treturn { kind: "keyReadsUnwritten", read, writing }',
				replacement:
					'\t\tif (writing !== undefined && writing !== "drawn") {\n\t\t\treturn { kind: "keyReadsUnwritten", read, writing }',
				why: "A key generation over a drawn field admitted: its key would read a slot grizzle draws after the key is compared."
			},
			{
				file: "packages/engine/src/ir/desc.ts",
				original: '\t\tcase "place":\n\t\tcase "generated":\n\t\t\treturn true',
				replacement: '\t\tcase "place":\n\t\t\treturn true\n\t\tcase "generated":',
				why: "Every generated field refused in a primary key, the rule before GENPK: a key generation over caller fields alone would not compile."
			}
		]
	}
)

/**
 * A family's member over an owner whose key holds a generation groups by the owner's key exactly as INTERFACE.md §3
 * admits: its own key generation of the owner's expression over its same-named read (form (a)), or a caller field the
 * fill copies the owner's value into (form (b)); a member generating its group by another expression, or over another
 * field, names no owner by it and is refused, MalformedDescription.
 *
 * The box: the owner's generation, a path's ASCII lowering or its whitespace collapsed, by every member form (the same,
 * over another read, another expression, a copy). Oracle: the rule restated.
 */
export const aMemberOverAKeyGenerationGroupsByTheOwnersGenerationOrACopyOfIt = property.exhaust(
	finite(memberGroupGen),
	{
		needs: {},
		situations: [
			"admitted: same",
			"admitted: copied",
			"refused: otherRead",
			"refused: otherExpression"
		] satisfies ReadonlyArray<Reached<`${"admitted" | "refused"}: ${MemberForm}`>>,
		check: (_, c: Case<`${"admitted" | "refused"}: ${MemberForm}`>) => (m) =>
			Effect.sync(() => {
				const shown = Formatter.format(m)
				const outcome = memberGroupAdmission(m)
				if (memberGroupAdmitted(m)) {
					succeeded(outcome, `${shown}: a member grouped by the owner's generation or its copy`)
					c.note(`admitted: ${m.member}`)
				} else {
					refused(outcome, "MalformedDescription", `${shown}: a member generating another group`)
					c.note(`refused: ${m.member}`)
				}
			}),
		oracle: {
			kind: "specification",
			name: "INTERFACE.md §3 restated: a member's group over an owner's key generation is that generation over its same-named read, or a copy"
		},
		box: "the owner's generation, lowered or collapsed, by every member form: the same generation, over another read, another expression, a copied caller field",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/families.ts",
				original: '\t\tif (g.writing.kind === "keyGenerated" && !sameGeneration(g, key)) {',
				replacement: "\t\tif (g.writing.kind !== g.writing.kind) {",
				why: "Every member's key generation admitted as its group, whatever it generates: a member over another read or another expression would key its rows apart from the owner its group names."
			}
		]
	}
)
