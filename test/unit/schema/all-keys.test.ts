/**
 * The compile refuses every unrepresentable key it meets in one refusal (core/canonical.ts KeyLedger): each check that
 * judges an index entry, ownership's of a declared key, the law model's of an index it plans, the installation's of a
 * UNIQUE over a set its codes size and the index engine's of an index it creates, refuses a key whose entry no index
 * holds and goes on as though it fitted, and the compile ends refusing UnrepresentableKey naming them all, in the order
 * it met them; a refusal of another kind that stops it first gives way to the keys met before it.
 *
 * - The keys of a schema: every unit of every kind (all-keys.fixtures.ts keyKinds), two declared keys and one key of
 *   each other kind, each over a text that fits or over the wildcard, no byte bound proving, a set over a roster of codes
 *   that fit or past them; and an extension schema no installation creates, met after the law model and before the
 *   tables, or none. The box: each unit's key and the later refusal, 2^8 cases, exhausted. The oracle: the kinds of key
 *   README's key rule refuses, each unit's refusal worded as its check words it, the checks in the order a compile runs
 *   them (verdictOf).
 * - keyTextBytes's refusal names every field that faults: drawn fields of a bounded text, a natural, a text of no byte
 *   bound and bytes, a few or past what one index holds. The oracle: INDEX_MAX_KEYS beside the text, and each field's
 *   own bound (schema/representability.ts keyDatums), restated.
 *
 * Features: each kind of key refused, one and several at once, keys of every check at once, nothing refused, and a later
 * refusal behind keys and alone; each fault of keyTextBytes, alone and with others.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, boolean, element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { KeyFault } from "#compiler/core/causes.ts"
import { bytea, natural } from "#compiler/public/fields.ts"
import { keyTextBytes, str } from "#compiler/public/text.ts"
import { indexMaxKeys } from "#compiler/schema/representability.ts"
import { refused, refusedKeys, succeeded } from "#test/support/assert.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	installCase,
	type KeysFeature,
	keyKinds,
	keysCaseSpace,
	verdictOf
} from "#test/unit/schema/all-keys.fixtures.ts"

/** A refused key as the model and the refusal are compared: its subject and its fault's kind. */
const shown = (k: { readonly subject: string; readonly fault: KeyFault["kind"] }): string =>
	`${k.subject}: ${k.fault}`

/** Every unrepresentable key of a schema is refused at once, in the order its checks meet them, each named once; a later refusal of another kind gives way to the keys met before it. */
export const everyUnrepresentableKeyOfASchemaIsRefusedAtOnceInTheOrderItsChecksMeetThemEachNamedOnceALaterRefusalOfAnotherKindGivesWayToTheKeysMetBeforeIt =
	property.exhaust(keysCaseSpace, {
		needs: {},
		situations: [
			"nothing unrepresentable, installed",
			"one key refused",
			"several keys refused at once",
			"keys of every check refused at once",
			"a later refusal behind keys",
			"a later refusal alone",
			...Arr.map(keyKinds, (kind) => `${kind} key refused` as const)
		] satisfies ReadonlyArray<Reached<KeysFeature>>,
		check: (_, c: Case<KeysFeature>) => (keysCase) =>
			Effect.sync(() => {
				const verdict = verdictOf(keysCase)
				const compiled = installCase(keysCase)
				switch (verdict.kind) {
					case "installed":
						succeeded(compiled, "a schema of no unrepresentable key installs")
						c.note("nothing unrepresentable, installed")
						return
					case "later":
						refused(compiled, "MalformedDescription", "the later refusal, no key met before it")
						c.note("a later refusal alone")
						return
					case "keys": {
						const keys = refusedKeys(refused(compiled, "UnrepresentableKey", "the keys met"))
						assert.deepEqual(
							Arr.sort(
								Arr.map(keys, (k) => shown({ subject: k.subject, fault: k.fault.kind })),
								Order.String
							),
							Arr.sort(Arr.map(verdict.keys, shown), Order.String),
							"the refusal names exactly the unrepresentable keys met, each once"
						)
						const stageOf = new Map(Arr.map(verdict.keys, (k) => [k.subject, k.stage] as const))
						const stages = Arr.map(keys, (k) =>
							defined(stageOf.get(k.subject), "a key the model refuses")
						)
						assert.deepEqual(
							stages,
							Arr.sort(stages, Order.Number),
							"the keys stand in the order the compile's checks meet them"
						)
						c.noteAll(
							Arr.map(
								Arr.dedupe(
									Arr.map(
										Arr.filter(keysCase.units, (u) => u.unrepresentable),
										(u) => u.kind
									)
								),
								(kind) => `${kind} key refused` as const
							)
						)
						c.note(keys.length === 1 ? "one key refused" : "several keys refused at once")
						if (Arr.dedupe(stages).length === 4) {
							c.note("keys of every check refused at once")
						}
						if (keysCase.later) {
							c.note("a later refusal behind keys")
						}
						return
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "README's key rule, each unit's refusal as its check words it, the checks in the order a compile runs them"
		},
		box: "two declared keys and one key of each other kind, each fitting or not, and a later refusal or none",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/canonical.ts",
				original: "\t\t\tthis.#met.push(key)\n",
				replacement: "\t\t\tthrow new Refusal(unrepresentableKeys([key]))",
				why: "The compile stops at the first unrepresentable key, refusing it alone: a schema of several is refused one key at a time."
			},
			{
				file: "packages/engine/src/core/canonical.ts",
				original:
					"\treturn first.ok && isNonEmpty(met) ? Result.err(unrepresentableKeys(met)) : first",
				replacement: "\treturn first",
				why: "A compile that met unrepresentable keys and no other refusal installs them: PostgreSQL refuses the first write whose entry outgrows one (54000)."
			},
			{
				file: "packages/engine/src/core/canonical.ts",
				original: "\t\t\t!this.#met.some(",
				replacement: "\t\t\ttrue || !this.#met.some(",
				why: "A key two plans judge alike, a fold's running text on each axis that carries it, named twice."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "\tif (!verdict.ok) {",
				replacement: "\tif (false) {",
				why: "Ownership refuses no declared key, and no later check judges one again: a declared key over a text of no byte bound installs."
			}
		]
	})

/** A field keyTextBytes reads beside its text: one of a byte bound, a natural, a text of no byte bound, or bytes. */
const fieldKinds = ["bounded", "natural", "unbounded", "bytes"] as const
type FieldKind = (typeof fieldKinds)[number]

const descriptorOf = (kind: FieldKind) => {
	switch (kind) {
		case "bounded":
			return str.bytes(16, str.regex("^.*$", "su"))
		case "natural":
			return natural
		case "unbounded":
			return str.regex("^.*$", "su")
		case "bytes":
			return bytea
	}
}

/** The fault of a field beside a key's text: none for a field of a bound. */
const fieldFault = (kind: FieldKind, field: string): Option.Option<KeyFault> => {
	switch (kind) {
		case "bounded":
		case "natural":
			return Option.none()
		case "unbounded":
			return Option.some({ kind: "unboundedText", field })
		case "bytes":
			return Option.some({ kind: "storageOnly", field })
	}
}

type TextBytesFeature =
	| "a budget"
	| "one fault"
	| "several faults"
	| "past the columns an index holds"
	| "a field of no byte bound"
	| "a bytes field"

/** The box: up to three fields of any kinds, alone or filled with naturals to INDEX_MAX_KEYS fields, one more than an
 * index holds beside the text. */
const fieldsSpace = finite((source): ReadonlyArray<FieldKind> => {
	const kinds = source.draw(array(element(fieldKinds), { min: 0, max: 3 }))
	return source.draw(boolean)
		? [...kinds, ...upTo(indexMaxKeys - kinds.length, (): FieldKind => "natural")]
		: kinds
})

/** keyTextBytes's refusal names every field that faults, and more fields than an index holds beside a text, at once; fields that fault nowhere leave the text a budget. */
export const keyTextBytessRefusalNamesEveryFieldThatFaultsAndMoreFieldsThanAnIndexHoldsBesideATextAtOnce =
	property.exhaust(fieldsSpace, {
		needs: {},
		situations: [
			"a budget",
			"one fault",
			"several faults",
			"past the columns an index holds",
			"a field of no byte bound",
			"a bytes field"
		] satisfies ReadonlyArray<Reached<TextBytesFeature>>,
		check: (_, c: Case<TextBytesFeature>) => (kinds) =>
			Effect.sync(() => {
				const columns: ReadonlyArray<KeyFault> =
					kinds.length + 1 > indexMaxKeys ? [{ kind: "columns", limit: indexMaxKeys }] : []
				const faults = [
					...columns,
					...Arr.flatMap(kinds, (kind, i) => Option.toArray(fieldFault(kind, `fields[${i}]`)))
				]
				const budget = catchCompileError(() => keyTextBytes(Arr.map(kinds, descriptorOf)))
				if (!Arr.isReadonlyArrayNonEmpty(faults)) {
					assert.ok(
						succeeded(budget, "fields of bounds leave a budget") > 0,
						"a budget of a byte at least"
					)
					c.note("a budget")
					return
				}
				assert.deepEqual<ReadonlyArray<KeyFault>>(
					Arr.map(
						refusedKeys(refused(budget, "UnrepresentableKey", "fields that fault")),
						(k) => k.fault
					),
					faults,
					"the refusal names every fault, the columns first, then each field's in order"
				)
				c.note(faults.length === 1 ? "one fault" : "several faults")
				c.noteAll(
					Arr.map(faults, (f) =>
						f.kind === "columns"
							? "past the columns an index holds"
							: f.kind === "unboundedText"
								? "a field of no byte bound"
								: "a bytes field"
					)
				)
			}),
		oracle: {
			kind: "specification",
			name: "INDEX_MAX_KEYS beside the text, and each field's own bound as schema/representability.ts keyDatums counts it, restated"
		},
		box: "up to three fields of any kinds, alone or filled with naturals past what an index holds beside a text",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/representability.ts",
				original: "\t\t...each.flatMap((d) => (d.ok ? [] : [d.error]))",
				replacement: "\t\t...each.flatMap((d) => (d.ok ? [] : [d.error])).slice(0, 1)",
				why: "keyTextBytes refuses its first faulting field alone: a consumer fixes its fields one load at a time."
			}
		]
	})
