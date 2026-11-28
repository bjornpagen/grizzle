/** What the properties of network.test.ts read: its schema, role and login, its spaces and its models. */

import { array, constant, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Net } from "#compiler/public/compute.ts"
import { cidr, inet, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	attested,
	context,
	login,
	relation,
	role,
	schema,
	wholeEntriesOf,
	wholeWritesOf
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { generatedTemplate } from "#test/support/install-migrate.ts"

/**
 * inet and cidr written and read through grizzle, and an inet context's address, from a token's claim or attested
 * by the server, filtering a cidr relation by Net.within.
 *
 * README, "Tables and types", network types, and "Contexts of a role". A Host is keyed by its inet, a Network holds a
 * cidr. The role
 * `campus` holds both whole and declares two contexts of one field, an inet `address`: Where, a token's claim, read from
 * its nested `net` object; and Origin, attested by the server where it opens the Db, never read from a token. Its login
 * serves the inserts of hosts and networks, the reads of each, and the networks within which Where's address and
 * Origin's lie.
 */
const Host = relation("Host", { id: int4, address: inet }, ["address"])
export const Network = relation("Network", { id: int4, network: cidr }, ["id"])

/** The address a token claims, from its nested `net` object: a client's statement. */
const Where = context("Where", { address: inet }, { claim: "net" })

/** The address the server attests a request reached it from: never a token's claim. */
const Origin = attested("Origin", { address: inet })

export const campusAt = (name: string) => {
	const base = schema(name, [Host, Network], [])
	const putHosts = ChangeSet.empty(base).insert(Host, [])
	const putNetworks = ChangeSet.empty(base).insert(Network, [])
	const hosts = query(base).rule((r) => {
		const { id, address } = v(Host, "host")
		return r.match(Host, { id, address }).find({ id, address })
	})
	const networks = query(base).rule((r) => {
		const { id, network } = v(Network, "network")
		return r.match(Network, { id, network }).find({ id, network })
	})
	/** The networks within which the token's claimed address lies. */
	const whereIn = query(base).rule((r) => {
		const { id, network } = v(Network, "network")
		const { address } = v(Where, "where")
		return r
			.match(Network, { id, network })
			.match(Where, { address })
			.where(Net.within(address, network))
			.find({ id })
	})
	/** The networks within which the server's attested address lies. */
	const originIn = query(base).rule((r) => {
		const { id, network } = v(Network, "network")
		const { address } = v(Origin, "origin")
		return r
			.match(Network, { id, network })
			.match(Origin, { address })
			.where(Net.within(address, network))
			.find({ id })
	})
	const campus = role(base, "campus", wholeEntriesOf(base), {
		...wholeWritesOf(base),
		contexts: [Where, Origin]
	})
	return {
		base,
		campus,
		web: login(base, "web", [campus], {
			workload: [workload(campus, { putHosts, putNetworks, hosts, networks, whereIn, originIn })]
		})
	}
}

/** The installation drafted and served once per member as `grizzle generate` does (install-migrate.ts generatedTemplate). */
export const campusTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "network types",
	content: { label: "campus" },
	build: (name) => {
		const campus = campusAt(name)
		return { schema: campus.base, logins: [campus.web] }
	},
	ambient: ordinarySession
})

const hexDigit = (n: number): string => n.toString(16)

/** An IPv4 octet's spelling: its value, or one with leading zeros, which inet_in reads as its value. */
const octet: Gen<string> = weighted([
	[6, (s) => `${s.draw(int(0, 255))}`],
	[1, (s) => `0${s.draw(int(0, 99))}`],
	[1, () => "256"]
])

/** A mask's spelling: a length within the family's width or past it, with leading zeros, or wrapping a C int. */
const mask = (width: number): Gen<string> =>
	weighted([
		[6, (s) => `${s.draw(int(0, width))}`],
		[1, (s) => `0${s.draw(int(0, width))}`],
		[1, () => `${width + 1}`],
		[1, (s) => `${4294967296 + s.draw(int(0, width))}`]
	])

/** An IPv6 word's spelling: one to four hexadecimal digits of either case, or five. */
const word: Gen<string> = weighted([
	[6, (s) => hexDigit(s.draw(int(0, 0xffff)))],
	[1, (s) => Str.toUpperCase(hexDigit(s.draw(int(0, 0xffff))))],
	[1, (s) => `0${hexDigit(s.draw(int(0, 0xfff)))}`],
	[1, () => "1ffff"]
])

/** An IPv6 address's spelling: eight words, a run of them as `::`, or an embedded IPv4 tail. */
const ipv6: Gen<string> = (s) => {
	const words = s.draw(array(word, { min: 1, max: 9 }))
	const gap = s.draw(int(0, words.length))
	const compressed = s.draw(
		weighted([
			[1, constant(true)],
			[2, constant(false)]
		])
	)
	const spelled = compressed
		? `${Arr.join(words.slice(0, gap), ":")}::${Arr.join(words.slice(gap), ":")}`
		: Arr.join(words, ":")
	return s.draw(
		weighted([
			[2, constant(false)],
			[1, constant(true)]
		])
	)
		? `${spelled}:${Arr.join(s.draw(array(octet, { min: 2, max: 4 })), ".")}`
		: spelled
}

/**
 * A network text: an IPv4 or IPv6 address with or without a mask, an IPv4-mapped or IPv4-compatible IPv6 address, a
 * cidr's shorthand, a hexadecimal one, or none.
 */
const spelling: Gen<string> = weighted([
	[5, (s) => Arr.join(s.draw(array(octet, { min: 4, max: 4 })), ".")],
	[4, (s) => `${Arr.join(s.draw(array(octet, { min: 4, max: 4 })), ".")}/${s.draw(mask(32))}`],
	[2, (s) => `${Arr.join(s.draw(array(octet, { min: 1, max: 3 })), ".")}/${s.draw(mask(32))}`],
	[1, (s) => Arr.join(s.draw(array(octet, { min: 1, max: 4 })), ".")],
	[1, (s) => `${Arr.join(s.draw(array(octet, { min: 4, max: 4 })), ".")}.`],
	[
		1,
		(s) =>
			`0x${Arr.join(s.draw(array((t) => hexDigit(t.draw(int(0, 15))), { min: 1, max: 9 })), "")}`
	],
	[5, ipv6],
	[4, (s) => `${s.draw(ipv6)}/${s.draw(mask(128))}`],
	[
		2,
		(s) =>
			`${s.draw(element(["::ffff:", "::FFFF:", "::", "0:0:0:0:0:ffff:"]))}${Arr.join(s.draw(array(octet, { min: 4, max: 4 })), ".")}`
	],
	[
		1,
		(s) => s.draw(element(["", "::", "/8", "1.2.3.4/", "::/0", " 1.2.3.4", "1.2.3.4 ", "a.b.c.d"]))
	]
])

/** A case of the values property: a batch of network texts. */
export const spellings: Gen<ReadonlyArray<string>> = array(spelling, { min: 1, max: 40 })

export type ValuesFeature =
	| "an IPv4 inet stored"
	| "an IPv6 inet stored"
	| "an IPv4 cidr stored"
	| "an IPv6 cidr stored"
	| "a spelling read to its one form"
	| "refused as no inet"
	| "a cidr's host bits refused"
	| "refused as no cidr"

/** A case of the contexts property: the networks stored, the address, and where it comes from. */
export interface ContextsCase {
	readonly networks: ReadonlyArray<string>
	readonly address: string
	readonly source: "token" | "attested" | "token naming Origin"
}

/** A cidr drawn about an address: its prefix of a drawn length, or another network of the address's family or not. */
const ipv4Of = (n: number): string =>
	Arr.join(
		Arr.map([24, 16, 8, 0], (shift) => `${(n >>> shift) & 0xff}`),
		"."
	)

export const contextsCases: Gen<ContextsCase> = (s) => {
	const base = s.draw(int(0, 0xffff_ffff))
	const family = s.draw(element(["ipv4", "ipv6"] as const))
	const address =
		family === "ipv4"
			? ipv4Of(base)
			: `2001:db8:${hexDigit(base >>> 16)}:${hexDigit(base & 0xffff)}::1`
	const networkOf: Gen<string> = weighted([
		[
			3,
			(t) => {
				const bits = t.draw(int(0, 32))
				const masked = bits === 0 ? 0 : (base >>> (32 - bits)) << (32 - bits)
				return family === "ipv4"
					? `${ipv4Of(masked >>> 0)}/${bits}`
					: t.draw(
							element(["2001::/16", "2001:db8::/32", `2001:db8:${hexDigit(base >>> 16)}::/48`])
						)
			}
		],
		[2, (t) => `${ipv4Of(t.draw(int(0, 0xffff_ffff)) & 0xffff_ff00)}/24`],
		[1, () => "::/0"],
		[1, () => "0.0.0.0/0"]
	])
	return {
		networks: s.draw(array(networkOf, { min: 0, max: 6 })),
		address,
		source: s.draw(element(["token", "attested", "token naming Origin"] as const))
	}
}

export type ContextsFeature =
	| "a token's address within a network"
	| "an attested address within a network"
	| "within no network"
	| "within several networks"
	| "a network of the other family"
	| "a token's claim of Origin reads no attested fact"
	| "the network column's GiST index"
