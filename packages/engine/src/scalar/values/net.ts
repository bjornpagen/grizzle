import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { ValueFault } from "#compiler/core/errors.ts"

/**
 * PostgreSQL's network address types, inet and cidr, on the host: their values, the one text each value has, and the
 * order and containment PostgreSQL computes over them. Every function here is a port of PostgreSQL 19's own
 * (src/backend/utils/adt/network.c, inet_net_pton.c and src/port/inet_net_ntop.c), so the host admits exactly the texts
 * inet_in and cidr_in admit, reads each as the value they read it as, and prints it as inet_out and cidr_out print it:
 * '1.2.3.4/32' is admitted as inet '1.2.3.4', cidr '10/8' as '10.0.0.0/8', and a cidr with a bit set right of its mask
 * is refused, as PostgreSQL refuses it. A host value is that printed text, its value's one form, so two values are equal
 * exactly when their texts are.
 *
 * Every one of PostgreSQL's quirks is kept, never smoothed: a cidr's class-based mask when the text states none, an
 * IPv4 cidr's hexadecimal spelling, an inet's trailing dot after four octets, an IPv6 text's embedded IPv4 octets of
 * fewer than four, a mask length's digits wrapping at 32 bits as the C int they are read into does, and IPv6's
 * printing of an address whose first six words alone are zero as embedded IPv4 octets ('::102:304' prints as
 * '::1.2.3.4').
 * test/pg/net's agreement property holds each to PostgreSQL's own answer over drawn texts.
 */

/**
 * An inet host value: inet_out's text of an inet value, an IPv4 address's four dotted octets or an IPv6 address's
 * colon-separated words, with `/` and its mask length unless the mask is the family's whole width. It is pg.inet's host
 * type, domain and language. The language is wider than the values, as Uuid's is: TypeScript writes each part as
 * `${string}`, so any text with three dots or a colon is in it, and it is refused at the boundary instead (admitNet).
 */
export type Inet = `${string}.${string}.${string}.${string}` | `${string}:${string}`

/**
 * A cidr host value: cidr_out's text of a cidr value, a network's address and, always, `/` and its mask length. It is
 * pg.cidr's host type, domain and language, wider than the values as Inet's is.
 */
export type Cidr = `${string}/${string}`

/** The network carriers: PostgreSQL's inet, an address with its network's mask, and cidr, a network. */
export type NetCarrier = "inet" | "cidr"

/**
 * An address family, in PostgreSQL's order of them: PGSQL_AF_INET (2) before PGSQL_AF_INET6 (3), the order
 * network_cmp compares two values of two families by.
 */
export type NetFamily = "ipv4" | "ipv6"

/**
 * A network value as PostgreSQL's inet struct holds it: its family, its mask length, from 0 to the family's width, and
 * its address, 4 bytes for IPv4 and 16 for IPv6. A cidr's address has no bit set past its mask; an inet's may.
 */
export interface NetValue {
	readonly family: NetFamily
	readonly bits: number
	readonly address: Uint8Array
}

/**
 * A family's width in bits (ip_maxbits) and in bytes (ip_addrsize).
 *
 * @formatConstant IPv4 addresses are 32 bits, IPv6 addresses 128 (RFC 791, RFC 8200)
 */
const familyWidth = {
	ipv4: { bits: 32, bytes: 4 },
	ipv6: { bits: 128, bytes: 16 }
} as const satisfies {
	readonly [F in NetFamily]: { readonly bits: number; readonly bytes: number }
}

/** PostgreSQL's code of a family, PGSQL_AF_INET and PGSQL_AF_INET6, which network_cmp subtracts. */
const familyCode = { ipv4: 2, ipv6: 3 } as const satisfies { readonly [F in NetFamily]: number }

/** The value of a text the port refuses: inet_in's and cidr_in's "invalid input syntax" (ENOENT or EMSGSIZE). */
const refused = undefined

/** The code unit at `i` of `src`, or 0 past its end: C's view of a string, whose terminator reads as NUL. */
const at = (src: string, i: number): number => (i < src.length ? src.charCodeAt(i) : 0)

/** `isdigit` of an ASCII code unit, under the C locale PostgreSQL's port reads it in. */
const isDigit = (ch: number): boolean => ch >= 0x30 && ch <= 0x39

/** A hexadecimal digit's value, of either case, or -1 for any other code unit. */
const hexValue = (ch: number): number => {
	if (ch >= 0x30 && ch <= 0x39) {
		return ch - 0x30
	}
	if (ch >= 0x61 && ch <= 0x66) {
		return ch - 0x61 + 10
	}
	if (ch >= 0x41 && ch <= 0x46) {
		return ch - 0x41 + 10
	}
	return -1
}

/** `n * 10 + d` in a C int, wrapping as PostgreSQL's build (-fwrapv) wraps it. */
const decimalStep = (n: number, ch: number): number => (Math.imul(n, 10) + (ch - 0x30)) | 0

/** C's `a / b` of two ints: truncated toward zero. */
const cDivide = (a: number, b: number): number => Math.trunc(a / b)

/** A parse's address and mask length, as pg_inet_net_pton returns them into the struct network_in zeroed. */
interface Parsed {
	readonly bits: number
	readonly address: Uint8Array
}

/**
 * inet_cidr_pton_ipv4 (inet_net_pton.c): cidr_in's IPv4 parse, of `size` bytes. Dotted decimal octets, or `0x` and
 * hexadecimal nybbles, then an optional `/` and mask length; a text that states none takes its class's mask, widened to
 * cover every octet it states, and 4 for a bare class D 224.
 */
const cidrPtonIpv4 = (src: string, size0: number): Parsed | undefined => {
	const dst: Array<number> = []
	let size = size0
	let i = 0
	let ch = at(src, i++)
	let tmp = 0
	if (
		ch === 0x30 &&
		(at(src, i) === 0x78 || at(src, i) === 0x58) &&
		hexValue(at(src, i + 1)) >= 0
	) {
		if (size <= 0) {
			return refused
		}
		let dirty = 0
		i++
		for (;;) {
			ch = at(src, i++)
			const n = hexValue(ch)
			if (ch === 0 || n < 0) {
				break
			}
			tmp = dirty === 0 ? n : (tmp << 4) | n
			dirty++
			if (dirty === 2) {
				if (size <= 0) {
					return refused
				}
				size--
				dst.push(tmp & 0xff)
				dirty = 0
			}
		}
		if (dirty !== 0) {
			if (size <= 0) {
				return refused
			}
			size--
			dst.push((tmp << 4) & 0xff)
		}
	} else if (isDigit(ch)) {
		for (;;) {
			tmp = 0
			for (;;) {
				tmp = tmp * 10 + (ch - 0x30)
				if (tmp > 255) {
					return refused
				}
				ch = at(src, i++)
				if (!isDigit(ch)) {
					break
				}
			}
			if (size <= 0) {
				return refused
			}
			size--
			dst.push(tmp)
			if (ch === 0 || ch === 0x2f) {
				break
			}
			if (ch !== 0x2e) {
				return refused
			}
			ch = at(src, i++)
			if (!isDigit(ch)) {
				return refused
			}
		}
	} else {
		return refused
	}
	let bits = -1
	if (ch === 0x2f && isDigit(at(src, i)) && dst.length > 0) {
		ch = at(src, i++)
		bits = 0
		for (;;) {
			bits = decimalStep(bits, ch)
			ch = at(src, i++)
			if (!isDigit(ch)) {
				break
			}
		}
		if (ch !== 0) {
			return refused
		}
		if (bits > 32) {
			return refused
		}
	}
	if (ch !== 0) {
		return refused
	}
	const first = dst[0]
	if (first === undefined) {
		return refused
	}
	if (bits === -1) {
		bits = first >= 240 ? 32 : first >= 224 ? 8 : first >= 192 ? 24 : first >= 128 ? 16 : 8
		if (bits < dst.length * 8) {
			bits = dst.length * 8
		}
		if (bits === 8 && first === 224) {
			bits = 4
		}
	}
	while (bits > dst.length * 8) {
		if (size <= 0) {
			return refused
		}
		size--
		dst.push(0)
	}
	return { bits, address: padded(dst, familyWidth.ipv4.bytes) }
}

/**
 * inet_net_pton_ipv4 (inet_net_pton.c): inet_in's IPv4 parse. Dotted decimal octets, then an optional `/` and mask
 * length; with no mask the text states all four octets, and the mask states no more octets than the text does.
 */
const inetPtonIpv4 = (src: string): Parsed | undefined => {
	const dst: Array<number> = []
	let size = 4
	let i = 0
	let ch = 0
	for (;;) {
		ch = at(src, i++)
		if (!isDigit(ch)) {
			break
		}
		let tmp = 0
		for (;;) {
			tmp = tmp * 10 + (ch - 0x30)
			if (tmp > 255) {
				return refused
			}
			ch = at(src, i++)
			if (!isDigit(ch)) {
				break
			}
		}
		if (size === 0) {
			return refused
		}
		size--
		dst.push(tmp)
		if (ch === 0 || ch === 0x2f) {
			break
		}
		if (ch !== 0x2e) {
			return refused
		}
	}
	let bits = -1
	if (ch === 0x2f && isDigit(at(src, i)) && dst.length > 0) {
		ch = at(src, i++)
		bits = 0
		for (;;) {
			bits = decimalStep(bits, ch)
			ch = at(src, i++)
			if (!isDigit(ch)) {
				break
			}
		}
		if (ch !== 0) {
			return refused
		}
		if (bits > 32) {
			return refused
		}
	}
	if (ch !== 0) {
		return refused
	}
	if (bits === -1) {
		if (dst.length !== 4) {
			return refused
		}
		bits = 32
	}
	if (dst.length === 0) {
		return refused
	}
	if (cDivide(bits, 8) > dst.length) {
		return refused
	}
	return { bits, address: padded(dst, familyWidth.ipv4.bytes) }
}

/**
 * getbits (inet_net_pton.c): the mask length a text from `i` to its end spells, decimal digits with no leading zero,
 * at most 128; undefined for any other text.
 */
const getBits = (src: string, i0: number): number | undefined => {
	let val = 0
	let n = 0
	for (let i = i0; i < src.length; i++) {
		const ch = src.charCodeAt(i)
		if (!isDigit(ch)) {
			return undefined
		}
		if (n++ !== 0 && val === 0) {
			return undefined
		}
		val = val * 10 + (ch - 0x30)
		if (val > 128) {
			return undefined
		}
	}
	return n === 0 ? undefined : val
}

/**
 * getv4 (inet_net_pton.c): the IPv4 octets an IPv6 text embeds, read from `i` to its end into `dst` at `at0`, each
 * decimal of no leading zero and at most 255, at most four, then an optional `/` and mask length (getBits). Its answer
 * is whether it read them, and the mask length it read, if any; it writes each octet as it reads it, as the C does.
 */
const getV4 = (
	src: string,
	i0: number,
	dst: Uint8Array,
	at0: number
): { readonly read: boolean; readonly bits: number | undefined } => {
	const no = { read: false, bits: undefined }
	let d = at0
	let val = 0
	let n = 0
	for (let i = i0; i < src.length; i++) {
		const ch = src.charCodeAt(i)
		if (isDigit(ch)) {
			if (n++ !== 0 && val === 0) {
				return no
			}
			val = val * 10 + (ch - 0x30)
			if (val > 255) {
				return no
			}
			continue
		}
		if (ch === 0x2e || ch === 0x2f) {
			if (d - at0 > 3) {
				return no
			}
			dst[d++] = val
			if (ch === 0x2f) {
				const bits = getBits(src, i + 1)
				return bits === undefined ? no : { read: true, bits }
			}
			val = 0
			n = 0
			continue
		}
		return no
	}
	if (n === 0 || d - at0 > 3) {
		return no
	}
	dst[d] = val
	return { read: true, bits: undefined }
}

/**
 * inet_cidr_pton_ipv6 (inet_net_pton.c), inet_in's and cidr_in's IPv6 parse alike: up to eight words of one to four
 * hexadecimal digits, one `::` standing for a run of zero words, an optional embedded IPv4 tail (getV4), and an optional
 * `/` and mask length (getBits), 128 where the text states none.
 */
const ptonIpv6 = (src: string): Parsed | undefined => {
	const tmp = new Uint8Array(16)
	const endp = 16
	let tp = 0
	let colonp = -1
	let i = 0
	if (at(src, i) === 0x3a) {
		i++
		if (at(src, i) !== 0x3a) {
			return refused
		}
	}
	let curtok = i
	let sawXdigit = false
	let val = 0
	let digits = 0
	let bits = -1
	for (;;) {
		const ch = at(src, i++)
		if (ch === 0) {
			break
		}
		const hex = hexValue(ch)
		if (hex >= 0) {
			val = (val << 4) | hex
			digits++
			if (digits > 4) {
				return refused
			}
			sawXdigit = true
			continue
		}
		if (ch === 0x3a) {
			curtok = i
			if (!sawXdigit) {
				if (colonp !== -1) {
					return refused
				}
				colonp = tp
				continue
			} else if (at(src, i) === 0) {
				return refused
			}
			if (tp + 2 > endp) {
				return refused
			}
			tmp[tp++] = (val >> 8) & 0xff
			tmp[tp++] = val & 0xff
			sawXdigit = false
			digits = 0
			val = 0
			continue
		}
		if (ch === 0x2e && tp + 4 <= endp) {
			const v4 = getV4(src, curtok, tmp, tp)
			if (v4.read) {
				if (v4.bits !== undefined) {
					bits = v4.bits
				}
				tp += 4
				sawXdigit = false
				break
			}
		}
		if (ch === 0x2f) {
			const slash = getBits(src, i)
			if (slash !== undefined) {
				bits = slash
				break
			}
		}
		return refused
	}
	if (sawXdigit) {
		if (tp + 2 > endp) {
			return refused
		}
		tmp[tp++] = (val >> 8) & 0xff
		tmp[tp++] = val & 0xff
	}
	if (bits === -1) {
		bits = 128
	}
	if (colonp !== -1) {
		const n = tp - colonp
		if (tp === endp) {
			return refused
		}
		for (let j = 1; j <= n; j++) {
			tmp[endp - j] = tmp[colonp + n - j] ?? 0
			tmp[colonp + n - j] = 0
		}
		tp = endp
	}
	if (tp !== endp) {
		return refused
	}
	return { bits, address: tmp }
}

/** `bytes` extended with zeros to `width` bytes: the struct network_in zeroed before the parse wrote into it. */
const padded = (bytes: ReadonlyArray<number>, width: number): Uint8Array => {
	const out = new Uint8Array(width)
	out.set(bytes.slice(0, width))
	return out
}

/**
 * addressOK (network.c): whether no bit of `address` past its first `bits` is set, which every cidr value holds.
 */
const addressOK = (address: Uint8Array, bits: number, family: NetFamily): boolean => {
	const { bits: maxbits, bytes: maxbytes } = familyWidth[family]
	if (bits === maxbits) {
		return true
	}
	let byte = cDivide(bits, 8)
	let mask = bits !== 0 ? 0xff >> (bits % 8) : 0xff
	while (byte < maxbytes) {
		if (((address[byte] ?? 0) & mask) !== 0) {
			return false
		}
		mask = 0xff
		byte++
	}
	return true
}

/** Whether `src` holds only ASCII and no NUL: what PostgreSQL's parse reads past, since every text it admits is ASCII. */
const isAsciiText = (src: string): boolean => {
	for (let i = 0; i < src.length; i++) {
		const ch = src.charCodeAt(i)
		if (ch === 0 || ch > 0x7f) {
			return false
		}
	}
	return true
}

/** Each carrier's refusals: a text its input function cannot read, and a cidr's bit set right of its mask. */
const syntaxFault = { inet: "inetSyntax", cidr: "cidrSyntax" } as const satisfies {
	readonly [C in NetCarrier]: ValueFault
}

/**
 * network_in (network.c): the value inet_in (`carrier` inet) or cidr_in (cidr) reads `src` as. Its family is IPv6
 * exactly when the text holds a colon; a mask past the family's width is refused, and so, for cidr, is a bit set right
 * of the mask (`cidrHostBits`). A text that is no ASCII, or holds a NUL, is no address of either.
 */
const parseNet = (src: string, carrier: NetCarrier): Result.Result<NetValue, ValueFault> => {
	if (!isAsciiText(src)) {
		return Result.err(syntaxFault[carrier])
	}
	const family: NetFamily = src.includes(":") ? "ipv6" : "ipv4"
	const parsed =
		family === "ipv6"
			? ptonIpv6(src)
			: carrier === "cidr"
				? cidrPtonIpv4(src, familyWidth.ipv4.bytes)
				: inetPtonIpv4(src)
	if (parsed === undefined || parsed.bits < 0 || parsed.bits > familyWidth[family].bits) {
		return Result.err(syntaxFault[carrier])
	}
	if (carrier === "cidr" && !addressOK(parsed.address, parsed.bits, family)) {
		return Result.err("cidrHostBits")
	}
	return Result.ok({ family, bits: parsed.bits, address: parsed.address })
}

/** inet_net_ntop_ipv4 (inet_net_ntop.c): the four octets, and the mask length unless it is 32. */
const ntopIpv4 = (address: Uint8Array, bits: number): string => {
	const octets = Array.from(address.subarray(0, 4), (b) => `${b}`).join(".")
	return bits === 32 ? octets : `${octets}/${bits}`
}

/**
 * inet_net_ntop_ipv6 (inet_net_ntop.c): the eight words in lowercase hexadecimal of no leading zero, the longest run of
 * two or more zero words, its first where two tie, as `::`; an address whose first six words alone are zero, or whose
 * first five are and whose sixth is ffff, ends in its last four bytes as dotted octets; and the mask length unless it
 * is 128. (The C's third case of embedded octets, seven zero words and a last word other than 1, never reaches its
 * test, which only the seventh word's turn reads and which a run of seven zero words skips.)
 */
const ntopIpv6 = (address: Uint8Array, bits: number): string => {
	const words = Array.from(
		{ length: 8 },
		(_, w) => ((address[2 * w] ?? 0) << 8) | (address[2 * w + 1] ?? 0)
	)
	let best = { base: -1, len: 0 }
	let cur = { base: -1, len: 0 }
	for (const [w, word] of words.entries()) {
		if (word === 0) {
			cur = cur.base === -1 ? { base: w, len: 1 } : { base: cur.base, len: cur.len + 1 }
		} else if (cur.base !== -1) {
			if (best.base === -1 || cur.len > best.len) {
				best = cur
			}
			cur = { base: -1, len: 0 }
		}
	}
	if (cur.base !== -1 && (best.base === -1 || cur.len > best.len)) {
		best = cur
	}
	if (best.base !== -1 && best.len < 2) {
		best = { base: -1, len: 0 }
	}
	let text = ""
	for (const [w, word] of words.entries()) {
		if (best.base !== -1 && w >= best.base && w < best.base + best.len) {
			if (w === best.base) {
				text += ":"
			}
			continue
		}
		if (w !== 0) {
			text += ":"
		}
		if (
			w === 6 &&
			best.base === 0 &&
			(best.len === 6 ||
				(best.len === 7 && words[7] !== 0x0001) ||
				(best.len === 5 && words[5] === 0xffff))
		) {
			text += Array.from(address.subarray(12, 16), (b) => `${b}`).join(".")
			break
		}
		text += word.toString(16)
	}
	if (best.base !== -1 && best.base + best.len === 8) {
		text += ":"
	}
	return bits === 128 ? text : `${text}/${bits}`
}

/**
 * inet_out (network.c network_out): an inet's text, typed as Inet: an IPv4 address's four dotted octets, an IPv6
 * address's words, each holding what Inet's language spells.
 */
const inetText = (value: NetValue): Inet => {
	if (value.family === "ipv4") {
		const [a, b, c, d] = Array.from(value.address.subarray(0, 4), (o) => `${o}`)
		return `${a ?? "0"}.${b ?? "0"}.${c ?? "0"}.${d ?? "0"}${value.bits === 32 ? "" : `/${value.bits}`}`
	}
	const text = ntopIpv6(value.address, value.bits)
	const colon = text.indexOf(":")
	return `${text.slice(0, colon)}:${text.slice(colon + 1)}`
}

/** cidr_out (network.c network_out): a cidr's text, its address as inet_out prints it and, always, its mask length. */
const cidrText = (value: NetValue): Cidr => {
	const address =
		value.family === "ipv4"
			? ntopIpv4(value.address, familyWidth.ipv4.bits)
			: ntopIpv6(value.address, familyWidth.ipv6.bits)
	return `${address}/${value.bits}`
}

/**
 * bitncmp (network.c): the order of two addresses' first `n` bits, as memcmp orders their whole bytes, then bit by bit.
 */
const bitncmp = (l: Uint8Array, r: Uint8Array, n: number): number => {
	const whole = cDivide(n, 8)
	for (let b = 0; b < whole; b++) {
		const d = (l[b] ?? 0) - (r[b] ?? 0)
		if (d !== 0) {
			return d
		}
	}
	if (n % 8 === 0) {
		return 0
	}
	let lb = l[whole] ?? 0
	let rb = r[whole] ?? 0
	for (let b = n % 8; b > 0; b--) {
		const lh = (lb & 0x80) !== 0
		const rh = (rb & 0x80) !== 0
		if (lh !== rh) {
			return lh ? 1 : -1
		}
		lb = (lb << 1) & 0xff
		rb = (rb << 1) & 0xff
	}
	return 0
}

/**
 * network_cmp (network.c), the order of inet's and cidr's B-tree class: by family, IPv4 first; then by the addresses'
 * bits under the shorter mask; then by mask length, shorter first; then by the whole address.
 */
export const compareNet = (a: NetValue, b: NetValue): -1 | 0 | 1 => {
	const order =
		a.family === b.family
			? bitncmp(a.address, b.address, Math.min(a.bits, b.bits)) ||
				a.bits - b.bits ||
				bitncmp(a.address, b.address, familyWidth[a.family].bits)
			: familyCode[a.family] - familyCode[b.family]
	return order < 0 ? -1 : order > 0 ? 1 : 0
}

/**
 * The containment relations of two network values, PostgreSQL's `<<=` (network_subeq, `within`), `<<`
 * (network_sub, `strictlyWithin`) and `&&` (network_overlap, `overlaps`), each false for two values of two families:
 * `a <<= b` holds where a's mask is no shorter than b's and a's address agrees with b's on b's mask, `a << b` where a's
 * mask is moreover longer, and `a && b` where the two agree on the shorter mask. `>>=` and `>>` are the first two with
 * their operands swapped.
 */
export const netWithin = (a: NetValue, b: NetValue): boolean =>
	a.family === b.family && a.bits >= b.bits && bitncmp(a.address, b.address, b.bits) === 0

export const netStrictlyWithin = (a: NetValue, b: NetValue): boolean =>
	a.family === b.family && a.bits > b.bits && bitncmp(a.address, b.address, b.bits) === 0

export const netOverlaps = (a: NetValue, b: NetValue): boolean =>
	a.family === b.family && bitncmp(a.address, b.address, Math.min(a.bits, b.bits)) === 0

/**
 * The value a host value or an output text of `carrier` is, read by a caller that holds one PostgreSQL or the admission
 * made: inet_out's or cidr_out's text, or the `::text` of either (network_show), which states every mask. A text it
 * cannot read is a defect of its caller's.
 */
export const netValueOf = (text: string, carrier: NetCarrier): NetValue => {
	const parsed = parseNet(text, carrier)
	if (!parsed.ok) {
		defect(`a ${carrier} text PostgreSQL or an admission wrote, unread: ${parsed.error}`)
	}
	return parsed.value
}

/**
 * An inet's output text read into its one form (codec/read.ts): a result column's `::text`, network_show, which states
 * a whole mask inet_out omits ('1.2.3.4/32'), read as the value it spells and printed as inet_out prints it ('1.2.3.4').
 */
export const convertInet = (text: string): Inet => inetText(netValueOf(text, "inet"))

/** A cidr's output text read into its one form: its `::text` is cidr_out's text already, read and printed alike. */
export const convertCidr = (text: string): Cidr => cidrText(netValueOf(text, "cidr"))

/**
 * The public parse of an inet: any value, refused unless it is a text inet_in admits (`inetSyntax`), and otherwise the
 * Inet of its value's printed text. A server holding a request's address as a header's text gets the Inet an inet
 * column, parameter, fact or attested context takes through it, once.
 */
export const admitInet = (input: unknown): Result.Result<Inet, ValueFault> =>
	typeof input === "string"
		? Result.map(parseNet(input, "inet"), inetText)
		: Result.err("inetSyntax")

/**
 * The public parse of a cidr: any value, refused unless it is a text cidr_in admits (`cidrSyntax`, or `cidrHostBits`
 * for a bit set right of its mask), and otherwise the Cidr of its value's printed text.
 */
export const admitCidr = (input: unknown): Result.Result<Cidr, ValueFault> =>
	typeof input === "string"
		? Result.map(parseNet(input, "cidr"), cidrText)
		: Result.err("cidrSyntax")

/** Whether a text is an inet's one form: a text inet_in reads, as inet_out prints the value it reads. */
export const isInetText = (text: string): text is Inet => {
	const inet = admitInet(text)
	return inet.ok && inet.value === text
}

/** Whether a text is a cidr's one form: a text cidr_in reads, as cidr_out prints the value it reads. */
export const isCidrText = (text: string): text is Cidr => {
	const cidr = admitCidr(text)
	return cidr.ok && cidr.value === text
}

/** The inet operations, beside the Inet type of the same name. */
export const Inet = Object.freeze({ parse: admitInet })

/** The cidr operations, beside the Cidr type of the same name. */
export const Cidr = Object.freeze({ parse: admitCidr })
