-- The refusal's own sentence, beside its count (#433).
--
-- A device refused `invalid_write` sixty-nine times in thirteen minutes left a row saying exactly that,
-- and nothing about which rule it broke. The sentence is kept now, as the last one seen, with every id
-- and hash masked by the server before it is written (D-134): what is kept is the rule, not the node.
ALTER TABLE sync_problems ADD COLUMN detail text
    CONSTRAINT sync_problems_detail_is_short CHECK (char_length(detail) <= 300);
