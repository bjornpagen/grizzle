import { Buffer } from "node:buffer"
import { generateKeyPairSync, sign } from "node:crypto"
import { Duplex, type DuplexOptions } from "node:stream"
import { createSecureContext, type SecureContext, TLSSocket } from "node:tls"
import { Array as Arr, String as Str } from "effect"
import type { PgSocket } from "#adapter/types/driver.ts"
import type { Transport } from "#adapter/types/layer.ts"

/**
 * TLS that a test terminates itself, in memory, on grizzle's public transport: a test's own certificate authority and a
 * server certificate it signs, and an endpoint whose every connection is a pair of streams in memory, the client's end
 * a socket the driver connects (PgSocket), the server's end answering the SSLRequest with S and terminating
 * verify-full TLS. grizzle reaches it as it reaches any server (memoryTransport), its CA given as `ca`, so a test's
 * protocol tap or fake server sits behind the same SSLRequest and verify-full TLS every connection makes.
 *
 * In memory, a byte the server's end writes reaches the client's end in the same call, and the driver reads it there:
 * so a test that counts what it let through knows the driver has read exactly that.
 *
 * A DER element: its tag, its length (short form below 128, long form from it), and its content.
 */
const der = (tag: number, content: Uint8Array): Buffer => {
	const length: Array<number> = []
	for (let rest = content.length; rest > 0; rest = Math.floor(rest / 256)) {
		length.unshift(rest % 256)
	}
	const head = content.length < 0x80 ? [content.length] : [0x80 | length.length, ...length]
	return Buffer.concat([Buffer.from([tag, ...head]), content])
}

const sequence = (parts: ReadonlyArray<Uint8Array>): Buffer => der(0x30, Buffer.concat(parts))

const ascii = (text: string): Buffer => Buffer.from(text, "latin1")

/** The OID 1.2.840.10045.4.3.2, ecdsa-with-SHA256 (RFC 5758 section 3.2), as its DER element. */
const ecdsaWithSha256 = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])

/** The OID 2.5.4.3, commonName (RFC 5280 appendix A.1), as its DER element. */
const commonName = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03])

/** The OID 2.5.29.17, subjectAltName (RFC 5280 section 4.2.1.6), as its DER element. */
const subjectAltName = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x11])

/** The OID 2.5.29.19, basicConstraints (RFC 5280 section 4.2.1.9), as its DER element. */
const basicConstraints = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x13])

/** DER's TRUE. */
const derTrue = Buffer.from([0x01, 0x01, 0xff])

/** A certificate's version, v3: [0] EXPLICIT INTEGER 2. */
const version3 = der(0xa0, der(0x02, Buffer.from([0x02])))

/** The signature algorithm of every certificate here: ecdsa-with-SHA256, with no parameters. */
const signatureAlgorithm = sequence([ecdsaWithSha256])

/** A Name of one relative distinguished name, its common name `name`. */
const nameOf = (name: string): Buffer =>
	sequence([der(0x31, sequence([commonName, der(0x0c, Buffer.from(name, "utf8"))]))])

/** From 2000-01-01 to 2049-12-31, UTCTime's last year: a validity no test outlives, read from no clock. */
const validity = sequence([der(0x17, ascii("000101000000Z")), der(0x17, ascii("491231235959Z"))])

/** An extension: its OID, critical or not, and its value's DER, wrapped in an OCTET STRING. */
const extension = (oid: Buffer, critical: boolean, value: Buffer): Buffer =>
	sequence(critical ? [oid, derTrue, der(0x04, value)] : [oid, der(0x04, value)])

/** A P-256 key pair: its SubjectPublicKeyInfo in DER, and its private key in PKCS #8 PEM. */
const keyPair = () =>
	generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
		publicKeyEncoding: { type: "spki", format: "der" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" }
	})

/**
 * A certificate (RFC 5280 section 4.1): `serial`, issued by `issuer` to `subject`, whose key is `spki`, with
 * `extensions`, signed with the issuer's private key `signer`.
 */
const certificate = (options: {
	readonly serial: number
	readonly issuer: Buffer
	readonly subject: Buffer
	readonly spki: Buffer
	readonly extensions: ReadonlyArray<Buffer>
	readonly signer: string
}): Buffer => {
	const tbs = sequence([
		version3,
		der(0x02, Buffer.from([options.serial])),
		signatureAlgorithm,
		options.issuer,
		validity,
		options.subject,
		options.spki,
		der(0xa3, sequence(options.extensions))
	])
	const signature = sign("sha256", tbs, options.signer)
	return sequence([
		tbs,
		signatureAlgorithm,
		der(0x03, Buffer.concat([Buffer.from([0x00]), signature]))
	])
}

/** A certificate's DER as PEM text. */
const pem = (certificateDer: Buffer): string => {
	const text = certificateDer.toString("base64")
	const lines: Array<string> = []
	for (let at = 0; at < text.length; at += 64) {
		lines.push(Str.slice(at, at + 64)(text))
	}
	return `-----BEGIN CERTIFICATE-----\n${Arr.join(lines, "\n")}\n-----END CERTIFICATE-----\n`
}

/**
 * What a test's TLS endpoint presents: its CA's certificate, which a client verifies against as `ca`, the name its
 * server certificate carries, which a client verifies as `servername`, and the server's context.
 */
export interface TlsMaterial {
	readonly ca: string
	readonly servername: string
	readonly context: SecureContext
}

/**
 * A fresh certificate authority, and a server certificate it signs for `servername` (a DNS name, its only
 * subjectAltName), both P-256 with ECDSA-SHA256, and the server's TLS context presenting it.
 */
export const tlsMaterial = (servername: string): TlsMaterial => {
	const authority = keyPair()
	const authorityName = nameOf("grizzle test CA")
	const caDer = certificate({
		serial: 1,
		issuer: authorityName,
		subject: authorityName,
		spki: authority.publicKey,
		extensions: [extension(basicConstraints, true, sequence([derTrue]))],
		signer: authority.privateKey
	})
	const server = keyPair()
	const serverDer = certificate({
		serial: 2,
		issuer: authorityName,
		subject: nameOf(servername),
		spki: server.publicKey,
		extensions: [extension(subjectAltName, false, sequence([der(0x82, ascii(servername))]))],
		signer: authority.privateKey
	})
	return {
		ca: pem(caDer),
		servername,
		context: createSecureContext({ key: server.privateKey, cert: pem(serverDer) })
	}
}

/**
 * The client's end of a connection in memory: a socket pg connects, whose connect reports the connection on the next
 * turn, once the server's end is accepted, and whose no-delay, keep-alive and ref are nothing in memory.
 */
class MemorySocket extends Duplex implements PgSocket {
	readonly #connected: () => void

	constructor(options: DuplexOptions, connected: () => void) {
		super(options)
		this.#connected = connected
	}

	connect(): this {
		process.nextTick(() => {
			this.#connected()
			this.emit("connect")
		})
		return this
	}

	setNoDelay(): this {
		return this
	}

	setKeepAlive(): this {
		return this
	}

	ref(): this {
		return this
	}

	unref(): this {
		return this
	}
}

/**
 * A connection in memory: the client's end, and the server's, which `accept` is handed when the client connects. A
 * write to either end reaches the other in the same call; ending either ends the other's reading, and an end whose
 * reading ends ends its own writing, as Node's TCP socket does (allowHalfOpen false), so a connection either side ends
 * closes on both, the TLS over each end with it; destroying either destroys both.
 */
const memoryConnection = (accept: (server: Duplex) => void): MemorySocket => {
	const server: Duplex = new Duplex({
		allowHalfOpen: false,
		read() {},
		write(chunk: Uint8Array, ...[, callback]) {
			client.push(chunk)
			callback()
		},
		final(callback) {
			client.push(null)
			callback()
		},
		destroy(error, callback) {
			client.destroy()
			callback(error)
		}
	})
	const client: MemorySocket = new MemorySocket(
		{
			allowHalfOpen: false,
			read() {},
			write(chunk: Uint8Array, ...[, callback]) {
				server.push(chunk)
				callback()
			},
			final(callback) {
				server.push(null)
				callback()
			},
			destroy(error, callback) {
				server.destroy()
				callback(error)
			}
		},
		() => {
			accept(server)
		}
	)
	return client
}

/** The SSLRequest message: its length, 8, and the request code 80877103. */
const sslRequest = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])

/** The server's yes to an SSLRequest. */
const sslAccepted = Buffer.from("S", "latin1")

/**
 * A TLS endpoint in memory: `open` makes the client's end of a new connection, whose server's end answers the
 * SSLRequest with S, then terminates TLS with `material` and hands `serve` the TLS socket, whose plaintext is the
 * client's. A first message that is no SSLRequest ends the connection: nothing is ever served in plaintext.
 */
export const memoryEndpoint = (
	material: TlsMaterial,
	serve: (secure: TLSSocket) => void
): (() => PgSocket) => {
	const accept = (server: Duplex): void => {
		server.once("data", (first: Buffer) => {
			if (!first.equals(sslRequest)) {
				server.destroy()
				return
			}
			const secure = new TLSSocket(server, { isServer: true, secureContext: material.context })
			server.write(sslAccepted)
			serve(secure)
		})
	}
	return () => memoryConnection(accept)
}

/**
 * The transport that reaches a memory endpoint: its sockets, and its CA and servername, verified as any server's. Its
 * host is the servername and its port PostgreSQL's, which a socket in memory never dials.
 */
export const memoryTransport = (material: TlsMaterial, open: () => PgSocket): Transport => ({
	kind: "sslRequest",
	host: material.servername,
	port: 5432,
	open,
	ca: material.ca,
	servername: material.servername
})
