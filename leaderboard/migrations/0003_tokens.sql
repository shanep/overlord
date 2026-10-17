-- Each person's average tokens a day over the last 60 days, so the board can
-- show who runs Claude hardest. Rows from before this are 0.
ALTER TABLE scores ADD COLUMN tokens_per_day INTEGER NOT NULL DEFAULT 0;
