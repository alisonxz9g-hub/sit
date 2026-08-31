/**
 * The contract every route implements.
 *
 * `destroy` is not optional theatre: the optimizer holds object URLs and possibly a
 * running ffmpeg job, and the router relies on this to release both on navigation.
 */
export interface View {
  readonly element: HTMLElement;
  destroy(): void;
}
