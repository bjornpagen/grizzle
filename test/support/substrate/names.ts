import { Formatter, Option, String as Str } from "effect"
import { Hex } from "effect/encoding"

import { regex } from "arkregex"
import { maxIdentifierBytes } from "#compiler/core/identity.ts"
/** Lowercase ASCII letter words joined by single underscores: a schema label, and a role name roleName takes. */
const word = regex("^[a-z]+(?:_[a-z]+)*$")

/**
 * The segment every allocated schema name leads with, the substrate's own, as `gz_` leads the names of its databases.
 * No label leads an allocation, so none starts with `pg_`, which the naming door refuses in a schema's name
 * (core/identity.ts parseSchemaName), whatever word a test labels it with.
 */
const allocationLead = "gz"

/**
 * An allocated schema name: the lead (allocationLead), a label word, then the allocating pid, the allocation's number
 * and 32 random bits, each in decimal, the random bits zero-padded to ten digits. Its digit runs are segments of their
 * own, so the name is its own conversion at the naming door (core/identity.ts) and its own installed schema, and every
 * login's and role's PostgreSQL role and each role's schema the door mints under it is `<name>__<name>`; the lead and
 * the label hold no digit, so the first digit run is the pid, whatever follows the allocation.
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
 * `gz_gzs_<pid>_<n>_<random>`: the pid and the allocation's number, which its substrate counts, separate allocations
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
 * no two allocations of one substrate share a name. Every name it makes is one the naming door admits for a schema:
 * the word rule admits the label, the lead keeps it off `pg_`, and assertIdentifier holds it within maxIdentifierBytes.
 */
export const uniqueSchemaName = (label: string, allocationNumber: number): string => {
	if (!word.test(label)) {
		throw new Error(`schema label ${Formatter.format(label)} is not a lowercase letter word`)
	}
	const name = `${allocationLead}_${label}_${process.pid}_${allocationNumber}_${random32()}`
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
 * it, its decoder login's among them, or a role roleName names under it; none for any other name. The global setup drops what a dead process left
 * behind (shared.ts).
 */
export const allocatingPid = (name: string): Option.Option<number> =>
	Option.map(
		Option.fromNullishOr(
			allocation.exec(Str.startsWith(liveLead)(name) ? Str.slice(liveLead.length)(name) : name)?.[1]
		),
		(pid) => Number(pid)
	)

/**
 * The lead of a decoder login's stem (core/identity.ts identity.liveSource): `__live_`, then its root schema's segments,
 * an allocation's, so the sweep reads its process off the rest.
 */
const liveLead = "__live_"

/** A role a test creates under an allocated `schema`: `<schema>__<name>`, which starts with rolePrefix(schema). */
export const roleName = (schema: string, name: string): string => {
	if (!allocation.test(schema)) {
		throw new Error(`schema name ${Formatter.format(schema)} is no allocated name`)
	}
	if (!word.test(name)) {
		throw new Error(`role name ${Formatter.format(name)} is not a lowercase letter word`)
	}
	const full = `${schema}__${name}`
	assertIdentifier(full)
	return full
}

/**
 * An owner login's role (substrate.ts ownerLogin): `<allocation>__login` under an allocation of its own, labelled
 * `owner`, so no schema's roles share its prefix and the sweep reads its process off it as off any test role.
 */
export const ownerLoginName = (allocationNumber: number): string =>
	roleName(uniqueSchemaName("owner", allocationNumber), "login")

/** The prefix every role and schema that belongs to an allocated `schema` starts with, but the installed schema, which
 * is the allocation itself: each login's and role's PostgreSQL role, each role's schema, and each role a test names
 * under it. */
export const rolePrefix = (schema: string): string => `${schema}_`

export const assertIdentifier = (name: string): void => {
	if (!regex("^[a-z_][a-z0-9_]*$").test(name)) {
		throw new Error(`${Formatter.format(name)} is not a plain lowercase identifier`)
	}
	if (Buffer.byteLength(name, "utf8") > maxIdentifierBytes.value) {
		throw new Error(
			`${Formatter.format(name)} exceeds ${maxIdentifierBytes.value} bytes and would be truncated`
		)
	}
}

/** A random password for a test role; SCRAM hashes it on the server (password_encryption). */
export const randomPassword = (): string => randomHex(16)
