/** Thrown to unwind a running script when the user leaves the tour. Swallowed by the runner. */
export class DemoAborted extends Error {
  constructor() {
    super('demo aborted');
    this.name = 'DemoAborted';
  }
}

export interface CursorState {
  x: number;
  y: number;
  /** Bumped on each click so the view can retrigger the press ripple. */
  press: number;
  visible: boolean;
}

/** Ease-in-out — the cursor accelerates away and settles, rather than sliding at a robotic constant rate. */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/**
 * Drives the guided tour's synthetic cursor and the real UI underneath it.
 *
 * The cursor is not a decoration painted over a scripted mock: it travels to an actual element and then
 * genuinely clicks it, so every button the tour presses runs the same handler a user's click would. If a
 * control is renamed or moved, the tour visibly breaks instead of quietly lying.
 *
 * Every await is abortable. Esc rejects the in-flight step with {@link DemoAborted} so a half-finished
 * sequence unwinds instead of continuing to drive an app the user has already left.
 */
export class DemoDriver {
  private aborted = false;
  private ff = false;
  private onChange: (c: CursorState) => void;
  private state: CursorState;
  private pressSeq = 0;
  /** The element a press is currently held on, so {@link abort} can let go of it. Null between gestures. */
  private down: { x: number; y: number; el: HTMLElement } | null = null;

  constructor(onChange: (c: CursorState) => void, start?: { x: number; y: number }) {
    this.onChange = onChange;
    this.state = {
      x: start?.x ?? window.innerWidth / 2,
      y: start?.y ?? window.innerHeight / 2,
      press: 0,
      visible: false,
    };
  }

  /**
   * Stop the script at its next checkpoint — and LET GO first.
   *
   * A gesture unwinds wherever it happens to be, which for a drag or a paint stroke is mid-press. Leaving
   * the button held would strand the canvas in a drag mode that owns the pointer and hand the user an app
   * still mid-gesture; the release ends it cleanly, exactly as lifting a real finger would.
   */
  abort(): void {
    this.aborted = true;
    this.release();
  }

  /** True once the tour is skipping this step to its end — see {@link fastForward}. */
  get fast(): boolean {
    return this.ff;
  }

  /** Send the pointerup for an in-flight press, if there is one. */
  private release(): void {
    const at = this.down;
    this.down = null;
    if (at) DemoDriver.fire(at.el, 'pointerup', at.x, at.y);
  }

  /**
   * Run the REST of the step at once — pressing Next mid-animation.
   *
   * Not the same as {@link abort}. Aborting unwinds a half-built scene, which the next step then has to
   * rebuild from an empty canvas; fast-forwarding still performs every click, drag and hover, so the step
   * genuinely finishes and the next one inherits it. What it drops is only the part that exists for the
   * viewer: the pauses, the cursor travel, and the camera eases (which land in one frame instead).
   *
   * It is a JUMP, not a speed-up — there is no fast animation to watch, because the point of pressing Next
   * mid-step is not to see the rest of it sooner but to be done with it.
   *
   * Gestures keep every intermediate move that CHANGES what they do: a paint stroke selects what its PATH
   * crosses, so a serpentine collapsed to one jump would pick up a diagonal instead of the region.
   */
  fastForward(): void {
    this.ff = true;
  }

  private emit(): void {
    this.onChange({ ...this.state });
  }

  private checkpoint(): void {
    if (this.aborted) throw new DemoAborted();
  }

  /** Pause, abortably. Fast-forwarding drops every pause — pacing is the only thing they were for. */
  wait(ms: number): Promise<void> {
    this.checkpoint();
    if (this.ff) return Promise.resolve();
    return this.hold(ms);
  }

  /**
   * A pause for real time the tour doesn't own — the camera ease, which runs on its own clock inside the
   * canvas, so a gesture aimed while it is still flying lands at coordinates that no longer mean what they
   * meant.
   *
   * Fast-forwarding skips it, because a skipped step frames the camera INSTANTLY (see `frameOn`): there is
   * no tween left in flight to wait out, and sitting through one is the opposite of what Next just asked for.
   */
  hold(ms: number): Promise<void> {
    this.checkpoint();
    if (this.ff) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const id = window.setTimeout(() => {
        if (this.aborted) reject(new DemoAborted());
        else resolve();
      }, ms);
      // Abort mid-wait resolves on the next tick rather than hanging the script.
      const poll = window.setInterval(() => {
        if (!this.aborted) return;
        window.clearTimeout(id);
        window.clearInterval(poll);
        reject(new DemoAborted());
      }, 60);
      window.setTimeout(() => window.clearInterval(poll), ms + 80);
    });
  }

  /**
   * Let React commit and the canvas paint before the next action.
   *
   * This is load-bearing, not padding. State setters are asynchronous while the imperative canvas handle
   * is immediate, so a step that switched mode and then wrote to the canvas in the same tick had its work
   * silently reverted by the mode-swap effect that ran afterwards. Awaiting a commit is what orders them.
   */
  async settle(frames = 2): Promise<void> {
    for (let i = 0; i < frames; i++) {
      this.checkpoint();
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    this.checkpoint();
  }

  /**
   * True when a `data-demo` control is on screen but DISABLED.
   *
   * A press on one is silently a no-op (`click()` on a disabled button does nothing), so a loop that
   * keeps pressing until a control goes away would spin forever on it. The guided fix flow is exactly
   * that shape: it holds the Approve button up but greys it out on a violation it cannot resolve
   * automatically, and the tour has to take the Skip beside it instead.
   */
  static disabled(demoId: string): boolean {
    const el = document.querySelector(`[data-demo="${demoId}"]`);
    return el instanceof HTMLButtonElement && el.disabled;
  }

  /** The live viewport centre of a `data-demo` element, or null when it isn't on screen. */
  static locate(demoId: string): { x: number; y: number } | null {
    const el = document.querySelector<HTMLElement>(`[data-demo="${demoId}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /**
   * Wait (briefly, in frames) for a `data-demo` control to exist on screen, then hand back its centre.
   *
   * Controls the tour presses are React-rendered off the gesture before them — the floating panel bar only
   * appears once a selection has committed AND the canvas has published its anchor, which is two commits
   * and a paint away. Pacing used to cover that gap by accident; a fast-forwarded step has no pauses left
   * to cover it with, and a press on an element that isn't there yet silently does nothing.
   */
  private async awaitTarget(demoId: string, timeoutMs = 700): Promise<{ x: number; y: number } | null> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      this.checkpoint();
      const at = DemoDriver.locate(demoId);
      if (at) return at;
      if (performance.now() >= deadline) return null;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  }

  /** Glide to a viewport point, or to a `data-demo` element. A missing element is a no-op, not a crash. */
  async moveTo(target: string | { x: number; y: number }, ms = 420): Promise<void> {
    this.checkpoint();
    const to = typeof target === 'string' ? await this.awaitTarget(target) : target;
    if (!to) return;
    const from = { x: this.state.x, y: this.state.y };
    this.state.visible = true;
    if (this.ff) {
      this.state.x = to.x;
      this.state.y = to.y;
      this.emit();
      return;
    }
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    // Short hops shouldn't take as long as a trip across the screen.
    const dur = Math.max(130, Math.min(ms, 130 + dist * 0.45));
    const t0 = performance.now();
    for (;;) {
      this.checkpoint();
      const t = Math.min(1, (performance.now() - t0) / dur);
      const k = ease(t);
      this.state.x = from.x + (to.x - from.x) * k;
      this.state.y = from.y + (to.y - from.y) * k;
      this.emit();
      if (t >= 1) break;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  }

  /** Press: show the ripple, then really click the element so its own handler runs. */
  async click(demoId?: string): Promise<void> {
    this.checkpoint();
    this.state.press = ++this.pressSeq;
    this.emit();
    await this.wait(110);
    if (demoId) {
      document.querySelector<HTMLElement>(`[data-demo="${demoId}"]`)?.click();
    }
    await this.settle();
    await this.wait(150);
  }

  /** Move to an element and click it in one gesture. */
  async press(demoId: string, pauseAfter = 200): Promise<void> {
    await this.moveTo(demoId);
    await this.click(demoId);
    if (pauseAfter) await this.wait(pauseAfter);
  }

  /** Park the cursor over a viewport point without clicking — used to point at canvas work. */
  async point(pt: { x: number; y: number }, pauseAfter = 180): Promise<void> {
    await this.moveTo(pt);
    if (pauseAfter) await this.wait(pauseAfter);
  }

  /**
   * Hover a control for real. React implements onMouseEnter through delegated `mouseover`/`pointerover`
   * on the root, so dispatching those is what actually fires a hover handler — which is how the tour can
   * show the Optimize and Assign previews rather than describing them.
   */
  async hover(demoId: string, dwell = 600): Promise<void> {
    await this.moveTo(demoId);
    const el = document.querySelector<HTMLElement>(`[data-demo="${demoId}"]`);
    if (el) {
      for (const type of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith('over'), cancelable: true }));
      }
    }
    await this.settle();
    if (dwell) await this.wait(dwell);
  }

  /** Stop hovering — mirrors {@link hover} so a preview is cleared the way moving the mouse away would. */
  async unhover(demoId: string): Promise<void> {
    const el = document.querySelector<HTMLElement>(`[data-demo="${demoId}"]`);
    if (!el) return;
    for (const type of ['pointerout', 'mouseout', 'pointerleave', 'mouseleave']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith('out'), cancelable: true }));
    }
    await this.settle();
  }

  /**
   * Type into a real input, character by character, the way a keyboard would.
   *
   * React owns the value, so assigning `el.value` is invisible to it — the write has to go through the
   * prototype's own setter (which is also what defeats React's change-dedupe tracker) followed by the
   * `input` event its onChange is delegated from. That is what makes this the REAL box being filled in
   * rather than a picture of one: the rotating placeholder gives way, and the Enter below runs the same
   * submit handler a typed prompt does — LLM call, room catalog, and all.
   *
   * The reveal is driven by the CLOCK rather than a timer per character, so a long sentence takes about
   * as long to appear as it takes to read and a dropped frame costs characters instead of seconds.
   * Fast-forwarding fills the whole value in one tick: pressing Next mid-sentence asks to be done with
   * it, not to watch it typed faster.
   */
  async typeInto(
    demoId: string,
    text: string,
    opts: { submit?: boolean; ms?: number } = {},
  ): Promise<void> {
    await this.moveTo(demoId);
    const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-demo="${demoId}"]`,
    );
    if (!el) return;
    this.state.press = ++this.pressSeq;
    this.emit();
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const nativeSet = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
    const show = (value: string) => {
      if (nativeSet) nativeSet.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    if (this.ff) {
      show(text);
    } else {
      // Linear, not eased: a hand types at a steady rate, and an ease-out would leave the last few
      // characters crawling in long after the sentence has read as finished.
      const dur = opts.ms ?? Math.max(700, Math.min(2600, text.length * 42));
      const t0 = performance.now();
      let shown = 0;
      for (;;) {
        this.checkpoint();
        const t = Math.min(1, (performance.now() - t0) / dur);
        const want = Math.round(t * text.length);
        if (want !== shown) {
          shown = want;
          show(text.slice(0, shown));
        }
        if (t >= 1) break;
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
    }
    await this.settle();
    if (!opts.submit) return;
    await this.wait(320); // a beat on the finished sentence before it is sent
    this.state.press = ++this.pressSeq;
    this.emit();
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await this.settle();
  }

  /**
   * Poll `ok()` on real frames until it holds, up to `timeoutMs`; reports whether it did.
   *
   * For work the tour does NOT own — a Generate prompt is a network round-trip, and nothing the script
   * does makes it land sooner. Deliberately NOT skipped by a fast-forward for the same reason: carrying
   * on against a canvas the new rooms haven't arrived on reads as the step having done nothing at all.
   */
  async until(ok: () => boolean, timeoutMs = 15000): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      this.checkpoint();
      if (ok()) return true;
      if (performance.now() >= deadline) return false;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  }

  /* ---- Canvas gestures ------------------------------------------------------------------------
   * The canvas is not made of DOM controls, so these synthesize the real pointer sequence on it. The
   * point is fidelity: the tour goes through the same pointerdown/up the user's hand would, so what it
   * demonstrates is genuinely the app's interaction code and not a scripted shortcut around it.
   * ------------------------------------------------------------------------------------------- */

  private static canvasEl(): HTMLElement | null {
    return document.querySelector<HTMLElement>('canvas[aria-label="Infinite drawing canvas"]');
  }

  private static fire(el: HTMLElement, type: string, x: number, y: number, extra: PointerEventInit = {}) {
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        ...extra,
      }),
    );
  }

  /**
   * A full press-and-release at a viewport point, with the cursor travelling there first.
   *
   * `pauseAfter` lengthens the beat once the click has landed — worth it where the click itself is the
   * lesson (a boolean fires on release, and reads as nothing at all if the tour moves on immediately).
   */
  async canvasClick(
    pt: { x: number; y: number },
    opts: { shift?: boolean } = {},
    pauseAfter = 170,
  ): Promise<void> {
    const el = DemoDriver.canvasEl();
    if (!el) return;
    await this.moveTo(pt);
    this.state.press = ++this.pressSeq;
    this.emit();
    DemoDriver.fire(el, 'pointerdown', pt.x, pt.y, { shiftKey: opts.shift });
    this.down = { ...pt, el };
    await this.wait(80);
    this.down = null;
    DemoDriver.fire(el, 'pointerup', pt.x, pt.y, { shiftKey: opts.shift });
    await this.settle(2);
    await this.wait(pauseAfter);
  }

  /**
   * Park the cursor on a canvas point and dispatch the move the app hovers on — no button held.
   *
   * {@link point} only animates the tour's own cursor, which the canvas knows nothing about. Some
   * affordances only exist under a real hover (the magenta mullion face an Edit session lights up), so
   * showing one means sending the same idle `pointermove` a hand would.
   */
  async canvasHover(pt: { x: number; y: number }, dwell = 420): Promise<void> {
    const el = DemoDriver.canvasEl();
    if (!el) return;
    await this.moveTo(pt);
    DemoDriver.fire(el, 'pointermove', pt.x, pt.y, { buttons: 0 });
    await this.settle(2);
    if (dwell) await this.wait(dwell);
  }

  /** Two clicks plus the dblclick the canvas actually listens for — how a user opens a shape. */
  async canvasDoubleClick(pt: { x: number; y: number }): Promise<void> {
    const el = DemoDriver.canvasEl();
    if (!el) return;
    await this.canvasClick(pt, {}, 90);
    await this.canvasClick(pt, {}, 90);
    el.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y }),
    );
    await this.settle(2);
    await this.wait(260);
  }

  /**
   * Press, glide, release — a real drag, so paint-select and mullion drags run their own code.
   *
   * The intermediate moves are the gesture, not decoration: a paint stroke selects the panels its PATH
   * crosses. Fast-forwarding therefore fires the same moves, just without a frame between them.
   */
  async canvasDrag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    opts: { shift?: boolean; steps?: number } = {},
  ): Promise<void> {
    const el = DemoDriver.canvasEl();
    if (!el) return;
    await this.moveTo(from);
    this.state.press = ++this.pressSeq;
    this.emit();
    DemoDriver.fire(el, 'pointerdown', from.x, from.y, { shiftKey: opts.shift });
    this.down = { ...from, el };
    const steps = opts.steps ?? 18;
    for (let i = 1; i <= steps; i++) {
      this.checkpoint();
      const k = ease(i / steps);
      const x = from.x + (to.x - from.x) * k;
      const y = from.y + (to.y - from.y) * k;
      this.state.x = x;
      this.state.y = y;
      this.down = { x, y, el };
      this.emit();
      DemoDriver.fire(el, 'pointermove', x, y, { shiftKey: opts.shift });
      if (!this.ff) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    this.down = null;
    DemoDriver.fire(el, 'pointerup', to.x, to.y, { shiftKey: opts.shift });
    await this.settle(2);
    await this.wait(180);
  }

  /**
   * Press, glide through EVERY point in turn, release — one continuous stroke along a polyline.
   *
   * {@link canvasDrag} is the two-point case; this is the one paint-select actually wants. The brush adds
   * whatever the stroke's PATH crosses, so a zigzag sweeping back and forth across a block picks the whole
   * block up in a single gesture instead of a line at a time. Only the first point is arbitrated against
   * the mullions (the grab is decided on pointerdown), so the turns are free to cross grid lines.
   *
   * Speed is eased over the WHOLE path rather than per leg: the cursor accelerates away from the start and
   * settles at the end, and runs at a steady rate through the corners the way a hand sweeping a region does,
   * instead of stopping dead at every turn.
   *
   * The stroke is driven by the CLOCK, not by a step count — it covers the path in a fixed duration and
   * emits as many moves as the frame rate allows. That is what keeps a sweep over a heavy elevation from
   * crawling: every move repaints the scene, and a framed, clad facade can take tens of milliseconds to
   * redraw, so a fixed number of steps would stretch one stroke out over several seconds. Dropping moves
   * instead costs nothing, because the brush fills in whatever the SEGMENT between two moves crossed.
   */
  async canvasStroke(points: { x: number; y: number }[], opts: { shift?: boolean } = {}): Promise<void> {
    const el = DemoDriver.canvasEl();
    if (!el || points.length < 2) return;
    // Arc-length table, so a position can be found at any distance along the path.
    const legs = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
    const total = legs.reduce((a, b) => a + b, 0);
    if (total <= 0) return;

    await this.moveTo(points[0]);
    this.state.press = ++this.pressSeq;
    this.emit();
    DemoDriver.fire(el, 'pointerdown', points[0].x, points[0].y, { shiftKey: opts.shift });
    this.down = { ...points[0], el };

    // Cumulative distance to each vertex, so a turn can be found by arc length.
    const cum = [0];
    for (const len of legs) cum.push(cum[cum.length - 1] + len);

    let nextV = 1; // the first corner not yet reported
    /**
     * Report the cursor's arrival at distance `s`, passing through every CORNER on the way.
     *
     * The corners are what make dropped frames safe. The brush fills in the straight segment between two
     * consecutive moves, so a frame that skipped past a turn would have the app paint the diagonal
     * short-cut across it instead of the two legs the stroke actually took.
     */
    const advance = (s: number) => {
      while (nextV < points.length && cum[nextV] <= s) {
        const v = points[nextV++];
        DemoDriver.fire(el, 'pointermove', v.x, v.y, { shiftKey: opts.shift });
      }
      const leg = Math.min(nextV - 1, legs.length - 1);
      const t = legs[leg] > 0 ? Math.min(1, Math.max(0, (s - cum[leg]) / legs[leg])) : 1;
      const a = points[leg];
      const b = points[leg + 1];
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      this.state.x = p.x;
      this.state.y = p.y;
      this.down = { x: p.x, y: p.y, el };
      this.emit();
      DemoDriver.fire(el, 'pointermove', p.x, p.y, { shiftKey: opts.shift });
    };

    if (this.ff) {
      advance(total); // every corner, in order, in one tick — the same path, none of the animation
    } else {
      // Roughly a screen-width per second, floored and capped so neither a one-row sweep nor a full
      // elevation is out of proportion to the rest of the tour's pacing.
      const dur = Math.max(650, Math.min(1700, total * 1.1));
      const t0 = performance.now();
      for (;;) {
        this.checkpoint();
        const raw = Math.min(1, (performance.now() - t0) / dur);
        advance(ease(raw) * total);
        if (raw >= 1) break;
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
    }
    const end = points[points.length - 1];
    this.down = null;
    DemoDriver.fire(el, 'pointerup', end.x, end.y, { shiftKey: opts.shift });
    await this.settle(2);
    await this.wait(180);
  }

  /**
   * Drag OUT of a control and release over the canvas — how the cube places a shape.
   *
   * Every event goes to the button, not to whatever sits under the cursor, because that is precisely what
   * the pointer capture the button takes would do. The tour therefore exercises the real drag-and-drop
   * path rather than a shortcut that drops geometry straight onto the canvas.
   */
  async dragFrom(
    demoId: string,
    to: { x: number; y: number },
    opts: { steps?: number } = {},
  ): Promise<void> {
    await this.moveTo(demoId);
    const el = document.querySelector<HTMLElement>(`[data-demo="${demoId}"]`);
    if (!el) return;
    const from = { x: this.state.x, y: this.state.y };
    this.state.press = ++this.pressSeq;
    this.emit();
    DemoDriver.fire(el, 'pointerdown', from.x, from.y);
    this.down = { ...from, el };
    await this.wait(110);
    const steps = opts.steps ?? 20;
    for (let i = 1; i <= steps; i++) {
      this.checkpoint();
      const k = ease(i / steps);
      const x = from.x + (to.x - from.x) * k;
      const y = from.y + (to.y - from.y) * k;
      this.state.x = x;
      this.state.y = y;
      this.down = { x, y, el };
      this.emit();
      DemoDriver.fire(el, 'pointermove', x, y);
      if (!this.ff) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    await this.wait(120); // let the drop preview settle where it will land before releasing
    this.down = null;
    DemoDriver.fire(el, 'pointerup', to.x, to.y);
    await this.settle(2);
    await this.wait(200);
  }

  hide(): void {
    this.state.visible = false;
    this.emit();
  }
}
