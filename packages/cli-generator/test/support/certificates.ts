import { Array as Arr, Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { finished } from "#test/support/process.ts"

/** A PEM file the fixture wrote: where it lies, for a child process's flag or variable, and its text. */
type Pem = Readonly<{ path: string; text: string }>

/** A leaf certificate and its private key. */
type CertificatePair = Readonly<{ cert: Pem; key: Pem }>

/** The two TLS origins of the TLS capture server. */
export type TlsOrigin = "A" | "B"

/**
 * The TEST-NET-1 literal (RFC 5737) each TLS origin's certificate also names, beside loopback, so a client can reach the
 * origin through a proxy's CONNECT under a host that is not loopback and still verify it.
 */
const tlsOriginAddresses: Readonly<Record<TlsOrigin, string>> = {
	A: "192.0.2.10",
	B: "192.0.2.11"
}

/**
 * The fixture's certificates: a test CA, a server leaf for each TLS origin naming 127.0.0.1, localhost and the origin's
 * TEST-NET-1 literal, and a client leaf for client authentication, each a P-256 key the CA signs.
 */
export type Certificates = Readonly<{
	ca: Pem
	servers: Readonly<Record<TlsOrigin, CertificatePair>>
	client: CertificatePair
}>

/** The subject every client certificate the fixture makes carries, as Node's X509Certificate prints it. */
export const clientSubject = "CN=capture-server client"

/** An openssl step that exited non-zero: its subcommand, its exit code and its stderr. */
class CertificateStepFailed extends Schema.TaggedError<
	CertificateStepFailed,
	{ readonly brand: unique symbol }
>()("CertificateStepFailed", {
	step: Schema.String,
	exitCode: Schema.Int,
	stderr: Schema.Uint8Array
}) {}

const ellipticKey: ReadonlyArray<string> = [
	"-newkey",
	"ec",
	"-pkeyopt",
	"ec_paramgen_curve:prime256v1",
	"-nodes"
]

/** Runs openssl with the arguments, failing with its stderr when it exits non-zero. */
const openssl = Effect.fn("certificates.openssl")(function* (
	step: string,
	args: ReadonlyArray<string>
) {
	const run = yield* finished(ChildProcess.make("openssl", [step, ...args], { stdout: "ignore" }))
	if (run.exitCode !== 0) {
		return yield* CertificateStepFailed.make({
			step,
			exitCode: run.exitCode,
			stderr: run.stderr
		})
	}
})

/** A leaf as openssl makes it: its name, the extensions its certificate carries and its serial. */
type Leaf = Readonly<{ name: string; extensions: ReadonlyArray<string>; serial: number }>

/** Makes one leaf in the directory: a key and a request, then the certificate the CA signs with the leaf's extensions. */
const makeLeaf = Effect.fn("certificates.leaf")(function* (directory: string, leaf: Leaf) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const file = (suffix: string) => path.join(directory, `${leaf.name}.${suffix}`)
	yield* fs.writeFileString(file("ext"), Arr.join(Arr.append(leaf.extensions, ""), "\n"))
	yield* openssl("req", [
		...ellipticKey,
		"-keyout",
		file("key"),
		"-out",
		file("csr"),
		"-subj",
		`/CN=capture-server ${leaf.name}`
	])
	yield* openssl("x509", [
		"-req",
		"-in",
		file("csr"),
		"-CA",
		path.join(directory, "ca.pem"),
		"-CAkey",
		path.join(directory, "ca.key"),
		"-set_serial",
		String(leaf.serial),
		"-days",
		"2",
		"-extfile",
		file("ext"),
		"-out",
		file("pem")
	])
	return {
		cert: { path: file("pem"), text: yield* fs.readFileString(file("pem")) },
		key: { path: file("key"), text: yield* fs.readFileString(file("key")) }
	}
})

/** The extensions of an origin's server leaf. */
const serverExtensions = (origin: TlsOrigin): ReadonlyArray<string> => [
	`subjectAltName=IP:127.0.0.1,DNS:localhost,IP:${tlsOriginAddresses[origin]}`,
	"basicConstraints=CA:FALSE",
	"extendedKeyUsage=serverAuth"
]

/**
 * Makes the fixture's certificates with openssl in a temporary directory the scope removes. openssl is the system's,
 * found on PATH.
 */
export const makeCertificates = Effect.fn("certificates.make")(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = yield* fs.makeTempDirectoryScoped({ prefix: "capture-server-tls-" })
	const caPath = path.join(directory, "ca.pem")
	yield* openssl("req", [
		"-x509",
		...ellipticKey,
		"-keyout",
		path.join(directory, "ca.key"),
		"-out",
		caPath,
		"-days",
		"2",
		"-subj",
		"/CN=capture-server test CA",
		"-addext",
		"basicConstraints=critical,CA:TRUE",
		"-addext",
		"keyUsage=critical,keyCertSign"
	])
	const servers = {
		A: yield* makeLeaf(directory, { name: "A", extensions: serverExtensions("A"), serial: 1 }),
		B: yield* makeLeaf(directory, { name: "B", extensions: serverExtensions("B"), serial: 2 })
	}
	const client = yield* makeLeaf(directory, {
		name: "client",
		extensions: ["basicConstraints=CA:FALSE", "extendedKeyUsage=clientAuth"],
		serial: 3
	})
	const certificates: Certificates = {
		ca: { path: caPath, text: yield* fs.readFileString(caPath) },
		servers,
		client
	}
	return certificates
})
