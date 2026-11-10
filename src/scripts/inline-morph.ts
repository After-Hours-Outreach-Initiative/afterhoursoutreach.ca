export class InlineMorph {
  private animation?: Animation;
  private restore?: () => void;

  cancel() {
    this.animation?.cancel();
    this.animation = undefined;
    this.restore?.();
    this.restore = undefined;
  }

  run(
    surface: HTMLElement,
    trigger: HTMLButtonElement,
    form: HTMLFormElement,
    expanded: boolean,
    update: () => void,
    { reveal = false }: { reveal?: boolean } = {},
  ) {
    // Sample an interrupted morph before cancelling it, so reversing never jumps.
    const before = surface.getBoundingClientRect();
    this.cancel();
    // Measure the natural collapsed trigger, never its animated or expanded size.
    let triggerBounds = expanded ? trigger.getBoundingClientRect() : undefined;
    update();
    const after = surface.getBoundingClientRect();
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const removeProbe =
      reveal && expanded ? revealBounds(surface, after, reduced) : undefined;
    if (reduced) {
      removeProbe?.();
      return Promise.resolve(true);
    }
    triggerBounds ??= trigger.getBoundingClientRect();

    // Keep centered labels/icons still while only the enclosing border resizes.
    trigger.style.width = `${triggerBounds.width}px`;
    trigger.style.height = `${triggerBounds.height}px`;
    form.style.width = `${Math.max(before.width, after.width) - 4}px`;
    this.restore = () => {
      removeProbe?.();
      trigger.style.removeProperty("width");
      trigger.style.removeProperty("height");
      form.style.removeProperty("width");
    };
    const animation = surface.animate(
      [
        {
          width: `${before.width}px`,
          height: `${before.height}px`,
          backgroundColor: "#000",
        },
        {
          width: `${after.width}px`,
          height: `${after.height}px`,
          backgroundColor: "#000",
        },
      ],
      { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    this.animation = animation;
    return animation.finished.then(
      () => {
        if (this.animation !== animation) return false;
        this.animation = undefined;
        this.restore?.();
        this.restore = undefined;
        return true;
      },
      () => false,
    );
  }
}

/**
 * Scroll the expanded surface into view while it is still morphing. A hidden
 * probe holds the final bounds, outside the surface's clip, so scroll containers
 * can already reach the end position before the animated size catches up.
 */
function revealBounds(surface: HTMLElement, bounds: DOMRect, instant: boolean) {
  const host = surface.parentElement;
  if (!host) return undefined;
  const positioned = getComputedStyle(host).position !== "static";
  if (!positioned) host.style.position = "relative";
  const hostBounds = host.getBoundingClientRect();
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  Object.assign(probe.style, {
    position: "absolute",
    top: `${bounds.top - hostBounds.top - host.clientTop}px`,
    left: `${bounds.left - hostBounds.left - host.clientLeft}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
    visibility: "hidden",
    pointerEvents: "none",
  });
  host.appendChild(probe);
  probe.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    behavior: instant ? "instant" : "smooth",
  });
  return () => {
    probe.remove();
    if (!positioned) host.style.removeProperty("position");
  };
}
