import { int4Max } from "#compiler/core/canonical.ts"
import { maxAllocSize } from "#compiler/core/errors.ts"

/**
 * The longest message a PostgreSQL backend reads from a client, as the message's Int32 length counts it, itself
 * included: a Query or Parse message holding a statement, or a Bind message carrying one execution's parameters, each
 * read under it by SocketBackend (src/backend/tcop/postgres.c). A longer one is "invalid message length"
 * (src/backend/libpq/pqcomm.c pq_getmessage), after which the backend ends the connection without an ErrorResponse,
 * so a statement whose text is longer, in UTF-8 bytes, is refused as ResourceBound (statementBytes) when it is printed,
 * and a statement whose Parse message, its text with its name and fields, or whose Bind message would be longer is
 * refused on the host as InputTooLarge before its flight is sent (the shell's wire/batch.ts).
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0's frontend/backend protocol
 * @unit bytes
 * @scope one message from client to server, as its Int32 length counts it, itself included
 * @derivation a protocol constant, PQ_LARGE_MESSAGE_LIMIT, which libpq.h defines as one less than MaxAllocSize:
 *   "#define PQ_LARGE_MESSAGE_LIMIT (MaxAllocSize - 1)"
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/include/libpq/libpq.h#L34, verified 2026-11-20)
 * @from {@link maxAllocSize}
 */
export const messageMaxBytes = maxAllocSize - 1

/**
 * The most bytes one SSL_write takes, a C int's greatest value. Node's TLS socket hands each write it is given to one
 * SSL_write, a corked flight's chunks concatenated, and OpenSSL refuses a length past INT_MAX, which wraps negative, as
 * "bad length".
 *
 * @limitKind derived
 * @owner OpenSSL 4.1.0, as Node 26.13.0 bundles it
 * @unit bytes
 * @scope the plaintext of one SSL_write: one write Node's TLS socket is handed, a corked flight's chunks together
 * @derivation SSL_write takes its length as a C int and refuses a negative one, "int SSL_write(SSL *s, const void
 *   *buf, int num)" and "if (num < 0) {"
 *   (https://github.com/nodejs/node/blob/v26.13.0/deps/openssl/openssl/ssl/ssl_lib.c#L2647-L2653, verified
 *   2026-11-07), and Node's TLS socket passes it a write's chunks as one length, "written = SSL_write(ssl_.get(),
 *   bs->Data(), length);" (https://github.com/nodejs/node/blob/v26.13.0/src/crypto/crypto_tls.cc#L1181), so a write is
 *   at most INT_MAX bytes, the greatest integer
 * @from {@link int4Max}
 */
const sslWriteMaxBytes = int4Max

/**
 * The most bytes one send on a macOS socket carries: a write or a writev past INT_MAX is refused whole with EINVAL.
 * Node's TLS socket writes the ciphertext of one SSL_write to its socket in one call, so a flight's ciphertext is one
 * send.
 *
 * @limitKind derived
 * @owner macOS's kernel, XNU 12377.121.6
 * @unit bytes
 * @scope one write or writev to a socket on macOS: the ciphertext of one SSL_write, which Node's TLS socket writes in
 *   one call
 * @derivation sosend refuses "if (resid < 0 || resid > INT_MAX ||" with "error = EINVAL;"
 *   (https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.121.6/bsd/kern/uipc_socket.c#L2122-L2124, verified
 *   2026-11-07); Node's TLS socket sizes one buffer for the whole ciphertext of a write, "allocate_hint_ = (size /
 *   kThreshold + 1) * (kThreshold + 5 + 32);"
 *   (https://github.com/nodejs/node/blob/v26.13.0/src/crypto/crypto_bio.h#L110), and hands what its buffers hold to
 *   its socket in one call, "StreamWriteResult res = underlying_stream()->Write(bufs, count);"
 *   (https://github.com/nodejs/node/blob/v26.13.0/src/crypto/crypto_tls.cc#L770). Linux refuses no length: "On Linux,
 *   write() (and similar system calls) will transfer at most 0x7ffff000 (2,147,479,552) bytes, returning the number of
 *   bytes actually transferred." (https://man7.org/linux/man-pages/man2/write.2.html, verified 2026-11-07), and libuv
 *   writes the rest
 * @from {@link int4Max}
 */
const socketSendMaxBytes = int4Max

/**
 * The most plaintext one TLS record carries. OpenSSL cuts a write into records of this many bytes but the last, its
 * max_send_fragment's default, which a peer lowers only when the client asks for max_fragment_length, and Node's TLS
 * socket asks for none.
 *
 * @limitKind published
 * @owner TLS 1.2 (RFC 5246), and TLS 1.3 alike (RFC 8446)
 * @unit bytes
 * @scope the plaintext fragment of one TLS record
 * @constraint protocol constant
 * @source https://www.rfc-editor.org/rfc/rfc5246#section-6.2.1
 * @quote The length MUST NOT exceed 2^14.
 * @verified 2026-11-07
 */
const tlsRecordPlaintextBytes = 2 ** 14

/**
 * The most bytes one TLS 1.2 record's protected fragment holds, its plaintext and all its cipher adds: a MAC, an
 * explicit IV, a nonce or padding. TLS 1.3's is 2^14 + 256 (RFC 8446 section 5.2), so a session of either version stays
 * within it.
 *
 * @limitKind published
 * @owner TLS 1.2 (RFC 5246)
 * @unit bytes
 * @scope the protected fragment of one TLS record, as TLSCiphertext.length counts it
 * @constraint protocol constant
 * @source https://www.rfc-editor.org/rfc/rfc5246#section-6.2.3
 * @quote The length MUST NOT exceed 2^14 + 2048.
 * @verified 2026-11-07
 */
const tlsRecordProtectedBytes = 2 ** 14 + 2048

/**
 * The header in front of every TLS record's fragment: its ContentType, an enum of one byte, its ProtocolVersion, two
 * uint8, and its uint16 length.
 *
 * @limitKind published
 * @owner TLS 1.2 (RFC 5246), and TLS 1.3 alike (RFC 8446)
 * @unit bytes
 * @scope the header of one TLS record, in front of its fragment
 * @constraint protocol constant
 * @source https://www.rfc-editor.org/rfc/rfc5246#section-6.2.3
 * @quote ContentType type; ProtocolVersion version; uint16 length;
 * @verified 2026-11-07
 */
const tlsRecordHeaderBytes = 1 + 2 + 2

/**
 * The most bytes one flight writes, every message pg writes for it corked into one write. Node's TLS socket hands that
 * write to one SSL_write and its ciphertext to one send on its socket, so a longer flight fails whole: OpenSSL's "bad
 * length" past INT_MAX, or the socket's EINVAL once TLS's records have grown it past INT_MAX. The connection ends with
 * the flight's end unsent, which a flight carrying COMMIT would report as CommitLost though nothing committed, so a
 * flight past this is refused on the host as InputTooLarge before any byte of it is written (the shell's wire/batch.ts).
 *
 * @limitKind derived
 * @owner the TLS every session runs over: OpenSSL's SSL_write, TLS 1.2's records and macOS's socket send
 * @unit bytes
 * @scope one flight: the Closes in front of it, BEGIN, the prologue, each statement's Parse, Bind, Describe, Execute
 *   and Sync, and the transaction's end, as pg writes them
 * @derivation a flight's plaintext must fit one SSL_write, and its ciphertext one send. TLS cuts the plaintext into
 *   records of tlsRecordPlaintextBytes each but the last, and sends each as its header and a protected fragment of at
 *   most tlsRecordProtectedBytes, TLS 1.2's bound, the larger of the two versions a session negotiates (Node's and
 *   PostgreSQL's least is TLS 1.2). So the flight is at most the whole records whose worst ciphertext fits one send,
 *   and at most what one SSL_write takes
 * @from {@link sslWriteMaxBytes}, {@link socketSendMaxBytes}, {@link tlsRecordPlaintextBytes}, {@link
 *   tlsRecordProtectedBytes}, {@link tlsRecordHeaderBytes}
 */
export const flightMaxBytes = Math.min(
	sslWriteMaxBytes,
	Math.floor(socketSendMaxBytes / (tlsRecordHeaderBytes + tlsRecordProtectedBytes)) *
		tlsRecordPlaintextBytes
)
/**
 * The two texts a value takes between grizzle and PostgreSQL, two types so that neither is ever read as the other:
 *
 * - `ParamText` is what grizzle sends: a parameter's text, which PostgreSQL's input function of the parameter's type
 *   reads. Only an encoder writes one (codec/scalar.ts, and codec/recordset.ts for an array of them), and only the wire
 *   sends one; nothing in grizzle reads one back. A bytes or text column's array is sent in binary instead, a
 *   `ParamBinary` (codec/bytea.ts), which PostgreSQL's receive function reads: the column's type chooses it, never the
 *   array's size.
 * - `OutputText` is what PostgreSQL sends back: a result cell's text, its type's output function's. Only the wire
 *   receives one (packages/grizzle/src/adapter/wire/session.ts), and only a reader reads one (codec/read.ts). No
 *   column's text is a bytes value's: a bytes column travels in chunks, which its statement's delivery assembles into
 *   the value itself, a `Cell` (codec/delivery.ts).
 *
 * The two spell one value differently wherever PostgreSQL's input and output forms differ, a set's X and hex digits in
 * and its 0s and 1s out among them, so a reader fed the other form would read another value; no function takes a
 * plain string where either belongs, and neither is assignable to the other.
 */
declare const paramTextBrand: unique symbol
declare const outputTextBrand: unique symbol

/** A parameter's text, as an encoder writes it for PostgreSQL's input function. */
export type ParamText = string & { readonly [paramTextBrand]: true }

declare const paramBinaryBrand: unique symbol

/**
 * A parameter's binary value, as an encoder writes it for PostgreSQL's receive function, in the array binary format
 * (codec/bytea.ts): a bytes column's bytea[], or a text column's text[] of its values' UTF-8 bytes, chosen by the
 * column's type. The driver sends it with format code 1, since it is a Uint8Array.
 */
export type ParamBinary = Uint8Array<ArrayBuffer> & { readonly [paramBinaryBrand]: true }

/** What one placeholder carries: its text, or a bytes or text column's binary array. */
export type Param = ParamText | ParamBinary

/** A result cell's text, as PostgreSQL's output function writes it. */
export type OutputText = string & { readonly [outputTextBrand]: true }

/** A statement's answer rows as PostgreSQL sent them: each row's cells, each its output text. */
export type OutputRows = ReadonlyArray<ReadonlyArray<OutputText>>

/**
 * One cell of a delivered row: a column's output text, or a bytes column's value, assembled from the chunks its
 * statement delivered into a fresh array over a buffer of its own (codec/delivery.ts). A text column's cell is never a
 * value and a bytes column's never a text.
 */
export type Cell = OutputText | Uint8Array<ArrayBuffer>

/** A statement's rows as its delivery assembles them: each row's cells, in its statement's output order. */
export type AssembledRows = ReadonlyArray<ReadonlyArray<Cell>>

/**
 * The one text bytes travel in from PostgreSQL to the host: RFC 4648's base64url alphabet, which PostgreSQL's
 * `encode(x, 'base64url')` writes (lower/delivery.ts bytesWireText) and the host's base64 decoder reads (`intoWire`,
 * `ofWire`), unpadded and with no line breaks. A bytes column's chunks and a digest's result text are both of it.
 *
 * @formatConstant PostgreSQL 19's encode format name and the TC39 base64 decoder's alphabet option, RFC 4648 §5
 */
export const bytesWireAlphabet = "base64url"

/** Writes the bytes a wire text spells (`bytesWireAlphabet`) into `into` from its start: a bytes value's chunk. */
export const intoWire = (into: Uint8Array, text: string): void => {
	into.setFromBase64(text, { alphabet: bytesWireAlphabet })
}

/** The bytes a wire text spells (`bytesWireAlphabet`), in a fresh array over its own buffer: a digest's result text. */
export const ofWire = (text: string): Uint8Array<ArrayBuffer> =>
	Uint8Array.fromBase64(text, { alphabet: bytesWireAlphabet })
