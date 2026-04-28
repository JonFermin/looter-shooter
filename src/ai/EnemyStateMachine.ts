// Tiny finite-state-machine helper for enemies. Kept deliberately minimal —
// just enum + a thin class with `current`, `transition()`, and per-state
// onEnter / onExit callbacks. Nothing here knows about Babylon — the Enemy
// class wires the actual scene-side reactions in onEnter / onExit handlers.
//
// Why a class at all instead of an inline switch? Two reasons:
//   1. The four states each have setup work (start animation, stop animation,
//      kick a tween) and a single hook makes that explicit and symmetric.
//   2. Future bosses / variants will reuse the same shape, so a shared type
//      is worth the ~20 lines.

export enum EnemyState {
  IDLE = 0,
  CHASE = 1,
  ATTACK = 2,
  DEAD = 3,
}

export type StateHandler = () => void;

export class EnemyStateMachine {
  private _current: EnemyState;
  private readonly enterHandlers = new Map<EnemyState, StateHandler>();
  private readonly exitHandlers = new Map<EnemyState, StateHandler>();

  constructor(initial: EnemyState = EnemyState.IDLE) {
    this._current = initial;
  }

  get current(): EnemyState {
    return this._current;
  }

  /** Register a callback fired when entering a state. */
  onEnter(state: EnemyState, fn: StateHandler): void {
    this.enterHandlers.set(state, fn);
  }

  /** Register a callback fired when leaving a state. */
  onExit(state: EnemyState, fn: StateHandler): void {
    this.exitHandlers.set(state, fn);
  }

  /**
   * Move to a new state. No-ops if the next state equals current to avoid
   * re-firing onEnter/onExit during steady-state ticks. DEAD is sticky:
   * once reached, further transitions are ignored.
   */
  transition(next: EnemyState): void {
    if (this._current === next) return;
    if (this._current === EnemyState.DEAD) return;

    const exitFn = this.exitHandlers.get(this._current);
    exitFn?.();

    this._current = next;

    const enterFn = this.enterHandlers.get(this._current);
    enterFn?.();
  }
}
