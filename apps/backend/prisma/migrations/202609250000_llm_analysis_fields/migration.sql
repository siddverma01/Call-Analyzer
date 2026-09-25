-- AlterTable
ALTER TABLE "MeetingSummary" ADD COLUMN "blockers" JSONB;
ALTER TABLE "MeetingSummary" ADD COLUMN "followUps" JSONB;
ALTER TABLE "MeetingSummary" ADD COLUMN "importantDates" JSONB;
ALTER TABLE "MeetingSummary" ADD COLUMN "participants" JSONB;