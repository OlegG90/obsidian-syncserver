-- The vault a device syncs (#364, D-139, revising AC-13).
--
-- A device row was never an account-wide device: the plugin lives inside one Obsidian vault and syncs
-- exactly one server vault, and only the device knew which. The server learns it when the device first
-- opens a vault, and the vault must be the device's own account's — hence the composite key. Removing
-- the vault clears the link (and the removal revokes the device, in code); the account column stays.
ALTER TABLE devices ADD COLUMN vault_id uuid;

ALTER TABLE devices ADD CONSTRAINT devices_vault_is_the_accounts
    FOREIGN KEY (user_id, vault_id) REFERENCES vaults (user_id, id) ON DELETE SET NULL (vault_id);

CREATE INDEX devices_vault ON devices (vault_id);
