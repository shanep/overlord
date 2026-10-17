-- The ids of the achievements each person has unlocked, comma separated, so
-- the board can show their trophies. Rows from before this are empty.
ALTER TABLE scores ADD COLUMN achievements TEXT NOT NULL DEFAULT '';
