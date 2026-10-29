import type { ValueFault } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"

/**
 * The uuid host value, canonical: UUID case and byte encodings need canonicalization.
 *
 * A uuid is 16 bytes. The host spelling is the hyphenated 8-4-4-4-12 hexadecimal form in either case; the canonical
 * value is its lowercase spelling, which is PostgreSQL's uuid_out text, so equal uuids have one host string and string
 * order is byte order. PostgreSQL's other accepted input spellings (braces, missing or regrouped hyphens) are refused
 * at the boundary rather than given a second host spelling.
 *
 * A per-row hot path: one allocation-free scan of the 36 code units, hex digits with hyphens at 8, 13, 18 and 23. The
 * canonical spelling is the input itself when it has no uppercase digit, which is every uuid_out text, and its ASCII
 * lowercase otherwise.
 */
export const toUuid = (value: unknown): Result.Result<string, ValueFault> => {
	if (typeof value !== "string" || value.length !== 36) {
		return Result.err("uuidSyntax")
	}
	let upper = false
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		const upperDigit = code >= 0x41 && code <= 0x46
		const lowerDigit = (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66)
		if (i === 8 || i === 13 || i === 18 || i === 23 ? code !== 0x2d : !upperDigit && !lowerDigit) {
			return Result.err("uuidSyntax")
		}
		upper ||= upperDigit
	}
	return Result.ok(upper ? value.toLowerCase() : value)
}
