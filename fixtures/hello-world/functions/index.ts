import type { Context } from "@edge-canon/runtime";

export default async function handler(context: Context): Promise<Response> {
  return new Response("Hello, World from Edge Canon!", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}
