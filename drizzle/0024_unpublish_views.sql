-- Views are now the only thing that can be published, and a published view
-- shows only its columns, which must be visible fields of the collection's
-- saved schema. Views published before that rule could show any field, so
-- unpublish them all; owners re-publish after picking columns.
UPDATE "views" SET "published" = false WHERE "published";
