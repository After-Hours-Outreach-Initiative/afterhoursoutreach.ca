// Sequential validation/fixture requests use the same original-baseline and
// draft-generation metadata as a freshly opened form. Conflict tests supply
// explicit stale metadata instead of using this helper.
export async function profileWriteBody(
  read: (
    path: string,
  ) => Promise<{ json(): Promise<unknown>; text(): Promise<string> }>,
  input: object,
) {
  const state = (await (
    await read("/api/v1/account/application-draft")
  ).json()) as {
    userId?: string;
    submitted?: boolean;
    generation?: string | null;
    draft?: { revision: string } | null;
  };
  if (!state.userId) return input;
  let baseline: unknown;
  if (state.submitted) {
    const html = await (await read("/volunteer/account")).text();
    const encoded = html.match(/data-profile-baseline="([^"]*)"/)?.[1];
    if (encoded)
      baseline = JSON.parse(
        encoded.replace(
          /&(?:quot|amp|lt|gt|#39|#34);/g,
          (entity) =>
            ({
              "&quot;": '"',
              "&#34;": '"',
              "&#39;": "'",
              "&amp;": "&",
              "&lt;": "<",
              "&gt;": ">",
            })[entity]!,
        ),
      );
  }
  return {
    applicationUserId: state.userId,
    intent: state.submitted ? "edit" : "submit",
    ...(state.submitted
      ? { baseline }
      : {
          draft: {
            revision: state.draft?.revision ?? null,
            generation: state.generation ?? null,
          },
        }),
    ...input,
  };
}
