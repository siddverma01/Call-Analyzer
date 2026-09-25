-- Productivity features: meeting search, per-user template preferences,
-- standalone tasks, and the built-in system templates.

-- --------------------------------------------------------------------------
-- 1. Tasks can exist without a meeting (standalone action items).
-- --------------------------------------------------------------------------

ALTER TABLE "ActionItem" ALTER COLUMN "meetingId" DROP NOT NULL;

-- --------------------------------------------------------------------------
-- 2. Per-user default template preference (system + custom templates both
--    support per-user defaults; defaulting is not shared between users).
-- --------------------------------------------------------------------------

CREATE TABLE "UserTemplatePreference" (
    "userId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTemplatePreference_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "UserTemplatePreference_templateId_idx" ON "UserTemplatePreference"("templateId");

ALTER TABLE "UserTemplatePreference" ADD CONSTRAINT "UserTemplatePreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserTemplatePreference" ADD CONSTRAINT "UserTemplatePreference_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- 3. PostgreSQL full-text search.
--
-- A maintained `searchVector` column on Meeting aggregates the meeting title,
-- transcript segments, summary, structured notes (discussion points,
-- decisions, ...), and action item descriptions so one GIN index powers
-- /api/search. Triggers keep it current on any change to those tables.
-- --------------------------------------------------------------------------

ALTER TABLE "Meeting" ADD COLUMN "searchVector" tsvector;

CREATE OR REPLACE FUNCTION meeting_search_document(meeting_id TEXT)
RETURNS tsvector
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  doc tsvector;
BEGIN
  SELECT
    setweight(to_tsvector('english', COALESCE(m."title", '')), 'A') ||
    setweight(COALESCE((SELECT to_tsvector('english', COALESCE(string_agg(ts."text", ' '), '')) FROM "TranscriptSegment" ts WHERE ts."meetingId" = m."id"), ''::tsvector), 'B') ||
    setweight(COALESCE((SELECT to_tsvector('english', COALESCE(su."summary", '')) FROM "MeetingSummary" su WHERE su."meetingId" = m."id"), ''::tsvector), 'B') ||
    setweight(COALESCE((SELECT jsonb_to_tsvector('english', su."discussionPoints", '["string", "numeric"]') FROM "MeetingSummary" su WHERE su."meetingId" = m."id"), ''::tsvector), 'C') ||
    setweight(COALESCE((SELECT jsonb_to_tsvector('english', su."decisions", '["string", "numeric"]') FROM "MeetingSummary" su WHERE su."meetingId" = m."id"), ''::tsvector), 'C') ||
    setweight(COALESCE((SELECT jsonb_to_tsvector('english', su."risks", '["string", "numeric"]') FROM "MeetingSummary" su WHERE su."meetingId" = m."id"), ''::tsvector), 'C') ||
    setweight(COALESCE((SELECT jsonb_to_tsvector('english', su."followUps", '["string", "numeric"]') FROM "MeetingSummary" su WHERE su."meetingId" = m."id"), ''::tsvector), 'C') ||
    setweight(to_tsvector('english', COALESCE((SELECT string_agg(ai."description", ' ') FROM "ActionItem" ai WHERE ai."meetingId" = m."id"), '')), 'D')
  INTO doc
  FROM "Meeting" m
  WHERE m."id" = meeting_id;

  RETURN doc;
END;
$$;

CREATE OR REPLACE FUNCTION meeting_search_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  m_id TEXT;
BEGIN
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
    UPDATE "Meeting" SET "searchVector" = meeting_search_document(m_id) WHERE "Meeting"."id" = m_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "Meeting_searchVector_trg"
  AFTER INSERT OR UPDATE OF "title" ON "Meeting"
  FOR EACH ROW EXECUTE FUNCTION meeting_search_update();

CREATE TRIGGER "TranscriptSegment_searchVector_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "TranscriptSegment"
  FOR EACH ROW EXECUTE FUNCTION meeting_search_update();

CREATE TRIGGER "MeetingSummary_searchVector_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "MeetingSummary"
  FOR EACH ROW EXECUTE FUNCTION meeting_search_update();

CREATE TRIGGER "ActionItem_searchVector_trg"
  AFTER INSERT OR UPDATE OR DELETE ON "ActionItem"
  FOR EACH ROW EXECUTE FUNCTION meeting_search_update();

CREATE INDEX "Meeting_searchVector_idx" ON "Meeting" USING GIN ("searchVector");

-- Backfill every existing meeting's search document.
UPDATE "Meeting" SET "searchVector" = meeting_search_document("id");

-- --------------------------------------------------------------------------
-- 4. Built-in system templates. `userId` stays NULL so every user sees them;
--    they are read-only (users duplicate them to customize).
-- --------------------------------------------------------------------------

INSERT INTO "Template" ("id", "userId", "name", "type", "description", "schema", "prompt", "isDefault", "createdAt", "updatedAt") VALUES
('sys-standup', NULL, 'Stand-up', 'SYSTEM', 'Daily stand-up: yesterday, today, blockers, and action items.', '{"sections":[{"key":"yesterday","label":"Yesterday","type":"list"},{"key":"today","label":"Today","type":"list"},{"key":"blockers","label":"Blockers","type":"list"},{"key":"actionItems","label":"Action Items","type":"list"}]}', 'Generate stand-up notes covering yesterday''s work, today''s plan, blockers, and action items.', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('sys-sales', NULL, 'Sales Meeting', 'SYSTEM', 'Sales pipeline and opportunity review with commitments and next steps.', '{"sections":[{"key":"pipelineReview","label":"Pipeline Review","type":"list"},{"key":"opportunities","label":"Opportunities","type":"list"},{"key":"objections","label":"Objections & Negotiations","type":"list"},{"key":"decisions","label":"Decisions","type":"list"},{"key":"commitments","label":"Commitments","type":"list"},{"key":"actionItems","label":"Action Items","type":"list"}]}', 'Generate sales meeting notes covering pipeline, opportunities, objections, decisions, commitments, and action items.', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('sys-team', NULL, 'Team Meeting', 'SYSTEM', 'Team updates, discussion, decisions, risks, and follow-ups.', '{"sections":[{"key":"updates","label":"Updates","type":"list"},{"key":"discussion","label":"Discussion","type":"list"},{"key":"decisions","label":"Decisions","type":"list"},{"key":"blockers","label":"Blockers / Risks","type":"list"},{"key":"followUps","label":"Follow-ups","type":"list"},{"key":"actionItems","label":"Action Items","type":"list"}]}', 'Generate team meeting notes covering updates, discussion, decisions, blockers/risks, follow-ups, and action items.', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('sys-client', NULL, 'Client Meeting', 'SYSTEM', 'Client requirements, pain points, discussion, commitments, and follow-ups.', '{"sections":[{"key":"clientRequirements","label":"Client Requirements","type":"list"},{"key":"painPoints","label":"Pain Points","type":"list"},{"key":"discussion","label":"Discussion","type":"list"},{"key":"decisions","label":"Decisions","type":"list"},{"key":"commitments","label":"Commitments","type":"list"},{"key":"followUps","label":"Follow-ups","type":"list"},{"key":"actionItems","label":"Action Items","type":"list"}]}', 'Generate client meeting notes covering requirements, pain points, discussion, decisions, commitments, follow-ups, and action items.', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('sys-technical', NULL, 'Technical Meeting', 'SYSTEM', 'Technical deep dives: problem, discussion, root cause, decisions, and plan.', '{"sections":[{"key":"problem","label":"Problem","type":"text"},{"key":"technicalDiscussion","label":"Technical Discussion","type":"list"},{"key":"rootCause","label":"Root Cause","type":"text"},{"key":"decisions","label":"Decisions","type":"list"},{"key":"implementationPlan","label":"Implementation Plan","type":"list"},{"key":"risks","label":"Risks","type":"list"},{"key":"actionItems","label":"Action Items","type":"list"}]}', 'Generate technical meeting notes covering the problem, technical discussion, root cause, decisions, implementation plan, risks, and action items.', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('sys-planning', NULL, 'Project Planning', 'SYSTEM', 'Planning sessions: goals, scope, milestones, resources, risks, and decisions.', '{"sections":[{"key":"goals","label":"Goals & Objectives","type":"list"},{"key":"scope","label":"Scope","type":"text"},{"key":"milestones","label":"Milestones / Timeline","type":"list"},{"key":"resources","label":"Resources","type":"list"},{"key":"risks","label":"Risks & Dependencies","type":"list"},{"key":"decisions","label":"Decisions","type":"list"},{"key":"actionItems","label":"Action Items","type":"list"}]}', 'Generate project planning notes covering goals, scope, milestones, resources, risks, decisions, and action items.', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('sys-interview', NULL, 'Interview', 'SYSTEM', 'Candidate assessment: skills, strengths, concerns, decision, and next steps.', '{"sections":[{"key":"candidateOverview","label":"Candidate Overview","type":"text"},{"key":"skillAssessment","label":"Skill Assessment","type":"list"},{"key":"strengths","label":"Strengths","type":"list"},{"key":"concerns","label":"Concerns","type":"list"},{"key":"discussion","label":"Discussion","type":"list"},{"key":"decision","label":"Decision","type":"text"},{"key":"nextSteps","label":"Next Steps","type":"list"},{"key":"actionItems","label":"Action Items","type":"list"}]}', 'Generate interview notes covering the candidate overview, skill assessment, strengths, concerns, discussion, decision, next steps, and action items.', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('sys-1on1', NULL, 'One-on-One', 'SYSTEM', 'Status updates, discussion, feedback, goals, and action items.', '{"sections":[{"key":"statusUpdate","label":"Status Update","type":"list"},{"key":"discussion","label":"Discussion","type":"list"},{"key":"wins","label":"Wins & Concerns","type":"list"},{"key":"feedback","label":"Feedback","type":"list"},{"key":"goals","label":"Goals","type":"list"},{"key":"actionItems","label":"Action Items","type":"list"}]}', 'Generate one-on-one notes covering status, discussion, wins and concerns, feedback, goals, and action items.', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('sys-custom', NULL, 'Custom', 'SYSTEM', 'Free-form meeting notes with no fixed structure.', '{"sections":[]}', 'Generate free-form meeting notes that capture the key points, decisions, and action items.', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);