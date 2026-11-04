import { Brand } from "effect"
type TableName = string & Brand.Brand<"TableName">
type SqlText = string & { readonly sqlText: true }
declare const nominal: <A, B extends A>() => (value: A) => B
export const table = Brand.nominal<TableName>()
export const sql = nominal<string, SqlText>()
