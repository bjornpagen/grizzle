/**
 * The host's same-key checks of a written relation's additions, decided where the relation is written
 * (runtime/write/normalize.ts HostChecks): its declared keys the host holds every field of, a key generation's by its
 * generation, which the host fills before it compares any, and its span keys the probe leaves to the host.
 */
import type { LawId } from "#compiler/core/ids.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import type { Stamped } from "#compiler/ir/instant.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type {
	HostChecks,
	HostKey,
	HostKeyField,
	HostSpanKey,
	KeyGeneration
} from "#compiler/runtime/write/normalize.ts"
import type { RecordedLaw } from "#compiler/types/changeset/changeset.ts"
import { hostHeld, type RelationUniques } from "#compiler/write/insert/unique.ts"

/** A key field of the relation's facts, by its name, with its type (runtime/write/normalize.ts HostKeyField). */
const hostKeyField = (f: LawField): HostKeyField => ({ field: f.name, type: f.type })

/**
 * Every key generation of a written relation's fields, with the table of its generation, which the host fills each
 * stated fact by before any key is compared or any row sent (runtime/write/normalize.ts KeyGeneration): the relation's
 * own, whichever of its keys the host checks.
 */
export const keyGenerations = (fields: ReadonlyArray<LawField>): ReadonlyArray<KeyGeneration> =>
	fields.flatMap((f) =>
		f.writing.kind === "keyGenerated"
			? [{ field: f.name, type: f.type, generation: predicateTable(f.writing.expr) }]
			: []
	)

/**
 * The fields at which the host holds a key of rows that leave out `stamped`, the fields their statement fills (ir/instant.ts
 * Stamped): every field of it the host holds a fact's value at (insert/unique.ts `hostHeld`), and none of a stamped field
 * whose stamp is the call's one value (Stamp `call`), or a head's where the key holds every field of the stamp's child:
 * every row of one call that agrees at the child carries one stamp, so two rows the key holds apart differ at its other
 * fields. None where it holds another field no fact holds, or a head's stamped field without its child, which rows of one
 * call may stamp apart: only their statement compares them.
 */
const heldAt = (
	fields: ReadonlyArray<LawField>,
	stamped: ReadonlyArray<Stamped>
): ReadonlyArray<LawField> | undefined => {
	const held: Array<LawField> = []
	for (const f of fields) {
		const stamp = stamped.find((s) => s.field.name === f.name)
		if (stamp !== undefined) {
			if (
				stamp.stamp.kind !== "call" &&
				!stamp.stamp.child.every((c) => fields.some((g) => g.name === c.name))
			) {
				return undefined
			}
			continue
		}
		if (!hostHeld(f)) {
			return undefined
		}
		held.push(f)
	}
	return held
}

/** The host checks of a relation's keys, each at the fields it holds of rows that leave out `stamped` (`heldAt`), and of
 * its span candidate keys whose every field such a row holds. */
export const hostChecks = (
	keyLaws: ReadonlyArray<{
		readonly fields: ReadonlyArray<LawField>
		readonly law: LawId
		readonly described: RecordedLaw
	}>,
	uniques: RelationUniques,
	stamped: ReadonlyArray<Stamped>
): HostChecks =>
	Object.freeze({
		keys: keyLaws.flatMap((k): ReadonlyArray<HostKey> => {
			const held = heldAt(k.fields, stamped)
			return held === undefined
				? []
				: [Object.freeze({ law: k.law, described: k.described, fields: held.map(hostKeyField) })]
		}),
		spans: uniques.checks.flatMap(({ object: check, pairs }) =>
			check.kind !== "span" ||
			pairs !== "host" ||
			[...check.equal, check.span].some((f) => stamped.some((s) => s.field.name === f.name))
				? []
				: [
						Object.freeze({
							law: check.law,
							described: check.described,
							equal: check.equal.map(hostKeyField),
							span: { field: check.span.name, type: check.span.type }
						})
					]
		)
	})

/**
 * The host checks of a relation's additions in a stratum whose insert computes `computed`, fields its host rows leave
 * out, every row of the call holding the call's one value of each (ir/instant.ts Stamp `call`), which only the
 * statement that writes the rows computes: a key or span key over no computed field compares every addition, as the
 * relation's own checks do (`hostChecks`); one over a computed field compares the puts' at all of its fields and the
 * inserted facts' at its other fields alone (runtime/write/normalize.ts KeyCompares), since two rows of one call that
 * agree there agree at it too; and a span key whose span the call computes is, for the inserted facts, a key of its
 * compared fields, since every span is nonempty (scalar/values/span.ts) and the call's one span overlaps itself.
 */
export const computedChecks = (
	keyLaws: ReadonlyArray<{
		readonly fields: ReadonlyArray<LawField>
		readonly law: LawId
		readonly described: RecordedLaw
	}>,
	uniques: RelationUniques,
	computed: ReadonlyArray<Stamped>
): HostChecks => {
	const own = hostChecks(keyLaws, uniques, [])
	const computes = (f: { readonly field: string }): boolean =>
		computed.some((s) => s.field.name === f.field)
	const held = (fields: ReadonlyArray<HostKeyField>): ReadonlyArray<HostKeyField> =>
		fields.filter((f) => !computes(f))
	const keys: Array<HostKey> = []
	const spans: Array<HostSpanKey> = []
	/** The keys a span key whose span the call computes is for the inserted facts, after every declared key. */
	const spanKeys: Array<HostKey> = []
	for (const k of own.keys) {
		if (k.fields.some(computes)) {
			keys.push(
				Object.freeze({ ...k, compares: "put" as const }),
				Object.freeze({ ...k, fields: held(k.fields), compares: "insert" as const })
			)
		} else {
			keys.push(k)
		}
	}
	for (const check of own.spans) {
		if (!computes(check.span) && !check.equal.some(computes)) {
			spans.push(check)
			continue
		}
		spans.push(Object.freeze({ ...check, compares: "put" as const }))
		if (computes(check.span)) {
			spanKeys.push(
				Object.freeze({
					law: check.law,
					described: check.described,
					fields: held(check.equal),
					compares: "insert" as const
				})
			)
		} else {
			spans.push(Object.freeze({ ...check, equal: held(check.equal), compares: "insert" as const }))
		}
	}
	return Object.freeze({ keys: [...keys, ...spanKeys], spans })
}
