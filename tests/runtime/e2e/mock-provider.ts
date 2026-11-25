// Minimal local scripted OpenAI-compatible HTTP provider for process-level E2E
// tests (Issue #47). Zero API keys, zero outbound network traffic.

export interface MockProviderHandle {
  readonly url: string
  readonly port: number
  readonly requests: Array<{ path: string; body: any }>
  close: () => void
}

export function startMockProvider(replyText = "Scripted E2E response."): MockProviderHandle {
  const requests: Array<{ path: string; body: any }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      let body: any = null
      try {
        body = await req.json()
      } catch {}
      requests.push({ path: url.pathname, body })

      if (url.pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "scripted-model", object: "model", owned_by: "local" }],
        })
      }

      if (body?.stream === true) {
        const chunk1 = {
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "scripted-model",
          choices: [{ index: 0, delta: { role: "assistant", content: replyText }, finish_reason: null }],
        }
        const chunk2 = {
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "scripted-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
        const sse = `data: ${JSON.stringify(chunk1)}\n\ndata: ${JSON.stringify(chunk2)}\n\ndata: [DONE]\n\n`
        return new Response(sse, {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        })
      }

      return Response.json({
        id: "chatcmpl-e2e",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "scripted-model",
        choices: [{ index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    port: server.port,
    requests,
    close: () => server.stop(true),
  }
}
