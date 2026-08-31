/**
 * Core barrel. Deliberately excludes ./ffmpeg, which touches `document` and
 * `import.meta.env` and so only loads in a browser. Keeping it out means the rest of
 * the core stays testable under plain Node.
 */
export * from './mp4/index';
export * from './targets';
export * from './diagnose';
export * from './pipeline';
