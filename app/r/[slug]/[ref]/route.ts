import type { NextRequest } from "next/server";
import { GET as redirectSlug } from "../route";

// /r/<slug>/<ref>: the same tracked link with a per-message tail, so the
// setter never sends one identical URL to dozens of people (see
// trackedLinksFor in lib/setter/engine.ts). The tail is ignored.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; ref: string }> }
) {
  const { slug } = await params;
  return redirectSlug(request, { params: Promise.resolve({ slug }) });
}
