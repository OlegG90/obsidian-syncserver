-- A live node never sits under a deleted folder (#431). Deleting a folder marks the folder and
-- nothing under it; a client deletes what is in it first, deepest first (docs/04). A folder deleted
-- with live content left the content live under a parent no listing shows — every participant's
-- copy of it, once the delete fanned out — and a client placing it by its parent put it at the top
-- of the vault. DEFERRED: a pass over a subtree (catch-up, a restore lifting its ancestors) may
-- touch parent and child in either order, and only the state at COMMIT must hold; the check
-- re-reads the row rather than trusting NEW.
CREATE FUNCTION nodes_check_live_under_live() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    cur  nodes%ROWTYPE;
    held uuid;
BEGIN
    SELECT * INTO cur FROM nodes WHERE vault_id = NEW.vault_id AND id = NEW.id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF cur.deleted_at IS NULL THEN
        IF EXISTS (SELECT 1 FROM nodes p
                    WHERE p.vault_id = cur.vault_id AND p.id = cur.parent_id AND p.deleted_at IS NOT NULL) THEN
            RAISE EXCEPTION 'node % is live, but its folder % is deleted', cur.id, cur.parent_id
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
    END IF;

    SELECT c.id INTO held FROM nodes c
     WHERE c.vault_id = cur.vault_id AND c.parent_id = cur.id AND c.deleted_at IS NULL
     LIMIT 1;
    IF held IS NOT NULL THEN
        RAISE EXCEPTION 'folder % cannot be deleted while it still holds live node %; delete what is in it first',
            cur.id, held USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER nodes_live_under_live
    AFTER INSERT OR UPDATE OF parent_id, deleted_at ON nodes
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION nodes_check_live_under_live();
