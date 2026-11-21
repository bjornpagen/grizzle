/**
 * inet and cidr values as the host holds them (scalar/values/net.ts): an address of either family with a mask
 * length, drawn word by word, its text admitted by the host's own parser, so each is inet_out's or cidr_out's text.
 * A cidr's host bits are drawn zero, since a cidr holding host bits is no value.
 */

import { boolean, type Gen, int, map } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { admitCidr, admitInet, type Cidr, type Inet } from "#compiler/scalar/values/net.ts"
import { succeeded } from "#test/support/assert.ts"

/** An address's text with its mask length: its host bits cleared when `network`. */
const netText =
	(network: boolean): Gen<string> =>
	(s) => {
		const v6 = s.draw(boolean)
		const width = v6 ? 128 : 32
		const bits = s.draw(int(0, width))
		const words = Array.from({ length: v6 ? 8 : 4 }, () => s.draw(int(0, v6 ? 0xffff : 0xff)))
		const size = v6 ? 16 : 8
		const kept = Arr.map(words, (w, i) => {
			const keep = Math.max(0, Math.min(size, bits - i * size))
			return network ? (keep === 0 ? 0 : (w >>> (size - keep)) << (size - keep)) : w
		})
		const address = v6
			? Arr.join(
					Arr.map(kept, (w) => w.toString(16)),
					":"
				)
			: Arr.join(Arr.map(kept, String), ".")
		return `${address}/${bits}`
	}

/** inet values: an address with its network's mask. */
export const inetValues: Gen<Inet> = map(netText(false), (text) =>
	succeeded(admitInet(text), "a drawn inet text")
)

/** cidr values: a network. */
export const cidrValues: Gen<Cidr> = map(netText(true), (text) =>
	succeeded(admitCidr(text), "a drawn cidr text")
)
