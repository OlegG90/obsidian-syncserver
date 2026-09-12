-- What went wrong for which device, counted rather than listed (#355, D-134).
--
-- One row per device, method, route template, status and refusal code. A refusal that repeats moves
-- `count` and `last_at` instead of adding a row, so the table grows with the number of DIFFERENT
-- problems, not with how often one recurs. No paths, names, bodies or node ids: the route is the
-- template (`/vaults/:vaultId/nodes/:nodeId/move`), and the code is the refusal's name.
CREATE TABLE sync_problems (
    user_id   uuid        NOT NULL REFERENCES users ON DELETE CASCADE,
    device_id uuid        NOT NULL REFERENCES devices ON DELETE CASCADE,
    method    text        NOT NULL,
    route     text        NOT NULL,
    status    smallint    NOT NULL CHECK (status BETWEEN 400 AND 599),
    code      text        NOT NULL,
    count     bigint      NOT NULL DEFAULT 1 CHECK (count > 0),
    first_at  timestamptz NOT NULL DEFAULT now(),
    last_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, method, route, status, code)
);

CREATE INDEX sync_problems_by_account ON sync_problems (user_id, last_at);
