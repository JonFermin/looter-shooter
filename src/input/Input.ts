type ClickHandler = () => void;
type LockHandler = (locked: boolean) => void;

/**
 * Framework-agnostic input helper. A single instance attaches global
 * keyboard/mouse listeners on construction; entities can query held-key
 * state, accumulated mouse-look delta, and subscribe to mouse-button
 * clicks and pointer-lock changes without per-entity wiring.
 *
 * Mouse delta only accumulates while the document holds pointer lock —
 * otherwise normal cursor motion would drift the player view.
 */
export class Input {
  private heldKeys = new Set<string>();
  private mouseDeltaX = 0;
  private mouseDeltaY = 0;
  private clickHandlers = new Map<number, Set<ClickHandler>>();
  private lockHandlers = new Set<LockHandler>();

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.heldKeys.add(e.key.toLowerCase());
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.heldKeys.delete(e.key.toLowerCase());
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (document.pointerLockElement) {
      this.mouseDeltaX += e.movementX;
      this.mouseDeltaY += e.movementY;
    }
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    const set = this.clickHandlers.get(e.button);
    if (!set) return;
    for (const handler of set) {
      handler();
    }
  };

  private readonly onLockChange = (): void => {
    const locked = document.pointerLockElement !== null;
    for (const handler of this.lockHandlers) {
      handler(locked);
    }
  };

  // Clear held-key state when the window loses focus so keys held during
  // alt-tab don't get stuck "down" forever.
  private readonly onBlur = (): void => {
    this.heldKeys.clear();
  };

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("pointerlockchange", this.onLockChange);
  }

  isDown(key: string): boolean {
    return this.heldKeys.has(key.toLowerCase());
  }

  getMouseDelta(): { dx: number; dy: number } {
    const out = { dx: this.mouseDeltaX, dy: this.mouseDeltaY };
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    return out;
  }

  requestPointerLock(canvas: HTMLCanvasElement): void {
    canvas.requestPointerLock();
  }

  onClick(button: number, handler: ClickHandler): () => void {
    let set = this.clickHandlers.get(button);
    if (!set) {
      set = new Set();
      this.clickHandlers.set(button, set);
    }
    const bucket = set;
    bucket.add(handler);
    return () => {
      bucket.delete(handler);
    };
  }

  onPointerLockChange(handler: LockHandler): () => void {
    this.lockHandlers.add(handler);
    return () => {
      this.lockHandlers.delete(handler);
    };
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    this.heldKeys.clear();
    this.clickHandlers.clear();
    this.lockHandlers.clear();
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
  }
}
