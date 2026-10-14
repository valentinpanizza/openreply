-- AI setter (lib/setter): conversations it runs and their messages.
ALTER TABLE "Automation" ADD COLUMN "setterContext" TEXT;

CREATE TYPE "SetterStatus" AS ENUM ('ACTIVE', 'HUMAN');

CREATE TABLE "SetterConversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT,
    "automationId" TEXT,
    "status" "SetterStatus" NOT NULL DEFAULT 'ACTIVE',
    "phase" TEXT NOT NULL DEFAULT 'abridor',
    "notes" TEXT,
    "timezone" TEXT,
    "email" TEXT,
    "callAt" TIMESTAMP(3),
    "eventId" TEXT,
    "resourceSentAt" TIMESTAMP(3),
    "statusReason" TEXT,
    "lastUserAt" TIMESTAMP(3),
    "lastBotAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SetterConversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SetterConversation_instagramAccountId_userId_key" ON "SetterConversation"("instagramAccountId", "userId");

CREATE TABLE "SetterMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "text" TEXT NOT NULL,
    "mid" TEXT,
    "model" TEXT,
    "costUsd" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SetterMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SetterMessage_mid_key" ON "SetterMessage"("mid");
CREATE INDEX "SetterMessage_conversationId_createdAt_idx" ON "SetterMessage"("conversationId", "createdAt");

ALTER TABLE "SetterMessage" ADD CONSTRAINT "SetterMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SetterConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
