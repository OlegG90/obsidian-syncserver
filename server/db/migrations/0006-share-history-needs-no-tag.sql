-- A shared version owes its share envelope, not its share dedup tag (#397).
--
-- The envelope is what lets a participant open history, and re-wrapping a content key needs
-- no plaintext, so preparation can give one to every version. The tag it cannot: it is an HMAC
-- over plaintext that is on disk only for the live head — the split activation and unmarking
-- already make. The head's tag is `nodes_active_share_writes_have_key_material`'s to demand,
-- on the node, where the head lives. Asking it of every version refused every join of a folder
-- edited before it was shared, because the join copies that history.

CREATE OR REPLACE FUNCTION versions_check_active_share_material() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    s shares%ROWTYPE;
    n nodes%ROWTYPE;
BEGIN
    SELECT * INTO n FROM nodes WHERE vault_id = NEW.vault_id AND id = NEW.node_id;
    IF n.share_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO s FROM shares WHERE id = n.share_id;
    IF s.state = 'active' AND n.share_item_id <> s.root_item_id
       AND NOT EXISTS (SELECT 1 FROM blob_keys WHERE sha256 = NEW.sha256 AND scope_id = s.subtree_key_id) THEN
        RAISE EXCEPTION 'active shared version needs its share envelope'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
