export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function requireSameOrigin(request: Request, origin: string) {
  if (request.headers.get("origin") !== origin)
    throw new RequestError(403, "This request must come from the website.");
}

/** Reject oversized bodies even when Content-Length is absent or incorrect. */
export async function readJson(
  request: Request,
  limit = 16_384,
): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  )
    throw new RequestError(415, "Send JSON.");
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "Missing request body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RequestError(413, "Request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestError(400, "Invalid JSON.");
  }
}

export function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//"))
    return "/volunteer/account";
  try {
    const url = new URL(value, "https://local.invalid");
    if (
      url.origin !== "https://local.invalid" ||
      !/^(?:\/(?:volunteer|volunteers)(?:\/|$)|\/manage\/(?:events\/?|applications\/?|volunteers(?:\/[^/]+)?\/?)$|\/(?:events|applications|apply|register)\/?$)/.test(
        url.pathname,
      ) ||
      url.pathname.startsWith("/volunteer/sign-in")
    )
      return "/volunteer/account";
    // Normalize legacy application links, including return URLs in older emails.
    if (/^\/(?:volunteer\/)?register\/?$/.test(url.pathname))
      return "/apply" + url.search;
    if (/^\/volunteer\/?$/.test(url.pathname)) return "/events" + url.search;
    if (/^\/manage\/events\/?$/.test(url.pathname)) {
      url.searchParams.set("view", "organizer");
      return "/events" + url.search;
    }
    if (/^\/manage\//.test(url.pathname))
      return url.pathname.replace(/^\/manage/, "") + url.search;
    if (/^\/volunteer\/volunteers(?:\/|$)/.test(url.pathname))
      return url.pathname.replace(/^\/volunteer/, "") + url.search;
    return url.pathname + url.search;
  } catch {
    return "/volunteer/account";
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof RequestError)
    return Response.json(
      { ...error.details, message: error.message },
      {
        status: error.status,
        headers: {
          "Cache-Control": "no-store",
          ...(error.status === 429 ? { "Retry-After": "60" } : {}),
        },
      },
    );
  // Never log request bodies, email addresses, tokens, or profile answers.
  console.error(JSON.stringify({ event: "account_request_failed" }));
  return Response.json(
    { message: "The service is unavailable. Please try again later." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
