#!/bin/sh
# Standalone reproduction of nodejs/node#65994 with the node on PATH: `sh repro.sh`. TextEncoder.encodeInto into a
# destination of exactly a text's UTF-8 length must write the whole text (WHATWG Encoding, "encodeInto"). On Node
# v25.4.0 and later it stops one scalar short when the text holds a scalar of U+0400 to U+07FF and is long enough. Each
# line prints PASS or FAIL; a release carrying nodejs/node#65997 prints PASS on every line. The control lines pass today.
set -eu
node --input-type=module <<'JS'
const encoder = new TextEncoder()
const report = (label, text, spare) => {
	const length = Buffer.byteLength(text, "utf8")
	const { read, written } = encoder.encodeInto(text, new Uint8Array(length + spare))
	const ok = read === text.length && written === length
	console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${text.length} units, ${length} bytes, read ${read}, written ${written}`)
	return ok
}
console.log(`node ${process.version}, v8 ${process.versions.v8}`)
report("U+0400 x 258, exact destination", "Ѐ".repeat(258), 0)
report("'a' x 52 then U+0400, exact destination", "a".repeat(52) + "Ѐ", 0)
report("U+07FF x 4096, exact destination", "߿".repeat(4096), 0)
report("control: U+0400 x 257, exact destination (scalar path)", "Ѐ".repeat(257), 0)
report("control: U+0400 x 4096, one spare byte", "Ѐ".repeat(4096), 1)
report("control: U+0101 x 4096, exact destination", "ā".repeat(4096), 0)
report("control: U+0400 x 4096 then 'a', exact destination", "Ѐ".repeat(4096) + "a", 0)
report("control: U+00E9 x 4096 (one-byte string), exact destination", "é".repeat(4096), 0)
const fresh = encoder.encode("Ѐ".repeat(4096))
console.log(`${fresh.length === 8192 ? "PASS" : "FAIL"} control: encode() of U+0400 x 4096 gives ${fresh.length} bytes`)
JS
