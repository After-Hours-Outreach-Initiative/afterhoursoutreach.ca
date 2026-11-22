import { vi } from "vitest";

/** Fake Cloudflare send_email binding that records each message it accepts. */
export function emailSender(
  handler: (message: EmailMessageBuilder) => unknown = () => undefined,
) {
  const messages: EmailMessageBuilder[] = [];
  const send = vi.fn(async (message: EmailMessageBuilder) => {
    await handler(message);
    messages.push(message);
    return { messageId: `accepted-${messages.length}` };
  });
  return Object.assign({ send } as unknown as SendEmail, { send, messages });
}

/** A binding error as Cloudflare throws it, carrying private provider details. */
export function emailError(code: string) {
  return Object.assign(
    new Error("PRIVATE PROVIDER BODY volunteer@example.org"),
    { code },
  );
}
