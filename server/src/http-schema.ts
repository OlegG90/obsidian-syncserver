/**
 * How a route attaches the schema of its body (D-143, issue #468).
 *
 * The schemas themselves are `shared`'s (`shared/src/bodies.ts`), one per body, with the type each route
 * reads inferred from the same declaration. What lives here is the one decision a route makes about its
 * schema: whether it may be sent no body at all.
 *
 * **Bodies only.** A path or query parameter that names nothing is answered `404` by its handler, which
 * is what that status means here (D-20); a schema would turn it into a `400` and say a malformed id
 * exists.
 */
type Schema = object;

/** A route's options with a body schema — the one shape every route here passes it in. */
export const body = (schema: Schema): { schema: { body: Schema } } => ({ schema: { body: schema } });

/**
 * The same schema, for a route that asks whether a body was sent and answers an empty request with
 * its own code (`bad_vault_id`, `login_required`). Without `type`, the schema's `properties` apply only
 * to an object, so no body passes and a body that is sent is checked as before.
 */
export const optional = (schema: Schema): Schema => {
  const { type: _object, ...rest } = schema as { type?: unknown };
  return rest;
};
