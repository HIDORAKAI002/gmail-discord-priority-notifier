import { EmailDisposition, EmailLevel, ScoreConfidence } from "@prisma/client";
import { sha256 } from "./crypto.js";

export type ParsedEmail = {
  messageId: string;
  threadId?: string;
  from: string;
  subject: string;
  snippet: string;
  bodyText?: string;
};

export type ScoreResult = {
  geminiScore?: number;
  groqScore?: number;
  ruleScore?: number;
  ensembleScore: number;
  confidence: ScoreConfidence;
  category: EmailLevel;
  disposition: EmailDisposition;
  requiresResponse: boolean;
  summary: string;
};

export function classifyLevel(score: number, important = 50, critical = 80): EmailLevel {
  if (score >= critical) return EmailLevel.CRITICAL;
  if (score >= important) return EmailLevel.IMPORTANT;
  if (score >= 20) return EmailLevel.NORMAL;
  return EmailLevel.LOW;
}

export function dispositionForEmail(level: EmailLevel, spamScore: number): EmailDisposition {
  if (spamScore >= 75) return EmailDisposition.SPAM;
  if (level === EmailLevel.CRITICAL || level === EmailLevel.IMPORTANT) return EmailDisposition.IMPORTANT;
  if (level === EmailLevel.NORMAL) return EmailDisposition.USED;
  return EmailDisposition.LOW_VALUE;
}

export function hashedEmailFields(email: ParsedEmail) {
  const domain = email.from.match(/@([^>\s]+)/)?.[1]?.toLowerCase();
  return {
    senderHash: sha256(email.from.toLowerCase()),
    subjectHash: sha256(email.subject.toLowerCase()),
    senderDomain: domain,
    subjectPreview: email.subject.replace(/\s+/g, " ").slice(0, 140),
    snippetPreview: email.snippet.replace(/\s+/g, " ").slice(0, 240)
  };
}
