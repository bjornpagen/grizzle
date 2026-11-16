/** What the properties of overloads.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { isRecord } from "#compiler/core/record.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { type RangeOpCode, rangeOpCodes } from "#compiler/ir/expr.ts"
import { type SpanCarrier, spanCarriers } from "#compiler/ir/scalar.ts"
import type { ServedFile } from "#compiler/served/forms.ts"

type Overload = readonly [RangeOpCode, SpanCarrier]

export type Feature = `over ${SpanCarrier}`

export const overloadGen: Gen<Overload> = (source) =>
	[source.draw(element(rangeOpCodes)), source.draw(element(spanCarriers))] as const

/**
 * A served file holding `op` as its member `probe` and nothing besides, no roster among them: the writer walks a file's
 * members as values of any shape, so one member is a file it writes.
 */
export const fileHolding = (op: unknown): ServedFile =>
	trusted<ServedFile>({ rosters: new Map(), probe: op })

/** The member `probe` of a served file read back, as the file's value holds it. */
export const probeOf = (file: object): unknown => (isRecord(file) ? file["probe"] : undefined)
