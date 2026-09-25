-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "clientMeetingId" VARCHAR(80);

-- AlterTable
ALTER TABLE "ActionItem" ADD COLUMN "clientItemId" VARCHAR(80);

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_userId_clientMeetingId_key" ON "Meeting"("userId", "clientMeetingId");

-- CreateIndex
CREATE UNIQUE INDEX "ActionItem_meetingId_clientItemId_key" ON "ActionItem"("meetingId", "clientItemId");