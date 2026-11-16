import { maxIdentifierBytes } from "@bjornpagen/grizzle-engine/core/identity"
import { regex } from "arkregex"
import { Formatter, Option, String as Str } from "effect"
import { Hex } from "effect/encoding"
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

/**
 * A template's allocation (templateSchemaName): the template lead, the template's digest in decimal, then a label word.
 * It holds one digit run and no pid, so allocatingPid reads none off it and the sweep of ended processes spares every
 * name under it: the installation of a template database outlives the process that built it.
 */
const templateAllocation = regex("^gzt_[0-9]+_[a-z]+(?:_[a-z]+)*(?:_|$)")

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
 * The schema name of exactly `bytes` bytes under the allocation `allocated`: `_` and the letter `s` to the length, one
 * segment more, so the name is still its own conversion and its own installed schema, under the same allocation.
 */
export const schemaNameOfLength = (allocated: string, bytes: number): string => {
	const room = bytes - Buffer.byteLength(allocated, "utf8") - 1
	if (room < 1) {
		throw new Error(`the allocation ${allocated} leaves no room for a name of ${bytes} bytes`)
	}
	const name = `${allocated}_${Str.repeat(room)("s")}`
	assertIdentifier(name)
	return name
}

/**
 * The schema name a template's build allocates under `label` (substrate.ts templateAllocations): `gzt_`, the template's
 * digest in decimal (`digest`, templates.ts templateDigest), and the label, so the same template on any member, built
 * by any worker, allocates the same names, and a worker that never built it derives them: its installation's schema,
 * its owner login and every role under them. One build allocates a label once.
 */
export const templateSchemaName = (digest: string, label: string): string => {
	if (!word.test(label)) {
		throw new Error(`schema label ${Formatter.format(label)} is not a lowercase letter word`)
	}
	const name = `gzt_${digest}_${label}`
	if (!templateAllocation.test(name)) {
		throw new Error(`template digest ${Formatter.format(digest)} is no run of decimal digits`)
	}
	assertIdentifier(name)
	return name
}

/**
 * The names a template's installation is made under and every worker derives from its digest (templateSchemaName): the
 * installation's schema, labelled `install`, and its owner login's role, `<owner allocation>__login`, which a template
 * build's substrate gives its one owner login (substrate.ts templateAllocations).
 */
export interface TemplateNames {
	readonly schema: string
	readonly ownerLogin: string
}

/** The names of the template of digest `digest` (TemplateNames). */
export const templateNames = (digest: string): TemplateNames => ({
	schema: templateSchemaName(digest, "install"),
	ownerLogin: roleName(templateSchemaName(digest, "owner"), "login")
})

/**
 * The process that allocated a uniqueSchemaName schema, read off any name the door minted under it with the allocation
 * as its prefix, or a role roleName names under it; none for any other name, a decoder login's at its stem among them,
 * `__live_<digest>`, which names no allocation (core/identity.ts identity.liveSource): the sweep finds that one by the
 * name its allocation derives (shared.ts). The global setup drops what a dead process left behind.
 */
export const allocatingPid = (name: string): Option.Option<number> =>
	Option.map(Option.fromNullishOr(allocation.exec(name)?.[1]), (pid) => Number(pid))

/** A role a test creates under an allocated `schema`: `<schema>__<name>`, which starts with rolePrefix(schema). */
export const roleName = (schema: string, name: string): string => {
	if (!allocation.test(schema) && !templateAllocation.test(schema)) {
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
	if (Buffer.byteLength(name, "utf8") > maxIdentifierBytes) {
		throw new Error(
			`${Formatter.format(name)} exceeds ${maxIdentifierBytes} bytes and would be truncated`
		)
	}
}

/** A random password for a test role; SCRAM hashes it on the server (password_encryption). */
export const randomPassword = (): string => randomHex(16)
