-- First reply from a lead after their automatic voice note (owner notified).
ALTER TABLE "Lead" ADD COLUMN "repliedAt" TIMESTAMP(3);
