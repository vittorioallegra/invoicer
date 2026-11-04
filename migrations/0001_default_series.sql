-- Custom SQL migration file, put your code below! ---- Every database starts with the default numbering series (no prefix or suffix), named in Italian
-- like the owner's UI; the Worker keeps exactly one default series.
INSERT INTO `numbering_series` (`id`, `name`, `prefix`, `suffix`, `is_default`, `created_at`, `updated_at`)
VALUES ('default', 'Principale', NULL, NULL, 1, CAST(strftime('%s', 'now') AS integer) * 1000, NULL);
