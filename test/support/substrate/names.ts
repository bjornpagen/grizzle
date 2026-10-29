import { Option, String as Str } from "effect"
import { Hex } from "effect/encoding"
import { maxIdentifierBytes } from "#compiler/core/identity.ts"

import { regex } from "arkregex"
/** Lowercase ASCII letter words joined by single underscores: a schema label, and a role name roleName takes. */
const word = regex("^[a-z]+(?:_[a-z]+)*$")

/**
 * An allocated schema name: a label word, then the allocating pid, the allocation's number and 32 random bits, each in
 * decimal, the random bits zero-padded to ten digits. Its digit runs are segments of their own, so the name is its own
 * conversion at the naming door (core/identity.ts) and its own installed schema, and every login's and role's
 * PostgreSQL role and each role's schema the door mints under it is `<name>__<name>`; the label holds no digit, so the
 * first digit run is the pid, whatever follows the allocation.
 */
const allocation = regex("^[a-z]+(?:_[a-z]+)*_([0-9]+)_[0-9]+_[0-9]{10}(?:_|$)")

/** 32 random bits, from the platform's Web Crypto, as ten decimal digits. */
const random32 = (): string =>
	Str.padStart(10, "0")(String(crypto.getRandomValues(new Uint32Array(1))[0] ?? 0))

/**
 * `bytes` random bytes from the platform's Web Crypto, as lowercase hex, two digits a byte: the random bits of a name a
 * test mints, which keep a reused pid's names apart.
 */
export const randomHex = (bytes: number): string =>
	Hex.encode(crypto.getRandomValues(new Uint8Array(bytes)))

/**
 * `gzs_<pid>_<n>_<random>`: the pid and the allocation's number, which its substrate counts, separate allocations
 * within this machine, and the 32 random bits separate processes whose pids were reused after a crash that skipped the
 * finalizers. The label of a schema a test names by no label of its own.
 */
export const defaultSchemaLabel = "gzs"

/**
 * Unique, cluster-safe names for test schemas and roles.
 *
 * Roles are cluster-wide and several test processes share one cluster, so every pg or schedules test allocates a
 * unique schema name, the declared name its fixture is installed under, and every role the installation or the test
 * creates starts with rolePrefix(name). `allocationNumber` is the allocation's number, which its substrate counts, so
 * no two allocations of one substrate share a name.
 */
export const uniqueSchemaName = (label: string, allocationNumber: number): string => {
	if (!word.test(label)) {
		throw new Error(`schema label ${JSON.stringify(label)} is not a lowercase letter word`)
	}
	const name = `${label}_${process.pid}_${allocationNumber}_${random32()}`
	assertIdentifier(name)
	return name
}

/**
 * A unique schema name of exactly `bytes` bytes, uniqueSchemaName's allocation under `label`, then `_` and the letter
 * `s` to the length: one segment more, so the name is still its own conversion and its own installed schema.
 */
export const uniqueSchemaNameOfLength = (
	label: string,
	allocationNumber: number,
	bytes: number
): string => {
	const allocated = uniqueSchemaName(label, allocationNumber)
	const room = bytes - Buffer.byteLength(allocated, "utf8") - 1
	if (room < 1) {
		throw new Error(`the allocation ${allocated} leaves no room for a name of ${bytes} bytes`)
	}
	const name = `${allocated}_${Str.repeat(room)("s")}`
	assertIdentifier(name)
	return name
}

/**
 * The process that allocated a uniqueSchemaName schema, read off any name the door minted under
 * it or a role roleName names under it; none for any other name. The global setup drops what a dead process left
 * behind (shared.ts).
 */
export const allocatingPid = (name: string): Option.Option<number> =>
	Option.map(Option.fromNullishOr(allocation.exec(name)?.[1]), (pid) => Number(pid))

/** A role a test creates under an allocated `schema`: `<schema>__<name>`, which starts with rolePrefix(schema). */
export const roleName = (schema: string, name: string): string => {
	if (!allocation.test(schema)) {
		throw new Error(`schema name ${JSON.stringify(schema)} is no allocated name`)
	}
	if (!word.test(name)) {
		throw new Error(`role name ${JSON.stringify(name)} is not a lowercase letter word`)
	}
	const full = `${schema}__${name}`
	assertIdentifier(full)
	return full
}

/** The prefix every role and schema that belongs to an allocated `schema` starts with, but the installed schema, which
 * is the allocation itself: each login's and role's PostgreSQL role, each role's schema, and each role a test names
 * under it. */
export const rolePrefix = (schema: string): string => `${schema}_`

export const assertIdentifier = (name: string): void => {
	if (!regex("^[a-z_][a-z0-9_]*$").test(name)) {
		throw new Error(`${JSON.stringify(name)} is not a plain lowercase identifier`)
	}
	if (Buffer.byteLength(name, "utf8") > maxIdentifierBytes) {
		throw new Error(
			`${JSON.stringify(name)} exceeds ${maxIdentifierBytes} bytes and would be truncated`
		)
	}
}

/** A random password for a test role; SCRAM hashes it on the server (password_encryption). */
export const randomPassword = (): string => randomHex(16)
