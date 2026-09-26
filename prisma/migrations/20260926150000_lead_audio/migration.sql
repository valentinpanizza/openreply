-- Voice note sent automatically to a lead (LEAD_AUDIO_URLS).
ALTER TABLE "Lead" ADD COLUMN "audioSentAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "audioError" TEXT;
