/**
 * The reference's network containment (scalar/compute/registry.ts netContainment): PostgreSQL's `<<=`, `<<` and `&&`
 * over two network texts, decided by a second implementation of address prefixes, Node's own (node:net BlockList),
 * never grizzle's port of network.c. A text is an address and an optional `/` mask length, of IPv6 exactly when it holds
 * a colon, its mask the family's width where it states none; Node reads the address. `a <<= b` holds where a and b are
 * of one family, a's mask is no shorter than b's and a's address lies in b's address's subnet of b's mask; `a << b`
 * where a's mask is moreover longer; `a && b` where each address lies in the other's subnet of the shorter mask.
 */
import { BlockList } from "node:net"
import { String as Str } from "effect"

/** A network text's parts: its address, its family as Node names it, and its mask length. */
interface Parts {
	readonly address: string
	readonly family: "ipv4" | "ipv6"
	readonly bits: number
}

const partsOf = (text: string): Parts => {
	const [address, mask] = Str.split("/")(text)
	const family = Str.includes(":")(address) ? "ipv6" : "ipv4"
	const bits = mask === undefined ? (family === "ipv4" ? 32 : 128) : Number(mask)
	return { address, family, bits }
}

/** Whether `address` lies in the subnet of `network`'s first `prefix` bits, both of `family`, as Node decides it. */
const inSubnet = (
	address: string,
	network: string,
	prefix: number,
	family: "ipv4" | "ipv6"
): boolean => {
	const list = new BlockList()
	list.addSubnet(network, prefix, family)
	return list.check(address, family)
}

/** The value of a network containment over two network texts, by the reference's own decision (see the header). */
export const netHolds = (
	fn: "netWithin" | "netStrictlyWithin" | "netOverlaps",
	aText: string,
	bText: string
): boolean => {
	const a = partsOf(aText)
	const b = partsOf(bText)
	if (a.family !== b.family) {
		return false
	}
	switch (fn) {
		case "netWithin":
			return a.bits >= b.bits && inSubnet(a.address, b.address, b.bits, a.family)
		case "netStrictlyWithin":
			return a.bits > b.bits && inSubnet(a.address, b.address, b.bits, a.family)
		case "netOverlaps": {
			const shorter = Math.min(a.bits, b.bits)
			return inSubnet(a.address, b.address, shorter, a.family)
		}
	}
}
