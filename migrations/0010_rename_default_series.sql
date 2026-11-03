-- Custom SQL migration file, put your code below! --
-- The default series created by 0008 is named in Italian, like the owner's UI; a renamed one is kept.
UPDATE `numbering_series` SET `name` = 'Principale' WHERE `id` = 'default' AND `name` = 'Default';
