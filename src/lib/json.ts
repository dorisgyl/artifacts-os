// A value that has been through JSON. Used for anything that crosses a Durable
// Object RPC boundary or is stored by a Workflow step, where `unknown` does not
// type-check as serialisable. Deliberately shallow: a recursive JSON type makes
// the RPC Serializable<> mapping explode.
export type Json = string | number | boolean | null | object;

export const toJson = <T>(v: T): Json => JSON.parse(JSON.stringify(v ?? null)) as Json;
