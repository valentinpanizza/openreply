/**
 * What the Hub reads from Instagram through OpenReply's connection (the token
 * never leaves OpenReply): the list of conversations, the messages of one,
 * and who a person is. Reads only, so they do not go through the send gate.
 */

import { getMetaGraphApiVersion } from "@/lib/env";

type Fetcher = typeof fetch;

export class GraphError extends Error {
  constructor(public code: number | undefined, message: string) {
    super(message);
  }
}

function base(): string {
  return `https://graph.instagram.com/${getMetaGraphApiVersion()}`;
}

async function graphGet<T>(path: string, params: Record<string, string>, token: string, fetcher: Fetcher): Promise<T> {
  const url = new URL(`${base()}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const response = await fetcher(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!response.ok || data.error) {
    throw new GraphError(data.error?.code, `${data.error?.message ?? `HTTP ${response.status}`} (${url.pathname})`);
  }
  return data;
}

export type HubConversation = { id: string; actualizado: string | null; persona: { id: string; usuario: string | null } | null };

type ConversationsPage = {
  data?: { id: string; updated_time?: string; participants?: { data?: { id: string; username?: string }[] } }[];
  paging?: { next?: string; cursors?: { after?: string } };
};

/** One page of conversations, most recently updated first. With `userId`, the conversation with that person. */
export async function listConversations(
  token: string,
  igId: string,
  options: { after?: string | null; userId?: string | null; limit?: number },
  fetcher: Fetcher = fetch
): Promise<{ conversaciones: HubConversation[]; siguiente: string | null }> {
  const params: Record<string, string> = {
    platform: "instagram",
    fields: "id,updated_time,participants",
    limit: String(Math.min(Math.max(options.limit ?? 25, 1), 50)),
  };
  if (options.after) params.after = options.after;
  if (options.userId) params.user_id = options.userId;
  const page = await graphGet<ConversationsPage>(`${igId}/conversations`, params, token, fetcher);
  const conversaciones = (page.data ?? []).map((c) => {
    const other = (c.participants?.data ?? []).find((p) => p.id !== igId);
    return {
      id: c.id,
      actualizado: c.updated_time ?? null,
      persona: other ? { id: other.id, usuario: other.username ?? null } : null,
    };
  });
  return { conversaciones, siguiente: page.paging?.next ? (page.paging.cursors?.after ?? null) : null };
}

// From the richest to the plainest: a field Meta does not know makes it
// reject the whole request, so each step drops what could be the culprit.
const MESSAGE_FIELDS = [
  "messages{id,created_time,from,to,message,attachments,shares,story,reactions,is_unsupported}",
  "messages{id,created_time,from,to,message,attachments,story}",
  "messages{id,created_time,from,to,message}",
];

/** The latest messages of a conversation (Meta only gives the 20 most recent), newest first. */
export async function conversationMessages(
  token: string,
  conversationId: string,
  fetcher: Fetcher = fetch
): Promise<Record<string, unknown>[]> {
  let last: unknown;
  for (const fields of MESSAGE_FIELDS) {
    try {
      const data = await graphGet<{ messages?: { data?: Record<string, unknown>[] } }>(
        conversationId,
        { fields },
        token,
        fetcher
      );
      return data.messages?.data ?? [];
    } catch (error) {
      last = error;
      if (!(error instanceof GraphError) || (error.code !== 100 && error.code !== 1)) throw error;
    }
  }
  throw last;
}

export type HubProfile = {
  id: string;
  nombre: string | null;
  usuario: string | null;
  foto: string | null;
  seguidores: number | null;
  te_sigue: boolean | null;
};

type ProfileRow = {
  name?: string;
  username?: string;
  profile_pic?: string;
  follower_count?: number;
  is_user_follow_business?: boolean;
};

/** Name, @, picture and followers of each person. One that Meta does not give back comes as null. */
export async function profiles(token: string, ids: string[], fetcher: Fetcher = fetch): Promise<(HubProfile | null)[]> {
  return Promise.all(
    ids.map(async (id) => {
      try {
        const row = await graphGet<ProfileRow>(
          id,
          { fields: "name,username,profile_pic,follower_count,is_user_follow_business" },
          token,
          fetcher
        );
        return {
          id,
          nombre: row.name ?? null,
          usuario: row.username ?? null,
          foto: row.profile_pic ?? null,
          seguidores: typeof row.follower_count === "number" ? row.follower_count : null,
          te_sigue: typeof row.is_user_follow_business === "boolean" ? row.is_user_follow_business : null,
        };
      } catch {
        return null;
      }
    })
  );
}
