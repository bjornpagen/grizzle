/**
 * The module shape.test.ts's record-keys property runs in a child Node process started as a library consumer's is,
 * with no flag, so Object.prototype.__proto__ is in place, as --disable-proto=delete leaves it nowhere in a test
 * process. It decodes the record its one argument spells, a JSON array of [key, integer] entries, with recordShape, and
 * prints one JSON line: whether this process has the accessor, and what the decode answered.
 */
import { Record as Rec } from "effect"
import { defined } from "#compiler/core/invariant.ts"
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

const entries = trustedJson<ReadonlyArray<readonly [string, number]>>(
	defined(process.argv[2], "the entries the record-keys property passes as the child's argument")
)
const out = S.decodeWith(S.recordShape(S.integer, S.nonEmptyString), Rec.fromEntries(entries), "v")
const answer: ConsumerRecord = {
	accessor: Object.getOwnPropertyDescriptor(Object.prototype, "__proto__") !== undefined,
	decoded: out.ok
		? {
				kind: "decoded",
				entries: Rec.toEntries(out.value),
				plain: Object.getPrototypeOf(out.value) === Object.prototype
			}
		: { kind: "refused", message: out.error.message }
}

process.stdout.write(`${jsonText(answer)}\n`)
