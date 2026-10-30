-- AI setter: whether the person qualifies (lib/setter/quota.ts) and when the
-- call was booked, kept for the daily report (lib/setter/report.ts).
ALTER TABLE "SetterConversation" ADD COLUMN "fit" TEXT;
ALTER TABLE "SetterConversation" ADD COLUMN "bookedAt" TIMESTAMP(3);
