/**
 * The drift check's replay set restated by object rather than by digest (deploy/admission/proof.ts, adapter/admission
 * drift.ts): the specification the drift-proof properties hold the drift check and the proof digests to.
 */

import { Array as Arr, Order, String as Str } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { manifestStatements } from "#compiler/deploy/admission/manifest.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { parseIdent } from "#compiler/physical/obligations/graph.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"

/** The kinds of manifest identity no description names, whose objects the drift check never proves. */
const undescribed = [
	"extension",
	"role",
	"membership",
	"privileges",
	"publication",
	"other"
] as const

/**
 * The objects each object of `snapshot` names, as the specification states it, read off the manifest's text rather than
 * its statements' trees: each other object whose name the printed text of its replayed statements holds, quoted as
 * grizzle prints every name: a schema object's `"schema"."name"`, a schema's `"schema".`. A name the printer spells
 * bare (an index a replica identity names) is no part of it, so it never holds more than PostgreSQL needs first.
 */
export const printedNames = (
	snapshot: DeploySnapshot
): ReadonlyMap<string, ReadonlySet<string>> => {
	const names = Arr.flatMap(
		snapshot.manifest.objects,
		(o): ReadonlyArray<readonly [string, string]> => {
			const ident = parseIdent(o.ident)
			switch (ident.kind) {
				case "schema":
					return [[o.ident, `${quoteIdent(ident.name)}.`]]
				case "domain":
				case "type":
				case "table":
				case "materializedView":
				case "view":
				case "index":
				case "function":
					return [[o.ident, `${quoteIdent(ident.schema)}.${quoteIdent(ident.name)}`]]
				case "statistics":
				case "rowSecurity":
				case "replicaIdentity":
				case "extension":
				case "role":
				case "membership":
				case "privileges":
				case "publication":
				case "column":
				case "constraint":
				case "trigger":
				case "policy":
				case "other":
					return []
			}
		}
	)
	return new Map(
		Arr.map(succeeded(manifestStatements(snapshot)).objects, (o) => {
			const text = Arr.join(Arr.map(o.statements, printStatement), "\n")
			return [
				o.ident,
				new Set(
					Arr.flatMap(names, ([ident, name]) =>
						ident !== o.ident && Str.includes(name)(text) ? [ident] : []
					)
				)
			] as const
		})
	)
}

/** What each object of `snapshot` is created after, as the specification states it: each object its edges create it
 * after, and each it names (printedNames). */
export const specifiedAfter = (
	snapshot: DeploySnapshot
): ReadonlyMap<string, ReadonlySet<string>> => {
	const after = new Map<string, Set<string>>()
	for (const edge of snapshot.manifest.edges) {
		after.set(edge.to, new Set([...(after.get(edge.to) ?? []), edge.from]))
	}
	for (const [ident, named] of printedNames(snapshot)) {
		after.set(ident, new Set([...(after.get(ident) ?? []), ...named]))
	}
	return after
}

/**
 * The objects of `now` whose proof digest the proofs `proven`'s check recorded (none before the first) no longer
 * holds, as the specification states it, by object rather than by digest: an object of `now` is tainted when `proven`
 * holds no object of its identity, or one whose replayed statements (manifestStatements) have another canonical text,
 * or one created after other objects than it is (specifiedAfter), or when an object it is created after is tainted.
 */
export const specifiedTainted = (
	proven: DeploySnapshot | undefined,
	now: DeploySnapshot
): ReadonlySet<string> => {
	const statementsOf = (s: DeploySnapshot): ReadonlyMap<string, string> =>
		new Map(
			Arr.map(succeeded(manifestStatements(s)).objects, (o) => [
				o.ident,
				canonicalTextOf(o.statements)
			])
		)
	const was = proven === undefined ? new Map<string, string>() : statementsOf(proven)
	const wasAfter =
		proven === undefined ? new Map<string, ReadonlySet<string>>() : specifiedAfter(proven)
	const is = statementsOf(now)
	const after = specifiedAfter(now)
	const sameAfter = (ident: string): boolean =>
		canonicalTextOf(Arr.sort([...(after.get(ident) ?? [])], Order.String)) ===
		canonicalTextOf(Arr.sort([...(wasAfter.get(ident) ?? [])], Order.String))
	const tainted = new Set<string>()
	for (const o of now.manifest.objects) {
		if (
			was.get(o.ident) !== is.get(o.ident) ||
			!sameAfter(o.ident) ||
			Arr.some([...(after.get(o.ident) ?? [])], (from) => tainted.has(from))
		) {
			tainted.add(o.ident)
		}
	}
	return tainted
}

/**
 * The replay of `now` over the proofs `proven`'s check recorded (specifiedTainted): every tainted object of a kind a
 * description names, and every object one is created after, transitively, in install order.
 */
export const specifiedReplay = (
	proven: DeploySnapshot | undefined,
	now: DeploySnapshot
): ReadonlyArray<string> => {
	const tainted = specifiedTainted(proven, now)
	const after = specifiedAfter(now)
	const needed = new Set<string>()
	const pending = Arr.filter([...tainted], (ident) =>
		Arr.every(undescribed, (kind) => kind !== parseIdent(ident).kind)
	)
	for (let ident = pending.pop(); ident !== undefined; ident = pending.pop()) {
		if (!needed.has(ident)) {
			needed.add(ident)
			for (const from of after.get(ident) ?? []) {
				pending.push(from)
			}
		}
	}
	return Arr.flatMap(now.manifest.objects, (o) => (needed.has(o.ident) ? [o.ident] : []))
}
