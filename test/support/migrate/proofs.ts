/**
 * The drift check's replay set restated by object rather than by digest (deploy/admission/proof.ts, adapter/admission
 * drift.ts): the specification the drift-proof properties hold the drift check and the proof digests to.
 */

import { Array as Arr, Order } from "effect"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { manifestStatements } from "#compiler/deploy/admission/manifest.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { parseIdent } from "#compiler/physical/obligations/graph.ts"
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
 * The objects of `now` whose proof digest the proofs `proven`'s check recorded (none before the first) no longer
 * holds, as the specification states it, by object rather than by digest: an object of `now` is tainted when `proven`
 * holds no object of its identity, or one whose replayed statements (manifestStatements) have another canonical text,
 * or one created after other objects than it is, or when an object it is created after is tainted.
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
	const afterOf = (s: DeploySnapshot): ReadonlyMap<string, ReadonlyArray<string>> => {
		const after = new Map<string, Array<string>>()
		for (const edge of s.manifest.edges) {
			after.set(edge.to, [...(after.get(edge.to) ?? []), edge.from])
		}
		return after
	}
	const was = proven === undefined ? new Map<string, string>() : statementsOf(proven)
	const wasAfter = proven === undefined ? new Map<string, ReadonlyArray<string>>() : afterOf(proven)
	const is = statementsOf(now)
	const after = afterOf(now)
	const sameAfter = (ident: string): boolean =>
		canonicalTextOf(Arr.sort(after.get(ident) ?? [], Order.String)) ===
		canonicalTextOf(Arr.sort(wasAfter.get(ident) ?? [], Order.String))
	const tainted = new Set<string>()
	for (const o of now.manifest.objects) {
		if (
			was.get(o.ident) !== is.get(o.ident) ||
			!sameAfter(o.ident) ||
			Arr.some(after.get(o.ident) ?? [], (from) => tainted.has(from))
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
	const after = new Map<string, Array<string>>()
	for (const edge of now.manifest.edges) {
		after.set(edge.to, [...(after.get(edge.to) ?? []), edge.from])
	}
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
