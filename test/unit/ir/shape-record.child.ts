/**
 * The module shape.test.ts's record-keys property runs in a child Node process started as a library consumer's is,
 * with no flag, so Object.prototype.__proto__ is in place, as --disable-proto=delete leaves it nowhere in a test
 * process. Each case that decodes in a consumer's process starts its own child: each line it reads spells a record, a
 * JSON array of [key, integer] entries, which it decodes with recordShape, and for each it prints one JSON line: whether
 * this process has the accessor, and what the decode answered. It ends when its input does.
 */
import { createInterface } from "node:readline"
import { Record as Rec } from "effect"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import * as S from "#compiler/ir/shape.ts"

/**
 * What the child prints: whether Object.prototype.__proto__ exists in it, and the decode's answer: the decoded record's
 * own entries and whether its prototype is Object.prototype, or the refusal's message.
 */
export type ConsumerRecord = Readonly<{
	accessor: boolean
	decoded:
		| Readonly<{
				kind: "decoded"
				entries: ReadonlyArray<readonly [string, number]>
				plain: boolean
		  }>
		| Readonly<{ kind: "refused"; message: string }>
}>

/** The answer for the record `entries` spells, decoded in this process. */
const answerOf = (entries: ReadonlyArray<readonly [string, number]>): ConsumerRecord => {
	const out = S.decodeWith(
		S.recordShape(S.integer, S.nonEmptyString),
		Rec.fromEntries(entries),
		"v"
	)
	return {
		accessor: Object.getOwnPropertyDescriptor(Object.prototype, "__proto__") !== undefined,
		decoded: out.ok
			? {
					kind: "decoded",
					entries: Rec.toEntries(out.value),
					plain: Object.getPrototypeOf(out.value) === Object.prototype
				}
			: { kind: "refused", message: out.error.message }
	}
}

for await (const line of createInterface({ input: process.stdin })) {
	process.stdout.write(
		`${jsonText(answerOf(trustedJson<ReadonlyArray<readonly [string, number]>>(line)))}\n`
	)
}
