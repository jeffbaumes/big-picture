-- Each track has a revision that changes whenever its items or points change (milliseconds since epoch).
-- The page caches a track's data under its revision and only downloads it again when the revision moves.
ALTER TABLE tracks ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
UPDATE tracks SET rev = CAST(strftime('%s','now') AS INTEGER) * 1000;
