/**
 * The shape of a request body, declared beside its route and checked before the handler runs (issue #468).
 *
 * **What a schema refuses, and what it leaves alone.** It types every field the route reads, and it
 * requires the body to be an object where the handler reads it without asking whether there is one
 * (`obj`); a handler that asks keeps its own answer to an empty request (`optional`). It requires a field only when
 * nothing else would name it missing: a handler that answers `login_required` or `name_enc_required`
 * keeps that answer, because clients and the console read those codes, and a schema that pre-empted
 * them would replace a sentence with a path. What reaches a handler is therefore the right shape —
 * never `undefined` where an object was read, never a number where a string was decoded — and what is
 * wrong with it is said in one of two ways, both `400`: the handler's own code, or `invalid_request`
 * with the field the schema found (`docs/04`).
 *
 * **Bodies only.** A path or query parameter that names nothing is answered `404` by its handler, which
 * is what that status means here (D-20); a schema would turn it into a `400` and say a malformed id
 * exists.
 */
type Schema = Record<string, unknown>;

export const str: Schema = { type: 'string' };
export const int: Schema = { type: 'integer' };
/** Any value — for a field whose handler checks it itself and names the refusal. */
export const unchecked: Schema = {};

export const arrayOf = (items: Schema): Schema => ({ type: 'array', items });

/** An object, with these fields typed and these required. */
export const obj = (properties: Record<string, Schema>, required: readonly string[] = []): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

/**
 * A body the route accepts and does not need: typed when it is sent, and no refusal when it is not.
 * `properties` applies only to an object, so an absent body passes and a present one is checked.
 */
export const optional = (properties: Record<string, Schema>): Schema => ({ properties });

/** The name a node is placed under: encrypted, its HMAC, and the key that sealed it. */
export const placedName: Record<string, Schema> = { name_enc: str, name_hmac: str, name_key_id: str };

/** The key material a node write carries (`shared`'s `Material`): both lists optional, each entry whole. */
export const keyMaterial: { blob_envelopes: Schema; dedup_tags: Schema } = {
  blob_envelopes: arrayOf(obj({ sha256: str, scope_id: str, wrapped_key: str }, ['sha256', 'scope_id', 'wrapped_key'])),
  dedup_tags: arrayOf(obj({ sha256: str, scope_id: str, content_tag: str }, ['sha256', 'scope_id', 'content_tag'])),
};

/** A route's options with a body schema — the one shape every route here passes it in. */
export const body = (schema: Schema): { schema: { body: Schema } } => ({ schema: { body: schema } });
