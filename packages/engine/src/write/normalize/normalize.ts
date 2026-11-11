/**
 * The host's same-key checks of a written relation's additions, decided where the relation is written
 * (runtime/write/normalize.ts HostChecks): its declared keys the host holds every field of, and its span keys the probe
 * leaves to the host.
 */
import type { LawId } from "#compiler/core/ids.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { HostChecks, HostKey, HostKeyField } from "#compiler/runtime/write/normalize.ts"
import type { OwnLaw } from "#compiler/types/changeset/changeset.ts"
import { hostHeld, type RelationUniques } from "#compiler/write/insert/unique.ts"

/** A key field of the relation's facts, by its name, with its type. */
const hostKeyField = (f: LawField): HostKeyField => ({ field: f.name, type: f.type })

/** The host checks of a relation's keys whose every field it holds (insert/unique.ts `hostHeld`) and of its span
 * candidate keys. */
export const hostChecks = (
	keyLaws: ReadonlyArray<{
		readonly fields: ReadonlyArray<LawField>
		readonly law: LawId
		readonly described: OwnLaw
	}>,
	uniques: RelationUniques
): HostChecks =>
	Object.freeze({
		keys: keyLaws.flatMap((k): ReadonlyArray<HostKey> =>
			k.fields.every(hostHeld)
				? [
						Object.freeze({
							law: k.law,
							described: k.described,
							fields: k.fields.map(hostKeyField)
						})
					]
				: []
		),
		spans: uniques.checks.flatMap(({ object: check, pairs }) =>
			check.kind !== "span" || pairs !== "host"
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
