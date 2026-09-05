-- The host's own id for the sequence or timeline. Nullable so existing links,
-- written before panels reported one, keep working by name.
ALTER TABLE "sequence_links" ADD COLUMN "sequence_id" TEXT;

-- Reverse lookup: given the sequence in front of the editor, which version is it?
CREATE INDEX "sequence_links_user_id_nle_sequence_id_idx"
  ON "sequence_links" ("user_id", "nle", "sequence_id");
