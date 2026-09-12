-- A device's name is what a person reads in a list and picks a device by (#356, D-133).
--
-- Trimmed, one to 64 characters, no control characters. Every name written before this satisfies it:
-- the plugin sent 'obsidian', the console 'console', and the server's defaults are plain words.
ALTER TABLE devices ADD CONSTRAINT device_name_is_readable
    CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 64 AND name !~ '[[:cntrl:]]');
