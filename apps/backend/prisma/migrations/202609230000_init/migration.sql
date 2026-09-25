-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('DRAFT', 'STARTING', 'RECORDING', 'PROCESSING', 'COMPLETED', 'SYNC_PENDING', 'SYNCED', 'FAILED');

-- CreateEnum
CREATE TYPE "ActionItemStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "TemplateType" AS ENUM ('SYSTEM', 'CUSTOM');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" VARCHAR(128) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL DEFAULT 'Untitled meeting',
    "templateId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "status" "MeetingStatus" NOT NULL DEFAULT 'DRAFT',
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptSegment" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "clientSegmentId" VARCHAR(80) NOT NULL,
    "speaker" VARCHAR(120) NOT NULL DEFAULT 'Speaker 1',
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "isEdited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingSummary" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "discussionPoints" JSONB,
    "decisions" JSONB,
    "risks" JSONB,
    "openQuestions" JSONB,
    "actionItems" JSONB,
    "sections" JSONB,
    "aiModel" TEXT,
    "aiProvider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionItem" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "assignee" VARCHAR(120),
    "dueDate" TIMESTAMP(3),
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "status" "ActionItemStatus" NOT NULL DEFAULT 'OPEN',
    "sourceSegmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpeakerMapping" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "label" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,

    CONSTRAINT "SpeakerMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" VARCHAR(120) NOT NULL,
    "type" "TemplateType" NOT NULL DEFAULT 'CUSTOM',
    "description" TEXT,
    "schema" JSONB NOT NULL,
    "prompt" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "keyValues" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" VARCHAR(80) NOT NULL,
    "resource" VARCHAR(80) NOT NULL,
    "resourceId" VARCHAR(80),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Meeting_userId_createdAt_idx" ON "Meeting"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Meeting_userId_status_idx" ON "Meeting"("userId", "status");

-- CreateIndex
CREATE INDEX "Meeting_userId_startedAt_idx" ON "Meeting"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "TranscriptSegment_meetingId_startTime_idx" ON "TranscriptSegment"("meetingId", "startTime");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptSegment_meetingId_clientSegmentId_key" ON "TranscriptSegment"("meetingId", "clientSegmentId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingSummary_meetingId_key" ON "MeetingSummary"("meetingId");

-- CreateIndex
CREATE INDEX "ActionItem_userId_status_idx" ON "ActionItem"("userId", "status");

-- CreateIndex
CREATE INDEX "ActionItem_meetingId_status_idx" ON "ActionItem"("meetingId", "status");

-- CreateIndex
CREATE INDEX "ActionItem_sourceSegmentId_idx" ON "ActionItem"("sourceSegmentId");

-- CreateIndex
CREATE UNIQUE INDEX "SpeakerMapping_meetingId_label_key" ON "SpeakerMapping"("meetingId", "label");

-- CreateIndex
CREATE INDEX "Template_userId_isDefault_idx" ON "Template"("userId", "isDefault");

-- CreateIndex
CREATE INDEX "Template_type_idx" ON "Template"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_userId_key" ON "Setting"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingSummary" ADD CONSTRAINT "MeetingSummary_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_sourceSegmentId_fkey" FOREIGN KEY ("sourceSegmentId") REFERENCES "TranscriptSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpeakerMapping" ADD CONSTRAINT "SpeakerMapping_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Setting" ADD CONSTRAINT "Setting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
