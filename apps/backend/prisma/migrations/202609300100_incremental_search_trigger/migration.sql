-- Full-text search trigger made incremental.
--
-- The original TranscriptSegment trigger recomputed the entire meeting search
-- document for *every* inserted/updated/deleted row. Because the document
-- aggregates all of a meeting's transcript text, that made a 1-4 hour meeting
-- sync O(n²): a 2400-segment meeting (4h at ~1 segment/6s) triggered 2400 full
-- re-aggregations and pushed a single sync past the previous 30s budget.
--
-- Segments are now applied as a weight-B lexeme delta:
--   searchVector || setweight(text, 'B')   (insert)
--   searchVector - setweight(text, 'B')    (delete / changed row)
-- tsvector `-` is exact on lexeme + weight set, so deleting a transcript word
-- never removes the same word from the title (weight A), summary block
-- (weight B on summary text / C on structured notes) or action items (D).
-- Meeting title, MeetingSummary, and ActionItem events are rare and still
-- recompute from scratch via meeting_search_document().
--
-- This migration only replaces the trigger function; the triggers themselves
-- are untouched.

CREATE OR REPLACE FUNCTION meeting_search_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  m_id TEXT;
  current_doc tsvector;
  meeting_exists BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'TranscriptSegment' AND TG_OP = 'INSERT' THEN
    -- Hot path: `createMany` during an offline-first sync can insert thousands
    -- of transcript rows at once. Concatenating the new row's weight-B lexemes
    -- keeps this O(n) instead of recomputing the whole document per row.
    m_id := NEW."meetingId";
    IF m_id IS NOT NULL THEN
      UPDATE "Meeting"
      SET "searchVector" = COALESCE("searchVector", ''::tsvector) ||
                           setweight(to_tsvector('english', COALESCE(NEW."text", '')), 'B')
      WHERE "Meeting"."id" = m_id;
    END IF;
    RETURN NEW;
  END IF;

  -- Rare paths: segment edits, meeting title changes, summary / action-item
  -- writes, and deletions (including the cascaded rows of a deleted meeting).
  -- PostgreSQL has no tsvector subtraction operator, so rebuild the document
  -- from its current rows. Where the owning Meeting is being deleted at the
  -- same time, skip once the row is gone.
  IF TG_TABLE_NAME = 'Meeting' THEN
    IF TG_OP = 'DELETE' THEN
      m_id := OLD."id";
    ELSE
      m_id := NEW."id";
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      m_id := OLD."meetingId";
    ELSE
      m_id := NEW."meetingId";
    END IF;
  END IF;

  IF m_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM "Meeting" WHERE "id" = m_id) INTO meeting_exists;
    IF meeting_exists THEN
      UPDATE "Meeting" SET "searchVector" = meeting_search_document(m_id) WHERE "Meeting"."id" = m_id;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;