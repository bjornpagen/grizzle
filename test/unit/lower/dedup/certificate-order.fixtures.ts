/** What the properties of certificate-order.test.ts read: their box, the order's counted reads and the reference. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { array, element, type Gen, int, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { encode, everyProperty } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { NodeId } from "#compiler/core/ids.ts"
import {
	type Certificate,
	localCertificate,
	type MultiplicityRule
} from "#compiler/ir/certificate.ts"

/** The labels a box draws from: an order holds some of them, and a certificate may name one it does not hold. */
const labels = Arr.map(["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"] as const, (s) => NodeId(s))

/** The rules a box's certificates carry, so two certificates at one position sort by rule. */
const rules = [
	"R17.placement",
	"R17.unionAll",
	"R02.existence"
] as const satisfies ReadonlyArray<MultiplicityRule>

/** A plan's node order and its certificates, before canonicalization. */
export interface Box {
	readonly order: ReadonlyArray<NodeId>
	readonly certificates: ReadonlyArray<Certificate<MultiplicityRule>>
}

/**
 * One certificate: a rule, any outputs among the labels (one the order does not hold among them, or none), and a
 * preserved heading of one or two columns, so two certificates of one rule and position sort by their text.
 */
const certificateGen: Gen<Certificate<MultiplicityRule>> = (source) =>
	localCertificate(
		source.draw(element(rules)),
		[],
		source.draw(subarray(labels)),
		[],
		source.draw(element([["a"], ["a", "b"]]))
	)

/**
 * The box: an order of one to eight labels, one possibly met twice (an order of labels a DAG's nodes give, which
 * nodesByLabel reads tolerantly), and two to twelve certificates, one possibly drawn twice so the canonical list keeps
 * one copy.
 */
export const boxGen: Gen<Box> = (source) => {
	const order = source.draw(array(element(labels), { min: 1, max: 8 }))
	const drawn = source.draw(array(certificateGen, { min: 2, max: 12 }))
	const again = source.draw(int(0, drawn.length))
	const copy = drawn[again]
	return { order, certificates: copy === undefined ? drawn : [...drawn, copy] }
}

/**
 * `order` with each read of an entry counted into `reads`: how many of its positions a canonicalization reads, the
 * work its first-output positions take.
 */
export const countedOrder = (
	order: ReadonlyArray<NodeId>,
	reads: { count: number }
): ReadonlyArray<NodeId> =>
	new Proxy(order, {
		get: (target, property, receiver): unknown => {
			if (typeof property === "string" && Number.isInteger(Number(property))) {
				reads.count += 1
			}
			const value: unknown = Reflect.get(target, property, receiver)
			return value
		}
	})

/**
 * The canonical certificates as certify.ts ordered them before its first positions (at 8071f3a64): one copy of each by
 * its canonical text, in order of the first position of the order whose label is one of its outputs, scanned from the
 * order's start for each certificate, the order's length where none is, then rule, then text.
 */
export const referenceCertificates = (
	order: ReadonlyArray<NodeId>,
	certificates: ReadonlyArray<Certificate<MultiplicityRule>>
): Result.Result<ReadonlyArray<Certificate<MultiplicityRule>>, CompileError> => {
	const firstOutputAt = (outputs: ReadonlyArray<NodeId>): number => {
		for (const [i, id] of order.entries()) {
			if (outputs.includes(id)) {
				return i
			}
		}
		return order.length
	}
	const keyed: Array<{
		readonly cert: Certificate<MultiplicityRule>
		readonly text: string
		readonly at: number
	}> = []
	const seen = new Set<string>()
	for (const cert of certificates) {
		const text = encode(cert, everyProperty)
		if (!text.ok) {
			return Result.err(text.error)
		}
		if (seen.has(text.value)) {
			continue
		}
		seen.add(text.value)
		keyed.push({ cert, text: text.value, at: firstOutputAt(cert.outputs) })
	}
	keyed.sort((x, y) =>
		x.at !== y.at
			? x.at - y.at
			: x.cert.rule !== y.cert.rule
				? x.cert.rule < y.cert.rule
					? -1
					: 1
				: x.text < y.text
					? -1
					: x.text > y.text
						? 1
						: 0
	)
	return Result.ok(Arr.map(keyed, (k) => k.cert))
}
