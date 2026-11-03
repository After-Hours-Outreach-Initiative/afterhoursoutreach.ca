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
  ) {
    // Sample an interrupted morph before cancelling it, so reversing never jumps.
    const before = surface.getBoundingClientRect();
    this.cancel();
    // Measure the natural collapsed trigger, never its animated or expanded size.
    let triggerBounds = expanded ? trigger.getBoundingClientRect() : undefined;
    update();
    const after = surface.getBoundingClientRect();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return Promise.resolve(true);
    triggerBounds ??= trigger.getBoundingClientRect();

    // Keep centered labels/icons still while only the enclosing border resizes.
    trigger.style.width = `${triggerBounds.width}px`;
    trigger.style.height = `${triggerBounds.height}px`;
    form.style.width = `${Math.max(before.width, after.width) - 4}px`;
    this.restore = () => {
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
