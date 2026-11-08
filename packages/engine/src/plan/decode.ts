/**
 * What the shell's decode sites read PostgreSQL's output texts by: each statement's delivery (codec/delivery.ts), each
 * column type's reader (codec/read.ts), and the bytes equality a reader's digest of a bytes cell defers to
 * (scalar/values/bytes.ts). The architecture's zones give this facade to the shell's readers alone, so no other module
 * of the shell reaches a reader.
 */
export { assembled, cellKindOf, type Delivery, deliveryOf } from "#compiler/codec/delivery.ts"
export { type ScalarReader, scalarReader } from "#compiler/codec/read.ts"
export { sameBytes } from "#compiler/scalar/values/bytes.ts"
